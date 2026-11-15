// 2026-11-14 incident: every automatic deploy stuck since main 6db8d31. The Forge looked a unit's desired version
// up only in main's first-parent history (`log`). Branch updates merged main as the SECOND parent, so the Control
// Plane's version 3cd2f94, an ancestor of main 0a9e30f, was not on that chain: control-plane was skipped as
// `compare_failed_or_diverged`, and with a migration in another unit's diff the plan refused every unit
// (`new_migration_control_plane_unavailable`), the Forge's own fix included.
//
// The history below is that day's, with the real commit ids and parents (`git log --format='%H %P'
// 8a8164d..0a9e30f`); the trees are reduced to the paths that decide the plan. The Artifacts fake behaves as the
// binding does: `log(main)` lists the first-parent chain only, `readCommit` gives every parent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { migratedDb } from "./harness.ts";
import * as deployPlan from "../../forge/src/deploy-plan.ts";
import type { ArtifactsReader, ArtifactsTreeEntry } from "../../forge/src/checks.ts";

type Db = ReturnType<typeof migratedDb>;
const { forgePlan } = deployPlan;
const FULL = "full_redeploy_unresolved_base";

const C = {
  main: "0a9e30fc182c409dee8ab184e1a7cd4f58d81137", // Merge canonical main 1b273f0 into remove-manual-deploy
  b77c38a: "b77c38ab40a75e07eafe3d1a94306a44ded8b71b", // Remove the Console's manual emergency deploy
  r1b273f0: "1b273f0fe3615ef9a5c75e357ced263c03bc7744", // Forge tick: check main's head before change requests
  e240bf4: "e240bf486ead67144562f0a98822bc814b9115d8", // Merge canonical main 6db8d31 into retire-dead
  r44a938e: "44a938ea501eec5b9939f57cb47d9edffd2f1c64", // Merge canonical main 3cd2f94 into retire-dead
  r9351cb3: "9351cb3a90ad046878e776c2725cc3a948423761", // Retire signal-engine and home (0064)
  r6db8d31: "6db8d317de8f745825111992473231dbbebf0aea", // Merge canonical main 3cd2f94 into telos-t0
  r65f2e1d: "65f2e1df5548c480482929bd6c8f2c49c64dcc84",
  r37d63fb: "37d63fb474bae3a0c44b24103c39bf1b87d48af5",
  d55ac11: "d55ac11eefe642f485895b8cb74e3331177d4892", // Telos T0 (organism/vision.json)
  r3cd2f94: "3cd2f946aa684e522e72e769a2f330fe86b3fd0b", // Console: the Observer's vitals (the Control Plane's version)
  r969e3f0: "969e3f0e586d6fb0f168183a9d6bd4a65390875d", // Observer (0063)
  r8a8164d: "8a8164d18bf438e50d679dda5ec6a159c24f1da0", // Merge auditor-signal into canonical main c0365bc
  side: "5ade0000000000000000000000000000000000c1", // a commit in the repository that main never merged
} as const;
const tag = (sha: string) => sha.slice(0, 12);

type Files = Record<string, string>;
const M = "workers/control-plane-migrations/";
const BASE: Files = {
  "README.md": "x",
  [`${M}0062_drop_retired_signal_tables.sql`]: "-- 0062",
  "workers/console/src/index.ts": "console 0",
  "workers/ai-kernel/src/index.ts": "kernel 0",
  "workers/forge/src/tick.ts": "tick 0",
  "workers/deployment-orchestrator/src/index.ts": "orchestrator 0",
  "workers/platform-api/src/index.ts": "api 0",
};
const with_ = (files: Files, extra: Files): Files => ({ ...files, ...extra });
const observer = with_(BASE, { [`${M}0063_observer.sql`]: "-- 0063", "workers/ai-kernel/src/observer.ts": "observer" });
const at3cd2f94 = with_(observer, { "workers/console/src/index.ts": "console observer" });
const telos = with_(BASE, { "organism/vision.json": "{}" });
const merged6db8d31 = with_(at3cd2f94, { "organism/vision.json": "{}" });
const at9351cb3 = with_(BASE, { [`${M}0064_retire_signal_engine_and_home.sql`]: "-- 0064" });
const merged44a938e = with_(at3cd2f94, { [`${M}0064_retire_signal_engine_and_home.sql`]: "-- 0064" });
const atE240bf4 = with_(merged44a938e, { "organism/vision.json": "{}" });
const at1b273f0 = with_(atE240bf4, { "workers/forge/src/tick.ts": "tick main first" });
const atB77c38a = with_(atE240bf4, { "workers/console/src/index.ts": "console no manual deploy", "workers/deployment-orchestrator/src/index.ts": "orchestrator no POST" });
const atMain = with_(atB77c38a, { "workers/forge/src/tick.ts": "tick main first" });

