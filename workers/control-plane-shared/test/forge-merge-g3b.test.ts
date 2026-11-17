// ADR-0012 G3b (owner 2026-11-13, "kejar cut-over hari ini"): the Forge merges a change request into canonical main
// after a consensus merge_change (routine paths) or merge_owner_change and the owner's click (guard paths). Nothing
// merges while the merge path is github (migration 0057's default).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { APPROVER_EMAIL, baseEnv, fakeAi, migratedDb } from "./harness.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { MERGE_ACTIONS, castVote, mergeVote, type Evidence } from "../src/consensus-rules.ts";
import { mergePath, type ChangeEvidence } from "../src/merge-path.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";
import { ownerDecide } from "../../ai-kernel/src/consensus.ts";
import { runCycle } from "../../ai-kernel/src/supervisor.ts";
import { changeState, mergeForConsensus } from "../../forge/src/consensus-merge.ts";
import { MAIN_NOT_FIRST_PARENT } from "../../forge/src/changes.ts";
import { FLUSH, ZERO_SHA, forgeMerge, pktLine, type Fetch } from "../../forge/src/merge.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const HOST = "a".repeat(32) + ".artifacts.cloudflare.net";
const remoteOf = (repo: string) => `https://${HOST}/git/cryptophys/${repo}.git`;
const C0 = "0".repeat(39) + "1";
const M = "1".repeat(40);   // canonical main
const H = "2".repeat(40);   // the change request's head, a child of M
const X = "3".repeat(40);   // a head that does not contain M
const S = "4".repeat(40);   // `git merge main` on X: main is the SECOND parent (the incident of 2026-11-14)
const F = "5".repeat(40);   // the same merge with main as the FIRST parent
const COMMITS: Record<string, string[]> = { [C0]: [], [M]: [C0], [H]: [M], [X]: [C0], [S]: [X, M], [F]: [M, X] };
const CR = "fg-claude-x";
const text = (u: Uint8Array) => new TextDecoder().decode(u);

/** A one-object pack that verifyPack accepts (header, a byte, the SHA-1 trailer). */
function dummyPack(): Uint8Array {
  const body = Buffer.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 1, 0x30]);
  return Buffer.concat([body, createHash("sha1").update(body).digest()]);
}

/** Smart HTTP for upload-pack and receive-pack over `refs` (repo -> ref -> sha); records receive-pack updates. */
function gitWorld(refs: Record<string, Record<string, string>>) {
  const pushes: Array<{ repo: string; ref: string; from: string; to: string; packed: boolean }> = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = String(input);
    const m = /^https:\/\/[0-9a-f]{32}\.artifacts\.cloudflare\.net\/git\/cryptophys\/([a-z-]+)\.git\/(info\/refs\?service=(git-receive-pack|git-upload-pack)|git-receive-pack|git-upload-pack)$/.exec(url);
    const repo = m ? refs[m[1]] : undefined;
    if (!m || !repo) return new Response("not found", { status: 404 });
    if (m[2].startsWith("info/refs")) {
      const service = m[3];
      const entries = Object.entries(repo);
      const caps = service === "git-receive-pack" ? "report-status delete-refs" : "ofs-delta";
      const lines = entries.map(([ref, sha], i) => pktLine(i === 0 ? `${sha} ${ref}\0${caps}\n` : `${sha} ${ref}\n`));
      return new Response(Buffer.concat([pktLine(`# service=${service}\n`), FLUSH, ...lines, FLUSH]), { headers: { "content-type": `application/x-${service}-advertisement` } });
    }
    const body = new Uint8Array(init!.body as Uint8Array);
    if (m[2] === "git-upload-pack") {
      return new Response(Buffer.concat([pktLine("NAK\n"), dummyPack()]), { headers: { "content-type": "application/x-git-upload-pack-result" } });
    }
    const len = parseInt(text(body.subarray(0, 4)), 16);
    const [from, to, ref] = text(body.subarray(4, len)).split("\0")[0].split(" ");
    const packed = body.length > len + 4 + 32;
    let report: string[];
    if ((repo[ref] ?? ZERO_SHA) !== from) report = ["unpack ok\n", `ng ${ref} stale info\n`];
    else { if (to === ZERO_SHA) delete repo[ref]; else repo[ref] = to; pushes.push({ repo: m[1], ref, from, to, packed }); report = ["unpack ok\n", `ok ${ref}\n`]; }
    return new Response(Buffer.concat([...report.map((l) => pktLine(l)), FLUSH]), { headers: { "content-type": "application/x-git-receive-pack-result" } });
  };
  const binding = {
    get: async (name: string) => ({
      info: async () => ({ remote: remoteOf(name) }),
      createToken: async () => ({ plaintext: "art_v1_TOKEN?expires=1", expiresAt: 1 }),
      log: async (o: { ref?: string }) => { const sha = refs[name]?.[`refs/heads/${o?.ref ?? "main"}`]; return sha ? [{ hash: sha }] : []; },
      readCommit: async (sha: string) => (COMMITS[sha] ? { hash: sha, treeHash: "f".repeat(40), parents: COMMITS[sha] } : null),
      readTree: async () => [], readBlob: async () => null,
    }),
  };
  return { fetchImpl, binding, pushes, refs };
}

