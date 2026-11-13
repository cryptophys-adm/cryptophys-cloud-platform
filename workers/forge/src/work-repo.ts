// ADR-0012 G4 (§5j): contributors push to Artifacts instead of opening GitHub pull requests.
//
// The work repository cryptophys/platform-work is a fork of platform (§1: "holding all branches by people and
// agents"). Contributors push branches there with a repo-scoped write token the owner creates; the Forge
// never writes it. Two pieces live here:
//   - ensureWorkRepo, behind the approver-only POST /v1/forge/work-repo {confirm: "CREATE"}: forks platform
//     into platform-work once (default branch only) and reports the repo name and its remote host, never a
//     token. 202 while the fork is in progress, 200 once it is ready. Audited as forge.work_repo.
//   - workBranchesTick, a Forge tick step: a read token (120 s) for platform-work, Git smart-HTTP ref
//     discovery (upload-pack, merge.ts's pkt-line parser), and for each branch cr/…, claude/… or agent/…
//     a change request fg-<branch slug> with source 'forge' and repo 'platform-work':
//       - base = canonical platform main's head, when it is an ancestor of the branch head (read through
//         platform-work, which holds the fork's objects and every push). Otherwise blocked_reason =
//         not_based_on_main: the branch must contain main so that a later merge (G3b) is a fast-forward;
//       - changed paths and owner-only reasons from the same tree diff as GitHub-sourced requests;
//       - a branch that disappeared closes its request, with the verdict at that moment frozen.
// Discovery that fails changes nothing (no request is closed on a failed read). The token goes only into the
// Authorization header and is never logged, stored, audited or returned.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { checkOf, type ArtifactsReader } from "./checks.ts";
import { changedPaths, changeVerdict, criticalReasons, MAX_PATHS_STORED, type ChangeRow } from "./changes.ts";
import { CANONICAL_REPO, discoverRefs, isAncestor, refHead, repoStatus, trustedRemoteFor, validBranch, type Fetch } from "./merge.ts";

export const WORK_REPO = "platform-work";
export const WORK_READ_TOKEN_TTL_S = 120;
/** The branches the Forge registers; anything else in the work repository is ignored. */
export const WORK_BRANCH = /^(cr|claude|agent)\/[A-Za-z0-9._/-]{1,80}$/;
/** Registrations (tree diffs and ancestry walks) per tick; the rest wait for the next tick. */
export const MAX_REGISTRATIONS_PER_TICK = 5;
const ACTOR = "system:forge-work";

/** fg-<branch with "/" → "-">, at most 100 characters of slug. */
export function workChangeId(branch: string): string {
  return `fg-${branch.replace(/\//g, "-").slice(0, 100)}`;
}

export function workBranchAllowed(branch: string): boolean {
  return WORK_BRANCH.test(branch) && validBranch(branch);
}

function remoteHost(remote: string): string | null {
  try { return new URL(remote).hostname; } catch { return null; }
}

// ---------------------------------------------------------------- POST /v1/forge/work-repo

interface WorkRepoHandle {
  info(): Promise<{ remote: string } | null>;
  fork?(name: string, opts?: { description?: string; readOnly?: boolean; defaultBranchOnly?: boolean }): Promise<unknown>;
  [Symbol.dispose]?(): void;
}
export interface WorkRepoBinding {
  list(opts?: { limit?: number; cursor?: string }): Promise<{ repos: Array<{ name: string; status: string }>; cursor?: string | null }>;
  get(name: string): Promise<WorkRepoHandle>;
}
export interface WorkRepoResult { outcome: "ready" | "forking" | "failed"; repo: string; source: string; forked: boolean; remote_host: string | null; reason?: string }

/** Fork platform into platform-work once; idempotent. Never returns or audits a token (fork's result is dropped). */
export async function ensureWorkRepo(env: { DB: D1Database; ARTIFACTS?: WorkRepoBinding }, actor: string): Promise<WorkRepoResult> {
  if (!env.ARTIFACTS) throw Object.assign(new Error("artifacts_not_configured"), { status: 503 });
  const binding = env.ARTIFACTS;
  let forked = false;
  const done = async (outcome: WorkRepoResult["outcome"], remote_host: string | null, reason?: string): Promise<WorkRepoResult> => {
    const result: WorkRepoResult = { outcome, repo: WORK_REPO, source: CANONICAL_REPO, forked, remote_host, ...(reason ? { reason } : {}) };
    await appendAuditEvent(env.DB, { event_type: "forge.work_repo", actor, subject: WORK_REPO, outcome, payload: { ...result } });
    return result;
  };
  let state = await repoStatus(binding, WORK_REPO);
  if (state === "missing") {
    if ((await repoStatus(binding, CANONICAL_REPO)) !== "ready") return done("failed", null, "source_not_ready");
    const source = await binding.get(CANONICAL_REPO);
    try {
      if (typeof source.fork !== "function") return done("failed", null, "fork_unavailable");
      try {
        await source.fork(WORK_REPO, { description: "ADR-0012 G4 work repository: contributor branches (cr/, claude/, agent/)", defaultBranchOnly: true, readOnly: false });
      } catch {
        return done("failed", null, "fork_failed");
      }
      forked = true;
    } finally {
      source[Symbol.dispose]?.();
    }
    state = await repoStatus(binding, WORK_REPO);
  }
  if (state !== "ready") return done("forking", null, state === "missing" ? "fork_not_listed" : undefined);
  const repo = await binding.get(WORK_REPO);
  try {
    const remote = (await repo.info())?.remote ?? "";
    if (!trustedRemoteFor(remote, WORK_REPO)) return done("failed", null, "untrusted_remote");
    return done("ready", remoteHost(remote));
  } finally {
    repo[Symbol.dispose]?.();
  }
}

