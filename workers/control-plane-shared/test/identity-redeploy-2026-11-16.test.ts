// Owner 2026-11-16 ("1. Ya"): the redeploy for identities. After an owner saves the identity list on the Console's Users
// page, every unit whose active Workers carry another identity value than the saved row gives is redeployed at the
// commit it runs (no new code), so the native deploy writes and verifies the new lists without waiting for an unrelated
// deploy. The Supervisor proposes a routine deploy_commit with `redeploy: "identity_vars"` and the row's revision; the
// council, the Policy Engine, the brake and the rate limits treat it as any deploy_commit; the Orchestrator checks the
// row (owner-saved, that revision), the running commit, the plan (no migration) and that a value differs, when it queues
// the request and again before its executor runs. One redeploy per unit and revision.
//
// Runs in the Forge: no npm package imports, no node:test mock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, accessCertsResponse, baseEnv, call, fakeAi, fakeWorkflow, forgeSees, isAccessCerts, migratedDb, req,
} from "./harness.ts";
import { DEPLOY_UNITS, unitForService } from "../src/deploy-units.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { verifySyscallDecision } from "../src/capabilities.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import { deployStall } from "../src/deploy-stall.ts";
import {
  IDENTITY_REDEPLOY, IDENTITY_REDEPLOY_RETRIES, IDENTITY_REDEPLOY_RETRY_AFTER_MS, identityAttemptOf, identityClientHash, identityRedeployKey, identityRedeployParams,
} from "../src/identity-redeploy.ts";
import { describeAction, describeProposal } from "../src/plain.ts";
import { storeBundles, type BuiltModule, type BundleBucket } from "../../forge/src/bundles.ts";
import registry from "../../platform-registry/src/index.ts";
import { recordNativeDeploy, recordRollback } from "../../platform-registry/src/index.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { proposeFromAgent } from "../../recovery-manager/src/index.ts";
import { DeploymentLock, deployForConsensus, identityDrift, pendingDeploys, runNativeExecutors, seedIdentities } from "../../deployment-orchestrator/src/index.ts";
import { DEPLOY_VARS } from "../../deployment-orchestrator/src/deploy-vars.ts";
import { SAFE_MINUTES } from "../../deployment-orchestrator/src/native-rollback.ts";
import { DEPLOY_RETRIES_PER_COMMIT, DEPLOY_RETRY_AFTER_MS, runCycle } from "../../ai-kernel/src/supervisor.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const realFetch = globalThis.fetch;

const ACCOUNT = "a".repeat(32);
const AUD = "f".repeat(64);
const TEAM = "cryptophys.cloudflareaccess.com";
const CLIENT = "ci0123456789abcdef.access";
const HASH = await identityClientHash(CLIENT);
/** A rotated CI service token (owner 2026-11-16: the redeploy follows it, once per unit, for the same revision). */
const ROTATED = "ci-rotated-0001.access";
const SECRET = "s3cr3t-value";
const SUBDOMAIN = "cryptophys";
/** The commit every unit runs, and main's head (a docs-only commit: no unit is pending). */
const RUN = "6a".repeat(20);
const RUN_TAG = RUN.slice(0, 12);
const MAIN = "7b".repeat(20);
/** What the workflows deployed (ACCESS_ALLOWED_EMAILS), and what the owner saves. */
const OLD_EMAILS = [APPROVER_EMAIL, OPERATOR_EMAIL];
const NEW_EMAILS = [APPROVER_EMAIL, "new.operator@cryptophys.work"];
const varsOf = (emails: string[]): Record<string, string> => ({
  ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, CF_ACCOUNT_ID: ACCOUNT,
  OPERATOR_IDENTITIES: `${CLIENT},${emails.join(",")}`, DEPLOY_ALLOWED_IDENTITIES: `${CLIENT},${emails.join(",")}`, APPROVER_IDENTITIES: emails.join(","),
});
const PLATFORM_API = "cryptophys-platform-api";
const FORGE = "cryptophys-forge";
const UNIT_SERVICES = DEPLOY_UNITS.flatMap((u) => [...u.services]);
const MIGRATIONS = (migratedDb().raw.prepare("SELECT name FROM d1_migrations ORDER BY id").all() as Array<{ name: string }>).map((r) => r.name);

// ---------------------------------------------------------------- the Forge's bundles (R2), for the running commit only
function bucket() {
  const objects = new Map<string, { value: string; uploaded: Date }>();
  const b: BundleBucket & { objects: typeof objects; get(key: string): Promise<{ text(): Promise<string> } | null> } = {
    objects,
    async put(key, value) { objects.set(key, { value, uploaded: new Date() }); return {}; },
    async get(key) { const o = objects.get(key); return o ? { text: async () => o.value } : null; },
    async list({ prefix = "", cursor, limit = 1000 } = {}) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = keys.slice(start, start + limit);
      return { objects: page.map((key) => ({ key, uploaded: objects.get(key)!.uploaded })), truncated: start + limit < keys.length, cursor: String(start + limit) };
    },
    async delete(keys) { for (const k of [keys].flat()) objects.delete(k); },
  };
  return b;
}
type Bucket = ReturnType<typeof bucket>;
const moduleText = (name: string) => `export default { fetch() { return new Response("${name} ${RUN_TAG}"); } };`;
async function bundlesFor(b: Bucket, commit: string) {
  const built: BuiltModule[] = [];
  // The Console (static assets) has no stored build here: it is skipped with its reason.
  for (const name of UNIT_SERVICES.filter((s) => s !== "cryptophys-console")) {
    built.push({ dir: `workers/${name.replace("cryptophys-", "")}`, text: moduleText(name), toml: `name = "${name}"\nmain = "src/worker.ts"\ncompatibility_date = "2026-11-01"\n`, external: [] });
  }
  await storeBundles(b, commit, built, Date.now(), MIGRATIONS, { migrationSql: Object.fromEntries(MIGRATIONS.map((f) => [f, `-- ${f}\nSELECT 1;\n`])), externals: async () => new Map() });
}

// ---------------------------------------------------------------- Cloudflare (Workers API) and the public internet behind Access
type Binding = Record<string, unknown> & { type: string; name: string };
const productionBindings = (service: string, emails: string[]): Binding[] => {
  const unit = unitForService(service)!.unit;
  const v = varsOf(emails);
  return [
    { type: "d1", name: "DB", id: "11111111-2222-3333-4444-555555555555" },
    { type: "secret_text", name: "CF_DEPLOY_TOKEN" },
    { type: "plain_text", name: "SERVICE_NAME", text: service },
    ...(DEPLOY_VARS[unit][service] ?? []).map((n) => ({ type: "plain_text", name: n, text: v[n] })),
  ];
};
/**
 * Every deploy unit's Workers; `emails(service)` is the list each one was deployed with. A version upload binds what it
 * sends plus the kept types of the script's latest version, as Cloudflare does. The workers.dev probes answer through a
 * fake Access that requires the Orchestrator's service token.
 */