async function seedChange(db: any, head = H, critical: string[] = []) {
  const now = new Date().toISOString();
  db.raw.prepare(
    `INSERT INTO forge_change_requests (cr_id, number, branch, source_branch, title, author, head_sha, base_sha, github_ci, status, created_at, updated_at, source, repo, blocked_reason, changed_paths, critical)
     VALUES (?, 0, 'claude/x', 'claude/x', 't', 'a', ?, ?, NULL, 'open', ?, ?, 'forge', 'platform-work', NULL, '["M workers/forge/src/x.ts"]', ?)`,
  ).run(CR, head, M, now, now, JSON.stringify(critical));
  const steps = JSON.stringify({ typecheck: { status: "passed", errors: 0, build_id: "b", console_build: { status: "passed" } } });
  db.raw.prepare("INSERT INTO forge_check_runs (commit_sha, status, runner, started_at, guard_status, steps) VALUES (?, 'passed', 'forge-runner/1', ?, 'clean', ?)").run(head, now, steps);
}

function kernelEnv(db: any, forgeEnv: any, fetchImpl: Fetch) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, { APPROVER_IDENTITIES: APPROVER_EMAIL }),
    AI: fakeAi({ response: "not json" }),
    POLICY: { evaluate: async (input: Record<string, unknown>) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as never, p); } },
    RECOVERY: { propose: async () => ({}) },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    FORGE_MERGE: {
      changeState: (id: string) => changeState(forgeEnv, id),
      mergeForConsensus: (p: string, d: string, id: string, params: Record<string, unknown>) => mergeForConsensus(forgeEnv, p, d, id, params, fetchImpl),
    },
  };
  return env;
}

const evidence = (change: ChangeEvidence | null): Evidence => ({
  agents_enabled: true, audit_valid: true, services: {}, registry: {}, agents: {}, critical_reports_24h: 0, executing_plan_targets: [], recent_same: 0, change,
});
const ready: ChangeEvidence = { cr_id: CR, status: "open", source: "forge", head_sha: H, verdict: "would_merge", reasons: [], main_sha: M, contains_main: true };

