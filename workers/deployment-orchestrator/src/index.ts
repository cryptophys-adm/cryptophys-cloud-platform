import { explainCode, serviceName } from "../../control-plane-shared/src/plain.ts";
import type { AiBinding, D1Database, ExecutionContextLike, ScheduledEventLike } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { boundedString, boundedStringArray, engineFor, type AiTask } from "../../control-plane-shared/src/ai-engine.ts";
import { schemaReady } from "../../control-plane-shared/src/readiness.ts";
import { accessConfigured, actorOf, authenticate, identityAllowed, requireOperator } from "../../control-plane-shared/src/access.ts";
import { healthBody } from "../../control-plane-shared/src/http.ts";
import { publishAgentReport, type AgentRpcBinding } from "../../control-plane-shared/src/agents.ts";
import { verifyConsensusExecution } from "../../control-plane-shared/src/consensus-exec.ts";
import { DEPLOY_UNITS, isMigration, orderPending, recordPlanSide, registryFingerprint, unitChanged, unitForService, unitRegistryState, type DeployUnit, type PlannedUnit, type Skip } from "../../control-plane-shared/src/deploy-units.ts";
import { forgeMainHead, forgePendingDeploys, forgeReady } from "../../control-plane-shared/src/forge-gate.ts";
import { CloudflareWorkers, executeRollback, NATIVE_EXECUTOR, nativeRollbackConfigured, SAFE_MINUTES, type NativeRollbackEnv } from "./native-rollback.ts";
import { executeNativeDeploy, NATIVE_DEPLOY_EXECUTOR, nativeDeployConfigured, nativeDeployEligible, type BundleReader, type PlannedMigration, type PlannedService } from "./native-deploy.ts";

interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete?(key: string): Promise<boolean | void>;
}
interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}
interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
}
export interface Env extends NativeRollbackEnv {
  SERVICE_NAME: string;
  SERVICE_ENVIRONMENT: string;
  API_CONTRACT_VERSION: string;
  GH_ACTIONS_TOKEN: string;
  /**
   * Comma-separated Cloudflare Access identities allowed to request production deployments:
   * service-token Client IDs and/or operator emails. Replaces the former shared secret.
   */
  DEPLOY_ALLOWED_IDENTITIES?: string;
  /** Operators (the same list); with D1 accounts they may read the deployments list (viewers too). */
  OPERATOR_IDENTITIES?: string;
  APPROVER_IDENTITIES?: string;
  DEPLOYMENT_LOCK: DurableObjectNamespaceLike;
  CF_VERSION_METADATA?: { id: string; tag?: string };
  /** Shared control-plane D1: deployment ledger, audit log and AI budget. */
  DB: D1Database;
  /** AI Kernel agent binding (advisory reports). */
  AGENTS?: AgentRpcBinding;
  /** Dedicated Deployment Orchestrator AI engine (advisory only). */
  AI?: AiBinding;
  AI_MODEL?: string;
  AI_DAILY_REQUEST_LIMIT?: string;
  AI_ACCOUNT_DAILY_REQUEST_LIMIT?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** ADR-0012 G2b: the Forge's bundles (R2 cryptophys-forge-bundles), read only. */
  BUNDLES?: BundleReader;
}

const SERVICE = "cryptophys-deployment-orchestrator";
const TARGET_SERVICE = "cryptophys-platform-api";

interface RiskSummary { summary: string; risk_level: "low" | "medium" | "high"; notes: string[] }

/** Advisory only: never consulted for authorization, CI gating, locking or dispatch. */
const riskTask: AiTask<RiskSummary> = {
  name: "summarize_deployment_risk",
  instructions:
    'Summarize an already-dispatched production deployment for operators from the supplied evidence. Return ' +
    '{"summary": at most 400 characters, "risk_level": "low" | "medium" | "high", "notes": up to 4 strings of at most 160 characters}.',
  maxInputChars: 8000,
  maxOutputTokens: 300,
  validate(output) {
    const o = output as Record<string, unknown>;
    const summary = boundedString(o?.summary, 400);
    const notes = boundedStringArray(o?.notes, 4, 160);
    const level = o?.risk_level;
    if (!summary || !notes || (level !== "low" && level !== "medium" && level !== "high")) return null;
    return { summary, risk_level: level, notes };
  }
};

/** Best-effort audit for rejections; a failure here must not change the response. */
async function auditQuietly(env: Env, event: Parameters<typeof appendAuditEvent>[1]): Promise<string | null> {
  try {
    return (await appendAuditEvent(env.DB, event)).event_id;
  } catch (err) {
    console.error(JSON.stringify({ service: SERVICE, event: "audit_write_failed", message: String((err as Error)?.message ?? err) }));
    return null;
  }
}

const REPOSITORY = "cryptophys-adm/cryptophys-cloud-platform";
const WORKFLOW = "deploy-platform-api.yml";
const API = "https://api.github.com";
const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data, null, 2), { status, headers });

async function gh(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(API + path, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: "Bearer " + token,
      "x-github-api-version": "2022-11-28",
      "user-agent": "cryptophys-deployment-orchestrator",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers
    }
  });
}

/**
 * Dispatch a workflow on main. GitHub answered one consensus deploy with HTTP 500 (2026-11-09
 * 10:38 UTC). A 5xx or 429 is retried once after a pause, unless a dispatched run of that workflow
 * appeared meanwhile (an ambiguous failure that did start a run). Returns the final status.
 */
export const DISPATCH_RETRY_MS = 3_000;
export async function dispatchWorkflow(token: string, workflow: string, inputs: Record<string, string>, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<{ status: number; attempts: number }> {
  const send = () => gh(token, "/repos/" + REPOSITORY + "/actions/workflows/" + workflow + "/dispatches", { method: "POST", body: JSON.stringify({ ref: "main", inputs }) });
  const started = Date.now();
  const first = await send();
  if (first.status < 500 && first.status !== 429) return { status: first.status, attempts: 1 };
  await sleep(DISPATCH_RETRY_MS);
  const runs = await gh(token, "/repos/" + REPOSITORY + "/actions/workflows/" + workflow + "/runs?event=workflow_dispatch&per_page=5");
  if (runs.ok) {
    const recent = ((await runs.json()) as { workflow_runs?: Array<{ created_at?: string }> }).workflow_runs ?? [];
    if (recent.some((r) => Date.parse(r.created_at ?? "") >= started - 10_000)) return { status: 204, attempts: 1 };
  }
  return { status: (await send()).status, attempts: 2 };
}

/** Release a dispatch lock when nothing was dispatched, so a later proposal or plan can try again. */
async function releaseLock(env: Env, name: string, sha: string): Promise<void> {
  try {
    await env.DEPLOYMENT_LOCK!.get(env.DEPLOYMENT_LOCK!.idFromName(name))
      .fetch("https://lock.internal/release", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha }) });
  } catch { /* the lock stays claimed: the next main commit uses a new lock */ }
}

type CommitStatus = { state?: string; total_count?: number };
type WorkflowRun = { workflow_id: number; name: string; path?: string; event?: string; head_branch?: string; status: string; conclusion: string | null; run_number: number; run_attempt?: number };

/** Latest run of each validation/deployment workflow. */
export function latestRunPerWorkflow(runs: WorkflowRun[]): WorkflowRun[] {
  const latest = new Map<number, WorkflowRun>();
  for (const run of runs) {
    // Scheduled runs (e.g. drift monitoring) observe production; they are not CI for the commit.
    if (run.event === "schedule") continue;
    const seen = latest.get(run.workflow_id);
    if (!seen || run.run_number > seen.run_number || (run.run_number === seen.run_number && (run.run_attempt ?? 1) > (seen.run_attempt ?? 1))) {
      latest.set(run.workflow_id, run);
    }
  }
  return [...latest.values()];
}

// ADR-0009 phase 3 deploy units and their ordering rules live in the shared library, so the Forge
// computes the same plan from Artifacts (ADR-0012 phase 4, shadow).
export { DEPLOY_UNITS, unitChanged, unitForService, type DeployUnit } from "../../control-plane-shared/src/deploy-units.ts";

/** CI for a consensus deploy: the push-event validation runs on the commit, all green. Deploy runs are not CI. */
// "Validate" (validate.yml) was merged into "Validate Control Plane Workers" by the 2026-11-08
// hardening (#229). Requiring it afterwards made every consensus deploy fail closed as ci_not_green.
// A wiring test keeps every name here equal to an existing workflow's name.
export const REQUIRED_PUSH_VALIDATIONS = ["Validate Control Plane Workers"] as const;

/** Consensus deploys require the combined commit-status gate and both push validations on main.
 * Missing, pending, skipped or unreadable evidence fails closed. */
export async function ciGreen(token: string, sha: string): Promise<{ green: boolean; workflows: { name: string; conclusion: string | null }[] }> {
  const [statusRes, runsRes] = await Promise.all([
    gh(token, "/repos/" + REPOSITORY + "/commits/" + sha + "/status"),
    gh(token, "/repos/" + REPOSITORY + "/actions/runs?head_sha=" + sha + "&event=push&per_page=100"),
  ]);
  if (!statusRes.ok || !runsRes.ok) return { green: false, workflows: [] };
  const statusData = await statusRes.json() as CommitStatus;
  const runsData = await runsRes.json() as { total_count?: number; workflow_runs?: WorkflowRun[] };
  const allRuns = runsData.workflow_runs ?? [];
  // Do not accept a truncated Actions response or a push from a branch other than main.
  if (typeof runsData.total_count !== "number" || runsData.total_count > allRuns.length) return { green: false, workflows: [] };
  const runs = latestRunPerWorkflow(allRuns.filter((r) => r.event === "push" && r.head_branch === "main"));
  const statusGreen = typeof statusData.total_count === "number"
    && (statusData.total_count === 0 || statusData.state === "success");
  const requiredGreen = REQUIRED_PUSH_VALIDATIONS.every((name) =>
    runs.some((r) => r.name === name && r.status === "completed" && r.conclusion === "success"),
  );
  const green = statusGreen && requiredGreen && runs.every((r) => r.status === "completed" && r.conclusion === "success");
  return { green, workflows: runs.map(({ name, conclusion }) => ({ name, conclusion })) };
}

