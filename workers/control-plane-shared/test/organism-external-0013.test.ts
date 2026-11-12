// Owner 2026-11-12: "DNA untuk XAUUSD dan Omega dengan auto-register". The XAUUSD repository serves its organs'
// DNA over RPC (xauusd-ai-trading-assistant OrganismDna, binding EXT_ORGANISM_XAUUSD); the Forge's census reads it
// next to main's, within the external-organ ceiling; the Supervisor proposes what is new; consensus registers it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, fakeAi, migratedDb } from "./harness.ts";
import { verifySyscallDecision } from "../src/capabilities.ts";
import { castVote, type Evidence, type Proposal } from "../src/consensus-rules.ts";
import { EXTERNAL_CEILING, EXTERNAL_ORIGINS, externalCeilingViolations, externalOrgans } from "../src/organism.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { addExternalOrgans, censusTick, CENSUS_REFRESH_MS, type ExternalDnaReader } from "../../forge/src/census.ts";
import { externalReaders } from "../../forge/src/tick.ts";
import { runCycle } from "../../ai-kernel/src/supervisor.ts";
import { latestCensusRow } from "../../ai-kernel/src/organism.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import type { ArtifactsReader, ArtifactsTreeEntry } from "../../forge/src/checks.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const DIRS = ["ai-kernel", "audit-ledger", "console", "deployment-orchestrator", "drift-detector", "forge", "forge-typecheck", "forge-typecheck-cr", "home", "platform-api", "platform-registry", "policy-engine", "recovery-manager"];
const MAIN = "c".repeat(40);
const XAUUSD = EXTERNAL_ORIGINS.find((o) => o.origin === "xauusd")!;
const CAPS = [...EXTERNAL_CEILING.capabilities];
const AI = "xauusd-ai-trading-assistant";

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

const organ = (service: string, agents: unknown[] = [], engines: string[] = []) => ({
  $schema_version: 1, service, display_name: service, kind: "service", deploy_unit: null, access: false, rollback: false,
  drift: { via: "rpc", binding: "EXT_XAUUSD_AI" }, agents, engines: engines.map((task) => ({ task })),
});
const agent = (id: string, capabilities = CAPS, extra: Record<string, unknown> = {}) => ({ id, display_name: id, capabilities, tier_max: 1, voter: false, ...extra });

/** The XAUUSD DNA as served: the 13 agents registered today, plus what the test grows. */
function xauusdDna(db: Db, grow: { agents?: unknown[]; engines?: string[] } = {}) {
  const grown = new Set((grow.agents ?? []).map((a) => (a as { id: string }).id));
  const live = (db.raw.prepare("SELECT agent_id FROM agents WHERE host_worker = ? ORDER BY agent_id").all(AI) as Array<{ agent_id: string }>)
    .filter((r) => !grown.has(r.agent_id)).map((r) => agent(r.agent_id));
  return {
    schema: XAUUSD.schema,
    organs: [
      organ(AI, [...live, ...(grow.agents ?? [])], grow.engines ?? []),
      ...XAUUSD.services.filter((s) => s !== AI).map((s) => organ(s)),
    ],
  };
}
const reader = (dna: () => unknown): ExternalDnaReader[] => [{ origin: XAUUSD, dna: async () => dna() }];

function kernelEnv(db: Db) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const mem = new Map<string, unknown>();
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async (agentId: string, decisionId: string) => { await verifySyscallDecision(db, decisionId, agentId, "recovery.propose"); return { plan: {} }; } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    DEPLOY: { pendingDeploys: async () => ({ main_sha: null, ci_green: false, units: [], skipped: [] }) },
    CANONICAL_MAIN: { mainHead: async () => ({ main_sha: MAIN }) },
  };
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, structuredClone(v)); } };
  return { env, memory };
}
const setMode = (db: Db, mode: string) => db.raw.prepare("UPDATE consensus_controls SET value = ? WHERE control = 'mode'").run(mode);
const last = (db: Db) => db.raw.prepare("SELECT * FROM consensus_proposals ORDER BY created_at DESC, rowid DESC LIMIT 1").get() as any;

