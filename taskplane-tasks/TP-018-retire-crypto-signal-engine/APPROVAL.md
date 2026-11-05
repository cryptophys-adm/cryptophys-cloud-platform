# TP-018 approval record

## PR #108: VALIDATED (orchestrator, 2026-11-05), merged as `d81ce40`

**Checks:** typecheck clean; 117 tests pass, 0 fail, 0 skipped; 7 criterion tests; `test_migrations.py` PASS; dry-runs free of `cryptophys-signal-engine`; CI green.

**Worker conduct:**
- `STATUS.md` honestly reported `blocked`, with the failing tests listed. No test was deleted or skipped. That is an improvement on TP-017.
- `STATUS.md` was not refreshed after the final fixes. This record supersedes it.
- `PROMPT.md` (orchestrator-owned) was amended with an audit addendum. The content is sound, so it is accepted.

**Orchestrator prerequisites and fixes made during the review:**
- **#109:** the validation and deploy workflows stop building `signal-engine`.
- **#110:** `signals.observe` judges staleness at the cycle time, which removes a real-clock test time bomb that had turned `main` red.
- **Merge `a5277db`:** `main` merged into the TP-018 branch, resolving the conflict with #110.

## DEPLOYED AND VERIFIED (orchestrator, 2026-11-05 13:55 UTC)

Deploy Control Plane run 42039749459: success.

- Migration 0020 was applied at 13:53:39.
- The registry shows `cryptophys-signal-engine` as `disabled`.
- Agent `signal-engine` is `suspended`, with reason "retired: crypto Signal Engine (owner decision 2026-11-05)".
- Supervisor grants are now `platform.observe, recovery.propose, memory.recall, memory.remember`.
- Drift is 0. The Signal Engine is recorded as `disabled` and is not probed.

## WORKER DELETED (owner confirmed "ya, hapus", 2026-11-05)

- **#112** added `retire-worker.yml`:
  - it is limited to an allow-list and runs only from `main`, with `DELETE`, in the `production` Environment;
  - it fails closed while any source, binding, deploy, validation or Access reference remains.
- The same PR dropped the Signal Engine from `provision-access.yml`.
- **Retire Worker run 42041570698: success** (14:05 UTC). The Workflow `cryptophys-signal-ingest` and then the Worker `cryptophys-signal-engine` were deleted, and the workflow verified a 404.
- A Cloudflare account listing afterwards does not include `cryptophys-signal-engine`.
- The last crypto ingest was at 14:05:01, just before the deletion. Historical crypto data stays in D1: 4,461 candles, plus Mizan, confluence and macro.

The worker is done with TP-018.
