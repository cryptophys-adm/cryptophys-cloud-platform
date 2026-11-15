// Owner 2026-11-15: the Signal Analyst reports the trading organ's health in metric form. The decision digest is
// gone (Nexus and xauusd's Telegram heartbeat relay decisions); the flip, stale, empty and unavailable warnings stay;
// one metric snapshot ({metric, value, baseline_7d, z}) is published on a material change or at the 6 h heartbeat.
import { test } from "node:test";
import assert from "node:assert/strict";
import { baseEnv, migratedDb } from "./harness.ts";
import { parsePolicyRequest, decide } from "../../policy-engine/src/index.ts";
import { observe } from "../../ai-kernel/src/syscall.ts";
import {
  MIN_BASELINE_SAMPLES, ORGAN_HEALTH_METRICS, SNAPSHOT_HEARTBEAT_MS, SNAPSHOT_SCHEMA, organHealthValues, recordSample,
  runSignalCycle, shouldPublishSnapshot, snapshotChanges, withBaselines, type OrganHealthSample, type WindowDecision,
} from "../../ai-kernel/src/signal-analyst.ts";

const H = 3_600_000;
const D = 24 * H;
// Aligned like production: the cycle runs at minute 22, H1 keys are bar opens on the hour.
const NOW = Date.UTC(2026, 10, 15, 12, 22, 0);
const TOP = Date.UTC(2026, 10, 15, 12, 0, 0);
const key = (openMs: number, tf = 60) => `OANDA:XAUUSD:${tf}:${openMs}`;

function kernelEnv(extra: Record<string, unknown> = {}) {
  const db = migratedDb();
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const env: any = {
    ...baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: "ci-client.access,ops@cryptophys.work,approver@cryptophys.work", APPROVER_IDENTITIES: "approver@cryptophys.work" }),
    POLICY: { evaluate: async (input: any) => { const p = parsePolicyRequest(input); if (p instanceof Error) throw p; return decide(policyEnv as any, p); } },
    RECOVERY: { propose: async () => ({}) },
    MEMORY: { upsert: async () => ({}), query: async () => ({ matches: [] }), deleteByIds: async () => ({}) },
    ...extra,
  };
  const store = new Map<string, unknown>();
  const mem = { store, get: async <T>(k: string) => store.get(k) as T | undefined, put: async (k: string, v: unknown) => { store.set(k, structuredClone(v)); } };
  return { env, db, mem };
}

/** The legacy /api/decisions shape, levels included, newest first (as xauusd returns it). */
const raw = (openMs: number, decision: string, confidence: number | null = 0.5, tf = 60) => ({
  candle_key: key(openMs, tf), timestamp: new Date(openMs + tf * 60_000 + 60_000).toISOString(), decision, confidence,
  entry_price: 4051.2, stop_loss: 4060, take_profit: 4030, risk_reward: 2.4, position_size_pct: 0.5,
  reasoning: "Rejected 4,078.50 twice; sell below 4051 with the stop above $4060 and the target near 4030.",
  trade: { entry: 4051.2, stop: 4060, tp: 4030, rrr: 2.4 },
});
function xauusd(items: any[]) {
  return { fetch: async () => new Response(JSON.stringify({ status: "ok", count: items.length, items }), { status: 200, headers: { "content-type": "application/json" } }) };
}
const reports = (db: any) => db.raw.prepare("SELECT kind, severity, subject, body_json FROM agent_reports WHERE agent_id = 'signal-analyst' ORDER BY rowid").all()
  .map((r: any) => ({ ...r, body: JSON.parse(r.body_json) }));
const snapshots = (db: any) => reports(db).filter((r: any) => r.body.schema === SNAPSHOT_SCHEMA);
const metric = (body: any, name: string) => body.metrics.find((m: any) => m.metric === name);

// ---------------------------------------------------------------- the metrics, from fixture decisions

