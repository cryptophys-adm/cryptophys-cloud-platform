import { explainCode, serviceName } from "../../control-plane-shared/src/plain.ts";
import type { AiBinding, D1Database, ExecutionContextLike, ScheduledEventLike } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { boundedString, boundedStringArray, engineFor, type AiTask } from "../../control-plane-shared/src/ai-engine.ts";
import { schemaReady } from "../../control-plane-shared/src/readiness.ts";
import { accessConfigured, actorOf, authenticate, identityAllowed } from "../../control-plane-shared/src/access.ts";
import { healthBody } from "../../control-plane-shared/src/http.ts";
import { publishAgentReport, type AgentRpcBinding } from "../../control-plane-shared/src/agents.ts";
import { verifyConsensusExecution } from "../../control-plane-shared/src/consensus-exec.ts";
import { CloudflareWorkers, executeRollback, NATIVE_EXECUTOR, nativeRollbackConfigured, SAFE_MINUTES, type NativeRollbackEnv } from "./native-rollback.ts";

interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
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

type CommitStatus = { state?: string; total_count?: number };
type WorkflowRun = { workflow_id: number; name: string; path?: string; event?: string; head_branch?: string; status: string; conclusion: string | null; run_number: number; run_attempt?: number };

const REQUEST_WORKFLOW_PATH = ".github/workflows/request-platform-api-deployment.yml";

/**
 * Latest run of each validation/deployment workflow. The request workflow is
 * excluded because it runs from trusted main and is necessarily in progress
 * while it asks this gate to evaluate the same commit.
 */
export function latestRunPerWorkflow(runs: WorkflowRun[]): WorkflowRun[] {
  const latest = new Map<number, WorkflowRun>();
  for (const run of runs) {
    // `path` may carry an "@<ref>" suffix; compare the file path only.
    if (run.path?.split("@")[0] === REQUEST_WORKFLOW_PATH) continue;
    // Scheduled runs (e.g. drift monitoring) observe production; they are not CI for the commit.
    if (run.event === "schedule") continue;
    const seen = latest.get(run.workflow_id);
    if (!seen || run.run_number > seen.run_number || (run.run_number === seen.run_number && (run.run_attempt ?? 1) > (seen.run_attempt ?? 1))) {
      latest.set(run.workflow_id, run);
    }
  }
  return [...latest.values()];
}

/**
 * ADR-0009 phase 3: deploy units. Each production workflow deploys a fixed set of Workers from
 * the exact main commit; a unit is pending when files under its paths changed since the
 * version recorded in the registry. Console, Home and Platform API import the shared library.
 */
const SHARED_SRC = "workers/control-plane-shared/src/";
export const DEPLOY_UNITS = [
  // Deploy the orchestrator first: the following Control Plane deployment binds the kernel to DeployRpc.
  { unit: "deployment-orchestrator", workflow: "deploy-deployment-orchestrator.yml", services: ["cryptophys-deployment-orchestrator"], paths: ["workers/deployment-orchestrator/", SHARED_SRC] },
  {
    unit: "control-plane", workflow: "deploy-control-plane.yml",
    services: ["cryptophys-policy-engine", "cryptophys-audit-ledger", "cryptophys-platform-registry", "cryptophys-recovery-manager", "cryptophys-drift-detector", "cryptophys-ai-kernel"],
    paths: ["workers/policy-engine/", "workers/audit-ledger/", "workers/platform-registry/", "workers/recovery-manager/", "workers/drift-detector/", "workers/ai-kernel/", "workers/control-plane-migrations/", SHARED_SRC],
  },
  // Directory prefixes include manifests, lockfiles, bundler config and static assets, not just source files.
  { unit: "console", workflow: "deploy-console.yml", services: ["cryptophys-console"], paths: ["workers/console/", SHARED_SRC] },
  { unit: "home", workflow: "deploy-home.yml", services: ["cryptophys-home"], paths: ["workers/home/", SHARED_SRC] },
  { unit: "platform-api", workflow: "deploy-platform-api.yml", services: ["cryptophys-platform-api"], paths: ["workers/platform-api/", SHARED_SRC] },
  // ADR-0012 phase 1b: the Forge (platform source on Cloudflare Artifacts).
  { unit: "forge", workflow: "deploy-forge.yml", services: ["cryptophys-forge"], paths: ["workers/forge/", SHARED_SRC] },
] as const;
export type DeployUnit = (typeof DEPLOY_UNITS)[number];

