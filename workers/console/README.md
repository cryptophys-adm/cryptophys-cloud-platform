# cryptophys-console

Operator Console (ADR-0008) at `console.cryptophys.work`. A backend-for-frontend with no authority of its own.

- Every request needs a valid Cloudflare Access JWT of an identity in `OPERATOR_IDENTITIES`; `/health` and `/ready` need only a valid JWT.
- `/api/{service}/…` forwards allow-listed requests (`CONSOLE_ALLOW_LIST` in `src/index.ts`) to the platform Workers through Service Bindings, carrying only the operator's own `cf-access-jwt-assertion`. The target Worker verifies it and enforces the operator rule, approver rule and separation of duties.
- Never forwarded: the kernel's `/mcp` and the audit ledger's `POST /v1/events`.
- Non-GET `/api` calls require a same-origin `Origin` and `x-cryptophys-console: 1`.
- `GET /api/whoami` returns the actor and whether it is an approver (cosmetic, for the UI).
- No AI engine (ADR-0008 §4), no D1, no Durable Objects, no cron.

Deploy-time variables: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OPERATOR_IDENTITIES`, `APPROVER_IDENTITIES`.
