# Forge runner, local (ADR-0012 phase 3)

Runs the **Forge checks** on this machine, in workerd (the Workers runtime), with the Forge's own
code: `workers/forge/src/checks.ts` and `workers/forge/src/runner/`.

- **Bundling.** The control-plane test suite is bundled by esbuild-wasm inside the isolate.
- **Running.** The bundles run in Dynamic Workers, 4 files per Worker, loaded by content id (`LOADER.get`), as the Forge Worker does on Cloudflare. `--runs=2` checks the commit twice; `cold` in the summary is how many Workers each run had to build (0 the second time).
- **The one stand-in.** The Artifacts repo is replaced by git-style trees built from the working tree (tracked files and untracked, not-ignored ones).

| Node module | Replacement in the isolate (`workers/forge/src/runner/shims/`) |
|---|---|
| `node:test` | `test`, `test.skip`/`todo`, `beforeEach`/`afterEach` |
| `node:sqlite` | `DatabaseSync` over sql.js (SQLite in WebAssembly) |
| `node:fs` | read-only snapshot of the commit's text files, plus an in-memory scratch area |
| `node:os`, `node:child_process` | small stubs; `spawnSync` is not available |
| Wrangler bundling (TP-025) | `globalThis.__FORGE_BUNDLE(dir)`, which calls the Forge's `ForgeBundler` entrypoint |

```sh
(cd workers/control-plane-shared && npm ci)
node tools/forge-runner/run.mjs              # whole suite
node tools/forge-runner/run.mjs plain-english.test.ts
node tools/forge-runner/run.mjs --runs=2          # twice, on the Workers the first run left warm
```

Status (2026-11-08): **all 329 tests pass**, with the same per-file counts as Node, in about 38 s.
