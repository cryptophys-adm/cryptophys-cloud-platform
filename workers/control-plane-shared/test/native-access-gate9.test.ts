// ADR-0012 G6 gate 9 (docs/GITHUB-CUTOVER.md): Cloudflare Access is provisioned by the Orchestrator with the owner's
// CF_ACCESS_TOKEN, as the critical consensus action change_access, without provision-access.yml.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, fakeAi, fakeWorkflow, migratedDb } from "./harness.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { proposeFromAgent } from "../../recovery-manager/src/index.ts";
import { verifySyscallDecision } from "../src/capabilities.ts";
import { DeploymentLock, accessForConsensus, accessPlanSummary } from "../../deployment-orchestrator/src/index.ts";
import { ACCESS_APP_NAME, CloudflareApi, NEXUS_GROUP, PLATFORM_WORKERS, PUBLIC_HOSTNAMES, PUBLIC_PATHS, applyAccess, planAccess } from "../../deployment-orchestrator/src/native-access.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { ACCESS_CHECK_MINUTES, runCycle } from "../../ai-kernel/src/supervisor.ts";
import { ownerDecide } from "../../ai-kernel/src/consensus.ts";
import { ownerInbox } from "../../ai-kernel/src/owner-inbox.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const ACCOUNT = "a".repeat(32);
const realFetch = globalThis.fetch;
const CI_TOKEN = "11111111-1111-4111-8111-111111111111";
const AGENT_TOKEN = "22222222-2222-4222-8222-222222222222";
const NEW_AGENT = "33333333-3333-4333-8333-333333333333";
const GROUP = "44444444-4444-4444-8444-444444444444";
const IDP_GOOGLE = "55555555-5555-4555-8555-555555555555";
const IDP_PIN = "66666666-6666-4666-8666-666666666666";
const APP_ID = "77777777-7777-4777-8777-777777777777";
const tagOf = (name: string) => [...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, "0").repeat(4).slice(0, 32);

