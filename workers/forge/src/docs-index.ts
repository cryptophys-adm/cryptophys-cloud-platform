// HAIC H1a (docs/design/HAIC-H0-H1.md §3.2, tool `docs_index`): the platform's own documents, read from canonical main
// on Artifacts and split by heading, for the read-only "Ask the organism" chat (H1b). Bundling them at build time, as
// the vision is, would redeploy the Control Plane on every doc edit; this reads main at call time instead.
//
// Read only: no write, no ref but main, no path outside the document roots. Every section carries an evidence ref
// `ev:platform/doc/<path>@<main sha 12>#<section id>` (the §4.6 format), so an answer can cite the exact text it used.
import type { ArtifactsReader } from "./checks.ts";
import { CANONICAL_REPO, refHead, type MergeBinding } from "./merge.ts";

/** The document roots: every `*.md` below them (ADRs, their records, the runbooks, the designs). */
export const DOC_ROOTS = ["architecture/adr", "docs"] as const;
export const MAX_DOC_FILES = 150;
/** A section's text is cut here (the SSOT's dated line 5 alone is longer); `truncated` says so. */
export const MAX_SECTION_CHARS = 6_000;
/** The whole answer of one call stays under this many characters of section text. */
export const MAX_RESULT_CHARS = 48_000;
export const MAX_QUERY_RESULTS = 12;
const MAX_QUERY_TERMS = 8;

export interface DocSection { id: string; heading: string; level: number; text: string }
interface DocFile { path: string; sections: DocSection[] }
type Reader = Pick<ArtifactsReader, "readCommit" | "readTree" | "readBlob" | "log">;
export interface DocsEnv { ARTIFACTS?: MergeBinding }

const slug = (s: string) => s.toLowerCase().replace(/[`*_~[\]()]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "section";

/**
 * Split Markdown into sections at ATX headings (`#` to `######`), outside fenced code blocks. Text before the first
 * heading is the section `_top` (level 0). Ids are the heading's slug, made unique within the file (`-2`, `-3`, …).
 */
export function splitSections(text: string): DocSection[] {
  const out: DocSection[] = [];
  const seen = new Map<string, number>();
  let cur: DocSection = { id: "_top", heading: "", level: 0, text: "" };
  let fence: string | null = null;
  const body: string[] = [];
  const flush = () => { cur.text = body.join("\n").trim(); body.length = 0; if (cur.level > 0 || cur.text) out.push(cur); };
  for (const line of text.split("\n")) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) { if (fence === null) fence = f[1][0]; else if (f[1][0] === fence) fence = null; body.push(line); continue; }
    const h = fence === null ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (!h) { body.push(line); continue; }
    flush();
    const base = slug(h[2]);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    cur = { id: n === 1 ? base : `${base}-${n}`, heading: h[2], level: h[1].length, text: "" };
  }
  flush();
  return out;
}

const isDoc = (path: string) => path.endsWith(".md") && DOC_ROOTS.some((r) => path.startsWith(`${r}/`));

// One parsed copy per isolate, for the newest main it read: main moves a few times a day, the chat asks often.
let cache: { main: string; files: DocFile[]; truncated: boolean } | null = null;

async function load(repo: Reader, main: string): Promise<{ files: DocFile[]; truncated: boolean }> {
  if (cache?.main === main) return cache;
  const commit = await repo.readCommit(main);
  if (!commit) throw new Error("main_unreadable");
  const files: DocFile[] = [];
  let truncated = false;
  const walk = async (tree: string, at: string): Promise<void> => {
    for (const e of (await repo.readTree(tree)) ?? []) {
      const path = at ? `${at}/${e.name}` : e.name;
      if (e.type === "tree") {
        if (e.name === "node_modules" || e.name.startsWith(".")) continue;
        if (!DOC_ROOTS.some((r) => r === path || r.startsWith(`${path}/`) || path.startsWith(`${r}/`))) continue;
        await walk(e.hash, path);
      } else if (e.type === "blob" && isDoc(path)) {
        if (files.length >= MAX_DOC_FILES) { truncated = true; return; }
        const blob = await repo.readBlob(e.hash);
        if (blob) files.push({ path, sections: splitSections(await blob.text()) });
      }
    }
  };
  await walk(commit.treeHash, "");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  cache = { main, files, truncated };
  return cache;
}

