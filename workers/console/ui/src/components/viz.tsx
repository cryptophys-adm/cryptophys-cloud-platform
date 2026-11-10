/**
 * Cerebrum visual kit (owner 2026-11-09: "more graph better than text, tables that are structural and
 * scroll"). Plain SVG/HTML, no chart library. Rules (dataviz method):
 *  - status colors are fixed and always ship with a label; the segment order below was validated for
 *    colour-vision deficiency on the Console surface (#0d1117): good, info, warning, owner, serious, critical;
 *  - categorical hues come in a fixed order (CATEGORICAL), never cycled; past eight, fold into "other";
 *  - thin marks, a 2px surface gap between touching segments, 4px rounded data ends;
 *  - text never wears a series colour; a swatch beside it carries identity;
 *  - every chart has a hover tooltip, and every value is also reachable as text (legend or table).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { ChevronDown, ChevronRight, ChevronsUpDown, ArrowDown, ArrowUp } from "lucide-react";

export const STATUS = {
  good: "#0ca30c", info: "#3987e5", warning: "#fab219", owner: "#9085e9", serious: "#ec835a", critical: "#d03b3b", neutral: "#6b6a65",
} as const;
export const CATEGORICAL = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"] as const;
const SURFACE = "#0d1117";
const GRID = "#262b33";
const AXIS = "#3a404a";

/* ------------------------------------------------------------------ tooltip */

interface TipState { x: number; y: number; content: ReactNode }
function useTip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const show = (e: { clientX: number; clientY: number }, content: ReactNode) => setTip({ x: e.clientX, y: e.clientY, content });
  const showAt = (el: Element, content: ReactNode) => { const r = el.getBoundingClientRect(); setTip({ x: r.left + r.width / 2, y: r.top, content }); };
  const hide = () => setTip(null);
  const node = tip ? (
    <div role="tooltip" className="pointer-events-none fixed z-50 max-w-[260px] rounded-lg border border-white/10 bg-[#0b0e14]/95 px-2.5 py-1.5 text-[11px] text-slate-300 shadow-xl"
      style={{ left: Math.min(tip.x + 12, window.innerWidth - 270), top: Math.max(tip.y - 12, 8), transform: "translateY(-100%)" }}>{tip.content}</div>
  ) : null;
  return { show, showAt, hide, node };
}
const TipRow = ({ color, value, label }: { color: string; value: ReactNode; label: ReactNode }) => (
  <div className="flex items-center gap-2"><span className="h-[2px] w-3 shrink-0 rounded" style={{ background: color }} /><b className="mono text-slate-100">{value}</b><span className="text-slate-400">{label}</span></div>
);

function useWidth<T extends HTMLElement>(): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/* ------------------------------------------------------------------ legend */

export interface Segment { key: string; label: string; value: number; color: string }

