// ADR-0012 gate 8 (§5m): the read side of the Forge's daily git bundle of cryptophys/platform in R2
// (workers/forge/src/git-backup.ts, migration 0054), for the Forge's GET /v1/forge/git-backup and the Console
// Code page. Read-only. Before migration 0054 exists it returns null. Nothing here holds or returns a token: the
// runs record hashes, sizes, refs and errors only.
//
// Owner 2026-11-13: the owner is contacted only for critical reports and approval requests. A stale backup
// (no success for GIT_BACKUP_STALE_MS) is shown on the Console only; it is not an owner notice and is never
// emailed or sent to Telegram.
import type { D1Database } from "./types.ts";

export const GIT_BACKUP_PREFIX = "git-backups/platform/";
/** R2 keeps the newest bundle of each of the last this-many UTC days that have one. */
export const GIT_BACKUP_RETAINED_DAYS = 30;
/** Run rows are kept this long, except a row whose bundle is still retained in R2. */
export const GIT_BACKUP_ROW_RETENTION_DAYS = 90;
/** The Console shows the backup as stale when no run has succeeded for this long. */
export const GIT_BACKUP_STALE_MS = 48 * 3_600_000;

export interface GitBackupRef { name: string; sha: string }
export interface GitBackupRun {
  run_id: string; main_sha: string; day: string; ran_at: string; status: "ok" | "failed";
  r2_key: string | null; bundle_sha256: string | null; bundle_bytes: number | null; pack_bytes: number | null;
  pack_sha1: string | null; pack_version: number | null; objects: number | null; refs: number | null;
  error: string | null; pruned_at: string | null;
}
export type GitBackupStatus = "no_data" | "stale" | "failing" | "ok";
export interface GitBackupView {
  schema: "git-backup.v1";
  status: GitBackupStatus;
  /** No successful run within GIT_BACKUP_STALE_MS (or none at all since the first run that old). */
  stale: boolean;
  /** The newest run, which may have failed. */
  latest_run: GitBackupRun | null;
  /** The newest successful run, with the refs its bundle holds. */
  last_ok_run: (GitBackupRun & { ref_list: GitBackupRef[] }) | null;
  /** The newest runs, newest first. */
  runs: GitBackupRun[];
  /** Successful runs whose bundle retention has not deleted. */
  retained_bundles: number;
  retained_days: number;
  stale_after_hours: number;
  observed_at: string;
}

const COLUMNS = "run_id, main_sha, day, ran_at, status, r2_key, bundle_sha256, bundle_bytes, pack_bytes, pack_sha1, pack_version, objects, refs, error, pruned_at";

/** The latest git backups. Null before migration 0054. */
export async function gitBackup(db: D1Database, nowMs = Date.now(), limit = 10): Promise<GitBackupView | null> {
  const n = Math.max(1, Math.min(50, Math.floor(limit) || 10));
  let runs: GitBackupRun[]; let lastOk: (GitBackupRun & { refs_json: string | null }) | null; let oldest: { ran_at: string } | null; let retained: { n: number } | null;
  try {
    runs = (await db.prepare(`SELECT ${COLUMNS} FROM forge_git_backups ORDER BY ran_at DESC LIMIT ?`).bind(n).all<GitBackupRun>()).results ?? [];
    lastOk = await db.prepare(`SELECT ${COLUMNS}, refs_json FROM forge_git_backups WHERE status = 'ok' ORDER BY ran_at DESC LIMIT 1`).first<GitBackupRun & { refs_json: string | null }>() ?? null;
    oldest = await db.prepare("SELECT ran_at FROM forge_git_backups ORDER BY ran_at ASC LIMIT 1").first<{ ran_at: string }>() ?? null;
    retained = await db.prepare("SELECT COUNT(*) AS n FROM forge_git_backups WHERE status = 'ok' AND pruned_at IS NULL").first<{ n: number }>() ?? null;
  } catch {
    return null;
  }
  const latest = runs[0] ?? null;
  let refList: GitBackupRef[] = [];
  if (lastOk) {
    try {
      const parsed = JSON.parse(lastOk.refs_json ?? "[]");
      if (Array.isArray(parsed)) refList = parsed.filter((r) => r && typeof r.name === "string" && typeof r.sha === "string").map((r) => ({ name: r.name, sha: r.sha }));
    } catch { refList = []; }
  }
  const stale = latest !== null && (lastOk ? nowMs - Date.parse(lastOk.ran_at) > GIT_BACKUP_STALE_MS : nowMs - Date.parse(oldest?.ran_at ?? "") > GIT_BACKUP_STALE_MS);
  const status: GitBackupStatus = !latest ? "no_data" : stale ? "stale" : latest.status === "failed" ? "failing" : "ok";
  const okRun = lastOk ? (({ refs_json: _r, ...rest }) => rest)(lastOk) : null;
  return {
    schema: "git-backup.v1", status, stale, latest_run: latest,
    last_ok_run: okRun ? { ...okRun, ref_list: refList } : null,
    runs, retained_bundles: Number(retained?.n ?? 0), retained_days: GIT_BACKUP_RETAINED_DAYS,
    stale_after_hours: GIT_BACKUP_STALE_MS / 3_600_000, observed_at: new Date(nowMs).toISOString(),
  };
}
