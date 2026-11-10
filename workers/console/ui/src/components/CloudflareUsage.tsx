import { Cloud, KeyRound } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "./ui";
import { ActivityChart, BarList, DataTable, STATUS, type Bucket } from "./viz";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { ago } from "../lib/format";

/**
 * Real Cloudflare usage against the Workers Free limits (owner 2026-11-10). Data comes from
 * GET /v1/usage on the Platform API, which reads the GraphQL Analytics API with an owner-created,
 * read-only token. A metric that cannot be read shows its error, never a number.
 */
const fmt = (v: number) => v.toLocaleString("en-US");
const tone = (pct: number | null) => (pct === null ? STATUS.neutral : pct >= 100 ? STATUS.critical : pct >= 80 ? STATUS.warning : STATUS.good);

function MetricRow({ m }: { m: any }) {
  const pct = typeof m.pct === "number" ? m.pct : null;
  return (
    <div className="glass-inner space-y-1.5 p-3">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="font-semibold text-slate-200">{m.label}</span>
        <span className="mono text-slate-300">{pct === null ? "—" : `${pct}%`}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-[4px] bg-white/[0.05]" role="progressbar" aria-label={m.label} aria-valuenow={m.today ?? undefined} aria-valuemin={0} aria-valuemax={m.limit}>
        {pct !== null && <div className="h-full rounded-r-[4px]" style={{ width: `${Math.min(100, Math.max(pct, m.today > 0 ? 1 : 0))}%`, background: tone(pct) }} />}
      </div>
      {m.error ? (
        <div className="break-words text-[10px] text-amber-300">not readable: {m.error}</div>
      ) : (
        <div className="mono text-[10px] text-slate-500">{fmt(m.today)} / {fmt(m.limit)} {m.unit} per {m.limit ? "day" : ""}</div>
      )}
    </div>
  );
}

export default function CloudflareUsage() {
  const { data, loading, error } = usePoll(() => call("platform.usage"), 300_000);
  const d: any = data ?? {};
  const metrics: any[] = Array.isArray(d.metrics) ? d.metrics : [];
  const workers = metrics.find((m) => m.key === "workers_requests");
  const buckets: Bucket[] = (workers?.history ?? []).map((h: any) => ({ start: Date.parse(`${h.date}T00:00:00Z`), counts: { req: h.value }, total: h.value }));
  return (
    <Panel title="Cloudflare usage · Workers Free limits" icon={<Cloud className="h-3.5 w-3.5 text-cyan-300" />}
      right={<div className="flex flex-wrap justify-end gap-2">
        <Badge tone={d.configured ? "green" : "amber"}>{d.configured ? "live from Cloudflare" : loading && !data ? "loading" : "token not set"}</Badge>
        {d.observed_at && <Badge tone="slate">{d.cached ? "cached · " : ""}{ago(d.observed_at)}</Badge>}
      </div>}>
      {loading && !data ? <Skeleton rows={3} /> : error && !data ? <Empty>The usage endpoint is not available yet: {error}</Empty> : !d.configured ? (
        <div className="space-y-3 text-[12px]">
          <div className="flex items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-amber-100">
            <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{d.setup ?? "The owner sets a read-only analytics token on cryptophys-platform-api."} Until then no Cloudflare number is shown here.</span>
          </div>
          {d.platform && (
            <div>
              <div className="mb-1.5 text-[10px] uppercase tracking-widest text-slate-500">Measured by the platform itself · AI requests today (cap 250/day across services)</div>
              <BarList items={(d.platform.ai_requests_by_service ?? []).map((r: any) => ({ label: String(r.service_id).replace(/^cryptophys-/, ""), value: Number(r.requests ?? 0) }))} empty="No AI request today." />
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {metrics.map((m) => <MetricRow key={m.key} m={m} />)}
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <div className="mb-1.5 text-[10px] uppercase tracking-widest text-slate-500">Workers requests per day · 7 days (UTC)</div>
              {buckets.length ? <ActivityChart buckets={buckets} bin={86_400_000} series={[{ key: "req", label: "requests", color: STATUS.info }]} height={110} caption="Workers requests per day" /> : <Empty>{workers?.error ?? "No data."}</Empty>}
            </div>
            <div>
              <div className="mb-1.5 text-[10px] uppercase tracking-widest text-slate-500">Requests today per Worker{typeof d.workers_errors_today === "number" ? ` · ${d.workers_errors_today} errors` : ""}</div>
              <DataTable rows={d.workers_today ?? []} rowKey={(r: any) => r.script} maxHeight={220} dense empty="No request recorded today." columns={[
                { key: "script", header: "Worker", sort: (r: any) => r.script, cell: (r: any) => <span className="mono text-[11px]">{r.script}</span> },
                { key: "requests", header: "requests", align: "right", sort: (r: any) => r.requests, cell: (r: any) => <span className="mono">{fmt(r.requests)}</span> },
              ]} initialSort={{ key: "requests", dir: "desc" }} />
            </div>
          </div>
          <p className="text-[10px] text-slate-500">{d.source}. Daily limits reset at {d.window?.resets ?? "00:00 UTC"}. Read-only token; nothing here changes the plan or spends money.</p>
        </div>
      )}
    </Panel>
  );
}
