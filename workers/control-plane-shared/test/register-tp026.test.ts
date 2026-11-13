import { test } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, call, migratedDb, req } from "./harness.ts";
import { REQUIRED_MIGRATION, schemaReady } from "../src/readiness.ts";
import registry from "../../platform-registry/src/index.ts";
import drift, { observe, targets } from "../../drift-detector/src/index.ts";

function healthy(tag: string | null) {
  return { health: async () => ({ status: "ok", version: tag ? { id: "v", tag } : null }) };
}

function driftTestEnv(db: any, extra: Record<string, unknown> = {}) {
  const http = (handler: (path: string) => Response) => ({
    fetch: async (input: Request | string) => {
      const path = new URL(String(input)).pathname;
      return handler(path);
    },
  });
  return {
    ...baseEnv("cryptophys-drift-detector", db, { CF_VERSION_METADATA: { id: "self", tag: "aaaaaaaaaaaa" } }),
    SVC_PLATFORM_API: healthy("aaaaaaaaaaaa"),
    SVC_DEPLOYMENT_ORCHESTRATOR: healthy("aaaaaaaaaaaa"),
    SVC_PLATFORM_REGISTRY: healthy("aaaaaaaaaaaa"),
    SVC_POLICY_ENGINE: healthy("aaaaaaaaaaaa"),
    SVC_AUDIT_LEDGER: healthy("aaaaaaaaaaaa"),
    SVC_RECOVERY_MANAGER: healthy("aaaaaaaaaaaa"),
    SVC_AI_KERNEL: healthy("aaaaaaaaaaaa"),
    SVC_CONSOLE: healthy("aaaaaaaaaaaa"),
    SVC_FORGE: healthy("bbbbbbbbbbbb"),
    EXT_XAUUSD_AI: http(() => Response.json({ status: "ok" })),
    EXT_XAUUSD_NEWS: http(() => Response.json({ status: "ok" })),
    EXT_XAUUSD_PULL_ADAPTER: http(() => Response.json({ status: "ok" })),
    EXT_XAUUSD_NEXUS: http(() => new Response("<html>", { status: 200 })),
    EXT_AETHER: http(() => Response.json({ status: "ok" })),
    EXT_XAUUSD_OMEGA: http(() => Response.json({ status: "ok" })),
    ...extra,
  } as any;
}

test("1. Migration: service_registry has 18 rows (15 + Aether from 0027 + Forge from 0030 + Omega from 0042), console registered, home kept but disabled (0055), schemaReady is true", async () => {
  const db = migratedDb();
  const rows = db.raw.prepare("SELECT * FROM service_registry ORDER BY service_id").all() as any[];
  assert.equal(rows.length, 18);

  const omegaRow = rows.find((r) => r.service_id === "xauusd-omega");
  assert.ok(omegaRow);
  assert.equal(omegaRow.display_name, "XAUUSD Omega Execution Engine");
  assert.equal(omegaRow.environment, "production");
  assert.equal(omegaRow.status, "registered");
  assert.equal(omegaRow.desired_version, null);
  const omegaMeta = JSON.parse(omegaRow.metadata_json);
  assert.equal(omegaMeta.owner, "cryptophys-adm");
  assert.equal(omegaMeta.health_path, "/health");
  assert.equal(omegaMeta.deployed_by, "cryptophys-adm/xauusd-ai-trading-assistant");

  const consoleRow = rows.find((r) => r.service_id === "cryptophys-console");
  assert.ok(consoleRow);
  assert.equal(consoleRow.display_name, "Console");
  assert.equal(consoleRow.environment, "production");
  assert.equal(consoleRow.status, "registered");
  assert.equal(consoleRow.desired_version, null);
  const consoleMeta = JSON.parse(consoleRow.metadata_json);
  assert.equal(consoleMeta.owner, "cryptophys-adm");
  assert.equal(consoleMeta.purpose, "Operator console: allow-listed forwarding with the operator's own Access JWT (ADR-0008)");
  assert.equal(consoleMeta.data_classification, "internal");
  assert.equal(consoleMeta.source, "workers/console");

  const homeRow = rows.find((r) => r.service_id === "cryptophys-home");
  assert.ok(homeRow);
  assert.equal(homeRow.display_name, "Cerebrum Home");
  assert.equal(homeRow.environment, "production");
  // ADR-0010 amendment 2026-11-13: cryptophys-home is retired; 0055 keeps the row and disables it.
  assert.equal(homeRow.status, "disabled");
  assert.equal(homeRow.desired_version, null);
  const homeMeta = JSON.parse(homeRow.metadata_json);
  assert.equal(homeMeta.owner, "cryptophys-adm");
  assert.equal(homeMeta.purpose, "Read-only home portal and navigation (ADR-0008)");
  assert.equal(homeMeta.data_classification, "internal");
  assert.equal(homeMeta.source, "workers/home");

  assert.equal(REQUIRED_MIGRATION, "0029_knowledge_proposals.sql");
  const env = baseEnv("cryptophys-drift-detector", db);
  assert.equal(await schemaReady(env), true);
});

