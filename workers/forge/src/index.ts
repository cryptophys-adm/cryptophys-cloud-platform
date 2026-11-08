// cryptophys-forge (ADR-0012 phase 1): the Cloudflare-native source of the platform, on Artifacts.
//
// Phase 1 is read-only towards production and changes nothing GitHub does:
//   - POST /v1/forge/import  {confirm: "IMPORT"}: one-time import of the public GitHub repository
//     into the Artifacts repo cryptophys/platform (idempotent; an existing repo is left alone).
//   - POST /v1/forge/mirror-token {confirm: "MIRROR"}: a 10-minute, repo-scoped write token for the
//     CI service token only. The mirror workflow pushes GitHub main to the Artifacts repo with it,
//     so both carry the same commit SHAs while GitHub is still the source of truth (phases 1-4).
//   - GET /v1/forge/status, GET /v1/forge/commits: the repo and its main history, for the Console.
// Every write is in the audit chain. Tokens are returned once and never stored or logged.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { accessConfigured, accessGate, actorOf, listConfigured, requireOperator, type AccessIdentity } from "../../control-plane-shared/src/access.ts";
import { errorResponse, healthBody, json, readJsonObject } from "../../control-plane-shared/src/http.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { schemaReady } from "../../control-plane-shared/src/readiness.ts";

export const REPO = "platform";
export const ARTIFACTS_NAMESPACE = "cryptophys";
export const SOURCE_URL = "https://github.com/cryptophys-adm/cryptophys-cloud-platform";
export const MIRROR_TOKEN_TTL_S = 600;

export interface ArtifactsCommit { id?: string; sha?: string; message?: string; author?: { name?: string; email?: string; date?: string } | string; timestamp?: string; date?: string }
export interface ArtifactsRepo {
  info(): Promise<{ name: string; remote: string; defaultBranch?: string; default_branch?: string; lastPushAt?: string | null; last_push_at?: string | null } | null>;
  createToken(scope?: "read" | "write", ttl?: number): Promise<{ plaintext: string; expiresAt: string | number }>;
  log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<ArtifactsCommit[]>;
  [Symbol.dispose]?(): void;
}
export interface ArtifactsBinding {
  list(opts?: { limit?: number; cursor?: string }): Promise<{ repos: Array<{ name: string; status: "ready" | "importing" | "forking" }>; cursor?: string | null }>;
  get(name: string): Promise<ArtifactsRepo>;
  import(params: { source: { url: string; branch?: string }; target: { name: string; opts?: { description?: string } } }): Promise<{ name: string; remote: string }>;
}

export interface Env {
  SERVICE_NAME: string;
  SERVICE_ENVIRONMENT: string;
  API_CONTRACT_VERSION: string;
  CF_VERSION_METADATA?: { id: string; tag?: string };
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  OPERATOR_IDENTITIES?: string;
  APPROVER_IDENTITIES?: string;
  DB: D1Database;
  ARTIFACTS?: ArtifactsBinding;
}

const sha = (c: ArtifactsCommit) => String(c.sha ?? c.id ?? "");
const when = (c: ArtifactsCommit) => String(typeof c.author === "object" ? c.author?.date ?? c.timestamp ?? c.date ?? "" : c.timestamp ?? c.date ?? "");
const who = (c: ArtifactsCommit) => String(typeof c.author === "object" ? c.author?.name ?? "" : c.author ?? "");
export function presentCommit(c: ArtifactsCommit) {
  return { sha: sha(c), title: String(c.message ?? "").split("\n")[0].slice(0, 200), author: who(c).slice(0, 100), date: when(c) };
}

type RepoState = "missing" | "ready" | "importing" | "forking";

async function repoState(env: Env): Promise<RepoState> {
  if (!env.ARTIFACTS) return "missing";
  let cursor: string | undefined;
  do {
    const page = await env.ARTIFACTS.list(cursor ? { limit: 100, cursor } : { limit: 100 });
    const found = page.repos.find((item) => item.name === REPO);
    if (found) return found.status;
    cursor = page.cursor ?? undefined;
  } while (cursor);
  return "missing";
}

async function withRepo<T>(env: Env, fn: (repo: ArtifactsRepo) => Promise<T>): Promise<T | null> {
  if (!env.ARTIFACTS) return null;
  const repo = await env.ARTIFACTS.get(REPO);
  try {
    return await fn(repo);
  } finally {
    repo[Symbol.dispose]?.();
  }
}

export function trustedArtifactsRemote(remote: string): boolean {
  try {
    const url = new URL(remote);
    return url.protocol === "https:"
      && /^[0-9a-f]{32}\.artifacts\.cloudflare\.net$/.test(url.hostname)
      && url.username === ""
      && url.password === ""
      && url.port === ""
      && url.pathname === "/git/" + ARTIFACTS_NAMESPACE + "/" + REPO + ".git"
      && url.search === ""
      && url.hash === "";
  } catch {
    return false;
  }
}