function fakeCloud(emails: (service: string) => string[]) {
  let n = 0;
  const uuid = () => `${String(++n).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const scripts = new Map<string, { active: Array<{ version_id: string; percentage: number }>; versions: Map<string, { bindings: Binding[]; tag?: string; module?: string }> }>();
  for (const svc of UNIT_SERVICES) {
    const id = uuid();
    scripts.set(svc, { active: [{ version_id: id, percentage: 100 }], versions: new Map([[id, { bindings: productionBindings(svc, emails(svc)), tag: RUN_TAG }]]) });
  }
  const uploads: Array<{ script: string; metadata: any; module: string }> = [];
  const calls: string[] = [];
  const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (isAccessCerts(url)) return accessCertsResponse();
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    if (url === `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/subdomain`) return reply(200, { success: true, result: { subdomain: SUBDOMAIN } });
    const host = /^https:\/\/([a-z0-9-]+)\.cryptophys\.workers\.dev(\/.*)$/.exec(url);
    if (host) {
      calls.push(`probe ${host[1]}${host[2]}`);
      if (headers.get("CF-Access-Client-Id") !== cloud.client || headers.get("CF-Access-Client-Secret") !== SECRET) return reply(302);
      const name = host[1] === PLATFORM_API ? "cryptophys-cloud-platform" : host[1];
      if (host[2] === "/health") return reply(200, { status: "ok", service: name, environment: "production", contract_version: "v1", version: { id: "v", tag: RUN_TAG } });
      if (host[2] === "/ready") return reply(200, { status: "ready", service: name, production_ready: true, checks: { a: true } });
      if (host[1] === FORGE && host[2] === "/v1/forge/status") return reply(200, { repo: { name: "platform" }, head: { sha: MAIN } });
      return reply(404, { error: "not_found" });
    }
    const m = new RegExp(`^https://api\\.cloudflare\\.com/client/v4/accounts/${ACCOUNT}/workers/scripts/([a-z0-9-]+)/(.*)$`).exec(url);
    if (!m) throw new Error(`unexpected ${method} ${url}`);
    assert.equal(headers.get("authorization"), "Bearer deploy-token");
    const [, script, rest] = m;
    const s = scripts.get(script);
    if (!s) return reply(404, { success: false, errors: [{ code: 10007 }] });
    calls.push(`${method} ${script} ${rest.replace(/[0-9a-f-]{36}/, "<id>")}`);
    if (rest === "deployments" && method === "GET") return reply(200, { success: true, result: { deployments: [{ created_on: "2026-11-16T00:00:00Z", versions: s.active }] } });
    if (rest === "deployments" && method === "POST") { s.active = JSON.parse(String(init!.body)).versions; return reply(200, { success: true, result: { id: "dep" } }); }
    if (rest === "versions" && method === "POST") {
      const form = init!.body as FormData;
      const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
      const main = form.get(metadata.main_module) as Blob | null;
      const module = main ? await main.text() : "";
      uploads.push({ script, metadata, module });
      const latest = [...s.versions.values()].at(-1)!;
      const sent: Binding[] = (metadata.bindings ?? []).map((b: Binding) => ({ ...b }));
      const keep: string[] = metadata.keep_bindings ?? [];
      const kept = latest.bindings.filter((b) => keep.includes(b.type) && !sent.some((x) => x.name === b.name));
      const id = uuid();
      s.versions.set(id, { bindings: [...structuredClone(kept), ...sent], tag: metadata.annotations?.["workers/tag"], module });
      return reply(200, { success: true, result: { id } });
    }
    const vm = /^versions\/([0-9a-f-]{36})$/.exec(rest);
    if (vm && method === "GET") {
      const v = s.versions.get(vm[1]);
      return v ? reply(200, { success: true, result: { id: vm[1], resources: { bindings: structuredClone(v.bindings), script_runtime: { compatibility_date: "2026-11-01", compatibility_flags: [] } } } })
        : reply(404, { success: false, errors: [{ code: 10007 }] });
    }
    throw new Error(`unexpected ${method} ${url}`);
  }) as typeof fetch;
  const live = (svc: string) => { const sc = scripts.get(svc)!; return sc.versions.get(sc.active[0].version_id)!; };
  const liveText = (svc: string, name: string) => live(svc).bindings.find((b) => b.name === name)?.text;
  /** A dashboard edit: a new version of the script with `emails` in its identity lists, made active. */
  const dashboardEdit = (svc: string, list: string[]) => {
    const id = uuid();
    scripts.get(svc)!.versions.set(id, { bindings: productionBindings(svc, list) });
    scripts.get(svc)!.active = [{ version_id: id, percentage: 100 }];
  };
  const cloud = { fetcher, uploads, calls, scripts, live, liveText, dashboardEdit, client: CLIENT };
  return cloud;
}
type Cloud = ReturnType<typeof fakeCloud>;

// ---------------------------------------------------------------- the Orchestrator, the Registry and the AI Kernel on one D1
function lockNs() {
  const stores = new Map<string, Map<string, unknown>>();
  return { idFromName: (x: string) => x, get: (id: unknown) => {
    const key = String(id); if (!stores.has(key)) stores.set(key, new Map()); const data = stores.get(key)!;
    const lock = new DeploymentLock({ storage: { get: async (k: string) => data.get(k) as never, put: async (k: string, v: unknown) => { data.set(k, v); }, delete: async (k: string) => data.delete(k) }, blockConcurrencyWhile: (cb) => cb() });
    return { fetch: (i: RequestInfo | URL, init?: RequestInit) => lock.fetch(new Request(i, init)) };
  } };
}
interface World { db: Db; b: Bucket; cloud: Cloud; orch: Record<string, unknown>; kernel: Record<string, unknown>; memory: { get<T>(k: string): Promise<T | undefined>; put(k: string, v: unknown): Promise<void> }; reports: unknown[] }

/**
 * Production on day one: every unit runs RUN with the lists the workflows deployed (OLD_EMAILS), except the units
 * `current` names, which already carry NEW_EMAILS. Main's head is a docs commit (nothing pending). The seed is written.
 */
async function world(opts: { current?: string[]; mode?: "shadow" | "deploy" } = {}): Promise<World> {
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = ? WHERE control = 'mode'").run(opts.mode ?? "deploy");
  db.raw.prepare(`UPDATE service_registry SET desired_version = ? WHERE service_id IN (${UNIT_SERVICES.map(() => "?").join(", ")})`).run(RUN_TAG, ...UNIT_SERVICES);
  await forgeSees(db, { main: MAIN, files: ["docs/OPERATIONS.md"], ready: true });
  const b = bucket();
  await bundlesFor(b, RUN);
  const current = new Set(opts.current ?? []);
  const cloud = fakeCloud((svc) => current.has(unitForService(svc)!.unit) ? NEW_EMAILS : OLD_EMAILS);
  const reports: unknown[] = [];
  const old = varsOf(OLD_EMAILS);
  const orch = baseEnv("cryptophys-deployment-orchestrator", db, {
    GH_ACTIONS_TOKEN: "", DEPLOYMENT_LOCK: lockNs(), CF_DEPLOY_TOKEN: "deploy-token", CF_ACCOUNT_ID: ACCOUNT, BUNDLES: b,
    ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, CF_ACCESS_CLIENT_ID: CLIENT, CF_ACCESS_CLIENT_SECRET: SECRET,
    OPERATOR_IDENTITIES: old.OPERATOR_IDENTITIES, APPROVER_IDENTITIES: old.APPROVER_IDENTITIES,
    DRIFT: { probeService: async () => ({ reachable: true, healthy: true, version_tag: RUN_TAG, error: null }) },
    REGISTRY: { recordRollback: (id: string) => recordRollback({ DB: db } as never, id), recordNativeDeploy: (id: string) => recordNativeDeploy({ DB: db } as never, id) },
    AGENTS: { syscall: async (_a: string, _c: string, input: unknown) => { reports.push(input); return { outcome: "succeeded" }; } },
  });
  assert.deepEqual(await seedIdentities(orch as never), { seeded: true, emails: 2 });
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const recoveryEnv = { ...baseEnv("cryptophys-recovery-manager", db), RECOVERY_LIFECYCLE: fakeWorkflow().binding };
  const kernel: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async (agentId: string, decisionId: string, input: Record<string, unknown>) => { await verifySyscallDecision(db, decisionId, agentId, "recovery.propose"); return proposeFromAgent(recoveryEnv as never, agentId, input); } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    DEPLOY: {
      pendingDeploys: async () => pendingDeploys(orch as never),
      deployForConsensus: async (id: string, dec: string, target: string, params: Record<string, unknown>) => deployForConsensus(orch as never, id, dec, target, params),
      identityDrift: async () => identityDrift(orch as never, cloud.fetcher),
    },
  };
  const mem = new Map<string, unknown>();
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, structuredClone(v)); } };
  return { db, b, cloud, orch, kernel, memory, reports };
}