/** The evidence ref of one section at a main commit. */
export const docRef = (path: string, main: string, id: string) => `ev:platform/doc/${path}@${main.slice(0, 12)}#${id}`;

function cut(text: string, max: number) { return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false }; }

/**
 * - no input: the index, every document's path and its sections' ids, headings, levels and sizes;
 * - `path`: that document's sections with their text (each up to MAX_SECTION_CHARS, the call up to MAX_RESULT_CHARS),
 *   or only `section` (an id) of it;
 * - `query`: the sections that contain every word of it (heading matches count triple), best first, each with a
 *   snippet around the first match; at most `limit` (≤ MAX_QUERY_RESULTS).
 */
export async function readDocs(env: DocsEnv, input: { path?: unknown; section?: unknown; query?: unknown; limit?: unknown } = {}): Promise<Record<string, unknown>> {
  if (!env.ARTIFACTS) return { available: false, reason: "artifacts_not_bound" };
  const repo = await env.ARTIFACTS.get(CANONICAL_REPO) as unknown as Reader & { [Symbol.dispose]?: () => void };
  try {
    const main = await refHead(repo, "main");
    if (!main) return { available: false, reason: "main_unreadable" };
    const { files, truncated } = await load(repo, main);
    const base = { available: true, main_sha: main, schema: "forge.docs.v1" };

    if (typeof input.path === "string") {
      const file = files.find((f) => f.path === input.path);
      if (!file) return { ...base, refused: isDoc(input.path) ? "not_found" : "not_a_document" };
      const wanted = typeof input.section === "string" ? file.sections.filter((s) => s.id === input.section) : file.sections;
      if (typeof input.section === "string" && !wanted.length) return { ...base, path: file.path, refused: "section_not_found" };
      let budget = MAX_RESULT_CHARS;
      const sections = [];
      for (const s of wanted) {
        if (budget <= 0) break;
        const c = cut(s.text, Math.min(MAX_SECTION_CHARS, budget));
        budget -= c.text.length;
        sections.push({ id: s.id, heading: s.heading, level: s.level, text: c.text, truncated: c.truncated, ref: docRef(file.path, main, s.id) });
      }
      return { ...base, path: file.path, sections, omitted: wanted.length - sections.length };
    }

    if (typeof input.query === "string" && input.query.trim()) {
      const terms = [...new Set(input.query.toLowerCase().split(/[^a-z0-9_.-]+/).filter((t) => t.length >= 2))].slice(0, MAX_QUERY_TERMS);
      if (!terms.length) return { ...base, query: input.query, results: [] };
      const limit = Math.max(1, Math.min(MAX_QUERY_RESULTS, Number.isInteger(input.limit) ? Number(input.limit) : MAX_QUERY_RESULTS));
      const hits: { path: string; s: DocSection; score: number; at: number }[] = [];
      for (const f of files) for (const s of f.sections) {
        const head = s.heading.toLowerCase(), body = s.text.toLowerCase();
        let score = 0, at = -1;
        for (const t of terms) {
          const inHead = head.includes(t), i = body.indexOf(t);
          if (!inHead && i < 0) { score = 0; break; }
          score += (inHead ? 3 : 0) + (i < 0 ? 0 : body.split(t).length - 1);
          if (i >= 0 && (at < 0 || i < at)) at = i;
        }
        if (score > 0) hits.push({ path: f.path, s, score, at });
      }
      hits.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return {
        ...base, query: input.query, terms, total: hits.length,
        results: hits.slice(0, limit).map((h) => {
          const from = Math.max(0, h.at - 200);
          return { path: h.path, id: h.s.id, heading: h.s.heading, level: h.s.level, score: h.score,
            snippet: `${from > 0 ? "…" : ""}${h.s.text.slice(from, from + 600)}${from + 600 < h.s.text.length ? "…" : ""}`, ref: docRef(h.path, main, h.s.id) };
        }),
      };
    }

    return {
      ...base, truncated,
      files: files.map((f) => ({ path: f.path, sections: f.sections.map((s) => ({ id: s.id, heading: s.heading, level: s.level, chars: s.text.length })) })),
    };
  } finally {
    repo[Symbol.dispose]?.();
  }
}

/** For tests: forget the parsed copy. */
export function resetDocsCache(): void { cache = null; }
