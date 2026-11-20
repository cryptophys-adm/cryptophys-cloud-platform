// Ledger anchors outside D1 (owner 2026-11-20, "4a semuanya"; ADR-0021 "Tamper evidence"): once per UTC day the
// Recovery Manager writes the head of the platform's audit_events chain and of xauusd's published signal-ledger head
// to the locked R2 bucket cryptophys-ledger-anchors, with OpenTimestamps proofs, and audits it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migratedDb } from "./harness.ts";
import { appendAuditEvent } from "../src/audit.ts";
import { ANCHOR_BUCKET, ANCHOR_RETENTION_DAYS, ANCHOR_SCHEMA, OTS_CALENDARS, OTS_MAGIC, anchorTick, otsFile, type AnchorBucket } from "../../recovery-manager/src/anchor.ts";

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
const NOW = Date.parse("2026-11-20T12:13:00.000Z");
const H64 = "ab".repeat(32);

function bucket() {
  const objects = new Map<string, { body: Uint8Array; meta?: Record<string, string> }>();
  const b: AnchorBucket = {
    async head(key) { return objects.has(key) ? { key } : null; },
    async put(key, value, opts) {
      if (objects.has(key)) throw new Error("locked: object exists"); // the bucket lock refuses an overwrite
      objects.set(key, { body: typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value as ArrayBuffer), meta: opts?.customMetadata });
      return {};
    },
  };
  return { b, objects };
}
function calendars(answer = Uint8Array.of(0xf0, 0x10, 0x00, 0x83, 0xdf, 0xe3, 0x0d, 0x2e, 0xf9, 0x0c, 0x8e), fail: string[] = []) {
  const calls: { url: string; body: Uint8Array; headers: Record<string, string> }[] = [];
  const fetchFn = async (url: string, init: { body: Uint8Array; headers: Record<string, string> }) => {
    calls.push({ url, body: init.body, headers: init.headers });
    if (fail.some((f) => url.includes(f))) throw new Error("down");
    return { ok: true, status: 200, arrayBuffer: async () => answer.slice().buffer };
  };
  return { fetchFn: fetchFn as never, calls };
}
const audits = (db: ReturnType<typeof migratedDb>, type: string) =>
  (db.raw.prepare("SELECT subject, outcome, payload_json FROM audit_events WHERE event_type = ? ORDER BY rowid").all(type) as any[]).map((r) => ({ ...r, payload: JSON.parse(r.payload_json) }));
const report = (db: ReturnType<typeof migratedDb>, id: string, agent: string, body: unknown, at: string) =>
  db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at) VALUES (?, ?, 'xauusd_digest', 'info', 'ledger anchor', ?, 'deterministic', NULL, ?)")
    .run(id, agent, JSON.stringify(body), at);

