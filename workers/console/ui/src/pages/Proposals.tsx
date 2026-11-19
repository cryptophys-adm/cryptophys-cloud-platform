import { Fragment, useEffect, useState } from "react";
import { ArrowLeft, Check, FileCheck2, X } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, navigate } from "../lib/format";
import { refPage } from "./Ask";
import { hubLabel, useDebounced, useHub } from "../lib/hub";
import { CorrectionBox } from "../components/CorrectionBox";

/**
 * HAIC H2 (ADR-0017 H2; owner answers of 2026-11-18): typed proposals. A council's pick (and, with H2b, a chat
 * directive) becomes a typed_proposal.v1 draft; only the owner confirms or rejects it. A confirmed proposal goes its
 * kind's way: policy_parameter to consensus (set_policy_parameter, routine), repository_task to the evolver,
 * vision_kpi to the orchestrator (a guard path: the merge needs the owner's click), shadow_arm to xauusd. Nothing here
 * acts by itself; operators read.
 *
 * HAIC H3c (docs/design/HAIC-H3.md §11 step 3, Q6): the owner may correct a proposal in any state (kept as the owner's
 * teaching of its origin: the council's moderator or the chat model), and a reject's note is also kept as the owner's
 * decision (weight 1). Neither confirms, rejects or changes anything.
 */

const ID = /^tp_[0-9a-f]{16}$/;
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const STATE_TONE: Record<string, "amber" | "green" | "slate" | "red" | "cyan"> = {
  draft: "amber", confirmed: "cyan", handoff_pending: "cyan", handed_off: "green", rejected: "slate", expired: "slate", failed: "red",
};
const STATE_LABEL: Record<string, string> = { draft: "waits for you", handoff_pending: "handing off", handed_off: "handed off" };
const PATH_LABEL: Record<string, string> = { consensus: "consensus", evolver: "the evolver", orchestrator: "the orchestrator", xauusd: "xauusd" };
const until = (iso: unknown) => {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return "—";
  const h = (t - Date.now()) / 3_600_000;
  return h <= 0 ? "passed" : h < 48 ? `in ${Math.round(h)} h` : `in ${Math.round(h / 24)} d`;
};
const refLabel = (ref: string) => ref.replace(/^ev:(platform\/)?/, "").replace(/@\d{4}-\d\d-\d\dT[\d:.]+Z/, "").slice(0, 60);
const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