test("2. Probed and healthy: console is probed, healthy, drifted: false, desired_version_unset; retired home is disabled, never drift", async () => {
  const db = migratedDb();
  const env = driftTestEnv(db, {
    SVC_CONSOLE: healthy("aaaaaaaaaaaa"),
    SVC_FORGE: healthy("bbbbbbbbbbbb"),
  });
  const report = await observe(env, "test", "operator");
  const by = Object.fromEntries(report.services.map((s) => [s.service_id, s]));

  const c = by["cryptophys-console"];
  assert.ok(c);
  assert.equal(c.status, "healthy");
  assert.equal(c.drifted, false);
  assert.equal(c.managed, false);
  assert.ok(c.reasons.includes("desired_version_unset"));
  assert.equal(c.observed_version, "aaaaaaaaaaaa");

  const h = by["cryptophys-home"];
  assert.ok(h);
  assert.equal(h.status, "disabled");
  assert.equal(h.drifted, false);
  assert.deepEqual(h.reasons, ["disabled"]);
  assert.equal(h.observed_version, null);
  assert.equal(report.drifted, 0, "the retired Worker without a binding is not drift");
});

test("3. Managed: setting desired_version via registry makes console managed, drifted: false, status: healthy", async () => {
  const db = migratedDb();
  const regEnv = baseEnv("cryptophys-platform-registry", db);

  const resC = await call(registry, regEnv, req("PUT", "/v1/services/cryptophys-console/desired-version", {
    desired_version: "aaaaaaaaaaaa",
  }));
  assert.equal(resC.status, 200);

  const env = driftTestEnv(db, {
    SVC_CONSOLE: healthy("aaaaaaaaaaaa"),
    SVC_FORGE: healthy("bbbbbbbbbbbb"),
  });
  const report = await observe(env, "test", "operator");
  const by = Object.fromEntries(report.services.map((s) => [s.service_id, s]));

  const c = by["cryptophys-console"];
  assert.equal(c.managed, true);
  assert.equal(c.drifted, false);
  assert.equal(c.status, "healthy");
  assert.equal(c.desired_version, "aaaaaaaaaaaa");
  assert.equal(c.observed_version, "aaaaaaaaaaaa");
});

test("4. Real drift: version mismatch drifts console; a throwing binding makes console unavailable and drifted", async () => {
  const db = migratedDb();
  const regEnv = baseEnv("cryptophys-platform-registry", db);

  // Set desired versions
  await call(registry, regEnv, req("PUT", "/v1/services/cryptophys-console/desired-version", { desired_version: "aaaaaaaaaaaa" }));

  // Part 1: Version mismatch on console
  const mismatchEnv = driftTestEnv(db, {
    SVC_CONSOLE: healthy("cccccccccccc"), // different tag
    SVC_FORGE: healthy("bbbbbbbbbbbb"),
  });
  const report1 = await observe(mismatchEnv, "test", "operator");
  const by1 = Object.fromEntries(report1.services.map((s) => [s.service_id, s]));

  const c1 = by1["cryptophys-console"];
  assert.equal(c1.drifted, true);
  assert.ok(c1.reasons.includes("version_mismatch"));
  assert.equal(c1.status, "degraded");

  // Part 2: Unreachable console (throws)
  const throwingEnv = driftTestEnv(db, {
    SVC_CONSOLE: { health: async () => { throw new Error("unreachable"); } },
    SVC_FORGE: healthy("bbbbbbbbbbbb"),
  });
  const report2 = await observe(throwingEnv, "test", "operator");
  const by2 = Object.fromEntries(report2.services.map((s) => [s.service_id, s]));

  const c2 = by2["cryptophys-console"];
  assert.equal(c2.drifted, true);
  assert.equal(c2.status, "unavailable");
});