test("M1. the vote: every voter approves only an open platform-work request at the proposed head, containing main, with the verdict its action needs", () => {
  const p = (action: string, head = H) => ({ action, target: CR, params: { head_sha: head }, class: action === "merge_change" ? "routine" as const : "critical" as const });
  assert.deepEqual(mergeVote(p("merge_change"), evidence(ready))?.vote, "approve");
  for (const [change, why] of [
    [null, /did not report/], [{ ...ready, status: "merged" }, /merged/], [{ ...ready, source: "github" }, /platform-work/],
    [{ ...ready, contains_main: false }, /fast-forward/], [{ ...ready, verdict: "pending" }, /verdict is pending/], [{ ...ready, cr_id: "fg-other" }, /another change/],
  ] as const) {
    const v = mergeVote(p("merge_change"), evidence(change as never))!;
    assert.equal(v.vote, "reject"); assert.match(v.reason, why);
  }
  assert.match(mergeVote(p("merge_change", X), evidence(ready))!.reason, /head moved/);
  assert.equal(mergeVote(p("merge_owner_change"), evidence(ready))!.vote, "reject", "a routine verdict is not an owner merge");
  assert.equal(mergeVote(p("merge_owner_change"), evidence({ ...ready, verdict: "needs_owner" }))!.vote, "approve");
  assert.equal(mergeVote({ action: "deploy_commit", target: "x", params: {}, class: "routine" }, evidence(ready)), null);
  for (const voter of ["platform-registry", "drift-detector", "policy-engine", "deployment-orchestrator", "supervisor", "auditor"] as const) {
    assert.equal(castVote(voter, p("merge_change", X), evidence(ready)).vote, "reject", voter);
  }
  assert.deepEqual([...MERGE_ACTIONS].sort(), ["merge_change", "merge_owner_change"]);
});

test("M2. migration 0057 keeps GitHub merging: the Policy Engine vetoes a merge until the cut-over flips the path", async () => {
  const db = migratedDb();
  assert.equal(await mergePath(db as never), "forge", "migration 0058 (the cut-over) flipped it");
  db.raw.prepare("UPDATE forge_controls SET value = 'github' WHERE control = 'merge_path'").run();
  assert.equal(await mergePath(db as never), "github");
  const env = baseEnv("cryptophys-policy-engine", db);
  const ask = () => decide(env as never, parsePolicyRequest({ subject: "agent:supervisor", action: "consensus.execute", resource: `merge_change:${CR}`, context: { class: "routine", passed: true } }) as never);
  const before = await ask();
  assert.equal(before.decision, "deny"); assert.match(before.reason, /merge_path_forge/);
  db.raw.prepare("UPDATE forge_controls SET value = 'forge' WHERE control = 'merge_path'").run();
  assert.equal((await ask()).decision, "allow");
});

test("M3. end to end: the Supervisor proposes, the council and the Policy Engine pass it, the Forge fast-forwards canonical main, once", async () => {
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  await seedChange(db);
  const g = gitWorld({ platform: { "refs/heads/main": M }, "platform-work": { "refs/heads/main": M, "refs/heads/claude/x": H } });
  const forgeEnv = { DB: db, ARTIFACTS: g.binding };
  const env = kernelEnv(db, forgeEnv, g.fetchImpl);
  db.raw.prepare("UPDATE forge_controls SET value = 'github' WHERE control = 'merge_path'").run();
  const mem = new Map<string, unknown>();
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, v); } };

  // While the path is github, nothing is proposed.
  await runCycle(env as never, memory, "scheduled", Date.now());
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM consensus_proposals WHERE action LIKE 'merge%'").get() as any).n, 0);

  db.raw.prepare("UPDATE forge_controls SET value = 'forge' WHERE control = 'merge_path'").run();
  await runCycle(env as never, memory, "scheduled", Date.now());
  const p = db.raw.prepare("SELECT * FROM consensus_proposals WHERE action = 'merge_change'").get() as any;
  assert.equal(p.status, "executed", p.outcome_json);
  assert.equal(JSON.parse(p.evidence_json).change.verdict, "would_merge");
  assert.equal(g.refs.platform["refs/heads/main"], H, "canonical main is the head");
  assert.deepEqual(g.pushes.map((x) => [x.repo, x.ref, x.from, x.to, x.packed]), [
    ["platform", `refs/heads/cr/${CR}`, ZERO_SHA, H, true],   // the head's objects, copied with a pack
    ["platform", "refs/heads/main", M, H, false],               // then the fast-forward (no new objects)
  ]);
  const row = db.raw.prepare("SELECT status, merge_sha, verdict_at_outcome, agrees FROM forge_change_requests WHERE cr_id = ?").get(CR) as any;
  assert.deepEqual({ ...row }, { status: "merged", merge_sha: H, verdict_at_outcome: "would_merge", agrees: null });
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE event_type = 'forge.merged' AND subject = ?").get(CR) as any).n, 1);

  // Nothing is proposed again for a merged request.
  await runCycle(env as never, memory, "scheduled", Date.now());
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM consensus_proposals WHERE action LIKE 'merge%'").get() as any).n, 1);
});

