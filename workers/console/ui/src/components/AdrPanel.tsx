import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, ScrollText } from "lucide-react";
import clsx from "clsx";
import { Badge, Empty, Panel, Skeleton } from "./ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import {
  ADR_PANEL_TITLE, ADR_POLL_MS, ADR_VIEW_SCHEMA, DRIFT_LABEL, MARK, MARK_LEGEND, MISSING, OUTSIDE_PLATFORM, OWNER_WAITING,
  evidenceLink, explanationSource, isDeferred, lastChange, outsideMain, ownerLink, phaseLabel, phaseMark, progressSegments,
  shown, staleLabel, statusLabel, statusTone, stewardLabel, stewardTone, utcMinute, type PhaseMark,
} from "../lib/adr";

// The ADR Steward's panel on the Vision page (docs/design/ADR-STEWARD.md §6, §11 row 5). Read-only: it reads
// GET /v1/adr (kernel.adr) every five minutes while the tab is visible, and the one open row's GET /v1/adr/{id}
// (kernel.adr_one) when it opens or its revision changes. Every number, state and label comes from those responses;
// a missing value is "—" (AGENTS.md: measured data only).

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const MARK_TONE: Record<PhaseMark, string> = { proven: "text-emerald-300", asserted: "text-amber-200", open: "text-slate-500" };

/** Proven solid, asserted hatched (§6.4): "done by document" never looks like "done by evidence". */
function ProgressBar({ e }: { e: any }) {
  const seg = progressSegments(e);
  if (!seg) return <span className="mono text-[12px] text-slate-500">{MISSING}</span>;
  return (
    <div className="flex min-w-0 items-center gap-2" aria-label={`${seg.percent}% lengkap, ${seg.proven}% terbukti, ${seg.asserted}% dinyatakan`}>
      <div className="flex h-2 w-24 shrink-0 overflow-hidden rounded-full bg-white/[0.06] sm:w-32">
        <div data-adr-seg="proven" className="h-full bg-emerald-400/80" style={{ width: `${seg.proven}%` }} />
        <div data-adr-seg="asserted" className="adr-hatch h-full" style={{ width: `${seg.asserted}%` }} />
      </div>
      <span className="mono whitespace-nowrap text-[12px] text-slate-200">{seg.percent}%</span>
      <span className="mono whitespace-nowrap text-[10px] text-slate-500">{seg.proven}% terbukti</span>
    </div>
  );
}

function OwnerActions({ actions }: { actions: any[] }) {
  if (actions.length === 0) return <span className="text-slate-500">{MISSING}</span>;
  return (
    <ul className="space-y-1">
      {actions.map((a, i) => {
        const link = ownerLink(a);
        return (
          <li key={i} className="break-words">
            <span className="text-slate-200">{shown(a?.text)}</span>
            <span className="text-slate-500"> · {OWNER_WAITING} → </span>
            {link ? <a className="text-cyan-300 hover:underline" href={link.href}>{link.label}</a>
              : a?.outside_platform === true ? <span className="text-amber-200">{OUTSIDE_PLATFORM}</span> : <span className="text-slate-500">{MISSING}</span>}
          </li>
        );
      })}
    </ul>
  );
}

function Refs({ refs }: { refs: unknown }) {
  const list = arr(refs).map(evidenceLink).filter((r): r is { text: string; href: string | null } => r !== null);
  if (list.length === 0) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {list.slice(0, 6).map((r, i) => r.href
        ? <a key={i} href={r.href} className="mono break-all rounded border border-white/10 px-1.5 text-[10px] text-cyan-300 hover:border-cyan-400/40">{r.text}</a>
        : <span key={i} className="mono break-all rounded border border-white/10 px-1.5 text-[10px] text-slate-400">{r.text}</span>)}
      {list.length > 6 && <span className="text-[10px] text-slate-500">+{list.length - 6}</span>}
    </span>
  );
}

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-3">
      <div className="text-[10px] uppercase tracking-widest text-slate-500">{label}</div>
      <div className="min-w-0 text-[12px] text-slate-300">{children}</div>
    </div>
  );
}

