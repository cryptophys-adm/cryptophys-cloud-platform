// ADR-0014 E2 (owner 2026-11-13): the evolver's edit validator, shared by the AI Kernel (before it proposes) and the
// Forge (before it writes). Owner limits: 400 changed lines, 20 files, tests only ever gain assertions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CHANGED_FILES, MAX_CHANGED_LINES, MIN_START_INTERVAL_HOURS, MAX_IN_FLIGHT, EVOLVER_MODEL, changedLines, checkEdits, pathRefusal } from "../src/evolution-limits.ts";
import { criticalPathReason } from "../src/guard-paths.ts";

const SRC = "workers/drift-detector/src/probe.ts";
const TST = "workers/control-plane-shared/test/probe.test.ts";
const base = (entries: Array<[string, string | null]>) => new Map(entries);

test("E1. the owner's limits are the values in code", () => {
  assert.deepEqual([MAX_IN_FLIGHT, MIN_START_INTERVAL_HOURS, MAX_CHANGED_LINES, MAX_CHANGED_FILES, EVOLVER_MODEL], [1, 4, 400, 20, "@cf/openai/gpt-oss-120b"]);
});

test("E2. paths: only workers/ and docs/; guard paths, migrations, configuration, dependencies and binaries are refused", () => {
  assert.equal(pathRefusal(SRC), null);
  assert.equal(pathRefusal("docs/OPERATIONS.md"), null);
  for (const [p, why] of [
    [".github/workflows/ci.yml", "path_outside_scope"], ["workers/../.github/x", "path_outside_scope"], ["architecture/adr/0015-x.md", "path_outside_scope"],
    ["workers/policy-engine/src/index.ts", "guard_path:policy_engine"], ["workers/control-plane-shared/src/evolution-limits.ts", "guard_path:evolution_guard"],
    ["workers/control-plane-shared/src/guard-paths.ts", "guard_path:evolution_guard"], ["workers/ai-kernel/organism.json", "guard_path:evolution_guard"],
    ["workers/control-plane-migrations/0099_x.sql", "d1_migration"], ["workers/forge/wrangler.toml", "worker_configuration"],
    ["workers/console/organism.json", "worker_configuration"], ["workers/forge/package.json", "dependencies"], ["workers/console/ui/package.json", "guard_path:typecheck_harness"], ["workers/console/ui/public/x.png", "binary_file"],
  ] as const) assert.equal(pathRefusal(p), why, p);
  assert.ok(criticalPathReason("workers/control-plane-shared/src/capabilities.ts"), "the capability catalog is a guard path");
});

test("E3. a replace edit needs exactly one occurrence; a create needs a new file; unread files are refused", () => {
  const b = base([[SRC, "const a = 1;\nconst a = 1;\n"], [TST, null]]);
  assert.match((checkEdits(b, [{ path: SRC, find: "const a = 1;", replace: "x" }]) as any).refusals[0], /find_not_unique/);
  assert.match((checkEdits(b, [{ path: SRC, find: "nope", replace: "x" }]) as any).refusals[0], /find_not_found/);
  assert.match((checkEdits(b, [{ path: SRC, create: "x" }]) as any).refusals[0], /exists/);
  assert.match((checkEdits(b, [{ path: "workers/x/src/y.ts", create: "x" }]) as any).refusals[0], /not_read/);
  assert.deepEqual((checkEdits(b, []) as any).refusals, ["no_edits"]);
});

test("E4. a behaviour change needs a test; a test may gain assertions, never lose them", () => {
  const b = base([[SRC, "export const v = 1;\n"], [TST, "assert.equal(1, 1);\nassert.ok(true);\n"]]);
  assert.deepEqual((checkEdits(b, [{ path: SRC, find: "v = 1", replace: "v = 2" }]) as any).refusals, ["behaviour_change_without_test"]);
  const ok = checkEdits(b, [{ path: SRC, find: "v = 1", replace: "v = 2" }, { path: TST, find: "assert.ok(true);", replace: "assert.ok(true);\nassert.equal(2, 2);" }]);
  assert.ok(ok.ok); assert.deepEqual(ok.ok && ok.files.map((f) => f.path), [TST, SRC]);
  const weaker = checkEdits(b, [{ path: SRC, find: "v = 1", replace: "v = 2" }, { path: TST, find: "assert.ok(true);\n", replace: "" }]);
  assert.match((weaker as any).refusals.join(), /assertions_removed/);
  assert.ok(checkEdits(base([["docs/OPERATIONS.md", "a\n"]]), [{ path: "docs/OPERATIONS.md", find: "a", replace: "b" }]).ok, "docs need no test");
});

test("E5. size: at most 400 changed lines and 20 files", () => {
  assert.equal(changedLines("a\nb\n", "a\nc\n"), 2);
  assert.equal(changedLines(null, "a\nb"), 2);
  const big = Array.from({ length: 401 }, (_, i) => `line ${i}`).join("\n");
  assert.match((checkEdits(base([["docs/BIG.md", null]]), [{ path: "docs/BIG.md", create: big }]) as any).refusals.join(), /too_many_lines/);
  const many = Array.from({ length: 21 }, (_, i) => [`docs/n${i}.md`, null] as [string, null]);
  const res = checkEdits(base(many), many.map(([p]) => ({ path: p, create: "x" })));
  assert.match((res as any).refusals.join(), /too_many_files: 21/);
});
