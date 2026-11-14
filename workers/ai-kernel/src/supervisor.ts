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
import { CAPABILITIES, RECOVERY_STEP_ACTIONS, agentsEnabled, getAgent } from "../../control-plane-shared/src/capabilities.ts";
import { recallContextForAgent, rememberOutcomeForAgent } from "./memory.ts";
import { syscall, observeMetabolism, type SyscallEnv, type SyscallResult } from "./syscall.ts";
import { expireOwnerProposals } from "./consensus.ts";
import { openCriticalReportRows } from "./owner-inbox.ts";
import { latestCensusRow, proposalFor } from "./organism.ts";
import { POLICY_PARAMETERS, readPolicyParameter } from "../../control-plane-shared/src/policy-params.ts";
import { KERNEL_AGENTS, RETIRE_EXEMPT_HOSTS, RETIRE_IDLE_DAYS, TARGET } from "../../control-plane-shared/src/consensus-rules.ts";
import { mergePath } from "../../control-plane-shared/src/merge-path.ts";

/** ADR-0009 phase 3: deploy proposals per supervisor cycle (keeps an operator wake well under 30 s). */
export const MAX_DEPLOY_PROPOSALS_PER_CYCLE = 1;
/** Default of the Policy Engine platform_daily_limit; the live value is the council-adjustable policy parameter. */
export const DAILY_DEPLOY_LIMIT = POLICY_PARAMETERS["daily-deploy-limit"].default;
/** Wave C: denied or failed syscalls in one hour before the supervisor proposes suspending an agent. */
export const SUSPEND_AFTER_FAILURES_PER_HOUR = 5;

export const AGENT_ID = "supervisor";
/** Gate 9: the Access plan is read in the first cycle of each hour (cycles at :07/:22/:37/:52). */
export const ACCESS_CHECK_MINUTES = 15;
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

/**
 * Owner 2026-11-14: consensus.propose's hourly window as the Policy Engine counts it (capabilities.ts, check
 * rate_limit): the syscalls this agent CONSUMED in the last hour (agent_syscall_consumptions, written by
 * verifySyscallDecision when an allowed call is dispatched) against max_per_hour (4). A denied attempt is never
 * consumed, so it does not move the window; it only adds a denied syscall (19 in one day, measured 2026-11-14).
 * The window reopens when its oldest counting consumption is an hour old. The Policy Engine stays the authority:
 * this only avoids calls it is certain to refuse.
 */
