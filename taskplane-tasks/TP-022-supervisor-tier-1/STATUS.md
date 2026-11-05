# TP-022 status

State: done

## Evidence

- `npm run typecheck`: completed, no errors.
- `npm test`: 143 tests, 143 pass, 0 fail, 0 skipped, 0 todo.
- `python3 ../control-plane-migrations/test_migrations.py`: PASS.
- dry-run ai-kernel: Total Upload 106.14 KiB / gzip 26.15 KiB.

## Changes

- Added migration `0021_supervisor_tier_1.sql`.
- Updated readiness.
- `workers/ai-kernel/src/kernel.ts`: exported `KERNEL_HOST`, guard before tier check.
- `workers/ai-kernel/src/agent-rpc.ts`: guard before host comparison; updated comment.
- `workers/ai-kernel/src/index.ts`: ignored kernel-hosted principals; static import.
- ADR-0007 amendment and OPERATIONS update.
- Rewrote/updated tests: external-agents.test.ts (platform-api fixture), ai-kernel.test.ts, retire-signal-engine-tp018.test.ts.
- Added `supervisor-tier1-tp022.test.ts`.

## Open questions

- None.
