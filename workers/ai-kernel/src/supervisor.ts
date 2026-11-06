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
import type { JsonObject } from "../../control-plane-shared/src/http.ts";
import { boundedString, engineFor, type AiTask } from "../../control-plane-shared/src/ai-engine.ts";
import { RECOVERY_STEP_ACTIONS, agentsEnabled, getAgent } from "../../control-plane-shared/src/capabilities.ts";
import { recallContextForAgent, rememberOutcomeForAgent } from "./memory.ts";
import { syscall, type SyscallEnv, type SyscallResult } from "./syscall.ts";

export const AGENT_ID = "supervisor";
const SERVICE = "cryptophys-ai-kernel";
const PROPOSAL_COOLDOWN_MS = 24 * 3_600_000;

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

export const draftTask: AiTask<Proposal> = {
  name: "draft_recovery_proposal",
  instructions:
    "You are the platform supervisor agent of a Cloudflare Workers control plane. Given drift evidence for one service, " +
    'draft a recovery plan for a human approver. Return {"title": at most 160 characters, "rationale": at most 1500 characters, ' +
    `"steps": 1-5 objects {"action": one of ${RECOVERY_STEP_ACTIONS.join(", ")}, "description": at most 300 characters}}. ` +
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
      steps.push({ action: raw.action as string, description });
    }
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
  if (env.DEPLOY) {
    try {
      const pending = await env.DEPLOY.pendingDeploys();
      for (const u of pending.units) {
        if (!pending.main_sha) break;
        const seen = await env.DB.prepare(
          "SELECT 1 AS x FROM consensus_proposals WHERE action = 'deploy_commit' AND target = ? AND json_extract(params_json, '$.commit_sha') = ? LIMIT 1",
        ).bind(u.target, pending.main_sha).first();
        if (seen) continue;
        const r = await syscall(env, AGENT_ID, "consensus.propose", {
          action: "deploy_commit", target: u.target,
          params: { commit_sha: pending.main_sha, unit: u.unit, workflow: u.workflow, reason: u.reason.slice(0, 200) },
        });
        report.actions.push(r);
        report.findings.push({ kind: "deploy", service_id: u.target, action: "consensus.propose", outcome: r.outcome });
      }
    } catch (err) {
      report.findings.push({ kind: "deploy", action: "none", why: `pending deploys unavailable: ${String((err as Error)?.message ?? err).slice(0, 120)}` });
    }
  }

  await memory.put("last_cycle", report);
  return report;
}
