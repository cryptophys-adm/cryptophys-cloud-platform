/**
 * Signal ingestion as a Cloudflare Workflow (ADR-0006). Each series, each symbol's derived
 * engines, the macro context and the run record are separate durable steps, so:
 *  - a transient provider failure (timeout, 429/5xx, Kraken "Too many requests") is retried by
 *    the step with an exponential back-off, without re-fetching the series already stored;
 *  - an isolate eviction mid-run resumes at the next step instead of losing the pass;
 *  - the last attempt still returns the failure as data, so it is recorded in
 *    signal_ingest_runs exactly as before.
 * Steps per run: series + symbols + 2 (about 12 for 3 symbols x 2 timeframes).
 */
import type { WorkflowStepLike } from "../../control-plane-shared/src/types.ts";
import { nowIso } from "../../control-plane-shared/src/http.ts";
import {
  TRANSIENT_ERRORS, config, deriveStage, ingestSeriesStage, macroStage, recordRunStage,
  type Env, type IngestParams, type SeriesResult,
} from "./index.ts";

export const SERIES_RETRIES = { limit: 3, delay: "10 seconds", backoff: "exponential" as const };
export const MACRO_RETRIES = { limit: 2, delay: "30 seconds", backoff: "exponential" as const };
export const TRANSIENT_MACRO_ERRORS = /macro_(?:timeout|unreachable|http_(?:429|5\d\d))/i;

export async function runIngest(env: Env, params: IngestParams, instanceId: string, step: WorkflowStepLike) {
  const startedAt = await step.do("start", async () => nowIso());
  const cfg = config(env);
  if (cfg instanceof Error) throw cfg;
  const series: SeriesResult[] = [];
  for (const symbol of cfg.symbols) {
    for (const timeframe of cfg.timeframes) {
      series.push(await step.do(`series ${symbol} ${timeframe}`, { retries: SERIES_RETRIES, timeout: "2 minutes" }, async (ctx) => {
        const result = await ingestSeriesStage(env, symbol, timeframe, params.now);
        // Throwing hands the retry to the Workflow engine; the final attempt records the error.
        if (result.status === "error" && TRANSIENT_ERRORS.test(result.error ?? "") && ctx.attempt <= SERIES_RETRIES.limit) {
          throw new Error(`${symbol} ${timeframe}: ${result.error}`);
        }
        return result;
      }));
    }
    await step.do(`derive ${symbol}`, async () => deriveStage(env, symbol, cfg.timeframes, params.now));
  }
  const macro = await step.do("macro", { retries: MACRO_RETRIES }, async (ctx) => {
    const result = await macroStage(env, params.now);
    // macroStage returns provider failures as data so inline ingestion can record them.
    // Re-throw only transient failures here to activate Workflow retries; preserve the
    // final failure as data so recordRunStage still records it.
    if (result?.status === "error" && TRANSIENT_MACRO_ERRORS.test(result.error ?? "") && ctx.attempt <= MACRO_RETRIES.limit) {
      throw new Error(`macro context: ${result.error}`);
    }
    return result;
  });
  if (macro) series.push(macro);
  const run = await step.do("record run", async () => recordRunStage(env, params.now, startedAt, params.trigger, series, instanceId));
  return { run_id: run.run_id, series: run.series.length, failed: run.failed };
}
