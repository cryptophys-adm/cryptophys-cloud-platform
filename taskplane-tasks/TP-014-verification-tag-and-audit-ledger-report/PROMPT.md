# TP-014: Quiet the deploy smoke test; Audit Ledger agent reports a broken chain

- **Worker:** pi (see `taskplane-tasks/PI.md`).
- **Depends on:** TP-013 (merged and deployed).
- **Branch:** `worker/TP-014-verification-and-audit-report`.
- **PR title:** `TP-014: deploy-verification tag and Audit Ledger chain report`.

## Goal

1. **Stop a known false alarm.** Every Deploy Control Plane run deliberately asks the Policy Engine to approve a `deploy` with `ci_green: false`; it must be refused. Since TP-013, that smoke test produces a `warning` report on every deploy. The orchestrator has already tagged that request with `context.deploy_verification: true` (in `.github/workflows/deploy-control-plane.yml`, in the same PR as this task). The Policy Engine must not report a deny that carries this tag.
2. **The Audit Ledger agent reports a broken audit chain**: `critical`, at most once per hour for the same break.

The Platform API agent intentionally publishes nothing: it is a read-only gateway. Do not add reports there.

**No migration.** `audit-ledger` already holds `reports.publish` in production.

## Read first (and nothing else)

- `workers/control-plane-shared/src/agents.ts`: `publishAgentReport`.
- `workers/policy-engine/src/index.ts`: `PolicyRequest`, `decide()`, and the TP-013 report block in it.
- `workers/audit-ledger/src/index.ts`: `Env`, and the `GET /v1/verify` route.
- `workers/control-plane-shared/src/audit.ts`, lines 105–136: `ChainVerification` and `verifyAuditChain`.
- `workers/control-plane-shared/test/agent-reports-tp013.test.ts`: the test style to copy.
- `workers/control-plane-migrations/0012_agent_reports.sql`: the `agent_reports` columns.

## Files you may change

- `workers/policy-engine/src/index.ts`
- `workers/audit-ledger/src/index.ts`
- `workers/control-plane-shared/test/agent-reports-tp014.test.ts` (new)
- `taskplane-tasks/TP-014-verification-tag-and-audit-ledger-report/STATUS.md`

Do not change any other file: no `wrangler.toml`, no migrations, no `.github/workflows/*` (the orchestrator has already made the workflow change).

## Specification

### 1. Policy Engine: honour the verification tag

In `decide()`, change the TP-013 condition so that a deny is reported only when **all** of these hold:

- `result.decision === "deny"`;
- `req.action !== "agent.syscall"` (unchanged; it prevents a feedback loop);
- `req.context.deploy_verification !== true`. Use strict `=== true`. A string `"true"`, `1` or any other value **is still reported**.

Everything else stays exactly as it is:

- the decision, the `policy_decisions` row (its stored evidence keeps the tag, because the context is redacted and stored as today), the audit event and the response;
- `evaluatePolicy` must not read `deploy_verification`. The tag can only silence the advisory report; it can never change a decision.

### 2. Audit Ledger: report a broken chain

1. Change `export type Env = BaseEnv;` to `export type Env = BaseEnv & { AGENTS?: AgentRpcBinding };`.
2. In the `GET /v1/verify` route, compute `const result = await verifyAuditChain(env.DB)`.
   - If `result.valid === false`, publish a report, subject to the de-duplication rule in step 3.
   - Then return `json(result)` exactly as today.
3. **De-duplication.** Before publishing, check whether a report already exists:

   ```sql
   SELECT 1 FROM agent_reports WHERE agent_id = 'audit-ledger' AND subject = ? AND created_at > ? LIMIT 1
   ```

   Bind the same subject and `new Date(Date.now() - 3600_000).toISOString()`. If a row exists, do not publish.

   The query must **never break the response**. Wrap it in `try/catch`; if the query fails, skip publishing and log the error.
4. The report:
   - `agent_id`: `"audit-ledger"`;
   - `kind`: `"audit_digest"`;
   - `severity`: `"critical"`;
   - `subject`: `Audit chain invalid at <first_invalid_event_id>`;
   - `body`: `{ events_checked, first_invalid_event_id, reason, head_hash }`. Never include event payloads.
5. A valid chain publishes nothing.

### 3. Do not

- Add AI calls, crons, or real network calls in tests.
- Change any HTTP status or response body.

## Budget

There are no new crons, Durable Objects or AI calls. The de-duplication query is one read on the (agent_id, created_at) index, made only when the chain is invalid. A broken chain should never happen.

## Acceptance criteria (one `test()` per criterion, in `agent-reports-tp014.test.ts`)

1. **Tagged deny is silent.** A `deploy` with `ci_green: false` and `deploy_verification: true`:
   - still returns `deny` with `ci_green` in the reason;
   - still writes the `policy_decisions` row and the audit event;
   - publishes nothing.
2. **Tag is strict.** The same request with `deploy_verification: "true"` (a string) publishes one `warning` report.
3. **Tag cannot change a decision.** A request that would be allowed returns `allow` with `deploy_verification: true` and with `deploy_verification: false`. The tag also does not turn a deny into an allow (criterion 1).
4. **TP-013 behaviour is unchanged.** An untagged deny still publishes. The `agent.syscall` exclusion still holds.
5. **Broken chain reports once.**
   - Tamper with one row in `audit_events`, for example by changing `payload_json` through `db.raw`.
   - Call `GET /v1/verify` twice.
   - Both calls return `valid: false` with the same body as before.
   - Exactly one `reports.publish` call is made: `audit-ledger`, `audit_digest`, `critical`, and the body has no payload.
   - The second call is suppressed because the first report row exists. Use a binding fake that **inserts** the report row, or pre-insert a matching row in `agent_reports`.
6. **Valid chain is silent.** On an untampered database, `GET /v1/verify` returns `valid: true` and publishes nothing.
7. **Outage-safe.** A missing binding, a throwing binding, or a failing de-duplication query (for example a fake DB whose `prepare` throws for `agent_reports`) still returns the same `GET /v1/verify` response.
8. **No regressions.** The `npm test` count is higher than 110, with 0 failures and 0 skipped. Existing tests pass untouched.

## Definition of done

Follow "Definition of done" in `ANTIGRAVITY.md`. Dry-run these Workers:

```bash
for d in policy-engine audit-ledger; do npx wrangler deploy --dry-run --config ../$d/wrangler.toml --outdir /tmp/dry-$d; done
```

Fill in `STATUS.md`: `State: done`, `Evidence`, `Changes` and `Open questions`.

## After merge (orchestrator only)

Deploy Control Plane, then verify in D1:

- drift is 0;
- the deploy's own smoke-test deny produced **no** new `policy-engine` report;
- the `policy_decisions` row for that deny still exists.
