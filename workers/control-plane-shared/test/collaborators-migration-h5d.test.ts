// HAIC H5d (docs/design/HAIC-H5.md §7.1 and §11 H5d; owner 2026-11-19, "Setuju semua rekomendasi"): the collaborator
// schema, migration 0085 (the next free number after H3b's 0084, with no gap). It is additive and routine under
// migration-rules.ts, applies on a migrated database, each new table's CHECKs refuse a bad row and accept a good one, and
// the Workers that will use it (the AI Kernel, the Platform Registry) are not ready without it, while every other
// service's readiness still ends at 0029. Nothing reads or writes the new columns and tables yet (H5e–H5i).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, call, migratedDb, req } from "./harness.ts";
import kernel from "../../ai-kernel/src/index.ts";
import registry from "../../platform-registry/src/index.ts";
import policy from "../../policy-engine/src/index.ts";
import { COLLABORATOR_MIGRATIONS, REQUIRED_MIGRATION, schemaReady } from "../src/readiness.ts";
import { destructiveMigration, splitSqlStatements, unsupportedStatement } from "../src/migration-rules.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const MIGRATION = "0085_collaborators.sql";
const SQL = read(`workers/control-plane-migrations/${MIGRATION}`);
const H64 = "a".repeat(64);

/** Expects SQLite to refuse the statement with a constraint failure (CHECK, NOT NULL, UNIQUE or PRIMARY KEY). */
function refused(db: DatabaseSync, sql: string, params: Array<string | number | null>, label: string) {
  assert.throws(() => db.prepare(sql).run(...params), /constraint failed/i, label);
}
const columns = (db: DatabaseSync, table: string) => (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map((r) => r.name);

test("H5d-1. migration 0085 follows 0084 with no gap, is additive and routine under migration-rules.ts", () => {
  const files = readdirSync(new URL("workers/control-plane-migrations/", ROOT)).filter((f) => f.endsWith(".sql")).sort();
  const at = files.indexOf(MIGRATION);
  assert.ok(at > 0, "the migration exists");
  assert.equal(files[at - 1], "0084_corrections.sql", "it follows the corrections ledger (H3b)");
  assert.equal(Number(MIGRATION.slice(0, 4)), Number(files[at - 1].slice(0, 4)) + 1, "the next free number: no gap (a lower number cannot be added once a higher one is applied)");
  assert.ok(files.slice(at + 1).every((f) => Number(f.slice(0, 4)) > 85), "only later migrations follow it");
  const statements = splitSqlStatements(SQL).map((s) => s.replace(/^(\s*--[^\n]*\n)+/, "").trim());
  assert.deepEqual(statements.map((s) => /^(ALTER TABLE \w+ ADD COLUMN \w+|CREATE (TABLE|INDEX) IF NOT EXISTS \w+)/.exec(s)?.[1] ?? s.slice(0, 40)), [
    "ALTER TABLE platform_accounts ADD COLUMN reviewer",
    "ALTER TABLE platform_accounts ADD COLUMN expires_at",
    "CREATE TABLE IF NOT EXISTS collab_comments",
    "CREATE INDEX IF NOT EXISTS idx_collab_comments_target",
    "CREATE TABLE IF NOT EXISTS conversation_collab_budget",
    "CREATE TABLE IF NOT EXISTS collab_controls",
  ]);
  assert.equal(destructiveMigration(SQL), false, "the native deploy applies it as routine (no deploy_destructive_migration, no owner click)");
  assert.equal(unsupportedStatement(splitSqlStatements(SQL)), null, "every statement runs in one D1 batch");
  assert.doesNotMatch(SQL.replace(/--[^\n]*/g, ""), /\b(UNIQUE|UPDATE|DELETE|DROP|RENAME|INSERT)\b/i, "no row is written, seeded or rewritten");
  assert.doesNotMatch(SQL.replace(/--[^\n]*/g, ""), /human_feedback/i, "collaborators teach through the H3 ledger (corrections, 0084), not a second table");
  assert.match(read("workers/control-plane-migrations/test_migrations.py"), /PASS: 0085 collaborators/);
});

test("H5d-2. it applies on a migrated database: rows kept, an existing account reads as no reviewer and no expiry; the splitter's batch gives the same schema as a plain exec", () => {
  const db = migratedDb();
  assert.ok(db.raw.prepare("SELECT 1 FROM d1_migrations WHERE name = ?").get(MIGRATION), "the harness applied and recorded it");
  assert.deepEqual(columns(db.raw, "platform_accounts").slice(-2), ["reviewer", "expires_at"]);
  for (const t of ["collab_comments", "conversation_collab_budget", "collab_controls"]) {
    assert.equal((db.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n, 0, `${t} has no row`);
  }
  // Apply it to a database migrated up to 0084 with one account row, once by plain exec and once statement by statement.
  const before = () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec("PRAGMA foreign_keys = ON");
    for (const f of readdirSync(new URL("workers/control-plane-migrations/", ROOT)).filter((x) => x.endsWith(".sql") && x < MIGRATION).sort()) raw.exec(read(`workers/control-plane-migrations/${f}`));
    raw.prepare("INSERT INTO platform_accounts (email, kind, privilege, status, created_by, created_at, updated_by, updated_at) VALUES ('v@example.com', 'admin', 'viewer', 'active', 'o@example.com', 't0', 'o@example.com', 't0')").run();
    return raw;
  };
  const schema = (raw: DatabaseSync) => raw.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
  const plain = before();
  plain.exec(SQL);
  const batched = before();
  batched.exec("BEGIN");
  for (const s of splitSqlStatements(SQL)) batched.prepare(s).run();
  batched.exec("COMMIT");
  assert.deepEqual(schema(batched), schema(plain));
  assert.deepEqual(batched.prepare("SELECT email, kind, privilege, status, reviewer, expires_at FROM platform_accounts").all().map((r) => ({ ...r })),
    [{ email: "v@example.com", kind: "admin", privilege: "viewer", status: "active", reviewer: 0, expires_at: null }]);
  // A plain index on (target_ref, created_at) serves the per-target read of H5g.
  const plan = (plain.prepare("EXPLAIN QUERY PLAN SELECT comment_id FROM collab_comments WHERE target_ref = ? ORDER BY created_at").all("ev:x") as Array<{ detail: string }>).map((r) => r.detail).join(" ");
  assert.match(plan, /USING INDEX idx_collab_comments_target/);
});

test("H5d-3. platform_accounts.reviewer is 0 or 1, never NULL, 0 by default; expires_at is optional", () => {
  const { raw } = migratedDb();
  const insert = "INSERT INTO platform_accounts (email, kind, privilege, status, created_by, created_at, updated_by, updated_at, reviewer, expires_at) VALUES (?, 'admin', 'viewer', 'active', 'o@example.com', 't0', 'o@example.com', 't0', ?, ?)";
  raw.prepare(insert).run("r@example.com", 1, "2026-12-31T00:00:00.000Z");
  raw.prepare(insert).run("v@example.com", 0, null);
  raw.prepare("INSERT INTO platform_accounts (email, kind, privilege, status, created_by, created_at, updated_by, updated_at) VALUES ('d@example.com', 'admin', 'operator', 'active', 'o@example.com', 't0', 'o@example.com', 't0')").run();
  assert.deepEqual({ ...raw.prepare("SELECT reviewer, expires_at FROM platform_accounts WHERE email = 'd@example.com'").get() }, { reviewer: 0, expires_at: null });
  for (const bad of [2, -1, null, "yes"]) refused(raw, insert, [`b${String(bad).length}${typeof bad}@example.com`, bad, null], `reviewer ${String(bad)}`);
  refused(raw, "UPDATE platform_accounts SET reviewer = 3 WHERE email = 'r@example.com'", [], "reviewer 3 on update");
});

test("H5d-4. collab_comments: an ev: target, a collaborator or owner author, 1 to 1,200 characters, a sha256, visible or hidden with hidden_by", () => {
  const { raw } = migratedDb();
  const insert = "INSERT INTO collab_comments (comment_id, target_ref, author, author_role, text, content_sha256, status, hidden_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
  const ok: Array<string | null> = ["cmt_0123456789abcdef", "ev:platform/typed_proposal/tp_0123456789abcdef", "r@example.com", "reviewer", "x".repeat(1200), H64, "visible", null, "t0"];
  raw.prepare(insert).run(...ok);
  for (const role of ["operator", "approver", "owner"]) raw.prepare(insert).run(`cmt_${role}`, ok[1], ok[2], role, "ok", H64, "visible", null, "t0");
  raw.prepare(insert).run("cmt_hidden", ok[1], ok[2], "reviewer", "ok", H64, "hidden", "o@example.com", "t0");
  raw.prepare("INSERT INTO collab_comments (comment_id, target_ref, author, author_role, text, content_sha256, created_at) VALUES ('cmt_default', 'ev:platform/inbox/i1', 'r@example.com', 'reviewer', 'ok', ?, 't0')").run(H64);
  assert.deepEqual({ ...raw.prepare("SELECT status, hidden_by FROM collab_comments WHERE comment_id = 'cmt_default'").get() }, { status: "visible", hidden_by: null });
  refused(raw, insert, ok, "the same comment_id twice");
  const bad: Array<[number, string | null]> = [
    [0, "c"], [0, "c".repeat(41)], [0, null], [1, "platform/council/cs_x"], [1, "ev:"], [1, `ev:${"x".repeat(298)}`], [2, ""], [2, null],
    [3, "viewer"], [3, "user"], [3, "OWNER"], [3, null], [4, ""], [4, "x".repeat(1201)], [4, null], [5, "a".repeat(63)], [5, null],
    [6, "deleted"], [6, null], [8, null],
  ];
  for (const [i, value] of bad) {
    const row = [...ok];
    row[0] = `cmt_bad_${i}_${String(value).length}`;
    row[i] = value;
    refused(raw, insert, row, `column ${i} = ${String(value).slice(0, 12)}`);
  }
  // Hidden exactly when hidden_by is set: a comment is hidden by someone, and a visible one names nobody.
  for (const [status, by] of [["hidden", null], ["visible", "o@example.com"], ["hidden", ""]] as const) {
    refused(raw, insert, ["cmt_bad_hidden", ok[1], ok[2], "reviewer", "ok", H64, status, by, "t0"], `${status} by ${String(by)}`);
  }
  raw.prepare("UPDATE collab_comments SET status = 'hidden', hidden_by = 'o@example.com' WHERE comment_id = 'cmt_default'").run();
  refused(raw, "UPDATE collab_comments SET status = 'hidden' WHERE comment_id = 'cmt_operator'", [], "hidden without hidden_by");
});

test("H5d-5. conversation_collab_budget: one row per (day, actor), a collaborator role only, turns never negative", () => {
  const { raw } = migratedDb();
  const insert = "INSERT INTO conversation_collab_budget (day, actor, role, turns) VALUES (?, ?, ?, ?)";
  for (const [n, role] of ["reviewer", "operator", "approver"].entries()) raw.prepare(insert).run("2026-11-19", `a${n}@example.com`, role, 5);
  raw.prepare("INSERT INTO conversation_collab_budget (day, actor, role) VALUES ('2026-11-20', 'a0@example.com', 'reviewer')").run();
  assert.deepEqual({ ...raw.prepare("SELECT turns FROM conversation_collab_budget WHERE day = '2026-11-20'").get() }, { turns: 0 });
  assert.deepEqual({ ...raw.prepare("SELECT SUM(turns) AS pool FROM conversation_collab_budget WHERE day = '2026-11-19'").get() }, { pool: 15 }, "the shared pool is the day's sum");
  refused(raw, insert, ["2026-11-19", "a0@example.com", "reviewer", 1], "the same (day, actor) twice");
  const bad: Array<[number, string | number | null]> = [[0, "2026-11-1"], [0, null], [1, ""], [1, null], [2, "owner"], [2, "viewer"], [2, null], [3, -1], [3, null]];
  for (const [i, value] of bad) {
    const row: Array<string | number | null> = ["2026-11-21", `b${i}${String(value).length}@example.com`, "operator", 1];
    row[i] = value;
    refused(raw, insert, row, `column ${i} = ${String(value)}`);
  }
  // The owner's pool is its own table and unchanged (0078).
  assert.deepEqual(columns(raw, "conversation_budget"), ["day", "turns"]);
});

test("H5d-6. collab_controls: only collaborators_enabled, value '0' or '1'; conversation_controls is unchanged", () => {
  const { raw } = migratedDb();
  const insert = "INSERT INTO collab_controls (control, value, updated_by, updated_at) VALUES (?, ?, ?, ?)";
  raw.prepare(insert).run("collaborators_enabled", "1", "o@example.com", "t0");
  raw.prepare("UPDATE collab_controls SET value = '0', updated_by = 'ops@example.com' WHERE control = 'collaborators_enabled'").run();
  refused(raw, insert, ["collaborators_enabled", "1", "o@example.com", "t0"], "one row per control");
  for (const control of ["enabled", "agents_enabled", "COLLABORATORS_ENABLED", null]) refused(raw, insert, [control, "1", "o@example.com", "t0"], `control ${String(control)}`);
  for (const [column, value] of [["value", "2"], ["value", "on"], ["value", null], ["updated_by", ""], ["updated_by", null], ["updated_at", null]] as const) {
    refused(raw, `UPDATE collab_controls SET ${column} = ? WHERE control = 'collaborators_enabled'`, [value], `${column} ${String(value)}`);
  }
  refused(raw, "INSERT INTO conversation_controls (control, value, updated_by, updated_at) VALUES ('collaborators_enabled', '1', 'o', 't0')", [], "the chat's own switch still admits only 'enabled'");
});

test("H5d-7. readiness: the AI Kernel and the Platform Registry require 0085; every other service still needs nothing after 0029", async () => {
  assert.deepEqual([...COLLABORATOR_MIGRATIONS], [MIGRATION]);
  assert.equal(REQUIRED_MIGRATION, "0029_knowledge_proposals.sql", "the list every service needs still ends at 0029 (executor-first.ts)");
  const db = migratedDb();
  const stub = { idFromName: (n: string) => n, get: () => ({}) };
  const kernelEnv = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL }),
    POLICY: {}, RECOVERY: {}, SUPERVISOR: stub, SIGNAL_ANALYST: stub, AUDITOR: stub, MEMORY: {},
  };
  const registryEnv = baseEnv("cryptophys-platform-registry", db);
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  for (const [name, worker, env] of [["kernel", kernel, kernelEnv], ["registry", registry, registryEnv], ["policy", policy, policyEnv]] as const) {
    const ready = await call(worker, env, req("GET", "/ready"));
    assert.deepEqual([ready.status, ready.body.status, ready.body.checks.database_schema], [200, "ready", true], `${name} with 0085`);
  }
  db.raw.prepare("DELETE FROM d1_migrations WHERE name = ?").run(MIGRATION);
  for (const [name, worker, env] of [["kernel", kernel, kernelEnv], ["registry", registry, registryEnv]] as const) {
    const unready = await call(worker, env, req("GET", "/ready"));
    assert.deepEqual([unready.status, unready.body.status, unready.body.checks.database_schema], [503, "not_ready", false], `${name} without 0085`);
    assert.ok(Object.entries(unready.body.checks).every(([k, v]) => k === "database_schema" || v === true), `${name}: only the schema check fails`);
  }
  // A service that does not use the collaborator tables (here the Policy Engine; the Orchestrator, Forge, Console and
  // Platform API call schemaReady without it the same way) stays ready, so a pending 0085 makes none of them unready.
  assert.equal((await call(policy, policyEnv, req("GET", "/ready"))).status, 200);
  assert.equal(await schemaReady({ DB: db } as never), true);
  assert.equal(await schemaReady({ DB: db } as never, COLLABORATOR_MIGRATIONS), false);
});
