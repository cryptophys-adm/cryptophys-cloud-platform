// HAIC H1.5e (docs/design/HAIC-H0-H1.md §4.4 "Records"; exit criterion: "every session is fully audited, with its
// transcript hash matching the R2 object"): a closed council's transcript is one R2 object, its body exactly what
// transcript_sha256 hashes; a failure is audited and retried by the kernel's hourly pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { baseEnv, migratedDb } from "./harness.ts";
import { CouncilError, archiveTranscript, dismissCouncil, proposeCouncil, readCouncil, transcriptKey, type CouncilStore } from "../../ai-kernel/src/council.ts";
import { ARCHIVE_BATCH, storeMissingTranscripts } from "../../ai-kernel/src/council-archive.ts";
import { listCouncils } from "../../ai-kernel/src/council.ts";

const NOW = Date.parse("2026-11-18T11:00:00.000Z");
const ID = (n: number) => `cs_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function memStore(): CouncilStore { const m = new Map<string, unknown>(); return { get: async <T>(k: string) => structuredClone(m.get(k)) as T | undefined, put: async (k: string, v: unknown) => { m.set(k, structuredClone(v)); } }; }
function bucket(fail = false) {
  const objects = new Map<string, { body: string; options: any }>();
  return { objects, put: async (key: string, body: string, options: any) => { if (fail) throw new Error("R2 unavailable"); objects.set(key, { body, options }); return {}; } };
}
function setup(r2?: ReturnType<typeof bucket>) {
  const db = migratedDb();
  const env: any = { ...baseEnv("cryptophys-ai-kernel", db), TRANSCRIPTS: r2 };
  const stores = new Map<string, CouncilStore>();
  const storeOf = (id: string) => { if (!stores.has(id)) stores.set(id, memStore()); return stores.get(id)!; };
  const events = (type: string) => (db.raw.prepare("SELECT outcome, payload_json FROM audit_events WHERE event_type = ? ORDER BY rowid").all(type) as any[]).map((e) => ({ outcome: e.outcome, ...JSON.parse(e.payload_json) }));
  return { db, env, storeOf, events };
}
async function closed(s: ReturnType<typeof setup>, n: number) {
  await proposeCouncil(s.env, s.storeOf(ID(n)), { session_id: ID(n), proposed_by: "agent:auditor", trigger_kind: "finding", topic: `Persistent census finding ${n}`,
    question: "Should the DNA change?", refs: ["ev:platform/census/abcdefabcdef#findings"], detail: "Reported for 2 days." }, NOW);
  return dismissCouncil(s.env, s.storeOf(ID(n)), "owner@example.com", NOW + 60_000);
}

test("E1. a closed council's transcript is one R2 object whose sha256 is the one in D1 and the audit chain; stored once", async () => {
  const r2 = bucket();
  const s = setup(r2);
  const c = await closed(s, 1);
  assert.equal(c.state, "dismissed");
  const r = await archiveTranscript(s.env, s.storeOf(ID(1)), NOW + 120_000);
  assert.deepEqual(r, { stored: true, key: `councils/${ID(1)}.json` });
  assert.equal(transcriptKey(ID(1)), r.key);
  const obj = r2.objects.get(r.key!)!;
  const sha = createHash("sha256").update(obj.body).digest("hex");
  const row = s.db.raw.prepare("SELECT transcript_sha256, transcript_key FROM councils WHERE session_id = ?").get(ID(1)) as any;
  assert.deepEqual([row.transcript_sha256, row.transcript_key], [sha, r.key], "the object hashes to the stored sha256");
  const { session, messages } = await readCouncil(s.storeOf(ID(1)));
  assert.equal(obj.body, JSON.stringify(messages), "the body is exactly the messages that were hashed");
  assert.deepEqual([session.transcript_key, session.transcript_sha256], [r.key, sha]);
  assert.deepEqual(obj.options, { httpMetadata: { contentType: "application/json" }, customMetadata: { schema: "council.transcript.v1", session_id: ID(1), state: "dismissed", sha256: sha, messages: String(messages.length) } });
  const stored = s.events("council.transcript_stored");
  assert.deepEqual(stored.map((e) => [e.outcome, e.key, e.sha256, e.messages]), [["stored", r.key, sha, messages.length]]);
  assert.ok(stored[0].bytes > 0);
  assert.deepEqual(await archiveTranscript(s.env, s.storeOf(ID(1)), NOW + 180_000), { stored: false, key: r.key, reason: "already_stored" });
  assert.equal(r2.objects.size, 1);
  const list = await listCouncils(s.db) as any;
  assert.equal(list.councils[0].transcript_key, r.key);
});

test("E2. not closed, no binding, or R2 failing: nothing is stored; a failure is audited and the hourly pass stores it later", async () => {
  const failing = bucket(true);
  const s = setup(failing);
  await proposeCouncil(s.env, s.storeOf(ID(2)), { session_id: ID(2), proposed_by: "agent:auditor", trigger_kind: "finding", topic: "Open proposal", question: "Q?", refs: ["ev:platform/census/abcdefabcdef#findings"], detail: "d" }, NOW);
  assert.deepEqual(await archiveTranscript(s.env, s.storeOf(ID(2)), NOW), { stored: false, reason: "not_closed" }, "a proposal is not closed");
  await closed(s, 3);
  assert.deepEqual(await archiveTranscript(s.env, s.storeOf(ID(3)), NOW + 120_000), { stored: false, reason: "r2_error" });
  assert.deepEqual(s.events("council.transcript_store_failed").map((e) => [e.outcome, e.message]), [["r2_error", "R2 unavailable"]]);
  assert.equal((s.db.raw.prepare("SELECT transcript_key FROM councils WHERE session_id = ?").get(ID(3)) as any).transcript_key, null);
  assert.deepEqual(await archiveTranscript({ ...s.env, TRANSCRIPTS: undefined }, s.storeOf(ID(3)), NOW), { stored: false, reason: "no_binding" });

  // The hourly pass: the bucket works again; the object is asked to store it.
  const r2 = bucket();
  s.env.TRANSCRIPTS = r2;
  const settle = async (op: () => Promise<unknown>) => { try { return { ok: true, value: await op() }; } catch (e) { if (e instanceof CouncilError) return { ok: false, code: e.code }; throw e; } };
  s.env.COUNCIL = { idFromName: (n: string) => n, get: (n: string) => ({ storeTranscript: () => settle(() => archiveTranscript(s.env, s.storeOf(n), NOW + 3_600_000)) }) };
  assert.deepEqual(await storeMissingTranscripts(s.env), { asked: [ID(3)], stored: [ID(3)] });
  assert.ok(r2.objects.has(`councils/${ID(3)}.json`));
  assert.deepEqual(await storeMissingTranscripts(s.env), { asked: [], stored: [] }, "nothing left");
  assert.deepEqual(await storeMissingTranscripts({ DB: s.db as never, COUNCIL: s.env.COUNCIL }), { asked: [], stored: [], reason: "no_binding" });
  assert.equal(ARCHIVE_BATCH, 5);
});

test("E3. wiring: the bucket binding, migration 0081 additive, the hourly retry, and modules that write only the transcript", () => {
  const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
  assert.match(read("workers/ai-kernel/wrangler.toml"), /\[\[r2_buckets\]\]\nbinding = "TRANSCRIPTS"\nbucket_name = "cryptophys-council-transcripts"/);
  const mig = read("workers/control-plane-migrations/0081_council_transcripts.sql");
  const code = mig.split("\n").map((l) => l.split("--")[0]).join("\n").toUpperCase();
  assert.ok(!/\b(DROP|DELETE|UPDATE|INSERT|RENAME)\b/.test(code) && (code.match(/ALTER TABLE COUNCILS ADD COLUMN TRANSCRIPT_KEY/g) ?? []).length === 1, "0081 only adds the column");
  const idx = read("workers/ai-kernel/src/index.ts");
  assert.match(idx, /if \(minute === 7 && env\.COUNCIL\) \{[\s\S]*?ctx\.waitUntil\(storeMissingTranscripts\(env as never\)/);
  const src = read("workers/ai-kernel/src/council-archive.ts");
  for (const imp of src.matchAll(/^import [\s\S]*? from "([^"]+)";/gm)) assert.doesNotMatch(imp[1], /consensus|syscall|executor|recovery|deploy|merge|evolution|forge|knowledge|ai-engine/, imp[1]);
  assert.doesNotMatch(src, /INSERT INTO|UPDATE |DELETE |\.put\(/, "the pass reads; only the council's object writes");
  assert.doesNotMatch(read("workers/ai-kernel/src/council.ts"), /TRANSCRIPTS\.(delete|list|get)\(/, "a council only ever puts its own transcript");
});
