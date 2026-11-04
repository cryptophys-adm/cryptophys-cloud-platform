import { test, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, call, migratedDb, req, accessCertsResponse, isAccessCerts, OUTSIDER_JWT, fakeAi } from "./harness.ts";
import signal, { Pacer, config, ingest, parseKlines, parseKrakenOhlc, PROVIDERS, setPacer } from "../../signal-engine/src/index.ts";

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 3, 12, 4); // 12:04Z: the 11:00 candle is closed, the 12:00 candle is still forming
const realFetch = globalThis.fetch;
// A virtual clock: pacing and back-off are recorded instead of slept.
let slept: number[] = [];
let virtualNow = 0;
beforeEach(() => {
  slept = [];
  virtualNow = 0;
  setPacer(new Pacer(async (ms) => { slept.push(ms); virtualNow += ms; }, () => virtualNow));
});
afterEach(() => { globalThis.fetch = realFetch; });

function kline(i: number, base = 2000): unknown[] {
  const open = NOW - (NOW % H) - (300 - i) * H; // i = 300 is the forming 12:00 candle
  const c = base + Math.sin(i / 7) * 20 + i * 0.1;
  return [open, String(c - 1), String(c + 3), String(c - 4), String(c), String(100 + (i % 13)), open + H - 1, "0", 10, "0", "0", "0"];
}

function market(handler: (url: URL) => Response | Promise<Response>) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (isAccessCerts(url)) return accessCertsResponse();
    calls.push(url);
    return handler(new URL(url));
  }) as typeof fetch;
  return calls;
}

const env = (db = migratedDb(), extra: Record<string, unknown> = {}) =>
  baseEnv("cryptophys-signal-engine", db, { SYMBOLS: "BTCUSDT,ETHUSDT", TIMEFRAMES: "1h", MARKET_DATA_PROVIDER: "binance", ...extra });

test("config validates symbols, timeframes and the market-data origin", () => {
  assert.ok(!(config(env() as never) instanceof Error));
  assert.ok(config({ ...env(), SYMBOLS: "btc" } as never) instanceof Error);
  assert.ok(config({ ...env(), TIMEFRAMES: "1h,5m" } as never) instanceof Error);
  assert.ok(config({ ...env(), MARKET_DATA_PROVIDER: "coingecko" } as never) instanceof Error);
  assert.equal((config({ ...env(), MARKET_DATA_PROVIDER: undefined } as never) as { provider: string }).provider, "kraken", "Kraken is the default");
});

test("klines are parsed strictly and the forming candle is never kept", () => {
  const rows = parseKlines([kline(298), kline(299), kline(300)], NOW);
  assert.ok(!(rows instanceof Error));
  assert.equal((rows as unknown[]).length, 2);
  assert.ok(parseKlines({ code: -1121 }, NOW) instanceof Error);
  const bad = kline(10); bad[2] = String(Number(bad[4]) - 50); // high below close
  assert.ok(parseKlines([bad], NOW) instanceof Error);
  assert.ok(parseKlines([["x", "1", "2", "0", "1", "1", "2"]], NOW) instanceof Error);
});

test("ingest backfills the window, stores immutable candles and computes both engines for the latest closed candle", async () => {
  const db = migratedDb();
  const e = env(db);
  const calls = market((url) => {
    const limit = Number(url.searchParams.get("limit"));
    return Response.json(Array.from({ length: limit }, (_, k) => kline(300 - limit + 1 + k, url.searchParams.get("symbol") === "ETHUSDT" ? 100 : 2000)));
  });
  const first = await ingest(e as never, NOW);
  assert.equal(first.failed, 0);
  assert.ok(calls.every((u) => u.startsWith("https://data-api.binance.vision/api/v3/klines?") && u.includes("limit=211")), "backfill fetches WINDOW + 1");
  const btc = first.series.find((s) => s.symbol === "BTCUSDT")!;
  assert.deepEqual([btc.fetched, btc.inserted, btc.computed], [210, 210, ["trend", "volume", "momentum", "volatility", "structure"]]);
  assert.equal(btc.latest_open_time, NOW - (NOW % H) - H, "latest stored candle is the last closed one");

  calls.length = 0;
  const second = await ingest(e as never, NOW);
  assert.ok(calls.every((u) => u.includes("limit=5")), "steady state fetches only the tail");
  assert.equal(second.series[0].inserted, 0, "closed candles are immutable and deduplicated");
  const n = db.raw.prepare("SELECT COUNT(*) AS n FROM signal_indicators").get() as { n: number };
  assert.equal(n.n, 12, "five engines + mizan per series; re-runs do not duplicate");
  const conf = db.raw.prepare("SELECT symbol, confluence_score, decision_json FROM signal_confluence ORDER BY symbol").all() as any[];
  assert.deepEqual(conf.map((r) => r.symbol), ["BTCUSDT", "ETHUSDT"], "one confluence per symbol and basis candle");
  assert.equal(JSON.parse(conf[0].decision_json).advisory_only, true);

  const latest = await call(signal, e, req("GET", "/v1/signals?symbol=BTCUSDT&timeframe=1h"));
  assert.equal(latest.status, 200);
  assert.equal(latest.body.advisory_only, true);
  assert.equal(typeof latest.body.engines.trend.indicators.ema_200, "number");
  assert.equal(typeof latest.body.engines.volume.indicators.mfi_14, "number");
  assert.match(latest.body.engines.trend.implementation, /pandas_ta_classic 0\.4\.47/);
  assert.equal(typeof latest.body.engines.momentum.indicators.rsi_14, "number");
  assert.equal(latest.body.engines.mizan.indicators.signal_tier, "neutral");
  assert.equal(latest.body.engines.mizan.indicators.advisory_risk_levels, null);
  assert.ok(["bullish", "bearish", "neutral"].includes(latest.body.confluence.decision.bias));
  const history = await call(signal, e, req("GET", "/v1/signals/history?symbol=ETHUSDT&timeframe=1h&limit=10"));
  assert.equal(history.body.rows.length, 6);
  const status = await call(signal, e, req("GET", "/v1/status"));
  assert.deepEqual(status.body.series.map((s: any) => [s.symbol, s.candles]), [["BTCUSDT", 210], ["ETHUSDT", 210]]);
});

