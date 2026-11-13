// ADR-0012 gates 5 and 6 (2026-11-13): the Forge copies a change request's head between Artifacts repositories
// (transfer.ts) so forge-sourced requests get a type-check, and runs the G3a merge spike until it has succeeded.
// Interoperability with the real Artifacts Git server was proven by hand on 2026-11-13 (platform-work: a pack of
// 11 objects / 16 KB with `have <main>`, 5,466 objects / 10 MB without; receive-pack accepted the pack).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migratedDb } from "./harness.ts";
import { uploadPackRequest } from "../../forge/src/git-backup.ts";
import { FLUSH, ZERO_SHA, pktLine, receivePackBody } from "../../forge/src/merge.ts";
import { SPIKE_RETRY_MS, mergeSpikeUntilProven } from "../../forge/src/merge.ts";
import { CANONICAL_CR_BRANCH, copyCommit, crSourcesTick, typecheckBranch } from "../../forge/src/transfer.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const text = (u: Uint8Array) => new TextDecoder().decode(u);

test("T1. upload-pack request: wants, a flush, the haves (deduplicated, never the want), then done", () => {
  const body = text(uploadPackRequest([A], ["ofs-delta"], [B, B]));
  const p = (s: string) => text(pktLine(s));
  assert.equal(body, p(`want ${A} ofs-delta\n`) + "0000" + p(`have ${B}\n`) + p("done\n"));
  assert.equal(text(uploadPackRequest([A], [])), p(`want ${A}\n`) + "0000" + p("done\n"), "a full clone sends no haves");
  assert.equal(text(uploadPackRequest([A], [], [A])), p(`want ${A}\n`) + "0000" + p("done\n"), "a have equal to a want is never sent");
  assert.throws(() => uploadPackRequest([A], [], ["nope"]), /invalid_haves/);
});

test("T2. receive-pack carries the given pack after the command; a delete carries none", async () => {
  const pack = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 9, 9]);
  const body = await receivePackBody({ from: ZERO_SHA, to: A, ref: "refs/heads/cr/fg-x" }, pack);
  assert.deepEqual([...body.subarray(body.length - pack.length)], [...pack]);
  assert.ok(text(body).includes(`${ZERO_SHA} ${A} refs/heads/cr/fg-x`));
  const del = await receivePackBody({ from: A, to: ZERO_SHA, ref: "refs/heads/x" });
  assert.ok(text(del).endsWith(text(FLUSH)), "a delete ends with the flush (no pack)");
});

test("T3. the canonical repository: only cr/fg-* branches, never main; nothing is read or pushed when refused", async () => {
  let touched = 0;
  const binding = { get: async () => { touched++; throw new Error("must not be reached"); } } as never;
  const fetchImpl = async () => { touched++; throw new Error("must not be reached"); };
  for (const branch of ["main", "cr/290", "release", "cr/fg-", "claude/x"]) {
    const r = await copyCommit(binding, { source: "platform-work", target: "platform", sha: A, branch }, fetchImpl as never);
    assert.equal(r.outcome, "refused", branch);
  }
  assert.equal((await copyCommit(binding, { source: "platform", target: "platform", sha: A, branch: "cr/fg-x" }, fetchImpl as never)).reason, "same_repository");
  assert.equal((await copyCommit(binding, { source: "platform-work", target: "platform", sha: ZERO_SHA, branch: "cr/fg-x" }, fetchImpl as never)).reason, "invalid_sha");
  assert.equal(touched, 0);
  assert.ok(CANONICAL_CR_BRANCH.test(typecheckBranch("fg-claude-gracious-brown-tkc4e8")));
});

test("T4. cr_sources: open, unblocked forge requests without a type-check report; one copy per tick, audited", async () => {
  const db = migratedDb();
  const now = new Date().toISOString();
  const row = (id: string, head: string, blocked: string | null) => db.prepare(
    `INSERT INTO forge_change_requests (cr_id, number, branch, source_branch, title, author, head_sha, base_sha, github_ci, status, created_at, updated_at, source, repo, blocked_reason)
     VALUES (?, 0, ?, ?, 't', 'a', ?, ?, NULL, 'open', ?, ?, 'forge', 'platform-work', ?)`,
  ).bind(id, id.slice(3).replace(/-/, "/"), id.slice(3).replace(/-/, "/"), head, A, now, now, blocked).run();
  await row("fg-claude-x", B, null);
  await row("fg-claude-stale", "c".repeat(40), "not_based_on_main");
  const copies: string[] = [];
  const repo = (name: string) => ({
    info: async () => ({ remote: `https://${"a".repeat(32)}.artifacts.cloudflare.net/git/cryptophys/${name}.git` }),
    readCommit: async () => ({ hash: B, treeHash: A }), createToken: async () => ({ plaintext: "t", expiresAt: 0 }),
  });
  const binding = { get: async (name: string) => { copies.push(name); return repo(name); } };
  // The ref discovery fails (no Git server here): the copy fails and is audited, nothing else is attempted.
  const out = await crSourcesTick({ DB: db as never, ARTIFACTS: binding as never }, (async () => new Response("no", { status: 503 })) as never);
  assert.equal(out.outcome, "checked");
  assert.deepEqual((out.results as any[]).map((r) => [r.branch, r.outcome]), [["cr/fg-claude-x", "failed"]], "the blocked request is not copied");
  const audit = (await db.prepare("SELECT subject, outcome, payload_json FROM audit_events WHERE event_type = 'forge.cr_source_copied'").all()).results as any[];
  assert.deepEqual(audit.map((a) => [a.subject, a.outcome]), [["fg-claude-x", "failed"]]);
  assert.equal(JSON.parse(audit[0].payload_json).target, "platform");
  assert.ok(!audit[0].payload_json.includes('"t"'), "no token in the audit");
});

test("T5. merge spike: run by the tick until one run succeeded; a failed run waits SPIKE_RETRY_MS", async () => {
  const db = migratedDb();
  const audit = (outcome: string, at: string) => db.prepare(
    "INSERT INTO audit_events (event_id, event_type, actor, subject, outcome, payload_json, previous_hash, event_hash, created_at) VALUES (?, 'forge.merge_spike', 'x', 'merge-spike', ?, '{}', NULL, ?, ?)",
  ).bind(`evt_${outcome}_${at}`, outcome, `h_${outcome}_${at}`, at).run();
  const never = { list: async () => { throw new Error("must not run"); }, get: async () => { throw new Error("must not run"); } };
  const now = Date.parse("2026-11-13T12:00:00.000Z");
  await audit("failed", new Date(now - 60_000).toISOString());
  assert.equal((await mergeSpikeUntilProven({ DB: db as never, ARTIFACTS: never as never }, now)).outcome, "waiting");
  await audit("succeeded", new Date(now - SPIKE_RETRY_MS * 2).toISOString());
  assert.equal((await mergeSpikeUntilProven({ DB: db as never, ARTIFACTS: never as never }, now)).outcome, "proven");
});

test("T6. wiring: the tick runs cr_sources and the spike; cr-builds reads forge requests on cr/<cr_id>", () => {
  const tick = readFileSync(new URL("../../forge/src/tick.ts", import.meta.url), "utf8");
  assert.match(tick, /step\("cr_sources", \(\) => crSourcesTick\(/);
  assert.match(tick, /step\("merge_spike", \(\) => mergeSpikeUntilProven\(/);
  const builds = readFileSync(new URL("../../forge/src/cr-builds.ts", import.meta.url), "utf8");
  assert.match(builds, /cr\.source === "forge" \? typecheckBranch\(cr\.cr_id\)/);
});