/** The open row: the phases from GET /v1/adr/{id}, the rest from the list entry. */
function AdrDetail({ e, id }: { e: any; id: string }) {
  const rev = typeof e?.revision === "number" ? e.revision : null;
  const { data, loading, error } = usePoll(() => call("kernel.adr_one", id), 0, [id, rev]);
  const d: any = data && data.adr === id ? data : null;
  const [phasesOpen, setPhasesOpen] = useState(false);
  const phases = arr(d?.phases);
  const blockers = d ? arr(d.blockers) : arr(e?.blockers);
  const explanation = d?.explanation ?? e?.explanation ?? null;
  const next = (d ?? e)?.next_step;
  return (
    <div className="mt-3 space-y-2.5 border-t border-white/5 pt-3" data-testid={`adr-detail-${id}`}>
      <Line label="Fase">
        {loading && !d ? <Skeleton rows={1} /> : error && !d ? <span className="text-rose-300">Dokumen ADR-{id} tidak dapat dibaca: {error}</span> : phases.length === 0 ? <span className="text-slate-500">{MISSING}</span> : (
          <div className="space-y-1.5">
            <button type="button" className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-left" aria-expanded={phasesOpen} onClick={() => setPhasesOpen((o) => !o)}>
              {phases.map((p) => (
                <span key={String(p?.id)} className="mono whitespace-nowrap text-[12px]">
                  <span className="text-slate-200">{shown(p?.id)}</span> <span className={MARK_TONE[phaseMark(p?.state)]}>{MARK[phaseMark(p?.state)]}</span>
                </span>
              ))}
              <span className="text-[10px] uppercase tracking-widest text-cyan-300">{phasesOpen ? "tutup" : "rincian"}</span>
            </button>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-500">
              {MARK_LEGEND.map(([m, label]) => <span key={m}><span className={MARK_TONE[m]}>{MARK[m]}</span> {label}</span>)}
            </div>
            {phasesOpen && (
              <ul className="space-y-1.5">
                {phases.map((p) => (
                  <li key={String(p?.id)} className="glass-inner p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="mono text-[12px] text-slate-100">{shown(p?.id)}</span>
                      <span className={clsx("text-[11px]", MARK_TONE[phaseMark(p?.state)])}>{MARK[phaseMark(p?.state)]} {phaseLabel(p?.state)}</span>
                      {p?.drift && <Badge tone="amber">{DRIFT_LABEL}</Badge>}
                    </div>
                    <div className="mt-0.5 break-words text-[12px] text-slate-300">{shown(p?.title)}</div>
                    {typeof p?.reason === "string" && p.reason && <div className="mt-0.5 break-words text-[11px] text-slate-500">{p.reason}</div>}
                    {typeof p?.earliest === "string" && <div className="mt-0.5 text-[11px] text-slate-500">paling cepat {utcMinute(p.earliest)}</div>}
                    <div className="mt-1"><Refs refs={p?.refs} /></div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Line>
      <Line label="Penghambat">
        {blockers.length === 0 ? <span className="text-slate-500">{MISSING}</span> : <ul className="list-disc space-y-0.5 pl-4">{blockers.map((b, i) => <li key={i} className="break-words">{String(b)}</li>)}</ul>}
      </Line>
      <Line label="Langkah berikutnya">{next ? <span className="break-words"><span className="mono text-slate-100">{shown(next.phase)}</span>: {shown(next.text)}</span> : <span className="text-slate-500">{MISSING}</span>}</Line>
      <Line label="Menunggu pemilik"><OwnerActions actions={arr((d ?? e)?.owner_actions)} /></Line>
      {(d?.stale === true || (!d && e?.stale === true)) && <Line label="Data"><span className="text-amber-200">{staleLabel(d?.stale_sources)}</span></Line>}
      {arr(d?.drift).length > 0 && <Line label={DRIFT_LABEL}>{arr(d.drift).map((x, i) => <div key={i} className="mono break-words text-[11px] text-amber-200">{shown(x?.phase)} · {shown(x?.kind)} · {shown(x?.doc_ref)}</div>)}</Line>}
      <Line label="Perubahan terakhir">
        <span className="mono">{lastChange(e)}</span>
        {arr(d?.history).length > 1 && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-slate-500">
            {arr(d.history).map((h) => <span key={String(h?.revision)} className="mono">rev {shown(h?.revision)} · {statusLabel({ status: h?.status })} · {typeof h?.percent === "number" ? `${h.percent}%` : MISSING}</span>)}
          </div>
        )}
      </Line>
      <Line label={`Penjelasan (${explanationSource(explanation)})`}>
        <p className="break-words leading-relaxed">{shown(explanation?.teks)}</p>
        <div className="mt-1"><Refs refs={explanation?.rujukan} /></div>
      </Line>
    </div>
  );
}

function AdrRow({ e, open }: { e: any; open: boolean }) {
  const id = String(e?.adr ?? "");
  const waiting = arr(e?.owner_actions).length;
  const drift = typeof e?.drift_count === "number" ? e.drift_count : null;
  return (
    <li id={`adr-${id}`} className={clsx("scroll-mt-4 rounded-xl border p-3", outsideMain(e) ? "border-dashed border-white/15 bg-transparent" : "border-white/5 bg-black/20", open && "border-cyan-400/25")}>
      <a href={open ? "#/vision/adr" : `#/vision/adr/${id}`} aria-expanded={open} className="block">
        <div className="flex flex-wrap items-center gap-2">
          {open ? <ChevronDown className="h-3.5 w-3.5 text-slate-500" /> : <ChevronRight className="h-3.5 w-3.5 text-slate-500" />}
          <span className="mono text-[13px] font-semibold text-cyan-200">{shown(e?.adr)}</span>
          <span className="min-w-0 break-words text-[13px] text-slate-100">{shown(e?.title)}</span>
          {isDeferred(e) && <Badge tone="amber">ditunda</Badge>}
          {drift !== null && drift > 0 && <Badge tone="amber">{DRIFT_LABEL} · {drift}</Badge>}
          {e?.stale === true && <Badge tone="amber">data lama</Badge>}
        </div>
        <div className="mt-2 grid gap-2 pl-5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1.2fr)] sm:items-center sm:gap-4">
          <div><Badge tone={statusTone(e)}>{statusLabel(e)}</Badge></div>
          <ProgressBar e={e} />
          <div className="min-w-0 break-words text-[12px] text-slate-400">
            <span className="text-[10px] uppercase tracking-widest text-slate-500">Berikutnya </span>
            {e?.next_step ? <><span className="mono text-slate-200">{shown(e.next_step.phase)}</span>: {shown(e.next_step.text)}</> : MISSING}
            {waiting > 0 && <span className="ml-2 text-amber-200">· {OWNER_WAITING}: {waiting}</span>}
          </div>
        </div>
      </a>
      {open && <AdrDetail e={e} id={id} />}
    </li>
  );
}

/** `focus`: the route is #/vision/adr (scroll here); `openId`: the row of #/vision/adr/<id>. */
export default function AdrPanel({ focus, openId }: { focus: boolean; openId: string | null }) {
  const { data, loading, error } = usePoll(() => call("kernel.adr"), ADR_POLL_MS);
  const ref = useRef<HTMLDivElement>(null);
  const loaded = data !== null;
  useEffect(() => {
    if (!focus || !loaded) return;
    const row = openId ? document.getElementById(`adr-${openId}`) : null;
    (row ?? ref.current)?.scrollIntoView({ block: "start" });
  }, [focus, openId, loaded]);

  const known = data?.schema === ADR_VIEW_SCHEMA;
  const steward = known ? data.steward ?? null : null;
  const adrs = known ? arr(data.adrs) : [];
  const status = steward?.status;
  const right = (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] uppercase tracking-widest text-slate-600">
      <span>baca-saja · dihitung dari bukti, bukan tebakan AI · diperbarui {utcMinute(steward?.last_pass_at)}</span>
      {known && <Badge tone={stewardTone(status)}>Steward: {stewardLabel(status)}</Badge>}
    </span>
  );
  let body;
  if (loading && !data) body = <Skeleton rows={3} />;
  else if (error && !data) body = <Empty>Data ADR tidak dapat dibaca: {error}</Empty>;
  else if (!known) body = <Empty>Respons GET /v1/adr tidak dikenali; tidak ada data ADR yang ditampilkan.</Empty>;
  else if (data.available === false) body = <Empty>Steward belum berjalan: data ADR belum tersedia (tabel adr_progress belum ada).</Empty>;
  else if (adrs.length === 0) body = <Empty>Belum ada pass Steward: belum ada dokumen ADR yang tersimpan.</Empty>;
  else body = <ul className="space-y-2">{adrs.map((e) => <AdrRow key={String(e?.adr)} e={e} open={openId === e?.adr} />)}</ul>;
  return (
    <div ref={ref} className="scroll-mt-4" data-testid="adr-panel">
      <Panel title={<span className="normal-case tracking-normal">{ADR_PANEL_TITLE}</span>} icon={<ScrollText className="h-3.5 w-3.5 text-cyan-300" />} right={right}>
        {known && status !== "enabled" && (
          <p className="mb-2 text-[12px] text-amber-200">
            Steward {stewardLabel(status)}: tidak ada pass baru{adrs.length > 0 ? `; yang tampil adalah dokumen tersimpan terakhir (pass terakhir ${utcMinute(steward?.last_pass_at)})` : ""}.
          </p>
        )}
        {error && data && <p className="mb-2 text-[11px] text-rose-300">Pembaruan terakhir gagal: {error}</p>}
        {body}
      </Panel>
    </div>
  );
}
