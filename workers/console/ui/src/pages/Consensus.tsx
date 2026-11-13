import { ArrowUpCircle, BarChart3, Check, Gavel, LineChart, Minus, OctagonX, ShieldAlert, Vote, X } from "lucide-react";
import { Badge, Dot, Empty, Panel, Skeleton } from "../components/ui";
import { ActivityChart, BarList, DataTable, STATUS, StatusBar, VoteBar, bucketize, type Column } from "../components/viz";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, listOf } from "../lib/format";
import { describeAction, explainReason } from "../lib/plain";
import { ownerClickMode } from "../lib/consensus";

/** Proposal outcomes in the validated segment order (good, info, warning, owner, serious, critical, neutral). */
export const PROPOSAL_STATUS = [
  { key: "executed", label: "executed", color: STATUS.good },
  { key: "shadow_passed", label: "passed (recorded)", color: STATUS.info },
  { key: "shadow_blocked", label: "policy blocked", color: STATUS.warning },
  { key: "pending_owner", label: "waits for owner", color: STATUS.owner },
  { key: "rejected", label: "rejected", color: STATUS.serious },
  { key: "failed", label: "failed", color: STATUS.critical },
  { key: "other", label: "expired / executing", color: STATUS.neutral },
];
export const proposalKey = (s?: string) => PROPOSAL_STATUS.some((x) => x.key === s) ? String(s) : "other";

export const statusTone = (s?: string): "green" | "amber" | "red" | "cyan" | "purple" | "slate" =>
  s === "shadow_passed" || s === "executed" ? "green" : s === "pending_owner" ? "purple" : s === "shadow_blocked" ? "amber" : s === "rejected" || s === "failed" ? "red" : s === "executing" ? "cyan" : "slate";

const MODE_TEXT: Record<string, string> = {
  shadow: "Shadow: proposals are voted, tallied and policy-checked, but nothing executes.",
  routine: "Routine: passed reversible actions execute; critical ones wait for an owner click.",
  deploy: "Deploy: passed routine actions, including green deploys, execute.",
  critical: "Critical: critical actions execute after consensus and an owner click.",
};

const VOTE_COLS: Column<any>[] = [
  { key: "vote", header: "vote", sort: (v) => v.vote, cell: (v) => (
    <span className="inline-flex items-center gap-1.5">
      {v.vote === "approve" ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : v.vote === "reject" ? <X className="h-3.5 w-3.5 text-rose-400" /> : <Minus className="h-3.5 w-3.5 text-slate-500" />}{v.vote}
    </span>) },
  { key: "voter", header: "seat", sort: (v) => v.voter_agent_id, cell: (v) => <a href={`#/agents/${v.voter_agent_id}`} className="mono text-cyan-200 hover:underline">{v.voter_agent_id}</a> },
  { key: "reason", header: "reason", className: "wrap", cell: (v) => <span className="text-slate-400">{v.reason}</span> },
];

function Votes({ p }: { p: any }) {
  const { data, loading } = usePoll(() => call("kernel.consensus_proposal", p.proposal_id), 0, [p.proposal_id]);
  const votes = listOf(data, "votes");
  return (
    <div className="space-y-2 py-1">
      <div className="text-[12px] text-slate-200">Proposal: {describeAction(p.action, p.target)}.</div>
      <div className="text-[11px] text-slate-500">proposed by <span className="mono">{p.proposer_agent_id}</span>{p.evidence?.policy_reason ? <> · {explainReason(p.evidence.policy_reason)}</> : null}</div>
      {loading && !data ? <Skeleton rows={3} /> : <DataTable rows={votes} columns={VOTE_COLS} rowKey={(v) => v.voter_agent_id} maxHeight={260} dense empty="No votes recorded." />}
    </div>
  );
}

const PROPOSAL_COLS: Column<any>[] = [
  { key: "status", header: "status", sort: (p) => p.status, cell: (p) => <span className="inline-flex items-center gap-1.5"><Dot tone={statusTone(p.status) as any} pulse={p.status === "pending_owner"} />{String(p.status).replace("_", " ")}</span> },
  { key: "action", header: "action", sort: (p) => p.action, cell: (p) => <span className="mono text-cyan-200">{p.action}</span> },
  { key: "target", header: "target", sort: (p) => p.target, cell: (p) => <span className="mono text-[11px] text-slate-300">{p.target}</span> },
  { key: "class", header: "class", sort: (p) => p.class, cell: (p) => <Badge tone={p.class === "critical" ? "purple" : p.class === "prohibited" ? "red" : "slate"}>{p.class}</Badge> },
  { key: "votes", header: "votes", sort: (p) => (p.eligible ? p.approvals / p.eligible : 0), cell: (p) => <VoteBar approvals={p.approvals} rejections={p.rejections} eligible={p.eligible} /> },
  { key: "policy", header: "policy", sort: (p) => p.policy_decision ?? "", cell: (p) => <span className={p.policy_decision === "allow" ? "text-emerald-300" : p.policy_decision === "deny" ? "text-rose-300" : "text-slate-500"}>{p.policy_decision ?? "—"}</span> },
  { key: "proposer", header: "proposer", sort: (p) => p.proposer_agent_id, cell: (p) => <span className="mono text-[11px] text-slate-400">{p.proposer_agent_id}</span> },
  { key: "when", header: "when", sort: (p) => Date.parse(p.created_at) || 0, cell: (p) => <span className="text-slate-500" title={p.created_at}>{ago(p.created_at)}</span> },
];

