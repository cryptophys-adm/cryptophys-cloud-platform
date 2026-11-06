import { useState } from "react";
import { AlertTriangle, ArrowLeft, Ban, Check, Flag, Play } from "lucide-react";
import { Badge, Field, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { fmt } from "../lib/format";
import { statusTone } from "./Recovery";

export default function RecoveryDetail({ id }: { id: string }) {
  const { who, act, notify } = useSession();
  const { data, loading, refresh } = usePoll(() => call("recovery.plan", id), 0, [id]);
  const [ack, setAck] = useState(false);
  const [startNotes, setStartNotes] = useState("");
  const [outcome, setOutcome] = useState("completed");
  const [finishNotes, setFinishNotes] = useState("");
  const plan = data?.plan ?? data ?? {};
  const pid = String(plan.plan_id ?? id);
  const reload = () => void refresh();

  return (
    <div className="flex flex-col gap-3">
      <a href="#/recovery" className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-slate-500 hover:text-cyan-300"><ArrowLeft className="h-3 w-3" />Recovery</a>
      <Panel title={<span className="mono normal-case tracking-normal text-slate-200">{pid}</span>} right={<Badge tone={statusTone(plan.status) as any}>{plan.status ?? "—"}</Badge>}>
        {loading && !data ? <Skeleton rows={5} /> : (
          <>
            {typeof plan.created_by === "string" && plan.created_by.startsWith("agent:") && (
              <div className="mb-3 flex items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-[12px] text-amber-200"><AlertTriangle className="h-3.5 w-3.5" />Proposed by an agent; check it before approving.</div>
            )}
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              {Object.entries(plan).filter(([k]) => k !== "steps").map(([k, v]) => <div key={k}><dt className="label">{k}</dt><dd className="mono break-words text-[12px] text-slate-200">{fmt(v)}</dd></div>)}
            </dl>
            {Array.isArray(plan.steps) && (
              <ol className="mt-4 space-y-1.5">
                {plan.steps.map((s: any, i: number) => (
                  <li key={i} className="glass-inner flex gap-3 px-3 py-2 text-[12px]"><span className="mono text-cyan-300">{i + 1}</span><span className="mono text-violet-200">{s.action}</span><span className="text-slate-300">{s.description}</span></li>
                ))}
              </ol>
            )}
          </>
        )}
      </Panel>

      <Panel title="Actions">
        <div className="flex flex-wrap gap-2">
          {plan.status === "draft" && who.approver && plan.created_by !== who.actor && (
            <button type="button" className="btn btn-approve" onClick={() => act({ route: "recovery.approve", params: pid, title: `Approve plan ${pid}`, lines: ["Approval is recorded under your identity. You cannot approve a plan you authored."], done: "Plan approved.", after: reload })}><Check className="h-3.5 w-3.5" />Approve…</button>
          )}
          {plan.status && plan.status !== "executing" && (
            <button type="button" className="btn btn-danger" onClick={() => act({ route: "recovery.disable", params: pid, title: `Disable plan ${pid}`, lines: ["The plan can no longer be approved or executed."], done: "Plan disabled.", after: reload })}><Ban className="h-3.5 w-3.5" />Disable…</button>
          )}
        </div>
        {plan.status === "approved" && (
          <div className="mt-4 border-t border-white/5 pt-4">
            <label className="flex items-center gap-2 text-[12px] text-slate-300"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />I have read the steps</label>
            <Field label="Notes (optional, up to 2000)" className="mt-2"><textarea className="field" maxLength={2000} value={startNotes} onChange={(e) => setStartNotes(e.target.value)} /></Field>
            <button type="button" className="btn mt-2" onClick={() => {
              if (!ack) { notify("err", "Tick “I have read the steps” first."); return; }
              const b: any = { phase: "start", operator_acknowledged: true };
              if (startNotes.trim()) b.notes = startNotes.trim();
              act({ route: "recovery.execute_start", params: pid, body: b, title: `Start plan ${pid}`, lines: ["Marks the plan as executing. You carry out the steps; nothing runs automatically."], done: "Execution started.", after: reload });
            }}><Play className="h-3.5 w-3.5" />Start execution…</button>
          </div>
        )}
        {plan.status === "executing" && (
          <div className="mt-4 border-t border-white/5 pt-4">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[200px_1fr]">
              <Field label="Outcome"><select className="field" value={outcome} onChange={(e) => setOutcome(e.target.value)}><option>completed</option><option>failed</option></select></Field>
              <Field label="Notes (optional, up to 2000)"><input className="field" maxLength={2000} value={finishNotes} onChange={(e) => setFinishNotes(e.target.value)} /></Field>
            </div>
            <button type="button" className="btn mt-2" onClick={() => {
              const b: any = { phase: "finish", outcome };
              if (finishNotes.trim()) b.notes = finishNotes.trim();
              act({ route: "recovery.execute_finish", params: pid, body: b, title: `Finish plan ${pid}`, lines: [`Records the outcome: ${outcome}.`], done: "Execution finished.", after: reload });
            }}><Flag className="h-3.5 w-3.5" />Finish execution…</button>
          </div>
        )}
      </Panel>
    </div>
  );
}
