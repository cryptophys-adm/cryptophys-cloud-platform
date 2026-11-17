// ADR-0014 §11 (owner 2026-11-17: "aktifkan evolver sekarang termasuk jalur balik"), docs/design/EVOLVER.md §5, step V5:
// the evolver agent (ai-kernel/src/evolver.ts). Its gene and engines, its privileged registration (the owner's click), the
// gates, one cycle from intent to code.propose, the repair call, transient failures, tracking to merge and deploy, the
// freeze, and the wiring (EvolverAgent, the tick, the wake route, migration v6, FORGE_EVOLUTION).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, migratedDb, registeredDb, req } from "./harness.ts";
import { CAPABILITIES, verifySyscallDecision } from "../src/capabilities.ts";
import { KERNEL_AGENTS, privilegedCapabilities } from "../src/consensus-rules.ts";
import { EVOLVER_MODEL, MIN_START_INTERVAL_HOURS } from "../src/evolution-limits.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import { parseDna } from "../src/organism.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { censusTick } from "../../forge/src/census.ts";
import { latestCensusRow, proposalFor } from "../../ai-kernel/src/organism.ts";
import { EVOLVER_ID, EVOLVER_TASKS, MAX_AI_CALLS, gateReason, relevantPaths, runEvolverCycle, trackEvolutions } from "../../ai-kernel/src/evolver.ts";
import { intakeEvolutionIntents } from "../../ai-kernel/src/evolution-intake.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { topologyDiff } from "../../deployment-orchestrator/src/topology.ts";
import type { ArtifactsReader, ArtifactsTreeEntry } from "../../forge/src/checks.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const KERNEL = "cryptophys-ai-kernel";
const NOW = Date.parse("2026-11-17T20:07:00.000Z");
const HOUR = 3_600_000;
const MAIN = "a".repeat(40);
const rows = (db: Db, sql: string, ...a: unknown[]) => (db.raw.prepare(sql).all(...(a as never[])) as any[]).map((r) => ({ ...r }));

const FILES: Record<string, string> = {
  "workers/ai-kernel/src/a.ts": "export const a = 1;\n",
  "workers/control-plane-shared/test/a.test.ts": "assert.equal(a, 1);\n",
  "docs/x.md": "# X\n",
};
const GOOD = {
  title: "Raise a to 2", description: "The intent asks for 2.",
  edits: [
    { path: "workers/ai-kernel/src/a.ts", find: "export const a = 1;", replace: "export const a = 2;" },
    { path: "workers/control-plane-shared/test/a.test.ts", find: "assert.equal(a, 1);", replace: "assert.equal(a, 2);" },
  ],
};
const GUARD = { title: "Touch a guard", description: "x", edits: [{ path: "workers/control-plane-shared/src/guard-paths.ts", create: "x" }] };
const PLAN = { files: ["workers/ai-kernel/src/a.ts", "workers/control-plane-shared/test/a.test.ts"], approach: "Change a and its test." };

/** An AI binding answering from a queue, recording the model and task of every call. */
function scriptedAi(answers: unknown[]) {
  const calls: Array<{ model: string; system: string }> = [];
  return {
    calls,
    run: async (model: string, input: any) => {
      calls.push({ model, system: String(input.messages?.[0]?.content ?? "") });
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return { response: a };
    },
  };
}

