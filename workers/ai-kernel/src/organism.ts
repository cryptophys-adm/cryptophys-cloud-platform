/**
 * ADR-0013 phase 3: self-registration. What the Forge's census finds declared in the DNA but not
 * yet live is proposed by the Supervisor to consensus; when a proposal passes, these executors write
 * the row. Owner decisions 2026-11-09:
 *   - register_agent / register_engine: routine, consensus only;
 *   - retire_engine (owner 2026-11-15, "Aksi retire_engine"): the mirror of register_engine, routine, for an
 *     enabled engine its organ's DNA no longer declares (census finding undeclared_engine); status 'retired',
 *     nothing deleted (ai_usage keeps its history); a DNA that declares the task again re-registers it;
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
import { EXTERNAL_ORIGINS, externalCeilingViolations } from "../../control-plane-shared/src/organism.ts";
import type { SyscallEnv } from "./syscall.ts";

/** One organ of the census genome summary (forge/src/census.ts). */
export interface CensusOrgan {
  service: string;
  kind: string;
  agents: Array<{ id: string; display_name?: string; capabilities?: string[]; tier_max?: number; voter: boolean; vote_binding?: string; schedule?: { cron: string } }>;
  engines: string[];
  /** Set for an external organ (EXTERNAL_ORIGINS): its DNA came over RPC, held to the external ceiling. */
  origin?: string;
}
export interface CensusRow { main_sha: string; status: "consistent" | "changes" | "invalid"; findings: Array<{ kind: string; subject: string; detail: string }>; genome: CensusOrgan[] }

export async function latestCensusRow(env: Pick<SyscallEnv, "DB">): Promise<CensusRow | null> {
  return (await latestCensusRows(env, 1))[0] ?? null;
}

/**
 * The latest census rows, newest first (one per main head; a head's row is retaken in place). A row that does not
 * parse ends the list there, so a consecutive pair is never formed across an unreadable row.
 */
export async function latestCensusRows(env: Pick<SyscallEnv, "DB">, limit: number): Promise<CensusRow[]> {
  let rows: Array<{ main_sha: string; status: CensusRow["status"]; findings: string; genome: string | null }>;
  try {
    rows = (await env.DB.prepare("SELECT main_sha, status, findings, genome FROM forge_organism_census ORDER BY taken_at DESC LIMIT ?")
      .bind(Math.max(1, Math.min(limit, 5))).all<{ main_sha: string; status: CensusRow["status"]; findings: string; genome: string | null }>()).results ?? [];
  } catch { return []; }
  const out: CensusRow[] = [];
  for (const row of rows) {
    try {
      out.push({ main_sha: row.main_sha, status: row.status, findings: JSON.parse(row.findings) ?? [], genome: JSON.parse(row.genome ?? "[]") ?? [] });
    } catch { break; }
  }
  return out;
}

