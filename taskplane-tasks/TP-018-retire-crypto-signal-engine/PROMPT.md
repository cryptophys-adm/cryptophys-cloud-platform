# TP-018: Retire the crypto Signal Engine (code side)

- **Worker:** pi (see `taskplane-tasks/PI.md`).
- **Depends on:** TP-017, merged and live. The Signal Analyst already reads XAUUSD.
- **Branch:** `worker/TP-018-retire-signal-engine`.
- **PR title:** `TP-018: retire the crypto Signal Engine`.

## Why

Owner decision, 2026-11-05 (recorded in `CONTEXT.md`): the platform's signal role moved to `xauusd-ai-trading-assistant`, and the crypto Signal Engine (BTC/ETH/SOL from Kraken) is retired.

- This task removes every **code** dependency on it.
- The orchestrator then changes the deploy workflows. After this PR is deployed, and only with the owner's explicit confirmation, the orchestrator deletes the Worker `cryptophys-signal-engine` from Cloudflare.

**Data is kept.** Do not drop or alter any crypto table: `market_candles`, `signal_*`, `macro_context`, `signal_ingest_runs`. They stay as history.

## Read first (and nothing else)

- `workers/control-plane-shared/src/capabilities.ts`: the `CAPABILITIES` map.
- `workers/ai-kernel/src/syscall.ts`: `SignalRpcBinding`, `SyscallEnv.SIGNALS`, `observe()` (the `ingest_runs` query and key), and the `signals.reingest` handler case.
- `workers/ai-kernel/src/supervisor.ts`: the header comment, the `Observation` type, and the ingest block (around lines 145–162).
- `workers/ai-kernel/src/index.ts`: the `/ready` checks (`signals_binding`).
- `workers/ai-kernel/wrangler.toml`: the `SIGNALS` binding and the cron comment.
- `workers/drift-detector/src/index.ts`: `targets()` and `observe()`, around lines 40–190.
- `workers/drift-detector/wrangler.toml`: the `SVC_SIGNAL_ENGINE` binding.
- `workers/control-plane-migrations/0010_ai_worker_os.sql`, lines 50–60, and `0016_platform_and_xauusd_agents.sql`, lines 39–42: the supervisor and signal-engine agent rows.
- `workers/control-plane-shared/test/ai-kernel.test.ts`, `agent-bindings.test.ts` and `workflows.test.ts`: the parts that use the Signal Engine.

## Files you may change or delete

**Delete** (the code being retired, with its own tests):

- the whole directory `workers/signal-engine/`;
- `workers/control-plane-shared/test/signal-engine.test.ts` (10 tests);
- `signal-indicators.test.ts` (1 test);
- `mizan.test.ts` (5 tests);
- `revised.test.ts` (5 tests).

**Change:**

- `workers/control-plane-migrations/0020_retire_signal_engine.sql` (new);
- `workers/control-plane-shared/src/readiness.ts`;
- `workers/control-plane-shared/src/capabilities.ts`;
- `workers/ai-kernel/src/syscall.ts`, `supervisor.ts` and `index.ts`;
- `workers/ai-kernel/wrangler.toml`;
- `workers/drift-detector/src/index.ts` and `wrangler.toml`;
- `workers/control-plane-shared/test/workflows.test.ts`: remove **only** the 5 Signal Engine ingest Workflow tests and their imports and helpers. All recovery-lifecycle tests stay untouched.
- `workers/control-plane-shared/test/agent-bindings.test.ts`:
  - remove only the test "Signal Engine: its agent reports failed series…" and its import;
  - drop `"signal-engine"` from the worker list in "every platform Worker binds AgentRpc…".
- `workers/control-plane-shared/test/ai-kernel.test.ts`, `agent-memory.test.ts`, `auditor.test.ts`, `external-agents.test.ts`, `signal-analyst.test.ts`: only what breaks because of this specification. **Rewrite** those assertions for the new behaviour. Never delete or skip a test to make it pass.
- `workers/control-plane-shared/test/retire-signal-engine-tp018.test.ts` (new);
- `taskplane-tasks/TP-018-retire-crypto-signal-engine/STATUS.md`.

**Do not touch:**

- `.github/*`; the orchestrator changes the workflows;
- any other Worker;
- earlier migrations;
- the xauusd repository.

## Specification

### 1. Migration `0020_retire_signal_engine.sql` (no `DROP`, no `DELETE`)

1. `UPDATE service_registry SET status = 'disabled', updated_at = '2026-11-05T14:00:00.000Z' WHERE service_id = 'cryptophys-signal-engine';`
2. `UPDATE agents SET status = 'suspended', status_reason = 'retired: crypto Signal Engine (owner decision 2026-11-05)', updated_by = 'migration:0020', updated_at = '2026-11-05T14:00:00.000Z' WHERE agent_id = 'signal-engine';`
3. **Remove `signals.reingest` from the supervisor grants**, keeping every other grant in order:

   ```sql
   UPDATE agents SET capabilities_json = (SELECT json_group_array(value) FROM json_each(agents.capabilities_json) WHERE value <> 'signals.reingest'),
     updated_by = 'migration:0020', updated_at = '2026-11-05T14:00:00.000Z'
   WHERE agent_id = 'supervisor';
   ```

   The supervisor keeps `tier_max = 2`. That is its ceiling, even when no tier-2 capability exists.