// ---------------------------------------------------------------- a fake Cloudflare account (Access + Workers)
interface World {
  scripts: Map<string, { tag: string; subdomain?: { enabled: boolean; previews_enabled: boolean } }>;
  apps: any[];
  tokens: Array<{ id: string; name: string }>;
  groups: Array<{ id: string; name: string }>;
  idps: Array<{ id: string; type: string; name: string }>;
  puts: any[];
}
function workflowApp(w: World): any {
  // Exactly what provision-access.yml writes (its body), as the API returns it (policies get ids).
  return {
    id: APP_ID, aud: "aud-1", name: ACCESS_APP_NAME, type: "self_hosted", session_duration: "8h", app_launcher_visible: false, auto_redirect_to_identity: false,
    destinations: [...PLATFORM_WORKERS.map((n) => ({ type: "worker", worker_id: w.scripts.get(n)!.tag })), ...PUBLIC_HOSTNAMES.map((uri) => ({ type: "public", uri })), ...PUBLIC_PATHS.map((uri) => ({ type: "public", uri }))],
    policies: [
      { id: "p1", name: "ci-service-token", decision: "non_identity", precedence: 1, include: [{ service_token: { token_id: CI_TOKEN } }] },
      { id: "p2", name: "platform-operators", decision: "allow", precedence: 2, include: [{ email: { email: "owner@example.com" } }, { group: { id: GROUP } }] },
      { id: "p3", name: "external-agents", decision: "non_identity", precedence: 3, include: [{ service_token: { token_id: AGENT_TOKEN } }] },
    ],
    allowed_idps: [IDP_GOOGLE, IDP_PIN],
  };
}
function world(): World {
  const w: World = {
    scripts: new Map(PLATFORM_WORKERS.map((n) => [n, { tag: tagOf(n) }])),
    apps: [], tokens: [{ id: CI_TOKEN, name: "cryptophys-ci" }, { id: AGENT_TOKEN, name: "cryptophys-agent-hermes" }, { id: "88888888-8888-4888-8888-888888888888", name: "someone-else" }],
    groups: [{ id: GROUP, name: NEXUS_GROUP }], idps: [{ id: IDP_GOOGLE, type: "google", name: "Google" }, { id: IDP_PIN, type: "onetimepin", name: "PIN" }, { id: "99999999-9999-4999-8999-999999999999", type: "saml", name: "Other" }],
    puts: [],
  };
  w.apps = [workflowApp(w), { id: "other-app", aud: "x", name: "something-else", policies: [], destinations: [] }];
  return w;
}
function fakeCloudflare(w: World, opts: { status?: (method: string, path: string) => number | undefined; tamperPut?: (body: any) => any } = {}) {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const prefix = `/client/v4/accounts/${ACCOUNT}/`;
    assert.ok(url.hostname === "api.cloudflare.com" && url.pathname.startsWith(prefix), `unexpected ${url}`);
    const path = url.pathname.slice(prefix.length);
    const auth = new Headers(init?.headers).get("authorization");
    calls.push(`${method} ${path}`);
    const forced = opts.status?.(method, path);
    if (forced !== undefined) return Response.json({ success: false, errors: [{ code: forced }] }, { status: forced });
    const ok = (result: unknown, info?: unknown) => Response.json({ success: true, result, ...(info ? { result_info: info } : {}) });
    if (path.startsWith("workers/")) assert.equal(auth, "Bearer deploy-token", "Workers calls use CF_DEPLOY_TOKEN");
    if (path.startsWith("access/")) assert.equal(auth, "Bearer access-token", "Access calls use CF_ACCESS_TOKEN");
    if (path === "workers/scripts" && method === "GET") return ok([...w.scripts].map(([id, s]) => ({ id, tag: s.tag })));
    let m = /^workers\/scripts\/([a-z0-9-]+)$/.exec(path);
    if (m && method === "PUT") {
      assert.ok(!w.scripts.has(m[1]), "an existing Worker is never overwritten");
      assert.ok(init?.body instanceof FormData);
      w.scripts.set(m[1], { tag: tagOf(m[1]) });
      return ok({ id: m[1] });
    }
    m = /^workers\/scripts\/([a-z0-9-]+)\/subdomain$/.exec(path);
    if (m && method === "POST") { w.scripts.get(m[1])!.subdomain = JSON.parse(String(init!.body)); return ok({}); }
    const page = Number(url.searchParams.get("page") ?? "1");
    if (path === "access/apps" && method === "GET") return ok(page === 1 ? w.apps : [], { total_pages: 1 });
    if (path === "access/service_tokens") return ok(page === 1 ? w.tokens : [], { total_pages: 1 });
    if (path === "access/groups") return ok(page === 1 ? w.groups : [], { total_pages: 1 });
    if (path === "access/identity_providers") return ok(w.idps);
    m = /^access\/apps\/([0-9a-z-]+)$/.exec(path);
    if (m && method === "PUT") {
      const body = JSON.parse(String(init!.body));
      w.puts.push(body);
      const i = w.apps.findIndex((a) => a.id === m![1]);
      const stored = { ...(opts.tamperPut ? opts.tamperPut(body) : body), id: w.apps[i].id, aud: w.apps[i].aud, policies: (opts.tamperPut ? opts.tamperPut(body) : body).policies.map((p: any, j: number) => ({ id: `n${j}`, ...p })) };
      w.apps[i] = stored;
      return ok(stored);
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  return { fetcher, calls };
}
const clients = (fetcher: typeof fetch) => ({ access: new CloudflareApi("access-token", ACCOUNT, fetcher), scripts: new CloudflareApi("deploy-token", ACCOUNT, fetcher) });

// ---------------------------------------------------------------- tests
test("NA1. the definition is provision-access.yml's: the same application, Workers, hostnames, paths and group", () => {
  const yml = read(".github/workflows/provision-access.yml");
  const env = (k: string) => (new RegExp(`^  ${k}: >-\\n((?:    .*\\n)+)`, "m").exec(yml)?.[1] ?? new RegExp(`^  ${k}: (.*)$`, "m").exec(yml)![1]).trim().split(/\s+/);
  assert.deepEqual([...PLATFORM_WORKERS], env("PLATFORM_WORKERS"));
  assert.deepEqual([...PUBLIC_HOSTNAMES], env("PUBLIC_HOSTNAMES"));
  assert.deepEqual([...PUBLIC_PATHS], env("PUBLIC_PATHS"));
  assert.deepEqual([ACCESS_APP_NAME], env("ACCESS_APP_NAME"));
  assert.match(yml, new RegExp(`group_name="${NEXUS_GROUP}"`));
  assert.match(read(".github/scripts/find-agent-service-tokens.sh"), /^prefix="cryptophys-agent-"$/m);
  assert.match(yml, /session_duration: "8h"/);
});

test("NA2. the application the workflow wrote is in sync; planning only reads", async () => {
  const w = world();
  const { fetcher, calls } = fakeCloudflare(w);
  const { access, scripts } = clients(fetcher);
  const plan = await planAccess(access, scripts);
  assert.ok(plan.ok, JSON.stringify(plan));
  assert.deepEqual([plan.ok && plan.in_sync, plan.ok && plan.changes], [true, []]);
  assert.ok(calls.every((c) => c.startsWith("GET ")), "planning never writes");
  assert.equal((await planAccess(access, scripts) as any).digest, (plan as any).digest, "the digest is stable");
});

test("NA3. differences are listed for the owner; operators and the CI token are kept; refusals fail closed", async () => {
  const w = world();
  w.tokens.push({ id: NEW_AGENT, name: "cryptophys-agent-pi" });
  w.apps[0].destinations = w.apps[0].destinations.filter((d: any) => d.worker_id !== tagOf("cryptophys-forge"));
  w.apps[0].session_duration = "24h";
  const { fetcher } = fakeCloudflare(w);
  const { access, scripts } = clients(fetcher);
  const plan = await planAccess(access, scripts);
  assert.ok(plan.ok && !plan.in_sync);
  assert.deepEqual(plan.ok && plan.changes, [
    "add destination worker:cryptophys-forge",
    `policy external-agents: add service_token:${NEW_AGENT}`,
    "session_duration: 24h -> 8h",
  ]);
  const ops = plan.ok && plan.body!.policies.find((p) => p.name === "platform-operators");
  assert.deepEqual(ops && ops.include, [{ email: { email: "owner@example.com" } }, { group: { id: GROUP } }], "the operator emails are the live ones");

  const refusal = async (mutate: (w: World) => void) => {
    const x = world(); mutate(x);
    const r = await planAccess(...Object.values(clients(fakeCloudflare(x).fetcher)) as [CloudflareApi, CloudflareApi]);
    return r.ok ? "ok" : r.reason;
  };
  assert.equal(await refusal((x) => { x.apps = x.apps.filter((a) => a.name !== ACCESS_APP_NAME); }), "access_application_missing");
  assert.equal(await refusal((x) => { x.apps.push({ ...x.apps[0], id: "dup" }); }), "more_than_one_access_application");
  assert.equal(await refusal((x) => { x.tokens = x.tokens.filter((t) => t.id !== CI_TOKEN); }), "ci_service_token_missing");
  assert.equal(await refusal((x) => { x.groups = []; }), "access_group_missing");
  assert.equal(await refusal((x) => { x.apps[0].policies[1].include = [{ group: { id: GROUP } }]; }), "operator_emails_unreadable");
  assert.equal(await refusal((x) => { x.apps[0].policies = x.apps[0].policies.filter((p: any) => p.name !== "ci-service-token"); }), "ci_service_token_policy_unreadable");
  const forbidden = await planAccess(...Object.values(clients(fakeCloudflare(world(), { status: (m, p) => p.startsWith("access/") ? 403 : undefined }).fetcher)) as [CloudflareApi, CloudflareApi]);
  assert.match(forbidden.ok ? "" : forbidden.reason, /^cloudflare_api_403/);
});

test("NA4. applying: only the approved plan; a new Worker is bootstrapped first as a private stub; the result is read back", async () => {
  // A plan that changed since the approval changes nothing.
  let w = world();
  w.tokens.push({ id: NEW_AGENT, name: "cryptophys-agent-pi" });
  let cf = fakeCloudflare(w);
  let { access, scripts } = clients(cf.fetcher);
  let run = await applyAccess(access, scripts, "f".repeat(64));
  assert.deepEqual([run.ok, run.reason, run.changed, w.puts.length], [false, "plan_changed_since_approval", false, 0]);

  // A new platform Worker (no script yet) and a new agent token: stub first, then the application, then verified.
  w = world();
  w.scripts.delete("cryptophys-forge");
  w.apps[0].destinations = w.apps[0].destinations.filter((d: any) => d.worker_id !== tagOf("cryptophys-forge"));
  w.tokens.push({ id: NEW_AGENT, name: "cryptophys-agent-pi" });
  cf = fakeCloudflare(w);
  ({ access, scripts } = clients(cf.fetcher));
  const plan = await planAccess(access, scripts);
  assert.ok(plan.ok);
  assert.deepEqual(plan.ok && plan.changes.slice(0, 2), ["create private stub cryptophys-forge (workers.dev and previews disabled)", "add destination worker:cryptophys-forge"]);
  run = await applyAccess(access, scripts, (plan as any).digest);
  assert.deepEqual([run.ok, run.changed, run.steps], [true, true, ["bootstrapped cryptophys-forge", "updated the application", "verified in sync"]], JSON.stringify(run));
  assert.deepEqual(w.scripts.get("cryptophys-forge")!.subdomain, { enabled: false, previews_enabled: false }, "the stub is private");
  assert.equal(w.puts.length, 1);
  assert.ok(w.puts[0].destinations.some((d: any) => d.worker_id === tagOf("cryptophys-forge")), "the new Worker is protected by its tag");
  assert.equal(w.apps.find((a) => a.name === "something-else")?.id, "other-app", "no other application is touched");
  assert.ok((await planAccess(access, scripts) as any).in_sync);

  // The update does not read back as planned: a failure after a change.
  w = world();
  w.tokens.push({ id: NEW_AGENT, name: "cryptophys-agent-pi" });
  cf = fakeCloudflare(w, { tamperPut: (b) => ({ ...b, session_duration: "720h" }) });
  ({ access, scripts } = clients(cf.fetcher));
  run = await applyAccess(access, scripts, ((await planAccess(access, scripts)) as any).digest);
  assert.deepEqual([run.ok, run.changed], [false, true]);
  assert.match(String(run.reason), /^not_in_sync_after_update/);
});

// ---------------------------------------------------------------- end to end: Supervisor -> owner click -> Orchestrator
function lockNs() {
  const stores = new Map<string, Map<string, unknown>>();
  return { idFromName: (n: string) => n, get: (id: unknown) => {
    const key = String(id); if (!stores.has(key)) stores.set(key, new Map()); const data = stores.get(key)!;
    const lock = new DeploymentLock({ storage: { get: async (k: string) => data.get(k) as never, put: async (k: string, v: unknown) => { data.set(k, v); }, delete: async (k: string) => data.delete(k) }, blockConcurrencyWhile: (cb) => cb() });
    return { fetch: (i: RequestInfo | URL, init?: RequestInit) => lock.fetch(new Request(i, init)) };
  } };
}
function kernelEnv(db: Db, fetcher: typeof fetch, extra: Record<string, unknown> = {}) {
  const reports: any[] = [];
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const recoveryEnv = { ...baseEnv("cryptophys-recovery-manager", db), RECOVERY_LIFECYCLE: fakeWorkflow().binding };
  const orch = baseEnv("cryptophys-deployment-orchestrator", db, {
    DEPLOYMENT_LOCK: lockNs(), CF_DEPLOY_TOKEN: "deploy-token", CF_ACCOUNT_ID: ACCOUNT, CF_ACCESS_TOKEN: "access-token",
    AGENTS: { syscall: async (_a: string, _c: string, input: unknown) => { reports.push(input); return { outcome: "succeeded" }; } }, ...extra,
  });
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async (agentId: string, decisionId: string, input: Record<string, unknown>) => { await verifySyscallDecision(db, decisionId, agentId, "recovery.propose"); return proposeFromAgent(recoveryEnv as never, agentId, input); } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    DEPLOY: {
      pendingDeploys: async () => ({ main_sha: null, ci_green: false, units: [], skipped: [] }),
      deployForConsensus: async () => { throw new Error("not in this test"); },
      retireForConsensus: async () => { throw new Error("not in this test"); },
      accessPlan: () => accessPlanSummary(orch as never, fetcher),
      accessForConsensus: (id: string, dec: string, digest: string) => accessForConsensus(orch as never, id, dec, digest, fetcher),
    },
  };
  const mem = new Map<string, unknown>();
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, structuredClone(v)); } };
  return { env, memory, reports };
}
const hourStart = () => { const d = new Date(); d.setUTCMinutes(7, 0, 0); return d.getTime(); };
const last = (db: Db) => db.raw.prepare("SELECT * FROM consensus_proposals WHERE action = 'change_access' ORDER BY rowid DESC LIMIT 1").get() as any;