export function unitForService(serviceId: string): DeployUnit | null {
  return DEPLOY_UNITS.find((u) => (u.services as readonly string[]).includes(serviceId)) ?? null;
}

export function unitChanged(unit: DeployUnit, files: string[]): boolean {
  return files.some((f) => unit.paths.some((p) => f === p || f.startsWith(p)));
}

/** CI for a consensus deploy: the push-event validation runs on the commit, all green. Deploy runs are not CI. */
const REQUIRED_PUSH_VALIDATIONS = ["Validate", "Validate Control Plane Workers"] as const;

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
 * Which deploy units have changes on a CI-green main that production does not run yet.
 * Read-only: GitHub ref, runs and compare APIs plus the registry. The supervisor proposes
 * deploy_commit for each pending unit; nothing is dispatched here.
 */
export async function pendingDeploys(env: Env): Promise<PendingDeploys> {
  const out: PendingDeploys = { main_sha: null, ci_green: false, units: [], skipped: [] };
  if (!env.GH_ACTIONS_TOKEN) { out.skipped.push({ unit: "*", reason: "github_token_missing" }); return out; }
  const sha = await mainSha(env.GH_ACTIONS_TOKEN);
  out.main_sha = sha;
  if (!sha) { out.skipped.push({ unit: "*", reason: "main_lookup_failed" }); return out; }
  out.ci_green = (await ciGreen(env.GH_ACTIONS_TOKEN, sha)).green;
  if (!out.ci_green) { out.skipped.push({ unit: "*", reason: "ci_not_green" }); return out; }
  const tag = sha.slice(0, 12);
  const pendingUnits: PendingDeploys["units"] = [];
  let newMigration = false;
  for (const unit of DEPLOY_UNITS) {
    const rows = await env.DB.prepare(
      `SELECT service_id, status, desired_version FROM service_registry WHERE service_id IN (${unit.services.map(() => "?").join(", ")})`,
    ).bind(...unit.services).all<{ service_id: string; status: string; desired_version: string | null }>();
    if (rows.results.length !== unit.services.length || rows.results.some((r) => r.status === "disabled")) { out.skipped.push({ unit: unit.unit, reason: "not_registered_or_disabled" }); continue; }
    const behind = [...new Set(rows.results.map((r) => r.desired_version).filter((v) => v !== tag))];
    if (behind.length === 0) continue;
    if (behind.some((v) => !v || !/^[0-9a-f]{7,40}$/.test(v))) { out.skipped.push({ unit: unit.unit, reason: "desired_version_unknown" }); continue; }
    let changed = false;
    let failed = false;
    for (const base of behind) {
      const res = await gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/compare/" + base + "..." + sha + "?per_page=300");
      if (!res.ok) { failed = true; break; }
      const cmp = await res.json() as { status?: string; files?: { filename: string }[] };
      if (cmp.status !== "ahead") { failed = cmp.status !== "identical"; if (failed) break; continue; }
      const files = (cmp.files ?? []).map((f) => f.filename);
      if (files.some((f) => f.startsWith("workers/control-plane-migrations/") && f.endsWith(".sql"))) newMigration = true;
      // GitHub lists at most 300 files; a larger diff is treated as touching every unit.
      if (files.length >= 300 || unitChanged(unit, files)) { changed = true; break; }
    }
    if (failed) { out.skipped.push({ unit: unit.unit, reason: "compare_failed_or_diverged" }); continue; }
    if (changed) pendingUnits.push({ unit: unit.unit, workflow: unit.workflow, target: unit.services[0], reason: `main ${tag} changes ${unit.unit}` });
  }
  // A new D1 migration is applied only by the Control Plane deploy, and every Worker's readiness
  // requires the newest migration: deploy the Control Plane first, alone (2026-11-07, migration 0026).
  const controlPlane = pendingUnits.find((u) => u.unit === "control-plane");
  if (newMigration) {
    if (controlPlane) {
      out.units.push(controlPlane);
      for (const u of pendingUnits) {
        if (u.unit !== "control-plane") out.skipped.push({ unit: u.unit, reason: "control_plane_migration_first" });
      }
      return out;
    }
    // Never deploy another unit if the migration-bearing Control Plane cannot be verified.
    // It may already be current (no skip recorded); otherwise fail closed on disabled,
    // unregistered, unknown-version or compare-failed Control Plane state.
    if (out.skipped.some((s) => s.unit === "control-plane")) {
      out.skipped.push({ unit: "*", reason: "new_migration_control_plane_unavailable" });
      return out;
    }
  }
  // DeployRpc must exist before the AI Kernel is redeployed with its new service binding.
  // Do not propose the Control Plane (or another unit) in the same cycle as the orchestrator.
  const orchestrator = pendingUnits.find((u) => u.unit === "deployment-orchestrator");
  if (orchestrator) {
    out.units.push(orchestrator);
    for (const u of pendingUnits) {
      if (u.unit !== "deployment-orchestrator") out.skipped.push({ unit: u.unit, reason: "deployment_orchestrator_must_complete_first" });
    }
  } else {
    out.units.push(...pendingUnits);
  }
  return out;
}