const FIXTURE: WindowDecision[] = [
  { open_ms: NOW - 30 * H, tf: 60, decision: "BUY", confidence: 0.9 }, // closed 29 h ago: outside 24 h
  { open_ms: NOW - 25 * H, tf: 60, decision: "SELL", confidence: 0.1 }, // closed exactly 24 h ago: outside
  { open_ms: TOP - 6 * H, tf: 60, decision: "BUY", confidence: 0.6 },
  { open_ms: TOP - 5 * H, tf: 60, decision: "SELL", confidence: 0.8 }, // flip
  { open_ms: TOP - 4 * H, tf: 60, decision: "WAIT", confidence: 0.2 },
  { open_ms: TOP - 3 * H, tf: 60, decision: "SELL", confidence: 0.5 },
  { open_ms: TOP - 2 * H, tf: 60, decision: "BUY", confidence: 0.7 }, // flip
  { open_ms: TOP - 1 * H, tf: 60, decision: "NO_TRADE", confidence: null },
  { open_ms: TOP - 15 * 60_000, tf: 15, decision: "BUY", confidence: 0.99 }, // another timeframe: not counted
];

test("M1. the 24 h metrics are computed from the decisions of the latest timeframe whose bar closed in the last 24 h", () => {
  const incidents = [NOW - 2 * H, NOW - 30 * H, NOW - 8 * D];
  const v = organHealthValues(FIXTURE, { open_ms: TOP - H, tf: 60 }, incidents, NOW);
  assert.deepEqual(v, {
    decisions_24h: 6,
    share_buy_24h: 0.333,
    share_sell_24h: 0.333,
    share_wait_24h: 0.167,
    share_no_trade_24h: 0.167,
    latest_decision_age_bars: 0.37, // closed at 12:00, now 12:22: 22 of 60 minutes
    flips_24h: 2,
    confidence_mean_24h: 0.56, // (0.6 + 0.8 + 0.2 + 0.5 + 0.7) / 5; the null confidence is left out
    confidence_p50_24h: 0.6,
    confidence_min_24h: 0.2,
    confidence_max_24h: 0.8,
    hit_rate_7d: null,
    hit_rate_30d: null,
    staleness_incidents_24h: 1,
    staleness_incidents_7d: 2,
  });
  // No decisions: counts are 0 and every share and confidence statistic is null, never 0.
  const empty = organHealthValues([], null, [], NOW);
  assert.equal(empty.decisions_24h, 0);
  for (const k of ["share_buy_24h", "confidence_mean_24h", "latest_decision_age_bars"] as const) assert.equal(empty[k], null, k);
  // An even count takes the mean of the two middle confidences.
  const even = organHealthValues(FIXTURE.slice(2, 6), { open_ms: TOP - 3 * H, tf: 60 }, [], NOW);
  assert.equal(even.confidence_p50_24h, 0.55);
});

