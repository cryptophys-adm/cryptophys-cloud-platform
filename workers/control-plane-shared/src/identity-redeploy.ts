// The redeploy for identities (owner 2026-11-16, "1. Ya"): an identity change is applied without waiting for an unrelated
// deploy.
//
// The native deploy writes the identity lists an owner saved in D1 `platform_identities` (identity-source.ts,
// deploy-vars.ts), but only when the unit deploys. A unit with no new commit kept the old lists. So, after an owner
// saves the list, the Supervisor asks the Deployment Orchestrator which units' active Workers carry another value than
// the one built from the saved row (`identityDrift`, read only), and proposes a routine consensus `deploy_commit` of each
// such unit AT ITS RUNNING COMMIT (no new code), with these params:
//
//   { commit_sha: <the unit's running commit, 40 hex>, unit, workflow, reason, redeploy: "identity_vars", identity_revision: N,
//     identity_client: <the first 8 hex of the SHA-256 of the Orchestrator's CI service token Client ID> }
//
// It is a deploy_commit like any other for the council and the Policy Engine (the same votes, the hourly limit per
// target, the daily deploy limit, the brake, the Supervisor's 4 proposals an hour), and it runs only on the native path,
// whose checks are those of every native deploy (deploy-vars.ts: format, the CI Client ID first, unit equality; the new
// text verified on the new version before traffic). The Orchestrator checks, when it queues the request and again right
// before its executor runs: the row is owner-saved (never `seed`, `invalid` or `unreadable`) at exactly revision N; the
// commit is the one every Worker of the unit runs; the plan applies no D1 migration; and at least one identity variable
// differs (otherwise nothing is queued). The request's lock and idempotency key name the revision and the CI token's
// hash, so a unit is redeployed once per revision of the identity row and per CI service token: not a loop, also when a
// dashboard edit changes a value again; a rotated CI token (owner 2026-11-16, "sesuai rekomendasimu") is redeployed once
// for the same revision. Only the hash prefix is stored, never the Client ID.
//
// Retries (owner 2026-11-16, "sesuai rekomendasimu"), as for a deploy of main (supervisor.ts DEPLOY_RETRY_AFTER_MS,
// DEPLOY_RETRIES_PER_COMMIT): an identity redeploy whose deploy failed and restored production, or whose proposal failed
// before anything was queued, is proposed again for the same unit, revision and token once the brake is off and an hour
// after the last attempt, at most IDENTITY_REDEPLOY_RETRIES more times. A failure that did not restore production (or
// that the executor refused) is never retried automatically. Each attempt has its own key (`...:<attempt>`); the
// Orchestrator numbers it from the requests already queued for that identity and refuses one while an earlier attempt is
// queued, running or succeeded, after a failure that was not restored, or beyond the retries.
//
// Break-glass (recovery-deploy.ts) and rescue (executor-rescue.ts) are unchanged.

/** params.redeploy of an identity redeploy. */
export const IDENTITY_REDEPLOY = "identity_vars";

export interface IdentityRedeployParams { commit_sha: string; unit: string; revision: number; client: string }

/** Mirrors supervisor.ts DEPLOY_RETRIES_PER_COMMIT and DEPLOY_RETRY_AFTER_MS (a test keeps them equal). */
export const IDENTITY_REDEPLOY_RETRIES = 2;
export const IDENTITY_REDEPLOY_RETRY_AFTER_MS = 3_600_000;
/** Attempts per unit, revision and CI token: the first and its retries. */
export const IDENTITY_REDEPLOY_ATTEMPTS = 1 + IDENTITY_REDEPLOY_RETRIES;
const CLIENT_HASH = /^[0-9a-f]{8}$/;

/** The first 8 hex of the SHA-256 of the CI service token's Client ID: names the token without storing it. */
export async function identityClientHash(clientId: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientId));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
}

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
  if (typeof params.identity_client !== "string" || !CLIENT_HASH.test(params.identity_client)) return { problem: "identity_client_invalid" };
  return { commit_sha: sha, unit: params.unit, revision: rev, client: params.identity_client };
}

/** A queued request's attempt number (signed details), 1 to IDENTITY_REDEPLOY_ATTEMPTS; null otherwise. */
export function identityAttemptOf(details: Record<string, unknown>): number | null {
  const a = details.identity_attempt;
  return typeof a === "number" && Number.isInteger(a) && a >= 1 && a <= IDENTITY_REDEPLOY_ATTEMPTS ? a : null;
}

/** What every attempt's key starts with: one identity redeploy per unit, commit, revision and CI token. */
export function identityRedeployBase(workflow: string, sha: string, revision: number, client: string): string {
  return `consensus:${workflow}:${sha}:identities:${revision}:${client}`;
}
/** The DeploymentLock name and the request's idempotency key of one attempt. */
export function identityRedeployKey(workflow: string, sha: string, revision: number, client: string, attempt: number): string {
  return `${identityRedeployBase(workflow, sha, revision, client)}:${attempt}`;
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
    /** identityClientHash of the CI service token's Client ID the expected lists start with; null without one. */
    client: string | null;
    /** Why nothing is redeployed from the row, when it is not owner-saved or gate 4 is off. */
    reason?: string;
    units: IdentityDriftUnit[];
    /** Units not checked or not redeployable, with the reason (e.g. no bundle for the running commit). */
    skipped: Array<{ unit: string; reason: string }>;
  };
