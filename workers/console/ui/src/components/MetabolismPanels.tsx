import { useState, type ReactNode } from "react";
import { Activity, Clock, Gauge, ShieldAlert, Timer } from "lucide-react";
import clsx from "clsx";
import { Badge, Empty, ErrorBox, Panel, Skeleton } from "./ui";
import { DataTable, HatchDef, Legend, STATUS, Sparkline, TipRow, axis, grid, niceMax, useHatchId, useTip, useWidth } from "./viz";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import {
  FOLD_TOP, GROUPS, MISSING, OTHER, TONE_COLOR, WINDOWS, bucketsOf, cells, count, cronCell, deployMarks, foldSeries, hourLabel, hourTitle, isNum, jobsOf,
  keyLabel, ms, noDataBuckets, rate, seriesOf, shareTone, sumOrNull, topKeys, totalsOf, type DeployMark, type Folded, type TelemetryGroup, type TelemetryWindow, type Tone,
} from "../lib/telemetry";

/**
 * The Organism page's Telemetry tab (frontend mockup 2026-11-22, owner approved): syscalls of the agents by agent or by
 * capability, their deny and fail rates and latency, and the kernel's cron runs, in hourly UTC buckets over 24 h or 7 days.
 * Two reads of GET /v1/telemetry (kernel.telemetry): the syscalls (group agent | capability) and the cron jobs
 * (group job), each with its own error box and Retry. Display only. Every number comes from those answers; a missing
 * value is "—" and an hour before the dataset's first point is hatched as "no data". Tokens and neurons are not shown.
 */

// Series identity (validated for colour-vision deficiency on #0d1117 with the dataviz validator, 2026-11-22): blue,
// magenta, violet, then the folded tail in neutral grey. None of them is a status colour (cyan ok, amber late, red fault).
const SERIES = ["#3987e5", "#d55181", "#9085e9"] as const;
const OTHER_COLOR = STATUS.neutral;
const LATENCY = TONE_COLOR.ok;

const colorOf = (f: Folded, i: number) => (f.folded.length ? OTHER_COLOR : SERIES[i] ?? OTHER_COLOR);

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">{label}</span>
      <div role="group" aria-label={label} className="inline-flex rounded-md border border-white/10 bg-black/20 p-0.5">
        {options.map((o) => (
          <button key={o} type="button" aria-pressed={o === value} onClick={() => onChange(o)}
            className={clsx("mono rounded-[5px] px-2.5 py-1 text-[11px] font-semibold transition", o === value ? "bg-cyan-400/15 text-cyan-200" : "text-slate-400 hover:text-slate-200")}>{o}</button>
        ))}
      </div>
    </div>
  );
}

function ToneDot({ tone }: { tone: Tone }) {
  return <span aria-hidden="true" className="inline-block h-[7px] w-[7px] shrink-0 rounded-full border-[1.5px]" style={{ borderColor: TONE_COLOR[tone], background: tone === "off" ? "transparent" : TONE_COLOR[tone] }} />;
}

function Tile({ label, value, sub, tone, spark }: { label: string; value: string; sub: ReactNode; tone: Tone; spark: ReactNode }) {
  return (
    <div className="glass-inner flex min-w-0 flex-col gap-1.5 px-3 py-2.5" data-telemetry-tile={label}>
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500"><ToneDot tone={tone} /><span className="truncate">{label}</span></div>
      <div className={clsx("mono text-[20px] font-bold leading-none", value === MISSING ? "text-slate-500" : "text-slate-100")}>{value}</div>
      <div className="text-[10px] text-slate-500">{sub}</div>
      <div className="h-[26px]">{spark}</div>
    </div>
  );
}

