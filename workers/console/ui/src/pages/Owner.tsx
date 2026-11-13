import type { ReactNode } from "react";
import { Ban, BookOpenCheck, Check, CheckCircle2, ExternalLink, Gavel, Inbox, ShieldAlert, ShieldCheck, Wrench, X } from "lucide-react";
import { Badge, Dot, Empty, Panel, Skeleton } from "../components/ui";
import { CriticalReportList } from "../components/CriticalReports";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { useOverview } from "../lib/overview";
import { ago } from "../lib/format";
import { describeAction, serviceName } from "../lib/plain";

/**
 * Owner decision 2026-11-13 ("Batasi User/Owner hanya untuk critical dan permintaan approval only"): the one page
 * where the platform needs a person. Exactly two sections, both from GET /v1/owner/inbox (the same reading the
 * owner's emails and Telegram messages come from): what waits for an approval, and the open critical reports.
 * Every action reuses its existing approver-only route and typed phrase; operators and viewers see the page
 * read-only. Everything else (drift, the organism census, build minutes, dependencies) stays on the other pages.
 */

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const count = (v: unknown): string => (typeof v === "number" && Number.isFinite(v) ? String(v) : "—");

/** "in 5 h" from an API deadline; "—" without one. */
function until(at?: string | null): string {
  const t = at ? Date.parse(at) : Number.NaN;
  if (!Number.isFinite(t)) return "—";
  const h = Math.round((t - Date.now()) / 3_600_000);
  return h <= 0 ? "now" : h < 48 ? `in ${h} h` : `in ${Math.round(h / 24)} d`;
}

function Group({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-slate-500">{icon}{title}</div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

const ReadOnly = () => <div className="mt-1.5 text-[11px] text-slate-500">Only an approver can decide.</div>;

function PlanItem({ p, reload }: { p: any; reload: () => void }) {
  const { who, act } = useSession();
  const own = p.created_by === who.actor;
  return (
    <div className="glass-inner px-3 py-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <Dot tone="amber" pulse />
        <span className="min-w-0 flex-1 break-words text-slate-200">{p.title ?? `Recovery plan for ${serviceName(p.service_id)}`}</span>
        <a href={`#/recovery/${p.plan_id}`} className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-cyan-300 hover:underline">Details <ExternalLink className="h-3 w-3" /></a>
      </div>
      <div className="mt-0.5 break-words text-[11px] text-slate-500">
        {serviceName(p.service_id)} · version <span className="mono">{p.plan_version}</span> · by <span className="mono">{p.created_by}</span> · {ago(p.created_at)} · approval window closes {until(p.approve_by)}
        {p.synthetic ? <> · <Badge tone="slate">deploy check</Badge></> : null}
      </div>
      {arr(p.steps).length > 0 && (
        <ol className="mt-1.5 space-y-0.5 pl-4 text-[11px] text-slate-400">
          {arr(p.steps).map((s: any, i: number) => <li key={i} className="list-decimal break-words"><span className="mono text-violet-200">{s.action}</span> {s.description}</li>)}
        </ol>
      )}
      {who.approver ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {own ? <span className="text-[11px] text-slate-500">You authored this plan; another approver must approve it.</span> : (
            <button type="button" className="btn btn-approve !py-1" onClick={() => act({ route: "recovery.approve", params: p.plan_id, title: `Approve plan ${p.plan_id}`,
              lines: ["Approval is recorded under your identity. You cannot approve a plan you authored.", "After approval the AI executes every step automatically and verifies the result. Follow the pipeline on the plan's page."],
              done: "Approved. The AI is executing the plan.", after: reload })}><ShieldCheck className="h-3.5 w-3.5" />Approve…</button>
          )}
          <button type="button" className="btn btn-danger !py-1" onClick={() => act({ route: "recovery.disable", params: p.plan_id, title: `Disable plan ${p.plan_id}`,
            lines: ["The plan can no longer be approved or executed."], done: "Plan disabled.", after: reload })}><Ban className="h-3.5 w-3.5" />Disable…</button>
        </div>
      ) : <ReadOnly />}
    </div>
  );
}

function ProposalItem({ p, mode, reload }: { p: any; mode: string | null; reload: () => void }) {
  const { who, act } = useSession();
  const canApprove = p.executable === true && mode === "critical";
  return (
    <div className="glass-inner px-3 py-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <Dot tone="purple" pulse />
        <span className="min-w-0 flex-1 break-words text-slate-200">Critical action: {describeAction(p.action, p.target)}</span>
        <a href="#/consensus" className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-cyan-300 hover:underline">Votes <ExternalLink className="h-3 w-3" /></a>
      </div>
      <div className="mt-0.5 break-words text-[11px] text-slate-500">
        <span className="mono">{p.action}</span> → <span className="mono">{p.target}</span> · proposed by <span className="mono">{p.proposer_agent_id}</span> · agents {count(p.approvals)} for, {count(p.rejections)} against of {count(p.eligible)} · expires {until(p.expires_at)}
      </div>
      {p.executable !== true && <div className="mt-1 text-[11px] text-amber-300">No platform executor: carry it out by its runbook, then reject to close it.</div>}
      {p.executable === true && mode !== "critical" && <div className="mt-1 text-[11px] text-amber-300">Approval executes only in consensus mode critical (now {mode ?? "—"}).</div>}
      {who.approver ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {canApprove && (
            <button type="button" className="btn btn-approve !py-1" onClick={() => act({ route: "kernel.consensus_approve", params: p.proposal_id, body: {}, title: `Approve ${p.action} → ${p.target}`,
              lines: ["Your click is recorded under your Access identity and is final.", "The Policy Engine re-checks, then the platform executes it immediately."],
              done: "Approved and executed.", after: reload })}><Check className="h-3.5 w-3.5" />Approve…</button>
          )}
          <button type="button" className="btn btn-danger !py-1" onClick={() => act({ route: "kernel.consensus_reject", params: p.proposal_id, body: {}, title: `Reject ${p.action} → ${p.target}`,
            lines: ["The proposal is closed as rejected; nothing executes."], done: "Rejected.", after: reload })}><X className="h-3.5 w-3.5" />Reject…</button>
        </div>
      ) : <ReadOnly />}
    </div>
  );
}