/**
 * Execute a consensus-approved deploy_commit (ADR-0009 phase 3). Re-verifies the proposal and
 * its fresh Policy Engine allow, then requires the commit to be current main with green CI,
 * claims a per-workflow-and-commit lock, records the request and dispatches the unit's
 * workflow. The workflow keeps all its own gates and rolls back automatically on failure.
 */
export async function deployForConsensus(env: Env, proposalId: string, decisionId: string, target: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  await verifyConsensusExecution(env.DB, proposalId, decisionId, "deploy_commit", target);
  const unit = unitForService(target);
  if (!unit) throw new Error("no_deploy_unit_for_target");
  const sha = typeof params.commit_sha === "string" ? params.commit_sha : "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error("invalid_commit_sha");
  if (!env.GH_ACTIONS_TOKEN || !env.DEPLOYMENT_LOCK) throw new Error("not_configured");
  const actor = `consensus:${proposalId}`;
  const current = await mainSha(env.GH_ACTIONS_TOKEN);
  if (current !== sha) throw new Error("commit_not_current_main");
  const ci = await ciGreen(env.GH_ACTIONS_TOKEN, sha);
  if (!ci.green) throw new Error("ci_not_green");
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
  const dispatch = await gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/actions/workflows/" + unit.workflow + "/dispatches",
    { method: "POST", body: JSON.stringify({ ref: "main", inputs: { confirm_production: "DEPLOY", commit_sha: sha } }) });
  const status = dispatch.status === 204 ? "running" : "failed";
  await env.DB.prepare("UPDATE deployment_requests SET status = ?, updated_at = ? WHERE request_id = ?").bind(status, new Date().toISOString(), requestId).run();
  await appendAuditEvent(env.DB, {
    event_type: dispatch.status === 204 ? "deployment.dispatched" : "deployment.dispatch_failed", actor, subject: target, outcome: status,
    payload: { request_id: requestId, commit_sha: sha, workflow: unit.workflow, unit: unit.unit, github_status: dispatch.status, proposal_id: proposalId },
  });
  if (dispatch.status !== 204) throw new Error(`dispatch_failed_${dispatch.status}`);
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

