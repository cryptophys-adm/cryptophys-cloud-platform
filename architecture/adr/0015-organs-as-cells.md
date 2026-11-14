# ADR-0015: Organs as cells: Durable Object actors, push to the senses, D1 as the ledger of facts

- **Status:** Accepted (owner, 2026-11-14: "setuju"). Nothing in the Decision is built yet; the phases below run in order, each in shadow first.
- **Owner direction (2026-11-14):**
  - "Satu-satunya yang memang core system ini adalah Ai Neuron karena ini adalah Ai Operating System" (the only true core is the AI Neuron, because this is an AI Operating System).
  - "alternatif arsitektur lain untuk mengurangi jumlah penulisan maupun akses data ke D1, tanpa mengurangi kemampuan yang sudah ada bahkan mungkin akan lebih meningkatkan lagi secara performa tapi hemat resources/billing" (another architecture that writes to and reads D1 less, without losing any capability and ideally performing better, while saving resources and billing).
- **Builds on:**
  - ADR-0007 (AI Worker OS);
  - ADR-0013 (living platform: organs, DNA, census);
  - the resource audit of 2026-11-14 and its P0 fixes on the platform (bounded drift retention and indexes, migrations 0059 and 0060; the Auditor's incremental chain check; metabolism cycles written on change; drift observations written on change, migration 0061; the archive of the retired signal tables to R2).
- **Applies to:** the platform and XAUUSD. Each repository follows this ADR in its own changes.

## Context

Measured on 2026-11-14:

- **The neuron already sleeps when the market is closed.** There were 2,500–3,000 Workers AI calls a day on 11-11..13 and 30 on Saturday 11-14.
- **The support work does not sleep.**
- **D1 is used as a working set, not as a ledger.**
  - Dashboards poll every 0.5–60 s and recompute rooms and reputation from D1 on every read. Reading the latest War Room costs 20,906 rows; one `outcome_scores` lookup costs 17,389 rows and returns nothing.
  - A War Room writes one row per agent step.
  - Telemetry (drift, metabolism, usage) was inserted unchanged every cycle. On the platform this was about 70% of all D1 writes.
  - About 20 XAUUSD tables have no retention, so every scan grows linearly.

## Decision

1. **The AI Neuron is the only core. Everything else is bones.** Bones are event-driven, keep hot state in memory, and write only when something changes. Savings from the bones are not spent on more support work. They stay as budget for the neuron.

2. **Each organ is a cell: one Durable Object actor.** Examples: Market Feed, the War Room per timeframe, Omega Bridge, the Supervisor.
   - Hot state lives in the DO's memory. Durable state lives in its SQLite storage, written on change and coalesced.
   - DO alarms replace crons where timing matters. A room starts at the bar close, not at the next 15-minute cron window.
   - A cell exposes RPC. Other organs never read its tables.

3. **Push to the senses, not polling.**
   - Nexus, Omega and the Console subscribe to a hub DO over WebSocket using the Hibernation API.
   - A cell publishes a snapshot when its state changes, for example when a room concludes, a decision is made, or a deploy finishes.
   - Polling remains only as a slow fallback (≥ 5 min).
   - Reads that cannot be pushed go through the Cache API (10–300 s).

4. **One document per run.**
   - A room run, decision or card is written once, when it is final, as one D1 row holding the queryable columns and a JSON body.
   - The full transcript is written as an R2 object keyed by run id.
   - Per-step rows stop once the readers have moved to the new shape.

5. **Incremental aggregates.**
   - Reputation, scorecards, budget counters and ledger metrics are kept as small aggregate rows.
   - Each new score updates its aggregate. No reader scans a 30-day window.

6. **Telemetry goes to Workers Analytics Engine.**
   - This covers drift observations, metabolism cycles, AI usage, health checks, syscall consumptions and latency.
   - D1 keeps only state changes and the audit events of state changes.
   - Analytics Engine is not a record of truth: it samples, and it keeps data for a limited time (check the current limits and retention in the Cloudflare documentation before phase 3). Audit, money, trades, decisions and proposals never go there.

7. **D1 is the ledger of facts.**
   - D1 holds the facts: audit chain, decisions, trades, proposals and votes, accounts, registry, doctrine, and run documents.
   - Every WHERE and ORDER BY on a hot path has an index.
   - Every index is justified, because each one adds a row write.
   - Prefix predicates use ranges, never LIKE.
   - There are no heartbeat UPDATEs beyond the one the registry already carries (the Drift Detector's `service_registry.updated_at`, migration 0061).

8. **Long memory lives in R2.**
   - Facts older than the hot window (30–90 days per table) move to R2 as NDJSON or Parquet.
   - Append-only event streams (scores, ledger, decisions) may flow through Pipelines into R2 Iceberg tables, so Aether can query the full history with SQL.
   - The audit chain stays in D1 with checkpoints.

## Phases

Each phase runs in shadow first: the old and new paths are compared, then the old path is retired. The resource audit's P0 fixes come first.

Platform order (owner, 2026-11-14):

| # | Phase | Main effect |
|---|---|---|
| 1 | Push hub DO (WebSocket Hibernation) for the Console; Cache API for the remainder | Dashboard reads drop to near zero; real-time UI |
| 2 | Incremental aggregates: the Supervisor's observe() snapshot in the SupervisorAgent DO | Each Supervisor cycle reads its own snapshot instead of scanning D1 |
| 3 | Telemetry to Analytics Engine: drift observations, metabolism cycles, AI usage, syscall consumptions | Most remaining platform telemetry writes leave D1; richer metrics |
| 4 | Retention with an R2 archive, including the five retired signal tables (archive verified, then dropped by migration with the owner's click) | D1 size stops growing; full history for Aether |

XAUUSD order (in its own repository): push hub for Nexus and Omega; run documents and reputation/scorecard aggregates (room and card reads: 1 row instead of 15–20k; ~4k fewer row writes a day); telemetry to Analytics Engine; Market Feed DO and Omega Bridge DO (KV reads per minute become memory, bridge writes only on change, bar-close timing); retention with an R2 archive.

## Rules that do not change

- Consensus, the brake, rollback and backups.
- The append-only audit chain.
- Trading actions need the owner's click.
- Workers AI models and budgets are outside this ADR.

## Consequences

- **Good:**
  - D1 rows read and written fall by an order of magnitude;
  - dashboards become real-time;
  - room and decision timing aligns with bar closes;
  - history is no longer bounded by D1 size;
  - the budget saved goes to the neuron.
- **Costs:**
  - a staged migration per organ;
  - a DO processes one request at a time, which suits an organ;
  - a new hub component;
  - Analytics Engine data is approximate and short-lived, which is why records of truth stay in D1.

## Alternatives considered

- **Keep D1 as the working set and only add indexes and caches.** It removes the worst scans (the P0 fixes) but keeps per-cycle writes and per-read recomputation, which grow with history.
- **An external time-series database.** Rejected: production runs on Workers and their bindings only (ADR-0005 decision 1).