test("5. Binding missing: without SVC_CONSOLE in env, cryptophys-console reports no_observation_binding", async () => {
  const db = migratedDb();
  const env = driftTestEnv(db);
  delete (env as any).SVC_CONSOLE;

  const report = await observe(env, "test", "operator");
  const by = Object.fromEntries(report.services.map((s) => [s.service_id, s]));

  const c = by["cryptophys-console"];
  assert.ok(c);
  assert.equal(c.drifted, true);
  assert.equal(c.status, "unavailable");
  assert.equal(c.probe.error, "no_observation_binding");
  assert.ok(c.reasons.includes("no_observation_binding"));
});

test("6. No regressions: drift detector readiness and targets mapping cover all 9 platform targets", async () => {
  const db = migratedDb();
  const env = driftTestEnv(db);
  const targetMap = targets(env);

  // 9 since cryptophys-home was retired (2026-11-13): it has no binding and no target.
  assert.equal(Object.keys(targetMap).length, 9);
  assert.ok("cryptophys-console" in targetMap);
  assert.ok(!("cryptophys-home" in targetMap));
  assert.ok(targetMap["cryptophys-console"]);

  const ready = await call(drift, env, req("GET", "/ready"));
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, "ready");
  assert.equal(ready.body.checks.observation_bindings, true);

  const missingConsole = await call(drift, { ...env, SVC_CONSOLE: undefined }, req("GET", "/ready"));
  assert.equal(missingConsole.status, 503);
  assert.equal(missingConsole.body.checks.observation_bindings, false);
});

test("TP-027: after 0028 the cryptophys-aether row is registered and probed at /health over EXT_AETHER; a failing Aether drifts", async () => {
  const db = migratedDb();
  const row = db.raw.prepare("SELECT status, metadata_json FROM service_registry WHERE service_id = 'cryptophys-aether'").get() as { status: string; metadata_json: string };
  assert.equal(row.status, "registered");
  assert.equal(JSON.parse(row.metadata_json).health_path, "/health");
  assert.equal(targets(driftTestEnv(db) as never)["cryptophys-aether"], undefined, "Aether is an external target, not an RPC target");
  const ok: any = await observe(driftTestEnv(db), "test", "test");
  const aether = ok.services.find((s: any) => s.service_id === "cryptophys-aether");
  assert.equal(aether.drifted, false);
  assert.equal(aether.probe.healthy, true);
  const down: any = await observe(driftTestEnv(db, { EXT_AETHER: { fetch: async () => Response.json({ status: "degraded" }) } }), "test", "test");
  assert.equal(down.services.find((s: any) => s.service_id === "cryptophys-aether").drifted, true);
});

test("TP-027: the Drift Detector is not ready without its EXT_AETHER binding", async () => {
  const db = migratedDb();
  const env = driftTestEnv(db);
  assert.equal((await call(drift, env, req("GET", "/ready"))).body.status, "ready");
  assert.equal((await call(drift, { ...env, EXT_AETHER: undefined }, req("GET", "/ready"))).status, 503);
});

test("TP-042: after 0042 the xauusd-omega row is registered and probed at /health over EXT_XAUUSD_OMEGA; a failing Omega drifts", async () => {
  const db = migratedDb();
  const row = db.raw.prepare("SELECT status, metadata_json FROM service_registry WHERE service_id = 'xauusd-omega'").get() as { status: string; metadata_json: string };
  assert.equal(row.status, "registered");
  assert.equal(JSON.parse(row.metadata_json).health_path, "/health");
  assert.equal(targets(driftTestEnv(db) as never)["xauusd-omega"], undefined, "xauusd-omega is an external target, not an RPC target");
  const ok: any = await observe(driftTestEnv(db), "test", "test");
  const omega = ok.services.find((s: any) => s.service_id === "xauusd-omega");
  assert.equal(omega.drifted, false);
  assert.equal(omega.probe.healthy, true);
  const down: any = await observe(driftTestEnv(db, { EXT_XAUUSD_OMEGA: { fetch: async () => Response.json({ status: "degraded" }) } }), "test", "test");
  assert.equal(down.services.find((s: any) => s.service_id === "xauusd-omega").drifted, true);
});

test("TP-042: the Drift Detector is not ready without its EXT_XAUUSD_OMEGA binding", async () => {
  const db = migratedDb();
  const env = driftTestEnv(db);
  assert.equal((await call(drift, env, req("GET", "/ready"))).body.status, "ready");
  assert.equal((await call(drift, { ...env, EXT_XAUUSD_OMEGA: undefined }, req("GET", "/ready"))).status, 503);
});