export async function deployForRecovery(env: Env, planId: string, decisionId: string, serviceId: string, version: string): Promise<Record<string, unknown>> {
  if (!/^[0-9a-f]{7,40}$/.test(version)) throw new Error("invalid_version");
  const plan = await verifyRecoveryExecution(env, planId, decisionId, serviceId);
  if (plan.plan_version !== version) throw new Error("plan_not_executing");
  const unit = unitForService(serviceId);
  if (!unit) throw new Error("no_deploy_unit_for_service");
  if (!env.GH_ACTIONS_TOKEN || !env.DEPLOYMENT_LOCK) throw new Error("not_configured");
  const sha = await mainSha(env.GH_ACTIONS_TOKEN);
  if (!sha) throw new Error("main_lookup_failed");
  // The deploy workflows deploy only the exact current main commit.
  if (!sha.startsWith(version)) throw new Error(`version_not_current_main: plan ${version}, main ${sha.slice(0, 12)}; a new plan is needed`);
  const ci = await ciGreen(env.GH_ACTIONS_TOKEN, sha);
  if (!ci.green) throw new Error("ci_not_green");
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
  const dispatch = await gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/actions/workflows/" + unit.workflow + "/dispatches",
    { method: "POST", body: JSON.stringify({ ref: "main", inputs: { confirm_production: "DEPLOY", commit_sha: sha } }) });
  const status = dispatch.status === 204 ? "running" : "failed";
  await env.DB.prepare("UPDATE deployment_requests SET status = ?, updated_at = ? WHERE request_id = ?").bind(status, new Date().toISOString(), requestId).run();
  await appendAuditEvent(env.DB, {
    event_type: dispatch.status === 204 ? "deployment.dispatched" : "deployment.dispatch_failed", actor, subject: serviceId, outcome: status,
    payload: { request_id: requestId, commit_sha: sha, workflow: unit.workflow, unit: unit.unit, github_status: dispatch.status, plan_id: planId },
  });
  if (dispatch.status !== 204) throw new Error(`dispatch_failed_${dispatch.status}`);
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
  const dispatch = await gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/actions/workflows/" + ROLLBACK_WORKFLOW + "/dispatches",
    { method: "POST", body: JSON.stringify({ ref: "main", inputs: { worker: serviceId, version_tag: tag, confirm_production: "ROLLBACK" } }) });
  const status = dispatch.status === 204 ? "running" : "failed";
  await env.DB.prepare("UPDATE deployment_requests SET status = ?, updated_at = ? WHERE request_id = ?").bind(status, new Date().toISOString(), requestId).run();
  await appendAuditEvent(env.DB, {
    event_type: dispatch.status === 204 ? "deployment.rollback_dispatched" : "deployment.dispatch_failed", actor, subject: serviceId, outcome: status,
    payload: { request_id: requestId, workflow: ROLLBACK_WORKFLOW, version_tag: tag, github_status: dispatch.status, ...link },
  });
  if (dispatch.status !== 204) throw new Error(`dispatch_failed_${dispatch.status}`);
  return { dispatched: true, request_id: requestId, workflow: ROLLBACK_WORKFLOW, commit_sha: sha, version_tag: tag };
}

const NATIVE_ROLLBACK_MAX_AGE_MS = 3 * 3_600_000;
/** A claimed executor that has not completed after this window is terminally failed, never replayed. */
export const NATIVE_ROLLBACK_EXECUTION_LEASE_MS = 30 * 60_000;

type NativeRollbackSignedRow = {
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

function nativeRollbackPayload(row: NativeRollbackSignedRow, details: Record<string, unknown>): string {
  return "cryptophys.native-rollback.queue.v1|" + canonicalRollbackJson({ ...row, details });
}

async function signNativeRollbackRequest(secret: string, row: NativeRollbackSignedRow, details: Record<string, unknown>): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(nativeRollbackPayload(row, details)));
  return Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function verifyNativeRollbackRequest(secret: string, row: NativeRollbackSignedRow, details: Record<string, unknown>, signature: unknown): Promise<boolean> {
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = new Uint8Array(signature.match(/../g)!.map((part) => Number.parseInt(part, 16)));
  return crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(nativeRollbackPayload(row, details)));
}

type NativeRollbackClaimState = { claimed: boolean; claimedAt: number | null };

async function nativeRollbackExecutionSha(requestId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("cryptophys.native-rollback.execution.v1|" + requestId),
  );
  return Array.from(new Uint8Array(digest).slice(0, 20), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function presentNativeRollbackClaim(result: { claimed?: unknown; claimed_at?: unknown }, claimResponse: boolean): NativeRollbackClaimState {
  const claimedAt = typeof result.claimed_at === "string" ? Date.parse(result.claimed_at) : Number.NaN;
  return {
    claimed: claimResponse && result.claimed === true,
    claimedAt: Number.isFinite(claimedAt) ? claimedAt : null,
  };
}

/** Read the one-time claim without consuming it; used to distinguish an active executor from an abandoned one. */
async function readNativeRollbackExecutionClaim(env: Env, requestId: string, idempotencyKey: string): Promise<NativeRollbackClaimState> {
  const sha = await nativeRollbackExecutionSha(requestId);
  const response = await env.DEPLOYMENT_LOCK.get(env.DEPLOYMENT_LOCK.idFromName(idempotencyKey))
    .fetch("https://lock.internal/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha }),
    });
  if (!response.ok) throw new Error("native_rollback_claim_status_http_" + response.status);
  const result = await response.json() as { claimed?: unknown; claimed_at?: unknown };
  return presentNativeRollbackClaim(result, true);
}

