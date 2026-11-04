# ADR-0006: Cloudflare Workflows for the recovery lifecycle and signal ingestion

- **Status:** Accepted
- **Date:** 2026-11-04
- **Owner decision:** "move to the next deployment, including the use of Workflows" (repository owner, 2026-11-04). This follows the orchestrator's proposal to start with the Recovery Manager and then the Signal Engine, after checking the step quota.
- **Builds on:** ADR-0004 (operational control plane) and ADR-0005 (Workers Paid included usage only, no containers, advisory only).

## Context

Two control-plane jobs need something a request/response Worker or a single cron invocation cannot provide.

1. **Recovery plans had no time limits.**
   - An approved plan stayed executable indefinitely.
   - A draft could be approved weeks later.
   - A started execution that was never finished stayed `executing` with nothing to raise it.
   - Enforcing deadlines only at request time leaves stale plans actionable until someone calls the API.
2. **Signal ingestion was one cron invocation.**
   - It processed all series in sequence, with one in-process retry per series.
   - A rate limit (Kraken `EGeneral:Too many requests`) or a 5xx recorded a failed series until the next quarter-hour run.
   - An isolate eviction mid-run lost the whole pass.

## Decision

1. **`cryptophys-recovery-lifecycle` (`RecoveryPlanWorkflow`, in `cryptophys-recovery-manager`).** One instance per plan, with the instance id equal to the plan id.
   - **Windows and deadlines.** Migration 0009 stores `approve_by` (creation + 72 h), `execute_by` (approval + 24 h) and `finish_by` (start + 24 h). The windows are set by `RECOVERY_*_WINDOW_HOURS` (1–720).
   - **Handlers enforce the deadlines.** A late approval returns `409 approval_window_closed`. A late start returns `409 execution_window_closed`. This holds whether or not the Workflow has run.
   - **The Workflow closes windows on time.**
     - It waits with `step.waitForEvent` until the deadline, then re-reads D1.
     - A draft past its window becomes `disabled` / `approval_expired`.
     - An approved plan not started in time becomes `disabled` / `approval_lapsed`.
     - Each change is audited as `recovery.plan_expired` with the actor `workflow:recovery-lifecycle`.
   - **Overdue executions are raised, never resolved.** An execution not finished in time is audited as `recovery.execution_overdue` and stays `executing`, because someone may still be mid-recovery.
   - **D1 stays the source of truth.** Events from the handlers (`plan-approved`, `execution-started`, `execution-finished`) only wake the instance early. Every stage re-reads D1, and no event payload is trusted.
   - **The Workflow never authorizes anything.** Approval identity, separation of duties and the Policy Engine `allow` remain in the HTTP handlers.
   - **Disabling a plan terminates its instance.**
   - **A Workflows outage does not block recovery.** The plan is still created, with its deadline, and the failure is logged.
   - **Older plans.** Plans created before 0009 have no deadline and keep their previous behaviour.
2. **`cryptophys-signal-ingest` (`SignalIngestWorkflow`, in `cryptophys-signal-engine`).** The cron (`4,19,34,49 * * * *`) creates one instance per firing.
   - **No duplicate runs.** The instance id is derived from `scheduledTime`, so a duplicate firing cannot start a second run.
   - **Durable steps.** Each series, each symbol's derived engines, the macro context and the run record is its own step.
   - **Retries on transient failures.** Timeouts, unreachable hosts, 429, 5xx and Kraken rate-limit errors throw, so the step retries: 3 retries, 10 s exponential back-off.
   - **Failures are still recorded.** The final attempt returns the failure as data, so `signal_ingest_runs` records it as before. A stored series is never fetched again after a later step fails.
   - **Run records name their instance.** `signal_ingest_runs.workflow_instance_id` records the instance. It is NULL for inline runs: `POST /v1/ingest`, and the cron if the binding is missing.
3. **Readiness.**
   - The Recovery Manager reports `lifecycle_workflow`, and the Signal Engine reports `ingest_workflow`.
   - Both are required for `ready`, so a deploy without the binding fails verification.
4. **The Workflow code is testable in Node.** The Workflow bodies (`recovery-manager/src/lifecycle.ts`, `signal-engine/src/ingest-workflow.ts`) are written against the minimal interfaces in `control-plane-shared/src/types.ts`. They are tested with a fake step engine (`test/workflows.test.ts`), and `worker.ts` only adapts the `WorkflowEntrypoint`.

## Usage against the Workers Paid included quotas

| Workflow | Steps | Volume | Per month |
| --- | --- | --- | --- |
| Signal ingest | 3 symbols × 1–2 timeframes: series + derive + start, macro, record ≈ 12 per run | 96 runs/day | ≈ 35,000 |
| Recovery lifecycle | ≤ 7 per plan | a handful of plans | < 100 |

- **Steps.** Workers Paid includes 500,000 steps a month, so usage is about 7% of the allowance.
- **Storage.**
  - Retention is set per Workflow: ingest keeps successes for 3 days and errors for 14; recovery keeps both for 30 days.
  - This stays far below the 1 GB-month included.
- **CPU and requests.** Unchanged in kind: the same D1 queries and market-data calls, now split into steps.

## Consequences

- Stale recovery plans leave actionable states on time, with an audit trail.
- A rate-limited series is retried within the same run, rather than waiting 15 minutes.
- `POST /v1/ingest` stays inline and synchronous, for operators and tests.
- Deploying requires the API token to manage Workflows. `wrangler deploy` creates or updates the Workflow with the script, and the deploy verification fails closed if the binding is missing.

## Alternatives considered

- **Deadlines checked only by the HTTP handlers.** Rejected on its own: nothing would move a stale plan or raise an overdue execution. It is kept as the second line of enforcement.
- **A sweeper cron in the Recovery Manager.** Rejected. It would need polling, adds invocations around the clock, and reacts only at its own cadence.
- **Queues for ingestion.** Rejected. Queues add a producer, a consumer and a dead-letter queue to get per-series retries, which a Workflow step provides directly.
- **Deploying from a Workflow instead of GitHub Actions.** Rejected. The Worker would have to hold a deploy-capable API token, and branch protection, required checks and the `production` environment would no longer gate production.