function KnowledgeItem({ k, reload }: { k: any; reload: () => void }) {
  const { who, act } = useSession();
  const text = typeof k.item?.text === "string" ? k.item.text : null;
  return (
    <div className="glass-inner px-3 py-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <Dot tone="amber" pulse />
        <span className="mono min-w-0 flex-1 break-words text-cyan-200">{k.item_id}@{k.item_version}</span>
        <Badge tone="purple">{String(k.kind ?? "—").replace(/_/g, " ")}</Badge>
        <a href="#/knowledge" className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-cyan-300 hover:underline">Evidence <ExternalLink className="h-3 w-3" /></a>
      </div>
      <div className="mt-0.5 break-words text-[11px] text-slate-500">by <span className="mono">{k.proposer_agent_id}</span> · {ago(k.created_at)} · review window closes {until(k.expires_at)}</div>
      <p className="mt-1 break-words text-[12px] text-slate-300">{text ?? "—"}</p>
      {who.approver ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="btn btn-approve !py-1" onClick={() => act({ route: "kernel.knowledge_approve", params: k.proposal_id, body: { reason: "approved for shadow testing in the Console" },
            title: `Approve ${k.item_id}@${k.item_version} for shadow testing`,
            lines: ["Recorded under your Access identity in the audit chain.", "Aether exports it in the approved pack; the XAUUSD shadow arm tests it. No live agent changes.", "Promotion still needs your PR in the XAUUSD repository."],
            done: "Approved for shadow testing.", after: reload })}><Check className="h-3.5 w-3.5" />Approve…</button>
          <button type="button" className="btn btn-danger !py-1" onClick={() => act({ route: "kernel.knowledge_reject", params: k.proposal_id, body: { reason: "rejected in the Console" },
            title: `Reject ${k.item_id}@${k.item_version}`, lines: ["The proposal is closed as rejected. Aether does not propose the same version again."],
            done: "Rejected.", after: reload })}><X className="h-3.5 w-3.5" />Reject…</button>
        </div>
      ) : <ReadOnly />}
    </div>
  );
}

