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
6. **Type-check.** `tsc --noEmit -p workers/control-plane-tsconfig.json` runs on Workers Builds from the Artifacts repository (`../forge-typecheck`), because the compiler needs about 190 MB and an isolate has 128 MB (owner, 2026-11-08). The build reports to `POST /v1/forge/typecheck-report` (`src/typecheck.ts`, migration 0035).
   - The check of the same commit takes the report as its `typecheck` step; until it arrives the step is `pending`.
   - A type error fails the check, also when the report arrives after the check ran.
   - Change requests (`cr/<number>`) are type-checked by a second project with no build secrets, `../forge-typecheck-cr` (root directory `workers/forge-typecheck-cr` in both the Production and the Previews Base build settings, which Workers Builds keeps apart; ADR-0012 §5d, owner 2026-11-11). Its build prints the result as one log line, and each tick reads it through the Workers Builds API (`src/cr-builds.ts`, Forge secret `CF_BUILDS_API_TOKEN`). The line counts only when its commit is the change request's head. Without the secret the step is skipped, and change requests stay `pending` on the type-check.
     A Preview build may be listed only under its Preview, so when the Worker's build list has none for the branch, the tick reads the branch's Preview. The `forge.tick` log line reports the step under `cr_typecheck`: `outcome`, `open`, `recorded`, `builds_listed`, `previews_listed` and `via_preview`.
7. **Record.** The result goes to D1 `forge_check_runs` (with `steps` and `guard_status`) and the audit chain.

- **Shim imports.** `src/runner/assets.js` holds the wasm toolchain. Only `src/worker.ts` imports it, so the Node tests never load it. Wrangler imports the shims as Text (`[[rules]]`). The globs match the import specifiers as written there, so keep those import paths.
- **Local run.** `node tools/forge-runner/run.mjs` runs the same checks code in local workerd. There the type-check step reads `not_configured`.

## Organism census (ADR-0013)

`src/census.ts` reads main's DNA (`workers/<dir>/organism.json`). It also reads the external organs' DNA over RPC: the XAUUSD Workers through `EXT_ORGANISM_XAUUSD`, the xauusd AI Worker's `OrganismDna.dna()`. Each census compares that DNA with the live registries.

- External organs are held to the external ceiling (ADR-0013 §6).
- An origin that does not answer is an `external_dna_unavailable` finding. Main's census still runs.
- The census of an unchanged head is retaken every 30 minutes, so a new XAUUSD deploy is seen within half an hour.

## Change requests (phase 4, shadow)

`src/changes.ts`, migration 0037, ADR-0012 §5d. Every same-repository pull request becomes change
request `gh-<number>`: `forge-change-request.yml` pushes its head to `cr/<number>` and registers it
(`POST /v1/forge/changes`, CI service token, `confirm: "REGISTER"`). The cron checks open change
request heads before commits of `main`. `GET /v1/forge/changes` lists each one with:

- the changed paths and the owner-only reasons (ADR §2.4);
- the check of its head (tests, bundles, secret scan, type-check and Console build);
- the verdict: `pending`, `blocked`, `needs_owner` or `would_merge`.

`mirror-to-forge.yml` reports GitHub's outcome (`POST /v1/forge/changes/outcome`, `confirm: "REPORT"`),
which freezes the verdict. Merge parity counts GitHub merges the Forge agreed with (target 10). The
Forge merges nothing yet.

## Deploy plan (phase 4, shadow)

`src/deploy-plan.ts`, migration 0038. Each tick computes which deploy units main's head needs, from
Artifacts tree diffs against each unit's desired version, with the Orchestrator's shared rules
(`control-plane-shared/src/deploy-units.ts`). The Orchestrator records its GitHub-based plan for the
same commit and registry inputs; `GET /v1/forge/deploy-plans` lists both and the plan parity (target 10).

## The cron tick

`src/tick.ts` runs three independent steps at :04/:19/:34/:49:
1. the deploy plan;
2. one change request head;
3. one commit of `main`, deferred when step 2 used more than two minutes.

A failing step never stops the others, and its error is audited as `forge.tick_failed`.