test("X1. the external ceiling: tier 1, no seat, four capabilities; organs outside the origin or claiming platform lists are refused", () => {
  assert.deepEqual(externalCeilingViolations(agent("ok")), []);
  assert.deepEqual(externalCeilingViolations(agent("greedy", [...CAPS, "consensus.propose"], { tier_max: 2, voter: true })), ["tier_max 2", "council seat", "capability consensus.propose"]);
  const { organs, refused } = externalOrgans(XAUUSD, {
    schema: XAUUSD.schema,
    organs: [
      organ(AI, [agent("hud-new"), agent("hud-greedy", ["platform.observe"])], ["new_task"]),
      organ("cryptophys-ai-kernel"),
      { ...organ("xauusd-omega"), deploy_unit: "control-plane" },
      { ...organ("xauusd-nexus-dashboard"), kind: "nonsense" },
      organ(AI),
    ],
  });
  assert.deepEqual(organs.map((o) => [o.service, o.agents.map((a) => a.id)]), [[AI, ["hud-new"]]]);
  assert.deepEqual(refused.map((r) => `${r.kind} ${r.subject}`), [
    "external_agent_refused hud-greedy",
    "external_organ_refused cryptophys-ai-kernel",
    "external_organ_refused xauusd-omega",
    "external_organ_refused xauusd:3",
    `external_organ_refused ${AI}`,
  ]);
  assert.throws(() => externalOrgans(XAUUSD, { schema: "other", organs: [] }), /not xauusd-organism\.v1/);
});

test("X2. the census reads XAUUSD's DNA next to main's: today's 13 agents are consistent; organs carry their origin", async () => {
  const db = migratedDb();
  const r = await censusTick(db as never, repoWith(realDna()), Date.now(), reader(() => xauusdDna(db)));
  assert.equal(r.status, "consistent", JSON.stringify((db.raw.prepare("SELECT findings FROM forge_organism_census").get() as any)?.findings));
  const row = db.raw.prepare("SELECT organs, agents FROM forge_organism_census WHERE main_sha = ?").get(MAIN) as any;
  assert.equal(row.organs, DIRS.length + 5);
  const census = (await latestCensusRow({ DB: db } as never))!;
  const ai = census.genome.find((o) => o.service === AI)!;
  assert.equal(ai.origin, "xauusd");
  assert.equal(ai.agents.length, 13);
  assert.equal(census.genome.find((o) => o.service === "cryptophys-ai-kernel")!.origin, undefined, "main's organs have no origin");
});

test("X3. an origin that does not answer is a finding; main's census still runs and nothing of the origin is retired", async () => {
  const db = migratedDb();
  const r = await censusTick(db as never, repoWith(realDna()), Date.now(), [{ origin: XAUUSD, dna: () => Promise.reject(new Error("no such entrypoint")) }]);
  assert.equal(r.status, "changes");
  const f = (await latestCensusRow({ DB: db } as never))!.findings;
  assert.deepEqual(f.map((x) => `${x.kind} ${x.subject}`), ["external_dna_unavailable xauusd"]);
  assert.ok(!f.some((x) => x.kind === "undeclared_agent"), "absent DNA never reads as dismantled agents");
  const genome = new Map();
  const slow = await addExternalOrgans(genome, [{ origin: XAUUSD, dna: () => new Promise(() => {}) }], 20);
  assert.match(slow.findings[0].detail, /timeout/);
  assert.equal(genome.size, 0);
});

test("X4. a new XAUUSD agent registers itself by consensus; one above the ceiling never does; AI tasks are declared in the census", async () => {
  const db = migratedDb();
  setMode(db, "deploy");
  const { env, memory } = kernelEnv(db);
  const grow = { agents: [agent("hud-supertrend"), agent("hud-greedy", [...CAPS, "consensus.propose"])], engines: ["war_room_opening", "decision_council"] };
  const t0 = Date.now();
  await censusTick(db as never, repoWith(realDna()), t0, reader(() => xauusdDna(db, grow)));
  const census = (await latestCensusRow({ DB: db } as never))!;
  assert.deepEqual(census.findings.map((f) => `${f.kind} ${f.subject}`), ["external_agent_refused hud-greedy", "unregistered_agent hud-supertrend"]);
  assert.deepEqual(census.genome.find((o) => o.service === AI)!.engines, ["war_room_opening", "decision_council"], "the AI tasks are in the census genome");
  assert.equal((db.raw.prepare("SELECT engines FROM forge_organism_census WHERE main_sha = ?").get(MAIN) as any).engines,
    DIRS.reduce((n, d) => n + JSON.parse(read(`workers/${d}/organism.json`)).engines.length, 0) + 2);

  await runCycle(env as never, memory, "scheduled", t0);
  const p = last(db);
  assert.equal(p.action, "register_agent");
  assert.equal(p.status, "executed", p.outcome_json);
  const a = db.raw.prepare("SELECT host_worker, tier_max, voter, capabilities_json FROM agents WHERE agent_id = 'hud-supertrend'").get() as any;
  assert.deepEqual({ ...a, capabilities_json: JSON.parse(a.capabilities_json).sort() }, { host_worker: AI, tier_max: 1, voter: 0, capabilities_json: [...CAPS].sort() });

  await runCycle(env as never, memory, "scheduled", t0);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM consensus_proposals WHERE action = 'register_engine'").get()!.n, 0, "no proposal the trading guard would always refuse");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM agents WHERE agent_id = 'hud-greedy'").get()!.n, 0, "above the ceiling: never proposed, never registered");

  const r = await censusTick(db as never, repoWith(realDna()), t0 + CENSUS_REFRESH_MS + 1, reader(() => xauusdDna(db, grow)));
  assert.equal(r.outcome, "refreshed");
  assert.deepEqual((await latestCensusRow({ DB: db } as never))!.findings.map((f) => f.kind), ["external_agent_refused"]);
});

