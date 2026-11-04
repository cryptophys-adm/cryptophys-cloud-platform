import type { BaseEnv, ExecutionContextLike, ScheduledEventLike } from "../../control-plane-shared/src/types.ts";
import {
  errorResponse, healthResponse, json, limitParam, newId, nowIso, serviceMetadata, type JsonObject,
} from "../../control-plane-shared/src/http.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { boundedString, boundedStringArray, engineFor, type AiTask } from "../../control-plane-shared/src/ai-engine.ts";
import { readinessResponse } from "../../control-plane-shared/src/readiness.ts";
import { accessGate, requireOperator } from "../../control-plane-shared/src/access.ts";
import {
  IMPLEMENTATION, MIN_HISTORY, WINDOW, momentumIndicators, structureIndicators, trendIndicators, volatilityIndicators,
  volumeIndicators, type Candle, type Indicators,
} from "./indicators.ts";
import { CATEGORIES, REGIME, decision, mizan, regime, tfConfluence } from "./mizan.ts";
import { MACRO_SOURCES, parseFearGreed, parseGlobal } from "./macro.ts";

const ENGINES: [string, number, (c: Candle[]) => Indicators][] = [
  ["trend", MIN_HISTORY.trend, trendIndicators],
  ["volume", MIN_HISTORY.volume, volumeIndicators],
  ["momentum", MIN_HISTORY.momentum, momentumIndicators],
  ["volatility", MIN_HISTORY.volatility, volatilityIndicators],
  ["structure", MIN_HISTORY.structure, structureIndicators],
];

/**
 * cryptophys-signal-engine (ADR-0005): the apps-gitops trend and volume signal engines,
 * migrated from NATS consumers on Kubernetes to one Worker with a Cron Trigger and D1.
 * Advisory only: public, read-only market data, no account keys, no orders.
 */
export interface Env extends BaseEnv {
  /** Comma-separated exchange symbols, e.g. "BTCUSDT,ETHUSDT". */
  SYMBOLS?: string;
  /** Comma-separated timeframes from TIMEFRAMES_ALLOWED. */
  TIMEFRAMES?: string;
  /** Public, keyless market-data provider: "kraken" (default) or "binance". */
  MARKET_DATA_PROVIDER?: string;
}

const SERVICE = "cryptophys-signal-engine";
const SYMBOL = /^[A-Z0-9]{5,20}$/;
export const TIMEFRAMES_ALLOWED = ["15m", "1h", "4h", "1d"] as const;
const DEFAULT_SYMBOLS = "BTCUSDT,ETHUSDT,SOLUSDT";
const DEFAULT_TIMEFRAMES = "1h,4h";
const TIMEFRAME_MS: Record<string, number> = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };

interface StoredCandle extends Candle { close_time: number }

/**
 * A keyless, read-only public market-data source. Binance refuses Cloudflare Worker egress
 * (every production run in signal_ingest_runs returned HTTP 403), so Kraken is the default.
 * Candles from different venues are never mixed in one series: the provider is recorded per
 * candle in `source`, and a series only accepts candles from the configured provider.
 */
export interface Provider {
  name: string;
  origin: string;
  /** Minimum spacing between requests to this provider within one ingestion pass. */
  minIntervalMs: number;
  url(symbol: string, timeframe: string, sinceOpenTime: number | null, backfill: boolean): string;
  parse(body: unknown, timeframe: string, now: number): StoredCandle[] | Error;
}

function candle(openTime: number, closeTime: number, o: number, h: number, l: number, c: number, v: number, now: number): StoredCandle | Error | null {
  if (![openTime, o, h, l, c, v, closeTime].every(Number.isFinite)) return new Error("candle has non-numeric fields");
  if (!(closeTime > openTime && h >= Math.max(o, c, l) && l <= Math.min(o, c) && v >= 0)) return new Error("candle is inconsistent");
  return closeTime >= now ? null : { open_time: openTime, close_time: closeTime, o, h, l, c, v }; // forming: never stored
}

