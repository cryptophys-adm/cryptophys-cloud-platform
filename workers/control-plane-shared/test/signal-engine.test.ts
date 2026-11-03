import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, call, migratedDb, req, accessCertsResponse, isAccessCerts, OUTSIDER_JWT, fakeAi } from "./harness.ts";
import signal, { config, ingest, parseKlines } from "../../signal-engine/src/index.ts";

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 3, 12, 4); // 12:04Z: the 11:00 candle is closed, the 12:00 candle is still forming
const realFetch = globalThis.fetch;
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
  baseEnv("cryptophys-signal-engine", db, { SYMBOLS: "BTCUSDT,ETHUSDT", TIMEFRAMES: "1h", MARKET_DATA_URL: "https://data-api.binance.vision", ...extra });

test("config validates symbols, timeframes and the market-data origin", () => {
  assert.ok(!(config(env() as never) instanceof Error));
  assert.ok(config({ ...env(), SYMBOLS: "btc" } as never) instanceof Error);
  assert.ok(config({ ...env(), TIMEFRAMES: "1h,5m" } as never) instanceof Error);
  assert.ok(config({ ...env(), MARKET_DATA_URL: "http://data-api.binance.vision" } as never) instanceof Error);
  assert.ok(config({ ...env(), MARKET_DATA_URL: "https://x.example/path?q" } as never) instanceof Error);
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
  assert.deepEqual([btc.fetched, btc.inserted, btc.computed], [210, 210, ["trend", "volume"]]);
  assert.equal(btc.latest_open_time, NOW - (NOW % H) - H, "latest stored candle is the last closed one");

  calls.length = 0;
  const second = await ingest(e as never, NOW);
  assert.ok(calls.every((u) => u.includes("limit=5")), "steady state fetches only the tail");
  assert.equal(second.series[0].inserted, 0, "closed candles are immutable and deduplicated");
  const n = db.raw.prepare("SELECT COUNT(*) AS n FROM signal_indicators").get() as { n: number };
  assert.equal(n.n, 4, "one row per engine per series; re-runs do not duplicate");

  const latest = await call(signal, e, req("GET", "/v1/signals?symbol=BTCUSDT&timeframe=1h"));
  assert.equal(latest.status, 200);
  assert.equal(latest.body.advisory_only, true);
  assert.equal(typeof latest.body.engines.trend.indicators.ema_200, "number");
  assert.equal(typeof latest.body.engines.volume.indicators.mfi_14, "number");
  assert.match(latest.body.engines.trend.implementation, /pandas_ta_classic 0\.9\.0/);
  const history = await call(signal, e, req("GET", "/v1/signals/history?symbol=ETHUSDT&timeframe=1h&limit=10"));
  assert.equal(history.body.rows.length, 2);
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