const regEnv = (db: Db) => baseEnv("cryptophys-platform-registry", db, { APPROVER_IDENTITIES: APPROVER_EMAIL });
/** The owner's click on the Users page: POST /v1/identities with the revision the form showed. */
async function ownerSaves(db: Db, emails: string[]): Promise<number> {
  const current = (db.raw.prepare("SELECT revision FROM platform_identities WHERE id = 'access'").get() as { revision: number } | undefined)?.revision ?? null;
  const r = await call(registry, regEnv(db), req("POST", "/v1/identities", { emails, revision: current, confirm: "IDENTITIES" }, APPROVER_JWT));
  assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.body));
  return r.body.source.revision as number;
}
/** One scheduled Supervisor cycle, with the fake Cloudflare as the network (the Orchestrator's own client uses it). */
async function cycle(w: World) {
  globalThis.fetch = w.cloud.fetcher;
  try { return await runCycle(w.kernel as never, w.memory as never, "scheduled"); } finally { globalThis.fetch = realFetch; }
}
const nextSafeMinute = (after: number): number => {
  const first = Math.ceil(after / 60_000) * 60_000;
  for (let i = 0; i < 60; i++) { const c = first + i * 60_000; if (SAFE_MINUTES.includes(new Date(c).getUTCMinutes())) return c; }
  throw new Error("no safe minute");
};
const execute = (w: World) => runNativeExecutors(w.orch as never, nextSafeMinute(Date.now() + 1_000), w.cloud.fetcher, { delayMs: 0 });
const deployProposals = (db: Db) => (db.raw.prepare("SELECT * FROM consensus_proposals WHERE action = 'deploy_commit' ORDER BY created_at, rowid").all() as any[])
  .map((p) => ({ ...p, params: JSON.parse(p.params_json), outcome: p.outcome_json ? JSON.parse(p.outcome_json) : null }));
const events = (db: Db, type: string) => (db.raw.prepare("SELECT subject, outcome, payload_json FROM audit_events WHERE event_type = ? ORDER BY rowid").all(type) as any[])
  .map((r) => ({ subject: r.subject as string, outcome: r.outcome as string, payload: JSON.parse(r.payload_json) }));
const requests = (db: Db) => (db.raw.prepare("SELECT * FROM deployment_requests ORDER BY created_at, rowid").all() as any[]).map((r) => ({ ...r, details: JSON.parse(r.details_json) }));
const identityFindings = (c: { findings: Array<Record<string, unknown>> }) => c.findings.filter((f) => f.kind === "identity");
/** Make every executed deploy older than the Policy Engine's hour (one executed action per target an hour). */
const anHourLater = (db: Db) => db.raw.prepare("UPDATE consensus_proposals SET created_at = ?, decided_at = ?").run(new Date(Date.now() - 61 * 60_000).toISOString(), new Date(Date.now() - 61 * 60_000).toISOString());
let seq = 0;
/** A passed deploy_commit as the kernel records it before it calls the Orchestrator. */
function passedProposal(db: Db, target: string, params: Record<string, unknown>) {
  seq++;
  const proposal = `cns_${String(seq).padStart(8, "0")}-1111-4111-8111-111111111117`;
  const decision = `dec_${String(seq).padStart(8, "0")}-2222-4222-8222-222222222227`;
  const at = new Date().toISOString();
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES (?, 'supervisor', 'deploy_commit', ?, 'routine', ?, '{}', 'deploy', 8, 8, 0, 1, ?, 'allow', 'executing', NULL, ?, ?)`).run(proposal, target, JSON.stringify(params), decision, at, at);
  db.raw.prepare(`INSERT INTO policy_decisions (decision_id, subject, action, resource, decision, reason, evidence_json, created_at) VALUES (?, 'ai:kernel', 'consensus.execute', ?, 'allow', 'ok', '{}', ?)`)
    .run(decision, `deploy_commit:${target}`, at);
  return { proposal, decision };
}
const identityParams = (unit: string, revision: number, sha = RUN, client = HASH) => ({ commit_sha: sha, unit, workflow: DEPLOY_UNITS.find((u) => u.unit === unit)!.workflow, reason: "test", redeploy: IDENTITY_REDEPLOY, identity_revision: revision, identity_client: client });
async function orchestrate<T>(w: World, f: () => Promise<T>): Promise<T> {
  globalThis.fetch = w.cloud.fetcher;
  try { return await f(); } finally { globalThis.fetch = realFetch; }
}

// ================================================================= 1. the params, the key and the shared rules
test("IR-1. the params are strict, the key names the revision, and an identity redeploy is no deploy of main for the stall alarm", async () => {
  assert.equal(identityRedeployParams({ commit_sha: RUN }), null, "a deploy of main names no redeploy");
  assert.deepEqual(identityRedeployParams(identityParams("forge", 2)), { commit_sha: RUN, unit: "forge", revision: 2, client: HASH });
  assert.match(HASH, /^[0-9a-f]{8}$/);
  assert.deepEqual(identityRedeployParams({ ...identityParams("forge", 2), identity_client: CLIENT }), { problem: "identity_client_invalid" }, "a hash, never the Client ID");
  assert.deepEqual([identityAttemptOf({ identity_attempt: 1 }), identityAttemptOf({ identity_attempt: 3 }), identityAttemptOf({ identity_attempt: 4 }), identityAttemptOf({})], [1, 3, null, null]);
  // The retry rule is the main-deploy rule.
  assert.deepEqual([IDENTITY_REDEPLOY_RETRIES, IDENTITY_REDEPLOY_RETRY_AFTER_MS], [DEPLOY_RETRIES_PER_COMMIT, DEPLOY_RETRY_AFTER_MS]);
  assert.deepEqual(identityRedeployParams({ ...identityParams("forge", 2), redeploy: "anything" }), { problem: "identity_redeploy_unknown" });
  assert.deepEqual(identityRedeployParams({ ...identityParams("forge", 2), identity_revision: 0 }), { problem: "identity_revision_invalid" });
  assert.deepEqual(identityRedeployParams({ ...identityParams("forge", 2), identity_revision: "2" }), { problem: "identity_revision_invalid" });
  assert.deepEqual(identityRedeployParams({ ...identityParams("forge", 2), commit_sha: RUN_TAG }), { problem: "invalid_commit_sha" });
  assert.equal(identityRedeployKey("deploy-forge.yml", RUN, 3, HASH, 1), `consensus:deploy-forge.yml:${RUN}:identities:3:${HASH}:1`);
  assert.notEqual(identityRedeployKey("deploy-forge.yml", RUN, 3, HASH, 1), `consensus:deploy-forge.yml:${RUN}`, "never the key of the commit's own deploy");
  // The stall alarm counts deploys of main: an executed identity redeploy neither ends nor starts an episode.
  const db = migratedDb();
  const at = new Date().toISOString();
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES ('cns_ir1', 'supervisor', 'deploy_commit', ?, 'routine', ?, '{}', 'deploy', 8, 8, 0, 1, NULL, 'allow', 'executed', '{}', ?, ?)`).run(FORGE, JSON.stringify(identityParams("forge", 2)), at, at);
  assert.equal((await deployStall(db)).last_deploy, null);
  // No new consensus action: consensus-rules.ts and the Policy Engine are unchanged, so no guard path besides the docs.
  for (const f of ["workers/control-plane-shared/src/identity-redeploy.ts", "workers/deployment-orchestrator/src/identity-redeploy.ts", "workers/ai-kernel/src/identity-redeploy.ts", "workers/ai-kernel/src/supervisor.ts", "workers/deployment-orchestrator/src/index.ts"]) {
    assert.equal(criticalPathReason(f), null, f);
  }
  assert.doesNotMatch(read("workers/control-plane-shared/src/consensus-rules.ts"), /identity_vars|IDENTITY_REDEPLOY/);
});