export function Legend({ items, className }: { items: { label: string; color: string; value?: ReactNode; dim?: boolean }[]; className?: string }) {
  return (
    <ul className={clsx("flex flex-wrap gap-x-4 gap-y-1 text-[11px]", className)}>
      {items.map((i) => (
        <li key={i.label} className={clsx("flex items-center gap-1.5", i.dim && "opacity-50")}>
          <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: i.color }} />
          <span className="text-slate-400">{i.label}</span>
          {i.value !== undefined && <span className="mono text-slate-200">{i.value}</span>}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ stacked status bar */

/** One bar split by status: how a whole divides (e.g. proposals by outcome). Legend carries every value. */
export function StatusBar({ segments, height = 12, unit = "", legend = true, className }: { segments: Segment[]; height?: number; unit?: string; legend?: boolean; className?: string }) {
  const tip = useTip();
  const total = segments.reduce((n, s) => n + Math.max(0, s.value), 0);
  const shown = segments.filter((s) => s.value > 0);
  return (
    <div className={className}>
      <div className="flex w-full gap-[2px] overflow-hidden rounded-[4px] bg-white/[0.04]" style={{ height }} role="img"
        aria-label={segments.map((s) => `${s.label} ${s.value}`).join(", ")}>
        {total === 0 ? null : shown.map((s) => (
          <div key={s.key} tabIndex={0} className="h-full outline-none transition-[filter] hover:brightness-125 focus-visible:brightness-125"
            style={{ width: `${(s.value / total) * 100}%`, minWidth: 3, background: s.color }}
            onPointerMove={(e) => tip.show(e, <TipRow color={s.color} value={`${s.value}${unit}`} label={`${s.label} · ${Math.round((s.value / total) * 100)}%`} />)}
            onPointerLeave={tip.hide} onFocus={(e) => tip.showAt(e.currentTarget, <TipRow color={s.color} value={`${s.value}${unit}`} label={s.label} />)} onBlur={tip.hide} />
        ))}
      </div>
      {legend && <Legend className="mt-2" items={segments.map((s) => ({ label: s.label, color: s.color, value: s.value, dim: s.value === 0 }))} />}
      {tip.node}
    </div>
  );
}

/* ------------------------------------------------------------------ bar list */

export interface BarItem { label: string; value: number; parts?: Segment[]; href?: string; sub?: string }

/**
 * Horizontal bars sorted by size: magnitude per category (events per type, agents per host).
 * With `parts` each bar is stacked; pass `series` so the legend names them.
 */
export function BarList({ items, max = 10, color = STATUS.info, series, unit = "", empty = "No data.", keepOrder = false }: { items: BarItem[]; max?: number; color?: string; series?: { label: string; color: string }[]; unit?: string; empty?: string; keepOrder?: boolean }) {
  const tip = useTip();
  const sorted = keepOrder ? [...items] : [...items].sort((a, b) => b.value - a.value);
  const head = sorted.slice(0, max);
  const rest = sorted.slice(max);
  if (rest.length) head.push({ label: `other (${rest.length})`, value: rest.reduce((n, i) => n + i.value, 0) });
  const top = Math.max(1, ...head.map((i) => i.value));
  if (!head.length) return <p className="py-2 text-[12px] text-slate-500">{empty}</p>;
  return (
    <div>
      {series && series.length > 1 && <Legend className="mb-2" items={series} />}
      <ul className="space-y-1.5">
        {head.map((i) => {
          const parts = i.parts?.filter((p) => p.value > 0) ?? [{ key: "v", label: i.label, value: i.value, color }];
          const label = i.href ? <a href={i.href} className="hover:text-cyan-200 hover:underline">{i.label}</a> : i.label;
          return (
            <li key={i.label} className="grid grid-cols-[minmax(0,38%)_1fr_auto] items-center gap-2 text-[11px]">
              <span className="mono truncate text-slate-300" title={i.label}>{label}</span>
              <div className="flex h-[10px] gap-[2px]" style={{ width: `${Math.max(2, (i.value / top) * 100)}%` }}>
                {parts.map((p, k) => (
                  <div key={p.key} tabIndex={0} className={clsx("h-full outline-none hover:brightness-125 focus-visible:brightness-125", k === parts.length - 1 && "rounded-r-[4px]")}
                    style={{ flexGrow: p.value, flexBasis: 0, minWidth: 2, background: p.color }}
                    onPointerMove={(e) => tip.show(e, <><div className="mb-0.5 text-slate-400">{i.label}</div>{parts.map((q) => <TipRow key={q.key} color={q.color} value={`${q.value}${unit}`} label={q.label} />)}</>)}
                    onPointerLeave={tip.hide} onFocus={(e) => tip.showAt(e.currentTarget, <TipRow color={p.color} value={`${p.value}${unit}`} label={`${i.label} · ${p.label}`} />)} onBlur={tip.hide} />
                ))}
              </div>
              <span className="mono text-right text-slate-200">{i.value}{unit}{i.sub ? <span className="ml-1 text-slate-500">{i.sub}</span> : null}</span>
            </li>
          );
        })}
      </ul>
      {tip.node}
    </div>
  );
}

/* ------------------------------------------------------------------ activity over time */

const BINS = [15 * 60_000, 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 86_400_000];
export interface Bucket { start: number; counts: Record<string, number>; total: number }

/** Bin rows by time (span from the oldest row to now, at most ~`target` bins of a clean size). */
export function bucketize<T>(rows: T[], time: (r: T) => string | number | null | undefined, key: (r: T) => string, target = 24, now = Date.now()): { buckets: Bucket[]; bin: number } {
  const ts = rows.map((r) => { const t = time(r); return typeof t === "number" ? t : t ? Date.parse(t) : NaN; });
  const valid = ts.filter((t) => Number.isFinite(t));
  if (!valid.length) return { buckets: [], bin: 3_600_000 };
  const span = Math.max(now - Math.min(...valid), 3_600_000);
  const bin = BINS.find((b) => span / b <= target) ?? 86_400_000;
  const end = Math.ceil(now / bin) * bin;
  const n = Math.min(Math.ceil(span / bin) + 1, target + 1);
  const start = end - n * bin;
  const buckets: Bucket[] = Array.from({ length: n }, (_, i) => ({ start: start + i * bin, counts: {}, total: 0 }));
  rows.forEach((r, i) => {
    const t = ts[i];
    if (!Number.isFinite(t) || t < start) return;
    const b = buckets[Math.min(n - 1, Math.floor((t - start) / bin))];
    const k = key(r);
    b.counts[k] = (b.counts[k] ?? 0) + 1;
    b.total += 1;
  });
  return { buckets, bin };
}

const niceMax = (v: number) => { if (v <= 4) return Math.max(1, v); const p = 10 ** Math.floor(Math.log10(v)); const m = v / p; return (m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };
const fmtBin = (t: number, bin: number) => {
  const d = new Date(t);
  const hh = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return bin >= 86_400_000 ? `${d.getUTCDate()}/${d.getUTCMonth() + 1}` : bin >= 6 * 3_600_000 ? `${d.getUTCDate()}/${d.getUTCMonth() + 1} ${hh}` : hh;
};

/** Stacked columns over time (UTC): when things happened, split by series. Hover a column for every series. */
export function ActivityChart({ buckets, bin, series, height = 120, caption }: { buckets: Bucket[]; bin: number; series: { key: string; label: string; color: string }[]; height?: number; caption?: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const tip = useTip();
  const [hover, setHover] = useState<number | null>(null);
  const top = niceMax(Math.max(1, ...buckets.map((b) => b.total)));
  const padL = Math.max(26, String(top).length * 6 + 10), padB = 18, padT = 6;
  const plotW = Math.max(0, width - padL - 4);
  const plotH = height - padB - padT;
  const slot = buckets.length ? plotW / buckets.length : 0;
  const barW = Math.max(2, Math.min(24, slot - 2));
  const y = (v: number) => padT + plotH - (v / top) * plotH;
  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(2, Math.floor(plotW / 56))));
  const present = series.filter((s) => buckets.some((b) => (b.counts[s.key] ?? 0) > 0));
  const shownSeries = present.length ? present : series;
  return (
    <div ref={ref} className="w-full">
      {shownSeries.length > 1 && <Legend className="mb-2" items={shownSeries.map((s) => ({ label: s.label, color: s.color, value: buckets.reduce((n, b) => n + (b.counts[s.key] ?? 0), 0) }))} />}
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={caption ?? "activity over time"} onPointerLeave={() => { setHover(null); tip.hide(); }}>
          {[0, top / 2, top].map((v) => (
            <g key={v}>
              <line x1={padL} x2={width - 2} y1={y(v)} y2={y(v)} stroke={v === 0 ? AXIS : GRID} strokeWidth={1} />
              <text x={padL - 4} y={y(v) + 3} textAnchor="end" fontSize={9} fill="#7d8590" className="mono">{Number.isInteger(v) ? v.toLocaleString("en-US") : v.toFixed(1)}</text>
            </g>
          ))}
          {buckets.map((b, i) => {
            const x = padL + i * slot + (slot - barW) / 2;
            let acc = 0;
            const segs = shownSeries.filter((s) => (b.counts[s.key] ?? 0) > 0);
            return (
              <g key={b.start}>
                {hover === i && <rect x={padL + i * slot} y={padT} width={slot} height={plotH} fill="#ffffff" opacity={0.04} />}
                {segs.map((s, k) => {
                  const v = b.counts[s.key] ?? 0;
                  const y0 = y(acc), y1 = y(acc + v);
                  acc += v;
                  const h = Math.max(1, y0 - y1 - (k < segs.length - 1 ? 2 : 0));
                  const isTop = k === segs.length - 1;
                  return isTop
                    ? <path key={s.key} d={`M${x},${y1 + h} V${y1 + Math.min(4, h / 2)} Q${x},${y1} ${x + Math.min(4, barW / 2)},${y1} H${x + barW - Math.min(4, barW / 2)} Q${x + barW},${y1} ${x + barW},${y1 + Math.min(4, h / 2)} V${y1 + h} Z`} fill={s.color} />
                    : <rect key={s.key} x={x} y={y0 - h} width={barW} height={h} fill={s.color} />;
                })}
                <rect x={padL + i * slot} y={padT} width={slot} height={plotH + padB} fill="transparent" tabIndex={0}
                  onPointerMove={(e) => { setHover(i); tip.show(e, <><div className="mb-0.5 text-slate-400">{fmtBin(b.start, bin)} UTC · {b.total} total</div>{shownSeries.map((s) => <TipRow key={s.key} color={s.color} value={b.counts[s.key] ?? 0} label={s.label} />)}</>); }}
                  onFocus={(e) => { setHover(i); tip.showAt(e.currentTarget, <><div className="mb-0.5 text-slate-400">{fmtBin(b.start, bin)} UTC · {b.total} total</div>{shownSeries.map((s) => <TipRow key={s.key} color={s.color} value={b.counts[s.key] ?? 0} label={s.label} />)}</>); }}
                  onBlur={() => { setHover(null); tip.hide(); }} />
                {i % labelEvery === 0 && <text x={padL + i * slot + slot / 2} y={height - 4} textAnchor="middle" fontSize={9} fill="#7d8590" className="mono">{fmtBin(b.start, bin)}</text>}
              </g>
            );
          })}
        </svg>
      )}
      {tip.node}
    </div>
  );
}

/* ------------------------------------------------------------------ meter */

/** Progress toward a target (e.g. parity runs in a row). */
export function Meter({ value, target, label, color = STATUS.info }: { value: number; target: number; label: string; color?: string }) {
  const pct = target > 0 ? Math.min(100, Math.round((value / target) * 100)) : 0;
  const done = value >= target;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[11px]"><span className="text-slate-400">{label}</span><span className="mono text-slate-100">{value}/{target}{done ? " ✓" : ""}</span></div>
      <div className="h-2 w-full overflow-hidden rounded-[4px] bg-white/[0.05]" role="progressbar" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={target}>
        <div className="h-full rounded-r-[4px]" style={{ width: `${Math.max(pct, value > 0 ? 2 : 0)}%`, background: done ? STATUS.good : color }} />
      </div>
    </div>
  );
}

