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
// Values are never logged or audited; the outcome names the variables only.
//
// The checks run once the owner has given the Orchestrator the Access service token (CF_ACCESS_CLIENT_ID and
// CF_ACCESS_CLIENT_SECRET, native-smoke.ts): one owner action switches on gate 4's Access checks, the values and the
// probes together. Before that the earlier rule applies alone (kept verbatim; the digest or the plan check).
//
// What this cannot do: change a value. A new operator or approver email (ACCESS_ALLOWED_EMAILS) or a new CI
// service token lives only in the GitHub Environment; it needs the owner (docs/GITHUB-CUTOVER.md, gate 4).

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

const EMAIL = "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}";
const CLIENT_ID = "[A-Za-z0-9._-]+";
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
export type DeployVarReference = Partial<Record<"ACCESS_TEAM_DOMAIN" | "ACCESS_AUD" | "CF_ACCOUNT_ID" | "CI_CLIENT_ID", string>>;

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
 */
export function keptDeployVars(unit: string, service: string, activeBindings: unknown, reference: DeployVarReference): { vars: Record<string, string> } | { reason: string } {
  const names = DEPLOY_VARS[unit]?.[service];
  if (!names) return { reason: `deploy_vars_unknown:${service}` };
  if (!Array.isArray(activeBindings)) return { reason: "active_bindings_unreadable" };
  const vars: Record<string, string> = {};
  for (const name of names) {
    const found = (activeBindings as Binding[]).filter((b) => b?.name === name);
    if (found.length === 0) return { reason: `deploy_var_unsourced:${name}` };
    if (found.length !== 1 || found[0].type !== "plain_text" || typeof found[0].text !== "string") return { reason: `deploy_var_not_plain:${name}` };
    const text = found[0].text;
    const src = DEPLOY_VAR_SOURCES[name];
    if (!src || !src.format.test(text)) return { reason: `deploy_var_malformed:${name}` };
    if (src.native !== "active_version") {
      const want = src.native === "active_version_and_ci_token" ? reference.CI_CLIENT_ID : reference[name as keyof DeployVarReference];
      if (!want) return { reason: `deploy_var_reference_missing:${name}` };
      const got = src.native === "active_version_and_ci_token" ? text.split(",")[0] : text;
      if (got !== want) return { reason: `deploy_var_mismatch:${name}` };
    }
    vars[name] = text;
  }
  return { vars };
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