export async function consensusProposeWindow(db: KernelEnv["DB"], agentId: string, now = Date.now()): Promise<{ used: number; limit: number; full: boolean; reopens_at: string | null }> {
  const limit = CAPABILITIES["consensus.propose"].max_per_hour ?? Number.POSITIVE_INFINITY;
  const rows = (await db.prepare(
    "SELECT consumed_at FROM agent_syscall_consumptions WHERE agent_id = ? AND capability = 'consensus.propose' AND consumed_at >= ? ORDER BY consumed_at ASC",
  ).bind(agentId, new Date(now - 3_600_000).toISOString()).all<{ consumed_at: string }>()).results ?? [];
  const used = rows.length;
  const full = used >= limit;
  // With n >= limit consumptions, a call is allowed again once n - limit + 1 of them have left the window.
  const reopens_at = full ? new Date(Date.parse(rows[used - limit].consumed_at) + 3_600_000).toISOString() : null;
  return { used, limit, full, reopens_at };
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

/** The heartbeat interval of metabolism_cycles when nothing changes, with 2 minutes' slack for cycle jitter. */
export const METABOLISM_HEARTBEAT_MS = 3_600_000 - 120_000;
export const METABOLISM_RETENTION_MS = 30 * 86_400_000;

/** Evaluates digital metabolism health, updates adaptive power mode, and records the cycle when it carries news. */
export async function evaluateMetabolismState(env: KernelEnv, now = Date.now()): Promise<JsonObject | null> {
  try {
    const obs = await observeMetabolism(env, now);
    const marketStatus = obs.market_status as "open" | "closed" | "holiday";
    const tradingNetPnl = (obs.trading_net_pnl_24h as number) ?? 0;
    const infraBurn = (obs.infra_burn_cost_24h as number) ?? 0.15;
    // No invented values: a placeholder or missing treasury has no runway, and runway rules are skipped.
    const treasuryReserve = typeof obs.treasury_reserve_usd === "number" ? obs.treasury_reserve_usd : 0;
    const runwayDays = typeof obs.runway_days === "number" ? obs.runway_days : null;
    const runwayText = runwayDays === null ? "runway unmeasured (no owner treasury entry)" : `runway: ${runwayDays}d`;
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
    } else if (infraBurn > 0.20 || tradingNetPnl < -100 || (runwayDays !== null && runwayDays < 7)) {
      targetMode = "survival";
      reason = infraBurn > 0.20
        ? `billable infrastructure burn ($${infraBurn}/day exceeding free tier): entering survival mode to throttle compute and preserve free tier`
        : `drawdown or low runway (net 24h: $${tradingNetPnl}, ${runwayText}): throttling compute`;
    } else if (tradingNetPnl > 50 && (runwayDays === null || runwayDays > 90)) {
      // Growth raises budgets, so the supervisor never enters it on its own: it only reports that
      // the owner could set the override (owner 2026-11-10).
      reason = `growth eligible (net 24h: +$${tradingNetPnl}, ${runwayText}); staying in homeostasis until the owner sets the growth override`;
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

    const evaluatedAt = new Date(now).toISOString();
    const actionsJson = JSON.stringify({ mode_changed: modeChanged, previous_mode: currentMode, target_mode: targetMode });
    const modeReason = reason.slice(0, 300);

    // Resource audit (owner 2026-11-14): a cycle is recorded when something changed (the mode, the market status, the
    // reason, the treasury reserve or the runway) and otherwise once an hour as the heartbeat, instead of every
    // 15-minute cycle with the same state.
    const last = await env.DB.prepare(
      "SELECT cycle_id, evaluated_at, market_status, power_mode, mode_reason, treasury_reserve_usd, runway_days FROM metabolism_cycles ORDER BY evaluated_at DESC LIMIT 1",
    ).first<{ cycle_id: string; evaluated_at: string; market_status: string; power_mode: string; mode_reason: string | null; treasury_reserve_usd: number | null; runway_days: number | null }>();
    const record = modeChanged || !last || now - Date.parse(last.evaluated_at) >= METABOLISM_HEARTBEAT_MS
      || last.market_status !== marketStatus || last.power_mode !== targetMode || last.mode_reason !== modeReason
      || (last.treasury_reserve_usd ?? null) !== (treasuryReserve ?? null) || (last.runway_days ?? null) !== (runwayDays ?? null);
    let cycleId = last?.cycle_id ?? null;
    if (record) {
      cycleId = newId("mtb");
      await env.DB.prepare(
        `INSERT INTO metabolism_cycles (
          cycle_id, evaluated_at, market_status, trading_net_pnl_24h, infra_burn_cost_24h,
          metabolic_ratio, treasury_reserve_usd, runway_days, power_mode, mode_reason, actions_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        cycleId, evaluatedAt, marketStatus, tradingNetPnl, infraBurn,
        metabolicRatio, treasuryReserve, runwayDays, targetMode, modeReason, actionsJson
      ).run();
      // Retention: 30 days (the Console shows 14), swept once a day with the 03:00 UTC hour's record.
      if (new Date(now).getUTCHours() === 3) {
        await env.DB.prepare("DELETE FROM metabolism_cycles WHERE evaluated_at < ?").bind(new Date(now - METABOLISM_RETENTION_MS).toISOString()).run();
      }
    }

    return {
      cycle_id: cycleId,
      recorded: record,
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

  // Every consensus.propose of this cycle goes through here (same order as before: drift, agents, organism, deploy,
  // merge, Access). When the hourly window is full the attempt is skipped and the cycle records ONE finding instead
  // of a denied syscall per attempt. Date.now(), not `now`: the Policy Engine's rate_limit counts on its own clock.
  let windowFull = false;
  const proposeConsensus = async (input: JsonObject): Promise<SyscallResult | null> => {
    if (!windowFull) {
      const w = await consensusProposeWindow(env.DB, AGENT_ID, Date.now());
      if (w.full) {
        windowFull = true;
        report.findings.push({
          kind: "rate_window", action: "none", capability: "consensus.propose", used: w.used, limit: w.limit, reopens_at: w.reopens_at,
          why: `consensus.propose window full until ${w.reopens_at ? w.reopens_at.slice(11, 16) : "later"} UTC (${w.used} of ${w.limit} in the last hour); proposals wait`,
        });
      }
    }
    if (windowFull) return null;
    return syscall(env, AGENT_ID, "consensus.propose", input);
  };

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
      const consensus = await proposeConsensus({
        action: "redeploy_desired_version", target: s.service_id,
        params: { version: s.desired_version, observed_version: s.observed_version, reasons: s.reasons.slice(0, 5) },
      });
      if (consensus) {
        report.actions.push(consensus);
        report.findings.push({ kind: "drift", service_id: s.service_id, action: "consensus.propose", outcome: consensus.outcome });
      }
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
        const r = await proposeConsensus({
          action: "suspend_agent", target: noisy.agent_id,
          params: { reason: `${noisy.n} denied or failed syscalls in the last hour` },
        });
        if (r) {
          report.actions.push(r);
          report.findings.push({ kind: "agent", service_id: noisy.agent_id, action: "consensus.propose", outcome: r.outcome, why: `${noisy.n} failures in 1 h` });
        }
      }
    }
    // Owner 2026-11-11 ("dismantle dan delete agent yang sudah tidak berkontribusi"): one enabled agent per
    // cycle that has done nothing for RETIRE_IDLE_DAYS (no action, report or vote, registered before the
    // window) is proposed for retirement; at most once a week per agent. Kernel agents, council seats and
    // the exempt hosts are never proposed (consensus-rules.ts RETIRE_EXEMPT_HOSTS).
    const idleSince = new Date(now - RETIRE_IDLE_DAYS * 86_400_000).toISOString();
    const exempt = [...KERNEL_AGENTS, ...RETIRE_EXEMPT_HOSTS];
    const idle = await env.DB.prepare(
      `SELECT g.agent_id FROM agents g
       WHERE g.status = 'enabled' AND g.created_at < ?1
         AND g.agent_id NOT IN (${[...KERNEL_AGENTS].map((_, i) => `?${i + 3}`).join(", ")})
         AND g.host_worker NOT IN (${[...RETIRE_EXEMPT_HOSTS].map((_, i) => `?${i + 3 + KERNEL_AGENTS.size}`).join(", ")})
         AND g.voter = 0
         AND NOT EXISTS (SELECT 1 FROM agent_actions a WHERE a.agent_id = g.agent_id AND a.created_at >= ?1)
         AND NOT EXISTS (SELECT 1 FROM agent_reports r WHERE r.agent_id = g.agent_id AND r.created_at >= ?1)
         AND NOT EXISTS (SELECT 1 FROM consensus_proposals p WHERE p.action = 'retire_agent' AND p.target = g.agent_id AND p.created_at >= ?2)
       ORDER BY g.created_at, g.agent_id LIMIT 1`,
    ).bind(idleSince, new Date(now - 7 * 86_400_000).toISOString(), ...exempt).first<{ agent_id: string }>();
    if (idle) {
      const r = await proposeConsensus({
        action: "retire_agent", target: idle.agent_id,
        params: { reason: `no action, report or vote for ${RETIRE_IDLE_DAYS} days` },
      });
      if (r) {
        report.actions.push(r);
        report.findings.push({ kind: "agent", service_id: idle.agent_id, action: "consensus.propose", outcome: r.outcome, why: `idle ${RETIRE_IDLE_DAYS} days: retire_agent` });
      }
    }
    // ADR-0013 phase 3: what the Forge's census found declared in the DNA but not live (an agent,
    // an engine, a council seat) is proposed for registration, one per cycle, each action and
    // target (an engine: each task) at most once a day. Seats and privileged agents are critical: they reach the owner.
    const census = await latestCensusRow(env);
    // 2026-11-13: eleven XAUUSD engines stayed unregistered for a day. Their proposals were rejected 8-0 only because
    // the brake held (an open critical report), and each rejection then held its engine for the 24 h cooldown although
    // the brake was off hours later. So: nothing is proposed while the brake holds (every voter would reject it), and
    // a registration rejected only by the brake is proposed again once it is off. Unreadable counts as on (fail closed).
    let registrationBrakeOff = false;
    try { registrationBrakeOff = (await openCriticalReportRows(env.DB, now, 1)).length === 0; } catch { registrationBrakeOff = false; }
    const waiting = (census?.findings ?? []).filter((f) => census && proposalFor(census, f)).length;
    if (!registrationBrakeOff && waiting > 0) {
      report.findings.push({ kind: "organism", action: "none", why: `${waiting} registration(s) wait: a critical report is open, so the council would reject them` });
    }
    for (const f of registrationBrakeOff ? census?.findings ?? [] : []) {
      const prop = census ? proposalFor(census, f) : null;
      if (!prop) continue;
      // An engine's target is its service, so its task is part of the key: a Worker's second new AI task is not
      // held for a day behind its first (owner 2026-11-12). A proposal the Policy Engine vetoed (shadow_blocked,
      // e.g. its hourly limit per action and target) is retried after an hour, as deploy proposals are.
      const task = prop.action === "register_engine" ? String(prop.params.task ?? "") : null;
      const recent = await env.DB.prepare(
        `SELECT 1 AS x FROM consensus_proposals WHERE action = ? AND target = ? AND created_at >= ?
           AND (status <> 'shadow_blocked' OR created_at >= ?)
           AND NOT (status = 'rejected' AND COALESCE(json_extract(evidence_json, '$.critical_reports_24h'), 0) > 0)${task !== null ? " AND json_extract(params_json, '$.task') = ?" : ""} LIMIT 1`,
      ).bind(...[prop.action, prop.target, new Date(now - REGISTRATION_COOLDOWN_MS).toISOString(), new Date(now - 3_600_000).toISOString(), ...(task !== null ? [task] : [])]).first();
      if (recent) continue;
      // The Policy Engine executes at most one action per action and target an hour (target-actions-per-hour).
      // A Worker's next task waits until its previous registration is an hour old instead of being proposed
      // only to be vetoed (owner 2026-11-12: no noise in the council).
      if (task !== null) {
        const perHour = await readPolicyParameter(env.DB, "target-actions-per-hour");
        const ran = await env.DB.prepare(
          `SELECT COUNT(*) AS n FROM consensus_proposals WHERE action = ? AND target = ? AND status IN ('executing','executed') AND decided_at >= ?`,
        ).bind(prop.action, prop.target, new Date(now - 3_600_000).toISOString()).first<{ n: number }>();
        if ((ran?.n ?? 0) >= perHour) continue;
      }
      const r = await proposeConsensus(prop);
      if (!r) break;
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
      // 2026-11-13: a proposal the council rejected only because the brake held (an open critical report in its
      // evidence) is proposed again once the brake is off; before, such a commit waited for the next main commit.
      // Unreadable counts as on (fail closed), so nothing is retried while the brake may hold.
      let brakeOff = false;
      try { brakeOff = (await openCriticalReportRows(env.DB, Date.now(), 1)).length === 0; } catch { brakeOff = false; }
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
             AND (status <> 'shadow_blocked' OR created_at >= ?)
             AND NOT (? = 1 AND status = 'rejected' AND COALESCE(json_extract(evidence_json, '$.critical_reports_24h'), 0) > 0) LIMIT 1`,
        ).bind(u.target, pending.main_sha, new Date(Date.now() - 3_600_000).toISOString(), brakeOff ? 1 : 0).first();
        if (seen) continue;
        const r = await proposeConsensus({
          action: "deploy_commit", target: u.target,
          params: { commit_sha: pending.main_sha, unit: u.unit, workflow: u.workflow, reason: u.reason.slice(0, 200) },
        });
        if (!r) break;
        proposed += 1;
        report.actions.push(r);
        report.findings.push({ kind: "deploy", service_id: u.target, action: "consensus.propose", outcome: r.outcome });
      }
    } catch (err) {
      report.findings.push({ kind: "deploy", action: "none", why: `pending deploys unavailable: ${String((err as Error)?.message ?? err).slice(0, 120)}` });
    }
  }

  // ADR-0012 G3b: after the cut-over (merge path forge), a change request on platform-work whose every check passed is
  // proposed for merge, one per cycle: merge_change for routine paths, merge_owner_change (the owner's click) when it
  // touches a guard path. Once per request and head; a policy veto (shadow_blocked) is retried after an hour.
  if (env.FORGE_MERGE && trigger !== "operator" && (await mergePath(env.DB)) === "forge") {
    try {
      const open = (await env.DB.prepare(
        "SELECT cr_id, head_sha FROM forge_change_requests WHERE status = 'open' AND source = 'forge' AND blocked_reason IS NULL ORDER BY updated_at ASC LIMIT 10",
      ).all<{ cr_id: string; head_sha: string }>()).results ?? [];
      const hourAgo = new Date(now - 3_600_000).toISOString();
      for (const cr of open) {
        if (!TARGET.test(cr.cr_id)) {
          report.findings.push({ kind: "merge", service_id: cr.cr_id, action: "none", why: "the change request's id cannot name a consensus target (letters, digits and dashes only)" });
          continue;
        }
        const seen = await env.DB.prepare(
          `SELECT 1 AS x FROM consensus_proposals WHERE action IN ('merge_change', 'merge_owner_change') AND target = ? AND json_extract(params_json, '$.head_sha') = ?
             AND (status <> 'shadow_blocked' OR created_at >= ?) LIMIT 1`,
        ).bind(cr.cr_id, cr.head_sha, hourAgo).first();
        if (seen) continue;
        const state = await env.FORGE_MERGE.changeState(cr.cr_id);
        if (!state || state.head_sha !== cr.head_sha || !state.contains_main) continue;
        const action = state.verdict === "would_merge" ? "merge_change" : state.verdict === "needs_owner" ? "merge_owner_change" : null;
        if (!action) continue;
        const r = await proposeConsensus({ action, target: cr.cr_id, params: { head_sha: cr.head_sha } });
        if (!r) break;
        report.actions.push(r);
        report.findings.push({ kind: "merge", service_id: cr.cr_id, action: "consensus.propose", outcome: r.outcome });
        break;
      }
    } catch (err) {
      report.findings.push({ kind: "merge", action: "none", why: `merge proposals unavailable: ${String((err as Error)?.message ?? err).slice(0, 120)}` });
    }
  }

  // ADR-0012 G6 gate 9: once an hour, compare the Access application with the platform's definition. A difference
  // becomes one critical change_access proposal per plan (its digest), which waits for the owner's click; it is
  // proposed again only when the plan changes or after 24 h (the owner window). A plan that cannot be read is a
  // finding only: the owner is contacted for approvals, not for this.
  if (trigger === "scheduled" && env.DEPLOY?.accessPlan && new Date(now).getUTCMinutes() < ACCESS_CHECK_MINUTES) {
    try {
      const plan = await env.DEPLOY.accessPlan();
      if (!plan.configured) {
        // Not set up: nothing to say every hour.
      } else if (!plan.ok) {
        report.findings.push({ kind: "access", action: "none", why: `access plan unavailable: ${String(plan.reason ?? "unknown").slice(0, 120)}` });
      } else if (plan.in_sync) {
        report.findings.push({ kind: "access", action: "none", why: "the Access application matches the platform's definition" });
      } else if (plan.digest && /^[0-9a-f]{64}$/.test(plan.digest)) {
        const seen = await env.DB.prepare(
          "SELECT 1 AS x FROM consensus_proposals WHERE action = 'change_access' AND json_extract(params_json, '$.digest') = ? AND created_at >= ? LIMIT 1",
        ).bind(plan.digest, new Date(now - PROPOSAL_COOLDOWN_MS).toISOString()).first();
        if (seen) {
          report.findings.push({ kind: "access", action: "none", why: "the Access change is already proposed; it waits for the owner" });
        } else {
          const changes = (plan.changes ?? []).slice(0, 12).map((c) => String(c).slice(0, 120));
          const r = await proposeConsensus({ action: "change_access", target: "platform", params: { digest: plan.digest, changes } });
          if (r) {
            report.actions.push(r);
            report.findings.push({ kind: "access", action: "consensus.propose", outcome: r.outcome, why: `${changes.length} Access change(s): ${changes.slice(0, 3).join("; ")}`.slice(0, 300) });
          }
        }
      }
    } catch (err) {
      report.findings.push({ kind: "access", action: "none", why: `access plan unavailable: ${String((err as Error)?.message ?? err).slice(0, 120)}` });
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
    const thirtyDaysAgo = new Date(now - 30 * 86_400_000).toISOString().slice(0, 10);
    const overages = await env.DB.prepare(
      "SELECT service_id, period_day, estimated_cost_usd FROM infra_burn_metrics WHERE period_day >= ? AND estimated_cost_usd > 0 ORDER BY period_day DESC, estimated_cost_usd DESC"
    ).bind(thirtyDaysAgo).all<{ service_id: string; period_day: string; estimated_cost_usd: number }>();
    for (const o of overages.results ?? []) {
      report.findings.push({
        kind: "billable_usage_overage",
        service_id: o.service_id,
        period_day: o.period_day,
        action: "throttle_free_tier",
        outcome: "throttled",
        why: `incurred billable cost of ${o.estimated_cost_usd.toFixed(2)} USD on ${o.period_day}; throttled to preserve Free Tier`,
      });
    }
  } catch {}

  await memory.put("last_cycle", report);
  return report;
}
