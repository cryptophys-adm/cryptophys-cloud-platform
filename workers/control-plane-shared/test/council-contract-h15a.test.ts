// HAIC H1.5a (docs/design/HAIC-H0-H1.md §4.6): the shared council.v1 contract. Both sides check their output against the
// fixtures in docs/contracts/council-v1/; here, Cerebrum's validators, lifecycle, limits, claim check and autonomy guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  COUNCIL_LIMITS, COUNCIL_STATES, SHADOW_MINIMUM, TERMINAL_STATES, canTransition, capConfidence, isDuplicateProposal, parseRef, refCarriesPrice,
  topicKey, validateDecision, validateMessage, validateOption, validateSession, verifyClaim, widensAutonomy, type CouncilOption,
} from "../src/council.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const DIR = "docs/contracts/council-v1/";
const VALIDATE = { session: validateSession, message: validateMessage, decision: validateDecision } as Record<string, (x: unknown) => string[]>;

test("H15a-1. the shared fixtures: every valid file passes, every invalid one fails with its expected error, and the index lists every file", () => {
  const index = JSON.parse(read(`${DIR}index.json`));
  const listed = index.files.map((f: any) => f.file).sort();
  const onDisk = ["valid", "invalid"].flatMap((d) => readdirSync(new URL(`${DIR}${d}/`, ROOT)).map((f) => `${d}/${f}`)).sort();
  assert.deepEqual(listed, onDisk);
  assert.ok(index.files.length >= 19);
  for (const f of index.files) {
    const errors = VALIDATE[f.kind](JSON.parse(read(`${DIR}${f.file}`)));
    if (f.expect_errors.length === 0) assert.deepEqual(errors, [], f.file);
    else for (const want of f.expect_errors) assert.ok(errors.includes(want), `${f.file}: expected ${want}, got ${JSON.stringify(errors)}`);
  }
});

test("H15a-2. the lifecycle: the design's flow, abort from any running state, nothing leaves a terminal state, expiry never decides", () => {
  assert.ok(canTransition("proposed", "convening") && canTransition("proposed", "dismissed"));
  assert.ok(canTransition("positions", "synthesis"), "over budget, synthesis comes early");
  for (const s of ["convening", "positions", "rebuttals", "synthesis"] as const) assert.ok(canTransition(s, "aborted"), s);
  assert.ok(canTransition("awaiting_owner", "expired") && canTransition("awaiting_owner", "decided") && canTransition("decided", "handed_off"));
  assert.ok(!canTransition("awaiting_owner", "aborted") && !canTransition("proposed", "positions") && !canTransition("expired", "decided"));
  for (const t of TERMINAL_STATES) for (const s of COUNCIL_STATES) assert.ok(!canTransition(t, s), `${t} -> ${s}`);
  assert.deepEqual([COUNCIL_LIMITS.max_open_sessions, COUNCIL_LIMITS.max_started_per_utc_day, COUNCIL_LIMITS.max_model_calls, COUNCIL_LIMITS.max_usd], [2, 4, 16, 0.10]);
  assert.deepEqual(SHADOW_MINIMUM, { days: 14, directional_outcomes: 30 }, "Q8");
});

test("H15a-3. evidence refs: the five sides, no price fields; a claim verifies only when every ref resolves and one matches", () => {
  assert.deepEqual(parseRef("ev:platform/observer.finding/obs_1"), { side: "platform", source: "observer.finding", id: "obs_1", as_of: null, field: null });
  assert.deepEqual(parseRef("ev:adr/0017#phases"), { side: "adr", source: "adr", id: "0017", as_of: null, field: "phases" });
  assert.equal(parseRef("ev:github/x/y"), null);
  assert.equal(parseRef("https://example.com"), null);
  for (const [f, price] of [["sl_share", false], ["sl_share_asia", false], ["hit_rate_7d", false], ["entry_price", true], ["sl", true], ["tp2", true], ["level", true]] as const) {
    assert.equal(refCarriesPrice(parseRef(`ev:xauusd/signal_ledger.summary/k#${f}`)!), price, f);
  }
  const values: Record<string, unknown> = { "ev:platform/report/r1#metrics.hit_rate_7d": 0.62, "ev:platform/report/r2#n": 58 };
  const resolve = (r: string) => (r in values ? { value: values[r], as_of: "2026-11-18T10:00:00Z" } : null);
  assert.equal(verifyClaim({ metric: "hit_rate_7d", value: 0.62, refs: ["ev:platform/report/r1#metrics.hit_rate_7d"] }, resolve), true);
  assert.equal(verifyClaim({ metric: "n", value: "58", refs: ["ev:platform/report/r2#n"] }, resolve), true, "a numeric string equals its number");
  assert.equal(verifyClaim({ metric: "hit_rate_7d", value: 0.7, refs: ["ev:platform/report/r1#metrics.hit_rate_7d"] }, resolve), false, "a value that differs");
  assert.equal(verifyClaim({ metric: "x", value: 1, refs: ["ev:platform/report/missing"] }, resolve), false, "a ref that does not resolve");
  assert.equal(verifyClaim({ metric: "x", value: 1, refs: [] }, resolve), false, "no ref");
});

