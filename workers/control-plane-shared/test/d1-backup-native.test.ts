// Cloudflare-native D1 backup fallback (owner decision 2026-11-07): the Recovery Manager writes a
// SQL dump of D1 to the private R2 bucket through its bindings when no backup is newer than 24 h.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { migratedDb } from "./harness.ts";
import { appendAuditEvent, verifyAuditChain } from "../src/audit.ts";
import { backupIfStale, dumpSql, sqlLiteral, type R2BucketLike } from "../../recovery-manager/src/backup.ts";
import recoveryWorker from "../../recovery-manager/src/index.ts";
import { ARCHIVE_PREFIX, RETIRED_SIGNAL_TABLES, archiveKey, archiveRetiredTables, type ArchiveBucket } from "../../recovery-manager/src/archive.ts";

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

/** The retired signal tables as their original migrations created them (0062 dropped them from the schema). */
function withRetiredTables(db: ReturnType<typeof migratedDb>) {
  const dir = new URL("workers/control-plane-migrations/", ROOT);
  const sql = ["0004_signal_engine_and_external_services.sql", "0005_signal_ingest_runs.sql", "0006_signal_engines_and_confluence.sql", "0007_macro_context.sql", "0008_signal_confluence_mizan.sql"]
    .map((f) => readFileSync(new URL(f, dir), "utf8")).join("\n");
  for (const t of RETIRED_SIGNAL_TABLES) {
    const m = new RegExp(`CREATE TABLE ${t} \\([\\s\\S]*?\\n\\);`).exec(sql);
    if (!m) throw new Error(`no CREATE TABLE for ${t}`);
    db.raw.exec(m[0]);
  }
  return db;
}

function archiveBucket() {
  const objects = new Map<string, { body: ArrayBuffer; meta: Record<string, string> }>();
  const calls = { head: 0, put: 0, get: 0 };
  const bucket: ArchiveBucket = {
    async head(key) { calls.head++; return objects.has(key) ? {} : null; },
    async put(key, body, opts) { calls.put++; objects.set(key, { body, meta: opts?.customMetadata ?? {} }); return {}; },
    async get(key) { calls.get++; const o = objects.get(key); return o ? { arrayBuffer: async () => o.body, customMetadata: o.meta } : null; },
  };
  return { bucket, objects, calls };
}