const COMMITS: Record<string, { parents: string[]; files: Files }> = {
  [C.r8a8164d]: { parents: [], files: BASE },
  [C.r969e3f0]: { parents: [C.r8a8164d], files: observer },
  [C.r3cd2f94]: { parents: [C.r969e3f0], files: at3cd2f94 },
  [C.d55ac11]: { parents: [C.r8a8164d], files: telos },
  [C.r37d63fb]: { parents: [C.d55ac11], files: telos },
  [C.r65f2e1d]: { parents: [C.r37d63fb], files: telos },
  [C.r6db8d31]: { parents: [C.r65f2e1d, C.r3cd2f94], files: merged6db8d31 },
  [C.r9351cb3]: { parents: [C.r8a8164d], files: at9351cb3 },
  [C.r44a938e]: { parents: [C.r9351cb3, C.r3cd2f94], files: merged44a938e },
  [C.e240bf4]: { parents: [C.r44a938e, C.r6db8d31], files: atE240bf4 },
  [C.r1b273f0]: { parents: [C.e240bf4], files: at1b273f0 },
  [C.b77c38a]: { parents: [C.e240bf4], files: atB77c38a },
  [C.main]: { parents: [C.b77c38a, C.r1b273f0], files: atMain },
  [C.side]: { parents: [C.r8a8164d], files: with_(BASE, { "workers/platform-api/src/index.ts": "api from an unmerged branch" }) },
};

/** The Artifacts binding over COMMITS: `log(main)` is the first-parent chain, `readCommit` lists every parent. */
function historyRepo(): ArtifactsReader & { reads: string[] } {
  const trees: Record<string, ArtifactsTreeEntry[]> = {}; const blobs: Record<string, string> = {}; let n = 1;
  const id = (p: string) => p + (n++).toString(16).padStart(39, "0");
  function build(files: Files): string {
    const here: Record<string, Files> = {}; const entries: ArtifactsTreeEntry[] = [];
    for (const [p, t] of Object.entries(files)) {
      const i = p.indexOf("/");
      if (i < 0) {
        const existing = Object.entries(blobs).find(([, v]) => v === t)?.[0];
        const h = existing ?? id("b"); blobs[h] = t; entries.push({ name: p, type: "blob", mode: "100644", hash: h });
      } else (here[p.slice(0, i)] ??= {})[p.slice(i + 1)] = t;
    }
    for (const [d, sub] of Object.entries(here)) entries.push({ name: d, type: "tree", mode: "40000", hash: build(sub) });
    const key = JSON.stringify(entries.sort((a, b) => a.name.localeCompare(b.name)));
    const existing = Object.entries(trees).find(([, e]) => JSON.stringify(e) === key);
    if (existing) return existing[0];
    const h = id("e"); trees[h] = entries; return h;
  }
  const roots = Object.fromEntries(Object.entries(COMMITS).map(([sha, c]) => [sha, build(c.files)]));
  const reads: string[] = [];
  return {
    reads,
    async readCommit(h) { reads.push(h); return COMMITS[h] ? { hash: h, treeHash: roots[h], parents: COMMITS[h].parents } as never : null; },
    async readTree(h) { return trees[h] ?? null; },
    async readBlob(h) { return h in blobs ? new Blob([blobs[h]]) : null; },
    async log(opts) {
      const chain: Array<Record<string, unknown>> = [];
      for (let sha: string | undefined = C.main; sha; sha = COMMITS[sha]?.parents[0]) chain.push({ hash: sha, parents: COMMITS[sha].parents });
      return chain.slice(0, opts?.limit ?? 30);
    },
  };
}

