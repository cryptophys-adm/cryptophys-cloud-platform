# TP-015 status

State: done

## Evidence

- `npm ci`: completed.
- `npm run typecheck`: completed, no errors.
- `npm test`: 124 tests, 124 pass, 0 fail, 0 skipped.
- `python3 ../control-plane-migrations/test_migrations.py`: PASS.
- dry-run ai-kernel: Total Upload 98.22 KiB / gzip 24.36 KiB.
- dry-run platform-api: Total Upload 18.83 KiB / gzip 6.00 KiB.

## Changes

- `workers/ai-kernel/src/syscall.ts`: `observe()` now returns `agent_reports_24h` with counts, latest attention, bounded subjects, fail-safe.
- Added `workers/control-plane-shared/test/reports-overview-tp015.test.ts`.

## Open questions

- None.
