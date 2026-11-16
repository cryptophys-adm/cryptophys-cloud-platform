// Owner 2026-11-16: the deploy-time identity lists get a native source in D1 (migration 0073, platform_identities).
// The owner edits the ACCESS_ALLOWED_EMAILS emails on the Console's Users page (an owner's click, audited); the native
// deploy builds OPERATOR_IDENTITIES / DEPLOY_ALLOWED_IDENTITIES (`<CI Client ID>,<emails>`) and APPROVER_IDENTITIES from
// an owner-saved row, writes a changed value as the version's plain_text binding and verifies it before traffic. No row
// and the one-time seed carry the active values exactly as before; an invalid row is never deployed and is an Owner page
// problem (identity_source_invalid).
//
// Runs in the Forge: no npm package imports, no node:test mock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, CI_JWT, OPERATOR_EMAIL, OPERATOR_JWT, OUTSIDER_JWT, baseEnv, call, migratedDb, req, signAccessJwt,
} from "./harness.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import {
  IDENTITY_EMAIL, MAX_IDENTITY_EMAILS, identitySourceOf, identityVarValues, normalizeIdentityEmails, readIdentitySource, seedEmails, seedIdentitySource,
  type IdentityRow, type IdentitySource,
} from "../src/identity-source.ts";
import registry from "../../platform-registry/src/index.ts";
import { gate4Deploy, seedIdentities } from "../../deployment-orchestrator/src/index.ts";
import {
  DEPLOY_VARS, DEPLOY_VAR_SOURCES, deployVarsConsistent, keptDeployVars, plainTextBindings, withDeployVarText, withPlannedDeployVars, type DeployVarReference,
} from "../../deployment-orchestrator/src/deploy-vars.ts";
import { executeNativeDeploy, type BundleWorker, type PlannedService } from "../../deployment-orchestrator/src/native-deploy.ts";
import { bindingSetOf, CloudflareWorkers, KEEP_BINDINGS, type VersionMetadata } from "../../deployment-orchestrator/src/native-rollback.ts";
import { verifyPlannedBindings } from "../../deployment-orchestrator/src/config-diff.ts";
import { unhandledProblems } from "../../ai-kernel/src/owner-inbox.ts";
import { UI_ROUTES } from "../../console/src/ui/routes.ts";
import { CONSOLE_ALLOW_LIST } from "../../console/src/index.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
type Db = ReturnType<typeof migratedDb>;

const ACCOUNT = "a".repeat(32);
const AUD = "f".repeat(64);
const TEAM = "cryptophys.cloudflareaccess.com";
const CLIENT = "ci0123456789abcdef.access";
const OLD = "0c".repeat(20);
const NEW = "4d".repeat(20);
const TAG = NEW.slice(0, 12);
const REF: DeployVarReference = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, CF_ACCOUNT_ID: ACCOUNT, CI_CLIENT_ID: CLIENT };
/** What the workflows deployed (access-identities.sh with ACCESS_ALLOWED_EMAILS = ops@example.com,owner@example.com). */
const EMAILS = ["ops@example.com", "owner@example.com"];
const OPS = `${CLIENT},${EMAILS.join(",")}`;
const APPROVERS = EMAILS.join(",");
const VALUES: Record<string, string> = {
  ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, OPERATOR_IDENTITIES: OPS, DEPLOY_ALLOWED_IDENTITIES: OPS, APPROVER_IDENTITIES: APPROVERS, CF_ACCOUNT_ID: ACCOUNT,
};
const NEW_EMAILS = ["owner@example.com", "new.operator@example.com"];
const owned = (emails = NEW_EMAILS, revision = 2): IdentitySource =>
  ({ status: "owner", operator_emails: emails, approver_emails: emails, revision, updated_by: "owner@example.com", updated_at: "2026-11-16T09:00:00.000Z" });
const seeded = (emails = EMAILS): IdentitySource =>
  ({ status: "seed", operator_emails: emails, approver_emails: emails, revision: 1, updated_by: "agent:deployment-orchestrator", updated_at: "2026-11-16T03:10:00.000Z" });

function activeBindings(unit: string, service: string, override: Record<string, string | null> = {}): Array<Record<string, unknown>> {
  const vars = (DEPLOY_VARS[unit][service] ?? []).flatMap((n) => {
    const v = n in override ? override[n] : VALUES[n];
    return v === null ? [] : [{ type: "plain_text", name: n, text: v }];
  });
  return [
    { type: "d1", name: "DB", id: "11111111-2222-3333-4444-555555555555" },
    { type: "secret_text", name: "CF_DEPLOY_TOKEN" },
    { type: "version_metadata", name: "CF_VERSION_METADATA" },
    { type: "plain_text", name: "SERVICE_NAME", text: service },
    ...vars,
  ];
}

// ---------------------------------------------------------------- a fake Cloudflare that honours the upload metadata
/**
 * A version upload as Cloudflare builds it: the sent bindings, plus the previous version's bindings of every type in
 * keep_bindings that no sent binding names. `ignorePlainText` drops what the upload sent (a Cloudflare that kept the old
 * text), so the verification before traffic must catch it; `ignoreServices` likewise for the declared service bindings
 * (a Cloudflare that kept the active version's).
 */
