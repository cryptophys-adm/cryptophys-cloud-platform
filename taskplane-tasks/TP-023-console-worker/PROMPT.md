# TP-023: Console Worker (`cryptophys-console`): forwarding, allow-list, whoami and hardening

- **Worker:** pi (see `taskplane-tasks/PI.md`).
- **Depends on:** TP-022 (merged and deployed). ADR-0008 is accepted.
- **Branch:** `worker/TP-023-console-worker`.
- **PR title:** `TP-023: console Worker (allow-listed forwarding with the operator's own Access JWT)`.

## Why

**Owner decision (2026-11-05, ADR-0008):** an operator Console at `console.cryptophys.work`, with action buttons for every control-plane feature. It stays separate from Nexus until phase 2.

- This task builds the **server side** and a minimal shell page.
- TP-024 builds the full UI on top of it.
- **Security model (ADR-0008 §3).** The Console has no authority of its own:
  - it forwards the operator's **own verified Access JWT** to the platform Workers' `fetch` handlers through Service Bindings;
  - the target Worker verifies that JWT and enforces the operator rule, the approver rule and separation of duties, exactly as for a direct call.

## Read first (and nothing else)

- `architecture/adr/0008-cerebrum-console-access.md`, all of it.
- `workers/platform-api/src/index.ts` and `src/worker.ts`: the pattern to copy (Access gate, health, readiness, `HealthRpc`).
- `workers/platform-api/wrangler.toml`, `package.json` and `tsconfig.json`.
- `workers/control-plane-shared/src/access.ts`: `authenticate`, `requireOperator`, `identityAllowed`, `actorOf`.
- `workers/control-plane-shared/src/http.ts`: `healthBody`, `MAX_BODY_BYTES`.
- `workers/control-plane-shared/test/harness.ts`, and `control-plane.test.ts` around line 233, which has the recovery-plan approve pattern.
- The `if (path === …)` route lines in each target's `src/index.ts`: `ai-kernel`, `recovery-manager`, `platform-registry`, `policy-engine`, `drift-detector`, `audit-ledger`, `deployment-orchestrator` and `platform-api`. Only read them to confirm the allow-list below; do not change them.

## Files you may change

- `workers/console/` (new):
  - `wrangler.toml`, `package.json`, `tsconfig.json`, `README.md`;
  - `src/index.ts`, `src/worker.ts`, `src/ui.ts`.
- `workers/control-plane-tsconfig.json`: add `"console/src/**/*.ts"` to `include`. Nothing else.
- `workers/control-plane-shared/test/console-tp023.test.ts` (new).
- `docs/OPERATIONS.md`: a short "Console" paragraph.
- `taskplane-tasks/TP-023-console-worker/STATUS.md`.

**Do not touch** `.github/*`, any other Worker's source, the migrations, or any other test file. The orchestrator writes the deploy workflow and the Access change.

## Specification

### 1. `wrangler.toml`

- `name = "cryptophys-console"`, `main = "src/worker.ts"`, `compatibility_date = "2026-11-01"`, `workers_dev = true`.
- `routes = [{ pattern = "console.cryptophys.work", custom_domain = true }]`
- `[observability] enabled = true`, and `[version_metadata] binding = "CF_VERSION_METADATA"`.
- `[vars]`:
  - `SERVICE_NAME = "cryptophys-console"`
  - `SERVICE_ENVIRONMENT = "production"`
  - `API_CONTRACT_VERSION = "v1"`
- No `[ai]`, D1, Durable Objects or secrets. `ACCESS_*`, `OPERATOR_IDENTITIES` and `APPROVER_IDENTITIES` are set at deploy time; write a comment saying so.
- Eight `[[services]]` bindings with the **default entrypoint** (no `entrypoint`, no `props`):

  | Binding | Service |
  |---|---|
  | `KERNEL` | `cryptophys-ai-kernel` |
  | `RECOVERY` | `cryptophys-recovery-manager` |
  | `REGISTRY` | `cryptophys-platform-registry` |
  | `POLICY` | `cryptophys-policy-engine` |
  | `DRIFT` | `cryptophys-drift-detector` |
  | `AUDIT` | `cryptophys-audit-ledger` |
  | `ORCHESTRATOR` | `cryptophys-deployment-orchestrator` |
  | `PLATFORM` | `cryptophys-platform-api` |

### 2. Request handling (`src/index.ts`)