/** Stacked columns per hour, the hours before the first point hatched, a gap where no point, deploy markers on top. */
function StackedHours({ buckets, series, noData, deploys, week, height = 170 }: { buckets: string[]; series: { key: string; label: string; color: string; cells: Array<number | null> }[]; noData: number; deploys: DeployMark[]; week: boolean; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const tip = useTip();
  const hatch = useHatchId();
  const [hover, setHover] = useState<number | null>(null);
  const n = buckets.length;
  const totals = buckets.map((_, i) => sumOrNull(series.map((s) => s.cells[i])));
  const top = niceMax(Math.max(1, ...totals.map((t) => t ?? 0)));
  const padL = Math.max(28, String(top).length * 6 + 10), padB = 18, padT = 16;
  const plotW = Math.max(0, width - padL - 4), plotH = height - padB - padT;
  const slot = n ? plotW / n : 0;
  const barW = Math.max(1, Math.min(22, slot - (slot > 4 ? 2 : 1)));
  const y = (v: number) => padT + plotH - (v / top) * plotH;
  const every = week ? 24 : Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 52))));
  const showLabel = (i: number) => (week ? new Date(buckets[i]).getUTCHours() === 0 : i % every === 0);
  const tipFor = (i: number) => (
    <><div className="mb-0.5 text-slate-400">{hourTitle(buckets[i])} · {i < noData ? "no data" : totals[i] === null ? `no point (${MISSING})` : `${count(totals[i])} syscalls`}</div>
      {i >= noData && series.map((s) => <TipRow key={s.key} color={s.color} value={count(s.cells[i])} label={s.label} />)}</>
  );
  let lastLabelX = -Infinity;
  return (
    <div ref={ref} className="w-full">
      {width > 0 && n > 0 && (
        <svg width={width} height={height} data-series={series.length} role="img" aria-label="syscalls per hour, stacked by series, with deploy markers" onPointerLeave={() => { setHover(null); tip.hide(); }}>
          <HatchDef id={hatch} />
          {[0, top / 2, top].map((v) => (
            <g key={v}>
              <line x1={padL} x2={width - 2} y1={y(v)} y2={y(v)} stroke={v === 0 ? axis : grid} strokeWidth={1} />
              <text x={padL - 4} y={y(v) + 3} textAnchor="end" fontSize={9} fill="#7d8590" className="mono">{Number.isInteger(v) ? v.toLocaleString("en-US") : v.toFixed(1)}</text>
            </g>
          ))}
          {noData > 0 && (
            <g data-nodata="hours" data-nodata-count={noData}>
              <rect x={padL} y={padT} width={noData * slot} height={plotH} fill={`url(#${hatch})`} opacity={0.75} />
              {noData * slot > 54 && <text x={padL + (noData * slot) / 2} y={padT + plotH / 2} textAnchor="middle" fontSize={10} fill="#8b949e">no data</text>}
            </g>
          )}
          {buckets.map((b, i) => {
            const x = padL + i * slot + (slot - barW) / 2;
            let acc = 0;
            const segs = i < noData ? [] : series.filter((s) => (s.cells[i] ?? 0) > 0);
            return (
              <g key={b}>
                {hover === i && <rect x={padL + i * slot} y={padT} width={slot} height={plotH} fill="#ffffff" opacity={0.05} />}
                {segs.map((s, k) => {
                  const v = s.cells[i] ?? 0;
                  const y0 = y(acc), y1 = y(acc + v);
                  acc += v;
                  const h = Math.max(1, y0 - y1 - (k < segs.length - 1 && barW > 3 ? 2 : 0));
                  return <rect key={s.key} x={x} y={y0 - h} width={barW} height={h} rx={k === segs.length - 1 && barW > 6 ? 2 : 0} fill={s.color} />;
                })}
                <rect x={padL + i * slot} y={padT} width={slot} height={plotH + padB} fill="transparent" tabIndex={0}
                  onPointerMove={(e) => { setHover(i); tip.show(e, tipFor(i)); }} onFocus={(e) => { setHover(i); tip.showAt(e.currentTarget, tipFor(i)); }} onBlur={() => { setHover(null); tip.hide(); }} />
                {showLabel(i) && <text x={padL + i * slot + slot / 2} y={height - 4} textAnchor="middle" fontSize={9} fill="#7d8590" className="mono">{hourLabel(b, week)}</text>}
              </g>
            );
          })}
          {deploys.map((d) => {
            const x = padL + d.x * plotW;
            const label = x - lastLabelX > 56;
            if (label) lastLabelX = x;
            return (
              <g key={`${d.version}-${d.at}`} data-deploy={d.version}>
                <title>{`deploy ${d.version}${d.previous ? ` (after ${d.previous})` : ""} · first point ${d.at}`}</title>
                <line x1={x} x2={x} y1={padT - 2} y2={padT + plotH} stroke="#c9d1d9" strokeWidth={1} strokeDasharray="2 2" opacity={0.7} />
                {label && <text x={Math.min(Math.max(x, padL + 22), width - 24)} y={padT - 5} textAnchor="middle" fontSize={9} fill="#c9d1d9" className="mono">▾ {d.version.slice(0, 7)}</text>}
              </g>
            );
          })}
        </svg>
      )}
      {tip.node}
    </div>
  );
}