export default function Owner() {
  const { who } = useSession();
  const { refresh: refreshOverview } = useOverview();
  const { data, loading, error, refresh } = usePoll(() => call("kernel.owner_inbox"), 60_000);
  const reload = () => { void refresh(); void refreshOverview(); };
  const plans = arr(data?.approvals?.recovery_plans);
  const proposals = arr(data?.approvals?.consensus);
  const knowledge = arr(data?.approvals?.knowledge);
  const reports = arr(data?.critical_reports);
  const approvals = plans.length + proposals.length + knowledge.length;
  const mode: string | null = typeof data?.consensus_mode === "string" ? data.consensus_mode : null;
  const nothing = Boolean(data) && approvals === 0 && reports.length === 0;

  return (
    <div className="flex flex-col gap-3">
      <h1 className="sr-only">Owner</h1>
      {loading && !data ? <Panel><Skeleton rows={4} /></Panel> : error && !data ? (
        <Panel title="Owner" icon={<Inbox className="h-3.5 w-3.5 text-cyan-300" />}><Empty>{error}</Empty></Panel>
      ) : nothing ? (
        <Panel title="Owner" icon={<Inbox className="h-3.5 w-3.5 text-cyan-300" />} right={<span className="text-[11px] text-slate-500" title={data?.observed_at}>checked {ago(data?.observed_at)}</span>}>
          <div className="flex items-center gap-3 py-6">
            <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-300" />
            <div>
              <div className="text-[15px] font-semibold text-white">Nothing needs you</div>
              <div className="text-[12px] text-slate-400">No approval waits and no critical report is open. You are contacted only when one of these appears.</div>
            </div>
          </div>
        </Panel>
      ) : (
        <>
          <Panel title="Waiting for your approval" icon={<Gavel className="h-3.5 w-3.5 text-amber-300" />}
            right={<Badge tone={approvals ? "amber" : "slate"}>{count(data?.counts?.approvals)}</Badge>}>
            {!who.approver && <p className="mb-2 text-[11px] text-slate-500">You can see these items; an approver decides them.</p>}
            {approvals === 0 ? <Empty>No approval waits.</Empty> : (
              <div className="space-y-3">
                {plans.length > 0 && <Group title="Recovery plans" icon={<Wrench className="h-3 w-3" />}>{plans.map((p) => <PlanItem key={p.plan_id} p={p} reload={reload} />)}</Group>}
                {proposals.length > 0 && <Group title={`Critical actions · consensus mode ${mode ?? "—"}`} icon={<ShieldAlert className="h-3 w-3" />}>{proposals.map((p) => <ProposalItem key={p.proposal_id} p={p} mode={mode} reload={reload} />)}</Group>}
                {knowledge.length > 0 && <Group title="Learned knowledge" icon={<BookOpenCheck className="h-3 w-3" />}>{knowledge.map((k) => <KnowledgeItem key={k.proposal_id} k={k} reload={reload} />)}</Group>}
              </div>
            )}
          </Panel>
          <Panel title="Open critical reports" icon={<ShieldAlert className="h-3.5 w-3.5 text-rose-300" />}
            right={<Badge tone={reports.length ? "red" : "slate"}>{count(data?.counts?.critical_reports)}</Badge>}>
            <p className="mb-2 text-[11px] text-slate-500">An open critical report of the last 24 hours makes the agents reject routine actions until an approver acknowledges it as handled.</p>
            <CriticalReportList rows={reports} reload={reload} empty="No critical report is open." />
          </Panel>
        </>
      )}
      <p className="px-1 text-[11px] text-slate-500">
        Other notices (drift, the organism census, build minutes, dependency advisories) are not sent to you; they are on <a className="text-cyan-300/80 hover:underline" href="#/">Command</a>, <a className="text-cyan-300/80 hover:underline" href="#/infrastructure">Infrastructure</a>, <a className="text-cyan-300/80 hover:underline" href="#/agents">AI Mesh</a> and <a className="text-cyan-300/80 hover:underline" href="#/code">Code</a>.
      </p>
    </div>
  );
}
