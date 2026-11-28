import { Fragment, useEffect, useState } from "react";
import { Archive as Archive2, ArrowLeft, Check, FileCheck2, GitPullRequestClosed, X } from "lucide-react";
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
 *
 * External intents (owner via the coordinator, 2026-11-25, CT1): the council tasks that wait for another repository
 * (evolution intents in state waiting_external, GET /v1/evolution). Only the owner closes one, with a reason in words
 * (at most 300 characters, never a price or a secret: the kernel refuses them); the reason reaches the council's
 * moderator in xauusd through council.decisions.read.
 *
 * Issue #327 C3 (owner 2026-11-28: "Ya Kerjakan", "... ada arsip beserta statusnya"): External intents lists every open
 * intent for another repository with its state (queued_external when assigned), last update (time, ref, note), next
 * actor (the kernel's nextActor; never derived here) and freshness; the owner's buttons move it one step (Start, PR,
 * Merged, Deployed, Close, Refuse; the kernel refuses any other). The Archive lists every intent with its state, close
 * code and next actor, and opens its full history (GET /v1/evolution/intents/{id}).
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

const CLOSE_MAX = 300;

function CloseIntent({ id, onClosed }: { id: string; onClosed: (id: string) => void }) {
  const { notify } = useSession();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!open) return <button type="button" className="btn btn-danger py-1!" onClick={() => setOpen(true)}><X className="h-3.5 w-3.5" />Close…</button>;
  const text = reason.trim();
  const submit = () => {
    if (sending || !text) return;
    setSending(true);
    setErr(null);
    call("kernel.intent_close", id, { reason: text })
      .then((d) => { notify("ok", d?.changed === false ? "Already closed." : "Intent closed."); setOpen(false); setReason(""); onClosed(id); })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setSending(false));
  };
  return (
    <div className="mt-2 w-full basis-full">
      <label className="block">
        <span className="label">Reason for closing ({reason.length}/{CLOSE_MAX})</span>
        <textarea className="field min-h-[56px]" maxLength={CLOSE_MAX} value={reason} onChange={(e) => setReason(e.target.value)} disabled={sending}
          aria-label={`Reason for closing ${id}`} placeholder="Why this task is closed, for example: not supported by the replay" />
      </label>
      <p className="mt-1 text-[10px] text-slate-600">Words only, no prices; the moderator in xauusd reads this reason.</p>
      {err && <p role="alert" className="mt-1 text-[11px] text-red-300 wrap-break-word">{err}</p>}
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" className="btn py-1!" onClick={() => { setOpen(false); setErr(null); }} disabled={sending}>Cancel</button>
        <button type="button" className="btn btn-danger py-1!" onClick={submit} disabled={sending || !text}><Check className="h-3.5 w-3.5" />Submit</button>
      </div>
    </div>
  );
}

/** Issue #327 C3: an external intent's open states, as the kernel moves them (evolution-progress.ts). */
const OPEN_EXTERNAL = ["waiting_external", "in_progress", "proposed", "merged", "deployed"];
const INTENT_TONE: Record<string, "amber" | "green" | "slate" | "red" | "cyan" | "purple"> = {
  waiting_external: "amber", queued_external: "cyan", in_progress: "cyan", proposed: "purple", merged: "green", deployed: "green",
  closed: "slate", refused: "red", rejected: "slate", expired: "slate", queued: "amber",
};
/** The state as the council reads it: an assigned waiting_external intent is queued_external. */
const intentState = (i: any) => (i?.state === "waiting_external" && i?.assignee ? "queued_external" : String(i?.state ?? "—"));
/** The owner's next steps per state (the kernel refuses any other); refuse is open until closed. */
const STEPS: Record<string, Array<{ state: string; label: string; ref?: "pr" | "sha"; noteRequired?: boolean }>> = {
  waiting_external: [{ state: "in_progress", label: "Start" }],
  in_progress: [{ state: "proposed", label: "PR", ref: "pr" }],
  proposed: [{ state: "merged", label: "Merged", ref: "sha" }],
  merged: [{ state: "deployed", label: "Deployed", ref: "sha" }],
  deployed: [{ state: "closed", label: "Close" }],
};
const REFUSE = { state: "refused", label: "Refuse", noteRequired: true };
const NOTE_MAX = 300;

function RefLink({ value: r }: { value: any }) {
  if (!r || typeof r !== "object") return null;
  if (typeof r.pr_url === "string" && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(r.pr_url)) {
    return <a className="mono text-cyan-300 hover:underline" href={r.pr_url} target="_blank" rel="noreferrer noopener">PR #{r.pr_url.split("/").pop()}</a>;
  }
  if (typeof r.sha === "string") return <span className="mono text-slate-300" title={r.sha}>{r.sha.slice(0, 12)}</span>;
  return null;
}

