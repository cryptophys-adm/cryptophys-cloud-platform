// Owner 2026-11-27 ("Ya, buat draft-nya"), confirming the proposal: Command's CTA row is CTA's Beam switch, and the CTA
// studio's own agent_model setting stays a local kill switch that can only turn Beam off. Its first step, the ADR-0007
// amendment's "Design for CTA": CTA_CEILING names one cta agent, cta-model-router, with exactly model_router.status and
// model_router.report_paid. Every other cta agent keeps EXTERNAL_CEILING (AC-CTA). No migration seeds the agent: CTA's
// DNA declares it, the census proposes the routine register_agent, and CTA's router calls the kernel over AgentRpc,
// hosted by cryptophys-cta. CTA's own side (its DNA entry, its binding, its router's reads) is CTA's change, after this.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { APPROVER_EMAIL, baseEnv, migratedDb, lastReviewedRecord } from "./harness.ts";
import {
  CTA_CEILING, CTA_MODEL_ROUTER_AGENT, EXTERNAL_CEILING, EXTERNAL_ORIGINS, XAUUSD_CEILING, XAUUSD_MODEL_ROUTER_AGENT,
  externalCeilingFor, externalCeilingViolations, externalOrgans, externalProposalRefusal, type Genome,
} from "../src/organism.ts";
import { forgetRouterState, readRouterState, routerSystemOfOrigin, setRouterState, type ModelRouterEnv } from "../src/model-router.ts";
import { castVote, privilegedCapabilities, type Evidence, type Proposal } from "../src/consensus-rules.ts";
import { rpcSyscall } from "../../ai-kernel/src/agent-rpc.ts";
import { compare } from "../../forge/src/census.ts";
import { proposalFor, type CensusRow } from "../../ai-kernel/src/organism.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { criticalPathReason } from "../src/guard-paths.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const HOST = "cryptophys-cta";
const CTA = EXTERNAL_ORIGINS.find((o) => o.origin === "cta")!;
const ROUTER_CAPS = ["model_router.status", "model_router.report_paid"];
const KEY = "rk-test-KEY-cta-0123456789-never-stored";
const ON: ModelRouterEnv = { MODEL_ROUTER: "on", REFLECTION_API_KEY: KEY };
const GENERAL = { tier_max: EXTERNAL_CEILING.tier_max, capabilities: EXTERNAL_CEILING.capabilities, proposals: [] };

test("CMR-1. CTA_CEILING: cta-model-router holds exactly the two router capabilities; every other cta agent, and the default, keep EXTERNAL_CEILING", () => {
  assert.equal(CTA_MODEL_ROUTER_AGENT, "cta-model-router");
  assert.equal(CTA.ceiling, CTA_CEILING);
  assert.deepEqual(Object.keys(CTA_CEILING.agents), [CTA_MODEL_ROUTER_AGENT], "one named agent");
  assert.deepEqual([...CTA_CEILING.agents[CTA_MODEL_ROUTER_AGENT]], ROUTER_CAPS);
  assert.deepEqual(CTA_CEILING.proposals, {});
  assert.equal(CTA_CEILING.tier_max, EXTERNAL_CEILING.tier_max);
  assert.deepEqual([...CTA_CEILING.capabilities], [...EXTERNAL_CEILING.capabilities], "the cta default is the general ceiling, not widened");
  assert.deepEqual(externalCeilingFor(CTA, CTA_MODEL_ROUTER_AGENT), { tier_max: 1, capabilities: ROUTER_CAPS, proposals: [] });
  for (const id of [undefined, "cta-editor", "cta-guardian", "x", XAUUSD_MODEL_ROUTER_AGENT]) {
    assert.deepEqual({ ...externalCeilingFor(CTA, id), capabilities: [...externalCeilingFor(CTA, id).capabilities] }, { ...GENERAL, capabilities: [...GENERAL.capabilities] }, String(id));
  }
  assert.deepEqual(privilegedCapabilities(ROUTER_CAPS), [], "a routine registration, no owner click for the agent");
  // xauusd's grant is unchanged; the CTA client is not xauusd's, nor xauusd's CTA's.
  assert.deepEqual([...XAUUSD_CEILING.agents[XAUUSD_MODEL_ROUTER_AGENT]], ROUTER_CAPS);
  assert.ok(!Object.hasOwn(XAUUSD_CEILING.agents, CTA_MODEL_ROUTER_AGENT));
  const XAU = EXTERNAL_ORIGINS.find((o) => o.origin === "xauusd")!;
  assert.deepEqual(externalCeilingViolations({ id: CTA_MODEL_ROUTER_AGENT, tier_max: 1, capabilities: ["model_router.status"] }, XAU), ["capability model_router.status"]);
  // routerSystemOfOrigin maps a cta agent to the CTA switch.
  assert.equal(routerSystemOfOrigin(CTA.origin), "cta");
});

