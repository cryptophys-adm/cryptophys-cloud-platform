# cryptophys-forge

ADR-0012: the Cloudflare-native source of the platform, on Artifacts (`cryptophys/platform`), and
the checks that run the control-plane test suite against it (phase 3).

| Route | Who | What |
|---|---|---|
| `GET /health`, `GET /ready` | Access | Health and readiness (`artifacts_binding`, D1 schema, Access) |
| `GET /v1/forge/status` | operators, viewers | The repo and the head of `main` |
| `GET /v1/forge/commits?limit=` | operators, viewers | History of `main` (newest first) |
| `GET /v1/forge/checks?limit=` | operators, viewers | Forge checks of recent commits of `main` (newest first), each with GitHub CI's conclusion, plus the parity count |
| `POST /v1/forge/ci-report` `{confirm:"REPORT", commit, conclusion, workflow_run_id}` | the CI service token only | GitHub CI's conclusion for a commit of `main` (`forge-ci-report.yml`) |
| `POST /v1/forge/import` `{confirm:"IMPORT"}` | operators | One-time import of the GitHub repository; an existing repo is left alone |
| `POST /v1/forge/mirror-token` `{confirm:"MIRROR"}` | the CI service token only | 10-minute write token for the mirror workflow |

While GitHub is still the source of truth (phases 1–4), `mirror-to-forge.yml` pushes `main` to the
Artifacts repo after every push, so both hold the same commit SHAs. Deployed by `deploy-forge.yml`.

## Forge checks (phase 3)

A cron at `:04/:19/:34/:49` runs the control-plane suite against the next unchecked commit of `main`.
It needs no GitHub at any step.

1. **Snapshot.** The commit's text files are read from Artifacts (`src/checks.ts`).
2. **Bundle.** Each test file is bundled by esbuild-wasm in this isolate (`src/runner/core.ts`). `node:test`, `node:sqlite`, `node:fs`, `node:os` and `node:child_process` are replaced by `src/runner/shims/`.
3. **Run.** The bundles run in Dynamic Workers (`[[worker_loaders]]`), 8 files per Worker, with no network access.
4. **Bundles.** Every Worker in the commit is bundled, as CI's dry run does. The Worker's `[[rules]]` apply, and `.wasm` and `node_modules` imports stay external.
5. **Secret scan.** Well-known credential formats are scanned for. A finding records the rule, path and line, never the text.
6. **Record.** The result goes to D1 `forge_check_runs` (with `steps` and `guard_status`) and the audit chain.

- **Shim imports.** `src/runner/assets.js` holds the wasm toolchain. Only `src/worker.ts` imports it, so the Node tests never load it. Wrangler imports the shims as Text (`[[rules]]`). The globs match the import specifiers as written there, so keep those import paths.
- **Local run.** `node tools/forge-runner/run.mjs` runs the same checks code in local workerd.
