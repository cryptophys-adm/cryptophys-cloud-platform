// ADR-0012 G2c-2 (§5l): configuration and binding changes planned without GitHub. The plan is the active
// version's bindings with the wrangler.toml diff applied; anything a version upload cannot reproduce is
// ineligible with an explicit reason, and the uploaded version must bind exactly the plan before traffic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  bindingsFromToml, parseToml, planConfigChange, uploadBindings, verifyPlannedBindings, verifyVersionSettings,
  type BindingRecord, type ConfigPlan,
} from "../../deployment-orchestrator/src/config-diff.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const D1_ID = "0f6a3c1e-1111-4222-8333-944445555666";
const DO_NS = "a".repeat(32);

const ORCH = read("workers/deployment-orchestrator/wrangler.toml");
const KERNEL = read("workers/ai-kernel/wrangler.toml");

/**
 * The binding records the API would return for the active version deployed from `toml` by its workflow: the
 * placeholders rendered, the server's fields added, the deploy-time --var values and the secrets.
 */
function activeFor(toml: string, extra: BindingRecord[] = []): BindingRecord[] {
  const b = bindingsFromToml(parseToml(toml)!).bindings!;
  return [...b.map((r) => {
    const o: BindingRecord = { ...r };
    if (o.type === "d1") o.id = D1_ID;
    if (o.type === "service") o.environment = "production";
    if (o.type === "durable_object_namespace") o.namespace_id = DO_NS;
    if (o.type === "send_email") o.allowed_destination_addresses = ["owner@example.com", "security@example.com"];
    return o;
  }), ...extra];
}
const DEPLOY_VARS: BindingRecord[] = [
  { type: "plain_text", name: "ACCESS_AUD", text: "aud-tag" },
  { type: "plain_text", name: "CF_ACCOUNT_ID", text: "f".repeat(32) },
  { type: "secret_text", name: "CF_DEPLOY_TOKEN" },
  { type: "secret_text", name: "GH_ACTIONS_TOKEN" },
];
const ok = (r: ReturnType<typeof planConfigChange>): ConfigPlan => { assert.equal(r.eligible, true, JSON.stringify(r)); return r as ConfigPlan; };
const reason = (r: ReturnType<typeof planConfigChange>) => (r.eligible ? "eligible" : r.reason);
/** What the API returns for a version uploaded with the plan (it adds the server fields to config records). */
const uploadedFrom = (plan: ConfigPlan): BindingRecord[] => [
  ...uploadBindings(plan).map((b) => {
    const o = { ...b };
    if (o.type === "service" && o.environment === undefined) o.environment = "production";
    if (o.type === "durable_object_namespace") o.namespace_id = DO_NS;
    return o;
  }),
  ...plan.secrets.map((k) => ({ type: k.split(":")[0], name: k.split(":")[1] })),
];

