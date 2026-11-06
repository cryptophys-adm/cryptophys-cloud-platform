# TP-026 approval record

## PR #145 review

**VALIDATED** at `4d723a9`, first pass, and merged as `9b9692d`.
- The orchestrator re-ran the checks: typecheck clean, 185 tests passing, `test_migrations.py` PASS. CI was green.
- The diff matches the spec exactly. The rewritten assertions are listed in `STATUS.md`.
- **Mutation check:** with the `SVC_CONSOLE` mapping removed from `targets()`, criteria 2, 3, 4 and 6 fail.

## Orchestrator follow-ups

- **#146:** `deploy-console.yml` and `deploy-home.yml` record the desired version.
- **#147:** the Console UI redesign. Deployed in the same rollout, at the same commit.

## Deployment (2026-11-06)

All three runs used commit `4b0f64b`.

| Run | Result |
|---|---|
| Deploy Control Plane, run 42142724656 | Success. Migration `0022_register_console_and_home.sql` applied; the Drift Detector was redeployed with `SVC_CONSOLE` and `SVC_HOME`. Dispatched at 01:16 UTC, after the :15 cron. |
| Deploy Console, run 42143547113 | Success. The Nexus UI is live through Access; the smoke tests passed; desired version `4b0f64bf07d9` recorded. |
| Deploy Cerebrum Home, run 42144119940 | Success. Desired version `4b0f64bf07d9` recorded. |

**DEPLOYED AND VERIFIED** (orchestrator, D1, cron observation at 01:30:08 UTC):
- `service_registry` has 15 rows;
- `cryptophys-console` and `cryptophys-home` show desired = observed = `4b0f64bf07d9`, `drifted = 0`, and no reasons, so they are managed and healthy;
- across all 15 services the latest observations show **0 drifted**.

The worker is done with TP-026.
