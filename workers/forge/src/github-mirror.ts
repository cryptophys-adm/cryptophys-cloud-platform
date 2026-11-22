// Owner 2026-11-22 ("opsi a", then "sinkron otomatis"): the GitHub repository cryptophys-adm/cryptophys-cloud-platform
// mirrors the Forge's main and stays in step with it. The Forge stays canonical (ADR-0012); GitHub merges nothing and is
// read only for everyone but this module, so nobody reads or deploys from a stale copy again (incident 2026-11-21).
//
// Each Forge tick, with the owner's token (Forge secret GITHUB_MIRROR_TOKEN: a fine-grained token with Contents
// read/write on that one repository and nothing else):
//   1. read canonical main from Artifacts and the mirror's main from GitHub (receive-pack ref discovery);
//   2. equal: nothing; the mirror's main not an ancestor of canonical main: no push, one audit event per pair
//      (forge.github_mirror_diverged), because only a force push could fix it and the Forge never force-pushes;
//   3. otherwise fetch the pack of canonical main minus what the mirror's main reaches from Artifacts (transfer.ts,
//      a read token with a 120 s TTL) and fast-forward GitHub's main with it (merge.ts fastForward: the update is
//      sent only if GitHub's main is still exactly the value just read, and receive-pack must report it ok).
// The token goes only in the Authorization header of requests to github.com; it is never logged, stored, audited or
// returned. Only refs/heads/main is ever written, and only by fast-forward.
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { canonicalMainHead } from "./census.ts";
import { GitBackupError } from "./git-backup.ts";
import { CANONICAL_REPO, discoverRefs, fastForward, isAncestor, trustedRemoteFor, validSha, ZERO_SHA, type Fetch, type MergeBinding } from "./merge.ts";
import { fetchCommitPack, TRANSFER_TOKEN_TTL_S } from "./transfer.ts";

export const GITHUB_MIRROR_REMOTE = "https://github.com/cryptophys-adm/cryptophys-cloud-platform.git";
export const GITHUB_MIRROR_HOST = "github.com";
/** A failure with the same reason is audited again only after this long (the tick runs every 15 minutes). */
export const MIRROR_FAILURE_REAUDIT_MS = 6 * 3_600_000;

export interface MirrorEnv { DB: D1Database; ARTIFACTS?: MergeBinding; GITHUB_MIRROR_TOKEN?: string }
export interface MirrorResult { outcome: "not_configured" | "unchanged" | "pushed" | "diverged" | "failed"; from?: string; to?: string; objects?: number; pack_bytes?: number; reason?: string }

const base64 = (s: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/**
 * A fetch for github.com only. GitHub's Git smart HTTP takes the token as Basic credentials (user x-access-token),
 * while merge.ts sends `Bearer`; this rewrites that one header and refuses any other host, so the token can never be
 * sent to Artifacts or anywhere else by mistake.
 */
export function githubFetch(fetchImpl: Fetch, token: string): Fetch {
  return (input, init) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    if (url.protocol !== "https:" || url.hostname !== GITHUB_MIRROR_HOST) return Promise.reject(new Error("github_fetch_host_refused"));
    const headers: Record<string, string> = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
    delete headers.authorization;
    headers.authorization = `Basic ${base64(`x-access-token:${token}`)}`;
    return fetchImpl(url.toString(), { ...init, headers, redirect: "manual" });
  };
}

async function lastMirrorEvent(db: D1Database): Promise<{ event_type: string; outcome: string; payload_json: string; created_at: string } | null> {
  return await db.prepare(
    "SELECT event_type, outcome, payload_json, created_at FROM audit_events WHERE event_type IN ('forge.github_mirror_pushed', 'forge.github_mirror_failed', 'forge.github_mirror_diverged') ORDER BY created_at DESC LIMIT 1",
  ).first<{ event_type: string; outcome: string; payload_json: string; created_at: string }>() ?? null;
}