export async function status(env: Env) {
  const state = await repoState(env);
  if (state === "missing") return { repo: null, head: null, configured: Boolean(env.ARTIFACTS), source: SOURCE_URL, status: "not_imported" };
  if (state !== "ready") return { repo: { name: REPO, status: state }, head: null, configured: true, source: SOURCE_URL, status: state };
  const result = await withRepo(env, async (repo) => ({
    info: await repo.info(),
    head: (await repo.log({ ref: "main", limit: 1 }))[0] ?? null,
  }));
  if (!result) return { repo: null, head: null, configured: false, source: SOURCE_URL, status: "not_imported" };
  return {
    repo: result.info ? { name: result.info.name, default_branch: result.info.defaultBranch ?? result.info.default_branch ?? "main", last_push_at: result.info.lastPushAt ?? result.info.last_push_at ?? null } : null,
    head: result.head ? presentCommit(result.head) : null,
    configured: true,
    source: SOURCE_URL,
    status: "ready",
  };
}

export async function commits(env: Env, limit: number) {
  const state = await repoState(env);
  if (state !== "ready") return { commits: [], status: state };
  const rows = await withRepo(env, (repo) => repo.log({ ref: "main", limit: Math.min(Math.max(limit, 1), 100) }));
  return { commits: (rows ?? []).map(presentCommit), status: "ready" };
}

export async function importRepo(env: Env, identity: AccessIdentity): Promise<{ imported: boolean; repo: string; status?: RepoState }> {
  if (!env.ARTIFACTS) throw new Error("artifacts_not_configured");
  const state = await repoState(env);
  if (state !== "missing") return state === "ready" ? { imported: false, repo: REPO } : { imported: false, repo: REPO, status: state };
  await env.ARTIFACTS.import({ source: { url: SOURCE_URL, branch: "main" }, target: { name: REPO, opts: { description: "Cryptophys cloud platform (ADR-0012 Forge)" } } });
  await appendAuditEvent(env.DB, { event_type: "forge.imported", actor: actorOf(identity), subject: REPO, outcome: "succeeded", payload: { source: SOURCE_URL, branch: "main" } });
  return { imported: true, repo: REPO };
}

export async function mirrorToken(env: Env, identity: AccessIdentity): Promise<{ remote: string; token: string; expires_at: string | number }> {
  if (identity.type !== "service_token") throw Object.assign(new Error("service_token_required"), { status: 403 });
  const state = await repoState(env);
  if (state !== "ready") throw Object.assign(new Error(state === "missing" ? "repo_not_imported" : "repo_not_ready"), { status: 409 });
  const result = await withRepo(env, async (repo) => {
    const info = await repo.info();
    const remote = info?.remote ?? "";
    if (!trustedArtifactsRemote(remote)) throw Object.assign(new Error("untrusted_artifacts_remote"), { status: 502 });
    const token = await repo.createToken("write", MIRROR_TOKEN_TTL_S);
    await appendAuditEvent(env.DB, { event_type: "forge.mirror_token_issued", actor: actorOf(identity), subject: REPO, outcome: "issued", payload: { ttl_s: MIRROR_TOKEN_TTL_S } });
    return { remote, token: token.plaintext, expires_at: token.expiresAt };
  });
  if (!result) throw Object.assign(new Error("artifacts_not_configured"), { status: 503 });
  return result;
}

async function readiness(env: Env): Promise<Response> {
  const checks = {
    production_environment: env.SERVICE_ENVIRONMENT === "production",
    database_schema: await schemaReady(env as never),
    operator_identities_configured: listConfigured(env.OPERATOR_IDENTITIES),
    artifacts_binding: Boolean(env.ARTIFACTS),
    access_configured: accessConfigured(env),
  };
  const ready = Object.values(checks).every(Boolean);
  return json({ status: ready ? "ready" : "not_ready", service: env.SERVICE_NAME, production_ready: ready, checks }, ready ? 200 : 503);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const blocked = await accessGate(request, env as never);
    if (blocked) return blocked;
    if (request.method === "GET" && url.pathname === "/health") return json(healthBody(env as never));
    if (request.method === "GET" && url.pathname === "/ready") return readiness(env);
    const operator = await requireOperator(request, env as never);
    if (!operator.ok) return operator.response;
    try {
      if (request.method === "GET" && url.pathname === "/v1/forge/status") return json(await status(env));
      if (request.method === "GET" && url.pathname === "/v1/forge/commits") return json(await commits(env, Number(url.searchParams.get("limit") ?? "20") || 20));
      if (request.method === "POST" && (url.pathname === "/v1/forge/import" || url.pathname === "/v1/forge/mirror-token")) {
        const body = await readJsonObject(request);
        if (!body.ok) return body.response;
        if (url.pathname === "/v1/forge/import") {
          if (body.value.confirm !== "IMPORT") return errorResponse(400, "confirmation_required", 'type "IMPORT" to import the repository');
          return json(await importRepo(env, operator.identity));
        }
        if (body.value.confirm !== "MIRROR") return errorResponse(400, "confirmation_required", 'type "MIRROR" to request a mirror token');
        return json(await mirrorToken(env, operator.identity));
      }
      return errorResponse(404, "not_found");
    } catch (err) {
      const e = err as Error & { status?: number };
      return errorResponse(e.status ?? 500, e.status ? e.message : "internal_error", e.status ? undefined : String(e.message ?? e).slice(0, 200));
    }
  },
};
