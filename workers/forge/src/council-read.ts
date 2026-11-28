// CB3 (owner 2026-11-28: "sementara B dulu ...", ADR-0014 §13): the read-only view of the Forge's data repository
// `council` at main, for the organs that read it. The scope is the entrypoint a caller's binding names, never a value
// in the request: CouncilPolicyRpc (xauusd's AI Worker) reads policy/ and ledger/, CouncilLedgerRpc (Aether) reads
// ledger/ only. Both read main as the binding resolves it now; neither has a write method, and no other repository or
// ref is reachable from here.
import { ALLOWLIST_PATH, COUNCIL_REPO, LEDGER_PATH, OVERLAY_PATH, SEGMENT } from "../../control-plane-shared/src/council-repo.ts";
import type { ArtifactsReader } from "./checks.ts";
import { refHead } from "./merge.ts";

export type CouncilScope = "policy" | "ledger";
export const MAX_LISTED = 500;
const MAX_TEXT = 64 * 1024;

export interface CouncilReadEnv { ARTIFACTS?: { get(name: string): Promise<ArtifactsReader> } }
export type ReadAnswer = { available: true; main_sha: string; path: string; text: string | null } | { available: false; reason: string };
export type ListAnswer = { available: true; main_sha: string; prefix: string; paths: string[]; truncated: boolean } | { available: false; reason: string };

/** Whether `path` (a file) is within `scope`: a ledger file for both; the overlay and the allowlist for policy only. */
export function fileInScope(scope: CouncilScope, path: unknown): path is string {
  if (typeof path !== "string") return false;
  if (LEDGER_PATH.test(path)) return true;
  return scope === "policy" && (path === OVERLAY_PATH || path === ALLOWLIST_PATH);
}

/** Whether `prefix` (a directory to list) is within `scope`: ledger/ and its first two levels; policy/ for policy only. */
export function prefixInScope(scope: CouncilScope, prefix: unknown): prefix is string {
  if (typeof prefix !== "string") return false;
  if (prefix === "policy/") return scope === "policy";
  if (prefix === "ledger/") return true;
  const parts = prefix.split("/");
  return parts[0] === "ledger" && parts[parts.length - 1] === "" && parts.length >= 3 && parts.length <= 4 && parts.slice(1, -1).every((p) => SEGMENT.test(p));
}

async function withMain<T>(env: CouncilReadEnv, fn: (repo: ArtifactsReader, main: string, tree: string) => Promise<T>): Promise<T | { available: false; reason: string }> {
  if (!env.ARTIFACTS) return { available: false, reason: "artifacts_not_configured" };
  let repo: ArtifactsReader;
  try { repo = await env.ARTIFACTS.get(COUNCIL_REPO); } catch { return { available: false, reason: "no_council_repository" }; }
  try {
    const main = await refHead(repo, "main").catch(() => null);
    if (!main) return { available: false, reason: "no_main" };
    const tree = (await repo.readCommit(main))?.treeHash;
    if (!tree) return { available: false, reason: "main_unreadable" };
    return await fn(repo, main, tree);
  } finally {
    repo[Symbol.dispose]?.();
  }
}

async function treeAt(repo: ArtifactsReader, root: string, dirs: string[]): Promise<string | null> {
  let tree = root;
  for (const d of dirs) {
    const e = (await repo.readTree(tree))?.find((x) => x.name === d);
    if (!e || e.type !== "tree") return null;
    tree = e.hash;
  }
  return tree;
}

/** One file of `council` at main within the scope; text null when it does not exist. */
export async function councilReadFile(env: CouncilReadEnv, scope: CouncilScope, path: unknown): Promise<ReadAnswer> {
  if (!fileInScope(scope, path)) return { available: false, reason: "path_not_in_scope" };
  return withMain(env, async (repo, main, root) => {
    const parts = path.split("/");
    const dir = await treeAt(repo, root, parts.slice(0, -1));
    const e = dir ? (await repo.readTree(dir))?.find((x) => x.name === parts[parts.length - 1]) : undefined;
    if (!e || (e.type !== "blob" && e.type !== "exec")) return { available: true as const, main_sha: main, path, text: null };
    const text = (await (await repo.readBlob(e.hash))?.text()) ?? null;
    if (text !== null && text.length > MAX_TEXT) return { available: false as const, reason: "file_too_large" };
    return { available: true as const, main_sha: main, path, text };
  });
}

/** The file paths under `prefix` at main within the scope (recursive, at most MAX_LISTED, sorted). */
export async function councilList(env: CouncilReadEnv, scope: CouncilScope, prefix: unknown): Promise<ListAnswer> {
  if (!prefixInScope(scope, prefix)) return { available: false, reason: "prefix_not_in_scope" };
  return withMain(env, async (repo, main, root) => {
    const start = await treeAt(repo, root, prefix.split("/").slice(0, -1));
    const paths: string[] = [];
    let truncated = false;
    const walk = async (tree: string, at: string): Promise<void> => {
      for (const e of (await repo.readTree(tree)) ?? []) {
        if (paths.length >= MAX_LISTED) { truncated = true; return; }
        const p = `${at}${e.name}`;
        if (e.type === "tree") await walk(e.hash, `${p}/`);
        else if (fileInScope(scope, p)) paths.push(p);
      }
    };
    if (start) await walk(start, prefix);
    return { available: true as const, main_sha: main, prefix, paths: paths.sort(), truncated };
  });
}