/** Two thin bars, deny rate (amber) over fail rate (red), on one scale shared by every row. */
function PairedBars({ deny, fail, max }: { deny: number | null; fail: number | null; max: number }) {
  const w = (v: number | null) => (isNum(v) && max > 0 ? `${Math.max(v > 0 ? 3 : 0, (v / max) * 100)}%` : "0%");
  return (
    <div className="flex w-32 flex-col gap-[3px]" title={`deny ${rate(deny)} · fail ${rate(fail)}`}>
      <div className="h-[6px] w-full rounded-[3px] bg-white/4"><div className="h-full rounded-r-[3px]" style={{ width: w(deny), background: TONE_COLOR.late }} /></div>
      <div className="h-[6px] w-full rounded-[3px] bg-white/4"><div className="h-full rounded-r-[3px]" style={{ width: w(fail), background: TONE_COLOR.fault }} /></div>
    </div>
  );
}

/** p50 to p95 on one ms scale shared by every row: a hollow dot at p50, a filled one at p95. "—" without either. */
function RangeBar({ p50, p95, max }: { p50: number | null; p95: number | null; max: number }) {
  const W = 104, H = 14;
  if (!isNum(p50) && !isNum(p95)) return <span className="text-[11px] text-slate-500">{MISSING}</span>;
  const x = (v: number) => 4 + (Math.min(v, max) / (max || 1)) * (W - 8);
  return (
    <svg width={W} height={H} role="img" aria-label={`p50 ${ms(p50)}, p95 ${ms(p95)}`}>
      <title>{`p50 ${ms(p50)} · p95 ${ms(p95)}`}</title>
      <line x1={4} x2={W - 4} y1={H / 2} y2={H / 2} stroke={grid} strokeWidth={1} />
      {isNum(p50) && isNum(p95) && <line x1={x(p50)} x2={x(p95)} y1={H / 2} y2={H / 2} stroke={LATENCY} strokeWidth={2} strokeLinecap="round" />}
      {isNum(p50) && <circle cx={x(p50)} cy={H / 2} r={3.5} fill="#0d1117" stroke={LATENCY} strokeWidth={1.5} />}
      {isNum(p95) && <circle cx={x(p95)} cy={H / 2} r={3.5} fill={LATENCY} stroke="#0d1117" strokeWidth={1.5} />}
    </svg>
  );
}

