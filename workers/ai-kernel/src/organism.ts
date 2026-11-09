/**
 * ADR-0013 phase 3: self-registration. What the Forge's census finds declared in the DNA but not
 * yet live is proposed by the Supervisor to consensus; when a proposal passes, these executors write
 * the row. Owner decisions 2026-11-09:
 *   - register_agent / register_engine: routine, consensus only;
 *   - register_privileged_agent (a capability above tier 1, or consensus.propose): critical, owner click;
 *   - admit_voter (a council seat, one per Worker): critical, owner click.
 *
 * Every executor re-verifies the passed proposal and its Policy Engine decision, and takes the gene
 * from the latest census (the DNA the Forge read from main), never from the proposal's params alone:
 * a proposal can only register what reviewed, merged code declares.
 */
import type { JsonObject } from "../../control-plane-shared/src/http.ts";
import { nowIso } from "../../control-plane-shared/src/http.ts";
import { appendAuditEventWithMutation, AuditMutationConflictError } from "../../control-plane-shared/src/audit.ts";
import { verifyConsensusExecution } from "../../control-plane-shared/src/consensus-exec.ts";
import { forbiddenCapabilities, privilegedCapabilities } from "../../control-plane-shared/src/consensus-rules.ts";
import type { SyscallEnv } from "./syscall.ts";

/** One organ of the census genome summary (forge/src/census.ts). */
export interface CensusOrgan {
  service: string;
  kind: string;
  agents: Array<{ id: string; display_name?: string; capabilities?: string[]; tier_max?: number; voter: boolean; vote_binding?: string }>;
  engines: string[];
}
export interface CensusRow { main_sha: string; status: "consistent" | "changes" | "invalid"; findings: Array<{ kind: string; subject: string; detail: string }>; genome: CensusOrgan[] }

export async function latestCensusRow(env: Pick<SyscallEnv, "DB">): Promise<CensusRow | null> {
  let row: { main_sha: string; status: CensusRow["status"]; findings: string; genome: string | null } | null;
  try {
    row = await env.DB.prepare("SELECT main_sha, status, findings, genome FROM forge_organism_census ORDER BY taken_at DESC LIMIT 1").first();
  } catch { return null; }
  if (!row) return null;
  try {
    return { main_sha: row.main_sha, status: row.status, findings: JSON.parse(row.findings) ?? [], genome: JSON.parse(row.genome ?? "[]") ?? [] };
  } catch { return null; }
}