test("N6. retired signal tables: archived once to R2 outside the lifecycle prefix, read back and counted against D1, audited; then a no-op (2026-11-14)", async () => {
  const db = withRetiredTables(migratedDb());
  const ins = db.raw.prepare("INSERT INTO market_candles (symbol, timeframe, open_time, close_time, open, high, low, close, volume, source, ingested_at) VALUES (?, '1h', ?, ?, 1, 2, 0.5, 1.5, 10, ?, '2026-11-01T00:00:00Z')");
  for (let i = 0; i < 1203; i++) ins.run(i % 2 ? "BTCUSDT" : "ETHUSDT", i + 1, i + 2, i % 2 ? "k" : "it's\nINSERT INTO \"market_candles\" (");
  db.raw.prepare("INSERT INTO signal_ingest_runs (run_id, trigger, started_at, finished_at, series_total, series_failed, results_json) VALUES ('r1', 'scheduled', 't', 't', 1, 0, ?)").run(JSON.stringify({ a: "line\nbreak" }));
  const { bucket, objects, calls } = archiveBucket();
  const out = await archiveRetiredTables({ DB: db as never, BACKUPS: bucket });
  assert.equal(out.status, "done");
  const states = (out as any).tables.map((t: any) => [t.table, t.state, t.rows ?? null, t.d1_rows ?? null]);
  assert.deepEqual(states, [["market_candles", "verified", 1203, 1203], ["signal_indicators", "verified", 0, 0], ["signal_confluence", "verified", 0, 0], ["signal_ingest_runs", "verified", 1, 1], ["macro_context", "verified", 0, 0]]);
  assert.ok(ARCHIVE_PREFIX.startsWith("archive/") && !ARCHIVE_PREFIX.startsWith("control-plane/"), "outside the 90-day lifecycle rule (control-plane/)");
  assert.deepEqual([...objects.keys()].sort(), RETIRED_SIGNAL_TABLES.map(archiveKey).sort());
  // The archived script restores the rows exactly.
  const restored = new DatabaseSync(":memory:");
  restored.exec(gunzipSync(Buffer.from(objects.get(archiveKey("market_candles"))!.body)).toString("utf8"));
  assert.equal((restored.prepare("SELECT COUNT(*) AS n FROM market_candles WHERE symbol = 'ETHUSDT' AND source LIKE 'it''s%'").get() as any).n, 602);
  assert.equal(objects.get(archiveKey("market_candles"))!.meta.rows, "1203");
  const exact = (d: any) => d.prepare("SELECT source FROM market_candles WHERE open_time = 1").get().source;
  assert.equal(exact(restored), exact(db.raw), "a value with a line break restores byte for byte");
  assert.equal(exact(restored), "it's\nINSERT INTO \"market_candles\" (");
  const audits = db.raw.prepare("SELECT subject, outcome, payload_json FROM audit_events WHERE event_type = 'backup.archive_verified' ORDER BY rowid").all() as any[];
  assert.deepEqual(audits.map((a) => [a.subject, a.outcome]), RETIRED_SIGNAL_TABLES.map((t) => [archiveKey(t), "verified"]));
  // Verified tables cost no R2 call afterwards.
  const before = { ...calls };
  await archiveRetiredTables({ DB: db as never, BACKUPS: bucket });
  assert.deepEqual(calls, before);
  // A table whose rows changed after archiving is reported, not passed: the next run compares again.
  const { bucket: b2, calls: c2 } = archiveBucket();
  const db2 = withRetiredTables(migratedDb());
  const first = await archiveRetiredTables({ DB: db2 as never, BACKUPS: b2 });
  assert.ok((first as any).tables.every((t: any) => t.state === "verified"));
  assert.equal(c2.put, 5);
  // Once a table is dropped, it is skipped.
  db.raw.exec("DROP TABLE signal_indicators; DROP TABLE signal_confluence; DROP TABLE market_candles; DROP TABLE signal_ingest_runs; DROP TABLE macro_context;");
  const gone = await archiveRetiredTables({ DB: db as never, BACKUPS: bucket });
  assert.ok((gone as any).tables.every((t: any) => t.state === "dropped"));
  assert.deepEqual(calls, before, "no R2 call once the tables are gone");
});

test("N7. a mismatch between the archive and D1 is audited as mismatch, never as verified", async () => {
  const db = withRetiredTables(migratedDb());
  db.raw.prepare("INSERT INTO macro_context (observed_hour, fear_greed, fear_greed_sentiment, btc_dominance, total_market_cap, sources_json, observed_at) VALUES (1, 50, 0, 50, 1, '{}', 't')").run();
  const { bucket, objects } = archiveBucket();
  // An archive object already present but missing the row (written before the row existed).
  const gz = gzipSync(Buffer.from("CREATE TABLE x (a);\n"));
  objects.set(archiveKey("macro_context"), { body: gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) as ArrayBuffer, meta: {} });
  const out = await archiveRetiredTables({ DB: db as never, BACKUPS: bucket });
  const macro = (out as any).tables.find((t: any) => t.table === "macro_context");
  assert.deepEqual([macro.state, macro.rows, macro.d1_rows], ["mismatch", 0, 1]);
  assert.equal((db.raw.prepare("SELECT outcome FROM audit_events WHERE event_type = 'backup.archive_verified' AND subject = ?").get(archiveKey("macro_context")) as any).outcome, "mismatch");
});

test("N8. after migration 0062 the archive step is a no-op: every retired table reads as dropped, no R2 call", async () => {
  const db = migratedDb();
  const { bucket, calls } = archiveBucket();
  const out = await archiveRetiredTables({ DB: db as never, BACKUPS: bucket });
  assert.ok((out as any).tables.every((t: any) => t.state === "dropped"));
  assert.deepEqual(calls, { head: 0, put: 0, get: 0 });
});

