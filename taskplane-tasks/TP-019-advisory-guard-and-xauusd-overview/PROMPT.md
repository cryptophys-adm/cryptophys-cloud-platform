# TP-019: Advisory-language guard for every AI draft, and the latest XAUUSD decision in the operator overview

- **Worker:** pi (see `taskplane-tasks/PI.md`).
- **Depends on:** TP-018 (merged and deployed).
- **Branch:** `worker/TP-019-advisory-guard`.
- **PR title:** `TP-019: advisory-language guard and XAUUSD in the overview`.

## Why

1. Since TP-016, Workers AI drafts can pass schema validation. The first AI-written digest that passed (2026-11-05 13:07 UTC) said *"SOLUSDT is **recommended for a buy**"*.
   - The platform is advisory only. Its AI text may describe; it must never recommend trades or give execution parameters.
   - Today the validators check only the shape and length of the output, not what it says.
2. The operator overview (`/v1/overview`, `/v1/status`, MCP `platform_status`) does not show the latest XAUUSD decision. The Signal Analyst already publishes it as an `xauusd_digest` report (TP-017).
3. The Platform API AI prompt still mentions "signal ingestion runs". The crypto Signal Engine was retired in TP-018.

The AI fix that was reserved as TP-019 becomes TP-020, and only if the Auditor's digest data shows it is still needed.

## Read first (and nothing else)

- `workers/control-plane-shared/src/ai-engine.ts`: the whole file. The guard goes into `run()`.
- `workers/ai-kernel/src/syscall.ts`, `observe()` (lines 30–95): the `agent_reports_24h` block is the pattern to copy.
- `workers/platform-api/src/index.ts`, lines 54–70: `overviewTask`.
- `workers/control-plane-shared/test/ai-diagnostics-tp016.test.ts` and `reports-overview-tp015.test.ts`: the test styles to copy.

## Files you may change

- `workers/control-plane-shared/src/ai-engine.ts`
- `workers/ai-kernel/src/syscall.ts`: `observe()` only.
- `workers/platform-api/src/index.ts`: the `overviewTask.instructions` string only.
- `workers/control-plane-shared/test/advisory-guard-tp019.test.ts` (new)
- `taskplane-tasks/TP-019-advisory-guard-and-xauusd-overview/STATUS.md`

No migrations, no `wrangler.toml`, no `.github/*`, no other Worker.

## Specification

### 1. Advisory-language guard (`ai-engine.ts`)

1. Export `ADVISORY_LANGUAGE: RegExp[]`. The list holds exactly these three case-insensitive patterns:

   ```ts
   /\b(buy|sell|long|short)\s+(now|immediately|here|at\s+\d)/i,
   /\b(recommend(s|ed|ation)?|advis(e|es|ed)|suggest(s|ed)?|should|consider)\b[^.!?\n]{0,60}\b(buy(ing)?|sell(ing)?|enter(ing)?|entry|go(ing)? (long|short)|open(ing)? a position)\b/i,
   /\b(take[- ]profit|stop[- ]loss|leverage|position[- ]siz(e|ing)|lot size)\b/i,
   ```

2. Export `violatesAdvisoryLanguage(value: unknown): boolean`.
   - It walks objects and arrays recursively, to a maximum depth of 6 and a maximum of 200 strings.
   - It returns `true` when any string matches any pattern.
   - It never throws.
3. In `AiEngine.run()`, after `task.validate(parsed)` returns non-null `data`:
   - if `violatesAdvisoryLanguage(data)` is true, treat the draft exactly like a schema failure:
     - call `recordFailure(day)`;
     - call `recordFailureCategory(day, task.name, "schema:advisory_language")`;
     - return `{ status: "invalid_output", reason: "schema:advisory_language", correlation_id }`;
   - otherwise return `ok` as today.
4. The guard applies to **every** task in every Worker, because they all go through `run()`.
   - It does not apply to `embed()`.
   - It never changes deterministic text that did not come from the model, for example the XAUUSD reasoning that the Signal Analyst copies.
5. Never store or log the offending text. Store only the category, as in TP-016.

### 2. Latest XAUUSD decision in `observe()` (`syscall.ts`)

