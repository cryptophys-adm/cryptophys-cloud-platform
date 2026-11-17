# Design: activating the evolver, the council intake and the return path

- **Status:** design (2026-11-17). The owner's decisions are in §1. The build follows §9. No step is built yet.
- **Owner decision (2026-11-17, relayed by the orchestrator and confirmed by the owner in this session):** "aktifkan evolver sekarang termasuk jalur balik" (activate the evolver now, together with the return path). This lifts ADR-0014's deferral (ADR-0014 §11).
- **Reads with:**
  - ADR-0014, the evolution loop. Its §1–§10 stay in force except where §11 says otherwise.
  - ADR-0007 (agents, capabilities, tiers) and ADR-0009 (consensus, the owner's click).
  - ADR-0012 (the Forge: change requests, checks, merges).
  - ADR-0017 and `docs/design/HAIC-H0-H1.md` (the decision hand-off, `council.decisions.read`).
  - ADR-0018 (external organs; held).
  - xauusd `docs/RFC_COUNCIL_PROPOSALS.md` (the `typed_proposal.v1` hand-off).
- **Base:** canonical main 0ec0822. Every "exists" claim names a file on that commit. Everything else is marked **new**.

## 1. Owner decisions (2026-11-17)

| # | Question | Answer |
|---|---|---|
| D1 | Activate the evolver now, with the return path, under the guardrails of §7 | "Ya, benar, kerjakan" |
| D2 | A `repository_task` for the xauusd repository | **Waits** in the inbox until ADR-0018 X1/X2 exist. The evolver works on the platform repository only (§4.3) |
| D3 | Cadence | **Unchanged**: one evolution in flight, at most one started per 4 hours (ADR-0014 §9). The owner first chose "10 CR/hari, 5 terbuka", then, shown that this would lift the 2026-11-13 limit while fitness and revert (E3) are not built, kept the 4-hour cycle |
| D4 | Guard paths | **ADR-0014 §3 stays**: a guard-path evolution merges by unanimous consensus under §3's four conditions, with no owner click. Until E3 is built, the evolver proposes routine paths only (`evolution-limits.ts`, §7), so no guard-path evolution can exist yet |

## 2. What exists and what is missing

**Exists (0ec0822):**
- **E1, the autonomous merge.** `merge_change` by consensus, merged by the Forge on Artifacts (`workers/forge/src/consensus-merge.ts`, `merge.ts`).
- **Change requests from `platform-work`.** Every branch pushed to `cryptophys/platform-work` becomes a change request `fg-<slug>`, gets the full checks and goes through the Supervisor (`workers/forge/src/work-repo.ts`, `changes.ts`). An `evo/<id>` branch therefore needs no new intake.
- **E2's validator.** `workers/control-plane-shared/src/evolution-limits.ts` holds the limits and `checkEdits` (scope, guard paths, diff size, the test rule, no removed assertions). It is a guard path.
- **E0's Observer inventory.** `workers/control-plane-shared/src/observer-inventory.ts` writes findings to `observer_findings`.
- **The council hand-off.** xauusd's moderator publishes `typed_proposal.v1` reports (`kind: xauusd_digest`, `body.schema: "typed_proposal.v1"`) through `reports.publish`. The first one arrived on 2026-11-17 at 15:58 UTC (`rpt_78293978…`, a `repository_task` for the xauusd repository).

**Missing (new):**
- no intents table; nothing reads the council reports or the inventory findings as work;
- no evolver agent; nobody writes code;
- no Forge path that writes a commit to an `evo/*` branch;
- no `council.decisions.read`; xauusd cannot learn what happened to its proposal;
- no owner toggle for the evolver.

## 3. Data (new, one migration)

**`evolution_intents`**: one row per need, whatever its source.
- `intent_id` (`int_<12 hex>`);
- `source`: `council`, `inventory`, `census`, `probe` or `owner`;
- `source_ref`: the report id, the finding id or the probe id. Unique with `source`, so an intent is never recorded twice;
- `origin_json`: for a council intent, the body's `proposal_id`, `origin` (`council`, `option_id`, `side`, `repo`, `topic`), `chosen_by` and `chosen_at`;
- `target_repo`: `platform` or the external repository's full name;
- `title`, `spec` (text, at most 8 KB), `evidence_refs_json` (at most 12);
- `state`, `state_reason`, `evolution_id` (the current one), `created_at`, `updated_at`.

**`evolutions`**: one row per attempt.
- `evolution_id` (`evo_<12 hex>`, `EVOLUTION_ID` in `evolution-limits.ts`) and `intent_id`;
- `state`, `branch` (`evo/<id>`), `base_sha`, `head_sha`, `cr_id`, `merge_sha`, `deploy_ref`;
- `model` (always `EVOLVER_MODEL`), `ai_calls`, `changed_lines`, `files_json`;
- `refusals_json` (from `checkEdits` or the Forge);
- `started_at`, `ended_at`.

**`evolution_updates`**: the return path's log, append-only. One row per state change of a council intent: `update_id`, `intent_id`, `proposal_id`, `state`, `reason`, `refs_json` (evolution, change request, merge, deploy), `created_at`.

**`evolver_controls`**: one row, `mode` = `on` or `off`, with `updated_by` and `updated_at`. It is the kill switch (§7): only the owner turns it on; any operator may turn it off as a brake.

## 4. The intake

### 4.1 Council intents

The ADR Steward pattern applies: a pass in the AI Kernel reads, validates and records. It never acts.

- **When.** After `reports.publish` stores a report whose `body.schema` is `typed_proposal.v1`, and in a 15-minute sweep that catches any it missed.
- **Accepted only when all hold:**
  - the report's agent is a registered agent of the external origin `xauusd`;
  - `kind` is `repository_task` and `executor` is `cryptophys`;
  - `state` is the accept (`handoff_pending`);
  - `origin.side` is `nexus` and `chosen_by` names the owner;
  - the body has no price field. The kernel drops price fields as `signals.observe` does.
- **Other kinds and later states are not intents.** A `policy_parameter` is xauusd's own (replay gate, auto-live, auto-rollback), `no_change` changes nothing, and a later state update of a proposal is not a new task.
- **Triage**, deterministic:
  - `target_repo` comes from `origin.repo`;
  - the platform repository → `queued`;
  - any other repository → `waiting_external`, with reason `adr_0018_x1_x2` (D2);
  - a spec over 8 KB or a missing title → `rejected`, with reason `invalid_spec`.
- **Visible.** `GET /v1/evolution` lists every intent from V2 on. The Console's Evolution page and an information item in Cerebrum's "Needs you" inbox follow in V6. They need no click, because the owner already chose the task in Nexus.

### 4.2 Platform intents (E0 and the census)

- An Observer inventory finding that no registration can settle (`undeclared_worker`, `missing_worker`) becomes an intent with `source: inventory`.
- A census finding the Supervisor cannot settle by a registration becomes an intent with `source: census`.
- A finding the Supervisor settles by `register_agent` or `register_engine` stays the Supervisor's and is not an intent.
- **Recurring findings.** One open intent per subject. A finding that recurs while its intent is open adds to that intent's evidence; it does not open a new intent.

### 4.3 External repositories (D2)

- An intent for a repository other than the platform's waits as `waiting_external`. The evolver never writes to it, and the platform never deploys an external organ (ADR-0018, option D).
- When ADR-0018 X1/X2 exist, the owner decides how such an intent is built. That needs a new amendment.

## 5. The evolver (E2)

### 5.1 The agent

- `evolver`, tier 2, in the AI Kernel (`workers/ai-kernel/src/evolver.ts`, a guard path).
- Registered by consensus like every agent. Its registration and capabilities are guard paths.
- **Capability (new):** `code.propose`. It may:
  - read files of canonical main through the Forge;
  - submit one set of edits for one evolution.

  It may not push, merge, deploy, read secrets or touch any branch other than its own `evo/<id>`.
- **Model:** `EVOLVER_MODEL` (`@cf/openai/gpt-oss-120b`) on Workers AI only. There is no fallback (ADR-0014 §9).

### 5.2 One cycle

A Durable Object alarm runs every 15 minutes. A cycle starts only when every condition holds:
- `evolver_controls.mode` is `on`;
- the kill switch is off and the consensus mode is not `shadow`;
- no evolution is in flight (`MAX_IN_FLIGHT = 1`);
- at least 4 hours have passed since the last start (`MIN_START_INTERVAL_HOURS = 4`);
- the quiet conditions of ADR-0014 §4 hold: no deploy running, no service drifted, no open critical report;
- the evolver is not frozen.

The cycle:
1. **Pick.** The oldest `queued` intent: council intents first, then the platform's own. An intent whose approach failed in the last 7 days is skipped (`FAILED_APPROACH_COOLDOWN_DAYS`).
2. **Plan.** One AI call reads the intent, the repository tree and recalled memory. It names at most 12 files to read.
3. **Write.** One AI call returns edits in `evolution-limits.ts`'s `Edit` shape, code and tests together.
4. **Check locally.** `checkEdits` runs on the edits. On a refusal there is one repair call with the refusals; a second refusal ends the evolution as `refused`. A cycle makes at most 3 AI calls.
5. **Propose.** `EvolutionRpc.propose` on the Forge (§6) gets the evolution id, the base SHA, the edits and the description (intent, evidence, expected effect).
6. **From here on, the existing path runs:**
   - the Forge's checks on `fg-evo-<id>`;
   - the Supervisor's `merge_change`, the council and the Policy Engine;
   - the Forge's merge;
   - `deploy_commit` by consensus.

   The evolver only watches the change request's state.
7. **End.** The evolution ends at the first of:
   - `deployed` (every unit of the merge deployed);
   - `closed` (checks failed, the council rejected it, or the change request stayed blocked for 24 hours);
   - `refused`.

   The outcome is written to the evolution, the intent, the audit chain and memory (`memory.remember`).

### 5.3 Until E3 exists

- **No fitness measurement yet.** A deployed evolution is recorded as `deployed_unmeasured`.
- **What still protects production:**
  - the deploy's own health check and automatic rollback (ADR-0009 phase 3);
  - the Forge's full checks;
  - the 4-hour cycle.
- **The freeze applies already.** Two evolutions in a row that end `closed` by failed checks, or any deploy rollback of an evolution, freeze the evolver. Only the owner lifts the freeze.
- **E3 comes next**, per ADR-0014 §7. Guard-path evolutions stay refused until it is built (§7).

## 6. The Forge's write path (new)

- **`EvolutionRpc.propose`** is a new Forge entrypoint in `workers/forge/src/evolution.ts`, a guard path. It is bound only to the AI Kernel, as `FORGE_EVOLUTION`.
- **What it does:**
  1. Checks the evolution id (`EVOLUTION_ID`) and that the base SHA is canonical main's head.
  2. Reads every edited file at that SHA.
  3. Runs `checkEdits` again. **The Forge's run is the authority**: it refuses anything the kernel's run let through.
  4. Writes one commit on main's head with the evolver as author.
  5. Pushes it to `refs/heads/evo/<id>` on `platform-work` and never to any other ref. A push to an existing `evo/<id>` is refused: one evolution, one commit.
- **Then.** The work-repository intake opens `fg-evo-<id>` as for any branch. Its checks, guard-path reasons, test guard and merge are unchanged.
- **Audit.** `forge.evolution_written` with the SHA, the files and the changed lines; or `forge.evolution_refused` with the refusals.
- **Credentials.** No GitHub credential exists in this path (ADR-0014 §5).

## 7. Guardrails

| Guardrail | Where it is enforced |
|---|---|
| **Forge only.** Every evolution is a change request on `platform-work` with the full checks. Nothing goes through GitHub | `EvolutionRpc` writes only `evo/*` on `platform-work` |
| **Routine paths only, until E3.** No guard path, D1 migration, Worker configuration, dependency, binary or deletion | `pathRefusal` and `checkEdits` in `evolution-limits.ts`, run by the kernel and again by the Forge |
| **Never editable by an evolution.** Guard rules, `organism/vision.json`, the Policy Engine's gates, Access, secrets, the evolver's own capabilities and ceiling | The guard-path list (`guard-paths.ts`). After E3, ADR-0014 §3's four conditions apply, and §3's refusals stay |
| **Tests may only grow.** A behaviour change needs a test, and no assertion is removed | `checkEdits`; the Forge's test guard |
| **Merge and deploy.** Through the Supervisor, the council and the Policy Engine; a destructive deploy keeps the owner's click | Unchanged |
| **Cadence.** One in flight, one started per 4 hours, 400 lines, 20 files | `evolution-limits.ts` (D3) |
| **AI budget.** At most 3 calls per cycle, so at most 18 a day; counted on the Metabolism page | The evolver |
| **Kill switch.** `evolver_controls.mode` through `POST /v1/evolution/mode`: `off` is a brake any operator may pull; `on` needs the owner and the confirmation `EVOLVER ON`. The platform kill switch and mode `shadow` also stop it | The evolver checks all three at every alarm |
| **Audit.** Every intent, attempt, refusal, write, merge, deploy and state update | The audit chain |
| **No trading, no funds.** An evolution never adds a path to a trading action without the owner's click, and never moves funds | ADR-0014 §3 refusals; ADR-0009; ADR-0020 |

## 8. The return path (`council.decisions.read`)

- **Capability (new):** `council.decisions.read`, tier 1, read-only. It follows HAIC-H0-H1.md §5: the xauusd side pulls, and Cerebrum never calls into xauusd.
- **Ceiling (new):** `XAUUSD_CEILING` in `control-plane-shared/src/organism.ts`, built like `AETHER_CEILING`. It names only the xauusd agents that pull (`xauusd-moderator`). `EXTERNAL_CEILING` is not widened. This is a guard-path change.
- **Request:** `{cursor}`.
- **Response:** `{updates: [typed_proposal.v1 state update], next_cursor}`, at most 20 per call, oldest first. It returns only updates for proposals that the caller's origin handed off.
- **Each update carries:**
  - `proposal_id` and `state`. The states are `queued`, `waiting_external`, `rejected`, `in_progress`, `proposed`, `merged`, `deployed`, `deployed_unmeasured`, `closed`, `refused`, `unfit` and `reverted`;
  - `reason`;
  - `refs`: `intent_id`, `evolution_id`, `cr_id`, `merge_sha`, `deploy_ref`;
  - `at`.
- **Cursor:** `at` plus `update_id`.
- **Not carried:** prices, code or diffs.
- **Later:** the same capability carries the Cerebrum-side council decisions of HAIC H2 when those exist.

## 9. Build order

Each step is one change request. Steps that touch guard paths say so.

| Step | What | Merge |
|---|---|---|
| V1 | This design, ADR-0014 §11 (the deferral lifted) and its manifest | owner click (`architecture/adr/0014-*`, `progress/0014.json`) |
| V2 | Migration: `evolution_intents`, `evolutions`, `evolution_updates`, `evolver_controls`. The council and inventory intake (§4); `GET /v1/evolution` (read) and `POST /v1/evolution/mode` (owner) | routine |
| V3 | `council.decisions.read` and `XAUUSD_CEILING` (§8) | guard path (`capabilities.ts`, the ceiling) |
| V4 | `EvolutionRpc` on the Forge (§6) and the `FORGE_EVOLUTION` binding | guard path (`forge/src/evolution.ts`) |
| V5 | The `evolver` agent, `code.propose`, its registration (§5). **The evolver is live from here** | guard path (`ai-kernel/src/evolver.ts`, `capabilities.ts`, `organism.json`) |
| V6 | Console Evolution page and owner notice (ADR-0014 E4) | routine |
| E3 | Fitness, automatic revert, freeze on unfit (ADR-0014 §1 step 7) | guard path where it touches `evolution-limits.ts` |

## 10. Evidence (manifest `progress/0014.json`)

- E2 is proven when `evolver` is registered. V4 adds `forge.evolution_written`, the first evolution that reached the Forge, to its evidence.
- The council intake (new phase `C1`) is proven by an `evolution_intents` row with `source = 'council'`.
- The return path (new phase `C2`) is proven by a `council.decisions.read` call from the xauusd origin in the audit chain.
- Until each is built it stays `not_measurable_yet`, with the step that builds it named.