test("M2. baseline_7d and z come from at least 24 earlier hourly samples of the last 7 days; otherwise null", () => {
  const values = organHealthValues(FIXTURE, { open_ms: TOP - H, tf: 60 }, [], NOW);
  const hour = Math.floor(NOW / H);
  const sample = (h: number, decisions: number | null): OrganHealthSample => ({ h, v: ORGAN_HEALTH_METRICS.map((m) => (m === "decisions_24h" ? decisions : null)) });
  // 24 samples alternating 2 and 10 (mean 6, sd 4), one of this hour (ignored) and one older than 7 days (ignored).
  const samples = [sample(hour - 200, 1000), ...Array.from({ length: MIN_BASELINE_SAMPLES }, (_, i) => sample(hour - 1 - i, i % 2 ? 2 : 10)), sample(hour, 1000)];
  const m = withBaselines(values, samples, NOW).find((x) => x.metric === "decisions_24h")!;
  assert.deepEqual(m, { metric: "decisions_24h", value: 6, baseline_7d: 6, z: 0 });
  const higher = withBaselines({ ...values, decisions_24h: 14 }, samples, NOW).find((x) => x.metric === "decisions_24h")!;
  assert.equal(higher.z, 2);
  // 23 samples: not enough.
  const few = withBaselines(values, samples.slice(0, MIN_BASELINE_SAMPLES), NOW).find((x) => x.metric === "decisions_24h")!;
  assert.deepEqual([few.baseline_7d, few.z], [null, null]);
  // A flat baseline: z 0 at the baseline, null away from it (no infinite z).
  const flat = Array.from({ length: MIN_BASELINE_SAMPLES }, (_, i) => sample(hour - 1 - i, 6));
  assert.equal(withBaselines(values, flat, NOW).find((x) => x.metric === "decisions_24h")!.z, 0);
  assert.equal(withBaselines({ ...values, decisions_24h: 7 }, flat, NOW).find((x) => x.metric === "decisions_24h")!.z, null);
  // A metric without samples has no baseline; the hit rates are not exposed by signals.observe.
  const all = withBaselines(values, samples, NOW);
  assert.deepEqual(all.map((x) => x.metric), [...ORGAN_HEALTH_METRICS]);
  assert.deepEqual(all.find((x) => x.metric === "share_buy_24h"), { metric: "share_buy_24h", value: 0.333, baseline_7d: null, z: null });
  for (const name of ["hit_rate_7d", "hit_rate_30d"]) {
    assert.deepEqual(all.find((x) => x.metric === name), { metric: name, value: null, baseline_7d: null, z: null, status: "unavailable_source_field" });
  }
  // One sample per UTC hour, 7 days kept.
  const kept = recordSample(samples, values, NOW);
  assert.equal(kept.filter((s) => s.h === hour).length, 1);
  assert.equal(kept.find((s) => s.h === hour)!.v[0], 6);
  assert.ok(kept.every((s) => s.h > hour - 7 * 24 - 1));
});

test("M3. the publish rule: first, a material change, or the 6 h heartbeat; an identical snapshot is not published again", () => {
  const values = organHealthValues(FIXTURE, { open_ms: TOP - H, tf: 60 }, [], NOW);
  const metrics = withBaselines(values, [], NOW);
  const last = { at: NOW, stale: false, values: Object.fromEntries(metrics.map((m) => [m.metric, { value: m.value, z: m.z }])) };
  assert.deepEqual(snapshotChanges(undefined, metrics, false), ["first"]);
  assert.equal(shouldPublishSnapshot(undefined, ["first"], NOW), "first");
  // The same values an hour later (the age grew): nothing to publish.
  const later = withBaselines({ ...values, latest_decision_age_bars: 1.37 }, [], NOW + H);
  assert.deepEqual(snapshotChanges(last, later, false), []);
  assert.equal(shouldPublishSnapshot(last, [], NOW + H), null);
  assert.equal(shouldPublishSnapshot(last, [], NOW + SNAPSHOT_HEARTBEAT_MS), "heartbeat");
  // Small moves are not material; a flip, a 0.05 share move, a staleness flag or a null <-> value change is.
  const moved = (patch: Partial<typeof values>) => snapshotChanges(last, withBaselines({ ...values, ...patch }, [], NOW + H), false);
  assert.deepEqual(moved({ share_buy_24h: 0.36, decisions_24h: 7, confidence_mean_24h: 0.58 }), []);
  assert.deepEqual(moved({ flips_24h: 3 }), ["flips_24h"]);
  assert.deepEqual(moved({ share_buy_24h: 0.383 }), ["share_buy_24h"]);
  assert.deepEqual(moved({ decisions_24h: 4 }), ["decisions_24h"]);
  assert.deepEqual(moved({ confidence_mean_24h: null }), ["confidence_mean_24h"]);
  assert.deepEqual(snapshotChanges(last, metrics, true), ["stale"]);
  assert.equal(shouldPublishSnapshot(last, ["flips_24h"], NOW + H), "change");
});

// ---------------------------------------------------------------- the cycle

