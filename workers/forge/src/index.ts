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
export const SOURCE_URL = "https://github.com/cryptophys-adm/cryptophys-cloud-platform";
export const MIRROR_TOKEN_TTL_S = 600;

/** The subset of the Artifacts Workers binding the Forge uses (Artifacts docs, 2026-10). */
/** Commit metadata from log(): field names vary by binding version, so they are read defensively. */
export type ArtifactsCommit = Record<string, unknown>;
export interface ArtifactsRepo {
  info(): Promise<{ name: string; remote: string; defaultBranch?: string; default_branch?: string; lastPushAt?: string | null; last_push_at?: string | null } | null>;
  createToken(scope?: "read" | "write", ttl?: number): Promise<{ plaintext: string; expiresAt: string | number }>;
  log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<ArtifactsCommit[]>;
  [Symbol.dispose]?(): void;
}
export interface ArtifactsBinding {
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

const HEX40 = /^[0-9a-f]{40}$/;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? v as Record<string, unknown> : {});
const str = (v: unknown) => (typeof v === "string" ? v : "");
/** Seconds or milliseconds since the epoch, or an ISO string, as ISO; anything else as "". */
function isoTime(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return "";
}
export function presentCommit(c: ArtifactsCommit) {
  const author = obj(c.author);
  const named = [c.hash, c.oid, c.sha, c.id, c.commit].map(str).find((v) => HEX40.test(v));
  const sha = named ?? Object.values(c).map(str).find((v) => HEX40.test(v)) ?? "";
  const date = [author.date, author.timestamp, author.time, author.when, c.timestamp, c.date, c.authorDate, c.author_date, obj(c.committer).timestamp, obj(c.committer).date]
    .map(isoTime).find(Boolean) ?? "";
  return {
    sha,
    title: str(c.message).split("\n")[0].slice(0, 200),
    author: (str(author.name) || str(c.author)).slice(0, 100),
    date,
  };
}

async function openRepo(env: Env): Promise<ArtifactsRepo | null> {
  if (!env.ARTIFACTS) return null;
  try { return await env.ARTIFACTS.get(REPO); } catch { return null; }
}

export async function status(env: Env) {
  const repo = await openRepo(env);
  if (!repo) return { repo: null, configured: Boolean(env.ARTIFACTS), source: SOURCE_URL };
  const info = await repo.info();
  const head = (await repo.log({ ref: "main", limit: 1 }))[0];
  return {
    repo: info ? { name: info.name, default_branch: info.defaultBranch ?? info.default_branch ?? "main", last_push_at: info.lastPushAt ?? info.last_push_at ?? null } : null,
    head: head ? presentCommit(head) : null,
    configured: true, source: SOURCE_URL,
  };
}

export async function commits(env: Env, limit: number) {
  const repo = await openRepo(env);
  if (!repo) return { commits: [] };
  return { commits: (await repo.log({ ref: "main", limit: Math.min(Math.max(limit, 1), 100) })).map(presentCommit) };
}

/** One-time import of the GitHub repository. An existing repo is never replaced. */
export async function importRepo(env: Env, identity: AccessIdentity): Promise<{ imported: boolean; repo: string }> {
  if (!env.ARTIFACTS) throw new Error("artifacts_not_configured");
  if (await openRepo(env)) return { imported: false, repo: REPO };
  await env.ARTIFACTS.import({ source: { url: SOURCE_URL, branch: "main" }, target: { name: REPO, opts: { description: "Cryptophys cloud platform (ADR-0012 Forge)" } } });
  await appendAuditEvent(env.DB, { event_type: "forge.imported", actor: actorOf(identity), subject: REPO, outcome: "succeeded", payload: { source: SOURCE_URL, branch: "main" } });
  return { imported: true, repo: REPO };
}

/** A short-lived write token for the mirror workflow. Only a service token (the CI identity) gets one. */
export async function mirrorToken(env: Env, identity: AccessIdentity): Promise<{ remote: string; token: string; expires_at: string | number }> {
  if (identity.type !== "service_token") throw Object.assign(new Error("service_token_required"), { status: 403 });
  const repo = await openRepo(env);
  if (!repo) throw Object.assign(new Error("repo_not_imported"), { status: 409 });
  const info = await repo.info();
  if (!info?.remote) throw new Error("repo_remote_unavailable");
  const t = await repo.createToken("write", MIRROR_TOKEN_TTL_S);
  await appendAuditEvent(env.DB, { event_type: "forge.mirror_token_issued", actor: actorOf(identity), subject: REPO, outcome: "issued", payload: { ttl_s: MIRROR_TOKEN_TTL_S } });
  return { remote: info.remote, token: t.plaintext, expires_at: t.expiresAt };
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
