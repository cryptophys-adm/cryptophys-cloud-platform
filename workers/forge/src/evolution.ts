// ADR-0014 §5 and §11, docs/design/EVOLVER.md §6 (owner 2026-11-17: "aktifkan evolver sekarang termasuk jalur balik"),
// step V4: the Forge's write path for the evolver. A guard path (guard-paths.ts, evolution_guard).
//
// EvolutionRpc.propose (worker.ts), bound only to the AI Kernel, turns one evolution's edits into one commit on
// canonical main's head and pushes it to `evo/<evolution_id>` of platform-work, and to no other ref. The work-repository
// intake then opens `fg-evo-<evolution_id>` like any branch: full checks, guard-path reasons, test guard, consensus merge.
// The Forge is the authority. Before it writes, in order, it checks:
//   0. the caller: the evolver agent, with a Policy Engine allow for code.propose of the last five minutes, consumed
//      here once (verifySyscallDecision, as every tier 1-2 syscall target does);
//   1. the evolution id and the base SHA, and that the base is canonical main's head now;
//   2. the switches: the evolver's own (evolver_controls.mode = on), the platform kill switch (agents_enabled) and the
//      consensus mode (not shadow);
//   3. the cadence of ADR-0014 §9: no evolution change request open (MAX_IN_FLIGHT) and none written within
//      MIN_START_INTERVAL_HOURS;
//   4. checkEdits (evolution-limits.ts) on the files as they are at the base: scope, guard paths, migrations,
//      configuration, dependencies, binaries, diff size, the test rule, no removed assertion;
//   5. that `evo/<evolution_id>` does not exist on platform-work: one evolution, one commit.
// Then it builds the blobs, trees and commit, places the base on the branch (copied from canonical with the objects
// platform-work lacks), and fast-forwards the branch from the base to the new commit with a pack of the new objects.
// Every outcome is audited: forge.evolution_written (SHA, files, changed lines) or forge.evolution_refused (reasons).
// Tokens are minted per call with a 120 s TTL, sent only in the Authorization header, never logged or returned.
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { verifySyscallDecision } from "../../control-plane-shared/src/capabilities.ts";
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import {
  EVOLUTION_ID, EVOLVER_AGENT_ID, MAX_CHANGED_FILES, MAX_FILE_BYTES, MAX_IN_FLIGHT, MIN_START_INTERVAL_HOURS, checkEdits, evolutionBranch, pathRefusal, type EditedFile,
} from "../../control-plane-shared/src/evolution-limits.ts";
import type { ArtifactsReader, ArtifactsTreeEntry } from "./checks.ts";
import { GitBackupError } from "./git-backup.ts";
import { CANONICAL_REPO, discoverRefs, fastForward, refHead, trustedRemoteFor, validSha, ZERO_SHA, type Fetch, type MergeBinding } from "./merge.ts";
import { fetchCommitPack, TRANSFER_TOKEN_TTL_S } from "./transfer.ts";
import { WORK_REPO, workChangeId } from "./work-repo.ts";

const ACTOR = "system:forge-evolution";
export const EVOLVER_AUTHOR = "Cryptophys Evolver <evolver@cryptophys.work>";
export const FORGE_COMMITTER = "Cryptophys Forge <forge@cryptophys.work>";
const TITLE_MAX = 120;
const DESCRIPTION_MAX = 4000;
const MAX_HAVES = 100;
const enc = new TextEncoder();

export interface EvolutionInput { evolution_id?: unknown; base_sha?: unknown; edits?: unknown; title?: unknown; description?: unknown }
export interface EvolutionResult {
  ok: boolean; outcome: "written" | "refused" | "failed"; evolution_id: string; branch?: string; cr_id?: string;
  base_sha?: string; head_sha?: string; files?: string[]; changed_lines?: number; refusals?: string[]; reason?: string;
}
export interface EvolutionEnv { DB: D1Database; ARTIFACTS?: MergeBinding }

