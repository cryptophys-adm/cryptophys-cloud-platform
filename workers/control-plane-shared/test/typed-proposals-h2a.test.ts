// HAIC H2a (ADR-0017 H2; owner answers of 2026-11-18): typed_proposal.v1 drafts from a council's pick, the owner's
// confirmation or rejection, and the hand-off by kind: consensus through the Supervisor (policy_parameter), the evolver
// (repository_task), the orchestrator (vision_kpi), xauusd's pull path (shadow_arm). Nothing acts before the owner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { DRAFT_WINDOW_MS, HANDOFF_PATH, draftFromCouncil, newProposalId, validateTypedProposal, type TypedProposal } from "../src/typed-proposal.ts";
import { decideProposal, draftsAwaitingOwner, expireDrafts, insertDraft, nextPolicyHandoff, readTypedProposal, recordPolicyHandoff } from "../../ai-kernel/src/proposals.ts";
import { readCouncilDecisions } from "../../ai-kernel/src/council-decisions.ts";
import { ownerInbox } from "../../ai-kernel/src/owner-inbox.ts";
import { collectNotices } from "../../ai-kernel/src/owner-notices.ts";
import { TYPED_PROPOSAL_KIND } from "../src/owner-inbox-rank.ts";

const NOW = Date.parse("2026-11-18T12:30:00.000Z");
const H = 3_600_000;
const CS = "cs_00000000-0000-4000-8000-0000000000c1";
const REF = "ev:platform/consensus/cns_00000005-0000-4000-8000-000000000000";
function tp(kind: TypedProposal["kind"], over: Partial<TypedProposal> = {}): TypedProposal {
  const base: Record<string, Partial<TypedProposal>> = {
    policy_parameter: { target: "daily-deploy-limit", params: { value: 12 } },
    repository_task: { target: "platform", params: { spec: "Route destructive-migration deploys through the workflow first." } },
    vision_kpi: { target: "native_deploy_success_rate", params: { to: 0.97 } },
    shadow_arm: { target: "key_level", params: { confirmation: "close" }, requires: ["owner_confirm", "shadow_window", "owner_click_to_promote"] },
  };
  return { schema: "typed_proposal.v1", proposal_id: newProposalId(), kind, title: `A ${kind}`, rationale: "Because the evidence says so.", target: null, params: {},
    measurement: { metric: "m", baseline: 0.1, window: "14d", success_threshold: 0.05 }, origin: { source: "council", ref: `${CS}#opt_1` }, evidence_refs: [REF],
    requires: ["owner_confirm", "owner_click_to_promote"], ...base[kind], ...over } as TypedProposal;
}
const events = (db: ReturnType<typeof migratedDb>, type: string) => (db.raw.prepare("SELECT actor, outcome, payload_json FROM audit_events WHERE event_type = ? ORDER BY rowid").all(type) as any[])
  .map((e) => ({ actor: e.actor, outcome: e.outcome, ...JSON.parse(e.payload_json) }));

test("T1. the contract: each kind's rules, never a price, never wider autonomy, always the owner's confirmation", () => {
  for (const k of ["policy_parameter", "repository_task", "vision_kpi", "shadow_arm"] as const) assert.deepEqual(validateTypedProposal(tp(k)), [], k);
  assert.deepEqual(HANDOFF_PATH, { policy_parameter: "consensus", repository_task: "evolver", vision_kpi: "orchestrator", shadow_arm: "xauusd" });
  const bad = (p: TypedProposal) => validateTypedProposal(p);
  assert.ok(bad(tp("policy_parameter", { params: { value: 99 } })).some((e) => e.startsWith("params.value: an integer from 1 to 40")));
  assert.ok(bad(tp("policy_parameter", { target: "trading-enabled" })).some((e) => e.startsWith("target")));
  assert.ok(bad(tp("repository_task", { target: "xauusd" })).some((e) => e.startsWith("target")), "other repositories wait for ADR-0018");
  assert.ok(bad(tp("shadow_arm", { params: { entry_price: 2650 } })).includes("params_carry_a_price"));
  assert.ok(bad(tp("shadow_arm", { requires: ["owner_confirm"] })).includes("requires.shadow_window"));
  assert.ok(bad(tp("repository_task", { params: { spec: "x", tier_max: 3 } })).includes("widens_autonomy"));
  assert.ok(bad(tp("policy_parameter", { requires: ["owner_click_to_promote"] })).includes("requires.owner_confirm"));
  assert.ok(bad(tp("vision_kpi", { evidence_refs: ["ev:xauusd/signal/abc#entry_price"] })).includes("evidence_refs"));
  // A council's pick: its option and the decision's proposal_draft.
  const d = draftFromCouncil("tp_0123456789abcdef", CS, { option_id: "opt_2", title: "Lower the limit", hypothesis: "Fewer stalls.", evidence_refs: [REF] },
    { kind: "policy_parameter", target: "daily-deploy-limit", params: { value: 8 }, measurement: null, requires: ["owner_confirm", "owner_click_to_promote"] });
  assert.deepEqual([d.origin, d.title, d.rationale, validateTypedProposal(d)], [{ source: "council", ref: `${CS}#opt_2` }, "Lower the limit", "Fewer stalls.", []]);
});

