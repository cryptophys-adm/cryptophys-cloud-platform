import { AlertTriangle, CheckCircle2, Cloud, Cpu, KeyRound, ShieldAlert } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "./ui";
import { ActivityChart, BarList, DataTable, STATUS, type Bucket } from "./viz";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { ago } from "../lib/format";

/**
 * Real Cloudflare usage and billable costs against Workers Free limits (owner 2026-11-10).
 * Data comes from GET /v1/usage on the Platform API, which reads the GraphQL Analytics API
 * and Billable Usage API with an owner-created, read-only token.
 * A metric that cannot be read shows its error or dash, never a number.
 */
const fmt = (v: number) => v.toLocaleString("en-US");
const fmtMoney = (v: unknown) => (typeof v === "number" ? "$" + Math.abs(v).toFixed(2) : "—");
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
  const spend = d.spend_summary;
  const products: any[] = Array.isArray(d.billable_products) ? d.billable_products : [];
  const intents: any[] = Array.isArray(d.orchestrator_cost_intents) ? d.orchestrator_cost_intents : [];
  const isOverage = typeof spend?.total_cost === "number" && spend.total_cost > 0;
  const hasSpend = typeof spend?.total_cost === "number";

  return (
    <Panel
      title="Cloudflare Billable Usage · Free Tier Quotas"
      icon={<Cloud className="h-3.5 w-3.5 text-cyan-300" />}
      right={
        <div className="flex flex-wrap justify-end gap-2">
          <Badge tone={d.configured ? "green" : "amber"}>
            {d.configured ? "live from Cloudflare" : loading && !data ? "loading" : "token not set"}
          </Badge>
          {d.observed_at && <Badge tone="slate">{d.cached ? "cached · " : ""}{ago(d.observed_at)}</Badge>}
        </div>
      }
    >
      {loading && !data ? (
        <Skeleton rows={3} />
      ) : error && !data ? (
        <Empty>The usage endpoint is not available yet: {error}</Empty>
      ) : !d.configured ? (
        <div className="space-y-3 text-[12px]">
          <div className="flex items-start gap-2 rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-amber-100">
            <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{d.setup ?? "The owner sets a read-only analytics and billing token on cryptophys-platform-api."} Until then no Cloudflare number is shown here.</span>
          </div>
          {d.platform && (
            <div>
              <div className="mb-1.5 text-[10px] uppercase tracking-widest text-slate-500">Measured by the platform itself · AI requests today across platform services</div>
              <BarList items={(d.platform.ai_requests_by_service ?? []).map((r: any) => ({ label: String(r.service_id).replace(/^cryptophys-/, ""), value: Number(r.requests ?? 0) }))} empty="No AI request today." />
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {/* Billable Usage API error or permission notice */}
          {d.billable_error && (
            <div className="flex items-start gap-2.5 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-[11px] text-amber-200 leading-relaxed">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
              <div className="space-y-1">
                <div>
                  <span className="font-semibold text-amber-300">Cloudflare Billable Usage API Notice:</span>{" "}
                  {d.billable_error}
                </div>
                {/permission|401|403|unauthorized/i.test(d.billable_error) && (
                  <div className="text-[10px] text-slate-300">
                    Action required: In the Cloudflare Dashboard (&gt; Manage Account &gt; API Tokens), verify that the API token set as <span className="mono font-semibold">CF_ANALYTICS_TOKEN</span> or <span className="mono font-semibold">CF_BILLING_TOKEN</span> on <span className="mono font-semibold">cryptophys-platform-api</span> has the <span className="mono font-semibold">Account &gt; Billing &gt; Read</span> permission in addition to <span className="mono font-semibold">Account &gt; Account Analytics &gt; Read</span>.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Section 1: Spend Summary Cards */}
          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-widest text-slate-500">Spend summary · Billing period {spend?.billing_period ?? "—"}</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <div className="glass-inner p-3 space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-slate-400">Total Cost</div>
                <div className="mono text-xl font-bold text-slate-100">{fmtMoney(spend?.total_cost)}</div>
                <div className="text-[10px] text-slate-500">
                  {spend ? `Usage observed ${spend.period_start} – ${spend.period_end}` : "Within Free Tier quota"}
                </div>
              </div>
              <div className="glass-inner p-3 space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-slate-400">Projected Cycle Cost</div>
                <div className="mono text-xl font-bold text-amber-300">{fmtMoney(spend?.projected_cost)}</div>
                <div className="text-[10px] text-slate-500">
                  {spend ? `${spend.days_observed} of ${spend.total_days} cycle days observed` : "Projected month cost"}
                </div>
              </div>
              <div className="glass-inner p-3 space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-slate-400">Average Daily Cost</div>
                <div className="mono text-xl font-bold text-cyan-300">{fmtMoney(spend?.average_daily_cost)}</div>
                <div className="text-[10px] text-slate-500">Based on observed usage in cycle</div>
              </div>
              <div className="glass-inner p-3 space-y-1">
                <div className="text-[10px] uppercase tracking-wider text-slate-400">Billing Cycle Window</div>
                <div className="mono text-sm font-semibold text-slate-200 mt-1">{spend?.billing_period ?? "—"}</div>
                <div className="text-[10px] text-slate-500">
                  {spend ? `${spend.period_start} to ${spend.period_end}` : "Account cycle"}
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: Product Breakdown Table */}
          {products.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[10px] uppercase tracking-widest text-slate-500">Billable usage breakdown · By product</div>
                <span className="mono text-[11px] text-slate-400">Total: {fmtMoney(spend?.total_cost)}</span>
              </div>
              <DataTable
                rows={products}
                rowKey={(r: any) => r.product}
                maxHeight={220}
                dense
                empty="No billable product recorded."
                columns={[
                  { key: "product", header: "Product", sort: (r: any) => r.product, cell: (r: any) => <span className="font-semibold text-slate-200 text-[11px]">{r.product}</span> },
                  { key: "category", header: "Category", sort: (r: any) => r.category, cell: (r: any) => <span className="text-slate-400 text-[11px]">{r.category}</span> },
                  { key: "total_usage", header: "Total usage", align: "right", cell: (r: any) => <span className="mono text-slate-300 text-[11px]">{r.total_usage}</span> },
                  { key: "billable_usage", header: "Billable usage", align: "right", cell: (r: any) => <span className="mono text-slate-300 text-[11px]">{r.billable_usage}</span> },
                  { key: "usage_cost", header: "Usage cost", align: "right", sort: (r: any) => r.usage_cost, cell: (r: any) => <span className="mono text-amber-300 font-bold text-[11px]">{fmtMoney(r.usage_cost)}</span> },
                ]}
                initialSort={{ key: "usage_cost", dir: "desc" }}
              />
            </div>
          ) : !d.billable_error ? (
            <div className="glass-inner p-3 space-y-1 text-[11px]">
              <div className="font-semibold text-slate-200">No billable cost records returned</div>
              <p className="text-[10px] text-slate-400 leading-relaxed">
                The Billable Usage API returned no cost record for this cycle. Cloudflare aggregates usage-based billing once a day.
              </p>
            </div>
          ) : null}

          {/* Section 3: Supervisor / Orchestrator Free Tier Control Intent Advisory */}
          <div className="glass-inner p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-200">
                {isOverage ? <ShieldAlert className="h-3.5 w-3.5 text-amber-400" /> : hasSpend ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : null}
                <span>Billable cost and the Supervisor</span>
              </div>
              <Badge tone={isOverage ? "amber" : hasSpend ? "green" : "slate"}>
                {isOverage ? "billable cost this cycle" : hasSpend ? "no billable cost this cycle" : "no billing data"}
              </Badge>
            </div>
            <p className="text-[11px] text-slate-400 leading-relaxed">
              The Supervisor records the cycle's billable cost as a daily burn (cycle-to-date cost ÷ days observed). Above $0.20 a day it enters survival mode, which pauses non-essential AI spending (memory and knowledge proposals); consensus is never blocked. The intents below are advisories: nothing else is changed automatically.
            </p>
            {intents.length > 0 && (
              <div className="space-y-1.5 pt-1">
                {intents.map((i: any) => (
                  <div key={i.intent_id} className="flex items-start gap-2 rounded-lg bg-black/20 p-2 text-[10px] text-slate-300">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-400" />
                    <div>
                      <span className="font-semibold text-amber-300">[{i.target_service}] {i.action}:</span> {i.directive}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Section 4: Workers Free Limits Meters */}
          <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-widest text-slate-500">Workers Free plan quotas &amp; live meters</div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {metrics.map((m) => <MetricRow key={m.key} m={m} />)}
            </div>
          </div>

          {/* Section 5: Activity Charts & Worker Requests Today */}
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

          <p className="text-[10px] text-slate-500">{d.source}. Daily limits reset at {d.window?.resets ?? "00:00 UTC"}. Read-only token; nothing here changes the plan or moves funds.</p>
        </div>
      )}
    </Panel>
  );
}
