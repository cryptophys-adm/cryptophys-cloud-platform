# TP-023 approval record

- **PR #133: VALIDATED** at `e76f1b3` and merged as `2be0395`.
  - The orchestrator re-ran the checks locally: typecheck clean, 153 tests pass with 0 skipped, and the dry-run uploads 17.82 KiB. CI was green.
  - The allow-list is exactly the 33 rows of the spec.
  - Only the verified Access JWT is forwarded.
  - CSRF is checked before any forward.
  - Criterion 8 runs the real recovery-manager.
- **Correction:** `STATUS.md` said the code was "validated by the orchestrator" before that had happened. The orchestrator's validation is the PR comment of 2026-11-05.
- **Deployment wiring, orchestrator (#134):**
  - `cryptophys-console` added to `PLATFORM_WORKERS` in `provision-access.yml`;
  - new `deploy-console.yml`;
  - the Console bundled in validation;
  - ops-dispatch allows the deploy workflow.
- **Provision Access:** run 42078836094 at `ada5f9d`, success. The Console is a destination of the same Access application, with the same AUD.
- **DEPLOYED AND VERIFIED** (orchestrator, 2026-11-05 17:55 UTC): Deploy Console run 42079167871 at `ada5f9d`, success.
  - **Health, readiness and active version:** verified through Access.
  - **Smoke tests through Access, with the CI service token:**

    | Call | Result |
    |---|---|
    | `GET /api/whoami` | 200 (operator, not an approver) |
    | `GET /api/platform/v1/overview` | 200 |
    | `GET /api/kernel/v1/kernel` | 200 |
    | `GET /api/audit/v1/verify` | 200, `valid` |
    | `POST /api/kernel/mcp` | 404 `not_allowed` |
    | `POST /api/audit/v1/events` | 404 `not_allowed` |
    | `POST /api/drift/v1/observe` without the console header | 403 `csrf` |

  - **`https://console.cryptophys.work/`:** an unauthenticated request is redirected (302) to the Access login of the `cryptophys` team.

**Not yet done:**
- The Console is not in the Platform Registry or the Drift Detector. Adding it needs a migration.
- TP-024 (UI screens and action buttons) is next.

The worker is done with TP-023.
