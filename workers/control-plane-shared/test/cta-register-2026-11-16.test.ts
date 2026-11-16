// Migration 0074 (2026-11-16): cryptophys-cta, the content studio (repository cryptophys-adm/cryptophys-cta, live since
// 11:36 UTC at https://cta.cryptophys.work), gets its service_registry row. Before it, every voter rejected the census's
// register_agent for cta-editor and cta-guardian ("host Worker cryptophys-cta is not an active registered service") and
// the Drift Detector's EXT_CRYPTOPHYS_CTA probe had nothing to observe. The migration registers the Worker only: the
// agents stay the census/consensus path, within the general EXTERNAL_CEILING.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { baseEnv, migratedDb } from "./harness.ts";
import { castVote, type Evidence, type Proposal } from "../src/consensus-rules.ts";
import { EXTERNAL_CEILING, EXTERNAL_ORIGINS } from "../src/organism.ts";
import { compareInventory, knownOrganism } from "../src/observer-inventory.ts";
import { censusTick } from "../../forge/src/census.ts";
import { latestCensusRow, proposalFor } from "../../ai-kernel/src/organism.ts";
import { observe } from "../../drift-detector/src/index.ts";
import type { ArtifactsReader, ArtifactsTreeEntry } from "../../forge/src/checks.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const DIRS = ["ai-kernel", "audit-ledger", "console", "deployment-orchestrator", "drift-detector", "forge", "forge-typecheck", "forge-typecheck-cr", "platform-api", "platform-registry", "policy-engine", "recovery-manager"];
const MAIN = "c".repeat(40);
const HOST = "cryptophys-cta";
const CTA = EXTERNAL_ORIGINS.find((o) => o.origin === "cta")!;
const SERVICES = Object.fromEntries(EXTERNAL_ORIGINS.map((o) => [o.origin, o.services]));
const TAG = "aaaaaaaaaaaa";

function repoWith(files: Record<string, string>, head = MAIN): ArtifactsReader {
  const trees: Record<string, ArtifactsTreeEntry[]> = {}; const blobs: Record<string, string> = {}; let n = 1;
  const id = () => (n++).toString(16).padStart(40, "c");
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

/** cta's organ as the deployed cryptophys-cta serves it over OrganismDna.dna() (2026-11-16). */
const ctaAgent = (id: string, display_name: string) => ({ id, display_name, capabilities: ["signals.observe", "reports.publish"], tier_max: 1, voter: false });
const ctaOrgan = {
  $schema_version: 1, service: HOST, display_name: "Cryptophys CTA · content studio", kind: "portal", deploy_unit: null, access: false, rollback: false,
  drift: { via: "rpc", binding: "EXT_CRYPTOPHYS_CTA" }, agents: [ctaAgent("cta-editor", "CTA Editor"), ctaAgent("cta-guardian", "CTA Content Guardian")], engines: [],
};
const ctaReader = { origin: CTA, dna: async () => ({ schema: "cta-organism.v1", organs: [ctaOrgan], deploy: { unit: HOST } }) };

const ctaRow = (db: Db) => db.raw.prepare("SELECT * FROM service_registry WHERE service_id = ?").get(HOST) as any;

/** The evidence every voter reads, from D1 as the kernel's gatherEvidence reads it (registry and agents), all brakes off. */
function evidenceOf(db: Db): Evidence {
  const reg = db.raw.prepare("SELECT service_id, status, desired_version FROM service_registry").all() as Array<{ service_id: string; status: string; desired_version: string | null }>;
  const ag = db.raw.prepare("SELECT agent_id, status, host_worker, voter FROM agents").all() as Array<{ agent_id: string; status: string; host_worker: string; voter: number }>;
  return {
    agents_enabled: true, audit_valid: true, services: {}, critical_reports_24h: 0, executing_plan_targets: [], recent_same: 0,
    registry: Object.fromEntries(reg.map((r) => [r.service_id, { status: r.status, desired_version: r.desired_version }])),
    agents: Object.fromEntries(ag.map((a) => [a.agent_id, { status: a.status, host_worker: a.host_worker, voter: a.voter === 1 }])),
  };
}
const seats = (db: Db) => (db.raw.prepare("SELECT agent_id FROM agents WHERE voter = 1 AND status = 'enabled' ORDER BY agent_id").all() as Array<{ agent_id: string }>).map((r) => r.agent_id);

/** The census's register_agent proposal for one of cta's agents, as the Supervisor builds it from the finding. */
async function censusProposal(db: Db, agentId: string): Promise<Proposal> {
  const census = (await latestCensusRow({ DB: db } as never))!;
  const finding = census.findings.find((f) => f.kind === "unregistered_agent" && f.subject === agentId);
  assert.ok(finding, `the census finds ${agentId} unregistered: ${JSON.stringify(census.findings)}`);
  const p = proposalFor(census, finding!);
  assert.ok(p);
  return { ...p!, class: "routine" };
}

test("CR1. 0074 registers cryptophys-cta: one active row, health-managed (no versions), the agents left to the census", () => {
  const db = migratedDb();
  const row = ctaRow(db);
  assert.ok(row, "the row is present");
  assert.deepEqual(
    [row.display_name, row.endpoint, row.environment, row.status, row.desired_version, row.observed_version],
    ["Cryptophys CTA · content studio", "https://cta.cryptophys.work", "production", "registered", null, null],
  );
  const meta = JSON.parse(row.metadata_json);
  assert.deepEqual([meta.owner, meta.repository, meta.origin, meta.data_classification], ["cryptophys-adm", "cryptophys-adm/cryptophys-cta", "cta", "internal"]);
  assert.equal(meta.retired_at, undefined, "not retired");
  assert.equal(meta.health_path, undefined, "probed over RPC (CtaHealth.health()), not over HTTP");
  assert.deepEqual(CTA.services, [HOST], "the row is the service of the cta origin");
  // The migration registers no agent and no engine: register_agent stays the census/consensus path.
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agents WHERE host_worker = ?").get(HOST) as any).n, 0);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agents WHERE agent_id LIKE 'cta-%'").get() as any).n, 0);
  // Additive: applied again, nothing changes (INSERT OR IGNORE).
  const before = db.raw.prepare("SELECT * FROM service_registry ORDER BY service_id").all();
  db.raw.exec(read("workers/control-plane-migrations/0074_register_cta.sql"));
  assert.deepEqual(db.raw.prepare("SELECT * FROM service_registry ORDER BY service_id").all(), before);
});

