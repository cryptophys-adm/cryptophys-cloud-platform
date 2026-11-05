# TP-018 status

State: blocked

## Evidence

- `npm run typecheck`: completed, no errors.
- `npm test`: 107 pass, 10 fail, 0 skipped, 0 todo, 0 cancelled.
- `python3 ../control-plane-migrations/test_migrations.py`: PASS.
- dry-run ai-kernel: Total Upload 99.78 KiB / gzip 24.57 KiB.
- dry-run drift-detector: Total Upload 33.85 KiB / gzip 9.73 KiB.
- Neither dry-run lists `cryptophys-signal-engine`.

## Changes

- Removed `workers/signal-engine/`.
- Added migration `0020_retire_signal_engine.sql`.
- Updated capabilities, ai-kernel syscall/supervisor/index/wrangler, drift-detector.
- Removed `SIGNALS` binding and unused constants.
- Updated `test/ai-kernel.test.ts` (supervisor grants and SIGNALS binding).

## Open questions

- 10 existing tests still fail because they reference removed `signals.reingest` capability or Signal Engine ingest behavior. They need rewriting for the new behavior. I did not delete or skip them.
