// CB1 (owner 2026-11-28: "sementara B dulu ...", confirmed in the platform session: "comfirmed"; ADR-0014 §13): the
// Forge's data repository `council`. The ledger contract (control-plane-shared/src/council-repo.ts) and councilSync
// (forge/src/council-sync.ts): pinned to the council repository, paths sanitised, every commit checked before main
// moves, never a price, a level, a lot or a secret.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migratedDb } from "./harness.ts";
import { FLUSH, ZERO_SHA, pktLine } from "../../forge/src/merge.ts";
import { commitObject, gitObject, treeBody } from "../../forge/src/evolution.ts";
import {
  COUNCIL_REPO, MAX_FILE_BYTES, checkCouncilCommit, contentProblems, ledgerPath, ledgerText, verdictProblems,
} from "../src/council-repo.ts";
import { CREATED_EVENT, REFUSED_EVENT, SYNC_EVENT, councilRepo, councilSyncTick, ledgerOf } from "../../forge/src/council-sync.ts";

type Db = ReturnType<typeof migratedDb>;
const NOW = Date.parse("2026-11-28T04:04:00.000Z");
const HOST = `https://${"a".repeat(32)}.artifacts.cloudflare.net/git/cryptophys`;
const XAU = "cryptophys-adm/xauusd-ai-trading-assistant";
const PR = `https://github.com/${XAU}/pull/661`;
const enc = new TextEncoder();
const dec = new TextDecoder();
const read = (rel: string) => readFileSync(new URL(`../../../${rel}`, import.meta.url), "utf8");
const iso = (ms: number) => new Date(ms).toISOString();

function withModerator(db: Db): Db {
  db.raw.prepare(`INSERT OR IGNORE INTO agents (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at, voter)
    VALUES ('xauusd-moderator', 'Council moderator', 'xauusd-ai-trading-assistant', 'test', 1, '["reports.publish"]', 'enabled', NULL, 'consensus:test', ?, ?, 0)`)
    .run("2026-11-17T00:00:00.000Z", "2026-11-17T00:00:00.000Z");
  return db;
}
const BODY = {
  schema: "typed_proposal.v1", kind: "repository_task", executor: "cryptophys",
  origin: { council: "cfc_mx01aa_sess01", option_id: "atr", side: "nexus", repo: XAU, topic: "free:evaluasi-strategy" },
  chosen_by: "council", topic_approved_by: "owner:owner@example.com", session_id: "cfc_mx01aa_sess01",
  title: "Add a 15-minute volatility filter", spec: "Keep WAIT when short-term volatility spikes.",
};
function report(db: Db, body: Record<string, unknown>, at: number) {
  db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at) VALUES (?, 'xauusd-moderator', 'xauusd_digest', 'info', 'Council task', ?, 'deterministic', NULL, ?)")
    .run(`rpt_${crypto.randomUUID()}`, JSON.stringify(body), iso(at));
}
function update(db: Db, proposal: string, state: string, reason: string | null, refs: Record<string, unknown>, at: number) {
  db.raw.prepare("INSERT INTO evolution_updates_v2 (update_id, intent_id, origin, proposal_id, state, reason, refs_json, created_at) VALUES (?, ?, 'xauusd', ?, ?, ?, ?, ?)")
    .run(`evu_${crypto.randomUUID()}`, "int_0a1b2c3d4e5f", proposal, state, reason, JSON.stringify({ intent_id: "int_0a1b2c3d4e5f", ...refs }), iso(at));
}
function intent(db: Db, proposal: string) {
  db.raw.prepare(`INSERT INTO evolution_intents_v2 (intent_id, source, source_ref, origin_json, target_repo, title, spec, evidence_refs_json, state, state_reason, evolution_id, created_at, updated_at)
    VALUES ('int_0a1b2c3d4e5f', 'council', ?, ?, ?, 'Add a 15-minute volatility filter', 'x', '[]', 'in_progress', 'in_progress', NULL, ?, ?)`)
    .run(proposal, JSON.stringify({ origin: "xauusd", council: BODY.origin.council, topic: BODY.origin.topic }), XAU, iso(NOW - 3_600_000), iso(NOW - 3_600_000));
}
/** A proposal handed off by xauusd and moved on the platform. */
function seed(proposal = "cp_mx01aa_cb1") {
  const db = withModerator(migratedDb());
  report(db, { ...BODY, proposal_id: proposal, state: "handoff_pending" }, NOW - 50 * 60_000);
  report(db, { ...BODY, proposal_id: proposal, state: "handoff_pending" }, NOW - 49 * 60_000); // a retried send
  report(db, { ...BODY, proposal_id: proposal, state: "handed_off" }, NOW - 48 * 60_000);
  intent(db, proposal);
  update(db, proposal, "queued_external", "assigned to xauusd-worker", { assignee: "xauusd-worker" }, NOW - 47 * 60_000);
  update(db, proposal, "in_progress", "picked up by the worker", { assignee: "xauusd-worker" }, NOW - 40 * 60_000);
  update(db, proposal, "proposed", "proposed", { assignee: "xauusd-worker", pr_url: PR }, NOW - 30 * 60_000);
  return db;
}

