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
  - After every change, the Registry sets the group to the owners plus the active accounts through the Access API, with the Worker secret `ACCESS_GROUPS_TOKEN`.
  - Without the secret, roles still apply, but a **new** person cannot sign in. The page says so.
  - Disabling removes a person from the group. An already open Access session lasts until it expires (8 h).
- **Deploy order.** A commit with a new migration deploys the Control Plane first and alone, because only that workflow applies migrations and every Worker's readiness needs the newest one (`pendingDeploys`).

## Owner steps (one time)

1. **Create a token** in Cloudflare (My Profile → API Tokens → Create Token → Custom):
   - permission: **Account → Access: Organizations, Identity Providers, and Groups → Edit**;
   - resources: account cryptophys.
2. **Store it as a Worker secret:** Workers & Pages → `cryptophys-platform-registry` → Settings → Variables and Secrets → **Add → Secret**, name `ACCESS_GROUPS_TOKEN`. It never passes through chat or GitHub.
3. **Provision Access runs once** (the orchestrator does this through ops-dispatch). It creates the group and includes it in the allow policy.
4. In the Console, select **Users → Sync sign-in** once.
