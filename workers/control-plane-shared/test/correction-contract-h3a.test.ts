// HAIC H3a (docs/design/HAIC-H3.md §4; owner 2026-11-19, every recommended default accepted): the correction.v1
// contract. Every shared fixture behaves as its index says, the vectors reproduce, nothing is refused for its content
// (secret redacted, price masked, long text truncated, unknown category stored as "other"), and no record can carry a
// parameter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import {
  CORRECTION_TEXT_MAX, LABEL_WEIGHT, NON_OWNER_WEIGHT, buildCorrection, correctionDedupHash, forbiddenCorrectionKeys, normalizeText, validateCorrection,
} from "../src/correction.ts";
import { normalizeText as learningNormalize } from "../../ai-kernel/src/learning-dedup.ts";

const DIR = new URL("../../../docs/contracts/correction-v1/", import.meta.url);
const json = (f: string) => JSON.parse(readFileSync(new URL(f, DIR), "utf8"));
const index = json("index.json");
const ctx = { actor: "owner:owner@example.com", owner: true, attested_by: "cerebrum_access" as const, now: "2026-11-19T10:00:00Z", correction_id: "cor_00000000000000aa" };
const target = { ref: "ev:platform/council/cs_x#seq_1", subject: "agent:signal-analyst", as_of: null };

test("H3a-1. every fixture behaves as the index says, and the index lists every file", () => {
  const listed = new Set(index.files.map((f: any) => f.file));
  for (const dir of ["valid", "invalid"]) for (const f of readdirSync(new URL(`${dir}/`, DIR))) assert.ok(listed.has(`${dir}/${f}`), `${dir}/${f} is in index.json`);
  for (const f of index.files) {
    const errors = validateCorrection(json(f.file));
    if (!f.expect_errors.length) assert.deepEqual(errors, [], f.file);
    else for (const e of f.expect_errors) assert.ok(errors.includes(e), `${f.file}: expected ${e}, got ${JSON.stringify(errors)}`);
  }
});

test("H3a-2. the vectors reproduce: stored fields and both hashes; refusals only for structurally empty input", async () => {
  const v = json("vectors.json");
  for (const t of v.build) {
    const r = await buildCorrection(t.input, t.context);
    assert.ok(r.ok, t.name);
    for (const [k, want] of Object.entries(t.expect)) assert.deepEqual((r as any).correction[k], want, `${t.name}.${k}`);
    assert.deepEqual(validateCorrection((r as any).correction), [], t.name);
  }
  const byName = Object.fromEntries(v.build.map((t: any) => [t.name, t.expect]));
  assert.equal(byName["whitespace-equal"].dedup_sha256, byName["whitespace-equal-2"].dedup_sha256, "whitespace and ref order do not change the dedup hash");
  for (const t of v.refused) assert.deepEqual(await buildCorrection(t.input, ctx), { ok: false, error: t.error }, t.name);
});

test("H3a-3. never refused for content: a secret is redacted, a price masked, long text truncated, an unknown category kept as other", async () => {
  const r = await buildCorrection({ side: "cerebrum", source: "council", category: "made_up", text: `ghp_${"a".repeat(36)} near 1,234.5 ${"y".repeat(CORRECTION_TEXT_MAX)}`, target }, ctx);
  assert.ok(r.ok);
  const c = (r as any).correction;
  assert.deepEqual(c.redactions, ["secret", "price", "truncated"]);
  assert.equal(c.text.length, CORRECTION_TEXT_MAX);
  assert.ok(!/ghp_a{36}/.test(c.text) && c.text.includes("[level]"));
  assert.deepEqual([c.category, c.category_raw, c.label], ["other", "made_up", "owner_correction"]);
  assert.deepEqual(validateCorrection(c), []);
});

test("H3a-4. weights: owner 3 for ratings and corrections, 1 for reject reasons, 1 for any actor that is not an owner; never above 3", async () => {
  assert.deepEqual(LABEL_WEIGHT, { owner_rating: 3, owner_correction: 3, owner_decision: 1, reviewer_correction: 2 });
  const owner = await buildCorrection({ side: "cerebrum", source: "council", rating: "down", target }, ctx);
  const other = await buildCorrection({ side: "nexus", source: "nexus_card", rating: "down", target: { ...target, subject: "seat:r37_funnel" } }, { ...ctx, owner: false, actor: "nexus:x@example.com", attested_by: "xauusd_nexus_access" });
  assert.deepEqual([(owner as any).correction.weight, (other as any).correction.weight], [3, NON_OWNER_WEIGHT]);
});

test("H3a-5. no parameters: a params, values or change field, or a price-like key at any depth, is never part of a record", async () => {
  assert.deepEqual(forbiddenCorrectionKeys({ a: { stopLoss: 1, b: [{ entry_price: 2 }] }, values: {} }), ["correction.a.stopLoss", "correction.a.b[0].entry_price", "correction.values"]);
  for (const k of ["params", "values", "change", "risk_size", "tp1"]) {
    const r = await buildCorrection({ side: "cerebrum", source: "council", rating: "up", target, [k]: 1 }, ctx);
    assert.deepEqual(r, { ok: false, error: `forbidden_key: input.${k}` }, k);
  }
});

test("H3a-6. dedup: the same normalized content by the same actor is the same hash; a different rating or actor is not; the text rule equals learning-dedup's", async () => {
  const base = { actor: ctx.actor, target, label: "owner_correction" as const, rating: null, category: "overconfident" as const, text: "a  b", evidence_refs: ["ev:platform/a/1"] };
  const h = await correctionDedupHash(base);
  assert.equal(await correctionDedupHash({ ...base, text: " a b " }), h);
  assert.notEqual(await correctionDedupHash({ ...base, rating: "up" }), h);
  assert.notEqual(await correctionDedupHash({ ...base, actor: "owner:other@example.com" }), h);
  for (const s of ["  x\t y\n", "A  B", ""]) assert.equal(normalizeText(s), learningNormalize(s));
});