test("CD1. every workers/*/wrangler.toml parses, and every binding kind it uses maps to an API record", () => {
  const dirs = readdirSync(new URL("workers/", ROOT)).filter((d) => existsSync(new URL(`workers/${d}/wrangler.toml`, ROOT)));
  assert.ok(dirs.length >= 12, `found ${dirs.length}`); // 12 since cryptophys-home was retired (2026-11-13)
  const types = new Set<string>();
  for (const d of dirs) {
    const config = parseToml(read(`workers/${d}/wrangler.toml`));
    assert.ok(config, `${d} parses`);
    const b = bindingsFromToml(config!);
    assert.ok(b.bindings, `${d}: ${b.reason}`);
    for (const r of b.bindings!) types.add(r.type);
  }
  for (const t of ["plain_text", "d1", "service", "durable_object_namespace", "r2_bucket", "ai", "vectorize", "workflow", "artifacts", "worker_loader", "version_metadata", "send_email", "assets"]) {
    assert.ok(types.has(t), `the repository uses ${t}`);
  }
  const console = bindingsFromToml(parseToml(read("workers/console/wrangler.toml"))!).bindings!;
  assert.deepEqual(console.find((b) => b.type === "assets"), { type: "assets", name: "ASSETS" });
  const audit = bindingsFromToml(parseToml(read("workers/audit-ledger/wrangler.toml"))!).bindings!;
  assert.deepEqual(audit.find((b) => b.name === "AGENTS"), { type: "service", name: "AGENTS", service: "cryptophys-ai-kernel", entrypoint: "AgentRpc", props: { host_worker: "cryptophys-audit-ledger" } });
  const kernel = bindingsFromToml(parseToml(KERNEL)!).bindings!;
  assert.deepEqual(kernel.find((b) => b.name === "SUPERVISOR"), { type: "durable_object_namespace", name: "SUPERVISOR", class_name: "SupervisorAgent" });
  assert.deepEqual(kernel.find((b) => b.name === "MEMORY"), { type: "vectorize", name: "MEMORY", index_name: "cryptophys-agent-memory" });
  assert.deepEqual(kernel.find((b) => b.name === "DB"), { type: "d1", name: "DB", id: "__CONTROL_PLANE_D1_DATABASE_ID__" }, "database_name and migrations_dir are wrangler-only");
  const recovery = bindingsFromToml(parseToml(read("workers/recovery-manager/wrangler.toml"))!).bindings!;
  assert.deepEqual(recovery.find((b) => b.type === "workflow"), { type: "workflow", name: "RECOVERY_LIFECYCLE", workflow_name: "cryptophys-recovery-lifecycle", class_name: "RecoveryPlanWorkflow" });
  const forge = parseToml(read("workers/forge/wrangler.toml"))!;
  assert.deepEqual(forge.limits, { cpu_ms: 300000 });
  assert.deepEqual((forge.triggers as any).crons, ["4,19,34,49 * * * *"]);
  // The kinds the repository does not use yet still map.
  const more = bindingsFromToml(parseToml([
    "[[kv_namespaces]]\nbinding = \"KV\"\nid = \"abc\"\npreview_id = \"p\"",
    "[[secrets_store_secrets]]\nbinding = \"S\"\nstore_id = \"st\"\nsecret_name = \"n\"",
    "[[analytics_engine_datasets]]\nbinding = \"AE\"\ndataset = \"d\"",
    "[[queues.producers]]\nbinding = \"Q\"\nqueue = \"q1\"",
    "[browser]\nbinding = \"BROWSER\"",
  ].join("\n"))!).bindings!;
  assert.deepEqual(more, [
    { type: "analytics_engine", name: "AE", dataset: "d" }, { type: "browser", name: "BROWSER" }, { type: "kv_namespace", name: "KV", namespace_id: "abc" },
    { type: "queue", name: "Q", queue_name: "q1" }, { type: "secrets_store_secret", name: "S", store_id: "st", secret_name: "n" },
  ]);
});

test("CD2. the parser refuses what it does not understand instead of guessing", () => {
  assert.deepEqual(parseToml("a = [\n  \"x\", # c\n  \"y\",\n]\nb = { k = 'v', n = 2 }\n[t]\nx = true\n[[arr]]\nq = -1.5\n[arr.sub]\nz = \"\\u00e9\"\n"),
    { a: ["x", "y"], b: { k: "v", n: 2 }, t: { x: true }, arr: [{ q: -1.5, sub: { z: "é" } }] });
  for (const bad of ["a = \"\"\"multi\"\"\"", "d = 2026-11-01", "a.b = 1", "a = 1\na = 2", "[t]\n[t]", "a = \"open", "a = 1 b = 2", "[[t]]\n[t]", "a = { b = 1 }\n[a]", "x = nope", "x = 'a\nb'"]) {
    assert.equal(parseToml(bad), null, bad);
  }
  assert.equal(bindingsFromToml(parseToml("[[hyperdrive]]\nbinding = \"H\"\nid = \"x\"")!).reason, "unsupported_key:hyperdrive");
  assert.equal(bindingsFromToml(parseToml("[vars]\nN = 3")!).reason, "var_not_string:N");
  assert.equal(bindingsFromToml(parseToml("[[r2_buckets]]\nbinding = \"B\"\nbucket_name = \"b\"\nweird = 1")!).reason, "unsupported_binding_field:r2_buckets.weird");
  assert.equal(bindingsFromToml(parseToml("[vars]\nX = \"1\"\n[ai]\nbinding = \"X\"")!).reason, "duplicate_binding_name:X");
  assert.equal(reason(planConfigChange("name = [", ORCH, [])), "config_unparsed");
  assert.equal(reason(planConfigChange(ORCH, ORCH, "nope")), "active_bindings_unreadable");
});