test("M4. a guard-path change waits for the owner's click (merge_owner_change); after it, the Forge merges", async () => {
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  db.raw.prepare("UPDATE forge_controls SET value = 'forge' WHERE control = 'merge_path'").run();
  await seedChange(db, H, ["policy_engine: workers/policy-engine/src/index.ts"]);
  const g = gitWorld({ platform: { "refs/heads/main": M }, "platform-work": { "refs/heads/claude/x": H } });
  const env = kernelEnv(db, { DB: db, ARTIFACTS: g.binding }, g.fetchImpl);
  const r = await syscall(env as never, "supervisor", "consensus.propose", { action: "merge_owner_change", target: CR, params: { head_sha: H } });
  assert.equal(r.outcome, "succeeded");
  const p = db.raw.prepare("SELECT * FROM consensus_proposals WHERE action = 'merge_owner_change'").get() as any;
  assert.equal(p.status, "pending_owner", p.outcome_json);
  assert.equal(g.refs.platform["refs/heads/main"], M, "nothing moves before the click");
  await ownerDecide(env as never, p.proposal_id, "approve", APPROVER_EMAIL, "reviewed");
  assert.equal(g.refs.platform["refs/heads/main"], H);
  assert.equal((db.raw.prepare("SELECT status FROM forge_change_requests WHERE cr_id = ?").get(CR) as any).status, "merged");
});

test("M5. the executor never trusts the caller: no passed proposal, a moved head or a head without main is refused and audited", async () => {
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  db.raw.prepare("UPDATE forge_controls SET value = 'forge' WHERE control = 'merge_path'").run();
  await seedChange(db, X);
  const g = gitWorld({ platform: { "refs/heads/main": M }, "platform-work": { "refs/heads/claude/x": X } });
  const forgeEnv = { DB: db, ARTIFACTS: g.binding };
  await assert.rejects(mergeForConsensus(forgeEnv as never, "cns_00000000-0000-4000-8000-000000000000", "dec_00000000-0000-4000-8000-000000000000", CR, { head_sha: X }, g.fetchImpl), /not_a_merge_proposal/);
  // Through the council: X does not contain main, so every voter rejects and nothing runs.
  const env = kernelEnv(db, forgeEnv, g.fetchImpl);
  await syscall(env as never, "supervisor", "consensus.propose", { action: "merge_change", target: CR, params: { head_sha: X } });
  const p = db.raw.prepare("SELECT status FROM consensus_proposals WHERE action = 'merge_change'").get() as any;
  assert.equal(p.status, "rejected");
  assert.equal(g.pushes.length, 0);
  // The canonical repository is refused to forgeMerge without the executor's flag.
  assert.equal((await forgeMerge(g.binding as never, "platform", { base: M, head: H }, g.fetchImpl)).reason, "canonical_not_enabled");
});

test("M6. wiring: the kernel binds the Forge's MergeRpc; the Console offers the owner's click; the docs name the switch", () => {
  assert.match(read("workers/ai-kernel/wrangler.toml"), /binding = "FORGE_MERGE"\nservice = "cryptophys-forge"\nentrypoint = "MergeRpc"/);
  assert.match(read("workers/forge/src/worker.ts"), /export class MergeRpc extends WorkerEntrypoint/);
  assert.match(read("workers/console/ui/src/pages/Consensus.tsx"), /"merge_owner_change"/);
  assert.match(read("docs/GITHUB-CUTOVER.md"), /forge_controls\.merge_path/);
});