4. Set `REQUIRED_MIGRATION` to `0020_retire_signal_engine.sql`, and add `"0019_ai_failures.sql"` to `REQUIRED_MIGRATIONS`.

### 2. Capabilities (`capabilities.ts`)

- Remove `"signals.reingest"` from `CAPABILITIES`. No tier-2 capability remains. That is intended.
- Update the descriptions:
  - `"platform.observe"` becomes "Read drift, recovery plans, agent state and the 24 h report summary";
  - `"signals.observe"` becomes "Read the latest XAUUSD advisory decisions from xauusd-ai-trading-assistant".
- Remove any comment that names `SignalRpc`.

### 3. AI Kernel

- `syscall.ts`:
  - remove `SignalRpcBinding`, `SyscallEnv.SIGNALS` and the `signals.reingest` case;
  - in `observe()`, remove the `signal_ingest_runs` query and the `ingest_runs` key;
  - all other keys stay unchanged, including `agent_reports_24h`.
- `supervisor.ts`:
  - remove the ingest rule (stale or failing ingestion leading to `signals.reingest`), the `ingest_runs` field and the `last_reingest` memory use;
  - update the header comment;
  - the drift rule (`recovery.propose`) is unchanged.
- `index.ts`: remove `signals_binding` from `/ready`. Readiness must not depend on the Signal Engine.
- `wrangler.toml`: remove the `SIGNALS` service binding. Rewrite the cron comment so it no longer mentions Signal Engine timing.

### 4. Drift Detector

- Remove `SVC_SIGNAL_ENGINE` from `wrangler.toml` and from `targets()` and the `Env` type.
- In `observe()`, a registry row with `status = 'disabled'` is **not probed**. Record its observation with:
  - `drifted = 0`;
  - `reasons = ["disabled"]`;
  - `status = "disabled"`;
  - no version.

  It must never count as drifted and never trigger an alert or a recovery proposal. Rows that are not disabled behave exactly as today.

### 5. Do not

- Remove `signals.observe`. It now reads XAUUSD (TP-017).
- Change the Signal Analyst, Auditor, reports or memory behaviour.
- Touch any crypto data table.

## Budget

- One Worker less, so fewer cron invocations. The Signal Engine ran every 15 minutes.
- No new crons and no AI calls.
- The supervisor's cycle gets shorter.

## Acceptance criteria (one `test()` per criterion, in `retire-signal-engine-tp018.test.ts`)

1. **Migration.** After all migrations:
   - `cryptophys-signal-engine` is `disabled` in the registry;
   - agent `signal-engine` is `suspended` with that reason;
   - the supervisor grants equal the 0010 / 0014 grants minus `signals.reingest`, in the same order;
   - the supervisor `tier_max` is still 2;
   - the crypto tables still exist, and their rows are untouched.
2. **Catalog.** `CAPABILITIES["signals.reingest"]` is undefined. A syscall of `signals.reingest` by the supervisor is **denied**: unknown capability or not granted. It is never executed.
3. **Observe.** `observe()` has no `ingest_runs` key and still returns `services`, `open_agent_plans`, `agents_enabled` and `agent_reports_24h`.
4. **Supervisor.** With fresh drift and stale or failing ingest rows in `signal_ingest_runs`, a cycle produces no `ingest` finding and calls no `signals.*` capability. A persistent drift still produces `recovery.propose`.
5. **Readiness.** The kernel `/ready` is 200 without any `SIGNALS` binding, and its checks contain no `signals_binding`.
6. **Disabled service.** A registry row with status `disabled` and no observation binding gets `drifted = 0`, `reasons = ["disabled"]` and `status` `disabled`, and it is not probed (assert with a binding spy). A non-disabled row without a binding is still drifted, `no_observation_binding`, as today.
7. **Bindings.** No `wrangler.toml` under `workers/` references `cryptophys-signal-engine`, and the directory `workers/signal-engine` no longer exists. Test this by reading the files.
8. **No regressions.**
   - `npm run typecheck` is clean.
   - `npm test` has 0 failures, 0 skipped and 0 todo.
   - Expected count: 137 − 21 (the four deleted files) − 5 (ingest Workflow tests) − 1 (Signal Engine agent test) + your new tests. State the exact before and after numbers in `STATUS.md`.

## Definition of done

Follow "Definition of done" in `ANTIGRAVITY.md`. Paste the **real** output tails into `STATUS.md`. Then dry-run the changed Workers:

```bash
for d in ai-kernel drift-detector; do npx wrangler deploy --dry-run --config ../$d/wrangler.toml --outdir /tmp/dry-$d; done
```

Neither dry-run may list `cryptophys-signal-engine`.

In `STATUS.md`, list every test file you changed, and why.

## After merge (orchestrator only, in this order)

1. **Workflows:**
   - remove `signal-engine` from `DEPLOY_ORDER` and `EXPECTED_WORKERS` in `deploy-control-plane.yml`;
   - remove it from the Worker list in `provision-access.yml`;
   - update the expected list in `.github/scripts/drift-summary.sh`.
2. **Deploy Control Plane**, which applies migration 0020 and redeploys the AI Kernel and the Drift Detector without the binding. Verify:
   - drift is 0, with `cryptophys-signal-engine` shown as `disabled`;
   - the supervisor runs without `signals.reingest`.
3. **Owner confirmation, then delete the Worker** `cryptophys-signal-engine` from Cloudflare. This is irreversible. Verify that it is absent and that drift is still 0.
