// Ported 2026-11-22 from the owner's VPS work (commit 6bb8306, branch vps/analytics-engine-2026-11-21), reviewed;
// owner: "Pindahkan folder analytic engine ke platform". ADR-0015 decision 6: telemetry only.
/**
 * Soft write-budget guard.
 *
 * Analytics Engine accepts at most 250 data points per Worker invocation, and the
 * Workers Free plan includes 100,000 points per day. This module enforces the
 * per-invocation ceiling and an isolate-level ceiling so a runaway loop cannot
 * burn the daily allowance in one request.
 *
 * IMPORTANT LIMITATION — read before relying on this:
 * Counters live in module scope, so they are per-isolate, not per-account. A
 * Worker with 40 warm isolates has 40 independent counters. This is a blast-radius
 * limiter, not an accounting system. The authoritative daily number comes from the
 * Analytics Engine dashboard or its GraphQL adaptive-groups
 * dataset. Alert on that, not on this.
 */

interface BudgetState {
  invocation: number;
  /** When the per-invocation counter was last reset (ms). */
  startedAt: number;
  isolate: number;
  dropped: number;
}

const state: BudgetState = { invocation: 0, startedAt: 0, isolate: 0, dropped: 0 };

/**
 * Platform port (2026-11-22): a Durable Object isolate lives across many invocations and no handler of it calls
 * startInvocation(), so without this the counter would reach the ceiling once and drop every later point. A counter
 * older than this is treated as a new invocation.
 */
export const INVOCATION_WINDOW_MS = 60_000;

/** Hard ceiling for a single isolate's lifetime. Deliberately generous. */
const ISOLATE_HARD_CAP = 50_000;

/**
 * Call at the top of every `fetch`, `queue`, `scheduled`, and `tail` handler so
 * the per-invocation counter reflects the current request.
 */
export function startInvocation(now: number = Date.now()): void {
  state.invocation = 0;
  state.startedAt = now;
}

export function tryConsumePoint(maxPerInvocation: number, now: number = Date.now()): boolean {
  if (now - state.startedAt > INVOCATION_WINDOW_MS) startInvocation(now);
  if (state.invocation >= maxPerInvocation || state.isolate >= ISOLATE_HARD_CAP) {
    state.dropped += 1;
    return false;
  }
  state.invocation += 1;
  state.isolate += 1;
  return true;
}

export function budgetSnapshot(): Readonly<BudgetState> {
  return { ...state };
}
