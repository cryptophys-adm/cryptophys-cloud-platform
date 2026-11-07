// Platform accounts (owner decision 2026-11-07, migration 0026): the Cerebrum Console's Users page.
//
//   kind 'admin' + privilege viewer | operator | approver -> may open the Cerebrum Console
//   kind 'user'                                          -> may sign in to Nexus only
//
// Only the owners (APPROVER_IDENTITIES, people) manage accounts, with a typed confirmation
// (GRANT to add or change, REVOKE to disable). Configured identities (owners, operators, the CI
// token) cannot be added, changed or disabled here, so nobody can lock the owners out and nobody
// can change their own access. Every change is written atomically with its audit event.
// Accounts are disabled, never deleted.
//
// Sign-in: Nexus is behind Cloudflare Access. The Access application's allow policy includes the
// group `cryptophys-nexus-accounts` (provision-access.yml). After each change this Worker attempts
// to reconcile that group to the active accounts plus the owners, through the Access API with the
// Worker secret ACCESS_GROUPS_TOKEN (Access: Groups Edit). A failed sync leaves Access membership
// potentially stale; the API returns the status and an owner can retry. Without the secret, roles
// still apply, but new people cannot sign in and disabled people may remain in the group.
import type { BaseEnv } from "../../control-plane-shared/src/types.ts";
import { errorResponse, json, readJsonObject } from "../../control-plane-shared/src/http.ts";
import { appendAuditEventWithMutation } from "../../control-plane-shared/src/audit.ts";
import { authenticate, actorOf, isOwner, roleOf, type AccessIdentity } from "../../control-plane-shared/src/access.ts";

export interface AccountsEnv extends BaseEnv {
  APPROVER_IDENTITIES?: string;
  /** Cloudflare account ID, set at deploy time (not a secret). */
  CF_ACCOUNT_ID?: string;
  /** Worker secret set by the owner: an API token with Access: Organizations, Identity Providers, and Groups Edit. */
  ACCESS_GROUPS_TOKEN?: string;
}

export const ACCESS_GROUP_NAME = "cryptophys-nexus-accounts";
export const KINDS = ["admin", "user"] as const;
export const PRIVILEGES = ["viewer", "operator", "approver"] as const;
const EMAIL = /^[a-z0-9._%+-]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,24}$/;

interface AccountRow {
  email: string; kind: string; privilege: string | null; status: string; note: string | null;
  created_by: string; created_at: string; updated_by: string; updated_at: string;
}

const listEmails = (list: string | undefined) => (list ?? "").split(",").map((v) => v.trim().toLowerCase()).filter((v) => v.includes("@"));

/** The configured people: owners and operator emails. They are not managed here. */
function configuredEmails(env: AccountsEnv): Set<string> {
  return new Set([...listEmails(env.APPROVER_IDENTITIES), ...listEmails(env.OPERATOR_IDENTITIES)]);
}

/** GET /v1/accounts/me: the caller's role, for the Console gate and whoami. Any valid Access identity. */
export async function whoAmI(request: Request, env: AccountsEnv): Promise<Response> {
  const auth = await authenticate(request, env);
  if (!auth.ok) return auth.response;
  const r = await roleOf(env, auth.identity);
  return json({ actor: actorOf(auth.identity), type: auth.identity.type, role: r.role, source: r.source, owner: r.owner });
}

export async function listAccounts(env: AccountsEnv): Promise<Response> {
  const rows = await env.DB.prepare("SELECT * FROM platform_accounts ORDER BY status, kind, email").all<AccountRow>();
  return json({
    accounts: rows.results,
    owners: listEmails(env.APPROVER_IDENTITIES),
    configured_operators: listEmails(env.OPERATOR_IDENTITIES).filter((e) => !listEmails(env.APPROVER_IDENTITIES).includes(e)),
    login_sync: loginSyncConfigured(env) ? "configured" : "not_configured",
  });
}

function ownerOnly(identity: AccessIdentity, env: AccountsEnv): Response | null {
  return isOwner(identity, env) ? null : errorResponse(403, "owner_required", "only an owner (APPROVER_IDENTITIES) manages accounts");
}

