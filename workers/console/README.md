# cryptophys-console

Operator Console (ADR-0008) at `https://nexus.cryptophys.work/console/`, through the zone route `nexus.cryptophys.work/console*` (ADR-0010). Its old custom domain `console.cryptophys.work` was retired on 2026-11-13; until `retire-worker.yml` detaches it, `LEGACY_HOSTS` redirects it to the mount. A backend-for-frontend with no authority of its own.

- Every request needs a valid Cloudflare Access JWT of an identity in `OPERATOR_IDENTITIES`; `/health` and `/ready` need only a valid JWT.
- `/api/{service}/…` forwards allow-listed requests (`CONSOLE_ALLOW_LIST` in `src/index.ts`) to the platform Workers through Service Bindings, carrying only the operator's own `cf-access-jwt-assertion`. The target Worker verifies it and enforces the operator rule, approver rule and separation of duties. One external Worker is on the list: Aether (`AETHER` -> `cryptophys-aether`, owner 2026-11-10), only `GET /v1/overview`, read-only. The Knowledge page shows its learning progress (each curator and calibrator rule's have-versus-need, and each timeframe's weighting replay against its discovery and holdout minimums) and the existing knowledge (canon files, KB v4, doctrine, roles, definitions, learned items, active weighting). Every number comes from that answer; a missing one shows a dash.
- Never forwarded: the kernel's `/mcp` and the audit ledger's `POST /v1/events`.
- Non-GET `/api` calls require a same-origin `Origin` and `x-cryptophys-console: 1`.
- `GET /api/whoami` returns the actor and whether it is an approver (cosmetic, for the UI).
- No AI engine (ADR-0008 §4), no D1, no Durable Objects, no cron.

Deploy-time variables: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OPERATOR_IDENTITIES`, `APPROVER_IDENTITIES`.
