// ADR-0012 G5: the read side of the Forge's dependency audit (workers/forge/src/dependency-audit.ts,
// migration 0051), shared by the Forge's GET /v1/forge/dependency-audit and the AI Kernel's owner notice
// `dependencies`. Read-only. Before migration 0051 exists it returns null.
import type { D1Database } from "./types.ts";

export const SEVERITIES = ["critical", "high", "moderate", "low", "info"] as const;
export type Severity = (typeof SEVERITIES)[number];
/** The owner hears of a dependency audit that has not succeeded for this long (three missed daily runs). */
export const DEPENDENCY_AUDIT_STALE_MS = 72 * 3_600_000;
/** What makes the owner notice open: a high or critical advisory in a Worker's or the Console UI's lockfile. */
export const NOTICE_SEVERITIES: ReadonlySet<string> = new Set(["critical", "high"]);

export interface DependencyAuditRun {
  run_id: string; main_sha: string; ran_at: string; status: "ok" | "failed";
  lockfiles: number; packages: number; advisories: number;
  critical: number; high: number; moderate: number; low: number; info: number; error: string | null;
}
export interface DependencyFinding {
  package: string; version: string; advisory_id: string; severity: Severity; title: string | null; url: string | null;
  vulnerable_versions: string | null; lockfiles: string[]; runtime: boolean;
}
export type DependencyAuditStatus = "no_data" | "stale" | "action_needed" | "failing" | "findings" | "clean";
export interface DependencyAudit {
  schema: "dependency-audit.v1";
  status: DependencyAuditStatus;
  /** No successful run within DEPENDENCY_AUDIT_STALE_MS (or none at all since the first run that old). */
  stale: boolean;
  /** The newest run, which may have failed. */
  latest_run: DependencyAuditRun | null;
  /** The newest successful run; `findings` are its findings. */
  last_ok_run: DependencyAuditRun | null;
  findings: DependencyFinding[];
  /** The advisory ids of `findings` that are high or critical in a runtime lockfile, sorted. */
  runtime_high_ids: string[];
  observed_at: string;
}

const RUN_COLUMNS = "run_id, main_sha, ran_at, status, lockfiles, packages, advisories, critical, high, moderate, low, info, error";
const SEVERITY_RANK: Record<string, number> = Object.fromEntries(SEVERITIES.map((s, i) => [s, i]));

/** The latest dependency audit, for the Console and the owner notice. Null before migration 0051. */
export async function dependencyAudit(db: D1Database, nowMs = Date.now()): Promise<DependencyAudit | null> {
  let latest: DependencyAuditRun | null; let lastOk: DependencyAuditRun | null; let oldest: { ran_at: string } | null;
  let rows: Array<Omit<DependencyFinding, "lockfiles" | "runtime"> & { lockfiles: string; runtime: number }> = [];
  try {
    latest = await db.prepare(`SELECT ${RUN_COLUMNS} FROM forge_dependency_audits ORDER BY ran_at DESC LIMIT 1`).first<DependencyAuditRun>() ?? null;
    lastOk = await db.prepare(`SELECT ${RUN_COLUMNS} FROM forge_dependency_audits WHERE status = 'ok' ORDER BY ran_at DESC LIMIT 1`).first<DependencyAuditRun>() ?? null;
    oldest = await db.prepare("SELECT ran_at FROM forge_dependency_audits ORDER BY ran_at ASC LIMIT 1").first<{ ran_at: string }>() ?? null;
    if (lastOk) {
      rows = (await db.prepare(
        "SELECT package, version, advisory_id, severity, title, url, vulnerable_versions, lockfiles, runtime FROM forge_dependency_findings WHERE run_id = ? LIMIT 500",
      ).bind(lastOk.run_id).all<Omit<DependencyFinding, "lockfiles" | "runtime"> & { lockfiles: string; runtime: number }>()).results ?? [];
    }
  } catch {
    return null;
  }
  const findings: DependencyFinding[] = rows.map((r) => {
    let lockfiles: string[] = [];
    try { const l = JSON.parse(r.lockfiles ?? "[]"); if (Array.isArray(l)) lockfiles = l.map(String); } catch { lockfiles = []; }
    return { ...r, lockfiles, runtime: r.runtime === 1 };
  }).sort((a, b) => (Number(b.runtime) - Number(a.runtime)) || (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9)
    || a.package.localeCompare(b.package) || a.version.localeCompare(b.version) || a.advisory_id.localeCompare(b.advisory_id));
  const runtimeHigh = [...new Set(findings.filter((f) => f.runtime && NOTICE_SEVERITIES.has(f.severity)).map((f) => f.advisory_id))].sort();
  const stale = latest !== null && (lastOk ? nowMs - Date.parse(lastOk.ran_at) > DEPENDENCY_AUDIT_STALE_MS : nowMs - Date.parse(oldest?.ran_at ?? "") > DEPENDENCY_AUDIT_STALE_MS);
  const status: DependencyAuditStatus = !latest ? "no_data" : stale ? "stale" : runtimeHigh.length ? "action_needed"
    : latest.status === "failed" ? "failing" : findings.length ? "findings" : "clean";
  return {
    schema: "dependency-audit.v1", status, stale, latest_run: latest, last_ok_run: lastOk, findings, runtime_high_ids: runtimeHigh,
    observed_at: new Date(nowMs).toISOString(),
  };
}