/** The gene the DNA declares for an agent, with its host, from the latest census. */
export function findAgentGene(census: CensusRow | null, agentId: string): { service: string; gene: CensusOrgan["agents"][number]; origin?: string } | null {
  for (const organ of census?.genome ?? []) {
    const gene = organ.agents.find((a) => a.id === agentId);
    if (gene) return { service: organ.service, gene, ...(organ.origin ? { origin: organ.origin } : {}) };
  }
  return null;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/**
 * The census the proposal was voted on, proven current: it is the latest census row, it is valid, the
 * proposal names its head, and that head is still canonical main in Artifacts right now (the Forge's
 * CanonicalMainRpc, read at execution time). A push to main after the last census tick therefore stops
 * every registration until the census of the new head is taken and voted on. Fails closed: without the
 * binding, or when the Forge cannot answer, nothing is registered.
 */
async function currentCensus(env: SyscallEnv, mainSha: unknown): Promise<CensusRow> {
  const census = await latestCensusRow(env);
  if (!census) throw new Error("census_unavailable");
  if (census.status !== "changes" && census.status !== "consistent") throw new Error("census_invalid");
  if (String(mainSha ?? "") !== census.main_sha) throw new Error("census_head_changed");
  if (!env.CANONICAL_MAIN) throw new Error("canonical_main_unavailable");
  let canonical: string | null;
  try { canonical = (await env.CANONICAL_MAIN.mainHead())?.main_sha ?? null; } catch { throw new Error("canonical_main_unavailable"); }
  if (!canonical || !/^[0-9a-f]{40}$/.test(canonical)) throw new Error("canonical_main_unavailable");
  if (canonical !== census.main_sha) throw new Error("census_stale_main_moved");
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
  if (!row || !["registered", "healthy", "degraded"].includes(row.status)) throw new Error("host_not_active");
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
  // An external organ's gene came over RPC, not from reviewed code: it is held to the ceiling again here.
  if (declared.origin !== undefined) {
    const origin = EXTERNAL_ORIGINS.find((o) => o.origin === declared.origin);
    if (!origin || !origin.services.includes(service)) throw new Error("external_origin_unknown");
    if (externalCeilingViolations(gene, origin).length) throw new Error("external_ceiling");
  }
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
       WHERE EXISTS (SELECT 1 FROM service_registry WHERE service_id = ? AND status IN ('registered', 'healthy', 'degraded'))`,
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

/**
 * ADR-0014 §11 (docs/design/EVOLVER.md §8, 2026-11-17): set a registered agent's capabilities to what its DNA now
 * declares (census finding agent_capabilities_changed). The gene comes from the latest census, as for a registration;
 * the host must be unchanged, no capability may be privileged (that needs a registration the owner clicks), and an
 * external organ's gene is held to its origin's ceiling again here. Status, seat and tier are not touched.
 */
async function updateAgentCapabilities(env: SyscallEnv, proposalId: string, p: { target: string; params: JsonObject }, actor: string): Promise<JsonObject> {
  const census = await currentCensus(env, p.params.main_sha);
  requireCensusFinding(census, "agent_capabilities_changed", p.target);
  const declared = findAgentGene(census, p.target);
  if (!declared || !declared.gene.capabilities || declared.gene.tier_max === undefined) throw new Error("agent_not_in_dna");
  const { service, gene } = declared;
  const caps = gene.capabilities!;
  if (String(p.params.service ?? "") !== service) throw new Error("host_differs_from_dna");
  if (!Array.isArray(p.params.capabilities) || !sameSet(p.params.capabilities.map(String), caps)) throw new Error("capabilities_differ_from_dna");
  if (caps.length === 0 || forbiddenCapabilities(caps).length) throw new Error("forbidden_capability");
  if (privilegedCapabilities(caps).length) throw new Error("privileged_needs_owner");
  if (declared.origin !== undefined) {
    const origin = EXTERNAL_ORIGINS.find((o) => o.origin === declared.origin);
    if (!origin || !origin.services.includes(service)) throw new Error("external_origin_unknown");
    if (externalCeilingViolations(gene, origin).length) throw new Error("external_ceiling");
  }
  const row = await env.DB.prepare("SELECT host_worker, capabilities_json FROM agents WHERE agent_id = ?").bind(p.target).first<{ host_worker: string; capabilities_json: string }>();
  if (!row) throw new Error("agent_not_registered");
  if (row.host_worker !== service) throw new Error("host_differs_from_dna");
  let previous: string[] = [];
  try { const v = JSON.parse(row.capabilities_json); if (Array.isArray(v)) previous = v.map(String); } catch { previous = []; }
  if (sameSet(previous, caps)) throw new Error("capabilities_unchanged");
  await requireActiveHost(env, service);
  try {
    await appendAuditEventWithMutation(env.DB, {
      event_type: "agent.capabilities_updated", actor, subject: `agent:${p.target}`, outcome: "updated",
      payload: { proposal_id: proposalId, host_worker: service, previous, capabilities: caps, main_sha: census.main_sha },
    }, () => env.DB.prepare(
      "UPDATE agents SET capabilities_json = ?, updated_by = ?, updated_at = ? WHERE agent_id = ? AND host_worker = ? AND capabilities_json = ?",
    ).bind(JSON.stringify(caps), actor, nowIso(), p.target, service, row.capabilities_json));
  } catch (err) {
    if (err instanceof AuditMutationConflictError) throw new Error("agent_changed_concurrently");
    throw err;
  }
  return { agent_id: p.target, host_worker: service, previous, capabilities: caps };
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
       WHERE EXISTS (SELECT 1 FROM service_registry WHERE service_id = ? AND status IN ('registered', 'healthy', 'degraded'))
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

/** "service:task" of an engine finding, split at the last colon, or null. */
export function engineSubject(subject: string): { service: string; task: string } | null {
  const i = subject.lastIndexOf(":");
  if (i <= 0 || i === subject.length - 1) return null;
  return { service: subject.slice(0, i), task: subject.slice(i + 1) };
}

/**
 * Whether the census read this organ's DNA. An external organ whose origin did not answer (external_dna_unavailable,
 * the Observer's unknown_origins) is left out of the genome, and its absence proves nothing: no engine of it is
 * retired. A main organ is read when it is in the genome; an external one also needs its origin named on it.
 */
export function organDnaRead(census: CensusRow, service: string): CensusOrgan | null {
  const origin = EXTERNAL_ORIGINS.find((o) => o.services.includes(service));
  if (origin && census.findings.some((f) => f.kind === "external_dna_unavailable" && f.subject === origin.origin)) return null;
  const organ = census.genome.find((o) => o.service === service);
  if (!organ) return null;
  if (origin ? organ.origin !== origin.origin : organ.origin !== undefined) return null;
  return organ;
}

/**
 * An undeclared_engine finding the latest census proves: an enabled engine whose organ's DNA was read and does not
 * declare the task. Shared by the Supervisor (proposal) and the executor (re-check at execution time).
 */
export function undeclaredEngineProven(census: CensusRow, subject: string): { service: string; task: string } | null {
  if (census.status !== "changes" || !census.findings.some((f) => f.kind === "undeclared_engine" && f.subject === subject)) return null;
  const e = engineSubject(subject);
  if (!e) return null;
  const organ = organDnaRead(census, e.service);
  if (!organ || organ.engines.includes(e.task)) return null;
  return e;
}

/** Owner 2026-11-15: an undeclared engine is retired only once the finding has persisted this long, or over 2 census rows. */
export const RETIRE_ENGINE_PERSIST_MS = 3_600_000;
export const RETIRE_ENGINE_PERSIST_ROWS = 2;

/**
 * Whether an undeclared_engine finding persisted (owner 2026-11-15), so a DNA change still in flight (a task renamed
 * in one commit and deployed in the next, an external origin's DNA between two writes) never retires an engine:
 *  - it is proven in each of the RETIRE_ENGINE_PERSIST_ROWS latest census rows (consecutive heads), or
 *  - the Supervisor has seen it proven, without a gap, for RETIRE_ENGINE_PERSIST_MS (firstSeenMs, its memory: a head's
 *    census row is retaken in place, so one row cannot show how long a finding stood).
 */
export function undeclaredEnginePersistent(rows: CensusRow[], subject: string, firstSeenMs: number | undefined, nowMs: number): boolean {
  if (!rows[0] || !undeclaredEngineProven(rows[0], subject)) return false;
  if (rows.length >= RETIRE_ENGINE_PERSIST_ROWS && rows.slice(0, RETIRE_ENGINE_PERSIST_ROWS).every((r) => undeclaredEngineProven(r, subject))) return true;
  return firstSeenMs !== undefined && nowMs - firstSeenMs >= RETIRE_ENGINE_PERSIST_MS;
}

/**
 * The mirror of registerEngine (owner 2026-11-15). The latest census, current with canonical main, must prove the
 * engine undeclared: its organ's DNA was read (never an organ of an origin whose DNA did not answer) and does not
 * declare the task. Only an enabled row changes; nothing is deleted, so ai_usage keeps its history. A second run
 * changes nothing. register_engine re-enables the row if a DNA declares the task again.
 */
async function retireEngine(env: SyscallEnv, proposalId: string, p: { target: string; params: JsonObject }, actor: string): Promise<JsonObject> {
  const census = await currentCensus(env, p.params.main_sha);
  const task = String(p.params.task ?? "");
  requireCensusFinding(census, "undeclared_engine", `${p.target}:${task}`);
  const organ = organDnaRead(census, p.target);
  if (!organ) throw new Error("organ_dna_unread");
  if (organ.engines.includes(task)) throw new Error("engine_still_declared");
  // An external organ is held to its origin as at registration: only a service its origin may declare.
  if (organ.origin !== undefined) {
    const origin = EXTERNAL_ORIGINS.find((o) => o.origin === organ.origin);
    if (!origin || !origin.services.includes(p.target)) throw new Error("external_origin_unknown");
  }
  await requireActiveHost(env, p.target);
  const at = nowIso();
  try {
    await appendAuditEventWithMutation(env.DB, {
      event_type: "engine.retired", actor, subject: `${p.target}:${task}`, outcome: "retired",
      payload: { proposal_id: proposalId, main_sha: census.main_sha, ...(organ.origin ? { origin: organ.origin } : {}) },
    }, () => env.DB.prepare(
      `UPDATE engines SET status = 'retired', registered_by = ?, updated_at = ?
       WHERE service_id = ? AND task = ? AND status = 'enabled'
         AND EXISTS (SELECT 1 FROM service_registry WHERE service_id = engines.service_id AND status IN ('registered', 'healthy', 'degraded'))`,
    ).bind(actor, at, p.target, task));
  } catch (err) {
    if (err instanceof AuditMutationConflictError) {
      await requireActiveHost(env, p.target);
      const row = await env.DB.prepare("SELECT status FROM engines WHERE service_id = ? AND task = ?").bind(p.target, task).first<{ status: string }>();
      if (row?.status === "retired") return { service_id: p.target, task, status: "retired", changed: false };
      throw new Error("engine_not_registered");
    }
    throw err;
  }
  return { service_id: p.target, task, status: "retired", changed: true };
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
         AND host_worker = ?
         AND EXISTS (SELECT 1 FROM service_registry WHERE service_id = agents.host_worker AND status IN ('registered', 'healthy', 'degraded'))
         AND NOT EXISTS (SELECT 1 FROM agents o WHERE o.host_worker = agents.host_worker AND o.voter = 1 AND o.agent_id <> agents.agent_id)`,
    ).bind(actor, nowIso(), p.target, declared.service));
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
    case "update_agent_capabilities":
      return updateAgentCapabilities(env, proposalId, p, actor);
    case "retire_engine":
      return retireEngine(env, proposalId, p, actor);
    case "admit_voter":
      return admitVoter(env, proposalId, p, actor, canVote);
    default:
      throw new Error("no_executor");
  }
}

