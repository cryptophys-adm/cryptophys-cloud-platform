# TP-016 status

State: done

## Evidence

- `npm ci`: completed.
- `npm run typecheck`: completed, no errors.
- `npm test`: 135 tests, 135 pass, 0 fail, 0 skipped.
- `python3 ../control-plane-migrations/test_migrations.py`: PASS.
- dry-run ai-kernel: Total Upload 101.57 KiB / gzip 24.91 KiB.
- dry-run platform-api: Total Upload 20.23 KiB / gzip 6.32 KiB.
- dry-run policy-engine: Total Upload 37.52 KiB / gzip 11.25 KiB.

## Changes

- Added migration `0019_ai_failures.sql`.
- Updated `REQUIRED_MIGRATION` to `0019_ai_failures.sql` and list.
- `workers/control-plane-shared/src/ai-engine.ts`: object response handling, categorized failures, recordFailureCategory upsert.
- Added `diagnose` to `draftSignalDigestTask` and `draftAuditDigestTask`.
- Updated `REQUIRED_MIGRATION` assertion in `ai-kernel.test.ts`.
- Added `workers/control-plane-shared/test/ai-diagnostics-tp016.test.ts`.

## Open questions

- None.