async function mainSha(token: string): Promise<string | null> {
  const res = await gh(token, "/repos/" + REPOSITORY + "/git/ref/heads/main");
  if (!res.ok) return null;
  const sha = (await res.json() as { object?: { sha?: string } }).object?.sha ?? "";
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

export interface PendingDeploys {
  main_sha: string | null;
  ci_green: boolean;
  units: { unit: string; workflow: string; target: string; reason: string }[];
  skipped: { unit: string; reason: string }[];
}

/**
 * Which deploy units have changes on a ready main that production does not run yet (ADR-0012 G1, owner
 * 2026-11-12): decided by the Forge from the Artifacts repository (forge-gate.ts), not by GitHub. Read-only;
 * the supervisor proposes deploy_commit for each pending unit; nothing is dispatched here.
 */
export async function pendingDeploys(env: Env): Promise<PendingDeploys> {
  return forgePendingDeploys(env.DB);
}

/**
 * The deploy gate of a commit (ADR-0012 G1): it is main's head as the Forge planned it, and the Forge's checks
 * are ready. The native deploy (G2b) needs nothing more.
 */
async function forgeDecision(env: Env, sha: string): Promise<{ workflows: { name: string; conclusion: string | null }[] }> {
  const head = await forgeMainHead(env.DB);
  if (!head.sha) throw new Error(head.reason);
  if (head.sha !== sha) throw new Error("commit_not_current_main");
  const gate = await forgeReady(env.DB, sha);
  if (!gate.ready) throw new Error("ci_not_green");
  return { workflows: [{ name: "Forge checks", conclusion: "success" }] };
}

/**
 * The GitHub path's gate: the Forge's decision, and GitHub's main is the same commit, because the unit's GitHub
 * workflow deploys only GitHub's main head (the mirror may lag by a push).
 */
async function forgeGate(env: Env, sha: string): Promise<{ workflows: { name: string; conclusion: string | null }[] }> {
  const decision = await forgeDecision(env, sha);
  if (await mainSha(env.GH_ACTIONS_TOKEN!) !== sha) throw new Error("github_main_not_mirrored");
  return decision;
}

type NativeChoice = { eligible: true; services: PlannedService[]; migrations: PlannedMigration[] } | { eligible: false; reason: string; service?: string; file?: string };

/**
 * G2b: whether this unit can deploy `sha` natively; the reason when not (recorded with the GitHub dispatch).
 * G2c-2: a configuration change is planned against the active versions, read (never written) with the deploy token.
 */
async function nativeDeployChoice(env: Env, unit: DeployUnit, sha: string): Promise<NativeChoice> {
  if (!nativeDeployConfigured(env)) return { eligible: false, reason: "not_configured" };
  const e = await nativeDeployEligible(env, unit, sha, new CloudflareWorkers(env.CF_DEPLOY_TOKEN!, env.CF_ACCOUNT_ID!));
  return e.eligible
    ? { eligible: true, services: e.services, migrations: e.migrations }
    : { eligible: false, reason: e.reason, ...(e.service ? { service: e.service } : {}), ...(e.file ? { file: e.file } : {}) };
}
const ineligibility = (c: NativeChoice) => c.eligible ? null : { reason: c.reason, ...(c.service ? { service: c.service } : {}), ...(c.file ? { file: c.file } : {}) };

/**
 * Execute a consensus-approved deploy_commit (ADR-0009 phase 3). Re-verifies the proposal and
 * its fresh Policy Engine allow, then requires the commit to be current main with green CI,
 * claims a per-workflow-and-commit lock, records the request and dispatches the unit's
 * workflow. The workflow keeps all its own gates and rolls back automatically on failure.
 *
 * ADR-0012 G2b: when the native deploy is configured and the change is code only for every Worker of the
 * unit, the request is queued for the Orchestrator's own executor instead, and GitHub is not involved.
 */
export async function deployForConsensus(env: Env, proposalId: string, decisionId: string, target: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  await verifyConsensusExecution(env.DB, proposalId, decisionId, "deploy_commit", target);
  const unit = unitForService(target);
  if (!unit) throw new Error("no_deploy_unit_for_target");
  const sha = typeof params.commit_sha === "string" ? params.commit_sha : "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("invalid_commit_sha");
  const native = nativeDeployConfigured(env);
  if (!env.DEPLOYMENT_LOCK || (!native && !env.GH_ACTIONS_TOKEN)) throw new Error("not_configured");
  const actor = `consensus:${proposalId}`;
  let nativeChoice: NativeChoice = { eligible: false, reason: "not_configured" };
  if (native) {
    await forgeDecision(env, sha);
    nativeChoice = await nativeDeployChoice(env, unit, sha);
    if (nativeChoice.eligible) {
      // The same lock as the GitHub path: a commit is either queued here or dispatched there, once.
      const lockName = `consensus:${unit.workflow}:${sha}`;
      const nativeLock = await env.DEPLOYMENT_LOCK.get(env.DEPLOYMENT_LOCK.idFromName(lockName))
        .fetch("https://lock.internal/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha }) });
      const claimed = await nativeLock.json() as { claimed?: boolean };
      if (!nativeLock.ok || !claimed.claimed) return { dispatched: false, reason: "already_dispatched", executor: NATIVE_DEPLOY_EXECUTOR, unit: unit.unit, commit_sha: sha };
      return queueNativeDeploy(env, { proposal_id: proposalId, policy_decision_id: decisionId }, target, unit, sha, nativeChoice, lockName);
    }
    if (!env.GH_ACTIONS_TOKEN) throw new Error("not_configured");
  }
  const ci = await forgeGate(env, sha);
  const lockResponse = await env.DEPLOYMENT_LOCK.get(env.DEPLOYMENT_LOCK.idFromName(`consensus:${unit.workflow}:${sha}`))
    .fetch("https://lock.internal/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha }) });
  const lock = await lockResponse.json() as { claimed?: boolean };
  if (!lockResponse.ok || !lock.claimed) return { dispatched: false, reason: "already_dispatched", workflow: unit.workflow, commit_sha: sha };
  const requestId = "dep_" + crypto.randomUUID();
  const at = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?)`,
  ).bind(requestId, target, sha, actor, proposalId, `consensus:${unit.workflow}:${sha}`,
    JSON.stringify({ workflow: unit.workflow, unit: unit.unit, ref: "main", workflows: ci.workflows, proposal_id: proposalId, policy_decision_id: decisionId }), at, at).run();
  const dispatch = await dispatchWorkflow(env.GH_ACTIONS_TOKEN, unit.workflow, { confirm_production: "DEPLOY", commit_sha: sha });
  const status = dispatch.status === 204 ? "running" : "failed";
  await env.DB.prepare("UPDATE deployment_requests SET status = ?, updated_at = ? WHERE request_id = ?").bind(status, new Date().toISOString(), requestId).run();
  await appendAuditEvent(env.DB, {
    event_type: dispatch.status === 204 ? "deployment.dispatched" : "deployment.dispatch_failed", actor, subject: target, outcome: status,
    payload: { request_id: requestId, commit_sha: sha, workflow: unit.workflow, unit: unit.unit, github_status: dispatch.status, attempts: dispatch.attempts, proposal_id: proposalId,
      native_deploy: ineligibility(nativeChoice) },
  });
  if (dispatch.status !== 204) { await releaseLock(env, `consensus:${unit.workflow}:${sha}`, sha); throw new Error(`dispatch_failed_${dispatch.status}`); }
  return { dispatched: true, request_id: requestId, workflow: unit.workflow, unit: unit.unit, commit_sha: sha };
}

/**
 * Autonomous recovery (owner decision 2026-11-06): the Recovery Manager's lifecycle Workflow
 * asks for the redeploy step of an approved, executing plan. The orchestrator verifies, in its
 * own code, that the plan is executing, that its recorded Policy Engine decision allowed
 * recovery.execute for exactly this plan within the last 2 hours, and that the plan's version
 * is the current main commit with green CI. It then dispatches the service's deploy workflow,
 * which keeps every gate and rolls back automatically on failure.
 */
export const RECOVERY_DECISION_WINDOW_MS = 2 * 3_600_000;

/** The plan is executing, names this service, and its own recovery.execute allow is fresh (2 h). */
async function verifyRecoveryExecution(env: Env, planId: string, decisionId: string, serviceId: string): Promise<{ plan_version: string }> {
  if (!/^plan_[0-9a-f-]{36}$/.test(planId) || !/^dec_[0-9a-f-]{36}$/.test(decisionId)) throw new Error("invalid_ids");
  const plan = await env.DB.prepare("SELECT service_id, status, plan_version, last_execution_json FROM recovery_plans WHERE plan_id = ?")
    .bind(planId).first<{ service_id: string; status: string; plan_version: string; last_execution_json: string | null }>();
  const exec = plan?.last_execution_json ? JSON.parse(plan.last_execution_json) : {};
  if (!plan || plan.status !== "executing" || plan.service_id !== serviceId || exec.policy_decision_id !== decisionId) throw new Error("plan_not_executing");
  const d = await env.DB.prepare("SELECT action, resource, decision, created_at FROM policy_decisions WHERE decision_id = ?")
    .bind(decisionId).first<{ action: string; resource: string; decision: string; created_at: string }>();
  const age = d ? Date.now() - Date.parse(d.created_at) : Number.NaN;
  if (!d || d.action !== "recovery.execute" || d.resource !== planId || d.decision !== "allow" || !(age >= 0 && age <= RECOVERY_DECISION_WINDOW_MS)) {
    throw new Error("recovery_decision_invalid");
  }
  return { plan_version: plan.plan_version };
}

/**
 * ADR-0012 G2c-1: when the redeploy is eligible for the native path, it is queued for the Orchestrator's own
 * executor (the same signed request as a consensus deploy, linked to the plan) and the Recovery Manager follows it
 * by request id (`requestStatus`); otherwise the unit's GitHub workflow is dispatched exactly as before.
 */
export async function deployForRecovery(env: Env, planId: string, decisionId: string, serviceId: string, version: string): Promise<Record<string, unknown>> {
  if (!/^[0-9a-f]{7,40}$/.test(version)) throw new Error("invalid_version");
  const plan = await verifyRecoveryExecution(env, planId, decisionId, serviceId);
  if (plan.plan_version !== version) throw new Error("plan_not_executing");
  const unit = unitForService(serviceId);
  if (!unit) throw new Error("no_deploy_unit_for_service");
  const native = nativeDeployConfigured(env);
  if (!env.DEPLOYMENT_LOCK || (!native && !env.GH_ACTIONS_TOKEN)) throw new Error("not_configured");
  // ADR-0012 G1: main's head and its readiness come from the Forge. The deploy workflows deploy only the exact current main commit.
  const head = await forgeMainHead(env.DB);
  if (!head.sha) throw new Error(head.reason);
  const sha = head.sha;
  if (!sha.startsWith(version)) throw new Error(`version_not_current_main: plan ${version}, main ${sha.slice(0, 12)}; a new plan is needed`);
  let nativeChoice: NativeChoice = { eligible: false, reason: "not_configured" };
  if (native) {
    await forgeDecision(env, sha);
    nativeChoice = await nativeDeployChoice(env, unit, sha);
    if (nativeChoice.eligible) {
      // The recovery path's lock, as for the workflow: a plan's commit is queued here or dispatched there, once.
      const lockName = `recovery:${unit.workflow}:${sha}`;
      const nativeLock = await env.DEPLOYMENT_LOCK.get(env.DEPLOYMENT_LOCK.idFromName(lockName))
        .fetch("https://lock.internal/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha }) });
      const claimed = await nativeLock.json() as { claimed?: boolean };
      if (!nativeLock.ok || !claimed.claimed) {
        // A retried step finds the request it queued before, so the lifecycle can still follow it.
        const prior = await env.DB.prepare("SELECT request_id FROM deployment_requests WHERE service_id = ? AND idempotency_key = ? AND requested_by = ? ORDER BY created_at DESC LIMIT 1")
          .bind(serviceId, lockName, `recovery:${planId}`).first<{ request_id: string }>();
        return { dispatched: false, reason: "already_dispatched", executor: NATIVE_DEPLOY_EXECUTOR, unit: unit.unit, commit_sha: sha, ...(prior ? { request_id: prior.request_id } : {}) };
      }
      return queueNativeDeploy(env, { plan_id: planId, policy_decision_id: decisionId }, serviceId, unit, sha, nativeChoice, lockName);
    }
    if (!env.GH_ACTIONS_TOKEN) throw new Error("not_configured");
  }
  const ci = await forgeGate(env, sha);
  const actor = `recovery:${planId}`;
  const lockResponse = await env.DEPLOYMENT_LOCK.get(env.DEPLOYMENT_LOCK.idFromName(`recovery:${unit.workflow}:${sha}`))
    .fetch("https://lock.internal/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha }) });
  const lock = await lockResponse.json() as { claimed?: boolean };
  if (!lockResponse.ok || !lock.claimed) return { dispatched: false, reason: "already_dispatched", workflow: unit.workflow, commit_sha: sha };
  const requestId = "dep_" + crypto.randomUUID();
  const at = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?)`,
  ).bind(requestId, serviceId, sha, actor, planId, `recovery:${planId}`,
    JSON.stringify({ workflow: unit.workflow, unit: unit.unit, ref: "main", workflows: ci.workflows, plan_id: planId, policy_decision_id: decisionId }), at, at).run();
  const dispatch = await dispatchWorkflow(env.GH_ACTIONS_TOKEN, unit.workflow, { confirm_production: "DEPLOY", commit_sha: sha });
  const status = dispatch.status === 204 ? "running" : "failed";
  await env.DB.prepare("UPDATE deployment_requests SET status = ?, updated_at = ? WHERE request_id = ?").bind(status, new Date().toISOString(), requestId).run();
  await appendAuditEvent(env.DB, {
    event_type: dispatch.status === 204 ? "deployment.dispatched" : "deployment.dispatch_failed", actor, subject: serviceId, outcome: status,
    payload: { request_id: requestId, commit_sha: sha, workflow: unit.workflow, unit: unit.unit, github_status: dispatch.status, attempts: dispatch.attempts, plan_id: planId,
      native_deploy: ineligibility(nativeChoice) },
  });
  if (dispatch.status !== 204) { await releaseLock(env, `recovery:${unit.workflow}:${sha}`, sha); throw new Error(`dispatch_failed_${dispatch.status}`); }
  return { dispatched: true, request_id: requestId, workflow: unit.workflow, unit: unit.unit, commit_sha: sha };
}

/** Read-only: the newest dispatched run of one deploy (or rollback) workflow on one commit (for pipeline progress). */
export async function runStatus(env: Env, workflow: string, commitSha: string): Promise<{ found: boolean; status?: string; conclusion?: string | null; run_id?: number; url?: string }> {
  if (!(DEPLOY_UNITS.some((u) => u.workflow === workflow) || workflow === ROLLBACK_WORKFLOW) || !/^[0-9a-f]{40}$/.test(commitSha) || !env.GH_ACTIONS_TOKEN) return { found: false };
  const res = await gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/actions/workflows/" + workflow + "/runs?event=workflow_dispatch&head_sha=" + commitSha + "&per_page=5");
  if (!res.ok) return { found: false };
  const runs = ((await res.json()) as { workflow_runs?: { id: number; status: string; conclusion: string | null; html_url: string; run_number: number }[] }).workflow_runs ?? [];
  const run = runs.sort((a, b) => b.run_number - a.run_number)[0];
  return run ? { found: true, status: run.status, conclusion: run.conclusion, run_id: run.id, url: run.html_url } : { found: false };
}

/**
 * ADR-0012 G2c-1: the state of one of the Orchestrator's own requests (native deploy or rollback), in runStatus's
 * shape, for the Recovery Manager's lifecycle: `queued` (approved), `in_progress` (running), or `completed` with
 * `success` or `failure` (and its reason). Read-only; any other request (a GitHub dispatch) is not found.
 */
export async function requestStatus(env: Pick<Env, "DB">, requestId: string): Promise<{ found: boolean; status?: string; conclusion?: string | null; request_id?: string; executor?: string; reason?: string | null }> {
  if (!/^dep_[0-9a-f-]{36}$/.test(requestId) || !env.DB) return { found: false };
  const row = await env.DB.prepare("SELECT status, details_json FROM deployment_requests WHERE request_id = ?").bind(requestId).first<{ status: string; details_json: string }>();
  if (!row) return { found: false };
  let details: { executor?: unknown; outcome?: { reason?: unknown } } = {};
  try { details = JSON.parse(row.details_json || "{}") ?? {}; } catch { details = {}; }
  const executor = typeof details.executor === "string" && Object.hasOwn(NATIVE_EXECUTORS, details.executor) ? details.executor : null;
  if (!executor) return { found: false };
  const reason = typeof details.outcome?.reason === "string" ? details.outcome.reason.slice(0, 300) : null;
  if (row.status === "succeeded") return { found: true, status: "completed", conclusion: "success", request_id: requestId, executor, reason: null };
  if (row.status === "failed") return { found: true, status: "completed", conclusion: "failure", request_id: requestId, executor, reason };
  return { found: true, status: row.status === "running" ? "in_progress" : "queued", conclusion: null, request_id: requestId, executor, reason: null };
}

/**
 * Wave B: roll a Worker back to the version it ran before. The target is the registry's previous
 * desired version (the version tag recorded before the current one, from the audit trail), so
 * a rollback always returns to a version that production ran and recorded. The Rollback Worker
 * workflow deploys that existing Worker version, verifies it live, records it as desired, and
 * restores the captured version if anything fails.
 */
export const ROLLBACK_WORKFLOW = "rollback-worker.yml";

export async function previousVersion(env: Env, serviceId: string): Promise<string | null> {
  const reg = await env.DB.prepare("SELECT desired_version FROM service_registry WHERE service_id = ?").bind(serviceId).first<{ desired_version: string | null }>();
  const current = reg?.desired_version ?? null;
  if (!current) return null;
  const rows = await env.DB.prepare(
    "SELECT payload_json FROM audit_events WHERE event_type = 'registry.desired_version_set' AND subject = ? ORDER BY rowid DESC LIMIT 50",
  ).bind(serviceId).all<{ payload_json: string }>();
  for (const r of rows.results) {
    let p: { previous?: unknown; desired_version?: unknown } = {};
    try { p = JSON.parse(r.payload_json); } catch { continue; }
    const prev = typeof p.previous === "string" ? p.previous.slice(0, 12) : "";
    if (p.desired_version === current && /^[0-9a-f]{12}$/.test(prev) && prev !== current.slice(0, 12)) return prev;
  }
  return null;
}

async function dispatchRollback(env: Env, actor: string, serviceId: string, tag: string, link: Record<string, string>): Promise<Record<string, unknown>> {
  if (!unitForService(serviceId)) throw new Error("no_deploy_unit_for_service");
  if (!/^[0-9a-f]{12}$/.test(tag)) throw new Error("invalid_version_tag");
  if (nativeRollbackConfigured(env)) return queueNativeRollback(env, actor, serviceId, tag, link);
  if (!env.GH_ACTIONS_TOKEN || !env.DEPLOYMENT_LOCK) throw new Error("not_configured");
  const sha = await mainSha(env.GH_ACTIONS_TOKEN);
  if (!sha) throw new Error("main_lookup_failed");
  const key = `rollback:${serviceId}:${tag}:${Object.values(link).join(":")}`;
  const lockResponse = await env.DEPLOYMENT_LOCK.get(env.DEPLOYMENT_LOCK.idFromName(key))
    .fetch("https://lock.internal/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha }) });
  const lock = await lockResponse.json() as { claimed?: boolean };
  if (!lockResponse.ok || !lock.claimed) return { dispatched: false, reason: "already_dispatched", workflow: ROLLBACK_WORKFLOW, commit_sha: sha, version_tag: tag };
  const requestId = "dep_" + crypto.randomUUID();
  const at = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?)`,
  ).bind(requestId, serviceId, tag, actor, Object.values(link)[0] ?? null, key, JSON.stringify({ workflow: ROLLBACK_WORKFLOW, version_tag: tag, ...link }), at, at).run();
  const dispatch = await dispatchWorkflow(env.GH_ACTIONS_TOKEN, ROLLBACK_WORKFLOW, { worker: serviceId, version_tag: tag, confirm_production: "ROLLBACK" });
  const status = dispatch.status === 204 ? "running" : "failed";
  await env.DB.prepare("UPDATE deployment_requests SET status = ?, updated_at = ? WHERE request_id = ?").bind(status, new Date().toISOString(), requestId).run();
  await appendAuditEvent(env.DB, {
    event_type: dispatch.status === 204 ? "deployment.rollback_dispatched" : "deployment.dispatch_failed", actor, subject: serviceId, outcome: status,
    payload: { request_id: requestId, workflow: ROLLBACK_WORKFLOW, version_tag: tag, github_status: dispatch.status, attempts: dispatch.attempts, ...link },
  });
  if (dispatch.status !== 204) { await releaseLock(env, key, sha); throw new Error(`dispatch_failed_${dispatch.status}`); }
  return { dispatched: true, request_id: requestId, workflow: ROLLBACK_WORKFLOW, commit_sha: sha, version_tag: tag };
}

const NATIVE_ROLLBACK_MAX_AGE_MS = 3 * 3_600_000;
/** A queued native deploy runs within 45 minutes or never: the Registry records it only within the hour. */
export const NATIVE_DEPLOY_MAX_AGE_MS = 45 * 60_000;
/** A claimed executor that has not completed after this window is terminally failed, never replayed. */
export const NATIVE_ROLLBACK_EXECUTION_LEASE_MS = 30 * 60_000;

/**
 * The Orchestrator's own executors (no GitHub). Both queue a signed deployment_requests row and run it from this
 * Worker's cron at a SAFE minute under a one-time Durable Object claim; they differ in what they run. The queue
 * and claim prefixes keep the two signatures apart; the rollback ones are unchanged since phase 2.
 */
interface NativeExecutorSpec {
  executor: string;
  label: string;
  reasonPrefix: string;
  queuePrefix: string;
  claimPrefix: string;
  maxAgeMs: number;
  succeededEvent: string;
  failedEvent: string;
}
const NATIVE_EXECUTORS: Record<string, NativeExecutorSpec> = {
  [NATIVE_EXECUTOR]: {
    executor: NATIVE_EXECUTOR, label: "native rollback", reasonPrefix: "native_rollback",
    queuePrefix: "cryptophys.native-rollback.queue.v1|", claimPrefix: "cryptophys.native-rollback.execution.v1|",
    maxAgeMs: NATIVE_ROLLBACK_MAX_AGE_MS, succeededEvent: "deployment.rollback_succeeded", failedEvent: "deployment.rollback_failed",
  },
  [NATIVE_DEPLOY_EXECUTOR]: {
    executor: NATIVE_DEPLOY_EXECUTOR, label: "native deploy", reasonPrefix: "native_deploy",
    queuePrefix: "cryptophys.native-deploy.queue.v1|", claimPrefix: "cryptophys.native-deploy.execution.v1|",
    maxAgeMs: NATIVE_DEPLOY_MAX_AGE_MS, succeededEvent: "deployment.native_deploy_succeeded", failedEvent: "deployment.native_deploy_failed",
  },
};
/** The spec of a stored row: from its parsed details, else from its raw text (for an unreadable row). */
function executorSpecOf(details: Record<string, unknown> | null, raw: string): NativeExecutorSpec {
  const named = typeof details?.executor === "string" && Object.hasOwn(NATIVE_EXECUTORS, details.executor) ? NATIVE_EXECUTORS[details.executor] : undefined;
  if (named) return named;
  return raw.includes('"executor":"' + NATIVE_DEPLOY_EXECUTOR + '"') ? NATIVE_EXECUTORS[NATIVE_DEPLOY_EXECUTOR] : NATIVE_EXECUTORS[NATIVE_EXECUTOR];
}

type NativeSignedRow = {
  request_id: string;
  service_id: string;
  requested_version: string;
  requested_by: string;
  approval_id: string | null;
  idempotency_key: string;
  created_at: string;
};

function canonicalRollbackJson(value: unknown): string {
  const normalize = (input: any): any => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.keys(input).sort().map((key) => [key, normalize(input[key])]));
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

function nativeQueuePayload(spec: NativeExecutorSpec, row: NativeSignedRow, details: Record<string, unknown>): string {
  return spec.queuePrefix + canonicalRollbackJson({ ...row, details });
}

async function signNativeRequest(spec: NativeExecutorSpec, secret: string, row: NativeSignedRow, details: Record<string, unknown>): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(nativeQueuePayload(spec, row, details)));
  return Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyNativeRequest(spec: NativeExecutorSpec, secret: string, row: NativeSignedRow, details: Record<string, unknown>, signature: unknown): Promise<boolean> {
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = new Uint8Array(signature.match(/../g)!.map((part) => Number.parseInt(part, 16)));
  return crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(nativeQueuePayload(spec, row, details)));
}

type NativeClaimState = { claimed: boolean; claimedAt: number | null };

async function nativeExecutionSha(spec: NativeExecutorSpec, requestId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(spec.claimPrefix + requestId));
  return Array.from(new Uint8Array(digest).slice(0, 20), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function presentNativeClaim(result: { claimed?: unknown; claimed_at?: unknown }, claimResponse: boolean): NativeClaimState {
  const claimedAt = typeof result.claimed_at === "string" ? Date.parse(result.claimed_at) : Number.NaN;
  return {
    claimed: claimResponse && result.claimed === true,
    claimedAt: Number.isFinite(claimedAt) ? claimedAt : null,
  };
}

/** Read the one-time claim without consuming it; used to distinguish an active executor from an abandoned one. */
async function readNativeExecutionClaim(env: Env, spec: NativeExecutorSpec, requestId: string, idempotencyKey: string): Promise<NativeClaimState> {
  const sha = await nativeExecutionSha(spec, requestId);
  const response = await env.DEPLOYMENT_LOCK.get(env.DEPLOYMENT_LOCK.idFromName(idempotencyKey))
    .fetch("https://lock.internal/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha }),
    });
  if (!response.ok) throw new Error(spec.reasonPrefix + "_claim_status_http_" + response.status);
  const result = await response.json() as { claimed?: unknown; claimed_at?: unknown };
  return presentNativeClaim(result, true);
}

/**
 * Claim execution outside shared D1. The HMAC authenticates the immutable request; this
 * request-scoped Durable Object claim prevents a restored signed D1 row from executing twice.
 */
async function claimNativeExecution(env: Env, spec: NativeExecutorSpec, requestId: string, idempotencyKey: string): Promise<NativeClaimState> {
  const sha = await nativeExecutionSha(spec, requestId);
  const response = await env.DEPLOYMENT_LOCK.get(env.DEPLOYMENT_LOCK.idFromName(idempotencyKey))
    .fetch("https://lock.internal/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha }),
    });
  const result = await response.json() as { claimed?: unknown; claimed_at?: unknown };
  if (!response.ok && response.status !== 409) throw new Error(spec.reasonPrefix + "_claim_http_" + response.status);
  return presentNativeClaim(result, response.ok);
}

async function failNativeRequest(env: Env, spec: NativeExecutorSpec, row: NativeSignedRow, details: Record<string, unknown>, reason: string, now: number): Promise<void> {
  await env.DB.prepare("UPDATE deployment_requests SET status = 'failed', details_json = ?, updated_at = ? WHERE request_id = ? AND status IN ('approved', 'running')")
    .bind(JSON.stringify({ ...details, outcome: { reason } }), new Date(now).toISOString(), row.request_id).run();
  await auditQuietly(env, {
    event_type: spec.failedEvent, actor: "agent:deployment-orchestrator", subject: row.service_id, outcome: "failed",
    payload: { request_id: row.request_id, executor: spec.executor, version_tag: String(row.requested_version ?? "").slice(0, 12), reason },
  });
}

/**
 * Insert one signed native request. D1 is shared by several Workers: the HMAC, keyed by the Orchestrator-only
 * deploy secret, covers the complete immutable queue identity, so another D1-bound Worker cannot forge one.
 */
async function insertSignedNativeRequest(env: Env, spec: NativeExecutorSpec, row: NativeSignedRow, unsignedDetails: Record<string, unknown>): Promise<void> {
  const signature = await signNativeRequest(spec, env.CF_DEPLOY_TOKEN!, row, unsignedDetails);
  const details = { ...unsignedDetails, signature };
  await env.DB.prepare(
    `INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?)`
  ).bind(row.request_id, row.service_id, row.requested_version, row.requested_by, row.approval_id, row.idempotency_key, JSON.stringify(details), row.created_at, row.created_at).run();
}

/**
 * ADR-0012 phase 2: queue a rollback for the Orchestrator's own executor (no GitHub). The same
 * idempotency lock as the workflow path makes a replay a no-op. The cron runs it at the next
 * minute outside the drift and kernel cron windows.
 */
async function queueNativeRollback(env: Env, actor: string, serviceId: string, tag: string, link: Record<string, string>): Promise<Record<string, unknown>> {
  if (!env.DEPLOYMENT_LOCK) throw new Error("not_configured");
  const key = "rollback:" + serviceId + ":" + tag + ":" + Object.values(link).join(":");
  const lockResponse = await env.DEPLOYMENT_LOCK.get(env.DEPLOYMENT_LOCK.idFromName(key))
    .fetch("https://lock.internal/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha: "0".repeat(40) }) });
  const lock = await lockResponse.json() as { claimed?: boolean };
  if (!lockResponse.ok || !lock.claimed) return { dispatched: false, reason: "already_dispatched", executor: NATIVE_EXECUTOR, version_tag: tag };
  const requestId = "dep_" + crypto.randomUUID();
  const at = new Date().toISOString();
  const approvalId = Object.values(link)[0] ?? null;
  const row: NativeSignedRow = { request_id: requestId, service_id: serviceId, requested_version: tag, requested_by: actor, approval_id: approvalId, idempotency_key: key, created_at: at };
  await insertSignedNativeRequest(env, NATIVE_EXECUTORS[NATIVE_EXECUTOR], row, { executor: NATIVE_EXECUTOR, version_tag: tag, ...link });
  await appendAuditEvent(env.DB, {
    event_type: "deployment.rollback_queued", actor, subject: serviceId, outcome: "approved",
    payload: { request_id: requestId, executor: NATIVE_EXECUTOR, version_tag: tag, ...link },
  });
  return { dispatched: true, request_id: requestId, executor: NATIVE_EXECUTOR, version_tag: tag };
}

/**
 * ADR-0012 G2b: queue a consensus deploy_commit (G2c-1: or a recovery plan's redeploy) for the Orchestrator's own
 * executor. The caller holds the same per-workflow-and-commit lock the GitHub path claims for that source, so a
 * commit is never both dispatched and queued. Consensus rows are written exactly as in G2b.
 */
type NativeDeploySource = { proposal_id: string; policy_decision_id: string } | { plan_id: string; policy_decision_id: string };
async function queueNativeDeploy(env: Env, source: NativeDeploySource, target: string, unit: DeployUnit, sha: string, choice: Extract<NativeChoice, { eligible: true }>, lockName: string): Promise<Record<string, unknown>> {
  const requestId = "dep_" + crypto.randomUUID();
  const at = new Date().toISOString();
  const fromPlan = "plan_id" in source;
  const link = fromPlan ? source.plan_id : source.proposal_id;
  const actor = fromPlan ? `recovery:${link}` : `consensus:${link}`;
  const row: NativeSignedRow = {
    request_id: requestId, service_id: target, requested_version: sha, requested_by: actor, approval_id: link,
    idempotency_key: `${fromPlan ? "recovery" : "consensus"}:${unit.workflow}:${sha}`, created_at: at,
  };
  try {
    await insertSignedNativeRequest(env, NATIVE_EXECUTORS[NATIVE_DEPLOY_EXECUTOR], row, {
      executor: NATIVE_DEPLOY_EXECUTOR, unit: unit.unit, commit_sha: sha, version_tag: sha.slice(0, 12), services: [...unit.services],
      ...source, workflows: [{ name: "Forge checks", conclusion: "success" }],
    });
  } catch (err) {
    // Nothing was queued: free the commit's lock so a later proposal can try again.
    await releaseLock(env, lockName, sha);
    throw err;
  }
  await appendAuditEvent(env.DB, {
    event_type: "deployment.native_deploy_queued", actor, subject: target, outcome: "approved",
    payload: { request_id: requestId, executor: NATIVE_DEPLOY_EXECUTOR, commit_sha: sha, unit: unit.unit, running: choice.services.map((s) => `${s.service}@${s.running_tag}`),
      ...(choice.migrations.length ? { migrations: choice.migrations.map((m) => m.file) } : {}),
      // G2c-2: what each planned configuration changes (planned again before the upload).
      ...(choice.services.some((s) => s.config) ? { config: Object.fromEntries(choice.services.filter((s) => s.config).map((s) => [s.service, { ...s.config!.changes, steps: s.config!.steps }])) } : {}),
      ...(fromPlan ? { plan_id: link } : { proposal_id: link }) },
  });
  return { dispatched: true, executor: NATIVE_DEPLOY_EXECUTOR, request_id: requestId, unit: unit.unit, commit_sha: sha };
}

/** Is this stored row exactly what the queue wrote for its executor? */
function nativeRequestValid(spec: NativeExecutorSpec, r: NativeSignedRow, details: Record<string, unknown>): boolean {
  if (!/^dep_[0-9a-f-]{36}$/.test(r.request_id)) return false;
  const unit = unitForService(r.service_id);
  if (!unit) return false;
  const planId = typeof details.plan_id === "string" ? details.plan_id : null;
  const proposalId = typeof details.proposal_id === "string" ? details.proposal_id : null;
  const fromProposal = proposalId !== null && planId === null && r.requested_by === "consensus:" + proposalId && r.approval_id === proposalId;
  const fromPlan = planId !== null && proposalId === null && r.requested_by === "recovery:" + planId && r.approval_id === planId;
  if (spec.executor === NATIVE_DEPLOY_EXECUTOR) {
    // G2c-1: a recovery plan's redeploy is keyed like its workflow lock (recovery:<workflow>:<sha>).
    return (fromProposal || fromPlan)
      && /^[0-9a-f]{40}$/.test(r.requested_version)
      && details.commit_sha === r.requested_version
      && details.unit === unit.unit
      && r.idempotency_key === `${fromPlan ? "recovery" : "consensus"}:${unit.workflow}:${r.requested_version}`;
  }
  const sourceValid = fromPlan || fromProposal;
  const linkId = planId ?? proposalId;
  return /^[0-9a-f]{12}$/.test(r.requested_version)
    && details.version_tag === r.requested_version
    && sourceValid
    && linkId !== null
    && r.idempotency_key === "rollback:" + r.service_id + ":" + r.requested_version + ":" + linkId;
}

/**
 * Run queued native requests, rollbacks and deploys (oldest first, at most 3 per run, at most one deploy). Only
 * at a SAFE minute. Every request expires (a rollback after 3 hours, a deploy after 45 minutes), including when
 * credentials are restored later.
 */
export async function runNativeExecutors(env: Env, now = Date.now(), fetcher: typeof fetch = fetch, opts: { delayMs?: number } = {}): Promise<{ executed: number; succeeded: number }> {
  if (!env.DB || !SAFE_MINUTES.includes(new Date(now).getUTCMinutes())) return { executed: 0, succeeded: 0 };
  const pattern = '%"executor":"native:%';
  const recoveryCutoff = new Date(now - NATIVE_ROLLBACK_EXECUTION_LEASE_MS).toISOString();
  type Row = NativeSignedRow & { details_json: string; updated_at: string; status: "approved" | "running" };
  const [approvedRows, abandonedRows] = await Promise.all([
    env.DB.prepare(
      "SELECT request_id, service_id, requested_version, requested_by, approval_id, idempotency_key, details_json, created_at, updated_at, status FROM deployment_requests WHERE status = 'approved' AND details_json LIKE ? ORDER BY created_at LIMIT 3",
    ).bind(pattern).all<Row>(),
    env.DB.prepare(
      "SELECT request_id, service_id, requested_version, requested_by, approval_id, idempotency_key, details_json, created_at, updated_at, status FROM deployment_requests WHERE status = 'running' AND COALESCE(updated_at, created_at) <= ? AND details_json LIKE ? ORDER BY COALESCE(updated_at, created_at) LIMIT 3",
    ).bind(recoveryCutoff, pattern).all<Row>(),
  ]);
  const rows = [...approvedRows.results, ...abandonedRows.results]
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .slice(0, 3);
  let executed = 0;
  let succeeded = 0;
  let deploysRun = 0;
  for (const r of rows) {
    let details: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(r.details_json || "{}");
      details = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch { details = null; }
    const spec = executorSpecOf(details, r.details_json ?? "");

    // A running row is considered only after the execution lease. A recent durable claim means
    // another invocation is still within its execution window; do not interfere with it.
    if (r.status === "running") {
      let prior: NativeClaimState;
      try {
        prior = await readNativeExecutionClaim(env, spec, r.request_id, r.idempotency_key);
      } catch {
        await failNativeRequest(env, spec, r, {}, spec.reasonPrefix + "_claim_state_unavailable", now);
        continue;
      }
      if (prior.claimed) {
        if (prior.claimedAt !== null && now - prior.claimedAt <= NATIVE_ROLLBACK_EXECUTION_LEASE_MS) continue;
        await failNativeRequest(env, spec, r, {}, spec.reasonPrefix + "_execution_claim_expired", now);
        continue;
      }
    }

    if (!details) {
      await failNativeRequest(env, spec, r, {}, "invalid_queue_details", now);
      continue;
    }
    if (details.executor !== spec.executor) continue;

    // Enforce the expiry even if credentials are later restored. A delayed request must never
    // become executable merely because the secret was re-added.
    const created = Date.parse(r.created_at);
    const age = now - created;
    if (!Number.isFinite(created) || age < 0 || age > spec.maxAgeMs) {
      await failNativeRequest(env, spec, r, details, "stale: " + spec.label + " request expired", now);
      continue;
    }

    if (!nativeRequestValid(spec, r, details)) {
      await failNativeRequest(env, spec, r, details, "invalid_" + spec.reasonPrefix + "_request", now);
      continue;
    }

    // If the token is temporarily absent, leave a fresh request queued; the unconditional
    // expiry above ensures it cannot execute if credentials return after its window.
    if (!env.CF_DEPLOY_TOKEN) continue;
    const unsignedDetails = { ...details };
    delete unsignedDetails.signature;
    const signedRow: NativeSignedRow = {
      request_id: r.request_id, service_id: r.service_id, requested_version: r.requested_version,
      requested_by: r.requested_by, approval_id: r.approval_id, idempotency_key: r.idempotency_key, created_at: r.created_at,
    };
    const signatureValid = await verifyNativeRequest(spec, env.CF_DEPLOY_TOKEN, signedRow, unsignedDetails, details.signature);
    if (!signatureValid) {
      await failNativeRequest(env, spec, r, details, "invalid_" + spec.reasonPrefix + "_signature", now);
      continue;
    }
    const isDeploy = spec.executor === NATIVE_DEPLOY_EXECUTOR;
    if (isDeploy ? !nativeDeployConfigured(env) : !nativeRollbackConfigured(env)) continue;
    // A deploy uploads and verifies every Worker of a unit; one per run keeps the cron within its time.
    if (isDeploy && deploysRun > 0) continue;

    // A deploy runs only on main's current head, still ready and still code only: the evidence may have
    // changed since it was queued. Checked before the claim; a refusal is terminal and moves nothing.
    let plan: PlannedService[] = [];
    let migrations: PlannedMigration[] = [];
    const cf = new CloudflareWorkers(env.CF_DEPLOY_TOKEN, env.CF_ACCOUNT_ID!, fetcher);
    if (isDeploy) {
      let refusal: string | null = null;
      try {
        const head = await forgeMainHead(env.DB);
        if (head.sha !== r.requested_version) refusal = "commit_not_current_main";
        else if (!(await forgeReady(env.DB, r.requested_version)).ready) refusal = "ci_not_green";
        else {
          const e = await nativeDeployEligible(env, unitForService(r.service_id)!, r.requested_version, cf);
          if (e.eligible) { plan = e.services; migrations = e.migrations; }
          else refusal = "not_eligible: " + e.reason + (e.service ? " (" + e.service + ")" : "");
        }
      } catch (err) {
        refusal = "forge_unavailable: " + String((err as Error)?.message ?? err).slice(0, 100);
      }
      if (refusal) {
        await failNativeRequest(env, spec, r, details, refusal, now);
        continue;
      }
    }

    // Persist approved -> running before consuming the one-time DO claim. If D1 fails, no claim
    // is burned and the next scheduled pass can retry. If the response is ambiguous after a
    // successful write, the running-row recovery path checks the DO state before proceeding.
    if (r.status === "approved") {
      const transition = await env.DB.prepare("UPDATE deployment_requests SET status = 'running', updated_at = ? WHERE request_id = ? AND status = 'approved'")
        .bind(new Date(now).toISOString(), r.request_id).run();
      if ((transition.meta.changes ?? 0) !== 1) continue;
    }

    let claimState: NativeClaimState;
    try {
      claimState = await claimNativeExecution(env, spec, r.request_id, r.idempotency_key);
    } catch {
      await failNativeRequest(env, spec, r, details, spec.reasonPrefix + "_execution_claim_unavailable", now);
      continue;
    }
    if (!claimState.claimed) {
      if (claimState.claimedAt === null) {
        await failNativeRequest(env, spec, r, details, spec.reasonPrefix + "_execution_claim_state_unknown", now);
      } else if (now - claimState.claimedAt > NATIVE_ROLLBACK_EXECUTION_LEASE_MS) {
        await failNativeRequest(env, spec, r, details, spec.reasonPrefix + "_execution_claim_expired", now);
      }
      continue;
    }

    executed++;
    let run: { ok: boolean; reason?: string; restored?: boolean; service?: string; steps: string[]; migrations_applied?: string[]; migration_failed?: string; restore_point_at?: string; settings_applied?: string[] };
    if (isDeploy) {
      deploysRun++;
      run = await executeNativeDeploy(cf, { DRIFT: env.DRIFT!, REGISTRY: env.REGISTRY!, BUNDLES: env.BUNDLES!, DB: env.DB }, r.request_id, r.requested_version, plan, { ...opts, migrations });
    } else {
      run = await executeRollback(cf, { DRIFT: env.DRIFT!, REGISTRY: env.REGISTRY! }, r.request_id, r.service_id, r.requested_version, opts);
    }
    if (run.ok) succeeded++;
    const status = run.ok ? "succeeded" : "failed";
    await env.DB.prepare("UPDATE deployment_requests SET status = ?, details_json = ?, updated_at = ? WHERE request_id = ? AND status = 'running'")
      .bind(status, JSON.stringify({ ...details, outcome: run }), new Date().toISOString(), r.request_id).run();
    await auditQuietly(env, {
      event_type: run.ok ? spec.succeededEvent : spec.failedEvent, actor: "agent:deployment-orchestrator", subject: r.service_id, outcome: status,
      payload: isDeploy
        ? { request_id: r.request_id, executor: spec.executor, commit_sha: r.requested_version, unit: String(details.unit), ...run }
        : { request_id: r.request_id, executor: spec.executor, version_tag: r.requested_version, ...run },
    });
    if (!run.ok) {
      await publishAgentReport(env.AGENTS, "deployment-orchestrator", {
        kind: "platform_digest", severity: "critical",
        subject: isDeploy
          ? "Deploy of " + String(details.unit) + " at " + r.requested_version.slice(0, 12) + " failed"
          : "Rollback of " + serviceName(r.service_id) + " to " + r.requested_version + " failed",
        body: { request_id: r.request_id, reason: run.reason ?? null, restored: run.restored ?? false, steps: run.steps, ...(isDeploy ? { service: run.service ?? null } : {}),
          // G2c-2: script settings (schedules, observability) applied before the failure; restored with the Workers.
          ...(run.settings_applied?.length ? { settings_applied: run.settings_applied } : {}),
          // G2c-1: D1 migrations are forward-only; a restore of the Workers never undoes them.
          ...(run.migrations_applied?.length || run.migration_failed ? {
            migrations_applied: run.migrations_applied ?? [], migration_failed: run.migration_failed ?? null, d1_restore_point_at: run.restore_point_at ?? null,
            action_required: run.migration_failed
              ? "A D1 migration failed during a native deploy. Its own batch was rolled back; the migrations listed as applied stay applied. The owner decides whether to fix forward or restore D1 (Time Travel) to the restore point."
              : "D1 migrations were applied before a Worker failed and the Workers were restored; the schema stays migrated. The owner decides how to continue.",
          } : {}) },
      });
    }
  }
  return { executed, succeeded };
}

/** The phase 2 name of the executor loop, which now also runs native deploys. */
export const runNativeRollbacks = runNativeExecutors;

/** Recovery step rollback_worker_version of an approved, executing plan (same checks as deployForRecovery). */
export async function rollbackForRecovery(env: Env, planId: string, decisionId: string, serviceId: string): Promise<Record<string, unknown>> {
  await verifyRecoveryExecution(env, planId, decisionId, serviceId);
  const tag = await previousVersion(env, serviceId);
  if (!tag) throw new Error("no_previous_version_recorded");
  return dispatchRollback(env, `recovery:${planId}`, serviceId, tag, { plan_id: planId });
}

/** Consensus action rollback_worker_version (deploy mode): params.version is the tag, re-verified like every consensus action. */
export async function rollbackForConsensus(env: Env, proposalId: string, decisionId: string, target: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  await verifyConsensusExecution(env.DB, proposalId, decisionId, "rollback_worker_version", target);
  const tag = String(params.version ?? "").slice(0, 12);
  const previous = await previousVersion(env, target);
  if (!previous || previous !== tag) throw new Error("version_is_not_the_previous_recorded_version");
  return dispatchRollback(env, `consensus:${proposalId}`, target, tag, { proposal_id: proposalId });
}

/**
 * ADR-0009 phase 4: execute an owner-approved retire_worker. Re-verifies the proposal (which,
 * for a critical action, includes the owner's approval click), requires the Worker to be
 * disabled in the registry, and dispatches the Retire Worker workflow. That workflow keeps its
 * own gates: an owner-curated RETIRABLE list, source gone from main, the production
 * Environment, and the DELETE confirmation. D1 data is never touched.
 */
export async function retireForConsensus(env: Env, proposalId: string, decisionId: string, target: string): Promise<Record<string, unknown>> {
  await verifyConsensusExecution(env.DB, proposalId, decisionId, "retire_worker", target);
  if (!/^cryptophys-[a-z0-9][a-z0-9-]{1,60}$/.test(target)) throw new Error("invalid_worker");
  if (unitForService(target)) throw new Error("worker_is_an_active_deploy_unit");
  const reg = await env.DB.prepare("SELECT status FROM service_registry WHERE service_id = ?").bind(target).first<{ status: string }>();
  if (reg?.status !== "disabled") throw new Error("worker_not_disabled_in_registry");
  if (!env.GH_ACTIONS_TOKEN || !env.DEPLOYMENT_LOCK) throw new Error("not_configured");
  const lockResponse = await env.DEPLOYMENT_LOCK.get(env.DEPLOYMENT_LOCK.idFromName(`consensus:retire:${target}`))
    .fetch("https://lock.internal/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sha: "0".repeat(40) }) });
  const lock = await lockResponse.json() as { claimed?: boolean };
  if (!lockResponse.ok || !lock.claimed) return { dispatched: false, reason: "already_dispatched", worker: target };
  const actor = `consensus:${proposalId}`;
  const requestId = "dep_" + crypto.randomUUID();
  const at = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
     VALUES (?, ?, 'retire', ?, 'approved', ?, ?, ?, ?, ?)`,
  ).bind(requestId, target, actor, proposalId, `consensus:retire:${target}`,
    JSON.stringify({ workflow: "retire-worker.yml", proposal_id: proposalId, policy_decision_id: decisionId }), at, at).run();
  const dispatch = await dispatchWorkflow(env.GH_ACTIONS_TOKEN, "retire-worker.yml", { worker: target, confirm_production: "DELETE" });
  const status = dispatch.status === 204 ? "running" : "failed";
  await env.DB.prepare("UPDATE deployment_requests SET status = ?, updated_at = ? WHERE request_id = ?").bind(status, new Date().toISOString(), requestId).run();
  await appendAuditEvent(env.DB, {
    event_type: dispatch.status === 204 ? "deployment.retire_dispatched" : "deployment.dispatch_failed", actor, subject: target, outcome: status,
    payload: { request_id: requestId, workflow: "retire-worker.yml", github_status: dispatch.status, attempts: dispatch.attempts, proposal_id: proposalId },
  });
  if (dispatch.status !== 204) { await releaseLock(env, `consensus:retire:${target}`, "0".repeat(40)); throw new Error(`dispatch_failed_${dispatch.status}`); }
  return { dispatched: true, request_id: requestId, workflow: "retire-worker.yml", worker: target };
}

