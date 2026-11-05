# TP-017: The Signal Analyst reads XAUUSD decisions (it stops reading crypto signals)

- **Worker:** pi (see `taskplane-tasks/PI.md`).
- **Depends on:** TP-016 merged. Start from the latest `main` *after* TP-016, because both touch `signal-analyst.ts`.
- **Branch:** `worker/TP-017-signal-analyst-xauusd`.
- **PR title:** `TP-017: Signal Analyst reads XAUUSD decisions`.

## Why

Owner decision, 2026-11-05: the platform's signal role moves to **`xauusd-ai-trading-assistant`**, and the crypto Signal Engine (BTC/ETH/SOL) will be retired in TP-018.

The XAUUSD system already makes the advisory decisions. It runs an Analyst → Counselor → Reasoner chain on every closed H1 candle, with parity-verified local engines. The Signal Analyst stops analysing crypto and becomes a **faithful, deterministic reader** of those decisions:

- it publishes `xauusd_digest` reports;
- it raises a warning when XAUUSD analysis goes stale or unreachable.

**You must not change the `xauusd-ai-trading-assistant` repository.** The platform reads its existing read-only API through an in-account Service Binding.

## Read first (and nothing else)

- `workers/ai-kernel/src/signal-analyst.ts`: the whole file. You will rewrite its cycle.
- `workers/ai-kernel/src/syscall.ts`: `observeSignals` (around lines 95–140) and the `CAPABILITY_HANDLERS` map that contains `"signals.observe"`.
- `workers/ai-kernel/src/index.ts`: `scheduled()`. The Signal Analyst runs at minute 7.
- `workers/ai-kernel/wrangler.toml`.
- `workers/drift-detector/wrangler.toml`, lines 78–96: the existing plain Service Bindings to the xauusd Workers. Copy that style.
- `workers/control-plane-shared/test/signal-analyst.test.ts`: the tests you will rewrite.
- The XAUUSD read API contract, shown below. Do not go and read the other repository.

### The XAUUSD contract you consume

`GET /api/decisions?limit=N` (N ≤ 50) on Worker `xauusd-ai-trading-assistant` returns:

```json
{ "status": "ok", "count": 2, "items": [
  { "candle_key": "OANDA:XAUUSD:60:1793872800000", "timestamp": "2026-11-05 11:05:16",
    "decision": "WAIT", "confidence": 0.3, "entry_price": null, "stop_loss": null,
    "take_profit": null, "risk_reward": null, "position_size_pct": null, "reasoning": "…up to 300 chars…" } ] }
```

- Items come newest first.
- `candle_key` is `OANDA:XAUUSD:60:<candle open time in ms>`, and H1 candles close one hour after they open.
- `decision` is one of `BUY`, `SELL`, `WAIT` or `NO_TRADE`.

## Files you may change

- `workers/ai-kernel/wrangler.toml`: add **one** plain Service Binding, nothing else.
- `workers/ai-kernel/src/syscall.ts`: `observeSignals` only.
- `workers/ai-kernel/src/signal-analyst.ts`
- `workers/ai-kernel/src/index.ts`: only the Signal Analyst minute in `scheduled()`.
- `workers/control-plane-shared/test/signal-analyst.test.ts`: rewrite it for the new behaviour.
- `workers/control-plane-shared/test/ai-diagnostics-tp016.test.ts`: only remove assertions about `draftSignalDigestTask`, if TP-016 added them, because that task is deleted here. The audit-digest assertions stay.
- Any other existing test that breaks **only** because `observeSignals` or the digest changed. List each such file and the reason in `STATUS.md`.
- `taskplane-tasks/TP-017-signal-analyst-reads-xauusd/STATUS.md`

Do not touch `workers/signal-engine/*`, migrations, `.github/workflows/*`, or the xauusd repository.

## Specification

### 1. Binding

In `workers/ai-kernel/wrangler.toml`, add a comment and:

