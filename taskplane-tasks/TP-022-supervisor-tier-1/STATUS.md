# TP-022 status

State: blocked

## Evidence

- `npm run typecheck`: completed, no errors.
- `npm test`: 137 pass, 6 fail, 0 skipped, 0 todo.
- `python3 ../control-plane-migrations/test_migrations.py`: PASS.
- dry-run ai-kernel: Total Upload 107.72 KiB / gzip 26.53 KiB.

## Changes

- Added migration `0021_supervisor_tier_1.sql`.
- Updated readiness.
- `workers/ai-kernel/src/kernel.ts`: exported `KERNEL_HOST`, guard before tier check.
- `workers/ai-kernel/src/agent-rpc.ts`: guard before host comparison.
- `workers/ai-kernel/src/index.ts`: ignored kernel-hosted principals.
- ADR-0007 amendment and OPERATIONS update.
- Updated tests: ai-kernel.test.ts, external-agents.test.ts.
- Added `supervisor-tier1-tp022.test.ts`.

## Open questions

- 6 existing external-agents/MCP tests still fail because they register principals for kernel-hosted agents (supervisor/signal-analyst/auditor), which are now refused with `kernel_agent_internal`. They need rewriting to use non-kernel agents.
