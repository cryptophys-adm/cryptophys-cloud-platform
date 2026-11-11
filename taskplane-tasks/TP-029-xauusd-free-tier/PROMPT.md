# TP-029: Bring the XAUUSD Workers back inside the free allowances

Owner go: 2026-11-11 ("high usage excess free tier … audit agent yang non critical atau non core yang consume banyak neuron … asses juga penggunaan high usage di D1 row read dan KV writes"; "setuju").

Repository: `cryptophys-adm/xauusd-ai-trading-assistant`. The platform orchestrator does not change that repository; this task is for the agent that maintains it. Open a pull request; do not merge or deploy it yourself.

## Findings (platform side, 2026-11-11)

- **The account is billed.** The Billable Usage API reports Workers AI neurons ($1.41) and Containers memory and disk ($1.20) for the current cycle. On Workers Free neither could accrue, so the account is on Workers Paid and every neuron above 10,000 a day is charged. The 10,000 free neurons a day are shared by every Worker on the account.
- **The platform's own AI use is small.**
  - It made 20.4 AI requests a day from 2026-11-04 to 11-10 (peak 42 on 11-06). These are request reservations in `ai_usage`, not measured neurons.
  - The new cap of 75 requests a day applies to the platform Workers together and is counted in the control-plane D1. It is not a Cloudflare account neuron meter, and it does not cover XAUUSD or Aether or their databases.
  - At the task bounds (~34 neurons a request, an estimate) it allows ~2.6k of the shared 10k.
  - That is why the work below is still needed to keep the whole account inside the allowance.
- **The XAUUSD reasoner uses `@cf/nvidia/nemotron-3-120b-a12b`** (45,455 neurons per million input tokens, 136,364 per million output tokens). That is 5× `gemma-4-26b`. Cloudflare plans to **deprecate it on 2026-11-20**, so the reasoner stops working then unless it moves.
- **Cadence:** the main Worker runs on `10-59/15 * * * *` and `6 * * * *`, and `market-data-ingestion` every 5 minutes. Reports in the last 7 days (shared D1 `agent_reports`):

  | Agent | Reports |
  |---|---|
  | xauusd-reasoner | 131 |
  | xauusd-moderator | 87 |
  | xauusd-risk-manager | 58 |
  | hud-interstellar-eyes | 44 |
  | hud-fabio-amt-sensors | 37 |
  | hud-macro-aether-sensors | 28 |
  | the other HUD agents | 2–19 each |

- **KV writes (free allowance: 1,000 a day):** only XAUUSD binds KV. `market-data-ingestion` (`MARKET_DATA_CACHE`) and the main Worker (`SIGNAL_CACHE`) share namespace `4ada6196…`. A 5-minute cron that writes even 4 keys per run is 1,152 writes a day. `OAUTH_STORE` belongs to the news ingestion Worker.
- **D1 rows read (free allowance: 5 million a day for the whole account):**
  - The platform fixed its own full-table reads in the same PR as this brief. The biggest one read 24,480 rows per call, on every Supervisor cycle and every Console poll.
  - `xauusd-signals` is the largest database on the account (31 MB, against 17 MB for the control plane). Its reads count toward the same daily allowance.
- **Containers:** none of the platform or XAUUSD sources in the session use Containers. Check `xauusd-omega`, Aether and the per-CI `xauusd-ai-preview-*` Workers (one is created per CI run).

## Requirements

1. **Models (owner decision 2026-11-11):** "pilih agent gpt-oss-120b karena punya kelas yang sama … ganti juga semua model yang berpotensi dihentikan".
   - **Correction:** the findings above came from a stale local clone, dated 2026-11-06. XAUUSD `main` already moved the news chain and the H1 Reasoner to `@cf/openai/gpt-oss-120b` on 2026-11-07, and the room agents to `gemma-4-26b-a4b-it`.
   - **No configured or default model is on the 2026-11-20 retirement list:** gpt-oss-120b, gpt-oss-20b, gemma-4-26b-a4b-it, glm-4.7-flash and bge-small-en-v1.5.
   - **Done:** cryptophys-adm/xauusd-ai-trading-assistant#244 adds `RETIRED_MODELS` (the 24 models of the 2026-11-05 notice), removes the glm-5 and nemotron request forms, and adds a test that fails if a default or a wrangler config names a retired model.
   - **Cost:** `glm-4.7-flash` (~77 neurons a call) would cost about a third of `gpt-oss-120b` (~229). The owner chose gpt-oss-120b to avoid a regression, so savings come from the items below, not from the model.
2. **Call the models only when something changed.** Run once per closed candle per timeframe, or when the signal changes, instead of every 15 minutes regardless. Cache the result for an unchanged input (same candle key and the same inputs), for example with AI Gateway caching.
3. **Non-core agents.** Measure the HUD agents (`hud-*`) and the risk manager, then decide per agent: run it without a model (deterministic), merge it into the moderator round, or run it less often. The reasoner and the moderator are the core advisory; change their model and cadence, not their existence.
4. **Per-agent budget.** Route model calls through AI Gateway, or count tokens per agent, so neurons can be attributed per agent. Stop non-core agents first when a daily budget is reached.
5. **KV writes.**
   - Write a key only when its value changed: compare a hash before `put`.
   - Batch several values into one key per run.
   - Give `MARKET_DATA_CACHE` and `SIGNAL_CACHE` separate namespaces.
   - Aim at fewer than 600 writes a day in total.
6. **D1 reads.**
   - Use D1 query insights (`wrangler d1 insights xauusd-signals --sort-by reads`) to list the queries with the most rows read.
   - Index or rewrite every query that scans a whole table on a cron or per request. A typical case is the latest row per key found with a correlated `MAX()`: use an index-backed `ORDER BY … LIMIT 1` per key instead.
7. **Previews.** Delete the `xauusd-ai-preview-*` Workers after their CI run, or reuse a single preview Worker.
8. No trading, no orders, no funds (ADR-0009). Advisory only.

## Done when

- Over 7 days, the account stays under 10,000 neurons, 1,000 KV writes and 5 million D1 rows read a day (Workers AI dashboard per model, D1 and KV metrics).
- No model deprecated on 2026-11-20 is used: not `nemotron-3-120b-a12b`, and not `glm-5.3-flash`.
- The PR lists the measured neurons per agent before and after.