test("CR2. with the row active, every seat approves the census's register_agent for cta-editor within EXTERNAL_CEILING, and still rejects one above it", async () => {
  // Without the row (as before 0074): the census finds the Worker unregistered, and every seat rejects the registration.
  const without = migratedDb();
  without.raw.prepare("DELETE FROM service_registry WHERE service_id = ?").run(HOST);
  await censusTick(without as never, repoWith(realDna()), Date.now(), [ctaReader]);
  const c0 = (await latestCensusRow({ DB: without } as never))!;
  assert.ok(c0.findings.some((f) => f.kind === "unregistered_service" && f.subject === HOST), JSON.stringify(c0.findings));
  const p0 = await censusProposal(without, "cta-editor");
  const council = seats(without);
  assert.ok(council.length >= 8, `the council has its seats: ${council.join(", ")}`);
  for (const voter of council) {
    assert.deepEqual(castVote(voter, p0, evidenceOf(without)), { voter, vote: "reject", reason: "host Worker cryptophys-cta is not an active registered service" }, voter);
  }

  // With 0074: the Worker is registered, so the census no longer reports it, and the same proposal passes every seat.
  const db = migratedDb();
  await censusTick(db as never, repoWith(realDna()), Date.now(), [ctaReader]);
  const c1 = (await latestCensusRow({ DB: db } as never))!;
  assert.equal(c1.findings.some((f) => f.subject === HOST), false, JSON.stringify(c1.findings));
  assert.deepEqual(c1.findings.filter((f) => f.kind.startsWith("external_")), [], "both agents are within the general ceiling");
  const p = await censusProposal(db, "cta-editor");
  assert.deepEqual([p.action, p.target, p.params.service, [...(p.params.capabilities as string[])].sort(), p.params.tier_max], ["register_agent", "cta-editor", HOST, ["reports.publish", "signals.observe"], 1]);
  for (const c of p.params.capabilities as string[]) assert.ok(EXTERNAL_CEILING.capabilities.includes(c), `${c} is within EXTERNAL_CEILING`);
  const e = evidenceOf(db);
  assert.equal(e.registry[HOST].status, "registered");
  for (const voter of seats(db)) assert.equal(castVote(voter, p, e).vote, "approve", `${voter}: ${castVote(voter, p, e).reason}`);
  assert.equal(castVote("supervisor", p, e).reason, "declared in the DNA census");
  // cta-guardian the same.
  const g = await censusProposal(db, "cta-guardian");
  for (const voter of seats(db)) assert.equal(castVote(voter, g, e).vote, "approve", voter);

  // Above the ceiling: still rejected by every seat, the row notwithstanding.
  const above = (params: Record<string, unknown>, action = "register_agent"): Proposal => ({ ...p, action, params: { ...p.params, ...params }, class: action === "register_agent" ? "routine" : "critical" });
  for (const voter of seats(db)) {
    assert.match(castVote(voter, above({ capabilities: ["signals.observe", "reports.publish", "platform.observe"] }), e).reason, /^above the external-organ ceiling: capability platform\.observe/, voter);
    assert.match(castVote(voter, above({ tier_max: 2 }), e).reason, /^above the external-organ ceiling: tier_max 2/, voter);
    assert.equal(castVote(voter, above({ capabilities: ["reports.publish", "consensus.propose"] }, "register_privileged_agent"), e).vote, "reject", voter);
    assert.equal(castVote(voter, above({ capabilities: ["reports.publish", "deploy.commit"] }), e).vote, "reject", voter);
  }
  // A registered agent is not registered twice.
  db.raw.prepare("INSERT INTO agents (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at) VALUES ('cta-editor', 'CTA Editor', ?, 'test', 1, '[\"signals.observe\",\"reports.publish\"]', 'enabled', NULL, 'test', 't', 't')").run(HOST);
  assert.equal(castVote("policy-engine", p, evidenceOf(db)).reason, "agent is already registered");
});