/** Votes of one proposal as a tiny segmented bar (approve, reject, abstain) plus the count. */
export function VoteBar({ approvals, rejections, eligible }: { approvals: number; rejections: number; eligible: number }) {
  const a = Math.max(0, approvals || 0), r = Math.max(0, rejections || 0), e = Math.max(a + r, eligible || 0), x = e - a - r;
  return (
    <span className="inline-flex items-center gap-2" title={`${a} approve · ${r} reject · ${x} abstain of ${e}`}>
      <span className="flex h-2 w-16 gap-[2px] overflow-hidden rounded-[3px] bg-white/[0.05]">
        {a > 0 && <span style={{ flexGrow: a, background: STATUS.good }} />}
        {r > 0 && <span style={{ flexGrow: r, background: STATUS.critical }} />}
        {x > 0 && <span style={{ flexGrow: x, background: STATUS.neutral }} />}
      </span>
      <span className="mono text-[11px] text-slate-300">{a}/{e}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ data table */

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Sort value; omit for an unsortable column. */
  sort?: (row: T) => string | number | null | undefined;
  align?: "left" | "right";
  className?: string;
}

/**
 * Structured, scrollable table: sticky header, sortable columns, optional expandable rows, a row
 * count, and scrolling inside the panel (never the page).
 */
export function DataTable<T>({ rows, columns, rowKey, onRowClick, expand, maxHeight = 440, empty = "Nothing to show.", initialSort, footer, dense }: {
  rows: T[]; columns: Column<T>[]; rowKey: (row: T, i: number) => string; onRowClick?: (row: T) => void; expand?: (row: T) => ReactNode;
  maxHeight?: number; empty?: ReactNode; initialSort?: { key: string; dir: "asc" | "desc" }; footer?: ReactNode; dense?: boolean;
}) {
  const [sort, setSort] = useState(initialSort ?? null);
  const [open, setOpen] = useState<string | null>(null);
  const sorted = useMemo(() => {
    const col = sort && columns.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const val = col.sort;
    const dir = sort!.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }, [rows, columns, sort]);
  if (!rows.length) return <p className="py-3 text-[12px] text-slate-500">{empty}</p>;
  const span = columns.length + (expand ? 1 : 0);
  return (
    <div>
      <div className="table-scroll" style={{ maxHeight }}>
        <table className={clsx("tbl", dense && "tbl-dense")}>
          <thead>
            <tr>
              {expand && <th className="w-6" aria-label="details" />}
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th key={c.key} className={clsx(c.align === "right" && "text-right", c.className)} aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}>
                    {c.sort ? (
                      <button type="button" className={clsx("inline-flex items-center gap-1 uppercase tracking-[0.18em] hover:text-slate-300", active && "text-slate-300")}
                        onClick={() => setSort(active && sort!.dir === "desc" ? { key: c.key, dir: "asc" } : { key: c.key, dir: "desc" })}>
                        {c.header}{active ? (sort!.dir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ChevronsUpDown className="h-3 w-3 opacity-40" />}
                      </button>
                    ) : c.header}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r, i) => {
              const k = rowKey(r, i);
              const isOpen = open === k;
              return [
                <tr key={k} className={clsx((onRowClick || expand) && "cursor-pointer", isOpen && "is-open")}
                  onClick={() => (expand ? setOpen(isOpen ? null : k) : onRowClick?.(r))}>
                  {expand && (
                    <td className="w-6 !pr-0">
                      <button type="button" aria-expanded={isOpen} aria-label={isOpen ? "Hide details" : "Show details"} className="text-slate-500 hover:text-cyan-300"
                        onClick={(e) => { e.stopPropagation(); setOpen(isOpen ? null : k); }}>
                        {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      </button>
                    </td>
                  )}
                  {columns.map((c) => <td key={c.key} className={clsx(c.align === "right" && "text-right", c.className)}>{c.cell(r)}</td>)}
                </tr>,
                isOpen && expand ? <tr key={`${k}:x`} className="is-detail"><td colSpan={span} onClick={(e) => e.stopPropagation()}>{expand(r)}</td></tr> : null,
              ];
            })}
          </tbody>
        </table>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[10px] uppercase tracking-widest text-slate-600">
        <span>{rows.length} row{rows.length === 1 ? "" : "s"}{sort ? ` · sorted by ${String(columns.find((c) => c.key === sort.key)?.key ?? "")}` : ""}</span>
        {footer}
      </div>
    </div>
  );
}

/** A labelled stat with a big number: for a single headline value, not a chart. */
export function Stat({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: keyof typeof STATUS }) {
  return (
    <div className="glass-inner px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
        {tone && <span className="h-2 w-2 rounded-full" style={{ background: STATUS[tone] }} />}{label}
      </div>
      <div className="mono mt-1 text-[20px] font-bold leading-none text-slate-100">{value}</div>
      {sub && <div className="mt-1 text-[10px] text-slate-500">{sub}</div>}
    </div>
  );
}

export const surface = SURFACE;