test("T2. a draft is stored once valid, waits 7 days, is an owner inbox item and part of owner_attention; an invalid one is audited, not stored", async () => {
  const db = migratedDb();
  const p = tp("policy_parameter");
  assert.deepEqual(await insertDraft(db as never, p, "owner:owner@example.com", NOW), { ok: true, proposal_id: p.proposal_id });
  const bad = await insertDraft(db as never, tp("policy_parameter", { params: { value: 0 } }), "owner:owner@example.com", NOW);
  assert.equal(bad.ok, false);
  assert.equal(events(db, "proposal.draft_invalid").length, 1);
  const r = await readTypedProposal(db as never, p.proposal_id) as any;
  assert.deepEqual([r.state, r.kind, r.origin_source, Date.parse(r.expires_at) - NOW, r.body.params.value], ["draft", "policy_parameter", "council", DRAFT_WINDOW_MS, 12]);
  assert.match(r.what_happens, /set_policy_parameter/);
  const inbox = await ownerInbox(db as never, NOW + H) as any;
  assert.deepEqual([inbox.counts.typed_proposals, inbox.typed_proposals[0].proposal_id], [1, p.proposal_id]);
  const item = inbox.items.find((i: any) => i.source === "proposal");
  assert.deepEqual(TYPED_PROPOSAL_KIND, { urgency: "normal", blocks: [] });
  assert.deepEqual([item.item_id, item.kind, item.action, item.page], [`proposal:${p.proposal_id}`, "typed_proposal_draft", { kind: "confirm", route: "kernel.proposal_confirm", approver_only: true }, `#/proposals/${p.proposal_id}`]);
  const n = (await collectNotices(db as never, NOW + H, ["owner_attention"]))[0];
  assert.deepEqual([n.active, n.count], [true, 1]);
  assert.match(n.lines[0], /Confirm or reject: A policy_parameter \(policy parameter, from a council\)/);
  // Past its window it expires, and it can no longer be confirmed.
  assert.deepEqual(await expireDrafts(db as never, NOW + DRAFT_WINDOW_MS - 1), []);
  assert.deepEqual(await expireDrafts(db as never, NOW + DRAFT_WINDOW_MS + 1), [p.proposal_id]);
  await assert.rejects(decideProposal(db as never, APPROVER_EMAIL, p.proposal_id, "confirm", null, NOW + DRAFT_WINDOW_MS + 2), (e: any) => e.code === "not_a_draft");
  assert.deepEqual(await draftsAwaitingOwner(db as never, NOW), []);
});

