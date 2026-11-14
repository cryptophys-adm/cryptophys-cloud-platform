/**
 * When an agent counts as idle, for the Supervisor's retire_agent proposals (owner 2026-11-11: "dismantle dan delete
 * agent yang sudah tidak berkontribusi"), and how a scheduled agent is judged (owner 2026-11-14: "jangan pensiun
 * aether calibrator karena cara kerjanya memang idle sampai jadwalnya kerja").
 *
 *  - An agent without a schedule in its DNA: idle after RETIRE_IDLE_DAYS (14) without an action or a report.
 *  - An agent whose DNA declares a schedule (organism.ts AgentGene.schedule, e.g. { "cron": "52 2 * * *" }): idle only
 *    after SCHEDULE_IDLE_RUNS (3) of its expected runs passed without an action or a report, and never sooner than
 *    the fixed window. A schedule can only lengthen the window: it says the agent is quiet between runs by design,
 *    never that it should be retired sooner. A weekly agent is idle after 21 days, a monthly one after 93; a daily or
 *    hourly one keeps the 14 days (three silent runs are not reason enough to dismantle it).
 *
 * Activity is what the kernel records: an agent_actions row (a tier 1+ syscall, allowed or denied) or an agent_reports
 * row. A tier 0 read (knowledge.status, doctrine.status, signals.observe) is not recorded, so a run that only reads
 * leaves no trace.
 */
import { RETIRE_IDLE_DAYS } from "./consensus-rules.ts";
import { schedulePeriodMs } from "./organism.ts";

const DAY_MS = 86_400_000;
/** A scheduled agent is idle only after this many of its expected runs without activity. */
export const SCHEDULE_IDLE_RUNS = 3;
/** The reason a retire_agent proposal of a scheduled agent that is not idle by its schedule is closed with. */
export const SCHEDULED_IDLE_REASON = "scheduled agent, idle by design until its run (owner 2026-11-14)";

/** The window without activity after which an agent is idle: the fixed one, or SCHEDULE_IDLE_RUNS runs if longer. */
export function idleWindowMs(schedule?: { cron?: unknown } | null): number {
  const fixed = RETIRE_IDLE_DAYS * DAY_MS;
  const period = schedule ? schedulePeriodMs(schedule.cron) : null;
  return period === null ? fixed : Math.max(fixed, SCHEDULE_IDLE_RUNS * period);
}

/**
 * Whether an agent is idle now: registered before the window opened and no activity inside it. `lastActivityMs` is
 * its latest action or report (null: none ever).
 */
export function isIdle(a: { createdAtMs: number; lastActivityMs: number | null; schedule?: { cron?: unknown } | null }, nowMs: number): boolean {
  const since = nowMs - idleWindowMs(a.schedule);
  return a.createdAtMs < since && (a.lastActivityMs === null || a.lastActivityMs < since);
}
