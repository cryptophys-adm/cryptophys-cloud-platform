// Users & privileges (owner decision 2026-11-07, migration 0026): accounts of kind admin
// (viewer | operator | approver) open the Cerebrum Console; kind user signs in to Nexus only.
// Only owners (APPROVER_IDENTITIES people) manage accounts, with GRANT / REVOKE; audited atomically.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, CI_JWT, OPERATOR_EMAIL, OPERATOR_JWT, OUTSIDER_JWT,
  baseEnv, call, migratedDb, req, signAccessJwt,
} from "./harness.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { requireApprover, requireOperator, roleOf } from "../src/access.ts";
import registry from "../../platform-registry/src/index.ts";
import { ACCESS_GROUP_NAME, syncLogin } from "../../platform-registry/src/accounts.ts";
import consoleWorker, { SERVICE_BINDINGS } from "../../console/src/index.ts";

const ROOT = new URL("../../../", import.meta.url);
type Db = ReturnType<typeof migratedDb>;

const regEnv = (db: Db, extra: Record<string, unknown> = {}) =>
  baseEnv("cryptophys-platform-registry", db, { APPROVER_IDENTITIES: APPROVER_EMAIL, ...extra });
const jwtFor = (email: string) => signAccessJwt({ email });
const add = (db: Db, body: Record<string, unknown>, jwt = APPROVER_JWT, extra: Record<string, unknown> = {}) =>
  call(registry, regEnv(db, extra), req("POST", "/v1/accounts", body, jwt));

test("U1. migration 0026: the table enforces kind/privilege, lower-case emails and the two statuses", () => {
  const db = migratedDb();
  const ins = (email: string, kind: string, privilege: string | null, status = "active") => db.raw.prepare(
    `INSERT INTO platform_accounts (email, kind, privilege, status, created_by, created_at, updated_by, updated_at) VALUES (?, ?, ?, ?, 'o', 't', 'o', 't')`,
  ).run(email, kind, privilege, status);
  ins("a@example.com", "admin", "viewer");
  ins("u@example.com", "user", null);
  assert.throws(() => ins("b@example.com", "admin", null), /CHECK/);
  assert.throws(() => ins("c@example.com", "user", "operator"), /CHECK/);
  assert.throws(() => ins("D@example.com", "user", null), /CHECK/);
  assert.throws(() => ins("e@example.com", "admin", "owner"), /CHECK/);
  assert.throws(() => ins("f@example.com", "user", null, "deleted"), /CHECK/);
});

test("U2. an owner adds an admin with GRANT; the change and its audit event are one write; the chain stays valid", async () => {
  const db = migratedDb();
  const r = await add(db, { email: "Analyst@Example.com", kind: "admin", privilege: "operator", note: "desk", confirm: "GRANT" });
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.account.email, r.body.account.kind, r.body.account.privilege, r.body.account.status, r.body.account.created_by],
    ["analyst@example.com", "admin", "operator", "active", APPROVER_EMAIL]);
  assert.equal(r.body.login_sync.status, "not_configured");
  const change = await add(db, { email: "analyst@example.com", kind: "user", confirm: "GRANT" });
  assert.deepEqual([change.status, change.body.account.kind, change.body.account.privilege], [200, "user", null]);
  const events = db.raw.prepare("SELECT event_type, actor, subject FROM audit_events WHERE event_type LIKE 'account.%' ORDER BY rowid").all() as any[];
  assert.deepEqual(events.map((e) => e.event_type), ["account.created", "account.changed"]);
  assert.ok(events.every((e) => e.actor === APPROVER_EMAIL && e.subject === "analyst@example.com"));
  assert.equal((await verifyAuditChain(db as never)).valid, true);
});

