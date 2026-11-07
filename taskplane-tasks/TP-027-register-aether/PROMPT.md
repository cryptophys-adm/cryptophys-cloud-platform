# TP-027: Register Aether, the Knowledge Guardian cluster

Owner approval: 2026-11-07 (RFC_AETHER_KNOWLEDGE_GUARDIAN, decisions A1 to A6, in `cryptophys-adm/xauusd-ai-trading-assistant` `docs/`). Phase A3 of that RFC.

## Goal

Aether is a separate cluster in the AI Mesh. It is hosted by the external Worker `cryptophys-aether` (repository `cryptophys-adm/cryptophys-aether`, deployed by Cloudflare Workers Builds). This task registers its host and agents so they can reach the kernel through `AgentRpc`, and adds a report kind for its advisory reports.

## Files

- `workers/control-plane-migrations/0027_register_aether.sql` (new)
- `workers/control-plane-shared/src/readiness.ts` (`REQUIRED_MIGRATION`)
- `workers/ai-kernel/src/reports.ts` (`REPORT_KINDS`)
- `workers/control-plane-shared/test/*` (migration pins, row counts, new TP-027 tests)
- `architecture/RESOURCE-OWNERSHIP.md`, `docs/AETHER-INTEGRATION.md` (new), this task directory

## Requirements

1. **Report kind:** add `knowledge_audit` to `agent_reports.kind` and to `REPORT_KINDS`.
2. **Agents:** register four agents with `host_worker = 'cryptophys-aether'`, `tier_max = 1` and only tier ≤ 1 capabilities:
   - `aether-auditor` and `aether-guardian`: `signals.observe`, `reports.publish`;
   - `aether-curator` and `aether-calibrator`: `reports.publish`.
3. **Service row:** register `cryptophys-aether` in `service_registry` (it hosts the agents) with status `disabled`. This means no probe and no drift until the Worker is deployed.
4. **Follow-up after the first deploy (not this task):**
   - add the Drift Detector `EXT_AETHER` service binding;
   - set the row to `registered`.
5. **No secret, no deploy, no workflow change.** Advisory only: Aether's reports never carry price levels.