1. **Every request** goes through `requireOperator`. That includes `/`, the assets and `/api/*`. `/health` and `/ready` only need `accessGate`, as in platform-api. A missing or invalid JWT gets 403, and a non-operator gets 403.
2. **`GET /`** returns the shell HTML. **`GET /assets/app.js`** and **`GET /assets/app.css`** come from `src/ui.ts`.
3. **`GET /api/whoami`** returns:

   ```json
   { "actor": "<actorOf>", "type": "user|service_token", "operator": true, "approver": <identityAllowed(identity, APPROVER_IDENTITIES)> }
   ```

4. **`/api/{service}/{rest}`** forwards to the binding for `{service}`, but only when `(service, method, "/" + rest)` matches the allow-list below. Anything else gets 404 `{ "error": "not_allowed" }`.
5. **Path safety:**
   - every path segment must match `^[A-Za-z0-9._@+:-]{1,128}$`;
   - segments `.` and `..` are rejected, and so is any `%`;
   - otherwise 400 `{ "error": "invalid_path" }`.
6. **CSRF.** For every method other than GET and HEAD under `/api/`:
   - require `Origin` to be present and equal to `new URL(request.url).origin`;
   - require header `x-cryptophys-console: 1`;
   - otherwise 403 `{ "error": "csrf" }`.
   - Check this **before** forwarding.
7. **Body.** `content-type` must be `application/json` when a body is sent, and the body is at most `MAX_BODY_BYTES` (32 KiB); otherwise 413 or 415. The body is passed through as bytes.
8. **The forwarded request:**
   - URL: `https://console.internal` + path + query. The query is kept only for GET and is at most 512 characters, otherwise 400.
   - Headers: **only** `cf-access-jwt-assertion` (the same token the Console just verified) and `content-type` if there is a body.
   - No cookies, no `authorization`, no other browser header.
9. **The response to the browser:**
   - the upstream status and body;
   - headers replaced by `content-type: application/json; charset=utf-8`, `cache-control: no-store` and `x-content-type-options: nosniff`;
   - upstream `set-cookie` and every other upstream header are dropped.
   - If the binding throws or is missing: 502 `{ "error": "upstream_unavailable", "service": "<service>" }`.
10. **Logging.** Log one line per forward: `{ event: "console_forward", service, method, route, status }`, where `route` is the allow-list **pattern**, not the concrete path. Never log the JWT, the actor, the body or the query.
11. **Security headers on every response:**
    - `x-content-type-options: nosniff`
    - `referrer-policy: no-referrer`
    - `x-frame-options: DENY`
    - `cache-control: no-store`

    The HTML response also gets:

    ```
    content-security-policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
    ```

12. **`/health` and `/ready`**, shaped like platform-api's so that `verify-worker-live.sh` accepts them:
    - `/health` uses `healthBody`;
    - `/ready` returns `{ status, service, production_ready, checks }`. The checks are:
      - `production_environment`
      - `access_configured`
      - `operator_identities_configured`
      - `approver_identities_configured`
      - `service_bindings`: all 8 present.
    - It returns 503 when any check fails.
13. **`src/worker.ts`** has the default export plus `HealthRpc`, as in platform-api.

### 3. The allow-list (export it as a constant so the tests can import it)

`{id}` = one safe segment. **Nothing else is forwarded.**

| service | method | path |
|---|---|---|
| `kernel` | GET | `/v1/kernel`, `/v1/status`, `/v1/reports`, `/v1/agents`, `/v1/agents/{id}`, `/v1/agents/{id}/actions` |
| `kernel` | POST | `/v1/kernel/agents-enabled`, `/v1/agents/{id}/wake`, `/v1/agents/{id}/suspend`, `/v1/agents/{id}/resume`, `/v1/agents/{id}/principals` |
| `kernel` | DELETE | `/v1/agents/{id}/principals/{id}` |
| `recovery` | GET | `/v1/plans`, `/v1/plans/{id}` |
| `recovery` | POST | `/v1/plans`, `/v1/plans/{id}/approve`, `/v1/plans/{id}/executions`, `/v1/plans/{id}/disable` |
| `registry` | GET | `/v1/services`, `/v1/services/{id}` |
| `registry` | PUT | `/v1/services/{id}`, `/v1/services/{id}/desired-version` |
| `policy` | GET | `/v1/decisions`, `/v1/decisions/{id}` |
| `policy` | POST | `/v1/evaluate` |
| `drift` | GET | `/v1/drift`, `/v1/drift/{id}` |
| `drift` | POST | `/v1/observe` |
| `audit` | GET | `/v1/events`, `/v1/events/{id}`, `/v1/verify` |
| `orchestrator` | POST | `/v1/deployments` |
| `platform` | GET | `/v1/overview` |

