/**
 * Cut-over gate of 2026-11-15 (owner, "1 setuju"): the rescue executor. It deploys ONE Worker, the Deployment
 * Orchestrator, from the Forge's bundle of main, and runs in the Recovery Manager, never in the Orchestrator. The
 * Orchestrator deploying itself runs its own possibly broken code; on 2026-11-15 its native deploy failed three times
 * on a bug whose fix lived in it, and the only way out was an owner-run GitHub workflow, which leaves at cut-over
 * step 6. This path is that workflow's replacement for the Orchestrator alone.
 *
 * Trigger (the simplest safe rule, owner-visible): an owner-approved break-glass recovery plan (`force_redeploy_unit`,
 * break-glass.ts) whose service is `cryptophys-deployment-orchestrator`. The Recovery Manager's plan Workflow runs it
 * instead of asking the Orchestrator (recovery-manager/src/autonomous.ts). No consensus action and no agent can start
 * it: it holds a second Workers Scripts Edit credential, so every use is one owner click. When the Orchestrator's own
 * last native deploy of its unit failed, the Owner page says so and points to this path (owner-inbox.ts
 * `executor_deploy_failed`), so the click is asked for exactly when the executor cannot fix itself.
 *
 * The steps are native-deploy.ts's for a code-only change, re-implemented here on purpose:
 *   1. the plan is re-checked in this module's own code: executing, its own recovery.execute allow within 2 hours,
 *      written and approved by two different people, one full commit that is main's head and ready (Forge checks),
 *      the Orchestrator's Worker and nothing else, and no destructive migration named (this path applies none);
 *   2. the Forge's manifest and module of that commit are read and hash-checked; the Worker must be single-module,
 *      without static assets or [limits], with the wrangler.toml of the version it runs (config_sha256 equal): a
 *      configuration change is not this path's (it stays with the Orchestrator's own plan);
 *   3. pending D1 migrations are allowed only when none names anything the Orchestrator's bundled code reads
 *      (executor-first.ts); this path never applies one;
 *   4. nothing else is deploying: no native request queued or running in the last 75 minutes;
 *   5. capture the active deployment, upload the module as a version that keeps every binding, check the uploaded
 *      version binds exactly what the active one binds (a 404 on reading it back is read again), deploy it at 100 %,
 *      verify it live through the Drift Detector (health and version tag), record the desired version through the
 *      Platform Registry; on any failure after the deploy call, restore the captured deployment and verify it.
 * One request row (deployment_requests, executor `rescue:deployment-orchestrator`, UNIQUE per plan) is the one-time
 * claim: a replayed Workflow step never deploys twice, and a row found `running` on replay (the step was interrupted)
 * is failed as `rescue_interrupted` with a critical report.
 *
 * Shared code it depends on, honestly: break-glass.ts (plan rules), forge-gate.ts (`forgeReady`), executor-first.ts,
 * migration-rules.ts (through executor-first), audit.ts and agents.ts. A bug in the Orchestrator Worker's code
 * (native-deploy.ts, native-rollback.ts, index.ts) cannot block it; a bug in one of these shared files could, and so
 * could a broken Recovery Manager or Drift Detector. The Cloudflare client below is its own and can address only the
 * Orchestrator's script. This file is a guard path (guard-paths.ts, break_glass).
 */
import type { D1Database } from "./types.ts";
import { appendAuditEvent } from "./audit.ts";
import { publishAgentReport, type AgentRpcBinding } from "./agents.ts";
import { approvedBreakGlassPlan } from "./break-glass.ts";
import { forgeReady } from "./forge-gate.ts";
import { ORCHESTRATOR_SERVICE, ORCHESTRATOR_UNIT, RESCUE_EXECUTOR, executorFirstVerdict, readOrchestratorManifest, readOrchestratorModule, type BundleTextReader } from "./executor-first.ts";