test("U3. only owners manage accounts; the phrase, the email, self-changes and configured identities are checked", async () => {
  const db = migratedDb();
  const body = { email: "x@example.com", kind: "admin", privilege: "viewer", confirm: "GRANT" };
  assert.deepEqual([(await add(db, body, OPERATOR_JWT)).status, (await add(db, body, OPERATOR_JWT)).body.error], [403, "owner_required"], "an operator is not an owner");
  assert.equal((await add(db, body, CI_JWT)).status, 403, "the CI token is not an owner");
  assert.equal((await add(db, body, OUTSIDER_JWT)).status, 403);
  // An approver *account* approves, but does not manage accounts.
  await add(db, { email: "boss@example.com", kind: "admin", privilege: "approver", confirm: "GRANT" });
  assert.deepEqual((await add(db, body, await jwtFor("boss@example.com"))).body.error, "owner_required");
  assert.equal((await add(db, { ...body, confirm: "grant" })).body.error, "confirmation_required");
  for (const email of ["not-an-email", "a b@example.com", "x@localhost", ""]) assert.equal((await add(db, { ...body, email })).body.error, "invalid_email", email);
  assert.equal((await add(db, { ...body, privilege: "owner" })).body.error, "invalid_privilege");
  assert.equal((await add(db, { email: "u@example.com", kind: "user", privilege: "viewer", confirm: "GRANT" })).body.error, "invalid_privilege");
  assert.equal((await add(db, { ...body, kind: "root" })).body.error, "invalid_kind");
  assert.equal((await add(db, { ...body, email: APPROVER_EMAIL })).body.error, "self_change");
  assert.deepEqual([(await add(db, { ...body, email: OPERATOR_EMAIL })).status, (await add(db, { ...body, email: OPERATOR_EMAIL })).body.error], [409, "configured_identity"]);
  assert.equal((db.raw.prepare("SELECT COUNT(*) n FROM platform_accounts").get() as any).n, 1, "only the approver account was written");
});

test("U4. roles: viewer reads, operator acts, approver approves, user and disabled accounts get nothing", async () => {
  const db = migratedDb();
  for (const [email, kind, privilege] of [["v@example.com", "admin", "viewer"], ["o@example.com", "admin", "operator"], ["a@example.com", "admin", "approver"], ["u@example.com", "user", null]] as const) {
    await add(db, { email, kind, ...(privilege ? { privilege } : {}), confirm: "GRANT" });
  }
  const env = regEnv(db);
  const op = async (method: string, email: string) => (await requireOperator(new Request("https://x/v1/services", { method, headers: { "cf-access-jwt-assertion": await jwtFor(email) } }), env as never)).ok;
  const ap = async (email: string) => (await requireApprover(new Request("https://x/approve", { method: "POST", headers: { "cf-access-jwt-assertion": await jwtFor(email) } }), env as never)).ok;
  assert.deepEqual([await op("GET", "v@example.com"), await op("POST", "v@example.com")], [true, false], "viewer: read only");
  assert.deepEqual([await op("GET", "o@example.com"), await op("POST", "o@example.com"), await ap("o@example.com")], [true, true, false], "operator");
  assert.deepEqual([await op("POST", "a@example.com"), await ap("a@example.com")], [true, true], "approver account");
  assert.deepEqual([await op("GET", "u@example.com"), await ap("u@example.com")], [false, false], "user: Nexus only");
  assert.equal(await ap(APPROVER_EMAIL), true, "the owner is an approver");
  assert.equal((await requireApprover(new Request("https://x/a", { method: "POST", headers: { "cf-access-jwt-assertion": CI_JWT } }), { ...env, APPROVER_IDENTITIES: `${APPROVER_EMAIL},${CI_CLIENT_ID}` } as never)).ok, false, "a service token is never an approver");
  // Disabling ends the role at once.
  const off = await call(registry, env, req("POST", "/v1/accounts/o@example.com/disable", { confirm: "REVOKE" }, APPROVER_JWT));
  assert.deepEqual([off.status, off.body.account.status], [200, "disabled"]);
  assert.equal(await op("GET", "o@example.com"), false);
  assert.equal((await call(registry, env, req("POST", "/v1/accounts/a@example.com/disable", { confirm: "yes" }, APPROVER_JWT))).body.error, "confirmation_required");
  assert.equal((await call(registry, env, req("POST", "/v1/accounts/nobody@example.com/disable", { confirm: "REVOKE" }, APPROVER_JWT))).status, 404);
  // Re-enabling is an upsert with GRANT.
  await add(db, { email: "o@example.com", kind: "admin", privilege: "viewer", confirm: "GRANT" });
  assert.deepEqual([await op("GET", "o@example.com"), await op("POST", "o@example.com")], [true, false]);
  // whoami on the Registry answers any valid identity with its role.
  const me = await call(registry, env, req("GET", "/v1/accounts/me", undefined, await jwtFor("u@example.com")));
  assert.deepEqual([me.status, me.body.role, me.body.owner], [200, "user", false]);
  const owner = await call(registry, env, req("GET", "/v1/accounts/me", undefined, APPROVER_JWT));
  assert.deepEqual([owner.body.role, owner.body.owner, owner.body.source], ["approver", true, "config"]);
  assert.equal((await roleOf(env as never, { subject: "ghost@example.com", type: "user" })).role, null);
  // The list is readable by viewers (GET) and shows the configured owners separately.
  const list = await call(registry, env, req("GET", "/v1/accounts", undefined, await jwtFor("v@example.com")));
  assert.deepEqual([list.status, list.body.owners, list.body.accounts.length], [200, [APPROVER_EMAIL], 4]);
});

