# TP-018 status

State: blocked — validation workflow sequencing and repository governance.

Current branch head: `710546c4dd09ce6222ac7866b8f5a4d215ecbbd7`.

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

1. Owner/orchestrator must land a separate validation-only workflow change removing the retired Signal Engine from the Control Plane dry-run bundle matrix. TP-018 explicitly forbids editing `.github/*`; this PR does not bypass that constraint.
2. Keep production deployment order, Access provisioning, and drift inventory unchanged until the post-merge orchestration change is ready. No production deployment is authorized by this task.
3. Repository `main` is currently unprotected and the repository has no visible rulesets. Independent approval and required-check enforcement are not established; do not merge on the basis of CI alone.
4. Independent security review and external check suites remain outstanding.

## Data and safety

- Migration 0020 updates registry/agent state and removes the supervisor grant; it does not drop crypto tables or delete historical crypto rows.
- No secrets, permissions, rulesets, branch protection, production configuration, or production resources were changed.
- No production workflow was dispatched.
