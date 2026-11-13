import { Archive } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "./ui";
import { DataTable, Stat } from "./viz";
import { ago } from "../lib/format";

/**
 * ADR-0012 gate 8: the off-Artifacts copy of the repository. Once per UTC day per head of main the Forge clones
 * cryptophys/platform over Git smart HTTP and writes it to R2 as a git bundle (GET /v1/forge/git-backup). Every
 * value comes from that response; a missing value is "—". A backup that has not succeeded for 48 hours is shown
 * here only (owner 2026-11-13: the owner is contacted for critical reports and approvals only).
 */
const STATUS_TONE: Record<string, "green" | "amber" | "red" | "slate"> = { ok: "green", failing: "amber", stale: "red", no_data: "slate" };
const STATUS_TEXT: Record<string, string> = { ok: "backed up", failing: "last run failed", stale: "stale", no_data: "not taken yet" };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? String(v) : "—");
const size = (v: unknown) => (typeof v === "number" && Number.isFinite(v)
  ? v >= 1048576 ? `${(v / 1048576).toFixed(1)} MiB` : v >= 1024 ? `${(v / 1024).toFixed(1)} KiB` : `${v} B` : "—");
const short = (v: unknown, n: number) => (typeof v === "string" && v ? v.slice(0, n) : "—");

export default function GitBackup({ data, loading }: { data: any; loading: boolean }) {
  const b = data?.backup;
  const ok = b?.last_ok_run;
  const latest = b?.latest_run;
  const runs: any[] = Array.isArray(b?.runs) ? b.runs : [];
  return (
    <Panel title="Repository backup · git bundle in R2" icon={<Archive className="h-3.5 w-3.5 text-emerald-300" />}
      right={<Badge tone={STATUS_TONE[b?.status] ?? "slate"}>{b ? STATUS_TEXT[b.status] ?? b.status : "—"}</Badge>}>
      {loading && !data ? <Skeleton rows={3} /> : !b ? <Empty>The Forge has not recorded a git backup yet (migration 0054 is missing).</Empty> : (
        <div className="flex flex-col gap-3">
          {b.stale ? (
            <p className="text-[11px] text-rose-200">No git backup has succeeded for {num(b.stale_after_hours)} hours{latest?.status === "failed" && latest.error ? `; latest error: ${latest.error}` : ""}.</p>
          ) : null}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <Stat label="Last bundle" value={ok ? ago(ok.ran_at) : "never"} tone={b.stale ? "critical" : ok ? "good" : undefined}
              sub={ok ? `main ${short(ok.main_sha, 12)}` : "—"} />
            <Stat label="SHA-256" value={<span className="mono text-[12px]" title={ok?.bundle_sha256 ?? ""}>{short(ok?.bundle_sha256, 16)}</span>}
              sub={ok ? `pack SHA-1 ${short(ok.pack_sha1, 12)}` : "—"} />
            <Stat label="Size" value={ok ? size(ok.bundle_bytes) : "—"} sub={ok ? `${num(ok.objects)} objects · ${num(ok.refs)} branches` : "—"} />
            <Stat label="Retained" value={num(b.retained_bundles)} sub={`newest per day, last ${num(b.retained_days)} days`} />
          </div>
          {latest && latest.status === "failed" ? (
            <p className="mono break-words text-[10px] leading-relaxed text-amber-200">Latest run {ago(latest.ran_at)} failed: {latest.error ?? "—"}</p>
          ) : null}
          {runs.length > 0 ? (
            <DataTable rows={runs} rowKey={(r) => r.run_id} maxHeight={240} columns={[
              { key: "day", header: "day", cell: (r) => <span className="mono text-[11px] text-slate-300">{r.day ?? "—"}</span> },
              { key: "main", header: "main", cell: (r) => <span className="mono text-[11px] text-cyan-200">{short(r.main_sha, 7)}</span> },
              { key: "status", header: "status", cell: (r) => <Badge tone={r.status === "ok" ? (r.pruned_at ? "slate" : "green") : "red"}>{r.status === "ok" ? (r.pruned_at ? "pruned" : "ok") : "failed"}</Badge> },
              { key: "size", header: "size", cell: (r) => <span className="text-[11px] text-slate-400">{size(r.bundle_bytes)}</span> },
              { key: "sha", header: "SHA-256", className: "wrap", cell: (r) => <span className="mono break-all text-[10px] text-slate-500" title={r.error ?? r.bundle_sha256 ?? ""}>{r.status === "ok" ? short(r.bundle_sha256, 16) : (r.error ?? "—")}</span> },
              { key: "when", header: "when", sort: (r) => Date.parse(r.ran_at) || 0, cell: (r) => <span className="text-slate-500" title={r.ran_at}>{ago(r.ran_at)}</span> },
            ]} />
          ) : null}
          <p className="text-[10px] leading-relaxed text-slate-500">
            The Forge clones the Artifacts repository over Git smart HTTP with a short-lived read token and stores the result as a git bundle in R2, the copy that remains when GitHub is archived. Restore: download the bundle, run git bundle verify on it, then git clone it into a new directory.
          </p>
        </div>
      )}
    </Panel>
  );
}