export const PROVIDERS: Record<string, Provider> = {
  binance: {
    name: "binance",
    origin: "https://data-api.binance.vision",
    minIntervalMs: 0,
    url: (symbol, timeframe, _since, backfill) => `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${timeframe}&limit=${backfill ? WINDOW + 1 : 5}`,
    parse: (body, _tf, now) => parseKlines(body, now),
  },
  kraken: {
    name: "kraken",
    origin: "https://api.kraken.com",
    // Kraken's public endpoints allow roughly one call per second per IP; six back-to-back calls
    // produced "EGeneral:Too many requests" in production (signal_ingest_runs, 2026-11-04 05:04Z).
    minIntervalMs: 1_100,
    // Kraken names bitcoin XBT; intervals are minutes; `since` (seconds) returns committed candles after it.
    url: (symbol, timeframe, since) =>
      `https://api.kraken.com/0/public/OHLC?pair=${symbol.replace(/^BTC/, "XBT")}&interval=${TIMEFRAME_MS[timeframe] / 60_000}` +
      (since === null ? "" : `&since=${Math.floor(since / 1000)}`),
    parse: (body, timeframe, now) => parseKrakenOhlc(body, TIMEFRAME_MS[timeframe], now),
  },
};

/** Parse a Kraken /0/public/OHLC response: rows are [time(s), open, high, low, close, vwap, volume, count]. */
export function parseKrakenOhlc(body: unknown, intervalMs: number, now: number): StoredCandle[] | Error {
  const b = body as { error?: unknown; result?: Record<string, unknown> };
  if (!b || typeof b !== "object") return new Error("ohlc response is not an object");
  if (Array.isArray(b.error) && b.error.length) return new Error(`provider_error: ${String(b.error[0]).slice(0, 80)}`);
  const key = Object.keys(b.result ?? {}).find((k) => k !== "last");
  const rows = key ? b.result![key] : undefined;
  if (!Array.isArray(rows)) return new Error("ohlc response has no candle array");
  const out: StoredCandle[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 7) return new Error("ohlc row is malformed");
    const openTime = Number(row[0]) * 1000;
    const k = candle(openTime, openTime + intervalMs - 1, Number(row[1]), Number(row[2]), Number(row[3]), Number(row[4]), Number(row[6]), now);
    if (k instanceof Error) return k;
    if (k) out.push(k);
  }
  return out;
}
const FETCH_TIMEOUT_MS = 10_000;
const RETENTION_DAYS = 400;

export function config(env: Env): { symbols: string[]; timeframes: string[]; provider: string } | Error {
  const list = (v: string | undefined, d: string) => (v ?? d).split(",").map((s) => s.trim()).filter(Boolean);
  const symbols = list(env.SYMBOLS, DEFAULT_SYMBOLS);
  const timeframes = list(env.TIMEFRAMES, DEFAULT_TIMEFRAMES);
  const provider = env.MARKET_DATA_PROVIDER ?? "kraken";
  if (!symbols.length || symbols.length > 20 || !symbols.every((s) => SYMBOL.test(s))) return new Error("SYMBOLS is invalid");
  if (!timeframes.length || !timeframes.every((t) => (TIMEFRAMES_ALLOWED as readonly string[]).includes(t))) return new Error("TIMEFRAMES is invalid");
  if (!PROVIDERS[provider]) return new Error(`MARKET_DATA_PROVIDER must be one of ${Object.keys(PROVIDERS).join(", ")}`);
  return { symbols, timeframes, provider };
}

/** Parse a Binance /api/v3/klines response, keeping only closed, internally consistent candles. */
export function parseKlines(body: unknown, now: number): StoredCandle[] | Error {
  if (!Array.isArray(body)) return new Error("klines response is not an array");
  const out: StoredCandle[] = [];
  for (const row of body) {
    if (!Array.isArray(row) || row.length < 7) return new Error("kline row is malformed");
    const [openTime, o, h, l, c, v, closeTime] = [row[0], row[1], row[2], row[3], row[4], row[5], row[6]].map(Number);
    const k = candle(openTime, closeTime, o, h, l, c, v, now);
    if (k instanceof Error) return k;
    if (k) out.push(k);
  }
  return out;
}