test("T3. confirmed, each kind goes its way: consensus via the Supervisor, the evolver, the orchestrator, xauusd's pull path with the draft", async () => {
  const db = migratedDb();
  const drafts = Object.fromEntries((["policy_parameter", "repository_task", "vision_kpi", "shadow_arm"] as const).map((k) => [k, tp(k)]));
  for (const p of Object.values(drafts)) await insertDraft(db as never, p, "owner:owner@example.com", NOW);
  const confirm = (k: string) => decideProposal(db as never, APPROVER_EMAIL, drafts[k].proposal_id, "confirm", "go", NOW + H) as Promise<any>;

  const pp = await confirm("policy_parameter");
  assert.deepEqual([pp.state, pp.handoff_path, pp.decided_by], ["handoff_pending", "consensus", APPROVER_EMAIL]);
  assert.deepEqual(await nextPolicyHandoff(db as never), { proposal_id: drafts.policy_parameter.proposal_id, target: "daily-deploy-limit", value: 12 });
  await recordPolicyHandoff(db as never, drafts.policy_parameter.proposal_id, { ok: true, consensus_id: "cns_00000000-0000-4000-8000-0000000000aa" }, NOW + 2 * H);
  const ppAfter = await readTypedProposal(db as never, drafts.policy_parameter.proposal_id) as any;
  assert.deepEqual([ppAfter.state, ppAfter.handoff_ref], ["handed_off", "cns_00000000-0000-4000-8000-0000000000aa"]);
  assert.equal(await nextPolicyHandoff(db as never), null);

  const rt = await confirm("repository_task");
  assert.deepEqual([rt.state, rt.handoff_path], ["handed_off", "evolver"]);
  const intent = db.raw.prepare("SELECT source, source_ref, target_repo, title, spec, state FROM evolution_intents_v2 WHERE intent_id = ?").get(rt.handoff_ref) as any;
  assert.deepEqual({ ...intent }, { source: "owner", source_ref: drafts.repository_task.proposal_id, target_repo: "platform", title: "A repository_task", spec: "Route destructive-migration deploys through the workflow first.", state: "queued" });

  const vk = await confirm("vision_kpi");
  assert.deepEqual([vk.state, vk.handoff_path, vk.handoff_ref], ["handed_off", "orchestrator", null]);
  assert.match(vk.reason, /organism\/vision\.json/);

  const sa = await confirm("shadow_arm");
  assert.deepEqual([sa.state, sa.handoff_path], ["handed_off", "xauusd"]);
  assert.equal((db.raw.prepare("SELECT state, target_repo FROM evolution_intents_v2 WHERE intent_id = ?").get(sa.handoff_ref) as any).state, "waiting_external");
  db.raw.prepare(`INSERT OR IGNORE INTO agents (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at, voter)
    VALUES ('xauusd-moderator', 'm', 'xauusd-ai-trading-assistant', 'test', 1, '[]', 'enabled', NULL, 'consensus:test', '2026-11-17T00:00:00.000Z', '2026-11-17T00:00:00.000Z', 0)`).run();
  const pulled = await readCouncilDecisions({ DB: db as never }, "xauusd-moderator", {}) as any;
  const u = pulled.updates.find((x: any) => x.proposal_id === drafts.shadow_arm.proposal_id);
  assert.deepEqual([u.state, u.refs.intent_id, u.draft], ["handed_off", sa.handoff_ref,
    { kind: "shadow_arm", target: "key_level", params: { confirmation: "close" }, measurement: { metric: "m", baseline: 0.1, window: "14d", success_threshold: 0.05 }, requires: ["owner_confirm", "shadow_window", "owner_click_to_promote"] }]);
  assert.ok(!JSON.stringify(pulled).includes("price"));
  assert.deepEqual(events(db, "proposal.confirmed").map((e) => e.path).sort(), ["consensus", "evolver", "orchestrator", "xauusd"]);
  await assert.rejects(confirm("repository_task"), (e: any) => e.code === "not_a_draft", "decided once");
});

test("T4. the routes: operators read; only the owner confirms or rejects; the Supervisor proposes set_policy_parameter once a cycle", async () => {
  const db = migratedDb();
  const env: any = baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL });
  const p = tp("repository_task");
  await insertDraft(db as never, p, "owner:owner@example.com", Date.now());
  const list = await call(kernel, env, req("GET", "/v1/proposals", undefined, OPERATOR_JWT));
  assert.deepEqual([list.status, list.body.proposals.length, list.body.proposals[0].proposal_id], [200, 1, p.proposal_id]);
  assert.equal((await call(kernel, env, req("GET", `/v1/proposals/${p.proposal_id}`, undefined, OPERATOR_JWT))).body.state, "draft");
  assert.equal((await call(kernel, env, req("POST", `/v1/proposals/${p.proposal_id}/confirm`, {}, OPERATOR_JWT))).status, 403);
  const rej = await call(kernel, env, req("POST", `/v1/proposals/${p.proposal_id}/reject`, { reason: "not now" }, APPROVER_JWT));
  assert.deepEqual([rej.status, rej.body.state, rej.body.reason], [200, "rejected", "not now"]);
  assert.equal((await call(kernel, env, req("GET", "/v1/proposals/tp_nothex", undefined, OPERATOR_JWT))).status, 404);
  const sup = readFileSync(new URL("../../ai-kernel/src/supervisor.ts", import.meta.url), "utf8");
  assert.match(sup, /proposeConsensus\(\{ action: "set_policy_parameter", target: next\.target, params: \{ value: next\.value, typed_proposal: next\.proposal_id \} \}\)/);
  const council = readFileSync(new URL("../../ai-kernel/src/council.ts", import.meta.url), "utf8");
  assert.match(council, /await insertDraft\(env\.DB, draftFromCouncil\(newProposalId\(\), s\.session_id, opt, decision\.proposal_draft as never\), `owner:\$\{actor\}`, now\)/);
  const proposals = readFileSync(new URL("../../ai-kernel/src/proposals.ts", import.meta.url), "utf8");
  for (const imp of proposals.matchAll(/^import [\s\S]*? from "([^"]+)";/gm)) assert.doesNotMatch(imp[1], /consensus|syscall|executor|recovery|deploy|merge|forge|ai-engine/, imp[1]);
  assert.doesNotMatch(proposals, /consensus\.propose|\.syscall\(|\.dispatch\(|POLICY\.evaluate/, "the module never proposes or executes");
});
