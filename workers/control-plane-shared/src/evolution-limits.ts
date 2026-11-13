// ADR-0014 §4 and §9: the evolution loop's hard limits, and the one validator of an evolution's edits. The AI
// Kernel's evolver runs it before it proposes (to spend no syscall on a change that cannot pass) and the Forge runs
// it again before it writes a commit (the authority). Owner decisions: one evolution in flight and one started per
// 4 hours (2026-11-13), at most 400 changed lines and 20 files (2026-11-12), gpt-oss on Workers AI only (2026-11-13).
// E2 (owner 2026-11-13: "boleh, bangun evolver sekarang secara paralel") proposes only routine changes: guard paths,
// D1 migrations, Worker configuration, dependencies and deletions wait for E1 and E3 (ADR-0014 §3's conditions).
//
// This file is a guard path (guard-paths.ts): an evolution may not change it.
import { criticalPathReason } from "./guard-paths.ts";

export const EVOLVER_AGENT_ID = "evolver";
export const EVOLVER_MODEL = "@cf/openai/gpt-oss-120b";
export const MAX_IN_FLIGHT = 1;
export const MIN_START_INTERVAL_HOURS = 4;
export const MAX_CHANGED_LINES = 400;
export const MAX_CHANGED_FILES = 20;
export const MAX_EDITS = 40;
export const MAX_FILE_BYTES = 120_000;
/** An approach that failed for an intent is not tried again for this long (ADR-0014 §1, step 8). */
export const FAILED_APPROACH_COOLDOWN_DAYS = 7;
export const EVOLUTION_ID = /^evo_[0-9a-f]{12}$/;
export const evolutionBranch = (id: string) => `evo/${id}`;

const EVOLVABLE = /^(workers|docs)\/[A-Za-z0-9._@+-]+(\/[A-Za-z0-9._@+-]+)*$/;
const MIGRATION = /^workers\/control-plane-migrations\//;
const CONFIG = /(^|\/)(wrangler(\.[a-z]+)?\.toml|organism\.json)$/;
const DEPENDENCIES = /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const BINARY = /\.(png|jpe?g|gif|webp|ico|wasm|woff2?|ttf|zip|gz|pdf)$/i;
const TEST_FILE = /\.test\.(ts|mjs)$/;
const ASSERTION = /\bassert(?:\.[A-Za-z]+)?\s*\(/g;

export type Edit = { path: string; find: string; replace: string } | { path: string; create: string };
export interface EditedFile { path: string; before: string | null; after: string }
export type EditCheck = { ok: true; files: EditedFile[]; changed_lines: number } | { ok: false; refusals: string[] };

/** Why E2 may not touch a path, or null when it may. */
export function pathRefusal(path: string): string | null {
  if (typeof path !== "string" || !EVOLVABLE.test(path) || path.split("/").some((s) => s === "." || s === ".." || s.startsWith("."))) return "path_outside_scope";
  if (path.includes("/node_modules/") || path.includes("/dist/")) return "path_generated";
  const guard = criticalPathReason(path);
  if (guard) return `guard_path:${guard}`;
  if (MIGRATION.test(path)) return "d1_migration";
  if (CONFIG.test(path)) return "worker_configuration";
  if (DEPENDENCIES.test(path)) return "dependencies";
  if (BINARY.test(path)) return "binary_file";
  return null;
}

/** Lines added plus lines removed, counted as a multiset difference (an upper bound for a real diff). */
export function changedLines(before: string | null, after: string): number {
  const count = (text: string) => {
    const m = new Map<string, number>();
    if (text) for (const line of text.split("\n")) m.set(line, (m.get(line) ?? 0) + 1);
    return m;
  };
  const a = count(before ?? "");
  const b = count(after);
  let n = 0;
  for (const [line, k] of a) n += Math.max(0, k - (b.get(line) ?? 0));
  for (const [line, k] of b) n += Math.max(0, k - (a.get(line) ?? 0));
  return n;
}

const occurrences = (text: string, part: string) => {
  let n = 0;
  for (let i = text.indexOf(part); i !== -1; i = text.indexOf(part, i + part.length)) n++;
  return n;
};

/**
 * Apply `edits` to `base` (path -> current content, null when the file does not exist) and check every limit.
 * A replace edit's `find` must occur exactly once in the file as the previous edits left it; a create needs a file
 * that does not exist. A change to a Worker's source needs a new or changed test, and a test may only gain assertions.
 */
export function checkEdits(base: ReadonlyMap<string, string | null>, edits: unknown): EditCheck {
  const refusals: string[] = [];
  if (!Array.isArray(edits) || edits.length === 0) return { ok: false, refusals: ["no_edits"] };
  if (edits.length > MAX_EDITS) return { ok: false, refusals: ["too_many_edits"] };
  const current = new Map<string, string | null>();
  const original = new Map<string, string | null>();
  for (const raw of edits) {
    const e = raw as Record<string, unknown>;
    const path = typeof e?.path === "string" ? e.path : "";
    const why = pathRefusal(path);
    if (why) { refusals.push(`${why}: ${path.slice(0, 120)}`); continue; }
    if (!base.has(path)) { refusals.push(`not_read: ${path}`); continue; }
    if (!original.has(path)) { original.set(path, base.get(path) ?? null); current.set(path, base.get(path) ?? null); }
    const now = current.get(path) ?? null;
    if (typeof e.create === "string") {
      if (now !== null) { refusals.push(`exists: ${path}`); continue; }
      current.set(path, e.create);
    } else if (typeof e.find === "string" && typeof e.replace === "string" && e.find.length > 0) {
      if (now === null) { refusals.push(`missing: ${path}`); continue; }
      const n = occurrences(now, e.find);
      if (n !== 1) { refusals.push(`${n === 0 ? "find_not_found" : "find_not_unique"}: ${path}`); continue; }
      current.set(path, now.replace(e.find, () => e.replace as string));
    } else {
      refusals.push(`malformed_edit: ${path}`);
    }
  }
  if (refusals.length) return { ok: false, refusals };

  const files: EditedFile[] = [];
  let lines = 0;
  for (const [path, after] of current) {
    const before = original.get(path) ?? null;
    if (after === null || after === before) { refusals.push(`no_change: ${path}`); continue; }
    if (after.includes("\u0000")) refusals.push(`binary_content: ${path}`);
    if (new TextEncoder().encode(after).length > MAX_FILE_BYTES) refusals.push(`file_too_large: ${path}`);
    if (TEST_FILE.test(path) && before !== null && (after.match(ASSERTION) ?? []).length < (before.match(ASSERTION) ?? []).length) {
      refusals.push(`assertions_removed: ${path}`);
    }
    lines += changedLines(before, after);
    files.push({ path, before, after });
  }
  if (files.length > MAX_CHANGED_FILES) refusals.push(`too_many_files: ${files.length}`);
  if (lines > MAX_CHANGED_LINES) refusals.push(`too_many_lines: ${lines}`);
  const source = files.some((f) => /^workers\/[^/]+\/src\//.test(f.path) && !TEST_FILE.test(f.path));
  if (source && !files.some((f) => TEST_FILE.test(f.path))) refusals.push("behaviour_change_without_test");
  if (refusals.length) return { ok: false, refusals };
  return { ok: true, files: files.sort((a, b) => a.path.localeCompare(b.path)), changed_lines: lines };
}