export interface SeriesResult {
  symbol: string;
  timeframe: string;
  status: "ok" | "error";
  fetched?: number;
  inserted?: number;
  latest_open_time?: number | null;
  computed?: string[];
  error?: string;
}

const RATE_LIMIT_BACKOFF_MS = 3_000;

/** Spaces provider calls within one pass; `sleep` is injectable so tests do not wait. */
export class Pacer {
  private last = -Infinity;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => number;
  constructor(sleep?: (ms: number) => Promise<void>, clock?: () => number) {
    this.sleep = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.clock = clock ?? (() => Date.now());
  }
  async wait(ms: number): Promise<void> { if (ms > 0) await this.sleep(ms); }
  async turn(minIntervalMs: number): Promise<void> {
    const gap = this.last + minIntervalMs - this.clock();
    if (gap > 0) await this.sleep(gap);
    this.last = this.clock();
  }
}
let pace = new Pacer();
/** Test hook: replace the pacer (e.g. with a recording, non-sleeping one). */
export function setPacer(p: Pacer): void { pace = p; }

async function ingestSeries(env: Env, provider: Provider, symbol: string, timeframe: string, now: number): Promise<SeriesResult> {
  const have = await env.DB.prepare(
    "SELECT COUNT(*) AS n, MAX(open_time) AS latest, SUM(source <> ?) AS foreign_rows FROM market_candles WHERE symbol = ? AND timeframe = ?",
  ).bind(provider.origin, symbol, timeframe).first<{ n: number; latest: number | null; foreign_rows: number | null }>();
  if ((have?.foreign_rows ?? 0) > 0) return { symbol, timeframe, status: "error", error: "series_has_other_provider_candles" };
  const backfill = (have?.n ?? 0) < WINDOW;
  const url = provider.url(symbol, timeframe, backfill ? null : have?.latest ?? null, backfill);
  let parsed: StoredCandle[] | Error = new Error("not_fetched");
  // One retry after a back-off when the provider says it is rate limited; anything else fails now.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await pace.wait(RATE_LIMIT_BACKOFF_MS);
    await pace.turn(provider.minIntervalMs);
    let body: unknown;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { accept: "application/json", "user-agent": "cryptophys-signal-engine (advisory; github.com/cryptophys-adm/cryptophys-cloud-platform)" },
      });
      if (res.status === 429 && attempt === 0) { await res.body?.cancel(); continue; }
      if (!res.ok) return { symbol, timeframe, status: "error", error: `market_data_http_${res.status}` };
      body = await res.json();
    } catch (err) {
      return { symbol, timeframe, status: "error", error: (err as Error)?.name === "TimeoutError" ? "market_data_timeout" : "market_data_unreachable" };
    }
    parsed = provider.parse(body, timeframe, now);
    if (parsed instanceof Error && /too many requests|rate limit/i.test(parsed.message) && attempt === 0) continue;
    break;
  }
  if (parsed instanceof Error) return { symbol, timeframe, status: "error", error: parsed.message };
  // Only candles newer than the stored tail are written; the provider may resend history.
  const candles = parsed.filter((k) => have?.latest == null || k.open_time > have.latest).slice(-1000);

  const ingestedAt = nowIso();
  const inserts = candles.map((k) => env.DB.prepare(
    `INSERT OR IGNORE INTO market_candles (symbol, timeframe, open_time, close_time, open, high, low, close, volume, source, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(symbol, timeframe, k.open_time, k.close_time, k.o, k.h, k.l, k.c, k.v, provider.origin, ingestedAt));
  let results: Awaited<ReturnType<typeof env.DB.batch>> = [];
  for (let i = 0; i < inserts.length; i += 100) results = results.concat(await env.DB.batch(inserts.slice(i, i + 100)));
  const inserted = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);

  const rows = await env.DB.prepare(
    `SELECT open_time, open AS o, high AS h, low AS l, close AS c, volume AS v FROM market_candles
     WHERE symbol = ? AND timeframe = ? ORDER BY open_time DESC LIMIT ?`,
  ).bind(symbol, timeframe, WINDOW).all<Candle>();
  const history = rows.results.reverse();
  const latest = history.at(-1);
  const computed: string[] = [];
  if (latest) {
    const writes = [];
    for (const [engine, min, compute] of ENGINES) {
      if (history.length < min) continue;
      writes.push(env.DB.prepare(
        `INSERT OR IGNORE INTO signal_indicators (symbol, timeframe, open_time, engine, implementation, window_size, indicators_json, computed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(symbol, timeframe, latest.open_time, engine, IMPLEMENTATION, history.length, JSON.stringify(compute(history)), nowIso()));
      computed.push(engine);
    }
    if (writes.length) await env.DB.batch(writes);
  }
  return { symbol, timeframe, status: "ok", fetched: candles.length, inserted, latest_open_time: latest?.open_time ?? null, computed };
}