test("LX1. the platform's audit chain head is anchored once per UTC day, with its sha256, and each calendar's .ots proof", async () => {
  const db = migratedDb();
  for (let i = 0; i < 5; i++) await appendAuditEvent(db as never, { event_type: "t.x", actor: "a", subject: `s${i}`, outcome: "ok", payload: { i } });
  const head = db.raw.prepare("SELECT event_id, event_hash FROM audit_events ORDER BY rowid DESC LIMIT 1").get() as { event_id: string; event_hash: string };
  const { b, objects } = bucket();
  const cal = calendars();
  const r = await anchorTick({ DB: db as never, ANCHORS: b }, NOW, cal.fetchFn);
  assert.deepEqual([r.outcome, r.written], ["written", ["platform/audit_events/2026-11-20.json"]]);
  const obj = objects.get("platform/audit_events/2026-11-20.json")!;
  const body = JSON.parse(new TextDecoder().decode(obj.body));
  assert.deepEqual([body.schema, body.source, body.day, body.head_event_id, body.head_hash, body.chain_valid], [ANCHOR_SCHEMA, "platform.audit_events", "2026-11-20", head.event_id, head.event_hash, true]);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", obj.body as Uint8Array<ArrayBuffer>));
  const hex = Array.from(digest, (x) => x.toString(16).padStart(2, "0")).join("");
  assert.equal(obj.meta?.sha256, hex);
  // One POST of the raw 32-byte digest to each calendar, and a detached .ots file per answer.
  assert.deepEqual(cal.calls.map((c) => c.url), OTS_CALENDARS.map(([, u]) => `${u}/digest`));
  for (const c of cal.calls) { assert.deepEqual(c.body, digest); assert.equal(c.headers.Accept, "application/vnd.opentimestamps.v1"); }
  for (const [label] of OTS_CALENDARS) {
    const ots = objects.get(`platform/audit_events/2026-11-20.json.${label}.ots`)!.body;
    assert.deepEqual(ots.slice(0, OTS_MAGIC.length), OTS_MAGIC, "the OpenTimestamps header magic");
    assert.deepEqual([ots[OTS_MAGIC.length], ots[OTS_MAGIC.length + 1]], [0x01, 0x08], "version 1, file hash SHA-256");
    assert.deepEqual(ots.slice(OTS_MAGIC.length + 2, OTS_MAGIC.length + 34), digest);
  }
  const [ev] = audits(db, "ledger.anchor_written");
  assert.deepEqual([ev.subject, ev.outcome, ev.payload.sha256, ev.payload.ots, ev.payload.ots_failed], ["platform/audit_events/2026-11-20.json", "written", hex, ["a", "b"], []]);
  // Later the same day: nothing is rewritten, nothing is submitted.
  const again = await anchorTick({ DB: db as never, ANCHORS: b }, NOW + 3_600_000, cal.fetchFn);
  assert.deepEqual([again.outcome, again.skipped], ["not_due", ["platform/audit_events/2026-11-20.json"]]);
  assert.equal(cal.calls.length, 2);
  // The next day: a new anchor.
  assert.equal((await anchorTick({ DB: db as never, ANCHORS: b }, NOW + 24 * 3_600_000, cal.fetchFn)).outcome, "written");
  assert.ok(objects.has("platform/audit_events/2026-11-21.json"));
});

test("LX2. xauusd's published ledger_anchor.v1 head is anchored per ledger and day; malformed, foreign or stale reports are not", async () => {
  const db = migratedDb();
  const { b, objects } = bucket();
  report(db, "rpt_old", "xauusd-risk-manager", { schema: ANCHOR_SCHEMA, ledger: "signal_ledger", day: "2026-11-18", head_hash: H64, events: 9 }, "2026-11-18T23:00:00.000Z");
  report(db, "rpt_bad", "xauusd-risk-manager", { schema: ANCHOR_SCHEMA, ledger: "signal_ledger", day: "2026-11-20", head_hash: "not-a-hash", events: 3 }, "2026-11-20T11:00:00.000Z");
  report(db, "rpt_other", "signal-analyst", { schema: ANCHOR_SCHEMA, ledger: "signal_ledger", day: "2026-11-20", head_hash: H64, events: 3 }, "2026-11-20T11:01:00.000Z");
  report(db, "rpt_1", "xauusd-risk-manager", { schema: ANCHOR_SCHEMA, ledger: "signal_ledger", day: "2026-11-20", head_hash: "cd".repeat(32), events: 41 }, "2026-11-20T11:02:00.000Z");
  report(db, "rpt_2", "xauusd-risk-manager", { schema: ANCHOR_SCHEMA, ledger: "signal_ledger", day: "2026-11-20", head_hash: H64, events: 42 }, "2026-11-20T11:30:00.000Z");
  const r = await anchorTick({ DB: db as never, ANCHORS: b }, NOW, calendars().fetchFn);
  assert.deepEqual((r.written as string[]).sort(), ["platform/audit_events/2026-11-20.json", "xauusd/signal_ledger/2026-11-20.json"]);
  const body = JSON.parse(new TextDecoder().decode(objects.get("xauusd/signal_ledger/2026-11-20.json")!.body));
  assert.deepEqual([body.source, body.head_hash, body.events, body.report_id], ["xauusd.signal_ledger", H64, 42, "rpt_2"], "the newest report for the day");
  assert.ok(!objects.has("xauusd/signal_ledger/2026-11-18.json"), "older than 26 hours");
  assert.equal([...objects.keys()].filter((k) => k.startsWith("xauusd/") && k.endsWith(".json")).length, 1);
});

