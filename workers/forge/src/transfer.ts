// ADR-0012 G4/G6: copy one commit, with every object it needs, from one Artifacts repository to a branch of
// another, over Git smart HTTP. The Artifacts binding cannot move objects between repositories, so the Forge
// fetches a pack from the source (upload-pack: want the commit, have the target's main, so the pack omits what
// the target already holds) and sends it to the target with the ref update (receive-pack, fastForward with a
// pack). Both tokens are minted per copy with a 120 s TTL, sent only in the Authorization header, and never
// logged, stored, audited or returned.
//
// Today's one use: the head of a change request pushed to platform-work is copied to the canonical repository
// as `cr/<cr_id>`, where the Workers Builds project cryptophys-forge-typecheck-cr builds and type-checks every
// cr/* branch (cr-builds.ts). On the canonical repository this module writes only `cr/fg-*` branches, never main.
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { chooseCapabilities, FETCH_TIMEOUT_MS, GitBackupError, MAX_PACK_BYTES, receivePack, uploadPackRequest, verifyPack } from "./git-backup.ts";
import { CANONICAL_REPO, discoverRefs, fastForward, gitHeaders, remoteBase, trustedRemoteFor, validBranch, validSha, ZERO_SHA, type Advertisement, type Fetch, type MergeBinding } from "./merge.ts";

export const TRANSFER_TOKEN_TTL_S = 120;
/** The only branches this module may write in the canonical repository. */
export const CANONICAL_CR_BRANCH = /^cr\/fg-[a-z0-9][a-z0-9._-]{0,90}$/;

export interface CopyResult { ok: boolean; outcome: "copied" | "unchanged" | "refused" | "failed"; branch: string; from?: string; to?: string; objects?: number; pack_bytes?: number; reason?: string }

const concat = (chunks: Uint8Array[], bytes: number): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(bytes);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
};

/** The pack of `want` minus what `haves` reach, from `remote` with a read token. Throws GitBackupError. */
export async function fetchCommitPack(remote: string, token: string, want: string, haves: string[], fetchImpl: Fetch, maxPackBytes = MAX_PACK_BYTES): Promise<{ pack: Uint8Array<ArrayBuffer>; objects: number }> {
  const base = remoteBase(remote);
  if (!base) throw new GitBackupError("invalid_remote");
  const discovered = await discoverRefs(base, token, fetchImpl, "git-upload-pack");
  if (!discovered.ok) throw new GitBackupError(`discovery_failed:${discovered.reason}`);
  const { caps, sideband } = chooseCapabilities((discovered as { ok: true; adv: Advertisement }).adv.capabilities);
  let res: Response;
  try {
    const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined;
    res = await fetchImpl(`${base}/git-upload-pack`, {
      method: "POST", redirect: "manual", body: uploadPackRequest([want], caps, haves), ...(signal ? { signal } : {}),
      headers: gitHeaders(token, { "content-type": "application/x-git-upload-pack-request", accept: "application/x-git-upload-pack-result" }),
    });
  } catch {
    throw new GitBackupError("fetch_unreachable");
  }
  if (res.status !== 200) throw new GitBackupError(`fetch_http_${res.status}`);
  if (!(res.headers.get("content-type") ?? "").startsWith("application/x-git-upload-pack-result")) throw new GitBackupError("fetch_not_smart_http");
  if (!res.body) throw new GitBackupError("fetch_empty");
  const received = await receivePack(res.body, sideband, maxPackBytes);
  const pack = concat(received.chunks, received.bytes);
  const info = await verifyPack(pack);
  return { pack, objects: info.objects };
}

/**
 * Copy `sha` from repository `source` to `refs/heads/<branch>` of repository `target`. Idempotent: a branch that
 * already points at `sha` is left alone. On the canonical repository only CANONICAL_CR_BRANCH is accepted.
 */