/**
 * Wave A: close the deployment ledger. Dispatches are recorded as 'running' and nothing used to
 * record the outcome. Every scheduled run looks up the GitHub Actions run of each open request
 * and records succeeded or failed; a request with no finished run after 3 hours is failed as stale.
 */
export async function reconcileDeployments(env: Env, now = Date.now()): Promise<{ checked: number; closed: number }> {
  if (!env.GH_ACTIONS_TOKEN || !env.DB) return { checked: 0, closed: 0 };
  const rows = await env.DB.prepare(
    "SELECT request_id, service_id, requested_version, details_json, created_at FROM deployment_requests WHERE status IN ('running', 'approved') AND created_at <= ? ORDER BY created_at LIMIT 20",
  ).bind(new Date(now - 2 * 60_000).toISOString()).all<{ request_id: string; service_id: string; requested_version: string; details_json: string; created_at: string }>();
  let closed = 0;
  for (const r of rows.results) {
    let details: Record<string, unknown> = {};
    try { details = JSON.parse(r.details_json || "{}"); } catch { details = {}; }
    const workflow = String(details.workflow ?? "");
    if (!/^[a-z0-9-]+\.yml$/.test(workflow)) continue;
    const res = await gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/actions/workflows/" + workflow + "/runs?event=workflow_dispatch&per_page=20&created=%3E%3D" + encodeURIComponent(r.created_at.slice(0, 19) + "Z"));
    if (!res.ok) continue;
    const runs = ((await res.json()) as { workflow_runs?: { id: number; head_sha: string; status: string; conclusion: string | null; html_url: string; created_at: string }[] }).workflow_runs ?? [];
    const sha = /^[0-9a-f]{40}$/.test(r.requested_version) ? r.requested_version : null;
    const run = runs.filter((x) => !sha || x.head_sha === sha).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
    let status: "succeeded" | "failed" | null = null;
    let note: Record<string, unknown> = {};
    if (run?.status === "completed") {
      status = run.conclusion === "success" ? "succeeded" : "failed";
      note = { run_id: run.id, run_url: run.html_url, conclusion: run.conclusion };
    } else if (!run && now - Date.parse(r.created_at) > 3 * 3_600_000) {
      status = "failed";
      note = { reason: "stale: no workflow run finished within 3 hours" };
    }
    if (!status) continue;
    const upd = await env.DB.prepare("UPDATE deployment_requests SET status = ?, details_json = ?, updated_at = ? WHERE request_id = ? AND status IN ('running', 'approved')")
      .bind(status, JSON.stringify({ ...details, outcome: note }), new Date(now).toISOString(), r.request_id).run();
    if ((upd.meta.changes ?? 0) === 1) {
      closed++;
      await auditQuietly(env, { event_type: "deployment.reconciled", actor: "agent:deployment-orchestrator", subject: r.service_id, outcome: status, payload: { request_id: r.request_id, workflow, ...note } });
    }
  }
  return { checked: rows.results.length, closed };
}