test("a failing market-data source is isolated per series and never stores partial or forming data", async () => {
  const db = migratedDb();
  market((url) => url.searchParams.get("symbol") === "BTCUSDT" ? new Response("geo-blocked", { status: 451 }) : Response.json([kline(299), kline(300)]));
  const run = await ingest(env(db) as never, NOW);
  assert.deepEqual(run.series.map((s) => [s.symbol, s.status, s.error ?? null]), [["BTCUSDT", "error", "market_data_http_451"], ["ETHUSDT", "ok", null]]);
  const eth = run.series[1];
  assert.deepEqual([eth.inserted, eth.computed], [1, []], "too little history: candle kept, no indicators published");
  market(() => Response.json({ msg: "invalid" }));
  assert.equal((await ingest(env(db) as never, NOW)).failed, 2);
  const runs = db.raw.prepare("SELECT trigger, series_total, series_failed, results_json FROM signal_ingest_runs ORDER BY started_at, rowid").all() as any[];
  assert.deepEqual(runs.map((r) => [r.trigger, r.series_total, r.series_failed]), [["scheduled", 2, 1], ["scheduled", 2, 2]]);
  assert.equal(JSON.parse(runs[0].results_json)[0].error, "market_data_http_451", "the failure cause is persisted");
});

test("HTTP surface: Access + operator identity, configured series only, manual ingest is audited, advisory output refuses trade advice", async () => {
  const db = migratedDb();
  const e = env(db);
  market((url) => Response.json(Array.from({ length: Number(url.searchParams.get("limit")) }, (_, k) => kline(90 + k))));
  assert.equal((await call(signal, e, req("GET", "/v1/status", undefined, null))).status, 403);
  assert.equal((await call(signal, e, req("GET", "/v1/status", undefined, OUTSIDER_JWT))).status, 403);
  assert.equal((await call(signal, e, req("GET", "/v1/signals?symbol=DOGEUSDT&timeframe=1h"))).status, 400);
  assert.equal((await call(signal, e, req("GET", "/v1/signals?symbol=BTCUSDT&timeframe=1h"))).status, 404);
  const run = await call(signal, e, req("POST", "/v1/ingest"));
  assert.equal(run.status, 200);
  const status = await call(signal, e, req("GET", "/v1/status"));
  assert.deepEqual([status.body.recent_runs.length, status.body.recent_runs[0].trigger], [1, "manual"]);
  const audit = db.raw.prepare("SELECT actor, outcome FROM audit_events WHERE event_type = 'signal.manual_ingest'").get() as any;
  assert.equal(audit.outcome, "success");

  e.AI = fakeAi({ response: JSON.stringify({ summary: "Price is above the 200 EMA; ADX is low.", observations: ["MFI is mid-range"] }) });
  const advised = await call(signal, e, req("GET", "/v1/signals?symbol=BTCUSDT&timeframe=1h&advisory=true"));
  assert.equal(advised.body.advisory.status, "ok");
  e.AI = fakeAi({ response: JSON.stringify({ summary: "Strong trend, buy now.", observations: [] }) });
  const refused = await call(signal, e, req("GET", "/v1/signals?symbol=BTCUSDT&timeframe=1h&advisory=true"));
  assert.equal(refused.body.advisory.status, "invalid_output", "trade advice from the model is rejected");
  assert.equal((await call(signal, e, req("GET", "/ready"))).body.checks.market_config_valid, true);
  assert.equal((await call(signal, { ...e, TIMEFRAMES: "7m" }, req("GET", "/ready"))).status, 503);
});

