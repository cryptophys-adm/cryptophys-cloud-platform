// The redeploy for identities, the Orchestrator's side (owner 2026-11-16; control-plane-shared/src/identity-redeploy.ts
// has the design). Read only: which units' active Workers carry another identity value than the owner-saved row gives,
// and whether one unit may be redeployed at its running commit for revision N. The deploy itself is the native deploy
// (native-deploy.ts), queued by deployForConsensus and run by the executor like every other.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { DEPLOY_UNITS, type DeployUnit } from "../../control-plane-shared/src/deploy-units.ts";
import { isIdentityVar } from "../../control-plane-shared/src/identity-source.ts";
import {
  IDENTITY_REDEPLOY_RETRIES, identityClientHash, type IdentityDrift, type IdentityDriftUnit,
} from "../../control-plane-shared/src/identity-redeploy.ts";
import { DEPLOY_VARS, type DeployVarReference } from "./deploy-vars.ts";
import { manifestForTag, nativeDeployEligible, type BundleReader, type PlannedService, type VersionReader } from "./native-deploy.ts";

export interface IdentityRedeployDeps { DB: D1Database; BUNDLES?: BundleReader }

/** Whether a unit's Workers are deployed with identity lists at all (DEPLOY_VARS). */
export function carriesIdentities(unit: DeployUnit): boolean {
  return Object.values(DEPLOY_VARS[unit.unit] ?? {}).some((names) => names.some(isIdentityVar));
}

/**
 * The commit every Worker of the unit runs: one registry desired version for all of them, resolved to the one commit
 * whose Forge bundle it names. Mixed or unknown versions are refused: there is no single commit to redeploy.
 */
export async function runningCommit(deps: IdentityRedeployDeps, unit: DeployUnit): Promise<{ sha: string } | { reason: string }> {
  if (!deps.BUNDLES) return { reason: "not_configured" };
  const services = [...unit.services] as string[];
  const rows = (await deps.DB.prepare(`SELECT service_id, status, desired_version FROM service_registry WHERE service_id IN (${services.map(() => "?").join(", ")})`)
    .bind(...services).all<{ service_id: string; status: string; desired_version: string | null }>()).results ?? [];
  if (rows.length !== services.length || rows.some((r) => r.status === "disabled")) return { reason: "not_registered_or_disabled" };
  const tags = new Set(rows.map((r) => (r.desired_version ?? "").slice(0, 12)));
  if (tags.size !== 1) return { reason: "unit_runs_mixed_versions" };
  const tag = [...tags][0];
  if (!/^[0-9a-f]{12}$/.test(tag)) return { reason: "desired_version_unknown" };
  const manifest = await manifestForTag(deps.BUNDLES, tag);
  if (!manifest) return { reason: "running_bundle_missing" };
  return { sha: manifest.commit };
}

export type IdentityRedeployChoice =
  | { ok: true; services: PlannedService[]; changed: Record<string, string[]> }
  | { ok: false; reason: string; service?: string };

/**
 * The next attempt's number for one identity (unit, commit, revision, CI token), from the requests already queued for it
 * (their keys start with identityRedeployBase). Refused while an earlier attempt is queued or running
 * (`identity_redeploy_in_progress`) or after one succeeded (`identity_redeploy_done`), after a failure that did not
 * restore production or that the executor refused (`identity_redeploy_not_restored`: never retried automatically), and
 * beyond IDENTITY_REDEPLOY_RETRIES (`identity_redeploy_retries_exhausted`).
 */
export async function identityRedeployAttempt(db: D1Database, target: string, base: string): Promise<{ attempt: number } | { reason: string }> {
  const rows = (await db.prepare(
    "SELECT status, json_extract(details_json, '$.outcome.restored') AS restored FROM deployment_requests WHERE service_id = ? AND substr(idempotency_key, 1, ?) = ?",
  ).bind(target, base.length + 1, `${base}:`).all<{ status: string; restored: number | boolean | null }>()).results ?? [];
  if (rows.some((r) => r.status === "approved" || r.status === "running")) return { reason: "identity_redeploy_in_progress" };
  if (rows.some((r) => r.status === "succeeded")) return { reason: "identity_redeploy_done" };
  if (rows.some((r) => !(r.restored === 1 || r.restored === true))) return { reason: "identity_redeploy_not_restored" };
  if (rows.length > IDENTITY_REDEPLOY_RETRIES) return { reason: "identity_redeploy_retries_exhausted" };
  return { attempt: rows.length + 1 };
}

/** identityClientHash of the CI Client ID gate 4 holds; null without one. */
export async function ciClientHash(gate4: { deployVars?: DeployVarReference }): Promise<string | null> {
  const id = gate4.deployVars?.CI_CLIENT_ID;
  return id ? identityClientHash(id) : null;
}