test("H15a-4. options: the autonomy guard refuses trading, autonomy and capability changes; unverified evidence caps confidence", () => {
  const opt = (change: CouncilOption["change"], refs: string[] = [], confidence = 0.8): CouncilOption => ({ option_id: "opt-1", rank: 1, title: "t", hypothesis: "h", change,
    expected_effect: { metric: "m", from: 1, to: 2, window: "30d" }, risk: { level: "low", reversible: true }, confidence, evidence_refs: refs, dissent: [] });
  assert.equal(widensAutonomy(opt({ type: "shadow_arm", target: "key_level", params: { entry_confirmation: "close" } })), null);
  assert.equal(widensAutonomy(opt({ type: "policy_parameter", target: "daily-deploy-limit", params: { value: 30 } })), null);
  assert.equal(widensAutonomy(opt({ type: "repository_task", target: "add a broker order path", params: {} })), "trading_capability");
  assert.equal(widensAutonomy(opt({ type: "policy_parameter", target: "agents", params: { tier_max: 2 } })), "autonomy_or_capability");
  assert.equal(widensAutonomy(opt({ type: "vision_kpi", target: "x", params: { grant_capability: "code.propose" } })), "autonomy_or_capability");
  assert.ok(validateOption(opt({ type: "policy_parameter", target: "x", params: { live_armed: true } })).includes("widens_autonomy:autonomy_or_capability"));
  const o = opt({ type: "shadow_arm", target: "k", params: {} }, ["ev:platform/report/a", "ev:platform/report/b"]);
  assert.equal(capConfidence(o, new Set(["ev:platform/report/a"])), 0.5);
  assert.equal(capConfidence(o, new Set()), 0, "no verified evidence, no confidence");
  assert.equal(capConfidence(opt({ type: "no_change", target: null, params: {} }, [], 0.3), new Set()), 0.3, "no change is exempt");
});

test("H15a-5. proposals are deduplicated for 7 days by topic, unless new evidence arrives", () => {
  const k = topicKey("Key Level entries often hit SL", "Why do they hit SL?");
  assert.equal(k, topicKey("key level ENTRIES often hit sl!", "why do they hit sl"));
  const now = Date.parse("2026-11-18T10:00:00Z");
  const recent = [{ key: k, refs: ["ev:platform/observer.finding/a"], created_at: "2026-11-15T10:00:00Z" }];
  assert.equal(isDuplicateProposal(k, ["ev:platform/observer.finding/a"], recent, now), true);
  assert.equal(isDuplicateProposal(k, ["ev:platform/observer.finding/a", "ev:platform/observer.finding/b"], recent, now), false, "new evidence");
  assert.equal(isDuplicateProposal(k, ["ev:platform/observer.finding/a"], recent, Date.parse("2026-11-23T10:00:01Z")), false, "after 7 days");
});

test("H15a-6. a council module never imports an executor, a consensus proposal, a merge, a deploy or a write route", () => {
  const files = ["workers/control-plane-shared/src/council.ts"];
  for (const f of files) {
    const src = read(f);
    for (const imp of src.matchAll(/^import [^;]+ from "([^"]+)";/gm)) {
      assert.doesNotMatch(imp[1], /consensus|syscall|executor|recovery|deploy|merge|git-write|evolution|forge|audit/, `${f} imports ${imp[1]}`);
    }
    assert.doesNotMatch(src, /consensus\.propose|\.syscall\(|INSERT INTO|UPDATE \w+ SET|DELETE FROM|method: "POST"/, `${f}: writes nothing`);
  }
});
