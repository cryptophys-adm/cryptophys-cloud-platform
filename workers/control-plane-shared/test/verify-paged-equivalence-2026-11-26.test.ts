// A2 (2026-11-26): the verify reads the stored bundle by range in pages (PagedSource). The same passes run on either
// source, so every verify test of gate 8 (BV, and GM for memory) runs here a second time with every in-memory verify
// read through PagedSource in 4 KiB pages and a 16 KiB page cache: entries and streams cross pages, bases are read
// back after eviction. Every assertion of those files must hold unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageInMemoryVerifyForTests, pagedReadsForTests } from "../../forge/src/bundle-verify.ts";

pageInMemoryVerifyForTests({ pageBytes: 4096, cacheBytes: 16_384 });
await import("./gate8-bundle-verify-2026-11-15.test.ts");
await import("./gate8-bundle-verify-memory-2026-11-20.test.ts");

test("EQ. the run above read through pages (it was not the in-memory path)", () => {
  assert.ok(pagedReadsForTests() > 1000, `paged reads ${pagedReadsForTests()}`);
});
