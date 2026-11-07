# TP-027 status

- **State:** done (PR open; the orchestrator merges after validation).

## Evidence (from `workers/control-plane-shared`)

| Check | Result |
|---|---|
| `npm test` | 281 pass, 0 fail (was 279) |
| `npm run typecheck` | clean |
| `python3 ../control-plane-migrations/test_migrations.py` | `PASS: initial schema, forward migration, data preservation, indexes, CHECK constraints, foreign keys, service-scoped idempotency, and fail-closed rollback` |
| `npx wrangler deploy --dry-run --config ../ai-kernel/wrangler.toml` | `Total Upload: 149.86 KiB / gzip: 35.86 KiB` |

New tests:

- `TP-027 Aether: four tier-1 agents hosted by cryptophys-aether, reachable only through AgentRpc with that host, publishing knowledge_audit reports` (`ai-kernel.test.ts`). It covers:
  - the agents, their tiers and capabilities;
  - the disabled service row;
  - no cross-host impersonation in either direction;
  - a `knowledge_audit` report is published;
  - an ungranted capability is denied.
- `TP-027: the disabled cryptophys-aether row is recorded without probing and never drifts before its first deploy` (`register-tp026.test.ts`).

## Changes

| File | Change |
|---|---|
| `0027_register_aether.sql` | Rebuilds `agent_reports` with the `knowledge_audit` kind (the same pattern as 0017; nothing references `agent_reports`). Adds the service row first, because `agents.host_worker` references `service_registry`. Then adds the four agents. |
| `readiness.ts` | `REQUIRED_MIGRATION = 0027_register_aether.sql`. 0026 joins the required list. |
| `reports.ts` | `REPORT_KINDS` gains `knowledge_audit`. |
| Tests | The migration pins move to 0027. The agent count moves from 32 to 36 (4 Aether) and the service count from 15 to 16 (Aether). |

**Revert:** add a forward migration that suspends the four agents (`status = 'suspended'`, with a reason). Merged migrations are never edited.

## Open questions

- After Aether's first deploy, the follow-up adds the Drift Detector `EXT_AETHER` binding and sets the row to `registered`.
- Aether's own `AGENTS` binding is added in the Aether repository once this migration is live.
