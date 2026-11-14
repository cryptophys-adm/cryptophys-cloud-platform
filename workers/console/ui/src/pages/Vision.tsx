import { Compass, Flag, Landmark, Target } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";

// ADR-0016 (Telos) T0: the organism's vision, read-only. Everything on this page comes from GET /v1/vision on the
// AI Kernel (organism/vision.json of the deployed commit). A KPI the vision has not measured or set yet is
// "not measured yet", never a default number (AGENTS.md: measured data only).
export const NOT_MEASURED = "not measured yet";

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string => (typeof v === "string" && v.trim() ? v : "—");
/** A baseline or target exactly as the vision states it; null or missing is "not measured yet". */
export const kpiValue = (v: unknown): string =>
  typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US", { maximumFractionDigits: 6 }) : typeof v === "string" && v.trim() ? v : NOT_MEASURED;
const HORIZON: Record<string, "red" | "amber" | "cyan"> = { now: "red", quarter: "amber", year: "cyan" };

function Value({ label, v }: { label: string; v: unknown }) {
  const shown = kpiValue(v);
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className={`mono break-words text-[12px] ${shown === NOT_MEASURED ? "text-slate-500" : "text-slate-100"}`}>{shown}</div>
    </div>
  );
}

export default function Vision() {
  const { data, loading, error } = usePoll(() => call("kernel.vision"), 0);
  const v: any = data?.vision ?? null;
  const problems = arr(data?.problems);
  const goals = arr(v?.growth?.goals);
  const status = typeof data?.status === "string" ? data.status : null;
  return (
    <div className="flex flex-col gap-3">
      <Panel title="Mission" icon={<Compass className="h-3.5 w-3.5 text-cyan-300" />}
        right={<span className="flex flex-wrap items-center gap-2">
          {status && <Badge tone={status === "valid" ? "green" : "red"}>{status}</Badge>}
          <span className="text-[10px] uppercase tracking-widest text-slate-600">read-only · changed only by the owner&apos;s click</span>
        </span>}>
        {loading && !data ? <Skeleton rows={2} /> : error && !data ? <Empty>The vision could not be read: {error}</Empty> : !v ? (
          <div>
            <Empty>No valid vision was served.</Empty>
            {problems.length > 0 && <ul className="mt-1 space-y-1 text-[12px] text-rose-300">{problems.map((p, i) => <li key={i} className="mono break-words">{String(p)}</li>)}</ul>}
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-[15px] leading-relaxed text-slate-100">{text(v.core?.mission)}</p>
            {typeof v.$comment === "string" && v.$comment.trim() && <p className="text-[11px] text-amber-200/80">{v.$comment}</p>}
            <div className="text-[10px] uppercase tracking-widest text-slate-600">source · {text(data?.source)} · {text(v.schema)}</div>
          </div>
        )}
      </Panel>
      {v && (<>
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel title="Identity" icon={<Flag className="h-3.5 w-3.5 text-violet-300" />}>
            <div className="mb-2 text-[10px] uppercase tracking-widest text-slate-500">Core organ</div>
            <div className="mb-3 text-[13px] text-slate-100">{text(v.core?.identity?.core_organ)}</div>
            <div className="mb-2 text-[10px] uppercase tracking-widest text-slate-500">Organs</div>
            <div className="flex flex-wrap gap-1.5">{arr(v.core?.identity?.organs).map((o, i) => <Badge key={i} tone="purple">{String(o)}</Badge>)}</div>
          </Panel>
          <Panel title="Constitution" icon={<Landmark className="h-3.5 w-3.5 text-amber-300" />}
            right={<span className="text-[10px] uppercase tracking-widest text-slate-600">never changed by AI</span>}>
            <ol className="list-decimal space-y-1.5 pl-5 text-[13px] text-slate-300">{arr(v.core?.constitution).map((c, i) => <li key={i}>{String(c)}</li>)}</ol>
          </Panel>
        </div>
        <Panel title="Goals and KPIs" icon={<Target className="h-3.5 w-3.5 text-emerald-300" />} right={<Badge tone="cyan">{goals.length} goals</Badge>}>
          {goals.length === 0 ? <Empty>The vision has no goals yet.</Empty> : (
            <div className="space-y-3">
              {goals.map((g: any) => (
                <div key={String(g.id)} className="glass-inner p-3">
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className="mono text-[13px] font-semibold text-cyan-200">{text(g.id)}</span>
                    <Badge tone={HORIZON[g.horizon] ?? "slate"}>{text(g.horizon)}</Badge>
                    {arr(g.organs).map((o, i) => <Badge key={i}>{String(o)}</Badge>)}
                  </div>
                  <div className="grid gap-2 md:grid-cols-2">
                    {arr(g.kpis).map((k: any) => (
                      <div key={String(k.id)} className="min-w-0 rounded-lg border border-white/10 p-2.5">
                        <div className="mono mb-1.5 break-words text-[12px] text-slate-200">{text(k.id)}</div>
                        <div className="grid grid-cols-2 gap-2">
                          <Value label="baseline" v={k.baseline} />
                          <Value label="target" v={k.target} />
                        </div>
                        <div className="mt-1.5 break-words text-[11px] text-slate-500">source · {text(k.source)}</div>
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 break-words text-[11px] text-slate-500">evidence · {text(g.evidence)}</p>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </>)}
    </div>
  );
}
