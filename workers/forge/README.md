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
| `POST /v1/forge/test-report` `{confirm:"REPORT", commit, tree?, build_uuid, branch?, files, pass, fail, skip, failures, duration_ms?, node?}` | the CI service token only | The control-plane test result of a commit from its Workers Builds run (CI-WB, 2026-11-25; `src/test-report.ts`, migration 0089) |
| `POST /v1/forge/import` `{confirm:"IMPORT"}` | operators | One-time import of the GitHub repository; an existing repo is left alone |
| `POST /v1/forge/mirror-token` `{confirm:"MIRROR"}` | the CI service token only | 10-minute write token for the mirror workflow |

While GitHub is still the source of truth (phases 1–4), `mirror-to-forge.yml` pushes `main` to the
Artifacts repo after every push, so both hold the same commit SHAs. Deployed by `deploy-forge.yml`.

## Forge checks (phase 3)

A cron at `:04/:19/:34/:49` checks `main`'s head when it has no run of main yet. There is no daily rerun of an
unchanged head (CI-WB, 2026-11-25: the daily run of 2026-11-14 is dropped; a lost or errored run is still retried
after 30 minutes). Commits a newer head superseded are not checked. It needs no GitHub at any step.

**Tests on Workers Builds (CI-WB, owner 2026-11-25: "ok jalankan rekomendasimu").** The suite runs natively in the
commit's own Workers Builds run, after the type-check (`../forge-typecheck/typecheck-and-report.mjs`: the `test`
script's command, a reporter that keeps only each test's file, name and outcome, the build secrets removed from the
tests' environment). A build of `main` posts the result to `POST /v1/forge/test-report`; a change request build has no
secrets and prints `FORGE_TEST_RESULT {...}`, which `src/cr-builds.ts` reads from the same log read as the type-check
line (within the 9 requests a tick). Both are validated by `control-plane-shared/src/forge-test-report.ts` and kept in
`forge_test_reports`, one row per commit. A check takes a report only for its exact commit (and tree), and only when
the report's test files equal the snapshot's test files; otherwise the run is an `error`
(`test_report_files_mismatch`), never a pass. Such a row has the usual shape: runner `workers-builds/1`,
`steps.tests`, `steps.workers` `{groups: 0, bundles: 0, loads: 0}`, coverage `full`, and
`steps.test_report {build_uuid, source: "workers_builds"}`. Steps 1, 4 and 5 below, the guard, the R2 bundle store
and the dependency record stay in this isolate. A head with no report waits, unclaimed, until two ticks after the
Forge first saw it (`forge_test_report_waits`), and the tick goes on with the next head due; then step 3 runs as a
fallback with **one** Dynamic Worker for the whole run. Its id is the hash of the whole suite's bundle, so an unchanged
suite keeps it; an isolate crash reruns each file alone; a Loader size limit, or bundles over 8 MB, runs the groups
of 4 instead (today's 189 test bundles are about 63 MB, so the fallback is grouped). The local harness
(`tools/forge-runner`) runs the suite as before.

1. **Snapshot.** The commit's text files are read from Artifacts (`src/checks.ts`).
2. **Bundle.** Each test file is bundled by esbuild-wasm in this isolate (`src/runner/core.ts`). `node:test`, `node:sqlite`, `node:fs`, `node:os` and `node:child_process` are replaced by `src/runner/shims/`.
3. **Run** (since CI-WB only the fallback). The bundles run in Dynamic Workers (`[[worker_loaders]]`), 4 files per Worker, with no network access and a 60 s CPU limit. A test Worker is loaded with `LOADER.get(id)`, where the id is the SHA-256 of its code; the commit and its snapshot come in the request, so an unchanged group reuses its Worker across commits (billing counts unique Worker IDs and code per day).
4. **Bundles.** Every Worker in the commit is bundled, as CI's dry run does. The Worker's `[[rules]]` apply, and `.wasm` and `node_modules` imports stay external.
5. **Secret scan.** Well-known credential formats are scanned for. A finding records the rule, path and line, never the text.
6. **Type-check.** `tsc --noEmit -p workers/control-plane-tsconfig.json` runs on Workers Builds from the Artifacts repository (`../forge-typecheck`), because the compiler needs about 190 MB and an isolate has 128 MB (owner, 2026-11-08). The build reports to `POST /v1/forge/typecheck-report` (`src/typecheck.ts`, migration 0035).
   - The check of the same commit takes the report as its `typecheck` step; until it arrives the step is `pending`.
   - A type error fails the check, also when the report arrives after the check ran.
   - Change requests (`cr/<number>`) are type-checked by a second project with no build secrets, `../forge-typecheck-cr` (root directory `workers/forge-typecheck-cr` in both the Production and the Previews Base build settings, which Workers Builds keeps apart; ADR-0012 §5d, owner 2026-11-11). Its build prints the result as one log line, and each tick reads it through the Workers Builds API (`src/cr-builds.ts`, Forge secret `CF_BUILDS_API_TOKEN`). The line counts only when its commit is the change request's head. Without the secret the step is skipped, and change requests stay `pending` on the type-check.
   - With the same secret, once an hour, the Forge measures the account's Workers Builds minutes (`src/build-usage.ts`, owner 2026-11-12): it lists every Worker's builds and its Previews' builds (GET only), keeps each finished build's measured duration in `forge_builds` (migration 0049), and serves the month against the free-tier budget of 3,000 minutes at `GET /v1/forge/build-usage`. The token needs `Workers Builds Configuration` and `Workers Scripts · Read`, which the change-request reader already uses.
     A Preview build may be listed only under its Preview, so when the Worker's build list has none for the branch, the tick reads the branch's Preview. The `forge.tick` log line reports the step under `cr_typecheck`: `outcome`, `open`, `recorded`, `builds_listed`, `previews_listed` and `via_preview`.
7. **Record.** The result goes to D1 `forge_check_runs` (with `steps` and `guard_status`) and the audit chain.

- **Shim imports.** `src/runner/assets.js` holds the wasm toolchain. Only `src/worker.ts` imports it, so the Node tests never load it. Wrangler imports the shims as Text (`[[rules]]`). The globs match the import specifiers as written there, so keep those import paths.
- **Local run.** `node tools/forge-runner/run.mjs` runs the same checks code in local workerd. There the type-check step reads `not_configured`.

## Organism census (ADR-0013)

`src/census.ts` reads main's DNA (`workers/<dir>/organism.json`). It also reads the external organs' DNA over RPC: the XAUUSD Workers through `EXT_ORGANISM_XAUUSD`, the xauusd AI Worker's `OrganismDna.dna()`, and Aether through `EXT_ORGANISM_AETHER`, `cryptophys-aether`'s `OrganismDna.dna()` (owner 2026-11-14; held to Aether's own ceiling, `organism.ts` `AETHER_CEILING`), and `cryptophys-cta` through `EXT_ORGANISM_CTA`, its `OrganismDna.dna()` (2026-11-16; schema `cta-organism.v1`, the general external ceiling). Each census compares that DNA with the live registries.

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

Since 2026-11-14 (every automatic deploy was stuck: the Control Plane's version 3cd2f94 was an ancestor of
main only through a merge's second parent, so it was not in `log(main)`):
- a desired version is resolved by ancestry: main's first-parent window (`PLAN_HISTORY`, one `log` call),
  then a breadth-first walk of every parent from main's head, at most `PLAN_ANCESTRY_READS` (500) commits;
- a migration is pending when main's `workers/control-plane-migrations/*.sql` has a file that D1's
  `d1_migrations` ledger does not list (an unreadable ledger counts as pending); the Control Plane then goes
  first and alone, planned even when its own paths did not change since its version;
- a desired version that is still not resolved (not found within the bound, or not an ancestor) is planned as a
  full redeploy of its unit from main's head, reason `full_redeploy_unresolved_base`, under the same ordering
  rules. `new_migration_control_plane_unavailable` remains only for a Control Plane that is unregistered,
  disabled or has no valid desired version.

## The cron tick

`src/tick.ts` runs three independent steps at :04/:19/:34/:49:
1. the deploy plan;
2. one change request head;
3. one commit of `main`, deferred when step 2 used more than two minutes.

A failing step never stops the others, and its error is audited as `forge.tick_failed`.