// ---------------------------------------------------------------- deployments list (Console "Pipelines")
const ACTIVE_REQUEST_STATUSES = ["pending", "approved", "running"];
const ACTIVE_PROPOSAL_STATUSES = ["pending_owner", "executing"];

/** Who started a deployment, in words the Console shows. */
export function deploymentOrigin(actor: string | null | undefined): "consensus" | "agent" | "deploy workflow" | "person" | "other" {
  const a = String(actor ?? "");
  if (a.startsWith("consensus:")) return "consensus";
  if (a.startsWith("agent:") || a.startsWith("ai:")) return "agent";
  if (a.endsWith(".access")) return "deploy workflow";
  if (a.includes("@")) return "person";
  return "other";
}

function text(v: unknown, max = 200): string | null {
  return typeof v === "string" && v.length > 0 ? v.slice(0, max) : null;
}

/** A deployment_requests row with only display fields (never the native-rollback signature). */
export function presentDeploymentRequest(r: Record<string, unknown>) {
  let d: Record<string, unknown> = {};
  try { d = JSON.parse(String(r.details_json ?? "{}")) ?? {}; } catch { d = {}; }
  const outcome = (d.outcome && typeof d.outcome === "object" ? d.outcome : {}) as Record<string, unknown>;
  const runUrl = text(outcome.run_url, 300);
  return {
    request_id: r.request_id, service_id: r.service_id, version: r.requested_version, status: r.status,
    requested_by: r.requested_by, origin: deploymentOrigin(r.requested_by as string),
    workflow: text(d.workflow) ?? (d.executor === NATIVE_DEPLOY_EXECUTOR ? "native deploy" : d.executor ? "native rollback" : null),
    proposal_id: text(d.proposal_id), run_url: runUrl?.startsWith("https://github.com/") ? runUrl : null,
    note: text(outcome.reason) ?? text(outcome.conclusion),
    created_at: r.created_at, updated_at: r.updated_at,
  };
}

