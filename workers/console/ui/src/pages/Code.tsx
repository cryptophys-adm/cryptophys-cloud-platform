import { Gauge, FlaskConical, FolderGit2, GitCommitHorizontal, GitPullRequest, Rocket } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { ago, listOf } from "../lib/format";
import { usePoll } from "../lib/usePoll";
import { BarList, DataTable, Meter, STATUS, Stat, StatusBar } from "../components/viz";
import BuildMinutes from "../components/BuildMinutes";
import DependencyAudit from "../components/DependencyAudit";

const CHECK_TONE: Record<string, "green" | "red" | "amber" | "slate"> = { passed: "green", failed: "red", error: "amber", running: "slate" };
const VERDICT: Record<string, { tone: "green" | "red" | "amber" | "slate" | "cyan"; label: string }> = {
  would_merge: { tone: "green", label: "would merge" }, needs_owner: { tone: "amber", label: "needs owner" },
  blocked: { tone: "red", label: "blocked" }, pending: { tone: "slate", label: "pending" },
};

// ADR-0012: the platform source on the Forge (Cloudflare Artifacts), read-only, and the Forge checks
// of each commit next to GitHub CI (phase 3).
export default function Code() {
  const status = usePoll(() => call("forge.status"), 60_000);
  const commits = usePoll(() => call("forge.commits", undefined, undefined, { limit: "30" }), 60_000);
  const checks = usePoll(() => call("forge.checks", undefined, undefined, { limit: "20" }), 60_000);
  const changes = usePoll(() => call("forge.changes", undefined, undefined, { limit: "15" }), 60_000);
  const crs = listOf(changes.data, "changes");
  const openCrs = crs.filter((c: any) => c.status === "open");
  const noVerdict = crs.filter((c: any) => c.status !== "open" && (c.verdict === "pending" || !c.verdict)).length;
  const mergeParity = changes.data?.parity;
  const plans = usePoll(() => call("forge.deploy_plans", undefined, undefined, { limit: "8" }), 60_000);
  const buildUsage = usePoll(() => call("forge.build_usage", undefined, undefined, { limit: "15" }), 300_000);
  const depAudit = usePoll(() => call("forge.dependency_audit"), 300_000);
  const planRows = listOf(plans.data, "plans");
  const planParity = plans.data?.parity;
  const unitsText = (u: string[] | null) => (u === null ? "not computed" : u.length ? u.join(" → ") : "nothing to deploy");
  const s = status.data;
  const rows = listOf(commits.data, "commits");
  const runs = listOf(checks.data, "checks");
  const parity = checks.data?.parity;
  const bySha = new Map(runs.map((r: any) => [r.commit, r]));
  return (
    <div className="flex flex-col gap-3">
      <h1 className="sr-only">Code</h1>
      <Panel title="Forge · platform source" icon={<FolderGit2 className="h-3.5 w-3.5 text-cyan-300" />}
        right={<Badge tone={s?.repo ? "green" : "amber"}>{s?.repo ? "mirrored" : s ? "not imported" : "—"}</Badge>}>
        {status.loading && !s ? <Skeleton /> : !s?.repo ? <Empty>The Forge has not imported the repository yet.</Empty> : (
          <div className="grid grid-cols-1 gap-2 text-[12px] sm:grid-cols-3">
            <Stat label="Repository" value={<span className="text-[14px]">cryptophys/{s.repo.name}</span>} />
            <Stat label="main" value={<span className="text-[14px] text-cyan-200">{String(s.head?.sha ?? "").slice(0, 12) || "—"}</span>} sub={s.head?.title} />
            <Stat label="Last change" value={<span className="text-[14px]">{s.head?.date ? ago(s.head.date) : "—"}</span>} sub={s.head?.author} />
          </div>
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">GitHub is still the source of truth during the migration (ADR-0012). Every push to main is mirrored here with the same commit IDs.</p>
      </Panel>
      <Panel title="Parity with GitHub · ADR-0012 gates" icon={<Gauge className="h-3.5 w-3.5 text-emerald-300" />}>
        <div className="grid gap-4 sm:grid-cols-3">
          <Meter label="Forge checks agree, in a row" value={parity?.consecutive ?? 0} target={parity?.target ?? 20} />
          <Meter label="Merge verdicts agree, in a row" value={mergeParity?.consecutive ?? 0} target={mergeParity?.target ?? 10} />
          <Meter label="Deploy plans agree, in a row" value={planParity?.consecutive ?? 0} target={planParity?.target ?? 10} />
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">Each gate moves from GitHub to the Forge once its bar is full. A disagreement resets the run.</p>
      </Panel>
      <Panel title="Change requests · shadow" icon={<GitPullRequest className="h-3.5 w-3.5 text-violet-300" />}
        right={<Badge tone={mergeParity && mergeParity.consecutive >= mergeParity.target ? "green" : "slate"}>{mergeParity ? `merge parity ${mergeParity.consecutive}/${mergeParity.target}` : "—"}</Badge>}>
        {changes.loading && !changes.data ? <Skeleton /> : (<>
          {/* Owner 2026-11-11: the bar counts only open requests. A merged or closed request keeps the
              verdict frozen at its outcome, shown in the table (and "no verdict at merge" when the
              Forge had not decided by then). */}
          {openCrs.length > 0 && <StatusBar className="mb-3" segments={[
            { key: "would_merge", label: "would merge", value: openCrs.filter((c: any) => c.verdict === "would_merge").length, color: STATUS.good },
            { key: "needs_owner", label: "needs owner", value: openCrs.filter((c: any) => c.verdict === "needs_owner").length, color: STATUS.owner },
            { key: "blocked", label: "blocked", value: openCrs.filter((c: any) => c.verdict === "blocked").length, color: STATUS.critical },
            { key: "pending", label: "pending", value: openCrs.filter((c: any) => !["would_merge", "needs_owner", "blocked"].includes(c.verdict)).length, color: STATUS.neutral },
          ]} />}
          {crs.length > 0 && <p className="mb-3 text-[11px] text-slate-500">{openCrs.length} open · {crs.length - openCrs.length} merged or closed{noVerdict ? ` · ${noVerdict} merged or closed before the Forge reached a verdict` : ""}</p>}
          <DataTable rows={crs} rowKey={(c) => c.cr_id} initialSort={{ key: "when", dir: "desc" }} maxHeight={420} empty="No change request has been registered on the Forge yet." columns={[
            { key: "number", header: "request", sort: (c) => (c.source === "forge" ? c.branch : c.number), cell: (c) => (
              <span className="inline-flex flex-wrap items-center gap-1">
                <Badge tone={c.source === "forge" ? "cyan" : "slate"}>{c.source === "forge" ? "forge" : c.source === "github" ? "github" : "—"}</Badge>
                <span className="mono break-all text-[11px] text-violet-200">{c.source === "forge" ? c.branch : `#${c.number}`}</span>
              </span>
            ) },
            { key: "title", header: "title", className: "wrap", sort: (c) => c.title, cell: (c) => <span className="text-slate-200">{c.title}</span> },
            { key: "verdict", header: "Forge verdict", sort: (c) => c.verdict, cell: (c) => { const v = VERDICT[c.verdict] ?? { tone: "slate", label: c.verdict ?? "—" }; return <span className="inline-flex flex-wrap gap-1"><Badge tone={v.tone}>{c.status === "open" ? v.label : c.verdict === "pending" || !c.verdict ? `no verdict at ${c.status === "merged" ? "merge" : "close"}` : `${v.label} at ${c.status}`}</Badge>{c.critical?.length ? <Badge tone="amber">owner path</Badge> : null}</span>; } },
            { key: "check", header: "check", sort: (c) => c.check?.status ?? "", cell: (c) => c.check ? <span className="text-[11px]"><span className={c.check.status === "passed" ? "text-emerald-300" : c.check.status === "failed" ? "text-rose-300" : "text-slate-400"}>{c.check.status}</span> <span className="mono text-slate-500">{c.check.pass ?? "—"}/{(c.check.pass ?? 0) + (c.check.fail ?? 0)}</span></span> : <span className="text-slate-600">not checked</span> },
            { key: "github", header: "GitHub CI", sort: (c) => c.github_ci, cell: (c) => <span className="text-[11px] text-slate-400">{c.github_ci ?? "—"}</span> },
            { key: "agrees", header: "agrees", sort: (c) => (c.agrees === true ? 2 : c.agrees === false ? 0 : 1), cell: (c) => c.status === "merged" ? <Badge tone={c.agrees === true ? "green" : c.agrees === false ? "red" : "slate"}>{c.agrees === true ? "yes" : c.agrees === false ? "no" : "late"}</Badge> : <span className="text-slate-600">—</span> },
            { key: "when", header: "updated", sort: (c) => Date.parse(c.updated_at) || 0, cell: (c) => <span className="text-slate-500">{c.updated_at ? ago(c.updated_at) : ""}</span> },
          ]} expand={(c) => (
            <div className="space-y-1 text-[11px] text-slate-300">
              <div className="mono break-all text-slate-400">{c.repo ? `${c.repo} · ` : ""}{c.source_branch} · head {String(c.head_sha).slice(0, 12)} · base {String(c.base_sha).slice(0, 12)} · {c.author}</div>
              {c.check ? <div>Check: {c.check.status} · {c.check.pass ?? "—"} passed · {c.check.fail ?? "—"} failed{c.check.typecheck ? ` · types ${c.check.typecheck.status}` : ""}{c.check.typecheck?.console_build ? ` · UI build ${c.check.typecheck.console_build}` : ""}</div> : <div className="text-slate-500">Not checked yet.</div>}
              {c.reasons?.length ? <ul className="space-y-0.5">{c.reasons.map((r: string, i: number) => <li key={i} className="mono break-words text-[10px] text-amber-200">{r}</li>)}</ul> : null}
              {c.changed_paths?.length ? <div className="mono break-words text-[10px] text-slate-500">{c.changed_paths.length} paths: {c.changed_paths.slice(0, 12).join(", ")}{c.changed_paths.length > 12 ? " …" : ""}</div> : null}
            </div>
          )} />
        </>)}
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">ADR-0012 phase 4, shadow: each pull request is checked on the Forge and given the verdict the Forge would give. GitHub still merges; merge parity counts the merges where both agree. Rows marked "forge" are branches pushed to the work repository platform-work (G4); they have no type-check source yet, so they stay pending.</p>
      </Panel>
      <Panel title="Deploy plan · shadow" icon={<Rocket className="h-3.5 w-3.5 text-amber-300" />}
        right={<Badge tone={planParity && planParity.consecutive >= planParity.target ? "green" : "slate"}>{planParity ? `plan parity ${planParity.consecutive}/${planParity.target}` : "—"}</Badge>}>
        {plans.loading && !plans.data ? <Skeleton /> : (
          <DataTable rows={planRows} rowKey={(p, i) => `${p.main_sha}-${i}`} maxHeight={320} empty="No deploy plan has been computed yet." columns={[
            { key: "sha", header: "main", cell: (p) => <span className="mono text-cyan-200">{String(p.main_sha).slice(0, 7)}</span> },
            { key: "forge", header: "Forge plan", className: "wrap", cell: (p) => <span className="text-slate-300">{unitsText(p.forge_units)}</span> },
            { key: "github", header: "GitHub plan", className: "wrap", cell: (p) => <span className="text-slate-400">{unitsText(p.github_units)}</span> },
            { key: "waits", header: "waiting", className: "wrap", cell: (p) => <span className="text-[10px] text-slate-500">{(p.forge_skipped ?? []).map((x: any) => `${x.unit}: ${String(x.reason).replace(/_/g, " ")}`).join(" · ") || "—"}</span> },
            { key: "agrees", header: "agrees", cell: (p) => p.agrees === null ? <span className="text-slate-600">—</span> : <Badge tone={p.agrees ? "green" : "red"}>{p.agrees ? "yes" : "no"}</Badge> },
            { key: "when", header: "when", cell: (p) => <span className="text-slate-500">{p.forge_at || p.github_at ? ago(p.forge_at ?? p.github_at) : ""}</span> },
          ]} />
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">For the same main commit and registry versions, the Forge computes the pending deploy units from Artifacts and the Orchestrator from GitHub. GitHub still decides.</p>
      </Panel>
      <Panel title="Forge checks" icon={<FlaskConical className="h-3.5 w-3.5 text-emerald-300" />}
        right={<Badge tone={parity && parity.consecutive >= parity.target ? "green" : "slate"}>{parity ? `parity ${parity.consecutive}/${parity.target}` : "—"}</Badge>}>
        {checks.loading && !checks.data ? <Skeleton /> : runs.length === 0 ? <Empty>No commit has been checked on the Forge yet.</Empty> : (<>
          <div className="mb-3 grid gap-3 lg:grid-cols-2">
            <div><div className="mb-1.5 text-[10px] uppercase tracking-widest text-slate-500">Tests per commit (newest first)</div>
              <BarList keepOrder max={10} series={[{ label: "passed", color: STATUS.good }, { label: "failed", color: STATUS.critical }]} items={runs.slice(0, 10).map((r: any) => ({
                label: String(r.commit).slice(0, 7), value: (r.pass ?? 0) + (r.fail ?? 0),
                parts: [{ key: "p", label: "passed", value: r.pass ?? 0, color: STATUS.good }, { key: "f", label: "failed", value: r.fail ?? 0, color: STATUS.critical }] }))} /></div>
            <div><div className="mb-1.5 text-[10px] uppercase tracking-widest text-slate-500">Run time per commit (newest first)</div>
              <BarList keepOrder max={10} unit=" s" items={runs.slice(0, 10).map((r: any) => ({ label: String(r.commit).slice(0, 7), value: r.duration_ms ? Math.round(r.duration_ms / 1000) : 0 }))} /></div>
          </div>
          <DataTable rows={runs} rowKey={(r) => r.commit} maxHeight={420} columns={[
            { key: "commit", header: "commit", cell: (r) => <span className="mono text-[11px] text-cyan-200">{String(r.commit).slice(0, 7)}</span> },
            { key: "status", header: "status", sort: (r) => r.status, cell: (r) => <Badge tone={CHECK_TONE[r.status] ?? "slate"}>{r.status}</Badge> },
            { key: "tests", header: "tests", align: "right", sort: (r) => r.fail ?? 0, cell: (r) => <span className="mono"><span className="text-slate-200">{r.pass ?? "—"}</span>{(r.fail ?? 0) > 0 ? <span className="text-rose-300"> / {r.fail} failed</span> : null}</span> },
            { key: "bundles", header: "bundles", align: "right", cell: (r) => r.bundles ? <span className="mono">{r.bundles.workers - r.bundles.failed}/{r.bundles.workers}</span> : <span className="text-slate-600">—</span> },
            { key: "types", header: "types", cell: (r) => !r.typecheck || r.typecheck.status === "not_configured" ? <span className="text-slate-600">—</span>
              : r.typecheck.status === "pending" ? <Badge tone="slate">pending</Badge>
              : (r.typecheck.errors ?? 0) > 0 || (r.typecheck.status === "failed" && !r.typecheck.console_build) ? <Badge tone="red">{`${r.typecheck.errors ?? "?"} errors`}</Badge> : <Badge tone="green">ok</Badge> },
            { key: "ui", header: "UI build", cell: (r) => r.typecheck?.console_build ? <Badge tone={r.typecheck.console_build === "passed" ? "green" : "red"}>{r.typecheck.console_build === "passed" ? "ok" : "failed"}</Badge> : <span className="text-slate-600">—</span> },
            { key: "secrets", header: "secrets", cell: (r) => r.guard_status ? <Badge tone={r.guard_status === "clean" ? "green" : "red"}>{r.guard_status === "clean" ? "none" : "found"}</Badge> : <span className="text-slate-600">—</span> },
            { key: "github", header: "GitHub CI", cell: (r) => <span className="text-[11px] text-slate-400">{r.github ?? "not reported"}{r.agrees === true ? " · agrees" : r.agrees === false ? " · disagrees" : ""}</span> },
            { key: "when", header: "when", sort: (r) => Date.parse(r.started_at) || 0, cell: (r) => <span className="text-slate-500">{r.started_at ? ago(r.started_at) : ""}{r.duration_ms ? ` · ${Math.round(r.duration_ms / 1000)} s` : ""}</span> },
          ]} expand={(r) => r.failures?.length ? (
            <ul className="space-y-1">{r.failures.map((f: string, i: number) => <li key={i} className="mono break-words text-[10px] leading-relaxed text-rose-200">{f}</li>)}</ul>
          ) : <p className="text-[11px] text-slate-500">No failures.</p>} />
        </>)}
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">The Forge runs the control-plane tests, bundles every Worker, type-checks on Workers Builds and scans for committed credentials, on Cloudflare, for each new commit of main, from the Artifacts copy. These checks become a deploy gate after they agree with GitHub CI on {parity?.target ?? 20} commits in a row (ADR-0012).</p>
      </Panel>
      <BuildMinutes data={buildUsage.data} loading={buildUsage.loading} />
      <DependencyAudit data={depAudit.data} loading={depAudit.loading} />
      <Panel title="History of main" icon={<GitCommitHorizontal className="h-3.5 w-3.5 text-violet-300" />} right={<Badge tone="slate">{rows.length} commits</Badge>}>
        {commits.loading && !commits.data ? <Skeleton /> : (
          <DataTable rows={rows} rowKey={(c, i) => c.sha || `${c.title}-${i}`} maxHeight={420} empty="No commits to show." columns={[
            { key: "sha", header: "commit", cell: (c) => <span className="mono text-[11px] text-cyan-200">{String(c.sha ?? "").slice(0, 7)}</span> },
            { key: "check", header: "Forge check", cell: (c) => bySha.get(c.sha) ? <Badge tone={CHECK_TONE[(bySha.get(c.sha) as any).status] ?? "slate"}>{(bySha.get(c.sha) as any).status}</Badge> : <span className="text-slate-600">—</span> },
            { key: "title", header: "title", className: "wrap", cell: (c) => <span className="text-slate-200">{c.title}</span> },
            { key: "author", header: "author", cell: (c) => <span className="text-[11px] text-slate-400">{c.author}</span> },
            { key: "when", header: "when", sort: (c) => Date.parse(c.date) || 0, cell: (c) => <span className="text-slate-500" title={c.date}>{c.date ? ago(c.date) : ""}</span> },
          ]} />
        )}
      </Panel>
    </div>
  );
}
