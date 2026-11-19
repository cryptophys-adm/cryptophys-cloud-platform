// HAIC H3 (docs/design/HAIC-H3.md §1 non-goals, §9 "A back door to trading", §11 step 3; owner 2026-11-19, "Setuju semua
// rekomendasi"): a correction never changes a trading parameter, a strategy, a risk profile, a quorum or a weight, and is
// never an approval. This static test reads the corrections modules and their import lists: none imports a consensus,
// typed-proposal, policy-parameter, autonomy or executor writer, directly or through another module, and none writes
// anything but the corrections table (and the audit chain, through audit.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WORKERS = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (p: string) => readFileSync(join(WORKERS, p), "utf8");
/** The corrections modules: the correction.v1 contract (H3a) and the kernel's ledger (H3b, H3c). Add any new one here. */
const MODULES = ["control-plane-shared/src/correction.ts", "ai-kernel/src/corrections.ts"];
/** Modules that propose, draft, decide, set or execute: a corrections module never reaches them. */
const WRITERS = [
  "control-plane-shared/src/consensus-rules.ts", "control-plane-shared/src/consensus-exec.ts", "control-plane-shared/src/consensus-vote.ts",
  "control-plane-shared/src/typed-proposal.ts", "control-plane-shared/src/policy-params.ts", "control-plane-shared/src/autonomy-dial.ts",
  "control-plane-shared/src/executor-first.ts", "control-plane-shared/src/executor-rescue.ts", "control-plane-shared/src/break-glass.ts",
  "ai-kernel/src/consensus.ts", "ai-kernel/src/proposals.ts", "ai-kernel/src/directives.ts", "ai-kernel/src/council.ts", "ai-kernel/src/council-proposals.ts",
  "ai-kernel/src/autonomy.ts", "ai-kernel/src/syscall.ts", "ai-kernel/src/agent-rpc.ts", "ai-kernel/src/kernel.ts", "ai-kernel/src/supervisor.ts",
  "ai-kernel/src/evolver.ts", "ai-kernel/src/knowledge.ts", "ai-kernel/src/memory.ts",
];
/** Whole Workers that write or execute: no corrections module imports from them. */
const WRITER_DIRS = ["policy-engine/", "deployment-orchestrator/", "recovery-manager/", "forge/"];

