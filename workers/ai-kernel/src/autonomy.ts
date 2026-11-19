// HAIC H4 (ADR-0017 H4 §5; the owner's answers of 2026-11-18): the autonomy dial on the AI Kernel.
//
//   autonomyView     GET /v1/autonomy: each group's level, ceiling, actions, 14-day evidence and whether it is ready to
//                    be raised; and the passed proposals the dial held at suggest (what the agents would have done).
//   setAutonomyLevel POST /v1/autonomy/{group}: only the owner; any level up to the group's ceiling (its ADR-0009
//                    class), with the phrase "SET <GROUP> <LEVEL>"; audited.
//   autoDowngrade    hourly: a regression attributed to a group (a rollback after a deploy, three failed executions in
//                    a row) lowers it one level at once; the owner is told on the Owner page; only the owner raises it.
//   autonomyNotices  the inbox items: a group a regression lowered, and a group whose evidence is ready to be raised.
// Enforcement is in consensus.ts (propose, ownerDecide), consensus-exec.ts and the Policy Engine; this module only reads
// and writes the dial.
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { CONSENSUS_ACTIONS } from "../../control-plane-shared/src/consensus-rules.ts";
import { TRADING_CAPABILITY } from "../../control-plane-shared/src/capabilities.ts";
import {
  AUTONOMY_GROUPS, GROUP_ACTIONS, GROUP_LABEL, LEVEL_LABEL, LEVEL_RANK, RAISE_RULE, actionCeiling, effectiveLevel, groupCeiling, groupStats,
  isAutonomyGroup, isAutonomyLevel, oneLevelDown, raiseReady, regressions, setLevelProblem, setPhrase,
  type AutonomyGroup, type AutonomyLevel, type ExecutionRow, type Regression,
} from "../../control-plane-shared/src/autonomy-dial.ts";
import type { D1Database } from "../../control-plane-shared/src/types.ts";

export const DIAL_ACTOR = "system:autonomy-dial";
/** A regression lowers its group only if it happened in the last 3 h (the hourly pass, with slack) and after the level was set. */
export const DOWNGRADE_LOOKBACK_MS = 3 * 3_600_000;

export class AutonomyError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

interface DialRow { group_id: string; level: string; source: string; set_by: string; set_at: string; reason: string | null }

async function dialRows(db: D1Database): Promise<Map<AutonomyGroup, DialRow> | null> {
  try {
    const rows = (await db.prepare("SELECT group_id, level, source, set_by, set_at, reason FROM autonomy_dial").all<DialRow>()).results ?? [];
    return new Map(rows.filter((r) => isAutonomyGroup(r.group_id) && isAutonomyLevel(r.level)).map((r) => [r.group_id as AutonomyGroup, r]));
  } catch {
    return null; // migration 0083 not applied yet
  }
}

async function executionRows(db: D1Database, now: number): Promise<ExecutionRow[]> {
  const since = new Date(now - RAISE_RULE.window_days * 86_400_000).toISOString();
  return ((await db.prepare(
    "SELECT proposal_id, action, target, status, COALESCE(decided_at, created_at) AS decided_at FROM consensus_proposals WHERE status IN ('executed', 'failed') AND COALESCE(decided_at, created_at) >= ? ORDER BY COALESCE(decided_at, created_at) LIMIT 5000",
  ).bind(since).all<ExecutionRow>()).results ?? []);
}

const levelOf = (rows: Map<AutonomyGroup, DialRow> | null, g: AutonomyGroup): AutonomyLevel => {
  const r = rows?.get(g);
  return r && isAutonomyLevel(r.level) ? r.level : groupCeiling(g);
};

export async function autonomyView(db: D1Database, now = Date.now()) {
  const rows = await dialRows(db);
  const execs = await executionRows(db, now);
  const regs = regressions(execs, now);
  const groups = AUTONOMY_GROUPS.map((g) => {
    const level = levelOf(rows, g);
    const r = rows?.get(g) ?? null;
    const stats = groupStats(g, execs, now);
    const actions = g === "trading"
      ? Object.keys(CONSENSUS_ACTIONS).filter((a) => TRADING_CAPABILITY.test(a))
      : [...GROUP_ACTIONS[g]];
    return {
      group: g, label: GROUP_LABEL[g], level, level_label: LEVEL_LABEL[level], ceiling: groupCeiling(g),
      source: r?.source ?? "adr", set_by: r?.set_by ?? null, set_at: r?.set_at ?? null, reason: r?.reason ?? null,
      actions: actions.map((a) => ({ action: a, class: CONSENSUS_ACTIONS[a]?.class ?? null, ceiling: actionCeiling(a), effective: effectiveLevel(a, level) })),
      stats, raise_to: raiseReady(g, level, stats),
      regressions: regs.filter((x) => x.group === g).slice(-5),
    };
  });
  let held: unknown[] = [];
  try {
    held = (await db.prepare(
      "SELECT proposal_id, action, target, autonomy_level, created_at FROM consensus_proposals WHERE autonomy_level IN ('observe', 'suggest') AND status = 'shadow_passed' AND created_at >= ? ORDER BY created_at DESC LIMIT 20",
    ).bind(new Date(now - 7 * 86_400_000).toISOString()).all()).results ?? [];
  } catch { held = []; }
  return {
    available: rows !== null, levels: AUTONOMY_LEVELS_VIEW, raise_rule: RAISE_RULE, groups,
    // What the agents would have done in a group at observe or suggest: passed proposals the dial held (7 days).
    held,
  };
}
const AUTONOMY_LEVELS_VIEW = (Object.keys(LEVEL_RANK) as AutonomyLevel[]).map((l) => ({ level: l, label: LEVEL_LABEL[l] }));

