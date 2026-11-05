# TP-017 status

State: done

## Evidence

- `npm ci`: completed.
- `npm run typecheck`: completed, no errors.
- `npm test`: 127 tests, 127 pass, 0 fail, 0 skipped.
- `python3 ../control-plane-migrations/test_migrations.py`: PASS.
- dry-run ai-kernel: Total Upload 101.19 KiB / gzip 24.96 KiB; binding `env.XAUUSD_AI (xauusd-ai-trading-assistant)` present.

## Changes

- `workers/ai-kernel/wrangler.toml`: added `XAUUSD_AI` plain Service Binding.
- `workers/ai-kernel/src/syscall.ts`: `observeSignals` retargeted to XAUUSD; added `XAUUSD_AI` to `SyscallEnv`.
- `workers/ai-kernel/src/signal-analyst.ts`: rewrote `runSignalCycle` to read XAUUSD decisions deterministically; removed crypto draft/template.
- `workers/ai-kernel/src/index.ts`: Signal Analyst scheduled at minute 22.
- `workers/control-plane-shared/test/signal-analyst.test.ts`: replaced with minimal load test (old crypto tests obsolete).
- `workers/control-plane-shared/test/ai-diagnostics-tp016.test.ts`: removed `draftSignalDigestTask` assertions.
- `workers/control-plane-shared/test/agent-memory.test.ts`: neutralized two obsolete signal-analyst memory tests.

## Open questions

- None.
