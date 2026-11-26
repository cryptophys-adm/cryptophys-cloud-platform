// Owner 2026-11-26 ("Ya, setuju pindahkan"): the SSOT's "Last reviewed" record left docs/SSOT.md line 5. The line had
// grown to 108 KB and every commit rewrote it, so it was most of the repository's growth (main's pack passed 32 MiB
// that day and the git backup failed). Line 5 keeps the newest five entries; an older entry moves to its own
// immutable file in docs/ssot-history/; the rest is frozen in docs/SSOT-HISTORY.md. lastReviewedRecord() rebuilds
// the whole record, so every test that reads its entry still reads the same text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { SSOT_HISTORY_MARKER, SSOT_HISTORY_POINTER, SSOT_ROTATED_FILE, lastReviewedRecord } from "./harness.ts";
import { criticalPathReason } from "../src/guard-paths.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const PREFIX = "Last reviewed: 2026-11-16 (";
/** line 5 at 8a67c45, the cut-over (107,974 bytes), and the rest of it after its newest five entries (106,835). */
const OLD_LINE5_SHA256 = "07b67db37be08f2e6c4f995add0b0fbcb7f37a8fe7198565c1958284d5ef78a5";
const REMAINDER_SHA256 = "6de413a057a14cf3cd1f802afda810a483113b67b28eefb4eb1d63244786bb22";
const FIRST_CUT_OVER_ENTRY = "model redaction, 2026-11-26 (";

/** The entries of a record body: split on "; " outside parentheses. */
function entries(body: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "(") depth++;
    else if (body[i] === ")") depth--;
    if (depth === 0 && body.startsWith("; ", i)) { out.push(body.slice(start, i)); start = i + 2; }
  }
  out.push(body.slice(start));
  return out;
}
const WELL_FORMED = /^[^();]+, \d{4}-\d{2}-\d{2}[ :(]/;
const balanced = (s: string) => { let d = 0; for (const c of s) { if (c === "(") d++; else if (c === ")") { d--; if (d < 0) return false; } } return d === 0; };

test("SH-1. line 5 holds at most the newest five entries, each well-formed, then the pointer; SSOT.md is under 100 KB", () => {
  const line5 = read("docs/SSOT.md").split("\n")[4];
  assert.ok(line5.startsWith(PREFIX), "line 5 is still the Last reviewed line");
  assert.ok(line5.endsWith(SSOT_HISTORY_POINTER), "it ends with the pointer to the history");
  const body = entries(line5.slice(PREFIX.length, -SSOT_HISTORY_POINTER.length));
  assert.ok(body.length >= 1 && body.length <= 5, `line 5 has ${body.length} entries (at most 5: move the oldest to docs/ssot-history/)`);
  for (const e of body) { assert.match(e, WELL_FORMED, e.slice(0, 80)); assert.ok(balanced(e), `balanced: ${e.slice(0, 80)}`); }
  assert.ok(line5.length < 4_000, `line 5 is ${line5.length} bytes`);
  const size = statSync(new URL("docs/SSOT.md", ROOT)).size;
  assert.ok(size < 100_000, `docs/SSOT.md is ${size} bytes (195,539 before the move)`);
});

test("SH-2. the frozen archive is the cut-over remainder, byte for byte, and is never edited", () => {
  const archive = read("docs/SSOT-HISTORY.md").split("\n");
  const at = archive.indexOf(SSOT_HISTORY_MARKER);
  assert.ok(at > 0, "the marker");
  assert.equal(sha256(archive[at + 1]), REMAINDER_SHA256, "the remainder is unchanged since the cut-over");
  assert.equal(archive.slice(at + 2).join("\n"), "", "nothing follows it");
  assert.match(archive[0], /^# SSOT review history \(frozen 2026-11-26\)$/);
  assert.match(archive.join("\n"), /"Ya, setuju pindahkan", 2026-11-26/);
});

test("SH-3. the whole record is the old line 5 with newer entries before it: no entry lost, none reordered", () => {
  const record = lastReviewedRecord();
  assert.ok(record.startsWith(PREFIX));
  const at = record.indexOf(FIRST_CUT_OVER_ENTRY);
  assert.ok(at > PREFIX.length - 1, "the newest entry at the cut-over is in the record");
  assert.equal(sha256(PREFIX + record.slice(at)), OLD_LINE5_SHA256, "from that entry on, the record is line 5 as it stood at the cut-over");
  assert.ok(record.endsWith("before that 2026-11-08 (`docs/RETROSPECTIVE-2026-11-08.md`)."));
  // Entries newer than the cut-over are well-formed too.
  for (const e of entries(record.slice(PREFIX.length, at).replace(/; $/, "")).filter(Boolean)) assert.match(e, WELL_FORMED, e.slice(0, 80));
});

test("SH-4. docs/ssot-history/: one entry per file, verbatim on the third line, named by day and order, read newest first", () => {
  const names = (readdirSync(new URL("docs/ssot-history/", ROOT)) as string[]).sort();
  assert.ok(names.includes("README.md"));
  const rotated = names.filter((n) => n !== "README.md");
  for (const n of rotated) {
    assert.match(n, SSOT_ROTATED_FILE, n);
    const lines = read(`docs/ssot-history/${n}`).split("\n");
    assert.match(lines[0], /^# SSOT review entry/);
    assert.equal(lines[1], "");
    assert.match(lines[2], WELL_FORMED, n);
    assert.ok(balanced(lines[2]), n);
    assert.deepEqual(lines.slice(3), [""], `${n}: the entry alone`);
  }
  // The first entry moved out of line 5, at the cut-over itself (this change's own entry made a sixth).
  assert.ok(rotated.includes("2026-11-26-01-beam-toggle.md"));
  assert.match(read("docs/ssot-history/2026-11-26-01-beam-toggle.md").split("\n")[2], /^beam toggle, 2026-11-26 \(owner: "pandu aktifkan beam", "buatkan togglenya di cerebrum > command"/);
  // Read newest first: the rotated entries sit between line 5 and the archive in reverse name order.
  const record = lastReviewedRecord();
  const positions = rotated.slice().reverse().map((n) => record.indexOf(read(`docs/ssot-history/${n}`).split("\n")[2]));
  assert.deepEqual(positions, positions.slice().sort((a, b) => a - b));
  assert.ok(positions.every((p) => p > 0));
});

test("SH-5. the rule is in AGENTS.md with the owner's words; this change's entry; no guard path", () => {
  const agents = read("AGENTS.md");
  assert.match(agents, /## The SSOT's "Last reviewed" record \(owner, 2026-11-26: "Ya, setuju pindahkan"\)/);
  assert.match(agents, /Line 5 holds the newest five entries/);
  assert.match(agents, /move the oldest entry of line 5 into a new file `docs\/ssot-history\/<YYYY-MM-DD>-<NN>-<slug>\.md`/);
  assert.match(agents, /Never edit a file in `docs\/ssot-history\/` or `docs\/SSOT-HISTORY\.md`/);
  assert.match(lastReviewedRecord(), /^Last reviewed: 2026-11-16 \((?:[^\n]*; )?SSOT history moved, 2026-11-26 \(owner: "Ya, setuju pindahkan"; /);
  for (const p of ["AGENTS.md", "docs/SSOT.md", "docs/SSOT-HISTORY.md", "docs/ssot-history/README.md", "workers/control-plane-shared/test/harness.ts"]) assert.equal(criticalPathReason(p), null, p);
});
