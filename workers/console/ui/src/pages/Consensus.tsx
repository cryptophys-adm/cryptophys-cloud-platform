import { useState } from "react";
import { Check, Gavel, Minus, Vote, X } from "lucide-react";
import { Badge, Dot, Empty, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, listOf } from "../lib/format";

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

export default function Consensus() {
  useSession();
  const { data, loading, error } = usePoll(() => call("kernel.consensus", undefined, undefined, { limit: "50" }), 60_000);
  const [open, setOpen] = useState<string | null>(null);
  const rows = listOf(data, "proposals");
  const stats: Record<string, number> = data?.stats_24h ?? {};
  const mode = data?.mode ?? "—";
  return (
    <div className="flex flex-col gap-3">
      <Panel title="Consensus Engine" icon={<Gavel className="h-3.5 w-3.5 text-violet-300" />} right={<Badge tone={mode === "shadow" ? "amber" : "purple"}>mode · {mode}</Badge>}>
        <p className="text-[12px] leading-relaxed text-slate-400">{MODE_TEXT[mode] ?? "Loading mode…"} A proposal passes with a simple majority of the eligible control-plane agents (the proposer does not vote) and a Policy Engine allow. Trading is never proposable.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {["shadow_passed", "shadow_blocked", "rejected", "pending_owner", "executed", "failed"].map((k) => <Badge key={k} tone={statusTone(k)}>{k.replace("_", " ")} · {stats[k] ?? 0}</Badge>)}
        </div>
      </Panel>
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
                <div className="mt-1 text-[10px] text-slate-500">proposed by <span className="mono">{p.proposer_agent_id}</span> · {p.evidence?.policy_reason}</div>
                {open === p.proposal_id && <Votes id={p.proposal_id} />}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