test("U5. sign-in sync: the Access group gets the owners plus active accounts; missing secret or group is reported", async () => {
  const db = migratedDb();
  await add(db, { email: "a@example.com", kind: "admin", privilege: "viewer", confirm: "GRANT" });
  await add(db, { email: "u@example.com", kind: "user", confirm: "GRANT" });
  await add(db, { email: "gone@example.com", kind: "user", confirm: "GRANT" });
  await call(registry, regEnv(db), req("POST", "/v1/accounts/gone@example.com/disable", { confirm: "REVOKE" }, APPROVER_JWT));
  const env = regEnv(db, { ACCESS_GROUPS_TOKEN: "t", CF_ACCOUNT_ID: "acct" });
  const calls: { url: string; init?: RequestInit }[] = [];
  const fake = (groups: { id: string; name: string }[]) => (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return init?.method === "PUT" ? Response.json({ success: true }) : Response.json({ success: true, result: groups });
  }) as typeof fetch;
  assert.equal((await syncLogin(regEnv(db) as never)).status, "not_configured");
  assert.equal((await syncLogin(env as never, fake([]))).status, "group_missing");
  const ok = await syncLogin(env as never, fake([{ id: "g1", name: ACCESS_GROUP_NAME }]));
  assert.deepEqual(ok, { status: "synced", group_id: "g1", emails: 3 });
  const put = calls.find((c) => c.init?.method === "PUT")!;
  assert.equal(put.url, "https://api.cloudflare.com/client/v4/accounts/acct/access/groups/g1");
  const body = JSON.parse(String(put.init!.body));
  assert.deepEqual(body.include.map((i: any) => i.email.email).sort(), [APPROVER_EMAIL, "a@example.com", "u@example.com"].sort(), "owners and active accounts, never the disabled one");
  assert.equal(body.name, ACCESS_GROUP_NAME);
  const failing = (async () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000 }] }), { status: 403 })) as typeof fetch;
  assert.equal((await syncLogin(env as never, failing)).status, "failed");
});