test("M7. the linear-history guard (incident 2026-11-14): main merged in as the second parent is never proposed, voted or fast-forwarded", async () => {
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  db.raw.prepare("UPDATE forge_controls SET value = 'forge' WHERE control = 'merge_path'").run();
  // A row registered without the stored reason (before 0071, or before main moved): the live state still blocks it.
  await seedChange(db, S);
  const g = gitWorld({ platform: { "refs/heads/main": M }, "platform-work": { "refs/heads/main": M, "refs/heads/claude/x": S } });
  const forgeEnv = { DB: db, ARTIFACTS: g.binding };
  const state = (await changeState(forgeEnv as never, CR))!;
  assert.deepEqual([state.verdict, state.reasons, state.contains_main, state.main_sha], ["blocked", [MAIN_NOT_FIRST_PARENT], true, M]);
  assert.match(mergeVote({ action: "merge_change", target: CR, params: { head_sha: S }, class: "routine" }, evidence(state))!.reason, /verdict is blocked/);

  // The Supervisor reads the live state and proposes nothing for it.
  const mem = new Map<string, unknown>();
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, v); } };
  let reads = 0;
  const counting = (e: Record<string, unknown>, fe: unknown) => ({ ...e, FORGE_MERGE: { ...(e.FORGE_MERGE as object), changeState: async (id: string) => { reads++; return changeState(fe as never, id); } } });
  const env = kernelEnv(db, forgeEnv, g.fetchImpl);
  await runCycle(counting(env, forgeEnv) as never, memory, "scheduled", Date.now());
  assert.equal(reads, 1, "read, then skipped: its verdict is blocked");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM consensus_proposals WHERE action LIKE 'merge%'").get() as any).n, 0);
  // Proposed by hand anyway: every voter rejects it and nothing is pushed.
  await syscall(env as never, "supervisor", "consensus.propose", { action: "merge_change", target: CR, params: { head_sha: S } });
  assert.equal((db.raw.prepare("SELECT status FROM consensus_proposals WHERE action = 'merge_change'").get() as any).status, "rejected");
  assert.equal(g.pushes.length, 0);
  assert.equal(g.refs.platform["refs/heads/main"], M);
  // The fast-forward itself refuses it, even with the executor's flag.
  assert.equal((await forgeMerge(g.binding as never, "platform", { base: M, head: S }, g.fetchImpl, { canonical: true })).reason, "main_not_first_parent");
  assert.equal((await forgeMerge(g.binding as never, "platform", { base: M, head: X }, g.fetchImpl, { canonical: true })).reason, "not_fast_forward");

  // A row the Forge stored as refused (history_blocked_reason, migration 0071) is not even read by the Supervisor.
  const db2 = migratedDb();
  db2.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  db2.raw.prepare("UPDATE forge_controls SET value = 'forge' WHERE control = 'merge_path'").run();
  await seedChange(db2, S);
  db2.raw.prepare("UPDATE forge_change_requests SET history_blocked_reason = 'main_not_first_parent' WHERE cr_id = ?").run(CR);
  const forgeEnv2 = { DB: db2, ARTIFACTS: g.binding };
  reads = 0;
  await runCycle(counting(kernelEnv(db2, forgeEnv2, g.fetchImpl), forgeEnv2) as never, memory, "scheduled", Date.now());
  assert.equal(reads, 0);
  assert.equal((db2.raw.prepare("SELECT COUNT(*) AS n FROM consensus_proposals WHERE action LIKE 'merge%'").get() as any).n, 0);
  assert.deepEqual((await changeState(forgeEnv2 as never, CR))!.reasons, [MAIN_NOT_FIRST_PARENT], "the stored and the live reason are the same, once");
});

