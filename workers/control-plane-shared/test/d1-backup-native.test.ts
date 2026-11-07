// Cloudflare-native D1 backup fallback (owner decision 2026-11-07): the Recovery Manager writes a
// SQL dump of D1 to the private R2 bucket through its bindings when no backup is newer than 24 h.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { migratedDb } from "./harness.ts";
import { appendAuditEvent, verifyAuditChain } from "../src/audit.ts";
import { backupIfStale, dumpSql, sqlLiteral, type R2BucketLike } from "../../recovery-manager/src/backup.ts";
import recoveryWorker from "../../recovery-manager/src/index.ts";

const ROOT = new URL("../../../", import.meta.url);

function fakeBucket(existing: { key: string; uploaded: Date }[] = []) {
  const puts: { key: string; body: ArrayBuffer; meta: Record<string, string> }[] = [];
  const bucket: R2BucketLike = {
    async list(o) { return { objects: existing.filter((x) => x.key.startsWith(o?.prefix ?? "")).map((x) => ({ ...x, size: 1 })) }; },
    async put(key, body, opts) { puts.push({ key, body, meta: opts?.customMetadata ?? {} }); return {}; },
  };
  return { bucket, puts };
}

test("N1. literals: NULL, numbers, quotes and blobs", () => {
  assert.equal(sqlLiteral(null), "NULL");
  assert.equal(sqlLiteral(42), "42");
  assert.equal(sqlLiteral("it's"), "'it''s'");
  assert.equal(sqlLiteral(new Uint8Array([0, 255])), "X'00ff'");
  assert.equal(sqlLiteral([1, 2]), "X'0102'");
});

test("N2. the dump restores into an empty database with identical rows and a valid audit chain", async () => {
  const db = migratedDb();
  for (let i = 0; i < 1203; i++) await appendAuditEvent(db as never, { event_type: "t", actor: "a", subject: `s'${i}`, outcome: "ok", payload: { i, q: "x\"y" } });
  const { sql, tables, rows } = await dumpSql(db as never);
  assert.ok(tables > 20 && rows >= 1203);
  const restored = new DatabaseSync(":memory:");
  restored.exec(sql);
  for (const t of (db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])) {
    const a = db.raw.prepare(`SELECT COUNT(*) n FROM "${t.name}"`).get() as { n: number };
    const b = restored.prepare(`SELECT COUNT(*) n FROM "${t.name}"`).get() as { n: number };
    assert.equal(b.n, a.n, t.name);
  }
  const same = (d: DatabaseSync) => d.prepare("SELECT event_hash FROM audit_events ORDER BY rowid").all();
  assert.deepEqual(same(restored), same(db.raw));
  // Triggers come back too: the restored ledger is still append-only.
  assert.throws(() => restored.exec("UPDATE audit_events SET outcome = 'x'"));
});

test("N3. fallback rules: writes when no backup is newer than 24 h, skips a fresh one, never deletes", async () => {
  const now = Date.parse("2026-11-07T03:13:00Z");
  const fresh = fakeBucket([{ key: "control-plane/2026-11-07T024130Z.sql.gz", uploaded: new Date("2026-11-07T02:42:00Z") }]);
  const db = migratedDb();
  assert.deepEqual(await backupIfStale({ DB: db as never, BACKUPS: fresh.bucket }, now), { status: "fresh", latest: "2026-11-07T02:42:00.000Z" });
  assert.equal(fresh.puts.length, 0);

  const stale = fakeBucket([{ key: "control-plane/2026-11-06T024130Z.sql.gz", uploaded: new Date("2026-11-06T02:42:00Z") }]);
  const out = await backupIfStale({ DB: db as never, BACKUPS: stale.bucket }, now);
  assert.equal(out.status, "written");
  assert.equal(stale.puts[0].key, "control-plane/2026-11-07T031300Z.sql.gz", "same key format as d1-backup.yml");
  assert.match(gunzipSync(Buffer.from(stale.puts[0].body)).toString(), /^PRAGMA defer_foreign_keys=TRUE;\nCREATE TABLE/);
  assert.equal(stale.puts[0].meta.source, "cryptophys-recovery-manager");
  const ev = db.raw.prepare("SELECT subject, outcome FROM audit_events WHERE event_type = 'backup.d1_written'").get() as any;
  assert.deepEqual([ev.subject, ev.outcome], ["control-plane/2026-11-07T031300Z.sql.gz", "succeeded"]);
  assert.equal((await verifyAuditChain(db as never)).valid, true);
  assert.deepEqual(await backupIfStale({ DB: db as never }, now), { status: "no_binding" });
  assert.doesNotMatch(readFileSync(new URL("workers/recovery-manager/src/backup.ts", ROOT), "utf8"), /\.delete\(/, "the fallback never deletes");
});

test("N4. wiring: hourly cron and the private bucket binding on the Recovery Manager", async () => {
  const toml = readFileSync(new URL("workers/recovery-manager/wrangler.toml", ROOT), "utf8");
  assert.match(toml, /crons = \["13 \* \* \* \*"\]/);
  assert.match(toml, /\[\[r2_buckets\]\]\nbinding = "BACKUPS"\nbucket_name = "cryptophys-d1-backups"/);
  assert.match(readFileSync(new URL(".github/workflows/d1-backup.yml", ROOT), "utf8"), /BUCKET: cryptophys-d1-backups/);
  const waits: Promise<unknown>[] = [];
  const { bucket, puts } = fakeBucket();
  await (recoveryWorker as any).scheduled({ cron: "13 * * * *", scheduledTime: Date.now() }, { DB: migratedDb(), BACKUPS: bucket }, { waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await Promise.all(waits);
  assert.equal(puts.length, 1);
});

test("N5. primary since 2026-11-07: GitHub's d1-backup.yml has no schedule, and a failed native backup is audited", async () => {
  const wf = readFileSync(new URL(".github/workflows/d1-backup.yml", ROOT), "utf8");
  assert.doesNotMatch(wf, /^\s*schedule:/m, "no nightly GitHub schedule");
  assert.match(wf, /^\s*workflow_dispatch:/m, "kept for an on-demand copy");
  const db = migratedDb();
  const broken: R2BucketLike = { async list() { throw new Error("r2 unavailable"); }, async put() { return {}; } };
  const waits: Promise<unknown>[] = [];
  await (recoveryWorker as any).scheduled({ cron: "13 * * * *", scheduledTime: Date.now() }, { DB: db, BACKUPS: broken }, { waitUntil: (p: Promise<unknown>) => waits.push(p) });
  await assert.rejects(Promise.all(waits), /r2 unavailable/, "scheduled waitUntil promise must reject after recording the failure");
  const ev = db.raw.prepare("SELECT outcome, payload_json FROM audit_events WHERE event_type = 'backup.d1_failed'").get() as any;
  assert.equal(ev.outcome, "failed");
  assert.match(ev.payload_json, /r2 unavailable/);
});