export { RESCUE_EXECUTOR };
/** The owner-set secret on cryptophys-recovery-manager: a Cloudflare API token with Account → Workers Scripts → Edit. */
export const RESCUE_TOKEN = "CF_ORCHESTRATOR_DEPLOY_TOKEN";
/** The minutes a deploy may start: the Orchestrator's SAFE_MINUTES (outside the drift and kernel cron windows). */
export const RESCUE_MINUTES = [2, 10, 17, 25, 32, 40, 47, 55] as const;
/** The plan's recovery.execute allow must be this fresh (the Orchestrator's RECOVERY_DECISION_WINDOW_MS). */
export const RESCUE_DECISION_WINDOW_MS = 2 * 3_600_000;
export const RESCUE_VERIFY_ATTEMPTS = 12;
export const RESCUE_VERIFY_DELAY_MS = 5_000;
export const RESCUE_UPLOADED_READ_ATTEMPTS = 6;
export const RESCUE_UPLOADED_READ_DELAY_MS = 2_000;
/** The binding types a code-only version keeps from the script's previous version (native-rollback.ts KEEP_BINDINGS). */
export const RESCUE_KEEP_BINDINGS = [
  "plain_text", "secret_text", "secret_key", "d1", "service", "durable_object_namespace", "r2_bucket", "kv_namespace", "ai",
  "vectorize", "workflow", "artifacts", "worker_loader", "version_metadata", "secrets_store_secret", "send_email",
  "analytics_engine", "queue", "browser",
] as const;

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f-]{36}$/;
const API = "https://api.cloudflare.com/client/v4";

export interface RescueEnv {
  DB: D1Database;
  BUNDLES?: BundleTextReader & { list?(o: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: Array<{ key: string }>; truncated: boolean; cursor?: string }> };
  DRIFT?: { probeService(serviceId: string): Promise<{ healthy: boolean; version_tag: string | null }> };
  REGISTRY?: { recordNativeDeploy?(requestId: string): Promise<unknown> };
  AGENTS?: AgentRpcBinding;
  CF_ORCHESTRATOR_DEPLOY_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
}

/** What the rescue executor lacks in this Worker, by name; empty when it is configured. */
export function rescueMissing(env: Partial<RescueEnv>): string[] {
  const out: string[] = [];
  if (!env.CF_ORCHESTRATOR_DEPLOY_TOKEN) out.push(`secret ${RESCUE_TOKEN}`);
  if (!env.CF_ACCOUNT_ID || !/^[0-9a-f]{32}$/.test(env.CF_ACCOUNT_ID)) out.push("secret CF_ACCOUNT_ID (32 hex)");
  if (!env.BUNDLES?.get || !env.BUNDLES.list) out.push("binding BUNDLES");
  if (!env.DRIFT) out.push("binding DRIFT");
  if (!env.REGISTRY?.recordNativeDeploy) out.push("binding REGISTRY");
  return out;
}

/** Milliseconds until the next RESCUE_MINUTES minute starts (0 inside one). */
export function msToRescueMinute(now: number): number {
  if ((RESCUE_MINUTES as readonly number[]).includes(new Date(now).getUTCMinutes())) return 0;
  const start = Math.ceil(now / 60_000) * 60_000;
  for (let i = 0; i < 60; i++) if ((RESCUE_MINUTES as readonly number[]).includes(new Date(start + i * 60_000).getUTCMinutes())) return start + i * 60_000 - now;
  return 60_000;
}

type Deployment = Array<{ version_id: string; percentage: number }>;

/** A Workers API client that can address only the Orchestrator's script. */
export class RescueCloudflare {
  private readonly fetcher: typeof fetch;
  private readonly token: string;
  private readonly account: string;
  constructor(token: string, account: string, fetcher: typeof fetch = fetch) {
    if (!/^[0-9a-f]{32}$/.test(account)) throw new Error("invalid_account_id");
    this.token = token;
    this.account = account;
    this.fetcher = (input, init) => fetcher(input, init);
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const type: Record<string, string> = init.body instanceof FormData ? {} : { "content-type": "application/json" };
    const res = await this.fetcher(`${API}/accounts/${this.account}/workers/scripts/${ORCHESTRATOR_SERVICE}/${path}`, {
      ...init, headers: { authorization: `Bearer ${this.token}`, ...type },
    });
    const body = await res.json().catch(() => null) as { success?: boolean; result?: T; errors?: { code: number }[] } | null;
    if (!res.ok || !body?.success) throw new Error(`cloudflare_api_${res.status}_${(body?.errors ?? []).map((e) => e.code).join("-") || "error"}`);
    return body.result as T;
  }

