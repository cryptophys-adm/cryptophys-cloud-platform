// HAIC H1a (docs/design/HAIC-H0-H1.md §3.2): the Forge's read-only `docs_index` RPC over canonical main's documents.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DOC_ROOTS, MAX_RESULT_CHARS, MAX_SECTION_CHARS, docRef, readDocs, resetDocsCache, splitSections } from "../../forge/src/docs-index.ts";

const MAIN = "a".repeat(40);
interface Tree { [name: string]: string | Tree }
/** A fake Artifacts repository: hashes are counters, main is MAIN, every read is counted. */
function fakeArtifacts(files: Tree) {
  const trees = new Map<string, { name: string; mode: string; hash: string; type: string }[]>();
  const blobs = new Map<string, string>();
  let n = 0;
  const reads = { tree: 0, blob: 0 };
  const build = (t: Tree): string => {
    const entries = Object.entries(t).map(([name, v]) => {
      if (typeof v === "string") { const h = `b${n++}`; blobs.set(h, v); return { name, mode: "100644", hash: h, type: "blob" }; }
      return { name, mode: "40000", hash: build(v), type: "tree" };
    });
    const h = `t${n++}`; trees.set(h, entries); return h;
  };
  const root = build(files);
  const repo = {
    log: async () => [{ hash: MAIN }],
    readCommit: async (h: string) => (h === MAIN ? { hash: h, treeHash: root } : null),
    readTree: async (h: string) => { reads.tree++; return trees.get(h) ?? null; },
    readBlob: async (h: string) => { reads.blob++; return blobs.has(h) ? new Blob([blobs.get(h)!]) : null; },
  };
  const asked: string[] = [];
  return { reads, asked, env: { ARTIFACTS: { get: async (name: string) => { asked.push(name); return repo; } } } as never };
}

const ADR = `# ADR-0017: Human-AI collaboration

- **Status:** Accepted.

## Phases

| H0 | "Needs you" inbox |

## Guards

Approvals happen only by a click in Cerebrum.

\`\`\`md
# not a heading inside a fence
\`\`\`

## Guards

A second section with the same heading.
`;

const TREE: Tree = {
  architecture: { adr: { "0017-human-ai-collaboration.md": ADR, "README.md": "# ADRs\n\nThe index.\n", progress: { "0017.json": "{}" } } },
  docs: { "SSOT.md": `# SSOT\n\nLast reviewed: ${"x".repeat(MAX_SECTION_CHARS + 500)}\n\n## Platform rules\n\nNo fund movement.\n`, design: { "HAIC-H0-H1.md": "# Design\n\n## 2. H0: the Needs you inbox\n\nThe Needs you inbox ranks items.\n" }, "notes.txt": "not markdown" },
  workers: { "README.md": "# not a document root\n" },
  ".github": { "README.md": "# hidden\n" },
};

