// The native source of the deploy-time identity lists (owner 2026-11-16, migration 0073).
//
// Until the GitHub cut-over the deploy workflows build the identity lists with access-identities.sh from the GitHub
// variable ACCESS_ALLOWED_EMAILS and the secret CF_ACCESS_CLIENT_ID:
//   OPERATOR_IDENTITIES = <CI Client ID>,<email>,<email>...   (DEPLOY_ALLOWED_IDENTITIES is the same list)
//   APPROVER_IDENTITIES = <email>,<email>...
// with the emails lower-cased, deduplicated in their first order, checked against one regex and never empty. After the
// cut-over that variable is gone, so the owner keeps the emails in D1 `platform_identities` instead. This module is
// the one reading of that row (the Platform Registry's write route, the Deployment Orchestrator's native deploy and the
// Owner page all use it), so the three can never disagree on what a valid list is.
//
//   - status `absent` (no row, or the table not yet migrated) and `seed` (the row the Orchestrator copied once from its
//     own active version): the native deploy carries every Worker's active value exactly as before;
//   - status `owner` (an owner saved the list in the Console): the native deploy writes the values built from it;
//   - status `invalid` (a row that is not one this module would write) and `unreadable`: nothing is deployed from the
//     row; the deploy carries the active values and the Owner page lists `identity_source_invalid`.
//
// Only an owner's click writes the `owner` row (platform-registry/src/identities.ts); the seed only inserts when no row
// exists, and never changes a deployed value.
import type { D1Database } from "./types.ts";
import { appendAuditEventWithMutation, AuditMutationConflictError } from "./audit.ts";

/** access-identities.sh's email regex (deploy-vars.ts checks the deployed values against the same one). */
export const IDENTITY_EMAIL = "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}";
/** access-identities.sh's Client ID regex (a Client Secret starts with `cfast_` and is refused). */
export const IDENTITY_CLIENT_ID = "[A-Za-z0-9._-]+";
const EMAIL_RE = new RegExp(`^${IDENTITY_EMAIL}$`);
const CLIENT_ID_RE = new RegExp(`^(?!cfast_)${IDENTITY_CLIENT_ID}$`);
/** Limits of one list: the row's CHECK (5200 characters) holds 20 addresses of the longest legal length. */
export const MAX_IDENTITY_EMAILS = 20;
export const MAX_IDENTITY_EMAIL_CHARS = 254;
export const IDENTITY_SOURCE_ID = "access";
export const IDENTITY_SOURCE_TABLE = "platform_identities";
/** The deploy-time variables built from the row. */
export const IDENTITY_VARS = ["OPERATOR_IDENTITIES", "DEPLOY_ALLOWED_IDENTITIES", "APPROVER_IDENTITIES"] as const;
export type IdentityVar = (typeof IDENTITY_VARS)[number];
export const isIdentityVar = (name: string): name is IdentityVar => (IDENTITY_VARS as readonly string[]).includes(name);

export type EmailList = { emails: string[] } | { reason: string };

/**
 * ACCESS_ALLOWED_EMAILS semantics (access-identities.sh): a list of strings or one comma/space-separated string;
 * each entry trimmed and lower-cased, matching IDENTITY_EMAIL and at most 254 characters; duplicates dropped, first
 * order kept; at least one and at most MAX_IDENTITY_EMAILS. Refused with the reason, never repaired.
 */
export function normalizeIdentityEmails(input: unknown): EmailList {
  let raw: unknown[];
  if (typeof input === "string") raw = input.split(/[\s,]+/);
  else if (Array.isArray(input)) raw = input;
  else return { reason: "identity_emails_invalid" };
  if (raw.length > MAX_IDENTITY_EMAILS * 4) return { reason: "identity_emails_too_many" };
  const emails: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") return { reason: "identity_emails_invalid" };
    const e = entry.trim().toLowerCase();
    if (!e) continue;
    if (e.length > MAX_IDENTITY_EMAIL_CHARS || !EMAIL_RE.test(e)) return { reason: "identity_email_invalid" };
    if (!emails.includes(e)) emails.push(e);
  }
  if (emails.length === 0) return { reason: "identity_emails_empty" };
  if (emails.length > MAX_IDENTITY_EMAILS) return { reason: "identity_emails_too_many" };
  return { emails };
}

/** A stored list is valid only in the exact canonical form this module writes (no repair of a hand-edited row). */
function canonicalList(text: unknown): string[] | null {
  if (typeof text !== "string") return null;
  const n = normalizeIdentityEmails(text.split(","));
  return "emails" in n && n.emails.join(",") === text ? n.emails : null;
}

export interface IdentityRow {
  id: string; operator_emails: string; approver_emails: string; source: string; revision: number; updated_by: string; updated_at: string;
}
export type IdentitySource =
  | { status: "absent" }
  | { status: "unreadable" }
  | { status: "invalid"; reason: string; revision: number | null; updated_by: string | null; updated_at: string | null }
  | { status: "seed" | "owner"; operator_emails: string[]; approver_emails: string[]; revision: number; updated_by: string; updated_at: string };

