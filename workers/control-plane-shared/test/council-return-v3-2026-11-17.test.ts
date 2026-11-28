// ADR-0014 §11 (owner 2026-11-17: "aktifkan evolver sekarang termasuk jalur balik"), docs/design/EVOLVER.md §8, step V3:
// the return path. council.decisions.read (tier 0, read only) is granted only by XAUUSD_CEILING, to xauusd-moderator.
// A registered agent gets a capability its DNA now declares through the new routine consensus action
// update_agent_capabilities, which settles the census finding agent_capabilities_changed (it had no way out before).
import { test } from "node:test";
import assert from "node:assert/strict";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, fakeAi, migratedDb, registeredDb } from "./harness.ts";
import { CAPABILITIES, verifySyscallDecision } from "../src/capabilities.ts";
import { castVote, classify, privilegedCapabilities, type Evidence, type Proposal } from "../src/consensus-rules.ts";
import { EXTERNAL_CEILING, EXTERNAL_ORIGINS, XAUUSD_CEILING, externalCeilingFor } from "../src/organism.ts";
import { describeAction } from "../src/plain.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { censusTick, type ExternalDnaReader } from "../../forge/src/census.ts";
import { runCycle } from "../../ai-kernel/src/supervisor.ts";
import { PHASE2_EXECUTABLE } from "../../ai-kernel/src/consensus.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { latestCensusRow, proposalFor } from "../../ai-kernel/src/organism.ts";
import { MAX_UPDATES } from "../../ai-kernel/src/council-decisions.ts";
import { intakeEvolutionIntents } from "../../ai-kernel/src/evolution-intake.ts";
import type { ArtifactsReader, ArtifactsTreeEntry } from "../../forge/src/checks.ts";
import { readFileSync } from "node:fs";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const DIRS = ["ai-kernel", "audit-ledger", "console", "deployment-orchestrator", "drift-detector", "forge", "forge-typecheck", "forge-typecheck-cr", "platform-api", "platform-registry", "policy-engine", "recovery-manager"];
const A = "a".repeat(40);
const XAUUSD = EXTERNAL_ORIGINS.find((o) => o.origin === "xauusd")!;
const AI = "xauusd-ai-trading-assistant";
const MOD = "xauusd-moderator";
const READ = "council.decisions.read";
const NOW = Date.parse("2026-11-17T18:07:00.000Z");

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
const organ = (service: string, agents: unknown[] = []) => ({
  $schema_version: 1, service, display_name: service, kind: "service", deploy_unit: null, access: false, rollback: false,
  drift: { via: "rpc", binding: "EXT_XAUUSD_AI" }, agents, engines: [],
});
/** The xauusd DNA as served: its registered agents with EXTERNAL_CEILING, except the overrides. */
function xauusdReader(db: Db, override: Record<string, string[]>): ExternalDnaReader[] {
  return [{
    origin: XAUUSD,
    dna: async () => {
      const live = (db.raw.prepare("SELECT agent_id FROM agents WHERE host_worker = ? ORDER BY agent_id").all(AI) as Array<{ agent_id: string }>)
        .map((r) => ({ id: r.agent_id, display_name: r.agent_id, capabilities: override[r.agent_id] ?? [...EXTERNAL_CEILING.capabilities], tier_max: 1, voter: false }));
      return { schema: XAUUSD.schema, organs: [organ(AI, live), ...XAUUSD.services.filter((s) => s !== AI).map((s) => organ(s))] };
    },
  }];
}
function agent(db: Db, id: string, caps: string[] = [...EXTERNAL_CEILING.capabilities]) {
  db.raw.prepare("UPDATE agents SET capabilities_json = ? WHERE agent_id = ?").run(JSON.stringify(caps), id);
  db.raw.prepare(`INSERT OR IGNORE INTO agents (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at, voter)
    VALUES (?, ?, ?, 'test', 1, ?, 'enabled', NULL, 'consensus:test', '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z', 0)`).run(id, id, AI, JSON.stringify(caps));
}
const capsOf = (db: Db, id: string) => JSON.parse((db.raw.prepare("SELECT capabilities_json FROM agents WHERE agent_id = ?").get(id) as any).capabilities_json);
const proposalsOf = (db: Db, action: string) => db.raw.prepare("SELECT * FROM consensus_proposals WHERE action = ? ORDER BY rowid").all(action) as any[];

function setup() {
  const db = registeredDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  for (const id of [MOD, "hud-prophet"]) agent(db, id);
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const mem = new Map<string, unknown>();
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async (agentId: string, decisionId: string) => { await verifySyscallDecision(db, decisionId, agentId, "recovery.propose"); return { plan: {} }; } },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    DEPLOY: { pendingDeploys: async () => ({ main_sha: null, ci_green: false, units: [], skipped: [] }) },
    CANONICAL_MAIN: { mainHead: async () => ({ main_sha: A }) },
  };
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, structuredClone(v)); } };
  return { db, env, memory };
}