// ---------------------------------------------------------------- branch discovery (tick step)

export interface WorkReader extends ArtifactsReader {
  info?(): Promise<{ remote: string } | null>;
  createToken?(scope?: "read" | "write", ttl?: number): Promise<{ plaintext: string; expiresAt: string | number }>;
}
export interface WorkTickEnv {
  DB: D1Database;
  ARTIFACTS?: { get(name: string): Promise<WorkReader>; list?: WorkRepoBinding["list"] };
}

const printable = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[^\x20-\x7e]/g, "?").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Title and author name of a commit record from the binding (the e-mail is not kept). */
function describe(commit: Record<string, unknown> | null, branch: string): { title: string; author: string } {
  const message = printable(String(commit?.message ?? "").split("\n")[0], 200);
  const a = commit?.author;
  const name = printable(a && typeof a === "object" ? (a as Record<string, unknown>).name : a, 100);
  return { title: message || branch, author: name || "unknown" };
}

type ForgeRow = Pick<ChangeRow, "cr_id" | "branch" | "head_sha" | "base_sha" | "status" | "created_at" | "critical" | "blocked_reason">;

async function registerWorkChange(db: D1Database, repo: WorkReader, p: { id: string; branch: string; head: string; main: string; existing: ForgeRow | undefined }, nowMs: number): Promise<{ registered: boolean; blocked: boolean }> {
  const commit = await repo.readCommit(p.head) as Record<string, unknown> | null;
  if (!commit) return { registered: false, blocked: false }; // the push is not readable through the binding yet
  // main's head must be readable in platform-work (pushed with the branch) before the ancestry walk is worth it.
  const based = Boolean(await repo.readCommit(p.main)) && await isAncestor(repo, p.main, p.head);
  let paths: string | null = null;
  let critical: string | null = null;
  if (based) {
    const { changes, truncated } = await changedPaths(repo, p.main, p.head);
    paths = JSON.stringify(changes.slice(0, MAX_PATHS_STORED).map((c) => `${c.change[0].toUpperCase()} ${c.path}`));
    critical = JSON.stringify(await criticalReasons(repo, changes, truncated));
  }
  const blocked = based ? null : "not_based_on_main";
  const { title, author } = describe(commit, p.branch);
  const now = new Date(nowMs).toISOString();
  await db.prepare(
    `INSERT INTO forge_change_requests (cr_id, source, number, branch, source_branch, title, author, head_sha, base_sha, github_ci, status, changed_paths, critical, created_at, updated_at, repo, blocked_reason)
     VALUES (?, 'forge', 0, ?, ?, ?, ?, ?, ?, NULL, 'open', ?, ?, ?, ?, 'platform-work', ?)
     ON CONFLICT(cr_id) DO UPDATE SET branch = excluded.branch, source_branch = excluded.source_branch, title = excluded.title, author = excluded.author,
       head_sha = excluded.head_sha, base_sha = excluded.base_sha, status = 'open', changed_paths = excluded.changed_paths, critical = excluded.critical,
       blocked_reason = excluded.blocked_reason, verdict_at_outcome = NULL, merge_sha = NULL, agrees = NULL, outcome_at = NULL, updated_at = excluded.updated_at
     WHERE forge_change_requests.source = 'forge'`,
  ).bind(p.id, p.branch, p.branch, title, author, p.head, p.main, paths, critical, p.existing?.created_at ?? now, now, blocked).run();
  const outcome = !p.existing || p.existing.status !== "open" ? "opened" : p.existing.head_sha !== p.head ? "head_changed" : "base_changed";
  await appendAuditEvent(db, {
    event_type: "forge.change_registered", actor: ACTOR, subject: p.id, outcome,
    payload: { source: "forge", repo: WORK_REPO, branch: p.branch, head_sha: p.head, base_sha: p.main, blocked_reason: blocked, critical: critical ? JSON.parse(critical).length : null },
  });
  return { registered: true, blocked: Boolean(blocked) };
}

