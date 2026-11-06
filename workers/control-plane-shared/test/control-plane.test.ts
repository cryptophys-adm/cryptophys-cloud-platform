import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, CI_JWT, OPERATOR_EMAIL, OPERATOR_JWT, OUTSIDER_JWT, baseEnv, call, fakeAi, fakeWorkflow, migratedDb, req } from "./harness.ts";
import { AiEngine, extractJsonObject, type AiTask } from "../src/ai-engine.ts";
import { appendAuditEvent, verifyAuditChain, GENESIS_HASH } from "../src/audit.ts";
import { redact } from "../src/http.ts";
import audit from "../../audit-ledger/src/index.ts";
import registry from "../../platform-registry/src/index.ts";
import policy, { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import recovery from "../../recovery-manager/src/index.ts";
import drift from "../../drift-detector/src/index.ts";

const SHA = "0123456789abcdef0123456789abcdef01234567";

// ---------------------------------------------------------------- shared library

test("redaction removes secret-shaped keys and token values", () => {
  const out = redact({ api_token: "x", nested: { Authorization: "Bearer abcdefghijkl" }, note: "use Bearer abcdefghijklmnop now", ok: 1 }) as any;
  assert.equal(out.api_token, "[redacted]");
  assert.equal(out.nested.Authorization, "[redacted]");
  assert.equal(out.note, "use [redacted] now");
  assert.equal(out.ok, 1);
});

test("audit chain stays linear under concurrent appends and detects tampering", async () => {
  const db = migratedDb();
  await Promise.all(Array.from({ length: 12 }, (_, i) =>
    appendAuditEvent(db, { event_type: "test.event", actor: "tester", subject: `s${i}`, outcome: "ok", payload: { i } })));
  const v = await verifyAuditChain(db);
  assert.equal(v.valid, true);
  assert.equal(v.events_checked, 12);
  const first = db.raw.prepare("SELECT previous_hash FROM audit_events ORDER BY rowid LIMIT 1").get() as any;
  assert.equal(first.previous_hash, GENESIS_HASH);

  assert.throws(() => db.raw.exec("UPDATE audit_events SET outcome = 'forged'"), /append-only/);
  assert.throws(() => db.raw.exec("DELETE FROM audit_events"), /append-only/);

  db.raw.exec("DROP TRIGGER audit_events_no_update");
  db.raw.exec("UPDATE audit_events SET outcome = 'forged' WHERE rowid = 3");
  const tampered = await verifyAuditChain(db);
  assert.equal(tampered.valid, false);
  assert.equal(tampered.events_checked, 2);
  assert.match(tampered.reason!, /event_hash/);
});

const echoTask: AiTask<{ label: string }> = {
  name: "echo",
  instructions: "label",
  maxInputChars: 200,
  maxOutputTokens: 20,
  validate: (o) => (typeof (o as any)?.label === "string" ? { label: (o as any).label } : null),
};

test("AI engine enforces allow-lists, budgets, schemas, timeouts and redaction", async () => {
  const db = migratedDb();
  const ai = fakeAi({ response: 'Sure! ```json\n{"label":"deployment"}\n```' });
  const engine = new AiEngine({ service: "cryptophys-audit-ledger", ai, db, allowedModels: ["m1"], allowedTasks: ["echo"], model: "m1", dailyLimit: 2, timeoutMs: 50 });

  const ok = await engine.run(echoTask, { note: "Bearer secretsecretsecret", password: "p" }, "c1");
  assert.deepEqual(ok.status === "ok" && ok.data, { label: "deployment" });
  const sent = String((ai.calls[0].input.messages as any[])[1].content);
  assert.doesNotMatch(sent, /secretsecret|"p"/);

  ai.reply = { response: "not json" };
  assert.equal((await engine.run(echoTask, {}, "c2")).status, "invalid_output");
  const exhausted = await engine.run(echoTask, {}, "c3");
  assert.deepEqual([exhausted.status, (exhausted as any).reason], ["unavailable", "daily_budget_exhausted"]);
  const usage = db.raw.prepare("SELECT requests, failures FROM ai_usage WHERE service_id = 'cryptophys-audit-ledger'").get() as any;
  assert.deepEqual([usage.requests, usage.failures], [2, 1]);

  const other = new AiEngine({ service: "cryptophys-policy-engine", ai, db, allowedModels: ["m1"], allowedTasks: ["echo"], model: "m1", timeoutMs: 20 });
  assert.equal((await other.run({ ...echoTask, name: "nope" }, {}, "c4") as any).reason, "task_not_allowed");
  assert.equal((await other.run(echoTask, "x".repeat(500), "c5") as any).reason, "input_too_large");
  ai.delayMs = 100;
  assert.equal((await other.run(echoTask, {}, "c6") as any).reason, "timeout");
  ai.delayMs = 0;
  const wrongModel = new AiEngine({ service: "cryptophys-policy-engine", ai, db, allowedModels: ["m1"], allowedTasks: ["echo"], model: "paid-model" });
  assert.equal((await wrongModel.run(echoTask, {}, "c7") as any).reason, "model_not_allowed");
  const noBinding = new AiEngine({ service: "cryptophys-policy-engine", ai: undefined, db, allowedModels: ["m1"], allowedTasks: ["echo"], model: "m1" });
  assert.equal((await noBinding.run(echoTask, {}, "c8") as any).reason, "ai_binding_missing");

  const capped = new AiEngine({ service: "cryptophys-drift-detector", ai, db, allowedModels: ["m1"], allowedTasks: ["echo"], model: "m1", accountDailyLimit: 3 });
  assert.equal((await capped.run(echoTask, {}, "c9") as any).reason, "daily_budget_exhausted");
  assert.equal(extractJsonObject("no braces"), null);
});

// ---------------------------------------------------------------- readiness / auth (all services)

const services = [
  ["cryptophys-audit-ledger", audit],
  ["cryptophys-platform-registry", registry],
  ["cryptophys-policy-engine", policy],
] as const;

test("readiness requires schema, operator identities and AI binding", async () => {
  for (const [name, worker] of services) {
    const db = migratedDb();
    const env = baseEnv(name, db);
    const health = await call(worker, env, req("GET", "/health"));
    assert.equal(health.status, 200);
    assert.deepEqual(health.body.version, { id: "ver-self", tag: "abc1234def56" });
    assert.equal((await call(worker, env, req("GET", "/ready"))).body.status, "ready");
    assert.equal((await call(worker, baseEnv(name, migratedDb({ recordLedger: false })), req("GET", "/ready"))).status, 503);
    const noOperators = await call(worker, { ...env, OPERATOR_IDENTITIES: " , " }, req("GET", "/ready"));
    assert.equal(noOperators.status, 503);
    assert.equal(noOperators.body.checks.operator_identities_configured, false);
    assert.equal((await call(worker, { ...env, AI: undefined }, req("GET", "/ready"))).status, 503);
    assert.equal((await call(worker, { ...env, SERVICE_ENVIRONMENT: "development" }, req("GET", "/ready"))).status, 503);
  }
});

test("every /v1 endpoint requires an Access identity in OPERATOR_IDENTITIES; bearer tokens confer nothing", async () => {
  const paths: [unknown, string, string][] = [
    [audit, "GET", "/v1/events"], [audit, "GET", "/v1/verify"], [registry, "GET", "/v1/services"],
    [policy, "POST", "/v1/evaluate"], [recovery, "GET", "/v1/plans"], [drift, "GET", "/v1/drift"],
  ];
  for (const [worker, method, path] of paths) {
    const env = baseEnv("svc", migratedDb());
    const body = method === "POST" ? { subject: "x", action: "deploy", resource: "r" } : undefined;
    assert.equal((await call(worker as never, env, req(method, path, body, null, { authorization: "Bearer anything" }))).status, 403, `${path}: no Access JWT`);
    const outsider = await call(worker as never, env, req(method, path, body, OUTSIDER_JWT));
    assert.deepEqual([outsider.status, outsider.body.error], [403, "forbidden"], `${path}: authenticated but not an operator`);
    assert.equal((await call(worker as never, env, req(method, path, body, APPROVER_JWT))).status, 403, `${path}: approvers are not operators`);
    const unset = await call(worker as never, { ...env, OPERATOR_IDENTITIES: undefined }, req(method, path, body));
    assert.deepEqual([unset.status, unset.body.error], [503, "operator_identities_not_configured"], path);
    assert.ok((await call(worker as never, env, req(method, path, body, OPERATOR_JWT))).status < 400, `${path}: operator email (any case) is allowed`);
    assert.ok((await call(worker as never, env, req(method, path, body))).status < 400, `${path}: CI service token is allowed`);
  }
});

// ---------------------------------------------------------------- audit ledger

test("audit ledger appends, redacts, lists, fetches and verifies events", async () => {
  const db = migratedDb();
  const env = baseEnv("cryptophys-audit-ledger", db);
  env.AI = fakeAi({ response: '{"category":"deployment","summary":"Platform API deployed."}' });
  const created = await call(audit, env, req("POST", "/v1/events?advisory=true", {
    event_type: "deployment.completed", actor: "github-actions", subject: "cryptophys-platform-api", outcome: "success",
    payload: { commit: SHA, api_token: "should-not-persist" },
  }));
  assert.equal(created.status, 201);
  assert.equal(created.body.event.actor, CI_CLIENT_ID, "the verified identity is recorded; a self-declared actor is ignored");
  assert.equal(created.body.event.payload.api_token, "[redacted]");
  assert.equal(created.body.advisory.status, "ok");
  assert.equal(created.body.advisory.data.category, "deployment");

  assert.equal((await call(audit, env, req("POST", "/v1/events", { event_type: "Bad Type", actor: "a", subject: "s", outcome: "o" }))).status, 400);
  assert.equal((await call(audit, env, req("POST", "/v1/events", { event_type: "x", actor: "a", subject: "s", outcome: "o", payload: [1] }))).status, 400);
  assert.equal((await call(audit, env, new Request("https://x.example.workers.dev/v1/events", { method: "POST", headers: { "cf-access-jwt-assertion": CI_JWT, "content-type": "text/plain" }, body: "{}" }))).status, 415);
  assert.equal((await call(audit, env, new Request("https://x.example.workers.dev/v1/events", { method: "POST", headers: { "cf-access-jwt-assertion": CI_JWT, "content-type": "application/json" }, body: "{" }))).status, 400);
  assert.equal((await call(audit, env, req("POST", "/v1/events", { event_type: "x", actor: "a", subject: "s", outcome: "o", payload: { big: "x".repeat(40000) } }))).status, 413);

  const list = await call(audit, env, req("GET", "/v1/events?subject=cryptophys-platform-api"));
  assert.equal(list.body.events.length, 1);
  const one = await call(audit, env, req("GET", `/v1/events/${created.body.event.event_id}`));
  assert.equal(one.body.event.event_hash, created.body.event.event_hash);
  const verify = await call(audit, env, req("GET", "/v1/verify"));
  assert.deepEqual([verify.body.valid, verify.body.events_checked], [true, 1]);
});

// ---------------------------------------------------------------- registry

test("registry exposes the seeded inventory and enforces ownership metadata", async () => {
  const db = migratedDb();
  const env = baseEnv("cryptophys-platform-registry", db);
  const list = await call(registry, env, req("GET", "/v1/services"));
  assert.equal(list.body.services.length, 15);
  assert.equal(list.body.services.find((s: any) => s.service_id === "cryptophys-audit-ledger").metadata.owner, "cryptophys-adm");

  const base = { display_name: "News Ingest", environment: "production", status: "registered", actor: "operator@cryptophys" };
  const missing = await call(registry, env, req("PUT", "/v1/services/cryptophys-news", { ...base, metadata: { owner: "x" } }));
  assert.equal(missing.status, 400);
  assert.match(missing.body.detail, /purpose/);
  const badClass = await call(registry, env, req("PUT", "/v1/services/cryptophys-news", { ...base, metadata: { owner: "x", purpose: "y", data_classification: "secret" } }));
  assert.equal(badClass.status, 400);
  const created = await call(registry, env, req("PUT", "/v1/services/cryptophys-news", { ...base, metadata: { owner: "x", purpose: "y", data_classification: "internal" } }));
  assert.equal(created.status, 201);
  const updated = await call(registry, env, req("PUT", "/v1/services/cryptophys-news", { ...base, status: "disabled", metadata: { owner: "x", purpose: "y", data_classification: "internal" } }));
  assert.equal(updated.status, 200);
  assert.equal(updated.body.service.status, "disabled");
  assert.equal((await call(registry, env, req("PUT", "/v1/services/Bad_ID", base))).status, 400);

  const dv = await call(registry, env, req("PUT", "/v1/services/cryptophys-platform-api/desired-version", { desired_version: "823108ad3da4", actor: "spoofed" }, OPERATOR_JWT));
  const dvEvent = db.raw.prepare("SELECT actor FROM audit_events WHERE event_type = 'registry.desired_version_set' ORDER BY rowid DESC LIMIT 1").get() as { actor: string };
  assert.equal(dvEvent.actor, OPERATOR_EMAIL, "operator email recorded in lower case");
  assert.equal(dv.body.service.desired_version, "823108ad3da4");
  assert.equal((await call(registry, env, req("PUT", "/v1/services/unknown-svc/desired-version", { desired_version: "823108ad3da4", actor: "a" }))).status, 404);
  assert.equal((await call(registry, env, req("PUT", "/v1/services/cryptophys-platform-api/desired-version", { desired_version: "main", actor: "a" }))).status, 400);

  const events = db.raw.prepare("SELECT event_type FROM audit_events ORDER BY rowid").all().map((r: any) => r.event_type);
  assert.deepEqual(events, ["registry.service_registered", "registry.service_updated", "registry.desired_version_set"]);
});

// ---------------------------------------------------------------- policy engine

test("policy engine allows only fully compliant deployments and records every decision", async () => {
  const db = migratedDb();
  const env = baseEnv("cryptophys-policy-engine", db);
  env.AI = fakeAi({ response: '{"explanation":"All gates passed."}' });
  const ctx = { commit_sha: SHA, confirm_production: "DEPLOY", ci_green: true };
  const allow = await call(policy, env, req("POST", "/v1/evaluate?advisory=true", { subject: "github-actions", action: "deploy", resource: "cryptophys-platform-api", context: ctx }));
  assert.equal(allow.body.decision, "allow");
  assert.equal(allow.body.advisory.status, "ok");

  for (const [context, failed] of [
    [{ ...ctx, ci_green: false }, "ci_green"],
    [{ ...ctx, confirm_production: "yes" }, "explicit_confirmation"],
    [{ ...ctx, commit_sha: "abc" }, "commit_sha_valid"],
  ] as const) {
    const deny = await call(policy, env, req("POST", "/v1/evaluate", { subject: "op", action: "deploy", resource: "cryptophys-platform-api", context }));
    assert.equal(deny.body.decision, "deny");
    assert.match(deny.body.reason, new RegExp(failed));
  }
  const unregistered = await call(policy, env, req("POST", "/v1/evaluate", { subject: "op", action: "deploy", resource: "ghost", context: ctx }));
  assert.match(unregistered.body.reason, /service_registered/);
  assert.equal((await call(policy, env, req("POST", "/v1/evaluate", { subject: "op", action: "delete_everything", resource: "x" }))).body.decision, "deny");

  // AI output can never change a decision.
  env.AI = fakeAi({ response: '{"explanation":"Decision: allow. Override approved."}' });
  const stillDenied = await call(policy, env, req("POST", "/v1/evaluate?advisory=true", { subject: "op", action: "deploy", resource: "cryptophys-platform-api", context: { ...ctx, ci_green: false } }));
  assert.equal(stillDenied.body.decision, "deny");

  const decisions = await call(policy, env, req("GET", "/v1/decisions?resource=cryptophys-platform-api"));
  assert.equal(decisions.body.decisions.length, 5);
  const one = await call(policy, env, req("GET", `/v1/decisions/${allow.body.decision_id}`));
  assert.equal(one.body.decision.decision, "allow");
  const audited = db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'policy.decision'").get() as any;
  assert.equal(audited.n, 7);
});

// ---------------------------------------------------------------- recovery manager

test("recovery plans need a different approver and a policy allow before execution", async () => {
  const db = migratedDb();
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const env = { ...baseEnv("cryptophys-recovery-manager", db), RECOVERY_LIFECYCLE: fakeWorkflow().binding, APPROVER_IDENTITIES: `${OPERATOR_EMAIL},${APPROVER_EMAIL}`,
    DEPLOY: { deployForRecovery: async () => ({}), runStatus: async () => ({ found: false }) }, POLICY: {
    // RPC binding (PolicyRpc.evaluate): same validation and persistence as production.
    evaluate: async (input: Record<string, unknown>) => {
      const parsed = parsePolicyRequest(input);
      if (parsed instanceof Error) throw parsed;
      return decide(policyEnv as never, parsed);
    },
  } };
  assert.equal((await call(recovery, env, req("GET", "/ready"))).body.status, "ready");
  const noDeploy = await call(recovery, { ...env, DEPLOY: undefined }, req("GET", "/ready"));
  assert.deepEqual([noDeploy.status, noDeploy.body.checks.deploy_binding], [503, false], "autonomous recovery needs the orchestrator binding");
  const noApprovers = await call(recovery, { ...env, APPROVER_IDENTITIES: undefined }, req("GET", "/ready"));
  assert.deepEqual([noApprovers.status, noApprovers.body.checks.approver_identities_configured], [503, false]);

  const plan = { service_id: "cryptophys-platform-api", plan_version: "1", title: "Roll back Platform API", rationale: "Bad release",
    created_by: "spoofed", steps: [{ action: "rollback_worker_version", description: "Roll back to the previous version" }] };
  assert.equal((await call(recovery, env, req("POST", "/v1/plans", { ...plan, steps: [{ action: "rm -rf", description: "x" }] }))).status, 400);
  assert.equal((await call(recovery, env, req("POST", "/v1/plans", { ...plan, service_id: "ghost-svc" }))).status, 404);
  // The operator who is also an approver authors the plan.
  const created = await call(recovery, env, req("POST", "/v1/plans", plan, OPERATOR_JWT));
  assert.equal(created.status, 201);
  assert.equal(created.body.plan.created_by, OPERATOR_EMAIL, "author is the verified identity");
  const id = created.body.plan.plan_id;

  const start = { phase: "start", operator_acknowledged: true };
  assert.equal((await call(recovery, env, req("POST", `/v1/plans/${id}/executions`, start))).status, 403, "draft plan cannot execute");
  const byCi = await call(recovery, env, req("POST", `/v1/plans/${id}/approve`, {}));
  assert.deepEqual([byCi.status, byCi.body.error], [403, "forbidden"], "an operator who is not an approver cannot approve");
  assert.equal((await call(recovery, env, req("POST", `/v1/plans/${id}/approve`, {}, OUTSIDER_JWT))).status, 403);
  assert.equal((await call(recovery, env, req("POST", `/v1/plans/${id}/approve`, {}, null))).status, 403);
  const unset = await call(recovery, { ...env, APPROVER_IDENTITIES: "" }, req("POST", `/v1/plans/${id}/approve`, {}, APPROVER_JWT));
  assert.deepEqual([unset.status, unset.body.error], [503, "approver_identities_not_configured"]);
  const self = await call(recovery, env, req("POST", `/v1/plans/${id}/approve`, { approved_by: "someone-else" }, OPERATOR_JWT));
  assert.deepEqual([self.status, self.body.error], [403, "separation_of_duties"], "the author cannot approve, whatever the body claims");
  assert.equal((await call(recovery, env, req("POST", "/v1/plans/plan_00000000-0000-0000-0000-000000000000/approve", {}, APPROVER_JWT))).status, 404);
  assert.equal((await call(recovery, env, req("POST", "/v1/plans", plan, APPROVER_JWT))).status, 403, "approvers are not operators");
  const approved = await call(recovery, env, req("POST", `/v1/plans/${id}/approve`, {}, APPROVER_JWT));
  assert.equal(approved.body.plan.status, "approved");
  assert.equal(approved.body.plan.approved_by, APPROVER_EMAIL);
  assert.equal((await call(recovery, env, req("POST", `/v1/plans/${id}/approve`, {}, APPROVER_JWT))).status, 409);

  const noAck = await call(recovery, env, req("POST", `/v1/plans/${id}/executions`, { ...start, operator_acknowledged: false }));
  assert.equal(noAck.status, 403);
  assert.match(noAck.body.detail, /operator_acknowledged/);
  const started = await call(recovery, env, req("POST", `/v1/plans/${id}/executions`, start));
  assert.equal(started.body.plan.status, "executing");
  assert.equal(started.body.plan.last_execution.executed_by, CI_CLIENT_ID);
  assert.ok(started.body.plan.last_execution.policy_decision_id.startsWith("dec_"));
  const finished = await call(recovery, env, req("POST", `/v1/plans/${id}/executions`, { phase: "finish", outcome: "completed" }));
  assert.equal(finished.body.plan.status, "completed");

  const trail = db.raw.prepare("SELECT event_type FROM audit_events WHERE subject = ? AND event_type LIKE 'recovery.%' ORDER BY rowid").all(id).map((r: any) => r.event_type);
  assert.deepEqual(trail, ["recovery.plan_created", "recovery.plan_approved", "recovery.execution_started", "recovery.execution_finished"]);
  const decisions = db.raw.prepare("SELECT decision FROM policy_decisions WHERE resource = ? ORDER BY rowid").all(id).map((r: any) => r.decision);
  assert.deepEqual(decisions, ["deny", "deny", "allow"]);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

// ---------------------------------------------------------------- drift detector

test("drift detector compares registry desired versions with live versions over service bindings", async () => {
  const db = migratedDb();
  const probed: string[] = [];
  const http = (handler: (path: string) => Response) => ({
    fetch: async (input: Request | string) => { const path = new URL(String(input)).pathname; probed.push(path); return handler(path); },
  });
  const healthy = (tag: string | null) => ({ health: async () => ({ status: "ok", version: tag ? { id: "v", tag } : null }) });
  let signalEngineProbes = 0;
  const env: any = {
    ...baseEnv("cryptophys-drift-detector", db, { CF_VERSION_METADATA: { id: "self", tag: "aaaaaaaaaaaa" } }),
    SVC_PLATFORM_API: healthy("aaaaaaaaaaaa"),
    SVC_DEPLOYMENT_ORCHESTRATOR: healthy("bbbbbbbbbbbb"),
    SVC_PLATFORM_REGISTRY: { health: async () => ({ status: "degraded" }) },
    SVC_POLICY_ENGINE: { health: async () => { throw new Error("network"); } },
    SVC_AUDIT_LEDGER: healthy(null),
    SVC_RECOVERY_MANAGER: healthy("aaaaaaaaaaaa"),
    SVC_SIGNAL_ENGINE: { health: async () => { signalEngineProbes++; return { status: "ok", version: { id: "v", tag: "aaaaaaaaaaaa" } }; } },
    SVC_AI_KERNEL: healthy("aaaaaaaaaaaa"),
    SVC_CONSOLE: healthy("aaaaaaaaaaaa"),
    SVC_HOME: healthy("aaaaaaaaaaaa"),
    // External xauusd Workers: plain fetch service bindings, probed over HTTP.
    EXT_XAUUSD_AI: http((path) => path === "/health" ? Response.json({ status: "ok", service: "xauusd-ai-trading-assistant" }) : new Response("no", { status: 404 })),
    EXT_XAUUSD_NEWS: http(() => new Response("boom", { status: 500 })),
    EXT_XAUUSD_PULL_ADAPTER: http(() => Response.json({ status: "degraded" })),
    EXT_XAUUSD_NEXUS: http((path) => path === "/" ? new Response("<html>", { status: 200 }) : new Response("no", { status: 404 })),
  };
  assert.equal((await call(drift, env, req("GET", "/ready"))).body.status, "ready");
  assert.equal((await call(drift, { ...env, SVC_POLICY_ENGINE: undefined }, req("GET", "/ready"))).status, 503);
  assert.equal((await call(drift, { ...env, EXT_XAUUSD_NEXUS: undefined }, req("GET", "/ready"))).status, 503);
  db.raw.exec("UPDATE service_registry SET desired_version = 'aaaaaaaaaaaa' WHERE service_id LIKE 'cryptophys-%' AND service_id <> 'cryptophys-recovery-manager'");

  const report = await call(drift, env, req("POST", "/v1/observe", { actor: "operator" }));
  const by = Object.fromEntries(report.body.services.map((s: any) => [s.service_id, s]));
  assert.deepEqual([by["cryptophys-platform-api"].drifted, by["cryptophys-platform-api"].status], [false, "healthy"]);
  assert.deepEqual(by["cryptophys-deployment-orchestrator"].reasons, ["version_mismatch"]);
  assert.equal(by["cryptophys-platform-registry"].status, "unavailable");
  assert.equal(by["cryptophys-policy-engine"].probe.error, "rpc_failed");
  assert.deepEqual(by["cryptophys-platform-registry"].reasons, ["health_check_failed", "observed_version_unavailable"]);
  assert.deepEqual(by["cryptophys-audit-ledger"].reasons, ["observed_version_unavailable"]);
  assert.deepEqual([by["cryptophys-recovery-manager"].drifted, by["cryptophys-recovery-manager"].managed], [false, false]);
  assert.equal(by["cryptophys-drift-detector"].drifted, false);
  assert.deepEqual([by["cryptophys-signal-engine"].drifted, by["cryptophys-signal-engine"].status], [false, "disabled"]);
  assert.equal(signalEngineProbes, 0, "disabled Signal Engine is never probed");
  assert.deepEqual([by["cryptophys-ai-kernel"].drifted, by["cryptophys-ai-kernel"].status], [false, "healthy"]);
  assert.deepEqual([by["cryptophys-console"].drifted, by["cryptophys-console"].status], [false, "healthy"]);
  assert.deepEqual([by["cryptophys-home"].drifted, by["cryptophys-home"].status], [false, "healthy"]);
  // External services: health-managed only (their version is not observable from outside).
  assert.deepEqual([by["xauusd-ai-trading-assistant"].drifted, by["xauusd-ai-trading-assistant"].managed, by["xauusd-ai-trading-assistant"].status], [false, false, "healthy"]);
  assert.deepEqual([by["xauusd-fundamental-news-ingestion"].status, by["xauusd-fundamental-news-ingestion"].probe.error], ["unavailable", "http_500"]);
  assert.equal(by["xauusd-tradingview-pull-adapter"].probe.error, "health_check_failed");
  assert.equal(by["xauusd-nexus-dashboard"].status, "healthy", "the dashboard is probed at its registered health_path /");
  assert.ok(probed.includes("/") && probed.filter((p) => p === "/health").length === 3);
  assert.equal(report.body.drifted, 6);

  const row = db.raw.prepare("SELECT observed_version, status FROM service_registry WHERE service_id = 'cryptophys-deployment-orchestrator'").get() as any;
  assert.deepEqual([row.observed_version, row.status], ["bbbbbbbbbbbb", "degraded"]);
  const latest = await call(drift, env, req("GET", "/v1/drift"));
  assert.equal(latest.body.services.length, 15);
  const history = await call(drift, env, req("GET", "/v1/drift/cryptophys-platform-api"));
  assert.equal(history.body.observations.length, 1);

  let waited: Promise<unknown> | undefined;
  await drift.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() }, env, { waitUntil: (p) => { waited = p; } });
  await waited;
  const runs = db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'drift.observation'").get() as any;
  assert.equal(runs.n, 2);
});