test("M4. the cycle: no decision digest; the snapshot carries every metric in the {metric, value, baseline_7d, z} shape", async () => {
  const { env, db, mem } = kernelEnv();
  env.XAUUSD_AI = xauusd([raw(TOP - H, "WAIT", 0.3), raw(TOP - 2 * H, "WAIT", 0.4), raw(TOP - 3 * H, "BUY", 0.6)]);
  await runSignalCycle(env, mem, "scheduled", NOW);
  for (const r of reports(db).filter((x: any) => x.severity === "info")) {
    assert.equal(r.body.schema, SNAPSHOT_SCHEMA, "every info report is a metric snapshot");
    for (const k of ["decision", "reasoning", "risk_reward", "previous_decision"]) assert.equal(k in r.body, false, `no ${k} in an info report`);
    assert.doesNotMatch(r.subject, /\b(BUY|SELL|WAIT)\b/, "the subject is the metrics, not the decision");
  }
  assert.equal(snapshots(db).length, 1);
  const s = snapshots(db)[0].body;
  assert.equal(s.publish_reason, "first");
  assert.deepEqual(s.metrics.map((m: any) => m.metric), [...ORGAN_HEALTH_METRICS]);
  for (const m of s.metrics) assert.deepEqual(Object.keys(m).filter((k) => k !== "status"), ["metric", "value", "baseline_7d", "z"]);
  assert.equal(metric(s, "decisions_24h").value, 3);
  assert.equal(metric(s, "share_wait_24h").value, 0.667);
  assert.equal(metric(s, "confidence_mean_24h").value, 0.433);
  assert.deepEqual([metric(s, "decisions_24h").baseline_7d, metric(s, "decisions_24h").z], [null, null], "no history yet");
  assert.deepEqual(metric(s, "hit_rate_7d"), { metric: "hit_rate_7d", value: null, baseline_7d: null, z: null, status: "unavailable_source_field" });
  assert.deepEqual([s.latest.decision, s.bar_minutes, s.stale], ["WAIT", 60, false]);
});

test("M4b. a steady organ publishes no identical snapshot each cycle, only the 6 h heartbeat", async () => {
  const { env, db, mem } = kernelEnv();
  // Every hour one more closed H1 bar, all WAIT 0.3: 24 decisions in 24 h, the same values every cycle.
  const steady = (k: number) => Array.from({ length: 30 }, (_, i) => raw(TOP + k * H - (i + 1) * H, "WAIT", 0.3));
  for (let k = 0; k < 6; k++) {
    env.XAUUSD_AI = xauusd(steady(k));
    await runSignalCycle(env, mem, "scheduled", NOW + k * H);
  }
  assert.equal(snapshots(db).length, 1, "five more cycles with the same values publish nothing");
  assert.equal(metric(snapshots(db)[0].body, "decisions_24h").value, 24);
  env.XAUUSD_AI = xauusd(steady(6));
  await runSignalCycle(env, mem, "scheduled", NOW + SNAPSHOT_HEARTBEAT_MS);
  assert.equal(snapshots(db).length, 2);
  assert.equal(snapshots(db)[1].body.publish_reason, "heartbeat");
  assert.equal(reports(db).filter((r: any) => r.severity !== "info").length, 0, "no warning for a steady organ");
  // One sample per UTC hour.
  const store: any = mem.store.get("organ_health_samples");
  assert.equal(store.schema, SNAPSHOT_SCHEMA);
  assert.deepEqual(store.samples.map((x: any) => x.h), Array.from({ length: 7 }, (_, k) => Math.floor(NOW / H) + k));
});