// ================================================================= 2. detection
test("IR-2. the seed changes nothing; after the owner saves a new list, each unit whose active values differ is found at its running commit (names only)", async () => {
  const w = await world({ current: ["deployment-orchestrator", "control-plane"] });
  let d = await identityDrift(w.orch as never, w.cloud.fetcher);
  assert.deepEqual(d, { ok: true, source: "seed", revision: null, client: HASH, units: [], skipped: [], reason: "identity_source_seed" });
  assert.ok(!w.cloud.calls.length, "nothing is read from Cloudflare while the row is not owner-saved");
  const c0 = await cycle(w);
  assert.equal(deployProposals(w.db).length, 0, "the seed is never redeployed");
  assert.deepEqual(identityFindings(c0), []);

  const revision = await ownerSaves(w.db, NEW_EMAILS);
  assert.equal(revision, 2);
  d = await identityDrift(w.orch as never, w.cloud.fetcher);
  assert.ok(d.ok);
  if (!d.ok) return;
  assert.deepEqual([d.source, d.revision], ["owner", 2]);
  assert.deepEqual(d.units, [
    { unit: "platform-api", workflow: "deploy-platform-api.yml", target: PLATFORM_API, commit_sha: RUN, changed: { [PLATFORM_API]: ["OPERATOR_IDENTITIES"] } },
    { unit: "forge", workflow: "deploy-forge.yml", target: FORGE, commit_sha: RUN, changed: { [FORGE]: ["OPERATOR_IDENTITIES", "APPROVER_IDENTITIES"] } },
  ], "the Orchestrator and the Control Plane already carry the saved list");
  assert.deepEqual(d.skipped, [{ unit: "console", reason: "not_eligible: service_not_in_bundle (cryptophys-console)" }]);
  assert.ok(!JSON.stringify(d).includes("@") && !JSON.stringify(d).includes(CLIENT), "names only, never a value");
  assert.ok(!w.cloud.calls.some((c) => c.startsWith("POST")), "read only");
});

// ================================================================= 3. the redeploy, end to end
test("IR-3. the Supervisor proposes a deploy_commit of each drifted unit at its running commit; the native deploy writes and verifies the lists", async () => {
  const w = await world({ current: ["deployment-orchestrator", "control-plane"] });
  const revision = await ownerSaves(w.db, NEW_EMAILS);
  const c1 = await cycle(w);
  let ps = deployProposals(w.db);
  assert.equal(ps.length, 1, "one deploy proposal per cycle");
  assert.equal(ps[0].target, PLATFORM_API);
  assert.deepEqual({ ...ps[0].params, reason: undefined }, { ...identityParams("platform-api", revision), reason: undefined });
  assert.match(ps[0].params.reason, /identity lists revision 2: OPERATOR_IDENTITIES differ on 1 Worker\(s\); redeploy at the running commit 6a6a6a6a6a6a/);
  assert.equal(ps[0].status, "executed", JSON.stringify(ps[0].outcome));
  assert.equal(ps[0].class, "routine");
  assert.ok(identityFindings(c1).some((f) => f.action === "consensus.propose" && f.service_id === PLATFORM_API));
  // Queued for the native executor, keyed by the revision, with the signed redeploy details; GitHub is not involved.
  let rs = requests(w.db);
  assert.equal(rs.length, 1);
  assert.deepEqual([rs[0].service_id, rs[0].requested_version, rs[0].status, rs[0].idempotency_key], [PLATFORM_API, RUN, "approved", identityRedeployKey("deploy-platform-api.yml", RUN, 2, HASH, 1)]);
  assert.deepEqual([rs[0].details.executor, rs[0].details.redeploy, rs[0].details.identity_revision, rs[0].details.commit_sha], ["native:deploy", "identity_vars", 2, RUN]);
  const queued = events(w.db, "deployment.native_deploy_queued");
  assert.deepEqual([queued[0].payload.redeploy, queued[0].payload.identity_revision, queued[0].payload.identity_vars_changed], ["identity_vars", 2, { [PLATFORM_API]: ["OPERATOR_IDENTITIES"] }]);

  // The executor: the same code (the running commit's module), the new list written and verified before traffic.
  assert.deepEqual(await execute(w), { executed: 1, succeeded: 1 });
  rs = requests(w.db);
  assert.equal(rs[0].status, "succeeded", JSON.stringify(rs[0].details.outcome));
  const steps: string[] = rs[0].details.outcome.steps;
  const i = (x: string) => steps.indexOf(`${PLATFORM_API}:${x}`);
  assert.ok(i("vars_from_identity_table") >= 0 && i("vars_from_identity_table") < i("vars_changed:OPERATOR_IDENTITIES") && i("vars_changed:OPERATOR_IDENTITIES") < i("uploaded"), steps.join(" "));
  assert.ok(i("uploaded") < i("vars_verified") && i("vars_verified") < i("deployed"), "verified on the new version before traffic");
  assert.ok(i("smoke_passed") > i("deployed"), "the smoke tests through Access ran");
  assert.deepEqual(rs[0].details.outcome.deploy_vars_changed, { [PLATFORM_API]: ["OPERATOR_IDENTITIES"] });
  assert.equal(w.cloud.liveText(PLATFORM_API, "OPERATOR_IDENTITIES"), `${CLIENT},${NEW_EMAILS.join(",")}`);
  assert.equal(w.cloud.liveText(PLATFORM_API, "ACCESS_AUD"), AUD, "every other value kept");
  assert.equal(w.cloud.live(PLATFORM_API).tag, RUN_TAG);
  assert.equal(w.cloud.uploads.length, 1);
  assert.equal(w.cloud.uploads[0].module, moduleText(PLATFORM_API), "no new code: the running commit's module");
  assert.equal((w.db.raw.prepare("SELECT desired_version FROM service_registry WHERE service_id = ?").get(PLATFORM_API) as any).desired_version, RUN_TAG);
  const written = events(w.db, "deployment.identity_vars_written");
  assert.deepEqual(written.map((e) => [e.subject, e.payload.names, e.payload.identity_revision]), [[PLATFORM_API, ["OPERATOR_IDENTITIES"], 2]]);
  const done = events(w.db, "deployment.native_deploy_succeeded");
  assert.deepEqual([done[0].subject, done[0].payload.redeploy, done[0].payload.identity_revision, done[0].payload.commit_sha], [PLATFORM_API, "identity_vars", 2, RUN]);
  assert.ok(!JSON.stringify([...queued, ...written, ...done]).includes("new.operator@"), "no email in the audit chain");
  assert.equal(w.reports.length, 0);

  // The next cycle takes the Forge; then nothing is left.
  await cycle(w);
  ps = deployProposals(w.db);
  assert.deepEqual(ps.map((p) => [p.target, p.params.identity_revision, p.status]), [[PLATFORM_API, 2, "executed"], [FORGE, 2, "executed"]]);
  assert.deepEqual(await execute(w), { executed: 1, succeeded: 1 });
  assert.equal(w.cloud.liveText(FORGE, "APPROVER_IDENTITIES"), NEW_EMAILS.join(","));
  assert.equal(w.cloud.liveText(FORGE, "OPERATOR_IDENTITIES"), `${CLIENT},${NEW_EMAILS.join(",")}`);
  await cycle(w);
  assert.equal(deployProposals(w.db).length, 2, "every Worker carries the saved list: nothing more");
  const d = await identityDrift(w.orch as never, w.cloud.fetcher);
  assert.deepEqual(d.ok && d.units, []);
  assert.equal((await verifyAuditChain(w.db)).valid, true);
});