test("CD3. an unchanged config keeps every active binding verbatim, the deploy-time --var values and the secrets", () => {
  const active = activeFor(ORCH, DEPLOY_VARS);
  const plan = ok(planConfigChange(ORCH, ORCH, active));
  assert.deepEqual(plan.changes, { added: [], removed: [], changed: [], settings: [] });
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.secrets, ["secret_text:CF_DEPLOY_TOKEN", "secret_text:GH_ACTIONS_TOKEN"]);
  assert.deepEqual(plan.keep_bindings, ["secret_text", "secret_key"]);
  assert.ok(!plan.bindings.some((b) => b.type === "secret_text"), "secrets are never in the plan");
  assert.equal(plan.bindings.length, active.length - 2);
  assert.ok(Object.values(plan.sources).every((s) => s === "active"));
  assert.deepEqual(plan.bindings.find((b) => b.name === "ACCESS_AUD"), { type: "plain_text", name: "ACCESS_AUD", text: "aud-tag" });
  assert.deepEqual(plan.metadata, { compatibility_date: "2026-11-01", compatibility_flags: [] });
  // A Durable Object binding is sent without its namespace_id, which the API assigns.
  assert.ok(!("namespace_id" in uploadBindings(plan).find((b) => b.name === "DEPLOYMENT_LOCK")!));
  assert.deepEqual(verifyPlannedBindings(plan, uploadedFrom(plan)), { ok: true });
});

test("CD4. a changed [vars] value replaces only that record; --var values are untouched because the diff never names them", () => {
  const target = ORCH.replace('AI_DAILY_REQUEST_LIMIT = "80"', 'AI_DAILY_REQUEST_LIMIT = "60"');
  assert.notEqual(target, ORCH);
  const plan = ok(planConfigChange(ORCH, target, activeFor(ORCH, DEPLOY_VARS)));
  assert.deepEqual(plan.changes.changed, ["plain_text:AI_DAILY_REQUEST_LIMIT"]);
  assert.deepEqual(plan.bindings.find((b) => b.name === "AI_DAILY_REQUEST_LIMIT"), { type: "plain_text", name: "AI_DAILY_REQUEST_LIMIT", text: "60" });
  assert.equal(plan.sources["plain_text:AI_DAILY_REQUEST_LIMIT"], "config");
  assert.equal(plan.bindings.find((b) => b.name === "CF_ACCOUNT_ID")?.text, "f".repeat(32));
  assert.deepEqual(verifyPlannedBindings(plan, uploadedFrom(plan)), { ok: true });
});

test("CD5. a new service binding is added in the API shape; the API's environment field is accepted, anything else is not", () => {
  const target = ORCH + '\n[[services]]\nbinding = "POLICY"\nservice = "cryptophys-policy-engine"\nentrypoint = "PolicyRpc"\n';
  const plan = ok(planConfigChange(ORCH, target, activeFor(ORCH, DEPLOY_VARS)));
  assert.deepEqual(plan.changes.added, ["service:POLICY"]);
  assert.deepEqual(plan.bindings.find((b) => b.name === "POLICY"), { type: "service", name: "POLICY", service: "cryptophys-policy-engine", entrypoint: "PolicyRpc" });
  const uploaded = uploadedFrom(plan);
  assert.equal(uploaded.find((b) => b.name === "POLICY")?.environment, "production");
  assert.deepEqual(verifyPlannedBindings(plan, uploaded), { ok: true });
  const withProps = uploaded.map((b) => (b.name === "POLICY" ? { ...b, props: { x: 1 } } : b));
  assert.deepEqual(verifyPlannedBindings(plan, withProps), { ok: false, reason: "binding_differs", binding: "service:POLICY" });
});

