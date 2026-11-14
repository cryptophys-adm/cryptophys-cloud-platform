import { Activity, Eye, Radar } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "./ui";
import { DataTable, Legend, STATUS } from "./viz";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { ago } from "../lib/format";

/**
 * The account-wide Observer (owner 2026-11-14): vitals per organ, an anomaly timeline marked with deploys, and the
 * account inventory. Every value comes from GET /v1/observer on the Platform API (measured by the Cloudflare GraphQL
 * Analytics API); the one estimate (rows per request) is labelled so. A missing value is a dash.
 */
const pct = (v: unknown) => (typeof v === "number" ? `${(v * 100).toFixed(v < 0.01 ? 2 : 1)} %` : "—");
const msv = (v: unknown) => (typeof v === "number" ? `${v.toLocaleString("en-US", { maximumFractionDigits: 1 })} ms` : "—");
const int = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : "—");
const short = (s: string) => String(s).replace(/^cryptophys-/, "");

/** A single-series sparkline (the column header names it, so no legend); gaps where nothing was measured. */
function Spark({ points, label }: { points: Array<number | null>; label: string }) {
  const vals = points.filter((p): p is number => typeof p === "number");
  if (vals.length < 2) return <span className="text-[10px] text-slate-500">—</span>;
  const max = Math.max(...vals) || 1;
  const w = 96, h = 22, step = w / Math.max(points.length - 1, 1);
  const segs: string[] = [];
  let cur = "";
  points.forEach((p, i) => {
    if (typeof p !== "number") { if (cur) segs.push(cur); cur = ""; return; }
    cur += `${cur ? "L" : "M"}${(i * step).toFixed(1)},${(h - 2 - (p / max) * (h - 4)).toFixed(1)}`;
  });
  if (cur) segs.push(cur);
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${label}, last ${points.length} hours, peak ${max.toLocaleString("en-US")}`}>
      <title>{`${label}: peak ${max.toLocaleString("en-US")} over ${points.length} h`}</title>
      {segs.map((d, i) => <path key={i} d={d} fill="none" stroke={STATUS.info} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />)}
    </svg>
  );
}

/** Seven days on one axis: anomalies (dots) and deploys (ticks). Each mark has a native tooltip; the table below lists them. */
function Timeline({ anomalies, deploys, now }: { anomalies: any[]; deploys: any[]; now: number }) {
  const from = now - 7 * 86_400_000;
  const x = (iso: string) => Math.min(100, Math.max(0, ((Date.parse(iso) - from) / (now - from)) * 100));
  const days = Array.from({ length: 8 }, (_, i) => from + i * 86_400_000);
  return (
    <div>
      <Legend className="mb-2" items={[{ label: "anomaly or warning", color: STATUS.warning, value: anomalies.length }, { label: "deploy", color: STATUS.info, value: deploys.filter((d) => !d.rollback).length }, { label: "rollback", color: STATUS.serious, value: deploys.filter((d) => d.rollback).length }]} />
      <div className="relative h-12 w-full" role="img" aria-label="anomalies and deploys over the last 7 days">
        {days.map((d, i) => <span key={i} className="absolute top-1 bottom-1 w-px bg-[#262b33]" style={{ left: `${(i / 7) * 100}%` }} />)}
        <span className="absolute left-0 right-0 top-[30px] h-px bg-[#3a404a]" />
        {deploys.map((d, i) => (
          <span key={`d${i}`} title={`${d.rollback ? "rollback" : "deploy"} ${d.worker} → ${d.version} · ${d.deployed_at}`}
            className="absolute top-[22px] h-4 w-[2px] -translate-x-1/2 rounded-sm" style={{ left: `${x(d.deployed_at)}%`, background: d.rollback ? STATUS.serious : STATUS.info }} />
        ))}
        {anomalies.map((a, i) => (
          <span key={`a${i}`} title={`${a.worker} · ${a.metric} · ${a.detail}`}
            className="absolute top-[6px] h-2.5 w-2.5 -translate-x-1/2 rounded-full ring-2 ring-[#0d1117]" style={{ left: `${x(String(a.bucket ?? "").length > 10 ? a.bucket : a.created_at)}%`, background: STATUS.warning }} />
        ))}
      </div>
      <div className="mono flex justify-between text-[9px] text-slate-500"><span>7 d ago</span><span>now</span></div>
    </div>
  );
}

export default function ObserverVitals() {
  const { data, loading, error } = usePoll(() => call("platform.observer"), 300_000);
  const d: any = data ?? {};
  const organs: any[] = Array.isArray(d.organs) ? d.organs : [];
  const resources: any[] = Array.isArray(d.resources) ? d.resources : [];
  const anomalies: any[] = Array.isArray(d.anomalies) ? d.anomalies : [];
  const deploys: any[] = Array.isArray(d.deploys) ? d.deploys : [];
  const timed = anomalies.filter((a) => a.kind === "anomaly" || a.kind === "early_warning");
  const inventory: any[] = Array.isArray(d.last_inventory?.findings) ? d.last_inventory.findings : [];
  const datasets: Record<string, string> = d.last_senses?.datasets && typeof d.last_senses.datasets === "object" ? d.last_senses.datasets : {};
  const est = d.estimates?.rows_per_request;
  const now = typeof d.observed_at === "string" ? Date.parse(d.observed_at) : NaN;

  return (
    <Panel
      title="Observer · vitals per organ (all Workers on the account)"
      icon={<Radar className="h-3.5 w-3.5 text-cyan-300" />}
      right={
        <div className="flex flex-wrap justify-end gap-2">
          <Badge tone={d.configured ? "green" : "amber"}>{d.configured ? "measured · GraphQL Analytics" : loading && !data ? "loading" : "token not set"}</Badge>
          <Badge tone="slate">last hour {d.last_senses?.bucket ? String(d.last_senses.bucket).slice(11, 16) + " UTC" : "—"}</Badge>
        </div>
      }
    >
      {error && !data ? <Empty>Observer unavailable: {error}</Empty> : loading && !data ? <Skeleton rows={4} /> : (
        <div className="min-w-0 space-y-4">
          <p className="text-[11px] text-slate-400">
            Measured once an hour by the Platform API from the Cloudflare GraphQL Analytics API (cron {d.cron ?? "—"}). Error rate and CPU p99 are measured per Worker; D1 is measured per database, not per Worker, so rows per request is an estimate for the whole account.
          </p>
          {Object.keys(datasets).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(datasets).map(([k, v]) => <Badge key={k} tone={String(v).startsWith("ok") ? "green" : String(v) === "no_data" ? "slate" : "amber"}>{k} · {String(v).startsWith("error") ? "not readable" : String(v).replace("_", " ")}</Badge>)}
            </div>
          )}
          <DataTable rows={organs} rowKey={(o) => o.worker} initialSort={{ key: "rate", dir: "desc" }} maxHeight={360} dense
            empty="No vitals yet. The Observer records one row per Worker each hour once its token is set and its first run has finished."
            columns={[
              { key: "worker", header: "organ", sort: (o) => o.worker, cell: (o) => <span className="mono text-[11px] text-slate-200">{short(o.worker)}</span> },
              { key: "req", header: "requests (h)", align: "right", sort: (o) => o.measured?.requests, cell: (o) => <span className="mono">{int(o.measured?.requests)}</span> },
              { key: "rate", header: "error rate", align: "right", sort: (o) => o.measured?.error_rate, cell: (o) => <span className="mono">{pct(o.measured?.error_rate)}</span> },
              { key: "rate48", header: "error rate · 48 h", cell: (o) => <Spark label="error rate" points={(o.series ?? []).map((s: any) => s.error_rate)} /> },
              { key: "cpu", header: "CPU p99", align: "right", sort: (o) => o.measured?.cpu_p99_ms, cell: (o) => <span className="mono">{msv(o.measured?.cpu_p99_ms)}</span> },
              { key: "cpu48", header: "CPU p99 · 48 h", cell: (o) => <Spark label="CPU p99" points={(o.series ?? []).map((s: any) => s.cpu_p99_ms)} /> },
              { key: "exc", header: "exceptions", align: "right", sort: (o) => o.measured?.exceptions, cell: (o) => <span className="mono">{int(o.measured?.exceptions)}</span> },
            ]} />
          <div className="grid min-w-0 gap-4 lg:grid-cols-2">
            <div className="glass-inner min-w-0 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-white"><Activity className="h-3 w-3 text-violet-300" /> Storage and AI (measured per resource)</div>
              <DataTable rows={resources} rowKey={(r) => r.subject} dense maxHeight={240} empty="No D1, KV, Durable Object or AI data in the last 48 h." columns={[
                { key: "s", header: "resource", sort: (r) => r.subject, cell: (r) => <span className="mono text-[10px] break-all text-slate-300">{r.subject}</span> },
                { key: "v", header: "last hour", align: "right", cell: (r) => <span className="mono text-[11px]">{r.kind === "d1" ? `${int(r.measured?.rows_read)} rows read` : r.kind === "ai" ? `${int(r.measured?.neurons)} neurons` : `${int(r.measured?.requests)} ops`}</span> },
                { key: "q", header: "rows / query", align: "right", cell: (r) => <span className="mono text-[11px]">{r.kind === "d1" ? int(r.measured?.rows_per_query) : "—"}</span> },
                { key: "t", header: "48 h", cell: (r) => <Spark label={r.subject} points={(r.series ?? []).map((s: any) => s.value)} /> },
              ]} />
              <div className="mt-2 flex justify-between text-[11px] text-slate-400">
                <span>Rows read per request (account, estimated):</span>
                <span className="mono text-slate-200" title={est?.basis ?? ""}>{typeof est?.value === "number" ? est.value.toLocaleString("en-US") : "—"}{est ? " · estimated" : ""}</span>
              </div>
            </div>
            <div className="glass-inner min-w-0 p-3">
              <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-white"><Eye className="h-3 w-3 text-amber-300" /> Anomalies and deploys · 7 d</div>
              {Number.isNaN(now) ? <Empty>—</Empty> : <Timeline anomalies={timed} deploys={deploys} now={now} />}
            </div>
          </div>
          <DataTable rows={anomalies} rowKey={(a) => a.finding_id} initialSort={{ key: "when", dir: "desc" }} maxHeight={320} dense empty="No anomaly, warning or inventory finding in the last 7 days." columns={[
            { key: "worker", header: "subject", sort: (a) => a.worker, cell: (a) => <span className="mono text-[10px] break-all text-slate-300">{short(a.worker)}</span> },
            { key: "metric", header: "finding", sort: (a) => a.metric, cell: (a) => <Badge tone={a.severity === "warning" ? "amber" : "slate"}>{String(a.metric).replace(/_/g, " ")}</Badge> },
            { key: "value", header: "value / 7-day baseline", align: "right", cell: (a) => <span className="mono text-[11px]">{a.value ?? "—"} / {a.baseline_7d ?? "—"}{typeof a.z === "number" ? ` · z ${a.z}` : ""}</span> },
            { key: "deploy", header: "since deploy", cell: (a) => <span className="mono text-[10px] text-slate-400">{a.since_deploy ? `${a.since_deploy.version} · ${ago(a.since_deploy.deployed_at)}` : "—"}</span> },
            { key: "detail", header: "detail", className: "wrap", cell: (a) => <span className="text-[11px] text-slate-400">{a.detail}{a.report_only ? " (report only)" : ""}</span> },
            { key: "when", header: "when", sort: (a) => Date.parse(a.created_at) || 0, cell: (a) => <span className="text-slate-500">{ago(a.created_at)}</span> },
          ]} />
          <div className="text-[11px] text-slate-400">
            Inventory {d.last_inventory?.ran_at ? `· ${ago(d.last_inventory.ran_at)}` : "· —"}: {inventory.length ? `${inventory.length} finding(s)` : d.last_inventory ? "nothing undeclared, orphaned or idle" : "—"}
            {inventory.length > 0 && <ul className="mt-1 list-disc space-y-0.5 pl-4">{inventory.slice(0, 12).map((f, i) => <li key={i} className="break-words">{f.detail}</li>)}</ul>}
          </div>
        </div>
      )}
    </Panel>
  );
}