// ================================================================= 4. nothing to do
test("IR-4. no redeploy when the vars already match: nothing is proposed, and a forced proposal is refused before anything is queued", async () => {
  const w = await world({ current: DEPLOY_UNITS.map((u) => u.unit) });
  await ownerSaves(w.db, NEW_EMAILS);
  const d = await identityDrift(w.orch as never, w.cloud.fetcher);
  assert.deepEqual(d.ok && d.units, []);
  await cycle(w);
  await cycle(w);
  assert.equal(deployProposals(w.db).length, 0);
  const { proposal, decision } = passedProposal(w.db, FORGE, identityParams("forge", 2));
  await assert.rejects(orchestrate(w, () => deployForConsensus(w.orch as never, proposal, decision, FORGE, identityParams("forge", 2))), /identity_vars_match/);
  assert.equal(requests(w.db).length, 0);
  assert.deepEqual(events(w.db, "deployment.identity_redeploy_refused").map((e) => [e.subject, e.payload.reason, e.payload.identity_revision]), [[FORGE, "identity_vars_match", 2]]);
});

// ================================================================= 5. an invalid row
test("IR-5. no redeploy while the row is invalid: not detected, not proposed, refused when queued and again by the executor", async () => {
  const w = await world();
  await ownerSaves(w.db, NEW_EMAILS);
  // Queue a valid redeploy first, then break the row by hand (not the form the Registry writes).
  const { proposal, decision } = passedProposal(w.db, FORGE, identityParams("forge", 2));
  assert.equal((await orchestrate(w, () => deployForConsensus(w.orch as never, proposal, decision, FORGE, identityParams("forge", 2)))).dispatched, true);
  w.db.raw.prepare("UPDATE platform_identities SET approver_emails = 'Not An Email' WHERE id = 'access'").run();
  const d = await identityDrift(w.orch as never, w.cloud.fetcher);
  assert.deepEqual(d, { ok: true, source: "invalid", revision: null, client: HASH, units: [], skipped: [], reason: "identity_source_invalid: identity_approver_emails_malformed" });
  // The executor refuses the queued request: nothing is uploaded or deployed.
  assert.deepEqual(await execute(w), { executed: 0, succeeded: 0 });
  const [r] = requests(w.db);
  assert.deepEqual([r.status, r.details.outcome.reason], ["failed", "refused: identity_source_invalid"]);
  assert.equal(w.cloud.uploads.length, 0);
  assert.ok(!w.cloud.calls.some((c) => c.startsWith("POST")));
  // The Supervisor proposes nothing and says why; a proposal is refused by the Orchestrator.
  const before = deployProposals(w.db).length;
  const c = await cycle(w);
  assert.equal(deployProposals(w.db).length, before, "the Supervisor proposes nothing");
  assert.ok(identityFindings(c).some((f) => /the identity list is invalid \(identity_source_invalid: identity_approver_emails_malformed\): nothing is redeployed from it/.test(String(f.why))));
  const again = passedProposal(w.db, PLATFORM_API, identityParams("platform-api", 2));
  await assert.rejects(orchestrate(w, () => deployForConsensus(w.orch as never, again.proposal, again.decision, PLATFORM_API, identityParams("platform-api", 2))), /identity_source_invalid/);
  assert.equal(w.cloud.liveText(FORGE, "APPROVER_IDENTITIES"), OLD_EMAILS.join(","), "the invalid row never reached a Worker");
});

// ================================================================= 6. one per revision
test("IR-6. one redeploy per unit and revision, not a loop: a dashboard edit after it is not redeployed again; a new revision is", async () => {
  const w = await world({ current: ["deployment-orchestrator", "control-plane", "forge"] });
  await ownerSaves(w.db, NEW_EMAILS);
  await cycle(w);
  assert.deepEqual(await execute(w), { executed: 1, succeeded: 1 });
  assert.equal(w.cloud.liveText(PLATFORM_API, "OPERATOR_IDENTITIES"), `${CLIENT},${NEW_EMAILS.join(",")}`);
  // Someone edits the value on the dashboard: drift again, but revision 2 was redeployed already.
  w.cloud.dashboardEdit(PLATFORM_API, OLD_EMAILS);
  anHourLater(w.db);
  const d = await identityDrift(w.orch as never, w.cloud.fetcher);
  assert.deepEqual(d.ok && d.units.map((u) => u.unit), ["platform-api"]);
  await cycle(w);
  await cycle(w);
  assert.equal(deployProposals(w.db).length, 1, "revision 2 is not redeployed twice");
  // The Orchestrator's own guard: after a succeeded attempt the same unit, commit, revision and token is never queued again.
  const p = passedProposal(w.db, PLATFORM_API, identityParams("platform-api", 2));
  await assert.rejects(orchestrate(w, () => deployForConsensus(w.orch as never, p.proposal, p.decision, PLATFORM_API, identityParams("platform-api", 2))), /identity_redeploy_done/);
  w.db.raw.prepare("DELETE FROM consensus_proposals WHERE proposal_id = ?").run(p.proposal);
  // The owner saves again: revision 3 differs on every unit, so each is redeployed once, one per cycle, in deploy order.
  const r3 = await ownerSaves(w.db, [...NEW_EMAILS, "third@cryptophys.work"]);
  assert.equal(r3, 3);
  let last = await cycle(w);
  for (let k = 0; k < 4; k++) last = await cycle(w);
  // The Supervisor's consensus.propose window (4 an hour) holds the fourth unit of the hour.
  assert.ok(last.findings.some((f) => f.kind === "rate_window"));
  assert.equal(deployProposals(w.db).length, 4);
  w.db.raw.prepare("UPDATE agent_syscall_consumptions SET consumed_at = ?").run(new Date(Date.now() - 61 * 60_000).toISOString());
  await cycle(w);
  await cycle(w);
  const ps = deployProposals(w.db);
  assert.deepEqual(ps.map((x) => [x.target, x.params.identity_revision]), [
    [PLATFORM_API, 2], ["cryptophys-deployment-orchestrator", 3], ["cryptophys-policy-engine", 3], [PLATFORM_API, 3], [FORGE, 3],
  ]);
  assert.ok(ps.every((x) => x.params.commit_sha === RUN && x.status === "executed"));
  // In shadow mode the record stands in for the run: also once per revision.
  const s = await world({ mode: "shadow", current: ["deployment-orchestrator", "control-plane", "forge"] });
  await ownerSaves(s.db, NEW_EMAILS);
  await cycle(s);
  await cycle(s);
  assert.deepEqual(deployProposals(s.db).map((x) => [x.target, x.status]), [[PLATFORM_API, "shadow_passed"]]);
  assert.equal(requests(s.db).length, 0, "shadow mode executes nothing");
  // A policy veto (shadow_blocked) is proposed again after an hour, as for every deploy.
  s.db.raw.prepare("UPDATE consensus_proposals SET status = 'shadow_blocked', created_at = ?, decided_at = ?").run(new Date(Date.now() - 61 * 60_000).toISOString(), new Date(Date.now() - 61 * 60_000).toISOString());
  await cycle(s);
  assert.equal(deployProposals(s.db).length, 2);
});