function consoleEnv(registryReply: (r: Request) => Promise<Response>) {
  const forwarded: Request[] = [];
  const bindings: Record<string, unknown> = {};
  for (const name of Object.values(SERVICE_BINDINGS)) bindings[name] = { fetch: async (r: Request) => { forwarded.push(r); return Response.json({ ok: true }); } };
  bindings.REGISTRY = { fetch: async (r: Request) => { forwarded.push(r); return registryReply(r); } };
  const access = baseEnv("x", migratedDb());
  return {
    forwarded,
    env: {
      SERVICE_NAME: "cryptophys-console", SERVICE_ENVIRONMENT: "production", API_CONTRACT_VERSION: "v1",
      ACCESS_TEAM_DOMAIN: access.ACCESS_TEAM_DOMAIN, ACCESS_AUD: access.ACCESS_AUD,
      OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL,
      ASSETS: { fetch: async () => new Response("<html>", { headers: { "content-type": "text/html" } }) },
      ...bindings,
    },
  };
}

test("U6. the Cerebrum Console: admin accounts enter (viewer read only), user accounts and failed lookups do not", async () => {
  const db = migratedDb();
  for (const [email, kind, privilege] of [["v@example.com", "admin", "viewer"], ["o@example.com", "admin", "operator"], ["u@example.com", "user", null]] as const) {
    await add(db, { email, kind, ...(privilege ? { privilege } : {}), confirm: "GRANT" });
  }
  // The Console's Registry binding is the real Registry Worker over the same database.
  const reg = regEnv(db);
  const c = consoleEnv((r) => registry.fetch(r, reg as never));
  const go = async (email: string, method = "GET", path = "/console/api/whoami") => {
    const h: Record<string, string> = { "cf-access-jwt-assertion": await jwtFor(email) };
    if (method !== "GET") Object.assign(h, { origin: "https://nexus.cryptophys.work", "x-cryptophys-console": "1", "content-type": "application/json" });
    const res = await consoleWorker.fetch(new Request(`https://nexus.cryptophys.work${path}`, { method, headers: h, body: method === "GET" ? undefined : "{}" }), c.env as never);
    return { status: res.status, body: await res.json().catch(() => null) as any };
  };
  const v = await go("v@example.com");
  assert.deepEqual([v.status, v.body.role, v.body.viewer, v.body.operator, v.body.approver, v.body.owner], [200, "viewer", true, false, false, false]);
  assert.deepEqual((await go("v@example.com", "POST", "/console/api/drift/v1/observe")).body, { error: "viewer_read_only" });
  const o = await go("o@example.com");
  assert.deepEqual([o.status, o.body.role, o.body.operator], [200, "operator", true]);
  assert.equal((await go("u@example.com")).status, 403, "a Nexus-only user cannot open the Cerebrum Console");
  assert.equal((await go("ghost@example.com")).status, 403);
  const owner = await go(APPROVER_EMAIL);
  assert.deepEqual([owner.status, owner.body.owner, owner.body.approver], [200, true, true], "an owner opens the Console even if not in OPERATOR_IDENTITIES");
  // A Registry failure refuses; it never falls open.
  const down = consoleEnv(async () => { throw new Error("down"); });
  const res = await consoleWorker.fetch(new Request("https://nexus.cryptophys.work/console/api/whoami", { headers: { "cf-access-jwt-assertion": await jwtFor("v@example.com") } }), down.env as never);
  assert.equal(res.status, 403);
});

test("U7. wiring: Registry gets the owners and the account ID at deploy; Access includes the managed group", () => {
  const wf = readFileSync(new URL(".github/workflows/deploy-control-plane.yml", ROOT), "utf8");
  assert.match(wf, /"\$dir" == "platform-registry"/);
  assert.match(wf, /CF_ACCOUNT_ID:\$\{CLOUDFLARE_ACCOUNT_ID\}/);
  const prov = readFileSync(new URL(".github/workflows/provision-access.yml", ROOT), "utf8");
  assert.match(prov, /cryptophys-nexus-accounts/);
  assert.match(prov, /\{group: \{id: \$group\}\}/);
  const toml = readFileSync(new URL("workers/platform-registry/wrangler.toml", ROOT), "utf8");
  assert.doesNotMatch(toml, /ACCESS_GROUPS_TOKEN\s*=/, "the token is a Worker secret, never in Git");
});
