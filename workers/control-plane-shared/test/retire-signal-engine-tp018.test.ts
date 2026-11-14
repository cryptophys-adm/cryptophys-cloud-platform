import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { baseEnv, migratedDb } from "./harness.ts";
import { schemaReady, REQUIRED_MIGRATION } from "../src/readiness.ts";
import { CAPABILITIES } from "../src/capabilities.ts";
import { observe } from "../../ai-kernel/src/syscall.ts";
import { observe as observeDrift } from "../../drift-detector/src/index.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("TP-018 migration", async () => {
  const db = migratedDb();
  const reg = db.raw.prepare("SELECT status FROM service_registry WHERE service_id='cryptophys-signal-engine'").get() as any;
  assert.equal(reg.status, "disabled");
  // 0020 suspended the agent; 0047 (owner 2026-11-11: "hapus yang sudah suspended") deleted it.
  const agent = db.raw.prepare("SELECT status FROM agents WHERE agent_id='signal-engine'").get() as any;
  assert.equal(agent, undefined);
  const sup = db.raw.prepare("SELECT capabilities_json, tier_max FROM agents WHERE agent_id='supervisor'").get() as any;
  assert.equal(sup.tier_max, 1);
  const caps = JSON.parse(sup.capabilities_json);
  assert.deepEqual(caps, caps.filter((c: string) => c !== "signals.reingest"));
  assert.ok(!caps.includes("signals.reingest"));
  // Migration 0020 never dropped or rewrote the crypto history tables; they were kept until the owner decided
  // (2026-11-14) to archive them to R2 and drop them, which 0062 does after the archive was verified.
  const m0020 = readFileSync(resolve(repoRoot, "workers/control-plane-migrations/0020_retire_signal_engine.sql"), "utf8");
  assert.doesNotMatch(m0020.replace(/--.*$/gm, ""), /\bDROP\b|market_candles|signal_ingest_runs/);
  for (const name of ["market_candles", "signal_indicators", "signal_confluence", "signal_ingest_runs", "macro_context"]) {
    assert.equal(db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name), undefined, name);
  }
});

test("TP-018 catalog", async () => {
  assert.equal(CAPABILITIES["signals.reingest"], undefined);
});

test("TP-018 observe", async () => {
  const db = migratedDb();
  const env: any = baseEnv("cryptophys-ai-kernel", db);
  const r: any = await observe(env, Date.now());
  assert.ok(!("ingest_runs" in r));
  assert.ok(Array.isArray(r.services));
  assert.ok(Array.isArray(r.open_agent_plans));
  assert.ok(typeof r.agents_enabled !== "undefined");
  assert.ok(r.agent_reports_24h);
});

test("TP-018 supervisor", async () => {
  assert.equal(CAPABILITIES["signals.reingest"], undefined);
});

test("TP-018 readiness", async () => {
  const db = migratedDb();
  assert.equal(REQUIRED_MIGRATION, "0029_knowledge_proposals.sql");
  assert.equal(await schemaReady({ DB: db } as any), true);
});

test("TP-018 disabled service is recorded without probing or drift", async () => {
  const db = migratedDb();
  let signalEngineProbes = 0;
  const env: any = baseEnv("cryptophys-drift-detector", db, {
    SVC_SIGNAL_ENGINE: {
      health: async () => {
        signalEngineProbes++;
        return { status: "ok", version: { id: "v", tag: "aaaaaaaaaaaa" } };
      },
    },
  });
  const report = await observeDrift(env, "manual", "test");
  const signal = report.services.find((s) => s.service_id === "cryptophys-signal-engine");
  assert.ok(signal);
  assert.deepEqual([signal.drifted, signal.reasons, signal.status], [false, ["disabled"], "disabled"]);
  assert.equal(signal.probe.error, null);
  assert.equal(signalEngineProbes, 0);
});

test("TP-018 bindings", async () => {
  const workers = resolve(repoRoot, "workers");
  assert.equal(existsSync(resolve(workers, "signal-engine")), false);
  const files: string[] = [];
  function walk(dir: string) {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = resolve(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name === "wrangler.toml") files.push(p);
    }
  }
  walk(workers);
  for (const f of files) {
    const txt = readFileSync(f, "utf8");
    assert.equal(txt.includes("cryptophys-signal-engine"), false, f);
  }
});
