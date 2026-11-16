// The deploy-time identity lists' native source (owner 2026-11-16, migration 0073): the Console's Users page.
//
// The emails behind OPERATOR_IDENTITIES / DEPLOY_ALLOWED_IDENTITIES and APPROVER_IDENTITIES (ACCESS_ALLOWED_EMAILS
// semantics, control-plane-shared/src/identity-source.ts) live in D1 `platform_identities`. The native deploy writes the
// values built from an owner-saved row (deployment-orchestrator/src/deploy-vars.ts).
//
//   GET  /v1/identities   owners, operators and viewer accounts (emails are not secrets): the row, whether the deploys
//                         use it, what this Worker runs now, and the last changes from the audit chain;
//   POST /v1/identities   {emails, revision, confirm: "IDENTITIES"}: an owner only (a person in APPROVER_IDENTITIES, as
//                         for the accounts; never an approver account, an operator, a service token or an agent).
//
// The write is the strongest existing owner pattern on this Worker (the Users page's GRANT / REVOKE): the Access JWT of a
// configured owner, the Console's CSRF header and typed phrase, and the row written atomically with its audit event
// (identity_source.changed). The owner's own email must stay in the list (nobody locks the owners out), and `revision`
// must name the row the form showed, so a stale form never overwrites a newer list.
import type { BaseEnv } from "../../control-plane-shared/src/types.ts";
import { errorResponse, json, readJsonObject } from "../../control-plane-shared/src/http.ts";
import { appendAuditEventWithMutation, AuditMutationConflictError } from "../../control-plane-shared/src/audit.ts";
import { actorOf, isOwner, type AccessIdentity } from "../../control-plane-shared/src/access.ts";
import {
  IDENTITY_SOURCE_ID, IDENTITY_SOURCE_TABLE, identitySourceOf, MAX_IDENTITY_EMAILS, normalizeIdentityEmails, readIdentityRow, type IdentitySource,
} from "../../control-plane-shared/src/identity-source.ts";

export interface IdentitiesEnv extends BaseEnv {
  APPROVER_IDENTITIES?: string;
}

export const IDENTITIES_CONFIRM = "IDENTITIES";
const HISTORY = 10;

const emailsOf = (list: string | undefined) => (list ?? "").split(",").map((v) => v.trim().toLowerCase()).filter((v) => v.includes("@"));

/** What the native deploy does with the source (deploy-vars.ts), in the Console's words. */
function inEffect(s: IdentitySource): { uses: "identity_table" | "active_version"; detail: string } {
  if (s.status === "owner") return { uses: "identity_table", detail: "Each unit's next native deploy writes these lists (the CI service token's Client ID first in the operator list)." };
  if (s.status === "seed") return { uses: "active_version", detail: "Copied from the deployed lists; each Worker keeps its deployed values until an owner saves this list." };
  if (s.status === "invalid") return { uses: "active_version", detail: `Not a valid list (${s.reason}): nothing is deployed from it; each Worker keeps its deployed values.` };
  if (s.status === "unreadable") return { uses: "active_version", detail: "The list could not be read; each Worker keeps its deployed values." };
  return { uses: "active_version", detail: "No list saved yet: each Worker keeps its deployed values." };
}

/** GET /v1/identities. */
export async function getIdentities(env: IdentitiesEnv): Promise<Response> {
  let source: IdentitySource;
  let migrated = true;
  try {
    source = identitySourceOf(await readIdentityRow(env.DB));
    await env.DB.prepare(`SELECT 1 FROM ${IDENTITY_SOURCE_TABLE} LIMIT 1`).first();
  } catch (err) {
    migrated = !/no such table/i.test(String((err as Error)?.message ?? err));
    source = migrated ? { status: "unreadable" } : { status: "absent" };
  }
  const history = (await env.DB.prepare(
    "SELECT event_type, actor, outcome, payload_json, created_at FROM audit_events WHERE subject = ? AND event_type IN ('identity_source.seeded', 'identity_source.changed') ORDER BY rowid DESC LIMIT ?",
  ).bind(IDENTITY_SOURCE_TABLE, HISTORY).all<{ event_type: string; actor: string; outcome: string; payload_json: string; created_at: string }>()).results.map((e) => {
    let p: Record<string, unknown> = {};
    try { p = JSON.parse(e.payload_json) as Record<string, unknown>; } catch { p = {}; }
    return { event_type: e.event_type, actor: e.actor, created_at: e.created_at, revision: typeof p.revision === "number" ? p.revision : null, emails: Array.isArray(p.approver_emails) ? p.approver_emails : null };
  });
  return json({
    schema: "identity-source.v1",
    migrated,
    source,
    in_effect: inEffect(source),
    // What this Worker itself runs now (its active version's APPROVER_IDENTITIES), for comparison; the Client ID is not shown.
    running_here: { approver_emails: emailsOf(env.APPROVER_IDENTITIES) },
    limits: { max_emails: MAX_IDENTITY_EMAILS },
    history,
  });
}