// ================================================================= 7. the brake and the limits
test("IR-7. the brake, one deploy per target an hour, the daily limit, main's pending deploy and the propose window are respected", async () => {
  const w = await world({ current: ["deployment-orchestrator", "control-plane"] });
  await ownerSaves(w.db, NEW_EMAILS);
  // The brake: an open critical report. Nothing is proposed (every voter would reject), and the cycle says why.
  const at = new Date(Date.now() - 60_000).toISOString();
  w.db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at) VALUES ('rpt_ir7', 'deployment-orchestrator', 'platform_digest', 'critical', 'Deploy failed', '{}', 'not_used', NULL, ?)").run(at);
  const braked = await cycle(w);
  assert.equal(deployProposals(w.db).length, 0);
  assert.ok(identityFindings(braked).some((f) => /not checked while a critical report is open/.test(String(f.why))));
  // A proposal the council rejected only because the brake held is proposed again once it is off.
  const rejected = passedProposal(w.db, PLATFORM_API, identityParams("platform-api", 2));
  w.db.raw.prepare("UPDATE consensus_proposals SET status = 'rejected', passed = 0, evidence_json = '{\"critical_reports_24h\":1}', created_at = ?, decided_at = ? WHERE proposal_id = ?")
    .run(new Date(Date.now() - 61 * 60_000).toISOString(), new Date(Date.now() - 61 * 60_000).toISOString(), rejected.proposal);
  w.db.raw.prepare("INSERT INTO agent_report_acknowledgements (report_id, acknowledged_by, reason, acknowledged_at) VALUES ('rpt_ir7', ?, 'root cause fixed', ?)").run(APPROVER_EMAIL, new Date().toISOString());
  await cycle(w);
  let ps = deployProposals(w.db);
  assert.deepEqual(ps.map((p) => [p.target, p.status]), [[PLATFORM_API, "rejected"], [PLATFORM_API, "executed"]]);

  // One executed deploy_commit per target an hour: the Forge waits while its last deploy is recent.
  const recent = passedProposal(w.db, FORGE, { commit_sha: RUN });
  w.db.raw.prepare("UPDATE consensus_proposals SET status = 'executed' WHERE proposal_id = ?").run(recent.proposal);
  w.db.raw.prepare("UPDATE consensus_proposals SET decided_at = ? WHERE target = ?").run(new Date(Date.now() - 61 * 60_000).toISOString(), PLATFORM_API);
  const waited = await cycle(w);
  assert.ok(identityFindings(waited).some((f) => f.service_id === FORGE && /deployed in the last hour/.test(String(f.why))));
  assert.equal(deployProposals(w.db).filter((p) => p.target === FORGE && p.params.redeploy).length, 0);

  // The daily deploy limit: full, nothing is checked or proposed.
  w.db.raw.prepare("UPDATE consensus_proposals SET decided_at = ? WHERE proposal_id = ?").run(new Date(Date.now() - 61 * 60_000).toISOString(), recent.proposal);
  w.db.raw.prepare("UPDATE policy_parameters SET value = 2 WHERE name = 'daily-deploy-limit'").run();
  const calls = w.cloud.calls.length;
  await cycle(w);
  assert.equal(deployProposals(w.db).filter((p) => p.target === FORGE && p.params.redeploy).length, 0);
  assert.equal(w.cloud.calls.length, calls, "no Cloudflare read while the daily limit is reached");
  w.db.raw.prepare("UPDATE policy_parameters SET value = 10 WHERE name = 'daily-deploy-limit'").run();

  // A unit main is about to deploy is left to that deploy (it writes the same lists): main's deploy is proposed (here
  // it cannot run: no bundle for main), and while it stays pending the identity redeploy of that unit waits for it.
  await forgeSees(w.db, { main: MAIN, files: ["workers/forge/src/index.ts"], ready: true });
  await cycle(w);
  const pendingCycle = await cycle(w);
  const forgeDeploys = deployProposals(w.db).filter((p) => p.target === FORGE && p.proposal_id !== recent.proposal);
  assert.deepEqual(forgeDeploys.map((p) => [p.params.commit_sha, p.params.redeploy ?? null]), [[MAIN, null]], "main's deploy of the Forge, not an identity redeploy");
  assert.ok(identityFindings(pendingCycle).some((f) => f.service_id === FORGE && /main's pending deploy of forge writes identity revision 2/.test(String(f.why))), JSON.stringify(identityFindings(pendingCycle)));

  // The consensus.propose window (4 an hour): full, nothing is proposed.
  const v = await world({ current: ["deployment-orchestrator", "control-plane"] });
  await ownerSaves(v.db, NEW_EMAILS);
  for (let k = 0; k < 4; k++) {
    v.db.raw.prepare("INSERT INTO agent_syscall_consumptions (decision_id, agent_id, capability, consumed_at) VALUES (?, 'supervisor', 'consensus.propose', ?)").run(`dec_ir7_${k}`, new Date(Date.now() - 60_000).toISOString());
  }
  const full = await cycle(v);
  assert.equal(deployProposals(v.db).length, 0);
  assert.ok(full.findings.some((f) => f.kind === "rate_window"));
});

// ================================================================= 8. the executor checks again
test("IR-8. the executor checks again: a newer revision or another running commit refuses the request; a forged key is refused", async () => {
  const w = await world({ current: ["deployment-orchestrator", "control-plane", "forge"] });
  await ownerSaves(w.db, NEW_EMAILS);
  const a = passedProposal(w.db, PLATFORM_API, identityParams("platform-api", 2));
  assert.equal((await orchestrate(w, () => deployForConsensus(w.orch as never, a.proposal, a.decision, PLATFORM_API, identityParams("platform-api", 2)))).dispatched, true);
  await ownerSaves(w.db, [...NEW_EMAILS, "third@cryptophys.work"]);
  assert.deepEqual(await execute(w), { executed: 0, succeeded: 0 });
  assert.deepEqual(requests(w.db).map((r) => [r.status, r.details.outcome.reason]), [["failed", "refused: identity_revision_moved"]]);

  // Another running commit (a deploy of main ran meanwhile): refused; the lists come with that deploy.
  const b = passedProposal(w.db, PLATFORM_API, identityParams("platform-api", 3));
  assert.equal((await orchestrate(w, () => deployForConsensus(w.orch as never, b.proposal, b.decision, PLATFORM_API, identityParams("platform-api", 3)))).dispatched, true);
  w.db.raw.prepare("UPDATE service_registry SET desired_version = ? WHERE service_id = ?").run(MAIN.slice(0, 12), PLATFORM_API);
  assert.deepEqual(await execute(w), { executed: 0, succeeded: 0 });
  assert.equal(requests(w.db)[1].details.outcome.reason, "refused: running_bundle_missing");
  assert.equal(w.cloud.uploads.length, 0);
  w.db.raw.prepare("UPDATE service_registry SET desired_version = ? WHERE service_id = ?").run(RUN_TAG, PLATFORM_API);

  // Queued at an older commit than the unit runs: refused when queued.
  const c = passedProposal(w.db, PLATFORM_API, identityParams("platform-api", 3, MAIN));
  await assert.rejects(orchestrate(w, () => deployForConsensus(w.orch as never, c.proposal, c.decision, PLATFORM_API, identityParams("platform-api", 3, MAIN))), /identity_redeploy_not_running_commit/);
  // A proposal for another unit than its target, or malformed params, is refused.
  const d = passedProposal(w.db, PLATFORM_API, identityParams("forge", 3));
  await assert.rejects(orchestrate(w, () => deployForConsensus(w.orch as never, d.proposal, d.decision, PLATFORM_API, identityParams("forge", 3))), /identity_redeploy_unit_mismatch/);
  const e = passedProposal(w.db, PLATFORM_API, { ...identityParams("platform-api", 3), identity_revision: "3" });
  await assert.rejects(orchestrate(w, () => deployForConsensus(w.orch as never, e.proposal, e.decision, PLATFORM_API, { ...identityParams("platform-api", 3), identity_revision: "3" })), /identity_revision_invalid/);

  // Revision 3 was queued once and refused by the executor (nothing restored, nothing changed): never retried.
  const again = passedProposal(w.db, PLATFORM_API, identityParams("platform-api", 3));
  await assert.rejects(orchestrate(w, () => deployForConsensus(w.orch as never, again.proposal, again.decision, PLATFORM_API, identityParams("platform-api", 3))), /identity_redeploy_not_restored/);
  // A proposal naming another CI token than the Orchestrator holds is refused.
  const other = passedProposal(w.db, PLATFORM_API, identityParams("platform-api", 3, RUN, "0badc0de"));
  await assert.rejects(orchestrate(w, () => deployForConsensus(w.orch as never, other.proposal, other.decision, PLATFORM_API, identityParams("platform-api", 3, RUN, "0badc0de"))), /identity_ci_token_moved/);

  // A queued identity request whose key is not the revision's (or a deploy of main's key with redeploy details) is invalid.
  assert.equal(await ownerSaves(w.db, [...NEW_EMAILS, "fourth@cryptophys.work"]), 4);
  const f = passedProposal(w.db, PLATFORM_API, identityParams("platform-api", 4));
  assert.equal((await orchestrate(w, () => deployForConsensus(w.orch as never, f.proposal, f.decision, PLATFORM_API, identityParams("platform-api", 4)))).dispatched, true);
  w.db.raw.prepare("UPDATE deployment_requests SET idempotency_key = ? WHERE status = 'approved'").run(`consensus:deploy-platform-api.yml:${RUN}`);
  assert.deepEqual(await execute(w), { executed: 0, succeeded: 0 });
  assert.equal(requests(w.db).at(-1)!.details.outcome.reason, "invalid_native_deploy_request");
  assert.equal(w.cloud.uploads.length, 0);
});

// ================================================================= 9. what stays as it was, and the docs
test("IR-9. break-glass and rescue are unchanged; the docs say how an identity change reaches every Worker", () => {
  for (const f of ["workers/deployment-orchestrator/src/recovery-deploy.ts", "workers/control-plane-shared/src/executor-rescue.ts", "workers/control-plane-shared/src/break-glass.ts"]) {
    assert.doesNotMatch(read(f), /identity[-_]redeploy|IDENTITY_REDEPLOY/, f);
  }
  const ops = read("docs/OPERATIONS.md");
  const section = ops.slice(ops.indexOf("Changing an operator or approver email"));
  assert.match(section.slice(0, 4000), /redeploy/i);
  assert.match(section.slice(0, 4000), /identity_vars/);
  assert.match(read("docs/SSOT.md"), /Last reviewed: 2026-11-16 \([^)]*redeploy for identities/);
});

// ================================================================= 10-14. owner 2026-11-16 ("sesuai rekomendasimu"): retries, the CI token, the label
const HEALTHY = { probeService: async () => ({ reachable: true, healthy: true, version_tag: RUN_TAG, error: null }) };
/** The live check fails after the upload: the executor restores every changed Worker (`restored: true`). */
const UNHEALTHY = { probeService: async () => ({ reachable: true, healthy: false, version_tag: RUN_TAG, error: "unhealthy" }) };
/** An hour and a minute later: the last attempt, the hourly limits and the propose window are behind us. */
function later(db: Db) {
  const t = new Date(Date.now() - 61 * 60_000).toISOString();
  db.raw.prepare("UPDATE consensus_proposals SET created_at = ?, decided_at = ?").run(t, t);
  db.raw.prepare("UPDATE agent_syscall_consumptions SET consumed_at = ?").run(t);
}
const identityDeploys = (db: Db, target = PLATFORM_API) => deployProposals(db).filter((p) => p.target === target && p.params.redeploy === IDENTITY_REDEPLOY);

test("IR-10. a failed identity redeploy that restored production is retried an hour later with its own key, at most twice", async () => {
  const w = await world({ current: ["deployment-orchestrator", "control-plane", "forge"] });
  await ownerSaves(w.db, NEW_EMAILS);
  w.orch.DRIFT = UNHEALTHY;
  await cycle(w);
  assert.deepEqual(await execute(w), { executed: 1, succeeded: 0 });
  let rs = requests(w.db);
  assert.deepEqual([rs[0].status, rs[0].details.outcome.restored, rs[0].details.identity_attempt], ["failed", true, 1]);
  assert.equal(w.cloud.liveText(PLATFORM_API, "OPERATOR_IDENTITIES"), `${CLIENT},${OLD_EMAILS.join(",")}`, "restored");
  // Not within the hour.
  await cycle(w);
  assert.equal(identityDeploys(w.db).length, 1);
  later(w.db);
  const retry = await cycle(w);
  assert.equal(identityDeploys(w.db).length, 2);
  assert.ok(identityFindings(retry).some((f) => /^retry 1 of 2: the identity redeploy failed and production was restored/.test(String(f.why))), JSON.stringify(identityFindings(retry)));
  rs = requests(w.db);
  assert.deepEqual([rs[1].idempotency_key, rs[1].details.identity_attempt, rs[1].details.identity_client], [identityRedeployKey("deploy-platform-api.yml", RUN, 2, HASH, 2), 2, HASH]);
  w.orch.DRIFT = HEALTHY;
  assert.deepEqual(await execute(w), { executed: 1, succeeded: 1 });
  assert.equal(w.cloud.liveText(PLATFORM_API, "OPERATOR_IDENTITIES"), `${CLIENT},${NEW_EMAILS.join(",")}`);
  assert.deepEqual(events(w.db, "deployment.native_deploy_succeeded").map((e) => [e.payload.identity_revision, e.payload.identity_attempt]), [[2, 2]]);
  later(w.db);
  await cycle(w);
  assert.equal(identityDeploys(w.db).length, 2, "done: nothing more");

  // Three failed and restored attempts: the first and two retries, then no more (the Supervisor and the Orchestrator).
  const x = await world({ current: ["deployment-orchestrator", "control-plane", "forge"] });
  await ownerSaves(x.db, NEW_EMAILS);
  x.orch.DRIFT = UNHEALTHY;
  for (let k = 0; k < 3; k++) {
    await cycle(x);
    assert.deepEqual(await execute(x), { executed: 1, succeeded: 0 });
    later(x.db);
  }
  assert.deepEqual(requests(x.db).map((r) => r.details.identity_attempt), [1, 2, 3]);
  await cycle(x);
  assert.equal(identityDeploys(x.db).length, 1 + IDENTITY_REDEPLOY_RETRIES, "no fourth attempt");
  const forced = passedProposal(x.db, PLATFORM_API, identityParams("platform-api", 2));
  await assert.rejects(orchestrate(x, () => deployForConsensus(x.orch as never, forced.proposal, forced.decision, PLATFORM_API, identityParams("platform-api", 2))), /identity_redeploy_retries_exhausted/);
});

test("IR-11. a failure that did not restore production is never retried automatically", async () => {
  const w = await world({ current: ["deployment-orchestrator", "control-plane", "forge"] });
  await ownerSaves(w.db, NEW_EMAILS);
  w.orch.DRIFT = UNHEALTHY;
  await cycle(w);
  assert.deepEqual(await execute(w), { executed: 1, succeeded: 0 });
  // As when a restore fails (the Worker stays on the new version): the outcome says restored false.
  w.db.raw.prepare("UPDATE deployment_requests SET details_json = json_set(details_json, '$.outcome.restored', json('false'))").run();
  later(w.db);
  await cycle(w);
  await cycle(w);
  assert.equal(identityDeploys(w.db).length, 1, "the owner decides");
  const forced = passedProposal(w.db, PLATFORM_API, identityParams("platform-api", 2));
  await assert.rejects(orchestrate(w, () => deployForConsensus(w.orch as never, forced.proposal, forced.decision, PLATFORM_API, identityParams("platform-api", 2))), /identity_redeploy_not_restored/);
  assert.deepEqual(events(w.db, "deployment.identity_redeploy_refused").map((e) => e.payload.reason), ["identity_redeploy_not_restored"]);
});

test("IR-12. no retry under the brake: the restored failure waits for the critical report's acknowledgement", async () => {
  const w = await world({ current: ["deployment-orchestrator", "control-plane", "forge"] });
  await ownerSaves(w.db, NEW_EMAILS);
  w.orch.DRIFT = UNHEALTHY;
  await cycle(w);
  assert.deepEqual(await execute(w), { executed: 1, succeeded: 0 });
  later(w.db);
  // The failed deploy's critical report holds the brake (the fake report channel does not write it; it is added here).
  w.db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at) VALUES ('rpt_ir12', 'deployment-orchestrator', 'platform_digest', 'critical', 'Identity redeploy of platform-api failed', '{}', 'not_used', NULL, ?)").run(new Date(Date.now() - 60_000).toISOString());
  const braked = await cycle(w);
  assert.equal(identityDeploys(w.db).length, 1);
  assert.ok(identityFindings(braked).some((f) => /not checked while a critical report is open/.test(String(f.why))));
  w.db.raw.prepare("INSERT INTO agent_report_acknowledgements (report_id, acknowledged_by, reason, acknowledged_at) VALUES ('rpt_ir12', ?, 'live check fixed', ?)").run(APPROVER_EMAIL, new Date().toISOString());
  await cycle(w);
  assert.equal(identityDeploys(w.db).length, 2, "retried once the brake is off");
});

