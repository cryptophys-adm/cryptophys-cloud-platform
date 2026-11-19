/**
 * The Console's Infrastructure page ("Services & Drift", owner 2026-11-15): how a service's drift state and the
 * time of its last probe are read from GET /v1/drift. Pure functions, shared by the page and its tests.
 *
 * Last probe. Since migration 0061 the Drift Detector records a drift_observations row only when a service's state
 * changes, so a row's observed_at is when that state was first seen, not when the service was last looked at: a
 * service in sync for a day shows a day-old observed_at although it was probed 96 times since. What every run sets
 * for every observed service is service_registry.updated_at, the heartbeat (drift-state.ts), which GET /v1/drift
 * returns as last_seen_at. The last probe is that column and nothing else: a service the Drift Detector has never
 * recorded (no drift row, so no last_seen_at) has no probe time, which is "not measured", never 0 minutes and never
 * the registry row's own age. A registry write (a deploy recording its desired version) sets the same column, so
 * right after a deploy the value can read newer than the probe itself, until the next run (at most 15 minutes).
 *
 * Untagged version. A dashboard secret or variable change creates a new Worker version without a version tag, so
 * the probe cannot read the running version and the drift reason is observed_version_unavailable until the next
 * tagged deploy (ai-kernel/src/supervisor.ts onlyUntaggedVersion: not a recovery case). When that is the only
 * reason, the page says "untagged version (dashboard change)" instead of a plain "drifted".
 */

export const UNTAGGED_REASON = "observed_version_unavailable";
export const UNTAGGED_LABEL = "untagged version (dashboard change)";
export const NOT_MEASURED = "not measured";

/** The fields of one GET /v1/drift row this module reads. */
export interface DriftRowLike {
  service_id?: string;
  drifted?: boolean | null;
  observed_at?: string | null;
  last_seen_at?: string | null;
  evidence?: { reasons?: unknown } | null;
}

const validIso = (v: unknown): v is string => typeof v === "string" && v.length > 0 && Number.isFinite(Date.parse(v));

/** The reasons of a service's latest recorded state (evidence.reasons), as strings. */
export function driftReasons(d: DriftRowLike | null | undefined): string[] {
  const r = d?.evidence?.reasons;
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string") : [];
}

/** When the Drift Detector last probed the service: last_seen_at (service_registry.updated_at), or null. */
export function lastProbeAt(d: DriftRowLike | null | undefined): string | null {
  return validIso(d?.last_seen_at) ? d!.last_seen_at! : null;
}

/** Whole minutes from an ISO time to now, or null when the time is missing or unreadable. A future time is 0. */
export function minutesSince(iso: string | null | undefined, now: number): number | null {
  if (!validIso(iso) || !Number.isFinite(now)) return null;
  return Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
}

export interface ProbeAges {
  /** Services with a probe time, oldest probe first. */
  measured: Array<{ service_id: string; minutes: number; at: string }>;
  /** Services without one (never recorded by the Drift Detector). */
  unmeasured: string[];
}

/** Minutes since the last probe of each service, split into measured and not measured; never a 0 for a gap. */
export function probeAges(serviceIds: readonly string[], byId: ReadonlyMap<string, DriftRowLike>, now: number): ProbeAges {
  const measured: ProbeAges["measured"] = [];
  const unmeasured: string[] = [];
  for (const id of serviceIds) {
    const at = lastProbeAt(byId.get(id));
    const minutes = minutesSince(at, now);
    if (at === null || minutes === null) unmeasured.push(id);
    else measured.push({ service_id: id, minutes, at });
  }
  measured.sort((a, b) => b.minutes - a.minutes || a.service_id.localeCompare(b.service_id));
  return { measured, unmeasured };
}

export type DriftKind = "not_observed" | "disabled" | "in_sync" | "untagged" | "drifted";
export type DriftTone = "slate" | "green" | "amber" | "red";

/** True when the only reason is the missing version tag (a dashboard change since the last deploy). */
export function onlyUntagged(reasons: readonly string[]): boolean {
  return reasons.length === 1 && reasons[0] === UNTAGGED_REASON;
}

/**
 * The drift state the page shows for a service. `registryStatus` is the registry row's status: a disabled service
 * reads "disabled" whatever its last row says. A drifted service whose only reason is observed_version_unavailable
 * reads as an untagged version; one with any other reason as well is "drifted".
 */
export function driftState(d: DriftRowLike | null | undefined, registryStatus?: string | null): { kind: DriftKind; label: string; tone: DriftTone } {
  if (registryStatus === "disabled") return { kind: "disabled", label: "disabled", tone: "slate" };
  if (!d || typeof d.drifted !== "boolean") return { kind: "not_observed", label: "not observed", tone: "slate" };
  if (!d.drifted) return { kind: "in_sync", label: "in sync", tone: "green" };
  if (onlyUntagged(driftReasons(d))) return { kind: "untagged", label: UNTAGGED_LABEL, tone: "amber" };
  return { kind: "drifted", label: "drifted", tone: "red" };
}