function LastUpdate({ u }: { u: any }) {
  if (!u) return <span className="text-slate-600">no update yet</span>;
  return (
    <span className="text-slate-500">
      last: <span className="text-slate-300">{u.state}</span> <span title={u.at}>{u.at ? ago(u.at) : ""}</span> by <span className="mono">{u.actor}</span>
      {u.ref && <> · <RefLink value={u.ref} /></>}
      {u.note && <> · <span className="text-slate-400 wrap-break-word">{u.note}</span></>}
    </span>
  );
}

function ProgressStep({ id, step, onDone }: { id: string; step: { state: string; label: string; ref?: "pr" | "sha"; noteRequired?: boolean }; onDone: () => void }) {
  const { notify } = useSession();
  const [open, setOpen] = useState(false);
  const [ref, setRef] = useState("");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const danger = step.state === "refused";
  if (!open) return <button type="button" className={`btn ${danger ? "btn-danger" : ""} py-1!`} onClick={() => setOpen(true)}>{step.label}…</button>;
  const needRef = step.ref === "pr";
  const ready = (!needRef || ref.trim()) && (!step.noteRequired || note.trim());
  const submit = () => {
    if (sending || !ready) return;
    setSending(true);
    setErr(null);
    const body: Record<string, string> = { state: step.state };
    if (ref.trim()) body.ref = ref.trim();
    if (note.trim()) body.note = note.trim();
    call("kernel.intent_progress", id, body)
      .then((d) => { notify("ok", d?.changed === false ? "Already there." : `Intent ${step.state.replace(/_/g, " ")}.`); setOpen(false); setRef(""); setNote(""); onDone(); })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setSending(false));
  };
  return (
    <div className="mt-2 w-full basis-full">
      {step.ref && (
        <label className="block">
          <span className="label">{step.ref === "pr" ? "Pull request URL" : "Commit SHA (optional)"}</span>
          <input className="field" value={ref} onChange={(e) => setRef(e.target.value)} disabled={sending} aria-label={`Ref for ${step.label} ${id}`}
            placeholder={step.ref === "pr" ? "https://github.com/<owner>/<repo>/pull/<n>" : "7 to 40 hex"} />
        </label>
      )}
      <label className="mt-1 block">
        <span className="label">Note{step.noteRequired ? "" : " (optional)"} ({note.length}/{NOTE_MAX})</span>
        <textarea className="field min-h-[48px]" maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} disabled={sending} aria-label={`Note for ${step.label} ${id}`} />
      </label>
      <p className="mt-1 text-[10px] text-slate-600">Words only, no prices; the council reads this note.</p>
      {err && <p role="alert" className="mt-1 text-[11px] text-red-300 wrap-break-word">{err}</p>}
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" className="btn py-1!" onClick={() => { setOpen(false); setErr(null); }} disabled={sending}>Cancel</button>
        <button type="button" className={`btn ${danger ? "btn-danger" : "btn-approve"} py-1!`} onClick={submit} disabled={sending || !ready}><Check className="h-3.5 w-3.5" />{step.label}</button>
      </div>
    </div>
  );
}

