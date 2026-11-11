/**
 * Live view of the AI mesh for the Console (owner 2026-11-11: "halaman AI Mesh masih statis belum
 * autonomous dan dinamis"). Every value is read from what the agents actually did: the syscall log
 * (agent_actions), the council votes, the agent reports, the Forge census (ADR-0013 self-awareness)
 * and the self-registration proposals (ADR-0013 phase 3). Read-only; every table is optional, so the
 * view still answers on a database without one of them.
 */
import type { JsonObject } from "../../control-plane-shared/src/http.ts";
import type { KernelHttpEnv } from "./kernel.ts";

const REGISTRATION_ACTIONS = ["register_agent", "register_engine", "register_privileged_agent", "admit_voter"];

async function rows<T>(run: () => Promise<{ results: T[] }>): Promise<T[]> {
  try { return (await run()).results ?? []; } catch { return []; }
}

interface Liveness { actions_24h: number; last_action_at: string | null; last_capability: string | null; last_outcome: string | null; votes_24h: number; last_vote_at: string | null; reports_24h: number; last_report_at: string | null }

export async function meshView(env: KernelHttpEnv, now = Date.now()): Promise<JsonObject> {
  const since = new Date(now - 24 * 3_600_000).toISOString();
  const agents = await rows(() => env.DB.prepare(
    "SELECT agent_id, display_name, host_worker, tier_max, status, voter FROM agents ORDER BY agent_id",
  ).all<{ agent_id: string; display_name: string; host_worker: string; tier_max: number; status: string; voter: number }>());

  const actions = await rows(() => env.DB.prepare(
    `SELECT agent_id, capability, tier, outcome, created_at FROM agent_actions
     WHERE created_at >= ? ORDER BY created_at DESC LIMIT 500`,
  ).bind(since).all<{ agent_id: string; capability: string; tier: number; outcome: string; created_at: string }>());
  const votes = await rows(() => env.DB.prepare(
    "SELECT voter_agent_id AS agent_id, COUNT(*) AS n, MAX(created_at) AS last_at FROM consensus_votes WHERE created_at >= ? GROUP BY voter_agent_id",
  ).bind(since).all<{ agent_id: string; n: number; last_at: string }>());
  const reports = await rows(() => env.DB.prepare(
    "SELECT agent_id, COUNT(*) AS n, MAX(created_at) AS last_at FROM agent_reports WHERE created_at >= ? GROUP BY agent_id",
  ).bind(since).all<{ agent_id: string; n: number; last_at: string }>());

  const live = new Map<string, Liveness>();
  const get = (id: string) => {
    let l = live.get(id);
    if (!l) { l = { actions_24h: 0, last_action_at: null, last_capability: null, last_outcome: null, votes_24h: 0, last_vote_at: null, reports_24h: 0, last_report_at: null }; live.set(id, l); }
    return l;
  };
  for (const a of actions) {
    const l = get(a.agent_id);
    l.actions_24h += 1;
    if (!l.last_action_at) { l.last_action_at = a.created_at; l.last_capability = a.capability; l.last_outcome = a.outcome; }
  }
  for (const v of votes) { const l = get(v.agent_id); l.votes_24h = Number(v.n) || 0; l.last_vote_at = v.last_at; }
  for (const r of reports) { const l = get(r.agent_id); l.reports_24h = Number(r.n) || 0; l.last_report_at = r.last_at; }

  const lastSeen = (l: Liveness) => [l.last_action_at, l.last_vote_at, l.last_report_at].filter(Boolean).sort().pop() ?? null;
  const mesh = agents.map((a) => {
    const l = live.get(a.agent_id) ?? get(a.agent_id);
    const seen = lastSeen(l);
    const age = seen ? now - Date.parse(seen) : Infinity;
    return {
      ...a,
      voter: Boolean(a.voter),
      ...l,
      last_seen_at: seen,
      liveness: a.status !== "enabled" ? "suspended" : age <= 3_600_000 ? "active" : age <= 24 * 3_600_000 ? "recent" : "idle",
    };
  });

  const census = await rows(() => env.DB.prepare(
    "SELECT main_sha, status, organs, agents, engines, voters, findings, taken_at FROM forge_organism_census ORDER BY taken_at DESC LIMIT 20",
  ).all<{ main_sha: string; status: string; organs: number; agents: number; engines: number; voters: number; findings: string; taken_at: string }>());
  const registrations = await rows(() => env.DB.prepare(
    `SELECT proposal_id, action, target, class, status, approvals, rejections, eligible, created_at, decided_at, outcome_json
     FROM consensus_proposals WHERE action IN (${REGISTRATION_ACTIONS.map(() => "?").join(", ")})
     ORDER BY created_at DESC LIMIT 30`,
  ).bind(...REGISTRATION_ACTIONS).all<JsonObject>());
  const engines = await rows(() => env.DB.prepare(
    "SELECT service_id, task, status, registered_by, updated_at FROM engines ORDER BY service_id, task",
  ).all<JsonObject>());

  const parse = (s: string): unknown[] => { try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; } };
  return {
    observed_at: new Date(now).toISOString(),
    window: { from: since, hours: 24 },
    agents: mesh,
    activity: actions.slice(0, 60),
    activity_24h: actions,
    census: census.map((c) => ({ ...c, findings: parse(c.findings) })),
    registrations: registrations.map((r) => {
      let outcome: unknown = null;
      try { outcome = r.outcome_json ? JSON.parse(String(r.outcome_json)) : null; } catch { outcome = null; }
      return { ...r, outcome_json: undefined, outcome };
    }),
    engines,
    protocol: [
      "Self-awareness: every Worker declares itself in organism.json (DNA); the Forge takes a census of DNA versus the live registries on each main commit.",
      "Self-registration: a census finding (an undeclared or unregistered agent, engine or seat) makes the Supervisor propose its registration; the council votes; routine registrations run on consensus alone, privileged agents and new seats need the owner's click.",
      "No finding means every declared organ, agent, engine and seat is already registered: there is nothing to register until the DNA changes.",
    ],
  };
}