/** A fake Artifacts git host for the council repository: records each push and moves the ref. */
function gitServer(refs = new Map<string, string>()) {
  const pushes: Array<{ from: string; to: string; ref: string; bytes: number }> = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    if (!url.pathname.startsWith(`/git/cryptophys/${COUNCIL_REPO}.git/`)) return new Response("wrong repo", { status: 403 });
    if (url.pathname.endsWith("/info/refs")) {
      const service = url.searchParams.get("service")!;
      const lines = [...refs].map(([r, s], i) => pktLine(`${s} ${r}${i === 0 ? "\0report-status delete-refs" : ""}\n`));
      if (!lines.length) lines.push(pktLine(`${ZERO_SHA} capabilities^{}\0report-status delete-refs\n`));
      const body = new Uint8Array(await new Blob([pktLine(`# service=${service}\n`), FLUSH, ...lines, FLUSH] as BlobPart[]).arrayBuffer());
      return new Response(body, { headers: { "content-type": `application/x-${service}-advertisement` } });
    }
    if (url.pathname.endsWith("/git-receive-pack")) {
      const bytes = new Uint8Array(await new Response(init!.body as BodyInit).arrayBuffer());
      const len = parseInt(dec.decode(bytes.subarray(0, 4)), 16);
      const [from, to, ref] = dec.decode(bytes.subarray(4, len)).split("\0")[0].trim().split(" ");
      pushes.push({ from, to, ref, bytes: bytes.length });
      refs.set(ref, to);
      return new Response(new Blob([pktLine("unpack ok\n"), pktLine(`ok ${ref}\n`), FLUSH] as BlobPart[]));
    }
    return new Response("no", { status: 404 });
  };
  return { refs, pushes, fetchImpl: fetchImpl as never };
}
/** The council repository's binding: empty, or with main holding `files` (path -> text). */
async function binding(files: Record<string, string> | null, opts: { missing?: boolean } = {}) {
  const trees = new Map<string, Array<{ name: string; mode: string; hash: string; type: "tree" | "blob" }>>();
  const blobs = new Map<string, string>();
  let main: string | null = null;
  if (files) {
    const build = async (entries: Record<string, string>): Promise<string> => {
      const here: Array<{ name: string; mode: string; hash: string; type: "tree" | "blob" }> = [];
      const dirs = new Map<string, Record<string, string>>();
      for (const [p, t] of Object.entries(entries)) {
        const i = p.indexOf("/");
        if (i < 0) { const b = await gitObject("blob", enc.encode(t)); blobs.set(b.sha, t); here.push({ name: p, mode: "100644", hash: b.sha, type: "blob" }); }
        else { const d = p.slice(0, i); dirs.set(d, { ...(dirs.get(d) ?? {}), [p.slice(i + 1)]: t }); }
      }
      for (const [d, inner] of dirs) here.push({ name: d, mode: "40000", hash: await build(inner), type: "tree" });
      const t = await gitObject("tree", treeBody(here));
      trees.set(t.sha, here);
      return t.sha;
    };
    const root = await build(files);
    main = (await commitObject(root, "c".repeat(40), "seed", "", "evo_000000000000", NOW - 7_200_000)).sha;
    trees.set(`commit:${main}`, [{ name: root, mode: "", hash: root, type: "tree" }]);
  }
  const created: string[] = [];
  const gets: string[] = [];
  let exists = !opts.missing;
  const repo = {
    info: async () => ({ remote: `${HOST}/${COUNCIL_REPO}.git` }),
    createToken: async () => ({ plaintext: "tok_write.secret?expires=1", expiresAt: 0 }),
    log: async () => (main ? [{ hash: main }] : []),
    readCommit: async (h: string) => (h === main ? { hash: h, treeHash: trees.get(`commit:${main}`)![0].hash } : null),
    readTree: async (h: string) => trees.get(h) ?? null,
    readBlob: async (h: string) => (blobs.has(h) ? new Blob([blobs.get(h)!]) : null),
  };
  return {
    created, gets,
    binding: {
      get: async (name: string) => { gets.push(name); if (!exists) throw new Error("NOT_FOUND"); return repo as never; },
      create: async (name: string) => { created.push(name); exists = true; return { name }; },
    },
    main: () => main,
  };
}
const events = (db: Db, type: string) => (db.raw.prepare("SELECT outcome, payload_json FROM audit_events WHERE event_type = ? ORDER BY rowid").all(type) as any[]).map((e) => ({ outcome: e.outcome, payload: JSON.parse(e.payload_json) }));

