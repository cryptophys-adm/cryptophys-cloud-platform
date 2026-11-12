// ADR-0012 phase 4, shadow: change requests. While GitHub is still the source of truth, every
// same-repository pull request is mirrored here as change request gh-<number>
// (.github/workflows/forge-change-request.yml): its head is pushed to the Artifacts branch
// cr/<number>, the Forge checks that head like a commit of main, and computes the merge verdict it
// would give under ADR §2.4:
//   - pending      the checks, the type-check or the Console build of the head have not finished;
//   - blocked      a check failed, a secret was found, or the type-check / Console build failed;
//   - needs_owner  everything passed, but the change touches a path that stays with the owner;
//   - would_merge  everything passed and the change is routine (an agent-consensus merge).
// When GitHub merges or closes the pull request (mirror-to-forge.yml), the verdict at that moment is
// frozen next to the outcome. A GitHub merge agrees when the Forge would have merged it (or asked
// the owner), and disagrees when the Forge had blocked it. The Forge merges nothing in this phase.
//
// ADR-0012 G4 (§5j): change requests also come from branches pushed to the work repository
// cryptophys/platform-work (work-repo.ts), as fg-<branch slug> with source 'forge'. Each row names the
// repository its head is read from (`repo`, migration 0052): 'platform' for gh-<number>, 'platform-work'
// for fg-<slug>. A forge-sourced head that does not contain canonical main has blocked_reason
// not_based_on_main and is not checked until the contributor updates the branch.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { checkOf, isReady, STALE_RUN_MS, type ArtifactsReader, type ArtifactsTreeEntry, type CheckSummary } from "./checks.ts";

const HEX40 = /^[0-9a-f]{40}$/;
export const MERGE_PARITY_TARGET = 10;
export const MAX_CHANGED_PATHS = 2_000;
export const MAX_PATHS_STORED = 500;
/** The repository a change request's head is read from (migration 0052). */
export type ChangeRepo = "platform" | "platform-work";

export type Verdict = "would_merge" | "needs_owner" | "blocked" | "pending";
export interface Change { path: string; change: "added" | "modified" | "deleted"; base?: string; head?: string }

function bad(code: string, status = 400): Error & { status: number } { return Object.assign(new Error(code), { status }); }

// ---------------------------------------------------------------------------------------------
// Changed paths: a tree diff that only descends into subtrees whose hashes differ.

async function treeOf(repo: ArtifactsReader, commit: string): Promise<string> {
  const c = await repo.readCommit(commit);
  if (!c) throw bad("commit_not_mirrored", 409);
  return c.treeHash;
}

export async function changedPaths(repo: ArtifactsReader, baseSha: string, headSha: string, limit = MAX_CHANGED_PATHS): Promise<{ changes: Change[]; truncated: boolean }> {
  const changes: Change[] = [];
  let truncated = false;
  const isTree = (e: ArtifactsTreeEntry | undefined) => e?.type === "tree";
  async function walk(base: string | null, head: string | null, prefix: string): Promise<void> {
    if (truncated || base === head) return;
    const [b, h] = await Promise.all([base ? repo.readTree(base) : Promise.resolve([]), head ? repo.readTree(head) : Promise.resolve([])]);
    const bm = new Map((b ?? []).map((e) => [e.name, e]));
    const hm = new Map((h ?? []).map((e) => [e.name, e]));
    for (const name of [...new Set([...bm.keys(), ...hm.keys()])].sort()) {
      if (truncated) return;
      const be = bm.get(name); const he = hm.get(name);
      if (be && he && be.hash === he.hash && be.type === he.type) continue;
      const path = prefix + name;
      if (isTree(be) || isTree(he)) {
        await walk(isTree(be) ? be!.hash : null, isTree(he) ? he!.hash : null, path + "/");
        // A file replaced by a directory (or the reverse): the file side is its own change.
        if (be && !isTree(be)) changes.push({ path, change: "deleted", base: be.hash });
        if (he && !isTree(he)) changes.push({ path, change: "added", head: he.hash });
      } else {
        changes.push(be && he ? { path, change: "modified", base: be.hash, head: he.hash } : be ? { path, change: "deleted", base: be.hash } : { path, change: "added", head: he!.hash });
      }
      if (changes.length > limit) { truncated = true; changes.length = limit; }
    }
  }
  await walk(await treeOf(repo, baseSha), await treeOf(repo, headSha), "");
  return { changes, truncated };
}

// ---------------------------------------------------------------------------------------------
// ADR §2.4: changes that stay with the owner (a merge needs the owner's click, never consensus).