  async active(): Promise<Deployment> {
    const r = await this.call<{ deployments?: Array<{ created_on: string; versions: Deployment }> }>("deployments");
    const latest = [...(r?.deployments ?? [])].sort((a, b) => Date.parse(a.created_on) - Date.parse(b.created_on)).pop();
    const versions = (latest?.versions ?? []).map(({ version_id, percentage }) => ({ version_id, percentage })).sort((a, b) => a.version_id.localeCompare(b.version_id));
    if (!versions.length || !versions.every((v) => UUID.test(v.version_id))) throw new Error("active_deployment_unreadable");
    return versions;
  }

  /** The sorted `type:name` of a version's bindings and a digest of their full records; empty or unreadable throws. */
  async bindingSet(versionId: string): Promise<{ names: string[]; digest: string }> {
    if (!UUID.test(versionId)) throw new Error("invalid_version_id");
    const r = await this.call<{ resources?: { bindings?: unknown } }>(`versions/${versionId}`);
    const list = Array.isArray(r?.resources?.bindings) ? r.resources!.bindings as Array<{ type?: unknown; name?: unknown }> : null;
    if (!list?.length || !list.every((b) => typeof b?.type === "string" && typeof b?.name === "string")) throw new Error("version_bindings_unreadable");
    const canon = (v: unknown): unknown => Array.isArray(v) ? v.map(canon) : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v;
    const text = list.map((b) => JSON.stringify(canon(b))).sort().join("\n");
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
    return { names: list.map((b) => `${b.type}:${b.name}`).sort(), digest: [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("") };
  }

  /** Upload the module as a new, undeployed version that keeps every binding of the previous one; returns its id. */
  async upload(module: string, text: string, meta: { compatibility_date: string; compatibility_flags: string[]; tag: string; message: string }): Promise<string> {
    if (module !== `${ORCHESTRATOR_SERVICE}.mjs` || !/^[0-9a-f]{12}$/.test(meta.tag)) throw new Error("invalid_upload");
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify({
      main_module: module, compatibility_date: meta.compatibility_date, compatibility_flags: meta.compatibility_flags,
      keep_bindings: [...RESCUE_KEEP_BINDINGS], annotations: { "workers/tag": meta.tag, "workers/message": meta.message.slice(0, 100) },
    })], { type: "application/json" }));
    form.append(module, new Blob([text], { type: "application/javascript+module" }), module);
    const r = await this.call<{ id?: string }>("versions", { method: "POST", body: form });
    if (typeof r?.id !== "string" || !UUID.test(r.id)) throw new Error("version_upload_unreadable");
    return r.id;
  }

  async deploy(versions: Deployment, message: string): Promise<void> {
    await this.call("deployments", { method: "POST", body: JSON.stringify({ strategy: "percentage", versions, annotations: { "workers/message": message.slice(0, 100) } }) });
  }
}

const sameDeployment = (a: Deployment, b: Deployment) => JSON.stringify(a) === JSON.stringify(b);
const realSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The orchestrator's entry of the manifest of the one commit whose sha starts with `tag`, or null. */
async function runningWorker(bundles: NonNullable<RescueEnv["BUNDLES"]>, tag: string): Promise<{ commit: string; worker: Record<string, unknown> } | null> {
  const commits = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const r = await bundles.list!({ prefix: `bundles/${tag}`, cursor, limit: 1000 });
    for (const o of r.objects) { const m = /^bundles\/([0-9a-f]{40})\/manifest\.json$/.exec(o.key); if (m && m[1].startsWith(tag)) commits.add(m[1]); }
    if (!r.truncated || !r.cursor) break;
    cursor = r.cursor;
  }
  if (commits.size !== 1) return null;
  const commit = [...commits][0];
  const read = await readOrchestratorManifest(bundles, commit);
  return read.manifest?.worker ? { commit, worker: read.manifest.worker } : null;
}