/**
 * Cross-series engines for one symbol, after its candles and per-series engines are stored:
 * Mizan (regime from the 1h closes, as mizan-regime subscribed to 1h KWW only) on each
 * timeframe's latest candle, then the signal-edge multi-timeframe confluence and decision bias.
 */
async function deriveSymbol(env: Env, symbol: string, timeframes: string[], now: number): Promise<void> {
  const closesOf = async (tf: string) => (await env.DB.prepare(
    "SELECT open_time, close_time, close, volume FROM market_candles WHERE symbol = ? AND timeframe = ? ORDER BY open_time DESC LIMIT ?",
  ).bind(symbol, tf, REGIME.WINDOW).all<{ open_time: number; close_time: number; close: number; volume: number }>()).results.reverse();
  const regime1h = timeframes.includes("1h") ? regime((await closesOf("1h")).map((r) => r.close)) : null;
  const state: Record<string, Record<string, { ts: number; indicators: Indicators }>> = {};
  const writes = [];
  for (const tf of timeframes) {
    const rows = await closesOf(tf);
    const latest = rows.at(-1);
    if (!latest) continue;
    const ind = await env.DB.prepare("SELECT engine, indicators_json FROM signal_indicators WHERE symbol = ? AND timeframe = ? AND open_time = ?")
      .bind(symbol, tf, latest.open_time).all<{ engine: string; indicators_json: string }>();
    const byEngine = Object.fromEntries(ind.results.map((r) => [r.engine, JSON.parse(r.indicators_json) as Indicators]));
    for (const cat of CATEGORIES) {
      if (!byEngine[cat]) continue;
      // The aggregator compares EMAs with the close, which the original trend payload never carried.
      const indicators = cat === "trend" ? { ...byEngine[cat], close: latest.close } : byEngine[cat];
      (state[cat] ??= {})[tf] = { ts: latest.close_time, indicators };
    }
    const atr14 = (byEngine.volatility?.atr_14 as number | null | undefined) ?? null;
    const m = mizan(rows.map((r) => r.close), latest.volume, tf, regime1h, latest.close, atr14);
    writes.push(env.DB.prepare(
      `INSERT OR IGNORE INTO signal_indicators (symbol, timeframe, open_time, engine, implementation, window_size, indicators_json, computed_at)
       VALUES (?, ?, ?, 'mizan', ?, ?, ?, ?)`,
    ).bind(symbol, tf, latest.open_time, IMPLEMENTATION, rows.length, JSON.stringify(m), nowIso()));
  }
  const conf = tfConfluence(state, now);
  if (conf) {
    const basis = Math.max(...Object.values(state).flatMap((byTf) => Object.values(byTf).map((e) => e.ts)));
    writes.push(env.DB.prepare(
      `INSERT OR IGNORE INTO signal_confluence (symbol, basis_close_time, implementation, confluence_score, tf_scores_json, decision_json, computed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(symbol, basis, IMPLEMENTATION, conf.confluence_score, JSON.stringify(conf.tf_scores), JSON.stringify(decision(conf.confluence_score)), nowIso()));
  }
  if (writes.length) await env.DB.batch(writes);
}

/**
 * Hourly macro context (Fear & Greed, BTC dominance, total market cap). Returns null when this
 * hour is already stored; a failed or malformed source stores nothing and is reported.
 */
export async function ingestMacro(env: Env, now: number): Promise<SeriesResult | null> {
  const hour = now - (now % 3_600_000);
  if (await env.DB.prepare("SELECT 1 AS x FROM macro_context WHERE observed_hour = ?").bind(hour).first()) return null;
  const get = async (url: string): Promise<unknown | Error> => {
    await pace.turn(1_100);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json", "user-agent": "cryptophys-signal-engine (advisory)" } });
      if (!res.ok) { await res.body?.cancel(); return new Error(`macro_http_${res.status}`); }
      return await res.json();
    } catch (err) {
      return new Error((err as Error)?.name === "TimeoutError" ? "macro_timeout" : "macro_unreachable");
    }
  };
  const fgBody = await get(MACRO_SOURCES.fear_greed);
  const glBody = await get(MACRO_SOURCES.global);
  const fg = fgBody instanceof Error ? fgBody : parseFearGreed(fgBody);
  const gl = glBody instanceof Error ? glBody : parseGlobal(glBody);
  const errors = [fg, gl].filter((x): x is Error => x instanceof Error).map((e) => e.message);
  if (errors.length) return { symbol: "MACRO", timeframe: "1h", status: "error", error: errors.join(", ") };
  const f = fg as Exclude<typeof fg, Error>;
  const g = gl as Exclude<typeof gl, Error>;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO macro_context (observed_hour, fear_greed, fear_greed_class, fear_greed_sentiment, fear_greed_time, btc_dominance, total_market_cap, sources_json, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(hour, f.fear_greed, f.fear_greed_class, f.fear_greed_sentiment, f.fear_greed_time, g.btc_dominance, g.total_market_cap, JSON.stringify(MACRO_SOURCES), nowIso()).run();
  return { symbol: "MACRO", timeframe: "1h", status: "ok", inserted: 1, computed: ["macro"] };
}

async function latestMacro(env: Env): Promise<JsonObject | null> {
  return env.DB.prepare(
    "SELECT observed_hour, fear_greed, fear_greed_class, fear_greed_sentiment, fear_greed_time, btc_dominance, total_market_cap, observed_at FROM macro_context ORDER BY observed_hour DESC LIMIT 1",
  ).first<JsonObject>();
}

/** One ingestion pass over every configured series; a failing series never blocks the others. */
export async function ingest(env: Env, now = Date.now(), trigger: "scheduled" | "manual" = "scheduled"): Promise<{ run_id: string; series: SeriesResult[]; failed: number }> {
  const startedAt = nowIso();
  const cfg = config(env);
  if (cfg instanceof Error) throw cfg;
  const series: SeriesResult[] = [];
  for (const symbol of cfg.symbols) {
    for (const timeframe of cfg.timeframes) {
      try {
        series.push(await ingestSeries(env, PROVIDERS[cfg.provider], symbol, timeframe, now));
      } catch (err) {
        series.push({ symbol, timeframe, status: "error", error: "storage_failed" });
        console.error(JSON.stringify({ service: SERVICE, event: "series_failed", symbol, timeframe, message: String((err as Error)?.message ?? err) }));
      }
    }
    try {
      await deriveSymbol(env, symbol, cfg.timeframes, now);
    } catch (err) {
      console.error(JSON.stringify({ service: SERVICE, event: "derive_failed", symbol, message: String((err as Error)?.message ?? err) }));
    }
  }
  try {
    const macro = await ingestMacro(env, now);
    if (macro) series.push(macro);
  } catch (err) {
    series.push({ symbol: "MACRO", timeframe: "1h", status: "error", error: "storage_failed" });
    console.error(JSON.stringify({ service: SERVICE, event: "macro_failed", message: String((err as Error)?.message ?? err) }));
  }
  await env.DB.prepare("DELETE FROM market_candles WHERE open_time < ?").bind(now - RETENTION_DAYS * 86_400_000).run();
  await env.DB.prepare("DELETE FROM macro_context WHERE observed_hour < ?").bind(now - RETENTION_DAYS * 86_400_000).run();
  const failed = series.filter((s) => s.status === "error").length;
  const runId = newId("sig");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO signal_ingest_runs (run_id, trigger, started_at, finished_at, series_total, series_failed, results_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(runId, trigger, startedAt, nowIso(), series.length, failed, JSON.stringify(series)),
    env.DB.prepare("DELETE FROM signal_ingest_runs WHERE started_at < ?").bind(new Date(now - 30 * 86_400_000).toISOString()),
  ]);
  console.log(JSON.stringify({ service: SERVICE, event: "ingest", run_id: runId, series: series.length, failed }));
  return { run_id: runId, series, failed };
}

interface IndicatorRow { open_time: number; engine: string; implementation: string; window_size: number; indicators_json: string; computed_at: string }

async function latestSignals(env: Env, symbol: string, timeframe: string): Promise<JsonObject | null> {
  const candle = await env.DB.prepare(
    `SELECT open_time, close_time, open, high, low, close, volume, source FROM market_candles
     WHERE symbol = ? AND timeframe = ? ORDER BY open_time DESC LIMIT 1`,
  ).bind(symbol, timeframe).first<JsonObject & { open_time: number }>();
  if (!candle) return null;
  const rows = await env.DB.prepare(
    "SELECT open_time, engine, implementation, window_size, indicators_json, computed_at FROM signal_indicators WHERE symbol = ? AND timeframe = ? AND open_time = ?",
  ).bind(symbol, timeframe, candle.open_time).all<IndicatorRow>();
  const engines: JsonObject = {};
  for (const r of rows.results) {
    engines[r.engine] = { implementation: r.implementation, window_size: r.window_size, computed_at: r.computed_at, indicators: JSON.parse(r.indicators_json) };
  }
  const confluence = await env.DB.prepare(
    "SELECT basis_close_time, implementation, confluence_score, tf_scores_json, decision_json, computed_at FROM signal_confluence WHERE symbol = ? ORDER BY basis_close_time DESC LIMIT 1",
  ).bind(symbol).first<{ tf_scores_json: string; decision_json: string } & JsonObject>();
  return {
    symbol, timeframe, candle, engines, advisory_only: true, macro: await latestMacro(env),
    confluence: confluence ? { ...confluence, tf_scores_json: undefined, decision_json: undefined, tf_scores: JSON.parse(confluence.tf_scores_json), decision: JSON.parse(confluence.decision_json) } : null,
  };
}

interface Summary { summary: string; observations: string[] }
const summaryTask: AiTask<Summary> = {
  name: "summarize_signals",
  instructions:
    'Describe what the supplied, already computed indicators show, for a human analyst. Return {"summary": at most 400 characters, ' +
    '"observations": up to 4 strings of at most 160 characters}. This is not financial advice: never recommend buying, selling, ' +
    "position sizes or orders, and never state a value that is not in the input.",
  maxInputChars: 6000,
  maxOutputTokens: 300,
  validate(output) {
    const o = output as Record<string, unknown>;
    const summary = boundedString(o?.summary, 400);
    const observations = boundedStringArray(o?.observations, 4, 160);
    if (!summary || !observations) return null;
    const advice = /\b(buy|sell|go long|go short|enter|exit|take profit|stop loss)\b/i;
    return [summary, ...observations].some((s) => advice.test(s)) ? null : { summary, observations };
  },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const blocked = await accessGate(request, env);
    if (blocked) return blocked;
    const path = url.pathname;
    if (request.method === "GET" || request.method === "HEAD") {
      if (path === "/health" || path === "/healthz") return healthResponse(env);
      if (path === "/ready" || path === "/readyz") return readinessResponse(env, { market_config_valid: !(config(env) instanceof Error) });
      if (path === "/") {
        return serviceMetadata(env, "Deterministic trend and volume indicators from public market data (advisory only; every 15 minutes)", [
          "GET /v1/signals?symbol=&timeframe=", "GET /v1/signals/history?symbol=&timeframe=&limit=", "GET /v1/status", "GET /v1/macro", "POST /v1/ingest",
        ]);
      }
    }
    if (!path.startsWith("/v1/")) return errorResponse(404, "not_found");
    const operator = await requireOperator(request, env);
    if (!operator.ok) return operator.response;
    try {
      const cfg = config(env);
      if (cfg instanceof Error) return errorResponse(503, "not_configured", cfg.message);
      if (path === "/v1/ingest" && request.method === "POST") {
        const report = await ingest(env, Date.now(), "manual");
        await appendAuditEvent(env.DB, {
          event_type: "signal.manual_ingest", actor: operator.actor, subject: SERVICE,
          outcome: report.failed ? "partial" : "success", payload: { run_id: report.run_id, failed: report.failed },
        });
        return json(report, report.failed === report.series.length ? 502 : 200);
      }
      if (path === "/v1/macro" && request.method === "GET") {
        const rows = await env.DB.prepare(
          "SELECT observed_hour, fear_greed, fear_greed_class, fear_greed_sentiment, btc_dominance, total_market_cap, observed_at FROM macro_context ORDER BY observed_hour DESC LIMIT ?",
        ).bind(limitParam(url, 24, 200)).all<JsonObject>();
        return json({ advisory_only: true, sources: MACRO_SOURCES, rows: rows.results });
      }
      if (path === "/v1/status" && request.method === "GET") {
        const rows = await env.DB.prepare(
          `SELECT symbol, timeframe, COUNT(*) AS candles, MAX(open_time) AS latest_open_time, MAX(close_time) AS latest_close_time
           FROM market_candles GROUP BY symbol, timeframe ORDER BY symbol, timeframe`,
        ).all<{ symbol: string; timeframe: string; candles: number; latest_open_time: number; latest_close_time: number }>();
        const now = Date.now();
        const runs = await env.DB.prepare(
          "SELECT run_id, trigger, started_at, finished_at, series_total, series_failed, results_json FROM signal_ingest_runs ORDER BY started_at DESC LIMIT 5",
        ).all<{ results_json: string } & JsonObject>();
        return json({
          configured: cfg,
          recent_runs: runs.results.map((r) => ({ ...r, results_json: undefined, results: JSON.parse(r.results_json) })),
          series: rows.results.map((r) => ({ ...r, age_seconds: Math.round((now - r.latest_close_time) / 1000) })),
        });
      }
      const symbol = url.searchParams.get("symbol") ?? "";
      const timeframe = url.searchParams.get("timeframe") ?? "";
      if (path === "/v1/signals" || path === "/v1/signals/history") {
        if (request.method !== "GET") return errorResponse(405, "method_not_allowed");
        if (!cfg.symbols.includes(symbol) || !cfg.timeframes.includes(timeframe)) {
          return errorResponse(400, "invalid_request", "symbol and timeframe must be configured series");
        }
        if (path === "/v1/signals/history") {
          const rows = await env.DB.prepare(
            `SELECT open_time, engine, implementation, window_size, indicators_json, computed_at FROM signal_indicators
             WHERE symbol = ? AND timeframe = ? ORDER BY open_time DESC, engine LIMIT ?`,
          ).bind(symbol, timeframe, limitParam(url)).all<IndicatorRow>();
          return json({ symbol, timeframe, advisory_only: true, rows: rows.results.map((r) => ({ ...r, indicators_json: undefined, indicators: JSON.parse(r.indicators_json) })) });
        }
        const latest = await latestSignals(env, symbol, timeframe);
        if (!latest) return errorResponse(404, "no_data", "no closed candle has been ingested for this series yet");
        if (url.searchParams.get("advisory") === "true") {
          latest.advisory = await engineFor(env, SERVICE, [summaryTask.name]).run(summaryTask, latest.engines, newId("corr"));
        }
        return json(latest);
      }
      return errorResponse(404, "not_found");
    } catch (err) {
      const id = newId("err");
      console.error(JSON.stringify({ service: SERVICE, error_id: id, message: String((err as Error)?.message ?? err) }));
      return errorResponse(500, "internal_error", undefined, { error_id: id });
    }
  },

  async scheduled(_event: ScheduledEventLike, env: Env, ctx: ExecutionContextLike): Promise<void> {
    ctx.waitUntil(ingest(env).then(() => undefined, (err) => {
      console.error(JSON.stringify({ service: SERVICE, event: "scheduled_ingest_failed", message: String((err as Error)?.message ?? err) }));
    }));
  },
};