const UNIT_SERVICES: Record<string, string[]> = {
  "deployment-orchestrator": ["cryptophys-deployment-orchestrator"],
  "control-plane": ["cryptophys-policy-engine", "cryptophys-audit-ledger", "cryptophys-platform-registry", "cryptophys-recovery-manager", "cryptophys-drift-detector", "cryptophys-ai-kernel"],
  console: ["cryptophys-console"],
  "platform-api": ["cryptophys-platform-api"],
  forge: ["cryptophys-forge"],
};
/** Every unit at main's head, then the given units at the given versions. */
function registry(db: Db, versions: Record<string, string>) {
  db.raw.prepare("UPDATE service_registry SET desired_version = ? WHERE service_id IN (" +
    Object.values(UNIT_SERVICES).flat().map((s) => `'${s}'`).join(",") + ")").run(tag(C.main));
  for (const [unit, sha] of Object.entries(versions)) {
    for (const s of UNIT_SERVICES[unit]) db.raw.prepare("UPDATE service_registry SET desired_version = ? WHERE service_id = ?").run(tag(sha), s);
  }
}
/** D1 as on 2026-11-14 before the Control Plane deploy: 0064 is on main, not applied. */
const unapplied = (db: Db, file: string) => db.raw.prepare("DELETE FROM d1_migrations WHERE name = ?").run(file);
const names = (p: { units: { unit: string }[] }) => p.units.map((u) => u.unit);

test("ANC1. today's shape: the Control Plane's version is a second-parent ancestor of main and 0064 is pending: the Control Plane is planned, first and alone", async () => {
  const repo = historyRepo();
  const firstParent = (await repo.log({ ref: "main", limit: 200 })).map((c) => c.hash);
  assert.ok(!firstParent.includes(C.r3cd2f94), "3cd2f94 is not on main's first-parent chain");
  const db = migratedDb();
  // The Control Plane runs 3cd2f94; the Console a version on the first-parent chain, whose diff to main carries
  // migrations (the diff that made the old plan refuse every unit); the others run 3cd2f94 too.
  registry(db, { "control-plane": C.r3cd2f94, console: C.r8a8164d, forge: C.r3cd2f94, "deployment-orchestrator": C.r3cd2f94, "platform-api": C.r3cd2f94 });
  unapplied(db, "0064_retire_signal_engine_and_home.sql");
  const plan = await forgePlan(db as never, repo, C.main);
  assert.deepEqual(names(plan), ["control-plane"]);
  assert.equal(plan.units[0].reason, `main ${tag(C.main)} changes control-plane`, "resolved through the walk and diffed, not a full redeploy");
  assert.ok(!plan.skipped.some((s) => s.reason === "compare_failed_or_diverged"), JSON.stringify(plan.skipped));
  assert.ok(!plan.skipped.some((s) => s.reason === "new_migration_control_plane_unavailable"), JSON.stringify(plan.skipped));
  assert.deepEqual(plan.skipped.map((s) => s.unit).sort(), ["console", "deployment-orchestrator", "forge"]);
  assert.ok(plan.skipped.every((s) => s.reason === "control_plane_migration_first"));
  // After the Control Plane deploy (0064 applied, the Control Plane at main), the orchestrator goes alone, then the rest.
  db.raw.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run("0064_retire_signal_engine_and_home.sql");
  registry(db, { console: C.r8a8164d, forge: C.r3cd2f94, "deployment-orchestrator": C.r3cd2f94 });
  assert.deepEqual(names(await forgePlan(db as never, repo, C.main)), ["deployment-orchestrator"]);
  registry(db, { console: C.r8a8164d, forge: C.r3cd2f94 });
  assert.deepEqual(names(await forgePlan(db as never, repo, C.main)), ["console", "forge"]);
});

test("ANC2. a desired version that is not an ancestor of main (diverged, or unknown to the repository) is a full redeploy from main's head; the ordering rules hold", async () => {
  const repo = historyRepo();
  const db = migratedDb();
  registry(db, { "platform-api": C.side });
  let plan = await forgePlan(db as never, repo, C.main);
  assert.deepEqual(plan.units.map((u) => [u.unit, u.reason]), [["platform-api", FULL]]);
  assert.deepEqual(plan.skipped, []);
  registry(db, { "platform-api": "abcdefabcdef".padEnd(40, "0") });
  plan = await forgePlan(db as never, repo, C.main);
  assert.deepEqual(plan.units.map((u) => [u.unit, u.reason]), [["platform-api", FULL]], "a version the repository does not hold");
  // A diverged orchestrator still goes first and alone.
  registry(db, { "deployment-orchestrator": C.side, console: C.r3cd2f94 });
  plan = await forgePlan(db as never, repo, C.main);
  assert.deepEqual(plan.units.map((u) => [u.unit, u.reason]), [["deployment-orchestrator", FULL]]);
  assert.deepEqual(plan.skipped, [{ unit: "console", reason: "deployment_orchestrator_must_complete_first" }]);
  // A diverged Control Plane with a pending migration: the Control Plane is redeployed in full, first and alone,
  // instead of every unit being refused (new_migration_control_plane_unavailable).
  registry(db, { "control-plane": C.side, forge: C.r3cd2f94 });
  unapplied(db, "0064_retire_signal_engine_and_home.sql");
  plan = await forgePlan(db as never, repo, C.main);
  assert.deepEqual(plan.units.map((u) => [u.unit, u.reason]), [["control-plane", FULL]]);
  assert.deepEqual(plan.skipped, [{ unit: "forge", reason: "control_plane_migration_first" }]);
  // Only a Control Plane that cannot be deployed at all still refuses the others while a migration is pending.
  db.raw.prepare("UPDATE service_registry SET status = 'disabled' WHERE service_id = 'cryptophys-policy-engine'").run();
  plan = await forgePlan(db as never, repo, C.main);
  assert.deepEqual(plan, { units: [], skipped: [{ unit: "control-plane", reason: "not_registered_or_disabled" }, { unit: "*", reason: "new_migration_control_plane_unavailable" }] });
});

