// ADR-0012 G6 gate 4 (owner 2026-11-15, "1 setuju"): the deploy-time `--var` values on the native deploy path.
//
// Every deploy-*.yml workflow passes values to `wrangler deploy --var NAME:VALUE` that are in no wrangler.toml:
// the Access team domain and AUD (resolve-access.sh reads them from the Access application), the identity
// allow-lists (access-identities.sh builds them from the Environment variable ACCESS_ALLOWED_EMAILS and the
// secret CF_ACCESS_CLIENT_ID) and the account id (the secret CLOUDFLARE_ACCOUNT_ID). They reach each Worker as
// `plain_text` bindings. DEPLOY_VARS lists them per unit and Worker, exactly as the workflows pass them; a test
// derives the same table from the workflow YAML, so the two cannot drift apart.
//
// The native path carries them from the version it replaces: the code-only upload keeps every binding of the
// script's latest version (KEEP_BINDINGS), and a configuration plan keeps any binding its diff does not name
// verbatim (config-diff.ts). This module makes that explicit and checked:
//   - before the upload (and at eligibility, read only): each value the workflow would pass is on the active
//     version, as `plain_text`, well formed; values that name the same thing agree across the unit's Workers; the
//     three the Orchestrator itself holds (ACCESS_TEAM_DOMAIN, ACCESS_AUD, CF_ACCOUNT_ID: the one Access
//     application and the one account) equal its own; and the identity lists start with the Client ID of the
//     service token the Orchestrator holds for the smoke tests (the CI token, access-identities.sh's first entry).
//     Otherwise the deploy is refused with the reason (`deploy_var_unsourced:<NAME>`, ...): nothing on the
//     platform holds the value, so the unit stays on its workflow, which still holds the GitHub Environment;
//   - after the upload, before any traffic: the new version binds each of them with exactly the kept text
//     (`deploy_var_differs:<NAME>`).
// Values are never logged or audited by the deploy; the outcome names the variables only.
//
// The checks run once the owner has given the Orchestrator the Access service token (CF_ACCESS_CLIENT_ID and
// CF_ACCESS_CLIENT_SECRET, native-smoke.ts): one owner action switches on gate 4's Access checks, the values and the
// probes together. Before that the earlier rule applies alone (kept verbatim; the digest or the plan check).
//
// The identity lists have a native source (owner 2026-11-16, migration 0073, control-plane-shared/src/identity-source.ts):
// the owner keeps the ACCESS_ALLOWED_EMAILS emails in D1 `platform_identities`, changed only by an owner's click on the
// Console's Users page (platform-registry/src/identities.ts), audited. The reference then carries the row
// (`IDENTITIES`), and for OPERATOR_IDENTITIES, DEPLOY_ALLOWED_IDENTITIES and APPROVER_IDENTITIES:
//   - no row, or the seed (the Orchestrator's own active lists, copied once for the Console): carried from the active
//     version exactly as before; nothing changes on day one;
//   - an owner-saved row: the expected value is the row's, built as access-identities.sh builds it
//     (`<CI Client ID>,<emails...>`, the Client ID of the Orchestrator's CF_ACCESS_CLIENT_ID; APPROVER_IDENTITIES the
//     emails). It must pass the same format, Client-ID-first and unit-equality checks. The active version must bind the
//     variable once as `plain_text` (a deploy replaces a value, it never adds a binding); where its text differs the
//     native deploy writes the new text as that `plain_text` binding and verifies it on the new version before traffic
//     (`<worker>:vars_from_identity_table`, `<worker>:vars_changed:<NAME>`, names only);
//   - an invalid row: never deployed; the active values are carried as before and the Owner page lists
//     `identity_source_invalid` (`<worker>:identity_source_invalid` in the steps); an unreadable one (a D1 read failed)
//     is carried the same way.
// A new CI service token's Client ID also reaches the identity lists this way once the row is owner-saved: the expected
// lists start with the Client ID the Orchestrator holds.

import { IDENTITY_CLIENT_ID, IDENTITY_EMAIL, identityVarValues, isIdentityVar, type IdentitySource } from "../../control-plane-shared/src/identity-source.ts";

