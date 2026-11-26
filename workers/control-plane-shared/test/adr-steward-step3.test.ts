// The ADR Steward, step 3 (docs/design/ADR-STEWARD.md §4, §11 row 3; owner 2026-11-16, "ya semua, sesuai
// rekomendasimu"): the agent. Its DNA gene and engine, registered by the census through consensus (ADR-0013 phase 3);
// the tier-0 capability adr.observe and its handler; the AdrStewardAgent Durable Object (wrangler migration v5); the
// additive D1 migration 0075 (adr_progress, adr_progress_history); the scheduled hook and the wake id; a full pass that
// writes one document per ADR, a pass that rewrites nothing when nothing changed, and the one-query tick. Plain fs
// reads relative to the repository root, so the Forge runner can bundle it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, fakeAi, migratedDb, registeredByConsensus, registeredDb, req, withoutConversation, lastReviewedRecord } from "./harness.ts";
import { appendAuditEvent } from "../src/audit.ts";
import { CAPABILITIES, verifySyscallDecision } from "../src/capabilities.ts";
import { KERNEL_AGENTS, castVote, privilegedCapabilities, type Evidence, type Proposal } from "../src/consensus-rules.ts";
import { ADR_PROGRESS_DIR, DEPLOY_UNITS, unitChanged, unitForService } from "../src/deploy-units.ts";
import { destructiveMigration, splitSqlStatements, unsupportedStatement } from "../src/migration-rules.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import { parseDna } from "../src/organism.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { censusTick, CENSUS_REFRESH_MS } from "../../forge/src/census.ts";
import { configRefusal } from "../../deployment-orchestrator/src/config-diff.ts";
import { topologyDiff } from "../../deployment-orchestrator/src/topology.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { runCycle } from "../../ai-kernel/src/supervisor.ts";
import { latestCensusRow, proposalFor } from "../../ai-kernel/src/organism.ts";
import { ADR_MANIFESTS, bundledReadFile, manifestQuotes, observeAdr } from "../../ai-kernel/src/adr-observe.ts";
import {
  ADR_STEWARD_ID, ADR_WATCHED_EVENTS, AdrStewardCycleQueue, DAILY_PASS_MINUTE_UTC, adrDocHash, applyObservation, draftAdrExplanationTask,
  runAdrStewardCycle, stewardState, templateSentence, watchedEventTypes, type AdrProgressDoc,
} from "../../ai-kernel/src/adr-steward.ts";
import type { ArtifactsReader, ArtifactsTreeEntry } from "../../forge/src/checks.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const list = (p: string) => readdirSync(new URL(p, ROOT)) as string[];
const DIRS = ["ai-kernel", "audit-ledger", "console", "deployment-orchestrator", "drift-detector", "forge", "forge-typecheck", "forge-typecheck-cr", "platform-api", "platform-registry", "policy-engine", "recovery-manager"];
const KERNEL = "cryptophys-ai-kernel";
const MAIN = "5".repeat(40);
const NOW = Date.UTC(2026, 10, 17, 12, 7, 0);
const MIN = 60_000;
const MANIFEST_FILES = list(ADR_PROGRESS_DIR).filter((f) => f.endsWith(".json")).sort();
const MIGRATION = "0075_adr_progress.sql";

function repoWith(files: Record<string, string>, head = MAIN): ArtifactsReader {
  const trees: Record<string, ArtifactsTreeEntry[]> = {}; const blobs: Record<string, string> = {}; let n = 1;
  const id = () => (n++).toString(16).padStart(40, "e");
  function build(f: Record<string, string>): string {
    const here: Record<string, Record<string, string>> = {}; const entries: ArtifactsTreeEntry[] = [];
    for (const [p, t] of Object.entries(f)) {
      const i = p.indexOf("/");
      if (i < 0) { const h = id(); blobs[h] = t; entries.push({ name: p, type: "blob", mode: "100644", hash: h }); }
      else (here[p.slice(0, i)] ??= {})[p.slice(i + 1)] = t;
    }
    for (const [d, sub] of Object.entries(here)) entries.push({ name: d, type: "tree", mode: "40000", hash: build(sub) });
    const h = id(); trees[h] = entries; return h;
  }
  const root = build(files);
  return {
    async readCommit(h) { return h === head ? { hash: h, treeHash: root } : null; },
    async readTree(h) { return trees[h] ?? null; },
    async readBlob(h) { return h in blobs ? new Blob([blobs[h]]) : null; },
    async log() { return [{ hash: head }]; },
  };
}
const realDna = () => Object.fromEntries(DIRS.map((d) => [`workers/${d}/organism.json`, read(`workers/${d}/organism.json`)]));

function memory() {
  const m = new Map<string, unknown>();
  return { m, async get<T>(k: string) { return m.get(k) as T | undefined; }, async put(k: string, v: unknown) { m.set(k, structuredClone(v)); } };
}

/** The kernel's env over a database, with the real Policy Engine, the Forge's canonical main and a Steward namespace. */
function kernelEnv(db: Db) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const stewardMem = memory();
  const supMem = memory();
  const env: Record<string, unknown> = {
    ...baseEnv(KERNEL, db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async (agentId: string, decisionId: string) => { await verifySyscallDecision(db, decisionId, agentId, "recovery.propose"); return { plan: {} }; } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    DEPLOY: { pendingDeploys: async () => ({ main_sha: null, ci_green: false, units: [], skipped: [] }) },
    CANONICAL_MAIN: { mainHead: async () => ({ main_sha: MAIN }) },
  };
  const cycles: string[] = [];
  env.ADR_STEWARD = {
    idFromName: (n: string) => n,
    get: (id: unknown) => {
      assert.equal(id, ADR_STEWARD_ID);
      return { cycle: (t: "scheduled" | "operator") => { cycles.push(t); return runAdrStewardCycle(env as never, stewardMem, t, NOW); }, status: async () => (await stewardMem.get("last_cycle")) ?? null };
    },
  };
  env.SUPERVISOR = { idFromName: (n: string) => n, get: () => ({ cycle: async () => ({ agent_id: "supervisor", trigger: "scheduled", cycle_at: new Date(NOW).toISOString(), findings: [], actions: [] }), status: async () => null }) };
  return { env, db, stewardMem, supMem, cycles };
}