// ---------------------------------------------------------------- git objects

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
async function sha1(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-1", bytes as Uint8Array<ArrayBuffer>));
}
export type GitType = "commit" | "tree" | "blob";
export interface GitObject { type: GitType; body: Uint8Array; sha: string }
/** A git object and its id: SHA-1 of "<type> <size>\0<body>". */
export async function gitObject(type: GitType, body: Uint8Array): Promise<GitObject> {
  return { type, body, sha: hex(await sha1(concat([enc.encode(`${type} ${body.length}\0`), body]))) };
}

/** A tree object's body: entries sorted as git sorts them (a tree compares as its name followed by "/"). */
export function treeBody(entries: Array<{ mode: string; name: string; hash: string }>): Uint8Array {
  const key = (e: { mode: string; name: string }) => (e.mode === "40000" ? `${e.name}/` : e.name);
  const sorted = [...entries].sort((a, b) => { const x = enc.encode(key(a)); const y = enc.encode(key(b)); for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i]; return x.length - y.length; });
  return concat(sorted.flatMap((e) => [enc.encode(`${e.mode} ${e.name}\0`), unhex(e.hash)]));
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
const PACK_TYPE: Record<GitType, number> = { commit: 1, tree: 2, blob: 3 };
/** A version 2 packfile of whole (undeltified) objects, with its trailing SHA-1. */
export async function packOf(objects: GitObject[]): Promise<Uint8Array<ArrayBuffer>> {
  const head = new Uint8Array(12);
  head.set(enc.encode("PACK"), 0);
  const view = new DataView(head.buffer);
  view.setUint32(4, 2);
  view.setUint32(8, objects.length);
  const parts: Uint8Array[] = [head];
  for (const o of objects) {
    let size = o.body.length;
    const h: number[] = [(PACK_TYPE[o.type] << 4) | (size & 0x0f)];
    size >>>= 4;
    while (size > 0) { h[h.length - 1] |= 0x80; h.push(size & 0x7f); size >>>= 7; }
    parts.push(Uint8Array.from(h), await deflate(o.body));
  }
  const body = concat(parts);
  return concat([body, await sha1(body)]);
}

// ---------------------------------------------------------------- reading the base

type Reader = Pick<ArtifactsReader, "readCommit" | "readTree" | "readBlob">;
class PathConflict extends Error {}

/** The text of `path` at `treeHash`, or null when it does not exist. A directory where a file is named is a conflict. */
async function readAt(repo: Reader, treeHash: string, path: string): Promise<string | null> {
  const parts = path.split("/");
  let tree = treeHash;
  for (let i = 0; i < parts.length; i++) {
    const entries = await repo.readTree(tree);
    const e = entries?.find((x) => x.name === parts[i]);
    if (!e) return null;
    const last = i === parts.length - 1;
    if (!last) { if (e.type !== "tree") throw new PathConflict(path); tree = e.hash; continue; }
    if (e.type === "tree" || e.type === "gitlink" || e.type === "symlink") throw new PathConflict(path);
    const blob = await repo.readBlob(e.hash);
    if (!blob) throw new Error(`blob_unreadable:${path}`);
    return await blob.text();
  }
  return null;
}

/** The new tree for `treeHash` (null: a new directory) with `files` (relative path -> blob id) written in. */
async function buildTree(repo: Reader, treeHash: string | null, files: Map<string, string>, out: GitObject[]): Promise<string> {
  const entries: ArtifactsTreeEntry[] = treeHash ? [...((await repo.readTree(treeHash)) ?? [])] : [];
  const byName = new Map(entries.map((e) => [e.name, e]));
  const sub = new Map<string, Map<string, string>>();
  for (const [path, blob] of files) {
    const i = path.indexOf("/");
    if (i < 0) {
      const prev = byName.get(path);
      if (prev && (prev.type === "tree" || prev.type === "gitlink" || prev.type === "symlink")) throw new PathConflict(path);
      byName.set(path, { name: path, mode: prev?.mode === "100755" ? "100755" : "100644", hash: blob, type: "blob" });
    } else {
      const dir = path.slice(0, i);
      if (!sub.has(dir)) sub.set(dir, new Map());
      sub.get(dir)!.set(path.slice(i + 1), blob);
    }
  }
  for (const [dir, inner] of sub) {
    const prev = byName.get(dir);
    if (prev && prev.type !== "tree") throw new PathConflict(dir);
    byName.set(dir, { name: dir, mode: "40000", type: "tree", hash: await buildTree(repo, prev?.hash ?? null, inner, out) });
  }
  const obj = await gitObject("tree", treeBody([...byName.values()].map((e) => ({ mode: e.type === "tree" ? "40000" : e.mode, name: e.name, hash: e.hash }))));
  out.push(obj);
  return obj.sha;
}