test("X4b. a Worker's second new AI task is not held a day behind its first; a Policy veto is retried after an hour", async () => {
  const db = migratedDb();
  setMode(db, "deploy");
  const { env, memory } = kernelEnv(db);
  const files = realDna();
  const forge = JSON.parse(files["workers/forge/organism.json"]);
  forge.engines = [...forge.engines, { task: "summarize_census" }, { task: "explain_census" }];
  files["workers/forge/organism.json"] = JSON.stringify(forge);
  const t0 = Date.now();
  await censusTick(db as never, repoWith(files), t0);
  await runCycle(env as never, memory, "scheduled", t0);
  await runCycle(env as never, memory, "scheduled", t0);
  const rows = () => db.raw.prepare("SELECT json_extract(params_json, '$.task') AS task, status FROM consensus_proposals WHERE action = 'register_engine' ORDER BY rowid").all() as any[];
  assert.deepEqual(rows().map((r) => `${r.task} ${r.status}`), ["explain_census executed", "summarize_census shadow_blocked"], "the second task is proposed at once; the Policy Engine's hourly limit per target holds it");
  await runCycle(env as never, memory, "scheduled", t0 + 30 * 60_000);
  assert.equal(rows().length, 2, "not retried within the hour");
  await runCycle(env as never, memory, "scheduled", t0 + 61 * 60_000);
  assert.equal(rows().length, 3, "retried after the hour");
  assert.equal(rows()[2].task, "summarize_census");
});

test("X5. defence in depth: a tampered census or a proposal above the ceiling is refused by the vote and by the executor", async () => {
  const db = migratedDb();
  setMode(db, "deploy");
  const { env } = kernelEnv(db);
  await censusTick(db as never, repoWith(realDna()), Date.now(), reader(() => xauusdDna(db, { agents: [agent("hud-new-sensor")] })));
  // Someone rewrites the recorded genome so the external agent asks for more than the ceiling.
  const row = db.raw.prepare("SELECT genome, findings FROM forge_organism_census WHERE main_sha = ?").get(MAIN) as any;
  const genome = JSON.parse(row.genome);
  genome.find((o: any) => o.service === AI).agents.find((a: any) => a.id === "hud-new-sensor").capabilities = [...CAPS, "platform.observe"];
  db.raw.prepare("UPDATE forge_organism_census SET genome = ? WHERE main_sha = ?").run(JSON.stringify(genome), MAIN);
  await syscall(env as never, "supervisor", "consensus.propose", {
    action: "register_agent", target: "hud-new-sensor", params: { service: AI, capabilities: [...CAPS, "platform.observe"], tier_max: 1, main_sha: MAIN },
  });
  const p = last(db);
  assert.notEqual(p.status, "executed");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM agents WHERE agent_id = 'hud-new-sensor'").get()!.n, 0);
  const e: Evidence = {
    agents_enabled: true, audit_valid: true, services: {}, critical_reports_24h: 0, executing_plan_targets: [], recent_same: 0,
    registry: { [AI]: { status: "healthy", desired_version: null } }, agents: {},
  };
  const vote = (capabilities: string[], tier_max = 1) => castVote("policy-engine", { action: "register_agent", target: "hud-x", params: { service: AI, capabilities, tier_max }, class: "routine" } as Proposal, e);
  assert.equal(vote(CAPS).vote, "approve");
  assert.match(vote([...CAPS, "platform.observe"]).reason, /external-organ ceiling: capability platform\.observe/);
  assert.match(vote(CAPS, 2).reason, /tier_max 2/);
});

test("X6. the Forge binds XAUUSD's OrganismDna and reads only bound origins", () => {
  const toml = read("workers/forge/wrangler.toml");
  assert.match(toml, /binding = "EXT_ORGANISM_XAUUSD"\nservice = "xauusd-ai-trading-assistant"\nentrypoint = "OrganismDna"/);
  assert.deepEqual(externalReaders({ DB: {} } as never), []);
  assert.deepEqual(externalReaders({ DB: {}, EXT_ORGANISM_XAUUSD: { dna: async () => ({}) } } as never).map((r) => r.origin.origin), ["xauusd"]);
});
