import type { ReactNode } from "react";
import { ArrowLeft, Ban, BookOpenCheck, Check, CheckCircle2, ExternalLink, Gavel, Inbox, ListOrdered, ShieldAlert, ShieldCheck, Siren, Users, Wrench, X } from "lucide-react";
import { Badge, Dot, Empty, Panel, Skeleton } from "../components/ui";
import { CriticalReportList } from "../components/CriticalReports";
import { IncidentsPanel } from "../components/Incidents";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useDebounced, useHub } from "../lib/hub";
import { useSession } from "../lib/session";
import { useOverview } from "../lib/overview";
import { ago, navigate } from "../lib/format";
import { DataTable } from "../components/viz";
import { describeAction, serviceName } from "../lib/plain";
import { ownerClickMode } from "../lib/consensus";

/**
 * Owner decision 2026-11-13 ("Batasi User/Owner hanya untuk critical dan permintaan approval only"): the one page
 * where the platform needs a person. Three sections, all from GET /v1/owner/inbox (the same reading the owner's
 * emails and Telegram messages come from): what waits for an approval, the open critical reports, and the
 * production problems no agent is handling. Every action reuses its existing approver-only route and typed phrase;
 * operators and viewers see the page read-only. Everything else (drift the agents handle, the organism census,
 * build minutes under the budget, high advisories) stays on the other pages.
 *
 * HAIC H0c (docs/design/HAIC-H0-H1.md §2.6): above the sections, "Needs you" lists the same items ranked by the
 * kernel's score (items[] of the inbox, owner-inbox.rank.v1), and #/owner/<item_id> opens one item with its score,
 * evidence and the same approver-only action as its section. The ranking only orders; it decides nothing.
 *
 * Owner 2026-11-19: below the sections, the Incidents panel (components/Incidents.tsx, GET /v1/incidents) lists each
 * incident with its derived status, its timeline and its post-incident summary, on every state of the page.
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

const PROBLEM_LABEL: Record<string, string> = {
  self_unhealthy: "kernel or Drift Detector",
  observations_stale: "not observed",
  drift_unhandled: "drift not handled",
  recovery_failed: "recovery failed",
  critical_advisory: "critical advisory",
  build_minutes_exhausted: "build minutes used up",
  break_glass_deployed: "break-glass deploy",
  deploys_stalled: "deploys stalled",
  git_backup_unverified: "git backup failed verify",
  executor_deploy_failed: "deploy executor blocked",
  deploy_no_path: "deploy has no path",
  out_of_band_deploy: "code not deployed by the platform",
  identity_source_invalid: "identity list invalid",
  model_router_stopped: "Beam turned off",
};

/** One production problem no agent is handling: what, since when, and the page with the evidence. */
function ProblemItem({ p }: { p: any }) {
  const link = typeof p.link === "string" && p.link.startsWith("#/") ? p.link : "#/";
  return (
    <div className="glass-inner px-3 py-2 text-[12px]">
      <div className="flex items-start gap-2">
        <span className="mt-1.5"><Dot tone="red" pulse /></span>
        <span className="min-w-0 flex-1 wrap-break-word text-slate-200">{p.detail ?? "—"}</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <Badge tone="red">{PROBLEM_LABEL[p.code] ?? String(p.code ?? "—")}</Badge>
        <span className="mono break-all">{p.subject}</span>
        {p.since ? <span>since <span title={p.since}>{ago(p.since)}</span></span> : null}
        <a href={link} className="ml-auto inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-cyan-300 hover:underline">Evidence <ExternalLink className="h-3 w-3" /></a>
      </div>
    </div>
  );
}

const ReadOnly = ({ who = "an approver" }: { who?: string }) => <div className="mt-1.5 text-[11px] text-slate-500">Only {who} can decide.</div>;

