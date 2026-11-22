// Owner 2026-11-15 ("Aksi retire_engine"): the mirror of register_engine. An enabled engine whose organ's DNA no
// longer declares the task (census finding undeclared_engine) is proposed by the Supervisor once the finding has
// persisted (2 consecutive census rows, or 1 h), never for an organ whose origin's DNA was not read; routine
// consensus retires it (status 'retired', nothing deleted, audited engine.retired); a DNA that declares the task
// again re-registers it through register_engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, fakeAi, migratedDb, registeredDb } from "./harness.ts";
import { verifySyscallDecision } from "../src/capabilities.ts";
import { castVote, classify, type Evidence, type Proposal } from "../src/consensus-rules.ts";
import { EXTERNAL_CEILING, EXTERNAL_ORIGINS } from "../src/organism.ts";
import { describeAction } from "../src/plain.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { censusTick, CENSUS_REFRESH_MS, type ExternalDnaReader } from "../../forge/src/census.ts";
import { runCycle } from "../../ai-kernel/src/supervisor.ts";
import { PHASE2_EXECUTABLE } from "../../ai-kernel/src/consensus.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import {
  latestCensusRow, latestCensusRows, proposalFor, undeclaredEnginePersistent, undeclaredEngineProven, RETIRE_ENGINE_PERSIST_MS, type CensusRow,
} from "../../ai-kernel/src/organism.ts";
import type { ArtifactsReader, ArtifactsTreeEntry } from "../../forge/src/checks.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const DIRS = ["ai-kernel", "audit-ledger", "console", "deployment-orchestrator", "drift-detector", "forge", "forge-typecheck", "forge-typecheck-cr", "platform-api", "platform-registry", "policy-engine", "recovery-manager"];
const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const FORGE = "cryptophys-forge";
const GHOST = `${FORGE}:ghost_task`;
const XAUUSD = EXTERNAL_ORIGINS.find((o) => o.origin === "xauusd")!;
const AI = "xauusd-ai-trading-assistant";
const HOUR = 3_600_000;

function repoWith(files: Record<string, string>, head: string): ArtifactsReader {
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
/** The real DNA, with the Forge declaring these engines. */
function forgeDna(engines: string[]) {
  const files = realDna();
  const forge = JSON.parse(files["workers/forge/organism.json"]);
  forge.engines = engines.map((task) => ({ task }));
  files["workers/forge/organism.json"] = JSON.stringify(forge);
  return files;
}

const organ = (service: string, agents: unknown[] = [], engines: string[] = []) => ({
  $schema_version: 1, service, display_name: service, kind: "service", deploy_unit: null, access: false, rollback: false,
  drift: { via: "rpc", binding: "EXT_XAUUSD_AI" }, agents, engines: engines.map((task) => ({ task })),
});
/** The XAUUSD DNA as served: its registered agents, and these engines on the AI Worker (nexus-teacher, 0086: corrections.record only). */
function xauusdDna(db: Db, engines: string[] = []) {
  const live = (db.raw.prepare("SELECT agent_id FROM agents WHERE host_worker = ? ORDER BY agent_id").all(AI) as Array<{ agent_id: string }>)
    .map((r) => ({ id: r.agent_id, display_name: r.agent_id, capabilities: r.agent_id === "nexus-teacher" ? ["corrections.record"] : [...EXTERNAL_CEILING.capabilities], tier_max: 1, voter: false }));
  return { schema: XAUUSD.schema, organs: [organ(AI, live, engines), ...XAUUSD.services.filter((s) => s !== AI).map((s) => organ(s))] };
}
const xauusdRead = (db: Db): ExternalDnaReader[] => [{ origin: XAUUSD, dna: async () => xauusdDna(db) }];
const xauusdUnread: ExternalDnaReader[] = [{ origin: XAUUSD, dna: () => Promise.reject(new Error("no such entrypoint")) }];

function kernelEnv(db: Db) {
  const canonical = { head: A as string };
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const mem = new Map<string, unknown>();
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async (agentId: string, decisionId: string) => { await verifySyscallDecision(db, decisionId, agentId, "recovery.propose"); return { plan: {} }; } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    DEPLOY: { pendingDeploys: async () => ({ main_sha: null, ci_green: false, units: [], skipped: [] }) },
    CANONICAL_MAIN: { mainHead: async () => ({ main_sha: canonical.head }) },
  };
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, structuredClone(v)); } };
  return { env, memory, canonical };
}

