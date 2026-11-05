# TP-012: Recovery Manager and Deployment Orchestrator agents publish advisory reports

- **Worker:** pi (see `taskplane-tasks/PI.md`).
- **Depends on:** TP-011 part 2 (#85, deployed). Every platform Worker already has the `AGENTS` binding to `cryptophys-ai-kernel#AgentRpc`, pinned to its own name.
- **Branch:** `worker/TP-012-agent-reports`.
- **PR title:** `TP-012: Recovery Manager and Deployment Orchestrator agent reports`.

## Goal

Two more per-Worker agents become useful: they tell operators about events that need a human, as advisory `platform_digest` reports.

- **`recovery-manager`** reports when a recovery plan expires or overruns its execution window.
- **`deployment-orchestrator`** reports when a production deployment request is rejected.

## Read first (and nothing else)

- `workers/control-plane-shared/src/agents.ts`: `publishAgentReport`. Use it as is. It never throws.
- `workers/signal-engine/src/index.ts`: search for `publishAgentReport`. **Copy this pattern exactly.**
- `workers/control-plane-shared/test/agent-bindings.test.ts`: the `recorder()` helper and the test style to copy.
- `workers/control-plane-migrations/0016_platform_and_xauusd_agents.sql`: lines 8–40 (the agent rows).
- `workers/recovery-manager/src/lifecycle.ts`: `LifecycleEnv`, `closeWindow`.
- `workers/deployment-orchestrator/src/index.ts`: `Env`, and the two `deployment.rejected` audit calls, around lines 185–240.
- `workers/control-plane-shared/src/readiness.ts`: `REQUIRED_MIGRATION`.

## Files you may change

- `workers/control-plane-migrations/0018_grant_reports_publish.sql` (new)
- `workers/control-plane-shared/src/readiness.ts`
- `workers/recovery-manager/src/lifecycle.ts`
- `workers/deployment-orchestrator/src/index.ts`
- `workers/control-plane-shared/test/agent-reports-tp012.test.ts` (new)
- `taskplane-tasks/TP-012-recovery-and-orchestrator-agent-reports/STATUS.md`

You may not change any other file. In particular, do not touch `wrangler.toml` (the binding already exists) or `.github/workflows/*`.

## Specification

### 1. Migration `0018_grant_reports_publish.sql`

Today `recovery-manager` and `deployment-orchestrator` lack `reports.publish`, so the kernel would deny them with `capability_not_granted`. Grant it with an `UPDATE` that appends `"reports.publish"` to `capabilities_json` for exactly these two `agent_id`s.

- Use `json_insert(capabilities_json, '$[#]', 'reports.publish')`.
- Guard it so the capability is added only if it is not already present. Use `NOT EXISTS (SELECT 1 FROM json_each(capabilities_json) WHERE value = 'reports.publish')`.
- Set `updated_by = 'migration:0018'` and `updated_at = '2026-11-05T12:00:00.000Z'`.
- Change nothing else. `tier_max` stays 1. Add no rows.

Then set `REQUIRED_MIGRATION` to `0018_grant_reports_publish.sql`, and add the file to the `REQUIRED_MIGRATIONS` list if that list enumerates files.

### 2. Recovery Manager (`lifecycle.ts`)

1. Add `AGENTS?: AgentRpcBinding` to `LifecycleEnv`. Import the type from `control-plane-shared/src/agents.ts`.
2. In `closeWindow`, **after** the audit event is appended, call `publishAgentReport(env.AGENTS, "recovery-manager", …)`:

   | Case | `severity` | `subject` | `body` |
   |---|---|---|---|
   | `executing` overdue | `critical` | `Recovery plan <planId> execution overdue` | `{ plan_id, previous_status: "executing", reason: "execution_overdue", workflow_instance_id, action_required: "a human must finish or abandon the plan" }` |
   | `draft` / approved, expired | `warning` | `Recovery plan <planId> expired (<reason>)` | `{ plan_id, previous_status, reason, workflow_instance_id }` |

   Use `kind: "platform_digest"` in both cases.
3. Publish **only when the window was actually closed by this call**:
   - after the `UPDATE` changed 1 row; or
   - in the `executing` branch.

   Do not publish when `changes !== 1`.
4. Ignore the publish result. It must never change `closeWindow`'s return value or throw.

### 3. Deployment Orchestrator (`index.ts`)

1. Add `AGENTS?: AgentRpcBinding` to `Env`.
2. Next to each of the two `deployment.rejected` audit calls (`commit_not_current_main` and `ci_not_green`), publish a report:
   - `agent_id`: `"deployment-orchestrator"`;
   - `kind`: `"platform_digest"`;
   - `severity`: `"warning"`;
   - `subject`: `Deployment of <TARGET_SERVICE> rejected: <outcome>`;
   - `body`: the same payload object as the audit event, plus `requested_by`.
3. **Do not add latency or risk to the response.**
   - If the handler has an `ExecutionContext` available, use `ctx.waitUntil(publishAgentReport(...))`.
   - If it does not, `await` it. It never throws, and the AI Kernel is an in-account RPC.
   - Do **not** change the function signatures of exported functions only to obtain `ctx`. If `ctx` is not already reachable, use `await` and say so in `STATUS.md`.
4. Do not report `duplicate_production_deployment_request`. It is normal idempotency, not an incident.

### 4. Do not

- Add AI calls. These reports are deterministic (`publishAgentReport` already sets `ai_status: "deterministic"`).
- Publish from tests against a real network.
- Change the HTTP status codes or response bodies of the orchestrator.

## Budget

There are no new crons, Durable Objects or AI calls. Reports occur only on rare events: plan expiry, overdue execution, or a rejected deployment. The kernel's existing per-agent rate limit is the cap.

## Acceptance criteria (each needs a test in `agent-reports-tp012.test.ts`)

1. **Migration.** After all migrations, both `recovery-manager` and `deployment-orchestrator` have `reports.publish` exactly once, and `tier_max` is still 1. Running the `UPDATE` statement a second time does not duplicate the capability.
2. **Recovery expiry.** A draft whose approval window closes produces one `reports.publish` call:
   - as `recovery-manager`;
   - `severity: "warning"`;
   - `body.reason === "approval_expired"`;
   - the disclaimer is present.
3. **Recovery overdue.** An `executing` plan whose window closes produces `severity: "critical"` with `body.reason === "execution_overdue"`.
4. **No double report.** When the `UPDATE` changes 0 rows (the plan already moved on), no report is published.
5. **Kernel outage.** With a binding whose `syscall` throws:
   - `closeWindow` / `runLifecycle` still completes;
   - the plan is still `disabled`;
   - the audit event is still written.
6. **Orchestrator rejection.** A request rejected with `ci_not_green` (reuse the fakes in `orchestrator.test.ts`) still returns HTTP 409 with the same body, and publishes one `warning` report as `deployment-orchestrator`.
7. **Orchestrator kernel outage.** A missing binding (`AGENTS` undefined) or a throwing binding leaves the 409 response unchanged.
8. **No regressions.** `npm test` count is higher than 101, with 0 failures and 0 skipped.

## Definition of done

Follow "Definition of done" in `ANTIGRAVITY.md`. Dry-run these Workers:

```bash
for d in recovery-manager deployment-orchestrator; do npx wrangler deploy --dry-run --config ../$d/wrangler.toml --outdir /tmp/dry-$d; done
```

Fill in `STATUS.md` with:

- `State: done`;
- `Evidence`: command output tails;
- `Changes`;
- `Open questions`.

## After merge (orchestrator only, not the worker)

1. Deploy Control Plane runs migration 0018 and redeploys the Recovery Manager.
2. Deploy Deployment Orchestrator redeploys the orchestrator.
3. Verify in D1 that both agents have `reports.publish`, and that drift is 0.