**Explicitly not forwarded:**
- the kernel's `/mcp`;
- the audit ledger's `POST /v1/events`;
- `/health`, `/ready` and `/` of any target.

### 4. Shell page (`src/ui.ts`)

TP-024 builds the real screens; keep this minimal.

- Plain HTML, CSS and JS. **No npm dependency, no CDN, no inline `<script>` or `style=` attribute.**
- **Header:** "Cerebrum · Console", plus the signed-in actor and an "approver" badge from `/api/whoami`.
- **A "Platform overview" card** that fetches `/api/platform/v1/overview` and shows:
  - agents enabled;
  - drift count;
  - the `agent_reports_24h` totals;
  - `xauusd_latest`, if present.
- Write every value with `textContent`. **Never use `innerHTML` with fetched data.**
- **A shared `api(method, path, body)` helper** that sets `x-cryptophys-console: 1` and `content-type`, and turns a non-2xx response into a visible error line. TP-024 builds on it.
- **No action buttons yet.**

## Budget

- One Worker, no D1, AI or Durable Objects.
- Each Console request costs one request plus one Service Binding call.
- No cron.

## Acceptance criteria (one `test()` per criterion, in `console-tp023.test.ts`)

Use fake bindings that record the forwarded `Request` and return a canned response. For criterion 8, wire a binding to the real Worker.

1. **Access.**
   - no JWT gets 403;
   - `OUTSIDER_JWT` on `/`, `/api/whoami` and an allow-listed `/api` route gets 403, and no binding is called;
   - `OPERATOR_JWT` on `/` gets 200 HTML with the exact CSP header.
2. **whoami.** The operator gets `approver: false`. An identity in both lists gets `approver: true`. The actor is lower-case.
3. **Allow-list.**
   - every row in §3 forwards to the right binding with the right method and path;
   - these get 404 `not_allowed`: `/api/kernel/mcp`, `POST /api/audit/v1/events`, `/api/recovery/health`, an unknown service, and the wrong method on an allowed path;
   - no binding is called for any of them.
4. **Path safety.** `..`, `%2F`, `%40` and an over-long segment each get 400 `invalid_path`.
5. **CSRF.** For a POST to an allowed route, each of these gets 403 `csrf` with no forward:
   - no `Origin`;
   - a foreign `Origin`;
   - a missing `x-cryptophys-console` header.
6. **Header hygiene.**
   - the forwarded request carries the same JWT and nothing else: no `cookie` or `authorization`, even when the browser sent them;
   - an upstream `set-cookie` never reaches the browser;
   - the GET query passes through, and a query over 512 characters gets 400.
7. **Bodies and failures.** A body over 32 KiB gets 413, a non-JSON content type gets 415, and a binding that throws gets 502 `upstream_unavailable`.
8. **Identity is preserved end to end.** Wire `RECOVERY` to the real `recovery-manager` Worker on a migrated `FakeD1`.
   - Create a plan through the Console as `OPERATOR_JWT`.
   - Approving it through the Console as the same identity gets the Worker's own `separation_of_duties` 403.
   - Approving it as an approver who is also an operator succeeds, and the plan's `approved_by` is **that approver's email**, not anything Console-specific.
   - Follow the existing approve test's setup (`control-plane.test.ts` around line 233).
9. **Health and ready.** `/health` matches the deploy filter fields. `/ready` is 200 with all checks true, and 503 when `APPROVER_IDENTITIES` is unset.
10. **No regressions.**
    - typecheck is clean;
    - `npm test` is above 143, with 0 fail, 0 skipped and 0 todo;
    - the dry-run succeeds.

## Definition of done

Follow "Definition of done" in `ANTIGRAVITY.md`, and paste the **real** output tails into `STATUS.md`. Dry-run from `workers/control-plane-shared`:

```bash
npx wrangler deploy --dry-run --config ../console/wrangler.toml --outdir /tmp/dry-console
```

Set `State: done` only with 0 failures.

## After merge (orchestrator only)

1. Add `cryptophys-console` to `PLATFORM_WORKERS` in `provision-access.yml`, and run Provision Access. It bootstraps a private stub and adds the destination to the same AUD.
2. Add a `deploy-console.yml` modelled on `deploy-platform-api.yml`, with `APPROVER_IDENTITIES` passed. Add the Console to validation and to ops-dispatch.
3. Deploy, then verify:
   - `/health` and `/ready` through Access;
   - `whoami` for the owner;
   - `/api/platform/v1/overview` returns live data;
   - `/api/kernel/mcp` gets 404.
4. **Owner (Zero Trust dashboard):** connect an OIDC identity provider (GitHub or Google) to the team. One-time PIN stays as the fallback.