function setup(o: { answers?: unknown[]; forge?: Partial<{ written: Record<string, unknown> }> } = {}) {
  const db = registeredDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const ai = scriptedAi(o.answers ?? [PLAN, GOOD]);
  const proposals: any[] = [];
  const forge = {
    read: async (input: { paths?: unknown }) => {
      if (Array.isArray(input.paths)) return { available: true, main_sha: MAIN, files: Object.fromEntries((input.paths as string[]).map((p) => [p, FILES[p] ?? null])), refused: {} };
      return { available: true, main_sha: MAIN, paths: Object.keys(FILES) };
    },
    propose: async (agentId: string, decisionId: string, input: any) => {
      await verifySyscallDecision(db, decisionId, agentId, "code.propose");
      proposals.push(input);
      return o.forge?.written ?? { ok: true, outcome: "written", evolution_id: input.evolution_id, branch: `evo/${input.evolution_id}`, cr_id: `fg-evo-${input.evolution_id}`, base_sha: MAIN, head_sha: "b".repeat(40), files: input.edits.map((e: any) => e.path).sort(), changed_lines: 4 };
    },
  };
  const env: Record<string, unknown> = {
    ...baseEnv(KERNEL, db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: ai,
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    FORGE_EVOLUTION: forge,
  };
  const store = new Map<string, unknown>();
  const storage = { put: async (k: string, v: unknown) => { store.set(k, v); }, get: async (k: string) => store.get(k) };
  return { db, env, ai, proposals, storage, store };
}
function intent(db: Db, o: { source?: string; repo?: string; title?: string; at?: number; proposal?: string } = {}): string {
  const id = `int_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const origin = o.source === "council" ? { origin: "xauusd", proposal_id: o.proposal ?? "cp_1" } : {};
  db.raw.prepare("INSERT INTO evolution_intents (intent_id, source, source_ref, origin_json, target_repo, title, spec, evidence_refs_json, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'Make a equal 2.', '[]', 'queued', ?, ?)")
    .run(id, o.source ?? "owner", id, JSON.stringify(origin), o.repo ?? "platform", o.title ?? "Raise a", new Date(o.at ?? NOW - HOUR).toISOString(), new Date(o.at ?? NOW - HOUR).toISOString());
  return id;
}
const evolutions = (db: Db) => rows(db, "SELECT * FROM evolutions ORDER BY started_at, rowid");
const intentOf = (db: Db, id: string) => rows(db, "SELECT * FROM evolution_intents WHERE intent_id = ?", id)[0];
const events = (db: Db) => rows(db, "SELECT event_type, outcome FROM audit_events WHERE event_type LIKE 'evolution.%' ORDER BY rowid").map((e) => `${e.event_type}:${e.outcome}`);

test("V1. the gene: tier 2, code.read and code.propose, no seat; its two engines; a kernel agent; its files are guard paths", () => {
  const dna = parseDna(read("workers/ai-kernel/organism.json"));
  const gene = dna.agents.find((a) => a.id === EVOLVER_ID)!;
  assert.deepEqual([gene.tier_max, [...gene.capabilities].sort(), gene.voter], [2, ["code.propose", "code.read"], false]);
  assert.deepEqual(privilegedCapabilities(gene.capabilities), ["code.propose"], "registered only with the owner's click");
  assert.deepEqual(EVOLVER_TASKS.filter((t) => dna.engines.some((e) => e.task === t)), [...EVOLVER_TASKS]);
  assert.ok(KERNEL_AGENTS.has(EVOLVER_ID));
  assert.equal(criticalPathReason("workers/ai-kernel/src/evolver.ts"), "evolution_guard");
  assert.equal(EVOLVER_MODEL, "@cf/openai/gpt-oss-120b");
  assert.equal(MAX_AI_CALLS, 3);
});

test("V2. the census proposes register_privileged_agent for the evolver: a critical action, so the owner clicks", async () => {
  const db = registeredDb();
  db.raw.prepare("DELETE FROM agents WHERE agent_id = ?").run(EVOLVER_ID);
  const files = Object.fromEntries(["ai-kernel", "audit-ledger", "console", "deployment-orchestrator", "drift-detector", "forge", "forge-typecheck", "forge-typecheck-cr", "platform-api", "platform-registry", "policy-engine", "recovery-manager"]
    .map((d) => [`workers/${d}/organism.json`, read(`workers/${d}/organism.json`)]));
  const repo = await (async () => {
    const trees: Record<string, ArtifactsTreeEntry[]> = {}; const blobs: Record<string, string> = {}; let n = 1;
    const id = () => (n++).toString(16).padStart(40, "e");
    const build = (f: Record<string, string>): string => {
      const here: Record<string, Record<string, string>> = {}; const entries: ArtifactsTreeEntry[] = [];
      for (const [p, t] of Object.entries(f)) { const i = p.indexOf("/"); if (i < 0) { const h = id(); blobs[h] = t; entries.push({ name: p, type: "blob", mode: "100644", hash: h }); } else (here[p.slice(0, i)] ??= {})[p.slice(i + 1)] = t; }
      for (const [d, sub] of Object.entries(here)) entries.push({ name: d, type: "tree", mode: "40000", hash: build(sub) });
      const h = id(); trees[h] = entries; return h;
    };
    const root = build(files);
    return { readCommit: async (h: string) => (h === MAIN ? { hash: h, treeHash: root } : null), readTree: async (h: string) => trees[h] ?? null, readBlob: async (h: string) => (h in blobs ? new Blob([blobs[h]]) : null), log: async () => [{ hash: MAIN }] } as ArtifactsReader;
  })();
  await censusTick(db as never, repo, NOW);
  const census = (await latestCensusRow({ DB: db } as never))!;
  const f = census.findings.find((x) => x.subject === EVOLVER_ID)!;
  assert.equal(f.kind, "unregistered_agent");
  const p = proposalFor(census, f)!;
  assert.deepEqual([p.action, p.target, p.params.tier_max], ["register_privileged_agent", EVOLVER_ID, 2]);
});

test("V3. the gates, in order: the switch, the kill switch, the mode, the registration, in flight, the interval, a critical report, a deploy, the freeze", async () => {
  const s = setup();
  const g = () => gateReason({ DB: s.db } as never, NOW);
  assert.equal(await g(), null, "everything holds");
  s.db.raw.prepare("UPDATE evolver_controls SET value = 'off'").run(); assert.equal(await g(), "evolver_off");
  s.db.raw.prepare("UPDATE evolver_controls SET value = 'on', updated_at = ?").run(new Date(NOW - 10 * HOUR).toISOString());
  s.db.raw.prepare("UPDATE kernel_controls SET value = '0'").run(); assert.equal(await g(), "kill_switch_engaged");
  s.db.raw.prepare("UPDATE kernel_controls SET value = '1'").run();
  s.db.raw.prepare("UPDATE consensus_controls SET value = 'shadow'").run(); assert.equal(await g(), "consensus_mode_shadow");
  s.db.raw.prepare("UPDATE consensus_controls SET value = 'deploy'").run();
  s.db.raw.prepare("UPDATE agents SET status = 'suspended' WHERE agent_id = ?").run(EVOLVER_ID); assert.equal(await g(), "evolver_suspended");
  s.db.raw.prepare("UPDATE agents SET status = 'enabled' WHERE agent_id = ?").run(EVOLVER_ID);
  const i = intent(s.db);
  const evo = (id: string, state: string, started: number, ended: number | null) => s.db.raw.prepare("INSERT INTO evolutions (evolution_id, intent_id, state, model, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, i, state, EVOLVER_MODEL, new Date(started).toISOString(), ended === null ? null : new Date(ended).toISOString());
  evo("evo_000000000001", "proposed", NOW - 10 * HOUR, null); assert.equal(await g(), "evolution_in_flight");
  s.db.raw.prepare("UPDATE evolutions SET state = 'closed', ended_at = ? WHERE evolution_id = 'evo_000000000001'").run(new Date(NOW - 9 * HOUR).toISOString());
  evo("evo_000000000002", "refused", NOW - (MIN_START_INTERVAL_HOURS - 1) * HOUR, NOW - 2 * HOUR); assert.equal(await g(), "start_interval");
  s.db.raw.prepare("UPDATE evolutions SET started_at = ? WHERE evolution_id = 'evo_000000000002'").run(new Date(NOW - 5 * HOUR).toISOString());
  assert.equal(await g(), null);
  s.db.raw.prepare("INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, idempotency_key, details_json, created_at, updated_at) VALUES ('dep_x', 'cryptophys-policy-engine', ?, 'x', 'running', 'k', '{}', ?, ?)")
    .run(MAIN, new Date(NOW - 60_000).toISOString(), new Date(NOW - 60_000).toISOString());
  assert.equal(await g(), "deploy_running");
  s.db.raw.prepare("UPDATE deployment_requests SET status = 'succeeded'").run();
  // The freeze: the last two ended evolutions closed by failed checks, the switch not turned on since.
  s.db.raw.prepare("UPDATE evolution_intents SET state = 'closed', state_reason = 'checks_failed', evolution_id = 'evo_000000000002' WHERE intent_id = ?").run(i);
  const j = intent(s.db);
  s.db.raw.prepare("UPDATE evolution_intents SET state = 'closed', state_reason = 'checks_failed', evolution_id = 'evo_000000000001' WHERE intent_id = ?").run(j);
  assert.equal(await g(), "frozen");
  s.db.raw.prepare("UPDATE evolver_controls SET updated_at = ?").run(new Date(NOW - 60_000).toISOString());
  assert.equal(await g(), null, "the owner turned it on again after the freeze");
});

test("V4. one cycle: the oldest council intent first; plan, read, write, checkEdits, code.propose through the Policy Engine; recorded and returned", async () => {
  const s = setup();
  const owner = intent(s.db, { at: NOW - 3 * HOUR });
  const council = intent(s.db, { source: "council", at: NOW - HOUR, proposal: "cp_9" });
  const r = await runEvolverCycle(s.env as never, s.storage, NOW);
  assert.equal(r.outcome, "proposed", JSON.stringify(r));
  assert.equal(r.intent_id, council, "council intents first");
  assert.deepEqual(s.ai.calls.map((c) => c.model), [EVOLVER_MODEL, EVOLVER_MODEL], "gpt-oss only, two calls");
  assert.equal(s.proposals.length, 1);
  assert.deepEqual([s.proposals[0].base_sha, s.proposals[0].title, s.proposals[0].edits.length], [MAIN, GOOD.title, 2]);
  const [e] = evolutions(s.db);
  assert.deepEqual([e.state, e.cr_id, e.ai_calls, e.changed_lines, JSON.parse(e.files_json)], ["proposed", `fg-evo-${e.evolution_id}`, 2, 4, GOOD.edits.map((x) => x.path).sort()]);
  assert.deepEqual([intentOf(s.db, council).state, intentOf(s.db, owner).state], ["proposed", "queued"]);
  assert.deepEqual(rows(s.db, "SELECT proposal_id, state FROM evolution_updates ORDER BY created_at, rowid").map((u) => `${u.proposal_id}:${u.state}`), ["cp_9:in_progress", "cp_9:proposed"]);
  assert.deepEqual(events(s.db), ["evolution.started:started", "evolution.proposed:proposed"]);
  const decision = rows(s.db, "SELECT subject, resource, decision FROM policy_decisions WHERE resource = 'code.propose'");
  assert.deepEqual(decision, [{ subject: `agent:${EVOLVER_ID}`, resource: "code.propose", decision: "allow" }]);
  assert.equal((await runEvolverCycle(s.env as never, s.storage, NOW + 15 * 60_000)).reason, "evolution_in_flight", "one at a time");
});

test("V5. a refused draft gets one repair call; refused again it refuses the intent with the refusals; at most 3 AI calls", async () => {
  let s = setup({ answers: [PLAN, GUARD, GOOD] });
  let i = intent(s.db);
  let r = await runEvolverCycle(s.env as never, s.storage, NOW);
  assert.equal(r.outcome, "proposed");
  assert.equal(s.ai.calls.length, 3);
  s = setup({ answers: [PLAN, GUARD, GUARD] });
  i = intent(s.db);
  r = await runEvolverCycle(s.env as never, s.storage, NOW);
  assert.deepEqual([r.outcome, r.reason], ["refused", "edits_refused"]);
  assert.equal(s.ai.calls.length, MAX_AI_CALLS);
  assert.equal(s.proposals.length, 0, "nothing reaches the Forge");
  const [e] = evolutions(s.db);
  assert.deepEqual([e.state, e.ai_calls], ["refused", 3]);
  assert.match(JSON.parse(e.refusals_json)[0], /^guard_path:evolution_guard/);
  assert.deepEqual([intentOf(s.db, i).state, intentOf(s.db, i).state_reason], ["refused", "edits_refused"]);
});

test("V6. transient failures put the intent back: the model unavailable, the Forge's own gate; the repository unreadable takes nothing", async () => {
  let s = setup({ answers: [new Error("upstream 503")] });
  let i = intent(s.db);
  let r = await runEvolverCycle(s.env as never, s.storage, NOW);
  assert.equal(r.outcome, "refused");
  assert.deepEqual([intentOf(s.db, i).state, JSON.parse(evolutions(s.db)[0].refusals_json)], ["queued", ["transient"]]);
  assert.equal((await runEvolverCycle(s.env as never, s.storage, NOW + 15 * 60_000)).reason, "start_interval", "retried after the interval, not in a loop");
  s = setup({ forge: { written: { ok: false, outcome: "refused", reason: "base_not_main" } } });
  i = intent(s.db);
  r = await runEvolverCycle(s.env as never, s.storage, NOW);
  assert.equal(intentOf(s.db, i).state, "queued", "the Forge's gate is no verdict on the intent");
  s = setup();
  (s.env.FORGE_EVOLUTION as any).read = async () => ({ available: false });
  i = intent(s.db);
  r = await runEvolverCycle(s.env as never, s.storage, NOW);
  assert.deepEqual([r.outcome, r.reason, evolutions(s.db).length, intentOf(s.db, i).state], ["waiting", "code_read_unavailable", 0, "queued"]);
});

test("V7. tracking: merged, then deployed once every unit its files touch deployed after the merge; failed checks close it; stale after 24 h", async () => {
  const s = setup();
  const i = intent(s.db, { source: "council", proposal: "cp_7" });
  await runEvolverCycle(s.env as never, s.storage, NOW);
  const [e] = evolutions(s.db);
  const cr = (status: string, merge: string | null, at: number) => s.db.raw.prepare(`INSERT OR REPLACE INTO forge_change_requests (cr_id, number, branch, source_branch, title, author, head_sha, base_sha, github_ci, status, created_at, updated_at, source, repo, merge_sha, outcome_at)
    VALUES (?, 0, ?, ?, 't', 'Cryptophys Evolver', ?, ?, NULL, ?, ?, ?, 'forge', 'platform-work', ?, ?)`).run(e.cr_id, e.branch, e.branch, e.head_sha, MAIN, status, new Date(NOW).toISOString(), new Date(at).toISOString(), merge, merge ? new Date(at).toISOString() : null);
  cr("open", null, NOW);
  assert.deepEqual(await trackEvolutions({ DB: s.db } as never, NOW + HOUR), []);
  cr("merged", "c".repeat(40), NOW + 2 * HOUR);
  assert.deepEqual(await trackEvolutions({ DB: s.db } as never, NOW + 2 * HOUR), [`${e.evolution_id}:merged`]);
  // ai-kernel/src touches the control-plane unit (deployment_requests under its first service) and the shared test none.
  assert.deepEqual(await trackEvolutions({ DB: s.db } as never, NOW + 3 * HOUR), [], "not deployed yet");
  s.db.raw.prepare("INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, idempotency_key, details_json, created_at, updated_at) VALUES ('dep_y', 'cryptophys-policy-engine', ?, 'x', 'succeeded', 'k2', '{}', ?, ?)")
    .run("c".repeat(40), new Date(NOW + 3 * HOUR).toISOString(), new Date(NOW + 3 * HOUR).toISOString());
  assert.deepEqual(await trackEvolutions({ DB: s.db } as never, NOW + 4 * HOUR), [`${e.evolution_id}:deployed_unmeasured`]);
  assert.deepEqual(rows(s.db, "SELECT state FROM evolution_updates WHERE proposal_id = 'cp_7' ORDER BY created_at, rowid").map((u) => u.state), ["in_progress", "proposed", "merged", "deployed_unmeasured"]);
  assert.equal(intentOf(s.db, i).state, "deployed_unmeasured");

  const t = setup();
  intent(t.db);
  await runEvolverCycle(t.env as never, t.storage, NOW);
  const [f] = evolutions(t.db);
  t.db.raw.prepare("INSERT INTO forge_check_runs (commit_sha, status, runner, started_at) VALUES (?, 'failed', 'test', ?)").run(f.head_sha, new Date(NOW).toISOString());
  assert.deepEqual(await trackEvolutions({ DB: t.db } as never, NOW + HOUR), [`${f.evolution_id}:closed`]);
  const u = setup();
  intent(u.db);
  await runEvolverCycle(u.env as never, u.storage, NOW);
  assert.deepEqual((await trackEvolutions({ DB: u.db } as never, NOW + 25 * HOUR)).map((x) => x.split(":")[1]), ["closed"], "stale after 24 h");
  // An attempt that stopped mid-cycle never holds the slot: refused as interrupted after an hour.
  const v = setup();
  const k = intent(v.db);
  v.db.raw.prepare("INSERT INTO evolutions (evolution_id, intent_id, state, model, started_at) VALUES ('evo_00000000000a', ?, 'writing', ?, ?)").run(k, EVOLVER_MODEL, new Date(NOW - 2 * HOUR).toISOString());
  assert.deepEqual(await trackEvolutions({ DB: v.db } as never, NOW), ["evo_00000000000a:refused"]);
  assert.equal(intentOf(v.db, k).state_reason, "interrupted");
});

test("V8. the council path end to end: a platform council task from the intake is what the evolver picks", async () => {
  const s = setup();
  s.db.raw.prepare(`INSERT OR IGNORE INTO agents (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at, voter)
    VALUES ('xauusd-moderator', 'Moderator', 'xauusd-ai-trading-assistant', 't', 1, '[]', 'enabled', NULL, 'x', 'x', 'x', 0)`).run();
  s.db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at) VALUES ('rpt_1', 'xauusd-moderator', 'xauusd_digest', 'info', 't', ?, 'deterministic', NULL, ?)")
    .run(JSON.stringify({ schema: "typed_proposal.v1", proposal_id: "cp_p", kind: "repository_task", state: "handoff_pending", executor: "cryptophys", origin: { side: "nexus", repo: "cryptophys-adm/cryptophys-cloud-platform", council: "c", option_id: "o" }, chosen_by: "owner:o@example.com", title: "Raise a", spec: "Make a equal 2." }), new Date(NOW - HOUR).toISOString());
  await intakeEvolutionIntents(s.db, NOW);
  const r = await runEvolverCycle(s.env as never, s.storage, NOW);
  assert.equal(r.outcome, "proposed");
  assert.deepEqual(rows(s.db, "SELECT state FROM evolution_updates WHERE proposal_id = 'cp_p' ORDER BY created_at, rowid").map((u) => u.state), ["queued", "in_progress", "proposed"]);
  assert.deepEqual(relevantPaths(["docs/a.md", "workers/x/raise.ts"], "raise a"), ["workers/x/raise.ts", "docs/a.md"]);
});

test("V9. wiring: EvolverAgent is bound with migration v6 (additive), FORGE_EVOLUTION targets EvolutionRpc, the tick and the wake route reach it", async () => {
  const toml = read("workers/ai-kernel/wrangler.toml");
  assert.match(toml, /\[\[durable_objects\.bindings\]\]\nname = "EVOLVER"\nclass_name = "EvolverAgent"/);
  assert.match(toml, /\[\[services\]\]\nbinding = "FORGE_EVOLUTION"\nservice = "cryptophys-forge"\nentrypoint = "EvolutionRpc"/);
  const before = toml.replace(/\n# The evolver[^\n]*\n\[\[durable_objects\.bindings\]\]\nname = "EVOLVER"\nclass_name = "EvolverAgent"\n/, "\n")
    .replace(/\n\[\[migrations\]\]\ntag = "v6"\nnew_sqlite_classes = \["EvolverAgent"\]\n/, "\n");
  const d = topologyDiff(before, toml, KERNEL);
  assert.ok("diff" in d, JSON.stringify(d));
  assert.deepEqual([d.diff.migration?.from, d.diff.migration?.to, d.diff.destructive], ["v5", "v6", []]);
  assert.match(read("workers/ai-kernel/src/worker.ts"), /export class EvolverAgent extends DurableObject<Env>/);
  assert.match(read("workers/forge/src/worker.ts"), /export class EvolutionRpc extends WorkerEntrypoint<Env>/);
  const cycles: string[] = [];
  const ns = { idFromName: (n: string) => n, get: () => ({ cycle: async (t: string) => { cycles.push(t); return { trigger: t, agent_id: EVOLVER_ID }; }, status: async () => ({ outcome: "idle" }) }) };
  const env = { ...baseEnv(KERNEL, registeredDb(), { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL}` }), EVOLVER: ns, SUPERVISOR: { idFromName: (n: string) => n, get: () => ({ cycle: async () => ({}) }) } };
  const waited: Promise<unknown>[] = [];
  await kernel.scheduled({ scheduledTime: NOW, cron: "7,22,37,52 * * * *" } as never, env as never, { waitUntil: (p: Promise<unknown>) => { waited.push(p.catch(() => undefined)); } } as never);
  await Promise.all(waited);
  assert.deepEqual(cycles, ["scheduled"]);
  const woke = await call(kernel, env, req("POST", `/v1/agents/${EVOLVER_ID}/wake`, {}, OPERATOR_JWT));
  assert.equal(woke.status, 200);
  assert.deepEqual(cycles, ["scheduled", "operator"]);
  assert.match(read("workers/console/ui/src/pages/AgentDetail.tsx"), /const KERNEL_AGENTS = \[[^\]]*"evolver"/);
  assert.deepEqual([CAPABILITIES["code.read"].tier, CAPABILITIES["code.propose"].tier], [0, 2]);
  assert.ok(!/child_process|fetch\(/.test(read("workers/ai-kernel/src/evolver.ts")), "no process, no network of its own");
});