function PlanItem({ p, reload }: { p: any; reload: () => void }) {
  const { who, act } = useSession();
  const own = p.created_by === who.actor;
  return (
    <div className="glass-inner px-3 py-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <Dot tone="amber" pulse />
        <span className="min-w-0 flex-1 wrap-break-word text-slate-200">{p.title ?? `Recovery plan for ${serviceName(p.service_id)}`}</span>
        <a href={`#/recovery/${p.plan_id}`} className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-cyan-300 hover:underline">Details <ExternalLink className="h-3 w-3" /></a>
      </div>
      <div className="mt-0.5 wrap-break-word text-[11px] text-slate-500">
        {serviceName(p.service_id)} · version <span className="mono">{p.plan_version}</span> · by <span className="mono">{p.created_by}</span> · {ago(p.created_at)} · approval window closes {until(p.approve_by)}
        {p.synthetic ? <> · <Badge tone="slate">deploy check</Badge></> : null}
      </div>
      {arr(p.steps).length > 0 && (
        <ol className="mt-1.5 space-y-0.5 pl-4 text-[11px] text-slate-400">
          {arr(p.steps).map((s: any, i: number) => <li key={i} className="list-decimal wrap-break-word"><span className="mono text-violet-200">{s.action}</span> {s.description}</li>)}
        </ol>
      )}
      {who.approver ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {own ? <span className="text-[11px] text-slate-500">You authored this plan; another approver must approve it.</span> : (
            <button type="button" className="btn btn-approve py-1!" onClick={() => act({ route: "recovery.approve", params: p.plan_id, title: `Approve plan ${p.plan_id}`,
              lines: ["Approval is recorded under your identity. You cannot approve a plan you authored.", "After approval the AI executes every step automatically and verifies the result. Follow the pipeline on the plan's page."],
              done: "Approved. The AI is executing the plan.", after: reload })}><ShieldCheck className="h-3.5 w-3.5" />Approve…</button>
          )}
          <button type="button" className="btn btn-danger py-1!" onClick={() => act({ route: "recovery.disable", params: p.plan_id, title: `Disable plan ${p.plan_id}`,
            lines: ["The plan can no longer be approved or executed."], done: "Plan disabled.", after: reload })}><Ban className="h-3.5 w-3.5" />Disable…</button>
        </div>
      ) : <ReadOnly />}
    </div>
  );
}

function ProposalItem({ p, mode, reload }: { p: any; mode: string | null; reload: () => void }) {
  const { who, act } = useSession();
  const canApprove = p.executable === true && ownerClickMode(mode);
  return (
    <div className="glass-inner px-3 py-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-2">
        <Dot tone="purple" pulse />
        <span className="min-w-0 flex-1 wrap-break-word text-slate-200">Critical action: {describeAction(p.action, p.target)}</span>
        <a href="#/consensus" className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-cyan-300 hover:underline">Votes <ExternalLink className="h-3 w-3" /></a>
      </div>
      <div className="mt-0.5 wrap-break-word text-[11px] text-slate-500">
        <span className="mono">{p.action}</span> → <span className="mono">{p.target}</span> · proposed by <span className="mono">{p.proposer_agent_id}</span> · agents {count(p.approvals)} for, {count(p.rejections)} against of {count(p.eligible)} · expires {until(p.expires_at)}
      </div>
      {Array.isArray(p.changes) && p.changes.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[11px] text-slate-300">{p.changes.map((c: string) => <li key={c} className="wrap-break-word">{c}</li>)}</ul>
      )}
      {p.executable !== true && <div className="mt-1 text-[11px] text-amber-300">No platform executor: carry it out by its runbook, then reject to close it.</div>}
      {p.executable === true && !ownerClickMode(mode) && <div className="mt-1 text-[11px] text-amber-300">Approval executes only in consensus mode deploy or critical (now {mode ?? "—"}).</div>}
      {who.owner ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {canApprove && (
            <button type="button" className="btn btn-approve py-1!" onClick={() => act({ route: "kernel.consensus_approve", params: p.proposal_id, body: {}, title: `Approve ${p.action} → ${p.target}`,
              lines: ["Your click is recorded under your Access identity and is final.", "The Policy Engine re-checks, then the platform executes it immediately."],
              done: "Approved and executed.", after: reload })}><Check className="h-3.5 w-3.5" />Approve…</button>
          )}
          <button type="button" className="btn btn-danger py-1!" onClick={() => act({ route: "kernel.consensus_reject", params: p.proposal_id, body: {}, title: `Reject ${p.action} → ${p.target}`,
            lines: ["The proposal is closed as rejected; nothing executes."], done: "Rejected.", after: reload })}><X className="h-3.5 w-3.5" />Reject…</button>
        </div>
      ) : <ReadOnly who="the owner" />}
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
        <span className="mono min-w-0 flex-1 wrap-break-word text-cyan-200">{k.item_id}@{k.item_version}</span>
        <Badge tone="purple">{String(k.kind ?? "—").replace(/_/g, " ")}</Badge>
        <a href="#/knowledge" className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-cyan-300 hover:underline">Evidence <ExternalLink className="h-3 w-3" /></a>
      </div>
      <div className="mt-0.5 wrap-break-word text-[11px] text-slate-500">by <span className="mono">{k.proposer_agent_id}</span> · {ago(k.created_at)} · review window closes {until(k.expires_at)}</div>
      <p className="mt-1 wrap-break-word text-[12px] text-slate-300">{text ?? "—"}</p>
      {who.approver ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="btn btn-approve py-1!" onClick={() => act({ route: "kernel.knowledge_approve", params: k.proposal_id, body: { reason: "approved for shadow testing in the Console" },
            title: `Approve ${k.item_id}@${k.item_version} for shadow testing`,
            lines: ["Recorded under your Access identity in the audit chain.", "Aether exports it in the approved pack; the XAUUSD shadow arm tests it. No live agent changes.", "Promotion still needs your PR in the XAUUSD repository."],
            done: "Approved for shadow testing.", after: reload })}><Check className="h-3.5 w-3.5" />Approve…</button>
          <button type="button" className="btn btn-danger py-1!" onClick={() => act({ route: "kernel.knowledge_reject", params: k.proposal_id, body: { reason: "rejected in the Console" },
            title: `Reject ${k.item_id}@${k.item_version}`, lines: ["The proposal is closed as rejected. Aether does not propose the same version again."],
            done: "Rejected.", after: reload })}><X className="h-3.5 w-3.5" />Reject…</button>
        </div>
      ) : <ReadOnly />}
    </div>
  );
}

