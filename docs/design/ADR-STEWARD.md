# Design: the ADR Steward agent and the Vision page's ADR panel

- **Status:** design (2026-11-16), reviewed by the owner: the open questions are answered in §10 and the build may start in the order of §11. Steps 1 to 6 are built (2026-11-17); steps 7–8 are not.
- **Owner request (2026-11-16, confirmed "ya steward"):** "buatkan Agent monitoring ADR yang akan selalu dinamis update progress, detail, penjelasan, dan selalu diupdate di panel Vision sebagai panel ADR (sebutkan singkatannya)" (build an agent that monitors the ADRs, always updates their progress, detail and explanation, and shows them on the Vision page as an ADR panel, with the abbreviation spelled out).
- **Panel title (owner):** "ADR — Architecture Decision Records". The owner's first title (2026-11-16) added an Indonesian gloss, "(Catatan Keputusan Arsitektur)"; on 2026-11-17 the owner asked "all in english please", so the panel, its labels and its explanation are English (§6.3, §10 "Reversal").
- **Owner reversal (2026-11-17, "all in english please"):** the whole Cerebrum Console is English. This supersedes Q5 (the Indonesian explanation, §10) and the Indonesian title and labels: §6.3 is the English wording, `draft_adr_explanation` is plain English like every other AI task (`ai-engine.ts` has no per-task style any more), and the validator's status words and negations are English (§4.5).
- **Reads with:** ADR-0007 (AI Worker OS: agents, capabilities, syscalls), ADR-0009 (consensus, the owner's click), ADR-0012 and `docs/GITHUB-CUTOVER.md` (the cut-over gates), ADR-0013 (DNA and census), ADR-0015 (documents, push to the senses), ADR-0016 (Telos: the Vision page, the self-model), ADR-0017 (the "Needs you" inbox, "Ask the organism"), `docs/SSOT.md`.
- **Base:** canonical main 4ac34f6. Every "exists" claim below names a file on that commit. Everything else is marked **new**.

## 1. Goals and non-goals

### Goals

1. **Progress from evidence, not from guessing.** Each ADR's phases and gates are declared once, each with an evidence predicate that code evaluates against D1. A phase is **proven** only when its predicate holds. A phase that rests on a document only is **doc-asserted** and is shown differently. Anything else is **open**, with its blocker named.
2. **One agent keeps it current.** The ADR Steward (new) wakes on merges, deploys and other relevant audit events, and once a day. It recomputes every ADR and writes one compact document per ADR, only when something changed.
3. **A short explanation in plain English** (Indonesian until the owner's reversal of 2026-11-17). Metric-first, citing its evidence. The AI writes it only when a status changes, within a small daily cap. A deterministic sentence is always there, so the panel never depends on the AI.
4. **The Vision page shows it.** A panel titled as the owner asked lists ADR-0001 to ADR-0017, the held ADR-0018 and the planned ADR-0019, each with status, a progress bar, its phases, blockers, the next step, what waits for the owner (with links to `#/owner` and `#/consensus`), the last change and the explanation.
5. **Fit the plans already made.** The Steward's documents are the "Memory: ADR index" of the ADR-0016 T1 self-model, a read-only tool for ADR-0017 H1 ("Ask the organism"), and part of ADR-0019 P0 (assumption, §1.3).

### Non-goals

- **The Steward never edits an ADR, `docs/SSOT.md`, `docs/GITHUB-CUTOVER.md` or a manifest.** It has no write path to the repository. When an ADR's text and the evidence disagree it raises a finding (§4.8). A person or a session fixes the text through a normal change request.
- **No AI decides a status.** The AI writes prose about a status that code already computed. It cannot change a number, a phase state or a blocker.
- **No action on the platform.** The Steward proposes nothing to consensus and holds no `consensus.propose` (that capability is privileged, §4.2).
- **No new push hub in this work.** The panel polls slowly until the push hub exists (§6.5).
- **Not the xauusd repository's RFCs yet.** They are an option for later through the same manifest (§1.4).

### 1.3 Assumption: ADR-0019

ADR-0019 ("AI Mesh program") is owner-confirmed but not drafted. No file on main names it. This design assumes its P0 covers the organism's knowledge of its own plans, and that the ADR Steward belongs there. The owner confirms or corrects this (Q10).

### 1.4 Scope

- **Now:** the platform's ADRs, `architecture/adr/0001`–`0017` on main, plus 0018 (held) and 0019 (planned).
- **Later (option):** the xauusd repository's RFCs, described by the same manifest schema with `"scope": "xauusd"`. They would be reached through the read-only paths that exist today: the Forge census of external DNA (`EXT_ORGANISM_XAUUSD`, `control-plane-shared/src/organism.ts`) and the kernel's read-only `XAUUSD_AI` binding (`workers/ai-kernel/wrangler.toml`). A predicate kind for xauusd evidence would be added then; until then such phases can only be `external_asserted`.

## 2. The manifest

### 2.1 Where it lives: `architecture/adr/progress/00NN.json` (new), not front matter

One JSON file per ADR, validated by a schema. Reasons:

1. **Three ADRs are guard paths.** `control-plane-shared/src/guard-paths.ts` guards `architecture/adr/0009-*` and `0012-*` (`adr_0009_0012`) and `0014-*` (`evolution_guard`). Front matter inside those files would make every manifest edit a `merge_owner_change`, and it would mix "how we measure" into the decision text. `architecture/adr/progress/0012.json` matches none of those patterns.
2. **The kernel already bundles JSON from the repository at build time.** `workers/ai-kernel/src/vision-view.ts` imports `organism/vision.json` with `with { type: "json" }`, and `control-plane-shared/src/deploy-units.ts` redeploys the Control Plane unit when that file changes (`VISION_FILE`). The manifests follow the same pattern. No Markdown parser runs in a Worker.
3. **The ADR stays prose for people.** The ADR README asks for status, context, decision and consequences (`architecture/adr/README.md`). A machine block in every file would be noise for readers.
4. **The manifest says how to measure, not what the status is.** Status comes from evidence. So a manifest changes only when a phase or gate is added or redefined, which is rare. Progress itself never needs an edit.
5. **ADRs that are not on main still get a row.** 0018 lives on branch `adr-0018` and 0019 is not drafted. A manifest with `"adr_file": null` covers both.

The manifests are reviewed in ordinary change requests. Whether the manifests of the guarded ADRs should be guarded too is Q2.

### 2.2 Validation (new)

- `control-plane-shared/src/adr-progress.ts` (new): a pure function `adrManifestProblems(file)` that lists every problem, like `visionProblems` in `control-plane-shared/src/vision.ts`.
- `control-plane-shared/test/adr-progress.test.ts` (new) runs in CI and checks, for every file in `architecture/adr/progress/`:
  - the schema below;
  - `adr` equals the file name, and `adr_file` exists when it is not null;
  - `lifecycle` agrees with the ADR's `- **Status:**` line: `deferred` only when that line says "deferred", `superseded` only when it says "Superseded";
  - every `doc_asserted.quote` and every `doc_claim.quote` occurs verbatim in the file it names, so a document assertion is always anchored to real text on the same commit;
  - every `depends_on` names an existing phase;
  - the kernel's manifest module imports exactly the files in the directory (the DNA-consistency pattern of ADR-0013);
  - every `built` path exists.
- The kernel checks each manifest again before it uses it (as `vision-view.ts` does). An invalid manifest is reported with its problems and is never computed.

### 2.3 JSON Schema (`adr.progress.v1`)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "adr.progress.v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["schema", "adr", "title", "lifecycle", "phases"],
  "properties": {
    "schema": { "const": "adr.progress.v1" },
    "adr": { "type": "string", "pattern": "^[0-9]{4}$" },
    "title": { "type": "string", "minLength": 3, "maxLength": 160 },
    "adr_file": { "type": ["string", "null"], "pattern": "^architecture/adr/[0-9]{4}-[a-z0-9-]+\\.md$" },
    "lifecycle": { "enum": ["accepted", "deferred", "held", "planned", "superseded"] },
    "lifecycle_note": { "type": "string", "maxLength": 300 },
    "superseded_by": { "type": "string", "pattern": "^[0-9]{4}$" },
    "scope": { "enum": ["platform", "xauusd", "aether"], "default": "platform" },
    "fits": { "type": "array", "items": { "type": "string", "pattern": "^[0-9]{4}(:[A-Za-z0-9.-]+)?$" } },
    "groups": {
      "type": "array",
      "items": {
        "type": "object", "additionalProperties": false, "required": ["id", "title"],
        "properties": { "id": { "type": "string", "pattern": "^[a-z0-9-]{1,24}$" }, "title": { "type": "string", "maxLength": 80 } }
      }
    },
    "phases": { "type": "array", "maxItems": 40, "items": { "$ref": "#/$defs/phase" } }
  },
  "$defs": {
    "phase": {
      "type": "object", "additionalProperties": false, "required": ["id", "title", "evidence"],
      "properties": {
        "id": { "type": "string", "pattern": "^[A-Za-z0-9][A-Za-z0-9.-]{0,23}$" },
        "group": { "type": "string" },
        "title": { "type": "string", "maxLength": 120 },
        "weight": { "type": "integer", "minimum": 1, "maximum": 5, "default": 1 },
        "depends_on": { "type": "array", "items": { "type": "string", "pattern": "^([0-9]{4}:)?[A-Za-z0-9.-]+$" } },
        "evidence": { "$ref": "#/$defs/predicate" },
        "built": { "type": "array", "items": { "type": "string", "pattern": "^(workers|organism|docs|architecture)/" } },
        "doc_claim": {
          "type": "object", "additionalProperties": false, "required": ["state", "ref", "quote"],
          "properties": {
            "state": { "enum": ["done", "built", "not_built", "not_started"] },
            "ref": { "type": "string" },
            "quote": { "type": "string", "minLength": 6, "maxLength": 200 }
          }
        },
        "next": { "type": "string", "maxLength": 160 },
        "note": { "type": "string", "maxLength": 160 },
        "owner_action": {
          "type": "object", "additionalProperties": false, "required": ["text"],
          "properties": {
            "text": { "type": "string", "maxLength": 160 },
            "href": { "enum": ["#/owner", "#/consensus", "#/code", "#/users"] },
            "outside_platform": { "type": "boolean" }
          }
        }
      }
    },
    "predicate": {
      "type": "object",
      "required": ["kind"],
      "properties": {
        "kind": { "enum": [
          "migration_applied", "audit_event", "quiet_window", "deploy_step", "merged_and_deployed",
          "census_clean", "observer", "kpi_threshold", "consensus_executed", "agent_registered", "agent_report",
          "reading", "doc_asserted", "external_asserted", "not_measurable_yet",
          "all_of", "any_of", "sequence"
        ] },
        "of": { "type": "array", "minItems": 1, "maxItems": 8, "items": { "$ref": "#/$defs/predicate" } }
      },
      "$comment": "Each kind's own fields are listed in section 3; adr-progress.ts checks them per kind (unknown fields are a problem). Nesting depth is at most 3."
    }
  }
}
```

### 2.4 Example (part of ADR-0016)

```json
{
  "schema": "adr.progress.v1",
  "adr": "0016",
  "title": "Telos: a living vision, a self-model, and the Strategist",
  "adr_file": "architecture/adr/0016-telos.md",
  "lifecycle": "accepted",
  "fits": ["0019:P0"],
  "phases": [
    { "id": "T0", "title": "Vision schema, core draft, Console Vision page",
      "evidence": { "kind": "all_of", "of": [
        { "kind": "reading", "name": "vision_valid" },
        { "kind": "doc_asserted", "ref": "architecture/adr/0016-telos.md", "quote": "T0 is built (see \"T0 as built\")" } ] },
      "built": ["organism/vision.json", "workers/control-plane-shared/src/vision.ts", "workers/console/ui/src/pages/Vision.tsx"],
      "doc_claim": { "state": "done", "ref": "architecture/adr/0016-telos.md", "quote": "T0 is built (see \"T0 as built\")" } },
    { "id": "T1", "title": "Self-model snapshot, daily", "depends_on": ["T0"],
      "evidence": { "kind": "all_of", "of": [
        { "kind": "not_measurable_yet", "reason": "no self-model table or R2 snapshot exists yet" },
        { "kind": "reading", "name": "adr_index_live" } ] },
      "next": "Build the daily self-model; its Memory section reads the ADR Steward's documents",
      "doc_claim": { "state": "not_built", "ref": "architecture/adr/0016-telos.md", "quote": "T1–T5 are not built yet" } }
  ]
}
```

## 3. Predicate kinds

A manifest never contains SQL. Each kind is a parameterized query in `control-plane-shared/src/adr-evidence.ts` (new), and the manifest supplies only values. Every query below uses an index that exists today, named in the last column, except where noted.

Each evaluation returns `{ state, at, refs, reason }`:

- `state` is `proven`, `asserted`, `open` or `unknown` (the source could not be read).
- `refs` are evidence references in the `ev:` form proposed by the HAIC design (`ev:<side>/<source>/<id>[@<as_of>][#<field>]`; see §10, Q9), for example `ev:platform/audit/<event_id>`.

| Kind | Fields | Source (exists) | Query, in words | Index used |
|---|---|---|---|---|
| `migration_applied` | `name` (full file name, e.g. `0073_platform_identities.sql`) | D1 `d1_migrations`, the ledger that `wrangler d1 migrations apply` and the native deploy write (`deployment-orchestrator/src/native-deploy.ts`; read the same way in `control-plane-shared/src/readiness.ts` `schemaReady`) | `SELECT name FROM d1_migrations WHERE name = ?` | ledger's own key |
| `audit_event` | `event_type`, optional `since`, `payload` (`{ "$.path": value }`, at most 3), `min_count` (default 1) | `audit_events` (migration 0001; written by `control-plane-shared/src/audit.ts` `appendAuditEvent`) | `SELECT event_id, created_at FROM audit_events WHERE event_type = ? AND created_at >= ? [AND json_extract(payload_json, ?) = ?] ORDER BY created_at DESC LIMIT ?` | `idx_audit_events_type_created` |
| `quiet_window` | `fail_types[]`, `success_type`, `hours` | `audit_events` | The newest event of each fail type (one indexed query each). Proven when the newest failure is at least `hours` old and at least one `success_type` event lies inside the window. When open, the reason carries the earliest time it can be proven: newest failure + `hours`. | `idx_audit_events_type_created` |
| `deploy_step` | `step` or `step_suffix`, optional `executor`, `since` | `deployment_requests.details_json` `$.outcome.steps` and `$.executor` (`deployment-orchestrator/src/index.ts` writes `outcome: run` on the native paths; step names such as `<worker>:smoke_passed`, `migration:<file>:applied`, `<worker>:topology_planned` come from `native-deploy.ts`) | `SELECT d.request_id, d.updated_at, s.value FROM deployment_requests d, json_each(json_extract(d.details_json, '$.outcome.steps')) s WHERE d.status = 'succeeded' AND d.created_at >= ?`, then exact or suffix match in code (no `LIKE`, ADR-0015 §7) | `idx_deployment_requests_status_created` |
| `merged_and_deployed` | `cr_id` or `branch`, `unit` | `forge_change_requests` (migration 0052) and `deployment_requests` | The request is `merged` (its `outcome_at`), and a deploy of a Worker of `unit` (`DEPLOY_UNITS`, `control-plane-shared/src/deploy-units.ts`) has `status = 'succeeded'` and `created_at` after that `outcome_at`. Main only moves by fast-forward on the Forge, so any later deploy of main contains the merge. | `idx_forge_change_requests_status`, `idx_deployment_requests_status_created` |
| `census_clean` | optional `max_age_h` (default 1) | `forge_organism_census` (migration 0040; status `consistent`, `changes` or `invalid`) | The newest row by `taken_at` has `status = 'consistent'` and is fresh. Live: it can turn open again. | none: one row per main commit, a few hundred rows. Add an index on `taken_at` only if the Observer shows the scan |
| `observer` | `source`: `findings`, `vitals` or `runs`; then `worker` or `subject`, `metric`, `kind_filter` (the row's own `kind`), `since`, `expect` (`none` or `some`) | `observer_findings`, `observer_vitals`, `observer_runs` (migration 0063, the Observer in `control-plane-shared/src/observer.ts`) | Findings: `SELECT COUNT(*) FROM observer_findings WHERE kind = ? AND created_at >= ?` (worker and metric filtered in code). Runs: the newest `observer_runs` row of a kind with `status = 'ok'`. Vitals: see `kpi_threshold`. | `idx_observer_findings_kind_created`; runs by `UNIQUE (kind, bucket)` |
| `kpi_threshold` | `source`: `report_metric` or `observer_vitals`; `metric`, `op` (`>=`, `<=`, `==`), `value`, `max_age_h`; for `report_metric` also `agent_id`, `body_schema` | `agent_reports.body_json` metrics (for example the Signal Analyst's `trading_organ_health.v1`, `docs/SSOT.md` "Trading organ health"); `observer_vitals` (migration 0063) | Report: the newest reports of `agent_id` (`LIMIT 20`), the first whose `body.schema` matches, then `metrics[]` by name. Vitals: `SELECT <named column> FROM observer_vitals WHERE subject = ? AND kind = ? AND hour >= ?`, the column picked from a fixed list in code. Vision KPIs join here once T1 measures them (every baseline in `organism/vision.json` is `null` today). | `agent_reports_agent_created`; vitals primary key |
| `consensus_executed` | `action`, optional `target`, `since`, `owner_approved` (`true` for "an owner click") | `consensus_proposals` (migration 0023), `consensus_owner_decisions` (migration 0024) | `SELECT p.proposal_id, p.decided_at FROM consensus_proposals p [JOIN consensus_owner_decisions d ON d.proposal_id = p.proposal_id AND d.decision = 'approve'] WHERE p.action = ? AND p.status = 'executed' [AND p.target = ?] ORDER BY p.decided_at DESC LIMIT 1` | `idx_consensus_proposals_action_decided` |
| `agent_registered` | `agent_id`, optional `status` (default `enabled`) | `agents` (migration 0010) | `SELECT status FROM agents WHERE agent_id = ?` | primary key |
| `agent_report` (added 2026-11-17, for ADR-0020) | `report_kind` (an `agent_reports.kind`), `agent_id`, `body_schema`; optional `origin` (the body's `source`), `body` (1–3 JSON paths of the body with a value, for example `{"$.mode": "auto"}`), `item` (1–3 fields that one element of `body.items` matches, each a value or a list of up to 4, for example `{"event": ["armed", "disarmed"], "reason": "owner"}`), `since` | `agent_reports` (migration 0012 and later): what an agent published, for example the xauusd Risk Manager's `strategy_arm.v1` digests | `SELECT r.report_id, r.created_at FROM agent_reports r WHERE r.agent_id = ? AND r.kind = ? AND json_valid(r.body_json) AND json_extract(r.body_json, '$.schema') = ? [AND json_extract(r.body_json, '$.source') = ?] [AND json_extract(r.body_json, ?) = ?] [AND EXISTS (SELECT 1 FROM json_each(r.body_json, '$.items') i WHERE json_extract(i.value, ?) IN (?, …))] ORDER BY r.created_at DESC LIMIT 1`, every path and value bound. A past event (a report is never edited), so proven is sticky; the ref is `ev:platform/report/<report_id>@<created_at>#schema` (`#items` with an item condition): the row is in the platform's D1. | `agent_reports_agent_created` |
| `reading` | `name`, one of a fixed list in code | See the list below | A named query. New readings are added in code, never in a manifest. | per reading |
| `doc_asserted` | `ref` (a file on main), `quote` | The file itself; the CI test proves the quote is there on the same commit | No query. State `asserted`, never `proven`. | none |
| `external_asserted` | `source` (`xauusd`, `aether`, `branch:<name>`), `ref`, `as_of` | Text CI cannot read: another repository, or a branch not on main | No query. State `asserted`, labelled "eksternal" on the panel. | none |
| `not_measurable_yet` | `reason` | None yet | Always `open` with the reason as blocker. This keeps "we cannot measure it" visible instead of silently "done". | none |
| `all_of` / `any_of` | `of[]` | Combinators | `all_of`: proven when all are proven; asserted when all are proven or asserted and at least one is asserted; otherwise open with the first open reason. `any_of`: proven if any is proven, else asserted if any is asserted, else open. | none |
| `sequence` | `of[]` | Combinator | Proven when every item is proven and each one's `at` is later than the previous one's (for example: merged, then deployed natively, then in sync). | none |

**Readings (the `reading` kind; each new, each a short query on an existing table):**

| Name | Query, in words | Source (exists) |
|---|---|---|
| `forge_merge_path` | `value` of `forge_controls` row `merge_path` equals `forge` | migrations 0057, 0058 |
| `forge_work_cr_merged` | a `forge_change_requests` row with `source = 'forge'` and `status = 'merged'` | migration 0052 |
| `git_backup_verified_48h` | the newest `forge_git_backups` row has `verify_status = 'verified'` and `verified_at` within 48 h | migrations 0054, 0072 |
| `dependency_audit_fresh_48h` | the newest `forge_dependency_audits` row is within 48 h | `forge/src/dependency-audit.ts` |
| `vision_valid` | `visionView().status === "valid"` (no D1) | `ai-kernel/src/vision-view.ts` |
| `drift_in_sync_all` | every enabled service's latest drift state is in sync | `control-plane-shared/src/drift-state.ts` (the same reading the Owner page uses, `ai-kernel/src/owner-inbox.ts`) |
| `adr_index_live` | the Steward is registered and enabled, and `adr_progress` (new, §4.6) has a row for every manifest | new |
| `orchestrator_github_fallback_absent` | the Orchestrator reports `github_fallback: "absent"` | the field exists in `deployment-orchestrator/src/index.ts` (`/ready`); reading it needs a new read-only `DeployRpc` method |

**Rules for states:**

- **Proven is sticky only when the evidence is a past event** (`audit_event`, `migration_applied`, `consensus_executed`, `deploy_step`). Those rows are append-only, so the state cannot flip back. **Live checks** (`census_clean`, `quiet_window`, `reading`, `observer`, `kpi_threshold`) can return to open, and the document then says what changed.
- **`unknown` never changes a stored state.** A read error keeps the last state of that phase, marks the document `stale`, and names the source that failed. A phase is never reopened by a database hiccup.
- **`depends_on` does not override evidence.** A proven phase stays proven even if its dependency is open. `depends_on` only chooses the next step and names blockers.

## 4. The agent

### 4.1 Identity

| Field | Value |
|---|---|
| `agent_id` | `adr-steward` (new) |
| Display name | ADR Steward |
| Host | `cryptophys-ai-kernel` (the kernel hosts the Supervisor, Signal Analyst and Auditor: `workers/ai-kernel/organism.json`) |
| Process | A SQLite-backed Durable Object, `AdrStewardAgent` (new), like `SupervisorAgent`, `SignalAnalystAgent` and `AuditorAgent` in `workers/ai-kernel/src/worker.ts`. Its cycles are serialized by a cycle queue, as `AuditorCycleQueue` does (`ai-kernel/src/auditor.ts`). Its own storage holds the event cursor, the last pass time and the daily AI counter, so D1 gets no heartbeat writes (ADR-0015 §7). |
| DNA | One more entry in `workers/ai-kernel/organism.json` `agents`, plus one engine `{ "task": "draft_adr_explanation" }`. That file is a guard path (`evolution_guard`), so the change is `merge_owner_change`. After the merge the census proposes `register_agent` and `register_engine`, both routine (`control-plane-shared/src/consensus-rules.ts`). |
| Voter | No. It holds no council seat. |

### 4.2 Capabilities and tier

`tier_max = 1`. The grant is two capabilities:

| Capability | Tier | Status | Why |
|---|---|---|---|
| `adr.observe` | 0 | **new** in `control-plane-shared/src/capabilities.ts` | Reads the evidence for the manifests (§3). A tier-0 handler in `ai-kernel/src/syscall.ts` `TIER0_HANDLERS`, beside `platform.observe` and `audit.verify`. Not persisted and not rate limited, as for every tier-0 read. |
| `reports.publish` | 1 | exists (4 an hour) | Drift findings and a change digest (§4.8). |

- **Why a new capability rather than `platform.observe`.** `platform.observe` is "Read drift, recovery plans, agent state and the 24 h report summary" and its handler is the fixed `observe(env)` snapshot. Reading the Forge, migrations and consensus tables through it would widen what every holder of `platform.observe` can read. `capabilities.ts` is a guard path (`evolution_guard`), but the same change request already edits `organism.json`, a guard path, so it costs no extra owner click. Q3 asks the owner.
- **Not granted:**
  - `consensus.propose`: `privilegedCapabilities()` in `consensus-rules.ts` calls it privileged, and the Steward acts on nothing;
  - `memory.remember` and `memory.recall`: not needed for the minimal set. If they are added later, the learning mandate applies in full: no cap, no rate limit and no budget refusal (`control-plane-shared/src/power-mode.ts`);
  - `recovery.propose`, and anything at tier 2 or above.

### 4.3 Triggers

The kernel has one cron, `7,22,37,52 * * * *` (`workers/ai-kernel/wrangler.toml`). `scheduled()` in `ai-kernel/src/index.ts` runs the Supervisor every tick, the Signal Analyst at :22 and the Auditor at :37. There is no event bus or queue in the kernel today. So the Steward uses the tick, plus a cursor:

1. **Every tick (cheap check).** One indexed query: is there an `audit_events` row with `created_at` after the DO's cursor and `event_type` in the watched list? If there is none and nothing else is due, the cycle ends after one query.
   - Watched types (all exist; event names from `deployment-orchestrator/src/index.ts`, the Forge and `ai-kernel/src/consensus.ts`): `forge.merged`, `forge.change_outcome`, `forge.organism_census`, `forge.git_backup_verified`, `deployment.native_deploy_succeeded`, `deployment.native_deploy_failed`, `deployment.native_migration_applied`, `deployment.destructive_deploy_succeeded`, `deployment.destructive_topology_applied`, `deployment.retire_succeeded`, `deployment.rescue_succeeded`, `deployment.rescue_failed`, `deployment.break_glass_succeeded`, `deployment.break_glass_failed`, `deployment.rollback_succeeded`, `deployment.binding_drift_repaired`, `consensus.executed`, `consensus.owner_approved`, `identity_source.changed`, `agent.registered`, `engine.registered`.
   - The list is derived from the manifests' `audit_event` and `quiet_window` predicates plus the fixed set above, so a new gate's event wakes the Steward without a code change.
2. **A new deploy of the kernel.** When `CF_VERSION_METADATA.id` differs from the one stored in the DO, the bundled manifests may have changed. The Steward runs a full pass.
3. **Time-based predicates.** When a `quiet_window` is open with a known end time, the DO keeps that time and runs a pass on the first tick after it. For ADR-0012's 24 h window this is the tick after the earliest proof time.
4. **A daily full pass at 02:52 UTC.** It catches live checks that moved without an event (census, readings, observer, KPIs). It runs after the Auditor's 00:37 daily cycle and before the retention prune at 03:07.
5. **An operator wake.** `POST /v1/agents/adr-steward/wake` (exists). The handler in `ai-kernel/src/index.ts` accepts only the three current agent ids today, so the Steward's id is added there (new).

Latency: a merge on the Forge tick (:04, :19, :34, :49) is seen on the kernel tick three minutes later.

### 4.4 Algorithm (one cycle)

1. Check the global kill switch (`kernel_controls.agents_enabled`) and the agent's own status, as every kernel agent does. If either is off, stop.
2. Decide whether a pass is due (§4.3). If not, advance nothing and stop.
3. Load the bundled manifests and re-validate them (§2.2). An invalid manifest becomes one `adr.manifest_invalid` audit event per manifest hash and is shown as invalid. It is never computed.
4. Call `adr.observe` once with the list of predicates. The handler evaluates them in one `db.batch()` where it can, so a full pass is about 150 small queries, under the D1 per-invocation query limit.
5. For each ADR:
   1. **Phase states.** `proven`, `asserted` or `open`, per §3, and `unknown` handled as described there.
   2. **Status:**
      - `superseded`, `held` or `planned` when the manifest's `lifecycle` says so (the phases are still computed and shown);
      - otherwise `done` when every phase is proven or asserted, `not_started` when none is, and `in_progress` in between;
      - `deferred` is a badge, not a status: ADR-0014 is deferred, yet E1 is done.
   3. **Progress.** `percent` = weighted (proven + asserted) / weighted total, and `percent_proven` = weighted proven / weighted total, both rounded to whole numbers.
   4. **Blockers.** Each open phase's reason, plus:
      - "waits for the owner's click" when a matching proposal sits in `pending_owner`;
      - "depends on <phase>" for an open dependency;
      - "earliest <time UTC>" for an open `quiet_window`.
   5. **Next step.** The first open phase, in manifest order, whose dependencies are complete. Its text is the phase's `next`, or else its title.
   6. **Owner actions.** `pendingApprovals()` from `ai-kernel/src/owner-inbox.ts` (exists; the Owner page and the owner notices use the same reading). A `pending_owner` proposal whose action and target match an open phase's `consensus_executed` predicate is linked to that phase. A manifest `owner_action` adds an action the platform cannot see, such as archiving the GitHub repository, marked "outside the platform". Links: `#/owner`, and `#/consensus` for consensus items. Both routes exist in `workers/console/ui/src/App.tsx`; there is no per-proposal route today.
   7. **Drift.** Compare each phase's `doc_claim.state` with its computed state (§4.8).
   8. **Document.** Build the document (§4.6) and hash it with sha256, leaving out the explanation and the times.
6. **Write only on change.** If the hash equals the stored `body_sha256`, write nothing. Otherwise:
   - upsert the `adr_progress` row with `revision + 1`;
   - insert one `adr_progress_history` row;
   - append one `adr.status_changed` audit event.
7. **Explanation.** For each ADR whose status or any phase state changed, ask the AI for a short plain-English explanation, within the caps of §7.
   - It is written into the same row as `explanation_json`, which does not change the body hash.
   - Without the AI (budget, survival mode, invalid output) the deterministic sentence (§6.3) stays, labelled "automatic text".
8. **Advance.** Store the cursor (the newest watched event's `created_at`), the pass time and the version id in the DO.

### 4.5 The explanation task (`draft_adr_explanation`, new)

- **Input** (at most 4,000 characters): the ADR id and title; old and new status; the counts; the phases that changed, with their state, reason and evidence refs; the next step; and the owner actions. The input never contains ADR prose. Repository text is data, never instructions (ADR-0017 guards).
- **Output:** `{ "teks": string ≤ 400 chars, "rujukan": string[] ≤ 6 }`, in plain English, metric-first, at most three sentences. The two keys (the text and its refs) keep their first names: they are the stored `adr.explanation.v1` schema, not shown in the panel.
- **Validator** (deterministic). Any failure rejects the output, and the template stays:
  - every ref in `rujukan` is one of the input refs;
  - every number in `teks` occurs in the input (no invented figures);
  - no status word contradicts the computed status, for example "done" when the status is not `done`, and the computed status's word is not negated ("not done", "isn't in progress", "not yet done");
  - `violatesAdvisoryLanguage()` is false (`control-plane-shared/src/ai-engine.ts`);
  - the length bounds hold.
- **Language.** `AiEngine` appends `PLAIN_ENGLISH_STYLE` to every task's instructions (`ai-engine.ts`, the system message built in `run`). Step 6 first added a per-task style option with an Indonesian style line for this task only (Q5). The owner reversed Q5 on 2026-11-17 ("all in english please"): the option is removed, and this task is plain English like every other, under the owner's rule of 2026-11-07, "reports in English" (the comment above `DEFAULT_MODEL` in that file).
- **Model.** The kernel's configured text model (`AI_MODEL` in `workers/ai-kernel/wrangler.toml`, within `ALLOWED_TEXT_MODELS` of `ai-engine.ts`). No new model and no model outside Workers AI.
- **Not a learning call.** It never passes `purpose: "learning"`, so the per-service and account budgets apply to it (`power-mode.ts`, `ai-engine.ts` `reserve`).

### 4.6 Output document and storage

**What exists today:**

- The kernel binds D1 (`DB`), Vectorize (`MEMORY`) and Durable Objects. It binds **no R2 bucket** (`workers/ai-kernel/wrangler.toml`). R2 is bound only to the Orchestrator, the Forge and the Recovery Manager.
- ADR-0015 §4 allows "one D1 row holding the queryable columns and a JSON body", with R2 for large transcripts.

**Choice:** a D1 index row plus the body as D1 JSON. A document is a few kilobytes, and ADR-0012's is the largest at about 6 KB. No R2 binding is needed. It goes in one new migration, numbered the next free number when built. 0073 is the newest migration on main, and 0074 is taken by the pending ADR-0018 registry change request.

```sql
-- new
CREATE TABLE adr_progress (
  adr_id TEXT PRIMARY KEY CHECK (length(adr_id) = 4 AND adr_id GLOB '[0-9][0-9][0-9][0-9]'),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('accepted', 'deferred', 'held', 'planned', 'superseded')),
  status TEXT NOT NULL CHECK (status IN ('not_started', 'in_progress', 'done', 'superseded', 'held', 'planned')),
  phases_total INTEGER NOT NULL CHECK (phases_total >= 0),
  phases_proven INTEGER NOT NULL CHECK (phases_proven >= 0),
  phases_asserted INTEGER NOT NULL CHECK (phases_asserted >= 0),
  percent INTEGER NOT NULL CHECK (percent BETWEEN 0 AND 100),
  percent_proven INTEGER NOT NULL CHECK (percent_proven BETWEEN 0 AND 100),
  manifest_sha256 TEXT NOT NULL,
  body_sha256 TEXT NOT NULL,
  body_json TEXT NOT NULL CHECK (json_valid(body_json) AND length(body_json) <= 32768),
  explanation_json TEXT CHECK (explanation_json IS NULL OR json_valid(explanation_json)),
  changed_at TEXT NOT NULL
);
CREATE TABLE adr_progress_history (
  adr_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  percent INTEGER NOT NULL,
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  explanation_json TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (adr_id, revision)
);
```

- No `computed_at` column is updated on every pass, because that would be a heartbeat UPDATE (ADR-0015 §7). The last pass time lives in the DO and is served by its `status()` RPC.
- No new index: the list reads at most about 20 rows by primary key, and history is read per ADR by `(adr_id, revision)`.
- Expected volume: a few changed rows a day. History rows older than 90 days move to R2 with ADR-0015 phase 4 when that exists. Until then they stay; a year is well under 2,000 rows.

**Body (`adr.progress-doc.v1`):**

```json
{
  "schema": "adr.progress-doc.v1",
  "adr": "0012", "title": "Leave GitHub — the Forge", "lifecycle": "accepted", "deferred": false,
  "status": "in_progress", "phases_total": 26, "phases_proven": 12, "phases_asserted": 6, "percent": 69, "percent_proven": 46,
  "phases": [
    { "id": "G4B", "group": "gates", "title": "Gate 4 part B: routes, DO migrations, Workflows natively",
      "state": "open", "reason": "built, not yet run live", "built": true, "refs": [],
      "doc_claim": "built", "drift": null }
  ],
  "blockers": ["G4B: built, not yet run live", "W24: earliest 2026-11-17T14:12Z"],
  "next_step": { "phase": "G4B", "text": "First live run of a part B path" },
  "owner_actions": [{ "text": "Approve the first native retirement", "href": "#/owner", "proposal_id": null }],
  "drift": [],
  "stale": false, "manifest_sha256": "…", "deployed_commit": "…"
}
```

The figures above illustrate the shape. The real ones come from the first pass (§8.1).

### 4.7 Audit events (new)

All of them are written with `appendAuditEvent` (`control-plane-shared/src/audit.ts`), actor `agent:adr-steward`, subject `adr:<NNNN>`:

| Event | When | Payload |
|---|---|---|
| `adr.status_changed` | A document changed | `revision`, `from`, `to`, `percent`, `percent_proven`, the ids of the phases that changed, `body_sha256` |
| `adr.drift_detected` / `adr.drift_resolved` | A drift episode opens or closes (§4.8) | `phase`, `doc_ref`, `doc_state`, `computed_state`, `refs` |
| `adr.manifest_invalid` | Once per invalid manifest hash | `problems` (at most 10) |
| `adr.explanation_skipped` | The AI was not used for a change | `reason`: `budget`, `survival`, `daily_cap`, `invalid_output` or `unavailable` |

Every tier-0 syscall the Steward makes is also recorded the way the kernel records syscalls today (`ai-kernel/src/syscall.ts`).

### 4.8 Drift: from finding to a fixed document

**Drift** means a phase's `doc_claim.state` disagrees with its computed state:

- **`doc_behind`:** the evidence is proven (machine evidence, not asserted), but the document says `not_built`, `built` or `not_started`. Example: ADR-0012 gate 10 once a native retirement succeeds while `docs/GITHUB-CUTOVER.md` still says "built, live, not yet run".
- **`doc_ahead`:** the document says `done`, but the predicate is open, and not because of a read error.
- An `asserted` phase only gets a note, never a finding. There is no machine evidence to disagree with.

**The path, using only what exists:**

1. **A report.** One `platform_digest` report by `adr-steward`, severity `warning` and never `critical`, with `body.schema = "adr_drift.v1"` and `alert_key = adr_drift:<adr>:<phase>`. It is published once per episode, then a `Resolved:` info report with the same key when it closes.
   - This copies the deploy stall alarm (`docs/SSOT.md`, "Deploy stall alarm"). A critical report is the consensus brake, which a documentation lag must never trigger.
   - The report kind is a D1 `CHECK` constraint on `agent_reports` (migration 0027). The Signal Analyst already carries a schema in an existing kind (`xauusd_digest` with `trading_organ_health.v1`). So no table rebuild is needed.
2. **Shown where people look.** The ADR panel shows the drift on its row. Once the HAIC H0 "Needs you" inbox exists it can list drift as a low-urgency item. It never blocks anything.
3. **The fix is a normal change request.** Today no agent can write to the repository:
   - the evolver is not built (ADR-0014 E2 has only its limits, `control-plane-shared/src/evolution-limits.ts`);
   - its scope `EVOLVABLE` admits only `workers/` and `docs/` paths, so `architecture/adr/*` is refused as `path_outside_scope` (`control-plane-shared/test/evolution-limits-e2.test.ts`);
   - the Forge's `git-write.ts` is listed in `guard-paths.ts` but does not exist on main.

   So the report carries the suggested text (the phase, the file, the quote and what the evidence shows), and a session pushes a `claude/…` branch to `platform-work`. The Forge registers it, its checks run, and the Supervisor proposes `merge_change`, or `merge_owner_change` for ADR-0009, ADR-0012 and ADR-0014, which are guard paths (`AGENTS.md`, "After the GitHub cut-over"). When the evolver exists, a `docs/` drift such as the SSOT could become an evolution intent. `architecture/` stays outside its scope unless the owner widens it.
4. The CI quote check (§2.2) then forces the manifest's `doc_claim` to be updated in the same change request, so manifest and text cannot drift apart silently.

### 4.9 Failure modes

| Failure | Effect | Handling |
|---|---|---|
| Kill switch off, or agent suspended | No cycles | The API serves the last documents with `steward.status` (`suspended` or `agents_disabled`) and the age of the last pass. The panel shows the age. Nothing is invented. |
| D1 read error on a predicate | `unknown` | The last state is kept, the document is marked `stale` with the source, and nothing is reopened. |
| Manifest invalid at runtime | That ADR is not computed | The row shows "manifest invalid" with its problems, plus one audit event per hash. CI normally stops this before a deploy. |
| AI budget exhausted, survival mode, invalid output | No AI text | The deterministic sentence stays, plus `adr.explanation_skipped`. |
| An event storm (many deploys) | Many passes | At most one full pass per tick, because the DO serializes cycles. Writes happen only on change. |
| The cursor misses an event | A late update | The daily 02:52 pass recomputes everything. |
| A manifest change lands | New phases | The version-id check runs a full pass on the first tick after the deploy. |
| The DO migration fails on deploy | The Steward does not run | See risk R4: an additive `new_sqlite_classes` step is a gate 4 part B path that has not yet run live. |
| The `adr_progress` table is missing (migration not applied yet) | — | The API returns `available: false`, and the panel says the data is not available yet. No default rows. |

## 5. API

Both routes are **new** and read-only, on the AI Kernel, after `requireOperator` like every other kernel `GET` in `ai-kernel/src/index.ts`. Neither writes anything.

| Route | Returns |
|---|---|
| `GET /v1/adr` | `{ schema: "adr.progress-view.v1", available, steward: { agent_id, status, last_pass_at, last_full_pass_at, deployed_commit, ai_today: { used, cap } }, adrs: [ { adr, title, lifecycle, deferred, superseded_by, status, phases_total, phases_proven, phases_asserted, percent, percent_proven, next_step, blockers (first 3), owner_actions, drift_count, stale, revision, changed_at, explanation } ] }`, sorted by ADR number |
| `GET /v1/adr/{id}` | The full `adr.progress-doc.v1` body of one ADR, with the explanation and the last 10 history entries (`revision`, `status`, `percent`, `created_at`) |

- **Console proxy:** two rows in `CONSOLE_ALLOW_LIST` (`workers/console/src/index.ts`): kernel `GET /v1/adr` and `GET /v1/adr/{id}`. Two rows in `UI_ROUTES` (`workers/console/src/ui/routes.ts`): `kernel.adr` and `kernel.adr_one`, both `approverOnly: false` with no confirm phrase, like `kernel.vision`. The Console forwards only allow-listed paths with the caller's Access JWT, and the kernel checks the operator (`workers/console/src/index.ts` header comment). No new Access application or path.
- **Cache:** `Cache-Control: private, max-age=60`. ADR-0015 §3 suggests the Cache API for reads that cannot be pushed; with about 20 small rows, a plain D1 read is enough at first.
- **MCP (later, H1):** the same views as a read-only tool for "Ask the organism" (ADR-0017 §2 lists "the ADR and SSOT index" among its tools).

## 6. The Vision panel

### 6.1 What exists

- `#/vision` exists: `workers/console/ui/src/pages/Vision.tsx`, routed in `App.tsx` and in the nav after Organism (`components/AppShell.tsx`). It reads only `kernel.vision` and renders the Mission, Identity, Constitution, and Goals and KPIs panels, once (`usePoll(..., 0)`).
- So no new page is needed. The ADR panel is one more panel on that page (new).

### 6.2 Placement and routing

- The panel goes below "Goals and KPIs", and it renders even when the vision is invalid. Today the lower panels render only when `v` is set; the ADR panel does not depend on the vision.
- `#/vision/adr` scrolls to the panel, and `#/vision/adr/0012` opens that row. This is new: `App.tsx` passes `id` to some pages but not to Vision today.

### 6.3 Labels (English)

English since the owner's "all in english please" (2026-11-17), which replaced the Indonesian labels of 2026-11-16.

| Key | Label |
|---|---|
| Panel title | ADR — Architecture Decision Records |
| Right of title | read-only · computed from evidence, not AI guesses · updated <time> |
| Status `not_started` | not started |
| Status `in_progress` | in progress (X of Y phases) |
| Status `done` | done |
| Status `superseded` | superseded by ADR-NNNN |
| Status `held` | held |
| Status `planned` | planned |
| Badge `deferred` | deferred |
| Phase `proven` | proven |
| Phase `asserted` | asserted by document (external: "asserted by external source") |
| Phase `open` | open |
| Stale | stale data: <source> unreadable |
| Columns | Status · Progress · Phases · Blockers · Next step · Waiting for owner · Last change · Explanation |
| Owner action | Waiting for the owner's click → Open the Owner page (`#/owner`) / Open Consensus (`#/consensus`); outside the platform |
| Drift | Document does not match evidence |
| Explanation source | explained by AI · automatic text |
| Missing value | — |

**Deterministic sentence (always present).** For example: "0012: 18 of 26 phases complete (12 proven, 6 asserted by document). Open: G4B, G4D, G10, GB, W24 (earliest 2026-11-17 14:12 UTC). Next: G4B."

### 6.4 Sketch

```
ADR — Architecture Decision Records
read-only · computed from evidence, not AI guesses · updated 22:37 UTC · Steward: active

ADR    Title                         Status                          Progress              Next
0001   Cloudflare-native runtime     done                            ██████████ 100%       —
 …
0012   Leave GitHub (the Forge)      in progress (18 of 26 phases)   ███████░░░  69%       G4B: first live run
       Phases:  G1 ◆  G2 ●  G3 ●  G4A ●  G4B ○  G4D ○  G5 ●  …  W24 ○ (earliest 17-11 14:12)
       ● proven   ◆ asserted by document   ○ open
       Blockers: G4B built, not run live · G10 built, not run live · W24 window
       Waiting for owner: 1 → Owner        Last change: rev 14 · 21:56 UTC
       Explanation (automatic text): 0012: 18 of 26 phases complete …            [ev:…] [ev:…]
0014   Evolution loop  [deferred]    in progress (1 of 9 phases)     █░░░░░░░░░  11%       E0: intents
0016   Telos                         in progress (1 of 6 phases)     ██░░░░░░░░  17%       T1: self-model
0018   External organs               held  (1 of 5 phases)           ██░░░░░░░░  20%       X3: registry CR
0019   AI Mesh program               planned                         —                     —
```

The figures in the sketch are the expected first-pass values from §8, not measurements.

- **Progress bar:** two segments. The proven share is solid and the asserted share is hatched, so "done by document" never looks the same as "done by evidence".
- **Rows:** collapsed by default. The phase chips expand to the phase list: each phase's state, reason, evidence chips (`ev:` refs, linked to their Console page where one exists: Code, Consensus, Ledger, Organism) and its drift.
- **Truthfulness** (`AGENTS.md`; `control-plane-shared/test/console-truthfulness.test.ts`): every row, number and label comes from `GET /v1/adr`. The rows for 0018 and 0019 come from their manifests, not from the UI. A missing value is "—". No default status, and no green mark for something not proven. The render smoke test renders the panel with an empty and a filled response (new assertions).

### 6.5 Live updates

- **Now:** `usePoll(() => call("kernel.adr"), 300_000)`. Five minutes is the ADR-0015 §3 floor for a polling fallback. `usePoll` already pauses while the tab is hidden (`ui/src/lib/usePoll.ts`).
- **Later:** no push hub exists today. No Worker accepts a WebSocket, and ADR-0015 phase 1 is not built (`docs/SSOT.md`, "Organs as cells"). The HAIC design (`docs/design/HAIC-H0-H1.md`, on the unmerged branch `haic-design`, not on this base) plans a minimal `ConsoleHub` Durable Object in the kernel, with WebSocket Hibernation, for the HAIC H0 inbox and councils.
  - When it lands, the Steward publishes `{ channel: "adr", kind: "adr.status_changed", data: { adr, revision } }` after each write.
  - The panel then re-reads only that ADR (`kernel.adr_one`), and keeps the 5-minute poll as the fallback.

## 7. Cost

**AI:**

- **Per explanation:** at most about 1,800 input tokens (the instructions plus at most 4,000 characters of input) and at most 300 output tokens. At the neuron rates noted for the kernel's model in `control-plane-shared/src/ai-engine.ts` (about 9.1k neurons per million input tokens and 27.3k per million output tokens), that is about 16 + 8 ≈ **25 neurons per call**.
- **Caps (new, in the Steward's DO):**
  - at most 6 explanations per UTC day;
  - at most 1 per ADR per day;
  - at most 2 per cycle;
  - none in survival mode (`GET /v1/metabolism`; survival cuts the AI budgets to a quarter, `power-mode.ts` `SURVIVAL_AI_BUDGET`).
- **Daily ceiling:** 6 × 25 ≈ **150 neurons a day**, about 1.5 % of the account's 10,000 free daily neurons. Above the free allocation, at Workers AI's published $0.011 per 1,000 neurons, this is about $0.002 a day, or about **$0.05 a month at the cap**. Most days will have 0–3 changes. The rates are checked again when the task is built (step 6, 2026-11-17: unchanged).
- **Requests against `AI_ACCOUNT_DAILY_REQUEST_LIMIT = 75`** (`workers/ai-kernel/wrangler.toml`, counted in `ai_usage`): at most 6 a day, 8 % of the cap. The measured platform use was 20.4 requests a day with a peak of 42 (comment in that file), so the peak plus the Steward is 48, under 75.
  - The kernel's own `AI_DAILY_REQUEST_LIMIT = 80` is shared with the Supervisor and the Auditor. The Auditor's hourly digest uses up to 24 of it.
  - If the cap is reached, the explanation is skipped; nothing else is affected.
- **The learning mandate is untouched.** The Steward makes no learning call, adds no limit to `memory.remember`, `knowledge.propose` or their AI calls, and does not edit `power-mode.ts` (a guard path).

**D1 and compute:**

- **Tick checks:** 96 a day × 1 indexed query, a few rows each.
- **Full passes:** about 10 a day (events plus the daily pass) × about 150 small indexed queries ≈ 1,500 queries and about 30,000 rows read a day.
- **Panel reads:** about 300 rows per open tab per day at the 5-minute poll.
- **Writes:** a few rows a day, each with one audit event.
- All of this sits far inside the Workers Paid D1 allocation. Durable Object and Worker requests are about 100 a day. **The net cost is about $0** beyond the AI line above.

## 8. Seed manifests

The status table compiled from main at 22:30 UTC on 2026-11-16 is the expected first result. The first live pass confirms it. Any difference is a finding, not an edit.

### 8.1 ADR-0012 (gates 1–13, the executor and binding gates, the 24 h window, steps 1–8)

The groups are `gates` and `steps`. Expected at the first pass: 18 of 26 complete (12 proven, 6 asserted), 69 %, status `in_progress`.

One more gate than the orchestrator's table: `docs/GITHUB-CUTOVER.md` ("2026-11-16: binding props lost out of band") adds a **binding gate** for step 6, whose status there is "built, not yet run live". It is included as `GB`.

```json
{
  "schema": "adr.progress.v1", "adr": "0012", "title": "Leave GitHub — Cloudflare-native source, CI and deploy (the Forge)",
  "adr_file": "architecture/adr/0012-github-independence.md", "lifecycle": "accepted",
  "groups": [{ "id": "gates", "title": "Cut-over gates" }, { "id": "steps", "title": "Cut-over procedure" }],
  "phases": [
    { "id": "G1", "group": "gates", "title": "Deploy decisions read the Forge",
      "evidence": { "kind": "doc_asserted", "ref": "docs/GITHUB-CUTOVER.md", "quote": "done: merged in #301" } },
    { "id": "G2", "group": "gates", "title": "Forge keeps built modules",
      "evidence": { "kind": "audit_event", "event_type": "forge.bundles_stored" } },
    { "id": "G3", "group": "gates", "title": "Native deploy of code-only changes",
      "evidence": { "kind": "audit_event", "event_type": "deployment.native_deploy_succeeded" } },
    { "id": "G4A", "group": "gates", "title": "Gate 4 part A: smoke tests through Access, deploy-time vars",
      "evidence": { "kind": "deploy_step", "step": "unit:smoke_passed", "executor": "native:deploy" } },
    { "id": "G4B", "group": "gates", "title": "Gate 4 part B: routes, DO migrations, Workflows natively",
      "evidence": { "kind": "deploy_step", "step_suffix": ":topology_planned", "executor": "native:deploy" },
      "built": ["workers/deployment-orchestrator/src/topology.ts"], "next": "First live run of a part B path",
      "doc_claim": { "state": "built", "ref": "docs/GITHUB-CUTOVER.md", "quote": "built, not yet run live):** routes, Durable Object migrations and Workflows" } },
    { "id": "G4D", "group": "gates", "title": "Gate 4: destructive path (owner click)",
      "evidence": { "kind": "any_of", "of": [
        { "kind": "audit_event", "event_type": "deployment.destructive_deploy_succeeded" },
        { "kind": "audit_event", "event_type": "deployment.destructive_topology_applied" } ] },
      "built": ["workers/control-plane-shared/src/destructive-deploy.ts"] },
    { "id": "G5", "group": "gates", "title": "Forge merges by fast-forward, merge_change by consensus",
      "evidence": { "kind": "all_of", "of": [
        { "kind": "reading", "name": "forge_merge_path" },
        { "kind": "consensus_executed", "action": "merge_change" } ] } },
    { "id": "G6", "group": "gates", "title": "Contributors push to platform-work",
      "evidence": { "kind": "reading", "name": "forge_work_cr_merged" } },
    { "id": "G7", "group": "gates", "title": "Dependency audit and secret scan",
      "evidence": { "kind": "reading", "name": "dependency_audit_fresh_48h" } },
    { "id": "G8", "group": "gates", "title": "Daily git bundle to R2, verified",
      "evidence": { "kind": "reading", "name": "git_backup_verified_48h" } },
    { "id": "G9", "group": "gates", "title": "Access provisioning without provision-access.yml",
      "evidence": { "kind": "consensus_executed", "action": "change_access", "owner_approved": true } },
    { "id": "G10", "group": "gates", "title": "Worker retirement through the Scripts API",
      "evidence": { "kind": "sequence", "of": [
        { "kind": "consensus_executed", "action": "retire_worker", "owner_approved": true },
        { "kind": "audit_event", "event_type": "deployment.retire_succeeded", "payload": { "$.executor": "native:retire" } } ] },
      "built": ["workers/deployment-orchestrator/src/native-retire.ts"],
      "owner_action": { "text": "Approve the first native retirement when one is proposed", "href": "#/owner" },
      "doc_claim": { "state": "built", "ref": "docs/GITHUB-CUTOVER.md", "quote": "**built, live, not yet run**" } },
    { "id": "G11", "group": "gates", "title": "Rollback, alerts and owner notices off GitHub",
      "evidence": { "kind": "any_of", "of": [
        { "kind": "audit_event", "event_type": "deployment.rollback_succeeded" },
        { "kind": "doc_asserted", "ref": "docs/GITHUB-CUTOVER.md", "quote": "done: native rollback (credentials set), Kernel notices" } ] } },
    { "id": "G12", "group": "gates", "title": "Checks and type-check off GitHub",
      "evidence": { "kind": "doc_asserted", "ref": "docs/GITHUB-CUTOVER.md", "quote": "parity 34/34 checks and 78/78 plans" } },
    { "id": "G13", "group": "gates", "title": "Secrets as Worker secrets; native identity lists",
      "evidence": { "kind": "all_of", "of": [
        { "kind": "migration_applied", "name": "0073_platform_identities.sql" },
        { "kind": "doc_asserted", "ref": "docs/GITHUB-CUTOVER.md", "quote": "**secrets: met via Worker secrets**" } ] } },
    { "id": "GX", "group": "gates", "title": "Executor first: a fix to the executor reaches production without it",
      "evidence": { "kind": "audit_event", "event_type": "deployment.rescue_succeeded", "payload": { "$.executor": "rescue:deployment-orchestrator" } } },
    { "id": "GB", "group": "gates", "title": "Binding gate: native uploads restore declared service bindings",
      "evidence": { "kind": "any_of", "of": [
        { "kind": "audit_event", "event_type": "deployment.binding_drift_repaired" },
        { "kind": "deploy_step", "step_suffix": ":service_bindings_checked" } ] },
      "built": ["workers/control-plane-shared/src/service-bindings.ts"],
      "note": "the step name for 'checked, none found' is fixed when this is built",
      "doc_claim": { "state": "built", "ref": "docs/GITHUB-CUTOVER.md", "quote": "**Status: built, not yet run live** (branch `binding-props`" } },
    { "id": "W24", "group": "gates", "title": "Native deploys clean for 24 hours",
      "evidence": { "kind": "quiet_window", "hours": 24, "success_type": "deployment.native_deploy_succeeded",
        "fail_types": ["deployment.native_deploy_failed", "deployment.rescue_failed", "deployment.break_glass_failed", "deployment.destructive_deploy_failed"] } },
    { "id": "S1", "group": "steps", "title": "Freeze",
      "evidence": { "kind": "doc_asserted", "ref": "docs/GITHUB-CUTOVER.md", "quote": "## Cut-over log (2026-11-13" } },
    { "id": "S2", "group": "steps", "title": "Final sync",
      "evidence": { "kind": "doc_asserted", "ref": "docs/GITHUB-CUTOVER.md", "quote": "## Cut-over log (2026-11-13" } },
    { "id": "S3", "group": "steps", "title": "Backup",
      "evidence": { "kind": "audit_event", "event_type": "forge.git_backup_written" } },
    { "id": "S4", "group": "steps", "title": "Flip the merge path",
      "evidence": { "kind": "migration_applied", "name": "0058_cutover_merge_path_forge.sql" } },
    { "id": "S5", "group": "steps", "title": "Flip contributors (linear history guard)",
      "evidence": { "kind": "all_of", "of": [
        { "kind": "reading", "name": "forge_work_cr_merged" },
        { "kind": "migration_applied", "name": "0071_forge_linear_history_guard.sql" } ] } },
    { "id": "S6", "group": "steps", "title": "Retire GitHub paths",
      "depends_on": ["G4A", "G4B", "G4D", "G10", "GX", "GB", "W24"],
      "evidence": { "kind": "all_of", "of": [
        { "kind": "quiet_window", "hours": 168, "success_type": "deployment.native_deploy_succeeded", "fail_types": ["deployment.dispatched"] },
        { "kind": "external_asserted", "source": "github", "ref": "workflows disabled on GitHub", "as_of": null } ] },
      "next": "Disable the GitHub workflows once the gates and the 24 h window are met" },
    { "id": "S7", "group": "steps", "title": "Revoke the Orchestrator's GitHub token; archive the repository (owner)",
      "depends_on": ["S6"],
      "evidence": { "kind": "all_of", "of": [
        { "kind": "reading", "name": "orchestrator_github_fallback_absent" },
        { "kind": "external_asserted", "source": "github", "ref": "repository archived", "as_of": null } ] },
      "owner_action": { "text": "Delete GH_ACTIONS_TOKEN on the Orchestrator, then archive the GitHub repository", "outside_platform": true } },
    { "id": "S8", "group": "steps", "title": "Verify one routine change end to end",
      "depends_on": ["S7"],
      "evidence": { "kind": "sequence", "of": [
        { "kind": "audit_event", "event_type": "forge.merged" },
        { "kind": "audit_event", "event_type": "deployment.native_deploy_succeeded" },
        { "kind": "reading", "name": "drift_in_sync_all" } ] } }
  ]
}
```

Notes:

- **G13.** The gate row in `docs/GITHUB-CUTOVER.md` still reads "Identity lists: open", although migration 0073 and the redeploy for identities are on main (`docs/SSOT.md`, the 2026-11-16 entries). That is the first `doc_behind` the Steward would raise, once G13 carries a `doc_claim`.
- **`S6`'s 168 h window** on `deployment.dispatched` (a GitHub workflow dispatch) proves that nothing went through GitHub for a week. The `external_asserted` half covers what the platform cannot see.
- **Payload paths** (`$.executor`), and the step names marked in a `note`, are checked against the code when the evaluator is built.

### 8.2 ADR-0014 (E0–E5, A1–A3)

Expected: 1 of 9, 11 %, status `in_progress`, badge `deferred`.

```json
{
  "schema": "adr.progress.v1", "adr": "0014", "title": "The evolution loop",
  "adr_file": "architecture/adr/0014-evolution-loop.md", "lifecycle": "deferred",
  "phases": [
    { "id": "E1", "title": "Autonomous merge by consensus",
      "evidence": { "kind": "consensus_executed", "action": "merge_change" } },
    { "id": "E0", "title": "Self-inventory; findings become intents",
      "evidence": { "kind": "all_of", "of": [
        { "kind": "observer", "source": "runs", "kind_filter": "inventory", "expect": "some" },
        { "kind": "not_measurable_yet", "reason": "no intents table: inventory findings are not turned into intents" } ] },
      "built": ["workers/control-plane-shared/src/observer-inventory.ts"], "next": "Turn inventory findings into intents" },
    { "id": "E2", "title": "The evolver agent", "depends_on": ["E0"],
      "evidence": { "kind": "agent_registered", "agent_id": "evolver" },
      "built": ["workers/control-plane-shared/src/evolution-limits.ts"], "note": "limits only; no evolver agent" },
    { "id": "E3", "title": "Fitness, automatic revert, freeze", "depends_on": ["E2"],
      "evidence": { "kind": "not_measurable_yet", "reason": "no fitness or revert records exist" } },
    { "id": "E4", "title": "Evolution memory and Console page", "depends_on": ["E3"],
      "evidence": { "kind": "not_measurable_yet", "reason": "no evolutions table" } },
    { "id": "E5", "title": "Morphogenesis", "depends_on": ["E2", "E3"],
      "evidence": { "kind": "not_measurable_yet", "reason": "not started" } },
    { "id": "A1", "title": "Agentic votes with reasons",
      "evidence": { "kind": "not_measurable_yet", "reason": "votes are deterministic rules only" } },
    { "id": "A2", "title": "Diagnosis of what is stuck",
      "evidence": { "kind": "not_measurable_yet", "reason": "not started" } },
    { "id": "A3", "title": "Agent-to-agent protocol",
      "evidence": { "kind": "not_measurable_yet", "reason": "not started" } }
  ]
}
```

### 8.3 ADR-0016 (T0–T5)

Expected: 1 of 6, 17 %, status `in_progress`. T0 is complete but counts as asserted: the vision reads valid, and the rest of T0 rests on the ADR's own "T0 as built" text. The next step is T1.

The full manifest extends §2.4 with:

- T2 (the Strategist in shadow): `agent_registered strategist`, plus `not_measurable_yet` for the intents;
- T3 (the experience ledger), T4 (vision growth) and T5 (morphogenesis): `not_measurable_yet`, with `depends_on` chained in order;
- `fits: ["0019:P0"]` on the ADR.

### 8.4 One line for every other ADR

| ADR | Expected status | Evidence the manifest uses |
|---|---|---|
| 0001 Cloudflare-native runtime | done | doc-asserted (a baseline with no phases) |
| 0002 Infrastructure state and recovery | done | doc-asserted. The deferred backend selection is a clause of the decision, not a phase. |
| 0003 Service-scoped D1 integrity | done | `migration_applied 0002_service_referential_integrity.sql` (proven) |
| 0004 Operational control plane | done | `migration_applied 0003_control_plane_services.sql` (proven) |
| 0005 Cloudflare transformation | done | doc-asserted, including "no containers" |
| 0006 Cloudflare Workflows | done | `migration_applied 0009_recovery_lifecycle.sql`, plus doc-asserted |
| 0007 AI Worker OS | done | `agent_registered` supervisor, auditor and signal-analyst (proven) |
| 0008 Cerebrum Console and Access | done | doc-asserted, plus `reading vision_valid` as a Console liveness proxy. Better evidence is Q8. |
| 0009 Consensus autonomy (phases 1–4) | done | `consensus_executed` with `owner_approved: true` (phase 4), plus `migration_applied 0023_consensus_shadow.sql` (proven) |
| 0010 Nexus single origin | done | `migration_applied 0055_retire_home.sql`, plus doc-asserted |
| 0011 Users and privileges | done | `migration_applied 0026_platform_accounts.sql` (proven) |
| 0013 Living platform (phases 1–4) | done | `census_clean`, plus `consensus_executed register_agent` (proven) |
| 0015 Organs as cells | in progress (3 of 8), xauusd side only | Platform phases 1–4: `not_measurable_yet` (no hub, no Analytics Engine, no archive). xauusd P1 push hub done, P2a and P2b live: `external_asserted source xauusd`. P2c parked: open, "parked". The ADR's Status line says "Nothing in the Decision is built yet": a note, not a finding, because the evidence is external. |
| 0017 Human–AI collaboration (H0–H5) | not started (0 of 6) | All open. H0 and H1 carry the note "designed; owner answered Q1–Q11; design on branch haic-design". |
| 0018 Forge deploys external organs (X0–X3) | held (1 of 5) | `adr_file: null`, `lifecycle: held`, note "on branch adr-0018, not on main". X0 is `external_asserted branch:adr-0018`. X3's platform joins are `built` (the `EXTERNAL_ORIGINS` entry in `organism.ts`, the `EXT_ORGANISM_CTA` binding in `workers/forge/wrangler.toml`, the drift binding and the Access paths), and X3 also needs `migration_applied` of the pending 0074 registry migration (its file name is set when that change request lands). X1, X2 and X2b are open, not built. |
| 0019 AI Mesh program | planned | `adr_file: null`, `lifecycle: planned`, no phases, note "owner-confirmed, not drafted". |

## 9. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | A manifest is edited so that a gate reads as met with weaker evidence (for example, swapped for `doc_asserted`) | Manifests change only by reviewed change requests. Each manifest change is a full pass with an `adr.status_changed` event naming the phases that moved. The panel shows asserted phases hatched. Q2 proposes guard paths for the guarded ADRs' manifests. |
| R2 | The CI quote check makes document edits fail when a quoted phrase changes | Quotes are short. The test's message names the manifest and phase to update. Editing the doc and its claim together is the point. |
| R3 | "Proven" is mistaken for "safe": an event proves something happened once, not that it still works | Live predicates (`census_clean`, `quiet_window`, readings) where it matters. The panel says "proven" (evidenced), never "safe". |
| R4 | The new `AdrStewardAgent` class needs an additive DO migration (`new_sqlite_classes`, tag v5). On the native path that is a gate 4 part B case that has not run live yet. | Ship it while the GitHub workflow fallback still exists (before cut-over step 6). If it succeeds, it is also part B's first live proof. Otherwise, run the Steward without a DO (Q4). |
| R5 | AI text says something the evidence does not | The validator: refs from the input only, numbers from the input only, no contradicting status word. The template remains on failure. |
| R6 | Evidence semantics drift when code changes event names or step names | The CI test cross-checks the manifests' event types against the event names in the source, as the identity and gate tests already read source files. A renamed event fails CI. |
| R7 | Owner noise | Drift is a warning, once per episode, and never on Telegram by default. Owner actions only mirror `pendingApprovals()`, so nothing new reaches the owner. |
| R8 | D1 cost if the panel is left open in many tabs | The 5-minute poll is hidden-tab aware. The push hub removes the poll later. |

## 10. Open questions for the owner

1. **Q1. Manifest as separate JSON files (`architecture/adr/progress/00NN.json`) instead of front matter?** Recommended: **yes**. Three ADRs are guard paths, and progress comes from evidence, so the files rarely change.
2. **Q2. Make the manifests of the guarded ADRs (0009, 0012, 0014) guard paths too?** Recommended: **yes**. Their gates are the owner's decisions, the files change only when a gate is redefined, and one rule in `guard-paths.ts` covers it.
3. **Q3. A new tier-0 capability `adr.observe`, rather than widening `platform.observe`?** Recommended: **yes, new**. Least privilege, and a clear audit line. It rides in the same owner-click change request as the DNA.
4. **Q4. Run the Steward as its own Durable Object (`AdrStewardAgent`)?** Recommended: **yes**, shipped before cut-over step 6. It matches the other agents and serializes cycles, and the risk of the DO migration is covered while the GitHub fallback still exists.
5. **Q5. Write the panel's explanation in Indonesian, overriding "reports in English" (2026-11-07) for this panel only?** **Superseded 2026-11-17** by the owner's "all in english please": the panel and its explanation are English (see "Reversal" below). Recommended at the time: **yes**. You asked for "penjelasan" on the Vision panel. Identifiers and numbers stay as they are.
6. **Q6. AI cap: at most 6 explanations a day, 1 per ADR, none in survival mode?** Recommended: **yes**. About 150 neurons and 8 % of the 75-request account cap at most, and the template covers the rest.
7. **Q7. Count doc-asserted phases toward "done" (then "selesai") and the percentage, but draw them hatched and count them separately?** Recommended: **yes**. Otherwise ADR-0001 to ADR-0011 never read as done, and the separate count keeps it honest.
8. **Q8. For the older ADRs (0001, 0002, 0005, 0008), accept doc-asserted as their evidence?** Recommended: **yes**, for now. They predate the audit chain's coverage. Upgrade them only when a cheap machine predicate appears.
9. **Q9. Reuse the `ev:` evidence-ref format from the HAIC design for the panel and the Steward?** Recommended: **yes**. One citation format for the inbox, the chat and this panel.
10. **Q10. Place the Steward in ADR-0019 P0, and track ADR-0019 as "planned" until it is drafted?** Recommended: **yes**. It is the organism's knowledge of its own plans, and it is the first thing P0 needs to measure itself.
11. **Q11. Include the xauusd RFCs later through the same manifest?** Recommended: **later, after the platform panel has run a week**. Prove the predicates on the platform first. The xauusd evidence needs its own read-only source.
12. **Q12. Drift findings as `platform_digest` warnings, never critical, and not sent to Telegram?** Recommended: **yes**. A documentation lag must never raise the consensus brake or wake you up.

**Owner answers (2026-11-16, "ya semua, sesuai rekomendasimu").** Every recommendation above is accepted:
- Q1 to Q10 and Q12 are yes.
- Q11 is later: the xauusd RFCs come in after the platform panel has run for a week.
- The build may start in the order of §11.

**Reversal (2026-11-17, "all in english please").** The owner asked for the whole Cerebrum Console in English. This supersedes the answer to Q5 and the Indonesian part of the panel title: the panel's title is "ADR — Architecture Decision Records", its labels are §6.3's English ones, the deterministic sentence is English, and `draft_adr_explanation` runs with `PLAIN_ENGLISH_STYLE`, like every other AI task; the per-task Indonesian style (`INDONESIAN_STYLE_TASKS`, `taskStyle`) is removed from `ai-engine.ts`. The validator's status words and negations are English. The stored explanation keeps its keys `teks` and `rujukan`, which are data, not text the panel shows. Step 3 registers the agent and touches two guard paths, `capabilities.ts` and `workers/ai-kernel/organism.json`, so it still needs the owner's click through `merge_owner_change`. Step 1 does too, because the manifests of 0009, 0012 and 0014 are guard paths (Q2).

## 11. Implementation order

Each step is one change request. The effort is rough and assumes the session that builds it.

| # | Change request | Guard path? | Effort |
|---|---|---|---|
| 1 | `control-plane-shared/src/adr-progress.ts` (schema validator), `architecture/adr/progress/0001.json`–`0019.json` (the seed of §8), `test/adr-progress.test.ts` (schema, quotes, lifecycle, `built` paths). The Q2 rule goes in `guard-paths.ts` if approved. **Built 2026-11-17**, with `0020.json` for ADR-0020 (merged after this design) and the seed re-checked against main: GB has no "checked, none found" step, S6 and S7 keep the GitHub side open until it is dated, X3 measures `0074_register_cta.sql`, 0008 drops the `vision_valid` proxy. | Yes, Q2 (`merge_owner_change`) | 1 day |
| 2 | `control-plane-shared/src/adr-evidence.ts`: the predicate evaluator and the readings, pure over a D1 interface, with tests on `node:sqlite` fixtures built from the real migrations (the test runner already uses `--experimental-sqlite`). **Built 2026-11-17**, with `test/adr-evidence.test.ts`. As built: `asserted` is split into `doc_asserted` and `external_asserted`, and `not_measurable_yet` is its own state; a `sequence` looks each event up after the previous one, so the first chain counts; a `quiet_window` starts at the newest failure, or at the first success when there was none; `merged_and_deployed.branch` matches `source_branch`; `dependency_audit_fresh_48h` needs a completed (`ok`) audit; `adr_index_live` is not measurable until step 3 adds `adr_progress`, and `orchestrator_github_fallback_absent` until a read-only `DeployRpc` method exists. Every query has a LIMIT and an index, checked with query plans in the test. | No | 1.5 days |
| 3 | The agent: the DNA entry and engine in `workers/ai-kernel/organism.json`; `adr.observe` in `capabilities.ts` and its handler in `syscall.ts`; `AdrStewardAgent` with the wrangler migration v5; the D1 migration for `adr_progress` and `adr_progress_history`; the scheduled hook and the wake id; the audit events; `architecture/adr/progress/` added to the Control Plane unit's paths in `deploy-units.ts`. Then the census registers the agent and the engine by consensus. **Built 2026-11-17**, with migration `0075_adr_progress.sql`, `ai-kernel/src/adr-steward.ts`, `ai-kernel/src/adr-observe.ts` and `test/adr-steward-step3.test.ts`. As built: the gene and engine are registered by the census (migration 0041: new agents and engines only by consensus), so the tests that compare main's DNA with the registries apply them as consensus would (`test/harness.ts` `CONSENSUS_REGISTERED`); `adr-steward` joins `KERNEL_AGENTS` in `consensus-rules.ts`, a third guard path, because the DNA test requires that list to equal the kernel's agents; the kernel bundles the manifests and `organism/vision.json`, and for the Markdown the quotes the manifests anchor, which `adr-progress.test.ts` AP5 proves on the same commit, because a Text module rule would be refused by the native deploy as `build_rules_changed`; `draft_adr_explanation` is declared with its deterministic validator, as the DNA test requires of a declared engine, and never run before step 6; the body hash leaves out the evidence refs and the deploy commit, so a newer event proving the same thing rewrites nothing; drift opens and closes as `adr.drift_detected` and `adr.drift_resolved` audit events, and the reports stay step 7; a failed write is tried again an hour later; `adr_index_live` counts the rows, so the second pass rewrites 0016 once. | Yes (`organism.json`, `capabilities.ts`, and `consensus-rules.ts` for `KERNEL_AGENTS`): one owner click | 2 days |
| 4 | API: `GET /v1/adr` and `GET /v1/adr/{id}` on the kernel; the two allow-list rows and the two UI routes; tests like `vision-telos-0016.test.ts` V4. **Built 2026-11-17**, with `ai-kernel/src/adr-view.ts` and `test/adr-api-step4.test.ts`. As built: the two UI routes are the `UI_ROUTES` rows `kernel.adr` and `kernel.adr_one` of §5; the hash routes `#/vision/adr` and `#/vision/adr/<id>` belong to step 5, and no Console page changed; `steward.status` is `enabled`, `suspended`, `agents_disabled` or `not_registered`, from the agents table and the kill switch; `last_pass_at` comes from the Durable Object's `state()` RPC, and `last_full_pass_at` equals it, because every pass as built in step 3 evaluates every manifest; `deployed_commit` is the kernel's `CF_VERSION_METADATA.tag`; `ai_today` is `{ used: null, cap: null }` until step 6, since nothing measures it yet; a state RPC that fails leaves the pass times null; the detail is the stored body with the row's `revision` and `changed_at`, its `explanation` and `history`, newest first; an id that is not four digits is 400 `invalid_request`, an ADR without a document 404, any method but GET 405, and without the table the list is `available: false` and the detail 503 `not_available`; the kernel sends `Cache-Control: private, max-age=60`, and the Console proxy, unchanged, replaces it with its own `no-store` as for every forwarded route; the step 3 test's SSOT check now admits newer ADR Steward segments before step 3's. | No | 0.5 day |
| 5 | The Vision panel: the component, the labels of §6.3, the `#/vision/adr/<id>` routing, the render smoke test and truthfulness assertions. **Built 2026-11-17**, with `console/ui/src/components/AdrPanel.tsx`, `console/ui/src/lib/adr.ts` (the §6.3 wording and the panel's arithmetic, pure, so the Node test runs the same functions) and `test/adr-panel-step5.test.ts`. As built: the panel is its own component on `pages/Vision.tsx`, so the page itself still makes one read; `App.tsx` passes the hash's second and third segments, `#/vision/adr` scrolls to the panel and `#/vision/adr/<id>` opens that row, and a row opens and closes through the hash; the list polls every 5 minutes (`ADR_POLL_MS`), and the open row reads `kernel.adr_one` when it opens and when the list shows a new revision, not on a timer; the list has no phases, so the phase marks, the full blockers, the drift per phase, the stale sources and the history come from the open row's document; `GET /v1/adr` now carries `superseded_by`, so the list says superseded by ADR-NNNN without a second read; held and planned rows have a dashed border, and an ADR without phases (0019) shows "—" instead of a bar; a status is green only when done with every phase proven; `not_measurable_yet` and `unknown`, which §6.3 does not name, read "not measurable yet" and "unreadable" and are marked open; the Steward's states read active, suspended, disabled (agent kill switch) and not registered, and anything but active adds a line that no new pass runs and, with stored rows, when the last one ran; an unknown response is said to be unknown rather than drawn; evidence refs link to Consensus, Ledger, Code or Organism by their source, and owner actions only to the manifests' allowed pages. The render smoke checks seven cases at both widths: filled, a row opened, no pass yet, no table, not registered, suspended, and an invalid vision. The labels were Indonesian when built and are English since 2026-11-17 (the owner's reversal, §10); the labels quoted here are the English ones. | No | 1 day |
| 6 | The explanation: the `draft_adr_explanation` task, the per-task style option in `ai-engine.ts` (removed 2026-11-17), the validator, the caps in the DO and `adr.explanation_skipped`. **Built 2026-11-17**, in `ai-kernel/src/adr-steward.ts`, `control-plane-shared/src/ai-engine.ts`, `ai-kernel/src/adr-view.ts` and the panel's header, with `test/adr-explanation-step6.test.ts`. As built: the AI is asked only when an ADR's stored status changes (the owner's build instruction, narrower than §4.4 step 7's "status or any phase state"); a first document, or a change under the same status, keeps the sentence and is not a skip. The call goes through `engineFor` like the Supervisor's and the Auditor's drafts, so `ALLOWED_TEXT_MODELS`, the kernel's `AI_DAILY_REQUEST_LIMIT` and `AI_ACCOUNT_DAILY_REQUEST_LIMIT` apply, and it is made before the row is written, so the row is written once. The caps are 6 a UTC day, 1 per ADR a day and 2 a cycle, checked in that order after survival; survival is read from `metabolism_controls` as `AiEngine.reserve` reads it (the owner's override first), and an unreadable mode is not survival there either, the engine's budgets still applying. A request counts against the caps when the engine reserved it: an answer, an invalid answer, a timeout or an inference failure. `adr.explanation_skipped` carries `revision`, `from`, `to`, `reason`, `detail` (the engine's reason, such as `daily_budget_exhausted` or `schema:number_not_in_input`) and `cap`; the three caps share the reason `daily_cap`, told apart by `cap` (`day`, `adr` or `cycle`). The validator is stricter than §4.5: a draft must cite at least one ref, none twice; numbers are compared as whole numbers, so a 1 inside 18 is not in the input; only the computed status's §6.3 word may appear, never negated, and deferred only for a deferred ADR. A status change whose document has no evidence ref to cite makes no call and is skipped as `unavailable` with `no_evidence_refs`. The input carries the changed phases first and the first ref of other complete phases, trimmed to 4,000 characters as the engine serializes it. An AI explanation is stored as `source: "ai"` with the deterministic sentence kept in `template`. `steward.ai_today` is the Durable Object counter for the current UTC day against the cap of 6, both null when the Steward's state cannot be read; the panel shows it as "AI today: X/6", or "—". The neuron rates in `ai-engine.ts` are unchanged, so §7's figures hold. `power-mode.ts` is only read. **Changed 2026-11-17** (owner, "all in english please"): the explanation and the sentence are plain English, the per-task style option and `INDONESIAN_STYLE_TASKS` are removed, so every task gets `PLAIN_ENGLISH_STYLE`, and the validator's status words are English (not started, in progress, done, superseded, held, planned; deferred), negated by not, never, no longer or a contraction such as isn't, optionally with yet and been. | No | 1 day |
| 7 | Drift: `adr_drift.v1` reports with `alert_key` episodes, and the drift display on the panel. **Built 2026-11-17**, with `ai-kernel/src/adr-drift.ts`, the hook in `ai-kernel/src/adr-steward.ts` and `test/adr-drift-step7.test.ts`. As built: the episodes are read from the documents as stored in `adr_progress`, so a report names the drift the panel shows; an episode is one (ADR, phase, kind) drift, published once through `reports.publish` as a `platform_digest` **warning** with `body.schema = "adr_drift.v1"`, `state: "open"` and `alert_key = adr_drift:<adr>:<phase>`, carrying for each episode the phase and its title, the file, the quote the manifest anchors, the doc and computed states, up to 3 evidence refs, the manifest path, the panel link and a suggested fix in plain English (an operator report, so not Indonesian); an alert closes, once every episode it listed has closed, with a `Resolved:` **info** report with the same `alert_key` and `state: "resolved"`, which `resolvedLaterSql` reads as resolved, so the reports overview stops listing it; the open alerts are read back from `agent_reports` (the newest report of a key decides), so a restart reports nothing twice; the 4 `reports.publish` calls an hour are counted in the Durable Object: when the episodes to open and the alerts to close need more calls than are left, the new episodes go into one report (at most 12, under 14 KB) keyed `adr_drift:batch:<12 hex of their sha256>`, which closes when all of them have, and what is left is published on the next tick without a pass; a Policy Engine refusal (its own hourly count) is not counted and leaves the work pending; the report is never critical and is not sent to Telegram: the owner notices change nothing for it and the report relay does not qualify it (test AD3); the panel already showed the drift count and each phase's drift (step 5), so it is unchanged. In the same change, `docs/GITHUB-CUTOVER.md` records gate 4 part B's first live run (2026-11-17, `dep_3b2b298a-8d3d-40e7-8317-f1ba610bde17`), and the 0012 manifest's G4B `doc_claim` moves to `done` with the new quote, a guard path (`merge_owner_change`). | Yes (`architecture/adr/progress/0012.json`) | 0.5 day |
| 8 | Later: the `adr` channel on the `ConsoleHub` (with the HAIC hub slice); T1 self-model reads `adr_progress`; an H1 tool; the xauusd RFC manifests (Q11) | — | — |

Steps 1 and 2 can run in parallel. Step 3 waits for both, and steps 4–7 follow in order. Nothing here touches `.github/workflows/*`, and nothing writes to production before the reviewed deploys of steps 3–5.
