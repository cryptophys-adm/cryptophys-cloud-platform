import { FolderGit2, GitCommitHorizontal } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { ago, listOf } from "../lib/format";
import { usePoll } from "../lib/usePoll";

// ADR-0012 phase 1b: the platform source on the Forge (Cloudflare Artifacts), read-only.
export default function Code() {
  const status = usePoll(() => call("forge.status"), 60_000);
  const commits = usePoll(() => call("forge.commits", undefined, undefined, { limit: "30" }), 60_000);
  const s = status.data;
  const rows = listOf(commits.data, "commits");
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
      <Panel title="History of main" icon={<GitCommitHorizontal className="h-3.5 w-3.5 text-violet-300" />} right={<Badge tone="slate">{rows.length} commits</Badge>}>
        {commits.loading && !commits.data ? <Skeleton /> : rows.length === 0 ? <Empty>No commits to show.</Empty> : (
          <div className="space-y-1.5">
            {rows.map((c: any) => (
              <div key={c.sha || c.title} className="glass-inner flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
                <span className="mono text-[11px] text-cyan-200">{String(c.sha ?? "").slice(0, 7)}</span>
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
