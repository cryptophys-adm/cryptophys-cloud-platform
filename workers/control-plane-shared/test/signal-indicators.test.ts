import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { trendIndicators, volumeIndicators, type Candle } from "../../signal-engine/src/indicators.ts";

// Fixtures are produced by tools/parity/signal_fixtures.py from pandas_ta_classic, the library the
// original Python engines import. Each value must match to its published rounding.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/signal-parity.json", import.meta.url), "utf8")) as {
  pandas_ta_classic: string;
  cases: { name: string; candles: Candle[]; trend: Record<string, number | null>; volume: Record<string, number | null> }[];
};

function assertParity(label: string, actual: Record<string, number | null>, expected: Record<string, number | null>) {
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${label}: indicator set`);
  for (const [key, want] of Object.entries(expected)) {
    const got = actual[key];
    if (want === null) { assert.equal(got, null, `${label}.${key}: expected no value`); continue; }
    assert.notEqual(got, null, `${label}.${key}: expected ${want}`);
    // One unit in the last published decimal: the two runtimes may round an exact tie differently.
    const decimals = key === "obv" ? 2 : /^(adx|mfi)/.test(key) ? 4 : key === "supertrend_direction" ? 0 : 6;
    assert.ok(Math.abs((got as number) - want) <= 1.0001 * 10 ** -decimals, `${label}.${key}: ${got} != ${want}`);
  }
}

test(`indicator kernels match pandas_ta_classic ${fixture.pandas_ta_classic} on every fixture`, () => {
  assert.ok(fixture.cases.length >= 7);
  for (const c of fixture.cases) {
    assertParity(`${c.name}.trend`, trendIndicators(c.candles), c.trend);
    assertParity(`${c.name}.volume`, volumeIndicators(c.candles), c.volume);
  }
});