/** Counts every statement a database prepares, by SQL text. */
function counting(db: Db) {
  const seen: string[] = [];
  const proxy = new Proxy(db, {
    get(target: any, prop: string | symbol) {
      if (prop === "prepare") return (sql: string) => { seen.push(sql); return target.prepare(sql); };
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { db: proxy as Db, seen };
}

const rows = (db: Db, sql: string, ...args: unknown[]) => db.raw.prepare(sql).all(...(args as never[])) as any[];
const events = (db: Db, type: string) => rows(db, "SELECT subject, outcome, payload_json FROM audit_events WHERE event_type = ? ORDER BY rowid", type);
const set = (db: Db, sql: string, ...args: unknown[]) => db.raw.prepare(sql).run(...(args as never[]));

// ================================================================ the DNA, the capability and the census

test("AS1. the DNA declares the ADR Steward and its engine: tier_max 1, adr.observe and reports.publish, no seat", () => {
  const dna = parseDna(read("workers/ai-kernel/organism.json"));
  const gene = dna.agents.find((a) => a.id === ADR_STEWARD_ID)!;
  assert.deepEqual([gene.display_name, [...gene.capabilities].sort(), gene.tier_max, gene.voter], ["ADR Steward", ["adr.observe", "reports.publish"], 1, false]);
  assert.ok(dna.engines.some((e) => e.task === "draft_adr_explanation"));
  // adr.observe is new, tier 0 and routine; nothing privileged is granted (no consensus.propose, nothing at tier 2).
  assert.equal(CAPABILITIES["adr.observe"].tier, 0);
  assert.equal(CAPABILITIES["platform.observe"].description, "Read drift, recovery plans, agent state and the 24 h report summary", "platform.observe is not widened");
  assert.deepEqual(privilegedCapabilities(gene.capabilities), []);
  assert.ok(!gene.capabilities.includes("consensus.propose") && !gene.capabilities.some((c) => c.startsWith("memory.")));
  assert.ok(KERNEL_AGENTS.has(ADR_STEWARD_ID), "a kernel agent: consensus never suspends or retires it");
  // The guard paths this step touches: the DNA, the capability catalog and the kernel-agent list.
  for (const p of ["workers/ai-kernel/organism.json", "workers/control-plane-shared/src/capabilities.ts"]) assert.equal(criticalPathReason(p), "evolution_guard", p);
  assert.equal(criticalPathReason("workers/control-plane-shared/src/consensus-rules.ts"), "consensus_kill_switch");
  for (const p of ["workers/ai-kernel/src/adr-steward.ts", "workers/ai-kernel/src/adr-observe.ts", `workers/control-plane-migrations/${MIGRATION}`]) assert.equal(criticalPathReason(p), null, p);
});

test("AS2. the census finds the gene and the engine, and consensus registers both: routine, every seat approves", async () => {
  const db = migratedDb();
  const { env } = kernelEnv(db);
  set(db, "UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'");
  // The evolver (declared since 2026-11-17, a privileged registration with the owner's click) is registered here, so the
  // census shows only the Steward's gene and engine (evolver-v5-2026-11-17 covers the evolver's own registration).
  registeredByConsensus(db);
  set(db, "DELETE FROM agents WHERE agent_id = 'adr-steward'");
  set(db, "DELETE FROM engines WHERE task = 'draft_adr_explanation'");
  await censusTick(db as never, repoWith(realDna()), NOW);
  const census = (await latestCensusRow({ DB: db } as never))!;
  assert.deepEqual(census.findings.map((f) => `${f.kind} ${f.subject}`), ["unregistered_agent adr-steward", `unregistered_engine ${KERNEL}:draft_adr_explanation`]);
  const organ = census.genome.find((o) => o.service === KERNEL)!;
  assert.ok(organ.agents.some((a) => a.id === ADR_STEWARD_ID) && organ.engines.includes("draft_adr_explanation"));
  // The proposal the Supervisor builds is register_agent (not privileged), and every seat approves it.
  const p = proposalFor(census, census.findings[0])!;
  assert.deepEqual([p.action, p.target, p.params.service, [...(p.params.capabilities as string[])].sort(), p.params.tier_max], ["register_agent", ADR_STEWARD_ID, KERNEL, ["adr.observe", "reports.publish"], 1]);
  const reg = rows(db, "SELECT service_id, status, desired_version FROM service_registry");
  const ag = rows(db, "SELECT agent_id, status, host_worker, voter FROM agents");
  const e: Evidence = {
    agents_enabled: true, audit_valid: true, services: {}, critical_reports_24h: 0, executing_plan_targets: [], recent_same: 0,
    registry: Object.fromEntries(reg.map((r) => [r.service_id, { status: r.status, desired_version: r.desired_version }])),
    agents: Object.fromEntries(ag.map((a) => [a.agent_id, { status: a.status, host_worker: a.host_worker, voter: a.voter === 1 }])),
  };
  for (const voter of ag.filter((a) => a.voter === 1).map((a) => a.agent_id)) assert.equal(castVote(voter, { ...p, class: "routine" } as Proposal, e).vote, "approve", voter);

  // End to end, as for any new gene (organism-registration-0013 R4): the Supervisor proposes, the council passes it,
  // the executor writes the row from the census; then the engine.
  const mem = memory();
  await runCycle(env as never, mem, "scheduled", NOW);
  const last = () => rows(db, "SELECT * FROM consensus_proposals ORDER BY created_at DESC, rowid DESC LIMIT 1")[0];
  assert.deepEqual([last().action, last().target, last().status], ["register_agent", ADR_STEWARD_ID, "executed"], last().outcome_json);
  const row = rows(db, "SELECT * FROM agents WHERE agent_id = ?", ADR_STEWARD_ID)[0];
  assert.deepEqual([row.host_worker, row.tier_max, row.voter, row.status, [...JSON.parse(row.capabilities_json)].sort()], [KERNEL, 1, 0, "enabled", ["adr.observe", "reports.publish"]]);
  await runCycle(env as never, mem, "scheduled", NOW);
  assert.deepEqual([last().action, last().status], ["register_engine", "executed"], last().outcome_json);
  assert.equal(rows(db, "SELECT status FROM engines WHERE service_id = ? AND task = 'draft_adr_explanation'", KERNEL)[0].status, "enabled");
  // The census of the same head, retaken: consistent.
  const r = await censusTick(db as never, repoWith(realDna()), NOW + CENSUS_REFRESH_MS + 1);
  assert.deepEqual([r.outcome, r.status], ["refreshed", "consistent"]);
});

test("AS3. adr.observe is enforced: tier 0, denied without the grant or the registration, not persisted", async () => {
  const unregistered = migratedDb();
  const denied = await syscall(kernelEnv(unregistered).env as never, ADR_STEWARD_ID, "adr.observe", { now: NOW });
  assert.equal(denied.outcome, "denied");
  assert.match((denied as { reason: string }).reason, /agent_registered/);

  const db = registeredDb();
  const { env } = kernelEnv(db);
  // Another kernel agent does not hold it.
  const other = await syscall(env as never, "supervisor", "adr.observe", { now: NOW });
  assert.deepEqual([other.outcome, other.tier], ["denied", 0]);
  assert.match((other as { reason: string }).reason, /capability_granted/);
  // The Steward does; suspended, it does not; with the kill switch off, nobody does.
  const ok = await syscall(env as never, ADR_STEWARD_ID, "adr.observe", { now: NOW });
  assert.deepEqual([ok.outcome, ok.tier, ok.decision_id], ["succeeded", 0, null]);
  const result = (ok as unknown as { result: { schema: string; evaluations: unknown[]; manifests: { adr: string; sha256: string }[] } }).result;
  assert.equal(result.schema, "adr.observe.v1");
  assert.equal(result.evaluations.length, MANIFEST_FILES.length);
  assert.ok(result.manifests.every((m) => /^[0-9a-f]{64}$/.test(m.sha256)));
  set(db, "UPDATE agents SET status = 'suspended' WHERE agent_id = ?", ADR_STEWARD_ID);
  assert.match(((await syscall(env as never, ADR_STEWARD_ID, "adr.observe", {})) as { reason: string }).reason, /agent_enabled/);
  set(db, "UPDATE agents SET status = 'enabled' WHERE agent_id = ?", ADR_STEWARD_ID);
  set(db, "UPDATE kernel_controls SET value = '0' WHERE control = 'agents_enabled'");
  assert.match(((await syscall(env as never, ADR_STEWARD_ID, "adr.observe", {})) as { reason: string }).reason, /agents_enabled/);
  // Tier 0 is not persisted and needs no Policy Engine decision.
  assert.equal(rows(db, "SELECT COUNT(*) AS n FROM agent_actions WHERE capability = 'adr.observe'")[0].n, 0);
  // The caller names ADR ids only; a predicate or a manifest in the input is ignored.
  set(db, "UPDATE kernel_controls SET value = '1' WHERE control = 'agents_enabled'");
  const one = await observeAdr({ DB: db }, { now: NOW, adrs: ["0012", "x; DROP TABLE agents"], manifests: [{ adr: "0012", phases: [] }] } as never);
  assert.deepEqual((one.evaluations as { adr: string }[]).map((e) => e.adr), ["0012"]);
  assert.ok((one.evaluations as { phases: unknown[] }[])[0].phases.length > 20, "the bundled 0012 manifest, not the caller's");
});

// ================================================================ the kernel bundle, the deploy unit, the Durable Object

test("AS4. the kernel bundles exactly the manifests of the directory, and a change to one redeploys the Control Plane", () => {
  const src = read("workers/ai-kernel/src/adr-observe.ts");
  const imported = [...src.matchAll(/^import m(\d{4}) from "\.\.\/\.\.\/\.\.\/architecture\/adr\/progress\/(\d{4})\.json" with \{ type: "json" \};$/gm)].map((m) => { assert.equal(m[1], m[2]); return `${m[2]}.json`; });
  assert.deepEqual(imported, MANIFEST_FILES, "one import per manifest file (the DNA-consistency pattern of ADR-0013)");
  assert.deepEqual(ADR_MANIFESTS.map((m) => m.file), MANIFEST_FILES.map((f) => ADR_PROGRESS_DIR + f));
  for (const m of ADR_MANIFESTS) assert.deepEqual(m.manifest, JSON.parse(read(m.file)), m.file);
  // A manifest change redeploys the unit that hosts the kernel, and nothing else.
  assert.equal(ADR_PROGRESS_DIR, "architecture/adr/progress/");
  assert.deepEqual(DEPLOY_UNITS.filter((u) => unitChanged(u, [`${ADR_PROGRESS_DIR}0012.json`])).map((u) => u.unit), [unitForService(KERNEL)!.unit]);
  // The document predicates read the bundled vision and the quotes the manifests anchor (proven in their files by AP5).
  assert.deepEqual(JSON.parse(bundledReadFile("organism/vision.json")!), JSON.parse(read("organism/vision.json")));
  for (const [path, quotes] of manifestQuotes()) {
    const text = read(path);
    for (const q of quotes) { assert.ok(text.includes(q), `${path}: ${q}`); assert.ok(bundledReadFile(path)!.includes(q)); }
  }
  assert.equal(bundledReadFile("docs/not-a-file.md"), null);
  // No Text module rule: the native deploy would refuse a changed build rule (config-diff.ts build_rules_changed).
  assert.doesNotMatch(read("workers/ai-kernel/wrangler.toml"), /\[\[rules\]\]/);
});

test("AS5. AdrStewardAgent: bound, its DO migration v5 is additive and planned natively, the scheduled hook and the wake id", async () => {
  const full = read("workers/ai-kernel/wrangler.toml");
  const tags = [...full.matchAll(/\[\[migrations\]\]\ntag = "(v\d+)"\nnew_sqlite_classes = \["([A-Za-z]+)"\]/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(tags, ["v1:SupervisorAgent", "v2:SignalAnalystAgent", "v3:AuditorAgent", "v4:AlertVault", "v5:AdrStewardAgent", "v6:EvolverAgent", "v7:ConversationAgent", "v8:CouncilAgent", "v9:ConsoleHub"]);
  // The config as this step left it: before the evolver's binding and migration v6 (2026-11-17, evolver-v5 E1) and the
  // chat's v7 (HAIC H1b).
  const toml = withoutConversation(full).replace(/\n# The evolver[^\n]*\n\[\[durable_objects\.bindings\]\]\nname = "EVOLVER"\nclass_name = "EvolverAgent"\n/, "\n")
    .replace(/\n\[\[migrations\]\]\ntag = "v6"\nnew_sqlite_classes = \["EvolverAgent"\]\n/, "\n");
  assert.notEqual(toml, full);
  assert.match(toml, /\[\[durable_objects\.bindings\]\]\nname = "ADR_STEWARD"\nclass_name = "AdrStewardAgent"/);
  assert.match(read("workers/ai-kernel/src/worker.ts"), /export class AdrStewardAgent extends DurableObject<Env>/);
  // Against the config before this step, the native deploy plans an additive migration v4 -> v5 (gate 4 part B).
  const running = toml.replace(/\n# ADR Steward[^\n]*\n\[\[durable_objects\.bindings\]\]\nname = "ADR_STEWARD"\nclass_name = "AdrStewardAgent"\n/, "\n")
    .replace(/\n\[\[migrations\]\]\ntag = "v5"\nnew_sqlite_classes = \["AdrStewardAgent"\]\n/, "\n");
  assert.notEqual(running, toml);
  assert.equal(configRefusal(running, toml, { topology: true }), null);
  const d = topologyDiff(running, toml, KERNEL);
  assert.ok("diff" in d, JSON.stringify(d));
  assert.deepEqual([d.diff.migration?.from, d.diff.migration?.to, d.diff.destructive], ["v4", "v5", []]);
  assert.deepEqual(d.diff.migration?.steps, [{ new_sqlite_classes: ["AdrStewardAgent"] }]);

  // The scheduled handler wakes the Steward on every tick; an operator wakes it through the existing route.
  const { env, cycles } = kernelEnv(registeredDb());
  for (const minute of [7, 22, 37, 52]) {
    const waited: Promise<unknown>[] = [];
    await kernel.scheduled({ scheduledTime: Date.UTC(2026, 10, 17, 12, minute), cron: "7,22,37,52 * * * *" }, env as never, { waitUntil: (p: Promise<unknown>) => { waited.push(p); } });
    await Promise.all(waited);
  }
  assert.deepEqual(cycles, ["scheduled", "scheduled", "scheduled", "scheduled"]);
  const woke = await call(kernel, env, req("POST", "/v1/agents/adr-steward/wake", {}, OPERATOR_JWT));
  assert.deepEqual([woke.status, woke.body.agent_id, woke.body.trigger], [200, ADR_STEWARD_ID, "operator"]);
  const status = await call(kernel, env, req("GET", "/v1/agents/adr-steward", undefined, OPERATOR_JWT));
  assert.deepEqual([status.status, status.body.last_cycle.trigger], [200, "operator"]);
  assert.equal((await call(kernel, env, req("POST", "/v1/agents/not-an-agent/wake", {}, OPERATOR_JWT))).status, 404);
  // The Console's Wake button lists it (organism-dna-0013 O6).
  assert.match(read("workers/console/ui/src/pages/AgentDetail.tsx"), /const KERNEL_AGENTS = \[[^\]]*"adr-steward"/);
});

test("AS6. migration 0075 is additive: the next number, two CREATE TABLE IF NOT EXISTS, never destructive, applies twice", () => {
  const files = list("workers/control-plane-migrations/").filter((f) => f.endsWith(".sql")).sort();
  // The newest migration when it merged (0076_evolution.sql followed it on 2026-11-17): the next free number then.
  const at = files.indexOf(MIGRATION);
  assert.ok(at > 0, "the migration exists");
  assert.equal(Number(MIGRATION.slice(0, 4)), Number(files[at - 1].slice(0, 4)) + 1, "the next free number");
  assert.ok(files.slice(at + 1).every((f) => Number(f.slice(0, 4)) > Number(MIGRATION.slice(0, 4))), "only later migrations follow it");
  const sql = read(`workers/control-plane-migrations/${MIGRATION}`);
  const statements = splitSqlStatements(sql);
  assert.deepEqual(statements.map((s) => /CREATE TABLE IF NOT EXISTS (\w+)/.exec(s)?.[1] ?? s.slice(0, 40)), ["adr_progress", "adr_progress_history"]);
  assert.equal(destructiveMigration(sql), false, "the native deploy applies it as routine (no owner click)");
  assert.equal(unsupportedStatement(statements), null, "it runs as one D1 batch");
  const db = migratedDb();
  const schema = () => rows(db, "SELECT name, sql FROM sqlite_master ORDER BY name");
  const before = schema();
  db.raw.exec(sql);
  assert.deepEqual(schema(), before, "applied again, nothing changes");
  assert.ok(rows(db, "SELECT name FROM d1_migrations WHERE name = ?", MIGRATION).length === 1);
  // The constraints hold: a bad id, status or body is refused.
  const ins = (id: string, status: string, body: string) => () => set(db, `INSERT INTO adr_progress (adr_id, revision, lifecycle, status, phases_total, phases_proven, phases_asserted, percent, percent_proven,
    manifest_sha256, body_sha256, body_json, explanation_json, changed_at) VALUES (?, 1, 'accepted', ?, 0, 0, 0, 0, 0, 'm', 'b', ?, NULL, 't')`, id, status, body);
  assert.throws(ins("12", "done", "{}"), /CHECK/);
  assert.throws(ins("0012", "invalid", "{}"), /CHECK/);
  assert.throws(ins("0012", "done", "not json"), /CHECK/);
  assert.throws(ins("0012", "done", JSON.stringify({ x: "y".repeat(33_000) })), /CHECK/);
  ins("0012", "done", "{}")();
});

// ================================================================ the cycle

/** A database with the Steward registered by consensus and the census and its proposals left out. */
function stewardDb() {
  const db = registeredDb();
  const { env, stewardMem } = kernelEnv(db);
  const cycle = (t: "scheduled" | "operator", at = NOW, e: unknown = env) => runAdrStewardCycle(e as never, stewardMem, t, at);
  return { db, env, mem: stewardMem, cycle };
}
const docs = (db: Db) => rows(db, "SELECT * FROM adr_progress ORDER BY adr_id");
const history = (db: Db) => rows(db, "SELECT adr_id, revision, status, percent FROM adr_progress_history ORDER BY adr_id, revision");
/** The cycle's summary finding (the last one; a failed write or an unreadable store adds its own before it). */
const passOf = (r: { findings: Record<string, unknown>[] }) => r.findings.filter((f) => f.kind === "adr").at(-1) as Record<string, any>;

test("AS7. a full pass writes one document per ADR, with its history row, its audit event and the deterministic sentence, in English", async () => {
  const { db, cycle } = stewardDb();
  const r = await cycle("scheduled");
  const pass = passOf(r);
  assert.deepEqual(pass.reasons.slice(0, 2), ["first_pass", "new_deploy"]);
  assert.equal(pass.action, "written");
  assert.deepEqual(pass.written, MANIFEST_FILES.map((f) => f.slice(0, 4)));
  const all = docs(db);
  assert.equal(all.length, MANIFEST_FILES.length);
  assert.deepEqual(history(db).map((h) => `${h.adr_id}:${h.revision}`), all.map((d) => `${d.adr_id}:1`));
  const changed = events(db, "adr.status_changed");
  assert.deepEqual(changed.map((e) => e.subject), all.map((d) => `adr:${d.adr_id}`));
  for (const row of all) {
    const body = JSON.parse(row.body_json) as AdrProgressDoc;
    assert.equal(body.schema, "adr.progress-doc.v1");
    assert.deepEqual([row.revision, row.lifecycle, row.status, row.phases_total, row.phases_proven, row.phases_asserted, row.percent, row.percent_proven],
      [1, body.lifecycle, body.status, body.phases_total, body.phases_proven, body.phases_asserted, body.percent, body.percent_proven], row.adr_id);
    assert.equal(row.body_sha256, await adrDocHash(body));
    assert.ok(row.body_json.length <= 32_768, `${row.adr_id}: ${row.body_json.length} bytes`);
    assert.equal(body.deployed_commit, "abc1234def56");
    const expl = JSON.parse(row.explanation_json);
    assert.deepEqual([expl.source, expl.rujukan], ["template", []]);
    assert.equal(expl.teks, templateSentence(body));
    assert.ok(expl.teks.startsWith(row.adr_id) && expl.teks.length <= 400);
    const ev = JSON.parse(changed.find((e) => e.subject === `adr:${row.adr_id}`)!.payload_json);
    assert.deepEqual([ev.revision, ev.from, ev.to, ev.body_sha256], [1, null, row.status, row.body_sha256]);
  }
  // The planned ADR-0019 has no phases; the held ADR-0018 says so.
  const byId = Object.fromEntries(all.map((d) => [d.adr_id, d]));
  assert.equal(JSON.parse(byId["0019"].explanation_json).teks, "0019 (planned): no phases measured yet.");
  assert.match(JSON.parse(byId["0018"].explanation_json).teks, /^0018 \(held\): \d+ of \d+ phases complete/);
  // On an empty platform nothing is proven but the migrations and the registrations; the documents assert the rest.
  const s12 = JSON.parse(byId["0012"].explanation_json).teks;
  assert.match(s12, /^0012: \d+ of 26 phases complete \(\d+ proven, \d+ asserted by document\)\. Open: /);
  // ADR-0016 T1 reads adr_index_live: the Steward is now registered and every ADR has its row.
  const t1 = await observeAdr({ DB: db }, { now: NOW, adrs: ["0016"] });
  const leaf = (t1.evaluations as any[])[0].phases.find((p: any) => p.id === "T1");
  assert.equal(leaf.state, "not_measurable_yet", "T1's self-model half is still not measurable");
  assert.doesNotMatch(String(leaf.reason), /adr_progress has/, "the index half holds");
  // The Steward wrote only its own tables, the audit chain and, since step 7, its drift report (G4B's document is ahead
  // of an empty platform) through the policy-gated reports.publish syscall, which records policy.decision and agent.action.
  const kinds = rows(db, "SELECT DISTINCT event_type FROM audit_events WHERE actor = ?", `agent:${ADR_STEWARD_ID}`).map((e) => e.event_type).sort();
  assert.ok(kinds.every((k) => k.startsWith("adr.") || k === "agent.action" || k === "policy.decision"), kinds.join(", "));
  assert.deepEqual(rows(db, "SELECT DISTINCT capability FROM agent_actions WHERE agent_id = ?", ADR_STEWARD_ID).map((r) => r.capability), ["reports.publish"]);
});

test("AS8. nothing changed, nothing is written; a change rewrites only its ADR, with one history row", async () => {
  const { db, cycle, mem } = stewardDb();
  await cycle("scheduled");
  // The second pass rewrites ADR-0016 once: T1's adr_index_live half reads the rows the first pass wrote, so its
  // reason no longer names the missing index (T1 stays not measurable: the self-model does not exist yet).
  const second = passOf(await cycle("operator", NOW + MIN / 2));
  assert.deepEqual(second.written, ["0016"]);
  const t1 = (JSON.parse(docs(db).find((d) => d.adr_id === "0016")!.body_json) as AdrProgressDoc).phases.find((p) => p.id === "T1")!;
  assert.equal(t1.state, "not_measurable_yet");
  assert.doesNotMatch(String(t1.reason), /adr_progress has/);
  const before = { docs: docs(db), history: history(db).length, events: rows(db, "SELECT COUNT(*) AS n FROM audit_events")[0].n };
  // An operator wake runs a full pass: every hash matches, so no row, history row or audit event is added.
  const again = passOf(await cycle("operator", NOW + MIN));
  assert.deepEqual([again.action, again.written, again.unchanged], ["unchanged", [], MANIFEST_FILES.length]);
  assert.deepEqual(docs(db), before.docs);
  assert.equal(history(db).length, before.history);
  assert.equal(rows(db, "SELECT COUNT(*) AS n FROM audit_events")[0].n, before.events);
  // A newer event that proves an already proven phase changes refs only: still nothing is written.
  await appendAuditEvent(db, { event_type: "agent.registered", actor: "test", subject: "agent:x", outcome: "enabled", payload: {} });
  const sameState = passOf(await cycle("scheduled", NOW + 15 * MIN));
  assert.deepEqual([sameState.reasons, sameState.written], [["events"], []]);
  // A watched gate event: ADR-0012 S3 (forge.git_backup_written) is proven; only 0012 is rewritten, at revision 2.
  await appendAuditEvent(db, { event_type: "forge.git_backup_written", actor: "forge", subject: "git-backup", outcome: "written", payload: {} });
  const r = passOf(await cycle("scheduled", NOW + 30 * MIN));
  assert.deepEqual([r.reasons, r.written], [["events"], ["0012"]]);
  const row = docs(db).find((d) => d.adr_id === "0012")!;
  const old = before.docs.find((d) => d.adr_id === "0012")!;
  assert.equal(row.revision, 2);
  assert.equal(row.phases_proven, old.phases_proven + 1);
  assert.deepEqual(history(db).filter((h) => h.adr_id === "0012").map((h) => h.revision), [1, 2]);
  assert.equal(history(db).length, before.history + 1);
  const ev = events(db, "adr.status_changed").filter((e) => e.subject === "adr:0012").map((e) => JSON.parse(e.payload_json));
  assert.deepEqual([ev.length, ev[1].revision, ev[1].phases], [2, 2, ["S3"]]);
  for (const d of docs(db)) if (d.adr_id !== "0012") assert.deepEqual(d, before.docs.find((x) => x.adr_id === d.adr_id), d.adr_id);
  // The state lives in the Durable Object, never in D1.
  const st = await stewardState(mem);
  assert.equal(st.last_pass_at, new Date(NOW + 30 * MIN).toISOString());
  assert.equal(st.version_id, "ver-self");
});

test("AS9. the cheap tick: with nothing due, one audit query (plus the agent and kill-switch checks), no write", async () => {
  const { db, env, cycle } = stewardDb();
  await cycle("scheduled");
  const c = counting(db);
  const quiet = await cycle("scheduled", NOW + 15 * MIN, { ...env, DB: c.db });
  assert.deepEqual(passOf(quiet), { kind: "adr", action: "none", why: "nothing due" });
  assert.equal(c.seen.length, 3, c.seen.join("\n"));
  const tick = c.seen.filter((s) => /FROM audit_events/.test(s));
  assert.equal(tick.length, 1);
  assert.ok(!c.seen.some((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s)));
  // The tick query walks idx_audit_events_type_created, with fewer bound values than D1's limit of 100.
  const types = watchedEventTypes();
  assert.ok(types.length + 1 < 100);
  const plan = rows(db, `EXPLAIN QUERY PLAN ${tick[0]}`, ...types, "").map((r) => r.detail).join(" | ");
  assert.match(plan, /idx_audit_events_type_created/, plan);
  assert.doesNotMatch(plan, /SCAN audit_events(?! USING)/, plan);
  // The watched list is §4.3's fixed set plus what the manifests' audit_event and quiet_window predicates name.
  for (const t of ADR_WATCHED_EVENTS) assert.ok(types.includes(t), t);
  for (const t of ["forge.git_backup_written", "forge.bundles_stored", "deployment.dispatched"]) assert.ok(types.includes(t), t);
  assert.ok(!types.some((t) => t.startsWith("adr.")), "the Steward's own events never wake it");
  // An unwatched event wakes nothing; a watched one, a new deploy, the daily pass and an operator do.
  await appendAuditEvent(db, { event_type: "agent.action", actor: "agent:supervisor", subject: "platform.observe", outcome: "succeeded", payload: {} });
  assert.equal(passOf(await cycle("scheduled", NOW + 30 * MIN)).why, "nothing due");
  assert.deepEqual(passOf(await cycle("scheduled", NOW + 45 * MIN, { ...env, CF_VERSION_METADATA: { id: "ver-next", tag: "fedcba987654" } })).reasons, ["new_deploy"]);
  const tomorrow = Date.UTC(2026, 10, 18, 2, 52);
  assert.equal(new Date(tomorrow).getUTCHours() * 60 + new Date(tomorrow).getUTCMinutes(), DAILY_PASS_MINUTE_UTC);
  assert.equal(passOf(await cycle("scheduled", tomorrow - 15 * MIN, { ...env, CF_VERSION_METADATA: { id: "ver-next", tag: "fedcba987654" } })).why, "nothing due");
  assert.deepEqual(passOf(await cycle("scheduled", tomorrow, { ...env, CF_VERSION_METADATA: { id: "ver-next", tag: "fedcba987654" } })).reasons, ["daily"]);
});

test("AS10. a source that cannot be read keeps the stored state and marks the document stale; the kill switch stops every cycle", async () => {
  const { db, env, cycle, mem } = stewardDb();
  await cycle("scheduled");
  await cycle("operator", NOW + MIN / 2);
  // G6 reads only forge_change_requests (forge_work_cr_merged).
  const g6 = () => (JSON.parse(docs(db).find((d) => d.adr_id === "0012")!.body_json) as AdrProgressDoc).phases.find((p) => p.id === "G6")!;
  const stored = g6();
  const broken = new Proxy(db, {
    get(target: any, prop: string | symbol) {
      if (prop === "prepare") return (sql: string) => { if (/FROM forge_change_requests/.test(sql)) throw new Error("D1_ERROR: overloaded"); return target.prepare(sql); };
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const r = passOf(await cycle("operator", NOW + MIN * 3 / 4, { ...env, DB: broken }));
  assert.ok(r.written.includes("0012"), "the document is now stale");
  const doc = JSON.parse(docs(db).find((d) => d.adr_id === "0012")!.body_json) as AdrProgressDoc;
  assert.deepEqual([doc.stale, doc.stale_sources], [true, ["forge_change_requests"]]);
  assert.deepEqual([g6().state, g6().reason, g6().refs, g6().kept], [stored.state, stored.reason, stored.refs, true], "never reopened or changed by a database hiccup");
  assert.equal(stored.kept, undefined);
  assert.match(JSON.parse(docs(db).find((d) => d.adr_id === "0012")!.explanation_json).teks, /Stale data: forge_change_requests unreadable\.$/);
  // Readable again: the document is fresh, and the phase is computed as before.
  const fresh = passOf(await cycle("operator", NOW + MIN));
  assert.ok(fresh.written.includes("0012"));
  assert.deepEqual([g6().state, g6().kept, (JSON.parse(docs(db).find((d) => d.adr_id === "0012")!.body_json) as AdrProgressDoc).stale], [stored.state, undefined, false]);
  // The kill switch off, or the agent suspended: no pass, no write.
  const n = history(db).length;
  set(db, "UPDATE kernel_controls SET value = '0' WHERE control = 'agents_enabled'");
  assert.equal((await cycle("operator", NOW + 2 * MIN)).skipped, "agents_disabled");
  set(db, "UPDATE kernel_controls SET value = '1' WHERE control = 'agents_enabled'");
  set(db, "UPDATE agents SET status = 'suspended' WHERE agent_id = ?", ADR_STEWARD_ID);
  assert.equal((await cycle("operator", NOW + 3 * MIN)).skipped, "agent_suspended");
  assert.equal(history(db).length, n);
  assert.equal((await runAdrStewardCycle(kernelEnv(migratedDb()).env as never, mem, "operator", NOW)).skipped, "agent_not_registered");
  // §4.9: without the adr_progress table nothing is written, and the pass is tried again an hour later, not every tick.
  const bare = registeredDb();
  bare.raw.exec("DROP TABLE adr_progress");
  const b = kernelEnv(bare);
  const firstReport = await runAdrStewardCycle(b.env as never, b.stewardMem, "scheduled", NOW);
  const first = passOf(firstReport);
  assert.equal(first.written.length, 0);
  assert.equal(first.failed.length, MANIFEST_FILES.length);
  assert.match(String(firstReport.findings.find((f) => f.action === "store_unavailable")?.why), /no such table: adr_progress/);
  const st = await stewardState(b.stewardMem);
  assert.equal(st.retry_at, new Date(NOW + 60 * MIN).toISOString());
  assert.equal(passOf(await runAdrStewardCycle(b.env as never, b.stewardMem, "scheduled", NOW + 15 * MIN)).why, "nothing due");
  assert.deepEqual(passOf(await runAdrStewardCycle(b.env as never, b.stewardMem, "scheduled", NOW + 60 * MIN)).reasons, ["retry"]);
});

test("AS11. a drift episode opens and closes as audit events; an invalid manifest is audited once per hash and never computed", async () => {
  const { db, cycle } = stewardDb();
  await cycle("scheduled");
  const opened = () => events(db, "adr.drift_detected").map((e) => `${e.subject} ${JSON.parse(e.payload_json).phase} ${e.outcome}`);
  // ADR-0012 G4B: since 2026-11-17 the document says part B ran live (doc_claim "done"); an empty platform has no such
  // deploy, so the document is ahead of the evidence. Nothing a document lags behind is proven on an empty platform.
  assert.deepEqual(opened(), ["adr:0012 G4B doc_ahead"]);
  const det = JSON.parse(events(db, "adr.drift_detected")[0].payload_json);
  assert.deepEqual([det.doc_ref, det.doc_state, det.computed_state], ["docs/GITHUB-CUTOVER.md", "done", "open"]);
  const body = JSON.parse(docs(db).find((d) => d.adr_id === "0012")!.body_json) as AdrProgressDoc;
  assert.deepEqual(body.drift.map((d) => `${d.phase}:${d.kind}`), ["G4B:doc_ahead"]);
  // The same drift on the next pass is not audited again.
  await cycle("operator", NOW + MIN / 2);
  assert.equal(opened().length, 1);
  // A native deploy that planned a topology change proves G4B: the document and the evidence agree, and
  // adr.drift_resolved is audited once.
  set(db, `INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
    VALUES ('dep_g4b', 'cryptophys-console', ?, 'test', 'succeeded', NULL, 'idem_g4b', ?, ?, ?)`, "a".repeat(40),
    JSON.stringify({ executor: "native:deploy", outcome: { steps: ["cryptophys-ai-kernel:topology_planned"] } }), new Date(NOW).toISOString(), new Date(NOW).toISOString());
  await cycle("operator", NOW + MIN);
  const res = events(db, "adr.drift_resolved");
  assert.deepEqual(res.map((e) => [e.subject, JSON.parse(e.payload_json).phase, JSON.parse(e.payload_json).computed_state]), [["adr:0012", "G4B", "proven"]]);
  assert.ok(JSON.parse(res[0].payload_json).refs.some((r: string) => r.startsWith("ev:platform/deployment/dep_g4b")));
  await cycle("operator", NOW + 2 * MIN);
  assert.equal(events(db, "adr.drift_resolved").length, 1);
  assert.equal(JSON.parse(docs(db).find((d) => d.adr_id === "0012")!.body_json).drift.length, 0);
  // The drift reports (agent_reports, adr_drift.v1) are step 7's: test/adr-drift-step7.test.ts.
  // An invalid manifest (a kind the evaluator refuses) is never computed: one adr.manifest_invalid per manifest hash,
  // not repeated on the next pass, and its stored row is left as it was.
  const bad = { ...JSON.parse(read(`${ADR_PROGRESS_DIR}0001.json`)), phases: [{ id: "B1", title: "bad", evidence: { kind: "sql", query: "SELECT 1" } }] };
  const observe = async () => (await observeAdr({ DB: db }, { now: NOW }, ADR_MANIFESTS.map((m) => (m.adr === "0001" ? { ...m, manifest: bad } : m)))) as never;
  const row0001 = docs(db).find((d) => d.adr_id === "0001");
  const state = await stewardState(memory());
  const first = await applyObservation({ DB: db }, state, await observe(), new Date(NOW + MIN).toISOString());
  assert.deepEqual([first.pass.invalid, first.pass.written], [["0001"], []]);
  await applyObservation({ DB: db }, state, await observe(), new Date(NOW + 2 * MIN).toISOString());
  const inv = events(db, "adr.manifest_invalid");
  assert.equal(inv.length, 1, "once per manifest hash");
  assert.equal(inv[0].subject, "adr:0001");
  assert.ok(JSON.parse(inv[0].payload_json).problems.some((p: string) => /phases\[0\]\.evidence\.kind/.test(p)));
  assert.deepEqual(docs(db).find((d) => d.adr_id === "0001"), row0001);
  // Fixed, the manifest is computed again and its next invalid version would be reported again.
  await applyObservation({ DB: db }, state, (await observeAdr({ DB: db }, { now: NOW })) as never, new Date(NOW + 3 * MIN).toISOString());
  assert.equal(state.invalid["0001"], undefined);
});

test("AS12. the AI task is declared for the DNA's engine; its validator rejects invented numbers and refs (step 6 runs it, adr-explanation-step6)", () => {
  const task = draftAdrExplanationTask({ status: "in_progress", refs: ["ev:platform/audit/evt_1"], text: '{"phases_complete":18,"phases_total":26}' });
  assert.equal(task.name, "draft_adr_explanation");
  assert.deepEqual(task.validate({ teks: "18 of 26 phases complete.", rujukan: ["ev:platform/audit/evt_1"] }), { teks: "18 of 26 phases complete.", rujukan: ["ev:platform/audit/evt_1"] });
  assert.equal(task.validate({ teks: "19 of 26 phases complete.", rujukan: ["ev:platform/audit/evt_1"] }), null, "a number not in the input");
  assert.equal(task.validate({ teks: "18 of 26 phases.", rujukan: ["ev:platform/audit/evt_9"] }), null, "a ref not in the input");
  assert.equal(task.validate({ teks: "This ADR is done.", rujukan: ["ev:platform/audit/evt_1"] }), null, "done while in progress");
  assert.ok(task.validate({ teks: "This ADR is not done yet.", rujukan: ["ev:platform/audit/evt_1"] }));
  assert.equal(task.validate({ teks: "This ADR is not done.", rujukan: [] }), null, "step 6: a draft must cite the stored document's evidence");
  assert.equal(task.validate({ teks: "x".repeat(401), rujukan: ["ev:platform/audit/evt_1"] }), null);
  // Step 6: the Steward's one AI call is the explanation of a status change, inside explainStatusChange.
  const src = read("workers/ai-kernel/src/adr-steward.ts");
  assert.equal(src.match(/engineFor\(/g)?.length, 1);
  const fn = src.slice(src.indexOf("async function explainStatusChange("), src.indexOf("// ------", src.indexOf("async function explainStatusChange(")));
  assert.match(fn, /engineFor\(env, SERVICE, \[task\.name\]\)\.run\(task, built\.input,/);
});

test("AS13. the queue serializes cycles; docs/SSOT.md and the design record step 3", async () => {
  const q = new AdrStewardCycleQueue();
  let active = 0; let max = 0;
  await Promise.all([1, 2, 3].map(() => q.run(async () => { active++; max = Math.max(max, active); await Promise.resolve(); active--; })));
  assert.equal(max, 1);
  const ssot = read("docs/SSOT.md");
  assert.match(lastReviewedRecord(), /(?:^Last reviewed: |\); )2026-11-16 \([^\n]*ADR Steward step 3, the agent: [^()]*`adr_progress`[^()]*; ADR Steward step 2: /);
  assert.match(ssot, /\| `cryptophys-ai-kernel` \| [^|]*ADR Steward/);
  assert.match(ssot, /0075/);
  assert.match(read("docs/design/ADR-STEWARD.md"), /\| 3 \| The agent: [^\n]*\*\*Built 2026-11-17\*\*/);
});

test("AS14. a stored deterministic sentence in an older wording is refreshed in place, with no new revision or history row (2026-11-17, all in English)", async () => {
  const { db, cycle } = stewardDb();
  await cycle("scheduled");
  await cycle("operator", NOW + MIN / 2);
  const old = JSON.stringify({ schema: "adr.explanation.v1", source: "template", teks: "0012: 18 dari 26 fase selesai.", rujukan: [] });
  db.raw.prepare("UPDATE adr_progress SET explanation_json = ? WHERE adr_id = '0012'").run(old);
  const ai = JSON.stringify({ schema: "adr.explanation.v1", source: "ai", teks: "kept as written", rujukan: ["ev:platform/x/y"] });
  db.raw.prepare("UPDATE adr_progress SET explanation_json = ? WHERE adr_id = '0013'").run(ai);
  const before = { docs: docs(db), history: history(db).length };
  const p = passOf(await cycle("operator", NOW + MIN));
  assert.deepEqual(p.written, [], "no document is rewritten");
  const after = docs(db);
  const e12 = JSON.parse(after.find((d) => d.adr_id === "0012")!.explanation_json);
  assert.equal(e12.source, "template");
  assert.notEqual(e12.teks, "0012: 18 dari 26 fase selesai.");
  assert.match(e12.teks, /^0012: \d+ of \d+ phases complete/);
  assert.equal(after.find((d) => d.adr_id === "0012")!.revision, before.docs.find((d) => d.adr_id === "0012")!.revision, "same revision");
  assert.equal(history(db).length, before.history, "no history row");
  assert.equal(after.find((d) => d.adr_id === "0013")!.explanation_json, ai, "an AI explanation is never replaced by the sentence");
});