/** POST /v1/identities {emails, revision, confirm: "IDENTITIES"}. */
export async function saveIdentities(request: Request, env: IdentitiesEnv, identity: AccessIdentity): Promise<Response> {
  if (!isOwner(identity, env)) return errorResponse(403, "owner_required", "only an owner (APPROVER_IDENTITIES, a person) changes the identity lists");
  const body = await readJsonObject(request);
  if (!body.ok) return body.response;
  const b = body.value;
  if (b.confirm !== IDENTITIES_CONFIRM) return errorResponse(400, "confirmation_required", `type "${IDENTITIES_CONFIRM}" to change the operator and approver emails`);
  const list = normalizeIdentityEmails(b.emails);
  if ("reason" in list) return errorResponse(400, list.reason, `emails: 1 to ${MAX_IDENTITY_EMAILS} valid addresses`);
  const actor = actorOf(identity);
  if (!list.emails.includes(actor)) return errorResponse(400, "owner_not_in_list", "your own email stays in the list: nobody removes their own access");
  if (!(b.revision === null || (Number.isInteger(b.revision) && (b.revision as number) >= 1))) return errorResponse(400, "invalid_revision", "revision is the revision shown, or null when no list was saved");
  let row;
  try { row = await readIdentityRow(env.DB); } catch { return errorResponse(503, "identity_source_unreadable"); }
  try { await env.DB.prepare(`SELECT 1 FROM ${IDENTITY_SOURCE_TABLE} LIMIT 1`).first(); } catch { return errorResponse(503, "identity_source_not_migrated", "migration 0073 is not applied yet"); }
  const current = row ? Number(row.revision) : null;
  if (b.revision !== current) return errorResponse(409, "revision_conflict", "the list changed since this form was loaded; reload and try again", { revision: current });
  const text = list.emails.join(",");
  const before = identitySourceOf(row);
  if (before.status === "owner" && before.approver_emails.join(",") === text) return json({ unchanged: true, source: before });
  const revision = (current ?? 0) + 1;
  try {
    await appendAuditEventWithMutation(env.DB, {
      event_type: "identity_source.changed", actor, subject: IDENTITY_SOURCE_TABLE, outcome: "owner",
      payload: {
        previous: row ? { source: row.source, revision: current, approver_emails: emailsOf(row.approver_emails), operator_emails: emailsOf(row.operator_emails) } : null,
        operator_emails: list.emails, approver_emails: list.emails, revision,
        applies: "with each unit's next native deploy",
      },
    }, (event) => row
      ? env.DB.prepare(
        `UPDATE ${IDENTITY_SOURCE_TABLE} SET operator_emails = ?, approver_emails = ?, source = 'owner', revision = ?, updated_by = ?, updated_at = ? WHERE id = ? AND revision = ?`,
      ).bind(text, text, revision, actor, event.created_at, IDENTITY_SOURCE_ID, current)
      : env.DB.prepare(
        `INSERT INTO ${IDENTITY_SOURCE_TABLE} (id, operator_emails, approver_emails, source, revision, updated_by, updated_at)
         SELECT ?, ?, ?, 'owner', 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM ${IDENTITY_SOURCE_TABLE} WHERE id = ?)`,
      ).bind(IDENTITY_SOURCE_ID, text, text, actor, event.created_at, IDENTITY_SOURCE_ID));
  } catch (err) {
    if (err instanceof AuditMutationConflictError) return errorResponse(409, "revision_conflict", "the list changed since this form was loaded; reload and try again");
    throw err;
  }
  const saved = identitySourceOf(await readIdentityRow(env.DB));
  // access-identities.sh's warning: one approver can never approve a recovery plan it authored.
  const warning = list.emails.length < 2 ? { warning: "Only one approver email: recovery plans it authors can never be approved (separation of duties)." } : {};
  return json({ source: saved, in_effect: inEffect(saved), ...warning }, row ? 200 : 201);
}
