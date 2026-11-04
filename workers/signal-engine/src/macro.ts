/**
 * Macro context, ported from apps-gitops corpus sources (ADR-0005 decision 9):
 *  - sources/social/fetch.py and macro-dominance: Fear & Greed from api.alternative.me/fng/,
 *    normalised to [-1, 1] as (value - 50) / 50;
 *  - macro-dominance: total market cap and BTC dominance from api.coinlore.com/api/global/.
 *
 * Both sources are public and keyless. Unlike the source, a failed fetch is recorded as a
 * failure: the original returned invented values (fng=50, dxy=103.5, vix=14.5) with
 * confidence 0.98. Macro_Score is not computed: 40% of its weight is DXY/VIX scraped from an
 * unofficial Yahoo endpoint, which is not migrated.
 */
export interface MacroContext {
  fear_greed: number;
  fear_greed_class: string | null;
  fear_greed_sentiment: number;
  fear_greed_time: number | null;
  btc_dominance: number;
  total_market_cap: number;
}

export const MACRO_SOURCES = {
  fear_greed: "https://api.alternative.me/fng/",
  global: "https://api.coinlore.com/api/global/",
} as const;

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

export function parseFearGreed(body: unknown): Pick<MacroContext, "fear_greed" | "fear_greed_class" | "fear_greed_sentiment" | "fear_greed_time"> | Error {
  const row = (body as { data?: unknown[] })?.data?.[0] as Record<string, unknown> | undefined;
  const value = num(row?.value);
  if (!row || !Number.isInteger(value) || value < 0 || value > 100) return new Error("fear_greed_malformed");
  const ts = num(row.timestamp);
  return {
    fear_greed: value,
    fear_greed_class: typeof row.value_classification === "string" ? row.value_classification.slice(0, 40) : null,
    fear_greed_sentiment: (value - 50) / 50.0,
    fear_greed_time: Number.isFinite(ts) ? ts * 1000 : null,
  };
}

export function parseGlobal(body: unknown): Pick<MacroContext, "btc_dominance" | "total_market_cap"> | Error {
  const row = Array.isArray(body) ? (body[0] as Record<string, unknown>) : undefined;
  const mcap = num(row?.total_mcap);
  const dom = num(row?.btc_d);
  if (!row || !(mcap > 0) || !(dom >= 0 && dom <= 100)) return new Error("global_malformed");
  return { btc_dominance: dom, total_market_cap: mcap };
}