/** Every module a file imports (import, import type, export ... from), resolved to a path under workers/. */
function importsOf(file: string): string[] {
  const src = read(file);
  const specs = [...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"|^\s*import\s+"([^"]+)"/gm)].map((m) => m[1] ?? m[2]);
  return specs.filter((s) => s.startsWith(".")).map((s) => relative(WORKERS, resolve(WORKERS, dirname(file), s)).replace(/\\/g, "/"));
}
/** The file's imports, transitively (only TypeScript modules are followed). */
function closure(file: string): Set<string> {
  const seen = new Set<string>();
  const todo = [file];
  while (todo.length) {
    const f = todo.pop()!;
    for (const i of importsOf(f)) if (!seen.has(i) && i.endsWith(".ts")) { seen.add(i); if (existsSync(join(WORKERS, i))) todo.push(i); }
  }
  return seen;
}
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

test("H3-B1. the corrections modules are the contract and the ledger; every writer this test names exists", () => {
  const found = [
    ...readdirSync(join(WORKERS, "control-plane-shared/src")).filter((f) => /correction/i.test(f)).map((f) => `control-plane-shared/src/${f}`),
    ...readdirSync(join(WORKERS, "ai-kernel/src")).filter((f) => /correction/i.test(f)).map((f) => `ai-kernel/src/${f}`),
  ].sort();
  assert.deepEqual(found, [...MODULES].sort(), "a new corrections module is listed in MODULES, so this test reads it");
  for (const w of WRITERS) assert.ok(existsSync(join(WORKERS, w)), `${w} exists (the list would otherwise check nothing)`);
});

test("H3-B2. no corrections module imports a consensus, typed-proposal, policy-parameter, autonomy or executor writer, directly or transitively", () => {
  for (const m of MODULES) {
    const direct = importsOf(m);
    assert.ok(direct.length > 0, `${m}: its import list is read`);
    for (const i of direct) {
      assert.doesNotMatch(i, /consensus|typed-proposal|policy|autonomy|executor|syscall|proposals|directives|knowledge|evolver|supervisor|recovery|deploy|forge|memory|break-glass/, `${m} imports ${i}`);
      assert.ok(!WRITERS.includes(i), `${m} imports the writer ${i}`);
    }
    const all = closure(m);
    for (const w of WRITERS) assert.ok(!all.has(w), `${m} reaches the writer ${w} through its imports`);
    for (const i of all) assert.ok(!WRITER_DIRS.some((d) => i.startsWith(d)), `${m} reaches ${i}`);
  }
  // The kernel's ledger imports exactly the contract, the audit chain, the shared chat constants and the D1 types.
  assert.deepEqual(importsOf("ai-kernel/src/corrections.ts").sort(), [
    "control-plane-shared/src/audit.ts", "control-plane-shared/src/conversation.ts", "control-plane-shared/src/correction.ts", "control-plane-shared/src/types.ts",
  ]);
  // The contract is pure: the ev: ref grammar (the shared council contract, not the kernel's council) and the redaction rules.
  assert.deepEqual(importsOf("control-plane-shared/src/correction.ts").sort(), ["control-plane-shared/src/conversation.ts", "control-plane-shared/src/council.ts"]);
});

test("H3-B3. no corrections module calls a writer or writes anything but the corrections table", () => {
  for (const m of MODULES) {
    const c = code(read(m));
    assert.doesNotMatch(c, /consensusPropose|proposeConsensus|consensus\.propose|insertDraft|draftFrom|decideProposal|decideKnowledge|setPolicyParameter|setAutonomyLevel|autoDowngrade|setConsensusMode|ownerDecide|pickOption|\.syscall\(|\.dispatch\(|POLICY\.evaluate|RECOVERY\.|DEPLOY|FORGE/, m);
    assert.doesNotMatch(c, /\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\bREPLACE\s+INTO\b|\bDROP\b|\bALTER\s+TABLE\b/i, `${m}: no update, delete or schema change`);
    for (const t of c.matchAll(/\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\w+)/gi)) assert.equal(t[1], "corrections", `${m} writes ${t[1]}`);
    assert.doesNotMatch(c, /\b(typed_proposals|knowledge_proposals|consensus_proposals|policy_parameters|autonomy_levels|agents|agent_memories|evolution_intents_v2)\b\s*(?:SET|\(|VALUES)/i, `${m}: no write to another table`);
  }
  assert.doesNotMatch(code(read("control-plane-shared/src/correction.ts")), /\.prepare\(|fetch\(/, "the contract stores nothing and calls nothing");
  // A record carries no parameter (§4.1): the contract's forbidden keys include params, values and change.
  assert.match(read("control-plane-shared/src/correction.ts"), /const FORBIDDEN_KEYS = new Set\(\["params", "parameters", "values", "value", "change", "changes"/);
});

test("H3-B4. the reject hooks reach the ledger only through recordRejectReason; the typed-proposal contract is untouched by H3c", () => {
  const uses = (file: string) => [...read(file).matchAll(/^import \{([^}]+)\} from "\.\/corrections\.ts";/gm)].flatMap((m) => m[1].split(",").map((s) => s.trim()).filter(Boolean)).sort();
  assert.deepEqual(uses("ai-kernel/src/proposals.ts"), ["proposalRef", "proposalSubject", "recordRejectReason"]);
  assert.deepEqual(uses("ai-kernel/src/knowledge.ts"), ["knowledgeRef", "recordRejectReason"]);
  assert.doesNotMatch(read("control-plane-shared/src/typed-proposal.ts"), /correction/i, "typed-proposal.ts (a guard path) knows nothing of corrections");
  // The hook runs after the reject is stored and audited, and cannot throw (a failure is logged, test H3c-7).
  const p = read("ai-kernel/src/proposals.ts");
  assert.ok(p.indexOf('await audit(db, "rejected"') < p.indexOf("await recordRejectReason("), "proposals: the reject first, then the record");
  const k = read("ai-kernel/src/knowledge.ts");
  assert.ok(k.indexOf("knowledge.rejected") < k.indexOf("await recordRejectReason("), "knowledge: the review first, then the record");
});
