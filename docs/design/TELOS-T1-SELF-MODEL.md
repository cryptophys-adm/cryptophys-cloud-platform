# Design: Telos T1, the daily self-model snapshot

- **Status:** design (2026-11-22), for the owner's review; nothing is built.
- **Owner request (2026-11-22):** asked to fix the feedback loops that never ran, the owner answered "ya kerjakan nomor 1 dan semuanya" (yes, do number 1 and all of them). T1 is the first missing loop: every KPI baseline in `organism/vision.json` is `null`, and nothing measures the organism against its own goals.
- **Implements:** ADR-0016 §2 ("A self-model") and phase T1 ("Self-model snapshot, daily"). The progress manifest `architecture/adr/progress/0016.json` says of T1: `not_measurable_yet: "no self-model table or R2 snapshot exists yet"`, with the reading `adr_index_live`, and next "Build the daily self-model; its Memory section reads the ADR Steward's documents".
- **Reads with:** ADR-0016 ("Rules that do not change": learning is the highest mandate, no fund movement, guard paths); ADR-0015 (one D1 row with a JSON body; telemetry is never a record of truth); ADR-0020 §3 rule 1 and `docs/design/HAIC-H3.md` §4.4 (no price level leaves xauusd); `docs/design/ADR-STEWARD.md` (its documents are T1's "Memory: ADR index"); `docs/SSOT.md`; `AGENTS.md` (Console truthfulness).
- **Base:** canonical main `6a4010c`. Every "exists" claim names a file on that commit. Everything else is marked **new**.

## 1. Goals and non-goals

### Goals

1. **One measured picture of the organism, once a day.** A deterministic snapshot of what the organism knows about itself, in five sections: Body, Mind, Memory, Will and Ecosystem (§3).
2. **Every value is a measurement or an honest null.** Each value carries its source, its window and its `as_of`. When it cannot be measured it is `null` with a reason. There is never a default number (AGENTS.md; `control-plane-shared/test/console-truthfulness.test.ts`).
3. **The vision's KPIs get measured values.** Each KPI in `organism/vision.json` gets a measured value or a null with a reason, through a reviewed binding (§6). Baselines and targets stay exactly as the owner wrote them.
4. **Read surfaces.** A read-only kernel route, the Console Vision page, a read-only chat tool, and later the Strategist's input (T2).
5. **Cheap and quiet.** No AI call, D1 reads only, one write a day. The bones stay "event-driven, cheap, and write only on change" (the constitution).

### Non-goals

- **No Strategist (T2), no intents (T3), no vision growth (T4).** T1 computes no gap, ranks nothing and proposes nothing.
- **No action of any kind** (§8).
- **No new agent.** The snapshot is a kernel job, like `evolution_intake` and `autonomy_downgrade` in `ai-kernel/src/index.ts`. It holds no capability, makes no syscall and needs no DNA gene, so no guard path changes (§9).
- **No reads outside D1 in T1:** no Cloudflare API call, no xauusd or Aether RPC, no Analytics Engine query (§2.3).
- **No baseline.** The self-model reports measured values. A baseline stays `null` until the owner sets one in `organism/vision.json`, a guard path (`vision_core`).

## 2. What exists today

### 2.1 Sources the self-model can read (all in D1 `cryptophys-control-plane`)

| Source | Where it is written | Fields used | Notes |
|---|---|---|---|
| `agent_reports` (migration 0012; kinds widened in 0017 and 0027) | `ai-kernel/src/reports.ts` (`REPORT_KINDS`) | `agent_id`, `kind`, `severity`, `subject`, `body_json`, `created_at`; index `agent_reports_agent_created` | Holds every source below that is a report |
| Trading organ health, `xauusd_digest` with `body.schema = "trading_organ_health.v1"` | Signal Analyst, `ai-kernel/src/signal-analyst.ts` (`SNAPSHOT_SCHEMA`, `ORGAN_HEALTH_METRICS`: 15 metrics) | `{metric, value, baseline_7d, z}`; for `hit_rate_7d` and `hit_rate_30d` also `status`, `n_directional`, `hit`, `miss`, `wait_accuracy`, `subject`, `as_of` | Read through the whitelist `presentOrganHealth` (`ai-kernel/src/syscall.ts`): numbers and names only, never a price |
| Observer advisories, `platform_digest` with `body.source = "observer"` | `platform-api/src/index.ts` `publishAdvisory`, agent `platform-api` | findings `{worker, metric, value, baseline_7d, z, since_deploy}` | Warnings only; the record of truth is `observer_findings` |
| `observer_vitals`, `observer_findings`, `observer_runs` (migration 0063) | `control-plane-shared/src/observer.ts`, `observer-inventory.ts` | vitals per subject and hour (`requests`, `errors`, `rows_read`, `rows_written`, `neurons`, `cpu_p99_ms`, `exceeded_cpu`, `exceptions`; NULL is "not measured"); findings by `kind`; inventory runs' `findings_json` (`undeclared_worker`, `orphaned_declaration`, ...) | Kept 30 days (vitals, runs) and 90 days (findings) |
| Census and DNA, `forge_organism_census` (migration 0040) | `forge/src/census.ts`; read in `ai-kernel/src/organism.ts` | `main_sha`, `status`, `organs`, `agents`, `engines`, `voters`, `findings`, `genome`, `taken_at` | Covers the external origins in `EXTERNAL_ORIGINS` (`control-plane-shared/src/organism.ts`): xauusd, aether, cta |
| `service_registry`, `deployment_requests`, `drift_observations` (migration 0001; `streak` in 0061) | Platform Registry, Orchestrator, Drift Detector | registry `status`, `desired_version`, `observed_version`, `updated_at` (the heartbeat); requests by `status` and `created_at`; drift rows | Persistent drift by `isPersistentDrift` (`control-plane-shared/src/drift-state.ts`); retired services excluded by `notRetiredSql` (`retired.ts`) |
| `consensus_proposals` (migration 0023; `autonomy_level` in 0083), `consensus_controls`, `kernel_controls` | `ai-kernel/src/consensus.ts` | `action`, `target`, `class`, `status`, `mode`, `created_at`, `decided_at`; the mode; `agents_enabled` | Rollbacks are `action = 'rollback_worker_version'` (`ai-kernel/src/observer-watch.ts`); merges are `merge_change` and `merge_owner_change` (`supervisor.ts`) |
| `autonomy_dial` (migration 0083) | `control-plane-shared/src/autonomy-dial.ts` (`AUTONOMY_GROUPS`, `AUTONOMY_LEVELS`) | `group_id`, `level`, `source`, `set_at` | No row means the group is at its ceiling (the migration's own definition), so "ceiling" is a measured state, not a default |
| `adr_progress` (migration 0075) | ADR Steward, `ai-kernel/src/adr-steward.ts`; read by `adrListView` (`ai-kernel/src/adr-view.ts`) | per ADR `status`, `percent`, `percent_proven`, `phases_*`, `changed_at`, and drift and stale flags in `body_json` | T1's "Memory: ADR index" |
| `knowledge_proposals` (migration 0029; dedup in 0070) | `ai-kernel/src/knowledge.ts` | `kind`, `status`, `created_at`, `decided_at` | Aether's `knowledge_audit` reports are in `agent_reports` |
| `corrections` (migration 0084) | `ai-kernel/src/corrections.ts`; teaching record `control-plane-shared/src/teaching-record.ts` (`teachingRecord`), served by `reputationView` (`ai-kernel/src/corrections-read.ts`) | `label`, `source`, `side`, `subject`, `weight`, `created_at` | Counts and scores only; the text and the actor are never copied |
| `councils` (migration 0079) | `ai-kernel/src/council.ts` | `side`, `state`, `spent_calls`, `spent_usd`, `created_at` | |
| `evolution_intents_v2`, `evolutions_v2`, `evolver_controls` (migrations 0076, 0077) | `ai-kernel/src/evolution-intake.ts`, `evolver.ts`; mode by `evolverMode` (`evolution-view.ts`) | intent `source`, `state`; evolution `state`, `ai_calls`, `refusals_json` | |
| `ai_usage` (0003), `ai_failures` (0019) | `control-plane-shared/src/ai-engine.ts` (`recordFailureCategory`) | requests and failures per service and day; failures per `task` and `category` (`empty_response`, `truncated`, `output_budget_exhausted`, `schema:*`, `timeout`, `inference_failed`, ...) | |
| `infra_burn_metrics`, `metabolism_controls` (0043) | `control-plane-shared/src/cf-usage.ts` `persistBillableMetrics` (on a `GET /v1/usage` read); the Supervisor | per day and service `estimated_cost_usd`, `ai_neurons`, `calculated_at`; `power_mode` | Neuron costs are filed under `cryptophys-ai-kernel`, the rest under `cryptophys-platform-api` |
| `forge_builds` (0049), `forge_dependency_audits` (0051), `forge_change_requests` (0037, 0052) | Forge | build minutes; advisories by severity; change requests by `status`, `outcome_at` | Build budget `BUILD_MINUTES_BUDGET` (`control-plane-shared/src/build-usage.ts`) |
| `agent_memories` (0014), `agents` | `ai-kernel/src/memory.ts`; registry | counts per agent and status | Read only. Learning is never limited or touched |

### 2.2 What else exists

- **The vision** is bundled into the kernel (`ai-kernel/src/vision-view.ts` imports `organism/vision.json`) and validated by `visionProblems` and `parseVision` (`control-plane-shared/src/vision.ts`). Five goals, nine KPIs, every baseline `null`.
- **The kernel's cron** runs at `7,22,37,52 * * * *` (`ai-kernel/wrangler.toml`). Each job is timed into Analytics Engine by `trackJob` (`ai-kernel/src/analytics/telemetry.ts`). The Telemetry tab lists the jobs in `JOB_ORDER` (`ai-kernel/src/telemetry-view.ts`, 10 jobs today). Two tests pin that list: AW5 (`test/analytics-engine-writer-2026-11-22.test.ts`) and TV4 (`test/telemetry-view-2026-11-22.test.ts`, `JOB_ORDER.length === 10`).
- **R2.** The kernel binds one bucket, `TRANSCRIPTS` (`cryptophys-council-transcripts`, HAIC H1.5e). `docs/design/ADR-STEWARD.md` §4.6 still says the kernel binds no R2 bucket; that was true on its base commit and is stale now.
- **Read-only chat tools** are listed in `CHAT_TOOLS` (`control-plane-shared/src/conversation.ts`), among them `vision`, `adr_progress`, `census` and `owner_corrections`.

### 2.3 What the self-model does not read

- **Analytics Engine telemetry** (`GET /v1/telemetry`, `telemetry-view.ts`). AL3 in `test/analytics-engine-legal-2026-11-22.test.ts` allows one reader (`analytics/read.ts`), imported only by the telemetry view, and ADR-0015 decision 6 says nothing reads telemetry back to decide. A snapshot meant as the Strategist's input would break that, so T1 only writes its own job timing there (§5.6).
- **`GET /v1/usage` live.** The Cloudflare token lives only in the Platform API (`platform-api/src/index.ts`). T1 reads what that route persists (`infra_burn_metrics`) and the Observer's vitals, which come from the same GraphQL datasets.
- **xauusd, Aether and CTA directly.** T1 reads what the platform already holds about them (reports, census, registry, vitals). Omega health (`XAUUSD_OMEGA_HEALTH`), the market regime and the session calendar stay `null` with a reason (Q9).

## 3. What the self-model is

A **daily, deterministic snapshot of measured self-knowledge**. It is assembled by code from D1 rows and the bundled vision; no AI writes or judges any part of it. ADR-0016 §2 names Body, Mind, Memory, a Code map and Ecosystem. This design keeps those names and adds **Will** (the vision against measurement). The Code map is out of scope for T1: the Forge's census and the ADR index cover what can be measured today.

| Section | Contents (each value a measure, §4.1) | Main sources |
|---|---|---|
| **Body** | Workers: count by status, drifted now (persistent), versions desired against observed. Deploys: requests by status (7 d, 30 d), executed rollbacks (30 d). Vitals per platform Worker (24 h, 7 d): requests, error ratio, CPU p99, exceeded CPU. Free-limit use per day against `FREE_LIMITS` (`cf-usage.ts`). Cost: billable estimate month to date per service. Build minutes this month against the budget. Anomalies: Observer findings by kind (7 d) and the top 5 by \|z\|. Inventory: the newest run's finding counts. Census: the newest row's status and counts. Controls: kill switch, consensus mode, power mode, the autonomy level of each group | registry, drift, deployment requests, consensus, Observer tables, `infra_burn_metrics`, `forge_builds`, census, controls, `autonomy_dial` |
| **Mind** | Trading organ: the newest `trading_organ_health.v1` at or before the window end, all 15 metrics with `baseline_7d`, `z` and the hit rates' `status`, plus the report's age. AI health: requests and failures per service (7 d); failures per task and category (7 d). Councils: count by state, calls and spend (30 d). Consensus: proposals by status and class (30 d), waiting for the owner now. Evolver: mode, intents by state, evolutions by state, refusals (30 d). Teaching record: score and `n` per subject (7 d, 30 d) | `agent_reports`, `ai_usage`, `ai_failures`, `councils`, `consensus_proposals`, evolution tables, `corrections` via `teachingRecord` |
| **Memory** | ADR index: per ADR status, percent, percent proven, drift count, stale flag, `changed_at`, plus the reading `adr_index_live`. Knowledge: proposals by kind and status (30 d), pending now, Aether's newest `knowledge_audit` report (subject and time only). Corrections: count by label, source and side (7 d, 30 d). Memories: count per agent. Learning watch: `learning_volume` and `learning_repeat` findings (7 d). The experience ledger: `null`, not built (T3) | `adr_progress`, `knowledge_proposals`, `agent_reports`, `corrections`, `agent_memories`, `observer_findings` |
| **Will** | The vision: schema, sha256 and validity of the bundled file. Per goal and KPI: `baseline` and `target` copied verbatim, the `source` the vision names, the **measured** value through its binding (§6), and the binding's definition. Totals: KPIs measured against KPIs listed | bundled `organism/vision.json`, the other sections |
| **Ecosystem** | xauusd, Aether and CTA: registry status and versions, whether the census could read their DNA, vitals of their Workers (24 h), and for xauusd the age of the newest trading organ snapshot. Dependency advisories: the newest audit's critical, high and moderate counts. Workers AI model catalog and deprecations, the Cloudflare changelog, market regime and session calendar: `null`, with the reason that no platform source reads them yet | registry, census, `observer_vitals`, `agent_reports`, `forge_dependency_audits` |

The lists are bounded (top 5, top 10) and say how many were left out.

## 4. Data model

### 4.1 One measure (new)

```json
{ "value": 0.53, "unit": "ratio", "window": "30d", "as_of": "2026-11-22T21:00:00Z",
  "source": "agent_reports:trading_organ_health.v1", "ref": "ev:platform/report/rpt_…#metrics", "reason": null }
```

- `value` is a finite number, a short string from a closed list (a status or a level), a boolean, or `null`.
- `value` is `null` **exactly when** `reason` is set. Reasons are a closed list: `no_rows`, `source_unavailable`, `missing_table`, `not_built`, `source_outside_platform`, `no_binding`, `definition_pending`, `subject_mismatch`, `no_scored_data`, `unavailable_source_field`, `stale`, `budget_exceeded`, `division_by_zero`.
- A non-null value needs `source` and `as_of`. `as_of` is the time of the newest row that went into it, never the compute time.
- A row's presence is the measurement. A column that defaults to 0 (`infra_burn_metrics.estimated_cost_usd`, `councils.spent_usd`, `ai_usage.failures`) is read only from rows that exist. No rows is `no_rows`, never 0.
- `ref` follows the `ev:` grammar (`parseRef`, `control-plane-shared/src/council.ts`) and is refused when `refCarriesPrice` holds.

### 4.2 The document: `organism.self_model.v1` (new)

```json
{
  "schema": "organism.self_model.v1",
  "day": "2026-11-22",
  "window_end": "2026-11-23T00:00:00Z",
  "vision": { "schema": "organism.vision.v1", "sha256": "…", "valid": true },
  "sections": { "body": {}, "mind": {}, "memory": {}, "will": { "goals": [] }, "ecosystem": {} },
  "sources": [ { "id": "observer_vitals", "status": "ok", "rows": 6840, "as_of": "…", "point_in_time": false } ],
  "counts": { "measured": 0, "null": 0, "kpis_measured": 0, "kpis_total": 9 },
  "content_sha256": "sha256 of the canonical document without computed_at and deployed_commit",
  "computed_at": "…", "deployed_commit": "… | null"
}
```

- A source's `status` is `ok`, `empty`, `unavailable`, `missing_table` or `not_built`. A source that has no history (registry status, controls, the autonomy dial, `adr_progress`) is read as it is at compute time and marked `point_in_time: true`.
- The snapshot is `complete` when every source is `ok` or `empty`, otherwise `partial`.

### 4.3 The validator (new, `control-plane-shared/src/self-model.ts`)

`selfModelProblems(doc)` lists every problem, as `visionProblems` does in `vision.ts`. It checks:

- the schema and its keys, and the null-with-reason rule of §4.1 for every measure;
- the five sections, and that Will lists every KPI of the bundled vision exactly once;
- every ref through `parseRef` and `refCarriesPrice`;
- forbidden keys anywhere: `price`, `level`, `entry`, `sl`, `tp*`, `lot`, `params`, `action`, `propose`, `vote` (the `forbiddenKeys` pattern of `knowledge.ts`);
- a body of at most 64 KB, with finite numbers only.

The kernel checks every snapshot before it writes it and again before it serves it. An invalid one is reported with its problems and never served as valid, as `GET /v1/vision` does.

### 4.4 Storage: migration `0087_self_model.sql` (new, additive only)

```sql
CREATE TABLE IF NOT EXISTS self_model_snapshots (
  day TEXT PRIMARY KEY CHECK (length(day) = 10 AND day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  schema TEXT NOT NULL CHECK (schema = 'organism.self_model.v1'),
  status TEXT NOT NULL CHECK (status IN ('complete', 'partial')),
  sources_ok INTEGER NOT NULL CHECK (sources_ok >= 0),
  sources_total INTEGER NOT NULL CHECK (sources_total >= 0),
  measured INTEGER NOT NULL CHECK (measured >= 0),
  nulls INTEGER NOT NULL CHECK (nulls >= 0),
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  body_json TEXT NOT NULL CHECK (json_valid(body_json) AND length(body_json) <= 65536),
  computed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS self_model_kpis (
  day TEXT NOT NULL,
  goal_id TEXT NOT NULL CHECK (length(goal_id) BETWEEN 3 AND 60),
  kpi_id TEXT NOT NULL CHECK (length(kpi_id) BETWEEN 1 AND 80),
  value REAL,
  reason TEXT CHECK ((value IS NULL) = (reason IS NOT NULL)),
  source TEXT,
  as_of TEXT,
  PRIMARY KEY (day, goal_id, kpi_id)
);
```

- **Why D1 and not R2 (Q1).** ADR-0016 §2 says the snapshot is stored in R2 with its index row in D1. A snapshot is a few tens of kilobytes. ADR-0015 §4 allows one D1 row with a JSON body, and the ADR Steward does the same (`adr_progress`). R2 would need a new bucket, which the owner creates, and a new kernel binding. The D1 table is the "self-model table" the manifest's T1 evidence asks for.
- **Why a KPI table.** Trends on the Vision page and the Strategist's history need only the KPI values. Reading 30 bodies of 64 KB to draw one line would be wasteful; nine small rows a day are not.
- **Writes.** One snapshot row and up to about ten KPI rows a day. A later attempt the same day may replace a `partial` row with a `complete` one (`UPDATE … WHERE day = ? AND status = 'partial'`). A `complete` row is never rewritten. No heartbeat UPDATE (ADR-0015 §7).
- **Migration number.** 0086 is the newest on `6a4010c`. The build takes the next free number when it lands; a lower number cannot be held once a higher one is applied (`migration_out_of_order`, `HAIC-H3.md` §11).

### 4.5 Retention (Q2)

- Snapshots: 400 days in D1 (a year plus a month, for year-on-year comparison). At about 30 KB that is about 12 MB.
- KPI rows: kept, at about 3,300 rows a year.
- The sweep is a bounded DELETE in code at 03:07 UTC, next to `pruneSyscallConsumptions` (`ai-kernel/src/retention.ts`). It is not a migration.

## 5. How it is computed

### 5.1 Who and when

- **A kernel job, not an agent:** `ai-kernel/src/self-model.ts` (new) with the pure assembler in `control-plane-shared/src/self-model.ts`. It is called from `scheduled()` in `ai-kernel/src/index.ts` as `trackJob(env, "self_model_snapshot", …)`.
- **Schedule (Q3):** at **00:52 UTC**, for the UTC day that just ended. By then the Observer has sensed the 23:00 hour (at 00:27), and the Signal Analyst has run at 00:22. If the row is missing or `partial`, the 01:52 and 02:52 ticks try again. Other ticks cost one primary-key read.
- **No AI.** It imports nothing from `ai-engine.ts`, never touches `env.AI` and needs no AI budget. Power mode and the AI caps cannot affect it.
- **Under the kill switch** it still runs (Q7). It is observation, like the Observer, and records `agents_enabled` as a Body value.

### 5.2 One run

1. Read the bundled vision and validate it (`visionProblems`).
2. Set `window_end` to 00:00 UTC of the day after `day`. Every query reads rows with a time at or before `window_end` (`created_at`, `hour`, `observed_at`, `taken_at`, `decided_at`).
3. Read each source with its own fixed, parameterised, LIMITed query on an existing index. A source that fails or passes its time budget becomes `unavailable` or `budget_exceeded`. Its values are null with that reason, and the rest go on.
4. Compute each section with pure functions. Compute Will last, through the KPI bindings (§6).
5. Put the document in canonical form (sorted keys, numbers rounded to 4 decimals), hash it, and validate it.
6. Write the rows (§4.4) and one audit event, `self_model.snapshot_written`, with `appendAuditEvent` (`control-plane-shared/src/audit.ts`). The event carries `day`, `status`, `content_sha256`, the source and value counts, and no values.

### 5.3 Determinism

- The same D1 rows and the same bundled vision give a byte-identical `content_sha256`. A test proves it: rows inserted after `window_end` change nothing.
- Point-in-time sources are the exception, and they are marked (§4.2).

### 5.4 Bounds

- At most 40 statements a run. Every query has a LIMIT and uses an index; the test checks the query plans with `EXPLAIN QUERY PLAN` on `node:sqlite` fixtures built from the real migrations, as `test/adr-evidence.test.ts` does.
- About 20,000–40,000 rows read a run. `observer_vitals` over 30 days for the platform Workers only is the largest part, read through its `(subject, hour)` key. That is under 1 % of the 5,000,000-row daily free limit.
- A wall budget of 20 s for the run and 3 s for each source; CPU is a few hundred milliseconds of aggregation. Bodies are at most 64 KB, and lists are cut to their top entries with the number left out.

### 5.5 Failure modes

| Failure | Effect |
|---|---|
| A source fails or is slow | Its values are null (`source_unavailable`, `budget_exceeded`); the snapshot is `partial`; retried at 01:52 and 02:52 |
| A table is missing (a migration not yet applied) | `missing_table`; never a default row |
| The vision is invalid | Will lists the problems and no KPI is measured; the other sections are written |
| The snapshot fails its own validator | Not written; the job fails (seen in telemetry) and a log line names the problems |
| No run for a day | The route serves the newest snapshot and its age; the Console shows the age, not a stale value as current |
| The migration is not applied | The route answers `available: false` |

### 5.6 Telemetry

- The job is timed by `trackJob` as `self_model_snapshot`. It joins `JOB_ORDER` in `telemetry-view.ts` after `adr_steward_cycle`, making 11 jobs. AW5 and TV4 are updated in the same change.
- Only the job's timing and outcome go to Analytics Engine. The snapshot never reads telemetry back (§2.3).

## 6. Filling the vision KPIs

A **binding** is a named, pure function in `control-plane-shared/src/self-model-kpis.ts` (new) from the other sections to one measure, with a one-line definition shown beside the value. A KPI without a binding is null with `no_binding`. A test requires every KPI of `organism/vision.json` to have either a binding or an explicit `unbound` entry with its reason. A new KPI therefore stays visibly unmeasured until a reviewed binding lands. The owner confirms each definition (Q4).

| Goal / KPI | Vision `source` | Proposed binding (default) | Null when |
|---|---|---|---|
| g-accuracy / `decision_hit_rate_15m` | outcome_scores | `hit_rate_30d` of the newest `trading_organ_health.v1`, only when its `subject` is `engine:15` (the M15 Decision Engine) and `status` is `ok`; the 7-day rate is shown in Mind | `subject_mismatch`, `no_scored_data`, `unavailable_source_field`, `no_rows` |
| g-accuracy / `agent_grounding_rate` | metric_shadow | Unbound: xauusd's metric shadow is not read by the platform | `source_outside_platform` |
| g-efficiency / `neurons_per_correct_call` | neuron-allocation | Account Workers AI neurons over 30 days (`observer_vitals`, kind `ai`) ÷ `hit` of the 30-day window | `definition_pending` until confirmed; `division_by_zero` when `hit` is 0 |
| g-efficiency / `infra_cost_usd_month_excl_ai` | billing | Sum of `infra_burn_metrics.estimated_cost_usd` for the current UTC month, excluding `cryptophys-ai-kernel` (where neuron costs are filed). These are billable overages, an estimate per day, written only when `GET /v1/usage` is read; the $5 plan is not in them | `no_rows` (no billable usage recorded this month) |
| g-autonomy / `changes_merged_by_consensus_share` | forge_change_requests | Over 30 days: merged change requests whose merge was an executed `merge_change` proposal (routine consensus) ÷ all merged change requests | `no_rows`, `division_by_zero` |
| g-autonomy / `mean_time_to_rollback_minutes` | Observer + deployment_requests | Over 30 days, per executed `rollback_worker_version` proposal whose params name an Observer `finding_id`: execution time − the finding's `created_at`; the mean | `no_rows` (no rollback in the window: null, never 0) |
| g-resilience / `uptime_core_workers` | Observer | A proxy, named as such: 1 − errors ÷ requests over 30 days for the Workers of the control-plane deploy unit (`observer_vitals`) | `no_rows`, or `definition_pending` if the owner rejects the proxy |
| g-resilience / `recovery_drill_pass` | Strategist drills | Unbound: drills are scheduled by the Strategist (ADR-0016 §6) | `not_built` |
| g-self-knowledge / `undeclared_components` | census inventory diff | The number of `undeclared_worker` findings in the newest Observer inventory run | `no_rows` |

- The binding never writes the vision. Baseline and target are copied verbatim; a `null` baseline stays `null` and reads "not measured yet" on the Vision page (`NOT_MEASURED`, `console/ui/src/pages/Vision.tsx`).
- T1 computes no gap and no verdict against a target. That is the Strategist's job (ADR-0016 §3).

## 7. Read surfaces

| Surface | Who | What |
|---|---|---|
| `GET /v1/self-model` (new, AI Kernel) | Operators and viewer accounts, as `GET /v1/vision` | `{schema: "organism.self_model-view.v1", available, newest: {day, status, computed_at, age_h, problems, body}, days: [the last 30 index rows]}` |
| `GET /v1/self-model/{day}` (new) | Same | One day's body, or 404 |
| `GET /v1/self-model/kpis?days=90` (new) | Same | The KPI series from `self_model_kpis`, at most 400 days |
| Console | Everyone who can open the Vision page | Allow-list rows `kernel.self_model`, `kernel.self_model_day` and `kernel.self_model_kpis` (`console/src/index.ts`, `console/src/ui/routes.ts`), read-only. On the Vision page each KPI gains a "measured" cell: the value, window, `as_of` and definition, or "not measured yet" with the reason in words. A new sub-page `#/vision/self` shows the five sections and the source list with each source's status and age |
| Chat tool `self_model` (new, in `CHAT_TOOLS`) | The owner's chat | One section of the newest snapshot, quoted as data, with refs `ev:platform/self_model/<day>#<section>.<key>` (Q8) |
| T2 (not in scope) | The Strategist | The newest body as its large, stable, cached prompt prefix (ADR-0016 §3), and the KPI series |

All routes are GET only and answer `405` otherwise. Cache-Control is `private, max-age=300`.

## 8. What it never does

- **No action.** No syscall, no `consensus.propose`, no vote, no council proposal, no evolution intent, no typed proposal, no report, no owner notice. `evolution_intake` and `council-proposals.ts` do not read the self-model in T1.
- **No parameter.** It never writes `policy_parameters`, `autonomy_dial`, `metabolism_controls`, `consensus_controls`, `kernel_controls` or the vision.
- **No price level** (ADR-0020 §3 rule 1; `HAIC-H3.md` §4.4). Trading values pass through the `presentOrganHealth` whitelist; refs are checked with `refCarriesPrice`; the validator refuses price keys.
- **No trading and no money beyond infrastructure cost.** No deal result, P&L, treasury or account figure is copied (Q6). Funds are never moved.
- **No AI call, no network call and no telemetry read.**
- **No learning limit.** It counts memories, knowledge and corrections. It never calls, delays or caps `memory.remember` or `knowledge.propose`, and it never touches `power-mode.ts`.
- **No secrets and no identities.** No email, actor, correction text or report text is copied.

A static test, `test/self-model-boundary-t1.test.ts` (new), enforces this. The two modules may only read D1, except for INSERT and UPDATE on the two new tables and the audit append. They may not use `fetch(`, `env.AI`, `ai-engine`, `analytics/`, `syscall(`, `consensusPropose`, `insertDraft` or any executor.

## 9. Guard paths touched

Checked against `workers/control-plane-shared/src/guard-paths.ts` on `6a4010c`.

| Step | Paths | Guard reason | Merge |
|---|---|---|---|
| 1–7 | `control-plane-shared/src/self-model.ts`, `self-model-kpis.ts` (new); `ai-kernel/src/self-model.ts` (new), `index.ts`, `telemetry-view.ts`, `retention.ts`; `control-plane-migrations/0087_self_model.sql`; `console/src/index.ts`, `console/src/ui/routes.ts`, `console/ui/src/pages/Vision.tsx`; `control-plane-shared/src/conversation.ts`; tests; `architecture/adr/0016-telos.md`, `architecture/adr/progress/0016.json`, `docs/SSOT.md`, this document | none | routine `merge_change` |
| Never | `organism/vision.json`, `control-plane-shared/src/vision.ts` (`vision_core`; only imported); `ai-kernel/organism.json`, `capabilities.ts`, `guard-paths.ts` (`evolution_guard`: no agent, no capability); `consensus-*.ts`, `autonomy-dial.ts` (`consensus_kill_switch`; only read); `organism.ts` (`capability_ceiling`; only read); `power-mode.ts` and the learning tests (`learning_mandate`); `console/ui/package.json` (`typecheck_harness`); `ai-kernel/wrangler.toml` (no new binding while storage is D1, Q1) | — | not touched |

If the owner chooses R2 (Q1, option B), step 4 adds an R2 binding to `ai-kernel/wrangler.toml`. That file is not a guard path, but the owner creates the bucket first, and the native deploy plans the new binding as `changes.added` (`deployment-orchestrator/src/config-diff.ts`).

## 10. Risks

- **A binding that measures the wrong thing reads as truth.** Mitigation: each definition is shown beside its value, the owner confirms each one (Q4), and a proxy is labelled as one.
- **A stale value presented as current.** Mitigation: `as_of` on every value, the source list with ages, `point_in_time` flags, and the snapshot's own age on the Console.
- **Columns that default to 0** (`infra_burn_metrics`, `councils.spent_usd`, `ai_usage.failures`) read as measured zeros. Mitigation: only rows that exist count (§4.1); fixtures test the empty case.
- **A price leak through the trading organ or a ref.** Mitigation: the `presentOrganHealth` whitelist, `refCarriesPrice`, forbidden keys, and fixtures with price-bearing inputs.
- **The Strategist over-trusting a partial snapshot (T2).** Mitigation: `status`, the source list and null reasons are part of the document that T2 reads.
- **D1 load creeping up as sources are added.** Mitigation: the statement cap, the query-plan test and the 64 KB body cap.
- **Weakening the telemetry boundary.** Mitigation: T1 reads no telemetry; AL3 stays unchanged.
- **Migration number collision** with an in-flight branch. Mitigation: take the next free number at rebase.
- **Scope creep into action.** Mitigation: the boundary test, and T2 as a separate ADR phase with its own review.

## 11. Open questions for the owner

1. **Q1. Storage.** Option A, recommended: D1 only, with the body in `self_model_snapshots` (at most 64 KB) and the KPI series in `self_model_kpis`. There is no new bucket or binding; an R2 archive can come with ADR-0015 phase 4. Option B: a new bucket `cryptophys-self-model` (created by the owner) holding one object a day, with the D1 index row. ADR-0016 §2 says R2, so option A is recorded as a T1 note in the ADR.
2. **Q2. Retention.** Recommended: snapshots 400 days in D1, KPI rows kept.
3. **Q3. Schedule.** Recommended: 00:52 UTC for the UTC day that ended, with retries at 01:52 and 02:52.
4. **Q4. The KPI bindings of §6.** Recommended: accept the table as written. In particular:
   - `decision_hit_rate_15m` is the 30-day hit rate of `engine:15`;
   - `uptime_core_workers` is the labelled proxy 1 − errors ÷ requests;
   - `neurons_per_correct_call` is account neurons ÷ hits over 30 days;
   - `infra_cost_usd_month_excl_ai` is the recorded billable estimate, excluding the kernel's neuron line.
5. **Q5. A plain-English summary.** Recommended: none in T1. If wanted later, it is one optional AI call a day in a separate field, with its own validator, never feeding a number. The snapshot stays complete without it.
6. **Q6. Money in the self-model.** Recommended: infrastructure cost only. No deal result, P&L, treasury balance or account figure, even though `metabolism_cycles` holds some.
7. **Q7. Under the kill switch.** Recommended: the job keeps running, because it is observation and takes no action.
8. **Q8. The chat tool `self_model` in T1.** Recommended: yes, read-only, one section at a time.
9. **Q9. xauusd, Aether and CTA beyond what the platform already holds.** Recommended: T1 reads D1 only. Omega health, market regime and session calendar stay null (`source_outside_platform`) until a reviewed read-only path is designed.
10. **Q10. Console placement.** Recommended: a "measured" cell on each KPI of the Vision page, plus the `#/vision/self` sub-page.

## 12. Implementation order (small mergeable steps, each its own change request through Forge checks and consensus)

| # | Step | Tests | Merge | Effort |
|---|---|---|---|---|
| 1 | **T1a, the contract.** `control-plane-shared/src/self-model.ts`: the measure and document types, `selfModelProblems`, the canonical form and hash, the null-reason list | `self-model-contract-t1a.test.ts`: a null without a reason and a value without `as_of` are refused; a forbidden key at any depth is refused; a price-bearing ref is refused; over 64 KB is refused; Will must list every vision KPI once; the canonical hash ignores key order | routine | 0.5–1 d |
| 2 | **T1b, the assembler.** The per-source readers over a D1 interface and the pure section functions, not wired to cron | `self-model-assemble-t1b.test.ts` on `node:sqlite` fixtures from the real migrations: every query uses an index (query plans) and has a LIMIT; rows after `window_end` change nothing (determinism); a missing table gives `missing_table`; an empty source gives `no_rows`, never 0; trading values only through the whitelist; `self-model-boundary-t1.test.ts` (§8) | routine | 1.5–2 d |
| 3 | **T1c, the KPI bindings.** `self-model-kpis.ts` with the definitions the owner confirmed in Q4 | Every KPI in `organism/vision.json` is bound or explicitly unbound; each binding's null cases; `division_by_zero` when `hit` is 0; no rollback in the window gives null, not 0 | routine | 1 d |
| 4 | **T1d, storage and the job.** The migration (next free number); `ai-kernel/src/self-model.ts`; the 00:52 hook with retries; the partial-to-complete replacement; the audit event; the 400-day sweep; `JOB_ORDER` + `self_model_snapshot` | `test_migrations.py` and `migration-rules.ts`: additive only; one row a day; a complete row is never rewritten; a partial one is replaced once; AW5 and TV4 updated to 11 jobs; the audit payload carries no values | routine | 1–1.5 d |
| 5 | **T1e, the read routes.** `GET /v1/self-model`, `/{day}` and `/kpis`; the Console allow-list rows | Operators and viewers read it, any other caller is refused; non-GET 405; an invalid stored body is served with its problems, never as valid; `available: false` without the table | routine | 0.5–1 d |
| 6 | **T1f, the Console.** The KPI "measured" cell and `#/vision/self` | Render smoke test; `console-truthfulness.test.ts` green; a null reads "not measured yet" with its reason, never a number; `vision-telos-0016.test.ts` V1–V5 still green | routine | 1–1.5 d |
| 7 | **T1g, the chat tool.** `self_model` in `CHAT_TOOLS` | The tool is read-only, returns refs that `parseRef` accepts, and quotes values as data | routine | 0.5 d |
| 8 | **T1h, the record.** "T1 as built" in ADR-0016; T1's evidence in `progress/0016.json` becomes `migration_applied` for the new migration plus `adr_index_live`, with a `built` list; the SSOT Telos section | `adr-progress.test.ts` (quotes anchored, built paths exist); the ADR Steward computes T1 as proven | routine | 0.5 d |

- **Total:** about 7–9 working days, all on the platform, all routine.
- **Order:** steps 1–3 can be reviewed before anything runs. Step 4 starts the daily record. Steps 5–7 make it visible. Step 8 closes the phase.
- **Exit criteria:**
  - seven consecutive daily snapshots, each `complete` or `partial` with named sources;
  - every vision KPI measured or null with a reason;
  - the boundary test green;
  - the owner has reviewed the measured KPIs on the Vision page and confirmed or corrected the bindings.
