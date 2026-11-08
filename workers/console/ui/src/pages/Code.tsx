import { FlaskConical, FolderGit2, GitCommitHorizontal } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { ago, listOf } from "../lib/format";
import { usePoll } from "../lib/usePoll";

const CHECK_TONE: Record<string, "green" | "red" | "amber" | "slate"> = { passed: "green", failed: "red", error: "amber", running: "slate" };

// ADR-0012: the platform source on the Forge (Cloudflare Artifacts), read-only, and the Forge checks
// of each commit next to GitHub CI (phase 3).
export default function Code() {
  const status = usePoll(() => call("forge.status"), 60_000);
  const commits = usePoll(() => call("forge.commits", undefined, undefined, { limit: "30" }), 60_000);
  const checks = usePoll(() => call("forge.checks", undefined, undefined, { limit: "20" }), 60_000);
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
                  {r.guard_status ? <Badge tone={r.guard_status === "clean" ? "green" : "red"}>{r.guard_status === "clean" ? "no secrets" : "secret found"}</Badge> : null}
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
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">The Forge runs the control-plane tests, bundles every Worker and scans for committed credentials, on Cloudflare, for each new commit of main, from the Artifacts copy. These checks become a deploy gate after they agree with GitHub CI on {parity?.target ?? 20} commits in a row (ADR-0012).</p>
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