/** A database in mode deploy with an enabled engine the DNA does not declare (cryptophys-forge:ghost_task). */
function setup(extra: Array<[string, string]> = [[FORGE, "ghost_task"]]) {
  const db = registeredDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  for (const [service, task] of extra) {
    db.raw.prepare("INSERT INTO engines (service_id, task, status, registered_by, created_at, updated_at) VALUES (?, ?, 'enabled', 'consensus:old', '2026-11-10T00:00:00.000Z', '2026-11-10T00:00:00.000Z')").run(service, task);
  }
  return { db, ...kernelEnv(db) };
}
const engine = (db: Db, service: string, task: string) => db.raw.prepare("SELECT status, registered_by, created_at, updated_at FROM engines WHERE service_id = ? AND task = ?").get(service, task) as any;
const proposalsOf = (db: Db, action: string) => db.raw.prepare("SELECT * FROM consensus_proposals WHERE action = ? ORDER BY rowid").all(action) as any[];
const findingsOf = async (db: Db) => (await latestCensusRow({ DB: db } as never))!.findings.map((f) => `${f.kind} ${f.subject}`);

test("E1. retire_engine is the routine mirror of register_engine: catalog, phase 2 executor, plain text, votes", () => {
  assert.equal(classify("retire_engine"), "routine");
  assert.equal(classify("retire_engine"), classify("register_engine"));
  assert.ok(PHASE2_EXECUTABLE.has("retire_engine"));
  assert.match(describeAction("retire_engine", FORGE), /^retire an AI engine/);
  const e: Evidence = {
    agents_enabled: true, audit_valid: true, services: {}, critical_reports_24h: 0, executing_plan_targets: [], recent_same: 0, agents: {},
    registry: { [FORGE]: { status: "registered", desired_version: null }, "cryptophys-home": { status: "disabled", desired_version: null } },
  };
  const vote = (target: string, params: Record<string, unknown>) => castVote("supervisor", { action: "retire_engine", target, params, class: "routine" } as Proposal, e);
  assert.equal(vote(FORGE, { task: "ghost_task" }).vote, "approve");
  assert.match(vote(FORGE, { task: "Bad Task" }).reason, /lowercase/);
  assert.match(vote("cryptophys-home", { task: "ghost_task" }).reason, /not an active registered service/);
});

test("E2. a finding over 2 consecutive census rows is proposed, executed (status retired, audited), and leaves the census", async () => {
  const { db, env, memory, canonical } = setup();
  db.raw.prepare("INSERT OR IGNORE INTO ai_usage (service_id, day, requests, failures) VALUES (?, '2026-11-11', 7, 0)").run(FORGE);
  const usageBefore = db.raw.prepare("SELECT COUNT(*) AS n FROM ai_usage").get() as any;
  const t0 = Date.now();
  await censusTick(db as never, repoWith(realDna(), A), t0 - 10 * 60_000);
  await censusTick(db as never, repoWith(realDna(), B), t0 - 5 * 60_000);
  canonical.head = B;
  assert.deepEqual(await findingsOf(db), [`undeclared_engine ${GHOST}`]);
  assert.equal((await latestCensusRows({ DB: db } as never, 2)).length, 2);

  await runCycle(env as never, memory, "scheduled", t0);
  const [p] = proposalsOf(db, "retire_engine");
  assert.ok(p, "proposed");
  assert.equal(p.target, FORGE);
  assert.equal(p.class, "routine");
  assert.deepEqual(JSON.parse(p.params_json), { task: "ghost_task", main_sha: B });
  assert.equal(p.status, "executed", p.outcome_json);
  const row = engine(db, FORGE, "ghost_task");
  assert.equal(row.status, "retired");
  assert.equal(row.registered_by, `consensus:${p.proposal_id}`);
  assert.equal(row.created_at, "2026-11-10T00:00:00.000Z", "the row stays; nothing is deleted");
  const audit = db.raw.prepare("SELECT actor, outcome, payload_json FROM audit_events WHERE event_type = 'engine.retired' AND subject = ?").all(GHOST) as any[];
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor, `consensus:${p.proposal_id}`);
  assert.equal(JSON.parse(audit[0].payload_json).proposal_id, p.proposal_id);
  assert.deepEqual(db.raw.prepare("SELECT COUNT(*) AS n FROM ai_usage").get(), usageBefore, "ai_usage history stays");

  // The census of the same head, retaken: the retired engine is no finding any more.
  const r = await censusTick(db as never, repoWith(realDna(), B), t0 + CENSUS_REFRESH_MS + 1);
  assert.equal(r.outcome, "refreshed");
  assert.equal(r.status, "consistent");
  assert.deepEqual(await findingsOf(db), []);

  // Idempotent: proposing it again changes nothing (no finding any more), and nothing more is audited.
  const again = await syscall(env as never, "supervisor", "consensus.propose", { action: "retire_engine", target: FORGE, params: { task: "ghost_task", main_sha: B } });
  assert.equal(again.outcome, "succeeded");
  assert.notEqual(proposalsOf(db, "retire_engine").at(-1).status, "executed");
  assert.equal(engine(db, FORGE, "ghost_task").status, "retired");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'engine.retired'").get() as any).n, 1);
});

