# TP-012 status

State: done

## Evidence

- `npm ci`: completed, 0 vulnerabilities.
- `npm run typecheck`: completed, no errors.
- `npm test`: 108 tests, 108 pass, 0 fail, 0 skipped.
- `python3 ../control-plane-migrations/test_migrations.py`: PASS.
- dry-run recovery-manager: Total Upload 50.46 KiB / gzip 13.89 KiB.
- dry-run deployment-orchestrator: Total Upload 30.68 KiB / gzip 9.02 KiB.

## Changes

- Added `workers/control-plane-migrations/0018_grant_reports_publish.sql` granting `reports.publish` to `recovery-manager` and `deployment-orchestrator`.
- Updated `REQUIRED_MIGRATION` to `0018_grant_reports_publish.sql` in `workers/control-plane-shared/src/readiness.ts`.
- Added `AGENTS?: AgentRpcBinding` to `LifecycleEnv` and publish calls in `closeWindow` (`workers/recovery-manager/src/lifecycle.ts`).
- Added `AGENTS?: AgentRpcBinding` to `Env` and publish calls next to both `deployment.rejected` audit calls (`workers/deployment-orchestrator/src/index.ts`).
- Added `workers/control-plane-shared/test/agent-reports-tp012.test.ts`.
- Updated migration name assertion in `workers/control-plane-shared/test/ai-kernel.test.ts`.

## Open questions

- None.
