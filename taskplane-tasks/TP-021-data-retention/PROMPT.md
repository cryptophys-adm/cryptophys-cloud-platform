# TP-021: Data retention for drift observations and syscall consumptions

- **Worker:** pi (see `taskplane-tasks/PI.md`).
- **Depends on:** TP-019 (merged and deployed).
- **Branch:** `worker/TP-021-data-retention`.
- **PR title:** `TP-021: retention for drift observations and syscall consumptions`.

## Why, and the owner's decision

`drift_observations` grows by about **1,470 rows a day**: 13 services every 15 minutes, plus deploy-time observations. It has no retention. The other operational tables are small or already bounded. `agent_memories` already has 90-day retention.

**Owner decision, 2026-11-05.** Deleting data is a human decision under ADR-0007 (`data.delete` is tier 3), so the owner chose:

- `drift_observations`: keep **90 days**. Always keep the **2 newest observations per service**, which the supervisor's persistent-drift rule needs.
- `agent_syscall_consumptions`: keep **7 days**. The rate limit looks back 1 hour, and a policy decision is valid for 5 minutes, so older rows serve no check.
- **Never** delete from `audit_events` (hash chain), `policy_decisions`, `agent_reports`, `recovery_plans`, `deployment_requests`, the registry, or any crypto history table.

This is deterministic service housekeeping that runs on a schedule. It is not an agent action and makes no syscall. Each service prunes only the table it owns:

- the **Drift Detector** prunes `drift_observations`;
- the **AI Kernel** prunes `agent_syscall_consumptions`.

## Read first (and nothing else)

- `workers/drift-detector/src/index.ts`: `observe()`, which writes observations and audits, and `scheduled()`.
- `workers/ai-kernel/src/index.ts`: `scheduled()`. Note the minute-based dispatch.
- `workers/ai-kernel/src/memory.ts`, lines 205–235: the existing 90-day memory retention. **Copy its batching style.**
- `workers/control-plane-shared/src/capabilities.ts`, lines 95–165: how `agent_syscall_consumptions` is read, so you can confirm 7 days is safe.
- `workers/control-plane-shared/src/audit.ts`: `appendAuditEvent`.
- `workers/control-plane-shared/test/control-plane.test.ts`: how the Drift Detector is tested.

## Files you may change

- `workers/drift-detector/src/index.ts`
- `workers/ai-kernel/src/index.ts`: `scheduled()` only, plus an import.
- `workers/ai-kernel/src/retention.ts` (new): the kernel prune function.
- `workers/control-plane-shared/test/retention-tp021.test.ts` (new)
- `docs/OPERATIONS.md`: one "Data retention" paragraph.
- `taskplane-tasks/TP-021-data-retention/STATUS.md`

No migrations, no `wrangler.toml` (the crons already fire every 15 minutes), no `.github/*`.

## Specification

### 1. Drift Detector: `pruneDriftObservations(env, now)` (exported)

1. **Constants:** `DRIFT_RETENTION_DAYS = 90`, `RETENTION_BATCH = 2000`, `RETENTION_MAX_BATCHES = 5`.
2. **Cutoff:** `new Date(now - 90 * 86_400_000).toISOString()`.
3. **Statement**, repeated until a batch deletes fewer than `RETENTION_BATCH` rows or `RETENTION_MAX_BATCHES` is reached:

   ```sql
   DELETE FROM drift_observations WHERE observation_id IN (
     SELECT o.observation_id FROM drift_observations o
     WHERE o.observed_at < ?
       AND (SELECT COUNT(*) FROM drift_observations i WHERE i.service_id = o.service_id AND i.observed_at > o.observed_at) >= 2
     ORDER BY o.observed_at LIMIT ?)
   ```

   It deletes old rows but never one of the 2 newest per service. The orchestrator verified this on SQLite.
4. **Return** `{ deleted, cutoff, batches }`.
5. **Audit only when something was deleted.** If `deleted > 0`, append **one** audit event:
   - `event_type: "maintenance.retention"`;
   - `actor: "cryptophys-drift-detector"`;
   - `subject: "drift_observations"`;
   - `outcome: "deleted"`;
   - `payload: { deleted, cutoff, retention_days: 90, keep_newest_per_service: 2, decision: "owner 2026-11-05" }`.