function fakeCf(bindings: (svc: string) => Array<Record<string, unknown>>, opts: { ignorePlainText?: boolean; ignoreServices?: boolean } = {}) {
  let n = 0;
  const id = () => `${String(++n).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const scripts = new Map<string, { active: { version_id: string; percentage: number }[]; versions: Map<string, Array<Record<string, unknown>>>; latest: string }>();
  const script = (s: string) => {
    if (!scripts.has(s)) { const v = id(); scripts.set(s, { active: [{ version_id: v, percentage: 100 }], versions: new Map([[v, bindings(s)]]), latest: v }); }
    return scripts.get(s)!;
  };
  const calls: string[] = [];
  const uploads: VersionMetadata[] = [];
  const cf = {
    calls, scripts, script, uploads,
    async active(s: string) { calls.push(`active ${s}`); return structuredClone(script(s).active); },
    async version(s: string, v: string) { const b = script(s).versions.get(v); if (!b) throw new Error("cloudflare_api_404_10007"); return { id: v, resources: { bindings: structuredClone(b) } }; },
    async versionBindingSet(s: string, v: string) { return bindingSetOf(structuredClone(script(s).versions.get(v)!)); },
    async uploadVersion(s: string, _module: string, _text: string, metadata: VersionMetadata) {
      calls.push(`upload ${s}`);
      uploads.push(structuredClone(metadata));
      const sc = script(s);
      const prev = sc.versions.get(sc.latest)!;
      // 2026-11-16: a code-only upload may also send the declared service bindings (then `service` is not kept).
      const plain = opts.ignorePlainText ? undefined : metadata.plain_text;
      const services = opts.ignoreServices ? undefined : metadata.services;
      const sent = (metadata.config?.bindings ?? [...(services ?? []), ...(plain ?? [])]) as Array<Record<string, unknown>>;
      const keep: readonly string[] = metadata.config
        ? metadata.config.keep_bindings
        : KEEP_BINDINGS.filter((t) => !(plain && t === "plain_text") && !(services && t === "service"));
      const next = [...prev.filter((b) => keep.includes(String(b.type)) && !sent.some((x) => x.name === b.name)), ...structuredClone(sent)];
      const v = id();
      sc.versions.set(v, next);
      sc.latest = v;
      return v;
    },
    async deploy(s: string, versions: { version_id: string; percentage: number }[]) { calls.push(`deploy ${s}`); script(s).active = structuredClone(versions); },
  };
  return cf;
}
const liveText = (cf: ReturnType<typeof fakeCf>, s: string, name: string) => {
  const sc = cf.script(s);
  return sc.versions.get(sc.active[0].version_id)!.find((b) => b.name === name)?.text;
};

async function sha256(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function plannedFor(services: string[], extraToml = "") {
  const modules = new Map<string, string>();
  const plan: PlannedService[] = [];
  for (const service of services) {
    const text = `export default { fetch() { return new Response(${JSON.stringify(service)}); } };`;
    modules.set(`bundles/${NEW}/${service}.mjs`, text);
    // 2026-11-16 (binding props): the stored wrangler.toml, whose declared service bindings the executor compares
    // with the active version's (none unless `extraToml` declares some).
    const config = `name = "${service}"\nmain = "src/worker.ts"\ncompatibility_date = "2026-11-01"\n${extraToml}`;
    modules.set(`bundles/${NEW}/config/${service}.toml`, config);
    const worker: BundleWorker = {
      name: service, module: `${service}.mjs`, main_module: `${service}.mjs`, sha256: await sha256(text), bytes: new TextEncoder().encode(text).length,
      config_sha256: await sha256(config), compatibility_date: "2026-11-01", compatibility_flags: [], single_module: true, assets: false, external: [], limits: false, modules: null, config: `config/${service}.toml`,
    };
    plan.push({ service, worker, running_tag: OLD.slice(0, 12) });
  }
  const bundles = { async get(k: string) { const t = modules.get(k); return t === undefined ? null : { text: async () => t }; }, async list() { return { objects: [], truncated: false as const }; } };
  return { plan, bundles };
}
function deployEnv(bundles: Awaited<ReturnType<typeof plannedFor>>["bundles"], db?: Db) {
  return {
    DRIFT: { async probeService() { return { reachable: true, healthy: true, version_tag: TAG, error: null }; } },
    REGISTRY: { async recordRollback() { return { desired_version: "" }; }, async recordNativeDeploy() { return { desired_version: TAG, services: [] }; } },
    BUNDLES: bundles,
    ...(db ? { DB: db } : {}),
  };
}
const UNIT = ["cryptophys-policy-engine", "cryptophys-platform-registry"];

// ---------------------------------------------------------------- the registry
const regEnv = (db: Db) => baseEnv("cryptophys-platform-registry", db, { APPROVER_IDENTITIES: APPROVER_EMAIL });
const save = (db: Db, body: Record<string, unknown>, jwt: string | null = APPROVER_JWT) => call(registry, regEnv(db), req("POST", "/v1/identities", body, jwt));
const rowOf = (db: Db) => db.raw.prepare("SELECT * FROM platform_identities").all() as unknown as IdentityRow[];
const identityEvents = (db: Db) => db.raw.prepare("SELECT event_type, actor, outcome, payload_json FROM audit_events WHERE subject = 'platform_identities' ORDER BY rowid").all() as Array<{ event_type: string; actor: string; outcome: string; payload_json: string }>;

// ================================================================= 1. validation
test("IL-1. validation: ACCESS_ALLOWED_EMAILS semantics (lower case, deduplicated in first order, the one regex), strict limits, never empty", () => {
  // access-identities.test.sh's own input gives its own output.
  const n = normalizeIdentityEmails(" Ops@Example.com, second@example.com ops@example.com");
  assert.deepEqual(n, { emails: ["ops@example.com", "second@example.com"] });
  assert.deepEqual(identityVarValues({ operator_emails: (n as { emails: string[] }).emails, approver_emails: (n as { emails: string[] }).emails }, "abc123.access"),
    { OPERATOR_IDENTITIES: "abc123.access,ops@example.com,second@example.com", DEPLOY_ALLOWED_IDENTITIES: "abc123.access,ops@example.com,second@example.com", APPROVER_IDENTITIES: "ops@example.com,second@example.com" });
  assert.deepEqual(normalizeIdentityEmails(["B@x.io", "a@x.io", "b@x.io"]), { emails: ["b@x.io", "a@x.io"] });
  for (const [input, reason] of [
    ["", "identity_emails_empty"], [[], "identity_emails_empty"], [" , ,", "identity_emails_empty"],
    ["not-an-email", "identity_email_invalid"], ["a@b", "identity_email_invalid"], ["a@b.c", "identity_email_invalid"], [["a@x.io,b@x.io"], "identity_email_invalid"],
    ["<script>@x.io", "identity_email_invalid"], [`${"a".repeat(250)}@x.io`, "identity_email_invalid"],
    [[1], "identity_emails_invalid"], [null, "identity_emails_invalid"], [{ a: 1 }, "identity_emails_invalid"],
    [Array.from({ length: MAX_IDENTITY_EMAILS + 1 }, (_, i) => `u${i}@x.io`), "identity_emails_too_many"],
  ] as const) assert.deepEqual(normalizeIdentityEmails(input), { reason }, JSON.stringify(input).slice(0, 60));
  assert.ok("emails" in normalizeIdentityEmails(Array.from({ length: MAX_IDENTITY_EMAILS }, (_, i) => `u${i}@x.io`)));
  // The same regex as the deployed values' format check.
  assert.equal(IDENTITY_EMAIL, "[a-z0-9._%+-]+@[a-z0-9.-]+\\.[a-z]{2,}");
  assert.ok(DEPLOY_VAR_SOURCES.APPROVER_IDENTITIES.format.source.includes(IDENTITY_EMAIL));
  assert.ok(read(".github/scripts/access-identities.sh").includes(`=~ ^${IDENTITY_EMAIL}$ ]]`), "access-identities.sh checks each email with the same regex");
  // A stored row is valid only in the canonical form the save writes; nothing is repaired.
  const row = (over: Partial<IdentityRow>): IdentityRow => ({ id: "access", operator_emails: APPROVERS, approver_emails: APPROVERS, source: "owner", revision: 1, updated_by: "o@x.io", updated_at: "t", ...over });
  assert.equal(identitySourceOf(null).status, "absent");
  assert.deepEqual(identitySourceOf(row({})), { status: "owner", operator_emails: EMAILS, approver_emails: EMAILS, revision: 1, updated_by: "o@x.io", updated_at: "t" });
  for (const [over, reason] of [
    [{ operator_emails: "Ops@example.com,owner@example.com", approver_emails: "Ops@example.com,owner@example.com" }, "identity_operator_emails_malformed"],
    [{ operator_emails: "ops@example.com,ops@example.com" }, "identity_operator_emails_malformed"],
    [{ operator_emails: "ops@example.com, owner@example.com" }, "identity_operator_emails_malformed"],
    [{ operator_emails: ",,,,,,", approver_emails: ",,,,,," }, "identity_operator_emails_malformed"],
    [{ approver_emails: "ops@example.com" }, "identity_lists_differ"],
    [{ approver_emails: "x" }, "identity_approver_emails_malformed"],
    [{ source: "agent" }, "identity_source_unknown"],
    [{ revision: 0 }, "identity_source_metadata"],
  ] as const) {
    const s = identitySourceOf(row(over as Partial<IdentityRow>));
    assert.equal(s.status, "invalid", JSON.stringify(over));
    assert.equal((s as { reason: string }).reason, reason, JSON.stringify(over));
  }
});

// ================================================================= 2. the owner-only write, audited
test("IL-2. only an owner writes the list: service tokens, agents' tokens, operators, approver accounts and outsiders are refused, before the body is read", async () => {
  const db = migratedDb();
  const body = { emails: [APPROVER_EMAIL, "second@cryptophys.work"], revision: null, confirm: "IDENTITIES" };
  db.raw.prepare("INSERT INTO platform_accounts (email, kind, privilege, status, created_by, created_at, updated_by, updated_at) VALUES ('acct.approver@cryptophys.work', 'admin', 'approver', 'active', 'o', 't', 'o', 't')").run();
  const accountApprover = await signAccessJwt({ email: "acct.approver@cryptophys.work" });
  const agentToken = await signAccessJwt({ common_name: "cryptophys-agent-aether.access" });
  for (const [who, jwt] of [["CI service token", CI_JWT], ["an agent's service token", agentToken], ["operator", OPERATOR_JWT], ["approver account", accountApprover], ["outsider", OUTSIDER_JWT]] as const) {
    const r = await save(db, { ...body, emails: [...body.emails, "acct.approver@cryptophys.work", OPERATOR_EMAIL] }, jwt);
    assert.deepEqual([r.status, r.body.error], [403, "owner_required"], who);
  }
  assert.equal((await save(db, body, null)).status, 403, "no Access JWT");
  assert.deepEqual(rowOf(db), [], "nothing written");
  assert.deepEqual(identityEvents(db), [], "nothing audited");
  // The owner's own refusals.
  const refused = async (b: Record<string, unknown>, status: number, error: string) => {
    const r = await save(db, b);
    assert.deepEqual([r.status, r.body.error], [status, error], JSON.stringify(b));
  };
  await refused({ ...body, confirm: "GRANT" }, 400, "confirmation_required");
  await refused({ ...body, confirm: undefined }, 400, "confirmation_required");
  await refused({ ...body, emails: [] }, 400, "identity_emails_empty");
  await refused({ ...body, emails: "" }, 400, "identity_emails_empty");
  await refused({ ...body, emails: [APPROVER_EMAIL, "bad@"] }, 400, "identity_email_invalid");
  await refused({ ...body, emails: Array.from({ length: 21 }, (_, i) => i ? `u${i}@x.io` : APPROVER_EMAIL) }, 400, "identity_emails_too_many");
  await refused({ ...body, emails: ["someone.else@cryptophys.work"] }, 400, "owner_not_in_list");
  await refused({ ...body, revision: 1 }, 409, "revision_conflict");
  await refused({ ...body, revision: "1" }, 400, "invalid_revision");
  assert.deepEqual(rowOf(db), []);
  // Reads: operators may see the list (emails, not secrets); outsiders may not.
  assert.equal((await call(registry, regEnv(db), req("GET", "/v1/identities", undefined, OUTSIDER_JWT))).status, 403);
  const empty = await call(registry, regEnv(db), req("GET", "/v1/identities", undefined, OPERATOR_JWT));
  assert.equal(empty.status, 200);
  assert.deepEqual([empty.body.source, empty.body.in_effect.uses, empty.body.migrated], [{ status: "absent" }, "active_version", true]);
  assert.ok(!JSON.stringify(empty.body).includes(CI_CLIENT_ID), "the Client ID is not shown");
  assert.equal((await call(registry, regEnv(db), req("PUT", "/v1/identities", body, APPROVER_JWT))).status, 405);
});

test("IL-3. the owner's save: normalized, written atomically with its audit event, revision-checked, a no-op save writes nothing", async () => {
  const db = migratedDb();
  const first = await save(db, { emails: ` ${APPROVER_EMAIL.toUpperCase()}, second@cryptophys.work ${APPROVER_EMAIL}`, revision: null, confirm: "IDENTITIES" });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual(first.body.source, { status: "owner", operator_emails: [APPROVER_EMAIL, "second@cryptophys.work"], approver_emails: [APPROVER_EMAIL, "second@cryptophys.work"], revision: 1, updated_by: APPROVER_EMAIL, updated_at: first.body.source.updated_at });
  assert.equal(first.body.in_effect.uses, "identity_table");
  assert.equal(first.body.warning, undefined);
  const [row] = rowOf(db);
  assert.deepEqual([row.operator_emails, row.approver_emails, row.source, row.revision, row.updated_by], [`${APPROVER_EMAIL},second@cryptophys.work`, `${APPROVER_EMAIL},second@cryptophys.work`, "owner", 1, APPROVER_EMAIL]);
  const [ev] = identityEvents(db);
  assert.deepEqual([ev.event_type, ev.actor, ev.outcome], ["identity_source.changed", APPROVER_EMAIL, "owner"]);
  assert.deepEqual(JSON.parse(ev.payload_json).approver_emails, [APPROVER_EMAIL, "second@cryptophys.work"]);
  assert.equal(JSON.parse(ev.payload_json).previous, null);
  // A second save names the revision it saw; a stale form is refused; the same list again writes nothing.
  const second = await save(db, { emails: [APPROVER_EMAIL], revision: 1, confirm: "IDENTITIES" });
  assert.deepEqual([second.status, second.body.source.revision, second.body.source.approver_emails], [200, 2, [APPROVER_EMAIL]]);
  assert.match(second.body.warning, /separation of duties/, "access-identities.sh's one-approver warning");
  const stale = await save(db, { emails: [APPROVER_EMAIL, "third@cryptophys.work"], revision: 1, confirm: "IDENTITIES" });
  assert.deepEqual([stale.status, stale.body.error, stale.body.revision], [409, "revision_conflict", 2]);
  const same = await save(db, { emails: [APPROVER_EMAIL], revision: 2, confirm: "IDENTITIES" });
  assert.deepEqual([same.status, same.body.unchanged], [200, true]);
  const events = identityEvents(db);
  assert.equal(events.length, 2);
  assert.deepEqual(JSON.parse(events[1].payload_json).previous, { source: "owner", revision: 1, approver_emails: [APPROVER_EMAIL, "second@cryptophys.work"], operator_emails: [APPROVER_EMAIL, "second@cryptophys.work"] });
  assert.equal((await verifyAuditChain(db)).valid, true);
  // The list and its history as the Console reads them.
  const got = await call(registry, regEnv(db), req("GET", "/v1/identities", undefined, OPERATOR_JWT));
  assert.deepEqual([got.body.source.status, got.body.source.revision, got.body.history.length, got.body.history[0].emails], ["owner", 2, 2, [APPROVER_EMAIL]]);
  assert.deepEqual(got.body.running_here, { approver_emails: [APPROVER_EMAIL] });
});

test("IL-4. nothing but the owner's save and the one-time seed writes the table; the Console route is the owner's with a typed phrase", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const f = join(dir, n);
      if (n === "node_modules" || n === "test" || n === "ui" || n === "dist" || n.startsWith(".")) continue;
      if (statSync(f).isDirectory()) walk(f);
      else if (f.endsWith(".ts")) files.push(f);
    }
  };
  walk(new URL("workers", ROOT).pathname);
  const writers = files.filter((f) => /(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+(\$\{IDENTITY_SOURCE_TABLE\}|platform_identities)(?![A-Za-z0-9_])/i.test(readFileSync(f, "utf8")))
    .map((f) => f.slice(f.indexOf("workers/"))).sort();
  assert.deepEqual(writers, ["workers/control-plane-shared/src/identity-source.ts", "workers/platform-registry/src/identities.ts"]);
  // The seed inserts only a 'seed' row and only when none exists; only the owner's save writes 'owner'.
  const seedSrc = read("workers/control-plane-shared/src/identity-source.ts");
  assert.match(seedSrc, /SELECT \?, \?, \?, 'seed', 1, \?, \? WHERE NOT EXISTS/);
  assert.ok(!/'owner'/.test(seedSrc.replace(/status === "owner"|"owner"/g, "")), "the seed never writes source 'owner'");
  const saveSrc = read("workers/platform-registry/src/identities.ts");
  assert.ok(saveSrc.indexOf("if (!isOwner(identity, env))") < saveSrc.indexOf("readJsonObject(request)"), "the owner check comes before the body is read");
  assert.match(saveSrc, /appendAuditEventWithMutation/);
  assert.deepEqual(UI_ROUTES.find((r) => r.id === "registry.identities_update"), { id: "registry.identities_update", service: "registry", method: "POST", path: "/v1/identities", approverOnly: true, confirm: "IDENTITIES" });
  assert.deepEqual(UI_ROUTES.find((r) => r.id === "registry.identities"), { id: "registry.identities", service: "registry", method: "GET", path: "/v1/identities", approverOnly: false, confirm: null });
  assert.ok(CONSOLE_ALLOW_LIST.some((a) => a.service === "registry" && a.method === "POST" && a.path === "/v1/identities"));
  // The rules of a valid list, its write and the deploy that writes the values are guard paths (the owner's click).
  for (const p of ["workers/control-plane-shared/src/identity-source.ts", "workers/platform-registry/src/identities.ts", "workers/deployment-orchestrator/src/deploy-vars.ts"]) {
    assert.equal(criticalPathReason(p), "auth_access", p);
  }
});

// ================================================================= 3. the seed: once, exactly the deployed list, never a change
test("IL-5. the seed copies the Orchestrator's own active lists once, only when they are exactly access-identities.sh's output", async () => {
  assert.deepEqual(seedEmails({ OPERATOR_IDENTITIES: OPS, APPROVER_IDENTITIES: APPROVERS }, CLIENT), { emails: EMAILS });
  assert.deepEqual(seedEmails({ OPERATOR_IDENTITIES: OPS, APPROVER_IDENTITIES: APPROVERS }), { emails: EMAILS }, "before the owner sets the token, any Client ID shape");
  assert.deepEqual(seedEmails({ OPERATOR_IDENTITIES: OPS, APPROVER_IDENTITIES: APPROVERS }, "other.access"), { reason: "seed_operators_not_ci_token" });
  assert.deepEqual(seedEmails({ OPERATOR_IDENTITIES: `${CLIENT},ops@example.com`, APPROVER_IDENTITIES: APPROVERS }, CLIENT), { reason: "seed_lists_differ" });
  assert.deepEqual(seedEmails({ OPERATOR_IDENTITIES: OPS, APPROVER_IDENTITIES: "Ops@example.com,owner@example.com" }, CLIENT), { reason: "seed_approvers_malformed" });
  assert.deepEqual(seedEmails({ OPERATOR_IDENTITIES: `cfast_x,${APPROVERS}`, APPROVER_IDENTITIES: APPROVERS }), { reason: "seed_operators_malformed" });
  assert.deepEqual(seedEmails({ APPROVER_IDENTITIES: APPROVERS }), { reason: "seed_operators_malformed" });

  const db = migratedDb();
  const env = { DB: db, OPERATOR_IDENTITIES: OPS, APPROVER_IDENTITIES: APPROVERS, CF_ACCESS_CLIENT_ID: CLIENT, CF_ACCESS_CLIENT_SECRET: "s3cr3t" };
  assert.deepEqual(await seedIdentities(env as never), { seeded: true, emails: 2 });
  const seed = await readIdentitySource(db);
  assert.deepEqual(seed, { ...seeded(EMAILS), updated_at: (seed as { updated_at: string }).updated_at });
  assert.deepEqual(await seedIdentities(env as never), { seeded: false, reason: "present" }, "once");
  const events = identityEvents(db);
  assert.deepEqual(events.map((e) => [e.event_type, e.actor, e.outcome]), [["identity_source.seeded", "agent:deployment-orchestrator", "seed"]]);
  assert.ok(!events[0].payload_json.includes("s3cr3t") && !events[0].payload_json.includes(CLIENT), "no secret and no Client ID in the audit");
  // The owner's first save over the seed names its revision and makes the list the deploys' source.
  const r = await call(registry, baseEnv("cryptophys-platform-registry", db, { APPROVER_IDENTITIES: "owner@example.com" }),
    req("POST", "/v1/identities", { emails: EMAILS, revision: 1, confirm: "IDENTITIES" }, await signAccessJwt({ email: "owner@example.com" })));
  assert.deepEqual([r.status, r.body.source.status, r.body.source.revision], [200, "owner", 2], JSON.stringify(r.body));
  // A seed never overwrites a row, and an inconsistent active version seeds nothing.
  assert.deepEqual(await seedIdentitySource(db, { OPERATOR_IDENTITIES: `${CLIENT},x@example.com`, APPROVER_IDENTITIES: "x@example.com" }, CLIENT, "agent:deployment-orchestrator"), { seeded: false, reason: "present" });
  assert.equal((await readIdentitySource(db)).status, "owner");
  const fresh = migratedDb();
  assert.deepEqual(await seedIdentities({ ...env, DB: fresh, APPROVER_IDENTITIES: "owner@example.com" } as never), { seeded: false, reason: "seed_lists_differ" });
  assert.deepEqual(rowOf(fresh), []);
});

// ================================================================= 4. deploy-vars: the expected values
test("IL-6. no row and the seed carry the active values exactly as before; an owner-saved row gives `<CI Client ID>,<emails>` and the approver emails", () => {
  const unit = "control-plane", svc = "cryptophys-platform-registry";
  const active = activeBindings(unit, svc);
  const before = keptDeployVars(unit, svc, active, REF);
  assert.ok(!("reason" in before));
  assert.deepEqual(Object.keys(before), ["vars"], "today's answer");
  for (const IDENTITIES of [{ status: "absent" } as IdentitySource, seeded(), seeded(["someone@example.com"])]) {
    assert.deepEqual(keptDeployVars(unit, svc, active, { ...REF, IDENTITIES }), before, IDENTITIES.status);
  }
  const k = keptDeployVars(unit, svc, active, { ...REF, IDENTITIES: owned() });
  assert.ok(!("reason" in k));
  assert.equal(k.vars.OPERATOR_IDENTITIES, `${CLIENT},owner@example.com,new.operator@example.com`);
  assert.equal(k.vars.APPROVER_IDENTITIES, "owner@example.com,new.operator@example.com");
  assert.deepEqual([k.vars.ACCESS_TEAM_DOMAIN, k.vars.ACCESS_AUD, k.vars.CF_ACCOUNT_ID], [TEAM, AUD, ACCOUNT], "the other values are carried");
  assert.deepEqual(k.changed, ["OPERATOR_IDENTITIES", "APPROVER_IDENTITIES"]);
  assert.equal(k.identities, "identity_table");
  // The same list as deployed: from the table, nothing changed.
  const same = keptDeployVars(unit, svc, active, { ...REF, IDENTITIES: owned(EMAILS) });
  assert.deepEqual(same, { vars: before.vars, identities: "identity_table" });
  // The Orchestrator's own unit: DEPLOY_ALLOWED_IDENTITIES is the operator list renamed.
  const orch = keptDeployVars("deployment-orchestrator", "cryptophys-deployment-orchestrator", activeBindings("deployment-orchestrator", "cryptophys-deployment-orchestrator"), { ...REF, IDENTITIES: owned() });
  assert.ok(!("reason" in orch));
  assert.equal(orch.vars.DEPLOY_ALLOWED_IDENTITIES, orch.vars.OPERATOR_IDENTITIES);
  assert.deepEqual(orch.changed, ["DEPLOY_ALLOWED_IDENTITIES", "OPERATOR_IDENTITIES", "APPROVER_IDENTITIES"]);
  // Every existing check applies to the expected values: format, the reference, a plain_text binding to replace.
  assert.deepEqual(keptDeployVars(unit, svc, active, { ...REF, CI_CLIENT_ID: undefined, IDENTITIES: owned() }), { reason: "deploy_var_reference_missing:OPERATOR_IDENTITIES" });
  assert.deepEqual(keptDeployVars(unit, svc, active, { ...REF, CI_CLIENT_ID: "cfast_secret", IDENTITIES: owned() }), { reason: "deploy_var_malformed:OPERATOR_IDENTITIES" });
  assert.deepEqual(keptDeployVars(unit, svc, activeBindings(unit, svc, { APPROVER_IDENTITIES: null }), { ...REF, IDENTITIES: owned() }), { reason: "deploy_var_unsourced:APPROVER_IDENTITIES" }, "a deploy replaces a value, it never adds one");
  const secret = active.map((b) => b.name === "APPROVER_IDENTITIES" ? { type: "secret_text", name: b.name } : b);
  assert.deepEqual(keptDeployVars(unit, svc, secret, { ...REF, IDENTITIES: owned() }), { reason: "deploy_var_not_plain:APPROVER_IDENTITIES" });
  // The non-identity values keep every check.
  assert.deepEqual(keptDeployVars(unit, svc, activeBindings(unit, svc, { ACCESS_AUD: "e".repeat(64) }), { ...REF, IDENTITIES: owned() }), { reason: "deploy_var_mismatch:ACCESS_AUD" });
  // Values are never in a reason.
  assert.ok(!JSON.stringify(keptDeployVars(unit, svc, active, { ...REF, CI_CLIENT_ID: undefined, IDENTITIES: owned() })).includes("@"));
});

test("IL-7. the CI Client ID comes first: from the Orchestrator's token, also after the token was rotated; without the table a rotated token still refuses", () => {
  const unit = "control-plane", svc = "cryptophys-policy-engine";
  const k = keptDeployVars(unit, svc, activeBindings(unit, svc), { ...REF, IDENTITIES: owned() });
  assert.ok(!("reason" in k));
  assert.equal(k.vars.OPERATOR_IDENTITIES.split(",")[0], CLIENT);
  assert.match(k.vars.OPERATOR_IDENTITIES, DEPLOY_VAR_SOURCES.OPERATOR_IDENTITIES.format);
  // The active list starts with an older token's Client ID (the owner rotated cryptophys-ci).
  const rotated = activeBindings(unit, svc, { OPERATOR_IDENTITIES: `old-token.access,${APPROVERS}` });
  assert.deepEqual(keptDeployVars(unit, svc, rotated, REF), { reason: "deploy_var_mismatch:OPERATOR_IDENTITIES" }, "carried, as before: refused");
  assert.deepEqual(keptDeployVars(unit, svc, rotated, { ...REF, IDENTITIES: seeded() }), { reason: "deploy_var_mismatch:OPERATOR_IDENTITIES" }, "the seed changes nothing");
  const fixed = keptDeployVars(unit, svc, rotated, { ...REF, IDENTITIES: owned(EMAILS) });
  assert.deepEqual(fixed, { vars: { ...k.vars, OPERATOR_IDENTITIES: OPS }, changed: ["OPERATOR_IDENTITIES"], identities: "identity_table" });
});

test("IL-8. unit equality: the expected values agree across the unit's Workers; a mix of table and carried values is refused", () => {
  const unit = "control-plane";
  const all = [...Object.keys(DEPLOY_VARS[unit])].map((svc) => keptDeployVars(unit, svc, activeBindings(unit, svc), { ...REF, IDENTITIES: owned() }));
  assert.ok(all.every((k) => !("reason" in k)));
  assert.equal(deployVarsConsistent(all.map((k) => (k as { vars: Record<string, string> }).vars)), null);
  const orch = keptDeployVars("deployment-orchestrator", "cryptophys-deployment-orchestrator", activeBindings("deployment-orchestrator", "cryptophys-deployment-orchestrator"), { ...REF, IDENTITIES: owned() });
  assert.equal(deployVarsConsistent([(orch as { vars: Record<string, string> }).vars, (all[0] as { vars: Record<string, string> }).vars]), null, "DEPLOY_ALLOWED_IDENTITIES equals OPERATOR_IDENTITIES");
  const carried = keptDeployVars(unit, "cryptophys-ai-kernel", activeBindings(unit, "cryptophys-ai-kernel"), REF);
  assert.equal(deployVarsConsistent([(all[0] as { vars: Record<string, string> }).vars, (carried as { vars: Record<string, string> }).vars]), "deploy_var_inconsistent:OPERATOR_IDENTITIES");
});

// ================================================================= 5. the native deploy writes and verifies the change
test("IL-9. a changed value is written as the plain_text binding (code only), verified on the new version before traffic, and recorded by name", async () => {
  const db = migratedDb();
  const { plan, bundles } = await plannedFor(UNIT);
  const cf = fakeCf((s) => activeBindings("control-plane", s));
  const run = await executeNativeDeploy(cf as never, deployEnv(bundles, db) as never, "req-il9", NEW, plan, { delayMs: 0, deployVars: { ...REF, IDENTITIES: owned() } });
  assert.equal(run.ok, true, run.reason);
  for (const s of UNIT) {
    const i = (x: string) => run.steps.indexOf(`${s}:${x}`);
    assert.ok(i("vars_kept") < i("vars_from_identity_table") && i("vars_from_identity_table") < i("vars_changed:OPERATOR_IDENTITIES") && i("vars_changed:OPERATOR_IDENTITIES") < i("uploaded"), run.steps.join(" "));
    assert.ok(i("uploaded") < i("bindings_match") && i("bindings_match") < i("vars_verified") && i("vars_verified") < i("deployed"), run.steps.join(" "));
    assert.equal(liveText(cf, s, "OPERATOR_IDENTITIES"), `${CLIENT},owner@example.com,new.operator@example.com`);
    assert.equal(liveText(cf, s, "SERVICE_NAME"), s, "the other plain-text values are sent unchanged");
    assert.equal(liveText(cf, s, "ACCESS_AUD"), AUD);
  }
  assert.ok(run.steps.includes("cryptophys-platform-registry:vars_changed:APPROVER_IDENTITIES"));
  assert.ok(!run.steps.includes("cryptophys-policy-engine:vars_changed:APPROVER_IDENTITIES"), "the policy engine carries no approver list");
  assert.equal(liveText(cf, "cryptophys-platform-registry", "APPROVER_IDENTITIES"), "owner@example.com,new.operator@example.com");
  assert.deepEqual(run.deploy_vars_changed, { "cryptophys-policy-engine": ["OPERATOR_IDENTITIES"], "cryptophys-platform-registry": ["OPERATOR_IDENTITIES", "APPROVER_IDENTITIES"] });
  // The upload: every plain-text binding sent, plain_text no longer kept, every other type still kept (secrets, D1...).
  const up = cf.uploads[0];
  assert.deepEqual(up.plain_text!.map((b) => b.name).sort(), ["ACCESS_AUD", "ACCESS_TEAM_DOMAIN", "OPERATOR_IDENTITIES", "SERVICE_NAME"]);
  // Names only, never values, in the outcome and the audit chain.
  assert.ok(!JSON.stringify(run).includes("new.operator@example.com") && !JSON.stringify(run).includes(CLIENT), "values are never in the outcome");
  const written = db.raw.prepare("SELECT subject, payload_json FROM audit_events WHERE event_type = 'deployment.identity_vars_written' ORDER BY rowid").all() as Array<{ subject: string; payload_json: string }>;
  assert.deepEqual(written.map((w) => [w.subject, JSON.parse(w.payload_json).names, JSON.parse(w.payload_json).identity_revision]),
    [["cryptophys-policy-engine", ["OPERATOR_IDENTITIES"], 2], ["cryptophys-platform-registry", ["OPERATOR_IDENTITIES", "APPROVER_IDENTITIES"], 2]]);
  assert.ok(!written.some((w) => w.payload_json.includes("@")));
});

test("IL-10. a new version without the new text never takes traffic: the deploy stops before the deploy call", async () => {
  const { plan, bundles } = await plannedFor(UNIT);
  const cf = fakeCf((s) => activeBindings("control-plane", s), { ignorePlainText: true });
  const run = await executeNativeDeploy(cf as never, deployEnv(bundles) as never, "req-il10", NEW, plan, { delayMs: 0, deployVars: { ...REF, IDENTITIES: owned() } });
  assert.equal(run.ok, false);
  assert.match(run.reason!, /^(bindings_differ|deploy_vars_differ: deploy_var_differs:OPERATOR_IDENTITIES)$/);
  assert.ok(!cf.calls.some((c) => c.startsWith("deploy ")), "no deploy call");
  assert.equal(run.production_changed, false);
  assert.equal(liveText(cf, UNIT[0], "OPERATOR_IDENTITIES"), OPS, "production still runs the old list");
  // The verification itself is the existing one, against the new expected value.
  const replaced = withDeployVarText(activeBindings("control-plane", UNIT[0]), { OPERATOR_IDENTITIES: "x.access,a@x.io" }, ["OPERATOR_IDENTITIES"]);
  assert.equal(replaced.find((b) => b.name === "OPERATOR_IDENTITIES")!.text, "x.access,a@x.io");
  assert.deepEqual((await bindingSetOf(replaced)).names, (await bindingSetOf(activeBindings("control-plane", UNIT[0]))).names);
  assert.notEqual((await bindingSetOf(replaced)).digest, (await bindingSetOf(activeBindings("control-plane", UNIT[0]))).digest);
  assert.throws(() => withDeployVarText([{ type: "secret_text", name: "OPERATOR_IDENTITIES" }], { OPERATOR_IDENTITIES: "x" }, ["OPERATOR_IDENTITIES"]), /deploy_var_not_plain:OPERATOR_IDENTITIES/);
  assert.deepEqual(plainTextBindings(replaced).map((b) => b.name), ["SERVICE_NAME", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD", "OPERATOR_IDENTITIES"]);
});

test("IL-11. a configuration plan: the kept binding gets the new text, the plan check requires it; a value the plan builds from config is refused", () => {
  const plan = {
    bindings: [{ type: "plain_text", name: "APPROVER_IDENTITIES", text: APPROVERS }, { type: "plain_text", name: "SERVICE_NAME", text: "svc" }],
    sources: { "plain_text:APPROVER_IDENTITIES": "active", "plain_text:SERVICE_NAME": "config" } as Record<string, "active" | "config">,
    secrets: ["secret_text:CF_DEPLOY_TOKEN"],
  };
  const next = withPlannedDeployVars(plan, { APPROVER_IDENTITIES: "owner@example.com" }, ["APPROVER_IDENTITIES"]);
  assert.equal(next.bindings[0].text, "owner@example.com");
  assert.equal(plan.bindings[0].text, APPROVERS, "the plan is not mutated");
  const uploaded = (text: string) => [{ type: "plain_text", name: "APPROVER_IDENTITIES", text }, { type: "plain_text", name: "SERVICE_NAME", text: "svc" }, { type: "secret_text", name: "CF_DEPLOY_TOKEN" }];
  assert.deepEqual(verifyPlannedBindings(next, uploaded("owner@example.com")), { ok: true });
  assert.deepEqual(verifyPlannedBindings(next, uploaded(APPROVERS)), { ok: false, reason: "binding_differs", binding: "plain_text:APPROVER_IDENTITIES" });
  assert.throws(() => withPlannedDeployVars(plan, { SERVICE_NAME: "x" }, ["SERVICE_NAME"]), /deploy_var_unplanned:SERVICE_NAME/);
  assert.throws(() => withPlannedDeployVars(plan, { OPERATOR_IDENTITIES: "x" }, ["OPERATOR_IDENTITIES"]), /deploy_var_unplanned:OPERATOR_IDENTITIES/);
});

test("IL-12. the version upload form: plain-text values sent explicitly, plain_text dropped from keep_bindings; without a change the form is as before", async () => {
  const forms: Array<Record<string, unknown>> = [];
  const fetcher = (async (_url: RequestInfo | URL, init: RequestInit = {}) => {
    const meta = (init.body as FormData).get("metadata") as Blob;
    forms.push(JSON.parse(await meta.text()));
    return new Response(JSON.stringify({ success: true, result: { id: "00000001-0000-4000-8000-000000000000" } }), { status: 200 });
  }) as typeof fetch;
  const cf = new CloudflareWorkers("token", ACCOUNT, fetcher);
  const metadata: VersionMetadata = { main_module: "w.mjs", compatibility_date: "2026-11-01", compatibility_flags: [], tag: TAG, message: "m" };
  await cf.uploadVersion("cryptophys-policy-engine", "w.mjs", "export default {}", metadata);
  await cf.uploadVersion("cryptophys-policy-engine", "w.mjs", "export default {}", { ...metadata, plain_text: [{ type: "plain_text", name: "OPERATOR_IDENTITIES", text: OPS }, { type: "plain_text", name: "SERVICE_NAME", text: "s" }] });
  assert.deepEqual(forms[0].keep_bindings, [...KEEP_BINDINGS]);
  assert.equal(forms[0].bindings, undefined);
  assert.deepEqual(forms[1].keep_bindings, KEEP_BINDINGS.filter((t) => t !== "plain_text"));
  assert.ok((forms[1].keep_bindings as string[]).includes("secret_text") && (forms[1].keep_bindings as string[]).includes("d1"));
  assert.deepEqual(forms[1].bindings, [{ type: "plain_text", name: "OPERATOR_IDENTITIES", text: OPS }, { type: "plain_text", name: "SERVICE_NAME", text: "s" }]);
  for (const bad of [[{ type: "secret_text", name: "X", text: "y" }], [{ type: "plain_text", name: "A", text: "1" }, { type: "plain_text", name: "A", text: "2" }], [{ type: "plain_text", name: "bad name", text: "1" }]]) {
    await assert.rejects(cf.uploadVersion("s", "w.mjs", "x", { ...metadata, plain_text: bad as never }), /invalid_plain_text_upload/);
  }
});

// ================================================================= 6. no row: unchanged; an invalid row: carried, and a finding
test("IL-13. no row and the seed: the native deploy runs exactly as before (same steps, same live values, no change recorded)", async () => {
  const runWith = async (deployVars: DeployVarReference) => {
    const { plan, bundles } = await plannedFor(UNIT);
    const cf = fakeCf((s) => activeBindings("control-plane", s));
    const run = await executeNativeDeploy(cf as never, deployEnv(bundles) as never, "req-il13", NEW, plan, { delayMs: 0, deployVars });
    return { run, cf };
  };
  const today = await runWith(REF);
  assert.equal(today.run.ok, true, today.run.reason);
  for (const IDENTITIES of [{ status: "absent" } as IdentitySource, seeded(["someone.else@example.com"])]) {
    const r = await runWith({ ...REF, IDENTITIES });
    assert.equal(r.run.ok, true, r.run.reason);
    assert.deepEqual(r.run.steps, today.run.steps, IDENTITIES.status);
    assert.deepEqual(r.run.deploy_vars, today.run.deploy_vars);
    assert.equal(r.run.deploy_vars_changed, undefined);
    assert.ok(r.cf.uploads.every((u) => u.plain_text === undefined), "the code-only upload keeps every binding, as before");
    for (const s of UNIT) assert.equal(liveText(r.cf, s, "OPERATOR_IDENTITIES"), OPS);
  }
});

test("IL-14. an empty or malformed row is never deployed: the active values are carried, the steps say so, and the Owner page lists identity_source_invalid", async () => {
  const db = migratedDb();
  assert.deepEqual((await unhandledProblems(db as never)).filter((p) => p.code === "identity_source_invalid"), [], "no row is not a problem");
  // A hand-edited row: an empty list (the CHECK admits six commas), then two lists that differ.
  db.raw.prepare("INSERT INTO platform_identities (id, operator_emails, approver_emails, source, revision, updated_by, updated_at) VALUES ('access', ',,,,,,', ',,,,,,', 'owner', 3, 'someone', '2026-11-16T08:00:00.000Z')").run();
  const empty = await readIdentitySource(db);
  assert.deepEqual(empty, { status: "invalid", reason: "identity_operator_emails_malformed", revision: 3, updated_by: "someone", updated_at: "2026-11-16T08:00:00.000Z" });
  const [problem] = (await unhandledProblems(db as never)).filter((p) => p.code === "identity_source_invalid");
  assert.deepEqual([problem.subject, problem.link, problem.since], ["platform_identities", "#/users", "2026-11-16T08:00:00.000Z"]);
  assert.match(problem.detail, /revision 3.*identity_operator_emails_malformed.*keep each Worker's current identity lists/);
  db.raw.prepare("UPDATE platform_identities SET operator_emails = 'owner@example.com', approver_emails = 'owner@example.com,x@example.com'").run();
  const differ = await readIdentitySource(db);
  assert.equal((differ as { reason: string }).reason, "identity_lists_differ");

  const { plan, bundles } = await plannedFor(UNIT);
  const cf = fakeCf((s) => activeBindings("control-plane", s));
  const run = await executeNativeDeploy(cf as never, deployEnv(bundles) as never, "req-il14", NEW, plan, { delayMs: 0, deployVars: { ...REF, IDENTITIES: differ } });
  assert.equal(run.ok, true, run.reason);
  for (const s of UNIT) {
    assert.ok(run.steps.includes(`${s}:identity_source_invalid`), run.steps.join(" "));
    assert.ok(!run.steps.some((x) => x.startsWith(`${s}:vars_changed`) || x === `${s}:vars_from_identity_table`));
    assert.equal(liveText(cf, s, "OPERATOR_IDENTITIES"), OPS, "carried");
  }
  assert.ok(cf.uploads.every((u) => u.plain_text === undefined));
  assert.equal(run.deploy_vars_changed, undefined);
  // An unreadable source is carried the same way (D1 failed mid-read).
  const k = keptDeployVars("control-plane", UNIT[1], activeBindings("control-plane", UNIT[1]), { ...REF, IDENTITIES: { status: "unreadable" } });
  assert.deepEqual(k, { vars: (keptDeployVars("control-plane", UNIT[1], activeBindings("control-plane", UNIT[1]), REF) as { vars: Record<string, string> }).vars, identities: "identity_source_invalid" });
  // The owner's valid save closes the item.
  const r = await call(registry, baseEnv("cryptophys-platform-registry", db, { APPROVER_IDENTITIES: "owner@example.com" }),
    req("POST", "/v1/identities", { emails: ["owner@example.com"], revision: 3, confirm: "IDENTITIES" }, await signAccessJwt({ email: "owner@example.com" })));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await unhandledProblems(db as never)).filter((p) => p.code === "identity_source_invalid"), []);
  assert.match(read("workers/console/ui/src/pages/Owner.tsx"), /identity_source_invalid: "identity list invalid"/);
});

test("IL-15. the Orchestrator reads the table into gate 4's reference (only once the owner set its service token), at every check and before the executor runs", async () => {
  const db = migratedDb();
  const env = { DB: db, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, CF_ACCOUNT_ID: ACCOUNT, CF_ACCESS_CLIENT_ID: CLIENT, CF_ACCESS_CLIENT_SECRET: "s3cr3t" };
  assert.deepEqual(await gate4Deploy(env as never), { deployVars: { ...REF, IDENTITIES: { status: "absent" } } });
  assert.deepEqual(await gate4Deploy({ DB: db } as never), {}, "before the token: kept verbatim, as before");
  db.raw.prepare("INSERT INTO platform_identities (id, operator_emails, approver_emails, source, revision, updated_by, updated_at) VALUES ('access', 'owner@example.com', 'owner@example.com', 'owner', 1, 'owner@example.com', 't')").run();
  const g = await gate4Deploy(env as never);
  assert.equal(g.deployVars?.IDENTITIES?.status, "owner");
  const src = read("workers/deployment-orchestrator/src/index.ts");
  assert.equal((src.match(/await gate4Deploy\(env\)/g) ?? []).length, 5, "the four eligibility checks and the executor");
  assert.match(src, /isBreakGlass \? \{ destructive: named \} : \{ \.\.\.\(await gate4Deploy\(env\)\)/, "the break-glass deploy keeps its own rules (carried verbatim)");
  assert.match(src, /if \(minute === 10 \|\| minute === 40\) ctx\.waitUntil\(seedIdentities\(env\)/);
});

// ================================================================= 7. docs
test("IL-16. the docs say where the identity lists come from and how the owner changes an email after the cut-over", () => {
  const deploy = read("docs/CONTROL-PLANE-DEPLOYMENT.md");
  assert.match(deploy, /platform_identities/);
  assert.match(deploy, /identity_source_invalid/);
  const ops = read("docs/OPERATIONS.md");
  assert.match(ops, /IDENTITIES/);
  assert.match(ops, /platform_identities/);
  const ssot = read("docs/SSOT.md");
  assert.match(ssot.split("\n").find((l) => l.startsWith("Last reviewed: "))!, /2026-11-16 \(the deploy-time identity lists get a native source, D1 `platform_identities`/);
  assert.match(read("workers/deployment-orchestrator/src/deploy-vars.ts"), /vars_from_identity_table/);
});

// ================================================================= 7. together with the binding-props repair (main, 2026-11-16)
test("IL-17. one code-only upload restores a stripped AGENTS props and writes a changed identity list: both sent, every other binding kept, both verified before traffic", async () => {
  const agentsToml = '[[services]]\nbinding = "AGENTS"\nservice = "cryptophys-ai-kernel"\nentrypoint = "AgentRpc"\nprops = { host_worker = "HOST" }\n';
  // Each Worker's stored wrangler.toml declares AGENTS with its own host_worker (the TOML text is per Worker).
  const { plan, bundles } = await plannedFor(UNIT, agentsToml);
  for (const p of plan) {
    const key = `bundles/${NEW}/config/${p.service}.toml`;
    const text = (await (await bundles.get(key))!.text()).replace('"HOST"', JSON.stringify(p.service));
    const orig = bundles.get.bind(bundles);
    bundles.get = async (k: string) => k === key ? { text: async () => text } : orig(k);
    p.worker.config_sha256 = await sha256(text);
  }
  // Production as the out-of-band version left it: AGENTS without its props (the API's record, environment included).
  const agentsActive = (s: string, props?: Record<string, unknown>) =>
    ({ type: "service", name: "AGENTS", service: "cryptophys-ai-kernel", entrypoint: "AgentRpc", environment: "production", ...(props ? { props } : {}) });
  const active = (s: string) => [...activeBindings("control-plane", s), agentsActive(s)];
  const db = migratedDb();
  const cf = fakeCf(active);
  const run = await executeNativeDeploy(cf as never, deployEnv(bundles, db) as never, "req-il17", NEW, plan, { delayMs: 0, deployVars: { ...REF, IDENTITIES: owned() } });
  assert.equal(run.ok, true, run.reason);
  UNIT.forEach((s, n) => {
    const i = (x: string) => run.steps.indexOf(`${s}:${x}`);
    assert.ok(i("vars_changed:OPERATOR_IDENTITIES") < i("uploaded") && i("uploaded") < i("bindings_match"), run.steps.join(" "));
    assert.ok(i("bindings_match") < i("service_bindings_restored:AGENTS") && i("service_bindings_restored:AGENTS") < i("vars_verified") && i("vars_verified") < i("deployed"), run.steps.join(" "));
    // The one upload sent both: the declared AGENTS (props included) and every plain-text value, the changed one with its new text.
    const up = cf.uploads[n];
    assert.deepEqual(up.services, [{ type: "service", name: "AGENTS", service: "cryptophys-ai-kernel", entrypoint: "AgentRpc", props: { host_worker: s } }]);
    assert.equal(up.plain_text!.find((b) => b.name === "OPERATOR_IDENTITIES")!.text, `${CLIENT},owner@example.com,new.operator@example.com`);
    assert.equal(up.plain_text!.find((b) => b.name === "SERVICE_NAME")!.text, s);
    assert.equal(up.config, undefined, "code only");
    // Production now: the declared props, the new list, the other values unchanged, every other binding kept.
    const sc = cf.script(s);
    const live = sc.versions.get(sc.active[0].version_id)!;
    assert.deepEqual(live.find((b) => b.name === "AGENTS")!.props, { host_worker: s });
    assert.equal(liveText(cf, s, "OPERATOR_IDENTITIES"), `${CLIENT},owner@example.com,new.operator@example.com`);
    assert.equal(liveText(cf, s, "SERVICE_NAME"), s);
    assert.equal(liveText(cf, s, "ACCESS_AUD"), AUD);
    assert.deepEqual(live.filter((b) => b.type !== "service" && b.type !== "plain_text").map((b) => `${b.type}:${b.name}`).sort(),
      ["d1:DB", "secret_text:CF_DEPLOY_TOKEN", "version_metadata:CF_VERSION_METADATA"]);
  });
  assert.deepEqual(run.deploy_vars_changed, { "cryptophys-policy-engine": ["OPERATOR_IDENTITIES"], "cryptophys-platform-registry": ["OPERATOR_IDENTITIES", "APPROVER_IDENTITIES"] });
  assert.deepEqual(run.binding_drift, Object.fromEntries(UNIT.map((s) => [s, { restored: [{ name: "AGENTS", kinds: ["props"], retarget: false }], undeclared: [], repaired: true }])));
  const events = (db.raw.prepare("SELECT event_type, subject FROM audit_events WHERE event_type IN ('deployment.identity_vars_written', 'deployment.binding_drift_repaired') ORDER BY rowid").all() as Array<{ event_type: string; subject: string }>)
    .map((e) => `${e.event_type} ${e.subject}`);
  for (const s of UNIT) for (const e of ["deployment.identity_vars_written", "deployment.binding_drift_repaired"]) assert.ok(events.includes(`${e} ${s}`), events.join(", "));

  // Each check still holds when both are sent: a new version that kept the old text, or the active version's service
  // binding (here props that differ), never takes traffic.
  const wrongProps = (s: string) => [...activeBindings("control-plane", s), agentsActive(s, { host_worker: "cryptophys-ai-kernel" })];
  for (const [opts, reason] of [
    [{ ignorePlainText: true }, /^(bindings_differ|deploy_vars_differ: deploy_var_differs:OPERATOR_IDENTITIES)$/],
    [{ ignoreServices: true }, /^service_bindings_differ: service_binding_props_differs \(AGENTS\)$/],
  ] as const) {
    const bad = fakeCf(wrongProps, opts);
    const r = await executeNativeDeploy(bad as never, deployEnv(bundles) as never, "req-il17b", NEW, plan, { delayMs: 0, deployVars: { ...REF, IDENTITIES: owned() } });
    assert.equal(r.ok, false, JSON.stringify(opts));
    assert.match(r.reason!, reason);
    assert.ok(bad.uploads[0].services && bad.uploads[0].plain_text, "both were sent");
    assert.ok(!bad.calls.some((c) => c.startsWith("deploy ")), "no deploy call");
    assert.equal(r.production_changed, false);
    assert.equal(liveText(bad, UNIT[0], "OPERATOR_IDENTITIES"), OPS, "production still runs the old list");
  }
});