test("M5. the flip warning still fires: once per flipped candle, and not for flips before the window existed", async () => {
  const { env, db, mem } = kernelEnv();
  // History with a flip (BUY -> SELL) before the agent had a window: no warning for it.
  env.XAUUSD_AI = xauusd([raw(TOP - H, "SELL", 0.7), raw(TOP - 2 * H, "BUY", 0.6)]);
  await runSignalCycle(env, mem, "scheduled", NOW);
  const flips = () => reports(db).filter((r: any) => r.severity === "warning" && /flip/.test(r.subject));
  assert.equal(flips().length, 0);
  // A new candle flips SELL -> BUY: one warning, with the two decisions and no level.
  env.XAUUSD_AI = xauusd([raw(TOP, "BUY", 0.8), raw(TOP - H, "SELL", 0.7), raw(TOP - 2 * H, "BUY", 0.6)]);
  await runSignalCycle(env, mem, "scheduled", NOW + H);
  assert.equal(flips().length, 1);
  const w = flips()[0];
  assert.equal(w.kind, "xauusd_digest");
  assert.equal(w.subject, `XAUUSD H1 flip SELL -> BUY (confidence 0.8) for candle ${new Date(TOP).toISOString()}`);
  assert.deepEqual([w.body.candle_key, w.body.decision, w.body.previous_decision, w.body.previous_candle_key, w.body.confidence],
    [key(TOP), "BUY", "SELL", key(TOP - H), 0.8]);
  assert.ok(w.body.disclaimer);
  // The same observation again: no second warning for the same flip.
  await runSignalCycle(env, mem, "operator", NOW + H + 60_000);
  assert.equal(flips().length, 1);
  // The flip moved flips_24h, so a snapshot was published for the change.
  const last = snapshots(db).at(-1).body;
  assert.equal(last.publish_reason, "change");
  assert.ok(last.changed.includes("flips_24h"));
  assert.equal(metric(last, "flips_24h").value, 2);
});

test("M6. staleness incidents: one per stale candle, the stale warning keeps its kind and subject", async () => {
  const { env, db, mem } = kernelEnv();
  const staleOpen = TOP - 3 * H; // closed 2 h 22 min ago: stale (> 90 min)
  env.XAUUSD_AI = xauusd([raw(staleOpen, "WAIT", 0.3)]);
  await runSignalCycle(env, mem, "scheduled", NOW);
  await runSignalCycle(env, mem, "scheduled", NOW + H);
  const stale = reports(db).filter((r: any) => r.severity === "warning");
  assert.equal(stale.length, 1);
  assert.equal(stale[0].kind, "xauusd_digest");
  assert.equal(stale[0].subject, `XAUUSD analysis stale: no decision since candle ${new Date(staleOpen).toISOString()}`);
  const s = snapshots(db).at(-1).body;
  assert.equal(s.stale, true);
  assert.equal(metric(s, "staleness_incidents_24h").value, 1);
  assert.equal(metric(s, "staleness_incidents_7d").value, 1);
});