/** ADR-0009 phase 4: the actions the platform can execute after an owner click (the kernel's PHASE4_EXECUTABLE). Others are done by runbook. */
const OWNER_EXECUTABLE = new Set(["register_principal", "retire_worker", "retire_agent", "amend_constitution", "register_privileged_agent", "admit_voter"]);

function OwnerQueue({ rows, mode, reload }: { rows: any[]; mode: string; reload: () => void }) {
  const { who, act } = useSession();
  const pending = rows.filter((p) => p.status === "pending_owner");
  return (
    <Panel title="Owner Approval Queue" icon={<ShieldAlert className="h-3.5 w-3.5 text-fuchsia-300" />} right={<Badge tone={pending.length ? "purple" : "slate"}>{pending.length}</Badge>}>
      {pending.length === 0 ? (
        <Empty>Nothing waits for you. Critical actions reach this queue in mode deploy or critical, after the agents pass them and the Policy Engine allows them.</Empty>
      ) : (
        <DataTable rows={pending} rowKey={(p) => p.proposal_id} maxHeight={360} initialSort={{ key: "when", dir: "asc" }} columns={[
          { key: "action", header: "action", sort: (p) => p.action, cell: (p) => <span className="inline-flex items-center gap-1.5"><Dot tone="purple" pulse /><span className="mono text-fuchsia-200">{p.action}</span></span> },
          { key: "decide", header: "decision", className: "wrap", cell: (p) => {
            const runnable = OWNER_EXECUTABLE.has(p.action);
            return (
              <div className="space-y-1">
                {!runnable && <div className="text-[11px] text-amber-300">No platform executor: carry it out by its runbook, then reject to close it.</div>}
                {who.approver ? (
                  <div className="flex flex-wrap gap-2">
                    {runnable && ownerClickMode(mode) && (
                      <button type="button" className="btn btn-approve !py-1" onClick={() => act({ route: "kernel.consensus_approve", params: p.proposal_id, body: {}, title: `Approve ${p.action} → ${p.target}`,
                        lines: ["Your click is recorded under your Access identity and is final.", "The Policy Engine re-checks, then the platform executes it immediately.", p.action === "retire_worker" ? "Retiring deletes the Worker from Cloudflare. D1 data is not touched." : p.action === "admit_voter" ? "The agent gets a council seat and votes on every later proposal." : p.action === "register_privileged_agent" ? "The agent is registered with the privileged capabilities its DNA declares." : "The principal can act as this agent until revoked."],
                        done: "Approved and executed.", after: reload })}><Check className="h-3.5 w-3.5" />Approve…</button>
                    )}
                    <button type="button" className="btn btn-danger !py-1" onClick={() => act({ route: "kernel.consensus_reject", params: p.proposal_id, body: {}, title: `Reject ${p.action} → ${p.target}`,
                      lines: ["The proposal is closed as rejected; nothing executes."], done: "Rejected.", after: reload })}><X className="h-3.5 w-3.5" />Reject…</button>
                  </div>
                ) : <span className="text-[11px] text-slate-500">Only an approver can decide.</span>}
              </div>
            );
          } },
          { key: "target", header: "target", sort: (p) => p.target, cell: (p) => <span className="mono text-[11px] text-slate-300">{p.target}</span> },
          { key: "votes", header: "agents", cell: (p) => <VoteBar approvals={p.approvals} rejections={p.rejections} eligible={p.eligible} /> },
          { key: "when", header: "expires", sort: (p) => Date.parse(p.created_at) || 0, cell: (p) => { const left = Math.max(0, Math.round((Date.parse(p.created_at) + 86_400_000 - Date.now()) / 3_600_000)); return <span className={left < 4 ? "text-amber-300" : "text-slate-400"}>in {left} h</span>; } },
        ]} />
      )}
    </Panel>
  );
}