/** Failed cron runs per hour by job: red cells (darker = more failed), cyan where runs passed, hatched before the first point. */
function CronHeat({ jobs, buckets, noData, week }: { jobs: ReturnType<typeof jobsOf>; buckets: string[]; noData: number; week: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const tip = useTip();
  const hatch = useHatchId();
  const n = buckets.length;
  const labelW = 132, rowH = 16, padT = 2, padB = 16;
  const cellW = Math.max(3, n ? (Math.max(0, width - labelW - 4)) / n : 0);
  const svgW = labelW + cellW * n + 4;
  const height = padT + jobs.length * rowH + padB;
  const maxF = Math.max(1, ...jobs.flatMap((j) => j.failed_by_bucket.map((v) => v ?? 0)));
  const every = week ? 24 : Math.max(1, Math.ceil(n / Math.max(2, Math.floor((cellW * n) / 52))));
  return (
    <div ref={ref} className="w-full overflow-x-auto" style={{ overscrollBehavior: "contain" }}>
      {width > 0 && (
        <svg width={svgW} height={height} role="img" aria-label="failed cron runs per hour by job" onPointerLeave={tip.hide}>
          <HatchDef id={hatch} />
          {noData > 0 && <rect data-nodata="cron" data-nodata-count={noData} x={labelW} y={padT} width={noData * cellW} height={jobs.length * rowH} fill={`url(#${hatch})`} opacity={0.75} />}
          {jobs.map((j, r) => (
            <g key={j.subject}>
              <text x={labelW - 6} y={padT + r * rowH + rowH / 2 + 3} textAnchor="end" fontSize={10} fill="#c9d1d9" className="mono">{j.subject.length > 20 ? `${j.subject.slice(0, 19)}…` : j.subject}</text>
              {buckets.map((b, i) => {
                const state = cronCell(j.runs_by_bucket[i], j.failed_by_bucket[i], i < noData);
                if (state === "nodata") return null;
                const f = j.failed_by_bucket[i] ?? 0;
                const fill = state === "fault" ? TONE_COLOR.fault : state === "ok" ? TONE_COLOR.ok : "#161b22";
                const opacity = state === "fault" ? 0.45 + 0.55 * (f / maxF) : state === "ok" ? 0.28 : 1;
                const content = <><div className="mb-0.5 text-slate-400">{j.subject} · {hourTitle(b)}</div><TipRow color={TONE_COLOR.ok} value={count(j.runs_by_bucket[i])} label="runs" /><TipRow color={TONE_COLOR.fault} value={count(j.failed_by_bucket[i])} label="failed" /></>;
                return <rect key={b} data-cron={state} x={labelW + i * cellW + 0.5} y={padT + r * rowH + 1.5} width={Math.max(1, cellW - 1)} height={rowH - 3} rx={1.5} fill={fill} opacity={opacity}
                  onPointerMove={(e) => tip.show(e, content)} />;
              })}
            </g>
          ))}
          {buckets.map((b, i) => (week ? new Date(b).getUTCHours() === 0 : i % every === 0)
            ? <text key={b} x={labelW + i * cellW + cellW / 2} y={height - 4} textAnchor="middle" fontSize={9} fill="#7d8590" className="mono">{hourLabel(b, week)}</text> : null)}
        </svg>
      )}
      {tip.node}
    </div>
  );
}

function NotConfigured({ what }: { what: string }) {
  return (
    <div className="glass flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]" data-telemetry="not-configured">
      <ToneDot tone="off" />
      <span className="flex-1 text-slate-300">Telemetry is not configured: the kernel has no read token for its Analytics Engine datasets (secrets <span className="mono">AE_TELEMETRY_TOKEN</span>, <span className="mono">AE_TELEMETRY_ACCOUNT_ID</span>), so {what} are not measured. Nothing is shown in their place.</span>
      <Badge tone="slate">not configured</Badge>
    </div>
  );
}

export default function TelemetryPanels() {
  const [win, setWin] = useState<TelemetryWindow>("24h");
  const [group, setGroup] = useState<TelemetryGroup>("agent");
  // Two reads, so each can fail and be retried on its own.
  const sys = usePoll(() => call("kernel.telemetry", undefined, undefined, { window: win, group }), 60_000, [win, group]);
  const job = usePoll(() => call("kernel.telemetry", undefined, undefined, { window: win, group: "job" }), 60_000, [win]);
  // Only an answer for the selected window and group is drawn (a previous selection's answer is never relabelled).
  const s: any = sys.data && sys.data.window === win && sys.data.group === group ? sys.data : null;
  const j: any = job.data && job.data.window === win && job.data.group === "job" ? job.data : null;
  const week = win === "7d";

  const sb = bucketsOf(s), jb = bucketsOf(j);
  const sOn = s?.configured === true, jOn = j?.configured === true;
  const sNoData = sOn ? noDataBuckets(sb.buckets, s.first_point_at, sb.bucketMs) : 0;
  const jNoData = jOn ? noDataBuckets(jb.buckets, j.first_point_at, jb.bucketMs) : 0;
  const n = sb.buckets.length, jn = jb.buckets.length;
  const sum: any = sOn ? s.summary ?? {} : {};
  const byBucket: any = sOn ? s.summary_by_bucket ?? {} : {};
  const jsum: any = jOn ? j.summary ?? {} : {};
  const jByBucket: any = jOn ? j.summary_by_bucket ?? {} : {};
  const totals = sOn ? totalsOf(s) : [];
  const folded = sOn ? foldSeries(seriesOf(s, n), totals, group, n) : [];
  const top = topKeys(totals, group);
  const stack = folded.map((f, i) => ({ key: f.key, label: f.label, color: colorOf(f, i), cells: f.syscalls }));
  const swatch = (k: string) => { const i = top.indexOf(k); return i === -1 ? OTHER_COLOR : SERIES[i] ?? OTHER_COLOR; };
  const jobs = jOn ? jobsOf(j, jn) : [];
  const latP95 = cells(byBucket.latency_p95_ms, n);
  const lastHourP95 = n ? latP95[n - 1] : null;
  const maxRate = Math.max(0, ...totals.flatMap((t) => [t.deny_rate ?? 0, t.fail_rate ?? 0]));
  const maxLat = Math.max(0, ...totals.map((t) => t.latency_ms.p95 ?? t.latency_ms.p50 ?? 0));
  const maxDur = Math.max(0, ...jobs.map((x) => x.duration_ms.p95 ?? x.duration_ms.p50 ?? 0));
  const unconf = (d: any) => (d?.configured === false ? "not configured" : null);
  const sSub = (text: string) => unconf(s) ?? (s ? text : MISSING);
  const jSub = (text: string) => unconf(j) ?? (j ? text : MISSING);
  const keyCell = (k: string) => (
    <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: swatch(k) }} /><span className="mono text-slate-200">{keyLabel(k)}</span>{!top.includes(k) && <span className="text-[10px] text-slate-500">in {OTHER}</span>}</span>
  );

  return (
    <div className="flex flex-col gap-4" data-testid="telemetry-tab">
      <div className="glass p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 max-w-[720px]">
            <h1 className="text-lg font-bold text-white">Organism · telemetry</h1>
            <p className="mt-0.5 text-xs text-slate-400">
              The agents&apos; syscalls and the kernel&apos;s cron runs, read from the kernel&apos;s Analytics Engine datasets (GET /v1/telemetry): sampled, in hourly UTC buckets, display only. Every value comes from that answer; a missing one shows a dash, and hours before the first point are hatched as no data.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented label="window" value={win} options={WINDOWS} onChange={setWin} />
            <Segmented label="group" value={group} options={GROUPS} onChange={setGroup} />
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] uppercase tracking-widest text-slate-600">
          <span>first point · <span className="mono normal-case">{sOn && typeof s.first_point_at === "string" ? s.first_point_at : MISSING}</span></span>
          <span>generated · <span className="mono normal-case">{typeof s?.generated_at === "string" ? s.generated_at : MISSING}</span></span>
          <span>cached · <span className="mono normal-case">{isNum(s?.cache_s) ? `${s.cache_s} s` : MISSING}</span></span>
          <span>folded · top {FOLD_TOP[group]} {group === "agent" ? "agents" : "capabilities"}, the rest in {OTHER}</span>
        </div>
      </div>

      <ErrorBox error={sys.error} onRetry={() => void sys.refresh()} stale={Boolean(s)} />
      <ErrorBox error={job.error} onRetry={() => void job.refresh()} stale={Boolean(j)} />
      {s?.configured === false && <NotConfigured what="syscalls" />}
      {j?.configured === false && <NotConfigured what="cron runs" />}

      {/* 1. Five tiles with sparklines. */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Tile label="Syscalls" value={count(sum.syscalls)} tone={isNum(sum.syscalls) ? "ok" : "off"} sub={sSub(`last ${win}`)}
          spark={<Sparkline label="syscalls per hour" points={cells(byBucket.syscalls, n)} noData={sNoData} color={LATENCY} />} />
        <Tile label="Deny rate" value={rate(sum.deny_rate)} tone={shareTone(sum.deny_rate, "denied")} sub={sSub(`${count(sum.denied)} denied`)}
          spark={<Sparkline label="denied per hour" points={cells(byBucket.denied, n)} noData={sNoData} color={TONE_COLOR.late} />} />
        <Tile label="Fail rate" value={rate(sum.fail_rate)} tone={shareTone(sum.fail_rate, "failed")} sub={sSub(`${count(sum.failed)} failed`)}
          spark={<Sparkline label="failed per hour" points={cells(byBucket.failed, n)} noData={sNoData} color={TONE_COLOR.fault} />} />
        <Tile label="Syscall latency p95" value={ms(lastHourP95)} tone={isNum(lastHourP95) ? "ok" : "off"} sub={sSub(`last hour · ${win} p95 ${ms(sum.latency_ms?.p95)}`)}
          spark={<Sparkline label="latency p95 per hour" points={latP95} noData={sNoData} color={LATENCY} />} />
        <Tile label="Failed cron runs" value={count(jsum.failed)} tone={shareTone(jsum.failed, "failed")} sub={jSub(`of ${count(jsum.runs)} runs`)}
          spark={<Sparkline label="failed cron runs per hour" points={cells(jByBucket.failed, jn)} noData={jNoData} color={TONE_COLOR.fault} />} />
      </div>

      {/* 2. Syscalls per hour, stacked, with deploy markers. */}
      {s?.configured !== false && (
        <Panel title={`Syscalls per hour · by ${group} · ${win}`} icon={<Activity className="h-3.5 w-3.5 text-cyan-300" />}
          right={<span className="text-[10px] uppercase tracking-widest text-slate-600">▾ deploy_version</span>}>
          {!s ? (sys.loading ? <Skeleton rows={3} /> : <Empty>{MISSING}</Empty>) : stack.length === 0 ? (
            <><Empty>No syscall point in this window.</Empty>{sNoData > 0 && <StackedHours buckets={sb.buckets} series={[]} noData={sNoData} deploys={[]} week={week} height={90} />}</>
          ) : (
            <>
              <Legend className="mb-2" items={[...stack.map((x, i) => ({ label: x.label, color: x.color, value: count(folded[i].total) })), ...(sNoData ? [{ label: "no data", color: "#3a404a" }] : [])]} />
              <StackedHours buckets={sb.buckets} series={stack} noData={sNoData} deploys={deployMarks(s, sb.buckets, sb.bucketMs)} week={week} />
            </>
          )}
        </Panel>
      )}

      {s?.configured !== false && (
        <div className="grid gap-4 lg:grid-cols-2">
          {/* 3. Deny and fail rates, paired bars. */}
          <Panel title={`Deny and fail rate · by ${group}`} icon={<ShieldAlert className="h-3.5 w-3.5 text-amber-300" />}
            right={<Legend items={[{ label: "deny", color: TONE_COLOR.late }, { label: "fail", color: TONE_COLOR.fault }]} />}>
            {!s ? <Skeleton rows={3} /> : (
              <DataTable rows={totals} rowKey={(t) => t.key || "(none)"} dense maxHeight={320} empty="No syscall in this window." columns={[
                { key: "key", header: group, cell: (t) => keyCell(t.key) },
                { key: "syscalls", header: "syscalls", align: "right", sort: (t) => t.syscalls, cell: (t) => <span className="mono">{count(t.syscalls)}</span> },
                { key: "deny", header: "deny", align: "right", sort: (t) => t.deny_rate, cell: (t) => <span className="mono" title={`${count(t.denied)} denied`}>{rate(t.deny_rate)}</span> },
                { key: "fail", header: "fail", align: "right", sort: (t) => t.fail_rate, cell: (t) => <span className="mono" title={`${count(t.failed)} failed`}>{rate(t.fail_rate)}</span> },
                { key: "bars", header: "deny · fail", cell: (t) => <PairedBars deny={t.deny_rate} fail={t.fail_rate} max={maxRate} /> },
              ]} />
            )}
          </Panel>
          {/* 4. Syscall latency p50 to p95 per row. */}
          <Panel title={`Syscall latency p50–p95 · by ${group}`} icon={<Gauge className="h-3.5 w-3.5 text-cyan-300" />}
            right={<span className="text-[10px] uppercase tracking-widest text-slate-600">○ p50 · ● p95</span>}>
            {!s ? <Skeleton rows={3} /> : (
              <DataTable rows={totals} rowKey={(t) => t.key || "(none)"} dense maxHeight={320} empty="No syscall in this window." columns={[
                { key: "key", header: group, cell: (t) => keyCell(t.key) },
                { key: "p50", header: "p50", align: "right", sort: (t) => t.latency_ms.p50, cell: (t) => <span className="mono">{ms(t.latency_ms.p50)}</span> },
                { key: "p95", header: "p95", align: "right", sort: (t) => t.latency_ms.p95, cell: (t) => <span className="mono">{ms(t.latency_ms.p95)}</span> },
                { key: "range", header: `0 – ${ms(maxLat || null)}`, cell: (t) => <RangeBar p50={t.latency_ms.p50} p95={t.latency_ms.p95} max={maxLat} /> },
              ]} />
            )}
          </Panel>
        </div>
      )}

      {j?.configured !== false && (
        <div className="grid gap-4 xl:grid-cols-2">
          {/* 5. Cron duration p50 to p95 per job, in the kernel's job order. */}
          <Panel title={`Cron duration p50–p95 · ${win}`} icon={<Timer className="h-3.5 w-3.5 text-cyan-300" />}
            right={<Badge tone="slate">{j ? `${jobs.length} jobs` : MISSING}</Badge>}>
            {!j ? (job.loading ? <Skeleton rows={3} /> : <Empty>{MISSING}</Empty>) : (
              <DataTable rows={jobs} rowKey={(x) => x.subject} dense maxHeight={360} empty="No cron run in this window." columns={[
                { key: "job", header: "job", cell: (x) => <span className="mono text-slate-200">{x.subject}</span> },
                { key: "runs", header: "runs", align: "right", sort: (x) => x.runs, cell: (x) => <span className="mono">{count(x.runs)}</span> },
                { key: "failed", header: "failed", align: "right", sort: (x) => x.failed, cell: (x) => <span className={clsx("mono", isNum(x.failed) && x.failed > 0 && "text-red-400")}>{count(x.failed)}</span> },
                { key: "p50", header: "p50", align: "right", sort: (x) => x.duration_ms.p50, cell: (x) => <span className="mono">{ms(x.duration_ms.p50)}</span> },
                { key: "p95", header: "p95", align: "right", sort: (x) => x.duration_ms.p95, cell: (x) => <span className="mono">{ms(x.duration_ms.p95)}</span> },
                { key: "range", header: `0 – ${ms(maxDur || null)}`, cell: (x) => <RangeBar p50={x.duration_ms.p50} p95={x.duration_ms.p95} max={maxDur} /> },
              ]} />
            )}
          </Panel>
          {/* 6. Failed cron runs per hour by job, a heat grid. */}
          <Panel title={`Failed cron runs per hour · ${win}`} icon={<Clock className="h-3.5 w-3.5 text-red-400" />}
            right={<Legend items={[{ label: "failed", color: TONE_COLOR.fault }, { label: "ran, none failed", color: TONE_COLOR.ok }, { label: "no run", color: "#161b22" }, ...(jNoData ? [{ label: "no data", color: "#3a404a" }] : [])]} />}>
            {!j ? (job.loading ? <Skeleton rows={3} /> : <Empty>{MISSING}</Empty>) : jobs.length === 0 ? <Empty>No cron run in this window.</Empty> : (
              <CronHeat jobs={jobs} buckets={jb.buckets} noData={jNoData} week={week} />
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}