test("M7. no price field anywhere: no snapshot, warning, overview view or memory key is a level (recursively)", async () => {
  const BANNED = new Set(["entry", "entry_price", "exit_price", "stop", "stop_loss", "take_profit", "target", "price", "sl", "tp", "level", "levels", "trade", "position_size_pct"]);
  const offending = (v: unknown, path = "$"): string[] => {
    if (Array.isArray(v)) return v.flatMap((x, i) => offending(x, `${path}[${i}]`));
    if (!v || typeof v !== "object") return [];
    return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
      [...(BANNED.has(k.toLowerCase()) || /price|stop|take_profit|entry|target|level/i.test(k) ? [`${path}.${k}`] : []), ...offending(x, `${path}.${k}`)]);
  };
  // Normal, flip, stale, empty and unavailable cycles, each with levels in the source. Each scenario has its own
  // database: reports.publish allows 4 reports an hour per agent, and the tests run within one wall-clock hour.
  const scenario = async (steps: [number, any[] | null][]) => {
    const k = kernelEnv();
    for (const [t, items] of steps) {
      k.env.XAUUSD_AI = items ? xauusd(items) : { fetch: async () => { throw new Error("boom"); } };
      await runSignalCycle(k.env, k.mem, "scheduled", t);
    }
    return k;
  };
  const flipped = [raw(TOP, "BUY", 0.8), raw(TOP - H, "SELL", 0.7)];
  const runs = [
    await scenario([[NOW, [raw(TOP - H, "SELL", 0.7), raw(TOP - 2 * H, "BUY", 0.6)]], [NOW + H, flipped]]), // snapshot, flip
    await scenario([[NOW, flipped], [NOW + 4 * H, flipped]]), // stale
    await scenario([[NOW, []]]), // empty
    await scenario([[NOW, null]]), // unavailable
  ];
  const all = runs.flatMap((k) => reports(k.db));
  assert.ok(all.some((r: any) => r.body.schema === SNAPSHOT_SCHEMA));
  assert.ok(all.some((r: any) => /flip/.test(r.subject)));
  assert.ok(all.some((r: any) => /stale/.test(r.subject)));
  assert.ok(all.some((r: any) => r.subject === "XAUUSD decisions empty"));
  assert.ok(all.some((r: any) => /unavailable/.test(r.subject)));
  for (const r of all) assert.deepEqual(offending(r.body), [], r.subject);
  for (const k of runs) for (const [name, v] of k.mem.store) assert.deepEqual(offending(v), [], `memory ${name}`);
  const { env } = runs[0];
  const ov: any = await observe(env, NOW + 6 * H);
  assert.deepEqual(offending(ov.trading_organ_health), []);
  assert.deepEqual(offending(ov.xauusd_latest), []);
});

test("M8. the overview: trading_organ_health is the newest snapshot (known fields only); xauusd_latest keeps its six keys", async () => {
  const { env, db, mem } = kernelEnv();
  const ov0: any = await observe(env, NOW);
  assert.equal(ov0.trading_organ_health, null);
  env.XAUUSD_AI = xauusd([raw(TOP - H, "WAIT", 0.3), raw(TOP - 2 * H, "BUY", 0.6)]);
  await runSignalCycle(env, mem, "scheduled", NOW);
  const ov: any = await observe(env, NOW);
  const toh = ov.trading_organ_health;
  assert.deepEqual(Object.keys(toh).sort(), ["bar_minutes", "metrics", "observed_at", "report_id", "reported_at", "stale"]);
  assert.equal(toh.metrics.length, ORGAN_HEALTH_METRICS.length);
  assert.deepEqual(toh.metrics.find((m: any) => m.metric === "decisions_24h"), { metric: "decisions_24h", value: 2, baseline_7d: null, z: null });
  assert.equal(toh.metrics.find((m: any) => m.metric === "hit_rate_30d").status, "unavailable_source_field");
  assert.deepEqual(Object.keys(ov.xauusd_latest).sort(), ["candle_key", "confidence", "decided_at", "decision", "report_id", "reported_at"]);
  assert.deepEqual([ov.xauusd_latest.decision, ov.xauusd_latest.confidence, ov.xauusd_latest.candle_key], ["WAIT", 0.3, key(TOP - H)]);
  // A body with unknown fields or wrong types shows only what is known and well typed.
  db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, created_at) VALUES ('rpt_x', 'signal-analyst', 'xauusd_digest', 'info', 's', ?, 'deterministic', '2099-01-01T00:00:00.000Z')")
    .run(JSON.stringify({ schema: SNAPSHOT_SCHEMA, bar_minutes: "60", stale: "no", note: "free text", metrics: [{ metric: "x_1", value: "5", baseline_7d: 1, z: null, extra: 2 }, { metric: "Bad Name", value: 1 }] }));
  const ov2: any = await observe(env, NOW);
  assert.deepEqual(ov2.trading_organ_health, { report_id: "rpt_x", reported_at: "2099-01-01T00:00:00.000Z", observed_at: null, bar_minutes: null, stale: null,
    metrics: [{ metric: "x_1", value: null, baseline_7d: 1, z: null }] });
});
