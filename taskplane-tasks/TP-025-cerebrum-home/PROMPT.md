# TP-025: Cerebrum home portal (`cryptophys-home` at home.cryptophys.work)

- **Worker:** pi (see `taskplane-tasks/PI.md`).
- **Depends on:** TP-024 (deployed and verified).
- **Branch:** `worker/TP-025-cerebrum-home`.
- **PR title:** `TP-025: Cerebrum home portal (navigation and read-only platform status)`.

## Why

**Owner decision (ADR-0008 §1 and §5.3):** `home.cryptophys.work`, named **Cerebrum**, is the landing page after Access sign-in. It holds the navigation panel: Console, Nexus, and later modules. Nexus is merged into it only in phase 2, through an owner action in the xauusd repository.

Cerebrum is **read-only**. It has no action buttons; every action lives in the Console.

## Read first (and nothing else)

- `architecture/adr/0008-cerebrum-console-access.md`, §1, §2, §3 and §5.
- `workers/console/src/index.ts` and `src/worker.ts`. Copy their patterns:
  - the Access gate;
  - `requireOperator`;
  - forwarding with only the verified JWT;
  - response header replacement;
  - security headers and CSP;
  - health and readiness.
- `workers/console/wrangler.toml`, `package.json` and `tsconfig.json`.
- `workers/console/src/ui/app-js.ts`: only the `el()` and `api()` helpers, to copy.
- `workers/control-plane-shared/test/console-tp023.test.ts`: the `run`/`creq` helpers and the fake-binding recorder.

## Files you may change

- `workers/home/` (new):
  - `wrangler.toml`, `package.json`, `tsconfig.json`, `README.md`;
  - `src/index.ts`, `src/worker.ts`, `src/ui.ts`. You may split the UI into `src/ui/*.ts` modules that export strings.
- `workers/control-plane-tsconfig.json`: add `"home/src/**/*.ts"` to `include`. Nothing else.
- `workers/control-plane-shared/test/home-tp025.test.ts` (new).
- `docs/OPERATIONS.md`: a short "Cerebrum home" paragraph.
- `taskplane-tasks/TP-025-cerebrum-home/STATUS.md`.

**Do not touch** `.github/*`, the Console, any other Worker, the migrations, or other tests. **Add no npm dependency.**

## Specification

### 1. `wrangler.toml`

- `name = "cryptophys-home"`, `main = "src/worker.ts"`, `compatibility_date = "2026-11-01"`, `workers_dev = true`.
- `routes = [{ pattern = "home.cryptophys.work", custom_domain = true }]`
- `[observability] enabled = true`, and `[version_metadata] binding = "CF_VERSION_METADATA"`.
- `[vars]`:
  - `SERVICE_NAME = "cryptophys-home"`
  - `SERVICE_ENVIRONMENT = "production"`
  - `API_CONTRACT_VERSION = "v1"`
- **One** `[[services]]` binding with the default entrypoint: `PLATFORM` → `cryptophys-platform-api`.
- No AI, D1, Durable Objects or secrets (ADR-0008 §4). `ACCESS_*` and `OPERATOR_IDENTITIES` are set at deploy time; write a comment saying so.
- `APPROVER_IDENTITIES` is optional and used only for the badge.

### 2. Request handling (`src/index.ts`)

1. `/health` and `/ready` go through `accessGate`. **Every other path** goes through `requireOperator`; an outsider gets 403.
2. **`GET /`:** HTML with the exact Console CSP. **`GET /assets/app.js`** and **`GET /assets/app.css`** come from a fixed map. Any other `/assets/*` gets 404.
3. **`GET /api/whoami`** returns `{ actor, type, operator: true, approver }`, exactly as in the Console. If `APPROVER_IDENTITIES` is unset, `approver` is `false`.
4. **`GET /api/platform/v1/overview`** is forwarded to `PLATFORM`:
   - with only the verified `cf-access-jwt-assertion`;
   - with no query string;
   - the response headers are replaced (JSON content type, `no-store`, `nosniff`), and `set-cookie` is dropped;
   - if the binding throws or is missing: 502 `{ "error": "upstream_unavailable", "service": "platform" }`.
5. **Anything else under `/api/`** gets 404 `{ "error": "not_allowed" }`. **Every non-GET or HEAD method on any path** gets 405 `{ "error": "method_not_allowed" }`. There are no state-changing routes, so there is no CSRF path.
6. Every response carries the TP-023 security headers: `nosniff`, `no-referrer`, `DENY` and `no-store`.
7. **Logging:** one line per forward, `{ event: "home_forward", status }`. Never log the JWT or the actor.
8. **`/health`** uses `healthBody`. **`/ready`** returns `{ status, service, production_ready, checks }`. The checks are:
   - `production_environment`
   - `access_configured`
   - `operator_identities_configured`
   - `platform_binding`

   It returns 503 when any check fails. `APPROVER_IDENTITIES` is not required.
9. **`src/worker.ts`:** the default export plus `HealthRpc`, as in the Console.

### 3. UI

