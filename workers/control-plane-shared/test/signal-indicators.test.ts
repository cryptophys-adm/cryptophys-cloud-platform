import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { momentumIndicators, structureIndicators, trendIndicators, volatilityIndicators, volumeIndicators, type Candle } from "../../signal-engine/src/indicators.ts";

// Fixtures are produced by tools/parity/signal_fixtures.py from pandas_ta_classic, the library the
// original Python engines import. Each value must match to its published rounding.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/signal-parity.json", import.meta.url), "utf8")) as {
  pandas_ta_classic: string;
  cases: ({ name: string; candles: Candle[] } & Record<"trend" | "volume" | "momentum" | "volatility", Record<string, number | null>> & { structure: Record<string, unknown> })[];
};

function assertParity(label: string, actual: Record<string, unknown>, expected: Record<string, number | null | boolean>) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${label}: indicator set`);
  for (const [key, want] of Object.entries(expected)) {
    const got = actual[key];
    if (want === null) { assert.equal(got, null, `${label}.${key}: expected no value`); continue; }
    if (typeof want === "boolean") { assert.equal(got, want, `${label}.${key}`); continue; }
    assert.notEqual(got, null, `${label}.${key}: expected ${want}`);
    // One unit in the last published decimal: the two runtimes may round an exact tie differently.
    const decimals = key === "obv" ? 2 : /^(adx|mfi|rsi|stoch|cci|willr)/.test(key) ? 4 : key === "supertrend_direction" ? 0 : 6;
    assert.ok(Math.abs((got as number) - want) <= 1.0001 * 10 ** -decimals, `${label}.${key}: ${got} != ${want}`);
  }
}

test(`indicator kernels match pandas_ta_classic ${fixture.pandas_ta_classic} on every fixture`, () => {
  assert.ok(fixture.cases.length >= 7);
  for (const c of fixture.cases) {
    assertParity(`${c.name}.trend`, trendIndicators(c.candles), c.trend);
    assertParity(`${c.name}.volume`, volumeIndicators(c.candles), c.volume);
    assertParity(`${c.name}.momentum`, momentumIndicators(c.candles), c.momentum);
    assertParity(`${c.name}.volatility`, volatilityIndicators(c.candles), c.volatility as never);
    // Structure is exact: zone prices are raw candle prices and indices are window positions.
    assert.deepEqual(structureIndicators(c.candles), c.structure, `${c.name}.structure`);
  }
});