/** One mirror step. Never throws for a remote's answer; the tick's own step wrapper catches anything else. */
export async function githubMirrorTick(env: MirrorEnv, nowMs: number, fetchImpl: Fetch = (i, init) => fetch(i, init)): Promise<MirrorResult> {
  if (!env.ARTIFACTS || !env.GITHUB_MIRROR_TOKEN) return { outcome: "not_configured" };
  const gh = githubFetch(fetchImpl, env.GITHUB_MIRROR_TOKEN);
  const repo = await env.ARTIFACTS.get(CANONICAL_REPO);
  let result: MirrorResult;
  try {
    result = await mirrorOnce(repo, gh, fetchImpl);
  } finally {
    repo[Symbol.dispose]?.();
  }
  if (result.outcome === "unchanged" || result.outcome === "not_configured") return result;
  // Audit: every push; a divergence once per (mirror, canonical) pair; a failure once per reason every 6 hours.
  const last = await lastMirrorEvent(env.DB);
  const lastPayload = (() => { try { return JSON.parse(last?.payload_json ?? "{}") as Record<string, unknown>; } catch { return {}; } })();
  const event = result.outcome === "pushed" ? "forge.github_mirror_pushed" : result.outcome === "diverged" ? "forge.github_mirror_diverged" : "forge.github_mirror_failed";
  // The payload stores a missing value as null; compare the same way (a failed discovery has no `from`, 22 Nov 04:49Z audited every tick).
  const repeat = last?.event_type === event && (lastPayload.from ?? null) === (result.from ?? null) && (lastPayload.to ?? null) === (result.to ?? null) && (lastPayload.reason ?? null) === (result.reason ?? null)
    // The tick's own clock (payload.at), not the row's wall-clock created_at: the same tick time always gives the same answer.
    && (result.outcome === "diverged" || nowMs - Date.parse(String(lastPayload.at ?? last.created_at)) < MIRROR_FAILURE_REAUDIT_MS);
  if (!repeat) {
    await appendAuditEvent(env.DB, {
      event_type: event, actor: "system:forge-github-mirror", subject: "refs/heads/main", outcome: result.outcome,
      payload: { at: new Date(nowMs).toISOString(), remote: GITHUB_MIRROR_REMOTE, from: result.from ?? null, to: result.to ?? null, reason: result.reason ?? null, ...(result.objects !== undefined ? { objects: result.objects, pack_bytes: result.pack_bytes } : {}) },
    });
  }
  return result;
}

async function mirrorOnce(repo: Awaited<ReturnType<MergeBinding["get"]>>, gh: Fetch, fetchImpl: Fetch): Promise<MirrorResult> {
  const main = await canonicalMainHead(repo);
  if (!main) return { outcome: "failed", reason: "canonical_main_unreadable" };
  const discovered = await discoverRefs(GITHUB_MIRROR_REMOTE, "github", gh);
  if (!discovered.ok) return { outcome: "failed", to: main, reason: `mirror_${discovered.reason}` };
  const mirror = discovered.adv.refs.get("refs/heads/main") ?? ZERO_SHA;
  if (!validSha(mirror) || mirror === ZERO_SHA) return { outcome: "failed", to: main, reason: "mirror_main_missing" };
  if (mirror === main) return { outcome: "unchanged", from: mirror, to: main };
  if (!(await isAncestor(repo, mirror, main))) return { outcome: "diverged", from: mirror, to: main, reason: "mirror_not_ancestor_of_main" };
  const remote = (await repo.info())?.remote ?? "";
  if (!trustedRemoteFor(remote, CANONICAL_REPO)) return { outcome: "failed", from: mirror, to: main, reason: "untrusted_canonical_remote" };
  const readToken = (await repo.createToken("read", TRANSFER_TOKEN_TTL_S)).plaintext;
  let fetched: { pack: Uint8Array<ArrayBuffer>; objects: number };
  try {
    fetched = await fetchCommitPack(remote, readToken, main, [mirror], fetchImpl);
  } catch (err) {
    return { outcome: "failed", from: mirror, to: main, reason: err instanceof GitBackupError ? `pack_${err.message}` : "pack_failed" };
  }
  // The token argument only satisfies fastForward's check: githubFetch replaces the header with the real token.
  const pushed = await fastForward({ remote: GITHUB_MIRROR_REMOTE, token: "github", branch: "main", from: mirror, to: main, fetchImpl: gh, pack: fetched.pack });
  return pushed.ok
    ? { outcome: "pushed", from: mirror, to: main, objects: fetched.objects, pack_bytes: fetched.pack.length }
    : { outcome: "failed", from: mirror, to: main, reason: pushed.reason ?? "push_failed" };
}
