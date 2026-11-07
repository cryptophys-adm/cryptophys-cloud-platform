import { useState } from "react";
import { Activity, Brain, Sparkles } from "lucide-react";
import { call } from "../lib/api";
import { useOverview, healthScore } from "../lib/overview";
import { useSession } from "../lib/session";
import { Dot } from "./ui";

/** The original Nexus "AI Cognition" rail: posture, objective, confidence, active intents. */
export default function CognitionPanel() {
  const { ov, loading, error } = useOverview();
  const { notify } = useSession();
  const [summary, setSummary] = useState<{ summary?: string; attention?: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const score = healthScore(ov);
  const drifted = (ov?.services ?? []).filter((s) => s.drifted).length;
  const critical = ov?.agent_reports_24h?.counts?.critical ?? 0;
  const posture = !ov ? "unknown" : ov.agents_enabled === false ? "halted" : critical > 0 ? "degraded" : drifted > 0 ? "elevated" : "nominal";
  const style = {
    halted: { box: "border-rose-400/20 bg-rose-400/5 text-rose-300", dot: "red" as const },
    degraded: { box: "border-rose-400/15 bg-rose-400/[0.03] text-rose-300", dot: "red" as const },
    elevated: { box: "border-amber-400/15 bg-amber-400/[0.03] text-amber-200", dot: "amber" as const },
    nominal: { box: "border-cyan-400/10 bg-cyan-400/[0.04] text-slate-300", dot: "green" as const },
    unknown: { box: "border-white/10 bg-white/[0.02] text-slate-400", dot: "slate" as const },
  }[posture];
  const objective = !ov ? "Awaiting cerebrum…"
    : ov.agents_enabled === false ? "Kill switch engaged. Agents hold until an approver resumes them."
    : critical > 0 ? `Resolve ${critical} critical report${critical > 1 ? "s" : ""} before anything else.`
    : drifted > 0 ? `Reconcile ${drifted} drifted service${drifted > 1 ? "s" : ""} with the registry.`
    : "Observe, reason and attest. No intervention needed.";
  const confColor = score === null ? "bg-slate-700" : score >= 80 ? "bg-emerald-500" : score >= 50 ? "bg-amber-500" : "bg-rose-500";
  const intents = ov?.agent_reports_24h?.latest_attention ?? [];

  async function ask() {
    setBusy(true);
    try {
      const r = await call("platform.overview", undefined, undefined, { advisory: "true" });
      const a = r?.advisory;
      if (a?.status === "ok" && a.data) setSummary(a.data);
      else { setSummary(null); notify("err", `AI summary unavailable${a?.reason ? `: ${a.reason}` : ""}`); }
    } catch (e) { notify("err", (e as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="glass flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <div className="eyebrow flex items-center gap-2"><Brain className="h-3 w-3 text-cyan-400" />AI Cognition</div>
        <div className="flex items-center gap-1.5"><Dot tone={style.dot} pulse={posture !== "unknown"} /><span className="mono text-[9px] uppercase tracking-widest text-slate-600">{score === null ? "—" : `${score}%`}</span></div>
      </div>
      {loading && !ov ? (
        <div className="animate-pulse space-y-2"><div className="h-8 rounded-lg bg-white/5" /><div className="h-16 rounded-lg bg-white/5" /></div>
      ) : error && !ov ? (
        <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-[12px] text-rose-300">Cognition engine unavailable.</div>
      ) : (
        <>
          <div className={`rounded-xl border p-3 text-xs transition-colors ${style.box}`}>
            <div className="mb-1 flex items-center gap-1.5"><Activity className="h-3 w-3 shrink-0 opacity-70" /><span className="text-[9px] font-semibold uppercase tracking-wider opacity-60">{posture}</span></div>
            <p className="leading-relaxed opacity-90">{objective}</p>
          </div>
          {score !== null && (
            <div>
              <div className="mono mb-1 flex justify-between text-[9px] uppercase tracking-wider text-slate-600"><span>Confidence</span><span>{score}%</span></div>
              <div className="h-1 overflow-hidden rounded-full bg-white/5"><div className={`h-full rounded-full transition-all duration-700 ${confColor}`} style={{ width: `${score}%` }} /></div>
            </div>
          )}
          {intents.length > 0 && (
            <div>
              <div className="mb-1.5 text-[9px] font-semibold uppercase tracking-wider text-slate-600">Active Intents</div>
              <div className="space-y-1.5">
                {intents.slice(0, 3).map((it) => (
                  <div key={it.report_id} className="glass-inner flex items-start gap-2 px-2.5 py-2 text-[11px]">
                    <span className="mt-1"><Dot tone={it.severity === "critical" ? "red" : "amber"} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex justify-between"><span className="mono truncate text-[10px] text-cyan-300">{it.agent_id}</span><span className="ml-1 shrink-0 text-[9px] text-slate-600">{it.kind}</span></div>
                      <div className="mt-0.5 truncate text-[10px] italic text-slate-500">{it.subject}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
          {summary && (
            <div className="glass-inner p-3 text-[11px] leading-relaxed text-slate-300">
              <p>{summary.summary}</p>
              {(summary.attention ?? []).length > 0 && <ul className="mt-2 list-disc space-y-0.5 pl-4 text-slate-400">{summary.attention!.map((a, i) => <li key={i}>{a}</li>)}</ul>}
            </div>
          )}
        </>
      )}
      <button type="button" className="btn justify-center text-[11px]" onClick={ask} disabled={busy}>
        <Sparkles className="h-3.5 w-3.5 text-cyan-300" />{busy ? "Thinking…" : "Ask the platform AI"}
      </button>
      {!window.location.hash.startsWith("#/cognition") && <a href="#/cognition" className="text-center text-[9px] uppercase tracking-widest text-slate-600 transition-colors hover:text-cyan-400">Open Cognition Panel →</a>}
    </div>
  );
}
