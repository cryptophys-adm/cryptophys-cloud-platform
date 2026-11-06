# TP-026 status

State: done

## Who wrote what

- `workers/control-plane-migrations/0022_register_console_and_home.sql`: pi.
- `workers/control-plane-shared/src/readiness.ts`: pi.
- `workers/drift-detector/wrangler.toml`: pi.
- `workers/drift-detector/src/index.ts`: pi.
- `workers/control-plane-shared/test/control-plane.test.ts`: pi.
- `workers/control-plane-shared/test/ai-diagnostics-tp016.test.ts`: pi.
- `workers/control-plane-shared/test/ai-kernel.test.ts`: pi.
- `workers/control-plane-shared/test/retire-signal-engine-tp018.test.ts`: pi.
- `workers/control-plane-shared/test/supervisor-tier1-tp022.test.ts`: pi.
- `workers/control-plane-shared/test/register-tp026.test.ts`: pi.
- `docs/OPERATIONS.md`: pi.
- `taskplane-tasks/TP-026-register-console-home/STATUS.md`: pi.

## Evidence

- `npm run typecheck`:
```
> @cryptophys/control-plane@1.0.0 typecheck
> tsc --noEmit -p ../control-plane-tsconfig.json
```

- `npm test`:
```
ℹ tests 185
ℹ suites 0
ℹ pass 185
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 43016.932232
```

- `python3 ../control-plane-migrations/test_migrations.py`:
```
PASS: initial schema, forward migration, data preservation, indexes, CHECK constraints, foreign keys, service-scoped idempotency, and fail-closed rollback
```

- `npx wrangler deploy --dry-run --config ../drift-detector/wrangler.toml --outdir /tmp/dry-drift`:
```
Total Upload: 37.28 KiB / gzip: 10.69 KiB
```

## Changes

- Created migration `0022_register_console_and_home.sql` to register `cryptophys-console` and `cryptophys-home` in `service_registry`.
- Updated `REQUIRED_MIGRATION` to `0022_register_console_and_home.sql` and added `0021_supervisor_tier_1.sql` to `REQUIRED_MIGRATIONS` in `workers/control-plane-shared/src/readiness.ts`.
- Added `SVC_CONSOLE` and `SVC_HOME` service bindings with `entrypoint = "HealthRpc"` to `workers/drift-detector/wrangler.toml`.
- Added `SVC_CONSOLE` and `SVC_HOME` to `Env` and mapped `"cryptophys-console": env.SVC_CONSOLE` and `"cryptophys-home": env.SVC_HOME` in `targets()` in `workers/drift-detector/src/index.ts`.
- Added 6 criteria acceptance tests in `workers/control-plane-shared/test/register-tp026.test.ts`.
- Updated registry and drift inventory description in `docs/OPERATIONS.md`.

## Rewritten assertions

- `workers/control-plane-shared/test/control-plane.test.ts`:
  - Updated `assert.equal(list.body.services.length, 13)` to `15` to include the two newly registered services.
  - Added `SVC_CONSOLE: healthy("aaaaaaaaaaaa")` and `SVC_HOME: healthy("aaaaaaaaaaaa")` to the drift detector test environment fixture so observation bindings remain complete and healthy.
  - Added assertions asserting `by["cryptophys-console"]` and `by["cryptophys-home"]` are healthy and not drifted.
  - Updated `assert.equal(latest.body.services.length, 13)` to `15` for the latest drift observation count.
- `workers/control-plane-shared/test/ai-diagnostics-tp016.test.ts`:
  - Updated `assert.equal(REQUIRED_MIGRATION, "0021_supervisor_tier_1.sql")` to `"0022_register_console_and_home.sql"`.
- `workers/control-plane-shared/test/ai-kernel.test.ts`:
  - Updated `assert.equal(REQUIRED_MIGRATION, "0021_supervisor_tier_1.sql")` to `"0022_register_console_and_home.sql"`.
- `workers/control-plane-shared/test/retire-signal-engine-tp018.test.ts`:
  - Updated `assert.equal(REQUIRED_MIGRATION, "0021_supervisor_tier_1.sql")` to `"0022_register_console_and_home.sql"`.
- `workers/control-plane-shared/test/supervisor-tier1-tp022.test.ts`:
  - Updated `assert.equal(REQUIRED_MIGRATION, "0021_supervisor_tier_1.sql")` to `"0022_register_console_and_home.sql"`.

## Open questions

- None.