/**
 * What is deploying now and what was deployed: the Orchestrator's request ledger (Platform API,
 * consensus deploys, native rollbacks), consensus proposals still in flight, and every version a
 * deploy workflow or a person recorded in the registry (registry.desired_version_set).
 */
export async function listDeployments(env: Pick<Env, "DB">, limit = 25) {
  const n = Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 25, 1), 100);
  const marks = (xs: string[]) => xs.map(() => "?").join(", ");
  const [active, recent, proposals, deploys] = await Promise.all([
    env.DB.prepare(`SELECT * FROM deployment_requests WHERE status IN (${marks(ACTIVE_REQUEST_STATUSES)}) ORDER BY created_at DESC LIMIT 50`)
      .bind(...ACTIVE_REQUEST_STATUSES).all<Record<string, unknown>>(),
    env.DB.prepare("SELECT * FROM deployment_requests ORDER BY created_at DESC LIMIT ?").bind(n).all<Record<string, unknown>>(),
    env.DB.prepare(`SELECT proposal_id, action, target, class, status, approvals, eligible, created_at, decided_at FROM consensus_proposals WHERE status IN (${marks(ACTIVE_PROPOSAL_STATUSES)}) ORDER BY created_at DESC LIMIT 50`)
      .bind(...ACTIVE_PROPOSAL_STATUSES).all<Record<string, unknown>>(),
    env.DB.prepare("SELECT subject, actor, payload_json, created_at FROM audit_events WHERE event_type = 'registry.desired_version_set' ORDER BY created_at DESC LIMIT ?")
      .bind(n).all<{ subject: string; actor: string; payload_json: string; created_at: string }>(),
  ]);
  return {
    active: { requests: active.results.map(presentDeploymentRequest), proposals: proposals.results.map((p) => ({ ...p })) },
    requests: recent.results.map(presentDeploymentRequest),
    deploys: deploys.results.map((e) => {
      let p: Record<string, unknown> = {};
      try { p = JSON.parse(e.payload_json) ?? {}; } catch { p = {}; }
      return { service_id: e.subject, version: text(p.desired_version, 64), previous: text(p.previous, 64), origin: deploymentOrigin(e.actor), actor: e.actor, at: e.created_at };
    }),
    generated_at: new Date().toISOString(),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const auth = await authenticate(request, env);
    if (!auth.ok) return auth.response;

    if (request.method === "GET" && ["/health", "/healthz"].includes(url.pathname)) {
      return json(healthBody(env));
    }

    if (request.method === "GET" && ["/ready", "/readyz"].includes(url.pathname)) {
      const checks = {
        production_environment: env.SERVICE_ENVIRONMENT === "production",
        github_token_configured: Boolean(env.GH_ACTIONS_TOKEN),
        deploy_identities_configured: Boolean(env.DEPLOY_ALLOWED_IDENTITIES?.trim()),
        deployment_lock_binding: Boolean(env.DEPLOYMENT_LOCK),
        database_schema: Boolean(env.DB) && await schemaReady(env as never),
        ai_binding: Boolean(env.AI),
        access_configured: accessConfigured(env)
      };
      const ready = Object.values(checks).every(Boolean);
      return json({
        status: ready ? "ready" : "not_configured",
        service: env.SERVICE_NAME,
        production_dispatch_enabled: ready,
        // ADR-0012 phase 2 (informational; not a readiness gate): rollback without GitHub.
        native_rollback: nativeRollbackConfigured(env) ? "configured" : "not_configured",
        // ADR-0012 G2b (informational): code-only deploys from the Forge's bundles.
        native_deploy: nativeDeployConfigured(env) ? "configured" : "not_configured",
        checks
      }, ready ? 200 : 503);
    }

    if (url.pathname !== "/v1/deployments") return json({ error: "not_found" }, 404);
    if (request.method === "GET") {
      // Read-only list for the Console's Pipelines page: operators and viewer accounts.
      const reader = await requireOperator(request, env as never);
      if (!reader.ok) return reader.response;
      return json(await listDeployments(env, Number(url.searchParams.get("limit") ?? 25)));
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    if (env.SERVICE_ENVIRONMENT !== "production") {
      return json({ error: "production_worker_required", production_dispatch_enabled: false }, 503);
    }
    // Authorization: the Access-verified identity must be on the deployment allow-list.
    if (!identityAllowed(auth.identity, env.DEPLOY_ALLOWED_IDENTITIES)) {
      return json({ error: "forbidden", detail: "this Access identity may not request production deployments" }, 403);
    }
    if (!env.GH_ACTIONS_TOKEN || !env.DEPLOYMENT_LOCK || !env.DB) {
      return json({ error: "not_configured", operational: false }, 503);
    }

    let body: { commit_sha?: unknown; confirm_production?: unknown };
    try {
      body = await request.json() as typeof body;
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const sha = typeof body.commit_sha === "string" ? body.commit_sha : "";
    if (!/^[0-9a-f]{40}$/.test(sha)) return json({ error: "invalid_commit_sha" }, 400);
    if (body.confirm_production !== "DEPLOY") {
      return json({ error: "production_confirmation_required" }, 400);
    }
    // Recorded actor is the verified Access identity, not a claim from the request body.
    const requestedBy = actorOf(auth.identity).slice(0, 128);

    const refResponse = await gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/git/ref/heads/main");
    if (!refResponse.ok) {
      return json({ error: "github_ref_lookup_failed", status: refResponse.status }, 502);
    }
    const refData = await refResponse.json() as { object?: { sha?: string } };
    if (refData.object?.sha !== sha) {
      await auditQuietly(env, { event_type: "deployment.rejected", actor: requestedBy, subject: TARGET_SERVICE, outcome: "commit_not_current_main", payload: { commit_sha: sha, main_sha: refData.object?.sha ?? null } });
      await publishAgentReport(env.AGENTS, "deployment-orchestrator", {
        kind: "platform_digest", severity: "warning",
        subject: `Deployment of ${serviceName(TARGET_SERVICE)} refused: ${explainCode("commit_not_current_main")}`,
        body: { commit_sha: sha, main_sha: refData.object?.sha ?? null, requested_by: requestedBy },
      });
      return json({ error: "commit_not_current_main", expected_sha: refData.object?.sha ?? null }, 409);
    }

    // CI gate (owner decision, option B): the combined commit status plus the latest GitHub
    // Actions run of every validation/deployment workflow on this commit. Both lookups are readable by a fine-grained PAT
    // (Commit statuses: Read, Actions: Read); the Checks API is not.
    const [statusResponse, workflowRunsResponse] = await Promise.all([
      gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/commits/" + sha + "/status"),
      gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/actions/runs?head_sha=" + sha + "&per_page=100")
    ]);
    if (!statusResponse.ok || !workflowRunsResponse.ok) {
      // Report which lookup failed and GitHub's status so a missing token permission is diagnosable.
      // The gate still fails closed; no token or response body is echoed.
      return json({
        error: "github_ci_lookup_failed",
        lookups: {
          commit_status: { http_status: statusResponse.status, required_permission: "Commit statuses: Read" },
          workflow_runs: { http_status: workflowRunsResponse.status, required_permission: "Actions: Read" }
        }
      }, 502);
    }

    const statusData = await statusResponse.json() as CommitStatus;
    const runsData = await workflowRunsResponse.json() as { total_count?: number; workflow_runs?: WorkflowRun[] };
    const allRuns = runsData.workflow_runs ?? [];
    const runs = latestRunPerWorkflow(allRuns);

    const statusBlocked = (statusData.total_count ?? 0) > 0 && statusData.state !== "success";
    const runsBlocked =
      runs.length === 0 ||
      (runsData.total_count ?? 0) > allRuns.length ||
      runs.some(run => run.status !== "completed" || run.conclusion !== "success");

    if (statusBlocked || runsBlocked) {
      const ciPayload = { commit_sha: sha, commit_status: statusData.state ?? "unknown", blocking_workflows: runs.filter((r) => r.status !== "completed" || r.conclusion !== "success").map((r) => r.name) };
      await auditQuietly(env, {
        event_type: "deployment.rejected", actor: requestedBy, subject: TARGET_SERVICE, outcome: "ci_not_green",
        payload: ciPayload
      });
      await publishAgentReport(env.AGENTS, "deployment-orchestrator", {
        kind: "platform_digest", severity: "warning",
        subject: `Deployment of ${serviceName(TARGET_SERVICE)} refused: ${explainCode("ci_not_green")}`,
        body: { ...ciPayload, requested_by: requestedBy },
      });
      return json({
        error: "ci_not_green",
        commit_status: statusData.state ?? "unknown",
        status_count: statusData.total_count ?? 0,
        workflow_runs_reported: allRuns.length,
        workflow_runs_total: runsData.total_count ?? 0,
        workflows: runs.map(({ name, status, conclusion }) => ({ name, status, conclusion }))
      }, 409);
    }

    // Durable ledger entry first: the (service_id, idempotency_key) UNIQUE constraint is a
    // second duplicate guard alongside the Durable Object lock.
    const requestId = "dep_" + crypto.randomUUID();
    const createdAt = new Date().toISOString();
    try {
      await env.DB.prepare(
        `INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'approved', NULL, ?, ?, ?, ?)`
      ).bind(requestId, TARGET_SERVICE, sha, requestedBy, sha,
        JSON.stringify({ workflow: WORKFLOW, ref: "main", workflows: runs.map(({ name, conclusion }) => ({ name, conclusion })) }),
        createdAt, createdAt).run();
    } catch (err) {
      if (/UNIQUE constraint failed/i.test(String((err as Error)?.message ?? err))) {
        return json({ error: "duplicate_production_deployment_request", commit_sha: sha }, 409);
      }
      return json({ error: "deployment_ledger_unavailable", operational: false }, 503);
    }

    const lockId = env.DEPLOYMENT_LOCK.idFromName("platform-api-production:" + sha);
    const lockResponse = await env.DEPLOYMENT_LOCK.get(lockId).fetch("https://lock.internal/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha })
    });
    const lock = await lockResponse.json() as { claimed?: boolean };
    if (!lockResponse.ok || !lock.claimed) {
      return json({ error: "duplicate_production_deployment_request", commit_sha: sha }, 409);
    }

    // Production workflow has GitHub environment protection; reviewer approval must remain authoritative.
    const dispatch = await gh(
      env.GH_ACTIONS_TOKEN,
      "/repos/" + REPOSITORY + "/actions/workflows/" + WORKFLOW + "/dispatches",
      { method: "POST", body: JSON.stringify({ ref: "main", inputs: { confirm_production: "DEPLOY", commit_sha: sha } }) }
    );
    const finalStatus = dispatch.status === 204 ? "running" : "failed";
    await env.DB.prepare("UPDATE deployment_requests SET status = ?, updated_at = ? WHERE request_id = ?")
      .bind(finalStatus, new Date().toISOString(), requestId).run().catch(() => undefined);
    const auditEventId = await auditQuietly(env, {
      event_type: dispatch.status === 204 ? "deployment.dispatched" : "deployment.dispatch_failed",
      actor: requestedBy, subject: TARGET_SERVICE, outcome: finalStatus,
      payload: { request_id: requestId, commit_sha: sha, workflow: WORKFLOW, github_status: dispatch.status }
    });

    if (dispatch.status !== 204) {
      return json({
        request_id: requestId,
        error: "production_dispatch_failed",
        status: dispatch.status,
        commit_sha: sha,
        manual_reconciliation_required: true
      }, 502);
    }

    const advisory = url.searchParams.get("advisory") === "true"
      ? await engineFor(env, SERVICE, [riskTask.name]).run(riskTask, {
          commit_sha: sha,
          target: TARGET_SERVICE,
          workflows: runs.map(({ name, conclusion }) => ({ name, conclusion })),
          commit_status: statusData.state ?? "unknown"
        }, requestId)
      : undefined;

    return json({
      request_id: requestId,
      audit_event_id: auditEventId,
      status: "production_dispatch_accepted",
      repository: REPOSITORY,
      workflow: WORKFLOW,
      ref: "main",
      requested_commit_sha: sha,
      production_deployment_triggered: true,
      ...(advisory ? { advisory } : {})
    }, 202);
  },

  async scheduled(event: ScheduledEventLike, env: Env, ctx: ExecutionContextLike): Promise<void> {
    const at = Number(event.scheduledTime) || Date.now();
    const minute = new Date(at).getUTCMinutes();
    const log = (name: string) => (err: unknown) => {
      console.error(JSON.stringify({ service: SERVICE, event: name, message: String((err as Error)?.message ?? err) }));
    };
    // The GitHub ledger reconcile keeps its twice-an-hour cadence; native rollbacks and deploys run at every SAFE minute.
    if (minute === 10 || minute === 40) ctx.waitUntil(reconcileDeployments(env).then(() => undefined, log("reconcile_failed")));
    ctx.waitUntil(runNativeExecutors(env, at).then(() => undefined, log("native_executor_failed")));
  },
};