/** Where a deploy-time value comes from in the workflows, and the platform source the native path uses instead. */
export interface DeployVarSource {
  /** The GitHub Environment entries the workflow builds it from. */
  github: string;
  /**
   * Kept from the active version. `active_version_and_orchestrator`: it must also equal the Orchestrator's own value;
   * `active_version_and_ci_token`: its first entry must be the Client ID of the service token the Orchestrator holds.
   */
  native: "active_version" | "active_version_and_orchestrator" | "active_version_and_ci_token";
  format: RegExp;
}

const EMAIL = IDENTITY_EMAIL;
const CLIENT_ID = IDENTITY_CLIENT_ID;
/** access-identities.sh: the CI service token's Client ID, then the operator emails, comma-separated. */
const OPERATORS = new RegExp(`^(?!cfast_)${CLIENT_ID}(,${EMAIL})+$`);

export const DEPLOY_VAR_SOURCES: Readonly<Record<string, DeployVarSource>> = {
  ACCESS_TEAM_DOMAIN: { github: "resolve-access.sh (CLOUDFLARE_ACCESS_API_TOKEN: the Zero Trust organization)", native: "active_version_and_orchestrator", format: /^[a-z0-9-]+\.cloudflareaccess\.com$/ },
  ACCESS_AUD: { github: "resolve-access.sh (CLOUDFLARE_ACCESS_API_TOKEN: the Access application cryptophys-cloud-platform)", native: "active_version_and_orchestrator", format: /^[0-9a-f]{64}$/ },
  OPERATOR_IDENTITIES: { github: "access-identities.sh (secret CF_ACCESS_CLIENT_ID, variable ACCESS_ALLOWED_EMAILS)", native: "active_version_and_ci_token", format: OPERATORS },
  DEPLOY_ALLOWED_IDENTITIES: { github: "access-identities.sh (OPERATOR_IDENTITIES, renamed)", native: "active_version_and_ci_token", format: OPERATORS },
  APPROVER_IDENTITIES: { github: "access-identities.sh (variable ACCESS_ALLOWED_EMAILS)", native: "active_version", format: new RegExp(`^${EMAIL}(,${EMAIL})*$`) },
  CF_ACCOUNT_ID: { github: "secret CLOUDFLARE_ACCOUNT_ID", native: "active_version_and_orchestrator", format: /^[0-9a-f]{32}$/ },
};

const ACCESS = ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "OPERATOR_IDENTITIES"] as const;
const WITH_APPROVERS = [...ACCESS, "APPROVER_IDENTITIES"] as const;

/** unit -> Worker -> the `--var` names its workflow passes, in the workflow's order. */
export const DEPLOY_VARS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  "deployment-orchestrator": {
    "cryptophys-deployment-orchestrator": ["ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "DEPLOY_ALLOWED_IDENTITIES", "OPERATOR_IDENTITIES", "APPROVER_IDENTITIES", "CF_ACCOUNT_ID"],
  },
  "control-plane": {
    "cryptophys-policy-engine": ACCESS,
    "cryptophys-audit-ledger": ACCESS,
    "cryptophys-platform-registry": [...WITH_APPROVERS, "CF_ACCOUNT_ID"],
    "cryptophys-recovery-manager": WITH_APPROVERS,
    "cryptophys-drift-detector": ACCESS,
    "cryptophys-ai-kernel": WITH_APPROVERS,
  },
  console: { "cryptophys-console": WITH_APPROVERS },
  "platform-api": { "cryptophys-platform-api": ACCESS },
  forge: { "cryptophys-forge": WITH_APPROVERS },
};

/**
 * What the Orchestrator holds to check the kept values against: its own Access and account values (its env) and the
 * Client ID of its Access service token (`CI_CLIENT_ID`). A missing one refuses every value that needs it.
 */
export type DeployVarReference = Partial<Record<"ACCESS_TEAM_DOMAIN" | "ACCESS_AUD" | "CF_ACCOUNT_ID" | "CI_CLIENT_ID", string>> & {
  /**
   * Owner 2026-11-16: the identity lists' native source (D1 `platform_identities`, read by the Orchestrator). Absent,
   * `absent` or `seed`: the identity lists are carried from the active version as before.
   */
  IDENTITIES?: IdentitySource;
};

/** Where the identity lists of one Worker's new version come from, for the deploy outcome (never a value). */
export type IdentityVarsOrigin = "active_version" | "identity_table" | "identity_source_invalid";

