# TP-016: Diagnose why AI drafts fail validation

- **Worker:** pi (see `taskplane-tasks/PI.md`).
- **Depends on:** TP-015 (merged and deployed).
- **Branch:** `worker/TP-016-ai-failure-diagnostics`.
- **PR title:** `TP-016: AI failure categories and object-response handling`.

## Why

The orchestrator audited production on 2026-11-05.

**What works:**

- The agents are real and accurate. Every report matches its source data.
- Embeddings work: 10 of 10 succeeded.

**What fails:** every **text** draft from Workers AI failed schema validation.

- 5 of 5 failed: 4 `draft_signal_digest` and 1 `draft_audit_digest`.
- Every report shows `ai_status: "invalid_output"`, so the deterministic template was used each time.
- No hallucination reached users, but the AI currently contributes nothing.

We do not know **why**. `AiEngine.run()` only counts failures in `ai_usage`, and returns the same reason, `output_failed_schema_validation`, for every case.

**This task makes the cause measurable.** It does not change prompts, models or token limits. Those are fixed in a later task, once the data says what is wrong.

## Read first (and nothing else)

- `workers/control-plane-shared/src/ai-engine.ts`: the whole file, about 230 lines.
- `workers/ai-kernel/src/signal-analyst.ts`: lines 60–100, `draftSignalDigestTask` and its `validate`.
- `workers/ai-kernel/src/auditor.ts`: `draftAuditDigestTask` and its `validate`.
- `workers/control-plane-shared/src/readiness.ts`: `REQUIRED_MIGRATION`.
- `workers/control-plane-migrations/0018_grant_reports_publish.sql`: the newest migration, for numbering only.
- A test that already uses a fake AI binding. Search `fakeAi` in `workers/control-plane-shared/test/`.

## Files you may change

- `workers/control-plane-migrations/0019_ai_failures.sql` (new)
- `workers/control-plane-shared/src/readiness.ts`
- `workers/control-plane-shared/src/ai-engine.ts`
- `workers/ai-kernel/src/signal-analyst.ts`: only to add `diagnose` to `draftSignalDigestTask`.
- `workers/ai-kernel/src/auditor.ts`: only to add `diagnose` to `draftAuditDigestTask`.
- `workers/control-plane-shared/test/ai-kernel.test.ts`: only the one `REQUIRED_MIGRATION` assertion.
- `workers/control-plane-shared/test/ai-diagnostics-tp016.test.ts` (new)
- `taskplane-tasks/TP-016-ai-failure-diagnostics/STATUS.md`

## Specification

### 1. Migration `0019_ai_failures.sql`

```sql
CREATE TABLE ai_failures (
  service_id TEXT NOT NULL,
  day TEXT NOT NULL,
  task TEXT NOT NULL,
  category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 64),
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (service_id, day, task, category)
);
```

There is no foreign key, so a diagnostics write can never fail on registry state.

Then:

- set `REQUIRED_MIGRATION` to `0019_ai_failures.sql`;
- add `"0018_grant_reports_publish.sql"` to the `REQUIRED_MIGRATIONS` list, because the list must still contain every earlier entry;
- update the single `REQUIRED_MIGRATION` assertion in `ai-kernel.test.ts`.

### 2. Optional `diagnose` on `AiTask`

```ts
export interface AiTask<T> {
  // ...existing fields...
  /** Optional: why validate() rejected this output, as a short slug. Never echoes output content. */
  diagnose?(output: unknown): string;
}
```

### 3. Engine: categorize every failed generation (`run()` only; `embed()` stays unchanged)

Record **one** category per failed call with an upsert:

```sql
INSERT INTO ai_failures (service_id, day, task, category, count) VALUES (?, ?, ?, ?, 1)
ON CONFLICT(service_id, day, task, category) DO UPDATE SET count = count + 1
```

The write is wrapped in `try/catch`, exactly like `recordFailure`: telemetry never breaks the caller. Keep the existing `recordFailure(day)` call too, so `ai_usage.failures` keeps its meaning.

**Response handling** (fix this before categorizing):

- If `completion.response` is a **plain object** (not `null`, not an array), treat it as the already-parsed output and pass it straight to `validate`. Workers AI can return parsed JSON. This case is **not** a failure in itself.
- Otherwise use the existing text path.

**Categories.** Use exactly these slugs. Content after `schema:` is bounded to 48 characters.

