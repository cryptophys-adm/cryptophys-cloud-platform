import { useEffect, useState } from "react";
import { ArrowLeft, Check, CheckCircle2, CircleHelp, Gavel, Plus, RefreshCw, Send, Users, X } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, navigate } from "../lib/format";
import { refPage } from "./Ask";

/**
 * HAIC H1.5c (ADR-0017, docs/design/HAIC-H0-H1.md §4): Call for Councils in Cerebrum. A council is a bounded,
 * evidence-bound deliberation on one topic that ends in ranked options; it never acts. The owner convenes one, may join
 * while it deliberates, and picks an option or dismisses it here (Q6: picks in Cerebrum only). A pick becomes a proposal
 * draft for the owner to confirm (H2 performs the translation); "no change" closes the council. Operators read.
 *
 * There is no push hub yet (§4.5), so the page reloads every 5 minutes (ADR-0015 §3: polling only as a slow fallback)
 * and on Refresh; every owner click reloads at once.
 *
 * H1.5d (Q9): agents may propose a council from the evidence (an Observer cluster, a KPI regression, a persistent census
 * finding). A proposal waits here and in the owner's inbox; only the owner begins it ("CONVENE <id13>") or dismisses it.
 * Unbegun, it is dismissed as expired after 7 days. Nothing deliberates and no model is called before the owner's click.
 */