test("R1. council.decisions.read is tier 0 and read only; only XAUUSD_CEILING grants it, to the moderator; update_agent_capabilities is routine", () => {
  assert.deepEqual([CAPABILITIES[READ].tier, CAPABILITIES[READ].reversible], [0, true]);
  assert.deepEqual(privilegedCapabilities([READ]), []);
  assert.equal(XAUUSD.ceiling, XAUUSD_CEILING);
  assert.ok(externalCeilingFor(XAUUSD, MOD).capabilities.includes(READ));
  for (const o of EXTERNAL_ORIGINS) for (const id of [undefined, "hud-prophet", "aether-curator", "cta-editor"]) {
    assert.ok(!externalCeilingFor(o, id).capabilities.includes(READ), `${o.origin}/${id}`);
  }
  assert.ok(!EXTERNAL_CEILING.capabilities.includes(READ), "the general ceiling is not widened");
  assert.equal(classify("update_agent_capabilities"), "routine");
  assert.ok(PHASE2_EXECUTABLE.has("update_agent_capabilities"));
  assert.match(describeAction("update_agent_capabilities", MOD), /^set, as its DNA declares, the capabilities of the agent /);
});

test("R2. the votes: the moderator's new set is approved; a set above the ceiling, a privileged set, an unregistered agent or another host is rejected", () => {
  const e = {
    agents_enabled: true, audit_valid: true, critical_reports_24h: 0, services: [], recovery_plans: [], deploys: [], proposals_last_hour: 0,
    agents: { [MOD]: { status: "enabled", host_worker: AI }, "hud-prophet": { status: "enabled", host_worker: AI } },
    registry: { [AI]: { status: "healthy" } },
  } as unknown as Evidence;
  const p = (target: string, capabilities: unknown, service = AI) => ({ proposal_id: "cns_t", action: "update_agent_capabilities", target, class: "routine", params: { service, capabilities, tier_max: 1, main_sha: A } }) as unknown as Proposal;
  const vote = (q: Proposal) => castVote("platform-api", q, e);
  assert.equal(vote(p(MOD, [...EXTERNAL_CEILING.capabilities, READ])).vote, "approve");
  assert.match(vote(p("hud-prophet", [...EXTERNAL_CEILING.capabilities, READ])).reason, /above the external-organ ceiling: capability council\.decisions\.read/);
  // Owner 2026-11-22 ("Jalur klik owner (Rekomendasi)"): never as routine; only update_privileged_agent_capabilities, the owner's click.
  assert.match(vote(p(MOD, [...EXTERNAL_CEILING.capabilities, "consensus.propose"])).reason, /privileged capabilities are never updated as routine, only by update_privileged_agent_capabilities with the owner's click: consensus\.propose/);
  assert.match(vote(p(MOD, ["move.funds"])).reason, /unknown or prohibited/);
  assert.match(vote(p("ghost", [READ])).reason, /not registered/);
  assert.match(vote(p(MOD, [READ], "xauusd-omega")).reason, /registered on xauusd-ai-trading-assistant/);
  assert.match(vote(p(MOD, [])).reason, /non-empty list/);
});

test("R3. the census finding is proposed and executed: the moderator gets council.decisions.read, audited, and the census settles", async () => {
  const { db, env, memory } = setup();
  const t0 = Date.now();
  const declared = [...EXTERNAL_CEILING.capabilities, READ];
  await censusTick(db as never, repoWith(realDna(), A), t0 - 60_000, xauusdReader(db, { [MOD]: declared }));
  const census = (await latestCensusRow({ DB: db } as never))!;
  const finding = census.findings.find((f) => f.kind === "agent_capabilities_changed" && f.subject === MOD)!;
  assert.ok(finding, census.findings.map((f) => `${f.kind} ${f.subject} ${f.detail}`).join("; "));
  const prop = proposalFor(census, finding)!;
  assert.deepEqual([prop.action, prop.target, prop.params.service, prop.params.tier_max, prop.params.main_sha], ["update_agent_capabilities", MOD, AI, 1, A]);
  assert.deepEqual([...(prop.params.capabilities as string[])].sort(), [...declared].sort());

  await runCycle(env as never, memory, "scheduled", t0);
  const [p] = proposalsOf(db, "update_agent_capabilities");
  assert.ok(p, "proposed");
  assert.equal(p.status, "executed", p.outcome_json);
  assert.deepEqual(capsOf(db, MOD).sort(), [...declared].sort());
  assert.deepEqual(capsOf(db, "hud-prophet"), [...EXTERNAL_CEILING.capabilities], "no other agent changes");
  const audit = db.raw.prepare("SELECT actor, payload_json FROM audit_events WHERE event_type = 'agent.capabilities_updated' AND subject = ?").all(`agent:${MOD}`) as any[];
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0].payload_json).previous, [...EXTERNAL_CEILING.capabilities]);
  await censusTick(db as never, repoWith(realDna(), A), t0 + 31 * 60_000, xauusdReader(db, { [MOD]: declared }));
  assert.ok(!(await latestCensusRow({ DB: db } as never))!.findings.some((f) => f.kind === "agent_capabilities_changed"), "the census settles");
});

