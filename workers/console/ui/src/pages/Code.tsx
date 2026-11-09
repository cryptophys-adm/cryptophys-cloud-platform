import { FlaskConical, FolderGit2, GitCommitHorizontal, GitPullRequest, Rocket } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { ago, listOf } from "../lib/format";
import { usePoll } from "../lib/usePoll";

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
  const mergeParity = changes.data?.parity;
  const plans = usePoll(() => call("forge.deploy_plans", undefined, undefined, { limit: "8" }), 60_000);
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
            <div className="glass-inner px-3 py-2"><div className="text-[10px] uppercase tracking-widest text-slate-500">Repository</div><div className="mono break-all text-slate-200">cryptophys/{s.repo.name}</div></div>
            <div className="glass-inner px-3 py-2"><div className="text-[10px] uppercase tracking-widest text-slate-500">main</div><div className="mono break-all text-cyan-200">{String(s.head?.sha ?? "").slice(0, 12) || "—"}</div></div>
            <div className="glass-inner px-3 py-2"><div className="text-[10px] uppercase tracking-widest text-slate-500">Last change</div><div className="text-slate-200">{s.head?.date ? ago(s.head.date) : "—"}</div></div>
          </div>
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">GitHub is still the source of truth during the migration (ADR-0012). Every push to main is mirrored here with the same commit IDs.</p>
      </Panel>
      <Panel title="Change requests · shadow" icon={<GitPullRequest className="h-3.5 w-3.5 text-violet-300" />}
        right={<Badge tone={mergeParity && mergeParity.consecutive >= mergeParity.target ? "green" : "slate"}>{mergeParity ? `merge parity ${mergeParity.consecutive}/${mergeParity.target}` : "—"}</Badge>}>
        {changes.loading && !changes.data ? <Skeleton /> : crs.length === 0 ? <Empty>No pull request has been mirrored to the Forge yet.</Empty> : (
          <div className="space-y-1.5">
            {crs.map((c: any) => {
              const v = VERDICT[c.verdict] ?? { tone: "slate", label: c.verdict ?? "—" };
              return (
                <details key={c.cr_id} className="glass-inner px-3 py-2">
                  <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1">
                    <span className="mono text-[11px] text-violet-200">#{c.number}</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] text-slate-200">{c.title}</span>
                    <Badge tone={v.tone}>{c.status === "open" ? v.label : `${v.label} at ${c.status}`}</Badge>
                    {c.critical?.length ? <Badge tone="amber">owner path</Badge> : null}
                    {c.status === "merged" ? <Badge tone={c.agrees === true ? "green" : c.agrees === false ? "red" : "slate"}>{c.agrees === true ? "agrees" : c.agrees === false ? "disagrees" : "Forge late"}</Badge> : null}
                    <span className="text-[11px] text-slate-400">GitHub CI: {c.github_ci ?? "—"}</span>
                    <span className="ml-auto text-[10px] text-slate-500">{c.updated_at ? ago(c.updated_at) : ""}</span>
                  </summary>
                  <div className="mt-2 space-y-1 text-[11px] text-slate-300">
                    <div className="mono break-all text-slate-400">{c.source_branch} · head {String(c.head_sha).slice(0, 12)} · base {String(c.base_sha).slice(0, 12)} · {c.author}</div>
                    {c.check ? <div>Check: {c.check.status} · {c.check.pass ?? "—"} passed · {c.check.fail ?? "—"} failed{c.check.typecheck ? ` · types ${c.check.typecheck.status}` : ""}{c.check.typecheck?.console_build ? ` · UI build ${c.check.typecheck.console_build}` : ""}</div> : <div className="text-slate-500">Not checked yet.</div>}
                    {c.reasons?.length ? <ul className="space-y-0.5">{c.reasons.map((r: string, i: number) => <li key={i} className="mono break-words text-[10px] text-amber-200">{r}</li>)}</ul> : null}
                    {c.changed_paths?.length ? <div className="mono break-words text-[10px] text-slate-500">{c.changed_paths.length} paths: {c.changed_paths.slice(0, 12).join(", ")}{c.changed_paths.length > 12 ? " …" : ""}</div> : null}
                  </div>
                </details>
              );
            })}
          </div>
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">ADR-0012 phase 4, shadow: each pull request is checked on the Forge and given the verdict the Forge would give. GitHub still merges; merge parity counts the merges where both agree.</p>
      </Panel>
      <Panel title="Deploy plan · shadow" icon={<Rocket className="h-3.5 w-3.5 text-amber-300" />}
        right={<Badge tone={planParity && planParity.consecutive >= planParity.target ? "green" : "slate"}>{planParity ? `plan parity ${planParity.consecutive}/${planParity.target}` : "—"}</Badge>}>
        {plans.loading && !plans.data ? <Skeleton /> : planRows.length === 0 ? <Empty>No deploy plan has been computed yet.</Empty> : (
          <div className="space-y-1.5">
            {planRows.map((p: any, i: number) => (
              <div key={`${p.main_sha}-${i}`} className="glass-inner flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-[11px]">
                <span className="mono text-cyan-200">{String(p.main_sha).slice(0, 7)}</span>
                <span className="text-slate-300">Forge: {unitsText(p.forge_units)}</span>
                <span className="text-slate-400">GitHub: {unitsText(p.github_units)}</span>
                {p.agrees === null ? null : <Badge tone={p.agrees ? "green" : "red"}>{p.agrees ? "agrees" : "disagrees"}</Badge>}
                <span className="ml-auto text-[10px] text-slate-500">{p.forge_at || p.github_at ? ago(p.forge_at ?? p.github_at) : ""}</span>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">For the same main commit and registry versions, the Forge computes the pending deploy units from Artifacts and the Orchestrator from GitHub. GitHub still decides.</p>
      </Panel>
      <Panel title="Forge checks" icon={<FlaskConical className="h-3.5 w-3.5 text-emerald-300" />}
        right={<Badge tone={parity && parity.consecutive >= parity.target ? "green" : "slate"}>{parity ? `parity ${parity.consecutive}/${parity.target}` : "—"}</Badge>}>
        {checks.loading && !checks.data ? <Skeleton /> : runs.length === 0 ? <Empty>No commit has been checked on the Forge yet.</Empty> : (
          <div className="space-y-1.5">
            {runs.map((r: any) => (
              <details key={r.commit} className="glass-inner px-3 py-2">
                <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="mono text-[11px] text-cyan-200">{String(r.commit).slice(0, 7)}</span>
                  <Badge tone={CHECK_TONE[r.status] ?? "slate"}>{r.status}</Badge>
                  <span className="text-[12px] text-slate-200">{r.pass ?? "—"} passed · {r.fail ?? "—"} failed</span>
                  {r.bundles ? <span className="text-[11px] text-slate-400">bundles {r.bundles.workers - r.bundles.failed}/{r.bundles.workers}</span> : null}
                  {r.typecheck && r.typecheck.status !== "not_configured" ? (
                    r.typecheck.status === "pending" ? <Badge tone="slate">types pending</Badge>
                      : (r.typecheck.errors ?? 0) > 0 || (r.typecheck.status === "failed" && !r.typecheck.console_build)
                        ? <Badge tone="red">{`${r.typecheck.errors ?? "?"} type errors`}</Badge>
                        : <Badge tone="green">types ok</Badge>
                  ) : null}
                  {r.typecheck?.console_build ? (
                    <Badge tone={r.typecheck.console_build === "passed" ? "green" : "red"}>{r.typecheck.console_build === "passed" ? "UI build ok" : "UI build failed"}</Badge>
                  ) : null}
                  {r.guard_status ? <Badge tone={r.guard_status === "clean" ? "green" : "red"}>{r.guard_status === "clean" ? "no secrets" : "secret found"}</Badge> : null}
                  {r.ready ? <Badge tone="cyan">ready</Badge> : null}
                  <span className="text-[11px] text-slate-400">GitHub CI: {r.github ?? "not reported"}{r.agrees === true ? " · agrees" : r.agrees === false ? " · disagrees" : ""}</span>
                  <span className="ml-auto text-[10px] text-slate-500">{r.started_at ? ago(r.started_at) : ""}{r.duration_ms ? ` · ${Math.round(r.duration_ms / 1000)} s` : ""}</span>
                </summary>
                {r.failures?.length ? (
                  <ul className="mt-2 space-y-1">
                    {r.failures.map((f: string, i: number) => <li key={i} className="mono break-words text-[10px] leading-relaxed text-rose-200">{f}</li>)}
                  </ul>
                ) : <p className="mt-2 text-[11px] text-slate-500">No failures.</p>}
              </details>
            ))}
          </div>
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">The Forge runs the control-plane tests, bundles every Worker, type-checks on Workers Builds and scans for committed credentials, on Cloudflare, for each new commit of main, from the Artifacts copy. These checks become a deploy gate after they agree with GitHub CI on {parity?.target ?? 20} commits in a row (ADR-0012).</p>
      </Panel>
      <Panel title="History of main" icon={<GitCommitHorizontal className="h-3.5 w-3.5 text-violet-300" />} right={<Badge tone="slate">{rows.length} commits</Badge>}>
        {commits.loading && !commits.data ? <Skeleton /> : rows.length === 0 ? <Empty>No commits to show.</Empty> : (
          <div className="space-y-1.5">
            {rows.map((c: any) => (
              <div key={c.sha || c.title} className="glass-inner flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
                <span className="mono text-[11px] text-cyan-200">{String(c.sha ?? "").slice(0, 7)}</span>
                {bySha.get(c.sha) ? <Badge tone={CHECK_TONE[(bySha.get(c.sha) as any).status] ?? "slate"}>{(bySha.get(c.sha) as any).status}</Badge> : null}
                <span className="min-w-0 flex-1 break-words text-[12px] text-slate-200">{c.title}</span>
                <span className="text-[10px] text-slate-500">{c.author}{c.date ? ` · ${ago(c.date)}` : ""}</span>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
