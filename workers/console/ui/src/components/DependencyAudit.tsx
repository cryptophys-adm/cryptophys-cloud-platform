import { ShieldAlert } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "./ui";
import { DataTable, Stat } from "./viz";
import { ago } from "../lib/format";

/**
 * ADR-0012 G5: the npm dependency audit (Dependabot's alerts, off GitHub). Once a day per head of main the Forge
 * reads every package-lock.json from the Artifacts copy and asks the npm registry's advisory endpoint which
 * installed versions are affected (GET /v1/forge/dependency-audit). Every number comes from that response; a
 * missing value is "—". Upgrades are not proposed automatically yet.
 */
const STATUS_TONE: Record<string, "green" | "amber" | "red" | "slate"> = {
  clean: "green", findings: "amber", action_needed: "red", failing: "amber", stale: "red", no_data: "slate",
};
const STATUS_TEXT: Record<string, string> = {
  clean: "no advisory", findings: "advisories in tooling or low severity", action_needed: "high or critical in a build",
  failing: "last run failed", stale: "stale", no_data: "not audited yet",
};
const SEVERITY_TONE: Record<string, "red" | "amber" | "slate"> = { critical: "red", high: "red", moderate: "amber", low: "slate", info: "slate" };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : "—");

export default function DependencyAudit({ data, loading }: { data: any; loading: boolean }) {
  const a = data?.audit;
  const ok = a?.last_ok_run;
  const latest = a?.latest_run;
  const findings: any[] = Array.isArray(a?.findings) ? a.findings : [];
  return (
    <Panel title="npm dependencies · advisories" icon={<ShieldAlert className="h-3.5 w-3.5 text-rose-300" />}
      right={<Badge tone={STATUS_TONE[a?.status] ?? "slate"}>{a ? STATUS_TEXT[a.status] ?? a.status : "—"}</Badge>}>
      {loading && !data ? <Skeleton rows={3} /> : !a ? <Empty>The Forge has not audited npm dependencies yet (migration 0050 is missing).</Empty> : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat label="Critical · high" value={ok ? `${num(ok.critical)} · ${num(ok.high)}` : "—"}
              tone={a.runtime_high_ids?.length ? "critical" : ok && (ok.critical || ok.high) ? "warning" : undefined}
              sub={ok ? `${num(ok.moderate)} moderate · ${num(ok.low)} low` : "no successful run"} />
            <Stat label="In Worker or Console builds" value={a.runtime_high_ids ? `${a.runtime_high_ids.length}` : "—"} sub="high or critical advisories" />
            <Stat label="Packages" value={ok ? num(ok.packages) : "—"} sub={ok ? `${num(ok.lockfiles)} lockfiles · main ${String(ok.main_sha ?? "").slice(0, 7)}` : "—"} />
            <Stat label="Last run" value={latest ? ago(latest.ran_at) : "never"}
              sub={latest ? (latest.status === "ok" ? "succeeded" : `failed: ${latest.error ?? "—"}`) : "the Forge audits once a day"} />
          </div>
          {findings.length > 0 ? (
            <DataTable rows={findings} rowKey={(f) => `${f.package}@${f.version}#${f.advisory_id}`} maxHeight={300} columns={[
              { key: "package", header: "package", cell: (f) => <span className="mono text-[11px] text-cyan-200">{f.package}@{f.version}</span> },
              { key: "severity", header: "severity", cell: (f) => <Badge tone={SEVERITY_TONE[f.severity] ?? "slate"}>{f.severity}</Badge> },
              { key: "where", header: "where", cell: (f) => <span className="text-[11px] text-slate-400" title={(f.lockfiles ?? []).join(", ")}>{f.runtime ? "build" : "tooling"}</span> },
              { key: "title", header: "advisory", className: "wrap", cell: (f) => f.url
                ? <a className="text-[11px] text-slate-200 underline decoration-slate-600" href={f.url} target="_blank" rel="noreferrer noopener">{f.title ?? f.advisory_id}</a>
                : <span className="text-[11px] text-slate-200">{f.title ?? f.advisory_id}</span> },
              { key: "range", header: "affected", cell: (f) => <span className="mono text-[10px] text-slate-500">{f.vulnerable_versions ?? "—"}</span> },
            ]} />
          ) : ok ? <p className="text-[11px] text-slate-400">No advisory covers an installed version.</p> : null}
          <p className="text-[10px] leading-relaxed text-slate-500">
            The Forge reads every package-lock.json of main from the Artifacts copy once a day and asks the npm registry's advisory endpoint (the one npm audit uses), sending only package names and versions. "build" means a Worker's or the Console UI's lockfile; "tooling" means tests and scripts. A high or critical advisory in a build, or no successful audit for 72 hours, reaches the owner. Upgrades are not proposed automatically yet.
          </p>
        </div>
      )}
    </Panel>
  );
}