/** One tick of branch discovery on platform-work. Throws only for an infrastructure failure (audited by the tick). */
export async function workBranchesTick(env: WorkTickEnv, nowMs = Date.now(), fetchImpl: Fetch = (i, init) => fetch(i, init)): Promise<Record<string, unknown>> {
  const binding = env.ARTIFACTS;
  if (!binding || typeof binding.list !== "function") return { outcome: "not_configured" };
  // The binding is a Workers RPC stub: every property of `binding.list` (bind, call, apply) is a remote method name,
  // so the only safe use is calling it as a method of the binding, which repoStatus does. `.bind` failed every tick
  // from 2026-11-13 08:20 and `.call` from 12:34 ("The RPC receiver does not implement the method ...").
  const state = await repoStatus(binding as Pick<WorkRepoBinding, "list">, WORK_REPO);
  if (state !== "ready") return { outcome: "no_work_repo", status: state };

  const canonical = await binding.get(CANONICAL_REPO);
  let main: string | null;
  try { main = await refHead(canonical, "main"); } finally { canonical[Symbol.dispose]?.(); }
  if (!main) return { outcome: "no_main" };

  const repo = await binding.get(WORK_REPO);
  try {
    const remote = (await repo.info?.())?.remote ?? "";
    if (!trustedRemoteFor(remote, WORK_REPO)) throw new Error("untrusted_work_remote");
    if (typeof repo.createToken !== "function") throw new Error("token_unavailable");
    const token = await repo.createToken("read", WORK_READ_TOKEN_TTL_S);
    const discovered = await discoverRefs(remote, token.plaintext, fetchImpl, "git-upload-pack");
    if (!discovered.ok) throw new Error(`work_discovery_failed:${discovered.reason}`);

    const branches = new Map<string, string>();
    let ignored = 0;
    for (const [ref, sha] of discovered.adv.refs) {
      if (!ref.startsWith("refs/heads/")) continue;
      const name = ref.slice("refs/heads/".length);
      if (name === "main") continue;
      if (workBranchAllowed(name)) branches.set(name, sha); else ignored++;
    }

    const rows = (await env.DB.prepare("SELECT cr_id, branch, head_sha, base_sha, status, created_at, critical, blocked_reason FROM forge_change_requests WHERE source = 'forge'").all<ForgeRow>()).results ?? [];
    const byId = new Map(rows.map((r) => [r.cr_id, r]));
    const taken = new Map<string, string>();
    const registered: string[] = []; const collisions: string[] = []; const unreadable: string[] = [];
    let deferred = 0; let blocked = 0;
    for (const [branch, head] of [...branches].sort(([a], [b]) => a.localeCompare(b))) {
      const id = workChangeId(branch);
      const existing = byId.get(id);
      // Two branches with the same slug (claude/a/b and claude/a-b): the one already registered keeps the id.
      const owner = existing && existing.status === "open" && existing.branch !== branch && branches.has(existing.branch) ? existing.branch : taken.get(id);
      if (owner && owner !== branch) { collisions.push(branch); continue; }
      taken.set(id, branch);
      if (existing && existing.status === "open" && existing.branch === branch && existing.head_sha === head && existing.base_sha === main) continue;
      if (registered.length >= MAX_REGISTRATIONS_PER_TICK) { deferred++; continue; }
      const r = await registerWorkChange(env.DB, repo, { id, branch, head, main, existing }, nowMs);
      if (!r.registered) { unreadable.push(branch); continue; }
      registered.push(id);
      if (r.blocked) blocked++;
    }

    // A branch that disappeared closes its request, with the verdict at that moment frozen next to it.
    const closed: string[] = [];
    const now = new Date(nowMs).toISOString();
    for (const r of rows) {
      if (r.status !== "open" || branches.has(r.branch)) continue;
      const critical = r.critical === null ? null : JSON.parse(r.critical) as string[];
      const { verdict } = changeVerdict(r, await checkOf(env.DB, r.head_sha), critical, nowMs);
      const res = await env.DB.prepare("UPDATE forge_change_requests SET status = 'closed', verdict_at_outcome = ?, outcome_at = ?, updated_at = ? WHERE cr_id = ? AND status = 'open' AND source = 'forge'")
        .bind(verdict, now, now, r.cr_id).run();
      if ((res.meta?.changes ?? 0) === 0) continue;
      closed.push(r.cr_id);
      await appendAuditEvent(env.DB, { event_type: "forge.change_outcome", actor: ACTOR, subject: r.cr_id, outcome: "closed", payload: { source: "forge", reason: "branch_deleted", branch: r.branch, verdict, head_sha: r.head_sha } });
    }
    return { outcome: "discovered", main, branches: branches.size, ignored, registered, blocked, deferred, closed, collisions, unreadable };
  } finally {
    repo[Symbol.dispose]?.();
  }
}
