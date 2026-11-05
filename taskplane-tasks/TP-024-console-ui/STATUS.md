# TP-024 status

State: done

Branch `worker/TP-024-console-ui` from `origin/main` at `ac09dd9`.

## Who wrote what

- **agy (Antigravity CLI):** `workers/console/src/ui.ts`, `src/ui/routes.ts`, `src/ui/css.ts` and `src/ui/app-js.ts`. Its run ended with a quota error (HTTP 429) before it wrote any tests or docs.
- **pi:** `workers/control-plane-shared/test/console-tp024.test.ts` (8 tests) and the `docs/OPERATIONS.md` paragraph. pi left agy's UI files unchanged.
- **Claude Code session:**
  - in that test file, test 1 now compares every field against the §4 table, which is generated from PROMPT.md, and test 8 checks the TP-023 surface (33 allow-list rows, CSP, whoami, `/api/kernel/mcp` → 404);
  - ran the three commands below and wrote this file.

## Evidence

Run from `workers/control-plane-shared` on the committed tree, one command at a time. Output tails as observed.

### `npm run typecheck`

```

> @cryptophys/control-plane@1.0.0 typecheck
> tsc --noEmit -p ../control-plane-tsconfig.json

typecheck exit=0
```

### `npm test` (baseline on `ac09dd9`: 153 tests)

```
ok 81 - 1. route table: exactly the 34 ids with those fields, matching allow-list rows
ok 82 - 2. approver flags: exactly the five approverOnly ids
ok 83 - 3. confirmations: non-GET have confirm except policy.evaluate and drift.observe; GET have null
ok 84 - 4. no unsafe DOM or eval in served JS/CSS and HTML has no inline script/style/on*
ok 85 - 5. assets and headers: referenced assets 200 with right type and security headers; unknown 404; exact CSP; outsider 403
ok 86 - 6. single call path: one fetch( in client, /api/ literals only whoami or built
ok 87 - 7. embedded table equals JSON.stringify(UI_ROUTES)
ok 88 - 8. no regressions: the TP-023 server surface is unchanged (allow-list, CSP, whoami, forwarding)
1..161
# tests 161
# suites 0
# pass 161
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 37813.674653
test exit=0
```

### `npx wrangler deploy --dry-run --config ../console/wrangler.toml --outdir /tmp/dry-console`

```
 ⛅️ wrangler 4.156.2 (update available 4.158.0)
───────────────────────────────────────────────
Total Upload: 59.20 KiB / gzip: 16.91 KiB
Your Worker has access to the following bindings:
Binding                                                            Resource                     
env.KERNEL (cryptophys-ai-kernel)                                  Worker                       
env.RECOVERY (cryptophys-recovery-manager)                         Worker                       
env.REGISTRY (cryptophys-platform-registry)                        Worker                       
env.POLICY (cryptophys-policy-engine)                              Worker                       
env.DRIFT (cryptophys-drift-detector)                              Worker                       
env.AUDIT (cryptophys-audit-ledger)                                Worker                       
env.ORCHESTRATOR (cryptophys-deployment-orchestrator)              Worker                       
env.PLATFORM (cryptophys-platform-api)                             Worker                       
env.CF_VERSION_METADATA                                            Worker Version Metadata      
env.SERVICE_NAME ("cryptophys-console")                            Environment Variable         
env.SERVICE_ENVIRONMENT ("production")                             Environment Variable         
env.API_CONTRACT_VERSION ("v1")                                    Environment Variable         

--dry-run: exiting now.
dry-run exit=0
```

### Other checks run

- `git diff --quiet origin/main -- workers/control-plane-shared/test/console-tp023.test.ts workers/console/wrangler.toml workers/console/src/index.ts .github`: no differences.
- `grep -nE 'innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|setAttribute\("on' workers/console/src/ui.ts workers/console/src/ui/*.ts`: no matches.
- `ui/app-js.ts` has exactly one `fetch(` (inside `api()`). Its only timers are the 60 s Mission Control refresh, which returns unless `document.visibilityState === "visible"`, and the 30 s re-enable of "Observe now".

## Changes