test("NA5. end to end: the Supervisor proposes the Access change; it waits for the owner's click, then applies exactly that plan, once", async () => {
  assert.ok(ACCESS_CHECK_MINUTES > 7);
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  const w = world();
  w.tokens.push({ id: NEW_AGENT, name: "cryptophys-agent-pi" });
  const { fetcher } = fakeCloudflare(w);
  const { env, memory } = kernelEnv(db, fetcher);
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => String(i).includes("access/certs") ? (await import("./harness.ts")).accessCertsResponse() : fetcher(i, init)) as typeof fetch;
  try {
    await runCycle(env as never, memory, "scheduled", hourStart());
    const p = last(db);
    assert.equal(p.status, "pending_owner", p.outcome_json);
    const params = JSON.parse(p.params_json);
    assert.deepEqual(params.changes, [`policy external-agents: add service_token:${NEW_AGENT}`]);
    assert.match(params.digest, /^[0-9a-f]{64}$/);
    assert.equal(w.puts.length, 0, "nothing changes before the click");
    // The Owner page lists exactly those changes.
    const inbox = await ownerInbox(db as never);
    assert.deepEqual(inbox.approvals.consensus.map((c: any) => [c.action, c.executable, c.changes]), [["change_access", true, params.changes]]);
    // The next cycle does not propose the same plan again.
    await runCycle(env as never, memory, "scheduled", hourStart() + 1000);
    assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM consensus_proposals WHERE action = 'change_access'").get() as any).n, 1);
    // The owner approves: the Orchestrator applies that plan.
    const r = await ownerDecide(env as never, p.proposal_id, "approve", APPROVER_EMAIL, "add the new agent");
    assert.equal(r.status, "executed", JSON.stringify(r));
    assert.equal(w.puts.length, 1);
    assert.ok(w.puts[0].policies.find((x: any) => x.name === "external-agents").include.some((i: any) => i.service_token.token_id === NEW_AGENT));
    const audit = db.raw.prepare("SELECT event_type, outcome FROM audit_events WHERE event_type LIKE 'access.%'").all().map((e: any) => `${e.event_type}:${e.outcome}`);
    assert.deepEqual(audit, ["access.applied:succeeded"]);
    // In sync now: the next hourly check proposes nothing.
    await runCycle(env as never, memory, "scheduled", hourStart() + 3_600_000);
    assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM consensus_proposals WHERE action = 'change_access'").get() as any).n, 1);
  } finally { globalThis.fetch = realFetch; }
});

