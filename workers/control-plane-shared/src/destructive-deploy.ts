/**
 * Cut-over gate (owner 2026-11-15, "1 setuju"): a pending D1 migration the Forge marks destructive (DESTRUCTIVE_SQL,
 * migration-rules.ts) deploys natively only through the owner's click, never as a routine deploy_commit.
 *
 * - The Supervisor proposes the consensus action `deploy_destructive_migration` (critical) instead of deploy_commit
 *   for the Control Plane unit when main's pending migrations include destructive ones. Its params name the commit
 *   and each destructive file with its sha256, so the owner approves exactly that SQL.
 * - After the click the Deployment Orchestrator queues one signed native request (destructive-deploy executor). At
 *   run time it plans the unit again with exactly the named files allowed; a destructive file the proposal does not
 *   name, or a named file whose SQL changed, refuses the deploy.
 * - Before the first migration it reads D1's current Time Travel bookmark, stores it in the request's details and
 *   in the audit event `deployment.restore_point_recorded`; a bookmark it cannot read refuses before any change.
 *   A failure reports the bookmark; D1 is never restored automatically (a restore is the owner's, OPERATIONS).
 *
 * Pure: no bindings, no I/O. Read by consensus-rules.ts (every voter), the Supervisor and the Orchestrator.
 */
import { MAX_NAMED_DESTRUCTIVE, MIGRATION_FILE_NAME } from "./break-glass.ts";

export const DESTRUCTIVE_DEPLOY_ACTION = "deploy_destructive_migration";
/** The only unit that applies D1 migrations (SSOT; native-deploy.ts MIGRATING_UNIT). */
export const DESTRUCTIVE_DEPLOY_UNIT = "control-plane";
/** The audit event that carries the Time Travel bookmark read before the first destructive migration. */
export const RESTORE_POINT_EVENT = "deployment.restore_point_recorded";
/** What CF_DEPLOY_TOKEN needs for the bookmark read (Cloudflare API: D1 database Time Travel, Get Bookmark). */
export const D1_BOOKMARK_PERMISSION = "Account → D1 → Read (D1 Edit also works) on CF_DEPLOY_TOKEN of cryptophys-deployment-orchestrator";
/** A D1 Time Travel bookmark, e.g. 00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683 (docs, 2026-11-06). */
export const D1_BOOKMARK = /^[0-9a-f]{1,32}(-[0-9a-f]{1,32}){2}-[0-9a-f]{1,64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export interface NamedDestructive { file: string; sha256: string }
export interface DestructiveDeployParams { commit_sha: string; unit: string; destructive_migrations: NamedDestructive[] }

/**
 * The params of a deploy_destructive_migration proposal, or the reason they are malformed: a full commit, the
 * Control Plane unit, and 1 to MAX_NAMED_DESTRUCTIVE distinct migration files (NNNN_name.sql), each with its
 * sha256, in file order.
 */
export function destructiveDeployParams(params: Record<string, unknown> | null | undefined): DestructiveDeployParams | { problem: string } {
  const p = params ?? {};
  const commit = typeof p.commit_sha === "string" ? p.commit_sha : "";
  if (!HEX40.test(commit)) return { problem: "commit_sha must be a full 40-hex SHA" };
  if (p.unit !== DESTRUCTIVE_DEPLOY_UNIT) return { problem: `only the ${DESTRUCTIVE_DEPLOY_UNIT} unit applies D1 migrations` };
  const raw = p.destructive_migrations;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_NAMED_DESTRUCTIVE) {
    return { problem: `destructive_migrations must name 1 to ${MAX_NAMED_DESTRUCTIVE} migration files` };
  }
  const files: NamedDestructive[] = [];
  for (const m of raw as Array<Record<string, unknown> | null>) {
    const file = typeof m?.file === "string" ? m.file : "";
    const sha256 = typeof m?.sha256 === "string" ? m.sha256 : "";
    if (!MIGRATION_FILE_NAME.test(file) || !HEX64.test(sha256)) return { problem: "each destructive migration needs a file (NNNN_name.sql) and its sha256" };
    files.push({ file, sha256 });
  }
  if (new Set(files.map((f) => f.file)).size !== files.length) return { problem: "destructive_migrations names a file twice" };
  if (files.some((f, i) => i > 0 && files[i - 1].file > f.file)) return { problem: "destructive_migrations must be in file order" };
  return { commit_sha: commit, unit: DESTRUCTIVE_DEPLOY_UNIT, destructive_migrations: files };
}

/** The lines the Owner page shows with the proposal (owner-inbox.ts reads params.changes). */
export function destructiveChanges(files: ReadonlyArray<NamedDestructive>): string[] {
  return files.map((f) => `apply destructive migration ${f.file} (sha256 ${f.sha256.slice(0, 12)}) after recording a D1 Time Travel bookmark`);
}

/** The owner's restore command for a recorded bookmark (OPERATIONS, "Restore the control-plane database"). */
export const restoreCommand = (bookmark: string) => `npx wrangler d1 time-travel restore cryptophys-control-plane --bookmark=${bookmark}`;