/** POST /v1/accounts {email, kind, privilege?, note?, confirm: "GRANT"}: add, change or re-enable. */
export async function upsertAccount(request: Request, env: AccountsEnv, identity: AccessIdentity): Promise<Response> {
  const denied = ownerOnly(identity, env);
  if (denied) return denied;
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  const b = body.value;
  if (b.confirm !== "GRANT") return errorResponse(400, "confirmation_required", 'type "GRANT" to add or change an account');
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  if (!EMAIL.test(email) || email.length > 254) return errorResponse(400, "invalid_email");
  const kind = b.kind;
  if (kind !== "admin" && kind !== "user") return errorResponse(400, "invalid_kind", "kind must be admin or user");
  const privilege = kind === "admin" ? b.privilege : null;
  if (kind === "admin" && !(PRIVILEGES as readonly unknown[]).includes(privilege)) {
    return errorResponse(400, "invalid_privilege", "an admin needs privilege viewer, operator or approver");
  }
  if (kind === "user" && b.privilege !== undefined && b.privilege !== null) return errorResponse(400, "invalid_privilege", "a user has no privilege");
  const note = b.note === undefined || b.note === null ? null : typeof b.note === "string" && b.note.length <= 200 ? b.note : undefined;
  if (note === undefined) return errorResponse(400, "invalid_note", "note is a string of at most 200 characters");
  const actor = actorOf(identity);
  if (email === actor) return errorResponse(403, "self_change", "nobody changes their own access");
  if (configuredEmails(env).has(email)) return errorResponse(409, "configured_identity", "owners and configured operators are managed in configuration, not here");

  const before = await env.DB.prepare("SELECT * FROM platform_accounts WHERE email = ?").bind(email).first<AccountRow>();
  await appendAuditEventWithMutation(
    env.DB,
    {
      event_type: before ? "account.changed" : "account.created", actor, subject: email, outcome: "active",
      payload: { kind, privilege, note, previous: before ? { kind: before.kind, privilege: before.privilege, status: before.status } : null },
    },
    (event) => env.DB.prepare(
      `INSERT INTO platform_accounts (email, kind, privilege, status, note, created_by, created_at, updated_by, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET kind = excluded.kind, privilege = excluded.privilege, status = 'active',
         note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).bind(email, kind, privilege, note, actor, event.created_at, actor, event.created_at),
  );
  const account = await env.DB.prepare("SELECT * FROM platform_accounts WHERE email = ?").bind(email).first<AccountRow>();
  return json({ account, login_sync: await syncLogin(env) }, before ? 200 : 201);
}

/** POST /v1/accounts/{email}/disable {confirm: "REVOKE"}: the account keeps its history. */
export async function disableAccount(request: Request, env: AccountsEnv, identity: AccessIdentity, email: string): Promise<Response> {
  const denied = ownerOnly(identity, env);
  if (denied) return denied;
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  if (body.value.confirm !== "REVOKE") return errorResponse(400, "confirmation_required", 'type "REVOKE" to disable an account');
  const actor = actorOf(identity);
  if (email === actor) return errorResponse(403, "self_change", "nobody changes their own access");
  const before = await env.DB.prepare("SELECT * FROM platform_accounts WHERE email = ?").bind(email).first<AccountRow>();
  if (!before) return errorResponse(404, "not_found");
  if (before.status === "disabled") return json({ account: before, login_sync: await syncLogin(env) });
  await appendAuditEventWithMutation(
    env.DB,
    { event_type: "account.disabled", actor, subject: email, outcome: "disabled", payload: { kind: before.kind, privilege: before.privilege } },
    (event) => env.DB.prepare("UPDATE platform_accounts SET status = 'disabled', updated_by = ?, updated_at = ? WHERE email = ? AND status = 'active'")
      .bind(actor, event.created_at, email),
  );
  const account = await env.DB.prepare("SELECT * FROM platform_accounts WHERE email = ?").bind(email).first<AccountRow>();
  return json({ account, login_sync: await syncLogin(env) });
}

export function loginSyncConfigured(env: AccountsEnv): boolean {
  return Boolean(env.ACCESS_GROUPS_TOKEN && env.CF_ACCOUNT_ID);
}

export type LoginSync =
  | { status: "synced"; group_id: string; emails: number }
  | { status: "not_configured"; detail: string }
  | { status: "group_missing"; detail: string }
  | { status: "failed"; detail: string };

/**
 * Set the Access group to the active accounts plus the owners. Idempotent; the owners are always
 * included, so the group is never empty and the owners never lose sign-in through it.
 */
export async function syncLogin(env: AccountsEnv, fetcher: typeof fetch = fetch): Promise<LoginSync> {
  if (!loginSyncConfigured(env)) {
    return { status: "not_configured", detail: "set the Worker secret ACCESS_GROUPS_TOKEN on cryptophys-platform-registry so new accounts can sign in" };
  }
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/access/groups`;
  const headers = { authorization: `Bearer ${env.ACCESS_GROUPS_TOKEN}`, "content-type": "application/json" };
  try {
    const list = await fetcher(`${base}?per_page=1000`, { headers });
    const listed = await list.json() as { success?: boolean; result?: { id: string; name: string }[]; errors?: { code: number }[] };
    if (!list.ok || !listed.success) return { status: "failed", detail: `list groups: HTTP ${list.status} ${JSON.stringify(listed.errors ?? []).slice(0, 200)}` };
    const group = (listed.result ?? []).find((g) => g.name === ACCESS_GROUP_NAME);
    if (!group) return { status: "group_missing", detail: `run Provision Access once to create the Access group ${ACCESS_GROUP_NAME}` };
    const rows = await env.DB.prepare("SELECT email FROM platform_accounts WHERE status = 'active' ORDER BY email").all<{ email: string }>();
    const emails = [...new Set([...listEmails(env.APPROVER_IDENTITIES), ...rows.results.map((r) => r.email)])];
    const put = await fetcher(`${base}/${group.id}`, {
      method: "PUT", headers,
      body: JSON.stringify({ name: ACCESS_GROUP_NAME, include: emails.map((email) => ({ email: { email } })), exclude: [], require: [] }),
    });
    const updated = await put.json() as { success?: boolean; errors?: { code: number }[] };
    if (!put.ok || !updated.success) return { status: "failed", detail: `update group: HTTP ${put.status} ${JSON.stringify(updated.errors ?? []).slice(0, 200)}` };
    return { status: "synced", group_id: group.id, emails: emails.length };
  } catch (e) {
    return { status: "failed", detail: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

/** POST /v1/accounts/sync-login: owner-only resync (e.g. after the secret was set). */
export async function resyncLogin(request: Request, env: AccountsEnv, identity: AccessIdentity): Promise<Response> {
  const denied = ownerOnly(identity, env);
  if (denied) return denied;
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  if (body.value.confirm !== "SYNC") return errorResponse(400, "confirmation_required", 'type "SYNC" to reconcile the Nexus sign-in group');
  return json({ login_sync: await syncLogin(env) });
}

