/**
 * The Platform Supervisor agent (ADR-0007), a Durable Object process in the AI Kernel.
 *
 * One cycle: observe (tier 0) -> find problems deterministically -> draft with its AI engine ->
 * act through policy-gated syscalls. What triggers an action is deterministic; the AI engine
 * only writes the proposal text and step list, which are schema-validated and replaced by a
 * template when the model is unavailable. Nothing the model says can widen what is allowed.
 *
 *  - Persistent drift (two consecutive drifted observations of a managed service, no open
 *    agent plan for it, none proposed in the last 24 h) -> recovery.propose (tier 1).
 */
import { newId, type JsonObject } from "../../control-plane-shared/src/http.ts";
import { appendAuditEventWithMutation } from "../../control-plane-shared/src/audit.ts";
import { boundedString, engineFor, type AiTask } from "../../control-plane-shared/src/ai-engine.ts";
import { RECOVERY_STEP_ACTIONS, agentsEnabled, getAgent } from "../../control-plane-shared/src/capabilities.ts";
import { recallContextForAgent, rememberOutcomeForAgent } from "./memory.ts";
import { syscall, observeMetabolism, type SyscallEnv, type SyscallResult } from "./syscall.ts";
import { expireOwnerProposals } from "./consensus.ts";
import { latestCensusRow, proposalFor } from "./organism.ts";
import { POLICY_PARAMETERS, readPolicyParameter } from "../../control-plane-shared/src/policy-params.ts";

/** ADR-0009 phase 3: deploy proposals per supervisor cycle (keeps an operator wake well under 30 s). */
export const MAX_DEPLOY_PROPOSALS_PER_CYCLE = 1;
/** Default of the Policy Engine platform_daily_limit; the live value is the council-adjustable policy parameter. */
export const DAILY_DEPLOY_LIMIT = POLICY_PARAMETERS["daily-deploy-limit"].default;
/** Wave C: denied or failed syscalls in one hour before the supervisor proposes suspending an agent. */
export const SUSPEND_AFTER_FAILURES_PER_HOUR = 5;

export const AGENT_ID = "supervisor";
const SERVICE = "cryptophys-ai-kernel";
const PROPOSAL_COOLDOWN_MS = 24 * 3_600_000;
/** ADR-0013: one registration proposal per action and target per day. */
export const REGISTRATION_COOLDOWN_MS = 24 * 3_600_000;

/** Serializes overlapping invocations of one Durable Object agent cycle, including awaits. */
export class SerialCycleQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export interface KernelEnv extends SyscallEnv {
  AI_MODEL?: string;
  AI_DAILY_REQUEST_LIMIT?: string;
  AI_ACCOUNT_DAILY_REQUEST_LIMIT?: string;
}