/** Validate one row as this module would have written it. */
export function identitySourceOf(row: IdentityRow | null): IdentitySource {
  if (!row) return { status: "absent" };
  const meta = {
    revision: Number.isInteger(row.revision) && row.revision >= 1 ? row.revision : null,
    updated_by: typeof row.updated_by === "string" ? row.updated_by : null,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : null,
  };
  const invalid = (reason: string): IdentitySource => ({ status: "invalid", reason, ...meta });
  if (row.source !== "seed" && row.source !== "owner") return invalid("identity_source_unknown");
  if (meta.revision === null || !meta.updated_by || !meta.updated_at) return invalid("identity_source_metadata");
  const operators = canonicalList(row.operator_emails);
  if (!operators) return invalid("identity_operator_emails_malformed");
  const approvers = canonicalList(row.approver_emails);
  if (!approvers) return invalid("identity_approver_emails_malformed");
  // ACCESS_ALLOWED_EMAILS semantics: operators and approvers are one list today (the schema could hold two).
  if (operators.join(",") !== approvers.join(",")) return invalid("identity_lists_differ");
  return { status: row.source, operator_emails: operators, approver_emails: approvers, revision: meta.revision, updated_by: meta.updated_by, updated_at: meta.updated_at };
}

/** The row, raw (null when absent or the table does not exist yet); throws on any other read failure. */
export async function readIdentityRow(db: D1Database): Promise<IdentityRow | null> {
  try {
    return await db.prepare(`SELECT id, operator_emails, approver_emails, source, revision, updated_by, updated_at FROM ${IDENTITY_SOURCE_TABLE} WHERE id = ?`)
      .bind(IDENTITY_SOURCE_ID).first<IdentityRow>();
  } catch (err) {
    if (/no such table/i.test(String((err as Error)?.message ?? err))) return null;
    throw err;
  }
}

/** The identity source as the native deploy and the Owner page read it. Never throws. */
export async function readIdentitySource(db: D1Database | undefined): Promise<IdentitySource> {
  if (!db) return { status: "unreadable" };
  try {
    return identitySourceOf(await readIdentityRow(db));
  } catch {
    return { status: "unreadable" };
  }
}

/** The deploy-time values built from the emails, exactly as access-identities.sh prints them. */
export function identityVarValues(source: { operator_emails: readonly string[]; approver_emails: readonly string[] }, ciClientId: string): Record<IdentityVar, string> {
  const operators = `${ciClientId},${source.operator_emails.join(",")}`;
  return { OPERATOR_IDENTITIES: operators, DEPLOY_ALLOWED_IDENTITIES: operators, APPROVER_IDENTITIES: source.approver_emails.join(",") };
}

/**
 * The seed: the emails of the Orchestrator's own active APPROVER_IDENTITIES, accepted only when its
 * OPERATOR_IDENTITIES is exactly `<Client ID>,<those emails>` (access-identities.sh's output, the Client ID that of
 * the Orchestrator's CI service token when it holds one) and APPROVER_IDENTITIES is already canonical. So the seed
 * holds the very list the workflows deployed, or nothing.
 */
export function seedEmails(active: { OPERATOR_IDENTITIES?: string; APPROVER_IDENTITIES?: string }, ciClientId?: string): EmailList {
  const approvers = canonicalList(active.APPROVER_IDENTITIES);
  if (!approvers) return { reason: "seed_approvers_malformed" };
  const ops = typeof active.OPERATOR_IDENTITIES === "string" ? active.OPERATOR_IDENTITIES : "";
  const comma = ops.indexOf(",");
  const client = comma > 0 ? ops.slice(0, comma) : "";
  if (!CLIENT_ID_RE.test(client)) return { reason: "seed_operators_malformed" };
  if (ciClientId !== undefined && client !== ciClientId) return { reason: "seed_operators_not_ci_token" };
  if (ops.slice(comma + 1) !== approvers.join(",")) return { reason: "seed_lists_differ" };
  return { emails: approvers };
}

export type SeedOutcome = { seeded: true; emails: number } | { seeded: false; reason: string };

/**
 * Insert the seed row once, when no row exists, with its audit event in the same D1 batch. Never overwrites a row
 * (the INSERT is conditional on there being none, and a lost race is `present`). A seed changes no deployed value:
 * the native deploy carries the active values while the row is a seed.
 */
export async function seedIdentitySource(db: D1Database, active: { OPERATOR_IDENTITIES?: string; APPROVER_IDENTITIES?: string }, ciClientId: string | undefined, actor: string): Promise<SeedOutcome> {
  let row: IdentityRow | null;
  try { row = await readIdentityRow(db); } catch { return { seeded: false, reason: "unreadable" }; }
  if (row) return { seeded: false, reason: "present" };
  // The table must exist (migration 0073): a missing table reads as no row above.
  try { await db.prepare(`SELECT 1 FROM ${IDENTITY_SOURCE_TABLE} LIMIT 1`).first(); } catch { return { seeded: false, reason: "not_migrated" }; }
  const e = seedEmails(active, ciClientId);
  if ("reason" in e) return { seeded: false, reason: e.reason };
  const list = e.emails.join(",");
  try {
    await appendAuditEventWithMutation(db, {
      event_type: "identity_source.seeded", actor, subject: IDENTITY_SOURCE_TABLE, outcome: "seed",
      payload: { operator_emails: e.emails, approver_emails: e.emails, revision: 1, from: "the Deployment Orchestrator's active version", deploys: "carry each Worker's active value until an owner saves the list" },
    }, (event) => db.prepare(
      `INSERT INTO ${IDENTITY_SOURCE_TABLE} (id, operator_emails, approver_emails, source, revision, updated_by, updated_at)
       SELECT ?, ?, ?, 'seed', 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM ${IDENTITY_SOURCE_TABLE} WHERE id = ?)`,
    ).bind(IDENTITY_SOURCE_ID, list, list, actor, event.created_at, IDENTITY_SOURCE_ID));
  } catch (err) {
    if (err instanceof AuditMutationConflictError) return { seeded: false, reason: "present" };
    return { seeded: false, reason: "write_failed" };
  }
  return { seeded: true, emails: e.emails.length };
}