test("M8. the same merge with main as the first parent passes the guard and merges by consensus", async () => {
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  db.raw.prepare("UPDATE forge_controls SET value = 'forge' WHERE control = 'merge_path'").run();
  await seedChange(db, F);
  const g = gitWorld({ platform: { "refs/heads/main": M }, "platform-work": { "refs/heads/main": M, "refs/heads/claude/x": F } });
  const forgeEnv = { DB: db, ARTIFACTS: g.binding };
  const state = (await changeState(forgeEnv as never, CR))!;
  assert.deepEqual([state.verdict, state.contains_main], ["would_merge", true]);
  const mem = new Map<string, unknown>();
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, v); } };
  await runCycle(kernelEnv(db, forgeEnv, g.fetchImpl) as never, memory, "scheduled", Date.now());
  const p = db.raw.prepare("SELECT * FROM consensus_proposals WHERE action = 'merge_change'").get() as any;
  assert.equal(p.status, "executed", p.outcome_json);
  assert.equal(g.refs.platform["refs/heads/main"], F, "main fast-forwards; its previous head M stays its first parent");
});

test("M9. a merge the council rejected while a critical report held the brake is proposed again once the brake is off (2026-11-16)", async () => {
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  db.raw.prepare("UPDATE forge_controls SET value = 'forge' WHERE control = 'merge_path'").run();
  await seedChange(db);
  const g = gitWorld({ platform: { "refs/heads/main": M }, "platform-work": { "refs/heads/main": M, "refs/heads/claude/x": H } });
  const env = kernelEnv(db, { DB: db, ARTIFACTS: g.binding }, g.fetchImpl);
  const mem = new Map<string, unknown>();
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, v); } };
  const merges = () => db.raw.prepare("SELECT status, json_extract(evidence_json, '$.critical_reports_24h') AS crit FROM consensus_proposals WHERE action = 'merge_change' ORDER BY created_at").all() as any[];
  const backdate = () => db.raw.prepare("UPDATE consensus_proposals SET created_at = ? WHERE action = 'merge_change'").run(new Date(Date.now() - 2 * 3_600_000).toISOString());

  // The brake holds: an open critical report. The council rejects the merge.
  db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, created_at) VALUES ('rpt_brake', 'deployment-orchestrator', 'platform_digest', 'critical', 'deploy failed', '{}', 'deterministic', ?)").run(new Date().toISOString());
  await runCycle(env as never, memory, "scheduled", Date.now());
  assert.deepEqual(merges().map((r) => [r.status, r.crit > 0]), [["rejected", true]]);
  assert.notEqual(g.refs.platform["refs/heads/main"], H, "nothing merged under the brake");

  // Still braked, an hour later: not proposed again.
  backdate();
  await runCycle(env as never, memory, "scheduled", Date.now());
  assert.equal(merges().length, 1, "not while the brake holds");

  // The owner acknowledges: the same head is proposed again and merges.
  db.raw.prepare("DELETE FROM agent_reports WHERE report_id = 'rpt_brake'").run();
  await runCycle(env as never, memory, "scheduled", Date.now());
  assert.deepEqual(merges().map((r) => r.status), ["rejected", "executed"]);
  assert.equal(g.refs.platform["refs/heads/main"], H);
});