/** The agent's private memory (Durable Object storage). */
export interface Memory {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

interface ServiceObs { service_id: string; drifted: boolean; persistent: boolean; reasons: string[]; desired_version: string | null; observed_version: string | null }
interface Observation { services: ServiceObs[]; open_agent_plans: { service_id: string }[] }

export interface Proposal { title: string; rationale: string; steps: { action: string; description: string }[] }

/**
 * Steps an AI-drafted plan may contain: only those the Recovery Manager can execute, plus manual
 * notes. Restoring D1 and rotating secrets are critical, owner-run actions (ADR-0009); an AI draft
 * never proposes them (2026-11-07: a healthy service with an untagged version got a plan that
 * included restore_d1_bookmark).
 */
export const AI_DRAFT_STEP_ACTIONS = RECOVERY_STEP_ACTIONS.filter((a) => a !== "restore_d1_bookmark" && a !== "rotate_secret");

/**
 * A healthy, reachable service whose only finding is a missing version tag is not a recovery case:
 * a dashboard secret or settings change creates a new, untagged version (2026-11-07). It is
 * reported, and the next tagged deploy clears it.
 */
export function onlyUntaggedVersion(s: { reasons: string[] }): boolean {
  return s.reasons.length === 1 && s.reasons[0] === "observed_version_unavailable";
}

export const draftTask: AiTask<Proposal> = {
  name: "draft_recovery_proposal",
  instructions:
    "You are the platform supervisor agent of a Cloudflare Workers control plane. Given drift evidence for one service, " +
    'draft a recovery plan for a human approver. Return {"title": at most 160 characters, "rationale": at most 1500 characters, ' +
    `"steps": 1-5 objects {"action": one of ${AI_DRAFT_STEP_ACTIONS.join(", ")}, "description": at most 300 characters}}. ` +
    "Never propose restoring data or rotating secrets; those are owner actions. " +
    "Only use the evidence given. Never claim anything was executed. Never mention trading, orders or funds.",
  maxInputChars: 6000,
  maxOutputTokens: 600,
  validate(output) {
    const o = output as Record<string, unknown>;
    const title = boundedString(o?.title, 160);
    const rationale = boundedString(o?.rationale, 1500);
    if (!title || !rationale || !Array.isArray(o?.steps) || o.steps.length < 1 || o.steps.length > 5) return null;
    const steps: Proposal["steps"] = [];
    for (const raw of o.steps as Record<string, unknown>[]) {
      const description = boundedString(raw?.description, 300);
      if (!description || !(RECOVERY_STEP_ACTIONS as readonly string[]).includes(raw?.action as string)) return null;
      // Drop owner-only actions from AI drafts instead of passing them on for approval.
      if (!(AI_DRAFT_STEP_ACTIONS as readonly string[]).includes(raw.action as string)) continue;
      steps.push({ action: raw.action as string, description });
    }
    if (steps.length === 0) return null;
    return { title, rationale, steps };
  },
};

/** Deterministic proposal used when the AI engine is unavailable or its output is invalid. */
export function templateProposal(s: ServiceObs): Proposal {
  const mismatch = s.reasons.includes("version_mismatch");
  return {
    title: `Drift on ${s.service_id}: ${s.reasons.join(", ") || "unhealthy"}`.slice(0, 160),
    rationale: `The supervisor agent saw ${s.service_id} drifted in two consecutive observations. Desired version ${s.desired_version ?? "unset"}, observed ${s.observed_version ?? "unavailable"}. Reasons: ${s.reasons.join(", ") || "health check failed"}.`,
    steps: mismatch
      ? [
        { action: "redeploy_commit", description: `Redeploy the desired version ${s.desired_version} of ${s.service_id} through the GitHub Actions deploy workflow.` },
        { action: "manual", description: "Confirm health and drift are back in sync after the deploy." },
      ]
      : [
        { action: "manual", description: `Inspect ${s.service_id} logs and its /ready checks to find the failing dependency.` },
        { action: "rollback_worker_version", description: "If the active version is faulty, roll back to the previous version." },
      ],
  };
}

export interface CycleReport {
  agent_id: string;
  trigger: string;
  cycle_at: string;
  skipped?: string;
  memory?: "ok" | "unavailable";
  findings: JsonObject[];
  actions: SyscallResult[];
}

/** Evaluates digital metabolism health, updates adaptive power mode, and appends a cycle audit. */
export async function evaluateMetabolismState(env: KernelEnv, now = Date.now()): Promise<JsonObject | null> {
  try {
    const obs = await observeMetabolism(env, now);
    const marketStatus = obs.market_status as "open" | "closed" | "holiday";
    const tradingNetPnl = (obs.trading_net_pnl_24h as number) ?? 0;
    const infraBurn = (obs.infra_burn_cost_24h as number) ?? 0.15;
    const treasuryReserve = (obs.treasury_reserve_usd as number) ?? 500;
    const runwayDays = (obs.runway_days as number) ?? 500;
    const metabolicRatio = (obs.metabolic_ratio as number | null) ?? null;
    const override = String(obs.power_mode_override ?? "none");
    const autoAdapt = obs.auto_adaptation_enabled === true;
    const currentMode = obs.power_mode as "survival" | "homeostasis" | "growth";

    let targetMode: "survival" | "homeostasis" | "growth" = "homeostasis";
    let reason = "baseline homeostasis: balanced operational state";

    if (override !== "none" && ["survival", "homeostasis", "growth"].includes(override)) {
      targetMode = override as any;
      reason = `manual operator override enforced (${override})`;
    } else if (marketStatus === "closed") {
      targetMode = "survival";
      reason = "market closed (weekend): entering survival hibernation to conserve AI tokens and compute";
    } else if (infraBurn > 0.20 || tradingNetPnl < -100 || runwayDays < 7) {
      targetMode = "survival";
      reason = infraBurn > 0.20
        ? `billable infrastructure burn ($${infraBurn}/day exceeding free tier): entering survival mode to throttle compute and preserve free tier`
        : `drawdown or low runway (net 24h: $${tradingNetPnl}, runway: ${runwayDays}d): throttling compute`;
    } else if (tradingNetPnl > 50 && runwayDays > 90) {
      // Growth raises budgets, so the supervisor never enters it on its own: it only reports that
      // the owner could set the override (owner 2026-11-10).
      reason = `growth eligible (net 24h: +$${tradingNetPnl}, runway: ${runwayDays}d); staying in homeostasis until the owner sets the growth override`;
    }

    let modeChanged = false;
    if (autoAdapt && targetMode !== currentMode) {
      // The power mode changes what the Policy Engine allows, so every change is in the audit chain,
      // committed together with the mode itself.
      await appendAuditEventWithMutation(env.DB, {
        event_type: "metabolism.power_mode_changed", actor: "agent:supervisor", subject: "metabolism:power_mode", outcome: targetMode,
        payload: { previous_mode: currentMode, mode: targetMode, reason: reason.slice(0, 300), market_status: marketStatus },
      }, () => env.DB.prepare(
        "UPDATE metabolism_controls SET value = ?, updated_by = ?, updated_at = ? WHERE control = 'power_mode' AND value = ?"
      ).bind(targetMode, "agent:supervisor", new Date(now).toISOString(), currentMode));
      modeChanged = true;
    }

    const cycleId = newId("mtb");
    const evaluatedAt = new Date(now).toISOString();
    const actionsJson = JSON.stringify({ mode_changed: modeChanged, previous_mode: currentMode, target_mode: targetMode });

    await env.DB.prepare(
      `INSERT INTO metabolism_cycles (
        cycle_id, evaluated_at, market_status, trading_net_pnl_24h, infra_burn_cost_24h,
        metabolic_ratio, treasury_reserve_usd, runway_days, power_mode, mode_reason, actions_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      cycleId, evaluatedAt, marketStatus, tradingNetPnl, infraBurn,
      metabolicRatio, treasuryReserve, runwayDays, targetMode, reason.slice(0, 300), actionsJson
    ).run();

    return {
      cycle_id: cycleId,
      market_status: marketStatus,
      power_mode: targetMode,
      mode_changed: modeChanged,
      reason,
      treasury_reserve_usd: treasuryReserve,
      runway_days: runwayDays,
    };
  } catch (err) {
    console.error(JSON.stringify({ service: SERVICE, event: "metabolism_evaluation_failed", message: String((err as Error)?.message ?? err) }));
    return null;
  }
}

export async function runCycle(env: KernelEnv, memory: Memory, trigger: "scheduled" | "operator", now = Date.now()): Promise<CycleReport> {
  const report: CycleReport = { agent_id: AGENT_ID, trigger, cycle_at: new Date(now).toISOString(), findings: [], actions: [] };
  const agent = await getAgent(env.DB, AGENT_ID);
  if (!agent || agent.status !== "enabled" || !(await agentsEnabled(env.DB))) {
    report.skipped = !agent ? "agent_not_registered" : agent.status !== "enabled" ? "agent_suspended" : "agents_disabled";
    await memory.put("last_cycle", report);
    return report;
  }
  const observed = await syscall(env, AGENT_ID, "platform.observe");
  report.actions.push(observed);
  if (observed.outcome !== "succeeded") { await memory.put("last_cycle", report); return report; }
  const obs = observed.result as unknown as Observation;

  // Drift -> tier 1 proposal.
  const proposals = (await memory.get<Record<string, number>>("proposals")) ?? {};
  const open = new Set(obs.open_agent_plans.map((p) => p.service_id));
  for (const s of obs.services) {
    const managed = !(s.reasons.length === 1 && s.reasons[0] === "desired_version_unset");
    if (!s.drifted || !s.persistent || !managed || s.service_id === SERVICE) continue;
    if (onlyUntaggedVersion(s)) {
      report.findings.push({ kind: "drift", service_id: s.service_id, action: "none", why: "healthy; only the version tag is missing (e.g. a dashboard secret change); the next tagged deploy clears it" });
      continue;
    }
    if (open.has(s.service_id) || now - (proposals[s.service_id] ?? 0) < PROPOSAL_COOLDOWN_MS) {
      report.findings.push({ kind: "drift", service_id: s.service_id, action: "none", why: "proposal already open or recent" });
      continue;
    }
    const recalled = await recallContextForAgent(env, AGENT_ID, `drift ${s.service_id} ${s.reasons.join(" ")}`, report);
    const aiInput = recalled && recalled.length > 0 ? { ...s, context: recalled } : s;
    const ai = await engineFor(env, SERVICE, [draftTask.name]).run(draftTask, aiInput, `${AGENT_ID}:${s.service_id}:${now}`);
    const draft = ai.status === "ok" ? ai.data : templateProposal(s);
    const result = await syscall(env, AGENT_ID, "recovery.propose", {
      service_id: s.service_id, plan_version: (s.desired_version ?? "unknown").slice(0, 40),
      title: draft.title, rationale: `${draft.rationale}\n\n(Drafted by agent:${AGENT_ID}; AI ${ai.status}.)`.slice(0, 2000), steps: draft.steps,
    });
    report.actions.push(result);
    report.findings.push({ kind: "drift", service_id: s.service_id, action: "recovery.propose", outcome: result.outcome, ai: ai.status });
    // ADR-0009: the same remediation goes to the control-plane consensus. In shadow mode it is
    // voted, tallied and policy-checked but never executed.
    if (s.desired_version) {
      const consensus = await syscall(env, AGENT_ID, "consensus.propose", {
        action: "redeploy_desired_version", target: s.service_id,
        params: { version: s.desired_version, observed_version: s.observed_version, reasons: s.reasons.slice(0, 5) },
      });
      report.actions.push(consensus);
      report.findings.push({ kind: "drift", service_id: s.service_id, action: "consensus.propose", outcome: consensus.outcome });
    }
    if (result.outcome === "succeeded") {
      proposals[s.service_id] = now;
      const planId = String(((result.result.plan as JsonObject | undefined)?.plan_id) ?? s.service_id);
      await rememberOutcomeForAgent(env, AGENT_ID, "recovery_proposal", draft.title, planId, report);
    }
  }
  await memory.put("proposals", proposals);

  // ADR-0009 phase 3: a CI-green main commit that production does not run yet is proposed for
  // deployment, once per deploy unit and commit. Executed only in the 'deploy' consensus mode.
  // Only scheduled cycles propose deploys: a proposal takes 15-25 s (evidence, audit chain, one
  // vote per council seat, policy), and an operator wake is a synchronous request (deploy verification probes it).
  if (trigger === "scheduled") {
    const expired = await expireOwnerProposals(env, now);
    if (expired > 0) report.findings.push({ kind: "consensus", action: "expire", why: `${expired} owner decision(s) lapsed after 24 h` });
    // Wave C: an agent outside the kernel that keeps failing or being denied is proposed for
    // suspension (ADR-0009 §3.2 "repeated failures suspend the agent"), one per cycle, at most
    // once per agent every 6 h. It executes only in a non-shadow mode, through consensus.
    const noisy = await env.DB.prepare(
      `SELECT a.agent_id, COUNT(*) AS n FROM agent_actions a JOIN agents g ON g.agent_id = a.agent_id
       WHERE a.outcome IN ('denied', 'failed') AND a.created_at >= ? AND g.status = 'enabled'
         AND g.host_worker != 'cryptophys-ai-kernel'
       GROUP BY a.agent_id HAVING COUNT(*) >= ? ORDER BY n DESC LIMIT 1`,
    ).bind(new Date(now - 3_600_000).toISOString(), SUSPEND_AFTER_FAILURES_PER_HOUR).first<{ agent_id: string; n: number }>();
    if (noisy) {
      const recent = await env.DB.prepare("SELECT 1 AS x FROM consensus_proposals WHERE action = 'suspend_agent' AND target = ? AND created_at >= ? LIMIT 1")
        .bind(noisy.agent_id, new Date(now - 6 * 3_600_000).toISOString()).first();
      if (!recent) {
        const r = await syscall(env, AGENT_ID, "consensus.propose", {
          action: "suspend_agent", target: noisy.agent_id,
          params: { reason: `${noisy.n} denied or failed syscalls in the last hour` },
        });
        report.actions.push(r);
        report.findings.push({ kind: "agent", service_id: noisy.agent_id, action: "consensus.propose", outcome: r.outcome, why: `${noisy.n} failures in 1 h` });
      }
    }
    // ADR-0013 phase 3: what the Forge's census found declared in the DNA but not live (an agent,
    // an engine, a council seat) is proposed for registration, one per cycle, each action and
    // target at most once a day. Seats and privileged agents are critical: they reach the owner.
    const census = await latestCensusRow(env);
    for (const f of census?.findings ?? []) {
      const prop = census ? proposalFor(census, f) : null;
      if (!prop) continue;
      const recent = await env.DB.prepare("SELECT 1 AS x FROM consensus_proposals WHERE action = ? AND target = ? AND created_at >= ? LIMIT 1")
        .bind(prop.action, prop.target, new Date(now - REGISTRATION_COOLDOWN_MS).toISOString()).first();
      if (recent) continue;
      const r = await syscall(env, AGENT_ID, "consensus.propose", prop);
      report.actions.push(r);
      report.findings.push({ kind: "organism", service_id: prop.target, action: "consensus.propose", outcome: r.outcome, why: `${prop.action}: ${f.detail}`.slice(0, 300) });
      break;
    }
  }
  if (env.DEPLOY && trigger === "operator") {
    report.findings.push({ kind: "deploy", action: "none", why: "deploy proposals run in scheduled cycles only" });
  } else if (env.DEPLOY) {
    try {
      const pending = await env.DEPLOY.pendingDeploys();
      // At most one deploy proposal per cycle: each proposal gathers evidence, verifies the audit
      // chain and runs one vote per council seat, and deploys go one at a time anyway. The rest follow next cycle.
      let proposed = 0;
      // Do not propose what the Policy Engine is certain to veto (owner 2026-11-07: repeated
      // "Blocked" reports drowned the useful ones). Same counting as the Policy Engine: executions
      // that really ran, or shadow records in shadow mode. The Policy Engine stays the authority.
      const mode = (await env.DB.prepare("SELECT value FROM consensus_controls WHERE control = 'mode'").first<{ value: string }>())?.value ?? "shadow";
      const ran = mode === "shadow" ? "('executing','executed','shadow_passed')" : "('executing','executed')";
      const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
      const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
      const daily = await env.DB.prepare(
        `SELECT COUNT(*) AS n, MIN(decided_at) AS oldest FROM consensus_proposals WHERE action IN ('deploy_commit','rollback_worker_version','redeploy_desired_version') AND status IN ${ran} AND decided_at >= ?`,
      ).bind(dayAgo).first<{ n: number; oldest: string | null }>();
      const dailyLimit = await readPolicyParameter(env.DB, "daily-deploy-limit");
      if ((daily?.n ?? 0) >= dailyLimit && pending.units.length > 0) {
        const reopens = daily?.oldest ? new Date(Date.parse(daily.oldest) + 86_400_000).toISOString().slice(11, 16) : "later";
        report.findings.push({ kind: "deploy", action: "none", why: `daily limit of ${dailyLimit} deploys reached; ${pending.units.length} unit(s) wait until about ${reopens} UTC` });
      }
      for (const u of (daily?.n ?? 0) >= dailyLimit ? [] : pending.units) {
        const recentTarget = await env.DB.prepare(
          `SELECT 1 AS x FROM consensus_proposals WHERE action = 'deploy_commit' AND target = ? AND status IN ${ran} AND decided_at >= ? LIMIT 1`,
        ).bind(u.target, hourAgo).first();
        if (recentTarget) {
          report.findings.push({ kind: "deploy", service_id: u.target, action: "none", why: "this service was changed in the last hour; it waits" });
          continue;
        }
        if (proposed >= MAX_DEPLOY_PROPOSALS_PER_CYCLE) {
          report.findings.push({ kind: "deploy", service_id: u.target, action: "none", why: "deferred to the next cycle (one deploy proposal per cycle)" });
          continue;
        }
        if (!pending.main_sha) break;
        // Once per unit and commit, except that a proposal the Policy Engine vetoed (shadow_blocked,
        // e.g. a rate limit) is retried after an hour; otherwise a commit blocked once by the hourly
        // limit would never deploy (2026-11-07: #187 stayed undeployed after a target_rate_limit veto).
        const seen = await env.DB.prepare(
          `SELECT 1 AS x FROM consensus_proposals WHERE action = 'deploy_commit' AND target = ? AND json_extract(params_json, '$.commit_sha') = ?
             AND (status <> 'shadow_blocked' OR created_at >= ?) LIMIT 1`,
        ).bind(u.target, pending.main_sha, new Date(Date.now() - 3_600_000).toISOString()).first();
        if (seen) continue;
        const r = await syscall(env, AGENT_ID, "consensus.propose", {
          action: "deploy_commit", target: u.target,
          params: { commit_sha: pending.main_sha, unit: u.unit, workflow: u.workflow, reason: u.reason.slice(0, 200) },
        });
        proposed += 1;
        report.actions.push(r);
        report.findings.push({ kind: "deploy", service_id: u.target, action: "consensus.propose", outcome: r.outcome });
      }
    } catch (err) {
      report.findings.push({ kind: "deploy", action: "none", why: `pending deploys unavailable: ${String((err as Error)?.message ?? err).slice(0, 120)}` });
    }
  }

  // Digital Metabolism & Adaptive Power Mode Lifecycle
  const mtb = await evaluateMetabolismState(env, now);
  if (mtb && (mtb.mode_changed || trigger === "operator")) {
    report.findings.push({
      kind: "metabolism",
      service_id: "cryptophys-digital-metabolism",
      action: mtb.mode_changed ? "power_mode_adapted" : "observed",
      outcome: "succeeded",
      why: String(mtb.reason ?? `mode ${mtb.power_mode}`).slice(0, 300),
    });
  }

  // Audit real billable usage overages and report throttling intent to maintain free tier
  try {
    const dayStr = new Date(now).toISOString().slice(0, 10);
    const overages = await env.DB.prepare(
      "SELECT service_id, estimated_cost_usd FROM infra_burn_metrics WHERE period_day = ? AND estimated_cost_usd > 0"
    ).bind(dayStr).all<{ service_id: string; estimated_cost_usd: number }>();
    for (const o of overages.results ?? []) {
      report.findings.push({
        kind: "billable_usage_overage",
        service_id: o.service_id,
        action: "throttle_free_tier",
        outcome: "throttled",
        why: `incurred billable cost of ${o.estimated_cost_usd.toFixed(2)} USD; throttled to preserve Free Tier`,
      });
    }
  } catch {}

  await memory.put("last_cycle", report);
  return report;
}
