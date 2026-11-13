// ADR-0012 G6 gate 9 (docs/GITHUB-CUTOVER.md): Cloudflare Access provisioning without provision-access.yml. The owner
// created the secret CF_ACCESS_TOKEN on this Worker (2026-11-13: "done namanya CF_ACCESS_TOKEN"), with Access: Apps and
// Policies Edit, Access: Organizations, Identity Providers, and Groups Edit, and Access: Service Tokens Read.
//
// It converges the one Access application `cryptophys-cloud-platform` to the workflow's definition:
//   - destinations: every platform Worker (destination type `worker`, by its script tag), the public hostnames and the
//     public paths, exactly the workflow's PLATFORM_WORKERS / PUBLIC_HOSTNAMES / PUBLIC_PATHS (a test keeps them equal);
//   - policies: `ci-service-token` (Service Auth), `platform-operators` (allow: the operator emails plus the Access group
//     cryptophys-nexus-accounts) and `external-agents` (Service Auth for the tokens named cryptophys-agent-*);
//   - the allowed identity providers (Google, Microsoft Entra ID or OIDC, one-time PIN) and the session settings.
//
// What it never decides by itself (fail closed instead):
//   - who is an operator: the emails are kept exactly as the live `platform-operators` policy has them (the
//     workflow's ACCESS_ALLOWED_EMAILS is a GitHub variable); people are added through the Console's Users page,
//     which manages the group's members;
//   - which service token is CI's: kept from the live `ci-service-token` policy, and it must still exist;
//   - creating the application or the group: both must already exist (the workflow created them).
//
// The plan is read-only. Applying it is the critical consensus action `change_access`: it runs only after the owner's
// approval click, and only if the plan is still exactly the one approved (its digest). A platform Worker that does not
// exist yet is first created as a private 503 stub with workers.dev and previews disabled, as the workflow's bootstrap
// does, so Access protects it before its first deploy. After the update the application is read back and must equal
// the plan. The workflow's live probes through Access (the CI token's secret) are not repeated: the Orchestrator does
// not hold that secret.

const API = "https://api.cloudflare.com/client/v4";