test("CMR-2. the ceiling refuses anything more: another capability, a higher tier, a seat, a proposal; the router caps on another cta agent", () => {
  const cta = (id: string, capabilities: string[], extra: Record<string, unknown> = {}) => externalCeilingViolations({ id, tier_max: 1, voter: false, capabilities, ...extra }, CTA);
  assert.deepEqual(cta(CTA_MODEL_ROUTER_AGENT, ROUTER_CAPS), []);
  assert.deepEqual(cta(CTA_MODEL_ROUTER_AGENT, ["model_router.report_paid"]), []);
  for (const cap of ["signals.observe", "reports.publish", "memory.remember", "consensus.propose", "council.decisions.read", "knowledge.verdict"]) {
    assert.deepEqual(cta(CTA_MODEL_ROUTER_AGENT, [...ROUTER_CAPS, cap]), [`capability ${cap}`], cap);
  }
  assert.deepEqual(externalCeilingViolations({ id: CTA_MODEL_ROUTER_AGENT, tier_max: 2, voter: true, capabilities: ROUTER_CAPS }, CTA), ["tier_max 2", "council seat"]);
  for (const id of ["cta-editor", "cta-guardian"]) {
    assert.deepEqual(cta(id, ["signals.observe", "reports.publish"]), [], `${id} keeps what it had`);
    assert.deepEqual(cta(id, ["model_router.report_paid"]), ["capability model_router.report_paid"], id);
  }
  assert.match(externalProposalRefusal(CTA, CTA_MODEL_ROUTER_AGENT, "register_agent")!, /consensus\.propose is above the cta ceiling for cta-model-router/);
});