/** keptDeployVars' answer: the values the new version must bind, and which of them differ from the active version. */
export interface KeptDeployVars {
  vars: Record<string, string>;
  /** Owner 2026-11-16: the names whose expected text (from the identity table) differs from the active version's. */
  changed?: string[];
  /** Owner 2026-11-16: set when the Worker carries identity lists and an identity source was given. */
  identities?: IdentityVarsOrigin;
}

type Binding = { type?: unknown; name?: unknown; text?: unknown };

/**
 * The deploy-time values one Worker's new version must carry, read from its active version's bindings. Refused
 * (the reason names the variable, never its value):
 *   - `deploy_vars_unknown:<service>`: the Worker is not in DEPLOY_VARS (a new Worker: its workflow sets them);
 *   - `active_bindings_unreadable`;
 *   - `deploy_var_unsourced:<NAME>`: the active version does not have it, so no platform source holds the value;
 *   - `deploy_var_not_plain:<NAME>`: it is bound, but not as the `plain_text` the workflow's `--var` writes;
 *   - `deploy_var_malformed:<NAME>`: not the shape the workflow's scripts produce;
 *   - `deploy_var_reference_missing:<NAME>`: the Orchestrator lacks the value to check it against;
 *   - `deploy_var_mismatch:<NAME>`: another value than the Orchestrator's own, or an identity list that does not
 *     start with the Orchestrator's service token Client ID.
 *
 * Owner 2026-11-16: with an owner-saved identity source (`reference.IDENTITIES.status === "owner"`) the identity lists'
 * expected text is built from it (identityVarValues, the CI Client ID first) and checked like a kept value; the active
 * version must still bind each once as `plain_text` (the deploy replaces a value, it never adds one), and `changed`
 * names those whose active text differs. With an invalid or unreadable source they are carried and checked as before
 * (`identities: "identity_source_invalid"`): an invalid row never reaches a Worker.
 */
export function keptDeployVars(unit: string, service: string, activeBindings: unknown, reference: DeployVarReference): KeptDeployVars | { reason: string } {
  const names = DEPLOY_VARS[unit]?.[service];
  if (!names) return { reason: `deploy_vars_unknown:${service}` };
  if (!Array.isArray(activeBindings)) return { reason: "active_bindings_unreadable" };
  const source = reference.IDENTITIES;
  const fromTable = source?.status === "owner" ? source : null;
  const carriesIdentities = names.some(isIdentityVar);
  let table: Record<string, string> | null = null;
  if (fromTable && carriesIdentities) {
    if (!reference.CI_CLIENT_ID) return { reason: `deploy_var_reference_missing:${names.find(isIdentityVar)}` };
    table = identityVarValues(fromTable, reference.CI_CLIENT_ID);
  }
  const vars: Record<string, string> = {};
  const changed: string[] = [];
  for (const name of names) {
    const found = (activeBindings as Binding[]).filter((b) => b?.name === name);
    if (found.length === 0) return { reason: `deploy_var_unsourced:${name}` };
    if (found.length !== 1 || found[0].type !== "plain_text" || typeof found[0].text !== "string") return { reason: `deploy_var_not_plain:${name}` };
    const active = found[0].text;
    const text = table && isIdentityVar(name) ? table[name] : active;
    const src = DEPLOY_VAR_SOURCES[name];
    if (!src || !src.format.test(text)) return { reason: `deploy_var_malformed:${name}` };
    if (src.native !== "active_version") {
      const want = src.native === "active_version_and_ci_token" ? reference.CI_CLIENT_ID : reference[name as "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD" | "CF_ACCOUNT_ID"];
      if (!want) return { reason: `deploy_var_reference_missing:${name}` };
      const got = src.native === "active_version_and_ci_token" ? text.split(",")[0] : text;
      if (got !== want) return { reason: `deploy_var_mismatch:${name}` };
    }
    if (text !== active) changed.push(name);
    vars[name] = text;
  }
  if (!source || !carriesIdentities || source.status === "absent" || source.status === "seed") return { vars };
  if (table) return { vars, ...(changed.length ? { changed } : {}), identities: "identity_table" };
  return { vars, identities: "identity_source_invalid" };
}

