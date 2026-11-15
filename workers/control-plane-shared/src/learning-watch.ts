/**
 * Learning observed, never blocked (owner 2026-11-14, after the learning mandate in power-mode.ts).
 *
 * Once an hour, in the account-wide Observer's run (cryptophys-platform-api, cron :27; no new cron), the last complete
 * UTC hour of learning calls is read from agent_actions (memory.remember and knowledge.propose, any outcome) and
 * compared per agent with that agent's 7-day hourly baseline. Two findings, in the Observer's metric form
 * (observer_findings: worker = "agent:<id>", value, baseline_7d, sample), both kind "anomaly", severity "info" and
 * report_only (never a rollback):
 *  - learning_volume: the hour's count >= LEARNING_SPIKE_RATIO x max(baseline, LEARNING_BASELINE_FLOOR). The floor
 *    of 1 call an hour means a quiet or new agent needs at least 10 calls in an hour to count as a spike;
 *  - learning_repeat: the same subject at least LEARNING_REPEAT_MIN times in the hour (memory.remember: the same
 *    memory id returned, that is an exact duplicate that dedup answered; knowledge.propose: the same item_id).
 * The Observer's hourly advisory report carries them to the owner, and the Supervisor reads them as advisory cycle
 * findings (ai-kernel/src/observer-watch.ts). Nothing is throttled, denied or changed: these are readings only.
 */
import type { D1Database } from "./types.ts";
import type { Finding } from "./observer.ts";
import { LEARNING_CAPABILITIES } from "./power-mode.ts";

export const LEARNING_SPIKE_RATIO = 10;
export const LEARNING_BASELINE_FLOOR = 1;
export const LEARNING_REPEAT_MIN = 2;
export const LEARNING_BASELINE_DAYS = 7;
const HOUR_MS = 3_600_000;

const slots = (offset: number) => LEARNING_CAPABILITIES.map((_, i) => `?${i + offset}`).join(", ");

export interface LearningHour {
  hour: string;
  by_agent: Array<{ agent_id: string; count: number; by_capability: Record<string, number>; baseline_hourly: number }>;
  repeats: Array<{ agent_id: string; capability: string; subject: string; count: number }>;
}

/** The learning calls of the hour starting at `hourStartMs`, per agent, with each agent's 7-day hourly baseline. */
export async function learningHour(db: D1Database, hourStartMs: number): Promise<LearningHour> {
  const from = new Date(hourStartMs).toISOString();
  const to = new Date(hourStartMs + HOUR_MS).toISOString();
  const baseFrom = new Date(hourStartMs - LEARNING_BASELINE_DAYS * 24 * HOUR_MS).toISOString();
  const counts = (await db.prepare(
    `SELECT agent_id, capability, SUM(CASE WHEN created_at >= ?1 THEN 1 ELSE 0 END) AS hour_n,
            SUM(CASE WHEN created_at < ?1 THEN 1 ELSE 0 END) AS base_n
     FROM agent_actions WHERE created_at >= ?2 AND created_at < ?3 AND capability IN (${slots(4)})
     GROUP BY agent_id, capability`,
  ).bind(from, baseFrom, to, ...LEARNING_CAPABILITIES).all<{ agent_id: string; capability: string; hour_n: number; base_n: number }>()).results ?? [];
  const agents = new Map<string, LearningHour["by_agent"][number] & { base: number }>();
  for (const r of counts) {
    const a = agents.get(r.agent_id) ?? { agent_id: r.agent_id, count: 0, by_capability: {}, baseline_hourly: 0, base: 0 };
    a.count += Number(r.hour_n) || 0;
    a.by_capability[r.capability] = (a.by_capability[r.capability] ?? 0) + (Number(r.hour_n) || 0);
    a.base += Number(r.base_n) || 0;
    agents.set(r.agent_id, a);
  }
  const repeats = (await db.prepare(
    `SELECT agent_id, capability, subject, COUNT(*) AS n FROM (
       SELECT agent_id, capability,
              CASE capability WHEN 'memory.remember' THEN json_extract(result_json, '$.memory.memory_id')
                              ELSE json_extract(input_json, '$.item.item_id') END AS subject
       FROM agent_actions WHERE created_at >= ?1 AND created_at < ?2 AND capability IN (${slots(3)}))
     WHERE subject IS NOT NULL GROUP BY agent_id, capability, subject HAVING COUNT(*) >= ${LEARNING_REPEAT_MIN}
     ORDER BY n DESC, agent_id, subject LIMIT 50`,
  ).bind(from, to, ...LEARNING_CAPABILITIES).all<{ agent_id: string; capability: string; subject: string; n: number }>()).results ?? [];
  const hours = LEARNING_BASELINE_DAYS * 24;
  return {
    hour: from,
    by_agent: [...agents.values()].map(({ base, ...a }) => ({ ...a, baseline_hourly: Math.round((base / hours) * 1000) / 1000 }))
      .sort((x, y) => y.count - x.count || x.agent_id.localeCompare(y.agent_id)),
    repeats: repeats.map((r) => ({ agent_id: r.agent_id, capability: r.capability, subject: String(r.subject).slice(0, 80), count: Number(r.n) })),
  };
}