/**
 * Claim execution outside shared D1. The HMAC authenticates the immutable request; this
 * request-scoped Durable Object claim prevents a restored signed D1 row from executing twice.
 */
async function claimNativeRollbackExecution(env: Env, requestId: string, idempotencyKey: string): Promise<NativeRollbackClaimState> {
  const sha = await nativeRollbackExecutionSha(requestId);
  const response = await env.DEPLOYMENT_LOCK.get(env.DEPLOYMENT_LOCK.idFromName(idempotencyKey))
    .fetch("https://lock.internal/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha }),
    });
  const result = await response.json() as { claimed?: unknown; claimed_at?: unknown };
  if (!response.ok && response.status !== 409) throw new Error("native_rollback_claim_http_" + response.status);
  return presentNativeRollbackClaim(result, response.ok);
}

async function failNativeRollbackRequest(env: Env, row: NativeRollbackSignedRow, details: Record<string, unknown>, reason: string, now: number): Promise<void> {
  await env.DB.prepare("UPDATE deployment_requests SET status = 'failed', details_json = ?, updated_at = ? WHERE request_id = ? AND status IN ('approved', 'running')")
    .bind(JSON.stringify({ ...details, outcome: { reason } }), new Date(now).toISOString(), row.request_id).run();
  await auditQuietly(env, {
    event_type: "deployment.rollback_failed", actor: "agent:deployment-orchestrator", subject: row.service_id, outcome: "failed",
    payload: { request_id: row.request_id, executor: NATIVE_EXECUTOR, version_tag: row.requested_version, reason },
  });
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
  const row: NativeRollbackSignedRow = { request_id: requestId, service_id: serviceId, requested_version: tag, requested_by: actor, approval_id: approvalId, idempotency_key: key, created_at: at };
  const unsignedDetails = { executor: NATIVE_EXECUTOR, version_tag: tag, ...link };
  // D1 is shared by several Workers. Sign the complete immutable queue identity with the
  // Orchestrator-only deploy secret so another D1-bound Worker cannot forge a rollback request.
  const signature = await signNativeRollbackRequest(env.CF_DEPLOY_TOKEN!, row, unsignedDetails);
  const details = { ...unsignedDetails, signature };
  await env.DB.prepare(
    `INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?)`
  ).bind(row.request_id, row.service_id, row.requested_version, row.requested_by, row.approval_id, row.idempotency_key, JSON.stringify(details), row.created_at, row.created_at).run();
  await appendAuditEvent(env.DB, {
    event_type: "deployment.rollback_queued", actor, subject: serviceId, outcome: "approved",
    payload: { request_id: requestId, executor: NATIVE_EXECUTOR, version_tag: tag, ...link },
  });
  return { dispatched: true, request_id: requestId, executor: NATIVE_EXECUTOR, version_tag: tag };
}

/**
 * ADR-0012 phase 2: run queued native rollbacks (oldest first, at most 3 per run). Only at a
 * SAFE minute. Every request expires after three hours, including when credentials are restored later.
 */