6. **Schedule.** In `scheduled()`, run the prune once a day, when the event's UTC time is **03:00** (`getUTCHours() === 3 && getUTCMinutes() === 0`).
   - Run it in its own `ctx.waitUntil`, **after** starting the normal observation.
   - A prune failure is logged (`event: "drift_retention_failed"`) and never affects the observation.

### 2. AI Kernel: `pruneSyscallConsumptions(env, now)` (new `retention.ts`, exported)

1. **Constants:** `CONSUMPTION_RETENTION_DAYS = 7`, the same batch size and maximum batch count as above.
2. **Statement**, in the same loop:

   ```sql
   DELETE FROM agent_syscall_consumptions WHERE decision_id IN (
     SELECT decision_id FROM agent_syscall_consumptions WHERE consumed_at < ? ORDER BY consumed_at LIMIT ?)
   ```

3. **Audit:** the same pattern as the Drift Detector. One `maintenance.retention` event, only when `deleted > 0`:
   - `actor: "cryptophys-ai-kernel"`;
   - `subject: "agent_syscall_consumptions"`;
   - `payload: { deleted, cutoff, retention_days: 7, decision: "owner 2026-11-05" }`.
4. **Schedule:** in the kernel `scheduled()`, when UTC is **03:07** (`getUTCHours() === 3 && minute === 7`). It runs in its own `waitUntil`; failures are logged and never affect the supervisor or the agents.

### 3. Docs

Add a "Data retention" paragraph to `docs/OPERATIONS.md` covering:

- the two rules and their schedules;
- that audit events and decisions are never deleted;
- that the owner decided this on 2026-11-05.

## Budget

- Two daily jobs.
- Each one is at most 5 × 2,000-row deletes, and is usually a single small delete once the table reaches steady state.
- No AI calls.

## Acceptance criteria (one `test()` per criterion, in `retention-tp021.test.ts`)

1. **Drift cutoff.** Seed one service with 5 observations older than 90 days and 2 recent ones. After the prune, 2 remain, and they are the 2 recent ones.
2. **Never below 2 per service.** A service whose **only** 3 observations are all older than 90 days keeps its 2 newest.
3. **Boundary.** An observation exactly at the cutoff is kept. One 1 ms older than the cutoff is deleted, if it is not among the 2 newest.
4. **Batching.** With 4,500 deletable rows, one call deletes all 4,500 in 3 batches. With 12,000, one call deletes 10,000 and stops (`batches = 5`).
5. **Drift audit.** A prune that deletes rows appends exactly one `maintenance.retention` event with the payload above, and the audit chain still verifies. A prune that deletes nothing appends no event.
6. **Consumptions.**
   - Rows older than 7 days are deleted; newer ones are kept.
   - Afterwards, the `recovery.propose` rate limit still counts correctly within the hour.
   - Replay protection for a fresh decision still holds.
7. **Isolation.** Rows in `audit_events`, `policy_decisions`, `agent_reports` and `market_candles`, seeded old, are untouched by both prunes.
8. **Schedules.**
   - The Drift Detector `scheduled()` at 03:00 UTC calls the prune. At 03:15, and at 02:00, it does not.
   - The kernel at 03:07 calls `pruneSyscallConsumptions`. At 00:07 it does not.
   - Both still run their normal work: the observation, and the supervisor.
9. **Failure-safe.** A DB wrapper that throws for SQL containing `DELETE FROM drift_observations` makes the prune log an error, while the 03:00 observation is still recorded.
10. **No regressions.**
    - typecheck is clean.
    - `npm test` is higher than 127, with 0 fail, 0 skipped and 0 todo.
    - Existing tests are unchanged.

## Definition of done

Follow "Definition of done" in `ANTIGRAVITY.md`, and paste the **real** output tails into `STATUS.md`. Dry-run:

```bash
for d in drift-detector ai-kernel; do npx wrangler deploy --dry-run --config ../$d/wrangler.toml --outdir /tmp/dry-$d; done
```

Set `State: done` only with 0 failures.

## After merge (orchestrator only)

Deploy Control Plane. After the next 03:00 and 03:07 UTC runs, verify in D1:

- nothing older than 90 days, or 7 days, remains beyond the kept rows;
- `maintenance.retention` events exist only if something was deleted. Until about 2026-12-03 nothing is older than 90 days in `drift_observations`, so expect no drift event until then.
