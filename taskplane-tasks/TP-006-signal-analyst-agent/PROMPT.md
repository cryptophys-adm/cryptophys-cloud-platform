# TP-006: Signal Analyst agent and agent reports

**Worker:** Antigravity. **Depends on:** main at or after ADR-0007. **Read first:** `taskplane-tasks/ANTIGRAVITY.md`.

## Goal

This task adds a second agent process, `signal-analyst` (tier_max **1**), hosted by `cryptophys-ai-kernel`. Once an hour it reads the Signal Engine's latest confluence, decision and Mizan per symbol, plus the macro context, and publishes an **advisory digest** when something changed. It also adds the generic `agent_reports` store that TP-007 reuses.

## Files

- `workers/control-plane-migrations/0012_agent_reports.sql` (new; sequenced after `0011_agent_syscall_consumptions.sql`)
- `workers/control-plane-shared/src/capabilities.ts`
- `workers/control-plane-shared/src/readiness.ts` (`REQUIRED_MIGRATION`)
- `workers/ai-kernel/src/syscall.ts`, `kernel.ts`, `mcp.ts`, `index.ts`, `worker.ts`
- `workers/ai-kernel/src/signal-analyst.ts` (new)
- `workers/ai-kernel/src/reports.ts` (new)
- `workers/ai-kernel/wrangler.toml`
- `workers/control-plane-shared/test/signal-analyst.test.ts` (new)
- `workers/control-plane-shared/test/ai-kernel.test.ts`, `workers/control-plane-shared/test/control-plane.test.ts`: only if a readiness or count assertion must change.
- `taskplane-tasks/TP-006-signal-analyst-agent/STATUS.md` (new)

## Specification

1. **Migration 0012.**
   - `agent_reports`:
     - `report_id TEXT PK`;
     - `agent_id TEXT NOT NULL REFERENCES agents`;
     - `kind TEXT CHECK (kind IN ('signal_digest','audit_digest'))`;
     - `severity TEXT CHECK (severity IN ('info','warning','critical'))`;
     - `subject TEXT NOT NULL`;
     - `body_json TEXT CHECK (json_valid(body_json))`;
     - `ai_status TEXT NOT NULL`;
     - `decision_id TEXT`;
     - `created_at TEXT NOT NULL`;
     - index `(agent_id, created_at)`.
   - Seed the agent with `INSERT OR IGNORE`: `('signal-analyst', 'Signal Analyst', 'cryptophys-ai-kernel', <purpose>, 1, '["signals.observe","reports.publish"]', 'enabled', ...)`.
2. **Capabilities** (`capabilities.ts`):
   - `signals.observe`: tier 0.
   - `reports.publish`: tier 1, reversible, `max_per_hour: 4`.
3. **Syscall router** (`syscall.ts`).
   - Tier 0 currently always returns `observe()`. Replace this with a map from capability to handler: `platform.observe` → `observe`, `signals.observe` → `observeSignals`. An unknown tier-0 capability is denied.
   - Add `reports.publish` to `dispatch()`. The kernel owns `agent_reports`, so the handler calls `verifySyscallDecision(db, decisionId, agentId, "reports.publish")` and then inserts the row through `reports.ts`.
   - `observeSignals(env)`:
     - For each symbol, the latest `signal_confluence` row: symbol, `basis_close_time`, `confluence_score`, the parsed `decision_json.action`/`confidence`, and the `mizan_json` phi/tier/direction.
     - The latest `macro_context` row.
     - Read-only.
4. **Agent** (`signal-analyst.ts`), following the shape of `supervisor.ts`:
   - `runSignalCycle(env, memory, trigger, now)`. Skip when the agent is suspended or `agents_enabled` is off, like the supervisor.
   - **Deterministic trigger.** Publish when any symbol's `action` differs from the one stored in memory, or when 6 hours have passed since the last digest. Otherwise record `findings: [{kind:"signals", action:"none"}]`.
   - **AI task `draft_signal_digest`.**
     - Output: `{headline ≤160, summary ≤800, symbols: [{symbol, action, note ≤200}]}`.
     - `validate()` must reject output whose set of symbols, or whose action for any symbol, differs from the deterministic input.
     - On anything other than `ok`, use `templateDigest()`.
   - **Severity.** `warning` if any action flipped BUY↔SELL, otherwise `info`.
   - `body_json` always includes `disclaimer: "advisory only; not an order"` (added in code, not by AI) and `source_basis_close_times`.
   - Then call `syscall(env, "signal-analyst", "reports.publish", {...})`.
5. **Durable Object** `SignalAnalystAgent` in `worker.ts` (same shape as `SupervisorAgent`).
   - Binding `SIGNAL_ANALYST`.
   - In `wrangler.toml`, add `[[migrations]] tag = "v2"`, `new_sqlite_classes = ["SignalAnalystAgent"]`. **Keep tag v1 unchanged.**
6. **Scheduling.** Keep the kernel cron `7,22,37,52 * * * *`. In `scheduled()`, also run the analyst when the event's minute is `7`, which makes it hourly.
7. **HTTP and MCP.**
   - `GET /v1/reports?agent_id=&kind=&limit=` (operator).
   - `POST /v1/agents/signal-analyst/wake` (operator) runs one cycle.
   - MCP tool `list_reports` (same filters).
   - `wake_agent` accepts `signal-analyst`.
   - `/ready` adds `signal_analyst_binding`.

## Budget

- 24 cycles a day, and at most 4 publishes an hour (enforced by policy).
- AI only when publishing, at most about 6 a day in practice. It shares the kernel's `AI_DAILY_REQUEST_LIMIT = 40`; do not raise it.
- Durable Object usage is negligible.

## Acceptance criteria (each needs a test)

1. Migration seeds `signal-analyst` at tier 1, and `agent_reports` rejects an unknown `kind`.
2. `signals.observe` returns the latest confluence per symbol and the macro context. An unknown tier-0 capability is denied.
3. When an action changes, a report is published, with policy `allow`, an `agent_actions` row and an audit `agent.action`. No change and less than 6 h since the last digest means no publish.
4. AI output that changes an action, or adds or drops a symbol, is rejected (`invalid_output`), and the template is used. The disclaimer is always present.
5. `signal-analyst` cannot call `recovery.propose` or `signals.reingest` (denied: not granted / tier).
6. `reports.publish` handler without a valid decision id → `policy_decision_*` error.
7. Suspended agent or kill switch off → cycle skipped.
8. `GET /v1/reports` needs an operator. MCP `list_reports` works. Readiness fails without `SIGNAL_ANALYST`.