/** The owner sets a group's level (the route checks the owner); returns the new view of that group. */
export async function setAutonomyLevel(db: D1Database, actor: string, groupRaw: unknown, levelRaw: unknown, confirmationRaw: unknown, reasonRaw: unknown, now = Date.now()) {
  const problem = setLevelProblem(groupRaw, levelRaw);
  if (problem) throw new AutonomyError(400, "invalid_level", problem);
  const group = groupRaw as AutonomyGroup;
  const level = levelRaw as AutonomyLevel;
  const phrase = setPhrase(group, level);
  if (confirmationRaw !== phrase) throw new AutonomyError(400, "confirmation_required", `type "${phrase}" to set the level`);
  const reason = typeof reasonRaw === "string" && reasonRaw.trim() ? reasonRaw.trim().slice(0, 500) : null;
  const rows = await dialRows(db);
  if (rows === null) throw new AutonomyError(503, "not_available", "the autonomy dial is not migrated yet (0083)");
  const previous = levelOf(rows, group);
  const at = new Date(now).toISOString();
  await db.prepare(
    `INSERT INTO autonomy_dial (group_id, level, source, set_by, set_at, reason) VALUES (?, ?, 'owner', ?, ?, ?)
     ON CONFLICT (group_id) DO UPDATE SET level = excluded.level, source = 'owner', set_by = excluded.set_by, set_at = excluded.set_at, reason = excluded.reason`,
  ).bind(group, level, actor, at, reason).run();
  await appendAuditEvent(db, {
    event_type: "autonomy.level_set", actor, subject: `autonomy:${group}`, outcome: level,
    payload: { group, previous, level, ceiling: groupCeiling(group), reason, direction: LEVEL_RANK[level] > LEVEL_RANK[previous] ? "raise" : LEVEL_RANK[level] < LEVEL_RANK[previous] ? "lower" : "same" },
  });
  return { group, previous, level, set_at: at };
}

/** Hourly: lower each group with a fresh regression one level. Returns what it lowered. */
export async function autoDowngrade(db: D1Database, now = Date.now()): Promise<{ group: AutonomyGroup; from: AutonomyLevel; to: AutonomyLevel; regression: Regression }[]> {
  const rows = await dialRows(db);
  if (rows === null) return [];
  const regs = regressions(await executionRows(db, now), now);
  const out: { group: AutonomyGroup; from: AutonomyLevel; to: AutonomyLevel; regression: Regression }[] = [];
  for (const g of AUTONOMY_GROUPS) {
    const setAt = Date.parse(rows.get(g)?.set_at ?? "");
    const fresh = regs.filter((x) => x.group === g && Date.parse(x.at) >= now - DOWNGRADE_LOOKBACK_MS && (!Number.isFinite(setAt) || Date.parse(x.at) > setAt)).pop();
    if (!fresh) continue;
    const from = levelOf(rows, g);
    const to = oneLevelDown(from);
    if (to === from) continue;
    const at = new Date(now).toISOString();
    await db.prepare(
      `INSERT INTO autonomy_dial (group_id, level, source, set_by, set_at, reason) VALUES (?, ?, 'auto_downgrade', ?, ?, ?)
       ON CONFLICT (group_id) DO UPDATE SET level = excluded.level, source = 'auto_downgrade', set_by = excluded.set_by, set_at = excluded.set_at, reason = excluded.reason`,
    ).bind(g, to, DIAL_ACTOR, at, fresh.detail.slice(0, 500)).run();
    await appendAuditEvent(db, { event_type: "autonomy.auto_downgraded", actor: DIAL_ACTOR, subject: `autonomy:${g}`, outcome: to, payload: { group: g, from, to, regression: fresh as never } });
    out.push({ group: g, from, to, regression: fresh });
  }
  return out;
}

export interface AutonomyNotice { group: AutonomyGroup; label: string; kind: "lowered" | "raise_ready"; level: AutonomyLevel; to: AutonomyLevel | null; detail: string; since: string }

/** The inbox items: a group a regression lowered (until the owner sets it again), and a group ready to be raised. */
export async function autonomyNotices(db: D1Database, now = Date.now()): Promise<AutonomyNotice[]> {
  const rows = await dialRows(db);
  if (rows === null) return [];
  let execs: ExecutionRow[] = [];
  try { execs = await executionRows(db, now); } catch { execs = []; }
  const out: AutonomyNotice[] = [];
  for (const g of AUTONOMY_GROUPS) {
    const r = rows.get(g);
    const level = levelOf(rows, g);
    if (r?.source === "auto_downgrade") {
      out.push({ group: g, label: GROUP_LABEL[g], kind: "lowered", level, to: null, detail: r.reason ?? "a regression", since: r.set_at });
      continue;
    }
    const to = raiseReady(g, level, groupStats(g, execs, now));
    if (to) {
      const s = groupStats(g, execs, now);
      out.push({ group: g, label: GROUP_LABEL[g], kind: "raise_ready", level, to, detail: `${s.succeeded}/${s.executions} executions succeeded in ${RAISE_RULE.window_days} days, no regression`, since: r?.set_at ?? new Date(now).toISOString() });
    }
  }
  return out;
}
