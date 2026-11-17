import { Activity, ExternalLink, History, PackageCheck } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { ago, listOf } from "../lib/format";
import { ActivityChart, BarList, CATEGORICAL, DataTable, STATUS, StatusBar, bucketize } from "../components/viz";

const REQ_STATUS = [
  { key: "succeeded", label: "succeeded", color: STATUS.good },
  { key: "running", label: "running", color: STATUS.info },
  { key: "pending", label: "pending", color: STATUS.warning },
  { key: "failed", label: "failed", color: STATUS.critical },
  { key: "other", label: "cancelled / other", color: STATUS.neutral },
];
const reqKey = (s?: string) => (s === "succeeded" || s === "completed" ? "succeeded" : s === "running" || s === "dispatched" ? "running" : s === "pending" || s === "queued" ? "pending" : s === "failed" || s === "error" ? "failed" : "other");
const ORIGINS = ["consensus", "deploy workflow", "person", "agent", "other"];

type Tone = "green" | "amber" | "red" | "cyan" | "slate" | "purple";
const STATUS_TONE: Record<string, Tone> = {
  succeeded: "green", executed: "green", passed: "green", completed: "green",
  running: "cyan", executing: "cyan", approved: "cyan", pending: "amber", pending_owner: "amber",
  failed: "red", rejected: "red", cancelled: "slate", error: "red",
};
const ORIGIN_TONE: Record<string, Tone> = { consensus: "purple", "deploy workflow": "cyan", person: "amber", agent: "purple", other: "slate" };
const short = (v: unknown, n = 7) => String(v ?? "").slice(0, n) || "—";
const svc = (id: unknown) => String(id ?? "").replace(/^cryptophys-/, "");

/**
 * Pipelines: what is running now and what was deployed, read only. Deploys come from consensus (ADR-0009): the
 * native deploy, or the unit's deploy workflow as its fallback. The emergency deploy form was removed by the owner on
 * 2026-11-14 ("hapus aja, karena roadmap berikutnya kita kembangkan Human Ai Interaction & Collaboration").
 */