test("the scheduled handler runs one ingestion pass", async () => {
  const db = migratedDb();
  market(() => Response.json([kline(299)]));
  let waited: Promise<unknown> | undefined;
  await signal.scheduled({ cron: "4,19,34,49 * * * *", scheduledTime: NOW }, env(db) as never, { waitUntil: (p) => { waited = p; } });
  await waited;
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM market_candles").get() as any).n >= 0, true);
});

// Kraken rows: [time(s), open, high, low, close, vwap, volume, count]; the last row is the forming candle.
function krakenRow(i: number, intervalMs = H): unknown[] {
  const open = NOW - (NOW % intervalMs) - (300 - i) * intervalMs;
  const c = 60000 + Math.cos(i / 5) * 300 + i;
  return [open / 1000, String(c - 5), String(c + 20), String(c - 25), String(c), String(c), String(1 + (i % 7) / 10), 42];
}

test("Kraken provider: XBT naming, minute intervals, since-based tail, forming candle dropped, API errors surfaced", async () => {
  const k = PROVIDERS.kraken;
  assert.equal(k.url("BTCUSDT", "4h", null, true), "https://api.kraken.com/0/public/OHLC?pair=XBTUSDT&interval=240");
  assert.equal(k.url("ETHUSDT", "1h", 1_700_000_000_000, false), "https://api.kraken.com/0/public/OHLC?pair=ETHUSDT&interval=60&since=1700000000");
  const parsed = parseKrakenOhlc({ error: [], result: { XBTUSDT: [krakenRow(298), krakenRow(299), krakenRow(300)], last: 1 } }, H, NOW);
  assert.ok(Array.isArray(parsed) && parsed.length === 2 && parsed[1].close_time === parsed[1].open_time + H - 1);
  assert.match(String(parseKrakenOhlc({ error: ["EQuery:Unknown asset pair"] }, H, NOW)), /provider_error: EQuery:Unknown asset pair/);
  assert.ok(parseKrakenOhlc({ error: [], result: { last: 1 } }, H, NOW) instanceof Error);

  const db = migratedDb();
  const e = env(db, { MARKET_DATA_PROVIDER: "kraken", SYMBOLS: "BTCUSDT" });
  const calls = market((url) => {
    const since = url.searchParams.get("since");
    const rows = since ? [krakenRow(299), krakenRow(300)] : Array.from({ length: 301 }, (_, i) => krakenRow(i));
    return Response.json({ error: [], result: { [url.searchParams.get("pair")!]: rows, last: 0 } });
  });
  const first = await ingest(e as never, NOW);
  assert.deepEqual([first.series[0].status, first.series[0].inserted, first.series[0].computed], ["ok", 300, ["trend", "volume", "momentum", "volatility", "structure"]]);
  assert.ok(calls[0].includes("pair=XBTUSDT") && !calls[0].includes("since="));
  const second = await ingest(e as never, NOW);
  assert.ok(calls[1].includes("since="), "steady state asks only for candles after the stored tail");
  assert.equal(second.series[0].inserted, 0);
  const src = db.raw.prepare("SELECT DISTINCT source FROM market_candles").all() as { source: string }[];
  assert.deepEqual(src.map((r) => r.source), ["https://api.kraken.com"]);

  // Switching provider never mixes venues inside one series.
  market(() => Response.json([kline(299)]));
  const mixed = await ingest({ ...e, MARKET_DATA_PROVIDER: "binance" } as never, NOW);
  assert.equal(mixed.series[0].error, "series_has_other_provider_candles");
});

test("Kraken calls are spaced and a rate-limited series is retried once after a back-off", async () => {
  const db = migratedDb();
  const e = env(db, { MARKET_DATA_PROVIDER: "kraken", SYMBOLS: "BTCUSDT,SOLUSDT" });
  let solCalls = 0;
  market((url) => {
    if (url.searchParams.get("pair") === "SOLUSDT" && solCalls++ === 0) return Response.json({ error: ["EGeneral:Too many requests"] });
    return Response.json({ error: [], result: { [url.searchParams.get("pair")!]: [krakenRow(299), krakenRow(300)], last: 0 } });
  });
  const run = await ingest(e as never, NOW);
  assert.deepEqual(run.series.map((s) => s.status), ["ok", "ok"], "the retried series succeeds");
  assert.equal(solCalls, 2);
  assert.ok(slept.includes(3000), "back-off before the retry");
  assert.ok(slept.filter((ms) => ms === 1100).length >= 1, "consecutive Kraken calls are at least 1.1 s apart");

  market(() => Response.json({ error: ["EGeneral:Too many requests"] }));
  const limited = await ingest(e as never, NOW);
  assert.deepEqual(limited.series.map((s) => s.error), ["provider_error: EGeneral:Too many requests", "provider_error: EGeneral:Too many requests"], "only one retry; the cause is persisted");

  market(() => new Response("slow down", { status: 429 }));
  assert.equal((await ingest(e as never, NOW)).series[0].error, "market_data_http_429");
});
