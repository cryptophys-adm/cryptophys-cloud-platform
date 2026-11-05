# TP-018 status

State: blocked — waiting for prerequisite PR #109, independent review, and repository governance.

Current branch head: `be7b557f5a104c656d5cbac71e7ba75e69dfb6d9` (the next docs-only status commit will trigger another validation run).

## Latest GitHub Actions evidence

- `Validate` (#42038278649): SUCCESS; Platform API type-check, Deployment Orchestrator type-check, and deployment verification tests all passed.
- `Validate Control Plane Workers` (#42038278839):
  - Type-check: PASS.
  - Endpoint/library tests against the real D1 migrations: **117/117 PASS, 0 failed, 0 skipped**.
  - Isolated SQLite migration tests: PASS.
  - Worker bundle dry-run: FAIL because the existing `.github/workflows/validate-control-plane.yml` still loops over `signal-engine` and attempts to read the deleted `workers/signal-engine/wrangler.toml` (ENOENT).
- Exact test log tail from run #42038439162:
  ```text
  # tests 117
  # pass 117
  # fail 0
  # skipped 0
  ```
- Exact bundle failure tail from the same run:
  ```text
  Could not read file: ../signal-engine/wrangler.toml
  ENOENT: no such file or directory, open '.../workers/signal-engine/wrangler.toml'
  ```
- The workflow failure is not a TypeScript, test, migration, or Wrangler bundle-size failure. It is a stale validation matrix entry.
- External check suites (Claude, Cloudflare Workers & Pages, Cursor) remain queued; they are not approvals.

## Changes made on this branch

- Added `0017_report_kinds_xauusd_and_hud.sql` to `REQUIRED_MIGRATIONS`; added a regression test that readiness fails if its migration record is missing.
- Rewrote supervisor/syscall/memory/drift tests for the retired `signals.reingest` capability and suspended Signal Engine.
- Added a real drift test proving the disabled Signal Engine is recorded as disabled and its binding is not probed.
- Made the repository-root binding test portable using `import.meta.url`; removed the hard-coded runner path.
- Applied the owner's requested syscall-test corrections: the removed capability assertion checks for `capability_known`, and both rate-limit seed and consumption-count queries use `recovery.propose`. The now-unused `REINGEST_COOLDOWN_MS` and `INGEST_STALE_MS` constants are already absent from `supervisor.ts`.
- Added dated amendments to ADR-0005, ADR-0006, and ADR-0007. Historical crypto data and the XAUUSD Mizan/Prophet/GMI ownership boundary are preserved.
- Updated `docs/CONTROL-PLANE-WORKERS.md` and `docs/OPERATIONS.md` to distinguish 30 enabled tier-1 agents, one suspended tier-1 Signal Engine agent, and the tier-2 supervisor.
- Updated this task packet with the CI sequencing prerequisite.

## External blockers

1. Orchestrator prerequisite PR #109 is OPEN at head `f4258648e5d182c28086eb762779aa1512c96e3a`. Its Validate workflow is 3/3 SUCCESS; Control Plane validation is SUCCESS with 137/137 tests, migration tests, and all 7 remaining Worker dry-run bundles passing. Merge #109 first, then refresh #108 against the new main and rerun all checks.
2. PR #109 removes Signal Engine from the validation matrix and future `DEPLOY_ORDER`/`EXPECTED_WORKERS`, but deliberately leaves `provision-access.yml` and `drift-summary.sh` unchanged until owner-confirmed Worker deletion. No production deployment is authorized by either PR.
3. Repository `main` is currently unprotected and the repository has no visible rulesets. Required-check enforcement and independent approval are not established; do not merge on the basis of CI alone.
4. Independent security review and external check suites remain outstanding.

## Data and safety

- Migration 0020 updates registry/agent state and removes the supervisor grant; it does not drop crypto tables or delete historical crypto rows.
- No secrets, permissions, rulesets, branch protection, production configuration, or production resources were changed.
- No production workflow was dispatched.
