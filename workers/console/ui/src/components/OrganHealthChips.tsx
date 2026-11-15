import type { Overview } from "../lib/overview";
import { ago } from "../lib/format";

// Owner 2026-11-15: the trading organ's health as the Signal Analyst measures it (GET /v1/overview →
// trading_organ_health, its newest metric snapshot). Every value is the kernel's; a missing one is "—", and a
// metric the source does not expose yet says so. Display only: no decision, no advice, no level.
const LABELS: Record<string, string> = {
  decisions_24h: "decisions 24h",
  share_buy_24h: "BUY share",
  share_sell_24h: "SELL share",
  share_wait_24h: "WAIT share",
  share_no_trade_24h: "NO_TRADE share",
  latest_decision_age_bars: "latest age (bars)",
  flips_24h: "flips 24h",
  confidence_mean_24h: "conf mean",
  confidence_p50_24h: "conf p50",
  confidence_min_24h: "conf min",
  confidence_max_24h: "conf max",
  hit_rate_7d: "hit rate 7d",
  hit_rate_30d: "hit rate 30d",
  staleness_incidents_24h: "stale 24h",
  staleness_incidents_7d: "stale 7d",
};
const PERCENT = /^(share_|hit_rate_)/;

const shown = (metric: string, v: number | null | undefined) =>
  typeof v !== "number" ? "—" : PERCENT.test(metric) ? `${Math.round(v * 100)}%` : String(v);

export default function OrganHealthChips({ h }: { h: Overview["trading_organ_health"] }) {
  if (!h) return <p className="text-[11px] text-slate-500">No trading organ health snapshot yet.</p>;
  if (h.error) return <p className="text-[11px] text-slate-500">Trading organ health unavailable.</p>;
  const metrics = Array.isArray(h.metrics) ? h.metrics : [];
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-widest text-slate-500">
        <span>Trading organ health</span>
        <span className="normal-case tracking-normal text-slate-600">{h.reported_at ? `snapshot ${ago(h.reported_at)}` : "—"}</span>
        {h.stale === true && <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-amber-300">stale</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {metrics.map((m) => {
          const z = typeof m.z === "number" ? m.z : null;
          const tone = z !== null && Math.abs(z) >= 3 ? "border-rose-400/30 text-rose-300" : z !== null && Math.abs(z) >= 2 ? "border-amber-400/30 text-amber-300" : "border-white/10 text-slate-200";
          const unexposed = m.status === "unavailable_source_field";
          const title = unexposed ? "not exposed by the source yet" : `baseline 7d: ${typeof m.baseline_7d === "number" ? m.baseline_7d : "—"}`;
          return (
            <span key={m.metric} title={title} className={`mono inline-flex items-center gap-1.5 rounded-full border bg-white/[0.03] px-2 py-0.5 text-[10px] ${tone}`}>
              <span className="text-slate-500">{LABELS[m.metric] ?? m.metric}</span>
              <span>{unexposed ? "not exposed" : shown(m.metric, m.value)}</span>
              {z !== null && <span className="text-slate-500">z {z}</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}