| Situation | `category` |
|---|---|
| Timeout | `timeout` |
| `ai.run` threw | `inference_failed` |
| Text is empty and `response` is not an object | `empty_response` |
| Text has no `{` | `no_json_object` |
| Text has `{`, but no `}` after it | `truncated` |
| `{ … }` present, but `JSON.parse` fails | `json_parse_error` |
| Parsed, but `validate` returned `null` and the task has no `diagnose` | `schema_rejected` |
| Parsed, `validate` returned `null`, and the task has `diagnose` | `schema:` + `diagnose(output)`, sanitized to `[a-z0-9_]` and truncated to 48 characters |

Split the existing `extractJsonObject` logic so the engine can tell `no_json_object`, `truncated` and `json_parse_error` apart. The exported `extractJsonObject` must keep its current behaviour, because other code and tests use it.

Two more changes in `run()`:

- The `invalid_output` and `unavailable` outcomes keep their current `status`. In the `invalid_output` case, set `reason` to the category, for example `"reason": "truncated"`, instead of the fixed `output_failed_schema_validation`.
- In the `catch` block, the existing `unavailable` reason stays `"timeout"` or `"inference_failed"` as today, and is recorded with the same slug.

**Never store or log model output**, not even a prefix. Store only the category.

### 4. `diagnose` for the two failing tasks

Each `diagnose` mirrors its `validate` and returns the **first** failing check as a slug. Examples for the signal digest:

- `headline_invalid` (missing, empty or over 160 characters);
- `summary_invalid`;
- `symbols_not_array`;
- `symbols_count_mismatch`;
- `symbol_unknown`;
- `symbol_duplicate`;
- `action_mismatch`;
- `note_invalid`;
- `unknown`.

Do the same for the audit digest, based on its own checks.

`diagnose` must **not** include values from the output (no symbol names, no text) in the slug. `validate` must not change.

## Budget

There are no new crons or AI calls. Each failed generation adds one D1 upsert. Text generations are a handful per day.

## Acceptance criteria (one `test()` per criterion, in `ai-diagnostics-tp016.test.ts`)

1. **Migration.** After all migrations, `ai_failures` exists. `REQUIRED_MIGRATION` is `0019_ai_failures.sql`, and `schemaReady` is true.
2. **Object response.** A fake AI returning `{ response: { …valid object… } }` makes `run()` return `status: "ok"` and records no failure.
3. **Truncated.** A fake AI returning text `'{"headline": "x", "summary": "abc'` gives `invalid_output` with `reason: "truncated"`, and one `ai_failures` row with category `truncated`, count 1.
4. **Other text categories.** `""` gives `empty_response`. `"no json here"` gives `no_json_object`. `'{bad json}'` gives `json_parse_error`.
5. **Schema with diagnose.** For `draftSignalDigestTask`, a parsed output whose action for one symbol differs from the expected one gives category `schema:action_mismatch`. An output whose headline is 300 characters gives `schema:headline_invalid`.
6. **Schema without diagnose.** A task without `diagnose` gives `schema_rejected`.
7. **Timeout and throw.** These give `timeout` and `inference_failed` rows. The returned outcome is `unavailable` with the same reason as before this change.
8. **Count aggregates.** Two identical failures on the same day give one row with `count = 2`. `ai_usage.failures` also increases by 2.
9. **No content stored.** After a failure whose output contains `"SECRET_MARKER"`, no column of any `ai_failures` row contains that string. Also, a `diagnose` slug never contains a symbol name from the output.
10. **Telemetry never breaks the caller.** With a DB wrapper whose `prepare` throws for SQL containing `ai_failures`, `run()` still returns the same outcome.
11. **No regressions.** The `npm test` count is higher than 124, with 0 failures and 0 skipped. Existing tests pass, apart from the one `REQUIRED_MIGRATION` assertion. `extractJsonObject` keeps its behaviour.

## Definition of done

Follow "Definition of done" in `ANTIGRAVITY.md`, including `test_migrations.py`. Dry-run:

```bash
for d in ai-kernel platform-api policy-engine; do npx wrangler deploy --dry-run --config ../$d/wrangler.toml --outdir /tmp/dry-$d; done
```

Fill in `STATUS.md`: `State: done`, `Evidence`, `Changes`, `Open questions`.

## After merge (orchestrator only)

1. Deploy Control Plane, which applies migration 0019.
2. Wait for the next real digests (Signal Analyst on change or every 6 h; Auditor daily at about 00:37 UTC).
3. Query `ai_failures` for the categories. The fix (prompt, `max_tokens`, model or validator) becomes TP-019, based on that data. TP-017 (Signal Analyst reads XAUUSD) later removes `draftSignalDigestTask`; until then its `diagnose` is still required.
