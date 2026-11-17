// ADR-0014 §11, docs/design/EVOLVER.md §6, step V4: the Forge's write path for the evolver (forge/src/evolution.ts).
// One evolution's edits become one commit on canonical main's head, pushed to evo/<evolution_id> of platform-work after
// every gate: the id and base, the three switches, the cadence, checkEdits on the base's files, and a new branch.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migratedDb } from "./harness.ts";
import { EVOLUTION_ID, MIN_START_INTERVAL_HOURS } from "../src/evolution-limits.ts";
import { indexPack } from "../../forge/src/bundle-verify.ts";
import { FLUSH, ZERO_SHA, pktLine, readPktLines } from "../../forge/src/merge.ts";
import { commitObject, gitObject, packOf, proposeEvolution, treeBody, EVOLVER_AUTHOR } from "../../forge/src/evolution.ts";
import { WORK_BRANCH, workBranchAllowed, workChangeId } from "../../forge/src/work-repo.ts";
import type { ArtifactsTreeEntry } from "../../forge/src/checks.ts";

type Db = ReturnType<typeof migratedDb>;
const enc = new TextEncoder();
const dec = new TextDecoder();
const NOW = Date.parse("2026-11-17T18:00:00.000Z");
const ID = "evo_0123456789ab";
const HOST = `https://${"a".repeat(32)}.artifacts.cloudflare.net/git/cryptophys`;

test("F1. git objects as git computes them: blob, empty tree, tree order, a commit; the pack indexes to the same ids", async () => {
  assert.equal((await gitObject("blob", enc.encode("hello\n"))).sha, "ce013625030ba8dba906f756967f9e9ca394464a", "git hash-object of hello\\n");
  assert.equal((await gitObject("tree", treeBody([]))).sha, "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "git's empty tree");
  const blob = await gitObject("blob", enc.encode("hello\n"));
  // git orders a tree named "a" as "a/", so it sorts after "a.txt" ('.' < '/') and before "a0".
  const body = dec.decode(treeBody([{ mode: "100644", name: "a0", hash: blob.sha }, { mode: "40000", name: "a", hash: blob.sha }, { mode: "100644", name: "a.txt", hash: blob.sha }]));
  assert.deepEqual([...body.matchAll(/(\d+) ([^\0]+)\0/g)].map((m) => m[2]), ["a.txt", "a", "a0"]);
  const commit = await commitObject("4b825dc642cb6eb9a060e54bf8d69288fbee4904", "b".repeat(40), "Title", "Why.", ID, NOW);
  const text = dec.decode(commit.body);
  assert.match(text, /^tree 4b825dc642cb6eb9a060e54bf8d69288fbee4904\nparent b{40}\nauthor Cryptophys Evolver <evolver@cryptophys\.work> \d+ \+0000\ncommitter Cryptophys Forge <forge@cryptophys\.work> \d+ \+0000\n\nTitle\n\nWhy\.\n\nEvolution: evo_0123456789ab\n$/);
  const big = await gitObject("blob", enc.encode("x".repeat(70_000)));
  const pack = await packOf([blob, big, commit]);
  const idx = await indexPack(pack);
  assert.equal(idx.objects, 3);
  assert.deepEqual([...idx.byId.keys()].sort(), [blob.sha, big.sha, commit.sha].sort(), "indexed ids equal the computed ids: headers, sizes and zlib are right");
});

test("F2. evo/ is a work branch the intake reads; the change request id is fg-evo-<id>", () => {
  assert.ok(WORK_BRANCH.test(`evo/${ID}`) && workBranchAllowed(`evo/${ID}`));
  assert.equal(workChangeId(`evo/${ID}`), `fg-evo-${ID}`);
  assert.ok(EVOLUTION_ID.test(ID));
});

// ---------------------------------------------------------------- a canonical repository and a fake Git server

interface Tree { [name: string]: string | Tree }
async function repoOf(files: Tree) {
  const trees = new Map<string, ArtifactsTreeEntry[]>();
  const blobs = new Map<string, string>();
  async function build(t: Tree): Promise<string> {
    const entries: ArtifactsTreeEntry[] = [];
    for (const [name, v] of Object.entries(t)) {
      if (typeof v === "string") { const b = await gitObject("blob", enc.encode(v)); blobs.set(b.sha, v); entries.push({ name, mode: "100644", hash: b.sha, type: "blob" }); }
      else entries.push({ name, mode: "40000", hash: await build(v), type: "tree" });
    }
    const o = await gitObject("tree", treeBody(entries)); trees.set(o.sha, entries); return o.sha;
  }
  const root = await build(files);
  const main = (await commitObject(root, "c".repeat(40), "base", "", "evo_000000000000", NOW - 3_600_000)).sha;
  const reader = {
    info: async () => ({ remote: `${HOST}/platform.git` }),
    createToken: async () => ({ plaintext: "tok_read.secret", expiresAt: 0 }),
    readCommit: async (h: string) => (h === main ? { hash: h, treeHash: root } : null),
    readTree: async (h: string) => trees.get(h) ?? null,
    readBlob: async (h: string) => (blobs.has(h) ? new Blob([blobs.get(h)!]) : null),
    log: async () => [{ hash: main }],
  };
  return { main, root, reader, trees };
}

function gitServer(initial: Record<string, string>) {
  const refs = new Map(Object.entries(initial));
  const pushes: Array<{ from: string; to: string; ref: string; pack: Uint8Array<ArrayBuffer> }> = [];
  const calls: string[] = [];
  const fetchImpl = async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push(`${init?.method ?? "GET"} ${url.pathname.split("/").slice(-2).join("/")}${url.search}`);
    if (url.pathname.endsWith("/info/refs")) {
      const service = url.searchParams.get("service")!;
      const lines = [...refs].map(([r, s], i) => pktLine(`${s} ${r}${i === 0 ? "\0report-status delete-refs" : ""}\n`));
      if (!lines.length) lines.push(pktLine(`${ZERO_SHA} capabilities^{}\0report-status delete-refs\n`));
      const body = new Uint8Array(await new Blob([pktLine(`# service=${service}\n`), FLUSH, ...lines, FLUSH] as BlobPart[]).arrayBuffer());
      return new Response(body, { headers: { "content-type": `application/x-${service}-advertisement` } });
    }
    if (url.pathname.endsWith("/git-upload-pack")) {
      const base = await gitObject("blob", enc.encode("objects of the base"));
      return new Response(new Blob([pktLine("NAK\n"), await packOf([base])] as BlobPart[]), { headers: { "content-type": "application/x-git-upload-pack-result" } });
    }
    if (url.pathname.endsWith("/git-receive-pack")) {
      const bytes = new Uint8Array(await new Response(init!.body as BodyInit).arrayBuffer());
      const len = parseInt(dec.decode(bytes.subarray(0, 4)), 16);
      const cmd = dec.decode(bytes.subarray(4, len)).split("\0")[0].trim();
      const [from, to, ref] = cmd.split(" ");
      const packAt = len + 4; // the command, then the flush
      pushes.push({ from, to, ref, pack: bytes.slice(packAt) });
      refs.set(ref, to);
      return new Response(new Blob([pktLine("unpack ok\n"), pktLine(`ok ${ref}\n`), FLUSH] as BlobPart[]));
    }
    return new Response("no", { status: 404 });
  };
  return { refs, pushes, calls, fetchImpl };
}