/**
 * Values that name the same thing must agree across the Workers of one unit (one workflow run sets them all from
 * the same Environment). `deploy_var_inconsistent:<NAME>` otherwise: a dashboard edit on one Worker, which the
 * native path must not spread or undo.
 */
export function deployVarsConsistent(kept: ReadonlyArray<Record<string, string>>): string | null {
  const seen = new Map<string, string>();
  for (const vars of kept) {
    for (const [name, text] of Object.entries(vars)) {
      // DEPLOY_ALLOWED_IDENTITIES is OPERATOR_IDENTITIES under another name (deploy-deployment-orchestrator.yml).
      const key = name === "DEPLOY_ALLOWED_IDENTITIES" ? "OPERATOR_IDENTITIES" : name;
      const prior = seen.get(key);
      if (prior !== undefined && prior !== text) return `deploy_var_inconsistent:${name}`;
      seen.set(key, text);
    }
  }
  return null;
}

/**
 * After the upload, before traffic: the new version binds every kept value as `plain_text` with exactly the kept
 * text. `deploy_var_missing:<NAME>` or `deploy_var_differs:<NAME>` otherwise; unreadable fails closed.
 */
export function verifyDeployVars(kept: Readonly<Record<string, string>>, uploadedBindings: unknown): { ok: true } | { ok: false; reason: string } {
  if (!Array.isArray(uploadedBindings)) return { ok: false, reason: "uploaded_bindings_unreadable" };
  for (const [name, text] of Object.entries(kept)) {
    const found = (uploadedBindings as Binding[]).filter((b) => b?.name === name);
    if (found.length === 0) return { ok: false, reason: `deploy_var_missing:${name}` };
    if (found.length !== 1 || found[0].type !== "plain_text" || found[0].text !== text) return { ok: false, reason: `deploy_var_differs:${name}` };
  }
  return { ok: true };
}

/**
 * Owner 2026-11-16, the code-only upload of a changed value: the active version's binding records with the changed
 * names' text replaced. Its `plain_text` records are what the upload sends (VersionMetadata.plain_text), and the whole
 * list is the binding set the new version must have (bindingSetOf), so nothing else may differ.
 */
export function withDeployVarText(activeBindings: unknown, vars: Readonly<Record<string, string>>, changed: readonly string[]): Array<Record<string, unknown>> {
  if (!Array.isArray(activeBindings)) throw new Error("active_bindings_unreadable");
  const out = (activeBindings as Array<Record<string, unknown>>).map((b) => ({ ...b }));
  for (const name of changed) {
    const found = out.filter((b) => b?.name === name);
    if (found.length !== 1 || found[0].type !== "plain_text" || typeof vars[name] !== "string") throw new Error(`deploy_var_not_plain:${name}`);
    found[0].text = vars[name];
  }
  return out;
}

/** The `plain_text` records of a binding list, as an upload sends them. */
export function plainTextBindings(bindings: ReadonlyArray<Record<string, unknown>>): Array<{ type: "plain_text"; name: string; text: string }> {
  return bindings.filter((b) => b.type === "plain_text").map((b) => {
    if (typeof b.name !== "string" || typeof b.text !== "string") throw new Error("plain_text_binding_unreadable");
    return { type: "plain_text" as const, name: b.name, text: b.text };
  });
}

/**
 * Owner 2026-11-16, a configuration plan with a changed value: the plan's binding kept verbatim from the active version
 * gets the new text, so the upload sends it and verifyPlannedBindings requires it. A changed name the plan does not keep
 * from the active version (`deploy_var_unplanned:<NAME>`) stops the deploy: the plan would build it from config.
 */
export function withPlannedDeployVars<P extends { bindings: Array<{ type: string; name: string; [field: string]: unknown }>; sources: Record<string, "active" | "config"> }>(
  plan: P, vars: Readonly<Record<string, string>>, changed: readonly string[],
): P {
  const bindings = plan.bindings.map((b) => ({ ...b }));
  for (const name of changed) {
    const found = bindings.filter((b) => b.type === "plain_text" && b.name === name);
    if (found.length !== 1 || plan.sources[`plain_text:${name}`] !== "active" || typeof vars[name] !== "string") throw new Error(`deploy_var_unplanned:${name}`);
    found[0].text = vars[name];
  }
  return { ...plan, bindings };
}