test("ANC3. a pending migration is what D1 has not applied, not what a diff to a deployed version shows", async () => {
  const repo = historyRepo();
  // 0064 is in the Control Plane's diff (3cd2f94 to main), but D1 already applied it: no migration-first rule.
  let db = migratedDb();
  registry(db, { "control-plane": C.r3cd2f94, console: C.r3cd2f94 });
  let plan = await forgePlan(db as never, repo, C.main);
  assert.deepEqual(names(plan), ["control-plane", "console"]);
  assert.deepEqual(plan.skipped, []);
  // No migration in any diff (the Control Plane at main's first parent, unchanged since), but D1 lacks 0064: the
  // Control Plane is planned, first and alone, because only its deploy applies migrations.
  db = migratedDb();
  registry(db, { "control-plane": C.b77c38a, forge: C.b77c38a });
  assert.deepEqual(names(await forgePlan(db as never, repo, C.main)), ["forge"], "everything applied: the Control Plane's paths did not change");
  unapplied(db, "0064_retire_signal_engine_and_home.sql");
  plan = await forgePlan(db as never, repo, C.main);
  assert.deepEqual(plan.units.map((u) => [u.unit, u.reason]), [["control-plane", `main ${tag(C.main)} has a migration D1 has not applied`]]);
  assert.deepEqual(plan.skipped, [{ unit: "forge", reason: "control_plane_migration_first" }]);
  // A ledger that cannot be read counts as a pending migration (fail closed: the Control Plane first).
  db = migratedDb();
  registry(db, { "control-plane": C.b77c38a, forge: C.b77c38a });
  db.raw.prepare("DROP TABLE d1_migrations").run();
  assert.deepEqual(names(await forgePlan(db as never, repo, C.main)), ["control-plane"]);
});

test("ANC4. the ancestry walk: first-parent window first, then every parent, at most PLAN_ANCESTRY_READS commits", async () => {
  const { resolveAncestors, PLAN_ANCESTRY_READS, pendingMigrations } = deployPlan as typeof deployPlan & Record<string, any>;
  assert.equal(PLAN_ANCESTRY_READS, 500);
  let repo = historyRepo();
  // On the first-parent window: no commit is read.
  let r = await resolveAncestors(repo, C.main, [tag(C.r9351cb3)]);
  assert.deepEqual([r.resolved.get(tag(C.r9351cb3)), r.reads, repo.reads.length], [C.r9351cb3, 0, 0]);
  // Through a second parent: found by the walk.
  repo = historyRepo();
  r = await resolveAncestors(repo, C.main, [tag(C.r3cd2f94), tag(C.side)]);
  assert.equal(r.resolved.get(tag(C.r3cd2f94)), C.r3cd2f94);
  assert.equal(r.resolved.get(tag(C.side)), null, "a commit main never merged is not an ancestor");
  assert.equal(r.exhausted, false, "the whole history was walked");
  assert.equal(new Set(repo.reads).size, repo.reads.length, "each commit is read once");
  // The bound: a walk that stops early resolves nothing more (the unit is then redeployed in full).
  r = await resolveAncestors(historyRepo(), C.main, [tag(C.r3cd2f94)], 2);
  assert.deepEqual([r.resolved.get(tag(C.r3cd2f94)), r.exhausted, r.reads], [null, true, 2]);
  // The migrations of main's head, as the bundle manifest lists them, against the D1 ledger.
  const db = migratedDb();
  assert.deepEqual(await pendingMigrations(db as never, historyRepo(), C.main), []);
  unapplied(db, "0063_observer.sql");
  assert.deepEqual(await pendingMigrations(db as never, historyRepo(), C.main), ["0063_observer.sql"]);
});