export class DeploymentLock {
  private readonly state: DurableObjectStateLike;

  constructor(state: DurableObjectStateLike) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || (path !== "/claim" && path !== "/status" && path !== "/release")) {
      return json({ error: "not_found" }, 404);
    }
    let body: { sha?: unknown };
    try {
      body = await request.json() as typeof body;
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    const sha = typeof body.sha === "string" ? body.sha : "";
    if (!/^[0-9a-f]{40}$/.test(sha)) return json({ error: "invalid_commit_sha" }, 400);

    return this.state.blockConcurrencyWhile(async () => {
      const key = "claimed:" + sha;
      const existing = await this.state.storage.get(key) as { claimed_at?: unknown } | undefined;
      if (path === "/status") {
        return json({ claimed: !!existing, claimed_at: typeof existing?.claimed_at === "string" ? existing.claimed_at : null });
      }
      // Only the Orchestrator reaches this object (no route): it releases a claim when nothing was dispatched.
      if (path === "/release") {
        if (existing) await this.state.storage.delete?.(key);
        return json({ released: !!existing });
      }
      if (existing) return json({ claimed: false, claimed_at: typeof existing.claimed_at === "string" ? existing.claimed_at : null }, 409);
      const claimedAt = new Date().toISOString();
      await this.state.storage.put(key, { sha, claimed_at: claimedAt });
      return json({ claimed: true, claimed_at: claimedAt }, 201);
    });
  }
}
