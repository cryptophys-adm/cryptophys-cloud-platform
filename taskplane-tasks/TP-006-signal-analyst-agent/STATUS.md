# TP-006: Signal Analyst agent and agent reports — Status

- **State:** `done`
- **Branch:** `antigravity/TP-006-signal-analyst-agent`
- **Updated:** 2026-11-04

## Evidence

### 1. `npm ci`
```text
added 43 packages, and audited 44 packages in 11s
found 0 vulnerabilities
```

### 2. `npm run typecheck`
```text
> @cryptophys/control-plane@1.0.0 typecheck
> tsc --noEmit -p ../control-plane-tsconfig.json
```

### 3. `npm test`
```text
✔ migration 0011 seeds signal-analyst at tier 1 and agent_reports rejects an unknown kind (12.878004ms)
✔ signals.observe returns the latest confluence per symbol and macro context; unknown tier-0 capabilities are denied (19.655211ms)
✔ runSignalCycle publishes on action change or after 6 hours, records policy allow, agent_actions and audit chain, and skips when unchanged within 6 hours (78.404606ms)
✔ draft_signal_digest rejects AI output that alters actions or symbols, falls back to templateDigest, and always includes the advisory disclaimer (28.316873ms)
✔ signal-analyst is denied recovery.propose and signals.reingest by capability grant and tier limit (32.288948ms)
✔ publishReport rejects missing, mismatched, stale or already-used policy decision ids (24.088894ms)
✔ runSignalCycle skips when signal-analyst is suspended or the global kill switch is off (13.310665ms)
✔ HTTP GET /v1/reports, POST /v1/agents/signal-analyst/wake, MCP list_reports and wake_agent, scheduled minute-7 trigger, and readiness SIGNAL_ANALYST check (171.797731ms)
ℹ tests 71
ℹ suites 0
ℹ pass 71
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10154.721589
```

### 4. `python3 ../control-plane-migrations/test_migrations.py`
```text
PASS: initial schema, forward migration, data preservation, indexes, CHECK constraints, foreign keys, service-scoped idempotency, and fail-closed rollback
```

### 5. `wrangler deploy --dry-run`
```text
ai-kernel:               Total Upload: 58.79 KiB / gzip: 16.24 KiB (--dry-run: exiting now.)
policy-engine:           Total Upload: 31.29 KiB / gzip: 9.78 KiB  (--dry-run: exiting now.)
platform-registry:       Total Upload: 27.02 KiB / gzip: 8.24 KiB  (--dry-run: exiting now.)
audit-ledger:            Total Upload: 25.74 KiB / gzip: 7.99 KiB  (--dry-run: exiting now.)
recovery-manager:        Total Upload: 40.13 KiB / gzip: 11.21 KiB (--dry-run: exiting now.)
drift-detector:          Total Upload: 27.37 KiB / gzip: 8.41 KiB  (--dry-run: exiting now.)
signal-engine:           Total Upload: 75.38 KiB / gzip: 22.02 KiB (--dry-run: exiting now.)
deployment-orchestrator: Total Upload: 26.64 KiB / gzip: 8.18 KiB  (--dry-run: exiting now.)
platform-api:            Total Upload: 16.42 KiB / gzip: 5.53 KiB  (--dry-run: exiting now.)
```

## Changes

- `workers/control-plane-migrations/0012_agent_reports.sql`: creates `agent_reports` (`report_id`, `agent_id`, `kind`, `severity`, `subject`, `body_json`, `ai_status`, `decision_id`, `created_at` + index `agent_reports_agent_created`) and seeds `signal-analyst` at `tier_max = 1` with `["signals.observe","reports.publish"]` (sequenced as `0012` after `0011_agent_syscall_consumptions.sql` from PR #59).
- `workers/control-plane-shared/src/readiness.ts`: updates `REQUIRED_MIGRATION` to `"0012_agent_reports.sql"` and verifies both `"0011_agent_syscall_consumptions.sql"` and `"0012_agent_reports.sql"`.
- `workers/control-plane-shared/src/capabilities.ts`: adds `signals.observe` (tier 0) and `reports.publish` (tier 1, reversible, `max_per_hour: 4`).
- `workers/ai-kernel/src/reports.ts`: implements `publishReport` (with `verifySyscallDecision(db, decisionId, agentId, "reports.publish")`) and `listReports` with `agent_id`, `kind`, and `limit` filters.
- `workers/ai-kernel/src/syscall.ts`: routes tier-0 capabilities via `TIER0_HANDLERS` (`platform.observe` -> `observe`, `signals.observe` -> `observeSignals`), denies unknown/unwired tier-0 capabilities, and dispatches `reports.publish` to `publishReport`.
- `workers/ai-kernel/src/signal-analyst.ts`: implements `SignalAnalystCycleQueue`, `runSignalCycle`, `draftSignalDigestTask` (`draft_signal_digest`), and `templateDigest` with deterministic action-change / 6h triggers, `BUY↔SELL` flip `warning` severity, strict symbol/action validation, `disclaimer: "advisory only; not an order"`, and `source_basis_close_times`.
- `workers/ai-kernel/src/kernel.ts`, `mcp.ts`, `index.ts`, `worker.ts`, `wrangler.toml`: wires `SignalAnalystAgent` Durable Object (`SIGNAL_ANALYST`, migration `v2`, serialized via `SignalAnalystCycleQueue`), minute-`7` hourly cron scheduling, `GET /v1/reports`, `POST /v1/agents/signal-analyst/wake`, MCP `list_reports` and `wake_agent`, and strict fail-closed `/ready` `signal_analyst_binding: Boolean(env.SIGNAL_ANALYST)`.
- `workers/control-plane-shared/test/signal-analyst.test.ts` & `workers/control-plane-shared/test/ai-kernel.test.ts`: 9 tests in `signal-analyst.test.ts` covering all 8 acceptance criteria and cycle serialization, plus updated `kernelEnv` and migration readiness assertions in `ai-kernel.test.ts`.
- **Revert:** revert the merge commit of `antigravity/TP-006-signal-analyst-agent` (before applying migration `0012` in production).

## Open questions

- None. All orchestrator review findings on PR #61 (`signal_analyst_binding` fail-closed readiness, `SignalAnalystCycleQueue` per-agent cycle serialization, and `0012_agent_reports.sql` sequencing after PR #59's `0011_agent_syscall_consumptions.sql`) have been resolved and verified.