```toml
[[services]]
binding = "XAUUSD_AI"
service = "xauusd-ai-trading-assistant"
```

It is a plain fetch binding (no `entrypoint`), read-only, in the same account, and needs no token. Add `XAUUSD_AI?: { fetch(input: string, init?: RequestInit): Promise<Response> }` to the kernel `Env` type wherever `SyscallEnv`/`KernelEnv` is declared.

### 2. `observeSignals(env, now)`: tier 0 `signals.observe`, retargeted to XAUUSD

1. **Binding missing.** If `env.XAUUSD_AI` is missing, return `{ source: "xauusd-ai-trading-assistant", observed_at, available: false, error: "xauusd_binding_missing" }`.
2. **Fetch.** Call `env.XAUUSD_AI.fetch("https://xauusd.internal/api/decisions?limit=6", { headers: { accept: "application/json" } })` with a **5 s timeout**.
   - A non-2xx response, a timeout, a throw or invalid JSON gives `available: false` with `error`: `xauusd_http_<status>`, `xauusd_timeout`, `xauusd_unreachable` or `xauusd_invalid_body`.
   - The function never throws.
3. **Normalize** each item, keeping at most 6:

   ```ts
   { candle_key: string;               // must match /^OANDA:XAUUSD:60:\d{10,14}$/, else the item is dropped
     candle_open_ms: number;           // parsed from the key
     decided_at: string | null;        // item.timestamp, max 40 chars
     decision: "BUY" | "SELL" | "WAIT" | "NO_TRADE" | "UNKNOWN";
     confidence: number | null;        // finite and in [0, 1], else null
     entry_price, stop_loss, take_profit, risk_reward: number | null;  // finite and > 0, else null
     reasoning: string }               // max 300 chars
   ```

   **Drop `position_size_pct`.** Position sizing is never relayed by the platform.
4. **Stale rule.** Let `latest` be the newest valid item. The analysis is `stale` when `now - (latest.candle_open_ms + 3_600_000) > 90 * 60_000`: the latest analysed candle closed more than 90 minutes ago, so at least one closed candle has no decision. It is also `stale` when there are no valid items.
5. **Return** `{ source: "xauusd-ai-trading-assistant", observed_at, available: true, stale, latest: latest ?? null, recent: items }`.

### 3. Signal Analyst cycle (rewrite `runSignalCycle`; keep its exported name and signature)

The cycle is **deterministic**: no AI call. Delete `draftSignalDigestTask`, the crypto `templateDigest` and the crypto types. Keep the existing gates: agent registered and enabled, kill switch on.

1. Call `syscall(env, "signal-analyst", "signals.observe")`. If the outcome is not succeeded, record the finding and stop.
2. **Unavailable** (`available: false`): publish **one** `warning` per 6 h, tracked in memory key `last_unavailable_report_at`.
   - `kind: "xauusd_digest"`;
   - `subject: "XAUUSD decisions unavailable (<error>)"`;
   - `body: { error, source, disclaimer }`.

   Then stop.
3. **Stale:** publish **one** `warning` per distinct `latest.candle_key`, tracked in memory key `last_stale_candle_key`.
   - `subject: "XAUUSD analysis stale: no decision since candle <ISO of candle_open_ms>"`;
   - `body: { last_candle_key, last_decided_at, minutes_since_close, source, disclaimer }`.

   Then **continue** to step 4. The latest decision is still reported if it is new.
4. **Digest.** Publish when `latest` exists and **either** of these holds:
   - `latest.candle_key !== memory.last_candle_key` **and** `latest.decision !== memory.last_decision`;
   - 6 hours have passed since `memory.last_digest_at` (also true when that key is missing).
5. **Digest report:**
   - `kind: "xauusd_digest"`;
   - `ai_status: "deterministic"`;
   - `severity`: `"warning"` when the decision flips BUY↔SELL against `last_decision`, else `"info"`;
   - `subject`: `XAUUSD H1 <decision> (confidence <c or n/a>) for candle <ISO of candle_open_ms>`, max 200 chars;
   - `body`: `{ candle_key, decision, previous_decision, confidence, entry_price, stop_loss, take_profit, risk_reward, reasoning, decided_at, source, disclaimer: "advisory only; not an order" }`.
