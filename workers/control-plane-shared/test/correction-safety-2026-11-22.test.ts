// 2026-11-22, review of xauusd #521: three ways a correction's text kept what §4.4 masks or redacts.
// Built from pieces so that no key-shaped text sits in the repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeText, validateCorrection, CATEGORY_RAW_MAX } from "../src/correction.ts";
import { redactText, secretInText } from "../src/conversation.ts";

const DASH = "-".repeat(5);
const header = (kind: string) => `${DASH}BEGIN ${kind}PRIVATE KEY${DASH}`;
const footer = (kind: string) => `${DASH}END ${kind}PRIVATE KEY${DASH}`;
const BODY = ["MIIEvQIBADANBgkqhkiG9w0BAQEFAASC", "Zm9yLXRlc3RzLW9ubHktbm90LWEta2V5"].join("\n");

test("CS1. a pasted PEM private key is redacted whole, header to END line, and to the end of the text without one", () => {
  const pem = `see:\n${header("")}\n${BODY}\n${footer("")}\nthanks`;
  assert.ok(secretInText(pem));
  assert.equal(redactText(pem), "see:\n[redacted]\nthanks");
  assert.equal(redactText(`${header("RSA ")}\n${BODY}`), "[redacted]", "no END line: everything after the header goes");
  const r = new Set<string>();
  const t = safeText(`key ${header("EC ")} ${BODY} ${footer("EC ")} done`, r as never)!;
  assert.equal(t, "key [redacted] done");
  assert.ok(!t.includes(BODY.split("\n")[0]) && r.has("secret"));
});

test("CS2. price forms in other scripts or with invisible characters are masked; the text keeps its words", () => {
  for (const s of ["SL at ４０９５ too tight", "SL at ٤٠٩٥ too tight", "SL at 40​95 too tight", "SL at 4⁠95 too tight"]) {
    const r = new Set<string>();
    assert.equal(safeText(s, r as never), "SL at [level] too tight", JSON.stringify(s));
    assert.ok(r.has("price"));
  }
  const r = new Set<string>();
  assert.equal(safeText("a fair call", r as never), "a fair call");
  assert.equal(r.size, 0);
});

test("CS4. a letter O for a zero is masked; shorthand, rates, counts and plain words are not (owner 2026-11-22, \"ya sesuai saranmu\")", () => {
  for (const s of ["SL at 4O95 too tight", "SL at 4o95 too tight", "SL at 4OOO too tight", "SL at 4OOO.5 too tight", "SL at 1OOO too tight", "SL at 4\u041E95 too tight", "SL at 4\u039F\u039F\u039F too tight"]) assert.equal(safeText(s, new Set() as never), "SL at [level] too tight", s);
  for (const s of ["TP 95.50", "near 4.1k", "hit rate 57.5%", "GOOD call, too soon", "OO7 agent", "4O was fine", "1OO% sure", "a 1OO agents"]) {
    const r = new Set<string>();
    assert.equal(safeText(s, r as never), s, s);
    assert.equal(r.size, 0, s);
  }
});

test("CS3. a stored record whose text or category_raw hides a price behind an invisible character is invalid", () => {
  const base = {
    schema: "correction.v1", correction_id: "cor_bbbbbbbbbbbbbbbb", side: "nexus", source: "nexus_card", label: "owner_correction", rating: null,
    category: "other", category_raw: "fine", target: { ref: "ev:xauusd/card/d_1", subject: "seat:prophet", as_of: null }, text: "ok",
    evidence_refs: [], actor: "owner:owner@example.com", attested_by: "xauusd_nexus_access", weight: 3, supersedes: null, redactions: [],
    created_at: "2026-11-22T09:50:00Z", content_sha256: "a".repeat(64), dedup_sha256: "b".repeat(64),
  };
  assert.ok(validateCorrection({ ...base, text: "SL at 40​95" }).includes("text_carries_price"));
  assert.ok(validateCorrection({ ...base, category_raw: "SL ٤٠٩٥" }).includes("category_raw_carries_price"));
  assert.ok(validateCorrection({ ...base, category_raw: "x".repeat(CATEGORY_RAW_MAX + 1) }).includes("category_raw"));
  assert.deepEqual(validateCorrection(base), []);
});
