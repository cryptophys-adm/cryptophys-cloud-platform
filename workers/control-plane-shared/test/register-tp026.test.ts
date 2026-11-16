import { test } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, call, migratedDb, req } from "./harness.ts";
import { REQUIRED_MIGRATION, schemaReady } from "../src/readiness.ts";
import { isRetiredService } from "../src/retired.ts";
import registry from "../../platform-registry/src/index.ts";
import drift, { externalRpcTargets, externalTargets, observe, targets } from "../../drift-detector/src/index.ts";

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
    EXT_CRYPTOPHYS_CTA: { health: async () => ({ ok: true, service: "cryptophys-cta", publish: "off" }) },
    ...extra,
  } as any;
}

test("1. Migration: service_registry has 19 rows (15 + Aether from 0027 + Forge from 0030 + Omega from 0042 + cta from 0074), console registered, home kept but disabled (0055), schemaReady is true", async () => {
  const db = migratedDb();
  const rows = db.raw.prepare("SELECT * FROM service_registry ORDER BY service_id").all() as any[];
  assert.equal(rows.length, 19);
  const ctaRow = rows.find((r) => r.service_id === "cryptophys-cta");
  assert.deepEqual([ctaRow?.status, ctaRow?.environment, ctaRow?.endpoint, ctaRow?.desired_version, ctaRow?.observed_version], ["registered", "production", "https://cta.cryptophys.work", null, null]);

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
  // 0064 (owner 2026-11-14): retired for good; only the marker is added, every other key is kept.
  assert.equal(homeMeta.retired_by, "migration:0064");
  assert.equal(isRetiredService(homeRow), true);

  assert.equal(REQUIRED_MIGRATION, "0029_knowledge_proposals.sql");
  const env = baseEnv("cryptophys-drift-detector", db);
  assert.equal(await schemaReady(env), true);
});

test("2. Probed and healthy: console is probed, healthy, drifted: false, desired_version_unset; retired home is not observed", async () => {
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

  // Retired by 0064: not observed at all (no probe, no row, no heartbeat), while its registry row is kept.
  assert.equal(by["cryptophys-home"], undefined, "the retired Home is not in the run");
  const h = db.raw.prepare("SELECT status, observed_version, metadata_json, updated_at FROM service_registry WHERE service_id = 'cryptophys-home'").get() as any;
  assert.equal(h.status, "disabled");
  assert.equal(isRetiredService(h), true);
  assert.deepEqual([h.observed_version, h.updated_at], [null, "2026-11-14T12:00:00.000Z"], "no heartbeat for a retired service");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM drift_observations WHERE service_id = 'cryptophys-home'").get() as any).n, 0);
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


test("CTA: cryptophys-cta is probed over EXT_CRYPTOPHYS_CTA (CtaHealth.health()), health-managed; the binding is declared and needed for /ready", async () => {
  const { readFileSync } = await import("node:fs");
  const toml = readFileSync(new URL("../../drift-detector/wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /binding = "EXT_CRYPTOPHYS_CTA"\nservice = "cryptophys-cta"\nentrypoint = "CtaHealth"\n/);
  const db = migratedDb();
  const env = driftTestEnv(db);
  assert.equal(targets(env as never)["cryptophys-cta"], undefined, "cta is external, not a platform HealthRpc target");
  assert.equal(externalTargets(env as never)["cryptophys-cta"], undefined, "CtaHealth has no fetch handler: never probed over HTTP");
  assert.equal(externalRpcTargets(env as never)["cryptophys-cta"], env.EXT_CRYPTOPHYS_CTA);
  assert.equal((await call(drift, env, req("GET", "/ready"))).body.status, "ready");
  assert.equal((await call(drift, { ...env, EXT_CRYPTOPHYS_CTA: undefined }, req("GET", "/ready"))).status, 503);
  // Without a registry row (as before migration 0074): nothing is probed or recorded for it.
  let calls = 0;
  const counted = { health: async () => { calls++; return { ok: true, service: "cryptophys-cta" }; } };
  db.raw.prepare("DELETE FROM service_registry WHERE service_id = 'cryptophys-cta'").run();
  const before: any = await observe(driftTestEnv(db, { EXT_CRYPTOPHYS_CTA: counted }), "test", "test");
  assert.equal(before.services.some((s: any) => s.service_id === "cryptophys-cta"), false);
  assert.equal(calls, 0);
  // Once the registry row exists (0074, applied again here): healthy when health() answers ok for this service; anything else drifts.
  db.raw.exec(readFileSync(new URL("../../control-plane-migrations/0074_register_cta.sql", import.meta.url), "utf8"));
  const ok: any = await observe(driftTestEnv(db, { EXT_CRYPTOPHYS_CTA: counted }), "test", "test");
  const cta = ok.services.find((s: any) => s.service_id === "cryptophys-cta");
  assert.deepEqual([cta.drifted, cta.managed, cta.status, cta.probe.healthy, cta.probe.version_tag, calls], [false, false, "healthy", true, null, 1]);
  for (const [binding, error] of [
    [{ health: async () => ({ ok: false, service: "cryptophys-cta", error: "desk" }) }, "health_check_failed"],
    [{ health: async () => ({ ok: true, service: "cryptophys-aether" }) }, "health_check_failed"],
    [{ health: async () => ({ status: "ok" }) }, "health_check_failed"],
    [{ health: async () => { throw new Error("Worker has no entrypoint CtaHealth"); } }, "rpc_failed"],
  ] as const) {
    const down: any = await observe(driftTestEnv(db, { EXT_CRYPTOPHYS_CTA: binding }), "test", "test");
    const s = down.services.find((x: any) => x.service_id === "cryptophys-cta");
    assert.deepEqual([s.drifted, s.status, s.probe.error], [true, "unavailable", error]);
  }
});