/** Wave B: does the shadow consensus agree with what people did? Evidence for promoting the mode. */
function Agreement() {
  const { data, loading } = usePoll(() => call("kernel.consensus_report", undefined, undefined, { days: "7" }), 300_000);
  const rate = typeof data?.agreement_rate === "number" ? Math.round(data.agreement_rate * 100) : null;
  const items = listOf(data, "items").filter((i: any) => i.verdict !== "pending");
  return (
    <Panel title="Shadow Agreement · 7 days" icon={<LineChart className="h-3.5 w-3.5 text-emerald-300" />}
      right={<Badge tone={rate === null ? "slate" : rate >= 90 ? "green" : rate >= 70 ? "amber" : "red"}>{rate === null ? "not enough data" : `${rate}% agree`}</Badge>}>
      {loading && !data ? <Skeleton rows={3} /> : (
        <>
          <p className="text-[12px] leading-relaxed text-slate-400">Each proposal is compared with what people did afterwards. Promotion out of shadow needs at least 7 days and no false positive (ADR-0009).</p>
          <StatusBar className="mt-3" segments={[
            { key: "agree", label: "agree", value: data?.agree ?? 0, color: STATUS.good },
            { key: "fn", label: "false negative", value: data?.false_negative ?? 0, color: STATUS.warning },
            { key: "fp", label: "false positive", value: data?.false_positive ?? 0, color: STATUS.critical },
            { key: "pending", label: "pending", value: data?.pending ?? 0, color: STATUS.neutral },
          ]} />
          {items.length > 0 && (
            <div className="mt-3">
              <DataTable rows={items} rowKey={(i) => i.proposal_id} maxHeight={280} dense columns={[
                { key: "verdict", header: "verdict", sort: (i) => i.verdict, cell: (i) => <Badge tone={i.verdict === "agree" ? "green" : i.verdict === "false_positive" ? "red" : "amber"}>{String(i.verdict).replace("_", " ")}</Badge> },
                { key: "action", header: "action", sort: (i) => i.action, cell: (i) => <span className="mono text-cyan-200">{i.action}</span> },
                { key: "target", header: "target", sort: (i) => i.target, cell: (i) => <span className="mono text-[11px]">{i.target}</span> },
                { key: "evidence", header: "evidence", className: "wrap", cell: (i) => <span className="text-slate-400">{i.evidence}</span> },
              ]} />
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
  deploy: "Agents will also deploy CI-green commits from main and roll back on their own (1 per target per hour, 10 per day by default, adjustable by the council within hard bounds, automatic rollback).",
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
  const { data, loading, error, refresh } = usePoll(() => call("kernel.consensus", undefined, undefined, { limit: "100" }), 60_000);
  const rows = listOf(data, "proposals");
  const { buckets, bin } = bucketize(rows, (p: any) => p.created_at, (p: any) => proposalKey(p.status));
  const byAction = Object.values(rows.reduce((m: Record<string, any>, p: any) => {
    const e = (m[p.action] ??= { label: p.action, value: 0, ok: 0, no: 0 });
    e.value += 1; if (p.passed) e.ok += 1; else e.no += 1;
    return m;
  }, {})).map((e: any) => ({ label: e.label, value: e.value, parts: [{ key: "ok", label: "passed", value: e.ok, color: STATUS.good }, { key: "no", label: "not passed", value: e.no, color: STATUS.serious }] }));
  const stats: Record<string, number> = data?.stats_24h ?? {};
  const mode = data?.mode ?? "—";
  return (
    <div className="flex flex-col gap-3">
      <Panel title="Consensus Engine" icon={<Gavel className="h-3.5 w-3.5 text-violet-300" />} right={<Badge tone={mode === "shadow" ? "amber" : "purple"}>mode · {mode}</Badge>}>
        <p className="text-[12px] leading-relaxed text-slate-400">{MODE_TEXT[mode] ?? "Loading mode…"} A proposal passes with a simple majority of the eligible control-plane agents (the proposer does not vote) and a Policy Engine allow. Trading is never proposable.</p>
        <div className="mt-3 text-[10px] uppercase tracking-widest text-slate-500">Outcomes · last 24 h</div>
        <StatusBar className="mt-1.5" segments={PROPOSAL_STATUS.map((s) => ({ ...s, value: s.key === "other" ? Object.entries(stats).filter(([k]) => proposalKey(k) === "other").reduce((n, [, v]) => n + Number(v), 0) : Number(stats[s.key] ?? 0) }))} />
        {data && <ModeControl mode={mode} reload={() => void refresh()} />}
      </Panel>
      <OwnerQueue rows={rows} mode={mode} reload={() => void refresh()} />
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title={`Proposals over time · last ${rows.length}`} icon={<LineChart className="h-3.5 w-3.5 text-cyan-300" />}>
          {loading && !data ? <Skeleton rows={3} /> : rows.length === 0 ? <Empty>No proposals yet.</Empty> : <ActivityChart buckets={buckets} bin={bin} series={PROPOSAL_STATUS} caption="proposals over time by outcome" />}
        </Panel>
        <Panel title="By action" icon={<BarChart3 className="h-3.5 w-3.5 text-violet-300" />}>
          {loading && !data ? <Skeleton rows={3} /> : <BarList items={byAction} series={[{ label: "passed", color: STATUS.good }, { label: "not passed", color: STATUS.serious }]} empty="No proposals yet." />}
        </Panel>
      </div>
      <Agreement />
      <Panel title="Proposals" icon={<Vote className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone="cyan">{rows.length}</Badge>}>
        {loading && !data ? <Skeleton rows={5} /> : error && !data ? <Empty>{error}</Empty> : (
          <DataTable rows={rows} columns={PROPOSAL_COLS} rowKey={(p) => p.proposal_id} expand={(p) => <Votes p={p} />}
            initialSort={{ key: "when", dir: "desc" }} empty="No proposals yet. The supervisor proposes when it sees persistent drift." />
        )}
      </Panel>
    </div>
  );
}
