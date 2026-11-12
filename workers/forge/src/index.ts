// cryptophys-forge (ADR-0012 phase 1): the Cloudflare-native source of the platform, on Artifacts.
//
// Phase 1 is read-only towards production and changes nothing GitHub does:
//   - POST /v1/forge/import  {confirm: "IMPORT"}: one-time import of the public GitHub repository
//     into the Artifacts repo cryptophys/platform (idempotent; an existing repo is left alone).
//   - POST /v1/forge/mirror-token {confirm: "MIRROR"}: a 10-minute, repo-scoped write token for the
//     CI service token only. The mirror workflow pushes GitHub main to the Artifacts repo with it,
//     so both carry the same commit SHAs while GitHub is still the source of truth (phases 1-4).
//   - GET /v1/forge/status, GET /v1/forge/commits: the repo and its main history, for the Console.
//   - GET /v1/forge/checks: the Forge checks of main's recent commits (phase 3, checks.ts), each
//     next to GitHub CI's conclusion, and the parity count towards phase 4.
//   - POST /v1/forge/ci-report {confirm: "REPORT"}: GitHub CI's conclusion for a commit of main, from
//     the CI service token only (forge-ci-report.yml), while GitHub is still the source of truth.
//   - POST /v1/forge/typecheck-report {confirm: "REPORT"}: the type-check result of a commit from
//     Workers Builds (workers/forge-typecheck), CI service token only (ADR-0012 §5c).
//   - Change requests (phase 4, shadow; changes.ts): POST /v1/forge/changes {confirm: "REGISTER"} and
//     POST /v1/forge/changes/outcome {confirm: "REPORT"} from the CI service token only;
//     GET /v1/forge/changes lists them with the Forge's merge verdict and the merge parity.
//   - GET /v1/forge/build-usage (owner 2026-11-12): the account's measured Workers Builds minutes this month
//     against the free-tier budget, and the newest collected builds (build-usage.ts).
//   - GET /v1/forge/deploy-plans (phase 4, shadow; deploy-plan.ts): the Forge's deploy plan for main
//     next to the Orchestrator's GitHub-based plan for the same inputs, and the deploy-plan parity.
// Every write is in the audit chain. Tokens are returned once and never stored or logged.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { accessConfigured, accessGate, actorOf, listConfigured, requireOperator, type AccessIdentity } from "../../control-plane-shared/src/access.ts";
import { errorResponse, healthBody, json, readJsonObject } from "../../control-plane-shared/src/http.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { schemaReady } from "../../control-plane-shared/src/readiness.ts";
import { listChecks, recordCiReport, type ArtifactsReader } from "./checks.ts";
import { recordTypecheckReport } from "./typecheck.ts";
import { listChanges, recordOutcome, registerChange } from "./changes.ts";
import { listDeployPlans } from "./deploy-plan.ts";
import { latestCensus } from "./census.ts";
import { recentBuilds } from "./build-usage.ts";
import { buildUsage } from "../../control-plane-shared/src/build-usage.ts";

export const REPO = "platform";
export const ARTIFACTS_NAMESPACE = "cryptophys";
export const SOURCE_URL = "https://github.com/cryptophys-adm/cryptophys-cloud-platform";
export const MIRROR_TOKEN_TTL_S = 600;
/** The Forge's own tables (ADR-0012 phase 3): it is not ready before they exist. */
export const FORGE_MIGRATIONS = ["0031_forge_check_runs.sql", "0032_forge_ci_reports.sql", "0033_forge_check_steps.sql", "0035_forge_typecheck_reports.sql", "0036_forge_console_build.sql", "0037_forge_change_requests.sql", "0038_forge_deploy_plans.sql", "0039_forge_check_source.sql", "0040_forge_organism_census.sql", "0041_organism_registration.sql"] as const;

export type ArtifactsCommit = Record<string, unknown>;
export interface ArtifactsRepo {
  info(): Promise<{ name: string; remote: string; defaultBranch?: string; default_branch?: string; lastPushAt?: string | null; last_push_at?: string | null } | null>;
  createToken(scope?: "read" | "write", ttl?: number): Promise<{ plaintext: string; expiresAt: string | number }>;
  log(opts?: { ref?: string; limit?: number; offset?: number }): Promise<ArtifactsCommit[]>;
  readCommit: ArtifactsReader["readCommit"];
  readTree: ArtifactsReader["readTree"];
  readBlob: ArtifactsReader["readBlob"];
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
  /** ADR-0012 §5d: the owner's Workers Builds API token (Forge secret), read only by cr-builds.ts. */
  CF_BUILDS_API_TOKEN?: string;
  CR_TYPECHECK_WORKER?: string;
}

