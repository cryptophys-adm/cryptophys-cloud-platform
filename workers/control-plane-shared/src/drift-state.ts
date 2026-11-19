/**
 * Reading drift_observations after the change-only rule (owner decision 1 of the resource audit, 2026-11-14,
 * migration 0061).
 *
 * The Drift Detector records a row for a service only when its observed state changes: the signature is
 * (drifted, desired_hash, observed_hash, sorted reasons). A later run that sees the same state raises the row's
 * streak from 1 to 2 (once) and otherwise writes nothing to drift_observations. Every run still sets
 * service_registry.updated_at for every service, so that column is the heartbeat ("last seen"), and a row's
 * observed_at is the time its state was first seen.
 *
 * Persistent drift ("two runs in a row drifted") is, for the newest row L and the row before it P:
 *
 *     L.drifted = 1 AND (L.streak >= 2 OR P.drifted = 1)
 *
 * L.streak >= 2: two runs saw L's drifted state. P.drifted = 1: rows are recorded on every change, so P's state held
 * at the run just before the one that recorded L, and that run drifted too (with other reasons or versions). The
 * second clause is also what keeps the per-run history written before migration 0061 (every row streak 1) reading
 * as it did: the last two rows both drifted.
 */

export interface DriftHistoryRow {
  drifted: number;
  /** Absent only for rows read without the column; treated as 1. */
  streak?: number | null;
  observed_at: string;
}

/** The two newest observations of one service, newest first (bind the service_id). */
export const LAST_TWO_OBSERVATIONS_SQL =
  "SELECT drifted, streak, evidence_json, observed_at FROM drift_observations WHERE service_id = ? ORDER BY observed_at DESC, rowid DESC LIMIT 2";

/** Persistent drift from a service's two newest rows, newest first (see the module comment). */
export function isPersistentDrift(rows: readonly DriftHistoryRow[]): boolean {
  const [latest, previous] = rows;
  if (!latest || latest.drifted !== 1) return false;
  return (latest.streak ?? 1) >= 2 || previous?.drifted === 1;
}

/**
 * When a persistent drift began, as far as the two newest rows tell: the older row's observed_at when it drifted
 * too (the drift has lasted at least since then), else the newest row's (its drifted state was first seen then and
 * a later run confirmed it). Null when the drift is not persistent.
 */
export function persistentDriftSince(rows: readonly DriftHistoryRow[]): string | null {
  if (!isPersistentDrift(rows)) return null;
  return rows[1]?.drifted === 1 ? rows[1].observed_at : rows[0].observed_at;
}

/** The state signature the Drift Detector compares: reasons are sorted, so their order never counts as a change. */
export function driftSignature(drifted: boolean | number, desiredHash: string, observedHash: string, reasons: readonly string[]): string {
  return JSON.stringify([drifted ? 1 : 0, desiredHash, observedHash, [...reasons].sort()]);
}