/**
 * Whether `unit` may be redeployed at `sha` for identity revision `revision`, with the plan the native deploy runs.
 * `gate4` is the Orchestrator's gate 4 reference with the identity source read now (index.ts gate4Deploy). Refused:
 *   - `access_service_token_not_set`: gate 4 is off, so no deploy writes the identity lists;
 *   - `identity_source_<status>`: the row is not owner-saved (absent, seed, invalid, unreadable): nothing is written
 *     from it, so nothing is redeployed;
 *   - `identity_revision_moved`: the owner saved another revision since the proposal (that one has its own);
 *   - `identity_ci_token_moved`: the Orchestrator holds another CI service token than the proposal names (that one has
 *     its own);
 *   - `identity_redeploy_not_running_commit` (or the running commit's reason): the unit runs another commit now;
 *   - `not_eligible: <reason>`: the native deploy at that commit is not possible (every check of native-deploy.ts);
 *   - `identity_redeploy_migrations`: the plan would apply a D1 migration (a redeploy never does);
 *   - `identity_vars_match`: every Worker already carries the expected values (nothing to do).
 */
export async function identityRedeployChoice(deps: IdentityRedeployDeps, unit: DeployUnit, sha: string, revision: number, client: string, cf: VersionReader,
  gate4: { deployVars?: DeployVarReference }): Promise<IdentityRedeployChoice> {
  if (!gate4.deployVars) return { ok: false, reason: "access_service_token_not_set" };
  const source = gate4.deployVars.IDENTITIES;
  if (!source || source.status !== "owner") return { ok: false, reason: `identity_source_${source?.status ?? "absent"}` };
  if (source.revision !== revision) return { ok: false, reason: "identity_revision_moved" };
  if ((await ciClientHash(gate4)) !== client) return { ok: false, reason: "identity_ci_token_moved" };
  if (!carriesIdentities(unit)) return { ok: false, reason: "identity_vars_none" };
  const running = await runningCommit(deps, unit);
  if ("reason" in running) return { ok: false, reason: running.reason };
  if (running.sha !== sha) return { ok: false, reason: "identity_redeploy_not_running_commit" };
  const e = await nativeDeployEligible(deps, unit, sha, cf, gate4);
  if (!e.eligible) return { ok: false, reason: `not_eligible: ${e.reason}`, ...(e.service ? { service: e.service } : {}) };
  if (e.migrations.length) return { ok: false, reason: "identity_redeploy_migrations" };
  const changed = Object.fromEntries(e.services.filter((s) => s.deploy_vars_changed?.length).map((s) => [s.service, [...s.deploy_vars_changed!]]));
  if (Object.keys(changed).length === 0) return { ok: false, reason: "identity_vars_match" };
  return { ok: true, services: e.services, changed };
}

/**
 * Every unit whose active Workers carry another identity value than the owner-saved row gives, at its running commit.
 * Reads D1, the Forge's bundles and (only when the row is owner-saved and gate 4 is on) each Worker's active version.
 * Never writes, never throws.
 */
export async function identityDriftOf(deps: IdentityRedeployDeps, cf: VersionReader, gate4: { deployVars?: DeployVarReference }): Promise<IdentityDrift> {
  try {
    const source = gate4.deployVars?.IDENTITIES;
    const status = source?.status ?? "absent";
    const revision = source?.status === "owner" ? source.revision : null;
    const client = await ciClientHash(gate4);
    const base = { ok: true as const, source: status, revision, client, units: [] as IdentityDriftUnit[], skipped: [] as Array<{ unit: string; reason: string }> };
    if (!gate4.deployVars) return { ...base, reason: "access_service_token_not_set" };
    if (!source || source.status !== "owner") {
      return { ...base, reason: source?.status === "invalid" ? `identity_source_invalid: ${source.reason}` : `identity_source_${status}` };
    }
    if (!client) return { ...base, reason: "access_service_token_not_set" };
    for (const unit of DEPLOY_UNITS) {
      if (!carriesIdentities(unit)) continue;
      const running = await runningCommit(deps, unit);
      if ("reason" in running) { base.skipped.push({ unit: unit.unit, reason: running.reason }); continue; }
      const c = await identityRedeployChoice(deps, unit, running.sha, source.revision, client, cf, gate4);
      if (!c.ok) {
        if (c.reason !== "identity_vars_match") base.skipped.push({ unit: unit.unit, reason: `${c.reason}${c.service ? ` (${c.service})` : ""}`.slice(0, 120) });
        continue;
      }
      base.units.push({ unit: unit.unit, workflow: unit.workflow, target: unit.services[0], commit_sha: running.sha, changed: c.changed });
    }
    return base;
  } catch (err) {
    return { ok: false, reason: `identity_drift_unreadable: ${String((err as Error)?.message ?? err).slice(0, 100)}` };
  }
}
