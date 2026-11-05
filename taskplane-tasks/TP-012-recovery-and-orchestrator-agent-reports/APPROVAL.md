# TP-012 approval record

- **PR #88: VALIDATED** (orchestrator, 2026-11-05). Local re-run: 108 tests pass, typecheck clean, `test_migrations.py` PASS, both dry-runs OK. CI green. Merged as `c1854ed`.
- **DEPLOYED AND VERIFIED** (orchestrator, 2026-11-05 11:53 UTC):
  - Deploy Control Plane run 42022098877: success. Migration `0018_grant_reports_publish.sql` was applied at 11:50:17.
  - Deploy Production Deployment Orchestrator run 42022504105: success.
  - D1: `recovery-manager` and `deployment-orchestrator` each hold `reports.publish` exactly once, with `tier_max` 1.
  - Drift: 0 of 13 at 11:51 UTC.
- **Note.** Production already had `reports.publish` for both agents from migration 0017 (`updated_by` still reads `migration:0017`). The 0018 guard made it a no-op there. It stays as an idempotent record for fresh databases.

The worker is done with TP-012.
