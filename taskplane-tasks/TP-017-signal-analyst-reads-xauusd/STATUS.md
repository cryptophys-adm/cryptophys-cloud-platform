# TP-017 status

State: done

## Evidence

- `npm run typecheck`: completed, no errors.
- `npm test`: 136 tests, 136 pass, 0 fail, 0 skipped.
- `python3 ../control-plane-migrations/test_migrations.py`: PASS.
- dry-run ai-kernel: Total Upload 101.01 KiB / gzip 24.88 KiB; binding `env.XAUUSD_AI (xauusd-ai-trading-assistant)` present.

## Changes

- `workers/ai-kernel/wrangler.toml`: added `XAUUSD_AI` plain Service Binding.
- `workers/ai-kernel/src/syscall.ts`: `observeSignals` retargeted to XAUUSD with injectable timeout (default 5000 ms).
- `workers/ai-kernel/src/signal-analyst.ts`: rewrote `runSignalCycle` deterministically; removed crypto draft/template and legacy memory keys; added empty-data report.
- `workers/ai-kernel/src/index.ts`: Signal Analyst scheduled at minute 22.
- `workers/control-plane-shared/test/signal-analyst.test.ts`: 11 acceptance tests.
- `workers/control-plane-shared/test/ai-diagnostics-tp016.test.ts`: added assertion using `draftAuditDigestTask` with `diagnose`.
- `workers/control-plane-shared/test/agent-memory.test.ts`: removed two obsolete signal-analyst memory tests.

## Open questions

- None.