const URGENCY_TONE: Record<string, "red" | "amber" | "purple" | "slate"> = { critical: "red", high: "amber", normal: "purple", low: "slate" };
const BLOCK_LABEL: Record<string, string> = { trading_safety: "trading safety", cutover_gate: "cut-over gate", deploys: "deploys", merges: "merges", learning: "learning" };
const blocksText = (b: unknown) => arr(b).map((x) => BLOCK_LABEL[x] ?? String(x)).join(" · ") || "—";
const itemHref = (i: any) => (typeof i?.deep_link === "string" && i.deep_link.startsWith("#/owner/") ? i.deep_link : "#/owner");

/** "Needs you": every waiting item, ranked by the kernel's score; a row opens the item. */
function RankedList({ items }: { items: any[] }) {
  const rows = items.map((i, n) => ({ ...i, rank: n + 1 }));
  return (
    <Panel title="Needs you" icon={<ListOrdered className="h-3.5 w-3.5 text-cyan-300" />}
      right={<span className="text-[10px] text-slate-500">{rows.length} item{rows.length === 1 ? "" : "s"} · ranked by score</span>}>
      <DataTable rows={rows} rowKey={(r: any) => r.item_id} initialSort={{ key: "rank", dir: "asc" }} dense
        footer={<span>score = 100 × urgency × what it blocks × age × deadline · click a row to open it</span>}
        onRowClick={(r: any) => navigate(itemHref(r))} columns={[
          { key: "rank", header: "#", sort: (r: any) => r.rank, cell: (r: any) => <span className="mono text-slate-400">{r.rank}</span> },
          { key: "what", header: "what", className: "wrap", cell: (r: any) => <span className="text-slate-200">{r.what ?? "—"}</span> },
          { key: "urgency", header: "urgency", sort: (r: any) => r.score_parts?.U ?? 0, cell: (r: any) => <Badge tone={URGENCY_TONE[r.urgency] ?? "slate"}>{r.urgency ?? "—"}</Badge> },
          { key: "blocks", header: "blocks", className: "wrap", cell: (r: any) => <span className="text-[11px] text-slate-400">{blocksText(r.blocks)}</span> },
          { key: "due", header: "due", sort: (r: any) => Date.parse(r.deadline ?? "") || Number.MAX_SAFE_INTEGER, cell: (r: any) => <span className="text-slate-400" title={r.deadline ?? undefined}>{until(r.deadline)}</span> },
          { key: "score", header: "score", sort: (r: any) => r.score ?? 0, cell: (r: any) => <span className="mono text-slate-200">{count(r.score)}</span> },
        ]} />
    </Panel>
  );
}

