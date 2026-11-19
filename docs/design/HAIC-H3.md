# Design: HAIC H3 (corrections and ratings become knowledge)

Status: accepted by the owner on 2026-11-19; H3a built.

- **Implements:** ADR-0017 Decision 4 ("Teaching: owner corrections become knowledge (Nexus)"), owner decision 3 of 2026-11-14 ("Corrections in Nexus are recorded as high-weight learning"), and phase H3 of `docs/design/HAIC-H0-H1.md` §5.
- **Reads with:**
  - ADR-0016 (the learning mandate in "Rules that do not change"; Strategist reputation in §5);
  - ADR-0009 and ADR-0020 (trading needs the owner's click; no fund movement);
  - `docs/design/HAIC-H0-H1.md` (the `ev:` ref format and the shared-fixture pattern of `council.v1`, §4.6);
  - `docs/AETHER-INTEGRATION.md` (learned-knowledge proposals);
  - in `xauusd-ai-trading-assistant`: `docs/RFC_CALL_FOR_COUNCILS.md` §7 and §14 decision 9, `docs/RFC_AETHER_KNOWLEDGE_GUARDIAN.md`.
- **Boundary:** the Nexus part is built in `cryptophys-adm/xauusd-ai-trading-assistant` by its own session (ADR-0017 "Phases"). The Aether part is built in `cryptophys-aether` by its own session, through its own CI and guard paths (ADR-0016 "Rules that do not change"). This document defines the platform's part and the shared contract, and lists what the other two sides must do.

Every "exists" claim below names a file and line. A claim that something is new says so.

**Sources read.**
- The platform at canonical `main` `b251b08`.
- The xauusd repository at `origin/main` `a68eb82` (2026-11-18), read with `git show`. The local checkout there is older (`b0e4ca8`, 2026-11-13) and does not contain the council code. The remote may have moved again since.
- `cryptophys-aether` at `1ed4c03`, checked only for its ingress and guard paths.

## 1. Goals and non-goals

**Goals**
- One record format, `correction.v1`, for every owner judgement of an agent's output, whether it is a rating or a correction and whether it comes from Cerebrum or Nexus.
- Every correction is stored:
  - it is never refused;
  - it is deduplicated by content hash;
  - it is labelled and carries a weight;
  - it is audited.
- Corrections reach the agents as knowledge:
  - in Nexus, as owner-labelled notes, put first in the shadow knowledge arm's queue;
  - in Cerebrum, as evidence the chat and councils can read and cite.
- Corrections feed a measured, bounded **teaching record** (the owner-judgement side of reputation) for each agent, model or seat. It is shown in metric form.
- A shared contract with fixtures, built the way `council.v1` was, so that Cerebrum, Nexus and Aether can each check themselves against it.

**Non-goals and fixed guards** (unchanged constitution, ADR-0017 "Guards")
- **A correction never changes a trading parameter, a strategy, a risk profile, a quorum or a weight directly.**
  - `correction.v1` has no `params` field.
  - Each path from a correction into anything trading reads, in prompts or weights, goes through the existing shadow tests and their statistical gates (§5, §6.2).
  - Trading stays "critical: consensus, then one owner click" (`classify()` in `control-plane-shared/src/consensus-rules.ts`). No fund movement, ever (`PROHIBITED_CAPABILITY`, `capabilities.ts`).
- **A correction is not an approval.** It never confirms a directive, picks a council option, approves a consensus proposal or arms a strategy.
- **The learning mandate is kept.** No cap, rate limit, daily limit, power-mode denial or AI budget refusal applies to recording a correction (`control-plane-shared/src/power-mode.ts:29`). The kept rules still apply:
  - grants;
  - the kill switch (for agent-sent corrections);
  - the audit chain;
  - content safety.

  Content safety here works by redaction and masking, never by refusal (§4.4).
- **No secrets** are accepted or stored, and none is shown (ADR-0017 "Guards").
- **No price level leaves xauusd.** This is the existing rule for kernel reports and decision cards (xauusd `AGENTS.md` hard rule 8; `refCarriesPrice`, `control-plane-shared/src/council.ts:76`).
- **This document is a design.** It changes no code, consensus rule, guard path or workflow.

## 2. What exists today

### 2.1 Platform knowledge and learning

- **Learned-knowledge proposals** (`workers/ai-kernel/src/knowledge.ts`):
  - Kinds: `caution`, `role_reminder` and `param_candidate` (`:27`).
  - Only Aether's curator and calibrator propose, through `knowledge.propose` (`:325`). An approver decides each proposal once (`decideKnowledge`, `:404`). A pending proposal expires after 14 days (`:31`).
  - The validator (`validateKnowledgeItem`, `:219`) requires:
    - `label: "learned"` (`:225`);
    - `provenance.source: "aether"` (`:261`);
    - at least 10 cited decision cards (`MIN_CITED_CARDS`, `:32`, `:265`);
    - no price, level, order or field wording anywhere.
  - An owner's correction cannot meet these rules: it cites one target, not 10 cards, and its source is not Aether. **So corrections cannot be stored as `knowledge_proposals`.**
  - The table also rules them out:
    - `knowledge_proposals.kind` has a CHECK constraint on the three kinds (`control-plane-migrations/0029_knowledge_proposals.sql:14`);
    - `proposer_agent_id` must reference `agents` (`:11`);
    - adding a kind would mean rebuilding the table, which is destructive (`DESTRUCTIVE_SQL`, `control-plane-shared/src/migration-rules.ts:18`).
- **Which kinds run without approval:** `AUTONOMOUS_KNOWLEDGE_KINDS = ["caution", "role_reminder"]` (`control-plane-shared/src/knowledge-kinds.ts:8`). Only `param_candidate` waits for the owner (`knowledgeNeedsOwner`, `:11`). The inbox filters on the same list (`ai-kernel/src/owner-inbox.ts:123`), and `test/owner-inbox.test.ts:134-145` keeps the three in step.
- **Content-hash dedup** (`ai-kernel/src/learning-dedup.ts`):
  - `knowledgeDedupHash` hashes `["cryptophys.knowledge-dedup.v1", agent_id, item_id, normalized item without version]` (`:49-52`).
  - `memoryDedupHash` hashes `[…memory-dedup.v1, agent_id, kind, normalized text]` (`:45-47`).
  - An exact duplicate returns the existing row and writes nothing. Nothing is refused.
  - Migration `0070_learning_dedup_observe.sql` adds the `dedup_sha256` columns with **non-unique** indexes (`:46-50`). The reason given: a UNIQUE index would need a DELETE first and would refuse a concurrent learning call. H3 reuses this design.
- **Memory:** `memory.remember` stores bounded text (at most 1,000 characters) per agent in D1 and Vectorize (`ai-kernel/src/memory.ts:1-13`). Recall is limited to the calling agent's own memories.
- **The learning mandate:**
  - `LEARNING_CAPABILITIES = ["memory.remember", "knowledge.propose"]` (`power-mode.ts:32`). `power-mode.ts` is a guard path (`guard-paths.ts:54`).
  - Its invariant tests are guard paths too (`guard-paths.ts:57`):
    - LM4, knowledge.propose with no daily cap (`test/learning-mandate-2026-11-14.test.ts:146`);
    - LM6, only `ai-kernel/src/memory.ts` may pass `purpose: LEARNING_AI_PURPOSE` (`:192-216`);
    - LO2, the dedup (`test/learning-observe-2026-11-14.test.ts:82`).
  - The Observer reports `learning_volume` and `learning_repeat` findings and throttles nothing (`control-plane-shared/src/learning-watch.ts:79`, `:91`).

### 2.2 Platform ratings and owner judgements (H1c, H1.5, H2)

- **Chat turn ratings (H1c):**
  - Route: `POST /v1/conversations/{id}/turns/{n}/rating` with body `{rating: "up"|"down"}` (`ai-kernel/src/index.ts:166-178`). Owners only (`:162`).
  - `rateTurn` (`ai-kernel/src/conversation.ts:197-209`) writes `rating` on the turn record in the conversation's Durable Object storage (`TurnRecord.rating`, `:38`), overwriting any earlier rating. It then writes the audit event `conversation.rated`, with outcome `up`/`down` and payload `{conversation_id, turn}` only.
  - There is no D1 row for a rating. `conversations` (migration `0078_conversation.sql:26-34`) holds counts only.
  - Console: `kernel.conversation_rate` (`console/src/ui/routes.ts:52`; the allow-list in `console/src/index.ts:81`) and the thumbs buttons in `console/ui/src/pages/Ask.tsx:40`, `:67-70`.
  - **No rating is read by anything yet.** The weekly chat arena that would use them (HAIC-H0-H1 §3.5, step 9 of §7.3) is not built.
- **Councils (H1.5):**
  - `pickOption` takes an optional `owner_note` of at most 500 characters (`ai-kernel/src/council.ts:404-410`).
  - Owner messages are posted as `phase: "owner"` (`:396`).
  - There is no way to correct or rate a particular message, claim or option.
- **Typed proposals (H2):** `decideProposal(... "reject", reason)` stores a reject reason of at most 500 characters (`ai-kernel/src/proposals.ts:112-121`; table `typed_proposals.reason`, migration `0082`).
- **Knowledge reviews:** a reject reason on Aether's proposals (`knowledge.ts:407`, `:415`).

### 2.3 Reputation

- **Platform: none.** A search of `workers/` for "reputation" finds no code. The word appears only in ADR text:
  - ADR-0015 `:46` (reputation as small aggregate rows);
  - ADR-0016 `:59`, `:109`, `:126`, `:151` (the Strategist's reputation, phase T3, not built);
  - ADR-0017 `:47`;
  - HAIC-H0-H1 `:457`.
- **xauusd: an outcome-based reputation that sits on the trading path.**
  - `src/reputation.mjs` (P7) computes, per agent and timeframe over 30 days, a shrunk accuracy (`REPUTATION_PRIOR = 10`, `:20`) and a weight of 2 × shrunk, kept within `[0.25, 2]` (`WEIGHT_RANGE`, `:21`; `reputationOf`, `:43`).
  - `buildCrowdLine` (`:70`) weights each agent's bias by that weight. `quorumAllows` (`:118-119`, `QUORUM_SHARE = 0.5`) lets a room conclude BUY or SELL only with more than half of the weight.
  - The rooms enforce it (`src/timeframe-threads.mjs:178`, `entry_without_quorum`). The rooms are witnesses of the Decision Engine (`src/decision-engine.mjs:6-8`), whose decision feeds the EA, the Signal Ledger and Omega (`:33-34`).
  - **So any change to xauusd reputation weights is a change on the trading path.**
  - Changes to the reputation parameters go through deterministic replay and an owner PR (`src/tuning-replay.mjs:17`; RFC_AETHER `:410`).

### 2.4 xauusd and Aether: learned knowledge and corrections

- **Master knowledge:** `knowledge-base-v4.json` (version 4, `status: derived_from_pine_ssot`) is generated from `knowledge/kb-v4.mjs`. Every encoding cites a Pine line. It is the only master and is never changed by learning (RFC_AETHER `:545`; `src/learned-knowledge.mjs:11`, "Master knowledge (KB v4) always wins").
- **Learned pack:**
  - The bundled pack (`knowledge/learned/pack.json`) has `"items": []`.
  - Aether's live pack comes from `KnowledgeIngress.learnedPack()` (cryptophys-aether `src/index.mjs:45`; `src/knowledge.mjs:417`). Every item is `label: "learned"`. With `KNOWLEDGE_AUTO_SHADOW` on, pending `caution` and `role_reminder` items enter the pack too, as `review: "auto"`.
  - The text kinds a room accepts are `caution` and `role_reminder` (`src/learned-knowledge.mjs:16`).
- **Shadow knowledge arm** (`src/shadow-knowledge.mjs`):
  - at most 6 items at once (`MAX_ITEMS`, `:32`);
  - one extra opening call per agent and bar;
  - results are stored apart, "never in the crowd line" or any reputation (`:10`).
- **Autonomous promotion** (`src/learned-live.mjs`, owner 2026-11-13):
  - a note found `better_than_active` (Holm-adjusted p < 0.05, holdout no worse) goes live by itself for the tested agents and charts;
  - it retires by itself on a significantly worse record (`LIVE_RULES`, `:22`; switch `LEARNED_AUTO_PROMOTION`, `:15`, `:28`);
  - live notes reach real room prompts only while `LEARNED_KNOWLEDGE_ENABLED = "true"`;
  - RFC_AETHER `:146` still says "promotion is never automatic". That line predates `learned-live.mjs`.
- **Corrections in xauusd: designed, not built.**
  - `docs/RFC_CALL_FOR_COUNCILS.md` §7 (`:220-223`) specifies a council correction or rating as `{ label: "owner_correction" | "owner_rating", session_id, step, claim_ref, seat, text, rating, evidence_refs, content_hash }`.
  - Under that spec, a correction is stored once per hash, never refused (only secrets are checked), and sent to Aether with high weight, first in the shadow queue. It feeds the seat's reputation through "a bounded owner-rating term in `src/reputation.mjs` (proposed: at most ±0.05 of the crowd weight per week)".
  - Owner decision 9 (`:315`): "first in the knowledge arm's queue, shadow-tested; the owner can promote one by hand".
  - In code, `src/cfc-pack.mjs:556` and `:766` return `owner_corrections: unavailable("owner corrections are kept in the council sessions and are not read into … pack yet")`. No correction record, route, table or UI exists on `origin/main`: a search for `owner_correction`, `owner_rating`, `thumbs` and `correction.v1` under `src/`, `workers/` and `test/` finds only those two lines.
  - The Nexus dashboard has no feedback, rating or correction control (`workers/xauusd-nexus-dashboard/ui/src/pages/*`).
  - Nexus `/api/*` is GET/HEAD only. Owner writes go through `POST /omega/api/*` on the Omega Worker (RFC_CALL_FOR_COUNCILS §1.1).

### 2.5 Cross-repo plumbing that H3 reuses

- **External ceilings** (`control-plane-shared/src/organism.ts`, a guard path, `guard-paths.ts:44`):
  - `EXTERNAL_CEILING` = `signals.observe`, `reports.publish`, `memory.recall`, `memory.remember` (`:163`);
  - `AETHER_CEILING` (`:178`);
  - `XAUUSD_CEILING`, which adds only `council.decisions.read` for `xauusd-moderator` (`:199-205`).
- **Capabilities:** the catalog is `control-plane-shared/src/capabilities.ts:25-52` (a guard path, `guard-paths.ts:35`). Syscalls are dispatched in `ai-kernel/src/syscall.ts:869-896`. The Policy Engine treats learning capabilities the same in every power mode (`policy-engine/src/index.ts:85`).
- **`reports.publish` is limited to 4 an hour per agent** (`capabilities.ts:42`). It must not carry corrections, because that would cap learning.
- **The `ev:` ref grammar** and its price check: `parseRef` and `refCarriesPrice` (`control-plane-shared/src/council.ts:61-76`).
- **Redaction:** `redact()` (`control-plane-shared/src/http.ts:74`), `secretInText` and `redactText` (`control-plane-shared/src/conversation.ts:107`, `:110`).
- **Shared fixtures:** the `docs/contracts/council-v1/` pattern (README, `index.json`, `valid/`, `invalid/`), checked by `test/council-contract-h15a.test.ts`.

### 2.6 Documentation drift found while reading (to fix with H3)

- `docs/SSOT.md:137` still says "Not built yet. H0 and H1 start only after …". H0–H4 are built: migrations 0078–0083 and the routes in `ai-kernel/src/index.ts:83`.
- `docs/AETHER-INTEGRATION.md:68` still gives `knowledge.propose` as "6 an hour, 20 a day". The grants table in `docs/XAUUSD-INTEGRATION.md` §0 gives `memory.remember` as "12 per hour". The learning mandate removed both limits.

## 3. What a correction and a rating are

**A rating** is the owner's verdict on one agent output: `up` (good call) or `down` (wrong).

**A correction** is the owner's statement of what was wrong. It has:
- a category;
- optionally, a short text;
- optionally, the evidence refs that show it.

A correction may carry a rating as well.

| Label | Meaning | Weight (Q2) |
|---|---|---|
| `owner_rating` | Up or down only | 3 |
| `owner_correction` | Category plus text (plus an optional rating) | 3 |
| `owner_decision` | The owner's free-text **reason** on a reject: a typed proposal, a knowledge proposal (Q6) | 1 |
| `reviewer_correction` | H5 reviewers (ADR-0017 Decision 6); not in H3 | 2 |

**Categories** (closed list, extendable by contract version; from ADR-0017's examples):

`reading_wrong`, `invalidation_too_tight`, `invalidation_too_loose`, `evidence_wrong`, `evidence_missing`, `overconfident`, `underconfident`, `rule_broken`, `good_call`, `other`.

**Sources and targets:**

| Source | Side | Target ref (the `ev:` grammar) | Subject (whose teaching record) | Exists today |
|---|---|---|---|---|
| Chat turn rating | cerebrum | `ev:platform/conversation/<cnv_id>#turn_<n>` | `model:<CHAT_MODEL>` | The rating exists (DO and audit); no record |
| Council message, claim, option | cerebrum | `ev:platform/council/<cs_id>#seq_<n>[.claim_<i>]`, `#option_<id>` | `agent:<author>` (positions, rebuttals), `agent:moderator` (options) | No |
| Typed proposal reject reason | cerebrum | `ev:platform/typed_proposal/<tp_id>` | the origin (council moderator, or the chat model) | The reason is stored; no record |
| Knowledge review reject reason | cerebrum | `ev:platform/knowledge/<knw_id>` | `agent:aether-curator` or `aether-calibrator` | The reason is stored; no record |
| Decision card | nexus | `ev:xauusd/card/<d:…>` | `seat:<id>` of each agent on the card | No (xauusd session) |
| Room post, metric reading | nexus | `ev:xauusd/room_run/<run>#<step>` | `seat:<id>` | No |
| Decision Engine decision | nexus | `ev:xauusd/engine_decision/<bar>` | `seat:decision_council` | No |
| Nexus council turn, claim, option | nexus | `ev:xauusd/council/<cs_id>#…` | `seat:<id>` | Designed (RFC_CALL_FOR_COUNCILS §7) |

What is **not** a correction in H3:
- a pick, a dismissal, an approval or a confirmation (Q6);
- an owner chat message without the explicit correction control;
- anything sent through Telegram (ADR-0017 decision 1: Telegram is for notifications and light Q&A only).

## 4. Data model

### 4.1 The contract: `correction.v1` (new)

```json
{
  "schema": "correction.v1",
  "correction_id": "cor_<16 hex>",
  "side": "cerebrum|nexus",
  "source": "chat_rating|council|typed_proposal|knowledge_review|nexus_card|nexus_room|nexus_engine|nexus_council",
  "label": "owner_rating|owner_correction|owner_decision",
  "rating": "up|down|null",
  "category": "reading_wrong|…|good_call|other|null",
  "target": { "ref": "ev:…", "subject": "agent:<id>|model:<id>|seat:<id>", "as_of": "ISO time of the corrected output" },
  "text": "≤ 500 chars after redaction, or null",
  "evidence_refs": ["ev:…"],
  "actor": "owner:<access email>",
  "attested_by": "cerebrum_access|xauusd_nexus_access",
  "weight": 3,
  "supersedes": "cor_… | null",
  "redactions": ["secret", "price", "truncated"],
  "created_at": "ISO time",
  "content_sha256": "sha256 of the canonical record without id, times and weight",
  "dedup_sha256": "see 4.3"
}
```

- **Price safety:** refs are checked with `parseRef` and `refCarriesPrice`. A ref that carries a price is kept with its field dropped, and `redactions` gets `price`.
- **No parameters:** the schema has no `params`, `values` or `change` field. A validator test rejects any such key (the `forbiddenKeys` pattern, `knowledge.ts:58`).
- **Fixtures:** they live in `docs/contracts/correction-v1/` (README, `index.json`, `valid/`, `invalid/`), built like `council-v1`. The platform test, the xauusd test and the Aether test each load them.

### 4.2 Storage: migration `0084_corrections.sql` (new, additive only)

```sql
CREATE TABLE IF NOT EXISTS corrections (
  correction_id TEXT PRIMARY KEY CHECK (length(correction_id) = 20 AND substr(correction_id, 1, 4) = 'cor_'),
  side TEXT NOT NULL CHECK (side IN ('cerebrum', 'nexus')),
  source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 40),
  label TEXT NOT NULL CHECK (label IN ('owner_rating', 'owner_correction', 'owner_decision', 'reviewer_correction')),
  rating TEXT CHECK (rating IS NULL OR rating IN ('up', 'down')),
  category TEXT CHECK (category IS NULL OR length(category) <= 40),
  target_ref TEXT NOT NULL CHECK (length(target_ref) BETWEEN 4 AND 300),
  subject TEXT NOT NULL CHECK (length(subject) BETWEEN 3 AND 120),
  body_json TEXT NOT NULL CHECK (json_valid(body_json)),
  actor TEXT NOT NULL,
  attested_by TEXT NOT NULL,
  weight INTEGER NOT NULL CHECK (weight BETWEEN 1 AND 3),
  supersedes TEXT,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  dedup_sha256 TEXT NOT NULL CHECK (length(dedup_sha256) = 64),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corrections_subject ON corrections(subject, created_at);
CREATE INDEX IF NOT EXISTS idx_corrections_target ON corrections(target_ref, created_at);
CREATE INDEX IF NOT EXISTS idx_corrections_dedup ON corrections(actor, dedup_sha256);
CREATE INDEX IF NOT EXISTS idx_corrections_side ON corrections(side, created_at);
```

- **Why a new table and not `knowledge_proposals`:** see §2.1 (the kind CHECK, the agent foreign key, the validator, and corrections not being proposals that wait for review).
- **Why non-unique dedup:** see migration 0070's reasoning. Two truly simultaneous identical calls may both be written; that costs one row and refuses nothing.
- **`category` and `source` take free values in SQL,** with the closed lists in the validator. A new value is then a contract-version change, not a table rebuild.
- **Append-only.** The kernel never `UPDATE`s or `DELETE`s a row. A changed rating is a new row with `supersedes` set (Q7). The teaching record reads the newest row per `(actor, target_ref)`.
- **Retention:** kept like the audit chain, with no expiry. The record is small: no text beyond 500 characters, no transcript.
- **Migration number:** 0084 is the next free one at `b251b08` (latest `0083_autonomy_dial.sql`). If an in-flight branch takes it first, the next free number is used (as 0070 notes for 0066).

### 4.3 Dedup by content hash

- **The hash:** `dedup_sha256 = sha256(JSON.stringify(["cryptophys.correction-dedup.v1", actor, target_ref, label, rating, category, normalizeText(text ?? ""), sortedRefs]))`.
  - It is built with `normalizeText` and `normalizeValue` from `learning-dedup.ts:26-38`: whitespace runs are collapsed, case is kept and the refs are sorted.
  - `supersedes`, the ids and the times are left out.
- **What a duplicate does:** an exact duplicate by the same actor returns the existing row with `deduplicated: true`, writes nothing and is audited as `correction.deduplicated`.
- **What is not a duplicate:**
  - different content, such as up then down on the same target, which is a new row;
  - the same content after a different content in between: up, down, up gives three rows, and the newest one counts.

### 4.4 "Never refused" and content safety

Each step below is applied **before** storage and changes what is stored, not whether it is stored:

| Input | Result |
|---|---|
| Text with a secret (`secretInText`) | Stored as `redactText(text)`; `redactions += secret`; audited `correction.secret_redacted` (the chat refuses such a *question*; a correction is stored redacted instead) |
| A price-like number in text (the `PRICE` regex, `knowledge.ts:41`) | Masked as `[level]` in the platform and Aether copies; `redactions += price`. Nexus keeps its original in its own D1 |
| Text longer than 500 characters | Truncated; `redactions += truncated` |
| A ref that does not parse | Kept as `target.ref` only if it is the target; otherwise dropped from `evidence_refs`, with `invalid_refs: n` in the body |
| An unknown category | Stored as `other`, with the original in `body_json.category_raw` |
| An actor that is not an owner (Q9) | Stored with weight 1 and `attested_by` as sent; it never gets weight 3 |

The only call that writes nothing is a structurally empty one: no target and no rating, category or text. It returns `400 invalid_request`. There is nothing in it to learn.

### 4.5 Audit

Every record is audited with `appendAuditEvent` (`control-plane-shared/src/audit.ts`). The event types are:
- `correction.recorded`
- `correction.deduplicated`
- `correction.secret_redacted`
- `correction.delivered` (when Aether reads it, §7.3)
- `correction.converted` and `correction.not_convertible` (when Aether reports back)

The payload holds the id, label, rating, category, target ref, subject, weight, `content_sha256` and redaction flags. It never holds the text, which stays in D1 `body_json`. This is how the chat keeps text out of the chain (HAIC-H0-H1 §3.4).

## 5. How corrections become knowledge

The rule throughout: **a correction becomes knowledge by being read, ranked and tested. It never becomes a parameter.**

### 5.1 Cerebrum (platform scope)

- **The chat:**
  - A new read-only tool, `owner_corrections`, is added to `CHAT_TOOLS`. It returns the corrections whose `target_ref` or `subject` matches the refs and subjects of the turn's other tool results: deterministic matching, newest first, at most 10.
  - Each result is quoted as data, with its `ev:platform/correction/<id>` ref. The answer rules (HAIC-H0-H1 §3.3) treat it as evidence, not as instruction.
  - When an answer cites a value that the owner has corrected, the answer must cite the correction too.
  - No embedding: a new learning AI call site would break LM6 (`learning-mandate-2026-11-14.test.ts:192`), a guard path. See Q10.
- **Councils:** the convener adds an "Owner corrections" evidence section: the corrections on the topic's subjects and refs in the last 30 days. Seats may cite `ev:platform/correction/<id>`. Corrections still add no confidence on their own; the claim check is unchanged.
- **The chat arena** (HAIC-H0-H1 §3.5, not built): its score is already defined as "citation pass rate × the owner's thumbs-up share". H3 supplies the thumbs-up share from `corrections`, not from Durable Object storage.

### 5.2 Nexus (trading scope), built by the xauusd and Aether sessions

The flow is: Nexus correction → platform `corrections` (§7.2) → Aether pulls (§7.3) → Aether ledger → pack → xauusd shadow arm → statistical gate → live prompt, or retired.

- **Aether** turns a convertible correction into a learned text item:
  - kind `caution` (a reading or invalidation correction) or `role_reminder` (`rule_broken`);
  - `label: "owner_correction"`, `weight: 3`;
  - the audience is the corrected seat, and the situation is the target's chart and session;
  - the owner's text is masked and at most 300 characters.

  It is never `param_candidate` or a weighting item. A correction that cannot be turned into a valid note (no seat, no chart, or text that still fails the note rules) stays recorded and is reported `not_convertible: <reason>`. It still counts in the teaching record.
- **xauusd:**
  - The shadow arm puts `weight 3` items first in its 6-item queue (RFC_CALL_FOR_COUNCILS decision 9).
  - Live promotion happens only on the existing shadow verdict (`learned-live.mjs`). Owner decision 9's manual promotion is an owner click in Cerebrum, by HAIC Q6 (picks and promotions in Cerebrum). See Q3.
  - KB v4 still wins over any note (`learned-knowledge.mjs:11`).
  - `cfc-pack.mjs:556` and `:766` read the seat's corrections instead of `unavailable(...)`.
- **What a correction never does in xauusd:**
  - write `STRATEGY_PARAMS`, knob overrides, risk profiles, witness weights, `QUORUM_SHARE` or `REPUTATION_PRIOR`;
  - arm or disarm a strategy;
  - enter `outcome_scores`.

  A correction that *suggests* a parameter change, such as "invalidation too tight", can at most raise a council topic suggestion (`knowledge:<item>` or `strategy:` type) for the owner to start (HAIC Q9).

## 6. How corrections feed reputation

### 6.1 The teaching record (new; the owner-judgement side of reputation)

For each subject and window (7 days and 30 days), computed by a pure, deterministic function `teachingRecord(rows, now)`:

```
up_w    = Σ weight over the newest row per (actor, target) with rating up   (good_call counts as up)
down_w  = Σ weight over the same, with rating down, plus owner_correction rows without a rating
score   = (up_w + P/2) / (up_w + down_w + P)        P = 10, as REPUTATION_PRIOR in xauusd reputation.mjs:20
n       = rows counted;  by_category = counts;  last_at
```

- The score is shrunk toward 0.5, so a few ratings cannot floor or max a subject. A subject with no rows shows "—", never 0.5: the Console truthfulness rule, `console-truthfulness.test.ts`.
- It is computed on read from indexed rows, at most the last 30 days per subject. If reads grow, a small aggregate row per subject and day can be added later (ADR-0015 `:46`). Not needed at launch.
- **On the platform:**
  - `GET /v1/reputation` (new, operator-readable): the subjects with their 7-day and 30-day teaching records and category counts.
  - The Agents and AgentDetail pages show it next to each agent; the Ask page shows the chat model's.
  - It is **context only**. It gates nothing: no consensus vote, no council seat selection, no autonomy-dial level (H4 raises use the execution record, ADR-0017 amendment 2026-11-18 point 3), and no Policy Engine check.
  - When ADR-0016 T3 builds the Strategist's reputation, the teaching record is one of its inputs.

### 6.2 xauusd seat reputation (the trading path, so shadow first)

- The xauusd RFC's proposal is a bounded owner-rating term in `src/reputation.mjs`, at most ±0.05 of the crowd weight per week. That term would change `buildCrowdLine` weights, hence `quorumAllows`, the room conclusions, the Decision Engine's witnesses and the EA (§2.3).
- **Recommended (Q4):**
  - The live weight does **not** read corrections.
  - The term runs as a shadow crowd arm in the existing replay (`src/tuning-replay.mjs`, `shadow-crowd:<id>`, RFC_AETHER `:441`). It goes live only by the existing path for reputation parameters: a replay verdict, then an owner PR (RFC_AETHER `:410`).
  - Nexus shows the teaching record beside the outcome reputation as context. RFC_CALL_FOR_COUNCILS `:91` already shows a seat's reputation "as context".

## 7. Cross-repo contract

### 7.1 What the platform exposes

| Surface | Who | Shape |
|---|---|---|
| `docs/contracts/correction-v1/` | All three sides | Schema README, `index.json`, valid and invalid fixtures, and the dedup-hash vectors (input → `dedup_sha256`), so all sides hash identically |
| `POST /v1/corrections` (Console, kernel) | Owners, Access identity, CSRF | Body: `{target_ref, label, rating?, category?, text?, evidence_refs?, supersedes?}`. Response: `{correction_id, deduplicated, redactions}` |
| `GET /v1/corrections?subject=&target=&since=&limit=` | Operators | Records, newest first, at most 200, text included (already redacted) |
| `GET /v1/reputation` | Operators | Teaching records (§6.1) |
| `corrections.record` (new capability, tier 1, **learning**) | One named xauusd agent (§7.2) | Input: a `correction.v1` without id and hashes. Output: as the POST |
| `corrections.read` (new capability, tier 0) | `aether-curator` | Input: `{cursor, side?: "nexus"}`. Output: `{corrections: [correction.v1], next_cursor}`, oldest first, at most 50. Cursor: `created_at` plus `correction_id` (as `council.decisions.read`) |
| `knowledge` reports (existing `reports.publish`) | Aether | `body.schema: "correction_conversion.v1"`, `{correction_id, status: converted|not_convertible, item_id?, reason?}`, batched within the existing 4 an hour. The ack is not learning; the correction is already stored |

### 7.2 What Nexus sends

- **The owner's action:** a Nexus correction control (on a card, a room post or metric reading, a decision, or a council turn, claim or option) posts to a new `POST /omega/api/correction` on the Omega Worker. That Worker checks the owner's Access identity and the origin, as RFC_CALL_FOR_COUNCILS §1.1 does for council actions.
- **The local copy:** the AI Worker stores the original in its own D1, prices included, since prices never leave xauusd.
- **The send:**
  - The AI Worker sends the masked `correction.v1` over the existing `AGENTS` binding (`AgentRpc`) as `corrections.record`.
  - The sender is a **new dedicated agent id**, recommended `nexus-teacher`, registered by an additive `INSERT OR IGNORE` migration, as 0045 registered `knowledge-council`.
  - The alternative of granting the capability to an existing agent needs `UPDATE agents SET …`, which matches `DESTRUCTIVE_SQL`.
  - The new agent holds `corrections.record` only. It is named in `XAUUSD_CEILING.agents`; the general `EXTERNAL_CEILING` is not widened.
- **The identity:** `attested_by: "xauusd_nexus_access"`. The platform cannot verify a Nexus Access identity. It gives weight 3 only when the attested actor is in the platform's owner list (`isOwner`, `access.ts:198`; Q9).
- **Failures:** a transport failure is retried by the next sweep, as `aether-push.mjs` does for cards. A kernel denial is final (xauusd `AGENTS.md` rule 7).
- **Why not the existing capabilities:**
  - `reports.publish` is limited to 4 an hour, which would cap learning;
  - `memory.remember` (already in the ceiling, no rate limit) is private to the sending agent, is free text of at most 1,000 characters, and Aether cannot read it. It loses the structure, the dedup semantics and the audit labels. It is rejected as a design but noted as a no-guard-path fallback.

### 7.3 What Aether does

- Hourly, `aether-curator` calls `corrections.read` with its cursor, converts as described in §5.2, and acknowledges with `correction_conversion.v1`.
- The pack carries the items with `label: "owner_correction"`, `weight: 3` and `correction_id`.
- **Aether guard paths:** a new kernel call in its cron, or a new pack field, very likely touches `src/index.mjs`, an Aether guard path (`auth_access`, cryptophys-aether `guard-paths.json`). It therefore needs the owner's click there.

### 7.4 Shared fixtures and tests on each side

- **Platform:** `test/correction-contract-h3a.test.ts` loads every fixture, checks the expected errors, recomputes the dedup vectors and checks that the index lists every file (the pattern of H15a-1).
- **xauusd:** a test loads the same fixtures from a copy (the xauusd session copies the folder, as for `council-v1`) and checks its masked output and its hash against the vectors.
- **Aether:** a test checks the conversion: every `valid/` fixture becomes either a valid note or a `not_convertible` with an expected reason.

## 8. Guard paths touched

| Step | Path | Guard reason | Merge |
|---|---|---|---|
| H3a–H3d | `control-plane-shared/src/correction.ts` (new), `ai-kernel/src/corrections.ts` (new), `ai-kernel/src/index.ts`, `conversation.ts`, `conversation-tools.ts`, `council.ts`, `proposals.ts`, `knowledge.ts` (the reject hook only), migration 0084, Console pages and allow-list rows (`console/src/index.ts`, `console/src/ui/routes.ts`), `docs/contracts/correction-v1/`, `docs/SSOT.md` | none | routine `merge_change` |
| H3e | `control-plane-shared/src/capabilities.ts` (two capabilities) | `evolution_guard` (`guard-paths.ts:35`) | **owner click** (`merge_owner_change`) |
| H3e | `control-plane-shared/src/power-mode.ts` (`LEARNING_CAPABILITIES += corrections.record`) | `learning_mandate` (`:54`) | **owner click** |
| H3e | `control-plane-shared/src/organism.ts` (`XAUUSD_CEILING.agents.nexus-teacher`, `AETHER_CEILING.agents.aether-curator += corrections.read`) | `capability_ceiling` (`:44`) | **owner click** |
| H3e | `test/learning-mandate-2026-11-14.test.ts` (add LM10: `corrections.record` accepted 100 times in one hour in survival; no `max_per_hour`) | `learning_mandate` (`:57`) | **owner click** |
| H3e (optional) | `control-plane-shared/src/guard-paths.ts`: add the new invariant test `test/corrections-boundary-h3.test.ts` (§9) as a `learning_mandate` path | `evolution_guard` (`:35`) | **owner click** |
| Never | `consensus-rules.ts`, `consensus-exec.ts`, `consensus-vote.ts`, `autonomy-dial.ts`, `policy-engine/`, `access.ts`, `.github/workflows/*` | — | not touched |

The H3e changes go together as **one** `merge_owner_change`, so that the owner reviews the whole ingress once.

## 9. Risks

- **A back door to trading** through promoted notes: a live note changes a room prompt, then a stance, then the crowd, the Decision Engine and the EA.
  - Mitigation: only text kinds; shadow first with the existing Holm-adjusted gate and holdout; auto-retire; the switches `LEARNED_KNOWLEDGE_ENABLED` and `LEARNED_AUTO_PROMOTION`; no direct reputation-weight term (Q4).
  - A static test, `test/corrections-boundary-h3.test.ts`: no corrections module imports `consensusPropose`, `insertDraft`, policy parameters, the autonomy dial or an executor. `correction.v1` has no parameter key.
- **Owner bias or a small sample** swinging a record. Mitigation: shrinkage with prior 10, newest-per-target counting, both 7-day and 30-day windows, and context-only use.
- **Prices leaking to the platform or Aether.** Mitigation: masking on both sides, `refCarriesPrice`, and fixtures with price-bearing inputs in `invalid/` → masked output.
- **Secrets in text.** Mitigation: `redactText`, the audit flag, and no text in the audit chain.
- **Prompt injection through correction text.** Owner text is quoted as data wherever an agent reads it, like every other tool result (HAIC-H0-H1 §3.3). A Nexus-relayed text is external content.
- **Identity on the Nexus path.** The platform cannot verify it. Mitigation: `attested_by`, weight 3 only for owner identities, and the dedicated agent id. Only that agent can send.
- **Volume.** No cap, by mandate. The Observer's `learning_volume` and `learning_repeat` findings cover spikes (`learning-watch.ts`). Rows are small.
- **Contract drift** across three repositories. Mitigation: versioned schema, shared fixtures and dedup vectors tested on every side.
- **Double counting** outcome reputation and teaching record. Mitigation: they are separate fields with separate names, and neither is folded into the other.
- **Migration number collision** with an in-flight branch. Mitigation: take the next free number at rebase.
- **Documentation drift** (§2.6). Fixed in H3b's SSOT update.

## 10. Open questions for the owner

1. **Q1. Where the one correction ledger lives.**
   - Option A, recommended: the platform D1 `corrections`. Nexus sends through a new learning capability, and Aether pulls through a read capability. One audit chain, one teaching record, and calls go from the external organ to the platform as before.
   - Option B: Nexus writes to Aether directly, and the platform sees only aggregates.
2. **Q2. What "high weight" means.**
   - Recommended: an integer weight. Owner 3, H5 reviewer 2, and implicit or `owner_decision` 1.
   - It is used for ordering (first in the shadow queue; ranked above learned notes in retrieval, below KB v4) and as the multiplier in the teaching record.
   - It never skips a gate and never sets a live weight.
3. **Q3. Does a correction-derived note skip the shadow test?**
   - Recommended: no. It goes first in the queue (xauusd decision 9) and goes live only on the shadow verdict.
   - "The owner can promote one by hand" becomes an owner click in Cerebrum, per HAIC Q6, recorded and reversible. It is not a click in Nexus.
4. **Q4. May corrections change the xauusd crowd weight live?**
   - Recommended: no. The bounded owner-rating term (at most ±0.05 a week) runs as a shadow crowd arm in `tuning-replay.mjs`. It goes live only by a replay verdict plus an owner PR, because the weight feeds the quorum and hence trading.
   - On the platform, the teaching record is context only and gates nothing.
5. **Q5. Price and secret content in a correction's text.**
   - Recommended: never refused. Secrets are always redacted. Price-like numbers are masked as `[level]` in the platform and Aether copies, and the original stays in xauusd D1 only.
6. **Q6. Implicit signals.**
   - Recommended: only explicit free-text reject reasons become records (`owner_decision`, weight 1): typed-proposal reject reasons and knowledge-review reject reasons.
   - Picks, dismissals, approvals and confirmations do not count. They choose among options; they do not judge an agent's output.
7. **Q7. Changing a rating.**
   - Recommended: append-only. A new row carries `supersedes`, and the newest row per owner and target counts.
   - The Ask page's thumbs keep showing the newest rating.
8. **Q8. Backfill existing chat ratings.**
   - Recommended: yes, once. Read the `conversation.rated` audit events (turn and up or down only; no text exists there) into `corrections` with `source: chat_rating` and `body_json.backfilled: true`.
   - This is an additive insert by a one-off kernel job, not a migration, because D1 SQL cannot compute the hashes.
9. **Q9. Who may correct in H3.**
   - Recommended: owners only (`role.owner`), with weight 3.
   - H5 opens corrections to reviewers at weight 2.
   - A Nexus-attested actor who is not an owner is still recorded, at weight 1, never refused.
   - No corrections through Telegram.
10. **Q10. Semantic recall of corrections** (embedding them in Vectorize).
    - Recommended: not in H3. Deterministic ref and subject matching only.
    - An embedding would add a second learning AI call site, which LM6 forbids today, so it needs a guard-path test change and the owner's click. Revisit after a month of data.

**Owner answers (2026-11-19, "Setuju semua rekomendasi").** Every recommended default in this section is accepted. Migration numbers: the first of H3b and H5d to land takes 0084, the other the next free one. H3a (this contract) is `workers/control-plane-shared/src/correction.ts` with `docs/contracts/correction-v1/`.

## 11. Implementation order (small mergeable steps, each its own change request through Forge checks and consensus)

| # | Step | Repository | Tests | Merge | Rough effort |
|---|---|---|---|---|---|
| 1 | **H3a: the contract.** `control-plane-shared/src/correction.ts`: `validateCorrection`, `normalizeCorrection` (redact, mask, truncate, category fallback), `correctionDedupHash`, the forbidden-key check; `docs/contracts/correction-v1/` with valid and invalid fixtures and dedup vectors | platform | `correction-contract-h3a.test.ts`: every fixture as expected; the index lists every file; the vectors reproduce; secret → redacted, not refused; price → `[level]`; 501 characters → truncated; a `params` key → rejected | routine | 1–1.5 d |
| 2 | **H3b: the ledger and chat ratings.** Migration 0084; `ai-kernel/src/corrections.ts` (`recordCorrection`, `listCorrections`, audit); `POST/GET /v1/corrections`; `rateTurn` also records a correction (optional `note` in the rating body, at most 500 characters); the Ask page note field; allow-list rows; the Q8 backfill job; SSOT §"Human–AI collaboration" corrected (§2.6) | platform | Migration applies through `migration-rules.ts` and is additive (`test_migrations.py`); dedup (whitespace, key order) returns the same id, different content writes; up→down→up is three rows and the newest counts; owner-only (operator 403, viewer 403); audit has no text; 100 records in an hour in survival all written (mandate) | routine | 1.5–2 d |
| 3 | **H3c: council and proposal corrections.** `POST /v1/councils/{id}/corrections` (message seq, claim index or option id); reject reasons of typed proposals and knowledge reviews recorded as `owner_decision` (Q6); Councils and Proposals pages show a correction control | platform | A correction on a missing seq → 400; on an expired council → recorded (never refused); `corrections-boundary-h3.test.ts`: no corrections module imports a consensus, typed-proposal, policy-parameter, autonomy or executor writer | routine | 1.5–2 d |
| 4 | **H3d: knowledge and reputation reads.** The pure `teachingRecord()`; `GET /v1/reputation`; the Agents, AgentDetail and Ask displays; the chat tool `owner_corrections`; the council evidence section "Owner corrections" | platform | Shrinkage bounds (one down on a new subject → score ≥ 0.36); newest-per-target; "—" with no rows (`console-truthfulness.test.ts` still green); the chat cites `ev:platform/correction/<id>`; the council claim check is unchanged; no new `purpose: learning` call site (LM6 unchanged) | routine | 2 d |
| 5 | **H3e: the Nexus ingress and the Aether pull** (one owner change). `corrections.record` (tier 1, learning) and `corrections.read` (tier 0) in `capabilities.ts`; `LEARNING_CAPABILITIES`; `XAUUSD_CEILING` (`nexus-teacher`) and `AETHER_CEILING` (`aether-curator`); the `syscall.ts` dispatch; the next free migration number (0085 went to HAIC H5d) registering `nexus-teacher` (`INSERT OR IGNORE`); LM10 | platform | LM10: 100 `corrections.record` calls in one hour, in survival, all succeed and are metered; the kill switch still stops them (LM7 pattern); only `nexus-teacher` has it and `EXTERNAL_CEILING` is unchanged; a census gene with it on another xauusd agent is refused; `corrections.read` returns only `side = nexus`, cursor order, at most 50 | **owner click** | 1.5–2 d |
| 6 | **H3f: the Nexus side.** Correction controls on cards, room posts and readings, decisions and council turns; `POST /omega/api/correction`; a local table with the original; masking; the send over `AGENTS`; `cfc-pack` reads the seat's corrections; the teaching record shown beside reputation; shadow queue ordering by weight; the shadow crowd arm (Q4) | xauusd (its session) | The shared fixtures and vectors; no price leaves (the `cardLeaks` pattern); the Access and origin checks on the route; the queue puts weight 3 first; the live crowd weight unchanged (a replay test) | xauusd's own rules | 4–6 d |
| 7 | **H3g: the Aether side.** Cron pull of `corrections.read`; conversion into `caution` or `role_reminder` items labelled `owner_correction`, weight 3; pack fields; `correction_conversion.v1` acks | cryptophys-aether (its session) | The fixtures convert or give `not_convertible` with the expected reason; never `param_candidate`; touches `src/index.mjs` (Aether guard path) | Aether owner click | 2–3 d |
| 8 | **H3h: the ADR-0017 amendment and SSOT.** The owner's answers recorded as an amendment (like the H4 one); SSOT on all three sides; `docs/AETHER-INTEGRATION.md` and `docs/XAUUSD-INTEGRATION.md` limits corrected (§2.6) | all | `ssot-topology` and DNA tests on each side | routine on the platform | 0.5 d |

- **H3e's migration number (2026-11-19).** 0085 was first planned for H3e, but H3e waits for the owner's click with no date, and a number kept free cannot be held once a higher one is applied: the native deploy refuses a file that sorts below an applied one as `migration_out_of_order` (`native-deploy.ts` `migrationPlan`, `recovery-deploy.ts` `pendingMigrations`). So HAIC H5d took 0085 (`0085_collaborators.sql`), and H3e takes the next free number when it lands.
- **Total on the platform:** about 8–10 working days. On the other sides: about 6–9.
- **Order:** steps 1–4 need no guard path and give value on their own (chat and council corrections, the teaching record). Step 5 waits for the owner's click and gates steps 6 and 7.
- **Exit criteria:**
  - at least 20 real corrections recorded from at least two sources;
  - every record is audited and none was refused;
  - the dedup vectors pass on all three sides;
  - at least one Nexus correction has gone through Aether into the shadow queue with its verdict recorded;
  - a static test proves that no corrections path writes a parameter, a weight or a proposal;
  - the owner rates the teaching record useful on the Agents page.
