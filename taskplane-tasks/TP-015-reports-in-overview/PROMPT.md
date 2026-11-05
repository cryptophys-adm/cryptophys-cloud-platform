# TP-015: Agent reports in the platform overview

- **Worker:** pi (see `taskplane-tasks/PI.md`).
- **Depends on:** TP-014 (merged and deployed).
- **Branch:** `worker/TP-015-reports-in-overview`.
- **PR title:** `TP-015: agent report summary in the platform overview`.

## Goal

Seven platform agents now publish advisory reports, but operators only see them by asking `list_reports` explicitly. Add a small, bounded summary of the **last 24 hours of reports** to the AI Kernel's `observe()`. It then appears automatically in:

- the Platform API `GET /v1/overview`, through `KernelRpc.overview`;
- the kernel `GET /v1/status`;
- the MCP `platform_status` tool;
- the supervisor's `platform.observe`.

## Read first (and nothing else)

- `workers/ai-kernel/src/syscall.ts`, lines 30–70: `observe()`.
- `workers/control-plane-migrations/0012_agent_reports.sql` and `0017_report_kinds_xauusd_and_hud.sql`: the `agent_reports` columns and the `(agent_id, created_at)` index.
- `workers/control-plane-shared/test/ai-kernel.test.ts`: how `observe` / `platform_status` are exercised. Search for `platform_status` and `/v1/status`.
- `workers/control-plane-shared/test/agent-reports-tp014.test.ts`: the test style.

## Files you may change

- `workers/ai-kernel/src/syscall.ts`
- `workers/control-plane-shared/test/reports-overview-tp015.test.ts` (new)
- `taskplane-tasks/TP-015-reports-in-overview/STATUS.md`

Do not change any other file: no migrations, no `wrangler.toml`, no `.github/workflows/*`, and no Platform API code. The overview passes the kernel output through unchanged.

## Specification

Add one key, `agent_reports_24h`, to the object returned by `observe(env, now)`. Keep every existing key unchanged.

```ts
agent_reports_24h: {
  since: string;                                   // ISO time: now - 24 h, computed from the `now` argument
  counts: { critical: number; warning: number; info: number };
  latest_attention: Array<{                        // at most 5, newest first, severity critical or warning only
    report_id: string; agent_id: string; kind: string; severity: "critical" | "warning";
    subject: string; created_at: string;
  }>;
}
```

1. **Window.** `since = new Date(now - 24 * 3600_000).toISOString()`. Count rows with `created_at > since`.
2. **Two queries, both bounded:**
   - `SELECT severity, COUNT(*) AS n FROM agent_reports WHERE created_at > ? GROUP BY severity`. A severity with no rows gets 0.
   - `SELECT report_id, agent_id, kind, severity, subject, created_at FROM agent_reports WHERE created_at > ? AND severity IN ('critical','warning') ORDER BY created_at DESC, rowid DESC LIMIT 5`.
3. **Never include `body_json`.** The summary carries only the six listed columns. In addition, truncate `subject` to 200 characters in code; do not rely on the writer having done it.
4. **Fail-safe.** If either query throws, `observe()` must still return all its existing keys. Set `agent_reports_24h` to `{ since, counts: { critical: 0, warning: 0, info: 0 }, latest_attention: [], error: "reports_unavailable" }` and log the error. `observe()` feeds the supervisor and the Platform API, so it must never fail because of reports.
5. Do not change the supervisor, its decisions, or any proposal logic. The new key is informational.

## Budget

There are no new crons or AI calls. Each `observe()` call adds two small indexed reads (`LIMIT 5`, plus a group-by over at most a day of reports).

## Acceptance criteria (one `test()` per criterion, in `reports-overview-tp015.test.ts`)

1. **Counts.** Seed reports with fixed `created_at` values: 2 critical, 1 warning and 3 info inside the window, plus 1 critical older than 24 h. `observe(env, now)` returns:
   - `counts` = `{critical: 2, warning: 1, info: 3}`;
   - a `since` that equals `now - 24h`.
2. **Latest attention.** `latest_attention` holds only the 3 in-window critical and warning reports, newest first, each with exactly the six keys. With 7 qualifying rows, the length is 5.
3. **No body leak.** A report whose `body_json` contains a marker string such as `"SECRET_MARKER"` never appears in `JSON.stringify(observe(...))`.
4. **Subject is bounded.** A 300-character subject inserted directly into D1 is returned at 200 characters.
5. **Empty.** With no reports, the counts are all 0 and `latest_attention` is `[]`.
6. **Fail-safe.** With a DB wrapper whose `prepare` throws for SQL containing `agent_reports`, `observe()` still returns `services`, `ingest_runs`, `open_agent_plans` and `agents_enabled`, and `agent_reports_24h.error === "reports_unavailable"`.
7. **Surfaces.** The MCP `platform_status` tool (or `GET /v1/status`) output contains `agent_reports_24h`.
8. **No regressions.** The `npm test` count is higher than 117, with 0 failures and 0 skipped. Existing tests pass untouched.

## Definition of done

Follow "Definition of done" in `ANTIGRAVITY.md`. Dry-run:

```bash
for d in ai-kernel platform-api; do npx wrangler deploy --dry-run --config ../$d/wrangler.toml --outdir /tmp/dry-$d; done
```

Fill in `STATUS.md`: `State: done`, `Evidence`, `Changes` and `Open questions`.

## After merge (orchestrator only)

1. Deploy Control Plane (the AI Kernel).
2. Verify that `observe` returns `agent_reports_24h` with the live counts (compare with D1), and that drift is 0.
