# TP-019 status

State: done

## Evidence

- `npm run typecheck`: completed, no errors.
- `npm test`: 126 tests, 126 pass, 0 fail, 0 skipped, 0 todo.
- `python3 ../control-plane-migrations/test_migrations.py`: PASS.
- dry-run ai-kernel: Total Upload 102.69 KiB / gzip 25.37 KiB.
- dry-run platform-api: Total Upload 22.02 KiB / gzip 6.85 KiB.
- dry-run policy-engine: Total Upload 39.08 KiB / gzip 11.74 KiB.

## Changes

- `workers/control-plane-shared/src/ai-engine.ts`: added `ADVISORY_LANGUAGE` and `violatesAdvisoryLanguage`; guard in `run()`.
- `workers/ai-kernel/src/syscall.ts`: added `xauusd_latest` to `observe()`.
- `workers/platform-api/src/index.ts`: updated `overviewTask.instructions`.
- Added `workers/control-plane-shared/test/advisory-guard-tp019.test.ts`.

## Open questions

- None.
