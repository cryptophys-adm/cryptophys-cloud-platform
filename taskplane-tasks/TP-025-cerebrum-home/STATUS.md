# TP-025 status

State: implementation and CI dry-run complete; independent review and final rendered-browser verification remain outstanding.

## Who wrote what

- Initial Worker scaffold (workers/home/wrangler.toml, package.json, tsconfig.json, README.md, src/index.ts, src/worker.ts, src/ui.ts, src/ui/css.ts, src/ui/app-js.ts), workers/control-plane-tsconfig.json, and the initial test file were committed in d4a305c; GitHub records the author as cryptophys-adm.
- The first correction pass was committed in 88bd2f0; GitHub records the author as cryptophys-adm.
- The UI, formatter, behavioural tests and dry-run test changes in commits 10597b1, 897d2c3, fe0cc82 and 8a512b2 were made in this follow-up run. GitHub records the commit author as cryptophys-adm.
- This STATUS update records actual output from GitHub Actions run 42134558381.
- docs/OPERATIONS.md is not changed by this PR; no claim is made that it was changed.

## Evidence

Validated source commit: 8a512b274a32287ec6c70fe9ea9a42a7fbc04c36.

### Type-check output tail

Command: npm run typecheck

```text
> @cryptophys/control-plane@1.0.0 typecheck
> tsc --noEmit -p ../control-plane-tsconfig.json
```

The GitHub Actions step completed successfully; the test step followed.

### Test output tail

Command: npm test

```text
1..179
# tests 179
# suites 0
# pass 179
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 6263.741357
```

The TP-025 Home Worker Wrangler dry-run is test 122 and passed.

### Home Worker dry-run output tail

Command executed by the TP-025 dry-run test from workers/control-plane-shared:

```bash
npx wrangler deploy --dry-run --config ../home/wrangler.toml --outdir <temporary-directory>
```

Actual output:

```text
⛅️ wrangler 4.156.2
────────────────────
Total Upload: 21.41 KiB / gzip: 7.17 KiB
Your Worker has access to the following bindings:
env.PLATFORM (cryptophys-platform-api)                  Worker
env.CF_VERSION_METADATA                                 Worker Version Metadata
env.SERVICE_NAME ("cryptophys-home")                    Environment Variable
env.SERVICE_ENVIRONMENT ("production")                  Environment Variable
env.API_CONTRACT_VERSION ("v1")                         Environment Variable
--dry-run: exiting now.
```

The output is from the Home Worker configuration, not another Worker. No production deployment occurred.

### Migration test output

```text
PASS: initial schema, forward migration, data preservation, indexes, CHECK constraints, foreign keys, service-scoped idempotency, and fail-closed rollback
```

### GitHub Actions

- Validate Control Plane Workers: run 42134558381 — success.
- Validate: run 42134558431 — success.
- Both runs target source commit 8a512b274a32287ec6c70fe9ea9a42a7fbc04c36.

## Changes in this follow-up

- Added a pure exported summarize(body) formatter and embedded that same function into the served browser JavaScript.
- Added behavioural cases for the wrapped realistic response, empty/unknown response, disabled agents, null XAUUSD data, and XAUUSD error data.
- Preserved the persistent-drift marker in drift service labels.
- Removed the duplicate Refresh control; the single Refresh button is inside main.
- Replaced the Home button with a static current-page anchor and added the Nexus caption.
- Added the required 220px left navigation layout and mobile top-bar breakpoint.
- Put platform status, XAUUSD display-only fields, Console and Nexus tiles into separate cards.
- Aligned the background, card, and border colours with the Console.
- Replaced the assert.ok(true) placeholder with real CSP, whoami, and kernel-route assertions.
- Added a hermetic Wrangler dry-run test for cryptophys-home; it validates the actual Home Worker bundle and records its Total Upload output.
- Confirmed the empty dead-code block is absent from src/index.ts; the deploy-time configuration comment is already present in wrangler.toml.

## Outstanding

1. Perform a rendered Chromium check of the final layout at desktop and 360px. The latest layout has Worker tests and a Wrangler bundle dry-run, but no post-change browser render has been run in this automation.
2. Obtain independent review. The PR author cannot provide its own approval, and automated review services have not completed.
3. After merge, the orchestrator-owned follow-up in the TP-025 prompt remains: Access provisioning, a dedicated deploy workflow, validation inclusion, ops-dispatch wiring, and live verification. No production deployment is part of this PR.