test("E3. a fresh finding (one census row, under 1 h) is not proposed; after 1 h seen without a gap it is", async () => {
  const { db, env, memory } = setup();
  const t0 = Date.now();
  await censusTick(db as never, repoWith(realDna(), A), t0);
  await runCycle(env as never, memory, "scheduled", t0);
  assert.equal(proposalsOf(db, "retire_engine").length, 0, "a single fresh census row proves nothing yet");
  await runCycle(env as never, memory, "scheduled", t0 + 30 * 60_000);
  assert.equal(proposalsOf(db, "retire_engine").length, 0, "30 min is not 1 h");
  // The head's row is retaken in place (still one row): only the hour the Supervisor saw it counts.
  await censusTick(db as never, repoWith(realDna(), A), t0 + CENSUS_REFRESH_MS + 1);
  assert.equal((await latestCensusRows({ DB: db } as never, 2)).length, 1);
  await runCycle(env as never, memory, "scheduled", t0 + RETIRE_ENGINE_PERSIST_MS);
  const [p] = proposalsOf(db, "retire_engine");
  assert.ok(p, "proposed after 1 h");
  assert.equal(p.status, "executed", p.outcome_json);
  assert.equal(engine(db, FORGE, "ghost_task").status, "retired");
});

test("E4. a gap restarts the hour: a finding that left the census is fresh when it returns", async () => {
  const { db, env, memory } = setup();
  const t0 = Date.now();
  await censusTick(db as never, repoWith(realDna(), A), t0);
  await runCycle(env as never, memory, "scheduled", t0);
  // The DNA declares the task again for a while (a change in flight), then drops it again.
  await censusTick(db as never, repoWith(forgeDna(["ghost_task"]), A), t0 + CENSUS_REFRESH_MS + 1);
  await runCycle(env as never, memory, "scheduled", t0 + 40 * 60_000);
  await censusTick(db as never, repoWith(realDna(), A), t0 + 2 * CENSUS_REFRESH_MS + 2);
  await runCycle(env as never, memory, "scheduled", t0 + 70 * 60_000);
  assert.equal(proposalsOf(db, "retire_engine").length, 0, "seen again only 0 min ago");
  await runCycle(env as never, memory, "scheduled", t0 + 70 * 60_000 + RETIRE_ENGINE_PERSIST_MS);
  assert.equal(proposalsOf(db, "retire_engine").length, 1);
});

