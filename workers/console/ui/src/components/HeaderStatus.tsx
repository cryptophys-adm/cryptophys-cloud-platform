import { useSyncExternalStore } from "react";
import clsx from "clsx";
import { useOverview } from "../lib/overview";
import { attentionCell, clockParts, driftCell, meshCell, observedCell, type Cell, type Tone } from "../lib/headerStatus";

/** Tone classes: cyan ok, amber late, red fault, grey off. Green stays for bullish only, so the header never uses it. */
const TEXT: Record<Tone, string> = { ok: "text-cyan-300", late: "text-amber-300", fault: "text-red-400", off: "text-slate-400" };
const DOT: Record<Tone, string> = { ok: "border-cyan-400 bg-cyan-400", late: "border-amber-400 bg-amber-400", fault: "border-red-500 bg-red-500", off: "border-slate-400 bg-transparent" };

function StatusDot({ tone }: { tone: Tone }) {
  return <span aria-hidden="true" className={clsx("inline-block h-[7px] w-[7px] shrink-0 rounded-full border-[1.5px]", DOT[tone])} />;
}

/** One clock for every status view: a single one-second interval while anything shows it. */
const listeners = new Set<() => void>();
let tick = Date.now();
let timer: number | undefined;
function subscribe(fn: () => void) {
  listeners.add(fn);
  if (timer === undefined) timer = window.setInterval(() => { tick = Date.now(); listeners.forEach((l) => l()); }, 1000);
  return () => { listeners.delete(fn); if (!listeners.size && timer !== undefined) { window.clearInterval(timer); timer = undefined; } };
}
function useNow(): number {
  return useSyncExternalStore(subscribe, () => tick);
}

function useCells(now: number): Cell[] {
  const { ov } = useOverview();
  return [meshCell(ov), attentionCell(ov), driftCell(ov), observedCell(ov, now)];
}

const divider = "border-l border-white/10";

/** Desktop: one strip of the status cells and the clock. */
export function StatusStrip() {
  const now = useNow();
  const cells = useCells(now);
  const c = clockParts(new Date(now));
  return (
    <div className="mono flex items-stretch overflow-hidden rounded-lg border border-white/10 text-[12px]" aria-label="Status">
      {cells.map((cell, i) => (
        <a key={cell.label} href={cell.href} title={cell.title} className={clsx("flex min-h-[40px] items-center gap-2 px-3 transition hover:bg-white/5 hover:text-white", i > 0 && divider)}>
          <span className="text-slate-400">{cell.label}</span>
          <StatusDot tone={cell.tone} />
          <span className={clsx("font-semibold", TEXT[cell.tone])}>{cell.code}</span>
          {cell.detail && <span className="text-slate-400">{cell.detail}</span>}
        </a>
      ))}
      <div className={clsx("flex min-h-[40px] items-center gap-2.5 px-3", divider)}>
        <span><span className="font-medium text-slate-100">{c.utc}</span> <span className="text-slate-400">UTC</span></span>
        <span><span className="text-slate-300">{c.local}</span> <span className="text-slate-400">{c.zone}</span></span>
      </div>
    </div>
  );
}

/** Phone: the same cells as a row that is always visible under the header, 44 px tall. */
export function StatusRow() {
  const now = useNow();
  const cells = useCells(now);
  const c = clockParts(new Date(now));
  return (
    <div className="mono grid grid-cols-5 border-t border-white/10 text-[11px] md:hidden" aria-label="Status">
      {cells.map((cell, i) => (
        <a key={cell.label} href={cell.href} title={`${cell.label}: ${cell.title}`} className={clsx("flex min-h-[44px] flex-col items-center justify-center gap-0.5", i > 0 && divider)}>
          <span className="text-[10px] text-slate-500">{cell.label}</span>
          <span className="flex items-center gap-1"><StatusDot tone={cell.tone} /><span className={clsx("font-semibold", TEXT[cell.tone])}>{cell.code}</span></span>
        </a>
      ))}
      <div className={clsx("flex min-h-[44px] flex-col items-center justify-center", divider)} title={`${c.utc} UTC, ${c.local} ${c.zone}`}>
        <span className="font-medium text-slate-100">{c.utcShort}Z</span>
        <span className="text-slate-400">{c.local}</span>
      </div>
    </div>
  );
}