Same hard rules as TP-024 §1.1, §1.2 and §1.8:
- plain JS and CSS from `/assets/*`, with no inline script or style;
- `textContent` only;
- none of `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval(`, `new Function` or `setAttribute("on`;
- real buttons and labels;
- readable at 360 px.

1. **Layout:**
   - a **left navigation panel**, which becomes a top bar under 720 px;
   - a header "Cerebrum" with the actor and an "approver" badge;
   - a main area.
2. **Navigation panel**, in this order:
   - **Home**: the current page.
   - **Console**: `https://console.cryptophys.work`, same tab.
   - **Nexus ↗**: `https://nexus.cryptophys.work`, with `target="_blank"` and `rel="noopener noreferrer"`. Small caption: "XAUUSD room (separate site until phase 2)".
   - A disabled, non-link item "More modules (phase 2)" with `aria-disabled="true"`.
3. **Main area** (from `/api/platform/v1/overview`, loaded once, plus a "Refresh" button; no timers):
   - **Agents:** "running" when `agents_enabled` is true, otherwise "stopped (kill switch)".
   - **Drift:** the count of `services[]` with `drifted: true`. If it is above zero, list the ids and add "(persistent)" where `persistent` is true.
   - **Agent reports, 24 h:** `counts.critical`, `counts.warning` and `counts.info`, plus the number of `latest_critical` entries.
   - **Open recovery proposals:** `open_agent_plans.length`, with a link "Review in Console" to `https://console.cryptophys.work/#/recovery`.
   - **XAUUSD (display only):** `decision`, `confidence`, `candle_key` and `decided_at`. Show "unavailable" when `xauusd_latest.error` is set and "none" when it is null. Show no buttons and no advice.
   - **Tiles:** a "Console" tile and a "Nexus" tile, each with a one-line description and the same links as the nav.
4. **Errors:** an error is shown in a banner as `GET path: status error`. The page never goes blank.

## Budget

- One Worker, with one Service Binding call per page load or Refresh.
- No D1, AI, cron or timer.

## Acceptance criteria (one `test()` per criterion, in `home-tp025.test.ts`)

1. **Access.**
   - no JWT gets 403;
   - `OUTSIDER_JWT` gets 403 on `/`, `/assets/app.js`, `/api/whoami` and `/api/platform/v1/overview`, and the binding is not called;
   - `OPERATOR_JWT` on `/` gets 200 HTML with the exact CSP.
2. **whoami.** An operator gets `approver: false`. A dual identity gets `true`. With `APPROVER_IDENTITIES` unset, `false`. The actor is lower-case.
3. **Single forward.**
   - `GET /api/platform/v1/overview?x=1` reaches `PLATFORM` as `/v1/overview` with no query, carrying the same JWT and no other header, even when the browser sent `cookie` and `authorization`;
   - an upstream `set-cookie` is dropped;
   - a throwing or missing binding gets 502 `upstream_unavailable`.
4. **Nothing else.** Each of these gets 404 `not_allowed`, and no binding is called:
   - `/api/kernel/v1/agents`
   - `/api/platform/v1/overview/x`
   - `/api/recovery/v1/plans`
   - `/api/x`

   `POST`, `PUT` and `DELETE` on `/`, `/api/whoami` and `/api/platform/v1/overview` each get 405.
5. **UI safety.**
   - the served JS and CSS contain none of the forbidden strings;
   - the HTML has no inline script, `style=` or ` on…=` attribute;
   - the served HTML or JS contains the exact Console URL, and the Nexus URL with `target="_blank"` and `rel="noopener noreferrer"`;
   - there is no `setInterval` and no `setTimeout`.
6. **Assets and headers.**
   - `/assets/app.js` and `/assets/app.css` return 200 with the right types and the security headers;
   - `/assets/x.js` returns 404.
7. **Health and ready.** `/health` matches the deploy filter fields (service `cryptophys-home`). `/ready` is 200 with all four checks true, and 503 without the `PLATFORM` binding.
8. **No regressions.**
   - typecheck is clean;
   - `npm test` is above 167, with 0 fail, 0 skipped and 0 todo;
   - the dry-run succeeds.

## Definition of done

Follow "Definition of done" in `ANTIGRAVITY.md`. From `workers/control-plane-shared`:

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npx wrangler deploy --dry-run --config ../home/wrangler.toml --outdir /tmp/dry-home
```

Paste the **real** output tails into `STATUS.md`:
- under "Who wrote what", say who wrote each file;
- write only what you yourself observed;
- never write that the orchestrator validated anything.

## After merge (orchestrator only)

1. Add `cryptophys-home` to `PLATFORM_WORKERS` (`provision-access.yml`) and run Provision Access.
2. Add `deploy-home.yml`, modelled on `deploy-console.yml`, with smoke tests: `whoami`, the overview forward, `/api/kernel/v1/agents` 404, and `POST /` 405. Add the Worker to validation and to ops-dispatch.
3. Render the portal locally with Playwright at desktop and 360 px, then deploy and verify live.
4. **Owner:** open `https://home.cryptophys.work`. One Access sign-in now covers `home.` and `console.`.