test("E5. never for an organ whose origin's DNA was not read: absence there proves nothing", async () => {
  const { db, env, memory, canonical } = setup([[AI, "old_task"]]);
  const t0 = Date.now();
  // Read, then unread: the finding is not in 2 consecutive rows, and the unread row has none for the origin.
  await censusTick(db as never, repoWith(realDna(), A), t0 - 3 * HOUR, xauusdRead(db));
  await censusTick(db as never, repoWith(realDna(), B), t0 - 2 * HOUR, xauusdUnread);
  canonical.head = B;
  assert.deepEqual(await findingsOf(db), ["external_dna_unavailable xauusd"]);
  await runCycle(env as never, memory, "scheduled", t0 - 2 * HOUR);
  await runCycle(env as never, memory, "scheduled", t0);
  assert.equal(proposalsOf(db, "retire_engine").length, 0);
  assert.equal(engine(db, AI, "old_task").status, "enabled");

  // A tampered census naming the finding next to the unread origin is refused by the proposal rule and the executor.
  const row = (await latestCensusRow({ DB: db } as never))!;
  const tampered: CensusRow = { ...row, findings: [...row.findings, { kind: "undeclared_engine", subject: `${AI}:old_task`, detail: "x" }] };
  assert.equal(undeclaredEngineProven(tampered, `${AI}:old_task`), null);
  assert.equal(proposalFor(tampered, { kind: "undeclared_engine", subject: `${AI}:old_task` }, () => true), null);
  db.raw.prepare("UPDATE forge_organism_census SET findings = ? WHERE main_sha = ?").run(JSON.stringify(tampered.findings), B);
  const r = await syscall(env as never, "supervisor", "consensus.propose", { action: "retire_engine", target: AI, params: { task: "old_task", main_sha: B } });
  assert.equal(r.outcome, "succeeded");
  const p = proposalsOf(db, "retire_engine").at(-1);
  assert.equal(p.status, "failed");
  assert.match(p.outcome_json, /organ_dna_unread/);
  assert.equal(engine(db, AI, "old_task").status, "enabled");
});

test("E6. an external organ whose DNA was read retires like main's (the action's name is no trading action)", async () => {
  const { db, env, memory, canonical } = setup([[AI, "old_task"]]);
  const t0 = Date.now();
  await censusTick(db as never, repoWith(realDna(), A), t0 - 10 * 60_000, xauusdRead(db));
  await censusTick(db as never, repoWith(realDna(), B), t0 - 5 * 60_000, xauusdRead(db));
  canonical.head = B;
  assert.deepEqual(await findingsOf(db), [`undeclared_engine ${AI}:old_task`]);
  await runCycle(env as never, memory, "scheduled", t0);
  const [p] = proposalsOf(db, "retire_engine");
  assert.equal(p?.status, "executed", p?.outcome_json);
  assert.equal(engine(db, AI, "old_task").status, "retired");
  assert.equal(JSON.parse((db.raw.prepare("SELECT payload_json FROM audit_events WHERE event_type = 'engine.retired'").get() as any).payload_json).origin, "xauusd");
});

test("E7. re-registering a retired task re-enables the same row through register_engine", async () => {
  const { db, env, memory, canonical } = setup();
  const t0 = Date.now();
  await censusTick(db as never, repoWith(realDna(), A), t0 - 10 * 60_000);
  await censusTick(db as never, repoWith(realDna(), B), t0 - 5 * 60_000);
  canonical.head = B;
  await runCycle(env as never, memory, "scheduled", t0);
  assert.equal(engine(db, FORGE, "ghost_task").status, "retired");

  // A later head declares the task again: the census asks for it, and register_engine takes the retired row back.
  await censusTick(db as never, repoWith(forgeDna(["ghost_task"]), C), t0 + 60_000);
  canonical.head = C;
  assert.deepEqual(await findingsOf(db), [`unregistered_engine ${GHOST}`]);
  await runCycle(env as never, memory, "scheduled", t0 + 60_000);
  const [reg] = proposalsOf(db, "register_engine");
  assert.equal(reg?.status, "executed", reg?.outcome_json);
  const row = engine(db, FORGE, "ghost_task");
  assert.equal(row.status, "enabled");
  assert.equal(row.registered_by, `consensus:${reg.proposal_id}`);
  assert.equal(row.created_at, "2026-11-10T00:00:00.000Z", "the same row, re-enabled");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM engines WHERE service_id = ? AND task = 'ghost_task'").get(FORGE) as any).n, 1);
  const r = await censusTick(db as never, repoWith(forgeDna(["ghost_task"]), C), t0 + 60_000 + CENSUS_REFRESH_MS + 1);
  assert.equal(r.status, "consistent");
});