test("LX3. calendars that fail leave the anchor written and audited; an invalid audit chain is anchored as chain_invalid", async () => {
  const db = migratedDb();
  await appendAuditEvent(db as never, { event_type: "t.x", actor: "a", subject: "s", outcome: "ok", payload: {} });
  await appendAuditEvent(db as never, { event_type: "t.y", actor: "a", subject: "s", outcome: "ok", payload: {} });
  db.raw.exec("DROP TRIGGER IF EXISTS audit_events_no_update; UPDATE audit_events SET subject = 'tampered' WHERE event_type = 't.x'");
  const { b, objects } = bucket();
  const r = await anchorTick({ DB: db as never, ANCHORS: b }, NOW, calendars(undefined, ["a.pool", "b.pool"]).fetchFn);
  assert.equal(r.outcome, "written");
  const body = JSON.parse(new TextDecoder().decode(objects.get("platform/audit_events/2026-11-20.json")!.body));
  assert.equal(body.chain_valid, false);
  assert.ok(body.first_invalid_event_id);
  assert.ok(![...objects.keys()].some((k) => k.endsWith(".ots")));
  const [ev] = audits(db, "ledger.anchor_written");
  assert.deepEqual([ev.outcome, ev.payload.ots, ev.payload.ots_failed], ["chain_invalid", [], ["a:unreachable", "b:unreachable"]]);
});

test("LX4. no bucket, nothing; a bucket that throws is audited as ledger.anchor_failed and nothing is thrown", async () => {
  const db = migratedDb();
  assert.deepEqual(await anchorTick({ DB: db as never }, NOW), { outcome: "not_configured" });
  const broken: AnchorBucket = { async head() { throw new Error("R2 internal error"); }, async put() { return {}; } };
  const r = await anchorTick({ DB: db as never, ANCHORS: broken }, NOW, calendars().fetchFn);
  assert.equal(r.outcome, "failed");
  assert.equal(audits(db, "ledger.anchor_failed").length, 1);
  assert.throws(() => otsFile(new Uint8Array(31), new Uint8Array(4)), /digest_must_be_32_bytes/);
});

test("LX5. the Recovery Manager binds the locked bucket and runs the anchor in its scheduled handler; xauusd gets no binding", () => {
  const toml = read("workers/recovery-manager/wrangler.toml");
  assert.match(toml, /\[\[r2_buckets\]\]\nbinding = "ANCHORS"\nbucket_name = "cryptophys-ledger-anchors"/);
  assert.equal(ANCHOR_BUCKET, "cryptophys-ledger-anchors");
  assert.equal(ANCHOR_RETENTION_DAYS, 1095, "the bucket lock's 3 years");
  const idx = read("workers/recovery-manager/src/index.ts");
  assert.match(idx, /ctx\.waitUntil\(anchorTick\(env\)/);
  for (const f of ["workers/ai-kernel/wrangler.toml", "workers/platform-api/wrangler.toml", "workers/forge/wrangler.toml"]) {
    assert.doesNotMatch(read(f), /cryptophys-ledger-anchors/, `${f}: only the Recovery Manager writes anchors`);
  }
  const adr = read("architecture/adr/0021-self-improvement-protocol.md");
  assert.match(adr, /registry entries and validator verdicts are written to a hash-chained log anchored outside D1, and a broken chain blocks auto-deploys until it is verified/);
  assert.match(adr, /"4a semuanya"/);
});