test("H1a-1. splitSections: ATX headings outside code fences, a _top preamble, unique ids", () => {
  const s = splitSections(ADR);
  assert.deepEqual(s.map((x) => [x.id, x.level, x.heading]), [
    ["adr-0017-human-ai-collaboration", 1, "ADR-0017: Human-AI collaboration"], ["phases", 2, "Phases"], ["guards", 2, "Guards"], ["guards-2", 2, "Guards"],
  ]);
  assert.match(s[2].text, /# not a heading inside a fence/, "a fenced # line stays text");
  assert.deepEqual(splitSections("intro line\n\n# A\nbody").map((x) => x.id), ["_top", "a"]);
  assert.deepEqual(splitSections(""), []);
});

test("H1a-2. the index lists every *.md under architecture/adr and docs at canonical main, and nothing else; read only", async () => {
  resetDocsCache();
  const f = fakeArtifacts(TREE);
  const r = await readDocs(f.env) as any;
  assert.deepEqual([r.available, r.main_sha, r.schema, r.truncated], [true, MAIN, "forge.docs.v1", false]);
  assert.deepEqual(r.files.map((x: any) => x.path), ["architecture/adr/0017-human-ai-collaboration.md", "architecture/adr/README.md", "docs/SSOT.md", "docs/design/HAIC-H0-H1.md"]);
  assert.deepEqual(DOC_ROOTS, ["architecture/adr", "docs"]);
  assert.deepEqual(r.files[0].sections.map((s: any) => s.id), ["adr-0017-human-ai-collaboration", "phases", "guards", "guards-2"]);
  assert.ok(r.files[0].sections.every((s: any) => typeof s.chars === "number" && !("text" in s)), "the index carries sizes, not text");
  assert.deepEqual(f.asked, ["platform"], "only the canonical repository is read");
  const before = { ...f.reads };
  await readDocs(f.env);
  assert.deepEqual(f.reads, before, "a second call at the same main reads nothing from Artifacts");
  const src = readFileSync(new URL("../../forge/src/docs-index.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /fastForward|forgeMerge|createToken|receive-pack|INSERT INTO|UPDATE \w|DELETE FROM|appendAuditEvent|\.prepare\(/, "nothing in the module writes");
});

test("H1a-3. one document's sections with text and evidence refs, cut at the section and call limits; a section by id; refusals", async () => {
  resetDocsCache();
  const { env } = fakeArtifacts(TREE);
  const one = await readDocs(env, { path: "docs/SSOT.md" }) as any;
  assert.deepEqual(one.sections.map((s: any) => [s.id, s.truncated]), [["ssot", true], ["platform-rules", false]]);
  assert.equal(one.sections[0].text.length, MAX_SECTION_CHARS);
  assert.equal(one.sections[1].ref, `ev:platform/doc/docs/SSOT.md@${MAIN.slice(0, 12)}#platform-rules`);
  assert.equal(one.sections[1].ref, docRef("docs/SSOT.md", MAIN, "platform-rules"));
  const sec = await readDocs(env, { path: "architecture/adr/0017-human-ai-collaboration.md", section: "guards-2" }) as any;
  assert.deepEqual(sec.sections.map((s: any) => s.text), ["A second section with the same heading."]);
  assert.equal((await readDocs(env, { path: "workers/README.md" }) as any).refused, "not_a_document");
  assert.equal((await readDocs(env, { path: "docs/missing.md" }) as any).refused, "not_found");
  assert.equal((await readDocs(env, { path: "docs/SSOT.md", section: "nope" }) as any).refused, "section_not_found");
  assert.equal((await readDocs(env, { path: "../../etc/passwd" }) as any).refused, "not_a_document");
  assert.ok(MAX_RESULT_CHARS >= MAX_SECTION_CHARS);
});

test("H1a-4. a word search: every word must match, headings count triple, best first, with a snippet and a ref", async () => {
  resetDocsCache();
  const { env } = fakeArtifacts(TREE);
  const r = await readDocs(env, { query: "Needs you inbox" }) as any;
  assert.deepEqual(r.terms, ["needs", "you", "inbox"]);
  assert.deepEqual(r.results.map((x: any) => `${x.path}#${x.id}`), ["docs/design/HAIC-H0-H1.md#2-h0-the-needs-you-inbox", "architecture/adr/0017-human-ai-collaboration.md#phases"], "the heading match ranks first");
  assert.match(r.results[0].snippet, /Needs you inbox ranks items/);
  assert.deepEqual(r.results.map((x: any) => x.score), [12, 3]);
  assert.equal(r.results[0].ref, `ev:platform/doc/docs/design/HAIC-H0-H1.md@${MAIN.slice(0, 12)}#2-h0-the-needs-you-inbox`);
  assert.equal((await readDocs(env, { query: "guards", limit: 1 }) as any).results.length, 1);
  assert.deepEqual((await readDocs(env, { query: "nothing-matches-this" }) as any).results, []);
  assert.deepEqual((await readDocs(env, { query: "?!" }) as any).results, []);
});

test("H1a-5. without Artifacts or a readable main the answer says so; the RPC is the Forge's DocsRpc", async () => {
  resetDocsCache();
  assert.deepEqual(await readDocs({} as never), { available: false, reason: "artifacts_not_bound" });
  const noMain = { ARTIFACTS: { get: async () => ({ log: async () => [] }) } } as never;
  assert.deepEqual(await readDocs(noMain), { available: false, reason: "main_unreadable" });
  const worker = readFileSync(new URL("../../forge/src/worker.ts", import.meta.url), "utf8");
  assert.match(worker, /export class DocsRpc extends WorkerEntrypoint<Env> \{\n\s+async read\(/);
});