/** #/owner/<item_id>: one item, its score and evidence, and the same action as in its section below. */
/** HAIC H1.5c: a council that waits for the owner's pick; the pick itself is on the council's page (Cerebrum only, Q6). */
function CouncilItem({ c, proposal = false }: { c: any; proposal?: boolean }) {
  return (
    <div className="glass-inner flex flex-wrap items-center gap-2 px-3 py-2 text-[12px]">
      <Users className="h-3.5 w-3.5 text-cyan-300" />
      <span className="flex-1 wrap-break-word text-slate-200">{c.topic}</span>
      {proposal && <span className="text-slate-500">by <span className="mono">{String(c.proposed_by ?? "—").replace(/^agent:/, "")}</span></span>}
      <span className="text-slate-500" title={c.deadline}>expires {until(c.deadline)}</span>
      <a className="btn py-1!" href={`#/councils/${c.session_id}`}>{proposal ? "Open the proposal" : "Open the options"}</a>
    </div>
  );
}

function ItemDetail({ id, items, sections, mode, reload }: { id: string; items: any[]; sections: { plans: any[]; proposals: any[]; knowledge: any[]; reports: any[]; problems: any[]; councils: any[]; councilProposals: any[] }; mode: string | null; reload: () => void }) {
  const it = items.find((i) => i.item_id === id);
  const back = <a href="#/owner" className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-cyan-300 hover:underline"><ArrowLeft className="h-3 w-3" />All items</a>;
  if (!it) {
    return <Panel title="Item" right={back}><Empty>This item no longer waits for you: it was decided, it expired, or the problem closed.</Empty></Panel>;
  }
  const ref = id.slice(id.indexOf(":") + 1);
  const p = it.score_parts ?? {};
  const m = it.metric;
  let action: ReactNode = null;
  if (it.source === "consensus") { const x = sections.proposals.find((q) => q.proposal_id === ref); if (x) action = <ProposalItem p={x} mode={mode} reload={reload} />; }
  else if (it.source === "recovery_plan") { const x = sections.plans.find((q) => q.plan_id === ref); if (x) action = <PlanItem p={x} reload={reload} />; }
  else if (it.source === "knowledge") { const x = sections.knowledge.find((q) => q.proposal_id === ref); if (x) action = <KnowledgeItem k={x} reload={reload} />; }
  else if (it.source === "critical_report") { const x = sections.reports.find((q) => q.report_id === ref); if (x) action = <CriticalReportList rows={[x]} reload={reload} empty="—" />; }
  else if (it.source === "production_problem") { const x = sections.problems.find((q) => `${q.code}:${q.subject}` === ref); if (x) action = <ProblemItem p={x} />; }
  else if (it.source === "proposal") action = <a className="btn py-1!" href={`#/proposals/${ref}`}>Open the proposal to confirm or reject it</a>;
  else if (it.source === "autonomy") action = <a className="btn py-1!" href="#/autonomy">Open the autonomy dial to set the level</a>;
  else if (it.source === "council") {
    const x = sections.councils.find((q) => q.session_id === ref);
    const y = sections.councilProposals.find((q) => q.session_id === ref);
    if (x) action = <CouncilItem c={x} />; else if (y) action = <CouncilItem c={y} proposal />;
  }
  return (
    <Panel title="Item" icon={<Inbox className="h-3.5 w-3.5 text-cyan-300" />} right={back}>
      <div className="text-[14px] font-semibold wrap-break-word text-white">{it.what ?? "—"}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <Badge tone={URGENCY_TONE[it.urgency] ?? "slate"}>{it.urgency ?? "—"}</Badge>
        <span className="mono">{it.source}</span>·<span className="mono">{it.kind}</span>
      </div>
      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12px]">
        <dt className="text-slate-500">score</dt><dd className="mono text-slate-200">{count(it.score)} <span className="text-slate-500">= 100 × U {count(p.U)} × B {count(p.B)} × A {count(p.A)} × D {count(p.D)}</span></dd>
        <dt className="text-slate-500">blocks</dt><dd className="text-slate-300">{blocksText(it.blocks)}</dd>
        <dt className="text-slate-500">due</dt><dd className="text-slate-300" title={it.deadline ?? undefined}>{until(it.deadline)}</dd>
        <dt className="text-slate-500">waiting</dt><dd className="text-slate-300" title={it.created_at ?? undefined}>{it.created_at ? ago(it.created_at) : "—"}</dd>
        <dt className="text-slate-500">metric</dt><dd className="text-slate-300">{m && typeof m.value === "number" ? `${m.name}: ${m.value} of ${count(m.of)} ${m.unit ?? ""}` : "—"}</dd>
        <dt className="text-slate-500">risk</dt><dd className="text-slate-300">{it.risk ? `${it.risk.class} · ${it.risk.reversible === true ? "reversible" : it.risk.reversible === false ? "not reversible" : "reversibility —"} · ${it.risk.blast_radius}` : "—"}</dd>
        <dt className="text-slate-500">evidence</dt><dd className="space-y-0.5">{arr(it.evidence_refs).length ? arr(it.evidence_refs).map((r: string) => <div key={r} className="mono break-all text-[11px] text-cyan-200">{r}</div>) : "—"}</dd>
      </dl>
      <div className="mt-3">{action ?? <Empty>This item's entry is not in the inbox's sections any more; reload the page.</Empty>}</div>
    </Panel>
  );
}

