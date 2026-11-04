# TP-002 — Retire unused GitHub configuration in cryptophys-adm/cryptophys-cloud-platform

**Why:** identity-based authorization (ADR-0004 decision 4) and running the request workflow from `main` made some configuration dead.

## Steps

1. **Read-only.** List the `production` Environment secrets and variables, the deployment branch policies and the repository branches with `gh api` (names only). Confirm that nothing in `.github/workflows/` references:
   - `CONTROL_PLANE_ADMIN_TOKEN`
   - `CONTROL_PLANE_APPROVER_TOKEN`
   - `ORCHESTRATOR_SHARED_SECRET`
   Use `grep -rn` and include its output.
2. **After orchestrator VALIDATED on step 1:**
   - Delete the three unused secrets from the `production` Environment.
   - Delete branch `ops/platform-api-deploy-request`.
   - Do **not** remove `claude/gracious-brown-tkc4e8`. It is the orchestrator's operator branch and still drives `ops-dispatch.yml`. Do remove it from the `production` Environment's deployment branch policies: production workflows now run only on `main`.
3. **Evidence.** The before and after lists of names. Also show that the next scheduled `Drift Alert` and the next `Deploy Control Plane` the orchestrator dispatches still succeed. Ask the orchestrator to dispatch one.

**Done when:** the three secrets and the stray branch are gone, `production` allows `main` only, and production workflows are still green.