test("E8. an engine still declared is never retired, even on a tampered census", async () => {
  const { db, env, memory } = setup([]);
  const t0 = Date.now();
  await censusTick(db as never, repoWith(realDna(), A), t0 - 2 * HOUR);
  await runCycle(env as never, memory, "scheduled", t0 - 2 * HOUR);
  await censusTick(db as never, repoWith(realDna(), A), t0);
  await runCycle(env as never, memory, "scheduled", t0);
  assert.equal(proposalsOf(db, "retire_engine").length, 0, "a consistent census proposes nothing");

  // A finding that names a declared engine: unproven for the proposal rule, refused by the executor.
  const subject = "cryptophys-platform-registry:suggest_tags";
  db.raw.prepare("UPDATE forge_organism_census SET status = 'changes', findings = ? WHERE main_sha = ?")
    .run(JSON.stringify([{ kind: "undeclared_engine", subject, detail: "tampered" }]), A);
  const census = (await latestCensusRow({ DB: db } as never))!;
  assert.equal(undeclaredEngineProven(census, subject), null);
  assert.equal(undeclaredEnginePersistent([census, census], subject, t0 - 5 * HOUR, t0), false);
  assert.equal(proposalFor(census, { kind: "undeclared_engine", subject }, () => true), null);
  await runCycle(env as never, memory, "scheduled", t0 + 2 * HOUR);
  assert.equal(proposalsOf(db, "retire_engine").length, 0);
  const r = await syscall(env as never, "supervisor", "consensus.propose", { action: "retire_engine", target: "cryptophys-platform-registry", params: { task: "suggest_tags", main_sha: A } });
  assert.equal(r.outcome, "succeeded");
  const p = proposalsOf(db, "retire_engine").at(-1);
  assert.equal(p.status, "failed");
  assert.match(p.outcome_json, /engine_still_declared/);
  assert.equal(engine(db, "cryptophys-platform-registry", "suggest_tags").status, "enabled");
  // And one that no census row names at all.
  db.raw.prepare("UPDATE forge_organism_census SET findings = '[]' WHERE main_sha = ?").run(A);
  await syscall(env as never, "supervisor", "consensus.propose", { action: "retire_engine", target: "cryptophys-ai-kernel", params: { task: "draft_audit_digest", main_sha: A } });
  assert.match(proposalsOf(db, "retire_engine").at(-1).outcome_json, /census_finding_missing/);
  assert.equal(engine(db, "cryptophys-ai-kernel", "draft_audit_digest").status, "enabled");
});

test("E9. limits mirror register_engine: one proposal a cycle, registrations first, a Worker's second task waits the hour", async () => {
  const { db, env, memory, canonical } = setup([[FORGE, "ghost_task"], [FORGE, "other_task"]]);
  const t0 = Date.now();
  // The DNA also grows a new engine on another Worker: its registration goes first.
  const files = realDna();
  const reg = JSON.parse(files["workers/platform-registry/organism.json"]);
  reg.engines = [...reg.engines, { task: "explain_registry" }];
  files["workers/platform-registry/organism.json"] = JSON.stringify(reg);
  await censusTick(db as never, repoWith(files, A), t0 - 10 * 60_000);
  await censusTick(db as never, repoWith(files, B), t0 - 5 * 60_000);
  canonical.head = B;
  await runCycle(env as never, memory, "scheduled", t0);
  assert.deepEqual(db.raw.prepare("SELECT action FROM consensus_proposals ORDER BY rowid").all().map((r: any) => r.action), ["register_engine"]);
  await runCycle(env as never, memory, "scheduled", t0);
  await runCycle(env as never, memory, "scheduled", t0);
  const retired = () => proposalsOf(db, "retire_engine").map((r) => `${JSON.parse(r.params_json).task} ${r.status}`);
  assert.equal(retired().length, 1, "the Worker's second task waits for the hour instead of being vetoed");
  assert.match(retired()[0], / executed$/);
  // The Policy Engine reads the real clock: make the first retirement an hour old.
  db.raw.prepare("UPDATE consensus_proposals SET created_at = ?, decided_at = ? WHERE action = 'retire_engine'")
    .run(new Date(t0 - 61 * 60_000).toISOString(), new Date(t0 - 61 * 60_000).toISOString());
  await runCycle(env as never, memory, "scheduled", t0 + 61 * 60_000);
  assert.equal(retired().length, 2);
  assert.ok(retired().every((r) => r.endsWith(" executed")), retired().join("; "));
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM consensus_proposals WHERE status = 'shadow_blocked'").get() as any).n, 0);
});
