import { BookOpenCheck, Check, GraduationCap, Library, Scale, Sparkles, X } from "lucide-react";
import { Badge, Dot, Empty, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, listOf } from "../lib/format";
import { DataTable, Meter, STATUS, Stat, StatusBar } from "../components/viz";

/** TP-028: learned-knowledge proposals from Aether (tier 1 drafts). Approval is for shadow testing only. */
const tone = (s?: string): "green" | "amber" | "red" | "slate" =>
  s === "approved" ? "green" : s === "pending" ? "amber" : s === "rejected" ? "red" : "slate";
const KIND_TEXT: Record<string, string> = {
  caution: "A measured pattern where an agent has been wrong more often than usual.",
  role_reminder: "An agent keeps breaking its role or the doctrine; a reminder of its role.",
  param_candidate: "A parameter value from a reviewed grid, to test in shadow.",
};

// Aether's own view (GET /v1/overview over the AETHER Service Binding): how far each learning rule is
// from its threshold, and the knowledge that already exists. Every number is read from that answer; a
// missing value shows a dash.
const dash = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : String(v));
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const short = (sha?: string | null) => (sha ? String(sha).slice(0, 12) : "—");
const TF: Record<string, string> = { "15": "15m", "60": "1H", "240": "4H", "1D": "D1" };
const words = (s?: string | null) => (s ? String(s).replace(/_/g, " ") : "—");

/** A have/need meter when both numbers came back; a dash otherwise. */
function Need({ label, have, need }: { label: string; have: unknown; need: unknown }) {
  const h = num(have), n = num(need);
  if (h === null || n === null) return <div className="text-[11px] text-slate-500">{label} · —</div>;
  return <Meter label={label} value={h} target={n} />;
}
const Ready = ({ ready }: { ready?: boolean }) => (ready ? <Badge tone="green">ready</Badge> : <Badge tone="slate">collecting</Badge>);

