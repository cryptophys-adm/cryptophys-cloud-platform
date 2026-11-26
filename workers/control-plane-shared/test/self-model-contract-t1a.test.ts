// ADR-0016 (Telos) T1a, docs/design/TELOS-T1-SELF-MODEL.md §4 and §12 step 1 (owner 2026-11-22, "setuju semua"): the
// contract of the daily self-model snapshot, organism.self_model.v1. Pure checks only: no D1, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BUNDLED_VISION, NULL_REASONS, SELF_MODEL_MAX_BYTES, SELF_MODEL_SCHEMA, SELF_MODEL_SECTIONS, SOURCE_STATUSES, canonicalJson,
  isForbiddenSelfModelKey, parseSelfModel, selfModelContentHash, selfModelProblems, selfModelStatus, visionSha256, windowEndOf,
} from "../src/self-model.ts";
import { visionProblems, type Vision } from "../src/vision.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import { lastReviewedRecord } from "./harness.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const vision = () => structuredClone(BUNDLED_VISION) as Vision;
const AS_OF = "2026-11-22T21:00:00Z";

/** §6: the measured value of each KPI in the fixture; every other KPI is an honest null with its reason. */
const KPI_NULLS: Record<string, string> = {
  decision_hit_rate_15m: "no_scored_data", agent_grounding_rate: "source_outside_platform", neurons_per_correct_call: "definition_pending",
  infra_cost_usd_month_excl_ai: "no_rows", changes_merged_by_consensus_share: "division_by_zero", mean_time_to_rollback_minutes: "no_rows",
  uptime_core_workers: "no_rows", recovery_drill_pass: "not_built",
};

function countMeasures(n: unknown, c = { measured: 0, null: 0 }): { measured: number; null: number } {
  if (Array.isArray(n)) n.forEach((v) => countMeasures(v, c));
  else if (n && typeof n === "object") {
    if ("value" in n) { if ((n as { value: unknown }).value === null) c.null++; else c.measured++; }
    else Object.values(n).forEach((v) => countMeasures(v, c));
  }
  return c;
}

/** A valid snapshot for 2026-11-22, Will built from the bundled vision. */
async function fixture(): Promise<any> {
  const v = vision();
  const will = {
    goals: v.growth.goals.map((g) => ({
      id: g.id,
      kpis: g.kpis.map((k) => k.id === "undeclared_components"
        ? { id: k.id, baseline: k.baseline, target: k.target, source: k.source, definition: "undeclared_worker findings in the newest Observer inventory run",
          measured: { value: 0, unit: "count", window: "now", as_of: AS_OF, source: "observer_runs", ref: "ev:platform/observer_runs/run_42#findings", reason: null } }
        : { id: k.id, baseline: k.baseline, target: k.target, source: k.source, definition: KPI_NULLS[k.id] === "not_built" ? null : `binding of ${k.id}`,
          measured: { value: null, unit: null, window: "30d", as_of: null, source: null, ref: null, reason: KPI_NULLS[k.id] } }),
    })),
  };
  const doc: any = {
    schema: SELF_MODEL_SCHEMA,
    day: "2026-11-22",
    window_end: "2026-11-23T00:00:00Z",
    vision: { schema: "organism.vision.v1", sha256: await visionSha256(), valid: true },
    sections: {
      body: {
        workers: { total: { value: 14, unit: "count", window: "now", as_of: AS_OF, source: "service_registry", reason: null }, drifted_now: { value: 0, unit: "count", window: "now", as_of: AS_OF, source: "drift_observations", reason: null } },
        controls: { agents_enabled: { value: true, window: "now", as_of: AS_OF, source: "kernel_controls", reason: null }, autonomy: { deploys: { value: "consensus", window: "now", as_of: AS_OF, source: "autonomy_dial", reason: null } } },
        anomalies: { top: [{ worker: "cryptophys-ai-kernel", metric: "cpu_p99_ms", z: { value: 3.2514, unit: "z", window: "7d", as_of: AS_OF, source: "observer_findings", reason: null } }], omitted: 4 },
      },
      mind: {
        trading_organ: { hit_rate_30d: { value: 0.53, unit: "ratio", window: "30d", as_of: AS_OF, source: "agent_reports:trading_organ_health.v1", ref: "ev:platform/report/rpt_1#metrics", reason: null }, status: { value: "ok", window: "30d", as_of: AS_OF, source: "agent_reports:trading_organ_health.v1", reason: null } },
        consensus: { proposals_waiting: { value: 2, unit: "count", window: "now", as_of: AS_OF, source: "consensus_proposals", reason: null } },
      },
      memory: {
        adr_index: { "0016": { percent: { value: 0.25, unit: "ratio", window: "now", as_of: AS_OF, source: "adr_progress", reason: null } } },
        experience_ledger: { value: null, reason: "not_built" },
      },
      will,
      ecosystem: {
        census: { voters: { value: 5, unit: "count", window: "now", as_of: AS_OF, source: "forge_organism_census", reason: null } },
        market_regime: { value: null, source: null, reason: "source_outside_platform" },
      },
    },
    sources: [
      { id: "observer_vitals", status: "ok", rows: 6840, as_of: AS_OF, point_in_time: false },
      { id: "service_registry", status: "ok", rows: 14, as_of: AS_OF, point_in_time: true },
      { id: "infra_burn_metrics", status: "empty", rows: 0, as_of: null, point_in_time: false },
    ],
    counts: { measured: 0, null: 0, kpis_measured: 1, kpis_total: v.growth.goals.reduce((n, g) => n + g.kpis.length, 0) },
    content_sha256: "",
    computed_at: "2026-11-23T00:52:10Z",
    deployed_commit: "7b81ccc",
  };
  Object.assign(doc.counts, countMeasures(doc.sections));
  doc.content_sha256 = await selfModelContentHash(doc);
  return doc;
}
const has = (problems: string[], re: RegExp) => assert.ok(problems.some((p) => re.test(p)), `expected ${re} in ${JSON.stringify(problems)}`);