/** Pure: the findings of one hour (empty when nothing stands out). Never a denial or a throttle. */
export function learningFindings(h: LearningHour): Finding[] {
  const out: Finding[] = [];
  for (const a of h.by_agent) {
    const threshold = LEARNING_SPIKE_RATIO * Math.max(a.baseline_hourly, LEARNING_BASELINE_FLOOR);
    if (a.count >= threshold) {
      const ratio = a.baseline_hourly > 0 ? Math.round((a.count / a.baseline_hourly) * 10) / 10 : null;
      out.push({
        worker: `agent:${a.agent_id}`, metric: "learning_volume", kind: "anomaly", severity: "info", bucket: h.hour,
        value: a.count, baseline_7d: a.baseline_hourly, z: null, since_deploy: null, report_only: true,
        sample: { by_capability: a.by_capability, ratio_to_baseline: ratio, threshold, action: "observed only; learning is never throttled" },
        detail: `Agent ${a.agent_id} made ${a.count} learning calls in the hour (7-day baseline ${a.baseline_hourly} an hour${ratio === null ? "" : `, ${ratio}x`}). Observed only; nothing is throttled.`,
      });
    }
  }
  const byAgent = new Map<string, LearningHour["repeats"]>();
  for (const r of h.repeats) (byAgent.get(r.agent_id) ?? byAgent.set(r.agent_id, []).get(r.agent_id)!).push(r);
  for (const [agentId, rs] of byAgent) {
    const total = rs.reduce((n, r) => n + r.count, 0);
    out.push({
      worker: `agent:${agentId}`, metric: "learning_repeat", kind: "anomaly", severity: "info", bucket: h.hour,
      value: total, baseline_7d: null, z: null, since_deploy: null, report_only: true,
      sample: { repeated: rs.slice(0, 10), min_repeats: LEARNING_REPEAT_MIN, action: "observed only; exact duplicates are deduplicated, nothing is refused" },
      detail: `Agent ${agentId} repeated ${rs.length} learning subject(s) in the hour (${rs.slice(0, 3).map((r) => `${r.capability === "memory.remember" ? "memory" : "knowledge"} ${r.subject} x${r.count}`).join(", ")}). Observed only.`,
    });
  }
  return out;
}

/** The last complete UTC hour before `now`, in ms. */
export const lastCompleteHourMs = (now: number) => Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS;

/**
 * Learning AI use today (ai_usage.learning_requests, migration 0067) and the learning calls of the last 60 minutes per
 * agent, for GET /v1/metabolism. Cost is not measured: Workers AI reports neurons per account and model, not per
 * call, and the embedding model also serves recall, so no learning cost is computed (the Console shows "not measured").
 */
export async function learningUsage(db: D1Database, now: number): Promise<{
  ai_requests_today: number | null; ai_requests_today_all: number | null;
  last_hour: Array<{ agent_id: string; capability: string; count: number }> | null;
}> {
  const day = new Date(now).toISOString().slice(0, 10);
  let learning: number | null = null, all: number | null = null;
  try {
    const r = await db.prepare("SELECT COALESCE(SUM(learning_requests), 0) AS l, COALESCE(SUM(requests), 0) AS a FROM ai_usage WHERE day = ?").bind(day).first<{ l: number; a: number }>();
    learning = Number(r?.l ?? 0); all = Number(r?.a ?? 0);
  } catch { /* before migration 0067: not measured */ }
  let lastHour: Array<{ agent_id: string; capability: string; count: number }> | null = null;
  try {
    lastHour = ((await db.prepare(
      `SELECT agent_id, capability, COUNT(*) AS count FROM agent_actions WHERE created_at >= ?1 AND capability IN (${slots(2)})
       GROUP BY agent_id, capability ORDER BY count DESC, agent_id`,
    ).bind(new Date(now - HOUR_MS).toISOString(), ...LEARNING_CAPABILITIES).all<{ agent_id: string; capability: string; count: number }>()).results ?? [])
      .map((r) => ({ agent_id: r.agent_id, capability: r.capability, count: Number(r.count) }));
  } catch { lastHour = null; }
  return { ai_requests_today: learning, ai_requests_today_all: all, last_hour: lastHour };
}