async function setup(o: { mode?: string; evolver?: string; agents?: string } = {}) {
  const db = migratedDb();
  db.raw.prepare("UPDATE consensus_controls SET value = ? WHERE control = 'mode'").run(o.mode ?? "deploy");
  if (o.evolver) db.raw.prepare("UPDATE evolver_controls SET value = ? WHERE control = 'mode'").run(o.evolver);
  if (o.agents) db.raw.prepare("UPDATE kernel_controls SET value = ? WHERE control = 'agents_enabled'").run(o.agents);
  const repo = await repoOf({
    workers: { "ai-kernel": { src: { "a.ts": "export const a = 1;\n" } }, "control-plane-shared": { test: { "a.test.ts": "assert.equal(a, 1);\n" } } },
    docs: { "x.md": "# X\n" },
  });
  const work = { info: async () => ({ remote: `${HOST}/platform-work.git` }), createToken: async () => ({ plaintext: "tok_write.secret", expiresAt: 0 }) };
  const binding = { get: async (name: string) => (name === "platform" ? repo.reader : name === "platform-work" ? work : null) };
  const server = gitServer({ "refs/heads/main": "d".repeat(40), "refs/heads/claude/other": "e".repeat(40) });
  return { db, repo, binding, server, env: { DB: db as never, ARTIFACTS: binding as never } };
}
const EDITS = [
  { path: "workers/ai-kernel/src/a.ts", find: "export const a = 1;", replace: "export const a = 2;" },
  { path: "workers/control-plane-shared/test/a.test.ts", find: "assert.equal(a, 1);", replace: "assert.equal(a, 2);\nassert.ok(a > 1);" },
  { path: "docs/new/y.md", create: "# Y\n" },
];
const audits = (db: Db) => (db.raw.prepare("SELECT event_type, subject, outcome, payload_json FROM audit_events WHERE event_type LIKE 'forge.evolution_%' ORDER BY rowid").all() as any[]).map((a) => ({ ...a, payload: JSON.parse(a.payload_json) }));

