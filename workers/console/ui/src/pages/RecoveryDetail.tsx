import { useState } from "react";
import { AlertTriangle, ArrowLeft, Ban, Bot, Check, CircleDashed, ExternalLink, Loader2, Lock, MinusCircle, ShieldCheck, XCircle } from "lucide-react";
import { Badge, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, fmt } from "../lib/format";
import { statusTone } from "./Recovery";

/** One stage of the autonomous run, as the Recovery Manager records it (last_execution.pipeline). */
interface Stage { id: string; kind: string; label: string; status: string; started_at?: string; finished_at?: string; detail?: string; link?: string }

const STAGE_TONE: Record<string, string> = {
  succeeded: "border-emerald-400/40 bg-emerald-400/10 text-emerald-300",
  running: "border-cyan-400/50 bg-cyan-400/10 text-cyan-200",
  pending: "border-white/10 bg-white/[0.02] text-slate-500",
  skipped: "border-slate-400/20 bg-slate-400/5 text-slate-400",
  failed: "border-rose-400/40 bg-rose-400/10 text-rose-300",
  blocked: "border-amber-400/40 bg-amber-400/10 text-amber-200",
  cancelled: "border-white/10 bg-white/[0.02] text-slate-600",
};

function StageIcon({ status }: { status: string }) {
  const c = "h-4 w-4 shrink-0";
  if (status === "succeeded") return <Check className={`${c} text-emerald-400`} />;
  if (status === "running") return <Loader2 className={`${c} animate-spin text-cyan-300`} />;
  if (status === "failed") return <XCircle className={`${c} text-rose-400`} />;
  if (status === "blocked") return <Lock className={`${c} text-amber-300`} />;
  if (status === "skipped" || status === "cancelled") return <MinusCircle className={`${c} text-slate-500`} />;
  return <CircleDashed className={`${c} text-slate-600`} />;
}