const ID = /^cs_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POLL_MS = 5 * 60_000;
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const RUNNING = ["convening", "positions", "rebuttals", "synthesis"];
const STATE_TONE: Record<string, "cyan" | "amber" | "green" | "slate" | "red" | "purple"> = {
  proposed: "amber", convening: "cyan", positions: "cyan", rebuttals: "cyan", synthesis: "cyan",
  awaiting_owner: "amber", decided: "green", handed_off: "green", dismissed: "slate", aborted: "red", expired: "slate",
};
const STATE_LABEL: Record<string, string> = { awaiting_owner: "waits for your pick", handed_off: "handed off", proposed: "proposed, waits for you" };
const TRIGGER_LABEL: Record<string, string> = { owner: "the owner", finding: "a finding", kpi_regression: "a KPI regression" };
const stateBadge = (s: unknown) => <Badge tone={STATE_TONE[String(s)] ?? "slate"}>{STATE_LABEL[String(s)] ?? String(s ?? "—")}</Badge>;
const usd = (v: unknown) => (typeof v === "number" ? `$${v.toFixed(3)}` : "—");
const pct = (v: unknown) => (typeof v === "number" ? `${Math.round(v * 100)}%` : "—");
const until = (iso: unknown) => {
  const t = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(t)) return "—";
  const h = (t - Date.now()) / 3_600_000;
  return h <= 0 ? "passed" : h < 1 ? `in ${Math.max(1, Math.round(h * 60))} min` : `in ${Math.round(h)} h`;
};
const refLabel = (ref: string) => ref.replace(/^ev:(platform\/)?/, "").replace(/@\d{4}-\d\d-\d\dT[\d:.]+Z/, "").replace(/@[0-9a-f]{12}#/, "#").slice(0, 60);

function RefChip({ r }: { r: string }) {
  const page = refPage(r);
  const chip = <span className="mono rounded border border-cyan-400/25 px-1.5 py-0.5 text-[10px] text-cyan-200" title={r}>{refLabel(r)}</span>;
  return page ? <a href={page} className="hover:brightness-125">{chip}</a> : chip;
}

/** One metric claim: its value, window and n, its refs, and whether the convener verified it against them. */
function ClaimRow({ c }: { c: any }) {
  const verified = c?.verified === true;
  return (
    <li className="flex flex-wrap items-center gap-1.5 text-[11px]">
      {verified ? <Badge tone="green">verified</Badge> : <Badge tone="amber">unverified</Badge>}
      <span className="mono text-slate-200">{String(c?.metric ?? "—")}</span>
      <span className="text-slate-300">= {typeof c?.value === "number" || typeof c?.value === "string" ? String(c.value) : "—"}{c?.unit ? ` ${c.unit}` : ""}</span>
      {c?.window && <span className="text-slate-500">over {c.window}</span>}
      {typeof c?.n === "number" && <span className="text-slate-500">n = {c.n}</span>}
      {arr(c?.refs).slice(0, 6).map((r: string) => <RefChip key={r} r={r} />)}
    </li>
  );
}

function MessageCard({ m }: { m: any }) {
  const who = m.role === "owner" ? "You" : m.role === "system" ? "System" : `persona of ${String(m.author ?? "—").replace(/^agent:/, "")}`;
  const tone = m.role === "owner" ? "border-cyan-400/25 bg-cyan-500/5" : m.role === "system" ? "border-white/5 bg-transparent" : "border-white/10 bg-white/[0.03]";
  return (
    <div className={`rounded-lg border px-3 py-2 ${tone}`}>
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-widest text-slate-500">
        <span className="mono normal-case tracking-normal text-slate-400">#{m.seq}</span>
        <span>{m.phase}</span>·<span className="normal-case tracking-normal text-slate-300">{who}</span>
        {m.stance && <Badge tone="purple">{m.stance}</Badge>}
        {arr(m.reply_to).length > 0 && <span className="normal-case tracking-normal">answers #{arr(m.reply_to).join(", #")}</span>}
        <span className="ml-auto normal-case tracking-normal" title={m.at}>{m.at ? ago(m.at) : "—"}</span>
      </div>
      {m.phase !== "synthesis" && <div className="text-[13px] leading-relaxed text-slate-100 whitespace-pre-wrap wrap-break-word">{m.text}</div>}
      {arr(m.claims).length > 0 && <ul className="mt-2 space-y-1">{arr(m.claims).map((c: any, i: number) => <ClaimRow key={i} c={c} />)}</ul>}
    </div>
  );
}

/** The moderator's ranked options; the owner picks one or dismisses the council while it waits. */
function Options({ synth, session, reload }: { synth: any; session: any; reload: () => void }) {
  const { who, act } = useSession();
  const owner = who.owner === true;
  const waiting = session.state === "awaiting_owner";
  const [note, setNote] = useState("");
  const chosen = session.decision?.option_id ?? null;
  const pick = (o: any) => act({
    route: "kernel.council_pick", params: session.session_id, body: { option_id: o.option_id, note: note.trim() || undefined },
    title: `Pick option ${o.rank}: ${String(o.title ?? "").slice(0, 60)}`,
    lines: o.change?.type === "no_change"
      ? ["This closes the council: nothing changes. Your pick is audited under your Access identity."]
      : [
          "Your pick becomes a proposal draft for you to confirm; nothing changes by this click.",
          o.change?.type === "shadow_arm" ? "A strategy change runs first as a shadow arm over the measured window; going live is a separate click." : "Promotion to live is a separate owner click.",
          "The pick is audited under your Access identity.",
        ],
    done: "Picked.", after: () => { setNote(""); reload(); },
  });
  return (
    <Panel title="Options" icon={<Gavel className="h-3.5 w-3.5 text-amber-300" />}
      right={<span className="text-[10px] text-slate-500">ranked by the moderator · unverified claims add no confidence</span>}>
      {synth?.text && <p className="mb-3 text-[13px] leading-relaxed text-slate-200 whitespace-pre-wrap wrap-break-word">{synth.text}</p>}
      <div className="space-y-3">
        {arr(synth?.options).map((o: any) => (
          <div key={o.option_id} className={`rounded-lg border px-3 py-2 ${chosen === o.option_id ? "border-emerald-400/40 bg-emerald-500/5" : "border-white/10"}`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="mono text-[11px] text-slate-400">#{o.rank}</span>
              <span className="text-[13px] font-semibold text-white">{o.title ?? "—"}</span>
              <Badge tone={o.change?.type === "no_change" ? "slate" : "purple"}>{String(o.change?.type ?? "—").replace(/_/g, " ")}</Badge>
              {chosen === o.option_id && <Badge tone="green">your pick</Badge>}
            </div>
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12px]">
              <dt className="text-slate-500">hypothesis</dt><dd className="text-slate-200 wrap-break-word">{o.hypothesis ?? "—"}</dd>
              <dt className="text-slate-500">expected effect</dt><dd className="text-slate-300">{o.expected_effect ? `${o.expected_effect.metric}: ${o.expected_effect.from ?? "—"} → ${o.expected_effect.to ?? "—"} over ${o.expected_effect.window ?? "—"}` : "—"}</dd>
              <dt className="text-slate-500">risk</dt><dd className="text-slate-300">{o.risk ? `${o.risk.level} · ${o.risk.reversible ? "reversible" : "not reversible"}${o.risk.notes ? ` · ${o.risk.notes}` : ""}` : "—"}</dd>
              <dt className="text-slate-500">confidence</dt><dd className="mono text-slate-200">{pct(o.confidence)}</dd>
              <dt className="text-slate-500">target</dt><dd className="mono break-all text-slate-300">{o.change?.target ?? "—"}</dd>
              <dt className="text-slate-500">evidence</dt><dd className="flex flex-wrap gap-1.5">{arr(o.evidence_refs).length ? arr(o.evidence_refs).slice(0, 10).map((r: string) => <RefChip key={r} r={r} />) : "—"}</dd>
              <dt className="text-slate-500">dissent</dt><dd className="text-slate-300">{arr(o.dissent).length ? arr(o.dissent).join(" · ") : "—"}</dd>
            </dl>
            {waiting && owner && (
              <div className="mt-2 flex justify-end">
                <button type="button" className="btn btn-approve py-1!" onClick={() => pick(o)}><Check className="h-3.5 w-3.5" />Pick…</button>
              </div>
            )}
          </div>
        ))}
      </div>
      {waiting && owner && (
        <label className="mt-3 block">
          <span className="label">Note with your pick (optional, at most 500 characters)</span>
          <input className="field" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this option, or a constraint for the draft" />
        </label>
      )}
      {session.decision?.proposal_draft && (
        <div className="mt-3 rounded-lg border border-emerald-400/20 bg-emerald-500/5 px-3 py-2 text-[12px] text-slate-300">
          <div className="mb-1 flex items-center gap-1.5 text-emerald-200"><CheckCircle2 className="h-3.5 w-3.5" />Proposal draft</div>
          <div><span className="text-slate-500">kind</span> <span className="mono">{session.decision.proposal_draft.kind}</span> · <span className="text-slate-500">requires</span> <span className="mono">{arr(session.decision.proposal_draft.requires).join(", ")}</span></div>
          <div className="mt-1 text-[11px] text-slate-500">Confirming the draft and handing it to its path (a consensus action, a repository task or a shadow arm) arrives with H2; until then nothing runs from it.</div>
        </div>
      )}
    </Panel>
  );
}

function Detail({ id, limits }: { id: string; limits: any }) {
  const { who, act, notify } = useSession();
  const owner = who.owner === true;
  const { data, loading, error, refresh } = usePoll(() => call("kernel.council", id), POLL_MS, [id]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const reload = () => { void refresh(); };
  const back = <a href="#/councils" className="inline-flex items-center gap-1 text-[10px] uppercase tracking-widest text-cyan-300 hover:underline"><ArrowLeft className="h-3 w-3" />All councils</a>;
  if (loading && !data) return <Panel title="Council" right={back}><Skeleton rows={5} /></Panel>;
  if (error && !data) return <Panel title="Council" right={back}><Empty>{error}</Empty></Panel>;
  const s = data?.session;
  if (!s) return <Panel title="Council" right={back}><Empty>No such council.</Empty></Panel>;
  const messages = arr(data?.messages);
  const synth = [...messages].reverse().find((m) => m.phase === "synthesis");
  const running = RUNNING.includes(s.state);
  const open = running || s.state === "awaiting_owner" || s.state === "proposed";
  const maxChars = typeof limits?.max_message_chars === "number" ? limits.max_message_chars : 1200;
  const say = () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    call("kernel.council_message", s.session_id, { text: t })
      .then(() => { setText(""); reload(); })
      .catch((e) => notify("err", e.message))
      .finally(() => setSending(false));
  };
  const begin = () => act({
    route: "kernel.council_begin", params: s.session_id, body: {},
    title: "Begin this proposed council",
    lines: [
      `It deliberates from now on: at most ${s.budget?.max_calls ?? 16} model calls and about ${usd(s.budget?.max_usd)}; it counts toward the councils of today.`,
      "It ends in ranked options for your pick and never acts. This is audited under your Access identity.",
    ],
    done: "Begun.", after: reload,
  });
  const dismiss = () => act({
    route: "kernel.council_dismiss", params: s.session_id, body: {},
    title: running ? "Stop this council" : "Dismiss this council",
    lines: [running ? "The council stops now and is recorded as aborted by you; its transcript is kept." : "The council closes without a pick; nothing changes.", "This is audited under your Access identity."],
    done: running ? "Stopped." : "Dismissed.", after: reload,
  });
  return (
    <div className="flex flex-col gap-3">
      <Panel title="Council" icon={<Users className="h-3.5 w-3.5 text-cyan-300" />} right={back}>
        <div className="text-[15px] font-semibold wrap-break-word text-white">{s.topic}</div>
        <div className="mt-1 text-[13px] text-slate-300 whitespace-pre-wrap wrap-break-word">{s.question}</div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          {stateBadge(s.state)}
          <span>convened {arr(s.convened).length ? arr(s.convened).join(", ") : "—"}</span>·
          <span>{s.spent?.calls ?? "—"} of {s.budget?.max_calls ?? "—"} model calls</span>·
          <span>{usd(s.spent?.usd_est)} of {usd(s.budget?.max_usd)} estimated</span>·
          <span title={s.deadline}>{s.state === "awaiting_owner" ? `expires ${until(s.deadline)}` : `window ends ${until(s.deadline)}`}</span>
          {s.reason && <><span>·</span><span>reason <span className="mono">{s.reason}</span></span></>}
          {s.transcript_sha256 && <><span>·</span><span className="mono" title={s.transcript_sha256}>sha256 {s.transcript_sha256.slice(0, 12)}</span></>}
          {s.transcript_sha256 && <><span>·</span><span title="the closed council's transcript in R2 (cryptophys-council-transcripts), its sha256 the one above">{s.transcript_key ? <>R2 <span className="mono">{s.transcript_key}</span></> : "R2: not stored yet"}</span></>}
          <span className="ml-auto flex items-center gap-2">
            <button type="button" className="btn py-1!" onClick={reload} aria-label="Refresh"><RefreshCw className="h-3.5 w-3.5" />Refresh</button>
            {owner && open && <button type="button" className="btn btn-danger py-1!" onClick={dismiss}><X className="h-3.5 w-3.5" />{running ? "Stop…" : "Dismiss…"}</button>}
          </span>
        </div>
      </Panel>
      {s.proposal && (
        <Panel title="Proposed by an agent" icon={<Users className="h-3.5 w-3.5 text-amber-300" />}
          right={<span className="text-[10px] text-slate-500">only you begin it · unbegun, it expires {s.state === "proposed" ? until(s.deadline) : "—"}</span>}>
          <div className="text-[12px] text-slate-300">
            <span className="mono">{String(s.proposal.proposed_by ?? "—").replace(/^agent:/, "")}</span> proposed it on {TRIGGER_LABEL[s.trigger?.kind] ?? "evidence"}: {s.proposal.detail ?? "—"}
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">{arr(s.proposal.refs).slice(0, 10).map((r: string) => <RefChip key={r} r={r} />)}</div>
          {owner && s.state === "proposed" && (
            <div className="mt-2 flex justify-end"><button type="button" className="btn btn-approve py-1!" onClick={begin}><Users className="h-3.5 w-3.5" />Begin…</button></div>
          )}
        </Panel>
      )}
      {synth && arr(synth.options).length > 0 && <Options synth={synth} session={s} reload={reload} />}
      <Panel title="Transcript" right={<span className="text-[10px] text-slate-500">{messages.length} message{messages.length === 1 ? "" : "s"} · every post is a persona of its agent, labelled</span>}>
        {messages.length === 0 ? <Empty>{running ? "The council is convening: positions appear within about 10 minutes." : "No message."}</Empty> : (
          <div className="space-y-2">{messages.filter((m) => m.phase !== "synthesis").map((m) => <MessageCard key={m.seq} m={m} />)}</div>
        )}
        {owner && running && (
          <div className="mt-3 border-t border-white/5 pt-3">
            <div className="flex items-end gap-2">
              <textarea className="field min-h-[56px] flex-1" maxLength={maxChars} value={text} onChange={(e) => setText(e.target.value)}
                placeholder="Ask the council a question or set a constraint; the moderator must address it in the synthesis" disabled={sending} />
              <button type="button" className="btn" onClick={say} disabled={sending || !text.trim()} aria-label="Send to the council"><Send className="h-3.5 w-3.5" />Send</button>
            </div>
            <p className="mt-1 text-[10px] text-slate-600">At most {typeof limits?.max_owner_messages === "number" ? limits.max_owner_messages : 20} messages of {maxChars} characters. Never paste a token or a password: such a message is refused.</p>
          </div>
        )}
      </Panel>
    </div>
  );
}

function StartForm({ reload, limits }: { reload: () => void; limits: any }) {
  const { act } = useSession();
  const [topic, setTopic] = useState("");
  const [question, setQuestion] = useState("");
  const ok = topic.trim().length > 0 && topic.trim().length <= 200 && question.trim().length > 0 && question.trim().length <= 1200;
  const start = () => act({
    route: "kernel.council_start", body: { topic: topic.trim(), question: question.trim() },
    title: "Convene a council",
    lines: [
      `The council spends at most ${typeof limits?.max_model_calls === "number" ? limits.max_model_calls : 16} model calls and about $${typeof limits?.max_usd === "number" ? limits.max_usd.toFixed(2) : "0.10"}; at most ${typeof limits?.max_started_per_utc_day === "number" ? limits.max_started_per_utc_day : 4} councils start per UTC day.`,
      "It reads the platform's evidence, deliberates and ends in ranked options for your pick. It never acts.",
    ],
    done: "Convened.", after: (d: any) => { setTopic(""); setQuestion(""); reload(); if (typeof d?.session_id === "string") navigate(`#/councils/${d.session_id}`); },
  });
  return (
    <Panel title="Call a council" icon={<Plus className="h-3.5 w-3.5 text-cyan-300" />}>
      <label className="block">
        <span className="label">Topic (at most 200 characters)</span>
        <input className="field" maxLength={200} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="For example: Native deploys fail more often after migrations" />
      </label>
      <label className="mt-2 block">
        <span className="label">Question</span>
        <textarea className="field min-h-[56px]" maxLength={1200} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What should the council weigh, and what would you decide with its answer?" />
      </label>
      <div className="mt-2 flex justify-end">
        <button type="button" className="btn btn-approve py-1!" disabled={!ok} onClick={start}><Users className="h-3.5 w-3.5" />Convene…</button>
      </div>
    </Panel>
  );
}

export default function Councils({ council }: { council?: string }) {
  const { who } = useSession();
  const owner = who.owner === true;
  const { data, loading, error, refresh } = usePoll(() => call("kernel.councils"), POLL_MS);
  const id = council && ID.test(council) ? council : null;
  const rows = arr(data?.councils);
  const limits = data?.limits;
  useEffect(() => { if (council && !id) navigate("#/councils"); }, [council, id]);
  return (
    <div className="flex flex-col gap-3">
      <h1 className="sr-only">Councils</h1>
      {id && <Detail id={id} limits={limits} />}
      {!id && owner && data?.available !== false && <StartForm reload={() => void refresh()} limits={limits} />}
      <Panel title="Councils" icon={<Users className="h-3.5 w-3.5 text-cyan-300" />}
        right={<span className="text-[10px] text-slate-500">a council deliberates on evidence and ends in options; it never acts</span>}>
        {loading && !data ? <Skeleton rows={3} /> : error && !data ? <Empty>{error}</Empty> : data?.available === false ? (
          <Empty>Councils are not available yet: their table is not migrated.</Empty>
        ) : rows.length === 0 ? <Empty>No council yet.{owner ? " Call one above." : ""}</Empty> : (
          <ul className="divide-y divide-white/5">
            {rows.map((c: any) => (
              <li key={c.session_id}>
                <a href={`#/councils/${c.session_id}`} className={`flex flex-wrap items-center gap-2 px-1 py-2 text-[12px] hover:bg-white/5 ${c.session_id === id ? "bg-white/5" : ""}`}>
                  {stateBadge(c.state)}
                  <span className="flex-1 wrap-break-word text-slate-200">{c.topic}</span>
                  {c.trigger_kind && c.trigger_kind !== "owner" && <span className="text-slate-500">by <span className="mono">{String(c.created_by ?? "").replace(/^agent:/, "")}</span></span>}
                  <span className="text-slate-500">{c.spent_calls ?? "—"} calls · {usd(c.spent_usd)}</span>
                  <span className="text-slate-500" title={c.created_at}>{c.created_at ? ago(c.created_at) : "—"}</span>
                  {(c.state === "awaiting_owner" || c.state === "proposed") && <span className="text-amber-300" title={c.deadline}>expires {until(c.deadline)}</span>}
                </a>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 flex items-center gap-1 text-[10px] text-slate-600"><CircleHelp className="h-3 w-3" />Picks are made here only. A pick becomes a draft you confirm; a strategy change runs in shadow first, and going live is a separate click.</p>
      </Panel>
    </div>
  );
}