export type RescueChoice =
  | { ok: true; module: string; text: string; compatibility_date: string; compatibility_flags: string[]; running_tag: string; pending_migrations: string[] }
  | { ok: false; reason: string; file?: string };

/**
 * Everything the rescue deploy of the Orchestrator at `sha` needs, read only. `named` are the plan's destructive
 * migrations (must be none). Never throws.
 */
export async function rescueChoice(env: RescueEnv, sha: string, named: readonly string[], now = Date.now()): Promise<RescueChoice> {
  try {
    if (named.length) return { ok: false, reason: "orchestrator_applies_no_migrations" };
    if (!HEX40.test(sha)) return { ok: false, reason: "invalid_commit_sha" };
    if (!env.BUNDLES?.list) return { ok: false, reason: "not_configured" };
    const head = await env.DB.prepare("SELECT commit_sha FROM forge_check_runs WHERE source = 'main' ORDER BY started_at DESC, rowid DESC LIMIT 1").first<{ commit_sha: string }>();
    if (!head || head.commit_sha !== sha) return { ok: false, reason: head ? "commit_not_current_main" : "forge_main_check_missing" };
    const gate = await forgeReady(env.DB, sha);
    if (!gate.ready) return { ok: false, reason: gate.reason };
    const reg = await env.DB.prepare("SELECT status, desired_version FROM service_registry WHERE service_id = ?").bind(ORCHESTRATOR_SERVICE).first<{ status: string; desired_version: string | null }>();
    if (!reg || reg.status === "disabled" || !/^[0-9a-f]{12,40}$/.test(reg.desired_version ?? "")) return { ok: false, reason: "desired_version_unknown" };
    const read = await readOrchestratorManifest(env.BUNDLES, sha);
    if (!read.manifest) return { ok: false, reason: "no_bundle" };
    const w = read.manifest.worker;
    const mod = await readOrchestratorModule(env.BUNDLES, sha, w);
    if ("reason" in mod) return { ok: false, reason: mod.reason };
    if (w!.assets !== false) return { ok: false, reason: "assets" };
    if (w!.limits === true) return { ok: false, reason: "limits" };
    if (typeof w!.compatibility_date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(w!.compatibility_date)) return { ok: false, reason: "config_unreadable" };
    const flags = w!.compatibility_flags;
    if (!Array.isArray(flags) || !flags.every((f) => typeof f === "string")) return { ok: false, reason: "config_unreadable" };
    const tag = reg.desired_version!.slice(0, 12);
    const running = reg.desired_version!.length === 40 ? await readOrchestratorManifest(env.BUNDLES, reg.desired_version!).then((r) => r.manifest?.worker ? { commit: reg.desired_version!, worker: r.manifest.worker } : null)
      : await runningWorker(env.BUNDLES, tag);
    if (!running) return { ok: false, reason: "running_bundle_missing" };
    if (typeof w!.config_sha256 !== "string" || !HEX64.test(w!.config_sha256) || running.worker.config_sha256 !== w!.config_sha256) return { ok: false, reason: "config_changed" };
    if (running.worker.limits === true) return { ok: false, reason: "limits" };
    // D1's ledger against main's list: only files main has, and those not applied yet must not be read by the code.
    const migrations = read.manifest.migrations;
    if (!migrations) return { ok: false, reason: "migrations_unknown" };
    const ledger = ((await env.DB.prepare("SELECT name FROM d1_migrations").all<{ name: string | null }>()).results ?? []).map((r) => r.name);
    if (!ledger.every((n): n is string => typeof n === "string")) return { ok: false, reason: "d1_migrations_unreadable" };
    const unknown = ledger.find((f) => !migrations.includes(f));
    if (unknown) return { ok: false, reason: "d1_migration_not_in_main", file: unknown };
    const pending = migrations.filter((f) => !ledger.includes(f));
    if (pending.length) {
      const v = await executorFirstVerdict(env.BUNDLES, sha, pending);
      if (v.state !== "independent") return { ok: false, reason: v.state === "dependent" ? `orchestrator_needs_pending_migration:${v.reason}` : "no_bundle", ...(v.state === "dependent" && v.file ? { file: v.file } : {}) };
    }
    // Nothing else deploying: the Orchestrator's own requests (native:*) and other rescues, queued or running.
    const busy = await env.DB.prepare(
      `SELECT request_id FROM deployment_requests WHERE status IN ('approved', 'running') AND created_at >= ?
         AND (details_json LIKE '%"executor":"native:%' OR details_json LIKE '%"executor":"rescue:%') LIMIT 1`,
    ).bind(new Date(now - 75 * 60_000).toISOString()).first<{ request_id: string }>();
    if (busy) return { ok: false, reason: "deploy_in_progress" };
    return { ok: true, module: String(w!.module), text: mod.text, compatibility_date: w!.compatibility_date, compatibility_flags: [...flags as string[]], running_tag: tag, pending_migrations: pending };
  } catch {
    return { ok: false, reason: "rescue_read_failed" };
  }
}