/** The gene the DNA declares for an agent, with its host, from the latest census. */
export function findAgentGene(census: CensusRow | null, agentId: string): { service: string; gene: CensusOrgan["agents"][number] } | null {
  for (const organ of census?.genome ?? []) {
    const gene = organ.agents.find((a) => a.id === agentId);
    if (gene) return { service: organ.service, gene };
  }
  return null;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

async function currentCensus(env: SyscallEnv, mainSha: unknown): Promise<CensusRow> {
  const census = await latestCensusRow(env);
  if (!census) throw new Error("census_unavailable");
  if (census.status !== "changes" && census.status !== "consistent") throw new Error("census_invalid");
  if (String(mainSha ?? "") !== census.main_sha) throw new Error("census_head_changed");
  return census;
}

function requireCensusFinding(census: CensusRow, kind: string, subject: string): void {
  if (census.status !== "changes" || !census.findings.some((finding) => finding.kind === kind && finding.subject === subject)) {
    throw new Error("census_finding_missing");
  }
}

/** Recheck the live registry at execution time; the consensus evidence may be older than this write. */
async function requireActiveHost(env: SyscallEnv, service: string): Promise<void> {
  const row = await env.DB.prepare("SELECT status FROM service_registry WHERE service_id = ?").bind(service).first<{ status: string }>();
  if (!row || (row.status !== "healthy" && row.status !== "degraded")) throw new Error("host_not_active");
}

async function registerAgent(env: SyscallEnv, proposalId: string, p: { action: string; target: string; params: JsonObject }, actor: string): Promise<JsonObject> {
  const census = await currentCensus(env, p.params.main_sha);
  requireCensusFinding(census, "unregistered_agent", p.target);
  const declared = findAgentGene(census, p.target);
  if (!declared || !declared.gene.capabilities || declared.gene.tier_max === undefined || !declared.gene.display_name) throw new Error("agent_not_in_dna");
  const { service, gene } = declared;
  const caps = gene.capabilities!;
  if (String(p.params.service ?? "") !== service) throw new Error("host_differs_from_dna");
  if (!Array.isArray(p.params.capabilities) || !sameSet(p.params.capabilities.map(String), caps)) throw new Error("capabilities_differ_from_dna");
  if (Number(p.params.tier_max) !== gene.tier_max) throw new Error("tier_max_differs_from_dna");
  if (forbiddenCapabilities(caps).length) throw new Error("forbidden_capability");
  const privileged = privilegedCapabilities(caps).length > 0;
  if (privileged !== (p.action === "register_privileged_agent")) throw new Error(privileged ? "privileged_needs_owner" : "not_privileged");
  await requireActiveHost(env, service);
  const at = nowIso();
  try {
    await appendAuditEventWithMutation(env.DB, {
      event_type: "agent.registered", actor, subject: `agent:${p.target}`, outcome: "enabled",
      payload: { proposal_id: proposalId, host_worker: service, capabilities: caps, tier_max: gene.tier_max, privileged, asks_for_seat: gene.voter },
    }, () => env.DB.prepare(
      `INSERT OR IGNORE INTO agents (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at, voter)
       SELECT ?, ?, ?, ?, ?, ?, 'enabled', NULL, ?, ?, ?, 0
       WHERE EXISTS (SELECT 1 FROM service_registry WHERE service_id = ? AND status IN ('healthy', 'degraded'))`,
    ).bind(p.target, gene.display_name!.slice(0, 80), service,
      `Declared in ${service}'s DNA (organism.json at ${census.main_sha.slice(0, 12)}); registered by consensus ${proposalId}.`,
      gene.tier_max, JSON.stringify(caps), actor, at, at, service));
  } catch (err) {
    if (err instanceof AuditMutationConflictError) {
      await requireActiveHost(env, service);
      throw new Error("agent_already_registered");
    }
    throw err;
  }
  return { agent_id: p.target, host_worker: service, capabilities: caps, tier_max: gene.tier_max, privileged, seat: gene.voter ? "asks for a seat: admit_voter follows" : "none" };
}

async function registerEngine(env: SyscallEnv, proposalId: string, p: { target: string; params: JsonObject }, actor: string): Promise<JsonObject> {
  const census = await currentCensus(env, p.params.main_sha);
  const task = String(p.params.task ?? "");
  requireCensusFinding(census, "unregistered_engine", `${p.target}:${task}`);
  const organ = census.genome.find((o) => o.service === p.target);
  if (!organ || !organ.engines.includes(task)) throw new Error("engine_not_in_dna");
  await requireActiveHost(env, p.target);
  const at = nowIso();
  try {
    await appendAuditEventWithMutation(env.DB, {
      event_type: "engine.registered", actor, subject: `${p.target}:${task}`, outcome: "enabled", payload: { proposal_id: proposalId },
    }, () => env.DB.prepare(
      `INSERT INTO engines (service_id, task, status, registered_by, created_at, updated_at)
       SELECT ?, ?, 'enabled', ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM service_registry WHERE service_id = ? AND status IN ('healthy', 'degraded'))
       ON CONFLICT (service_id, task) DO UPDATE SET status = 'enabled', registered_by = excluded.registered_by, updated_at = excluded.updated_at WHERE engines.status <> 'enabled'`,
    ).bind(p.target, task, actor, at, at, p.target));
  } catch (err) {
    if (err instanceof AuditMutationConflictError) {
      await requireActiveHost(env, p.target);
      throw new Error("engine_already_registered");
    }
    throw err;
  }
  return { service_id: p.target, task, status: "enabled" };
}

/**
 * A council seat. The DNA must ask for it, the agent must be enabled, its Worker must hold no other
 * seat, and the seat must be able to vote through reviewed code: a vote binding the kernel knows
 * (VOTE_BINDINGS) that is bound in this deployment, or a founding seat's own rule.
 */
async function admitVoter(env: SyscallEnv, proposalId: string, p: { target: string; params: JsonObject }, actor: string, canVote: (agentId: string) => boolean): Promise<JsonObject> {
  const census = await currentCensus(env, p.params.main_sha);
  requireCensusFinding(census, "voter_seat_requested", p.target);
  const declared = findAgentGene(census, p.target);
  if (!declared?.gene.voter) throw new Error("seat_not_in_dna");
  const agent = await env.DB.prepare("SELECT status, host_worker, voter FROM agents WHERE agent_id = ?").bind(p.target).first<{ status: string; host_worker: string; voter: number }>();
  if (!agent) throw new Error("agent_not_registered");
  if (agent.status !== "enabled") throw new Error("agent_not_enabled");
  if (agent.host_worker !== declared.service) throw new Error("host_differs_from_dna");
  await requireActiveHost(env, agent.host_worker);
  if (!canVote(p.target)) throw new Error("no_vote_binding");
  try {
    await appendAuditEventWithMutation(env.DB, {
      event_type: "consensus.voter_admitted", actor, subject: `agent:${p.target}`, outcome: "admitted", payload: { proposal_id: proposalId, host_worker: agent.host_worker },
    }, () => env.DB.prepare(
      `UPDATE agents SET voter = 1, updated_by = ?, updated_at = ? WHERE agent_id = ? AND voter = 0 AND status = 'enabled'
         AND EXISTS (SELECT 1 FROM service_registry WHERE service_id = agents.host_worker AND status IN ('healthy', 'degraded'))
         AND NOT EXISTS (SELECT 1 FROM agents o WHERE o.host_worker = agents.host_worker AND o.voter = 1 AND o.agent_id <> agents.agent_id)`,
    ).bind(actor, nowIso(), p.target));
  } catch (err) {
    if (err instanceof AuditMutationConflictError) {
      await requireActiveHost(env, agent.host_worker);
      throw new Error("seat_unavailable");
    }
    throw err;
  }
  return { agent_id: p.target, host_worker: agent.host_worker, voter: true };
}

/** The ADR-0013 executors. The caller has run verifyConsensusExecution for critical actions; routine ones verify here. */
export async function executeRegistration(
  env: SyscallEnv, proposalId: string, decisionId: string, p: { action: string; target: string; params: JsonObject }, actor: string,
  canVote: (agentId: string) => boolean,
): Promise<JsonObject> {
  await verifyConsensusExecution(env.DB, proposalId, decisionId, p.action, p.target);
  switch (p.action) {
    case "register_agent":
    case "register_privileged_agent":
      return registerAgent(env, proposalId, p, actor);
    case "register_engine":
      return registerEngine(env, proposalId, p, actor);
    case "admit_voter":
      return admitVoter(env, proposalId, p, actor, canVote);
    default:
      throw new Error("no_executor");
  }
}

/** The proposal (action, target, params) that turns one census finding into a registration, or null. */
export function proposalFor(census: CensusRow, finding: { kind: string; subject: string }): { action: string; target: string; params: JsonObject } | null {
  if (finding.kind === "unregistered_agent") {
    const d = findAgentGene(census, finding.subject);
    if (!d?.gene.capabilities) return null;
    const action = privilegedCapabilities(d.gene.capabilities).length ? "register_privileged_agent" : "register_agent";
    return { action, target: d.gene.id, params: { service: d.service, capabilities: d.gene.capabilities, tier_max: d.gene.tier_max ?? 0, main_sha: census.main_sha } };
  }
  if (finding.kind === "unregistered_engine") {
    const i = finding.subject.lastIndexOf(":");
    if (i <= 0) return null;
    return { action: "register_engine", target: finding.subject.slice(0, i), params: { task: finding.subject.slice(i + 1), main_sha: census.main_sha } };
  }
  if (finding.kind === "voter_seat_requested") return { action: "admit_voter", target: finding.subject, params: { main_sha: census.main_sha } };
  return null;
}
