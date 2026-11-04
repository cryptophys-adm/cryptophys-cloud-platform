# TP-002 — Gate record (authoritative for the worker)

The worker does not read PR comments, so gate decisions for this task are recorded here, in
the repository the worker reads.

| Gate | Decision | By | When |
|---|---|---|---|
| Step 1 read-only inventory | **VALIDATED** | orchestrator (Claude cloud session) | 2026-11-04 |
| Step 2 destructive cleanup | **OWNER AUTHORIZATION: GRANTED** ("setuju dan dieksekusi pi, langkah 2 boleh jalan") | repository owner, recorded by the orchestrator | 2026-11-04 |

## Step 2: execute now, exactly this

1. Delete the `production` Environment secrets `CONTROL_PLANE_ADMIN_TOKEN`, `CONTROL_PLANE_APPROVER_TOKEN` and `ORCHESTRATOR_SHARED_SECRET`:
   `gh secret delete <NAME> --env production --repo cryptophys-adm/cryptophys-cloud-platform`
2. Delete the branch `ops/platform-api-deploy-request`:
   `gh api -X DELETE repos/cryptophys-adm/cryptophys-cloud-platform/git/refs/heads/ops/platform-api-deploy-request`
3. In `production`, delete the deployment-branch policy named `claude/gracious-brown-tkc4e8` and keep `main`. Find its id with
   `gh api repos/cryptophys-adm/cryptophys-cloud-platform/environments/production/deployment-branch-policies`,
   then run `gh api -X DELETE .../deployment-branch-policies/<id>`.
   **Do not delete the branch `claude/gracious-brown-tkc4e8`.**

## Then

- Work on a new branch, `worker/TP-002-step2`, from the latest `main`. PR #47 is already merged; do not reuse it.
- Update `STATUS.md`:
  - `State: done`;
  - the names before and after: Environment secrets, deployment-branch policies, branches;
  - the line `Owner approval: confirmed by owner to orchestrator, 2026-11-04 (see APPROVAL.md)`.
- Open a new PR titled `TP-002: step 2 cleanup (done)`. **Do not merge it.**
- If an API call is refused, stop: record the exact command and the HTTP status, and set `State: blocked`.