test("CB1-1. the writer is pinned to the council repository: platform and platform-work are refused; a missing repository is created once", async () => {
  const b = await binding(null);
  for (const name of ["platform", "platform-work", "Council", "council/../platform"]) {
    await assert.rejects(councilRepo(b.binding as never, name), /council_sync_writes_only_council/, name);
  }
  assert.deepEqual(b.gets, [], "a refused name never reaches the binding");
  const m = await binding(null, { missing: true });
  const r = await councilRepo(m.binding as never);
  assert.deepEqual([r.created, m.created, m.gets], [true, [COUNCIL_REPO], [COUNCIL_REPO, COUNCIL_REPO]]);
  const src = read("workers/forge/src/council-sync.ts");
  assert.ok(!/from "\.\/evolution\.ts"/.test(src) && !src.includes("git-write"), "not the evolver's write path");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.ok(!/CANONICAL_REPO|WORK_REPO|"platform-work"|ARTIFACTS!?\.get\(|binding\.get\((?!COUNCIL_REPO\))/.test(code), "no other repository is named or opened in code");
  assert.equal((code.match(/binding\.get\(COUNCIL_REPO\)/g) ?? []).length, 2, "the binding is opened with the constant only");
});

test("CB1-2. ledger paths: strict segments, never a dot, a slash or an empty segment", () => {
  assert.equal(ledgerPath("free:evaluasi-strategy", "cfc_mx01aa_sess01", "cp_mx01aa_cb1"), "ledger/free:evaluasi-strategy/cfc_mx01aa_sess01/cp_mx01aa_cb1.json");
  assert.equal(ledgerPath(null, null, "cp_x"), "ledger/no-topic/no-session/cp_x.json");
  for (const [t, s, p] of [["..", "s", "p"], ["a/b", "s", "p"], ["t", "..", "p"], ["t", "s", "../p"], ["t", "s", "p.json"], ["t", "s", ""], ["t", ".s", "p"], ["t", "s", "p\u0000"], ["t", "s", "pé"], ["-t", "s", "p"]] as const) {
    assert.equal(ledgerPath(t, s, p), null, `${t}/${s}/${p}`);
  }
});

test("CB1-3. ledgerOf: one file per proposal from xauusd's reports and the return path, in order, a retried send once, words only", async () => {
  const db = seed();
  const l = await ledgerOf(db, "cp_mx01aa_cb1");
  assert.ok(l);
  assert.equal(l.path, "ledger/free:evaluasi-strategy/cfc_mx01aa_sess01/cp_mx01aa_cb1.json");
  assert.deepEqual([l.file.session_id, l.file.topic, l.file.kind, l.file.chosen_by, l.file.topic_approved_by, l.file.intent_id], ["cfc_mx01aa_sess01", "free:evaluasi-strategy", "repository_task", "council", "owner:owner@example.com", "int_0a1b2c3d4e5f"]);
  assert.deepEqual(l.file.history.map((s) => [s.state, s.source, s.note ?? null, s.ref ?? null]), [
    ["handoff_pending", "xauusd", null, null], ["handed_off", "xauusd", null, null],
    ["queued_external", "platform", "assigned to xauusd-worker", null], ["in_progress", "platform", "picked up by the worker", null],
    ["proposed", "platform", null, { pr_url: PR }],
  ]);
  assert.deepEqual(checkCouncilCommit(new Map([[l.path, ledgerText(l.file)]])), []);
  // Expired with close_code; a title with a price-like number is withheld; a note with one is dropped.
  update(db, "cp_mx01aa_cb1", "expired", "expired: no progress in 7 days; returned to the council", { close_code: "expired" }, NOW - 10 * 60_000);
  update(db, "cp_mx01aa_cb1", "in_progress", "below 4095 again", {}, NOW - 9 * 60_000);
  report(db, { ...BODY, proposal_id: "cp_priced", title: "Sell below 4095", state: "handoff_pending" }, NOW - 5 * 60_000);
  const l2 = (await ledgerOf(db, "cp_mx01aa_cb1"))!;
  assert.deepEqual(l2.file.history.slice(-2).map((s) => [s.state, s.close_code ?? null, s.note ?? null]), [["expired", "expired", "expired: no progress in 7 days; returned to the council"], ["in_progress", null, null]]);
  const p = (await ledgerOf(db, "cp_priced"))!;
  assert.equal(p.file.title, "(title withheld: not words only)");
  assert.ok(!ledgerText(p.file).includes("4095"));
  assert.equal(await ledgerOf(db, "cp_unknown"), null, "no history, no file");
});

test("CB1-4. councilSync on an empty repository: one checked commit fast-forwards main from zero; audited with the cursor; then up to date", async () => {
  const db = seed();
  const b = await binding(null);
  const g = gitServer();
  const r = await councilSyncTick({ DB: db as never, ARTIFACTS: b.binding as never }, NOW, g.fetchImpl);
  assert.equal(r.outcome, "written", JSON.stringify(r));
  assert.equal(r.files, 1);
  assert.deepEqual(g.pushes.map((p) => [p.from, p.to, p.ref]), [[ZERO_SHA, r.commit, "refs/heads/main"]]);
  const ev = events(db, SYNC_EVENT);
  assert.deepEqual(ev.map((e) => [e.outcome, e.payload.commit, e.payload.files]), [["written", r.commit, ["ledger/free:evaluasi-strategy/cfc_mx01aa_sess01/cp_mx01aa_cb1.json"]]]);
  assert.match(ev[0].payload.cursor, /^2026-11-28T03:34:00\.000Z\|cp_mx01aa_cb1$/);
  assert.ok(!JSON.stringify(ev).includes("tok_write"), "the token is never audited");
  const again = await councilSyncTick({ DB: db as never, ARTIFACTS: b.binding as never }, NOW + 900_000, g.fetchImpl);
  assert.equal(again.outcome, "up_to_date");
  assert.equal(g.pushes.length, 1);
  // A new step moves the cursor: the proposal's file is rebuilt and written again, on top of main's head.
  const before = (await ledgerOf(db, "cp_mx01aa_cb1"))!;
  const b2 = await binding({ [before.path]: ledgerText(before.file) });
  const g2 = gitServer(new Map([["refs/heads/main", b2.main()!]]));
  update(db, "cp_mx01aa_cb1", "merged", "merged", { sha: "0a1b2c3d" }, NOW + 1000);
  const third = await councilSyncTick({ DB: db as never, ARTIFACTS: b2.binding as never }, NOW + 1_800_000, g2.fetchImpl);
  assert.equal(third.outcome, "written", JSON.stringify(third));
  assert.deepEqual(g2.pushes.map((p) => [p.from, p.to]), [[b2.main(), third.commit]]);
});

test("CB1-5. a file identical to main's copy is not written again (idempotent rebuild)", async () => {
  const db = seed();
  const l = (await ledgerOf(db, "cp_mx01aa_cb1"))!;
  const b = await binding({ [l.path]: ledgerText(l.file), "README.md": "council\n" });
  const g = gitServer(new Map([["refs/heads/main", b.main()!]]));
  const r = await councilSyncTick({ DB: db as never, ARTIFACTS: b.binding as never }, NOW, g.fetchImpl);
  assert.equal(r.outcome, "unchanged");
  assert.equal(g.pushes.length, 0);
  assert.deepEqual(events(db, SYNC_EVENT).map((e) => e.outcome), ["unchanged"]);
});

test("CB1-6. the commit check: only ledger files, each valid, no forbidden key, price-like number or secret, within size", () => {
  const db = seed();
  const ok = { schema: "council_ledger.v1", proposal_id: "cp_x", session_id: "s1", topic: "t1", kind: "repository_task", title: "A filter", chosen_by: "council", topic_approved_by: "owner:o@example.com", intent_id: null, history: [{ at: "2026-11-28T00:00:00.000Z", state: "handed_off", source: "xauusd" }] };
  const path = "ledger/t1/s1/cp_x.json";
  const t = (v: unknown) => JSON.stringify(v);
  assert.deepEqual(checkCouncilCommit(new Map([[path, t(ok)]])), []);
  const cases: Array<[string, string, RegExp]> = [
    // CB2a: the overlay is checked as council_policy.v1; the allowlist is never written by the sync (the owner's click).
    ["policy/overlay.json", t(ok), /not council_policy\.v1/],
    ["policy/allowlist.json", t(ok), /the allowlist changes only by the owner's click/],
    ["README.md", "x", /only ledger/],
    ["ledger/../platform/x.json", t(ok), /only ledger/],
    [path, "{", /not JSON/],
    [path, t({ ...ok, price: 1 }), /unknown key price|forbidden key/],
    [path, t({ ...ok, history: [{ ...ok.history[0], note: "entry at 4095" }] }), /price-like/],
    [path, t({ ...ok, history: [{ ...ok.history[0], note: "x", sl: 1 }] }), /forbidden key|unknown key sl/],
    [path, t({ ...ok, title: "key sk-abcdefghijklmnopqrstuvwxyzABCD" }), /secret/],
    [path, t({ ...ok, history: [{ ...ok.history[0], state: "moon" }] }), /unknown state/],
    [path, t({ ...ok, history: [{ ...ok.history[0], ref: { pr_url: "https://example.com/x" } }] }), /ref is/],
    [path, t({ ...ok, topic: "t2" }), /path does not match/],
    [path, t({ ...ok, history: [{ ...ok.history[0], at: "2026-11-28T01:00:00.000Z" }, { ...ok.history[0] }] }), /out of order/],
    [path, t({ ...ok, title: "a".repeat(MAX_FILE_BYTES) }), /over 16384 bytes/],
  ];
  for (const [p, body, re] of cases) assert.match(checkCouncilCommit(new Map([[p, body]])).join(" | "), re, `${p}: ${body.slice(0, 80)}`);
  assert.deepEqual(checkCouncilCommit(new Map()), ["the commit changes nothing"]);
  assert.deepEqual(contentProblems({ proposal_id: "cp_123456", intent_id: "int_0123456789ab", ref: { sha: "0123456789abcdef0123" }, at: "2026-11-28T00:00:00.000Z" }), [], "ids and commits are not prices");
  void db;
});

test("CB1-7. no poison pill: one refused proposal is left out and audited, the others are written, and the cursor advances", async () => {
  const db = seed("cp_good_one");
  report(db, { ...BODY, proposal_id: "cp_good_two", state: "handoff_pending" }, NOW - 20 * 60_000);
  // A history step the schema refuses (an unknown close_code from a malformed return-path row).
  report(db, { ...BODY, proposal_id: "cp_bad", state: "handoff_pending" }, NOW - 15 * 60_000);
  update(db, "cp_bad", "closed", "closed", { close_code: "vanished" }, NOW - 14 * 60_000);
  const b = await binding(null);
  const g = gitServer();
  const r = await councilSyncTick({ DB: db as never, ARTIFACTS: b.binding as never }, NOW, g.fetchImpl);
  assert.equal(r.outcome, "written", JSON.stringify(r));
  assert.equal(r.files, 2);
  assert.match(r.problems!.join(" "), /unknown close_code/);
  assert.equal(g.pushes.length, 1);
  const ref = events(db, REFUSED_EVENT);
  assert.deepEqual(ref.map((e) => e.payload.refused.map((x: any) => x.proposal_id)), [["cp_bad"]]);
  const sync = events(db, SYNC_EVENT);
  assert.deepEqual([sync[0].outcome, sync[0].payload.refused], ["written", ["cp_bad"]]);
  assert.match(sync[0].payload.cursor, /^2026-11-28T03:50:00\.000Z\|cp_bad$/, "the cursor advanced through the refused proposal, the batch's latest activity");
  // The next tick does not retry it; new activity on it does.
  assert.equal((await councilSyncTick({ DB: db as never, ARTIFACTS: b.binding as never }, NOW + 900_000, g.fetchImpl)).outcome, "up_to_date");
  update(db, "cp_bad", "closed", "closed", { close_code: "vanished" }, NOW + 1000);
  const again = await councilSyncTick({ DB: db as never, ARTIFACTS: b.binding as never }, NOW + 1_800_000, g.fetchImpl);
  assert.equal(again.outcome, "refused");
  assert.equal(events(db, REFUSED_EVENT).length, 2);
  assert.equal(g.pushes.length, 1);
});

test("CB1-7b. a repeated state is one step only when it repeats in a row: shadow, live, shadow keeps three", async () => {
  const db = withModerator(migratedDb());
  for (const [state, m] of [["shadow", 50], ["shadow", 49], ["live", 40], ["shadow", 30]] as const) report(db, { ...BODY, kind: "policy_parameter", proposal_id: "cp_knob", state }, NOW - m * 60_000);
  const l = (await ledgerOf(db, "cp_knob"))!;
  assert.deepEqual(l.file.history.map((s) => s.state), ["shadow", "live", "shadow"]);
});

test("CB1-8. the verdict schema xauusd publishes for CB2: valid and refused shapes", () => {
  const v = { schema: "council_policy_verdict.v1", proposal_id: "cp_x", session_id: "cfc_s", key: "decision.min_confidence", state: "shadow", verdict: "pass", evidence: { n: 31, mean_r: 0.42, holdout: true }, at: "2026-11-28T00:00:00.000Z" };
  assert.deepEqual(verdictProblems(v), []);
  for (const bad of [{ ...v, verdict: "maybe" }, { ...v, state: "armed" }, { ...v, key: "Risk Per Trade" }, { ...v, evidence: { n: 1, mean_r: 0.1 } }, { ...v, price: 1 }, { ...v, evidence: { n: 1, mean_r: 99, holdout: false } }]) {
    assert.ok(verdictProblems(bad).length > 0, JSON.stringify(bad));
  }
});

test("CB1-9. wiring: the Forge tick runs council_sync; the census and the Observer inventory do not enumerate Artifacts repositories", () => {
  const tick = read("workers/forge/src/tick.ts");
  assert.match(tick, /await step\("council_sync", \(\) => councilSyncTick\(env as never, nowMs\(\)\)\);/);
  // The council repository is a data repository: no Worker, no deploy unit, nothing the census compares.
  for (const f of ["workers/forge/src/census.ts", "workers/control-plane-shared/src/observer-inventory.ts"]) {
    assert.ok(!/ARTIFACTS\.list|artifacts\.list/.test(read(f)), f);
  }
});

test("CB1-10. the record: ADR-0014 §13 cites the owner, the manifest lists C4 to C6, the SSOT documents the repository", () => {
  const adr = read("architecture/adr/0014-evolution-loop.md");
  const sec = adr.slice(adr.indexOf("### 13. Amendment 2026-11-28"), adr.indexOf("## Consequences"));
  for (const s of ['"sementara B dulu', '"comfirmed"', "`council`", "council_ledger.v1", "never writes `platform` or `platform-work`", "council_policy_verdict.v1", "planned, not built"]) assert.ok(sec.includes(s), s);
  const m = JSON.parse(read("architecture/adr/progress/0014.json"));
  assert.deepEqual(m.phases.filter((p: any) => ["C4", "C5", "C6"].includes(p.id)).map((p: any) => [p.id, p.evidence.kind]), [["C4", "audit_event"], ["C5", "not_measurable_yet"], ["C6", "not_measurable_yet"]]);
  const ssot = read("docs/SSOT.md");
  assert.match(ssot.split("\n")[4], /^Last reviewed: 2026-11-16 \((?:[^\n]*; )?council repository, 2026-11-28 \(owner: "sementara B dulu/);
  assert.ok(ssot.includes("- **Council repository** (owner, 2026-11-28"));
});

// ---------------------------------------------------------------- CB2a (2026-11-28): the overlay of council-owned settings

const KNOB = "decision.min_confidence";
const ALLOW = JSON.stringify({ schema: "council_allowlist.v1", keys: { [KNOB]: { type: "number", min: 0.3, max: 0.8 } } });
function knob(db: Db, id: string, state: string, at: number, value = 0.45, from: number | null = 0.4) {
  report(db, { ...BODY, kind: "policy_parameter", executor: "xauusd", proposal_id: id, state, knob: KNOB, from, value }, at);
}
function verdict(db: Db, id: string, state: string, v: string, at: number) {
  report(db, { schema: "council_policy_verdict.v1", proposal_id: id, session_id: "cfc_mx01aa_sess01", key: KNOB, state, verdict: v, evidence: { n: 31, mean_r: 0.2, holdout: true }, at: iso(at) }, at);
}

test("CB2-1. the allowlist: typed and bounded keys; risk, arming, the ceiling, hashed or protected engines, Pine and prices are never council-owned", async () => {
  const { parseAllowlist, keyDenied } = await import("../src/council-repo.ts");
  const ok = parseAllowlist(ALLOW);
  assert.deepEqual([ok.problems, [...ok.allowlist!.keys()]], [[], [KNOB]]);
  for (const k of ["risk_per_trade", "live.arm", "profile_ceiling", "engine_hash", "protected.engines", "pine.ssot", "omega.mode", "entry.price", "Risk", "a..b"]) assert.ok(keyDenied(k) || !/^[a-z]/.test(k), k);
  const bad = parseAllowlist(JSON.stringify({ schema: "council_allowlist.v1", keys: { risk_per_trade: { type: "number", min: 0, max: 1 }, "x.y": { type: "number" }, "z.e": { type: "enum", enum: [] } } }));
  assert.deepEqual([...bad.allowlist!.keys()], []);
  assert.equal(bad.problems.length, 3);
  assert.deepEqual(parseAllowlist(null), { allowlist: null, problems: [] });
});

test("CB2-2. overlay candidates: shadow from xauusd's report, live or reverted by a verdict, reverted after 14 days in shadow with no verdict", async () => {
  const { overlayCandidates } = await import("../../forge/src/council-sync.ts");
  const db = withModerator(migratedDb());
  knob(db, "cp_k_shadow", "queued_shadow", NOW - 2 * 86_400_000);
  knob(db, "cp_k_live", "queued_shadow", NOW - 5 * 86_400_000);
  verdict(db, "cp_k_live", "live", "pass", NOW - 86_400_000);
  knob(db, "cp_k_revert", "queued_shadow", NOW - 5 * 86_400_000);
  verdict(db, "cp_k_revert", "shadow", "revert", NOW - 86_400_000);
  knob(db, "cp_k_old", "queued_shadow", NOW - 15 * 86_400_000);
  knob(db, "cp_k_draft", "draft", NOW - 86_400_000);
  const out = await overlayCandidates(db as never, NOW);
  const by = (id: string) => out.find((e) => e.proposal_id === id)!;
  assert.deepEqual([by("cp_k_shadow").state, by("cp_k_shadow").value, by("cp_k_shadow").reason], ["shadow", 0.45, undefined]);
  assert.deepEqual([by("cp_k_live").state, by("cp_k_live").reason], ["live", "verdict"]);
  assert.deepEqual([by("cp_k_revert").state, by("cp_k_revert").value, by("cp_k_revert").reason], ["reverted", 0.4, "verdict"]);
  assert.deepEqual([by("cp_k_old").state, by("cp_k_old").value, by("cp_k_old").reason, by("cp_k_old").at], ["reverted", 0.4, "expired", iso(NOW - 15 * 86_400_000 + 14 * 86_400_000)]);
  assert.equal(out.some((e) => e.proposal_id === "cp_k_draft"), false, "not in shadow yet: not a setting");
  // The expired entry is the same at every later tick (deterministic: no churn of commits).
  assert.deepEqual((await overlayCandidates(db as never, NOW + 3_600_000)).find((e) => e.proposal_id === "cp_k_old"), by("cp_k_old"));
});

test("CB2-3. the sync writes the overlay against main's allowlist; a key off the allowlist is left out, audited once, and listed in the owner's inbox", async () => {
  const { unhandledProblems } = await import("../../ai-kernel/src/owner-inbox.ts");
  const db = withModerator(migratedDb());
  knob(db, "cp_k_ok", "queued_shadow", NOW - 86_400_000);
  report(db, { ...BODY, kind: "policy_parameter", executor: "xauusd", proposal_id: "cp_k_off", state: "queued_shadow", knob: "decision.other_knob", from: 1, value: 2 }, NOW - 86_400_000);
  knob(db, "cp_k_far", "queued_shadow", NOW - 86_400_000, 0.95);
  const b = await binding({ "policy/allowlist.json": ALLOW });
  const g = gitServer(new Map([["refs/heads/main", b.main()!]]));
  const r = await councilSyncTick({ DB: db as never, ARTIFACTS: b.binding as never }, NOW, g.fetchImpl);
  assert.equal(r.outcome, "written", JSON.stringify(r));
  assert.ok(g.pushes.length === 1);
  const ev = events(db, SYNC_EVENT);
  assert.ok(ev[0].payload.files.includes("policy/overlay.json"));
  assert.deepEqual(ev[0].payload.refused.sort(), ["cp_k_far", "cp_k_off"]);
  const refusals = events(db, REFUSED_EVENT);
  assert.equal(refusals.length, 1);
  assert.match(JSON.stringify(refusals[0].payload.refused), /not on the allowlist/);
  assert.match(JSON.stringify(refusals[0].payload.refused), /outside the allowlist's type or bounds/);
  const problems = (await unhandledProblems(db as never, NOW + 60_000)).filter((p: any) => p.code === "council_sync_refused");
  assert.equal(problems.length, 1);
  assert.match(problems[0].detail, /cp_k_off|cp_k_far/);
  // The same refusals on the next tick are not audited again.
  await councilSyncTick({ DB: db as never, ARTIFACTS: b.binding as never }, NOW + 900_000, g.fetchImpl);
  assert.equal(events(db, REFUSED_EVENT).length, 1);
});

test("CB2-4. no allowlist on main: nothing is council-owned, no overlay is written; the allowlist itself is never written by the sync", async () => {
  const db = withModerator(migratedDb());
  knob(db, "cp_k_ok", "queued_shadow", NOW - 86_400_000);
  const b = await binding(null);
  const g = gitServer();
  const r = await councilSyncTick({ DB: db as never, ARTIFACTS: b.binding as never }, NOW, g.fetchImpl);
  // The proposal's ledger file is written; its setting is not (nothing is on an allowlist that does not exist).
  assert.equal(r.outcome, "written");
  const ev = events(db, SYNC_EVENT)[0].payload;
  assert.deepEqual([ev.files.includes("policy/overlay.json"), ev.files.some((f: string) => f.startsWith("ledger/")), ev.refused], [false, true, ["cp_k_ok"]]);
  assert.match(r.problems!.join(" "), /not on the allowlist/);
  const src = read("workers/forge/src/council-sync.ts");
  assert.ok(!/files\.set\(ALLOWLIST_PATH/.test(src), "the sync never writes the allowlist");
});

test("CB2-5. the overlay text is valid council_policy.v1 and the commit check refuses a forbidden key, a price, a duplicate and a reverted value", async () => {
  const { overlayText, overlayProblems, parseAllowlist } = await import("../src/council-repo.ts");
  const { allowlist } = parseAllowlist(ALLOW);
  const e = { key: KNOB, value: 0.45, from: 0.4, session_id: "cfc_s", proposal_id: "cp_a", state: "shadow" as const, since: iso(NOW - 1000), at: iso(NOW) };
  assert.deepEqual(overlayProblems(JSON.parse(overlayText([e])), allowlist), []);
  assert.match(overlayProblems(JSON.parse(overlayText([e, e])), allowlist).join(" "), /twice/);
  assert.match(overlayProblems(JSON.parse(overlayText([{ ...e, state: "reverted" }])), allowlist).join(" "), /carries its from value/);
  assert.match(overlayProblems({ schema: "council_policy.v1", entries: [{ ...e, price: 1 }] }, allowlist).join(" "), /unknown key price|forbidden key/);
  assert.match(overlayProblems({ schema: "council_policy.v1", entries: [{ ...e, key: "risk_per_trade" }] }, allowlist).join(" "), /never council-owned/);
  assert.match(checkCouncilCommit(new Map([["policy/overlay.json", overlayText([e])]]), null).join(" "), /not on the allowlist/);
});

test("CB2-6. the record: ADR-0014 §13 and the SSOT document CB2a", () => {
  assert.ok(read("architecture/adr/0014-evolution-loop.md").includes("CB2a builds the overlay"));
  const ssot = read("docs/SSOT.md");
  assert.match(ssot.split("\n")[4], /^Last reviewed: 2026-11-16 \((?:[^\n]*; )?council settings, 2026-11-28 /);
  assert.ok(ssot.includes("- **Council settings** (CB2a, 2026-11-28"));
});

// ---------------------------------------------------------------- CB3 (2026-11-28): the read-only view for the organs

test("CB3-1. the scope is the entrypoint: policy reads policy/ and ledger/, ledger reads ledger/ only; traversal and other paths are refused", async () => {
  const { councilReadFile, councilList, fileInScope, prefixInScope } = await import("../../forge/src/council-read.ts");
  const L = "ledger/free:evaluasi-strategy/cfc_mx01aa_sess01/cp_mx01aa_cb1.json";
  const b = await binding({ [L]: "{\"x\":1}\n", "policy/overlay.json": "{\"schema\":\"council_policy.v1\",\"entries\":[]}\n", "policy/allowlist.json": ALLOW, "README.md": "council\n" });
  const env = { ARTIFACTS: b.binding as never };
  const r = await councilReadFile(env, "policy", "policy/overlay.json");
  assert.deepEqual([r.available, (r as any).main_sha, (r as any).text], [true, b.main(), "{\"schema\":\"council_policy.v1\",\"entries\":[]}\n"]);
  assert.equal(((await councilReadFile(env, "ledger", L)) as any).text, "{\"x\":1}\n");
  for (const [scope, p] of [["ledger", "policy/overlay.json"], ["ledger", "policy/allowlist.json"], ["policy", "README.md"], ["policy", "ledger/../policy/overlay.json"], ["policy", "../platform/docs/SSOT.md"], ["policy", "ledger/a/b"], ["policy", 7]] as const) {
    assert.deepEqual(await councilReadFile(env, scope, p), { available: false, reason: "path_not_in_scope" }, `${scope} ${p}`);
  }
  assert.equal(fileInScope("policy", "policy/other.json"), false);
  assert.equal(((await councilReadFile(env, "policy", "ledger/t/s/cp_missing.json")) as any).text, null, "a missing file reads as null");
  const all = await councilList(env, "ledger", "ledger/");
  assert.deepEqual((all as any).paths, [L]);
  assert.deepEqual(((await councilList(env, "policy", "policy/")) as any).paths, ["policy/allowlist.json", "policy/overlay.json"]);
  for (const [scope, p] of [["ledger", "policy/"], ["ledger", "ledger/../"], ["ledger", "ledger/a/b/c/"], ["ledger", ""], ["ledger", "/"]] as const) assert.equal(prefixInScope(scope, p), false, `${scope} ${p}`);
  assert.deepEqual(((await councilList(env, "ledger", "ledger/free:evaluasi-strategy/")) as any).paths, [L]);
  // No repository or no main: available false, never another repository.
  assert.deepEqual(await councilReadFile({}, "policy", "policy/overlay.json"), { available: false, reason: "artifacts_not_configured" });
  const empty = await binding(null);
  assert.deepEqual(await councilReadFile({ ARTIFACTS: empty.binding as never }, "policy", "policy/overlay.json"), { available: false, reason: "no_main" });
  assert.deepEqual(b.gets.every((n) => n === COUNCIL_REPO), true);
});

test("CB3-2. wiring: two Forge entrypoints with read methods only, pinned to the council repository", () => {
  const worker = read("workers/forge/src/worker.ts");
  for (const cls of ["CouncilPolicyRpc", "CouncilLedgerRpc"]) {
    const at = worker.indexOf(`export class ${cls}`);
    const body = worker.slice(at, worker.indexOf("\n}\n", at) + 3);
    assert.deepEqual([...body.matchAll(/async (\w+)\(/g)].map((m) => m[1]), ["readFile", "list"], cls);
  }
  assert.match(worker, /CouncilPolicyRpc[\s\S]*councilReadFile\(this\.env as never, "policy", path\)/);
  assert.match(worker, /CouncilLedgerRpc[\s\S]*councilReadFile\(this\.env as never, "ledger", path\)/);
  const src = read("workers/forge/src/council-read.ts");
  assert.ok(src.includes("ARTIFACTS.get(COUNCIL_REPO)") && !/createToken|fastForward|receive-pack/.test(src), "read only, the council repository only");
});

test("CB3-3. the record: ADR-0014 §13 and the SSOT document the readers", () => {
  assert.ok(read("architecture/adr/0014-evolution-loop.md").includes("`CouncilPolicyRpc`"));
  const ssot = read("docs/SSOT.md");
  assert.match(ssot.split("\n")[4], /^Last reviewed: 2026-11-16 \(council readers, 2026-11-28 /);
  assert.ok(ssot.includes("- **Council readers** (CB3, 2026-11-28"));
});