test("CD6. a removed binding is dropped from the plan", () => {
  const target = ORCH.replace(/\[\[r2_buckets\]\]\nbinding = "BUNDLES"\nbucket_name = "cryptophys-forge-bundles"\n/, "");
  assert.notEqual(target, ORCH);
  const plan = ok(planConfigChange(ORCH, target, activeFor(ORCH, DEPLOY_VARS)));
  assert.deepEqual(plan.changes.removed, ["r2_bucket:BUNDLES"]);
  assert.ok(!plan.bindings.some((b) => b.name === "BUNDLES"));
  // The uploaded version still binding it is a difference that stops the deploy.
  const stale = [...uploadedFrom(plan), { type: "r2_bucket", name: "BUNDLES", bucket_name: "cryptophys-forge-bundles" }];
  assert.deepEqual(verifyPlannedBindings(plan, stale), { ok: false, reason: "unexpected_binding", binding: "r2_bucket:BUNDLES" });
});

test("CD7. a cron change is a separate schedules step applied after verification, with the running crons to restore", () => {
  const target = ORCH.replace('crons = ["2,10,17,25,32,40,47,55 * * * *"]', 'crons = ["2,10,17,25,32,40,47,55 * * * *", "0 3 * * *"]');
  assert.notEqual(target, ORCH);
  const plan = ok(planConfigChange(ORCH, target, activeFor(ORCH, DEPLOY_VARS)));
  assert.deepEqual(plan.changes.settings, ["triggers.crons"]);
  assert.deepEqual(plan.steps, [{
    kind: "schedules", method: "PUT", path: "schedules", when: "after_verify",
    body: [{ cron: "2,10,17,25,32,40,47,55 * * * *" }, { cron: "0 3 * * *" }],
    restore: [{ cron: "2,10,17,25,32,40,47,55 * * * *" }],
  }]);
  assert.equal(plan.bindings.length, activeFor(ORCH, DEPLOY_VARS).length - 2, "bindings untouched");
});

test("CD8. what a version upload cannot apply stays on GitHub, with its reason", () => {
  const active = activeFor(ORCH, DEPLOY_VARS);
  const cases: Array<[string, string]> = [
    [ORCH + '\n[[migrations]]\ntag = "v2"\nnew_sqlite_classes = ["Other"]\n', "do_migration"],
    [ORCH.replace('pattern = "deploy-orchestrator.cryptophys.work"', 'pattern = "deploy.cryptophys.work"'), "routing_changed"],
    [ORCH.replace("workers_dev = true", "workers_dev = false"), "routing_changed"],
    [ORCH.replace('workers_dev = true', 'workers_dev = true\npreview_urls = false'), "routing_changed"],
    [ORCH.replace('main = "src/worker.ts"', 'main = "src/other.ts"'), "identity_changed"],
    [ORCH.replace('name = "cryptophys-deployment-orchestrator"\n', 'name = "cryptophys-deployer"\n'), "identity_changed"],
    [ORCH + '\n[assets]\ndirectory = "./dist"\n', "assets_config_changed"],
    [ORCH + '\n[[workflows]]\nname = "w"\nbinding = "W"\nclass_name = "W"\n', "workflow_changed"],
    [ORCH + '\n[[queues.consumers]]\nqueue = "q"\n', "queue_consumer_changed"],
    [ORCH + '\n[[rules]]\ntype = "Text"\nglobs = ["**/*.txt"]\n', "build_rules_changed"],
    // Appended after the last table, a key belongs to that table: an unknown field there is refused.
    [ORCH + '\nlogpush = true\n', "unsupported_binding_field:r2_buckets.logpush"],
    [ORCH.replace("[observability]\nenabled = true\n", ""), "observability_removed_or_added"],
    [ORCH + '\n[[hyperdrive]]\nbinding = "H"\nid = "x"\n', "unsupported_key:hyperdrive"],
    [ORCH.replace('compatibility_date = "2026-11-01"', 'compatibility_date = "soon"'), "compatibility_date_missing"],
  ];
  for (const [target, why] of cases) {
    assert.notEqual(target, ORCH, why);
    assert.equal(reason(planConfigChange(ORCH, target, active)), why, why);
  }
  // A key placed at the top (before any table) is a top-level setting.
  assert.equal(reason(planConfigChange(ORCH, "logpush = true\n" + ORCH, active)), "logpush_changed");
  assert.equal(reason(planConfigChange(ORCH, "tail_consumers = [{ service = \"t\" }]\n" + ORCH, active)), "tail_consumers_changed");
  // The forge's own Durable Object migration history is unchanged by an unrelated edit.
  const forge = read("workers/forge/wrangler.toml");
  assert.equal(reason(planConfigChange(forge, forge.replace("cpu_ms = 300000", "cpu_ms = 200000"), activeFor(forge))), "eligible");
});

