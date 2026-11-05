# TP-013 status

State: done

## Evidence

- `npm ci`: completed.
- `npm run typecheck`: completed, no errors.
- `npm test`: 110 tests, 110 pass, 0 fail, 0 skipped.
- `python3 ../control-plane-migrations/test_migrations.py`: PASS.
- dry-run policy-engine: Total Upload 36.08 KiB / gzip 10.88 KiB.
- dry-run platform-registry: Total Upload 31.03 KiB / gzip 9.10 KiB.

## Changes

- `workers/policy-engine/src/index.ts`: `Env` now includes `AGENTS?`; `decide()` publishes a `warning` report on deny (excluding `agent.syscall`).
- `workers/platform-registry/src/index.ts`: `Env` now includes `AGENTS?`; upsert publishes `info` on new service and `warning` on disable.
- Added `workers/control-plane-shared/test/agent-reports-tp013.test.ts`.

## Open questions

- None.
