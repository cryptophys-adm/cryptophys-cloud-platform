# TP-026: Register the Console and Cerebrum home in the Platform Registry and the Drift Detector

- **Worker:** pi (see `taskplane-tasks/PI.md`).
- **Depends on:** TP-025 (deployed and verified).
- **Branch:** `worker/TP-026-register-console-home`.
- **PR title:** `TP-026: register cryptophys-console and cryptophys-home for drift observation`.

## Why

`cryptophys-console` and `cryptophys-home` are live, but they are not in the Platform Registry and the Drift Detector never probes them. If either one breaks or runs an unexpected version, nobody is told.

The other platform Workers are registered (migration 0003) and probed over their `HealthRpc` entrypoint. Both new Workers already export `HealthRpc` (`workers/console/src/worker.ts`, `workers/home/src/worker.ts`).

## Read first (and nothing else)

- `workers/control-plane-migrations/0003_control_plane_services.sql`, from line 31 to the end: the registry insert style.
- `workers/control-plane-migrations/0021_supervisor_tier_1.sql` and `workers/control-plane-shared/src/readiness.ts`: `REQUIRED_MIGRATION` and `REQUIRED_MIGRATIONS`.
- `workers/drift-detector/wrangler.toml`: the `[[services]]` blocks with `entrypoint = "HealthRpc"`.
- `workers/drift-detector/src/index.ts`, lines 20–70 (`Env`, `targets()`) and 143–210 (`observe()`).
- `workers/control-plane-shared/test/control-plane.test.ts`, around lines 167 and 347: the two `services.length, 13` assertions.
- `workers/control-plane-shared/test/control-plane.test.ts`, around line 311: the drift-detector env with `SVC_*: healthy("…")` bindings, the pattern to reuse.

## Files you may change

- `workers/control-plane-migrations/0022_register_console_and_home.sql` (new)
- `workers/control-plane-shared/src/readiness.ts`
- `workers/drift-detector/wrangler.toml`: two new `[[services]]` blocks only.
- `workers/drift-detector/src/index.ts`: `Env` and `targets()` only.
- Tests in `workers/control-plane-shared/test/`: only the assertions and fixtures that break because there are now 15 registered services and two more probe bindings. **Rewrite** them; never delete or skip them. List each one in `STATUS.md` under "Rewritten assertions".
- `workers/control-plane-shared/test/register-tp026.test.ts` (new)
- `docs/OPERATIONS.md`: the registry and drift inventory text.
- `taskplane-tasks/TP-026-register-console-home/STATUS.md`

**Do not touch** `.github/*`, the Console or home Worker source, any other Worker, or any merged migration.

## Specification

### 1. Migration `0022_register_console_and_home.sql`

```sql
-- 0022: register the operator Console and the Cerebrum home portal (ADR-0008) for drift observation.
-- desired_version is set by their deploy workflows.
INSERT OR IGNORE INTO service_registry
  (service_id, display_name, environment, status, metadata_json, created_at, updated_at)
VALUES
  ('cryptophys-console', 'Console', 'production', 'registered',
   '{"owner":"cryptophys-adm","purpose":"Operator console: allow-listed forwarding with the operator''s own Access JWT (ADR-0008)","data_classification":"internal","source":"workers/console"}',
   '2026-11-06T01:00:00.000Z', '2026-11-06T01:00:00.000Z'),
  ('cryptophys-home', 'Cerebrum Home', 'production', 'registered',
   '{"owner":"cryptophys-adm","purpose":"Read-only home portal and navigation (ADR-0008)","data_classification":"internal","source":"workers/home"}',
   '2026-11-06T01:00:00.000Z', '2026-11-06T01:00:00.000Z');
```

- Nothing else.
- Set `REQUIRED_MIGRATION` to `0022_register_console_and_home.sql`, and add `0021_supervisor_tier_1.sql` to `REQUIRED_MIGRATIONS`, following the existing pattern.

### 2. Drift Detector bindings

**`wrangler.toml`.** Add these two blocks after `SVC_AI_KERNEL`, in the same style:

```toml
[[services]]
binding = "SVC_CONSOLE"
service = "cryptophys-console"
entrypoint = "HealthRpc"

[[services]]
binding = "SVC_HOME"
service = "cryptophys-home"
entrypoint = "HealthRpc"
```

**`src/index.ts`:**
- add `SVC_CONSOLE: HealthRpcBinding;` and `SVC_HOME: HealthRpcBinding;` to `Env`;
- add `"cryptophys-console": env.SVC_CONSOLE` and `"cryptophys-home": env.SVC_HOME` to `targets()`.

Change nothing else in `observe()`.

## Budget

- Two more `HealthRpc` calls per observation, every 15 minutes, plus two D1 rows per observation, pruned at 90 days by TP-021.
- No new Worker, cron or AI.

## Acceptance criteria (one `test()` per criterion, in `register-tp026.test.ts`)

1. **Migration.** After all migrations:
   - `service_registry` has 15 rows;
   - `cryptophys-console` and `cryptophys-home` are `production`, `registered`, with `desired_version` NULL, and metadata with `owner`, `purpose`, `data_classification = "internal"` and the right `source`;
   - `REQUIRED_MIGRATION` is 0022, and `schemaReady` is true.
2. **Probed and healthy.** Use the existing drift-detector test pattern with fake `SVC_CONSOLE` and `SVC_HOME` `HealthRpc` bindings that return a healthy body with a version tag. Run `observe()`. Both services are `healthy`, and `drifted: false`.
   - Before a desired version is set, `reasons` contains `desired_version_unset`, and `managed` is false.
3. **Managed.** Set the desired version of both to the probed tag through the registry's `PUT /v1/services/{id}/desired-version`, as the deploy workflows will. Observe again: both are `managed: true`, `drifted: false`, `status: "healthy"`.
4. **Real drift.**
   - **Version mismatch:** `SVC_CONSOLE` returns a different tag than the desired version, so `cryptophys-console` is `drifted: true` with reason `version_mismatch`, and `cryptophys-home` stays healthy.
   - **Unreachable:** `SVC_HOME` throws, so `cryptophys-home` is `drifted: true` and `unavailable`.
5. **Binding missing.** Without `SVC_CONSOLE` in the env, `cryptophys-console` reports `no_observation_binding`. This proves the binding is what makes it observable.
6. **No regressions.**
   - typecheck is clean;
   - `npm test` is above 179, with 0 fail, 0 skipped and 0 todo;
   - `python3 ../control-plane-migrations/test_migrations.py` passes;
   - every rewritten assertion is listed in `STATUS.md`.

## Definition of done

Follow "Definition of done" in `ANTIGRAVITY.md`. From `workers/control-plane-shared`, run:

```bash
npm run typecheck
```

```bash
npm test
```

```bash
python3 ../control-plane-migrations/test_migrations.py
```

```bash
npx wrangler deploy --dry-run --config ../drift-detector/wrangler.toml --outdir /tmp/dry-drift
```

In `STATUS.md`:
- under "Who wrote what", say who wrote each file;
- paste the **actual last lines** each command printed (the `# tests / # pass / # fail` block, the `tsc` line, the migration test result and the `Total Upload` line); a summary is not the output;
- write only what you yourself observed. Never write that the orchestrator validated anything.

## After merge (orchestrator only)

1. **Deploy Control Plane.** It applies 0022 and redeploys the Drift Detector with the two bindings.
   - In the minutes between the migration and the Drift Detector deploy, a scheduled observation could report `no_observation_binding` for the two new rows.
   - **Deploy outside the :00/:15/:30/:45 cron minutes,** and treat a single alert in that window as expected.
2. **Record desired versions.** Add `record-desired-version.sh cryptophys-console|cryptophys-home "$COMMIT_SHA"` as the last step of `deploy-console.yml` and `deploy-home.yml`. Redeploy both so their desired versions are recorded.
3. **Verify.** `POST /v1/observe` shows both services `managed`, `healthy` and not drifted, and the deploy verification is still green.