test("CD9. placeholders resolve from the active binding of the same type and name, and fail closed otherwise", () => {
  // The kernel's send_email: its recipient placeholder is unchanged while the sender list changes.
  const target = KERNEL.replace('allowed_sender_addresses = ["alerts@notify.cryptophys.work"]', 'allowed_sender_addresses = ["alerts@notify.cryptophys.work", "ops@notify.cryptophys.work"]');
  assert.notEqual(target, KERNEL);
  const active = activeFor(KERNEL, [{ type: "secret_text", name: "CF_ACCESS_CLIENT_SECRET" }]);
  const plan = ok(planConfigChange(KERNEL, target, active));
  assert.deepEqual(plan.changes.changed, ["send_email:OWNER_EMAIL"]);
  assert.deepEqual(plan.bindings.find((b) => b.name === "OWNER_EMAIL"), {
    type: "send_email", name: "OWNER_EMAIL",
    allowed_destination_addresses: ["owner@example.com", "security@example.com"],
    allowed_sender_addresses: ["alerts@notify.cryptophys.work", "ops@notify.cryptophys.work"],
  });
  assert.ok(!JSON.stringify(plan.bindings).includes("placeholder"), "no placeholder reaches the plan");
  assert.equal(plan.bindings.find((b) => b.name === "DB")?.id, D1_ID, "the unchanged D1 binding keeps the rendered id");
  // A new binding carrying a placeholder has nothing to resolve from.
  const newDb = KERNEL + '\n[[d1_databases]]\nbinding = "DB2"\ndatabase_name = "cryptophys-control-plane"\ndatabase_id = "__CONTROL_PLANE_D1_DATABASE_ID__"\n';
  assert.equal(reason(planConfigChange(KERNEL, newDb, active)), "unresolved_placeholder:__CONTROL_PLANE_D1_DATABASE_ID__");
  // A changed binding whose placeholder field changed too cannot be rendered either.
  const recipients = KERNEL.replace('allowed_destination_addresses = ["owner-notify-placeholder@example.invalid"]', 'allowed_destination_addresses = ["owner-notify-placeholder@example.invalid", "x@example.com"]');
  assert.equal(reason(planConfigChange(KERNEL, recipients, active)), "unresolved_placeholder:owner-notify-placeholder@example.invalid");
  // An active binding that was never rendered is not a resolution.
  const unrendered = active.map((b) => (b.type === "send_email" ? { ...b, allowed_destination_addresses: ["owner-notify-placeholder@example.invalid"] } : b));
  assert.equal(reason(planConfigChange(KERNEL, target, unrendered)), "unresolved_placeholder:owner-notify-placeholder@example.invalid");
});

test("CD10. the running config must describe the active version for every binding the diff touches", () => {
  const active = activeFor(ORCH, DEPLOY_VARS);
  const changed = ORCH.replace('AI_DAILY_REQUEST_LIMIT = "80"', 'AI_DAILY_REQUEST_LIMIT = "60"');
  // A value overridden at deploy time (a --var of the same name) is not what the config says.
  const overridden = active.map((b) => (b.name === "AI_DAILY_REQUEST_LIMIT" ? { ...b, text: "99" } : b));
  assert.equal(reason(planConfigChange(ORCH, changed, overridden)), "active_differs_from_config:plain_text:AI_DAILY_REQUEST_LIMIT");
  // A binding the running config declares but the active version lacks.
  assert.equal(reason(planConfigChange(ORCH, ORCH, active.filter((b) => b.name !== "BUNDLES"))), "active_binding_missing:r2_bucket:BUNDLES");
  // Moving a --var into the config would silently override the deploy-time value.
  assert.equal(reason(planConfigChange(ORCH, ORCH.replace("[vars]\n", '[vars]\nACCESS_AUD = "x"\n'), active)), "binding_set_outside_config:plain_text:ACCESS_AUD");
  // A config binding named like a secret.
  assert.equal(reason(planConfigChange(ORCH, ORCH.replace("[vars]\n", '[vars]\nCF_DEPLOY_TOKEN = "x"\n'), active)), "binding_name_conflict:CF_DEPLOY_TOKEN");
});

