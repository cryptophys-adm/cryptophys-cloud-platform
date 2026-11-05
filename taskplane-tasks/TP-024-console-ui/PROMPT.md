# TP-024: Console UI: every screen and action button

- **Worker:** pi (see `taskplane-tasks/PI.md`).
- **Depends on:** TP-023 (merged, deployed and verified at `console.cryptophys.work`).
- **Branch:** `worker/TP-024-console-ui`.
- **PR title:** `TP-024: console UI (screens and action buttons for the whole control plane)`.

## Why

**Owner decision (ADR-0008):** the Console has action buttons for every control-plane feature.

TP-023 delivered the server side (allow-list forwarding with the operator's own Access JWT) and a shell page. This task builds the screens on top of it.

**The server side does not change.** The UI may call only the 33 allow-listed routes in `CONSOLE_ALLOW_LIST`. Every permission is enforced by the target Worker; the UI only hides buttons that would certainly be refused.

## Read first (and nothing else)

- `architecture/adr/0008-cerebrum-console-access.md`, §3.
- `workers/console/src/index.ts`: `CONSOLE_ALLOW_LIST`, `SERVICE_BINDINGS`, the asset routes and `/api/whoami`.
- `workers/console/src/ui.ts`: the shell, the `api()` helper and `addRow`.
- `workers/control-plane-shared/test/console-tp023.test.ts`: the `run`/`creq` helpers to reuse.
- The request bodies are listed below in §4. **Do not read the target Workers' source.** If a body in §4 turns out to be wrong, write it under `Open questions` instead of guessing.

## Files you may change

- `workers/console/src/ui.ts`. You may split the UI into `workers/console/src/ui/*.ts` modules that export strings.
- `workers/console/src/index.ts`: **only** to serve additional `GET /assets/<name>.js|.css` files from a fixed map. Change nothing else: not the allow-list, the CSRF check, the headers, the forwarding or `whoami`.
- `workers/control-plane-shared/test/console-tp024.test.ts` (new).
- `docs/OPERATIONS.md`: extend the "Console" paragraph with the screens and the approver rules.
- `taskplane-tasks/TP-024-console-ui/STATUS.md`.

**Do not touch** `.github/*`, any other Worker, the migrations, `console-tp023.test.ts`, or `wrangler.toml`. **Add no npm dependency.**

## Specification

### 1. Hard UI rules (each one is tested)

1. **Plain JavaScript and CSS strings, served from `/assets/*`.**
   - No framework, no CDN, no inline `<script>`, no `style=` attribute and no `on*=` attribute.
   - The CSP from TP-023 stays exactly as it is.
2. **Data is only ever written with `textContent`.** Build DOM with one helper, for example `el(tag, props, children)`. These strings must not appear anywhere in the UI source:
   - `innerHTML`
   - `outerHTML`
   - `insertAdjacentHTML`
   - `document.write`
   - `eval(`
   - `new Function`
   - `setAttribute("on`
3. **One route table.** Export a TS constant `UI_ROUTES` from `src/ui/routes.ts`. Each entry is:

   ```ts
   { id, service, method, path, approverOnly, confirm }
   ```

   - `path` uses `{id}` like the allow-list.
   - `confirm` is the typed phrase, or `null`.
   - Embed it into the client JS with `JSON.stringify(UI_ROUTES)`.
   - The client builds every API call **only** through `call(routeId, params, body, query)`, which:
     - substitutes `{id}` with `encodeURIComponent`-safe values;
     - refuses values that do not match `^[A-Za-z0-9._@+:-]{1,128}$`;
     - calls the TP-023 `api()` helper.
   - **No other `fetch` call to `/api/` exists**, apart from `/api/whoami`.
4. **Typed confirmation for every state-changing route** except `policy.evaluate` and `drift.observe`.
   - A modal shows what will happen, and the button stays disabled until the operator types the exact phrase.
   - Phrases use the target's id, for example:
     - `SUSPEND supervisor`
     - `APPROVE plan_…` (first 13 characters)
     - `DEPLOY <first 12 of sha>`
     - `AGENTS OFF`
     - `AGENTS ON`
   - Put a template such as `"SUSPEND {id}"` in `UI_ROUTES.confirm`.
5. **Approver gating is cosmetic.** Hide `approverOnly` buttons when `whoami.approver` is false. The server still decides.
   - A 403 such as `approver_required`, `separation_of_duties` or `forbidden` is shown as a readable error line, never swallowed.
6. **Budget.**
   - No polling faster than 60 seconds.
   - Auto-refresh only Mission Control, only while `document.visibilityState === "visible"`.
   - No other timers.
7. **No trading actions.** XAUUSD data is display only: decision, confidence, candle and time, copied as given. No buttons act on it.
8. **Accessibility basics.**
   - Real `<button>` elements and `<label>` for every input.
   - Visible focus.
   - Readable at 360 px width, with no horizontal page scroll.

### 2. Layout

- **Header:** "Cerebrum · Console", the actor, the approver badge, and a nav.
- **Nav entries:**
  - Mission Control
  - Agents
  - Reports
  - Recovery
  - Services & Drift
  - Policy
  - Audit
  - Deploy
  - an external link "Nexus ↗" to `https://nexus.cryptophys.work`, with `target="_blank"` and `rel="noopener noreferrer"`.
- **Routing:** hash routes (`#/`, `#/agents`, `#/agents/<id>`, `#/reports`, `#/recovery`, `#/recovery/<plan_id>`, `#/services`, `#/policy`, `#/audit`, `#/deploy`). An unknown hash shows Mission Control.
- **Errors and success:**
  - every error is shown in a dismissible banner: `METHOD path: status error`, plus `message` if present;
  - every success shows a short confirmation line and reloads the affected list.

### 3. Screens and their actions (`UI_ROUTES` ids in brackets)

1. **Mission Control** (`#/`):
   - **Overview** [`platform.overview`]:
     - kill switch state;
     - drifted services (services with `drifted: true`; show "0 drifted" when none);
     - `agent_reports_24h` totals and `latest_critical`;
     - open recovery proposals;
     - `xauusd_latest`.
   - **"AI summary" button:** the same route with `?advisory=true`. Clicked on demand only; never automatic.
   - **Kill switch:**
     - "Agents OFF" [`kernel.agents_disabled`], with confirm `AGENTS OFF`;
     - "Agents ON" [`kernel.agents_enabled`], with confirm `AGENTS ON`, `approverOnly`.
     - Both send `POST /v1/kernel/agents-enabled` with `{ "enabled": false|true }`.
2. **Agents** (`#/agents`):
   - **Table** [`kernel.agents`]: agent_id, display_name, host_worker, tier_max, status and status_reason. Filter by `host_worker`.
   - **Detail** (`#/agents/<id>`):
     - [`kernel.agent`];
     - the last 50 actions [`kernel.agent_actions`, query `limit=50`].
   - **Actions:**
     - **Suspend** [`kernel.suspend`]: body `{ "reason": "<1–200 chars>" }`, confirm `SUSPEND {id}`.
     - **Resume** [`kernel.resume`]: no body, confirm `RESUME {id}`, `approverOnly`.
     - **Wake** [`kernel.wake`]: no body, confirm `WAKE {id}`. Show it only for `supervisor`, `signal-analyst` and `auditor`.
     - **Add principal** [`kernel.principal_add`]: body `{ "access_identity": "<Access email or service-token Client ID>" }`, confirm `PRINCIPAL {id}`, `approverOnly`.
     - **Remove principal** [`kernel.principal_remove`]: `DELETE /v1/agents/{id}/principals/{id}`, confirm `REVOKE {id}`, `approverOnly`.
     - **Hide both principal buttons** when `host_worker === "cryptophys-ai-kernel"`; the kernel always refuses them (TP-022).
3. **Reports** (`#/reports`) [`kernel.reports`]:
   - query `agent_id`, `kind` (one of `signal_digest`, `audit_digest`, `platform_digest`, `xauusd_digest`, `hud_digest`) and `limit`, from 1 to 100;
   - show severity, kind, agent, subject, time and ai_status;
   - expand a row to show the body as pretty JSON in a `<pre>`, written with `textContent`.
4. **Recovery** (`#/recovery`):
   - **List** [`recovery.plans`]: filter `status`.
   - **Detail** (`#/recovery/<plan_id>`) [`recovery.plan`].
   - **Create** [`recovery.create`], confirm `CREATE PLAN`. Body:

     ```json
     { "service_id": "<registry id>", "plan_version": "<≤40>", "title": "<≤160>", "rationale": "<≤2000>",
       "steps": [ { "action": "<one of below>", "description": "<1–500>" } ] }
     ```

     - 1 to 20 steps;
     - `action` is one of: `rollback_worker_version`, `redeploy_commit`, `disable_service`, `restore_d1_bookmark`, `rotate_secret`, `manual`;
     - `service_id` is a select filled from [`registry.services`].
   - **Approve** [`recovery.approve`]: no body, confirm `APPROVE {id13}`, `approverOnly`.
     - Hide it when `plan.created_by === whoami.actor`, because separation of duties means the server refuses it.
     - Show a warning when `created_by` starts with `agent:`: "proposed by an agent; check it before approving".
   - **Start execution** [`recovery.execute_start`]: body `{ "phase": "start", "operator_acknowledged": true, "notes": "<optional ≤2000>" }`.
     - It requires a checkbox "I have read the steps".
     - Confirm `START {id13}`.
   - **Finish execution** [`recovery.execute_finish`]: body `{ "phase": "finish", "outcome": "completed"|"failed", "notes": "<optional>" }`, confirm `FINISH {id13}`.
   - **Disable** [`recovery.disable`]: no body, confirm `DISABLE {id13}`.
   - **Button visibility by plan status:**
     - approve: `draft`;
     - start: `approved`;
     - finish: `executing`;
     - disable: any status except `executing`.
5. **Services & Drift** (`#/services`):
   - **One table** joining [`registry.services`] and [`drift.list`] by service id: display name, status, desired version, observed version, drifted, and last observed.
   - **"Observe now"** [`drift.observe`]: body `{}`. No typed confirm, but disable the button for 30 s after a click.
   - **Edit service** [`registry.upsert`], confirm `UPDATE {id}`. Body:

     ```json
     { "display_name": "<≤120>", "environment": "development|preview|production",
       "status": "registered|healthy|degraded|unavailable|disabled", "endpoint": "<optional https URL>",
       "metadata": { "owner": "…", "purpose": "…", "data_classification": "public|internal|confidential|restricted", "…": "…" } }
     ```

     Prefill the form from [`registry.service`]. Keep unknown `metadata` keys unchanged.
   - **Set desired version** [`registry.desired_version`]: body `{ "desired_version": "<7–40 hex>" }`, confirm `VERSION {id}`.
6. **Policy** (`#/policy`):
   - **Decisions** [`policy.decisions`, query `limit`]. Click a row to load the detail [`policy.decision`] and show the evidence as JSON.
   - **Evaluate** [`policy.evaluate`]: body `{ "action": "…", "resource": "…", "context": { … } }`.
     - Context is a JSON textarea, validated with `JSON.parse` before sending, and it must be an object.
     - No confirm: evaluation only records a decision.
7. **Audit** (`#/audit`):
   - **Events** [`audit.events`, query `limit`, `event_type`, `subject`]. Click a row to load the detail [`audit.event`].
   - **"Verify chain"** [`audit.verify`]: show `valid`, `events_checked`, and `first_invalid_event_id` if any.
   - **"Export JSON":** download the currently loaded events and the last verify result as one JSON file.
     - Use a `Blob` and an `<a download>`, and revoke the object URL afterwards.
     - No server call beyond the two GETs.
8. **Deploy** (`#/deploy`) [`orchestrator.deploy`]: body `{ "commit_sha": "<40 hex>", "confirm_production": "DEPLOY" }`.
   - Validate the SHA client-side.
   - Confirm `DEPLOY {first 12}`.
   - Show the orchestrator's response as is. It may be 403 (not on the deploy list) or 503 (not configured); that is expected.

### 4. `UI_ROUTES` (exactly these 34 ids; each must equal an allow-list row)

| id | service | method | path | approverOnly | confirm |
|---|---|---|---|---|---|
| platform.overview | platform | GET | /v1/overview | false | null |
| kernel.kernel | kernel | GET | /v1/kernel | false | null |
| kernel.status | kernel | GET | /v1/status | false | null |
| kernel.reports | kernel | GET | /v1/reports | false | null |
| kernel.agents | kernel | GET | /v1/agents | false | null |
| kernel.agent | kernel | GET | /v1/agents/{id} | false | null |
| kernel.agent_actions | kernel | GET | /v1/agents/{id}/actions | false | null |
| kernel.agents_disabled | kernel | POST | /v1/kernel/agents-enabled | false | AGENTS OFF |
| kernel.agents_enabled | kernel | POST | /v1/kernel/agents-enabled | true | AGENTS ON |
| kernel.wake | kernel | POST | /v1/agents/{id}/wake | false | WAKE {id} |
| kernel.suspend | kernel | POST | /v1/agents/{id}/suspend | false | SUSPEND {id} |
| kernel.resume | kernel | POST | /v1/agents/{id}/resume | true | RESUME {id} |
| kernel.principal_add | kernel | POST | /v1/agents/{id}/principals | true | PRINCIPAL {id} |
| kernel.principal_remove | kernel | DELETE | /v1/agents/{id}/principals/{id} | true | REVOKE {id} |
| recovery.plans | recovery | GET | /v1/plans | false | null |
| recovery.plan | recovery | GET | /v1/plans/{id} | false | null |
| recovery.create | recovery | POST | /v1/plans | false | CREATE PLAN |
| recovery.approve | recovery | POST | /v1/plans/{id}/approve | true | APPROVE {id13} |
| recovery.execute_start | recovery | POST | /v1/plans/{id}/executions | false | START {id13} |
| recovery.execute_finish | recovery | POST | /v1/plans/{id}/executions | false | FINISH {id13} |
| recovery.disable | recovery | POST | /v1/plans/{id}/disable | false | DISABLE {id13} |
| registry.services | registry | GET | /v1/services | false | null |
| registry.service | registry | GET | /v1/services/{id} | false | null |
| registry.upsert | registry | PUT | /v1/services/{id} | false | UPDATE {id} |
| registry.desired_version | registry | PUT | /v1/services/{id}/desired-version | false | VERSION {id} |
| policy.decisions | policy | GET | /v1/decisions | false | null |
| policy.decision | policy | GET | /v1/decisions/{id} | false | null |
| policy.evaluate | policy | POST | /v1/evaluate | false | null |
| drift.list | drift | GET | /v1/drift | false | null |
| drift.observe | drift | POST | /v1/observe | false | null |
| audit.events | audit | GET | /v1/events | false | null |
| audit.event | audit | GET | /v1/events/{id} | false | null |
| audit.verify | audit | GET | /v1/verify | false | null |
| orchestrator.deploy | orchestrator | POST | /v1/deployments | false | DEPLOY {sha12} |

Several ids share an allow-list row, which is fine. `drift.get` (`GET /v1/drift/{id}`) is allowed but unused; leave it unused.

In `confirm`:
- `{id}` is the route's first path parameter;
- `{id13}` is its first 13 characters;
- `{sha12}` is the first 12 characters of `commit_sha`.

## Budget

No change to the server. One Console request plus one Service Binding call per click. The only timer is the 60-second Mission Control refresh, which runs only while the tab is visible.

## Acceptance criteria (one `test()` per criterion, in `console-tp024.test.ts`)

1. **Route table.** `UI_ROUTES` has exactly the 34 ids of §4, with those fields. Every entry, with `{id}` filled in, matches a `CONSOLE_ALLOW_LIST` row by service, method and path.
2. **Approver flags.** Exactly these ids are `approverOnly`:
   - `kernel.agents_enabled`
   - `kernel.resume`
   - `kernel.principal_add`
   - `kernel.principal_remove`
   - `recovery.approve`
3. **Confirmations.** Every non-GET entry has a non-null `confirm`, except `policy.evaluate` and `drift.observe`. Every GET entry has `confirm: null`.
4. **No unsafe DOM or eval.** The served JS and CSS, fetched through the Worker as `OPERATOR_JWT`, contain none of the strings in §1.2. The HTML contains no `<script>` without `src`, no `style=` and no ` on` event attribute.
5. **Assets and headers.**
   - every `/assets/*` file referenced by the HTML returns 200 with the right content type and the TP-023 security headers;
   - an unknown `/assets/x.js` returns 404;
   - `/` still has the exact CSP;
   - an outsider gets 403 on every asset.
6. **Single call path.** The client JS contains exactly one `fetch(` call site, inside `api()`. Every `/api/` string literal in the client is either `/api/whoami` or built from `UI_ROUTES`.
7. **Embedded table.** The JSON that the client JS embeds equals `JSON.stringify(UI_ROUTES)`. Check it by extracting it from the served JS.
8. **No regressions.**
   - `console-tp023.test.ts` passes unchanged;
   - typecheck is clean;
   - `npm test` is above 153, with 0 fail, 0 skipped and 0 todo;
   - the console dry-run succeeds.

## Definition of done

Follow "Definition of done" in `ANTIGRAVITY.md`, and paste the **real** output tails into `STATUS.md`. From `workers/control-plane-shared`:

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npx wrangler deploy --dry-run --config ../console/wrangler.toml --outdir /tmp/dry-console
```

**State honestly who wrote the code and what was run.** Write in `STATUS.md` only what you yourself observed. Never write that the orchestrator validated anything; only the orchestrator writes that, in `APPROVAL.md`.

## After merge (orchestrator only)

1. Deploy Console through ops-dispatch. The smoke tests are unchanged.
2. Render the UI locally with Playwright against the Worker and fake bindings, at desktop and 360 px widths. Check each screen, the confirm modals, and the approver gating for an operator and for an approver.
3. **Owner:** sign in at `https://console.cryptophys.work` and try a harmless action, for example Observe now or Verify chain.