const oneLine = (v: unknown, max: number) => (typeof v === "string" ? v : "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const paragraph = (v: unknown, max: number) => (typeof v === "string" ? v : "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim().slice(0, max);

/** The commit object of one evolution: the base as its only parent, the evolver as author, the Forge as committer. */
export async function commitObject(tree: string, parent: string, title: string, description: string, evolutionId: string, nowMs: number): Promise<GitObject> {
  const ts = `${Math.floor(nowMs / 1000)} +0000`;
  const text = `tree ${tree}\nparent ${parent}\nauthor ${EVOLVER_AUTHOR} ${ts}\ncommitter ${FORGE_COMMITTER} ${ts}\n\n${title}\n\n${description ? `${description}\n\n` : ""}Evolution: ${evolutionId}\n`;
  return gitObject("commit", enc.encode(text));
}

// ---------------------------------------------------------------- the gates

async function switchesRefusal(db: D1Database): Promise<string | null> {
  const row = await db.prepare(
    `SELECT (SELECT value FROM evolver_controls WHERE control = 'mode') AS evolver,
            (SELECT value FROM kernel_controls WHERE control = 'agents_enabled') AS agents,
            (SELECT value FROM consensus_controls WHERE control = 'mode') AS mode`,
  ).first<{ evolver: string | null; agents: string | null; mode: string | null }>().catch(() => null);
  if (!row) return "evolver_controls_unavailable";
  if (row.evolver !== "on") return "evolver_off";
  if (row.agents !== "1") return "kill_switch_engaged";
  if (!row.mode || row.mode === "shadow") return "consensus_mode_shadow";
  return null;
}

async function cadenceRefusal(db: D1Database, nowMs: number): Promise<string | null> {
  const open = await db.prepare("SELECT COUNT(*) AS n FROM forge_change_requests WHERE status = 'open' AND source = 'forge' AND branch LIKE 'evo/%'").first<{ n: number }>();
  if (Number(open?.n ?? 0) >= MAX_IN_FLIGHT) return "evolution_in_flight";
  const since = new Date(nowMs - MIN_START_INTERVAL_HOURS * 3_600_000).toISOString();
  const recent = await db.prepare("SELECT 1 AS x FROM audit_events WHERE event_type = 'forge.evolution_written' AND created_at >= ? LIMIT 1").bind(since).first();
  return recent ? "start_interval" : null;
}

// ---------------------------------------------------------------- propose

export async function proposeEvolution(env: EvolutionEnv, agentId: string, decisionId: unknown, input: EvolutionInput, fetchImpl: Fetch = (i, init) => fetch(i, init), nowMs = Date.now()): Promise<EvolutionResult> {
  if (agentId !== EVOLVER_AGENT_ID) throw new Error("not_the_evolver");
  await verifySyscallDecision(env.DB, decisionId, agentId, "code.propose", nowMs);
  const evolution_id = typeof input.evolution_id === "string" ? input.evolution_id : "";
  const done = async (r: EvolutionResult): Promise<EvolutionResult> => {
    const { ok, outcome, ...payload } = r;
    await appendAuditEvent(env.DB, { event_type: ok ? "forge.evolution_written" : "forge.evolution_refused", actor: ACTOR, subject: `evolution:${evolution_id || "invalid"}`, outcome, payload: { ...payload } });
    return r;
  };
  const refuse = (reason: string, refusals?: string[]) => done({ ok: false, outcome: "refused", evolution_id, reason, ...(refusals ? { refusals: refusals.slice(0, 20) } : {}) });
  if (!EVOLUTION_ID.test(evolution_id)) return refuse("invalid_evolution_id");
  const base = typeof input.base_sha === "string" ? input.base_sha : "";
  if (!validSha(base) || base === ZERO_SHA) return refuse("invalid_base_sha");
  const title = oneLine(input.title, TITLE_MAX);
  if (!title) return refuse("missing_title");
  const description = paragraph(input.description, DESCRIPTION_MAX);
  if (!env.ARTIFACTS) return refuse("artifacts_not_configured");
  const switches = await switchesRefusal(env.DB);
  if (switches) return refuse(switches);
  const cadence = await cadenceRefusal(env.DB, nowMs);
  if (cadence) return refuse(cadence);

  const branch = evolutionBranch(evolution_id);
  const canonical = await env.ARTIFACTS.get(CANONICAL_REPO);
  let objects: GitObject[];
  let files: EditedFile[];
  let changed_lines: number;
  let head: string;
  try {
    const main = await refHead(canonical, "main");
    if (main !== base) return refuse("base_not_main");
    const commit = await canonical.readCommit(base);
    if (!commit) return refuse("base_unreadable");
    const paths = Array.isArray(input.edits) ? [...new Set((input.edits as Array<Record<string, unknown>>).map((e) => (typeof e?.path === "string" ? e.path : "")).filter(Boolean))] : [];
    const baseFiles = new Map<string, string | null>();
    try {
      for (const p of paths.slice(0, 40)) baseFiles.set(p, await readAt(canonical, commit.treeHash, p));
    } catch (err) {
      if (err instanceof PathConflict) return refuse("path_conflict", [`path_conflict: ${String(err.message).slice(0, 120)}`]);
      throw err;
    }
    const check = checkEdits(baseFiles, input.edits);
    if (!check.ok) return refuse("edits_refused", check.refusals);
    files = check.files;
    changed_lines = check.changed_lines;
    objects = [];
    const blobs = new Map<string, string>();
    for (const f of files) {
      const blob = await gitObject("blob", enc.encode(f.after));
      objects.push(blob);
      blobs.set(f.path, blob.sha);
    }
    let tree: string;
    try { tree = await buildTree(canonical, commit.treeHash, blobs, objects); } catch (err) {
      if (err instanceof PathConflict) return refuse("path_conflict", [`path_conflict: ${String(err.message).slice(0, 120)}`]);
      throw err;
    }
    const c = await commitObject(tree, base, title, description, evolution_id, nowMs);
    objects.push(c);
    head = c.sha;
  } finally {
    canonical[Symbol.dispose]?.();
  }

  // Place the base on the branch (with whatever platform-work lacks of it), then fast-forward to the new commit.
  const src = await env.ARTIFACTS.get(CANONICAL_REPO);
  const work = await env.ARTIFACTS.get(WORK_REPO);
  const fail = (reason: string) => done({ ok: false, outcome: "failed", evolution_id, branch, base_sha: base, head_sha: head, reason });
  try {
    const srcRemote = (await src.info())?.remote ?? "";
    const workRemote = (await work.info())?.remote ?? "";
    if (!trustedRemoteFor(srcRemote, CANONICAL_REPO) || !trustedRemoteFor(workRemote, WORK_REPO)) return refuse("untrusted_remote");
    const writeToken = (await work.createToken("write", TRANSFER_TOKEN_TTL_S)).plaintext;
    const discovered = await discoverRefs(workRemote, writeToken, fetchImpl);
    if (!discovered.ok) return fail(`discovery_failed:${discovered.reason}`);
    if ((discovered.adv.refs.get(`refs/heads/${branch}`) ?? ZERO_SHA) !== ZERO_SHA) return refuse("branch_exists");
    const haves = [...new Set([...discovered.adv.refs.values()].filter((h) => validSha(h) && h !== ZERO_SHA))].slice(0, MAX_HAVES);
    const readToken = (await src.createToken("read", TRANSFER_TOKEN_TTL_S)).plaintext;
    let basePack: Uint8Array<ArrayBuffer>;
    try { basePack = (await fetchCommitPack(srcRemote, readToken, base, haves, fetchImpl)).pack; } catch (err) {
      return fail(err instanceof GitBackupError ? err.message : "fetch_failed");
    }
    const placed = await fastForward({ remote: workRemote, token: writeToken, branch, from: ZERO_SHA, to: base, fetchImpl, pack: basePack });
    if (!placed.ok) return fail(`base_push_failed:${placed.reason}`);
    const pushed = await fastForward({ remote: workRemote, token: writeToken, branch, from: base, to: head, fetchImpl, pack: await packOf(objects) });
    if (!pushed.ok) return fail(`push_failed:${pushed.reason}`);
  } finally {
    src[Symbol.dispose]?.();
    work[Symbol.dispose]?.();
  }
  return done({ ok: true, outcome: "written", evolution_id, branch, cr_id: workChangeId(branch), base_sha: base, head_sha: head, files: files.map((f) => f.path), changed_lines });
}

// ---------------------------------------------------------------- code.read (tier 0, read only)

/** At most this many paths are listed, and this many files read per call. */
export const MAX_LISTED_PATHS = 4000;
export const MAX_READ_FILES = 12;

/**
 * canonical main's head and the paths of its files that an evolution may touch (pathRefusal null), or with `paths`
 * the text of up to MAX_READ_FILES of them (null for a missing file; a refused path is never read).
 */
export async function readCode(env: EvolutionEnv, input: { paths?: unknown; prefix?: unknown }): Promise<Record<string, unknown>> {
  if (!env.ARTIFACTS) return { available: false };
  const repo = await env.ARTIFACTS.get(CANONICAL_REPO);
  try {
    const main = await refHead(repo, "main");
    const commit = main ? await repo.readCommit(main) : null;
    if (!main || !commit) return { available: false };
    if (Array.isArray(input.paths)) {
      const files: Record<string, string | null> = {};
      const refused: Record<string, string> = {};
      for (const p of [...new Set(input.paths.filter((x): x is string => typeof x === "string"))].slice(0, MAX_READ_FILES)) {
        const why = pathRefusal(p);
        if (why && !why.startsWith("guard_path:")) { refused[p] = why; continue; }
        try {
          const text = await readAt(repo, commit.treeHash, p);
          files[p] = text !== null && new TextEncoder().encode(text).length > MAX_FILE_BYTES ? null : text;
          if (why) refused[p] = why; // readable for context, never editable
        } catch (err) {
          if (err instanceof PathConflict) refused[p] = "path_conflict"; else throw err;
        }
      }
      return { available: true, main_sha: main, files, refused };
    }
    const prefix = typeof input.prefix === "string" ? input.prefix.replace(/^\/+|\/+$/g, "") : "";
    const out: string[] = [];
    const walk = async (tree: string, at: string): Promise<void> => {
      for (const e of (await repo.readTree(tree)) ?? []) {
        if (out.length >= MAX_LISTED_PATHS) return;
        const path = at ? `${at}/${e.name}` : e.name;
        if (e.type === "tree") {
          if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
          if (prefix && !(prefix.startsWith(`${path}/`) || prefix === path || path.startsWith(`${prefix}/`))) continue;
          await walk(e.hash, path);
        } else if ((!prefix || path.startsWith(`${prefix}/`)) && pathRefusal(path) === null) out.push(path);
      }
    };
    await walk(commit.treeHash, "");
    return { available: true, main_sha: main, paths: out, truncated: out.length >= MAX_LISTED_PATHS, max_files_per_change: MAX_CHANGED_FILES };
  } finally {
    repo[Symbol.dispose]?.();
  }
}
