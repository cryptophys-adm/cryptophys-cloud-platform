# TP-007: Auditor agent — Status

- **State:** `done`
- **Branch:** `antigravity/TP-007-auditor-agent`
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
✔ AuditorCycleQueue serializes concurrent cycles and recovers after rejection
✔ tampered audit chain produces a critical report with deterministic valid:false preserved even when AI claims chain is valid
✔ four or more denied syscalls in 24h produce a warning; a quiet hour produces no report except at 00:37 UTC
✔ auditor cannot call recovery.propose, signals.reingest or platform.observe
✔ runAuditCycle skips when auditor is suspended or the global kill switch is off
✔ readiness fails without AUDITOR binding; MCP wake_agent and HTTP wake with auditor return a cycle report
ℹ tests 83
ℹ suites 0
ℹ pass 83
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

### 4. `python3 ../control-plane-migrations/test_migrations.py`
```text
PASS: initial schema, forward migration, data preservation, indexes, CHECK constraints, foreign keys, service-scoped idempotency, and fail-closed rollback
```

### 5. `wrangler deploy --dry-run`
```text
ai-kernel:               Total Upload: ~65 KiB (--dry-run: exiting now.)
```

## Changes

- `workers/control-plane-migrations/0013_auditor_agent.sql`: seeds `auditor` (`Platform Auditor`) at `tier_max = 1` with `["audit.verify","reports.publish"]` (sequenced as `0013` after `0012_agent_reports.sql`).
- `workers/control-plane-shared/src/capabilities.ts`: adds `audit.verify` (tier 0, reversible).
- `workers/control-plane-shared/src/readiness.ts`: updates `REQUIRED_MIGRATION = "0013_auditor_agent.sql"` and verifies `0011`, `0012`, and `0013`.
- `workers/ai-kernel/src/syscall.ts`: implements `verifyAudit(env, now)` (running `verifyAuditChain(env.DB)` plus 24-hour counts of denied/failed `agent_actions` per agent, `policy_decisions` denies per action, `agent.suspended`/`agent.resumed`/`kernel.agents_enabled` audit events, and `agent:%` recovery plans) and wires `"audit.verify"` in `TIER0_HANDLERS`.
- `workers/ai-kernel/src/auditor.ts`: implements `AuditorCycleQueue`, `runAuditCycle`, `draftAuditDigestTask` (`draft_audit_digest`), and `templateAuditDigest`. Enforces deterministic triggers (`critical` on invalid chain, `warning` on >3 denied syscalls in 24h or any `kernel.agents_enabled` change, `info` once daily at `00:37 UTC`), rejects AI output that contradicts deterministic chain validity, and includes verbatim `chain` and `counts_24h` in `body_json`.
- `workers/ai-kernel/src/worker.ts`, `wrangler.toml`, `kernel.ts`, `index.ts`, `mcp.ts`: wires `AuditorAgent` Durable Object (`AUDITOR`, migration `v3`, serialized via `AuditorCycleQueue`), minute-`37` hourly cron schedule, `/v1/agents/auditor/wake`, MCP `wake_agent`, and fail-closed `/ready` `auditor_binding: Boolean(env.AUDITOR)`.
- `workers/control-plane-shared/test/auditor.test.ts`: 6 tests covering all 5 acceptance criteria plus per-agent cycle serialization.
- **Revert:** revert the merge commit of `antigravity/TP-007-auditor-agent` (before applying migration `0013` in production).

## Open questions

- None.