test("CMR-3. no migration seeds cta-model-router; once CTA's DNA declares it the census proposes the routine register_agent, approved within the ceiling, refused above it", async () => {
  for (const f of readdirSync(new URL("workers/control-plane-migrations/", ROOT)).filter((n) => n.endsWith(".sql"))) {
    assert.doesNotMatch(read(`workers/control-plane-migrations/${f}`), /cta-model-router/, f);
  }
  const db = migratedDb();
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agents WHERE agent_id = ?").get(CTA_MODEL_ROUTER_AGENT) as any).n, 0);
  const ctaAgent = (id: string) => ({ id, display_name: id, capabilities: ["signals.observe", "reports.publish"], tier_max: 1, voter: false });
  const organ = (agents: unknown[]) => ({ $schema_version: 1, service: HOST, display_name: "Cryptophys CTA · content studio", kind: "portal", deploy_unit: null, access: false, rollback: false, drift: { via: "rpc", binding: "EXT_CRYPTOPHYS_CTA" }, agents, engines: [] });
  const genomeOf = (agents: unknown[]) => {
    const { organs, refused } = externalOrgans(CTA, { schema: CTA.schema, organs: [organ(agents)] });
    return { g: new Map(organs.map((o) => [o.service, o])) as Genome, refused };
  };
  const live = [ctaAgent("cta-editor"), ctaAgent("cta-guardian")];
  const declared = genomeOf([...live, { id: CTA_MODEL_ROUTER_AGENT, display_name: "Model router client", capabilities: ROUTER_CAPS, tier_max: 1, voter: false }]);
  assert.deepEqual(declared.refused, []);
  const findings = await compare(db as never, declared.g);
  assert.deepEqual(findings.filter((f) => f.subject === CTA_MODEL_ROUTER_AGENT).map((f) => f.kind), ["unregistered_agent"]);
  const census: CensusRow = { main_sha: "a".repeat(40), status: "changes", findings, genome: [...declared.g.values()].map((d) => ({ service: d.service, kind: d.kind, agents: d.agents, engines: [], origin: "cta" })) };
  const p = proposalFor(census, { kind: "unregistered_agent", subject: CTA_MODEL_ROUTER_AGENT })!;
  assert.deepEqual([p.action, p.target, p.params.capabilities, p.params.tier_max, p.params.service], ["register_agent", CTA_MODEL_ROUTER_AGENT, ROUTER_CAPS, 1, HOST]);
  const e = { agents_enabled: true, audit_valid: true, critical_reports_24h: 0, services: [], recovery_plans: [], deploys: [], proposals_last_hour: 0, agents: {}, registry: { [HOST]: { status: "registered" } } } as unknown as Evidence;
  const proposal = (target: string, caps: string[]) => ({ proposal_id: "cns_t", action: "register_agent", target, class: "routine", params: { service: HOST, capabilities: caps, tier_max: 1, main_sha: "a".repeat(40) } }) as unknown as Proposal;
  assert.equal(castVote("platform-api", proposal(CTA_MODEL_ROUTER_AGENT, ROUTER_CAPS), e).vote, "approve", castVote("platform-api", proposal(CTA_MODEL_ROUTER_AGENT, ROUTER_CAPS), e).reason);
  assert.match(castVote("platform-api", proposal(CTA_MODEL_ROUTER_AGENT, [...ROUTER_CAPS, "memory.remember"]), e).reason, /above the external-organ ceiling: capability memory\.remember/);
  assert.match(castVote("platform-api", proposal("cta-editor", ["signals.observe", "model_router.status"]), e).reason, /above the external-organ ceiling: capability model_router\.status/);
  const over = genomeOf([...live, { id: CTA_MODEL_ROUTER_AGENT, display_name: "Model router client", capabilities: [...ROUTER_CAPS, "signals.observe"], tier_max: 1, voter: false }]);
  assert.deepEqual(over.refused.map((r) => [r.kind, r.subject]), [["external_agent_refused", CTA_MODEL_ROUTER_AGENT]]);
  const editorOver = genomeOf([ctaAgent("cta-guardian"), { ...ctaAgent("cta-editor"), capabilities: ["signals.observe", "model_router.report_paid"] }]);
  assert.deepEqual(editorOver.refused.map((r) => [r.kind, r.subject]), [["external_agent_refused", "cta-editor"]]);
});

