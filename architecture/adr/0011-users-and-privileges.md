# ADR-0011: Users and privileges in the Cerebrum Console

- **Status:** Accepted (owner, 2026-11-07)
- **Owner request:** "persiapkan panel user account management dan pengaturan privilegenya … buat menu khusus di cerebrum console untuk menambahkan user baru, dengan role admin (berhak akses cerebrum), dan user (tidak bisa akses cerebrum)." Roles: Viewer / Operator / Approver. Changes: one owner plus a typed confirmation.

## Decision

| Account | Nexus sign-in | Cerebrum Console | Rights |
|---|---|---|---|
| `user` | yes | no | none in the control plane |
| `admin` · viewer | yes | yes, read only | every GET |
| `admin` · operator | yes | yes | routine actions (as `OPERATOR_IDENTITIES`) |
| `admin` · approver | yes | yes | operator rights, plus approvals: recovery plans, owner-queue decisions, raising the consensus mode |
| owner (configured) | yes | yes | approver, plus **managing accounts** |

- **Root of trust stays in configuration.**
  - The owners are the people in `APPROVER_IDENTITIES`, and the operators and CI token are in `OPERATOR_IDENTITIES`.
  - Neither can be added, changed or disabled from the panel, so nobody can lock the owners out.
  - A configured approver who is not also an operator is still not an operator. The existing rule stands.
- **Accounts live in D1.** The table is `platform_accounts` (migration 0026).
  - Only owners write it: `POST /v1/accounts` with `GRANT` adds or changes an account, and `POST /v1/accounts/{email}/disable` with `REVOKE` disables one.
  - Nobody can change their own access.
  - Accounts are disabled, never deleted.
  - Each change is committed atomically with its audit event: `account.created`, `account.changed` or `account.disabled`.
- **One auth path.** `requireOperator` and `requireApprover` in `control-plane-shared/src/access.ts` check the configuration first, then the active account.
  - Every control-plane Worker therefore applies the same roles.
  - A service token is never an approver.
  - A failed lookup grants nothing.
- **The Console holds no role data.** It asks the Platform Registry (`GET /v1/accounts/me`, with the caller's own Access JWT).
  - It admits configured identities and `admin` accounts.
  - It refuses `user` accounts and refuses on any failure.
  - It blocks writes for viewers.
  - The Users page lives at `#/users`.
- **Nexus sign-in is managed without GitHub.**
  - The Access application's allow policy includes the Access group `cryptophys-nexus-accounts`. `provision-access.yml` creates it once and never overwrites it.
  - After every change, the Registry attempts to set the group to the owners plus the active accounts through the Access API, with the Worker secret `ACCESS_GROUPS_TOKEN`.
  - `POST /v1/accounts/sync-login` requires the server-side confirmation `SYNC`.
  - The API returns `synced`, `not_configured`, `group_missing` or `failed`. A failed sync does not roll back the D1 role change: Access membership may remain stale until an owner retries Sync sign-in. In particular, a disabled account may still pass Nexus Access while the group is stale; the Console must show this explicitly.
  - Without the secret, roles still apply, but new people cannot sign in and disabled people may remain in the Access group. An already open Access session lasts until it expires (8 h).
- **Deploy order.** A commit with a new migration deploys the Control Plane first and alone, because only that workflow applies migrations and every Worker's readiness needs the newest one (`pendingDeploys`).
  - *First rollout (owner, 2026-11-07: "Merge and race it").* The Orchestrator running in production predates this guard and still deploys itself first. Migration 0026 is therefore applied by a manual Control Plane deploy (ops-dispatch) right after the merge, inside the same kernel-cycle window. Its readiness then holds before the agents propose the Orchestrator. If the race is lost, the Orchestrator deploy fails verification and rolls back automatically.
- **Access edge scope (owner, 2026-11-07: "Accept, Workers are the gate").** The platform has one Access application, so `user` accounts pass the Access edge for every platform Worker destination, not only Nexus. The security boundary for them is the role check in each Worker. Every `/v1` route requires a role. Without one, only `/health`, `/ready` and service metadata answer. Splitting Nexus into its own Access application stays a possible later change.

## Owner steps (one time)

1. **Create a GitHub Actions provisioning token** in Cloudflare (My Profile → API Tokens → Create Token → Custom), scoped to account `cryptophys`, with:
   - **Workers Scripts → Read** (list the platform Worker destinations);
   - **Access: Service Tokens → Read** (resolve the CI and external-agent service-token IDs);
   - **Access: Organizations, Identity Providers, and Groups → Edit** (read identity providers/groups and create the Nexus account group);
   - **Access: Apps and Policies → Edit** (create or update the platform Access application and its policies).
   Store it as the GitHub Environment secret `CLOUDFLARE_ACCESS_API_TOKEN` in `production`. The `provision-access.yml` workflow uses this token for those read/write operations. Never put it in the repository or chat.
2. **Create a separate runtime sync token** in Cloudflare, scoped to account `cryptophys`, with only **Access: Organizations, Identity Providers, and Groups → Edit**. Store it as the Worker secret `ACCESS_GROUPS_TOKEN` on `cryptophys-platform-registry`. The Registry uses it to maintain group membership; keep this token separate from the broader provisioning token.
3. **Provision Access runs once** from `main` with the exact confirmation `PROVISION`. The workflow also uses the existing production secrets/variable for the account, service-token credentials, operator email allow-list, and private Worker bootstrap/edge verification.
4. After the Access group and policy are verified and the Console Users page is deployed, select **Users → Sync sign-in** once.