function Detail({ id }: { id: string }) {
  const { who, act } = useSession();
  const owner = who.owner === true;
  const { data, loading, error, refresh } = usePoll(() => call("kernel.proposal", id), 5 * 60_000, [id]);
  const [reason, setReason] = useState("");
  const live = useHub(["inbox"], useDebounced(() => void refresh()));
  const back = <a href="#/proposals" className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-cyan-300 hover:underline"><ArrowLeft className="h-3 w-3" />All proposals</a>;
  if (loading && !data) return <Panel title="Proposal" right={back}><Skeleton rows={5} /></Panel>;
  if (error && !data) return <Panel title="Proposal" right={back}><Empty>{error}</Empty></Panel>;
  const p = data;
  const b = p?.body;
  if (!p || !b) return <Panel title="Proposal" right={back}><Empty>No such proposal.</Empty></Panel>;
  const decide = (route: "kernel.proposal_confirm" | "kernel.proposal_reject") => act({
    route, params: p.proposal_id, body: { reason: reason.trim() || undefined },
    title: route === "kernel.proposal_confirm" ? `Confirm: ${String(b.title).slice(0, 60)}` : `Reject: ${String(b.title).slice(0, 60)}`,
    lines: route === "kernel.proposal_confirm"
      ? [p.what_happens ?? "", "Your confirmation is audited under your Access identity."]
      : ["Nothing happens; the draft is closed as rejected. This is audited under your Access identity."],
    done: route === "kernel.proposal_confirm" ? "Confirmed." : "Rejected.", after: () => { setReason(""); void refresh(); },
  });
  const origin = String(b.origin?.ref ?? "");
  const originLink = b.origin?.source === "council" ? `#/councils/${origin.split("#")[0]}` : null;
  return (
    <Panel title="Proposal" icon={<FileCheck2 className="h-3.5 w-3.5 text-cyan-300" />} right={back}>
      <div className="text-[15px] font-semibold wrap-break-word text-white">{b.title}</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
        <Badge tone={STATE_TONE[p.state] ?? "slate"}>{STATE_LABEL[p.state] ?? p.state}</Badge>
        <Badge tone="purple">{String(b.kind).replace(/_/g, " ")}</Badge>
        <span>from {originLink ? <a className="text-cyan-300 hover:underline" href={originLink}>a council</a> : b.origin?.source === "chat" ? "the chat" : "—"}</span>·
        <span title={p.created_at}>{p.created_at ? ago(p.created_at) : "—"}</span>
        {p.state === "draft" && <><span>·</span><span className="text-amber-300" title={p.expires_at}>expires {until(p.expires_at)}</span></>}
        <span className={`ml-auto ${live === "live" ? "text-emerald-300" : ""}`}>{hubLabel(live)}</span>
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-slate-200 whitespace-pre-wrap wrap-break-word">{b.rationale}</p>
      <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12px]">
        <dt className="text-slate-500">target</dt><dd className="mono break-all text-slate-200">{show(b.target)}</dd>
        {Object.entries(b.params ?? {}).map(([k, v]) => (<Fragment key={k}><dt className="text-slate-500">{k}</dt><dd className="text-slate-300 whitespace-pre-wrap wrap-break-word">{show(v)}</dd></Fragment>))}
        <dt className="text-slate-500">measured by</dt><dd className="text-slate-300">{b.measurement?.metric ? `${b.measurement.metric}: ${show(b.measurement.baseline)} → ${show(b.measurement.success_threshold)} over ${show(b.measurement.window)}` : "—"}</dd>
        <dt className="text-slate-500">evidence</dt><dd className="flex flex-wrap gap-1.5">{arr(b.evidence_refs).length ? arr(b.evidence_refs).map((r: string) => {
          const page = refPage(r);
          const chip = <span className="mono rounded border border-cyan-400/25 px-1.5 py-0.5 text-[10px] text-cyan-200" title={r}>{refLabel(r)}</span>;
          return page ? <a key={r} href={page}>{chip}</a> : <span key={r}>{chip}</span>;
        }) : "—"}</dd>
        <dt className="text-slate-500">requires</dt><dd className="mono text-slate-300">{arr(b.requires).join(", ") || "—"}</dd>
        <dt className="text-slate-500">once confirmed</dt><dd className="text-slate-300">{p.what_happens ?? "—"}</dd>
        {p.handoff_path && <><dt className="text-slate-500">handed to</dt><dd className="text-slate-300">{PATH_LABEL[p.handoff_path] ?? p.handoff_path}{p.handoff_ref ? <> · <span className="mono">{p.handoff_ref}</span></> : null}</dd></>}
        {p.reason && <><dt className="text-slate-500">note</dt><dd className="text-slate-300">{p.reason}</dd></>}
        {p.decided_by && <><dt className="text-slate-500">decided</dt><dd className="text-slate-300">by <span className="mono">{p.decided_by}</span> {p.decided_at ? ago(p.decided_at) : ""}</dd></>}
      </dl>
      {owner && p.state === "draft" && (
        <div className="mt-3 border-t border-white/5 pt-3">
          <label className="block">
            <span className="label">Note (optional, at most 500 characters)</span>
            <input className="field" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why you confirm or reject it" />
          </label>
          <p className="mt-1 text-[10px] text-slate-600">A reject's note is also kept as your decision on the proposal's origin, for its teaching record.</p>
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" className="btn btn-danger py-1!" onClick={() => decide("kernel.proposal_reject")}><X className="h-3.5 w-3.5" />Reject…</button>
            <button type="button" className="btn btn-approve py-1!" onClick={() => decide("kernel.proposal_confirm")}><Check className="h-3.5 w-3.5" />Confirm…</button>
          </div>
        </div>
      )}
      {owner && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/5 pt-2 text-[10px] text-slate-500">
          <span>Correct this proposal: what its origin got wrong (or right). It decides nothing.</span>
          <CorrectionBox what="this proposal" submit={(body) => call("kernel.proposal_correct", p.proposal_id, body)} />
        </div>
      )}
    </Panel>
  );
}

export default function Proposals({ proposal }: { proposal?: string }) {
  const { data, loading, error, refresh } = usePoll(() => call("kernel.proposals"), 5 * 60_000);
  const id = proposal && ID.test(proposal) ? proposal : null;
  const rows = arr(data?.proposals);
  useHub(["inbox"], useDebounced(() => void refresh()));
  useEffect(() => { if (proposal && !id) navigate("#/proposals"); }, [proposal, id]);
  return (
    <div className="flex flex-col gap-3">
      <h1 className="sr-only">Proposals</h1>
      {id && <Detail id={id} />}
      <Panel title="Typed proposals" icon={<FileCheck2 className="h-3.5 w-3.5 text-cyan-300" />}
        right={<span className="text-[10px] text-slate-500">a directive becomes a typed change; nothing happens before your confirmation</span>}>
        {loading && !data ? <Skeleton rows={3} /> : error && !data ? <Empty>{error}</Empty> : data?.available === false ? (
          <Empty>Typed proposals are not available yet: their table is not migrated.</Empty>
        ) : rows.length === 0 ? <Empty>No proposal yet. A council's pick makes one.</Empty> : (
          <ul className="divide-y divide-white/5">
            {rows.map((p: any) => (
              <li key={p.proposal_id}>
                <a href={`#/proposals/${p.proposal_id}`} className={`flex flex-wrap items-center gap-2 px-1 py-2 text-[12px] hover:bg-white/5 ${p.proposal_id === id ? "bg-white/5" : ""}`}>
                  <Badge tone={STATE_TONE[p.state] ?? "slate"}>{STATE_LABEL[p.state] ?? p.state}</Badge>
                  <Badge tone="purple">{String(p.kind).replace(/_/g, " ")}</Badge>
                  <span className="flex-1 wrap-break-word text-slate-200">{p.title}</span>
                  {p.handoff_path && <span className="text-slate-500">→ {PATH_LABEL[p.handoff_path] ?? p.handoff_path}</span>}
                  <span className="text-slate-500" title={p.created_at}>{p.created_at ? ago(p.created_at) : "—"}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