export const ACCESS_APP_NAME = "cryptophys-cloud-platform";
/** The workflow's PLATFORM_WORKERS, PUBLIC_HOSTNAMES and PUBLIC_PATHS (test NA1 keeps them equal). */
export const PLATFORM_WORKERS = [
  "cryptophys-platform-api", "cryptophys-deployment-orchestrator", "cryptophys-platform-registry",
  "cryptophys-policy-engine", "cryptophys-drift-detector", "cryptophys-audit-ledger", "cryptophys-recovery-manager",
  "cryptophys-ai-kernel", "cryptophys-console", "cryptophys-forge",
] as const;
export const PUBLIC_HOSTNAMES = ["nexus.cryptophys.work"] as const;
export const PUBLIC_PATHS = ["ai.cryptophys.work/api/*"] as const;
export const NEXUS_GROUP = "cryptophys-nexus-accounts";
const AGENT_TOKEN_PREFIX = "cryptophys-agent-";
const IDP_TYPES = new Set(["google", "azureAD", "oidc", "onetimepin"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[0-9a-f-]{20,64}$/;
const EMAIL = /^[^@\s]{1,100}@[^@\s]{1,100}\.[^@\s]{1,40}$/;

type Json = Record<string, unknown>;
export interface AccessPolicyBody { name: string; decision: "allow" | "non_identity"; precedence: number; include: Json[] }
export interface AccessAppBody {
  name: string;
  type: "self_hosted";
  destinations: Array<{ type: "worker"; worker_id: string } | { type: "public"; uri: string }>;
  session_duration: string;
  app_launcher_visible: boolean;
  auto_redirect_to_identity: boolean;
  policies: AccessPolicyBody[];
  allowed_idps?: string[];
}

/** One Cloudflare API caller. Every method throws `cloudflare_api_<status>` on an unexpected answer. */
export class CloudflareApi {
  private readonly token: string;
  private readonly account: string;
  private readonly fetcher: typeof fetch;
  constructor(token: string, account: string, fetcher: typeof fetch = fetch) {
    this.token = token;
    this.account = account;
    // Called as a plain function (see CloudflareWorkers): workerd throws "Illegal invocation" otherwise.
    this.fetcher = (input, init) => fetcher(input, init);
  }
  async call<T>(method: string, path: string, body?: unknown, multipart?: FormData): Promise<{ result: T; info?: { total_pages?: number } }> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetcher(`${API}/accounts/${this.account}/${path}`, { method, headers, body: multipart ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const json = await res.json().catch(() => null) as { success?: boolean; result?: T; result_info?: { total_pages?: number }; errors?: Array<{ code?: number }> } | null;
    if (!res.ok || json?.success !== true) throw new Error(`cloudflare_api_${res.status}_${(json?.errors ?? []).map((e) => e?.code).join("-") || "error"}`);
    return { result: json.result as T, info: json.result_info };
  }
  /** Every page of a list (`per_page` 50, at most 40 pages). */
  async list<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 40; page++) {
      const r = await this.call<T[]>("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=50&page=${page}`);
      if (!Array.isArray(r.result)) throw new Error("cloudflare_api_list_unreadable");
      out.push(...r.result);
      if (page >= (r.info?.total_pages ?? 1)) return out;
    }
    throw new Error("cloudflare_api_list_too_long");
  }
}

/** The tag-independent view the owner approves: Workers by name, policies by name, ids sorted. */
export interface AccessView {
  destinations: string[];
  policies: Array<{ name: string; decision: string; precedence: number; include: string[] }>;
  allowed_idps: string[];
  session_duration: string;
  app_launcher_visible: boolean;
  auto_redirect_to_identity: boolean;
}

export type AccessPlan =
  | { ok: true; in_sync: boolean; digest: string; app_id: string; aud: string; changes: string[]; missing_workers: string[]; body: AccessAppBody | null; desired: AccessView }
  | { ok: false; reason: string; detail?: string };

function includeKey(i: Json): string {
  const e = i as { email?: { email?: unknown }; group?: { id?: unknown }; service_token?: { token_id?: unknown } };
  if (typeof e.email?.email === "string") return `email:${e.email.email.toLowerCase()}`;
  if (typeof e.group?.id === "string") return `group:${e.group.id}`;
  if (typeof e.service_token?.token_id === "string") return `service_token:${e.service_token.token_id}`;
  return `other:${JSON.stringify(i).slice(0, 200)}`;
}
function destinationKey(d: Json, nameByTag: Map<string, string>): string {
  if (d?.type === "worker" && typeof d.worker_id === "string") return `worker:${nameByTag.get(d.worker_id) ?? `tag-${d.worker_id}`}`;
  if (d?.type === "public" && typeof d.uri === "string") return `public:${d.uri}`;
  return `other:${JSON.stringify(d).slice(0, 200)}`;
}
function viewOf(app: Json, nameByTag: Map<string, string>, idpName: Map<string, string>): AccessView {
  const policies = (Array.isArray(app.policies) ? app.policies as Json[] : []).map((p) => ({
    name: String(p.name ?? ""), decision: String(p.decision ?? ""), precedence: Number(p.precedence ?? 0),
    include: (Array.isArray(p.include) ? p.include as Json[] : []).map(includeKey).sort(),
  })).sort((a, b) => a.precedence - b.precedence || a.name.localeCompare(b.name));
  return {
    destinations: (Array.isArray(app.destinations) ? app.destinations as Json[] : []).map((d) => destinationKey(d, nameByTag)).sort(),
    policies,
    allowed_idps: (Array.isArray(app.allowed_idps) ? app.allowed_idps as string[] : []).map((id) => idpName.get(id) ?? `idp-${id}`).sort(),
    session_duration: String(app.session_duration ?? ""),
    app_launcher_visible: app.app_launcher_visible === true,
    auto_redirect_to_identity: app.auto_redirect_to_identity === true,
  };
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function describe(current: AccessView, desired: AccessView): string[] {
  const changes: string[] = [];
  for (const d of desired.destinations) if (!current.destinations.includes(d)) changes.push(`add destination ${d}`);
  for (const d of current.destinations) if (!desired.destinations.includes(d)) changes.push(`remove destination ${d}`);
  for (const p of desired.policies) {
    const c = current.policies.find((x) => x.name === p.name);
    if (!c) { changes.push(`add policy ${p.name} (${p.include.length} include rule(s))`); continue; }
    if (c.decision !== p.decision) changes.push(`policy ${p.name}: decision ${c.decision} -> ${p.decision}`);
    if (c.precedence !== p.precedence) changes.push(`policy ${p.name}: precedence ${c.precedence} -> ${p.precedence}`);
    for (const i of p.include) if (!c.include.includes(i)) changes.push(`policy ${p.name}: add ${i}`);
    for (const i of c.include) if (!p.include.includes(i)) changes.push(`policy ${p.name}: remove ${i}`);
  }
  for (const c of current.policies) if (!desired.policies.some((p) => p.name === c.name)) changes.push(`remove policy ${c.name}`);
  for (const i of desired.allowed_idps) if (!current.allowed_idps.includes(i)) changes.push(`allow identity provider ${i}`);
  for (const i of current.allowed_idps) if (!desired.allowed_idps.includes(i)) changes.push(`disallow identity provider ${i}`);
  for (const k of ["session_duration", "app_launcher_visible", "auto_redirect_to_identity"] as const) {
    if (current[k] !== desired[k]) changes.push(`${k}: ${String(current[k])} -> ${String(desired[k])}`);
  }
  return changes;
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Read-only: the live application, the desired one, and what would change. `access` holds CF_ACCESS_TOKEN, `scripts`
 * CF_DEPLOY_TOKEN (the script list for the Workers' tags). Never throws: a failure to read is a refusal.
 */
export async function planAccess(access: CloudflareApi, scripts: CloudflareApi): Promise<AccessPlan> {
  try {
    const scriptList = (await scripts.call<Array<{ id?: unknown; tag?: unknown }>>("GET", "workers/scripts")).result;
    if (!Array.isArray(scriptList)) return { ok: false, reason: "script_list_unreadable" };
    const tagByName = new Map<string, string>();
    for (const s of scriptList) if (typeof s?.id === "string" && typeof s.tag === "string" && /^[0-9a-f]{32}$/.test(s.tag)) tagByName.set(s.id, s.tag);
    const nameByTag = new Map([...tagByName].map(([n, t]) => [t, n] as const));
    const missing = PLATFORM_WORKERS.filter((w) => !tagByName.has(w));

    const apps = (await access.list<Json>("access/apps")).filter((a) => a?.name === ACCESS_APP_NAME);
    if (apps.length !== 1) return { ok: false, reason: apps.length ? "more_than_one_access_application" : "access_application_missing" };
    const app = apps[0];
    const appId = String(app.id ?? ""), aud = String(app.aud ?? "");
    if (!ID.test(appId) || !aud) return { ok: false, reason: "access_application_unreadable" };
    const livePolicies = Array.isArray(app.policies) ? app.policies as Json[] : [];

    // The CI token: kept from the live policy, and it must still exist.
    const tokens = await access.list<{ id?: unknown; name?: unknown }>("access/service_tokens");
    const ci = livePolicies.find((p) => p.name === "ci-service-token");
    const ciIncludes = Array.isArray(ci?.include) ? (ci!.include as Json[]).map(includeKey) : [];
    const ciToken = ciIncludes.length === 1 && ciIncludes[0].startsWith("service_token:") ? ciIncludes[0].slice("service_token:".length) : null;
    if (!ciToken || !UUID.test(ciToken)) return { ok: false, reason: "ci_service_token_policy_unreadable" };
    if (!tokens.some((t) => t?.id === ciToken)) return { ok: false, reason: "ci_service_token_missing" };
    const agentTokens = [...new Set(tokens.filter((t) => typeof t?.name === "string" && t.name.startsWith(AGENT_TOKEN_PREFIX) && typeof t.id === "string" && UUID.test(t.id)).map((t) => t.id as string))].sort();

    // The operators: kept exactly as the live policy has them.
    const ops = livePolicies.find((p) => p.name === "platform-operators");
    const emails = (Array.isArray(ops?.include) ? ops!.include as Json[] : []).map(includeKey).filter((k) => k.startsWith("email:")).map((k) => k.slice(6));
    if (!emails.length || !emails.every((e) => EMAIL.test(e))) return { ok: false, reason: "operator_emails_unreadable" };

    const groups = (await access.list<{ id?: unknown; name?: unknown }>("access/groups")).filter((g) => g?.name === NEXUS_GROUP);
    if (groups.length !== 1 || typeof groups[0].id !== "string" || !ID.test(groups[0].id)) return { ok: false, reason: groups.length ? "access_group_ambiguous" : "access_group_missing" };
    const group = groups[0].id as string;

    const idpList = (await access.call<Array<{ id?: unknown; type?: unknown; name?: unknown }>>("GET", "access/identity_providers")).result;
    if (!Array.isArray(idpList)) return { ok: false, reason: "identity_providers_unreadable" };
    const idps = idpList.filter((i) => typeof i?.id === "string" && IDP_TYPES.has(String(i.type)));
    const idpName = new Map(idpList.filter((i) => typeof i?.id === "string").map((i) => [i.id as string, `${String(i.type)}:${String(i.name ?? "")}`] as const));

    const policies: AccessPolicyBody[] = [
      { name: "ci-service-token", decision: "non_identity", precedence: 1, include: [{ service_token: { token_id: ciToken } }] },
      { name: "platform-operators", decision: "allow", precedence: 2, include: [...emails.map((email) => ({ email: { email } })), { group: { id: group } }] },
      ...(agentTokens.length ? [{ name: "external-agents", decision: "non_identity" as const, precedence: 3, include: agentTokens.map((token_id) => ({ service_token: { token_id } })) }] : []),
    ];
    const desiredApp: Json = {
      name: ACCESS_APP_NAME, type: "self_hosted",
      destinations: [
        ...PLATFORM_WORKERS.map((w) => ({ type: "worker", worker_id: tagByName.get(w) ?? `missing:${w}` })),
        ...PUBLIC_HOSTNAMES.map((uri) => ({ type: "public", uri })),
        ...PUBLIC_PATHS.map((uri) => ({ type: "public", uri })),
      ],
      session_duration: "8h", app_launcher_visible: false, auto_redirect_to_identity: false, policies,
      ...(idps.length ? { allowed_idps: idps.map((i) => i.id as string) } : {}),
    };
    // A Worker still to be bootstrapped is named, not tagged, in the view, so the digest survives its creation.
    const viewNames = new Map([...nameByTag, ...missing.map((w) => [`missing:${w}`, w] as const)]);
    const current = viewOf(app, nameByTag, idpName);
    const desired = viewOf(desiredApp, viewNames, idpName);
    const changes = [...missing.map((w) => `create private stub ${w} (workers.dev and previews disabled)`), ...describe(current, desired)];
    const digest = await sha256(JSON.stringify({ app: appId, current, desired }));
    const body = missing.length ? null : desiredApp as unknown as AccessAppBody;
    return { ok: true, in_sync: changes.length === 0, digest, app_id: appId, aud, changes, missing_workers: [...missing], body, desired };
  } catch (err) {
    return { ok: false, reason: String((err as Error)?.message ?? err).slice(0, 120) };
  }
}

/** The workflow's bootstrap: an inert 503 stub with workers.dev and previews disabled. Never touches an existing Worker. */
export async function bootstrapStub(scripts: CloudflareApi, name: string): Promise<void> {
  if (!(PLATFORM_WORKERS as readonly string[]).includes(name)) throw new Error("not_a_platform_worker");
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify({ main_module: "stub.mjs", compatibility_date: "2026-11-01" })], { type: "application/json" }));
  form.append("stub.mjs", new Blob(['export default { fetch() { return new Response(\'{"error":"not_deployed"}\', { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } }); } };'], { type: "application/javascript+module" }), "stub.mjs");
  await scripts.call("PUT", `workers/scripts/${name}`, undefined, form);
  await scripts.call("POST", `workers/scripts/${name}/subdomain`, { enabled: false, previews_enabled: false });
}

export interface AccessRun { ok: boolean; reason?: string; changed: boolean; steps: string[]; changes?: string[] }

/**
 * Apply an approved plan: plan again, require the approved digest, bootstrap any missing Worker, plan again (now with
 * its tag), update the application, read it back and require it to equal the plan. Never throws.
 */
export async function applyAccess(access: CloudflareApi, scripts: CloudflareApi, approvedDigest: string): Promise<AccessRun> {
  const steps: string[] = [];
  let changed = false;
  const fail = (reason: string): AccessRun => ({ ok: false, reason, changed, steps });
  try {
    let plan = await planAccess(access, scripts);
    if (!plan.ok) return fail(`refused: ${plan.reason}`);
    if (plan.digest !== approvedDigest) return fail("plan_changed_since_approval");
    if (plan.in_sync) return { ok: true, changed: false, steps: ["already in sync"], changes: [] };
    const approvedChanges = plan.changes;
    for (const w of plan.missing_workers) {
      await bootstrapStub(scripts, w);
      changed = true;
      steps.push(`bootstrapped ${w}`);
    }
    if (plan.missing_workers.length) {
      plan = await planAccess(access, scripts);
      if (!plan.ok) return fail(`refused after bootstrap: ${plan.reason}`);
      if (plan.digest !== approvedDigest || plan.missing_workers.length || !plan.body) return fail("plan_changed_after_bootstrap");
    }
    const r = await access.call<{ id?: unknown; aud?: unknown }>("PUT", `access/apps/${plan.app_id}`, plan.body);
    changed = true;
    steps.push("updated the application");
    if (r.result?.id !== plan.app_id || r.result?.aud !== plan.aud) return fail("application_identity_changed");
    const after = await planAccess(access, scripts);
    if (!after.ok) return fail(`unverifiable: ${after.reason}`);
    if (!after.in_sync || !same(after.desired, plan.desired)) return fail(`not_in_sync_after_update: ${after.changes.slice(0, 5).join("; ")}`);
    steps.push("verified in sync");
    return { ok: true, changed, steps, changes: approvedChanges };
  } catch (err) {
    return fail(String((err as Error)?.message ?? err).slice(0, 120));
  }
}