test("CMR-4. over AgentRpc, cta-model-router (hosted by cryptophys-cta) reads CTA's own switch and reports a paid sign; hosted elsewhere or another agent is denied; it holds nothing else", async () => {
  const db = migratedDb();
  forgetRouterState(db);
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const env = { ...baseEnv("cryptophys-ai-kernel", db, { ...ON }), POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async () => { throw new Error("unused"); } } };
  const PIN = { host_worker: HOST };
  assert.equal((await rpcSyscall(env as never, PIN, CTA_MODEL_ROUTER_AGENT, "model_router.status", {}) as any).outcome, "denied", "unregistered");
  const at = new Date().toISOString();
  const insert = db.raw.prepare(`INSERT INTO agents (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, 'test', 1, ?, 'enabled', NULL, 'consensus:test', ?, ?)`);
  insert.run(CTA_MODEL_ROUTER_AGENT, "Model router client", HOST, JSON.stringify(ROUTER_CAPS), at, at);
  insert.run("cta-editor", "CTA Editor", HOST, JSON.stringify(["signals.observe", "reports.publish"]), at, at);
  // Command's CTA row is CTA's switch: it is off by default, Cerebrum's own row on, and CTA reads its own.
  await setRouterState(db, APPROVER_EMAIL, { system: "cerebrum", state: "on" });
  const off = await rpcSyscall(env as never, PIN, CTA_MODEL_ROUTER_AGENT, "model_router.status", {}) as any;
  assert.equal(off.outcome, "succeeded", JSON.stringify(off));
  assert.equal(off.result.state.state, "off", "CTA's switch, not Cerebrum's");
  await setRouterState(db, APPROVER_EMAIL, { system: "cta", state: "on" });
  const st = await rpcSyscall(env as never, PIN, CTA_MODEL_ROUTER_AGENT, "model_router.status", {}) as any;
  assert.equal(st.outcome, "succeeded", JSON.stringify(st));
  assert.deepEqual([st.result.schema, st.result.state.state, st.result.state.mode], ["model_router.status.v1", "on", "free_only"]);
  assert.ok(!JSON.stringify(st).includes(KEY), "no key in the answer");
  // Host-pinned: the same agent from another Worker is refused; another cta agent has no router capability.
  for (const host of ["cryptophys-aether", "xauusd-ai-trading-assistant"]) {
    assert.equal((await rpcSyscall(env as never, { host_worker: host }, CTA_MODEL_ROUTER_AGENT, "model_router.status", {}) as any).reason, "agent_not_hosted_by_caller", host);
  }
  for (const cap of ROUTER_CAPS) assert.equal((await rpcSyscall(env as never, PIN, "cta-editor", cap, { signal: "http_402" }) as any).outcome, "denied", cap);
  for (const cap of ["reports.publish", "signals.observe", "memory.remember", "knowledge.verdict"]) {
    assert.equal((await rpcSyscall(env as never, PIN, CTA_MODEL_ROUTER_AGENT, cap, {}) as any).outcome, "denied", cap);
  }
  // A paid sign from CTA stops every system (model_router_global), audited once as CTA's agent.
  const rep = await rpcSyscall(env as never, PIN, CTA_MODEL_ROUTER_AGENT, "model_router.report_paid", { signal: "http_402" }) as any;
  assert.equal(rep.outcome, "succeeded", JSON.stringify(rep));
  assert.deepEqual(rep.result, { state: "off_paid", changed: true });
  const ev = db.raw.prepare("SELECT actor, payload_json FROM audit_events WHERE event_type = 'model_router.paid_detected'").all() as any[];
  assert.deepEqual(ev.map((x) => [x.actor, JSON.parse(x.payload_json).signal]), [[`agent:${CTA_MODEL_ROUTER_AGENT}`, "http_402"]]);
  const after = await rpcSyscall(env as never, PIN, CTA_MODEL_ROUTER_AGENT, "model_router.status", {}) as any;
  assert.notEqual(after.result.state.state, "on", "Beam is off for CTA after its own paid sign");
  for (const system of ["cerebrum", "cta"] as const) assert.equal((await readRouterState(db as never, system))?.state, "off_paid", `${system} is stopped by the paid sign`);
  assert.equal((db.raw.prepare("SELECT paid_off FROM model_router_global WHERE id = 'global'").get() as any).paid_off, 1, "the global paid stop");
});

test("CMR-5. the records: one constant names the agent; the ADR amendment, the SSOT entry with the owner's words; organism.ts is a guard path (the owner's click)", () => {
  const src = read("workers/control-plane-shared/src/organism.ts");
  assert.equal(src.match(/"cta-model-router"/g)?.length, 1, "the id is written once");
  assert.match(src, /\[CTA_MODEL_ROUTER_AGENT\]: Object\.freeze\(\["model_router\.status", "model_router\.report_paid"\]\)/);
  assert.match(src, /origin: "cta", schema: "cta-organism\.v1", binding: "EXT_ORGANISM_CTA",\n    services: Object\.freeze\(\["cryptophys-cta"\]\),\n    ceiling: CTA_CEILING,/);
  assert.equal(criticalPathReason("workers/control-plane-shared/src/organism.ts"), "capability_ceiling");
  const adr = read("architecture/adr/0007-ai-worker-os.md");
  assert.match(adr, /- \*\*Design for CTA \(ceiling built 2026-11-27; CTA's side not yet\)\.\*\*/);
  assert.match(adr, /"Ya, buat draft-nya", confirming the proposal: Command's CTA row is CTA's Beam switch, and the CTA studio's own `agent_model` setting stays as a local kill switch that can only turn Beam off/);
  assert.match(adr, /entrypoint = "AgentRpc", props = \{ host_worker = "cryptophys-cta" \}/);
  assert.match(adr, /Since 2026-11-27 `CTA_CEILING` grants them too, to one cta agent, `cta-model-router`/);
  const record = lastReviewedRecord();
  assert.match(record, /^Last reviewed: 2026-11-16 \((?:[^\n]*; )?CTA Beam client ceiling, 2026-11-27 \(owner: "Ya, buat draft-nya"/);
  assert.match(read("docs/SSOT.md"), /since 2026-11-27 its own `CTA_CEILING`: the general ceiling for every agent but `cta-model-router`/);
});
