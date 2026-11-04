import type { BaseEnv, ExecutionContextLike, ScheduledEventLike } from "../../control-plane-shared/src/types.ts";
import {
  errorResponse, healthResponse, json, limitParam, newId, nowIso, serviceMetadata, type JsonObject,
} from "../../control-plane-shared/src/http.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { boundedString, boundedStringArray, engineFor, type AiTask } from "../../control-plane-shared/src/ai-engine.ts";
import { readinessResponse } from "../../control-plane-shared/src/readiness.ts";
import { accessGate, requireOperator } from "../../control-plane-shared/src/access.ts";
import { IMPLEMENTATION, MIN_HISTORY, WINDOW, trendIndicators, volumeIndicators, type Candle } from "./indicators.ts";

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
  /** Public market-data origin (no credentials). */
  MARKET_DATA_URL?: string;
}

const SERVICE = "cryptophys-signal-engine";
const SYMBOL = /^[A-Z0-9]{5,20}$/;
export const TIMEFRAMES_ALLOWED = ["15m", "1h", "4h", "1d"] as const;
const DEFAULT_SYMBOLS = "BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,ARBUSDT"; // apps-gitops signal-market-feed SYMBOLS
const DEFAULT_TIMEFRAMES = "1h,4h";
const DEFAULT_MARKET_DATA_URL = "https://data-api.binance.vision";
const FETCH_TIMEOUT_MS = 10_000;
const RETENTION_DAYS = 400;

export function config(env: Env): { symbols: string[]; timeframes: string[]; origin: string } | Error {
  const list = (v: string | undefined, d: string) => (v ?? d).split(",").map((s) => s.trim()).filter(Boolean);
  const symbols = list(env.SYMBOLS, DEFAULT_SYMBOLS);
  const timeframes = list(env.TIMEFRAMES, DEFAULT_TIMEFRAMES);
  const origin = env.MARKET_DATA_URL ?? DEFAULT_MARKET_DATA_URL;
  if (!symbols.length || symbols.length > 20 || !symbols.every((s) => SYMBOL.test(s))) return new Error("SYMBOLS is invalid");
  if (!timeframes.length || !timeframes.every((t) => (TIMEFRAMES_ALLOWED as readonly string[]).includes(t))) return new Error("TIMEFRAMES is invalid");
  if (!/^https:\/\/[a-z0-9.-]+$/.test(origin)) return new Error("MARKET_DATA_URL must be an https origin");
  return { symbols, timeframes, origin };
}

interface StoredCandle extends Candle { close_time: number }

/** Parse a Binance /api/v3/klines response, keeping only closed, internally consistent candles. */
export function parseKlines(body: unknown, now: number): StoredCandle[] | Error {
  if (!Array.isArray(body)) return new Error("klines response is not an array");
  const out: StoredCandle[] = [];
  for (const row of body) {
    if (!Array.isArray(row) || row.length < 7) return new Error("kline row is malformed");
    const [openTime, o, h, l, c, v, closeTime] = [row[0], row[1], row[2], row[3], row[4], row[5], row[6]].map(Number);
    if (![openTime, o, h, l, c, v, closeTime].every(Number.isFinite)) return new Error("kline row has non-numeric fields");
    if (!(closeTime > openTime && h >= Math.max(o, c, l) && l <= Math.min(o, c) && v >= 0)) return new Error("kline row is inconsistent");
    if (closeTime >= now) continue; // still forming: never stored
    out.push({ open_time: openTime, close_time: closeTime, o, h, l, c, v });
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

async function ingestSeries(env: Env, origin: string, symbol: string, timeframe: string, now: number): Promise<SeriesResult> {
  const have = await env.DB.prepare("SELECT COUNT(*) AS n FROM market_candles WHERE symbol = ? AND timeframe = ?")
    .bind(symbol, timeframe).first<{ n: number }>();
  const limit = (have?.n ?? 0) < WINDOW ? WINDOW + 1 : 5;
  let body: unknown;
  try {
    const res = await fetch(`${origin}/api/v3/klines?symbol=${symbol}&interval=${timeframe}&limit=${limit}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { symbol, timeframe, status: "error", error: `market_data_http_${res.status}` };
    body = await res.json();
  } catch (err) {
    return { symbol, timeframe, status: "error", error: (err as Error)?.name === "TimeoutError" ? "market_data_timeout" : "market_data_unreachable" };
  }
  const candles = parseKlines(body, now);
  if (candles instanceof Error) return { symbol, timeframe, status: "error", error: candles.message };

  const ingestedAt = nowIso();
  const inserts = candles.map((k) => env.DB.prepare(
    `INSERT OR IGNORE INTO market_candles (symbol, timeframe, open_time, close_time, open, high, low, close, volume, source, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(symbol, timeframe, k.open_time, k.close_time, k.o, k.h, k.l, k.c, k.v, origin, ingestedAt));
  const results = inserts.length ? await env.DB.batch(inserts) : [];
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
    for (const [engine, min, compute] of [["trend", MIN_HISTORY.trend, trendIndicators], ["volume", MIN_HISTORY.volume, volumeIndicators]] as const) {
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

/** One ingestion pass over every configured series; a failing series never blocks the others. */
export async function ingest(env: Env, now = Date.now(), trigger: "scheduled" | "manual" = "scheduled"): Promise<{ run_id: string; series: SeriesResult[]; failed: number }> {
  const startedAt = nowIso();
  const cfg = config(env);
  if (cfg instanceof Error) throw cfg;
  const series: SeriesResult[] = [];
  for (const symbol of cfg.symbols) {
    for (const timeframe of cfg.timeframes) {
      try {
        series.push(await ingestSeries(env, cfg.origin, symbol, timeframe, now));
      } catch (err) {
        series.push({ symbol, timeframe, status: "error", error: "storage_failed" });
        console.error(JSON.stringify({ service: SERVICE, event: "series_failed", symbol, timeframe, message: String((err as Error)?.message ?? err) }));
      }
    }
  }
  await env.DB.prepare("DELETE FROM market_candles WHERE open_time < ?").bind(now - RETENTION_DAYS * 86_400_000).run();
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
  return { symbol, timeframe, candle, engines, advisory_only: true };
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
          "GET /v1/signals?symbol=&timeframe=", "GET /v1/signals/history?symbol=&timeframe=&limit=", "GET /v1/status", "POST /v1/ingest",
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
