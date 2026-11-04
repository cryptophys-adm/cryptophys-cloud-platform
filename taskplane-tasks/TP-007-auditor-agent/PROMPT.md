# TP-007: Auditor agent

**Worker:** Antigravity. **Depends on:** TP-006 merged. **Read first:** `taskplane-tasks/ANTIGRAVITY.md`.

## Goal

This task adds the `auditor` agent (tier_max **1**) in `cryptophys-ai-kernel`. Once an hour it verifies the audit hash chain and reviews the last 24 hours of governance events. It publishes an `audit_digest` report when something needs a human, plus once a day.

## Files

- `workers/control-plane-migrations/0012_auditor_agent.sql` (new; seed only)
- `workers/control-plane-shared/src/capabilities.ts`
- `workers/control-plane-shared/src/readiness.ts`
- `workers/ai-kernel/src/syscall.ts`, `index.ts`, `worker.ts`, `kernel.ts`, `mcp.ts`
- `workers/ai-kernel/src/auditor.ts` (new)
- `workers/ai-kernel/wrangler.toml`
- `workers/control-plane-shared/test/auditor.test.ts` (new)
- `taskplane-tasks/TP-007-auditor-agent/STATUS.md` (new)

## Specification

1. **Seed.** `('auditor', 'Platform Auditor', 'cryptophys-ai-kernel', <purpose>, 1, '["audit.verify","reports.publish"]', 'enabled', ...)`.
2. **Capability** `audit.verify`: tier 0. The handler runs `verifyAuditChain(env.DB)` from `control-plane-shared/src/audit.ts`. It also counts, over the last 24 h:
   - `agent_actions` with outcome `denied` or `failed`, per agent;
   - `policy_decisions` that were `deny`, per action;
   - `audit_events` of type `agent.suspended`, `agent.resumed` and `kernel.agents_enabled`;
   - `recovery_plans` created by `agent:%`.
3. **Agent** `runAuditCycle` (`auditor.ts`), deterministic triggers:
   - chain invalid → `critical`;
   - more than 3 denied agent syscalls in 24 h, or any `kernel.agents_enabled` change → `warning`;
   - otherwise only once a day, on the 00:37 UTC cycle → `info`.
   - AI task `draft_audit_digest`: `{headline ≤160, summary ≤800, items: up to 8 strings ≤200}`. The validator rejects output that claims the chain is valid when the deterministic result is invalid, or the reverse. Use a template when AI is not `ok`.
   - The report `body_json` carries the deterministic numbers and verification result verbatim. AI text is only added next to them.
4. **Durable Object** `AuditorAgent`, binding `AUDITOR`, wrangler migration `tag = "v3"`, `new_sqlite_classes = ["AuditorAgent"]`.
5. **Schedule.** In `scheduled()`, run the auditor on the minute-`37` cycle (hourly). `wake_agent` and `/v1/agents/auditor/wake` support `auditor`. `/ready` adds `auditor_binding`.
6. **The auditor never fixes anything.** It does not suspend agents, change data or propose recovery; it only reports.

## Budget

24 cycles a day. Chain verification reads every audit event, which is acceptable below about 50k events; record the event count in the report. AI is used only when publishing, so about 1–3 times a day.

## Acceptance criteria (each needs a test)

1. A tampered chain (modify a row directly in the test DB, as `control-plane.test.ts` does) produces a `critical` report whose deterministic `valid: false` is preserved, even when the AI says otherwise (that output is rejected).
2. Four or more denied syscalls in 24 h produce a `warning`. A quiet hour produces no report, except at the 00:37 cycle.
3. The auditor cannot call `recovery.propose`, `signals.reingest` or `platform.observe` (not granted).
4. The cycle is skipped when the agent is suspended or the kill switch is off.
5. Readiness fails without `AUDITOR`. The MCP `wake_agent` with `auditor` returns a cycle report.
