# Forge runner (ADR-0012 phase 3)

Runs the control-plane test suite in **workerd**, the Workers runtime, instead of Node. These same
shims are what the Forge loads into Dynamic Workers when the checks move off GitHub.

| Node module | Replacement in the isolate |
|---|---|
| `node:test` | `shims/node-test.js`: `test`, `test.skip`/`todo`, `beforeEach`/`afterEach` |
| `node:sqlite` | `shims/node-sqlite.js`: `DatabaseSync` over sql.js (SQLite in WebAssembly) |
| `node:fs` | `shims/node-fs.js`: a read-only snapshot of the repository's text files, plus an in-memory scratch area |
| `node:os`, `node:child_process` | small stubs; `spawnSync` is not available |

How it works:

- Each test file is bundled with esbuild.
- `import.meta.url` is replaced by the file's own repository path, so relative reads resolve.
- The module's top level is deferred until a request arrives, because workerd evaluates configured modules at startup, when `Date.now()` is 0.
- Each file then runs in a fresh `workerd` process.

```sh
(cd workers/control-plane-shared && npm ci)
node tools/forge-runner/run.mjs              # whole suite
node tools/forge-runner/run.mjs plain-english.test.ts
```

Status (2026-11-08): **321 of 322 tests pass in workerd**, with the same per-file counts as Node. The one known gap is the Wrangler dry-run bundle test (TP-025). It needs an in-isolate bundler, and it still runs in Node CI.