const CRITICAL_PATHS: Array<[RegExp, string]> = [
  [/^workers\/control-plane-shared\/src\/access\.ts$/, "auth_access"],
  [/^\.github\/workflows\/provision-access\.yml$/, "auth_access"],
  [/^\.github\/scripts\/(access-[a-z-]+|resolve-access|find-service-token|find-agent-service-tokens|bootstrap-private-worker)\.sh$/, "auth_access"],
  [/^workers\/policy-engine\//, "policy_engine"],
  [/^workers\/control-plane-shared\/src\/consensus-(rules|exec|vote)\.ts$/, "consensus_kill_switch"],
  [/^\.github\/scripts\/remove-worker-secrets\.sh$/, "secrets"],
  [/^workers\/control-plane-shared\/src\/secrets\.ts$/, "secrets"],
  [/^architecture\/adr\/00(09|12)-/, "adr_0009_0012"],
  // ADR-0012 §5d: a change request's type-check runs its own code, so a change to the harness is the owner's.
  [/^workers\/forge-typecheck(-cr)?\//, "typecheck_harness"],
  [/^workers\/(control-plane-tsconfig\.json|forge\/src\/cr-builds\.ts)$/, "typecheck_harness"],
  [/^workers\/(control-plane-shared|console\/ui)\/(package(-lock)?\.json|tsconfig[^/]*\.json|vite\.config\.[a-z]+)$/, "typecheck_harness"],
];
const MIGRATION = /^workers\/control-plane-migrations\/[^/]+\.sql$/;
const DESTRUCTIVE_SQL = /\b(DROP\s+(TABLE|COLUMN|INDEX|VIEW|TRIGGER)|DELETE\s+FROM|UPDATE\s+[A-Za-z_][A-Za-z0-9_]*\s+SET|ALTER\s+TABLE\s+[A-Za-z_][A-Za-z0-9_]*\s+(RENAME|DROP))\b/i;
const SECRET_OPS = /wrangler\s+secret\s+(put|delete|bulk)|secrets[_-]store/i;
const SECRET_FILES = /^(\.github\/(workflows|scripts)\/[^/]+\.(ya?ml|sh)|workers\/[^/]+\/wrangler(\.[a-z]+)?\.toml)$/;
const TEST_FILE = /\.test\.(ts|mjs|sh)$/;
/** node:test assertions, and the `|| fail` checks of the shell tests. */
const ASSERTION = /\bassert(?:\.[A-Za-z]+)?\s*\(|\|\|\s*fail\b/g;

const stripSqlComments = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;

async function text(repo: ArtifactsReader, hash: string | undefined): Promise<string> {
  if (!hash) return "";
  const blob = await repo.readBlob(hash);
  return blob ? await blob.text() : "";
}

/** The owner-only reasons a change touches, as "reason: path". Empty for a routine change. */
export async function criticalReasons(repo: ArtifactsReader, changes: Change[], truncated: boolean): Promise<string[]> {
  const reasons = new Set<string>();
  if (truncated) reasons.add(`too_many_changes: more than ${MAX_CHANGED_PATHS} paths`);
  for (const c of changes) {
    for (const [re, reason] of CRITICAL_PATHS) if (re.test(c.path)) reasons.add(`${reason}: ${c.path}`);
    if (MIGRATION.test(c.path)) {
      if (c.change !== "added") reasons.add(`migration_rewritten: ${c.path}`);
      else if (DESTRUCTIVE_SQL.test(stripSqlComments(await text(repo, c.head)))) reasons.add(`migration_drops_or_rewrites_data: ${c.path}`);
    }
    if (SECRET_FILES.test(c.path) && c.change !== "deleted") {
      const [before, after] = await Promise.all([text(repo, c.base), text(repo, c.head)]);
      if (SECRET_OPS.test(after) || SECRET_OPS.test(before)) reasons.add(`secrets: ${c.path}`);
    }
    if (TEST_FILE.test(c.path)) {
      if (c.change === "deleted") reasons.add(`test_removed: ${c.path}`);
      else if (c.change === "modified") {
        const [before, after] = await Promise.all([text(repo, c.base), text(repo, c.head)]);
        const b = count(before, ASSERTION); const a = count(after, ASSERTION);
        if (a < b) reasons.add(`test_assertions_removed: ${c.path} (${b} -> ${a})`);
      }
    }
  }
  return [...reasons].sort();
}

// ---------------------------------------------------------------------------------------------
// Verdict

export const TYPECHECK_NOT_CONFIGURED = "no type-check source for this head: change requests pushed to platform-work have none yet (ADR-0012 §5j)";
export const NOT_BASED_ON_MAIN = "not_based_on_main: the head does not contain canonical main; merge or rebase main into the branch and push again";

export function verdictOf(check: CheckSummary | null, critical: string[] | null, nowMs = Date.now()): { verdict: Verdict; reasons: string[] } {
  if (!check || (check.status === "running" && Date.parse(check.started_at) > nowMs - STALE_RUN_MS)) return { verdict: "pending", reasons: ["checks have not finished"] };
  const reasons: string[] = [];
  if (check.status === "error" || check.status === "running") reasons.push("the check run did not complete");
  if (check.fail) reasons.push(`${check.fail} tests failed`);
  if (check.bundles?.failed) reasons.push(`${check.bundles.failed} bundles failed`);
  if (check.guard_status && check.guard_status !== "clean") reasons.push("secret scan found a secret");
  if (check.typecheck?.status === "failed") reasons.push(check.typecheck.console_build === "failed" && !check.typecheck.errors ? "the Console build failed" : "the type-check failed");
  if (check.status === "failed" && reasons.length === 0) reasons.push("the check failed");
  if (reasons.length) return { verdict: "blocked", reasons };
  // G4: a head from platform-work has no type-check source yet (the secret-free build reads cr/<n> of platform).
  // It stays pending, so a forge-sourced change request cannot reach would_merge until one exists (G3b needs it).
  if (check.typecheck?.status === "not_configured") return { verdict: "pending", reasons: [TYPECHECK_NOT_CONFIGURED] };
  if (!check.typecheck || check.typecheck.status !== "passed") return { verdict: "pending", reasons: ["the type-check of this head has not reported"] };
  if (check.typecheck.console_build !== "passed") return { verdict: "pending", reasons: ["the Console build of this head has not reported"] };
  if (critical === null) return { verdict: "pending", reasons: ["changed paths not computed"] };
  if (!isReady(check.status, check.guard_status, check.typecheck)) return { verdict: "pending", reasons: ["not ready"] };
  return critical.length ? { verdict: "needs_owner", reasons: critical } : { verdict: "would_merge", reasons: [] };
}

/** The verdict of a change request: a head the Forge refused to check (G4) is blocked; otherwise verdictOf. */
export function changeVerdict(row: { blocked_reason?: string | null }, check: CheckSummary | null, critical: string[] | null, nowMs = Date.now()): { verdict: Verdict; reasons: string[] } {
  if (row.blocked_reason) return { verdict: "blocked", reasons: [row.blocked_reason === "not_based_on_main" ? NOT_BASED_ON_MAIN : row.blocked_reason] };
  return verdictOf(check, critical, nowMs);
}

// ---------------------------------------------------------------------------------------------
// Registration and outcome (CI service token only)

export interface ChangeRow {
  cr_id: string; source: string; number: number; branch: string; source_branch: string; title: string; author: string;
  head_sha: string; base_sha: string; github_ci: string | null; status: "open" | "merged" | "closed";
  changed_paths: string | null; critical: string | null; verdict_at_outcome: Verdict | null; merge_sha: string | null; agrees: number | null;
  created_at: string; updated_at: string; outcome_at: string | null;
  /** Migration 0052 (G4): the Artifacts repository the head is read from, and why the Forge will not check it. */
  repo: ChangeRepo; blocked_reason: "not_based_on_main" | null;
}
export interface ChangeInput { number?: unknown; source_branch?: unknown; title?: unknown; author?: unknown; head_sha?: unknown; base_sha?: unknown; github_ci?: unknown }

const crId = (n: number) => `gh-${n}`;
const crBranch = (n: number) => `cr/${n}`;

function parseInput(input: ChangeInput) {
  const number = Number(input.number);
  if (!Number.isInteger(number) || number < 1 || number > 10_000_000) throw bad("invalid_number");
  const sourceBranch = typeof input.source_branch === "string" && /^[A-Za-z0-9._/-]{1,200}$/.test(input.source_branch) ? input.source_branch : "";
  if (!sourceBranch) throw bad("invalid_source_branch");
  const title = typeof input.title === "string" ? input.title.replace(/[\r\n]+/g, " ").trim().slice(0, 200) : "";
  if (!title) throw bad("invalid_title");
  const author = typeof input.author === "string" && /^[A-Za-z0-9[\]._-]{1,100}$/.test(input.author) ? input.author : "";
  if (!author) throw bad("invalid_author");
  const head = typeof input.head_sha === "string" ? input.head_sha : "";
  const base = typeof input.base_sha === "string" ? input.base_sha : "";
  if (!HEX40.test(head)) throw bad("invalid_head_sha");
  if (!HEX40.test(base)) throw bad("invalid_base_sha");
  const ci = input.github_ci === undefined || input.github_ci === null ? null : input.github_ci;
  if (ci !== null && ci !== "success" && ci !== "failure") throw bad("invalid_github_ci");
  return { number, sourceBranch, title, author, head, base, ci: ci as "success" | "failure" | null };
}

/**
 * Register or update gh-<number> (forge-change-request.yml, after GitHub CI of the pull request).
 * The head must already be in the Artifacts repository (pushed to cr/<number>). Changed paths and
 * the owner-only reasons are computed from the trees whenever the head or base changes.
 */
export async function registerChange(db: D1Database, repo: ArtifactsReader, input: ChangeInput, actor: string, nowMs = Date.now()): Promise<ChangeRow> {
  const p = parseInput(input);
  const id = crId(p.number);
  const now = new Date(nowMs).toISOString();
  const existing = await db.prepare("SELECT * FROM forge_change_requests WHERE cr_id = ?").bind(id).first<ChangeRow>();
  if (existing?.status === "merged") throw bad("change_already_merged", 409);
  const moved = !existing || existing.head_sha !== p.head || existing.base_sha !== p.base;
  let paths = existing?.changed_paths ?? null;
  let critical = existing?.critical ?? null;
  if (moved) {
    const { changes, truncated } = await changedPaths(repo, p.base, p.head);
    paths = JSON.stringify(changes.slice(0, MAX_PATHS_STORED).map((c) => `${c.change[0].toUpperCase()} ${c.path}`));
    critical = JSON.stringify(await criticalReasons(repo, changes, truncated));
  }
  await db.prepare(
    `INSERT INTO forge_change_requests (cr_id, source, number, branch, source_branch, title, author, head_sha, base_sha, github_ci, status, changed_paths, critical, created_at, updated_at)
     VALUES (?, 'github', ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)
     ON CONFLICT(cr_id) DO UPDATE SET source_branch = excluded.source_branch, title = excluded.title, author = excluded.author, head_sha = excluded.head_sha,
       base_sha = excluded.base_sha, github_ci = excluded.github_ci, status = 'open', changed_paths = excluded.changed_paths, critical = excluded.critical,
       verdict_at_outcome = NULL, merge_sha = NULL, agrees = NULL, outcome_at = NULL, updated_at = excluded.updated_at`,
  ).bind(id, p.number, crBranch(p.number), p.sourceBranch, p.title, p.author, p.head, p.base, p.ci, paths, critical, existing?.created_at ?? now, now).run();
  await appendAuditEvent(db, {
    event_type: "forge.change_registered", actor, subject: id, outcome: moved ? "head_changed" : "updated",
    payload: { head_sha: p.head, base_sha: p.base, github_ci: p.ci, critical: JSON.parse(critical ?? "[]").length },
  });
  return (await db.prepare("SELECT * FROM forge_change_requests WHERE cr_id = ?").bind(id).first<ChangeRow>())!;
}

/** Agreement of a GitHub merge with the Forge's verdict at that moment (null: the Forge had not decided). */
export function mergeAgreement(verdict: Verdict): boolean | null {
  if (verdict === "pending") return null;
  return verdict !== "blocked";
}

/** GitHub merged or closed the pull request: freeze the verdict next to the outcome. Idempotent. */
export async function recordOutcome(db: D1Database, input: { number?: unknown; merged?: unknown; merge_sha?: unknown }, actor: string, nowMs = Date.now()): Promise<ChangeRow> {
  const number = Number(input.number);
  if (!Number.isInteger(number) || number < 1) throw bad("invalid_number");
  if (typeof input.merged !== "boolean") throw bad("invalid_merged");
  const mergeSha = input.merge_sha === undefined || input.merge_sha === null ? null : String(input.merge_sha);
  if (input.merged && (!mergeSha || !HEX40.test(mergeSha))) throw bad("invalid_merge_sha");
  const id = crId(number);
  const row = await db.prepare("SELECT * FROM forge_change_requests WHERE cr_id = ?").bind(id).first<ChangeRow>();
  if (!row) throw bad("change_not_found", 404);
  const status = input.merged ? "merged" : "closed";
  if (row.status !== "open") {
    if (row.status === status && (!input.merged || row.merge_sha === mergeSha)) return row;
    throw bad("change_already_decided", 409);
  }
  const { verdict } = changeVerdict(row, await checkOf(db, row.head_sha), row.critical === null ? null : JSON.parse(row.critical), nowMs);
  const agrees = input.merged ? mergeAgreement(verdict) : null;
  const now = new Date(nowMs).toISOString();
  await db.prepare("UPDATE forge_change_requests SET status = ?, verdict_at_outcome = ?, merge_sha = ?, agrees = ?, outcome_at = ?, updated_at = ? WHERE cr_id = ? AND status = 'open'")
    .bind(status, verdict, mergeSha, agrees === null ? null : agrees ? 1 : 0, now, now, id).run();
  await appendAuditEvent(db, { event_type: "forge.change_outcome", actor, subject: id, outcome: status, payload: { verdict, agrees, merge_sha: mergeSha, head_sha: row.head_sha } });
  return (await db.prepare("SELECT * FROM forge_change_requests WHERE cr_id = ?").bind(id).first<ChangeRow>())!;
}

// ---------------------------------------------------------------------------------------------
// Listing, parity and the check queue

export interface MergeParity { target: number; consecutive: number; compared: number; late: number; disagreements: string[] }

export function mergeParity(rows: Array<Pick<ChangeRow, "cr_id" | "status" | "agrees">>): MergeParity {
  let consecutive = 0; let broken = false; let compared = 0; let late = 0;
  const disagreements: string[] = [];
  for (const r of rows) {
    if (r.status !== "merged") continue;
    if (r.agrees === null) { late++; continue; }
    compared++;
    if (r.agrees === 1 && !broken) consecutive++;
    if (r.agrees === 0) { broken = true; disagreements.push(r.cr_id); }
  }
  return { target: MERGE_PARITY_TARGET, consecutive, compared, late, disagreements: disagreements.slice(0, 20) };
}

const parseList = (v: string | null): string[] | null => { try { const a = JSON.parse(v ?? "null"); return Array.isArray(a) ? a.map(String) : null; } catch { return null; } };

export async function listChanges(db: D1Database, limit: number, nowMs = Date.now()) {
  const n = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
  const rows = (await db.prepare("SELECT * FROM forge_change_requests ORDER BY updated_at DESC, rowid DESC LIMIT 200").all<ChangeRow>()).results ?? [];
  const changes = [];
  for (const r of rows.slice(0, n)) {
    const critical = parseList(r.critical);
    const check = await checkOf(db, r.head_sha);
    const live = changeVerdict(r, check, critical, nowMs);
    changes.push({
      cr_id: r.cr_id, source: r.source, repo: r.repo, blocked_reason: r.blocked_reason, number: r.number, branch: r.branch, source_branch: r.source_branch, title: r.title, author: r.author,
      head_sha: r.head_sha, base_sha: r.base_sha, github_ci: r.github_ci, status: r.status,
      changed_paths: parseList(r.changed_paths) ?? [], critical: critical ?? [],
      check: check ? { status: check.status, pass: check.pass, fail: check.fail, guard_status: check.guard_status, typecheck: check.typecheck, ready: check.ready } : null,
      verdict: r.status === "open" ? live.verdict : r.verdict_at_outcome, reasons: r.status === "open" ? live.reasons : [],
      merge_sha: r.merge_sha, agrees: r.agrees === null ? null : r.agrees === 1,
      created_at: r.created_at, updated_at: r.updated_at, outcome_at: r.outcome_at,
    });
  }
  // Newest outcome first; equal times (one request) keep the newest-updated-first order above.
  const ordered = [...rows].sort((a, b) => (b.outcome_at ?? "").localeCompare(a.outcome_at ?? ""));
  return { changes, parity: mergeParity(ordered) };
}

/** The head of the oldest open change request that has no check yet (or whose run was lost). */
/**
 * The next open change request head to check: the newest first (owner 2026-11-11). Pull requests are often
 * merged minutes after they open; oldest-first left most of them unchecked at their outcome.
 */
export async function nextChangeHead(db: D1Database, repo: ArtifactsReader, nowMs: number, repoName: ChangeRepo = "platform"): Promise<string | null> {
  // G4: only the requests whose head lives in `repo` (gh-<n> in platform, fg-<slug> in platform-work), and
  // never a head the Forge refused (not based on main).
  const rows = (await db.prepare(
    `SELECT c.head_sha, r.status, r.started_at FROM forge_change_requests c LEFT JOIN forge_check_runs r ON r.commit_sha = c.head_sha
     WHERE c.status = 'open' AND c.repo = ? AND c.blocked_reason IS NULL ORDER BY c.updated_at DESC, c.rowid DESC LIMIT 20`,
  ).bind(repoName).all<{ head_sha: string; status: string | null; started_at: string | null }>()).results ?? [];
  for (const r of rows) {
    if (r.status && !(r.status === "running" && Date.parse(r.started_at ?? "") < nowMs - STALE_RUN_MS)) continue;
    if (await repo.readCommit(r.head_sha)) return r.head_sha;
  }
  return null;
}