test("NA6. without CF_ACCESS_TOKEN nothing is proposed; a plan that moved since the click is refused and warns, changing nothing", async () => {
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  const w = world();
  w.tokens.push({ id: NEW_AGENT, name: "cryptophys-agent-pi" });
  const { fetcher } = fakeCloudflare(w);
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => String(i).includes("access/certs") ? (await import("./harness.ts")).accessCertsResponse() : fetcher(i, init)) as typeof fetch;
  try {
    const off = kernelEnv(db, fetcher, { CF_ACCESS_TOKEN: undefined });
    await runCycle(off.env as never, off.memory, "scheduled", hourStart());
    assert.equal(last(db), undefined, "not configured: no proposal");
    const { env, memory, reports } = kernelEnv(db, fetcher);
    await runCycle(env as never, memory, "scheduled", hourStart());
    const p = last(db);
    assert.equal(p.status, "pending_owner");
    // Before the click, another agent token appears: the approved plan is no longer current.
    w.tokens.push({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "cryptophys-agent-other" });
    const r = await ownerDecide(env as never, p.proposal_id, "approve", APPROVER_EMAIL, "ok");
    assert.equal(r.status, "failed");
    assert.match(JSON.stringify(r.outcome), /plan_changed_since_approval/);
    assert.equal(w.puts.length, 0);
    assert.equal(reports.at(-1).severity, "warning");
    assert.equal(reports.at(-1).body.changed, false);
  } finally { globalThis.fetch = realFetch; }
});
