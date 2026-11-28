// desired_version option B (the coordinator, 2026-11-28; option A's observation as the second source): an external
// organ's desired version is recorded only when two independent sources agree. Its DNA declares the commit its own
// deploy shipped (`deploy_commit`, read by the Forge census), and its health answer reports the running tag
// (`version.tag`, read by the Drift Detector into service_registry.observed_version). When both name the same commit
// (equal on the shorter, at least 7 hex) and the registry's desired_version differs, the Supervisor proposes the
// existing routine set_desired_version with the observed tag, at most one per organ per 6 hours and one per cycle.
// Pure: no I/O. Platform Workers never come here (their desired versions follow their deploys).
import { EXTERNAL_ORIGINS } from "./organism.ts";

export const DESIRED_VERSION_COOLDOWN_MS = 6 * 3_600_000;
const HEX = /^[0-9a-f]{7,40}$/;
export const EXTERNAL_SERVICE_IDS: ReadonlySet<string> = new Set(EXTERNAL_ORIGINS.flatMap((o) => o.services));
const EXTERNAL_SERVICES = EXTERNAL_SERVICE_IDS;

/** Two commit names agree when both are 7 to 40 hex and the longer starts with the shorter. */
export function sameCommit(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string" || !HEX.test(a) || !HEX.test(b)) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  return l.startsWith(s);
}

export interface CensusOrgan { service?: unknown; origin?: unknown; deploy_commit?: unknown }
export interface RegistryState { service_id: string; status: string; desired_version: string | null; observed_version: string | null }
export interface DesiredVersionProposal { service: string; version: string; deploy_commit: string }

/** The next set_desired_version to propose, or null. `recent`: the organs proposed for within the cooldown. */
export function nextDesiredVersion(genome: CensusOrgan[], registry: RegistryState[], recent: ReadonlySet<string>): DesiredVersionProposal | null {
  const reg = new Map(registry.map((r) => [r.service_id, r]));
  for (const o of genome) {
    if (typeof o.service !== "string" || !EXTERNAL_SERVICES.has(o.service) || typeof o.origin !== "string") continue;
    if (typeof o.deploy_commit !== "string" || !HEX.test(o.deploy_commit) || recent.has(o.service)) continue;
    const r = reg.get(o.service);
    if (!r || r.status === "disabled" || r.status === "retired" || !r.observed_version) continue;
    if (!sameCommit(o.deploy_commit, r.observed_version) || r.desired_version === r.observed_version) continue;
    return { service: o.service, version: r.observed_version, deploy_commit: o.deploy_commit };
  }
  return null;
}