export async function runNativeRollbacks(env: Env, now = Date.now(), fetcher: typeof fetch = fetch, opts: { delayMs?: number } = {}): Promise<{ executed: number; succeeded: number }> {
  if (!env.DB || !SAFE_MINUTES.includes(new Date(now).getUTCMinutes())) return { executed: 0, succeeded: 0 };
  const pattern = '%"executor":"' + NATIVE_EXECUTOR + '"%';
  const recoveryCutoff = new Date(now - NATIVE_ROLLBACK_EXECUTION_LEASE_MS).toISOString();
  const [approvedRows, abandonedRows] = await Promise.all([
    env.DB.prepare(
      "SELECT request_id, service_id, requested_version, requested_by, approval_id, idempotency_key, details_json, created_at, updated_at, status FROM deployment_requests WHERE status = 'approved' AND details_json LIKE ? ORDER BY created_at LIMIT 3",
    ).bind(pattern).all<NativeRollbackSignedRow & { details_json: string; updated_at: string; status: "approved" }>(),
    env.DB.prepare(
      "SELECT request_id, service_id, requested_version, requested_by, approval_id, idempotency_key, details_json, created_at, updated_at, status FROM deployment_requests WHERE status = 'running' AND COALESCE(updated_at, created_at) <= ? AND details_json LIKE ? ORDER BY COALESCE(updated_at, created_at) LIMIT 3",
    ).bind(recoveryCutoff, pattern).all<NativeRollbackSignedRow & { details_json: string; updated_at: string; status: "running" }>(),
  ]);
  const rows = [...approvedRows.results, ...abandonedRows.results]
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .slice(0, 3);
  let executed = 0;
  let succeeded = 0;
  for (const r of rows) {
    // A running row is considered only after the execution lease. A recent durable claim means
    // another invocation is still within its execution window; do not interfere with it.
    if (r.status === "running") {
      let prior: NativeRollbackClaimState;
      try {
        prior = await readNativeRollbackExecutionClaim(env, r.request_id, r.idempotency_key);
      } catch {
        await failNativeRollbackRequest(env, r, {}, "native_rollback_claim_state_unavailable", now);
        continue;
      }
      if (prior.claimed) {
        if (prior.claimedAt !== null && now - prior.claimedAt <= NATIVE_ROLLBACK_EXECUTION_LEASE_MS) continue;
        await failNativeRollbackRequest(env, r, {}, "native_rollback_execution_claim_expired", now);
        continue;
      }
    }

    let details: Record<string, unknown>;
    try { details = JSON.parse(r.details_json || "{}"); } catch {
      await failNativeRollbackRequest(env, r, {}, "invalid_queue_details", now);
      continue;
    }
    if (details.executor !== NATIVE_EXECUTOR) continue;

    // Enforce the three-hour expiry even if credentials are later restored. A delayed
    // rollback must never become executable merely because the secret was re-added.
    const created = Date.parse(r.created_at);
    const age = now - created;
    if (!Number.isFinite(created) || age < 0 || age > NATIVE_ROLLBACK_MAX_AGE_MS) {
      await failNativeRollbackRequest(env, r, details, "stale: native rollback request expired", now);
      continue;
    }

    const planId = typeof details.plan_id === "string" ? details.plan_id : null;
    const proposalId = typeof details.proposal_id === "string" ? details.proposal_id : null;
    const sourceValid = (planId !== null && proposalId === null && r.requested_by === "recovery:" + planId && r.approval_id === planId)
      || (proposalId !== null && planId === null && r.requested_by === "consensus:" + proposalId && r.approval_id === proposalId);
    const linkId = planId ?? proposalId;
    const targetValid = unitForService(r.service_id) !== null
      && /^[0-9a-f]{12}$/.test(r.requested_version)
      && details.version_tag === r.requested_version
      && /^dep_[0-9a-f-]{36}$/.test(r.request_id)
      && sourceValid
      && linkId !== null
      && r.idempotency_key === "rollback:" + r.service_id + ":" + r.requested_version + ":" + linkId;
    if (!targetValid) {
      await failNativeRollbackRequest(env, r, details, "invalid_native_rollback_request", now);
      continue;
    }

    // If the token is temporarily absent, leave a fresh request queued; the unconditional
    // expiry above ensures it cannot execute if credentials return after the three-hour window.
    if (!env.CF_DEPLOY_TOKEN) continue;
    const unsignedDetails = { ...details };
    delete unsignedDetails.signature;
    const signedRow: NativeRollbackSignedRow = {
      request_id: r.request_id, service_id: r.service_id, requested_version: r.requested_version,
      requested_by: r.requested_by, approval_id: r.approval_id, idempotency_key: r.idempotency_key, created_at: r.created_at,
    };
    const signatureValid = await verifyNativeRollbackRequest(env.CF_DEPLOY_TOKEN, signedRow, unsignedDetails, details.signature);
    if (!signatureValid) {
      await failNativeRollbackRequest(env, r, details, "invalid_native_rollback_signature", now);
      continue;
    }
    if (!nativeRollbackConfigured(env)) continue;

    // Persist approved -> running before consuming the one-time DO claim. If D1 fails, no claim
    // is burned and the next scheduled pass can retry. If the response is ambiguous after a
    // successful write, the running-row recovery path checks the DO state before proceeding.
    if (r.status === "approved") {
      const transition = await env.DB.prepare("UPDATE deployment_requests SET status = 'running', updated_at = ? WHERE request_id = ? AND status = 'approved'")
        .bind(new Date(now).toISOString(), r.request_id).run();
      if ((transition.meta.changes ?? 0) !== 1) continue;
    }

    let claimState: NativeRollbackClaimState;
    try {
      claimState = await claimNativeRollbackExecution(env, r.request_id, r.idempotency_key);
    } catch {
      await failNativeRollbackRequest(env, r, details, "native_rollback_execution_claim_unavailable", now);
      continue;
    }
    if (!claimState.claimed) {
      if (claimState.claimedAt === null) {
        await failNativeRollbackRequest(env, r, details, "native_rollback_execution_claim_state_unknown", now);
      } else if (now - claimState.claimedAt > NATIVE_ROLLBACK_EXECUTION_LEASE_MS) {
        await failNativeRollbackRequest(env, r, details, "native_rollback_execution_claim_expired", now);
      }
      continue;
    }

    executed++;
    const cf = new CloudflareWorkers(env.CF_DEPLOY_TOKEN!, env.CF_ACCOUNT_ID!, fetcher);
    const run = await executeRollback(cf, { DRIFT: env.DRIFT!, REGISTRY: env.REGISTRY! }, r.request_id, r.service_id, r.requested_version, opts);
    if (run.ok) succeeded++;
    const status = run.ok ? "succeeded" : "failed";
    await env.DB.prepare("UPDATE deployment_requests SET status = ?, details_json = ?, updated_at = ? WHERE request_id = ? AND status = 'running'")
      .bind(status, JSON.stringify({ ...details, outcome: run }), new Date().toISOString(), r.request_id).run();
    await auditQuietly(env, {
      event_type: run.ok ? "deployment.rollback_succeeded" : "deployment.rollback_failed", actor: "agent:deployment-orchestrator", subject: r.service_id, outcome: status,
      payload: { request_id: r.request_id, executor: NATIVE_EXECUTOR, version_tag: r.requested_version, ...run },
    });
    if (!run.ok) {
      await publishAgentReport(env.AGENTS, "deployment-orchestrator", {
        kind: "platform_digest", severity: "critical",
        subject: "Rollback of " + serviceName(r.service_id) + " to " + r.requested_version + " failed",
        body: { request_id: r.request_id, reason: run.reason ?? null, restored: run.restored ?? false, steps: run.steps },
      });
    }
  }
  return { executed, succeeded };
}

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
  const dispatch = await gh(env.GH_ACTIONS_TOKEN, "/repos/" + REPOSITORY + "/actions/workflows/retire-worker.yml/dispatches",
    { method: "POST", body: JSON.stringify({ ref: "main", inputs: { worker: target, confirm_production: "DELETE" } }) });
  const status = dispatch.status === 204 ? "running" : "failed";
  await env.DB.prepare("UPDATE deployment_requests SET status = ?, updated_at = ? WHERE request_id = ?").bind(status, new Date().toISOString(), requestId).run();
  await appendAuditEvent(env.DB, {
    event_type: dispatch.status === 204 ? "deployment.retire_dispatched" : "deployment.dispatch_failed", actor, subject: target, outcome: status,
    payload: { request_id: requestId, workflow: "retire-worker.yml", github_status: dispatch.status, proposal_id: proposalId },
  });
  if (dispatch.status !== 204) throw new Error(`dispatch_failed_${dispatch.status}`);
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
        checks
      }, ready ? 200 : 503);
    }

    if (url.pathname !== "/v1/deployments") return json({ error: "not_found" }, 404);
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
    // Actions run of every validation/deployment workflow on this commit. The trusted
    // request workflow is excluded because its own in-progress run is the caller of this
    // endpoint, not a CI result. Both lookups are readable by a fine-grained PAT
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
    // The GitHub ledger reconcile keeps its twice-an-hour cadence; native rollbacks run at every SAFE minute.
    if (minute === 10 || minute === 40) ctx.waitUntil(reconcileDeployments(env).then(() => undefined, log("reconcile_failed")));
    ctx.waitUntil(runNativeRollbacks(env, at).then(() => undefined, log("native_rollback_failed")));
  },
};

export class DeploymentLock {
  private readonly state: DurableObjectStateLike;

  constructor(state: DurableObjectStateLike) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || (path !== "/claim" && path !== "/status")) {
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
      if (existing) return json({ claimed: false, claimed_at: typeof existing.claimed_at === "string" ? existing.claimed_at : null }, 409);
      const claimedAt = new Date().toISOString();
      await this.state.storage.put(key, { sha, claimed_at: claimedAt });
      return json({ claimed: true, claimed_at: claimedAt }, 201);
    });
  }
}