test("T1a-1. the valid fixture passes, with every vision KPI in Will once and the counts it holds", async () => {
  const doc = await fixture();
  assert.deepEqual(visionProblems(BUNDLED_VISION), [], "the bundled vision is valid");
  assert.deepEqual(selfModelProblems(doc), []);
  assert.ok(parseSelfModel(doc));
  assert.equal(doc.counts.kpis_total, 9, "nine KPIs in organism/vision.json today");
  assert.equal(doc.content_sha256, await selfModelContentHash(doc));
  assert.deepEqual([...SELF_MODEL_SECTIONS], ["body", "mind", "memory", "will", "ecosystem"]);
  assert.deepEqual(Object.keys(doc.sections), [...SELF_MODEL_SECTIONS]);
  assert.equal(SELF_MODEL_MAX_BYTES, 65_536);
  assert.equal(windowEndOf("2026-12-31"), "2027-01-01T00:00:00Z");
  assert.equal(windowEndOf("2026-02-30"), null);
  assert.equal(selfModelStatus(doc.sources), "complete");
  assert.equal(selfModelStatus([...doc.sources, { status: "missing_table" }]), "partial");
  assert.equal(selfModelProblems("x")[0], "self_model: must be a JSON object");
});

test("T1a-2. a null without a reason, a value without as_of or source, a value with a reason, and an unknown reason are refused", async () => {
  assert.deepEqual([...NULL_REASONS], [
    "no_rows", "source_unavailable", "missing_table", "not_built", "source_outside_platform", "no_binding", "definition_pending",
    "subject_mismatch", "no_scored_data", "unavailable_source_field", "stale", "budget_exceeded", "division_by_zero",
  ], "the closed list of §4.1");
  const at = "sections.mind.trading_organ.hit_rate_30d";
  const bad = async (f: (m: any) => void) => { const d = await fixture(); f(d.sections.mind.trading_organ.hit_rate_30d); return selfModelProblems(d); };

  has(await bad((m) => { m.value = null; }), new RegExp(`^${at}: a null value needs a reason$`));
  has(await bad((m) => { delete m.as_of; }), new RegExp(`^${at}.as_of: required for a measured value$`));
  has(await bad((m) => { m.as_of = null; }), /hit_rate_30d.as_of: required for a measured value/);
  has(await bad((m) => { m.as_of = "2026-11-22 21:00:00"; }), /hit_rate_30d.as_of: must be an ISO UTC time/);
  has(await bad((m) => { m.source = null; }), /hit_rate_30d.source: required for a measured value/);
  has(await bad((m) => { m.reason = "stale"; }), /hit_rate_30d: a measured value has no reason/);
  has(await bad((m) => { m.value = null; m.reason = "zero"; }), /hit_rate_30d.reason: must be one of no_rows/);
  has(await bad((m) => { delete m.reason; }), /hit_rate_30d.reason: required/);
  has(await bad((m) => { m.value = Number.NaN; }), /hit_rate_30d.value: must be a finite number/);
  has(await bad((m) => { m.value = "the trading organ looks fine"; }), /hit_rate_30d.value: a string value must be a short status token/);
  has(await bad((m) => { m.value = "x2650"; }), /hit_rate_30d.value: a string value must be a short status token/);
  has(await bad((m) => { m.extra = 1; }), /hit_rate_30d.extra: unknown field/);

  // A number, a boolean or a null outside a measure is not a measurement.
  const d = await fixture();
  d.sections.body.workers.raw = 14; d.sections.body.flag = false; d.sections.memory.nothing = null;
  const p = selfModelProblems(d);
  has(p, /^sections.body.workers.raw: a number outside a measure/);
  has(p, /^sections.body.flag: a boolean outside a measure/);
  has(p, /^sections.memory.nothing: a null outside a measure has no reason/);
  // A Will KPI is a measure too, and a measured KPI shows its definition.
  const w = await fixture();
  const kpi = w.sections.will.goals.flatMap((g: any) => g.kpis).find((k: any) => k.id === "undeclared_components");
  kpi.measured.reason = null; kpi.measured.as_of = undefined; kpi.definition = null;
  has(selfModelProblems(w), /measured.as_of: required for a measured value/);
  has(selfModelProblems(w), /definition: a measured KPI shows its binding's definition/);
});

test("T1a-3. a forbidden key at any depth is refused; measures of outcomes and counts are not", async () => {
  for (const k of ["price", "entry_price", "level", "key_levels", "entry", "sl", "tp", "tp1", "tp2", "lot", "lots", "params", "action", "propose", "vote", "stop_loss", "takeProfit", "entryPrice"]) {
    assert.ok(isForbiddenSelfModelKey(k), `${k} is forbidden`);
  }
  for (const k of ["hit_rate_30d", "voters", "proposals_waiting", "target", "baseline", "as_of", "window_end", "point_in_time", "omitted"]) {
    assert.ok(!isForbiddenSelfModelKey(k), `${k} is allowed`);
  }
  const d = await fixture();
  d.sections.body.anomalies.top[0].detail = { deeper: [{ entry_price: { value: 1, unit: "usd", as_of: AS_OF, source: "x", reason: null } }] };
  d.sections.mind.trading_organ.tp2 = { value: null, reason: "no_rows" };
  d.sections.ecosystem.census.params = { value: null, reason: "no_rows" };
  d.vision.level = "x";
  const p = selfModelProblems(d);
  has(p, /^self_model.sections.body.anomalies.top\[0\].detail.deeper\[0\].entry_price: forbidden key$/);
  has(p, /^self_model.sections.mind.trading_organ.tp2: forbidden key$/);
  has(p, /^self_model.sections.ecosystem.census.params: forbidden key$/);
  has(p, /^self_model.vision.level: forbidden key$/);
  // Inside Will as well (an unknown field there, and forbidden).
  const w = await fixture();
  w.sections.will.goals[0].kpis[0].action = "rollback";
  has(selfModelProblems(w), /^self_model.sections.will.goals\[0\].kpis\[0\].action: forbidden key$/);
});

test("T1a-4. a price-bearing ref is refused, and so is a ref that is not ev:", async () => {
  const bad = async (ref: string) => { const d = await fixture(); d.sections.mind.trading_organ.hit_rate_30d.ref = ref; return selfModelProblems(d); };
  for (const ref of ["ev:xauusd/decisions/d_1#entry_price", "ev:xauusd/decisions/d_1#plan.sl", "ev:xauusd/decisions/d_1#tp2", "ev:xauusd/zones/z_1#level"]) {
    has(await bad(ref), /hit_rate_30d.ref: carries a price$/);
  }
  has(await bad("https://example.com/x"), /hit_rate_30d.ref: must be an ev: ref$/);
  assert.deepEqual(await bad("ev:platform/report/rpt_1#hit_rate_30d"), [], "a measure of outcomes is not a price (the hash is not rechecked here)");
  // The same in a Will KPI.
  const w = await fixture();
  w.sections.will.goals.flatMap((g: any) => g.kpis).find((k: any) => k.id === "undeclared_components").measured.ref = "ev:xauusd/report/r#close";
  has(selfModelProblems(w), /measured.ref: carries a price$/);
});

test("T1a-5. a document over 64 KB is refused", async () => {
  const d = await fixture();
  assert.ok(new TextEncoder().encode(canonicalJson(d)).length < SELF_MODEL_MAX_BYTES, "the fixture is well inside the bound");
  d.sections.body.anomalies.top = Array.from({ length: 400 }, (_, i) => ({ worker: `w-${"x".repeat(150)}-${i}`, metric: "errors" }));
  const bytes = new TextEncoder().encode(canonicalJson(d)).length;
  assert.ok(bytes > SELF_MODEL_MAX_BYTES);
  has(selfModelProblems(d), new RegExp(`^self_model: ${bytes} bytes, over the 65536-byte bound$`));
});

test("T1a-6. Will lists every KPI of the vision exactly once, verbatim", async () => {
  const kpis = (d: any) => d.sections.will.goals.flatMap((g: any) => g.kpis);
  // Missing.
  let d = await fixture();
  d.sections.will.goals[0].kpis.pop();
  has(selfModelProblems(d), /^sections.will: KPI "g-accuracy\/agent_grounding_rate" of the vision is missing$/);
  // Listed twice (in the same goal, and by repeating the goal).
  d = await fixture();
  d.sections.will.goals[0].kpis.push(structuredClone(d.sections.will.goals[0].kpis[0]));
  has(selfModelProblems(d), /KPI "g-accuracy\/decision_hit_rate_15m" listed twice/);
  d = await fixture();
  d.sections.will.goals.push(structuredClone(d.sections.will.goals[1]));
  has(selfModelProblems(d), /goal "g-efficiency" listed twice/);
  // Not in the vision.
  d = await fixture();
  d.sections.will.goals[0].kpis.push({ ...structuredClone(d.sections.will.goals[0].kpis[1]), id: "invented_kpi" });
  has(selfModelProblems(d), /kpis\[2\].id: not a KPI of goal "g-accuracy" in the vision/);
  d = await fixture();
  d.sections.will.goals.push({ id: "g-invented", kpis: [] });
  has(selfModelProblems(d), /goals\[5\].id: not a goal of the vision/);
  // Baseline, target and source copied verbatim; a null baseline is never filled in.
  d = await fixture();
  kpis(d)[0].baseline = 0.5; kpis(d)[1].target = 0.9; kpis(d)[2].source = "neurons";
  let p = selfModelProblems(d);
  has(p, /kpis\[0\].baseline: must be the vision's baseline, verbatim/);
  has(p, /kpis\[1\].target: must be the vision's target, verbatim/);
  has(p, /kpis\[0\].source: must be the vision's source, verbatim/);
  // A vision with one more KPI refuses the same document until Will lists it.
  const grown = vision();
  grown.growth.goals[0].kpis.push({ id: "new_kpi", baseline: null, target: null, source: "somewhere" });
  d = await fixture();
  p = selfModelProblems(d, grown);
  has(p, /KPI "g-accuracy\/new_kpi" of the vision is missing/);
  // An invalid vision: Will lists its problems, no goal, no KPI, and the header says invalid.
  const broken = vision() as any;
  broken.growth.goals[0].horizon = "someday";
  d = await fixture();
  p = selfModelProblems(d, broken);
  has(p, /^vision.valid: must be false/);
  has(p, /^sections.will.goals: must be empty while the vision is invalid$/);
  has(p, /^sections.will.problems: must list the vision's problems$/);
  d.vision.valid = false;
  d.sections.will = { goals: [], problems: visionProblems(broken) };
  d.counts = { ...countMeasures(d.sections), kpis_measured: 0, kpis_total: 0 };
  assert.deepEqual(selfModelProblems(d, broken), []);
});

test("T1a-7. the canonical hash ignores key order and the compute fields, and changes with any value", async () => {
  const d = await fixture();
  const reversed = (v: unknown): unknown => Array.isArray(v) ? v.map(reversed)
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversed(x)])) : v;
  const r = reversed(d) as any;
  assert.notEqual(JSON.stringify(r), JSON.stringify(d), "the key order really differs");
  assert.equal(await selfModelContentHash(r), d.content_sha256);
  assert.equal(canonicalJson(r), canonicalJson(d));
  // computed_at, deployed_commit and content_sha256 are outside the content.
  assert.equal(await selfModelContentHash({ ...d, computed_at: "2026-11-23T02:52:00Z", deployed_commit: null, content_sha256: "0".repeat(64) }), d.content_sha256);
  // Numbers are rounded to 4 decimals in the canonical form; a real change of a value changes the hash.
  const near = structuredClone(d); near.sections.mind.trading_organ.hit_rate_30d.value = 0.53000001;
  assert.equal(await selfModelContentHash(near), d.content_sha256);
  const moved = structuredClone(d); moved.sections.mind.trading_organ.hit_rate_30d.value = 0.5301;
  assert.notEqual(await selfModelContentHash(moved), d.content_sha256);
  assert.match(d.content_sha256, /^[0-9a-f]{64}$/);
  assert.equal(canonicalJson({ b: 1, a: [{ d: -0, c: 1.23456 }] }), '{"a":[{"c":1.2346,"d":0}],"b":1}');
});

test("T1a-8. the header, the sources and the counts are checked", async () => {
  const bad = async (f: (d: any) => void) => { const d = await fixture(); f(d); return selfModelProblems(d); };
  has(await bad((d) => { d.schema = "organism.self_model.v2"; }), /^self_model.schema: must be "organism.self_model.v1"$/);
  has(await bad((d) => { d.window_end = "2026-11-22T23:59:59Z"; }), /^window_end: must be 2026-11-23T00:00:00Z/);
  has(await bad((d) => { d.day = "2026-13-01"; }), /^day: must be a UTC calendar day/);
  has(await bad((d) => { d.computed_at = "2026-11-22T23:00:00Z"; }), /^computed_at: must be at or after window_end/);
  has(await bad((d) => { d.deployed_commit = "main"; }), /^deployed_commit: must be a commit sha or null$/);
  has(await bad((d) => { d.content_sha256 = "abc"; }), /^content_sha256: must be 64 lowercase hex/);
  has(await bad((d) => { d.vision.valid = false; }), /^vision.valid: must be true/);
  has(await bad((d) => { delete d.sections.memory; }), /^sections.memory: required, an object$/);
  has(await bad((d) => { d.sections.code_map = {}; }), /^sections.code_map: unknown field$/);
  has(await bad((d) => { d.counts.measured += 1; }), /^counts.measured: is \d+, the document holds \d+$/);
  has(await bad((d) => { d.counts.kpis_measured = 0; }), /^counts.kpis_measured: is 0, the document holds 1$/);
  has(await bad((d) => { d.counts.kpis_total = 8; }), /^counts.kpis_total: is 8, the document holds 9$/);
  assert.deepEqual([...SOURCE_STATUSES], ["ok", "empty", "unavailable", "missing_table", "not_built", "budget_exceeded"]);
  has(await bad((d) => { d.sources[2].rows = 3; }), /^sources\[2\].rows: an empty source read 0 rows$/);
  has(await bad((d) => { d.sources[0].rows = 0; }), /^sources\[0\].rows: an ok source read at least one row$/);
  has(await bad((d) => { d.sources[0].status = "unavailable"; }), /^sources\[0\].rows: a source that was not read has rows null$/);
  has(await bad((d) => { d.sources[0].status = "fine"; }), /^sources\[0\].status: must be one of/);
  has(await bad((d) => { d.sources.push(structuredClone(d.sources[0])); }), /source "observer_vitals" listed twice/);
  has(await bad((d) => { d.sections.body.anomalies.omitted = -1; }), /^sections.body.anomalies.omitted: must be a non-negative integer$/);
  const ok = await fixture();
  ok.sources.push({ id: "councils", status: "missing_table", rows: null, as_of: null, point_in_time: false });
  assert.deepEqual(selfModelProblems(ok), [], "a partial snapshot is still a valid document");
  assert.equal(selfModelStatus(ok.sources), "partial");
});

test("T1a-9. the contract is pure and import-light, touches no guard path, and is recorded in the SSOT and the design", () => {
  const src = read("workers/control-plane-shared/src/self-model.ts");
  const imports = [...src.matchAll(/^import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["../../../organism/vision.json", "./council.ts", "./vision.ts"]);
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
  for (const banned of [/\bfetch\(/, /\benv\./, /\.prepare\(/, /ai-engine/, /consensus/, /policy/, /syscall/]) assert.doesNotMatch(code, banned);
  assert.equal(criticalPathReason("workers/control-plane-shared/src/self-model.ts"), null);
  assert.equal(criticalPathReason("workers/control-plane-shared/test/self-model-contract-t1a.test.ts"), null);

  const ssot = lastReviewedRecord();
  assert.match(ssot, /^Last reviewed: 2026-11-16 \((?:[^\n]*; )?Telos T1a, 2026-11-22 \(owner: "setuju semua" to the ten T1 questions\): [^\n]*organism\.self_model\.v1/);
  const design = read("docs/design/TELOS-T1-SELF-MODEL.md");
  assert.match(design, /^- \*\*Status:\*\* design accepted by the owner on 2026-11-22[^;\n]*; step 1 \(T1a[^\n]*\) built, the rest not built\.$/m);
  assert.match(design, /^\*\*Owner answers \(2026-11-22, "setuju semua"\)\.\*\* Every recommended default in this section is accepted/m);
});