const HEX40 = /^[0-9a-f]{40}$/;
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? v as Record<string, unknown> : {});
const str = (v: unknown) => (typeof v === "string" ? v : "");
function isoTime(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) {
    const date = new Date(v < 1e12 ? v * 1000 : v);
    return Number.isNaN(date.getTime()) ? "" : date.toISOString();
  }
  if (typeof v === "string") {
    const millis = Date.parse(v);
    return Number.isNaN(millis) ? "" : new Date(millis).toISOString();
  }
  return "";
}
export function presentCommit(c: ArtifactsCommit) {
  const author = obj(c.author);
  // Only documented commit-id fields are accepted. An arbitrary 40-hex value may be a tree or parent hash.
  const commitSha = [c.hash, c.oid, c.sha, c.id, c.commit].map(str).find((v) => HEX40.test(v)) ?? "";
  const date = [author.date, author.timestamp, author.time, author.when, c.timestamp, c.date, c.authorDate, c.author_date, c.authoredAt, c.authored_at, c.committedAt, c.committed_at, obj(c.committer).timestamp, obj(c.committer).date]
    .map(isoTime).find(Boolean) ?? "";
  return {
    sha: commitSha,
    title: str(c.message).split("\n")[0].slice(0, 200),
    author: (str(author.name) || str(c.author)).slice(0, 100),
    date,
  };
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
    database_schema: await schemaReady(env as never, FORGE_MIGRATIONS),
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
      if (request.method === "GET" && url.pathname === "/v1/forge/checks") return json(await listChecks(env.DB, Number(url.searchParams.get("limit") ?? "20") || 20));
      if (request.method === "GET" && url.pathname === "/v1/forge/commits") return json(await commits(env, Number(url.searchParams.get("limit") ?? "20") || 20));
      if (request.method === "GET" && url.pathname === "/v1/forge/build-usage") return json({ usage: await buildUsage(env.DB, Date.now()), builds: await recentBuilds(env.DB, Number(url.searchParams.get("limit") ?? "15") || 15) });
      if (request.method === "GET" && url.pathname === "/v1/forge/census") return json(await latestCensus(env.DB, Number(url.searchParams.get("limit") ?? "5") || 5));
      if (request.method === "GET" && url.pathname === "/v1/forge/deploy-plans") return json(await listDeployPlans(env.DB, Number(url.searchParams.get("limit") ?? "10") || 10));
      if (request.method === "GET" && url.pathname === "/v1/forge/changes") return json(await listChanges(env.DB, Number(url.searchParams.get("limit") ?? "20") || 20));
      if (request.method === "POST" && (url.pathname === "/v1/forge/changes" || url.pathname === "/v1/forge/changes/outcome")) {
        if (operator.identity.type !== "service_token") return errorResponse(403, "service_token_required");
        const body = await readJsonObject(request);
        if (!body.ok) return body.response;
        const actor = actorOf(operator.identity);
        if (url.pathname === "/v1/forge/changes/outcome") {
          if (body.value.confirm !== "REPORT") return errorResponse(400, "confirmation_required", 'type "REPORT" to record a pull request outcome');
          return json({ change: await recordOutcome(env.DB, body.value as never, actor) });
        }
        if (body.value.confirm !== "REGISTER") return errorResponse(400, "confirmation_required", 'type "REGISTER" to register a change request');
        if ((await repoState(env)) !== "ready") return errorResponse(409, "repo_not_ready");
        const change = await withRepo(env, (repo) => registerChange(env.DB, repo, body.value as never, actor));
        return change ? json({ change }) : errorResponse(503, "artifacts_not_configured");
      }
      if (request.method === "POST" && (url.pathname === "/v1/forge/import" || url.pathname === "/v1/forge/mirror-token" || url.pathname === "/v1/forge/ci-report" || url.pathname === "/v1/forge/typecheck-report")) {
        const body = await readJsonObject(request);
        if (!body.ok) return body.response;
        if (url.pathname === "/v1/forge/ci-report") {
          if (operator.identity.type !== "service_token") return errorResponse(403, "service_token_required");
          if (body.value.confirm !== "REPORT") return errorResponse(400, "confirmation_required", 'type "REPORT" to record a CI result');
          return json(await recordCiReport(env.DB, body.value as never, actorOf(operator.identity)));
        }
        if (url.pathname === "/v1/forge/typecheck-report") {
          if (operator.identity.type !== "service_token") return errorResponse(403, "service_token_required");
          if (body.value.confirm !== "REPORT") return errorResponse(400, "confirmation_required", 'type "REPORT" to record a type-check result');
          return json(await recordTypecheckReport(env.DB, body.value as never, actorOf(operator.identity)));
        }
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
