// The redeploy for identities (owner 2026-11-16, "1. Ya"): an identity change is applied without waiting for an unrelated
// deploy.
//
// The native deploy writes the identity lists an owner saved in D1 `platform_identities` (identity-source.ts,
// deploy-vars.ts), but only when the unit deploys. A unit with no new commit kept the old lists. So, after an owner
// saves the list, the Supervisor asks the Deployment Orchestrator which units' active Workers carry another value than
// the one built from the saved row (`identityDrift`, read only), and proposes a routine consensus `deploy_commit` of each
// such unit AT ITS RUNNING COMMIT (no new code), with these params:
//
//   { commit_sha: <the unit's running commit, 40 hex>, unit, workflow, reason, redeploy: "identity_vars", identity_revision: N }
//
// It is a deploy_commit like any other for the council and the Policy Engine (the same votes, the hourly limit per
// target, the daily deploy limit, the brake, the Supervisor's 4 proposals an hour), and it runs only on the native path,
// whose checks are those of every native deploy (deploy-vars.ts: format, the CI Client ID first, unit equality; the new
// text verified on the new version before traffic). The Orchestrator checks, when it queues the request and again right
// before its executor runs: the row is owner-saved (never `seed`, `invalid` or `unreadable`) at exactly revision N; the
// commit is the one every Worker of the unit runs; the plan applies no D1 migration; and at least one identity variable
// differs (otherwise nothing is queued). The request's lock and idempotency key name the revision, so a unit is
// redeployed at most once per revision of the identity row: not a loop, also when a dashboard edit changes a value again.
//
// Break-glass (recovery-deploy.ts) and rescue (executor-rescue.ts) are unchanged.

/** params.redeploy of an identity redeploy. */
export const IDENTITY_REDEPLOY = "identity_vars";

export interface IdentityRedeployParams { commit_sha: string; unit: string; revision: number }

/**
 * The identity redeploy a deploy_commit's params (or a native request's signed details) name: null when they name none
 * (`redeploy` absent), the problem when they are malformed. Never repaired.
 */
export function identityRedeployParams(params: Record<string, unknown>): IdentityRedeployParams | { problem: string } | null {
  if (params.redeploy === undefined) return null;
  if (params.redeploy !== IDENTITY_REDEPLOY) return { problem: "identity_redeploy_unknown" };
  const sha = params.commit_sha;
  if (typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) return { problem: "invalid_commit_sha" };
  if (typeof params.unit !== "string" || !/^[a-z][a-z0-9-]{1,62}$/.test(params.unit)) return { problem: "identity_redeploy_unit_invalid" };
  const rev = params.identity_revision;
  if (typeof rev !== "number" || !Number.isInteger(rev) || rev < 1) return { problem: "identity_revision_invalid" };
  return { commit_sha: sha, unit: params.unit, revision: rev };
}

/** The DeploymentLock name and the request's idempotency key: one identity redeploy per unit, commit and revision. */
export function identityRedeployKey(workflow: string, sha: string, revision: number): string {
  return `consensus:${workflow}:${sha}:identities:${revision}`;
}

/** One unit whose active Workers carry another identity value than the saved row gives (names only, never values). */
export interface IdentityDriftUnit {
  unit: string;
  workflow: string;
  /** The consensus target: the unit's first Worker, as for every deploy_commit. */
  target: string;
  /** The commit every Worker of the unit runs (its registry desired version, resolved to the Forge's bundle). */
  commit_sha: string;
  /** Worker -> the identity variables whose active text differs. */
  changed: Record<string, string[]>;
}

/** The Orchestrator's answer to `identityDrift` (DeployRpc). */
export type IdentityDrift =
  | { ok: false; reason: string }
  | {
    ok: true;
    /** The identity source's status (identity-source.ts). Only `owner` ever gives units. */
    source: "absent" | "seed" | "owner" | "invalid" | "unreadable";
    /** The row's revision when it is owner-saved; null otherwise. */
    revision: number | null;
    /** Why nothing is redeployed from the row, when it is not owner-saved or gate 4 is off. */
    reason?: string;
    units: IdentityDriftUnit[];
    /** Units not checked or not redeployable, with the reason (e.g. no bundle for the running commit). */
    skipped: Array<{ unit: string; reason: string }>;
  };
