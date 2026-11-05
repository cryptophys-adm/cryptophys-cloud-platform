# TP-014 status

State: done

## Evidence

- `npm ci`: completed.
- `npm run typecheck`: completed, no errors.
- `npm test`: 117 tests, 117 pass, 0 fail, 0 skipped.
- `python3 ../control-plane-migrations/test_migrations.py`: PASS.
- dry-run policy-engine: Total Upload 36.12 KiB / gzip 10.90 KiB.
- dry-run audit-ledger: Total Upload 30.22 KiB / gzip 8.99 KiB.

## Changes

- `workers/policy-engine/src/index.ts`: deny report suppressed when `context.deploy_verification === true`.
- `workers/audit-ledger/src/index.ts`: `Env` includes `AGENTS?`; `GET /v1/verify` publishes `critical` `audit_digest` report on broken chain with 1-hour de-dup.
- Added `workers/control-plane-shared/test/agent-reports-tp014.test.ts`.

## Open questions

- None.
