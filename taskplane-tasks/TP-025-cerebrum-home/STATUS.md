# TP-025 status

State: implementation corrections pushed; independent review and the exact Home Worker dry-run remain outstanding.

## Who wrote what

- Initial Worker scaffold (workers/home/wrangler.toml, package.json, tsconfig.json, README.md, src/index.ts, src/worker.ts, src/ui.ts, src/ui/css.ts, src/ui/app-js.ts), workers/control-plane-tsconfig.json, and the initial test file were committed in d4a305c; GitHub records the author as cryptophys-adm.
- The first correction pass was committed in 88bd2f0; GitHub records the author as cryptophys-adm.
- This follow-up run created workers/home/src/ui/summary.ts and updated workers/home/src/ui.ts, src/ui/app-js.ts, src/ui/css.ts, and workers/control-plane-shared/test/home-tp025.test.ts in commit 10597b1. GitHub records the commit author as cryptophys-adm.
- This STATUS file is being updated with the actual GitHub Actions output below.
- docs/OPERATIONS.md is not changed by this PR; no claim is made that it was changed.

## Evidence

Current source commit: 10597b1c76832b58a106d3da98a4b57fe6fe902b.

### Type-check output tail

Command: npm run typecheck

```text
> @cryptophys/control-plane@1.0.0 typecheck
> tsc --noEmit -p ../control-plane-tsconfig.json
```

The GitHub Actions step completed successfully; the following test step started, so the command exited with status 0.

### Test output tail

Command: npm test

```text
1..178
# tests 178
# suites 0
# pass 178
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 9553.710203
```

### Migration test output

```text
PASS: initial schema, forward migration, data preservation, indexes, CHECK constraints, foreign keys, service-scoped idempotency, and fail-closed rollback
```

### Home Worker dry-run

Required command:

```bash
npx wrangler deploy --dry-run --config ../home/wrangler.toml --outdir /tmp/dry-home
```

NOT RUN in this validation. The current .github/workflows/validate-control-plane.yml dry-run loop bundles the existing control-plane Workers but omits home. Therefore there is no actual Total Upload line for cryptophys-home to paste. Output from another Worker is not substituted. This remains an explicit outstanding Definition-of-done item and must be run in an authorized build environment before TP-025 is declared complete.

### GitHub Actions

- Validate: run 42134171376 — success.
- Validate Control Plane Workers: run 42134171310 — success.
- The Control Plane run completed type-check, all tests, migration tests, and its configured dry-run loop. That loop did not include the Home Worker.

## Changes in this follow-up

- Added a pure exported summarize(body) formatter and embedded that same function into the served browser JavaScript.
- Added behavioural cases for the wrapped realistic response, empty/unknown response, disabled agents, null XAUUSD data, and XAUUSD error data.
- Removed the duplicate Refresh control; the single Refresh button is inside main.
- Replaced the Home button with a static current-page anchor and added the Nexus caption.
- Added the required 220px left navigation layout and mobile top-bar breakpoint.
- Put platform status, XAUUSD display-only fields, Console and Nexus tiles into separate cards.
- Aligned the background, card, and border colours with the Console.
- Replaced the assert.ok(true) placeholder with real CSP, whoami, and kernel-route assertions.
- Confirmed the empty dead-code block is absent from src/index.ts; the deploy-time configuration comment is already present in wrangler.toml.

## Outstanding

1. Run the exact Home Worker Wrangler dry-run and paste its real output tail.
2. Perform a rendered Chromium check of the final layout at desktop and 360px; the latest changes have only source-level and Worker tests so far.
3. Obtain independent review. The PR author cannot provide its own approval, and automated review services have not completed.
4. After merge, the orchestrator-owned follow-up in the TP-025 prompt remains: Access provisioning, a dedicated deploy workflow, validation inclusion, ops-dispatch wiring, and live verification. No production deployment is part of this PR.
