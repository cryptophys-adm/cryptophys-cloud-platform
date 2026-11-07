# TP-028 status

- **State:** done (PR open; the orchestrator merges after validation).

## Evidence (from `workers/control-plane-shared`, `workers/console/ui`)

| Check | Result |
|---|---|
| `npm test` | 288 pass, 0 fail (was 282) |
| `npm run typecheck` | clean |
| Console UI `npm run build` and `npm run typecheck` | clean |
| Console UI `npm run render-smoke` | `Render smoke passed: 14 screens x 2 widths under /console/.` (the Knowledge page is new) |
| `python3 ../control-plane-migrations/test_migrations.py` | `PASS: initial schema, forward migration, data preservation, indexes, CHECK constraints, foreign keys, service-scoped idempotency, and fail-closed rollback` |
| `wrangler deploy --dry-run` (ai-kernel, console) | bundles |

New tests (`knowledge-tp028.test.ts`):

- 0029 grants the two capabilities to the curator and the calibrator only.
- The validator:
  - accepts measured claims and role reminders in plain words, with every number taken from the evidence and 10 or more cited cards;
  - refuses a price, order wording, a field name or field definition, an unmeasured number, too few cards, a forbidden key, and a malformed parameter candidate.
- Proposals through `AgentRpc`:
  - the curator proposes;
  - the auditor (not granted) and the xauusd host are denied;
  - a duplicate version and an invalid item fail;
  - `knowledge.status` shows each agent its own proposals only.
- Decisions through the kernel API:
  - an approver approves or rejects once;
  - an operator, a service token or an agent cannot;
  - every proposal and decision is in the audit chain, and the chain verifies.
- Expiry after 14 days, and the daily limit of 20.