function driftEnv(db: Db, cta: unknown, reports: Array<{ subject: string; body: any }>) {
  const healthy = { health: async () => ({ status: "ok", version: { id: "v", tag: TAG } }) };
  const ok = { fetch: async () => Response.json({ status: "ok" }) };
  const env: any = {
    ...baseEnv("cryptophys-drift-detector", db, { CF_VERSION_METADATA: { id: "self", tag: TAG } }),
    AGENTS: {
      whoami: async () => ({}), observe: async () => ({}),
      syscall: async (_agent: string, capability: string, input: any) => { if (capability === "reports.publish") reports.push({ subject: input.subject, body: input.body }); return { outcome: "succeeded" }; },
    },
    EXT_XAUUSD_AI: ok, EXT_XAUUSD_NEWS: ok, EXT_XAUUSD_PULL_ADAPTER: ok, EXT_XAUUSD_NEXUS: ok, EXT_AETHER: ok, EXT_XAUUSD_OMEGA: ok,
    EXT_CRYPTOPHYS_CTA: cta,
  };
  for (const name of ["SVC_PLATFORM_API", "SVC_DEPLOYMENT_ORCHESTRATOR", "SVC_PLATFORM_REGISTRY", "SVC_POLICY_ENGINE", "SVC_AUDIT_LEDGER", "SVC_RECOVERY_MANAGER", "SVC_AI_KERNEL", "SVC_CONSOLE", "SVC_FORGE"]) env[name] = healthy;
  return env;
}