test("F3. a valid evolution: one commit on main's head, pushed to evo/<id> after its base, audited; nothing else is written", async () => {
  const s = await setup();
  const r = await proposeEvolution(s.env, { evolution_id: ID, base_sha: s.repo.main, edits: EDITS, title: "Raise a to 2", description: "Intent int_x: a must be 2." }, s.server.fetchImpl as never, NOW);
  assert.equal(r.outcome, "written", JSON.stringify(r));
  assert.deepEqual([r.branch, r.cr_id, r.base_sha, r.files], [`evo/${ID}`, `fg-evo-${ID}`, s.repo.main, ["docs/new/y.md", "workers/ai-kernel/src/a.ts", "workers/control-plane-shared/test/a.test.ts"]]);
  assert.deepEqual(s.server.pushes.map((p) => [p.ref, p.from, p.to]), [[`refs/heads/evo/${ID}`, ZERO_SHA, s.repo.main], [`refs/heads/evo/${ID}`, s.repo.main, r.head_sha]]);
  assert.deepEqual([...s.server.refs.keys()].sort(), ["refs/heads/claude/other", `refs/heads/evo/${ID}`, "refs/heads/main"], "no other ref is written");
  assert.equal(s.server.refs.get("refs/heads/main"), "d".repeat(40));
  const idx = await indexPack(s.server.pushes[1].pack);
  const commit = idx.byId.get(r.head_sha!)!;
  assert.equal(commit.kind, 1);
  const text = dec.decode(commit.data);
  assert.ok(text.includes(`parent ${s.repo.main}\n`) && text.includes(`author ${EVOLVER_AUTHOR}`) && text.includes(`Evolution: ${ID}`));
  const root = /^tree ([0-9a-f]{40})/.exec(text)![1];
  // Walk the new root through the pack (new trees) and the base (unchanged subtrees).
  const entriesOf = (sha: string) => {
    const t = idx.byId.get(sha);
    if (!t) return s.repo.trees.get(sha)!.map((e) => ({ name: e.name, sha: e.hash }));
    const out: Array<{ name: string; sha: string }> = []; let p = 0; const d = t.data;
    while (p < d.length) { const sp = d.indexOf(0x20, p); const nul = d.indexOf(0, sp); out.push({ name: dec.decode(d.subarray(sp + 1, nul)), sha: [...d.subarray(nul + 1, nul + 21)].map((b) => b.toString(16).padStart(2, "0")).join("") }); p = nul + 21; }
    return out;
  };
  const at = (path: string) => path.split("/").reduce((sha, name) => entriesOf(sha).find((e) => e.name === name)!.sha, root);
  // indexPack keeps no blob content once indexed; a blob's id is its content.
  const blobId = async (t: string) => (await gitObject("blob", enc.encode(t))).sha;
  assert.equal(at("workers/ai-kernel/src/a.ts"), await blobId("export const a = 2;\n"));
  assert.equal(at("workers/control-plane-shared/test/a.test.ts"), await blobId("assert.equal(a, 2);\nassert.ok(a > 1);\n"));
  assert.equal(at("docs/new/y.md"), await blobId("# Y\n"));
  for (const p of ["workers/ai-kernel/src/a.ts", "docs/new/y.md"]) assert.equal(idx.byId.get(at(p))?.kind, 3, `${p}: its blob is in the pack`);
  assert.equal(at("docs/x.md"), (await gitObject("blob", enc.encode("# X\n"))).sha, "an unchanged file keeps its blob");
  const a = audits(s.db);
  assert.deepEqual(a.map((x) => [x.event_type, x.subject, x.outcome]), [["forge.evolution_written", `evolution:${ID}`, "written"]]);
  assert.equal(a[0].payload.changed_lines, r.changed_lines);
  assert.ok(!JSON.stringify(a).includes("secret") && !JSON.stringify(r).includes("secret"), "no token anywhere");
});

