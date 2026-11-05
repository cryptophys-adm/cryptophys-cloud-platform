# TP-013: Policy Engine and Platform Registry agents publish advisory reports

- **Worker:** pi (see `taskplane-tasks/PI.md`).
- **Depends on:** TP-012 (merged and deployed).
- **Branch:** `worker/TP-013-policy-registry-reports`.
- **PR title:** `TP-013: Policy Engine and Platform Registry agent reports`.

## Goal

Two more per-Worker agents tell operators about events that need a human, as advisory `platform_digest` reports:

- the **`policy-engine`** agent reports a **denied** policy decision for a human-facing action;
- the **`platform-registry`** agent reports when a **new service is registered**, or when a service is **set to `disabled`**.

**No migration.** In production both agents already hold `reports.publish` (from migration 0017; verified in D1 on 2026-11-05). Do not add a migration, and do not change `REQUIRED_MIGRATION`.

## Read first (and nothing else)

- `workers/control-plane-shared/src/agents.ts`: `publishAgentReport`. Use it as is; it never throws.
- `workers/recovery-manager/src/lifecycle.ts`: the `publishAgentReport` calls added in TP-012. **Copy this pattern exactly.**
- `workers/control-plane-shared/test/agent-reports-tp012.test.ts`: the test style to copy, including the `recorder()` binding.
- `workers/policy-engine/src/index.ts`: `Env`, `decide()`.
- `workers/platform-registry/src/index.ts`: `Env`, the register/update handler (the `registry.service_registered` / `registry.service_updated` audit call).
- `workers/control-plane-shared/test/control-plane.test.ts`, lines 190–225: how the policy and registry handlers are called in tests.

## Files you may change

- `workers/policy-engine/src/index.ts`
- `workers/platform-registry/src/index.ts`
- `workers/control-plane-shared/test/agent-reports-tp013.test.ts` (new)
- `taskplane-tasks/TP-013-policy-and-registry-agent-reports/STATUS.md`

You may not change any other file: no `wrangler.toml` (the `AGENTS` binding already exists), no migrations, no `.github/workflows/*`, no `worker.ts`.

## Specification

### 1. Policy Engine (`policy-engine/src/index.ts`)

1. Change `export type Env = BaseEnv;` to `export type Env = BaseEnv & { AGENTS?: AgentRpcBinding };`. Import the type from `control-plane-shared/src/agents.ts`.
2. In `decide()`, publish a report **after** the `policy.decision` audit event is appended, **only when all of these hold**:
   - `result.decision === "deny"`;
   - `req.action !== "agent.syscall"`.
3. **Why the `agent.syscall` exclusion is mandatory.** Publishing a report is itself an `agent.syscall`, and the AI Kernel asks the Policy Engine to decide it. Reporting `agent.syscall` denials would let one denial trigger another syscall, which would trigger another decision, and so on (a feedback loop). Agent syscall denials are already recorded in `agent_actions`. A test must prove there is no loop (criterion 3).
4. The report:
   - `agent_id`: `"policy-engine"`;
   - `kind`: `"platform_digest"`;
   - `severity`: `"warning"`;
   - `subject`: `Policy denied <action> on <resource>`. Truncate `resource` to 100 characters.
   - `body`:
     - `decision_id`, `action`, `resource`, `reason`, `subject` (the requester);
     - `failed_checks`: the `id` of each check with `passed === false`. Send ids only, never the `detail` text or the request `context`. The context may contain operator-supplied data.
5. The `decide()` return value, the HTTP response and the audit event must stay exactly as they are today.

### 2. Platform Registry (`platform-registry/src/index.ts`)

1. Change `Env` in the same way as the Policy Engine.
2. In the register/update handler, **after** the audit event:

   | Case | `severity` | `subject` | `body` |
   |---|---|---|---|
   | new service (`existing` was null) | `info` | `Service <id> registered (<environment>)` | `{ service_id, environment, status, actor }` |
   | update where `status` changed **to** `disabled` (`existing.status !== "disabled"` and the new status is `"disabled"`) | `warning` | `Service <id> disabled` | `{ service_id, environment, previous_status, actor }` |

   Use `agent_id: "platform-registry"` and `kind: "platform_digest"` in both cases.
3. Do **not** publish for other updates, or for `registry.desired_version_set`. Every deploy sets desired versions, so reporting those would be noise.
4. Do **not** put `metadata` or `endpoint` in the body.
5. HTTP status codes (200/201) and response bodies stay unchanged.

### 3. Do not

- Add AI calls (the reports are deterministic).
- Use real network calls in tests.
- Change any check, decision or reason in `evaluatePolicy`.

## Budget

There are no new crons, Durable Objects or AI calls. Reports occur only on policy denials (rare, human-driven actions) and on registry registrations or disables (rare). The kernel's per-agent rate limit is the cap.

## Acceptance criteria (each needs a test in `agent-reports-tp013.test.ts`)

1. **Deny reports.** A `deploy` decision with `ci_green: false` returns `deny`, the same as before, and produces one `reports.publish` call:
   - as `policy-engine`;
   - with `severity: "warning"`;
   - with `body.failed_checks` containing `"ci_green"`;
   - with the disclaimer present;
   - with no `context` and no check `detail` in the body.
2. **Allow is silent.** An allowed `deploy` decision publishes nothing.
3. **No loop.** A denied `agent.syscall` decision publishes nothing. For example, use an unregistered agent subject, or a capability that is not granted.
4. **Policy outage.** With `AGENTS` undefined, or a binding whose `syscall` throws, `decide()` still returns the same decision, and the `policy_decisions` row and the audit event are still written.
5. **Registry new service.** Registering a new service returns 201 and publishes one `info` report as `platform-registry`, with no `metadata` in the body.
6. **Registry disable.** Updating an existing service from `healthy` to `disabled` returns 200 and publishes one `warning` report. An update that keeps the status, or changes it to anything other than `disabled`, publishes nothing.
7. **Registry outage.** A throwing binding leaves the 201/200 responses and bodies unchanged.
8. **No regressions.** The `npm test` count is higher than 108, with 0 failures and 0 skipped. The existing tests in `control-plane.test.ts` pass untouched.

## Definition of done

Follow "Definition of done" in `ANTIGRAVITY.md`. Dry-run these Workers:

```bash
for d in policy-engine platform-registry; do npx wrangler deploy --dry-run --config ../$d/wrangler.toml --outdir /tmp/dry-$d; done
```

Fill in `STATUS.md`:

- `State: done`;
- `Evidence`: the command output tails;
- `Changes`;
- `Open questions`.

## After merge (orchestrator only)

The orchestrator runs Deploy Control Plane (Policy Engine and Platform Registry), then verifies in D1 that drift is 0 and the Workers are healthy.