test("M10. a merge the council rejected without the brake (evidence critical_reports_24h 0) is not proposed again for the same head", async () => {
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  db.raw.prepare("UPDATE forge_controls SET value = 'forge' WHERE control = 'merge_path'").run();
  await seedChange(db);
  const g = gitWorld({ platform: { "refs/heads/main": M }, "platform-work": { "refs/heads/main": M, "refs/heads/claude/x": H } });
  const env = kernelEnv(db, { DB: db, ARTIFACTS: g.binding }, g.fetchImpl);
  const mem = new Map<string, unknown>();
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, v); } };
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES ('cns_old', 'supervisor', 'merge_change', ?, 'routine', ?, ?, 'deploy', 8, 0, 8, 0, 'deny', 'rejected', '{"executed":false}', ?, ?)`)
    .run(CR, JSON.stringify({ head_sha: H }), JSON.stringify({ critical_reports_24h: 0 }), new Date(Date.now() - 2 * 3_600_000).toISOString(), new Date(Date.now() - 2 * 3_600_000).toISOString());
  await runCycle(env as never, memory, "scheduled", Date.now());
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM consensus_proposals WHERE action = 'merge_change'").get() as any).n, 1, "a real rejection stands for that head");
});

/** A merge_owner_change for another request, waiting for the owner's click since `createdAt`. */
function seedOwnerWaiting(db: any, createdAt: string, status = "pending_owner") {
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed, policy_decision, status, outcome_json, created_at, decided_at)
    VALUES ('cns_owner', 'supervisor', 'merge_owner_change', 'fg-claude-guarded', 'critical', ?, '{}', 'deploy', 8, 8, 0, 1, 'allow', ?, NULL, ?, ?)`)
    .run(JSON.stringify({ head_sha: X }), status, createdAt, createdAt);
}

test("M11. while a merge_owner_change waits for the owner's click, no other request is proposed for merge (2026-11-17, cns_c2470c88)", async () => {
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  db.raw.prepare("UPDATE forge_controls SET value = 'forge' WHERE control = 'merge_path'").run();
  await seedChange(db);
  const g = gitWorld({ platform: { "refs/heads/main": M }, "platform-work": { "refs/heads/main": M, "refs/heads/claude/x": H } });
  const env = kernelEnv(db, { DB: db, ARTIFACTS: g.binding }, g.fetchImpl);
  const mem = new Map<string, unknown>();
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, v); } };
  const merges = () => (db.raw.prepare("SELECT COUNT(*) AS n FROM consensus_proposals WHERE action = 'merge_change'").get() as any).n;
  seedOwnerWaiting(db, new Date(Date.now() - 30 * 60_000).toISOString());

  const held = await runCycle(env as never, memory, "scheduled", Date.now()) as any;
  assert.equal(merges(), 0, "held while the owner's merge waits");
  assert.equal(g.refs.platform["refs/heads/main"], M, "main does not move under the owner's pending merge");
  assert.ok(JSON.stringify(held).includes("waits for the owner's click"), "the hold is reported");

  // Also while the owner's merge is executing.
  db.raw.prepare("UPDATE consensus_proposals SET status = 'executing' WHERE proposal_id = 'cns_owner'").run();
  await runCycle(env as never, memory, "scheduled", Date.now());
  assert.equal(merges(), 0, "held while the owner's merge executes");

  // The owner's merge is done: the routine request is proposed and merges.
  db.raw.prepare("UPDATE consensus_proposals SET status = 'executed' WHERE proposal_id = 'cns_owner'").run();
  await runCycle(env as never, memory, "scheduled", Date.now());
  assert.equal(merges(), 1);
  assert.equal(g.refs.platform["refs/heads/main"], H);
});

test("M12. a merge_owner_change past the 24 h owner window holds nothing", async () => {
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = 'deploy' WHERE control = 'mode'").run();
  db.raw.prepare("UPDATE forge_controls SET value = 'forge' WHERE control = 'merge_path'").run();
  await seedChange(db);
  const g = gitWorld({ platform: { "refs/heads/main": M }, "platform-work": { "refs/heads/main": M, "refs/heads/claude/x": H } });
  const env = kernelEnv(db, { DB: db, ARTIFACTS: g.binding }, g.fetchImpl);
  const mem = new Map<string, unknown>();
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, v); } };
  seedOwnerWaiting(db, new Date(Date.now() - 25 * 3_600_000).toISOString());
  await runCycle(env as never, memory, "scheduled", Date.now());
  assert.equal(g.refs.platform["refs/heads/main"], H, "an expired owner window does not block the routine merge");
});