test("IR-13. a rotated CI service token redeploys each unit once for the same revision; only a hash of the Client ID is stored", async () => {
  const w = await world({ current: ["deployment-orchestrator", "control-plane", "forge"] });
  await ownerSaves(w.db, NEW_EMAILS);
  await cycle(w);
  assert.deepEqual(await execute(w), { executed: 1, succeeded: 1 });
  later(w.db);
  await cycle(w);
  assert.equal(deployProposals(w.db).length, 1);
  // The owner rotates the token on the Orchestrator (and Access accepts the new one).
  w.orch.CF_ACCESS_CLIENT_ID = ROTATED;
  w.cloud.client = ROTATED;
  const rotated = await identityClientHash(ROTATED);
  assert.notEqual(rotated, HASH);
  const d = await identityDrift(w.orch as never, w.cloud.fetcher);
  assert.deepEqual(d.ok && [d.revision, d.client, d.units.map((u) => u.unit)], [2, rotated, ["deployment-orchestrator", "control-plane", "platform-api", "forge"]]);
  for (let k = 0; k < 6; k++) { later(w.db); await cycle(w); }
  const ps = deployProposals(w.db);
  assert.deepEqual(ps.map((p) => [p.target, p.params.identity_revision, p.params.identity_client]), [
    [PLATFORM_API, 2, HASH],
    ["cryptophys-deployment-orchestrator", 2, rotated], ["cryptophys-policy-engine", 2, rotated], [PLATFORM_API, 2, rotated], [FORGE, 2, rotated],
  ], "one new redeploy per unit, then nothing");
  // The Orchestrator's deploy (the oldest queued) writes the new Client ID first and verifies it.
  assert.deepEqual(await execute(w), { executed: 1, succeeded: 1 });
  assert.equal(w.cloud.liveText("cryptophys-deployment-orchestrator", "OPERATOR_IDENTITIES"), `${ROTATED},${NEW_EMAILS.join(",")}`);
  assert.equal(w.cloud.liveText("cryptophys-deployment-orchestrator", "DEPLOY_ALLOWED_IDENTITIES"), `${ROTATED},${NEW_EMAILS.join(",")}`);
  const stored = JSON.stringify([deployProposals(w.db), requests(w.db), w.db.raw.prepare("SELECT payload_json FROM audit_events").all()]);
  assert.ok(!stored.includes(ROTATED) && !stored.includes(CLIENT), "the Client ID is never stored in clear");
});

test("IR-14. the Console describes an identity redeploy as what it is, not as a deploy of the latest code", () => {
  assert.equal(describeProposal("deploy_commit", PLATFORM_API, identityParams("platform-api", 2)), "Redeploy platform-api at its running commit to apply the identity lists (revision 2)");
  assert.equal(describeProposal("deploy_commit", PLATFORM_API, { commit_sha: MAIN }), describeAction("deploy_commit", PLATFORM_API));
  assert.equal(describeProposal("rollback_worker_version", PLATFORM_API, null), describeAction("rollback_worker_version", PLATFORM_API));
  const page = read("workers/console/ui/src/pages/Consensus.tsx");
  assert.match(page, /describeProposal\(p\.action, p\.target, p\.params\)/);
  assert.match(read("workers/console/ui/src/lib/plain.ts"), /describeProposal/);
});