export interface RescueRun { ok: boolean; reason?: string; restored?: boolean; production_changed: boolean; version_id?: string; steps: string[] }

/** Run the deploy over a choice. Never throws; the caller records the outcome. */
export async function executeRescueDeploy(cf: RescueCloudflare, env: Pick<RescueEnv, "DRIFT" | "REGISTRY">, requestId: string, sha: string,
  choice: Extract<RescueChoice, { ok: true }>, opts: { delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<RescueRun> {
  const tag = sha.slice(0, 12);
  const sleep = opts.sleep ?? realSleep;
  const steps: string[] = [];
  let captured: Deployment | null = null;
  let changed = false;
  let versionId: string | undefined;
  try {
    if (!env.DRIFT || !env.REGISTRY?.recordNativeDeploy) throw new Error("not_configured");
    captured = await cf.active();
    if (captured.length !== 1 || captured[0].percentage !== 100) throw new Error("active_deployment_split");
    steps.push("captured");
    const active = await cf.bindingSet(captured[0].version_id);
    versionId = await cf.upload(choice.module, choice.text, { compatibility_date: choice.compatibility_date, compatibility_flags: choice.compatibility_flags, tag, message: `rescue deploy commit ${sha}` });
    steps.push("uploaded");
    let uploaded: { names: string[]; digest: string } | null = null;
    for (let i = 1; !uploaded; i++) {
      try { uploaded = await cf.bindingSet(versionId); } catch (e) {
        if (i >= RESCUE_UPLOADED_READ_ATTEMPTS || !/^cloudflare_api_404(_|$)/.test(String((e as Error)?.message ?? e))) throw e;
        await sleep(opts.delayMs ?? RESCUE_UPLOADED_READ_DELAY_MS);
      }
    }
    if (JSON.stringify(uploaded.names) !== JSON.stringify(active.names) || uploaded.digest !== active.digest) throw new Error("bindings_differ");
    steps.push("bindings_match");
    // Recorded before the call: an ambiguous failure of the deploy call is restored as well.
    changed = true;
    await cf.deploy([{ version_id: versionId, percentage: 100 }], `rescue deploy ${tag}, ${requestId}`);
    steps.push("deployed");
    let live = false;
    for (let i = 0; i < RESCUE_VERIFY_ATTEMPTS && !live; i++) {
      if (i > 0) await sleep(opts.delayMs ?? RESCUE_VERIFY_DELAY_MS);
      const p = await env.DRIFT.probeService(ORCHESTRATOR_SERVICE).catch(() => null);
      live = Boolean(p?.healthy && p.version_tag === tag);
    }
    if (!live) throw new Error("not_live_at_tag");
    steps.push("verified");
    await env.REGISTRY.recordNativeDeploy(requestId);
    steps.push("desired_recorded");
    return { ok: true, production_changed: true, version_id: versionId, steps };
  } catch (err) {
    const reason = String((err as Error)?.message ?? err).slice(0, 200);
    let restored = true;
    if (changed && captured) {
      try {
        if (!sameDeployment(await cf.active(), captured)) await cf.deploy(captured, `rescue ${requestId} failed; restoring`);
        restored = sameDeployment(await cf.active(), captured);
        if (restored) steps.push("restored");
      } catch { restored = false; }
    }
    return { ok: false, reason, restored, production_changed: changed, ...(versionId ? { version_id: versionId } : {}), steps };
  }
}

export const rescueRequestKey = (sha: string, planId: string) => `rescue:${ORCHESTRATOR_UNIT}:${sha}:${planId}`;

export type RescueOutcome =
  | { status: "succeeded"; request_id: string; detail: string }
  | { status: "failed"; request_id?: string; detail: string; refused?: boolean }
  | { status: "not_now"; detail: string };

async function audit(db: D1Database, event: Parameters<typeof appendAuditEvent>[1]): Promise<void> {
  try { await appendAuditEvent(db, event); } catch { /* the request row carries the outcome */ }
}

/**
 * The rescue's report: the owner's break_glass_deployed notice (warning) or, when it failed, the critical report that
 * holds routine consensus. Publishing is advisory and never throws (agents.ts), and a kernel refusal before the Policy
 * Engine (agent-rpc.ts resolve: the binding's props.host_worker) leaves no audit event of its own. So a report that
 * was not stored is recorded here as deployment.rescue_report_failed with the kernel's reason (incident 2026-11-16:
 * plan_b94d06cf's report was lost without a trace), and the reason is returned for the step's detail.
 */
async function report(env: RescueEnv, r: { request_id: string; plan_id: string; sha: string; ok: boolean; reason?: string; restored?: boolean; steps: string[] }): Promise<string | null> {
  const tag = r.sha.slice(0, 12);
  const severity = r.ok ? "warning" : "critical";
  const after = r.ok ? "It was verified live and recorded; the Orchestrator was not used."
    : `${r.restored === false ? "The restore of the Orchestrator did not complete: check production now." : "The Orchestrator was restored to the version it ran."} Acknowledge this report on the Owner page to let routine consensus continue.`;
  const published = await publishAgentReport(env.AGENTS, "recovery-manager", {
    kind: "platform_digest", severity,
    subject: `Rescue deploy of the Deployment Orchestrator at ${tag} ${r.ok ? "succeeded" : `failed (${r.reason ?? "unknown"})`}`.slice(0, 200),
    body: {
      explanation: `An owner-approved break-glass plan (${r.plan_id}) deployed the Deployment Orchestrator at main ${tag} through the Recovery Manager, without the Orchestrator's own deploy code. ${after}`,
      break_glass: true, rescue: true, executor: RESCUE_EXECUTOR, alert_key: `break_glass:${r.request_id}`, state: r.ok ? "open" : "failed",
      request_id: r.request_id, plan_id: r.plan_id, unit: ORCHESTRATOR_UNIT, commit_sha: r.sha, outcome: r.ok ? "succeeded" : "failed",
      reason: r.reason ?? null, restored: r.restored ?? null, steps: r.steps.slice(0, 20),
    },
  });
  if (published.ok) return null;
  await audit(env.DB, { event_type: "deployment.rescue_report_failed", actor: `recovery:${r.plan_id}`, subject: ORCHESTRATOR_SERVICE, outcome: "failed",
    payload: { request_id: r.request_id, plan_id: r.plan_id, commit_sha: r.sha, severity, alert_key: `break_glass:${r.request_id}`, rescue_outcome: r.ok ? "succeeded" : "failed", reason: published.reason } });
  return published.reason;
}

/** The step's detail names a report that was not stored, so the plan page shows it too. */
const unreported = (reason: string | null) => reason ? `; its report was not stored (${reason.slice(0, 120)}), audited as deployment.rescue_report_failed` : "";

/**
 * The force_redeploy_unit step of an approved break-glass plan for the Orchestrator, run by the Recovery Manager's
 * plan Workflow inside one step (no retries). Returns `not_now` outside RESCUE_MINUTES (nothing read or written).
 */
export async function rescueForRecovery(env: RescueEnv, planId: string, decisionId: string, opts: { now?: number; fetcher?: typeof fetch; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<RescueOutcome> {
  const now = opts.now ?? Date.now();
  if (msToRescueMinute(now) > 0) return { status: "not_now", detail: "waiting for a minute outside the drift and kernel cron windows" };
  const missing = rescueMissing(env);
  if (missing.length) return { status: "failed", refused: true, detail: `the rescue executor is not configured on cryptophys-recovery-manager: ${missing.join(", ")}` };
  const plan = await env.DB.prepare("SELECT service_id, status, plan_version, created_by, approved_by, steps_json, last_execution_json FROM recovery_plans WHERE plan_id = ?")
    .bind(planId).first<{ service_id: string; status: string; plan_version: string; created_by: string | null; approved_by: string | null; steps_json: string | null; last_execution_json: string | null }>();
  let exec: { policy_decision_id?: unknown } = {};
  try { exec = JSON.parse(plan?.last_execution_json ?? "{}") ?? {}; } catch { exec = {}; }
  const actor = `recovery:${planId}`;
  const refuse = async (reason: string, extra: Record<string, unknown> = {}): Promise<RescueOutcome> => {
    await audit(env.DB, { event_type: "deployment.rescue_refused", actor, subject: ORCHESTRATOR_SERVICE, outcome: "refused", payload: { plan_id: planId, policy_decision_id: decisionId, reason, ...extra } });
    return { status: "failed", refused: true, detail: `rescue deploy refused: ${reason}${extra.file ? ` (${String(extra.file)})` : ""}; nothing in production changed` };
  };
  if (!plan || plan.status !== "executing" || exec.policy_decision_id !== decisionId) return refuse("plan_not_executing");
  if (plan.service_id !== ORCHESTRATOR_SERVICE) return refuse("not_the_orchestrator");
  const d = await env.DB.prepare("SELECT action, resource, decision, created_at FROM policy_decisions WHERE decision_id = ?").bind(decisionId)
    .first<{ action: string; resource: string; decision: string; created_at: string }>();
  const age = d ? now - Date.parse(d.created_at) : Number.NaN;
  if (!d || d.action !== "recovery.execute" || d.resource !== planId || d.decision !== "allow" || !(age >= 0 && age <= RESCUE_DECISION_WINDOW_MS)) return refuse("recovery_decision_invalid");
  const bg = approvedBreakGlassPlan(plan);
  if (!bg.ok) return refuse(bg.reason);
  const sha = plan.plan_version;
  const key = rescueRequestKey(sha, planId);
  const prior = await env.DB.prepare("SELECT request_id, status, details_json FROM deployment_requests WHERE service_id = ? AND idempotency_key = ?")
    .bind(ORCHESTRATOR_SERVICE, key).first<{ request_id: string; status: string; details_json: string }>();
  if (prior) {
    if (prior.status === "succeeded") return { status: "succeeded", request_id: prior.request_id, detail: `rescue deploy of the Orchestrator at ${sha.slice(0, 12)} succeeded (request ${prior.request_id})` };
    if (prior.status === "running") {
      // The step was interrupted mid-deploy: never deploy twice. Production may be changed; the owner checks it.
      let details: Record<string, unknown> = {};
      try { details = JSON.parse(prior.details_json || "{}"); } catch { details = {}; }
      await env.DB.prepare("UPDATE deployment_requests SET status = 'failed', details_json = ?, updated_at = ? WHERE request_id = ? AND status = 'running'")
        .bind(JSON.stringify({ ...details, outcome: { reason: "rescue_interrupted", restored: null } }), new Date(now).toISOString(), prior.request_id).run();
      await audit(env.DB, { event_type: "deployment.rescue_failed", actor, subject: ORCHESTRATOR_SERVICE, outcome: "failed", payload: { request_id: prior.request_id, plan_id: planId, commit_sha: sha, reason: "rescue_interrupted" } });
      const lost = await report(env, { request_id: prior.request_id, plan_id: planId, sha, ok: false, reason: "rescue_interrupted", restored: false, steps: [] });
      return { status: "failed", request_id: prior.request_id, detail: `rescue deploy request ${prior.request_id} already ran for this plan; write a new plan${unreported(lost)}` };
    }
    return { status: "failed", request_id: prior.request_id, detail: `rescue deploy request ${prior.request_id} already ran for this plan; write a new plan` };
  }
  const choice = await rescueChoice(env, sha, bg.destructive_migrations, now);
  if (!choice.ok) return refuse(choice.reason, choice.file ? { file: choice.file } : {});
  const requestId = `dep_${crypto.randomUUID()}`;
  const at = new Date(now).toISOString();
  const details = {
    executor: RESCUE_EXECUTOR, unit: ORCHESTRATOR_UNIT, commit_sha: sha, version_tag: sha.slice(0, 12), services: [ORCHESTRATOR_SERVICE],
    plan_id: planId, policy_decision_id: decisionId, running: `${ORCHESTRATOR_SERVICE}@${choice.running_tag}`, pending_migrations: choice.pending_migrations,
  };
  try {
    // The one-time claim: UNIQUE(service_id, idempotency_key).
    await env.DB.prepare(
      `INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
    ).bind(requestId, ORCHESTRATOR_SERVICE, sha, actor, planId, key, JSON.stringify(details), at, at).run();
  } catch {
    return { status: "failed", detail: "rescue deploy request could not be claimed (another run of this plan holds it)" };
  }
  await audit(env.DB, { event_type: "deployment.rescue_started", actor, subject: ORCHESTRATOR_SERVICE, outcome: "running",
    payload: { request_id: requestId, executor: RESCUE_EXECUTOR, plan_id: planId, policy_decision_id: decisionId, commit_sha: sha, running: details.running, pending_migrations: choice.pending_migrations } });
  const cf = new RescueCloudflare(env.CF_ORCHESTRATOR_DEPLOY_TOKEN!, env.CF_ACCOUNT_ID!, opts.fetcher ?? fetch);
  const run = await executeRescueDeploy(cf, env, requestId, sha, choice, { delayMs: opts.delayMs, sleep: opts.sleep });
  await env.DB.prepare("UPDATE deployment_requests SET status = ?, details_json = ?, updated_at = ? WHERE request_id = ? AND status = 'running'")
    .bind(run.ok ? "succeeded" : "failed", JSON.stringify({ ...details, outcome: { reason: run.reason ?? null, restored: run.restored ?? null, production_changed: run.production_changed, version_id: run.version_id ?? null, steps: run.steps } }),
      new Date().toISOString(), requestId).run();
  await audit(env.DB, { event_type: run.ok ? "deployment.rescue_succeeded" : "deployment.rescue_failed", actor, subject: ORCHESTRATOR_SERVICE, outcome: run.ok ? "succeeded" : "failed",
    payload: { request_id: requestId, executor: RESCUE_EXECUTOR, plan_id: planId, commit_sha: sha, reason: run.reason ?? null, restored: run.restored ?? null, steps: run.steps } });
  const lost = await report(env, { request_id: requestId, plan_id: planId, sha, ok: run.ok, reason: run.reason, restored: run.restored, steps: run.steps });
  return run.ok
    ? { status: "succeeded", request_id: requestId, detail: `rescue deploy of the Orchestrator at ${sha.slice(0, 12)} succeeded without the Orchestrator (request ${requestId}${unreported(lost)})` }
    : { status: "failed", request_id: requestId, detail: `rescue deploy of the Orchestrator at ${sha.slice(0, 12)} failed: ${run.reason ?? "unknown"} (request ${requestId}; ${run.restored === false ? "restore did not complete, check production" : "restored"}${unreported(lost)})` };
}