/**
 * The proposal (action, target, params) that turns one census finding into a registration, or null. An
 * undeclared_engine becomes retire_engine only when `persistent` says it persisted (undeclaredEnginePersistent);
 * without it, as for every other kind the census only reports, the answer is null.
 */
export function proposalFor(
  census: CensusRow, finding: { kind: string; subject: string }, persistent?: (subject: string) => boolean,
): { action: string; target: string; params: JsonObject } | null {
  if (finding.kind === "unregistered_agent") {
    const d = findAgentGene(census, finding.subject);
    if (!d?.gene.capabilities) return null;
    const action = privilegedCapabilities(d.gene.capabilities).length ? "register_privileged_agent" : "register_agent";
    return { action, target: d.gene.id, params: { service: d.service, capabilities: d.gene.capabilities, tier_max: d.gene.tier_max ?? 0, main_sha: census.main_sha } };
  }
  // A capability change that stays routine (no privileged capability); a privileged one waits for the owner as a finding.
  if (finding.kind === "agent_capabilities_changed") {
    const d = findAgentGene(census, finding.subject);
    if (!d?.gene.capabilities || privilegedCapabilities(d.gene.capabilities).length) return null;
    return { action: "update_agent_capabilities", target: d.gene.id, params: { service: d.service, capabilities: d.gene.capabilities, tier_max: d.gene.tier_max ?? 0, main_sha: census.main_sha } };
  }
  if (finding.kind === "unregistered_engine") {
    const i = finding.subject.lastIndexOf(":");
    if (i <= 0) return null;
    return { action: "register_engine", target: finding.subject.slice(0, i), params: { task: finding.subject.slice(i + 1), main_sha: census.main_sha } };
  }
  if (finding.kind === "undeclared_engine") {
    const e = undeclaredEngineProven(census, finding.subject);
    if (!e || !persistent?.(finding.subject)) return null;
    return { action: "retire_engine", target: e.service, params: { task: e.task, main_sha: census.main_sha } };
  }
  if (finding.kind === "voter_seat_requested") return { action: "admit_voter", target: finding.subject, params: { main_sha: census.main_sha } };
  return null;
}