test("F4. the gates refuse before anything is written: id, base, switches, cadence, edits, path conflicts, an existing branch", async () => {
  const run = async (s: Awaited<ReturnType<typeof setup>>, input: Record<string, unknown>) => proposeEvolution(s.env, { evolution_id: ID, base_sha: s.repo.main, edits: EDITS, title: "t", ...input }, s.server.fetchImpl as never, NOW);
  let s = await setup();
  assert.equal((await run(s, { evolution_id: "evo_nope" })).reason, "invalid_evolution_id");
  assert.equal((await run(s, { base_sha: "x" })).reason, "invalid_base_sha");
  assert.equal((await run(s, { base_sha: "f".repeat(40) })).reason, "base_not_main");
  assert.equal((await run(s, { title: "  " })).reason, "missing_title");
  const guard = await run(s, { edits: [{ path: "workers/control-plane-shared/src/guard-paths.ts", create: "x" }] });
  assert.deepEqual([guard.reason, guard.refusals?.[0]], ["edits_refused", "guard_path:evolution_guard: workers/control-plane-shared/src/guard-paths.ts"]);
  const untested = await run(s, { edits: [EDITS[0]] });
  assert.deepEqual(untested.refusals, ["behaviour_change_without_test"]);
  const weaker = await run(s, { edits: [EDITS[0], { path: "workers/control-plane-shared/test/a.test.ts", find: "assert.equal(a, 1);", replace: "" }] });
  assert.ok(weaker.refusals?.some((x) => x.startsWith("assertions_removed")));
  const conflict = await run(s, { edits: [{ path: "workers/ai-kernel/src", create: "x" }] });
  assert.equal(conflict.reason, "path_conflict");
  assert.equal(s.server.pushes.length, 0);
  for (const [o, reason] of [[{ evolver: "off" }, "evolver_off"], [{ agents: "0" }, "kill_switch_engaged"], [{ mode: "shadow" }, "consensus_mode_shadow"]] as const) {
    s = await setup(o);
    assert.equal((await run(s, {})).reason, reason);
    assert.equal(s.server.pushes.length, 0);
  }
  // Cadence: an evolution change request open, or one written within MIN_START_INTERVAL_HOURS.
  s = await setup();
  s.db.raw.prepare(`INSERT INTO forge_change_requests (cr_id, number, branch, source_branch, title, author, head_sha, base_sha, github_ci, status, created_at, updated_at, source, repo)
    VALUES ('fg-evo-evo_aaaaaaaaaaaa', 0, 'evo/evo_aaaaaaaaaaaa', 'evo/evo_aaaaaaaaaaaa', 't', 'a', ?, ?, NULL, 'open', 'x', 'x', 'forge', 'platform-work')`).run("1".repeat(40), s.repo.main);
  assert.equal((await run(s, {})).reason, "evolution_in_flight");
  s = await setup();
  assert.equal((await run(s, {})).outcome, "written");
  assert.equal((await proposeEvolution(s.env, { evolution_id: "evo_0123456789ac", base_sha: s.repo.main, edits: EDITS, title: "t" }, s.server.fetchImpl as never, NOW + (MIN_START_INTERVAL_HOURS - 1) * 3_600_000)).reason, "start_interval");
  s = await setup();
  s.server.refs.set(`refs/heads/evo/${ID}`, "2".repeat(40));
  assert.equal((await run(s, {})).reason, "branch_exists");
  assert.ok(audits(s.db).every((a) => a.event_type === "forge.evolution_refused"));
});

test("F5. wiring: EvolutionRpc is the only caller; the module writes only evo/ branches of platform-work", () => {
  const worker = readFileSync(new URL("../../forge/src/worker.ts", import.meta.url), "utf8");
  assert.match(worker, /export class EvolutionRpc extends WorkerEntrypoint<Env> \{\n  async propose\(input: EvolutionInput\): Promise<EvolutionResult> \{\n    return proposeEvolution\(/);
  const src = readFileSync(new URL("../../forge/src/evolution.ts", import.meta.url), "utf8");
  const pushes = [...src.matchAll(/fastForward\(\{ remote: (\w+), token: \w+, branch(?:,| )/g)].map((m) => m[1]);
  assert.deepEqual(pushes, ["workRemote", "workRemote"], "both pushes go to platform-work, on `branch` (evo/<id>)");
  assert.match(src, /const branch = evolutionBranch\(evolution_id\);/);
  assert.ok(!/refs\/heads\/main|branch: "main"/.test(src));
  assert.deepEqual(readPktLines(pktLine("x\n")), ["x\n"]);
});