- `workers/console/src/ui.ts`: the shell, with a header, nav (8 screens plus "Nexus ↗" with `target="_blank" rel="noopener noreferrer"`), a dismissible error banner and a status line. It re-exports `APP_JS` and `APP_CSS`.
- `workers/console/src/ui/routes.ts` (new): `UI_ROUTES`, the 34 ids of §4.
- `workers/console/src/ui/app-js.ts` (new): the client JS.
  - Behaviour:
    - `UI_ROUTES` is embedded with `JSON.stringify`;
    - every API call goes through `call(routeId, params, body, query)`, which checks identifiers and then calls `api()`;
    - every state-changing route opens a typed-confirmation modal, except `policy.evaluate` and `drift.observe`;
    - approver-only buttons are hidden unless `whoami.approver`;
    - plan buttons follow the plan status;
    - principal buttons are hidden for `cryptophys-ai-kernel` agents, and Wake is shown only for supervisor, signal-analyst and auditor;
    - Export JSON uses a `Blob` with `<a download>` and `revokeObjectURL`;
    - there are no trading actions.
  - Screens: Mission Control, Agents, Reports, Recovery, Services & Drift, Policy, Audit and Deploy.
- `workers/console/src/ui/css.ts` (new): styles, including visible focus and a narrow-width layout.
- `workers/console/src/index.ts`: unchanged. `/assets/app.js` and `/assets/app.css` are still the only assets.
- `workers/control-plane-shared/test/console-tp024.test.ts` (new): 8 tests, one per acceptance criterion.
- `docs/OPERATIONS.md`: added the screens and approver rules to the Console paragraph.
- No npm dependency added, no CDN used, nothing deployed.
- Revert: revert the commit.

## Open questions

- The §4 request bodies were used as given; the target Workers' source was not read. Not done here: a rendered-browser check at desktop and 360 px widths (the PROMPT lists it as an orchestrator step after merge).

## Owner-requested corrections and follow-up validation (2026-11-06)

The owner requested five corrections in PR comment #6665811379. They are implemented on this branch:

1. **Safe path identifiers:** after validating the full identifier against SAFE, call() now inserts it unchanged rather than percent-encoding it. Regression test 9 sends a DELETE request with ops@cryptophys.work:svc+1 through the Console Worker and verifies the recording Service Binding receives the exact unencoded path.
2. **Mission Control overview:** reads the actual observe() shape:
   - services for drift count and service IDs, marking persistent drift;
   - open_agent_plans for the count and #/recovery/<plan_id> links;
   - agent_reports_24h.counts and latest_critical, shown as count plus agent/kind/time rows;
   - only decision, confidence, candle_key, and decided_at from xauusd_latest; an error is displayed as unavailable.
3. **Approval wording:** now says, “Approval is recorded under your identity. You cannot approve a plan you authored.” Any eligible operator may start the execution after a different person approves.
4. **Input limits:** added maxLength to PLAIN_PROPS, so the declared limits are applied to DOM controls.
5. **Audit export:** object URL revocation is deferred with setTimeout(..., 0) until after the click task.

The follow-up also adds tests 9–12 for the path-forwarding fix, the observe() field contract, maxLength and separation-of-duties copy, and deferred object-URL revocation.

### Validation observed on code head 4230c4469bbc113e3b5ddb923de91ab001fa04e8

- Validate run #42084745936: SUCCESS, all 3 jobs.
- Validate Control Plane Workers #42084745943: SUCCESS.
- npm run typecheck: PASS.
- npm test: 165 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo.
- Migration tests: PASS (initial schema, forward migration, data preservation, indexes, CHECK constraints, foreign keys, service-scoped idempotency, fail-closed rollback).
- Dry-run bundles: all 7 platform Workers, including Console, completed successfully without credentials. Console bundle: 60.80 KiB (17.24 KiB gzip).
- The first attempt at commit 80015204 failed TypeScript parsing in the new test regexes; those assertions were corrected in 4230c446, and the final validation above passed.

### Remaining verification

The owner’s Chromium render at 1280 px and 360 px was performed on the pre-correction head. A rendered-browser recheck after these five fixes has not yet been run. No production workflow was dispatched and nothing was deployed by this follow-up.