test("CR3. the Drift Detector probes cryptophys-cta over EXT_CRYPTOPHYS_CTA: healthy on ok for this service, drifted and unavailable otherwise, never a version alert", async () => {
  const db = migratedDb();
  // The platform's own Workers carry a desired version (the deploys record it); the external organs never do.
  db.raw.exec(`UPDATE service_registry SET desired_version = '${TAG}' WHERE service_id LIKE 'cryptophys-%' AND service_id NOT IN ('cryptophys-aether', 'cryptophys-cta', 'cryptophys-signal-engine', 'cryptophys-home')`);
  const reports: Array<{ subject: string; body: any }> = [];
  let calls = 0;
  const up = { health: async () => { calls++; return { ok: true, service: HOST, publish: "off" }; } };
  const run: any = await observe(driftEnv(db, up, reports), "scheduled", "cryptophys-drift-detector");
  const cta = run.services.find((s: any) => s.service_id === HOST);
  assert.ok(cta, "cta is observed now that it has a registry row");
  assert.equal(calls, 1, "probed once, over its CtaHealth RPC");
  assert.deepEqual(
    [cta.drifted, cta.managed, cta.status, cta.reasons, cta.desired_version, cta.observed_version, cta.probe.version_tag],
    [false, false, "healthy", ["desired_version_unset"], null, null, null],
  );
  assert.equal(run.drifted, 0, "nothing drifts");
  assert.deepEqual(reports, [], "no drift report: cta's missing version is not an alert");
  assert.deepEqual([ctaRow(db).status, ctaRow(db).observed_version, ctaRow(db).desired_version], ["healthy", null, null]);
  // Healthy is an active status: the registration vote still approves after the heartbeat.
  await censusTick(db as never, repoWith(realDna()), Date.now(), [ctaReader]);
  const e = evidenceOf(db);
  assert.equal(castVote("platform-registry", await censusProposal(db, "cta-editor"), e).vote, "approve");

  // Anything but { ok: true, service: "cryptophys-cta" } is unhealthy: drifted, unavailable, one report, and the
  // reasons are the probe's only (no version_mismatch, no observed_version_unavailable).
  const cases = [
    [{ health: async () => ({ ok: false, service: HOST, error: "desk" }) }, "health_check_failed"],
    [{ health: async () => ({ ok: true, service: "cryptophys-aether" }) }, "health_check_failed"],
    [{ health: async () => ({ status: "ok", version: { id: "v", tag: TAG } }) }, "health_check_failed"],
    [{ health: async () => null }, "health_check_failed"],
    [{ health: async () => { throw new Error("Worker has no entrypoint CtaHealth"); } }, "rpc_failed"],
  ] as const;
  for (const [binding, error] of cases) {
    const fresh = migratedDb();
    fresh.raw.exec(`UPDATE service_registry SET desired_version = '${TAG}' WHERE service_id LIKE 'cryptophys-%' AND service_id NOT IN ('cryptophys-aether', 'cryptophys-cta', 'cryptophys-signal-engine', 'cryptophys-home')`);
    const got: Array<{ subject: string; body: any }> = [];
    const down: any = await observe(driftEnv(fresh, binding, got), "scheduled", "cryptophys-drift-detector");
    const s = down.services.find((x: any) => x.service_id === HOST);
    assert.deepEqual([s.drifted, s.managed, s.status, s.probe.error, s.reasons], [true, false, "unavailable", error, [error, "desired_version_unset"]], error);
    assert.equal(down.drifted, 1, "only cta drifts");
    assert.equal(got.length, 1, "one report for the episode");
    assert.deepEqual(got[0].body.drifted, [{ service_id: HOST, reasons: [error, "desired_version_unset"], desired: null, observed: null }]);
    for (const r of got[0].body.drifted[0].reasons) assert.ok(!["version_mismatch", "observed_version_unavailable"].includes(r), r);
  }
});

test("CR4. the Observer's inventory classifies cryptophys-cta as declared: in the DNA union, not an unknown origin, not disabled, no finding", async () => {
  const db = migratedDb();
  await censusTick(db as never, repoWith(realDna()), Date.now(), [ctaReader]);
  const known = (await knownOrganism(db as never, SERVICES))!;
  assert.deepEqual([known.declared.has(HOST), known.unknown_origins.has(HOST), known.disabled.has(HOST)], [true, false, false]);
  const findings = (k: typeof known, items: Array<{ id: string; name: string }>) => compareInventory({
    known: k, lists: { scripts: { status: "ok", items } }, traffic7d: new Map([[HOST, 40]]), senses_cover_7d: false, day: "2026-11-16",
  }).filter((f) => f.worker === HOST).map((f) => f.metric);
  assert.deepEqual(findings(known, [{ id: HOST, name: HOST }]), [], "live with traffic and declared: nothing to report");
});

test("CR5. the docs record the registration, gate 9's first live run and the binding-props result", () => {
  const ssot = read("docs/SSOT.md");
  assert.match(ssot.split("\n").find((l) => l.startsWith("Last reviewed: "))!, /(?:^Last reviewed: |\); )2026-11-16 \([^\n]*`cryptophys-cta` gets its registry row, migration 0074/);
  const cutover = read("docs/GITHUB-CUTOVER.md");
  assert.match(cutover.split("\n").find((l) => l.startsWith("| 9 |"))!, /cns_8d019512-bae5-4a47-8952-091451f1340e/);
  assert.match(cutover, /ff6fd35[^\n]*\n[^\n]*service_binding_props_unverifiable:AGENTS/);
});
