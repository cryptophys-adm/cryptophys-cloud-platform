import { useState } from "react";
import { ArrowUpCircle, Check, Gavel, LineChart, Minus, OctagonX, ShieldAlert, Vote, X } from "lucide-react";
import { Badge, Dot, Empty, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, listOf } from "../lib/format";
import { describeAction, explainReason } from "../lib/plain";

export const statusTone = (s?: string): "green" | "amber" | "red" | "cyan" | "purple" | "slate" =>
  s === "shadow_passed" || s === "executed" ? "green" : s === "pending_owner" ? "purple" : s === "shadow_blocked" ? "amber" : s === "rejected" || s === "failed" ? "red" : s === "executing" ? "cyan" : "slate";

const MODE_TEXT: Record<string, string> = {
  shadow: "Shadow: proposals are voted, tallied and policy-checked, but nothing executes.",
  routine: "Routine: passed reversible actions execute; critical ones wait for an owner click.",
  deploy: "Deploy: passed routine actions, including green deploys, execute.",
  critical: "Critical: critical actions execute after consensus and an owner click.",
};

function Votes({ id }: { id: string }) {
  const { data, loading } = usePoll(() => call("kernel.consensus_proposal", id), 0, [id]);
  const votes = listOf(data, "votes");
  if (loading && !data) return <Skeleton rows={3} />;
  return (
    <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
      {votes.map((v: any) => (
        <div key={v.voter_agent_id} className="glass-inner flex items-start gap-2 px-3 py-2 text-[11px]">
          {v.vote === "approve" ? <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" /> : v.vote === "reject" ? <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose-400" /> : <Minus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" />}
          <div className="min-w-0"><div className="mono text-cyan-200">{v.voter_agent_id}</div><div className="text-slate-400">{v.reason}</div></div>
        </div>
      ))}
    </div>
  );
}

/** ADR-0009 phase 4: the actions the platform can execute after an owner click. Others are done by runbook. */
const OWNER_EXECUTABLE = new Set(["register_principal", "retire_worker"]);

function OwnerQueue({ rows, mode, reload }: { rows: any[]; mode: string; reload: () => void }) {
  const { who, act } = useSession();
  const pending = rows.filter((p) => p.status === "pending_owner");
  return (
    <Panel title="Owner Approval Queue" icon={<ShieldAlert className="h-3.5 w-3.5 text-fuchsia-300" />} right={<Badge tone={pending.length ? "purple" : "slate"}>{pending.length}</Badge>}>
      {pending.length === 0 ? (
        <Empty>Nothing waits for you. Critical actions reach this queue only in mode critical, after the agents pass them and the Policy Engine allows them.</Empty>
      ) : (
        <div className="space-y-2">
          {pending.map((p: any) => {
            const runnable = OWNER_EXECUTABLE.has(p.action);
            return (
              <div key={p.proposal_id} className="glass-inner px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Dot tone="purple" pulse />
                  <span className="mono text-[12px] text-fuchsia-200">{p.action}</span>
                  <span className="mono break-all text-[11px] text-slate-300">→ {p.target}</span>
                  <span className="mono text-[11px] text-slate-400">{p.approvals}/{p.eligible} agents approve</span>
                  <span className="ml-auto text-[10px] text-slate-500">{ago(p.created_at)} · expires after 24 h</span>
                </div>
                {!runnable && <div className="mt-1 text-[11px] text-amber-300">No platform executor: carry it out by its runbook, then reject this proposal to close it.</div>}
                {who.approver ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {runnable && mode === "critical" && (
                      <button type="button" className="btn btn-approve" onClick={() => act({ route: "kernel.consensus_approve", params: p.proposal_id, body: {}, title: `Approve ${p.action} → ${p.target}`,
                        lines: ["Your click is recorded under your Access identity and is final.", "The Policy Engine re-checks, then the platform executes it immediately.", p.action === "retire_worker" ? "Retiring deletes the Worker from Cloudflare. D1 data is not touched." : "The principal can act as this agent until revoked."],
                        done: "Approved and executed.", after: reload })}><Check className="h-3.5 w-3.5" />Approve…</button>
                    )}
                    <button type="button" className="btn btn-danger" onClick={() => act({ route: "kernel.consensus_reject", params: p.proposal_id, body: {}, title: `Reject ${p.action} → ${p.target}`,
                      lines: ["The proposal is closed as rejected; nothing executes."], done: "Rejected.", after: reload })}><X className="h-3.5 w-3.5" />Reject…</button>
                  </div>
                ) : <div className="mt-1 text-[11px] text-slate-500">Only an approver can decide.</div>}
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

/** Wave B: does the shadow consensus agree with what people did? Evidence for promoting the mode. */
function Agreement() {
  const { data, loading } = usePoll(() => call("kernel.consensus_report", undefined, undefined, { days: "7" }), 300_000);
  const rate = typeof data?.agreement_rate === "number" ? Math.round(data.agreement_rate * 100) : null;
  const items = listOf(data, "items").filter((i: any) => i.verdict !== "pending").slice(0, 8);
  return (
    <Panel title="Shadow Agreement · 7 days" icon={<LineChart className="h-3.5 w-3.5 text-emerald-300" />}
      right={<Badge tone={rate === null ? "slate" : rate >= 90 ? "green" : rate >= 70 ? "amber" : "red"}>{rate === null ? "not enough data" : `${rate}% agree`}</Badge>}>
      {loading && !data ? <Skeleton rows={3} /> : (
        <>
          <p className="text-[12px] leading-relaxed text-slate-400">Each proposal is compared with what people did afterwards. Promotion out of shadow needs at least 7 days and no false positive (ADR-0009).</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Badge tone="green">agree · {data?.agree ?? 0}</Badge>
            <Badge tone="red">false positive · {data?.false_positive ?? 0}</Badge>
            <Badge tone="amber">false negative · {data?.false_negative ?? 0}</Badge>
            <Badge tone="slate">pending · {data?.pending ?? 0}</Badge>
          </div>
          {items.length > 0 && (
            <div className="mt-3 space-y-1">
              {items.map((i: any) => (
                <div key={i.proposal_id} className="glass-inner flex flex-wrap items-center gap-2 px-3 py-1.5 text-[11px]">
                  <Badge tone={i.verdict === "agree" ? "green" : i.verdict === "false_positive" ? "red" : "amber"}>{String(i.verdict).replace("_", " ")}</Badge>
                  <span className="mono text-cyan-200">{i.action}</span>
                  <span className="mono break-all text-slate-300">→ {i.target}</span>
                  <span className="text-slate-500">{i.evidence}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

const MODES = ["shadow", "routine", "deploy", "critical"] as const;
const MODE_EFFECT: Record<string, string> = {
  routine: "Agents will execute passed reversible actions themselves: suspend/resume agents, registry changes, drift observation.",
  deploy: "Agents will also deploy CI-green commits from main and roll back on their own (1 per target per hour, 6 per day, automatic rollback).",
  critical: "Critical actions will reach your Owner Approval Queue and run after your click.",
};

/** Owner decision 2026-11-06: a person sets the mode. Raising needs an approver; anyone may brake back to shadow. */
function ModeControl({ mode, reload }: { mode: string; reload: () => void }) {
  const { who, act } = useSession();
  const idx = MODES.indexOf(mode as (typeof MODES)[number]);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {who.approver && MODES.filter((_, i) => i > idx).map((m) => (
        <button key={m} type="button" className="btn btn-approve" onClick={() => act({ route: "kernel.consensus_mode_raise", body: { mode: m, confirm: "RAISE MODE", reason: "owner raised the mode in the Console" },
          title: `Raise the consensus mode to ${m}`, lines: [MODE_EFFECT[m], "Recorded in the audit chain under your identity. Any operator can return to shadow at any time."],
          done: `Mode is now ${m}.`, after: reload })}><ArrowUpCircle className="h-3.5 w-3.5" />Mode: {m}…</button>
      ))}
      {idx > 0 && (
        <button type="button" className="btn btn-danger" onClick={() => act({ route: "kernel.consensus_mode_shadow", body: { mode: "shadow", confirm: "SHADOW", reason: "brake: back to shadow from the Console" },
          title: "Back to shadow", lines: ["Agents stop executing at once; proposals are only recorded again."], done: "Mode is now shadow.", after: reload })}><OctagonX className="h-3.5 w-3.5" />Back to shadow…</button>
      )}
    </div>
  );
}

export default function Consensus() {
  useSession();
  const { data, loading, error, refresh } = usePoll(() => call("kernel.consensus", undefined, undefined, { limit: "50" }), 60_000);
  const [open, setOpen] = useState<string | null>(null);
  const rows = listOf(data, "proposals");
  const stats: Record<string, number> = data?.stats_24h ?? {};
  const mode = data?.mode ?? "—";
  return (
    <div className="flex flex-col gap-3">
      <Panel title="Consensus Engine" icon={<Gavel className="h-3.5 w-3.5 text-violet-300" />} right={<Badge tone={mode === "shadow" ? "amber" : "purple"}>mode · {mode}</Badge>}>
        <p className="text-[12px] leading-relaxed text-slate-400">{MODE_TEXT[mode] ?? "Loading mode…"} A proposal passes with a simple majority of the eligible control-plane agents (the proposer does not vote) and a Policy Engine allow. Trading is never proposable.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {["shadow_passed", "shadow_blocked", "rejected", "pending_owner", "executed", "failed", "expired"].map((k) => <Badge key={k} tone={statusTone(k)}>{k.replace("_", " ")} · {stats[k] ?? 0}</Badge>)}
        </div>
        {data && <ModeControl mode={mode} reload={() => void refresh()} />}
      </Panel>
      <OwnerQueue rows={rows} mode={mode} reload={() => void refresh()} />
      <Agreement />
      <Panel title="Proposals" icon={<Vote className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone="cyan">{rows.length}</Badge>}>
        {loading && !data ? <Skeleton rows={5} /> : error && !data ? <Empty>{error}</Empty> : rows.length === 0 ? <Empty>No proposals yet. The supervisor proposes when it sees persistent drift.</Empty> : (
          <div className="space-y-1.5">
            {rows.map((p: any) => (
              <div key={p.proposal_id} className="glass-inner px-3 py-2.5">
                <button type="button" className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => setOpen(open === p.proposal_id ? null : p.proposal_id)} aria-expanded={open === p.proposal_id}>
                  <Dot tone={statusTone(p.status) === "slate" ? "slate" : (statusTone(p.status) as any)} pulse={p.status === "pending_owner"} />
                  <span className="mono text-[12px] text-cyan-200">{p.action}</span>
                  <span className="mono text-[11px] text-slate-300">→ {p.target}</span>
                  <Badge tone={p.class === "critical" ? "purple" : p.class === "prohibited" ? "red" : "slate"}>{p.class}</Badge>
                  <span className="mono text-[11px] text-slate-400">{p.approvals}/{p.eligible} approve</span>
                  <span className="text-[11px] text-slate-500">policy {p.policy_decision ?? "—"}</span>
                  <span className="ml-auto flex items-center gap-2"><Badge tone={statusTone(p.status)}>{String(p.status).replace("_", " ")}</Badge><span className="text-[10px] text-slate-600">{ago(p.created_at)}</span></span>
                </button>
                <div className="mt-1 text-[11px] text-slate-300">Proposal: {describeAction(p.action, p.target)}.</div>
                <div className="mt-0.5 text-[10px] text-slate-500">proposed by <span className="mono">{p.proposer_agent_id}</span>{p.evidence?.policy_reason ? <> · {explainReason(p.evidence.policy_reason)}</> : null}</div>
                {open === p.proposal_id && <Votes id={p.proposal_id} />}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