1. Add one key, `xauusd_latest`, next to `agent_reports_24h`. All existing keys stay unchanged.
2. Fill it from this query:

   ```sql
   SELECT report_id, created_at, body_json FROM agent_reports
   WHERE agent_id = 'signal-analyst' AND kind = 'xauusd_digest' AND json_extract(body_json, '$.decision') IS NOT NULL
   ORDER BY created_at DESC, rowid DESC LIMIT 1
   ```

3. Value:
   - `{ report_id, reported_at: created_at, candle_key, decision, confidence, decided_at }`, read from `body_json`;
   - `candle_key` and `decided_at` are cut to 60 characters;
   - `decision` is one of `BUY`, `SELL`, `WAIT`, `NO_TRADE` or `UNKNOWN`, otherwise `UNKNOWN`;
   - `confidence` is a number in [0, 1], otherwise `null`;
   - `null` when there is no row.
   - **Never** include `reasoning`, prices or any other body field.
4. **Fail-safe.** If the query or the JSON parse throws, set `xauusd_latest: { error: "xauusd_latest_unavailable" }`, log the error, and keep every other key.

### 3. Platform API overview prompt (`platform-api/src/index.ts`)

Replace the overview instructions' data description with:

> "drift per service, open agent proposals, whether agents are enabled, the 24 h agent report summary, and the latest XAUUSD advisory decision (state it exactly as given; never add advice)"

Remove "signal ingestion runs". The rest of the instructions, the validator and the limits stay unchanged.

## Budget

- One extra indexed read (`LIMIT 1`) per `observe()` call.
- One regex scan per successful AI draft.
- No new crons and no AI calls.

## Acceptance criteria (one `test()` per criterion, in `advisory-guard-tp019.test.ts`)

1. **Blocks recommendations.** `violatesAdvisoryLanguage` is true for each of these:
   - `"SOLUSDT is recommended for a buy"`;
   - `"Buy now"`;
   - `"you should consider entering a long"`;
   - `"set a stop-loss at 2300"`;
   - `"use 10x leverage"`;
   - `{ notes: ["fine", "position size 2%"] }` (nested value).
2. **Allows descriptions.** It is false for each of these:
   - `"XAUUSD decision is WAIT with confidence 0.3"`;
   - `"The audit chain is valid across 569 events"`;
   - `"Redeploy the Platform API to the desired version"`;
   - `"BTCUSDT momentum is neutral"`;
   - `"No action was taken"`.
3. **Engine rejects.** A fake AI returning a schema-valid object whose `summary` says "recommended for a buy" gives:
   - `status: "invalid_output"` with `reason: "schema:advisory_language"`;
   - one `ai_failures` row with that category;
   - `ai_usage.failures` up by 1;
   - the text stored nowhere.
4. **Engine passes clean drafts.** The same object with a descriptive summary gives `status: "ok"`.
5. **Bounded walk.** A 10-level nested object, or an array of 1,000 strings, does not throw. Strings past the limits are not scanned.
6. **Overview: latest decision.** After two `xauusd_digest` reports (WAIT, then BUY), plus one stale or unavailable digest without `decision`, `observe().xauusd_latest` is the BUY one with exactly the six keys, and contains no `reasoning`.
7. **Overview: none and fail-safe.** No digest gives `xauusd_latest: null`. A DB wrapper throwing for that query gives `{ error: "xauusd_latest_unavailable" }`, and `services`, `agent_reports_24h` and the other keys are still present.
8. **Prompt.** `overviewTask.instructions` contains "latest XAUUSD advisory decision" and does not contain "signal ingestion".
9. **No regressions.** typecheck is clean; `npm test` is higher than 117, with 0 fail, 0 skipped and 0 todo; existing tests are unchanged.

## Definition of done

Follow "Definition of done" in `ANTIGRAVITY.md`. Paste the **real** output tails of `npm run typecheck`, `npm test` and `test_migrations.py` into `STATUS.md`. Dry-run:

```bash
for d in ai-kernel platform-api policy-engine; do npx wrangler deploy --dry-run --config ../$d/wrangler.toml --outdir /tmp/dry-$d; done
```

Set `State: done` only with 0 failures.

## After merge (orchestrator only)

1. Deploy Control Plane (AI Kernel), then Deploy Platform API.
2. Verify through the deploy logs or `/v1/status` that `xauusd_latest` matches the newest `xauusd_digest`, and that drift is 0.
