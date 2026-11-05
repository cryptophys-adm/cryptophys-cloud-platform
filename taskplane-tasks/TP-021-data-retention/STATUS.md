# TP-021 status

State: done

## Evidence

- `npm run typecheck`: completed, no errors.
- `npm test`: 136 tests, 136 pass, 0 fail, 0 skipped, 0 todo.
- `python3 ../control-plane-migrations/test_migrations.py`: PASS.
- dry-run drift-detector: Total Upload 37.10 KiB / gzip 10.62 KiB.
- dry-run ai-kernel: Total Upload 105.33 KiB / gzip 25.97 KiB.

## Changes

- `workers/drift-detector/src/index.ts`: added `pruneDriftObservations`; scheduled daily at 03:00 UTC.
- `workers/ai-kernel/src/retention.ts`: added `pruneSyscallConsumptions`.
- `workers/ai-kernel/src/index.ts`: scheduled prune at 03:07 UTC.
- `docs/OPERATIONS.md`: added Data retention paragraph.
- Added `workers/control-plane-shared/test/retention-tp021.test.ts`.

## Open questions

- None.