test("R4. a DNA that gives another xauusd agent council.decisions.read changes nothing: the council rejects it", async () => {
  const { db, env, memory } = setup();
  const t0 = Date.now();
  await censusTick(db as never, repoWith(realDna(), A), t0 - 60_000, xauusdReader(db, { "hud-prophet": [...EXTERNAL_CEILING.capabilities, READ] }));
  await runCycle(env as never, memory, "scheduled", t0);
  const proposals = proposalsOf(db, "update_agent_capabilities");
  assert.ok(proposals.every((p) => p.status !== "executed"), JSON.stringify(proposals.map((p) => p.status)));
  assert.deepEqual(capsOf(db, "hud-prophet"), [...EXTERNAL_CEILING.capabilities]);
});

test("R5. council.decisions.read returns the caller origin's updates, oldest first, by cursor, at most MAX_UPDATES; never a price", async () => {
  const db = migratedDb();
  agent(db, MOD, [...EXTERNAL_CEILING.capabilities, READ]);
  agent(db, "hud-prophet");
  const body = (n: number, repo: string) => JSON.stringify({
    schema: "typed_proposal.v1", proposal_id: `cp_${n}`, kind: "repository_task", state: "handoff_pending", executor: "cryptophys",
    origin: { council: "cfc_1", option_id: `o${n}`, side: "nexus", repo }, chosen_by: "owner:o@example.com", chosen_at: "2026-11-17T15:00:00.000Z",
    title: `Task ${n}`, spec: `Do ${n}`, price: 2650,
  });
  for (let n = 1; n <= MAX_UPDATES + 3; n++) {
    db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at) VALUES (?, ?, 'xauusd_digest', 'info', 't', ?, 'deterministic', NULL, ?)")
      .run(`rpt_${crypto.randomUUID()}`, MOD, body(n, n % 2 ? "cryptophys-adm/xauusd-ai-trading-assistant" : "cryptophys-adm/cryptophys-cloud-platform"), new Date(NOW - 3_600_000 + n * 1000).toISOString());
  }
  await intakeEvolutionIntents(db, NOW);
  const env = baseEnv("cryptophys-ai-kernel", db, { POLICY: { evaluate: async () => { throw new Error("tier 0 never asks the Policy Engine"); } } });
  const first = await syscall(env as never, MOD, READ, {});
  assert.equal(first.outcome, "succeeded", JSON.stringify(first));
  const r1 = (first as any).result;
  assert.equal(r1.origin, "xauusd");
  assert.equal(r1.updates.length, MAX_UPDATES);
  assert.deepEqual(Object.keys(r1.updates[0]).sort(), ["at", "proposal_id", "reason", "refs", "schema", "state"]);
  // queued_external since Issue #327 (2026-11-28): an xauusd task is assigned to xauusd-worker.
  assert.ok(r1.updates.every((u: any) => ["queued", "waiting_external", "queued_external"].includes(u.state) && typeof u.refs.intent_id === "string"));
  // The planted price must not appear as a value or a word. A bare substring check also matched random UUIDs
  // (intent_id, proposal_id) that happen to contain "2650", which failed canonical main 7cbc789 once.
  const r1Text = JSON.stringify(r1);
  assert.ok(!/(?<![0-9A-Za-z-])2650(?![0-9A-Za-z-])/.test(r1Text), `never a price: ${r1Text}`);
  assert.ok(!/"price"/.test(r1Text), "never a price field");
  const second = (await syscall(env as never, MOD, READ, { cursor: r1.next_cursor }) as any).result;
  assert.equal(second.updates.length, 3);
  const seen = [...r1.updates, ...second.updates].map((u: any) => u.proposal_id);
  assert.equal(new Set(seen).size, MAX_UPDATES + 3, "each update once, none skipped");
  const third = (await syscall(env as never, MOD, READ, { cursor: second.next_cursor }) as any).result;
  assert.deepEqual([third.updates, third.next_cursor], [[], second.next_cursor]);
  const bad = await syscall(env as never, MOD, READ, { cursor: "'; DROP TABLE agents; --" });
  assert.notEqual(bad.outcome, "succeeded");
  const denied = await syscall(env as never, "hud-prophet", READ, {});
  assert.notEqual(denied.outcome, "succeeded", "an agent without the capability is refused");
});