6. On a successful publish:
   - set `last_candle_key`, `last_decision` and `last_digest_at`;
   - keep the existing `rememberOutcomeForAgent(…, "xauusd_digest", subject, reportId, report)` call, adapted from `"signal_digest"`.

   If `rememberOutcomeForAgent` takes a kind type that does not allow `"xauusd_digest"`, write `"signal_digest"` there and note it in `STATUS.md`. Do not edit migrations.
7. The platform **never** adds its own opinion, number or advice to the XAUUSD decision. The body copies normalized fields only.

### 4. Schedule

In `scheduled()`, run the Signal Analyst at **minute 22** instead of 7. The XAUUSD chain finishes about 5–20 minutes after the hour, so the 22-minute run usually sees the latest candle. Update the cron comment in `wrangler.toml` if it mentions the Signal Engine timing.

## Budget

- One fetch per hour through a Service Binding (in-account, no egress, no AI).
- At most 1 digest plus 1 stale report and 1 unavailable report per cycle, under the kernel's existing per-agent rate limit.
- AI calls drop by up to about 4 per day, because the failing crypto drafts are gone.

## Acceptance criteria (one `test()` per criterion; rewrite `signal-analyst.test.ts`; use a fake `XAUUSD_AI` binding)

1. **Normalize.** Invalid keys are dropped, `position_size_pct` never appears, numbers are clamped to null when not finite or not positive, `reasoning` is at most 300 characters, and an unknown decision becomes `UNKNOWN`.
2. **Errors.** A missing binding gives `xauusd_binding_missing`. HTTP 500 gives `xauusd_http_500`. A throw gives `xauusd_unreachable`. A never-resolving fetch gives `xauusd_timeout` (use a short injectable timeout in the test). A non-JSON body gives `xauusd_invalid_body`. `observeSignals` never throws.
3. **Stale rule.** The latest candle closed 89 minutes ago gives `stale: false`. It closed 91 minutes ago gives `stale: true`. No items gives `stale: true`.
4. **First digest.** Empty memory and a fresh WAIT give one `xauusd_digest` report with `info` severity, `ai_status: "deterministic"`, the disclaimer present, and the body equal to the normalized fields.
5. **No repeat.** The same candle again within 6 h publishes nothing. A new candle with the same decision within 6 h also publishes nothing.
6. **Change and flip.** A new candle with WAIT→BUY gives `info`. BUY→SELL gives `warning`.
7. **Six-hour heartbeat.** The same decision after 6 h publishes again.
8. **Stale report.** A stale latest gives one `warning` per `candle_key`. The second cycle with the same stale key gives no new stale report.
9. **Unavailable.** One `warning` within 6 h. Repeated failures within 6 h give no further reports.
10. **No AI.** The fake AI binding is never called during a cycle.
11. **Schedule.** `scheduled()` at minute 22 wakes the Signal Analyst. Minute 7 does not.
12. **No regressions.** `npm test` has 0 failures and 0 skipped. Every test you changed is listed in `STATUS.md` with the reason.

## Definition of done

Follow "Definition of done" in `ANTIGRAVITY.md`, then dry-run the AI Kernel:

```bash
npx wrangler deploy --dry-run --config ../ai-kernel/wrangler.toml --outdir /tmp/dry-ai-kernel
```

The dry-run output must list the `XAUUSD_AI` binding.

Fill in `STATUS.md`.

## After merge (orchestrator only)

Deploy Control Plane. At the next minute-22 run, verify in D1:

- an `xauusd_digest` report from `signal-analyst` matches the latest row of `trade_decisions` in D1 `xauusd-signals`;
- or, if XAUUSD is stale, a stale warning was published.

Then TP-018 retires the crypto Signal Engine.
