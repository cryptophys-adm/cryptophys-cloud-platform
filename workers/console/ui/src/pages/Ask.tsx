import { useEffect, useRef, useState } from "react";
import { FileCheck2, MessageSquareText, Plus, Send, ThumbsDown, ThumbsUp } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, navigate } from "../lib/format";

/**
 * HAIC H1c (ADR-0017 H1, docs/design/HAIC-H0-H1.md §3.1): "Ask the organism". The owner asks in English; the kernel
 * answers from read-only tools only, metric first, every number cited (an uncited one reads "— (not measured)"). The
 * chat cannot act: a request to change something gets the Console page that does it. Owners only (Q1); its budget is
 * its own (Q2). Each answer ends with its evidence chips, each linking to the page that shows that evidence.
 */

const ID = /^cnv_[0-9a-f]{16}$/;
const newId = () => `cnv_${[...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** The Console page that shows a ref's evidence, or null when none does. */
export function refPage(ref: string): string | null {
  const m = /^ev:(?:platform\/)?([a-z_.]+)(?:\/([^@#]+))?/.exec(ref);
  if (!m) return null;
  const [, kind, id] = m;
  if (kind === "adr") return id ? `#/vision/adr/${id}` : "#/vision/adr";
  const pages: Record<string, string> = {
    owner_inbox: "#/owner", production_problem: "#/owner", critical_report: "#/owner", consensus: "#/consensus", report: "#/",
    knowledge: "#/knowledge", agents: "#/agents", mesh: "#/agents", metabolism: "#/organism", census: "#/organism",
    vision: "#/vision", adr_progress: "#/vision/adr", doc: "#/code", policy_dry_run: "#/policy", reports: "#/",
  };
  if (kind === "recovery_plan" && id) return `#/recovery/${id}`;
  // HAIC H1.5c: a council ref opens that council.
  if (kind === "council" && id) return `#/councils/${id}`;
  return pages[kind] ?? null;
}
const refLabel = (ref: string) => ref.replace(/^ev:(platform\/)?/, "").replace(/@\d{4}-\d\d-\d\dT[\d:.]+Z/, "").replace(/@[0-9a-f]{12}#/, "#").slice(0, 60);

function Turn({ t, id, reload }: { t: any; id: string; reload: () => void }) {
  const { notify } = useSession();
  // HAIC H3b: a rating is also recorded as a correction; an optional short note goes with it as the correction's text.
  const [note, setNote] = useState("");
  const rate = (rating: "up" | "down") => {
    const text = note.trim();
    call("kernel.conversation_rate", [id, String(t.n)], text ? { rating, note: text } : { rating }).then(() => { setNote(""); reload(); }).catch((e) => notify("err", e.message));
  };
  const tone = t.status === "answered" ? "green" : t.status === "refused" ? "amber" : "red";
  return (
    <div className="space-y-2">
      <div className="ml-auto max-w-[85%] rounded-lg bg-cyan-500/10 px-3 py-2 text-[13px] text-slate-100 whitespace-pre-wrap wrap-break-word">{t.question}</div>
      <div className="max-w-[92%] rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
        <div className="text-[13px] leading-relaxed text-slate-100 whitespace-pre-wrap wrap-break-word">{t.answer}</div>
        {arr(t.refs).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {arr(t.refs).slice(0, 12).map((r: string) => {
              const page = refPage(r);
              const chip = <span className="mono rounded border border-cyan-400/25 px-1.5 py-0.5 text-[10px] text-cyan-200" title={r}>{refLabel(r)}</span>;
              return page ? <a key={r} href={page} className="hover:brightness-125">{chip}</a> : <span key={r}>{chip}</span>;
            })}
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
          {t.status !== "answered" && <Badge tone={tone}>{t.status}</Badge>}
          {arr(t.tools).length > 0 && <span>tools: <span className="mono">{arr(t.tools).map((x: any) => `${x.name}${x.ok ? "" : " (refused)"}`).join(", ")}</span></span>}
          {t.citations && (t.citations.kept > 0 || t.citations.stripped > 0) && (
            <span>{t.citations.kept} number{t.citations.kept === 1 ? "" : "s"} cited{t.citations.stripped ? `, ${t.citations.stripped} removed as not measured` : ""}</span>
          )}
          {arr(t.injection).length > 0 && <Badge tone="amber">instruction-like data ignored</Badge>}
          {typeof t.latency_ms === "number" && <span>{(t.latency_ms / 1000).toFixed(1)} s</span>}
          <span title={t.created_at}>{t.created_at ? ago(t.created_at) : "—"}</span>
          {t.status === "answered" && (
            <span className="ml-auto flex items-center gap-1">
              <input type="text" className="field w-44! px-2! py-0.5! text-[10px]!" maxLength={500} placeholder="note (optional)" aria-label="Rating note"
                title="Sent with your thumbs up or down and kept as your correction of this answer (at most 500 characters; a secret is redacted)" value={note} onChange={(e) => setNote(e.target.value)} />
              <button type="button" aria-label="Good answer" aria-pressed={t.rating === "up"} onClick={() => rate("up")}
                className={`rounded p-1 hover:bg-white/10 ${t.rating === "up" ? "text-emerald-300" : "text-slate-500"}`}><ThumbsUp className="h-3.5 w-3.5" /></button>
              <button type="button" aria-label="Bad answer" aria-pressed={t.rating === "down"} onClick={() => rate("down")}
                className={`rounded p-1 hover:bg-white/10 ${t.rating === "down" ? "text-rose-300" : "text-slate-500"}`}><ThumbsDown className="h-3.5 w-3.5" /></button>
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Ask({ conversation }: { conversation?: string }) {
  const { who, notify } = useSession();
  const owner = who.owner === true;
  const { data: list, loading, refresh } = usePoll(() => (owner ? call("kernel.conversations") : Promise.resolve(null)), 60_000);
  const id = conversation && ID.test(conversation) ? conversation : null;
  const [turns, setTurns] = useState<any[]>([]);
  const [loadingTurns, setLoadingTurns] = useState(false);
  const [q, setQ] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  const load = () => {
    if (!id || !owner) { setTurns([]); return; }
    setLoadingTurns(true);
    call("kernel.conversation", id).then((d) => setTurns(arr(d?.turns))).catch((e) => { if (e?.status === 404) setTurns([]); else notify("err", e.message); })
      .finally(() => setLoadingTurns(false));
  };
  useEffect(load, [id, owner]);
  useEffect(() => { end.current?.scrollIntoView?.({ block: "end" }); }, [turns.length, pending]);

  if (!owner) {
    return <Panel title="Ask the organism" icon={<MessageSquareText className="h-3.5 w-3.5 text-cyan-300" />}><Empty>The chat is for owners only.</Empty></Panel>;
  }
  const enabled = list?.enabled === true;
  const budget = list?.budget;
  const used = typeof budget?.used === "number" && typeof budget?.limit === "number" && budget.used >= budget.limit;
  const send = () => {
    const question = q.trim();
    if (!question || pending || !enabled) return;
    const target = id ?? newId();
    if (!id) navigate(`#/ask/${target}`);
    setPending(question);
    setQ("");
    call("kernel.conversation_turn", target, { question })
      .then((t) => { setTurns((prev) => [...prev, t]); void refresh(); })
      .catch((e) => { notify("err", e.message); setQ(question); })
      .finally(() => setPending(null));
  };

  // HAIC H2b: the owner's directive ("focus on accuracy this week") into a typed proposal draft, confirmed on its page.
  const propose = () => {
    const directive = q.trim();
    if (!directive || drafting || !enabled) return;
    setDrafting(true);
    call("kernel.proposal_draft", undefined, { directive, conversation_id: id ?? undefined })
      .then((p) => { setQ(""); notify("ok", "Draft made; confirm or reject it on its page."); if (typeof p?.proposal_id === "string") navigate(`#/proposals/${p.proposal_id}`); })
      .catch((e) => notify("err", e.message))
      .finally(() => setDrafting(false));
  };

  return (
    <div className="grid gap-3 lg:grid-cols-[260px_1fr]">
      <Panel title="Conversations" icon={<MessageSquareText className="h-3.5 w-3.5 text-cyan-300" />}
        right={<button type="button" className="btn py-1!" onClick={() => { setTurns([]); navigate(`#/ask/${newId()}`); }}><Plus className="h-3.5 w-3.5" />New</button>}>
        {loading && !list ? <Skeleton rows={3} /> : arr(list?.conversations).length === 0 ? <Empty>No conversation yet.</Empty> : (
          <ul className="space-y-1">
            {arr(list?.conversations).map((c: any) => (
              <li key={c.conversation_id}>
                <a href={`#/ask/${c.conversation_id}`} className={`block rounded px-2 py-1.5 text-[11px] hover:bg-white/5 ${c.conversation_id === id ? "bg-white/10 text-white" : "text-slate-400"}`}>
                  <span className="mono">{c.conversation_id.slice(4, 12)}</span> · {c.turns} turn{c.turns === 1 ? "" : "s"} · <span title={c.updated_at}>{ago(c.updated_at)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 border-t border-white/5 pt-2 text-[10px] text-slate-500">
          <div>Chat {list ? (enabled ? "on" : "off") : "—"} · model <span className="mono">{typeof list?.model === "string" ? list.model.replace(/^@cf\//, "") : "—"}</span></div>
          <div>Today: {typeof budget?.used === "number" ? budget.used : "—"} of {typeof budget?.limit === "number" ? budget.limit : "—"} turns</div>
        </div>
      </Panel>
      <Panel title="Ask the organism" right={<span className="text-[10px] text-slate-500">read only · every number cited · it cannot act</span>}>
        <div className="flex min-h-[320px] flex-col gap-4">
          {loadingTurns ? <Skeleton rows={4} /> : turns.length === 0 && !pending ? (
            <Empty>Ask about the platform in English: what waits for you, why a deploy failed, how an ADR is progressing, what a rule says. Answers come from the platform's own data, with their evidence.</Empty>
          ) : turns.map((t) => <Turn key={t.n} t={t} id={id!} reload={load} />)}
          {pending && (
            <div className="space-y-2">
              <div className="ml-auto max-w-[85%] rounded-lg bg-cyan-500/10 px-3 py-2 text-[13px] text-slate-100 whitespace-pre-wrap wrap-break-word">{pending}</div>
              <div className="text-[12px] text-slate-500">Reading the platform's data and answering… (up to about 30 seconds)</div>
            </div>
          )}
          <div ref={end} />
        </div>
        <div className="mt-3 border-t border-white/5 pt-3">
          {!enabled && list ? <p className="mb-2 text-[11px] text-amber-300">The chat is switched off.</p> : used ? <p className="mb-2 text-[11px] text-amber-300">Today's chat budget is used up; it starts again at 00:00 UTC.</p> : null}
          <div className="flex items-end gap-2">
            <textarea className="field min-h-[60px] flex-1" maxLength={2000} placeholder="Ask in English, for example: What needs me right now?" value={q}
              onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} disabled={!enabled || !!pending} />
            <div className="flex flex-col gap-1.5">
              <button type="button" className="btn" onClick={send} disabled={!enabled || !!pending || drafting || !q.trim()} aria-label="Send"><Send className="h-3.5 w-3.5" />Send</button>
              <button type="button" className="btn" onClick={propose} disabled={!enabled || !!pending || drafting || !q.trim()} aria-label="Make a proposal" title="Turn this directive into a typed proposal draft; nothing happens until you confirm it">
                <FileCheck2 className="h-3.5 w-3.5" />{drafting ? "Drafting…" : "Propose"}</button>
            </div>
          </div>
          <p className="mt-1 text-[10px] text-slate-600">Propose turns a directive (for example "raise the daily deploy limit to 12") into a typed proposal draft: a policy parameter, a repository task, a vision KPI or a shadow arm. Nothing happens until you confirm it. Never paste a token or a password here: a message that carries one is refused and only its redacted form is kept.</p>
        </div>
      </Panel>
    </div>
  );
}