function ExternalIntents({ data, loading, error, refresh }: { data: any; loading: boolean; error: string | null; refresh: () => void }) {
  const { who } = useSession();
  const owner = who.owner === true;
  const rows = arr(data?.intents).filter((i: any) => i?.target_repo !== "platform" && OPEN_EXTERNAL.includes(i?.state));
  return (
    <section aria-label="External intents">
    <Panel title="External intents" icon={<GitPullRequestClosed className="h-3.5 w-3.5 text-cyan-300" />}
      right={<span className="text-[10px] text-slate-500">council tasks another repository builds; each step reaches the council</span>}>
      {loading && !data ? <Skeleton rows={2} /> : error && !data ? <Empty>{error}</Empty> : data?.available === false ? (
        <Empty>Evolution intents are not available yet: their table is not migrated.</Empty>
      ) : rows.length === 0 ? <Empty>No intent waits for another repository.</Empty> : (
        <ul className="divide-y divide-white/5">
          {rows.map((i: any) => {
            const st = intentState(i);
            return (
              <li key={i.intent_id} className="flex flex-wrap items-center gap-2 px-1 py-2 text-[12px]">
                <Badge tone={INTENT_TONE[st] ?? "slate"}>{st.replace(/_/g, " ")}</Badge>
                {i.stale && <Badge tone="amber">stale</Badge>}
                <span className="flex-1 wrap-break-word text-slate-200">{i.title ?? "—"}</span>
                <span className="mono break-all text-slate-400">{i.target_repo ?? "—"}</span>
                <span className="text-slate-500">next: <span className="text-slate-200">{i.next_actor ?? "—"}</span></span>
                {i.expires_at && <span className="text-slate-500" title={i.expires_at}>expires {until(i.expires_at)}</span>}
                <span className="w-full basis-full text-[11px] text-slate-500">reason: <span className="mono">{i.state_reason ?? "—"}</span> · <LastUpdate u={i.last_update} /> · <span className="mono text-slate-600">{i.intent_id}</span></span>
                {owner && (
                  <div className="flex w-full basis-full flex-wrap gap-2">
                    {(STEPS[i.state] ?? []).map((s) => <ProgressStep key={s.state} id={i.intent_id} step={s} onDone={refresh} />)}
                    {i.state === "waiting_external" && <CloseIntent id={i.intent_id} onClosed={() => refresh()} />}
                    <ProgressStep id={i.intent_id} step={REFUSE} onDone={refresh} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
    </section>
  );
}

function History({ id }: { id: string }) {
  const { data, loading, error } = usePoll(() => call("kernel.intent", id), 5 * 60_000);
  if (loading && !data) return <Skeleton rows={2} />;
  if (error && !data) return <p role="alert" className="text-[11px] text-red-300">{error}</p>;
  const steps = arr(data?.history);
  if (!steps.length) return <Empty>No recorded step.</Empty>;
  return (
    <ol className="ml-2 border-l border-white/10 pl-3 text-[11px]">
      {steps.map((h: any, n: number) => (
        <li key={n} className="py-0.5 text-slate-400">
          <span className="text-slate-500" title={h.at}>{h.at ? ago(h.at) : "—"}</span> · <Badge tone={INTENT_TONE[h.state] ?? "slate"}>{String(h.state).replace(/_/g, " ")}</Badge>
          {h.from && <span className="text-slate-600"> from {String(h.from).replace(/_/g, " ")}</span>} by <span className="mono">{h.actor}</span>
          {h.ref && <> · <RefLink value={h.ref} /></>}
          {h.note && <> · <span className="wrap-break-word">{h.note}</span></>}
        </li>
      ))}
    </ol>
  );
}

function Archive({ data, loading, error }: { data: any; loading: boolean; error: string | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const rows = arr(data?.intents);
  return (
    <section aria-label="Archive">
    <Panel title="Archive" icon={<Archive2 className="h-3.5 w-3.5 text-cyan-300" />}
      right={<span className="text-[10px] text-slate-500">every intent, its state, next actor and full history</span>}>
      {loading && !data ? <Skeleton rows={3} /> : error && !data ? <Empty>{error}</Empty> : data?.available === false ? (
        <Empty>Evolution intents are not available yet: their table is not migrated.</Empty>
      ) : rows.length === 0 ? <Empty>No intent recorded yet.</Empty> : (
        <ul className="divide-y divide-white/5">
          {rows.map((i: any) => {
            const st = i.close_code === "expired" ? "expired" : intentState(i);
            return (
              <li key={i.intent_id} className="px-1 py-1.5 text-[12px]">
                <button type="button" className="flex w-full flex-wrap items-center gap-2 text-left hover:bg-white/5" aria-expanded={open === i.intent_id}
                  onClick={() => setOpen(open === i.intent_id ? null : i.intent_id)}>
                  <Badge tone={INTENT_TONE[st] ?? "slate"}>{st.replace(/_/g, " ")}</Badge>
                  {i.close_code && i.close_code !== "expired" && <span className="mono text-[10px] text-slate-500">{i.close_code}</span>}
                  <span className="flex-1 wrap-break-word text-slate-200">{i.title ?? "—"}</span>
                  <span className="text-slate-500">{i.source} · next: <span className="text-slate-300">{i.next_actor ?? "—"}</span></span>
                  <span className="text-slate-500" title={i.updated_at}>{i.updated_at ? ago(i.updated_at) : "—"}</span>
                </button>
                {open === i.intent_id && <div className="mt-1"><History id={i.intent_id} /></div>}
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
    </section>
  );
}

export default function Proposals({ proposal }: { proposal?: string }) {
  const { data, loading, error, refresh } = usePoll(() => call("kernel.proposals"), 5 * 60_000);
  // Issue #327 C3: one read of the evolution intents feeds both External intents and the Archive.
  const evo = usePoll(() => call("kernel.evolution"), 5 * 60_000);
  const id = proposal && ID.test(proposal) ? proposal : null;
  const rows = arr(data?.proposals);
  useHub(["inbox"], useDebounced(() => { void refresh(); void evo.refresh(); }));
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
      <ExternalIntents data={evo.data} loading={evo.loading} error={evo.error} refresh={() => void evo.refresh()} />
      <Archive data={evo.data} loading={evo.loading} error={evo.error} />
    </div>
  );
}