test("CD11. the binding check after upload: secrets by name and type, active records exactly, config records with server fields only", () => {
  const plan = ok(planConfigChange(ORCH, ORCH.replace('AI_DAILY_REQUEST_LIMIT = "80"', 'AI_DAILY_REQUEST_LIMIT = "60"'), activeFor(ORCH, DEPLOY_VARS)));
  const good = uploadedFrom(plan);
  assert.deepEqual(verifyPlannedBindings(plan, good), { ok: true });
  assert.deepEqual(verifyPlannedBindings(plan, good.filter((b) => b.name !== "GH_ACTIONS_TOKEN")), { ok: false, reason: "secrets_differ" });
  assert.deepEqual(verifyPlannedBindings(plan, good.filter((b) => b.name !== "DRIFT")), { ok: false, reason: "missing_binding", binding: "service:DRIFT" });
  // A kept record that lost its props (keep_bindings copying from the wrong version, G2b) stops the deploy.
  const noProps = good.map((b) => (b.name === "AGENTS" ? Object.fromEntries(Object.entries(b).filter(([k]) => k !== "props")) as BindingRecord : b));
  assert.deepEqual(verifyPlannedBindings(plan, noProps), { ok: false, reason: "binding_differs", binding: "service:AGENTS" });
  assert.deepEqual(verifyPlannedBindings(plan, good.map((b) => (b.name === "AI_DAILY_REQUEST_LIMIT" ? { ...b, text: "80" } : b))), { ok: false, reason: "binding_differs", binding: "plain_text:AI_DAILY_REQUEST_LIMIT" });
  assert.deepEqual(verifyPlannedBindings(plan, "x"), { ok: false, reason: "uploaded_bindings_unreadable" });
});

test("CD12. settings that are not bindings: compatibility and limits in the metadata, observability as a script setting, all verified", () => {
  const forge = read("workers/forge/wrangler.toml");
  const target = forge.replace('compatibility_date = "2026-11-01"', 'compatibility_date = "2026-11-10"\ncompatibility_flags = ["nodejs_compat"]').replace("[observability]\nenabled = true", "[observability]\nenabled = true\nhead_sampling_rate = 0.5");
  const plan = ok(planConfigChange(forge, target, activeFor(forge, [{ type: "secret_text", name: "CF_BUILDS_API_TOKEN" }])));
  assert.deepEqual(plan.metadata, { compatibility_date: "2026-11-10", compatibility_flags: ["nodejs_compat"], limits: { cpu_ms: 300000 } }, "full target values, not a diff");
  assert.deepEqual(plan.changes.settings, ["compatibility_date", "compatibility_flags", "observability"]);
  assert.deepEqual(plan.steps, [{ kind: "script_settings", method: "PATCH", path: "script-settings", when: "after_verify", body: { observability: { enabled: true, head_sampling_rate: 0.5 } }, restore: { observability: { enabled: true } } }]);
  const runtime = (over: Record<string, unknown> = {}) => ({ resources: { script_runtime: { compatibility_date: "2026-11-10", compatibility_flags: ["nodejs_compat"], limits: { cpu_ms: 300000 }, ...over } } });
  assert.deepEqual(verifyVersionSettings(plan.metadata, runtime()), { ok: true });
  assert.deepEqual(verifyVersionSettings(plan.metadata, runtime({ limits: undefined })), { ok: false, reason: "limits_differ" }, "a version without the planned cpu_ms never gets traffic");
  assert.deepEqual(verifyVersionSettings(plan.metadata, runtime({ compatibility_date: "2026-11-01" })), { ok: false, reason: "compatibility_date_differs" });
  assert.deepEqual(verifyVersionSettings(plan.metadata, runtime({ compatibility_flags: [] })), { ok: false, reason: "compatibility_flags_differ" });
  assert.deepEqual(verifyVersionSettings(plan.metadata, {}), { ok: false, reason: "version_settings_unreadable" });
});