export async function copyCommit(binding: MergeBinding, args: { source: string; target: string; sha: string; branch: string }, fetchImpl: Fetch): Promise<CopyResult> {
  const { source, target, sha, branch } = args;
  const refuse = (reason: string): CopyResult => ({ ok: false, outcome: "refused", branch, reason });
  if (!validSha(sha) || sha === ZERO_SHA) return refuse("invalid_sha");
  if (!validBranch(branch) || branch === "main") return refuse("invalid_branch");
  if (source === target) return refuse("same_repository");
  if (target === CANONICAL_REPO && !CANONICAL_CR_BRANCH.test(branch)) return refuse("canonical_branch_not_allowed");

  const src = await binding.get(source);
  const dst = await binding.get(target);
  try {
    const srcRemote = (await src.info())?.remote ?? "";
    const dstRemote = (await dst.info())?.remote ?? "";
    if (!trustedRemoteFor(srcRemote, source) || !trustedRemoteFor(dstRemote, target)) return refuse("untrusted_remote");
    if (!(await src.readCommit(sha))) return refuse("commit_not_in_source");
    const writeToken = (await dst.createToken("write", TRANSFER_TOKEN_TTL_S)).plaintext;
    const discovered = await discoverRefs(dstRemote, writeToken, fetchImpl);
    if (!discovered.ok) return { ok: false, outcome: "failed", branch, reason: discovered.reason };
    const current = discovered.adv.refs.get(`refs/heads/${branch}`) ?? ZERO_SHA;
    if (current === sha) return { ok: true, outcome: "unchanged", branch, from: current, to: sha };
    const haves = [discovered.adv.refs.get("refs/heads/main")].filter((h): h is string => validSha(h) && h !== ZERO_SHA);
    const readToken = (await src.createToken("read", TRANSFER_TOKEN_TTL_S)).plaintext;
    let fetched: { pack: Uint8Array<ArrayBuffer>; objects: number };
    try {
      fetched = await fetchCommitPack(srcRemote, readToken, sha, haves, fetchImpl);
    } catch (err) {
      return { ok: false, outcome: "failed", branch, reason: err instanceof GitBackupError ? err.message : "fetch_failed" };
    }
    const pushed = await fastForward({ remote: dstRemote, token: writeToken, branch, from: current, to: sha, fetchImpl, pack: fetched.pack });
    return pushed.ok
      ? { ok: true, outcome: "copied", branch, from: current, to: sha, objects: fetched.objects, pack_bytes: fetched.pack.length }
      : { ok: false, outcome: "failed", branch, from: current, to: sha, reason: pushed.reason };
  } finally {
    src[Symbol.dispose]?.();
    dst[Symbol.dispose]?.();
  }
}

/** The canonical branch a forge-sourced change request is type-checked on. */
export const typecheckBranch = (crId: string) => `cr/${crId}`;

/**
 * Tick step (ADR-0012 §5j, gate 6): give the newest open, unblocked forge-sourced change request without a
 * type-check report a type-check source, by copying its head to `cr/<cr_id>` of the canonical repository.
 * One copy per tick; a request already copied at its head is skipped without a transfer.
 */
export async function crSourcesTick(env: { DB: D1Database; ARTIFACTS?: MergeBinding }, fetchImpl: Fetch = (i, init) => fetch(i, init)): Promise<Record<string, unknown>> {
  if (!env.ARTIFACTS) return { outcome: "not_configured" };
  const rows = (await env.DB.prepare(
    `SELECT c.cr_id, c.head_sha, c.repo FROM forge_change_requests c LEFT JOIN forge_typecheck_reports t ON t.commit_sha = c.head_sha
     WHERE c.status = 'open' AND c.source = 'forge' AND c.blocked_reason IS NULL AND t.commit_sha IS NULL
     ORDER BY c.updated_at DESC LIMIT 3`,
  ).all<{ cr_id: string; head_sha: string; repo: string }>()).results ?? [];
  if (!rows.length) return { outcome: "up_to_date" };
  const results: CopyResult[] = [];
  for (const r of rows) {
    const branch = typecheckBranch(r.cr_id);
    const result = await copyCommit(env.ARTIFACTS, { source: r.repo, target: CANONICAL_REPO, sha: r.head_sha, branch }, fetchImpl);
    results.push(result);
    if (result.outcome === "unchanged") continue;
    await appendAuditEvent(env.DB, {
      event_type: "forge.cr_source_copied", actor: "system:forge-cr-sources", subject: r.cr_id, outcome: result.outcome,
      payload: { source: r.repo, target: CANONICAL_REPO, branch, head_sha: r.head_sha, ...(result.objects !== undefined ? { objects: result.objects, pack_bytes: result.pack_bytes } : {}), ...(result.reason ? { reason: result.reason } : {}) },
    });
    break;
  }
  return { outcome: results.some((r) => r.outcome === "copied") ? "copied" : "checked", results: results.map(({ branch, outcome, reason }) => ({ branch, outcome, ...(reason ? { reason } : {}) })) };
}
