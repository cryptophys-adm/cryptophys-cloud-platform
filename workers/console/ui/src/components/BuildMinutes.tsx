import { Timer } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "./ui";
import { BarList, DataTable, STATUS, Stat } from "./viz";
import { ago } from "../lib/format";

/**
 * Owner 2026-11-12 ("ya kerjakan opsi 2"): the account's Workers Builds minutes this month, measured by the
 * Forge from the Workers Builds API (GET /v1/forge/build-usage), against the free-tier budget. A build without a
 * measured start and stop counts as unmeasured, never estimated. Deploys run on GitHub Actions and use no build
 * minutes; only the type-check and Console UI builds (and any other Worker connected to Workers Builds) do.
 */
const STATUS_TONE: Record<string, "green" | "amber" | "red" | "slate"> = { ok: "green", warning: "amber", over: "red", stale: "amber", no_data: "slate" };
const STATUS_TEXT: Record<string, string> = {
  ok: "within budget", warning: "near budget", over: "over budget", stale: "stale", no_data: "not measured yet",
};
const secs = (s: unknown) => (typeof s === "number" && Number.isFinite(s) ? (s < 90 ? `${s} s` : `${Math.round(s / 6) / 10} min`) : "—");

export default function BuildMinutes({ data, loading }: { data: any; loading: boolean }) {
  const u = data?.usage;
  const builds: any[] = Array.isArray(data?.builds) ? data.builds : [];
  const budget = u?.budget_minutes ?? 3000;
  const pct = u ? Math.min(100, Math.round((u.minutes / budget) * 100)) : 0;
  const projPct = u?.projected_minutes != null ? Math.min(100, Math.round((u.projected_minutes / budget) * 100)) : null;
  const barColor = u?.status === "over" ? STATUS.critical : u?.status === "warning" ? STATUS.warning : STATUS.good;
  return (
    <Panel title="Workers Builds minutes · this month" icon={<Timer className="h-3.5 w-3.5 text-amber-300" />}
      right={<Badge tone={STATUS_TONE[u?.status] ?? "slate"}>{u ? STATUS_TEXT[u.status] ?? u.status : "—"}</Badge>}>
      {loading && !data ? <Skeleton rows={3} /> : !u ? <Empty>The Forge has not measured Workers Builds yet (migration 0049 or its Builds API token is missing).</Empty> : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat label="Measured" value={`${u.minutes} min`} tone={u.status === "over" ? "critical" : u.status === "warning" ? "warning" : "good"}
              sub={`of ${budget} (free tier) · ${u.month}`} />
            <Stat label="Projection" value={u.projected_minutes != null ? `${u.projected_minutes} min` : "—"}
              sub={u.projected_minutes != null ? "at this month's pace" : "after the first day of the month"} />
            <Stat label="Builds" value={u.builds} sub={`${u.avg_minutes != null ? `${u.avg_minutes} min each on average` : "no measured build"}${u.unmeasured_builds ? ` · ${u.unmeasured_builds} unmeasured` : ""}`} />
            <Stat label="Last measured" value={u.last_collection ? ago(u.last_collection.collected_at) : "never"}
              sub={u.last_collection ? `${u.last_collection.outcome} · ${u.last_collection.workers} Workers with builds` : "the Forge collects hourly"} />
          </div>
          <div>
            <div className="mb-1 flex items-baseline justify-between text-[11px]"><span className="text-slate-400">Used of the free-tier budget</span>
              <span className="mono text-slate-100">{pct}%{projPct !== null ? ` · projected ${projPct}%` : ""}</span></div>
            <div className="relative h-2 w-full overflow-hidden rounded-[4px] bg-white/[0.05]" role="progressbar" aria-label="build minutes used" aria-valuenow={u.minutes} aria-valuemin={0} aria-valuemax={budget}>
              {projPct !== null && <div className="absolute inset-y-0 left-0 rounded-r-[4px] opacity-30" style={{ width: `${projPct}%`, background: barColor }} />}
              <div className="absolute inset-y-0 left-0 rounded-r-[4px]" style={{ width: `${Math.max(pct, u.minutes > 0 ? 1 : 0)}%`, background: barColor }} />
              <div className="absolute inset-y-0 w-px bg-amber-300/70" style={{ left: `${Math.round(u.warn_ratio * 100)}%` }} title="warning threshold" />
            </div>
          </div>
          {u.by_worker.length > 0 && (
            <div><div className="mb-1.5 text-[10px] uppercase tracking-widest text-slate-500">Minutes per Worker</div>
              <BarList max={6} unit=" min" items={u.by_worker.map((w: any) => ({ label: w.worker, value: w.minutes }))} /></div>
          )}
          {builds.length > 0 && (
            <DataTable rows={builds} rowKey={(b) => b.build_uuid} maxHeight={260} columns={[
              { key: "worker", header: "Worker", cell: (b) => <span className="text-[11px] text-slate-200">{b.worker}</span> },
              { key: "branch", header: "branch", cell: (b) => <span className="mono text-[11px] text-cyan-200">{b.branch ?? "—"}{b.commit_sha ? ` · ${String(b.commit_sha).slice(0, 7)}` : ""}</span> },
              { key: "outcome", header: "outcome", cell: (b) => <Badge tone={b.outcome === "success" ? "green" : b.outcome ? "red" : "slate"}>{b.outcome ?? b.status ?? "—"}</Badge> },
              { key: "duration", header: "duration", align: "right", sort: (b) => b.duration_s ?? -1, cell: (b) => <span className="mono">{secs(b.duration_s)}</span> },
              { key: "queued", header: "queued", align: "right", cell: (b) => <span className="mono text-slate-400">{secs(b.queued_s)}</span> },
              { key: "when", header: "when", sort: (b) => Date.parse(b.stopped_on ?? b.created_on) || 0, cell: (b) => <span className="text-slate-500">{b.stopped_on ? ago(b.stopped_on) : "—"}</span> },
            ]} />
          )}
          <p className="text-[10px] leading-relaxed text-slate-500">
            Measured by the Forge from the Workers Builds API every hour, for every Worker on the account. Each build counts from its start to its stop, rounded up to whole minutes. The budget is the free tier ({u.included_minutes.free} min/month, 1 build at a time); the account is on Workers Paid ({u.included_minutes.paid} min/month). Deploys run on GitHub Actions and use no build minutes. The month is the UTC calendar month; Cloudflare's billing cycle may differ. A warning reaches the owner at {Math.round(u.warn_ratio * 100)}% of the budget, measured or projected.
          </p>
        </div>
      )}
    </Panel>
  );
}