function Progress({ o }: { o: any }) {
  const c = o?.progress?.curation;
  const w: any[] = o?.progress?.weighting ?? [];
  const rd = c?.role_drift, ca = c?.caution, en = c?.engine;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="decision cards read" value={dash(c?.cards)} sub={rd || ca ? `role drift ${dash(rd?.window_days)}d · patterns ${dash(ca?.window_days)}d` : undefined} />
        <Stat label="role reminders ready" value={dash(rd?.ready)} tone={num(rd?.ready) ? "good" : undefined} />
        <Stat label="agent patterns ready" value={dash(ca?.ready)} tone={num(ca?.ready) ? "good" : undefined} />
        <Stat label="engine patterns ready" value={dash(en?.ready)} tone={num(en?.ready) ? "good" : undefined} />
      </div>
      {!c ? <Empty>Aether returned no curation progress.</Empty> : (<>
        <div>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Curator · role drift</h4>
          <p className="mb-2 text-[11px] text-slate-500">An agent that breaks one owner rule in more than {dash(rd?.need?.rate_pct_above)}% of {dash(rd?.need?.rooms)}+ rooms, cited by {dash(rd?.need?.rooms_with_break)}+ rooms, over {dash(rd?.window_days)} days.</p>
          <div className="mb-2 max-w-md"><Need label="days of cards in the window" have={rd?.span_days} need={rd?.need?.span_days} /></div>
          <DataTable dense rows={rd?.agents ?? []} rowKey={(a: any) => a.agent} maxHeight={260} empty="No rooms in the window yet." columns={[
            { key: "agent", header: "agent", sort: (a: any) => a.agent, cell: (a: any) => <span className="mono text-cyan-200">{a.agent}</span> },
            { key: "rooms", header: "rooms", sort: (a: any) => a.rooms, align: "right", cell: (a: any) => <span className="mono">{dash(a.rooms)} / {dash(rd?.need?.rooms)}</span> },
            { key: "check", header: "most broken rule", cell: (a: any) => <span className="text-slate-300">{words(a.check)}</span> },
            { key: "breaks", header: "rooms with it", sort: (a: any) => a.rooms_with_break, align: "right", cell: (a: any) => <span className="mono">{dash(a.rooms_with_break)} / {dash(rd?.need?.rooms_with_break)}</span> },
            { key: "rate", header: "rate", sort: (a: any) => a.rate_pct, align: "right", cell: (a: any) => <span className="mono">{dash(a.rate_pct)}%</span> },
            { key: "ready", header: "", cell: (a: any) => <Ready ready={a.ready} /> },
          ]} />
        </div>
        <div>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Curator · agent patterns</h4>
          <p className="mb-2 text-[11px] text-slate-500">An agent wrong more often in one chart and session than in its other situations: {dash(ca?.need?.decisive)}+ decisive outcomes on each side, one-sided p &lt; {dash(ca?.need?.alpha)}, over {dash(ca?.window_days)} days. Decisive outcomes in the window: <span className="mono text-slate-300">{dash(ca?.decisive_outcomes)}</span>.</p>
          <DataTable dense rows={ca?.situations ?? []} rowKey={(x: any) => `${x.agent}|${x.chart}|${x.session}`} maxHeight={260} empty="No scored outcomes in the window yet." columns={[
            { key: "agent", header: "agent", sort: (x: any) => x.agent, cell: (x: any) => <span className="mono text-cyan-200">{x.agent}</span> },
            { key: "where", header: "chart · session", cell: (x: any) => <span className="text-slate-300">{TF[x.chart] ?? dash(x.chart)} · {words(x.session)}</span> },
            { key: "decisive", header: "decisive", sort: (x: any) => x.decisive, align: "right", cell: (x: any) => <span className="mono">{dash(x.decisive)} / {dash(ca?.need?.decisive)}</span> },
            { key: "wrong", header: "wrong here", sort: (x: any) => x.wrong_pct, align: "right", cell: (x: any) => <span className="mono">{dash(x.wrong_pct)}%</span> },
            { key: "base", header: "wrong elsewhere", align: "right", cell: (x: any) => <span className="mono">{x.baseline_wrong_pct == null ? "—" : `${x.baseline_wrong_pct}%`} <span className="text-slate-500">({dash(x.baseline_decisive)})</span></span> },
            { key: "ready", header: "", cell: (x: any) => <Ready ready={x.ready} /> },
          ]} />
        </div>
        <div>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Calibrator · engine patterns</h4>
          <p className="mb-2 text-[11px] text-slate-500">A structure engine that stays stuck in {dash(en?.need?.episodes)}+ separate episodes over {dash(en?.window_days)} days, seen in {dash(en?.need?.cards)}+ hourly cards: the next untested value of its reviewed grid is proposed for shadow.</p>
          <div className="grid gap-3 md:grid-cols-2">
            {(en?.families ?? []).map((f: any) => (
              <div key={f.family} className="glass-inner space-y-2 px-3 py-2.5">
                <div className="flex items-center justify-between text-[12px]"><span className="text-slate-200">{dash(f.name)} <span className="mono text-[10px] text-slate-500">{f.family}</span></span><Ready ready={f.ready} /></div>
                <Need label="stuck episodes" have={f.episodes} need={en?.need?.episodes} />
                <Need label="hourly cards stuck" have={f.cards} need={en?.need?.cards} />
                <div className="text-[11px] text-slate-500">longest {dash(f.longest_candles)} candles · next grid value {dash(f.next_value)}</div>
              </div>
            ))}
          </div>
        </div>
      </>)}
      <div>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Auto-tuning · quorum weighting per timeframe</h4>
        <p className="mb-2 text-[11px] text-slate-500">XAUUSD replays each room under neighbouring weightings. A candidate is judged once its discovery slice reaches its minimum and the newest rooms fill the holdout; a better one activates by itself.</p>
        {!w.length ? <Empty>No weighting report has reached Aether yet.</Empty> : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {w.map((t: any) => (
              <div key={t.timeframe} className="glass-inner space-y-2 px-3 py-2.5">
                <div className="flex items-center justify-between text-[12px]"><span className="text-slate-200">{TF[t.timeframe] ?? dash(t.timeframe)}</span><Badge tone="slate">{dash(t.mode)}</Badge></div>
                <div className="text-[11px] text-slate-400">rooms <span className="mono text-slate-200">{dash(t.rooms)}</span> over {dash(t.window_days)}d · {dash(t.candidates)} candidates</div>
                <Need label="discovery rooms" have={t.discovery?.have} need={t.discovery?.need} />
                <Need label="holdout rooms" have={t.holdout?.have} need={t.holdout?.need} />
                <div className="mono truncate text-[10px] text-slate-500" title={dash(t.active)}>active {dash(t.active)} · report {ago(t.received_at)}</div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const COUNCIL_TONE: Record<string, "green" | "amber" | "red" | "cyan" | "slate"> = { in_sync: "green", propose: "cyan", observing: "slate", refused: "red", unreported: "amber" };
const COUNCIL_TEXT: Record<string, string> = {
  in_sync: "matches the measured system",
  observing: "a difference not yet measured twice from the same version",
  propose: "every seat agreed: proposed to Cerebrum",
  refused: "the Aether seat refused it (outside its hard bound)",
  unreported: "the system no longer reports a fact: needs an owner PR",
};
const show = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** Owner 2026-11-11: the Knowledge Council's daily doctrine review, proposed to Cerebrum for execution. */
function Council({ o }: { o: any }) {
  const d = o?.doctrine;
  const s = d?.council?.last_session;
  const review: any[] = s?.review ?? [];
  const open = review.filter((r) => r.status !== "in_sync");
  const seats = d?.facts?.seats ?? {};
  if (!d) return <Empty>Aether returned no doctrine view.</Empty>;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="last session" value={s ? ago(s.held_at) : "—"} sub={s ? `${dash(s.session_id)} · mode ${dash(s.mode)}` : dash(d.council?.schedule_utc)} />
        <Stat label="rules reviewed" value={s ? review.length : "—"} sub={s ? `${open.length} differ from the system` : undefined} tone={s ? (open.length ? "warning" : "good") : undefined} />
        <Stat label="proposed to Cerebrum" value={s ? (s.proposals ?? []).filter((p: any) => p.proposal_id).length : "—"} />
        <Stat label="amendments applied" value={dash(d.applied?.length)} sub={d.audited ? `doctrine audited ${d.audited}` : undefined} />
      </div>
      <p className="text-[11px] text-slate-500">
        Facts: {d.facts ? <>reported {ago(d.facts.received_at)} · {Object.entries(seats).map(([k, v]: any) => `${k} ${dash(v.facts)} facts (version ${dash(v.version_id)})`).join(" · ")}</> : "—"}
      </p>
      <DataTable dense rows={open} rowKey={(r: any) => r.rule} maxHeight={300} empty={s ? "Every anchored rule matches the measured system." : "The council has not met yet."} columns={[
        { key: "status", header: "status", sort: (r: any) => r.status, cell: (r: any) => <span title={COUNCIL_TEXT[r.status] ?? ""}><Badge tone={COUNCIL_TONE[r.status] ?? "slate"}>{words(r.status)}</Badge></span> },
        { key: "rule", header: "rule", sort: (r: any) => r.rule, cell: (r: any) => <span className="mono text-cyan-200">{r.rule}</span> },
        { key: "drift", header: "doctrine → measured", className: "wrap", cell: (r: any) => (
          <span className="text-[11px] text-slate-300">{(r.drifts ?? []).map((x: any) => `${x.fact}: ${show(x.doctrine)} → ${show(x.observed)}`).join("; ") || (r.unreported ?? []).map((x: any) => `${x.fact}: not reported`).join("; ") || "—"}</span>
        ) },
        { key: "seats", header: "seats", cell: (r: any) => <span className="text-[11px] text-slate-400">{r.seats ? Object.entries(r.seats).map(([k, v]) => `${k} ${v}`).join(" · ") : "—"}</span> },
        { key: "action", header: "to Cerebrum", cell: (r: any) => <span className="mono text-[11px] text-slate-400">{dash(r.action)}</span> },
      ]} />
      <DataTable dense rows={d.council?.proposals ?? []} rowKey={(p: any, i) => `${p.session_id}:${p.rule_id}:${i}`} maxHeight={220} empty="No proposal yet." columns={[
        { key: "when", header: "proposed", sort: (p: any) => Date.parse(p.created_at) || 0, cell: (p: any) => <span className="text-slate-500">{ago(p.created_at)}</span> },
        { key: "rule", header: "rule", cell: (p: any) => <span className="mono text-cyan-200">{p.rule_id}</span> },
        { key: "action", header: "action", cell: (p: any) => <span className="mono text-[11px]">{p.action}</span> },
        { key: "status", header: "Cerebrum", cell: (p: any) => <span className="text-[11px] text-slate-300">{dash(p.status)}{p.detail ? ` · ${p.detail}` : ""}</span> },
        { key: "id", header: "proposal", cell: (p: any) => <span className="mono text-[10px] text-slate-500">{dash(p.proposal_id)}</span> },
      ]} />
    </div>
  );
}

function Existing({ o }: { o: any }) {
  const canon = o?.canon;
  const items: any[] = o?.knowledge?.items ?? [];
  const counts: Record<string, number> = o?.knowledge?.counts ?? {};
  const weighting: any[] = o?.weighting ?? [];
  if (!canon) return <Empty>Aether returned no canon.</Empty>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="canon" value={dash(canon.version)} sub={`sha ${short(canon.content_sha256)}`} />
        <Stat label="indicator KB" value={canon.kb_version == null ? "—" : `v${canon.kb_version}`} sub={`sha ${short(canon.kb_content_sha256)}`} />
        <Stat label="doctrine rules" value={dash(canon.doctrine?.length)} />
        <Stat label="learned items approved" value={dash(counts.approved ?? (o?.knowledge ? 0 : null))} sub="the learned pack (shadow only)" />
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Canon files</h4>
          <ul className="space-y-1 text-[11px]">
            {(canon.file_list ?? []).map((f: any) => <li key={f.path} className="flex justify-between gap-2"><span className="mono text-slate-300">{f.path}</span><span className="mono text-slate-500">{short(f.sha256)}</span></li>)}
          </ul>
          <h4 className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Indicator KB</h4>
          <p className="text-[11px] text-slate-400">{dash(canon.kb?.status && words(canon.kb.status))} · lanes: {(canon.kb?.input_lanes ?? []).map(words).join(", ") || "—"}</p>
          <div className="mt-1 flex flex-wrap gap-1">{(canon.kb?.sections ?? []).map((k: string) => <Badge key={k} tone="slate">{words(k)}</Badge>)}</div>
          <h4 className="mb-1 mt-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Definitions</h4>
          <div className="flex flex-wrap gap-1">{(canon.definitions ?? []).map((k: string) => <Badge key={k} tone="slate">{words(k)}</Badge>)}</div>
        </div>
        <div>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Agent roles ({dash(canon.roles?.length)})</h4>
          <div className="flex max-h-48 flex-wrap gap-1 overflow-auto">{(canon.roles ?? []).map((r: any) => <span key={r.id} title={`${dash(r.kind)} · ${dash(r.family)}`}><Badge tone="purple">{dash(r.name ?? r.id)}</Badge></span>)}</div>
        </div>
      </div>
      <div>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Doctrine</h4>
        <DataTable dense rows={canon.doctrine ?? []} rowKey={(r: any) => r.id} maxHeight={300} empty="No doctrine rules." columns={[
          { key: "id", header: "rule", sort: (r: any) => r.id, cell: (r: any) => <span className="mono text-cyan-200">{r.id}</span> },
          { key: "class", header: "class", sort: (r: any) => r.class ?? "", cell: (r: any) => r.class ? <Badge tone={r.class === "constitutional" ? "amber" : "slate"}>{r.class}</Badge> : <span className="text-slate-600">—</span> },
          { key: "rule", header: "what it says", className: "wrap", cell: (r: any) => <span className="text-slate-300">{r.rule}</span> },
          { key: "amended", header: "amended", cell: (r: any) => r.amended ? <span className="text-[11px] text-emerald-300" title={r.amended.amendment_id}>by Cerebrum · {ago(r.amended.executed_at)}</span> : <span className="text-slate-600">—</span> },
          { key: "since", header: "since", sort: (r: any) => r.since ?? "", cell: (r: any) => <span className="text-slate-500">{dash(r.updated ?? r.since)}</span> },
        ]} />
      </div>
      <div>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Learned items in Aether</h4>
        <DataTable dense rows={items} rowKey={(i: any) => `${i.item_id}@${i.version}`} maxHeight={260} empty="Aether has not drafted a learned item yet: the rules above are still collecting." columns={[
          { key: "status", header: "status", sort: (i: any) => i.status, cell: (i: any) => <span className="inline-flex items-center gap-1.5"><Dot tone={tone(i.status)} />{i.status}</span> },
          { key: "item", header: "item", sort: (i: any) => i.item_id, cell: (i: any) => <span className="mono text-cyan-200">{i.item_id}@{i.version}</span> },
          { key: "kind", header: "kind", cell: (i: any) => <Badge tone="purple">{words(i.kind)}</Badge> },
          { key: "text", header: "what it says", className: "wrap", cell: (i: any) => <span className="text-slate-300">{dash(i.text)}</span> },
          { key: "when", header: "updated", sort: (i: any) => Date.parse(i.updated_at) || 0, cell: (i: any) => <span className="text-slate-500">{ago(i.updated_at)}</span> },
        ]} />
      </div>
      <div>
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">Active weighting per timeframe</h4>
        {!weighting.length ? <Empty>No weighting report has reached Aether yet.</Empty> : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {weighting.map((t: any) => (
              <div key={t.timeframe} className="glass-inner px-3 py-2.5 text-[11px]">
                <div className="mb-1 flex items-center justify-between"><span className="text-[12px] text-slate-200">{TF[t.timeframe] ?? dash(t.timeframe)}</span><span className="mono text-[10px] text-slate-500">{dash(t.active?.id)}</span></div>
                <ul className="space-y-0.5">
                  {(t.agents ?? []).slice(0, 6).map((a: any) => <li key={a.agent} className="flex justify-between gap-2"><span className="mono text-slate-400">{a.agent}</span><span className="mono text-slate-200">{num(a.weight) === null ? "—" : a.weight.toFixed(2)}</span></li>)}
                </ul>
                {!(t.agents ?? []).length && <span className="text-slate-500">—</span>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Item({ p }: { p: any }) {
  const item = p.item ?? {};
  const ev = item.evidence ?? {};
  return (
    <div className="mt-2 space-y-2 text-[11px]">
      <p className="text-[12px] leading-relaxed text-slate-200">{item.text}</p>
      <div className="flex flex-wrap gap-2">
        <Badge tone="slate">audience · {(item.audience?.agents ?? []).join(", ")}</Badge>
        {(item.audience?.charts ?? []).length > 0 && <Badge tone="slate">charts · {item.audience.charts.join(", ")}</Badge>}
        <Badge tone="slate">{item.provenance?.card_ids?.length ?? 0} decision cards cited</Badge>
      </div>
      <pre className="glass-inner mono max-h-40 overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-[10px] text-slate-400">{JSON.stringify(ev, null, 2)}</pre>
      {item.params && <pre className="glass-inner mono overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-[10px] text-slate-400">{JSON.stringify(item.params, null, 2)}</pre>}
    </div>
  );
}

export default function Knowledge() {
  const { who, act } = useSession();
  const { data, loading, error, refresh } = usePoll(() => call("kernel.knowledge", undefined, undefined, { limit: "100" }), 60_000);
  const rows = listOf(data, "proposals");
  const counts: Record<string, number> = data?.counts ?? {};
  const pending = rows.filter((p: any) => p.status === "pending");
  const reload = () => void refresh();
  const aether = usePoll(() => call("aether.overview"), 300_000);
  const o: any = aether.data;
  return (
    <div className="flex flex-col gap-3">
      <Panel title="Learned Knowledge · Aether" icon={<Sparkles className="h-3.5 w-3.5 text-violet-300" />} right={<Badge tone={pending.length ? "amber" : "slate"}>{pending.length} pending</Badge>}>
        <p className="text-[12px] leading-relaxed text-slate-400">
          Aether's curator and calibrator propose what they measured. Your approval only lets a proposal run in shadow on the XAUUSD rooms; it never changes a live agent. Promotion is a separate owner PR in the XAUUSD repository. Proposals expire after 14 days. Advisory only: no levels, sizes or orders.
        </p>
        <StatusBar className="mt-3" segments={[
          { key: "approved", label: "approved for shadow", value: counts.approved ?? 0, color: STATUS.good },
          { key: "pending", label: "pending", value: counts.pending ?? 0, color: STATUS.warning },
          { key: "rejected", label: "rejected", value: counts.rejected ?? 0, color: STATUS.serious },
          { key: "expired", label: "expired", value: counts.expired ?? 0, color: STATUS.neutral },
        ]} />
      </Panel>
      <Panel title="Learning progress · Aether" icon={<GraduationCap className="h-3.5 w-3.5 text-emerald-300" />} right={<Badge tone="slate">{o?.generated_at ? `read ${ago(o.generated_at)}` : "—"}</Badge>}>
        <p className="mb-3 text-[12px] leading-relaxed text-slate-400">
          What the decision cards hold against each rule's threshold. A rule drafts a proposal only when it is ready; the curator and the calibrator run once a day ({dash(o?.progress?.curation?.schedule_utc)} UTC).
        </p>
        {aether.loading && !o ? <Skeleton rows={6} /> : aether.error && !o ? <Empty>{aether.error}</Empty> : <Progress o={o} />}
      </Panel>
      <Panel title="Existing knowledge" icon={<Library className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone="slate">{o?.canon?.version ? `canon ${o.canon.version}` : "—"}</Badge>}>
        <p className="mb-3 text-[12px] leading-relaxed text-slate-400">
          The canon is the reviewed knowledge every agent works from; it changes only by a reviewed PR. Learned items are measured by Aether and are never canon.
        </p>
        {aether.loading && !o ? <Skeleton rows={6} /> : aether.error && !o ? <Empty>{aether.error}</Empty> : <Existing o={o} />}
      </Panel>
      <Panel title="Knowledge Council · doctrine" icon={<Scale className="h-3.5 w-3.5 text-amber-300" />} right={<Badge tone="slate">{o?.doctrine?.council?.schedule_utc ? `${o.doctrine.council.schedule_utc} UTC` : "—"}</Badge>}>
        <p className="mb-3 text-[12px] leading-relaxed text-slate-400">
          Once a day the Nexus, Omega and Aether seats compare the doctrine with what the running system reports. A difference every seat agrees on goes to the Cerebrum consensus: an operational fact inside its hard bound executes after the vote, a constitutional one after your approval on the Consensus page. Aether applies only what Cerebrum executed.
        </p>
        {aether.loading && !o ? <Skeleton rows={4} /> : aether.error && !o ? <Empty>{aether.error}</Empty> : <Council o={o} />}
      </Panel>
      <Panel title="Proposals" icon={<BookOpenCheck className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone="cyan">{rows.length}</Badge>}>
        {loading && !data ? <Skeleton rows={5} /> : error && !data ? <Empty>{error}</Empty> : (
          <DataTable rows={rows} rowKey={(p) => p.proposal_id} initialSort={{ key: "when", dir: "desc" }} maxHeight={560}
            footer={pending.length ? <span className="text-amber-300">open a pending row to review and decide</span> : null}
            empty="No proposals yet. Aether proposes once it has enough decision cards and outcomes." columns={[
              { key: "status", header: "status", sort: (p) => p.status, cell: (p) => <span className="inline-flex items-center gap-1.5"><Dot tone={tone(p.status)} pulse={p.status === "pending"} />{p.status}</span> },
              { key: "item", header: "item", sort: (p) => p.item_id, cell: (p) => <span className="mono text-cyan-200">{p.item_id}@{p.item_version}</span> },
              { key: "kind", header: "kind", sort: (p) => p.kind, cell: (p) => <span title={KIND_TEXT[p.kind] ?? ""}><Badge tone="purple">{String(p.kind).replace("_", " ")}</Badge></span> },
              { key: "text", header: "what it says", className: "wrap", cell: (p) => <span className="text-slate-300">{p.item?.text ?? "—"}</span> },
              { key: "proposer", header: "proposer", sort: (p) => p.proposer_agent_id, cell: (p) => <span className="mono text-[11px] text-slate-400">{p.proposer_agent_id}</span> },
              { key: "decided", header: "decided", sort: (p) => p.decided_by ?? "", cell: (p) => p.decided_by ? <span className="text-[11px] text-slate-400">{p.decided_by} · {ago(p.decided_at)}</span> : <span className="text-slate-600">—</span> },
              { key: "when", header: "proposed", sort: (p) => Date.parse(p.created_at) || 0, cell: (p) => <span className="text-slate-500" title={p.created_at}>{ago(p.created_at)}</span> },
            ]}
            expand={(p) => (
              <div>
                <p className="text-[11px] text-slate-400">{KIND_TEXT[p.kind] ?? ""}{p.reason ? ` · ${p.reason}` : ""}</p>
                <Item p={p} />
                {p.status === "pending" && (who.approver ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" className="btn btn-approve" onClick={() => act({ route: "kernel.knowledge_approve", params: p.proposal_id, body: { reason: "approved for shadow testing in the Console" },
                      title: `Approve ${p.item_id}@${p.item_version} for shadow testing`,
                      lines: ["Recorded under your Access identity in the audit chain.", "Aether exports it in the approved pack; the XAUUSD shadow arm tests it. No live agent changes.", "Promotion still needs your PR in the XAUUSD repository."],
                      done: "Approved for shadow testing.", after: reload })}><Check className="h-3.5 w-3.5" />Approve…</button>
                    <button type="button" className="btn btn-danger" onClick={() => act({ route: "kernel.knowledge_reject", params: p.proposal_id, body: { reason: "rejected in the Console" },
                      title: `Reject ${p.item_id}@${p.item_version}`, lines: ["The proposal is closed as rejected. Aether does not propose the same version again."],
                      done: "Rejected.", after: reload })}><X className="h-3.5 w-3.5" />Reject…</button>
                  </div>
                ) : <div className="mt-1 text-[11px] text-slate-500">Only an approver can decide.</div>)}
              </div>
            )} />
        )}
      </Panel>
    </div>
  );
}
