import { useState } from "react";
import { Activity, ExternalLink, GitBranch, History, PackageCheck, Rocket } from "lucide-react";
import { Badge, Empty, Field, JsonView, Panel, Skeleton } from "../components/ui";
import { useSession } from "../lib/session";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { ago, listOf } from "../lib/format";

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
 * Pipelines: what is running now and what was deployed. Routine deploys come from consensus
 * (ADR-0009) and the deploy workflows; the manual Platform API form is kept as an emergency path.
 */
export default function Pipelines() {
  const { act, notify } = useSession();
  const deployments = usePoll(() => call("orchestrator.deployments", undefined, undefined, { limit: "25" }), 30_000);
  const checks = usePoll(() => call("forge.checks", undefined, undefined, { limit: "5" }), 60_000);
  const executing = usePoll(() => call("recovery.plans", undefined, undefined, { status: "executing" }), 60_000);
  const [manual, setManual] = useState(false);
  const [sha, setSha] = useState("");
  const [out, setOut] = useState<unknown>(null);

  const d = deployments.data as any;
  const activeRequests: any[] = d?.active?.requests ?? [];
  const activeProposals: any[] = d?.active?.proposals ?? [];
  const runningChecks = listOf(checks.data, "checks").filter((c: any) => c.status === "running");
  const runningPlans = listOf(executing.data, "plans");
  const activeCount = activeRequests.length + activeProposals.length + runningChecks.length + runningPlans.length;
  const requests: any[] = d?.requests ?? [];
  const deploys: any[] = d?.deploys ?? [];

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
                <span className="min-w-0 flex-1 break-words text-[12px] text-slate-200">{p.title}</span>
                <Badge tone="cyan">executing</Badge>
              </a>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Deployed versions" icon={<PackageCheck className="h-3.5 w-3.5 text-emerald-300" />} right={<Badge tone="slate">{deploys.length}</Badge>}>
        {deployments.loading && !d ? <Skeleton /> : deploys.length === 0 ? <Empty>No version has been recorded yet.</Empty> : (
          <div className="space-y-1.5">
            {deploys.map((e: any, i: number) => (
              <div key={`${e.service_id}-${e.at}-${i}`} className="glass-inner flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
                <span className="text-[12px] text-slate-200">{svc(e.service_id)}</span>
                <span className="mono text-[11px] text-cyan-200">{e.previous ? <span className="text-slate-500">{short(e.previous)} → </span> : null}{short(e.version)}</span>
                <Badge tone={ORIGIN_TONE[e.origin] ?? "slate"}>{e.origin}</Badge>
                <span className="ml-auto text-[10px] text-slate-500">{ago(e.at)}</span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">Every deploy workflow records the version it shipped in the registry; the Drift Detector then compares it with what runs.</p>
      </Panel>

      <Panel title="Deploy requests" icon={<History className="h-3.5 w-3.5 text-violet-300" />} right={<Badge tone="slate">{requests.length}</Badge>}>
        {deployments.loading && !d ? <Skeleton /> : requests.length === 0 ? <Empty>No deploy request yet.</Empty> : (
          <div className="space-y-1.5">
            {requests.map((r: any) => (
              <div key={r.request_id} className="glass-inner flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
                <Badge tone={STATUS_TONE[r.status] ?? "slate"}>{r.status}</Badge>
                <span className="text-[12px] text-slate-200">{svc(r.service_id)}</span>
                <span className="mono text-[11px] text-cyan-200">{short(r.version, 12)}</span>
                <Badge tone={ORIGIN_TONE[r.origin] ?? "slate"}>{r.origin}</Badge>
                {r.workflow ? <span className="mono text-[10px] text-slate-400">{r.workflow}</span> : null}
                {r.note ? <span className="text-[10px] text-slate-400">{r.note}</span> : null}
                {r.run_url ? <a className="inline-flex items-center gap-1 text-[10px] text-cyan-300" href={r.run_url} target="_blank" rel="noreferrer">run<ExternalLink className="h-3 w-3" /></a> : null}
                <span className="ml-auto text-[10px] text-slate-500">{ago(r.created_at)}</span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">The Deployment Orchestrator's ledger: consensus deploys, native rollbacks and Platform API requests. Each is closed against its workflow run.</p>
      </Panel>

      <Panel title="Manual deploy (emergency)" icon={<GitBranch className="h-3.5 w-3.5 text-amber-300" />}>
        {!manual ? (
          <>
            <p className="text-[12px] leading-relaxed text-slate-400">Routine deploys need no click: agents propose, consensus votes, the Policy Engine checks. Use this only if that path is stopped. It deploys the Platform API at the current main commit.</p>
            <button type="button" className="btn mt-2" onClick={() => setManual(true)}>Open manual deploy…</button>
          </>
        ) : (
          <>
            <p className="mb-3 text-[12px] leading-relaxed text-slate-400">The Deployment Orchestrator decides: it checks the deploy allow-list, CI status and the deployment lock before dispatching. A 403 or 503 response is expected for most identities.</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
              <Field label="Commit SHA (40 hex)"><input className="field mono" maxLength={40} value={sha} onChange={(e) => setSha(e.target.value)} /></Field>
              <div className="flex items-end"><button type="button" className="btn btn-danger" onClick={() => {
                const v = sha.trim().toLowerCase();
                if (!/^[0-9a-f]{40}$/.test(v)) { notify("err", "Commit SHA must be 40 hex characters."); return; }
                act({ route: "orchestrator.deploy", body: { commit_sha: v, confirm_production: "DEPLOY" }, title: `Deploy ${v.slice(0, 12)}`, lines: [`Requests a production deployment of commit ${v}.`], done: "Deployment request sent.",
                  after: (r) => { setOut(r); void deployments.refresh(); }, onError: (e: any) => setOut({ status: e.status, response: e.data }) });
              }}><Rocket className="h-3.5 w-3.5" />Deploy…</button></div>
            </div>
            {out !== null && <div className="mt-3"><JsonView value={out} /></div>}
          </>
        )}
      </Panel>
    </div>
  );
}