function duration(s: Stage): string | null {
  if (!s.started_at || !s.finished_at) return null;
  const ms = Date.parse(s.finished_at) - Date.parse(s.started_at);
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`;
}

/** Pipeline progress of the autonomous run; the AI works in the background, this only watches. */
function Pipeline({ plan }: { plan: any }) {
  const exec = plan.last_execution ?? {};
  const stages: Stage[] = Array.isArray(exec.pipeline) ? exec.pipeline : [];
  const done = stages.filter((s) => !["pending", "running"].includes(s.status)).length;
  const pct = stages.length ? Math.round((done / stages.length) * 100) : 0;
  const waiting = plan.status === "approved" && stages.length === 0;
  return (
    <Panel title="Autonomous Pipeline" icon={<Bot className="h-3.5 w-3.5 text-cyan-300" />}
      right={<Badge tone={plan.status === "completed" ? "green" : plan.status === "failed" ? "red" : "cyan"}>{plan.status === "executing" || waiting ? "AI running" : plan.status}</Badge>}>
      <p className="text-[12px] leading-relaxed text-slate-400">
        After the approval click the Recovery Manager runs every step in the background: the Policy Engine checks first, each step re-checks the live state before acting, and a final stage verifies health and drift. Nothing here needs another click.
      </p>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-white/5" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className={`h-full rounded-full transition-all duration-700 ${plan.status === "failed" ? "bg-rose-400/70" : "bg-gradient-to-r from-cyan-400 to-violet-400"}`} style={{ width: `${waiting ? 4 : pct}%` }} />
      </div>
      {waiting ? (
        <div className="mt-3 flex items-center gap-2 text-[12px] text-cyan-200"><Loader2 className="h-3.5 w-3.5 animate-spin" />Approved. The AI is starting the run…</div>
      ) : (
        <ol className="mt-3 space-y-1.5">
          {stages.map((s, i) => (
            <li key={s.id} className={`flex items-start gap-3 rounded-xl border px-3 py-2 ${STAGE_TONE[s.status] ?? STAGE_TONE.pending}`}>
              <StageIcon status={s.status} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mono text-[10px] text-slate-500">{String(i + 1).padStart(2, "0")}</span>
                  <span className="mono text-[11px] text-violet-200">{s.kind}</span>
                  <span className="break-words text-[12px] text-slate-200">{s.label}</span>
                  <span className="ml-auto flex items-center gap-2 text-[10px] text-slate-500">
                    {duration(s) && <span>{duration(s)}</span>}
                    {s.finished_at && <span>{ago(s.finished_at)}</span>}
                    <span className="uppercase tracking-wider">{s.status}</span>
                  </span>
                </div>
                {s.detail && <div className="mt-0.5 break-words text-[11px] text-slate-400">{s.detail}</div>}
                {s.link && <a className="mt-0.5 inline-flex items-center gap-1 text-[11px] text-cyan-300 hover:underline" href={s.link} target="_blank" rel="noreferrer">deploy run <ExternalLink className="h-3 w-3" /></a>}
              </div>
            </li>
          ))}
        </ol>
      )}
      {exec.failed_stage && <div className="mt-3 flex items-center gap-2 rounded-xl border border-rose-400/20 bg-rose-400/5 px-3 py-2 text-[12px] text-rose-200"><AlertTriangle className="h-3.5 w-3.5" />Stopped at {exec.failed_stage.id}: {exec.failed_stage.detail}</div>}
    </Panel>
  );
}

export default function RecoveryDetail({ id }: { id: string }) {
  const { who, act } = useSession();
  // Poll quickly while the AI is working; stop when the plan is settled.
  const [live, setLive] = useState(true);
  const { data, loading, refresh } = usePoll(async () => {
    const r = await call("recovery.plan", id);
    const st = (r?.plan ?? r)?.status;
    setLive(st === "approved" || st === "executing");
    return r;
  }, live ? 4_000 : 0, [id, live]);
  const plan = data?.plan ?? data ?? {};
  const pid = String(plan.plan_id ?? id);
  const reload = () => void refresh();
  const autonomous = plan.status === "approved" || plan.last_execution?.autonomous === true;

  return (
    <div className="flex flex-col gap-3">
      <a href="#/recovery" className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-slate-500 hover:text-cyan-300"><ArrowLeft className="h-3 w-3" />Recovery</a>
      <Panel title={<span className="mono normal-case tracking-normal text-slate-200">{pid}</span>} right={<Badge tone={statusTone(plan.status) as any}>{plan.status ?? "—"}</Badge>}>
        {loading && !data ? <Skeleton rows={5} /> : (
          <>
            {typeof plan.created_by === "string" && plan.created_by.startsWith("agent:") && plan.status === "draft" && (
              <div className="mb-3 flex items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-[12px] text-amber-200"><AlertTriangle className="h-3.5 w-3.5" />Proposed by an agent. After you approve, the AI executes it on its own.</div>
            )}
            {plan.plan?.title && <h2 className="mb-1 text-[14px] text-slate-100">{plan.plan.title}</h2>}
            {plan.plan?.rationale && <p className="mb-3 whitespace-pre-line text-[12px] text-slate-400">{plan.plan.rationale}</p>}
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              {["service_id", "plan_version", "created_by", "approved_by", "created_at", "approve_by", "workflow_instance_id"].filter((k) => plan[k] != null).map((k) => (
                <div key={k}><dt className="label">{k}</dt><dd className="mono break-words text-[12px] text-slate-200">{fmt(plan[k])}</dd></div>
              ))}
            </dl>
            {Array.isArray(plan.plan?.steps) && !autonomous && (
              <ol className="mt-4 space-y-1.5">
                {plan.plan.steps.map((s: any, i: number) => (
                  <li key={i} className="glass-inner flex gap-3 px-3 py-2 text-[12px]"><span className="mono text-cyan-300">{i + 1}</span><span className="mono text-violet-200">{s.action}</span><span className="text-slate-300">{s.description}</span></li>
                ))}
              </ol>
            )}
          </>
        )}
      </Panel>

      {autonomous && <Pipeline plan={plan} />}

      <Panel title="Actions">
        <div className="flex flex-wrap items-center gap-2">
          {plan.status === "draft" && who.approver && plan.created_by !== who.actor && (
            <button type="button" className="btn btn-approve" onClick={() => act({ route: "recovery.approve", params: pid, title: `Approve plan ${pid}`,
              lines: ["Approval is recorded under your identity. You cannot approve a plan you authored.", "After approval the AI executes every step automatically and verifies the result. Follow the pipeline on this page."],
              done: "Approved. The AI is executing the plan.", after: () => { setLive(true); reload(); } })}><ShieldCheck className="h-3.5 w-3.5" />Approve…</button>
          )}
          {plan.status === "draft" && (
            <button type="button" className="btn btn-danger" onClick={() => act({ route: "recovery.disable", params: pid, title: `Disable plan ${pid}`, lines: ["The plan can no longer be approved or executed."], done: "Plan disabled.", after: reload })}><Ban className="h-3.5 w-3.5" />Disable…</button>
          )}
          {autonomous && <span className="text-[12px] text-slate-400">{plan.status === "completed" || plan.status === "failed" ? "The AI finished this plan." : "No action needed: the AI is executing this plan."}</span>}
          {!autonomous && plan.status !== "draft" && <span className="text-[12px] text-slate-500">Nothing to do.</span>}
        </div>
      </Panel>
    </div>
  );
}