export default function Pipelines() {
  const deployments = usePoll(() => call("orchestrator.deployments", undefined, undefined, { limit: "25" }), 30_000);
  const checks = usePoll(() => call("forge.checks", undefined, undefined, { limit: "5" }), 60_000);
  const executing = usePoll(() => call("recovery.plans", undefined, undefined, { status: "executing" }), 60_000);

  const d = deployments.data as any;
  const activeRequests: any[] = d?.active?.requests ?? [];
  const activeProposals: any[] = d?.active?.proposals ?? [];
  const runningChecks = listOf(checks.data, "checks").filter((c: any) => c.status === "running");
  const runningPlans = listOf(executing.data, "plans");
  const activeCount = activeRequests.length + activeProposals.length + runningChecks.length + runningPlans.length;
  const requests: any[] = d?.requests ?? [];
  const deploys: any[] = d?.deploys ?? [];
  const originSeries = ORIGINS.map((o, i) => ({ key: o, label: o, color: i < 4 ? CATEGORICAL[i] : STATUS.neutral }));
  const { buckets, bin } = bucketize(deploys, (e: any) => e.at, (e: any) => (ORIGINS.includes(e.origin) ? e.origin : "other"));
  const perService = Object.entries(deploys.reduce((m: Record<string, number>, e: any) => { const k = svc(e.service_id); m[k] = (m[k] ?? 0) + 1; return m; }, {})).map(([label, value]) => ({ label, value: Number(value) }));

  return (
    <div className="flex flex-col gap-3">
      <h1 className="sr-only">Pipelines</h1>
      <Panel title="Running now" icon={<Activity className="h-3.5 w-3.5 text-cyan-300" />}
        right={<Badge tone={activeCount ? "cyan" : "slate"}>{deployments.loading && !d ? "—" : `${activeCount} active`}</Badge>}>
        {deployments.loading && !d ? <Skeleton rows={2} /> : deployments.error && !d ? <Empty>The deployments list is not available: {deployments.error}</Empty> : activeCount === 0 ? (
          <Empty>Nothing is running. New commits of main are checked by the Forge, then deployed by consensus at a safe minute.</Empty>
        ) : (
          <div className="space-y-1.5">
            {activeProposals.map((p: any) => (
              <a key={p.proposal_id} href="#/consensus" className="glass-inner flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
                <Badge tone="purple">consensus</Badge>
                <span className="mono text-[12px] text-fuchsia-200">{p.action}</span>
                <span className="text-[12px] text-slate-200">{svc(p.target)}</span>
                <Badge tone={STATUS_TONE[p.status] ?? "slate"}>{p.status === "pending_owner" ? "waiting for your click" : p.status}</Badge>
                <span className="ml-auto text-[10px] text-slate-500">{ago(p.created_at)}</span>
              </a>
            ))}
            {activeRequests.map((r: any) => (
              <div key={r.request_id} className="glass-inner flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
                <Badge tone={ORIGIN_TONE[r.origin] ?? "slate"}>{r.origin}</Badge>
                <span className="text-[12px] text-slate-200">deploy {svc(r.service_id)}</span>
                <span className="mono text-[11px] text-cyan-200">{short(r.version)}</span>
                <Badge tone={STATUS_TONE[r.status] ?? "slate"}>{r.status}</Badge>
                {r.workflow ? <span className="mono text-[10px] text-slate-400">{r.workflow}</span> : null}
                <span className="ml-auto text-[10px] text-slate-500">{ago(r.created_at)}</span>
              </div>
            ))}
            {runningChecks.map((c: any) => (
              <a key={c.commit} href="#/code" className="glass-inner flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
                <Badge tone="green">forge</Badge>
                <span className="text-[12px] text-slate-200">checks</span>
                <span className="mono text-[11px] text-cyan-200">{short(c.commit)}</span>
                <Badge tone="cyan">running</Badge>
                <span className="ml-auto text-[10px] text-slate-500">{ago(c.started_at)}</span>
              </a>
            ))}
            {runningPlans.map((p: any) => (
              <a key={p.plan_id} href={`#/recovery/${p.plan_id}`} className="glass-inner flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
                <Badge tone="amber">recovery</Badge>
                <span className="min-w-0 flex-1 wrap-break-word text-[12px] text-slate-200">{p.title}</span>
                <Badge tone="cyan">executing</Badge>
              </a>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Deployed versions" icon={<PackageCheck className="h-3.5 w-3.5 text-emerald-300" />} right={<Badge tone="slate">{deploys.length}</Badge>}>
        {deployments.loading && !d ? <Skeleton /> : deploys.length === 0 ? <Empty>No version has been recorded yet.</Empty> : (<>
          <div className="mb-3 grid gap-3 lg:grid-cols-2">
            <ActivityChart buckets={buckets} bin={bin} series={originSeries} height={110} caption="deploys over time by origin" />
            <div><div className="mb-1.5 text-[10px] uppercase tracking-widest text-slate-500">Deploys per service</div><BarList items={perService} max={8} /></div>
          </div>
          <DataTable rows={deploys} rowKey={(e, i) => `${e.service_id}-${e.at}-${i}`} initialSort={{ key: "when", dir: "desc" }} maxHeight={360} columns={[
            { key: "service", header: "service", sort: (e) => svc(e.service_id), cell: (e) => <span className="text-slate-200">{svc(e.service_id)}</span> },
            { key: "version", header: "version", cell: (e) => <span className="mono text-[11px] text-cyan-200">{e.previous ? <span className="text-slate-500">{short(e.previous)} → </span> : null}{short(e.version)}</span> },
            { key: "origin", header: "origin", sort: (e) => e.origin, cell: (e) => <Badge tone={ORIGIN_TONE[e.origin] ?? "slate"}>{e.origin}</Badge> },
            { key: "actor", header: "actor", sort: (e) => e.actor, cell: (e) => <span className="mono text-[10px] text-slate-500">{String(e.actor ?? "—").slice(0, 32)}</span> },
            { key: "when", header: "when", sort: (e) => Date.parse(e.at) || 0, cell: (e) => <span className="text-slate-500" title={e.at}>{ago(e.at)}</span> },
          ]} />
        </>)}
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">Every deploy workflow records the version it shipped in the registry; the Drift Detector then compares it with what runs.</p>
      </Panel>

      <Panel title="Deploy requests" icon={<History className="h-3.5 w-3.5 text-violet-300" />} right={<Badge tone="slate">{requests.length}</Badge>}>
        {deployments.loading && !d ? <Skeleton /> : requests.length === 0 ? <Empty>No deploy request yet.</Empty> : (<>
          <StatusBar className="mb-3" segments={REQ_STATUS.map((s) => ({ ...s, value: requests.filter((r: any) => reqKey(r.status) === s.key).length }))} />
          <DataTable rows={requests} rowKey={(r) => r.request_id} initialSort={{ key: "when", dir: "desc" }} maxHeight={360} columns={[
            { key: "status", header: "status", sort: (r) => r.status, cell: (r) => <Badge tone={STATUS_TONE[r.status] ?? "slate"}>{r.status}</Badge> },
            { key: "service", header: "service", sort: (r) => svc(r.service_id), cell: (r) => <span className="text-slate-200">{svc(r.service_id)}</span> },
            { key: "version", header: "version", cell: (r) => <span className="mono text-[11px] text-cyan-200">{short(r.version, 12)}</span> },
            { key: "origin", header: "origin", sort: (r) => r.origin, cell: (r) => <Badge tone={ORIGIN_TONE[r.origin] ?? "slate"}>{r.origin}</Badge> },
            { key: "workflow", header: "workflow", sort: (r) => r.workflow, cell: (r) => <span className="mono text-[10px] text-slate-400">{r.workflow ?? "—"}</span> },
            { key: "note", header: "note", className: "wrap", cell: (r) => <span className="text-[11px] text-slate-400">{r.note ?? ""}{r.run_url ? <a className="ml-1 inline-flex items-center gap-1 text-cyan-300" href={r.run_url} target="_blank" rel="noreferrer">run<ExternalLink className="h-3 w-3" /></a> : null}</span> },
            { key: "when", header: "when", sort: (r) => Date.parse(r.created_at) || 0, cell: (r) => <span className="text-slate-500" title={r.created_at}>{ago(r.created_at)}</span> },
          ]} />
        </>)}
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">The Deployment Orchestrator's ledger: consensus and recovery deploys, native rollbacks and retirements (older rows include manual requests, removed 2026-11-14). A workflow request is closed against its run.</p>
      </Panel>
    </div>
  );
}