export default function Owner({ item }: { item?: string }) {
  const { who } = useSession();
  const { refresh: refreshOverview } = useOverview();
  const { data, loading, error, refresh } = usePoll(() => call("kernel.owner_inbox"), 60_000);
  const reload = () => { void refresh(); void refreshOverview(); };
  // HAIC push hub (§4.5): the inbox's change signal reloads at once; the 60 s poll stays as the fallback.
  useHub(["inbox"], useDebounced(reload));
  const plans = arr(data?.approvals?.recovery_plans);
  const proposals = arr(data?.approvals?.consensus);
  const knowledge = arr(data?.approvals?.knowledge);
  const reports = arr(data?.critical_reports);
  const problems = arr(data?.production_problems);
  const councils = arr(data?.councils);
  const councilProposals = arr(data?.council_proposals);
  const drafts = arr(data?.typed_proposals);
  const approvals = plans.length + proposals.length + knowledge.length;
  const mode: string | null = typeof data?.consensus_mode === "string" ? data.consensus_mode : null;
  const items = arr(data?.items);
  const nothing = Boolean(data) && approvals === 0 && reports.length === 0 && problems.length === 0 && councils.length === 0 && councilProposals.length === 0 && drafts.length === 0;

  return (
    <div className="flex flex-col gap-3">
      <h1 className="sr-only">Owner</h1>
      {item && nothing && <ItemDetail id={item} items={items} sections={{ plans, proposals, knowledge, reports, problems, councils, councilProposals }} mode={mode} reload={reload} />}
      {loading && !data ? <Panel><Skeleton rows={4} /></Panel> : error && !data ? (
        <Panel title="Owner" icon={<Inbox className="h-3.5 w-3.5 text-cyan-300" />}><Empty>{error}</Empty></Panel>
      ) : nothing ? (
        <Panel title="Owner" icon={<Inbox className="h-3.5 w-3.5 text-cyan-300" />} right={<span className="text-[11px] text-slate-500" title={data?.observed_at}>checked {ago(data?.observed_at)}</span>}>
          <div className="flex items-center gap-3 py-6">
            <CheckCircle2 className="h-6 w-6 shrink-0 text-emerald-300" />
            <div>
              <div className="text-[15px] font-semibold text-white">Nothing needs you</div>
              <div className="text-[12px] text-slate-400">No approval waits, no critical report is open, and every production problem is handled by an agent. You are contacted only when one of these appears.</div>
            </div>
          </div>
        </Panel>
      ) : (
        <>
          {item && <ItemDetail id={item} items={items} sections={{ plans, proposals, knowledge, reports, problems, councils, councilProposals }} mode={mode} reload={reload} />}
          {items.length > 0 && <RankedList items={items} />}
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
          {councils.length > 0 && (
            <Panel title="Councils waiting for your pick" icon={<Users className="h-3.5 w-3.5 text-cyan-300" />}
              right={<Badge tone="amber">{count(data?.counts?.councils)}</Badge>}>
              <p className="mb-2 text-[11px] text-slate-500">A council ended in ranked options. Pick one or dismiss it on its page; with no pick it expires after 72 hours and nothing changes.</p>
              <div className="space-y-2">{councils.map((c) => <CouncilItem key={c.session_id} c={c} />)}</div>
            </Panel>
          )}
          {drafts.length > 0 && (
            <Panel title="Proposals waiting for your confirmation" icon={<Gavel className="h-3.5 w-3.5 text-amber-300" />}
              right={<Badge tone="amber">{count(data?.counts?.typed_proposals)}</Badge>}>
              <p className="mb-2 text-[11px] text-slate-500">A council's pick became a typed proposal. Nothing happens until you confirm it; unconfirmed, it expires after 7 days.</p>
              <div className="space-y-2">{drafts.map((d) => (
                <div key={d.proposal_id} className="glass-inner flex flex-wrap items-center gap-2 px-3 py-2 text-[12px]">
                  <Badge tone="purple">{String(d.kind).replace(/_/g, " ")}</Badge>
                  <span className="flex-1 wrap-break-word text-slate-200">{d.title}</span>
                  <span className="text-slate-500" title={d.deadline}>expires {until(d.deadline)}</span>
                  <a className="btn py-1!" href={`#/proposals/${d.proposal_id}`}>Open</a>
                </div>
              ))}</div>
            </Panel>
          )}
          {councilProposals.length > 0 && (
            <Panel title="Councils proposed by agents" icon={<Users className="h-3.5 w-3.5 text-amber-300" />}
              right={<Badge tone="slate">{count(data?.counts?.council_proposals)}</Badge>}>
              <p className="mb-2 text-[11px] text-slate-500">An agent saw evidence worth a council. Only you begin it, on its page; unbegun, it expires after 7 days and nothing changes.</p>
              <div className="space-y-2">{councilProposals.map((c) => <CouncilItem key={c.session_id} c={c} proposal />)}</div>
            </Panel>
          )}
          <Panel title="Open critical reports" icon={<ShieldAlert className="h-3.5 w-3.5 text-rose-300" />}
            right={<Badge tone={reports.length ? "red" : "slate"}>{count(data?.counts?.critical_reports)}</Badge>}>
            <p className="mb-2 text-[11px] text-slate-500">An open critical report of the last 24 hours makes the agents reject routine actions until an approver acknowledges it as handled.</p>
            <CriticalReportList rows={reports} reload={reload} empty="No critical report is open." />
          </Panel>
          <Panel title="Production problems no agent is handling" icon={<Siren className="h-3.5 w-3.5 text-rose-300" />}
            right={<Badge tone={problems.length ? "red" : "slate"}>{count(data?.counts?.production_problems)}</Badge>}>
            <p className="mb-2 text-[11px] text-slate-500">Something in production is broken or about to stop, and no recovery plan, deploy or agent is working on it. Each item links to its evidence.</p>
            {problems.length === 0 ? <Empty>Every production problem is handled by an agent or waits for your approval.</Empty> : (
              <div className="space-y-2">{problems.map((p, i) => <ProblemItem key={`${p.code}:${p.subject}:${i}`} p={p} />)}</div>
            )}
          </Panel>
        </>
      )}
      <IncidentsPanel />
      <p className="px-1 text-[11px] text-slate-500">
        Other notices (drift the agents handle, the organism census, build minutes under the budget, high advisories) are not sent to you; they are on <a className="text-cyan-300/80 hover:underline" href="#/">Command</a>, <a className="text-cyan-300/80 hover:underline" href="#/infrastructure">Infrastructure</a>, <a className="text-cyan-300/80 hover:underline" href="#/agents">AI Mesh</a> and <a className="text-cyan-300/80 hover:underline" href="#/code">Code</a>.
      </p>
    </div>
  );
}
