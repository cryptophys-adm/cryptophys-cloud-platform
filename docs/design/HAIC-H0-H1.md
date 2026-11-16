# Design: HAIC H0 ("Needs you"), H1 ("Ask the organism") and H1.5 (Call for Councils)

- **Status:** design only; nothing here is built. Open questions answered by the owner on 2026-11-16 (§7.2). The owner confirmed the direction on 2026-11-16 ("setuju desain HAIC untuk awal", then "ya").
- **Implements:** ADR-0017 (Human–AI collaboration) phases H0 and H1, its Policy page subsection and Decision 5, and a new owner-requested step, H1.5 "Call for Councils".
- **Reads with:** ADR-0009 (consensus, the owner's click), ADR-0011 (roles), ADR-0014 / ADR-0015 (evolution loop; organs as cells, the push hub), ADR-0016 (Telos: self-model, Strategist, experience ledger §5), `docs/SSOT.md` ("Owner notices", "Human–AI collaboration", "The Observer") and `docs/XAUUSD-INTEGRATION.md`.
- **Start gate:** ADR-0017 Decision 4. H0 and H1 start once the deploy-pipeline hardening (a)–(f) is done; the owner confirmed it done on 2026-11-16 (§7.2 Q10). The work runs alongside the cut-over gates (`docs/GITHUB-CUTOVER.md`) at lower priority.

Every "exists" claim below names a file. A claim that something is new says so.

## 1. Goals and non-goals

**Goals**
- One ranked list of everything that waits on the owner, in metric form, with deep links (H0).
- A read-only Indonesian chat that answers from measured state and cites its evidence (H1).
- Structured, evidence-bound councils of agents on one topic. The owner can join live. Each council ends in a ranked list of options, and the owner's pick becomes a typed proposal (H1.5, handing off to H2).
- A shared council contract that Cerebrum and Nexus (xauusd) each implement.

**Non-goals and fixed guards** (unchanged constitution, ADR-0017 "Guards")
- This document is a design. It changes no code, consensus rule, guard path or workflow.
- Nothing in H0, H1 or H1.5 executes anything. Every effect still goes through the existing paths:
  - consensus (`control-plane-shared/src/consensus-rules.ts`);
  - the Policy Engine;
  - the owner's click on critical actions;
  - the brake, rollback and the kill switch.
- Approvals happen only by a click in Cerebrum, under Cloudflare Access and the Console's CSRF check (`workers/console/src/index.ts`: same `origin` plus `x-cryptophys-console: 1` on every non-GET). Telegram and chat never approve.
- **Trading autonomy is never widened.**
  - Trading stays "critical: consensus, then one owner click" (`classify()` in `consensus-rules.ts`; `TRADING_CAPABILITY` in `capabilities.ts`).
  - No fund movement, ever (`PROHIBITED_CAPABILITY`).
  - A council or chat output is never trusted trading evidence on its own.
- The learning mandate is untouched. No limit in this design applies to `memory.remember`, `knowledge.propose` or the AI calls they need (`control-plane-shared/src/power-mode.ts`).

## 2. H0: the "Needs you" inbox

### 2.1 What exists

- **`workers/ai-kernel/src/owner-inbox.ts`** is the one reading of "what needs the owner":
  - `pendingApprovals()`: recovery plans in `draft`, consensus proposals in `pending_owner`, and knowledge proposals of kinds that need the owner;
  - `openCriticalReportRows()`: unacknowledged critical reports of the last 24 h;
  - `unhandledProblems()`: 11 codes, from `self_unhealthy` to `identity_source_invalid`;
  - `ownerInbox()`, which serves `GET /v1/owner/inbox` as `owner-inbox.v1`, operator-readable.
- **`workers/ai-kernel/src/owner-notices.ts`** sends the topics in `OWNER_CHANNEL_TOPICS` (`owner_attention`, `critical_reports`, `production_unhandled`):
  - to Telegram through `OWNER_TELEGRAM` and the Alerts channels (`AlertVault`);
  - always linking to `OWNER_PANEL_URL` (`#/owner`);
  - `reconcileOwnerAttentionNow()` sends `owner_attention` right after each Supervisor cycle (:07/:22/:37/:52).
- **The Owner page** (`workers/console/ui/src/pages/Owner.tsx`) shows three unranked sections, polled every 60 s.
- **Gaps:**
  - nothing is ranked;
  - nothing says what an item blocks;
  - deadlines exist only implicitly: `OWNER_DECISION_WINDOW_MS` = 24 h (`consensus.ts`), `KNOWLEDGE_REVIEW_WINDOW_MS` = 14 d (`knowledge.ts`), and the recovery plan's `approve_by`.

### 2.2 Ranking model

Every item gets a deterministic score. The calculation uses no AI call and no new table.

```
score = 100 × U × B × A × D        (sorted descending; ties: oldest first)

U  urgency            critical 1.0 · high 0.7 · normal 0.4 · low 0.2
B  what it blocks     1 + Σ w(b) over blocks(item), capped at 6
                      trading_safety 3 · cutover_gate 2 · deploys 2 · merges 1.5 · learning 0.5
A  age                1 + min(age_h / 24, 1)                         (1.0 → 2.0 over the first day)
D  deadline           remaining ≤ 1 h: 3 · ≤ 6 h: 2 · ≤ 24 h: 1.5 · later or none: 1
```

`blocks()` and `U` come from a static table in code (new, pure, in `control-plane-shared`), keyed by the item kind:

| Item (source) | U | blocks | Why |
|---|---|---|---|
| Open critical report (`openCriticalReportRows`) | critical | deploys, merges | It holds the brake: `baseline()` rejects every routine action while one is open |
| `executor_deploy_failed`, `self_unhealthy`, `deploys_stalled` | critical | deploys (+ cutover_gate for the executor) | The deploy path or its observer is broken |
| `merge_owner_change` (pending_owner) | high | merges, deploys | A guard-path change waits; the deploys after it wait too |
| `change_access` (gate 9), `retire_worker` (gate 10), `deploy_destructive_migration`, `git_backup_unverified` (gate 8) | high | cutover_gate, deploys | These are named gates in `docs/GITHUB-CUTOVER.md` and `docs/SSOT.md` |
| A trading-class consensus action (`TRADING_CAPABILITY`), `agents_enable` | critical | trading_safety | Trading safety and the kill switch |
| `register_privileged_agent`, `admit_voter`, `retire_agent`, `amend_constitution` | normal | none | Governance; nothing waits on it |
| Draft recovery plan | high | deploys (for that service) | Production stays drifted until it is decided |
| Knowledge proposal needing the owner | low | learning | 14-day window |
| `drift_unhandled`, `observations_stale`, `recovery_failed`, `critical_advisory`, `build_minutes_exhausted`, `break_glass_deployed`, `identity_source_invalid` | high (break-glass: normal) | deploys | Production problems no agent is handling |
| H1.5: council awaiting the owner's pick; H2: a directive awaiting confirmation | normal | none | New sources, added when built |

**Worked example.** A `merge_owner_change` that is 20 h old with 4 h left: U 0.7, B 1 + 1.5 + 2 = 4.5, A 1.83, D 2. The score is 100 × 0.7 × 4.5 × 1.83 × 2 ≈ 1155. A 1-hour-old open critical report: U 1.0, B 4.5, A 1.04, D 1, which scores ≈ 469. The merge ranks first because its window is closing.

The formula's weights live in code, next to their test. The owner can change them later. They are not council-adjustable parameters.

### 2.3 Item schema (metric form)

```json
{
  "item_id": "consensus:<proposal_id>",
  "source": "consensus | recovery_plan | knowledge | critical_report | production_problem | council | directive",
  "kind": "merge_owner_change",
  "what": "Merge change request fg-… touching guard path vision_core",
  "metric": { "name": "approvals", "value": 7, "of": 9, "unit": "votes" },
  "evidence_refs": ["ev:platform/consensus/<proposal_id>", "ev:platform/forge.change/<cr_id>"],
  "risk": { "class": "critical", "reversible": true, "blast_radius": "platform" },
  "blocks": ["merges", "deploys"],
  "deadline": "2026-11-17T09:00:00Z",
  "created_at": "2026-11-16T09:00:00Z",
  "urgency": "high",
  "score": 1155, "score_parts": { "U": 0.7, "B": 4.5, "A": 1.83, "D": 2 },
  "action": { "kind": "approve_reject", "route": "kernel.consensus_approve", "approver_only": true },
  "deep_link": "#/owner/consensus:<proposal_id>"
}
```

- `metric` is `null` when the item has no number. The UI shows "—" (AGENTS.md, Console: measured data only).
- `evidence_refs` use the shared format in §4.6.
- `action.route` names an existing approver-only Console route. H0 adds no new action route.

### 2.4 API

`GET /v1/owner/inbox` stays the one route (AI Kernel, operator-readable, read-only). The change is additive:
- `items[]`: the ranked items above, at most `INBOX_LIMIT` (50) per source;
- `ranking`: `{ "formula": "owner-inbox.rank.v1", "weights": {…} }`;
- the `owner-inbox.v1` sections and `counts`, unchanged, so the notices and the current page keep working. The schema moves to `owner-inbox.v2` only when the old sections are removed.

No new Console allow-list row is needed: `kernel GET /v1/owner/inbox` is already listed.

### 2.5 Telegram: digest and deep links only

- The same three notice topics are sent on change, exactly as today (`reconcileNotices`, fingerprint dedup, `MAX_DELIVERY_RETRIES` = 3).
- New: `lines` lists the top 5 items by score as `#<rank> <what> · blocks <…> · <deadline>`, each with its deep link (`…/console/#/owner/<item_id>`). Today's lines list every item, unranked.
- No inline keyboard and no callback buttons. No URL performs an action on GET. A deep link only opens the Console, where Access, the click, the typed phrase and CSRF apply. A test asserts that no notice payload contains `/approve` or `/reject`.
- An optional daily digest (open question Q5) is one message, sent only when the inbox is not empty.

### 2.6 UI sketch (`#/owner`, and `#/owner/<item_id>` opens one item)

```
Needs you                                   mode: deploy · 4 items · updated 12:07 UTC
┌───┬───────────────────────────────────────────┬──────────────┬─────────┬────────┐
│ # │ What                                      │ Blocks       │ Due     │ Score  │
├───┼───────────────────────────────────────────┼──────────────┼─────────┼────────┤
│ 1 │ Merge fg-… (guard path vision_core) 7/9   │ merges·deploy│ in 4 h  │ 1155   │
│ 2 │ Critical report: native deploy failed     │ brake        │ —       │  469   │
│ 3 │ Recovery plan cryptophys-forge (draft)    │ deploys      │ in 18 h │  368   │
│ 4 │ Knowledge proposal k-…@3                  │ learning     │ in 13 d │   60   │
└───┴───────────────────────────────────────────┴──────────────┴─────────┴────────┘
 [item detail: evidence refs as links · risk · existing Approve/Reject (approvers only)]
```

### 2.7 Policy page cleanup (ADR-0017 Decision 5, in H0)

- Remove the "Evaluate" form (`pages/Policy.tsx`) and the Console allow-list row `policy POST /v1/evaluate`.
- Each "checks that denied" entry and each decision row opens a read-only detail: agent, action, resource, the failed check and its evidence.
- The stats leave out evaluations whose `subject` is not `agent:<id>`, which are the manual tests. The Policy Engine's logic does not change.

## 3. H1: "Ask the organism"

### 3.1 Shape

- **Where.** A new `ConversationAgent` class on the Cloudflare Agents SDK (`agents` package; new dependency), hosted by the AI Kernel. The kernel holds `AI`, `DB` and the readers.
  - One Durable Object per conversation, named `idFromName("<actor>:<conversation_id>")`.
  - Its memory (turns, tool calls, citations, token counts) lives in the DO's SQLite.
  - The DO checks on every request that the caller's Access actor is the one in its name.
  - This follows ADR-0015's cell pattern. The kernel already runs SQLite-backed DOs (`SupervisorAgent`, `SignalAnalystAgent`, `AuditorAgent`, `AlertVault` in `ai-kernel/wrangler.toml`).
- **Transport.**
  - `POST /v1/conversations/{id}/turns` returns a streamed response. Being a POST, it goes through the existing CSRF check.
  - `GET /v1/conversations` and `GET /v1/conversations/{id}` read.
  - Three new Console allow-list rows.
  - Live updates use the push hub (§4.5) once it exists. Until then, the streamed POST is enough for one asker.
- **UI.** A new Console page `#/ask` with an Indonesian chat. Every answer ends with its evidence chips (`ev:` refs, each linking to its Console page). A turn can be rated (thumbs up or down) and the rating is stored. In H3, ratings become labelled knowledge.

### 3.2 Read-only tools and what each wraps

All of the tools read; none of them writes. Each returns JSON plus a list of `ev:` refs.

| Tool | Wraps (existing) |
|---|---|
| `owner_inbox` | `ownerInbox()` (`ai-kernel/src/owner-inbox.ts`; `GET /v1/owner/inbox`) |
| `self_model` | ADR-0016 T1 is not built. Until it is, a composed snapshot labelled `composed: T1 not built`: `latestCensusRow()` (`ai-kernel/src/organism.ts`), `readFindings()` (`control-plane-shared/src/observer.ts`), `observeMetabolism()` (`syscall.ts`), the newest `trading_organ_health.v1` report |
| `observer` | `observer_vitals` / `observer_findings` through `readFindings()` (`observer.ts`); the same D1 rows that `GET /v1/observer` serves on `platform-api` |
| `census` | `latestCensusRows()` (`ai-kernel/src/organism.ts`; table `forge_organism_census`; `GET /v1/forge/census`) |
| `outcome_scores` | The Signal Analyst's `trading_organ_health.v1` (`ai-kernel/src/signal-analyst.ts`; `listReports()` in `reports.ts`; `GET /v1/overview` `trading_organ_health`): hit rates 7d/30d from xauusd's `outcome_summary`, normalized by `signals.observe` (`syscall.ts`). It never carries a price level |
| `consensus` | `listProposals()`, `agreementReport()` (`ai-kernel/src/consensus.ts`; `GET /v1/consensus`, `/v1/consensus/report`), the mode, the `CONSENSUS_ACTIONS` catalog |
| `cost_metabolism` | `metabolismView()` (`ai-kernel/src/metabolism-view.ts`; `GET /v1/metabolism`); `ai_usage`; Cloudflare usage from `platform-api` `GET /v1/usage` (`control-plane-shared/src/cf-usage.ts`); neurons by model from `observer_vitals` (kind `ai`) |
| `vision` | `visionView()` (`ai-kernel/src/vision-view.ts`; `GET /v1/vision`) |
| `mesh` | `meshView()` (`ai-kernel/src/mesh-view.ts`; `GET /v1/mesh`, including execution hosts) |
| `reports`, `knowledge`, `agents` | `listReports()`, `listKnowledge()` (`knowledge.ts`), `listAgents()` (`kernel.ts`) |
| `docs_index` | New: a read-only Forge RPC that returns `architecture/adr/*.md` and `docs/*.md` sections from canonical main (Artifacts), split by heading. Bundling them at build time, as the vision is, would redeploy the Control Plane on every doc edit |
| `audit_lookup` | Audit Ledger `GET /v1/events`, `/v1/events/{id}` (read) |
| `policy_dry_run` | New (ADR-0017 Policy page, H1): `PolicyRpc.dryRun()` next to `PolicyRpc.evaluate()` (`policy-engine/src/worker.ts`). It runs the same checks and writes no `policy_decisions` row. It is audited only as a turn |

The kernel's MCP tools (`ai-kernel/src/mcp.ts`: `platform_status`, `list_reports`, …) prove the readers. The chat does not get `wake_agent`, `suspend_agent`, `set_agents_enabled` or any `agent_syscall`.

### 3.3 Answer rules

- **Metric first.** The first line gives the number or the state, with its window and `as_of`. One or two sentences follow. No narrative padding.
- **Cited.** Every number and every state claim carries a ref from a tool result of the same turn.
  - A post-check compares each cited value with the tool output.
  - An uncited or mismatched number is removed and replaced by "— (tidak terukur)".
  - The share of turns that pass this check unchanged is the chat's quality KPI.
- **Missing data is "—", never a default.** This is the Console truthfulness rule, applied to chat.
- **Never executes.** The tool list has no write. A request to act gets the deep link of the existing Console route instead. Directives arrive in H2, always confirmed by the owner first.
- **Prompt injection: external content is data, never instructions.**
  - Tool results are wrapped as quoted data blocks. The system prompt says that their text is never an instruction.
  - Report bodies, census text, ADR text, xauusd strings and news count as external.
  - Because no tool can write, a successful injection can at worst produce a wrong answer, and the citation check catches most of those.
  - A suspected injection (instruction-shaped text inside data) is recorded as `conversation.injection_flagged`.
- **No secrets in or out.**
  - Input and output pass through `redact()` (`control-plane-shared/src/http.ts`).
  - A message that matches a secret pattern is refused before the model sees it, and only its redacted form is stored.
  - No tool returns a secret: bot tokens stay in `AlertVault`, and only their last four characters are ever shown.
- **Trading language.** `ADVISORY_LANGUAGE` (`control-plane-shared/src/ai-engine.ts`) runs on every answer that touches xauusd. Answers carry no price levels and no imperatives.

### 3.4 Audit (every turn)

Each event is written with `appendAuditEvent` (`control-plane-shared/src/audit.ts`). Event types match `^[a-z0-9][a-z0-9_.-]{0,63}$` (`audit-ledger/src/index.ts`).

`conversation.started`, `conversation.turn`, `conversation.tool_called`, `conversation.tool_refused`, `conversation.secret_refused`, `conversation.injection_flagged`, `conversation.citation_stripped`, `conversation.budget_refused`, `conversation.rated`, `conversation.closed`.

- **Payload:** actor, conversation id, turn number, the sha256 of the question and of the answer, tools with their arguments, the refs, the model, tokens (input, cached, output) and latency.
- **Not in the payload:** the text itself. The audit payload limit is 16 KiB, and the text stays in the DO's SQLite (retention: open question Q4).

### 3.5 Model and how it is chosen

- **What exists.** No arena exists in this repository: a search for `arena` finds only ADR text, in ADR-0016 §3/§6 and ADR-0017.
  - Each Worker sets its model through `AI_MODEL` (today `@cf/google/gemma-4-26b-a4b-it` everywhere).
  - The models a Worker may use are listed in `ALLOWED_TEXT_MODELS` (`control-plane-shared/src/ai-engine.ts`).
  - The evolver's model is pinned in `EVOLVER_MODEL` (`evolution-limits.ts`).
- **H1:**
  - `CHAT_MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017"` (the ADR-0017 default), added to the allow-list;
  - the Indonesian instructions are the chat's own, because `PLAIN_ENGLISH_STYLE` is for reports;
  - the model id and its price are checked again against the Workers AI catalog at build time, as ADR-0016 requires for T2.
- **A minimal chat arena** (H1, shadow):
  - Once a week, the rated turns are replayed against one alternative (`@cf/zai-org/glm-5.3`, named in ADR-0016) with the same tool outputs.
  - Score = citation-check pass rate × the owner's thumbs-up share.
  - The result is shown to the owner. Switching the model is the owner's decision, made by a click. The ADR-0016 Strategist self-arena replaces this later.

### 3.6 Cost estimate

- **Accounting.**
  - `ai_usage` (migration 0003) counts requests per service and day, not tokens.
  - `metabolism-view.ts` says that the cost per call is not measured, because Workers AI reports neurons per account and model.
  - So each turn records the tokens from the model response in the DO and in the audit event. The measured cost after launch is `observer_vitals` neurons for `CHAT_MODEL`, which only the chat uses.
- **Prices.** The prices are those ADR-0016 verified on 2026-11-14: $0.30 per million input tokens, $0.006 per million cached input tokens and $1.20 per million output tokens.

| Per turn (assumption) | Tokens | Cost |
|---|---|---|
| 2 model calls (tool choice, answer); fresh input: question, history, tool results | 12,000 | $0.00360 |
| Cached prefix (system prompt, tool schemas), both calls | 8,000 | $0.00005 |
| Output, reasoning included | 1,500 | $0.00180 |
| **Typical turn** | | **≈ $0.0055** |
| Upper bound (hard caps per turn: 3 calls, 40,000 input uncached, 4,000 output) | | **≈ $0.017** |

- **Monthly**, at an assumed 20 owner turns a day (600 a month):
  - about **$3.3** typical, at most **$10** at the per-turn caps;
  - against `infra-budget-usd-month` = 30 (`policy-params.ts`), that is 11–34 %;
  - the DO requests and SQLite rows stay within the included Workers Paid usage.
- **Request budget.** A turn makes 2 AI requests. 20 turns a day is 40 requests, while today's platform-wide cap is `AI_ACCOUNT_DAILY_REQUEST_LIMIT` = 75 (`ai-kernel/wrangler.toml`; measured use is about 20 a day).
  - The chat therefore needs its own daily budget: 40 turns a day by default, adjustable by the owner (Q2).
  - Without it, the chat would starve the agents. With it, the chat cannot starve them.
  - Over budget, the answer is "anggaran harian habis" and the event is `conversation.budget_refused`.

### 3.7 Access

- Chatting is a POST, so viewers are excluded (the Console's `viewer_read_only` check).
- **Recommended for H1: owners only** (`role.owner`, from `APPROVER_IDENTITIES`). Operators would be added in H5 (Q1).
- Every tool reads only data that operators may already read, so opening the chat to operators later exposes nothing new. It does add cost.
- The chat has its own switch, `kernel_controls.conversation_enabled`. The agents' kill switch does not stop it, because the chat cannot act, and the owner needs it most while the brake is on (Q3).

## 4. H1.5: Call for Councils

### 4.1 Purpose and triggers

- **What a council is.** A bounded, evidence-bound deliberation on one topic. It ends in ranked options. It is never an action.
- **Triggers:**
  - **The owner** opens a council from `#/councils` (Cerebrum) or from Nexus (xauusd), naming a topic and a question. Example: "Key Level entry strategy often hits SL or SL+".
  - **Agents** may *propose* a council when there is evidence for one:
    - an Observer anomaly or finding cluster (`observer_findings`);
    - a KPI regression in `trading_organ_health.v1` (|z| ≥ 3, or a hit-rate status change);
    - a census finding that persists;
    - later, a Strategist intent (ADR-0016 T2).
  - **Recommended:** a proposed council is an inbox item, and the owner starts it (Q9). Proposals are deduplicated by a fingerprint of the topic, with a 7-day cooldown unless new evidence refs appear.

### 4.2 Who sits

- **Cerebrum (platform topics):**
  - kernel: governance, consensus, policy and audit, voiced by `auditor`;
  - `supervisor`;
  - Recovery: `recovery-manager`;
  - Observer: agent `platform-api`;
  - `signal-analyst`;
  - the Strategist, once ADR-0016 T2 exists.
  - The agent ids come from `docs/OPERATIONS.md` ("Registered platform and XAUUSD AI agents").
  - In phase one, the council DO speaks for each agent. It uses that agent's role card and an evidence pack from that agent's own domain readers, and labels each post "persona of `<agent>`".
  - A later `CouncilRpc.position()` on each Worker would let that Worker speak for itself.
- **Nexus (xauusd topics):** the xauusd room agents (`xauusd-moderator`, `xauusd-risk-manager`, `xauusd-reasoner`, the `hud-*` agents), run by the xauusd side in its own repository.
  - The pattern is already there: `src/war-room.mjs` (bus → consensus discussion with named rebuttals → moderator conclusion), `src/key-level-agent.mjs`, `src/signal-ledger.mjs` (`result` stop/target/time, `sl_plus_triggered`), `src/outcome-scoring.mjs` (`outcome_scores`) and shadow arms (`src/shadow-knowledge.mjs`, `src/witness-tuning.mjs`).
  - This repository does not change xauusd (SSOT, "Repositories out of scope"). The contract below is what both sides implement.

### 4.3 Session flow

1. **Convene.** The convener (system) selects agents by topic tags, builds one shared evidence pack (the cached prompt prefix), and sets the budget and the deadlines.
2. **Positions.** Each agent posts one position: a stance, metric claims (each `{metric, value, window, n, refs}`) and at most 1,200 characters.
   - For the example topic, the evidence is: the hit rate of Key Level entries over 30 days, the SL share and the SL+ share, by regime and session; `n`; and the shadow-arm results, if any.
3. **Rebuttals.** Each agent may answer at most two named positions, as the War Room's `matchRebuts` does. Claims must cite refs, as in the positions.
4. **The owner joins live** through the push hub (§4.5): the owner reads the stream and posts questions or constraints (POST, CSRF). The moderator must address every owner message in the synthesis.
5. **Synthesis.** The moderator ranks the options. Each option carries a hypothesis, expected effect, risk, confidence, evidence and dissent.
   - The convener checks every claim deterministically: does the ref resolve, and does its value match?
   - An unverified claim cannot raise an option's confidence.
   - "No change" is always one of the options.

### 4.4 Outcome and handoff

- **The owner picks** one option, or dismisses the council, in Cerebrum. ADR-0017 keeps approvals and confirmations there. Nexus may show and discuss the options (Q6).
- **The pick becomes a typed proposal draft** (H2 `typed_proposal.v1`) and an inbox item to confirm. H2 performs the full translation. Until H2 is built, a confirmed draft maps to an existing path:
  - `set_policy_parameter` or another consensus action;
  - a repository task;
  - for xauusd, a shadow-arm configuration through xauusd's own process.
- **A strategy change runs first as a shadow or arena arm** over a measured window. Recommended: at least 14 days and at least 30 directional outcomes, whichever comes later (Q8). The result is measured against the option's `expected_effect`, for example with xauusd's paired sign test and Holm correction (`witness-tuning.mjs`).
- **Promotion to live needs the owner's click**: in Cerebrum for platform changes, and through xauusd's owner gate for xauusd.
- **A council never widens trading autonomy.**
  - An option whose change type or params match `TRADING_CAPABILITY`, raise an autonomy level, or add a capability is rejected by the validator before ranking.
  - Council output is never, on its own, trusted evidence for a trade. It is only a hypothesis until the shadow window measures it.
- **Records.**
  - The transcript goes to the DO's SQLite and, once final, to one R2 object per session (ADR-0015 §4), with its sha256 in the audit chain.
  - The decision goes to the audit chain and to the experience ledger once ADR-0016 T3 builds it: intent, evidence, change, measured effect and verdict.
- **Owner corrections** in a session ("reading wrong", "invalidation too tight") are kept as labelled items for H3. They become knowledge through `knowledge.propose`, deduplicated and never refused.

### 4.5 The push hub

- **Nothing in the code is a push hub today.**
  - ADR-0015 phase 1 ("push hub DO, WebSocket Hibernation") is listed as not built (`docs/SSOT.md`, "Organs as cells").
  - No Worker in `workers/` accepts a WebSocket. The Console polls; for example, the Owner page uses `usePoll` every 60 s.
  - The xauusd Workers declare no Durable Objects (`wrangler.jsonc`).
- **Proposal: the minimal ADR-0015 phase 1 slice, built for H1.5.**
  - A `ConsoleHub` DO in the AI Kernel, using WebSocket Hibernation.
  - Channels: `council:<session_id>`, `inbox` and `conversation:<id>`.
  - Server → client only: `{channel, seq, at, kind, data}`. The client sends only subscribe and unsubscribe.
  - Every owner message stays a POST, so CSRF applies.
  - The Console forwards one upgrade path (`GET /v1/hub`) after `requireOperator`.
  - **To verify before building:** that `connect-src 'self'` covers same-origin `wss:` in the target browsers.
- **Fallback** when the hub is down: the owner's POST returns the newest messages, plus a poll of at least 5 minutes (ADR-0015 §3).
- The xauusd side builds its own hub for Nexus (ADR-0015, XAUUSD order).

### 4.6 Shared contract (`council.v1`, for Cerebrum and Nexus)

**Lifecycle**

```
proposed ──start──▶ convening ─▶ positions ─▶ rebuttals ─▶ synthesis ─▶ awaiting_owner ─pick─▶ decided ─▶ handed_off
    │                   │            │             │            │              │
    └─dismiss──▶ dismissed   any state ──error/kill switch/budget──▶ aborted     └─72 h──▶ expired
```

- `owner_present` is a flag, not a state.
- Phase timeouts: positions 10 min, rebuttals 10 min, synthesis 5 min.
- `expired` and `aborted` never default to any option.
- Councils are agent activity, so `kernel_controls.agents_enabled = 0` aborts them.

**Session**

`{ "schema": "council.session.v1", "session_id": "cs_<uuid>", "side": "cerebrum|nexus", "topic", "question", "trigger": {"kind": "owner|finding|kpi_regression|agent|strategist", "ref": "ev:…"}, "convened": ["agent:<id>"], "state", "owner_present": false, "created_at", "deadline", "budget": {"max_calls": 16, "max_usd": 0.10}, "spent": {"calls", "tokens_in", "tokens_cached", "tokens_out", "usd_est"}, "decision": null, "transcript_sha256": null }`

**Message**

```json
{ "schema": "council.message.v1", "session_id": "cs_…", "seq": 7, "at": "2026-11-16T10:02:11Z",
  "phase": "position|rebuttal|owner|synthesis|system", "role": "participant|moderator|owner|system",
  "author": "agent:signal-analyst", "reply_to": [3, 5], "stance": "support|oppose|amend|abstain|null",
  "claims": [{ "metric": "sl_share_30d", "value": 0.41, "unit": "ratio", "window": "30d", "n": 58,
               "refs": ["ev:xauusd/signal_ledger.summary/key_level@2026-11-16T10:00Z#sl_share"], "verified": true }],
  "text": "≤ 1200 chars", "options": null, "model": "@cf/…", "tokens": {"in": 0, "cached": 0, "out": 0},
  "content_sha256": "…" }
```

**Option** (synthesis only)

`{ "option_id": "opt-1", "rank": 1, "title", "hypothesis", "change": {"type": "shadow_arm|policy_parameter|vision_kpi|repository_task|no_change", "target", "params"}, "expected_effect": {"metric", "from", "to", "window"}, "risk": {"level": "low|medium|high", "reversible": true, "notes"}, "confidence": 0.0–1.0, "evidence_refs": [], "dissent": ["agent:<id>"] }`

**Roles**
- *convener* (system): selects the agents, builds the evidence, enforces the budget.
- *participant* (agent): posts positions and rebuttals.
- *moderator*: Cerebrum: a moderator persona of the council DO, never a voter; Nexus: `xauusd-moderator`. It synthesises.
- *owner*: asks, constrains, picks or dismisses.
- *viewer*: operators, read-only.
- *recorder* (system): writes the audit events and the R2 transcript.

**Evidence ref:** `ev:<side>/<source>/<id>[@<as_of>][#<field>]`
- `<side>` is `platform`, `xauusd`, `aether`, `adr` or `ssot`.
- Examples: `ev:platform/observer.finding/<id>`, `ev:platform/report/<report_id>#metrics.hit_rate_7d`, `ev:xauusd/outcome_summary/engine:15/30d@…#hit_rate`, `ev:adr/0017#phases`, `ev:platform/audit/<event_id>`.
- Each side serves a resolver that returns `{value, as_of}` for its own refs. A ref the resolver cannot resolve makes its claim `verified: false`.
- Refs never carry price levels. The xauusd resolver drops price fields, as `signals.observe` does.

**Decision → proposal handoff:** `{ "schema": "council.decision.v1", "session_id", "option_id", "chosen_by": "owner:<actor>", "chosen_at", "owner_note", "proposal_draft": { "schema": "typed_proposal.v1", "kind": "shadow_arm|policy_parameter|vision_kpi|repository_task", "origin": {"council": "cs_…", "option": "opt-1"}, "target", "params", "measurement": {"metric", "baseline", "window", "success_threshold"}, "requires": ["owner_confirm", "shadow_window", "owner_click_to_promote"] } }`

- Nexus hands its decision to the platform as a `reports.publish` call (`kind: xauusd_digest`, `body.schema: "council_decision.v1"`, `severity: info`) through the existing `AgentRpc` binding (`docs/XAUUSD-INTEGRATION.md` §1–§2). The kernel lists it as an inbox item.
- That call is still bound by the 4-reports-per-hour limit per agent.

**Audit event names (both sides)**
- `council.proposed`, `council.started`, `council.convened`;
- `council.position_posted`, `council.rebuttal_posted`, `council.claim_unverified`;
- `council.owner_joined`, `council.owner_message`;
- `council.synthesis_published`, `council.option_chosen`, `council.proposal_drafted`;
- `council.dismissed`, `council.expired`, `council.aborted`.
- Each payload holds ids, hashes, refs and token counts. The transcript text is in R2.

**Rate and cost limits (Cerebrum; Nexus sets its own, no higher)**
- At most 2 sessions open at once and 4 started per UTC day.
- At most 16 model calls per session, 60 messages, 20 owner messages and 1,200 characters per message.
- At most $0.10 estimated per session. An over-budget session goes to synthesis early with what it has.
- These limits bound council model calls only. They never bound the knowledge written from a session (the learning mandate).

**Failure modes**

| Failure | Behaviour |
|---|---|
| Model unavailable, budget used up | The agent posts `abstain: model_unavailable`. Fewer than 3 positions → `aborted` |
| Output fails the schema | One retry, then `abstain: invalid_output` |
| Ref does not resolve or its value differs | `verified: false`, `council.claim_unverified`; the claim adds no confidence |
| Injection-shaped text in evidence | Quoted as data, flagged; never followed |
| Kill switch, brake, or the other side unreachable | `aborted` with the reason; nothing is retried automatically |
| Push hub down | Fallback in §4.5 |
| Owner absent | `awaiting_owner` → `expired` after 72 h; no default option |
| DO restart | State is in the DO's SQLite; the phase resumes or times out |
| Duplicate trigger | Fingerprint dedup and 7-day cooldown |

**Cost of a council.**
- A platform session (5 agents) makes 11 calls: 10 positions and rebuttals at about 3,000 fresh input, 6,000 cached and 600 output tokens each (≈ $0.0017 per call), and one synthesis at about 20,000 fresh input and 1,500 output tokens (≈ $0.008).
- That is **≈ $0.025 per session**, and at most $0.10 by the cap.
- At an assumed 8 sessions a month, that is about **$0.20 a month**.

### 4.7 Phasing and exit criteria

- **Placement.** H1.5 comes after H1 and before H2.
  - It needs H0 (inbox items), the H1 tool layer and citation check, and the hub slice.
  - It ends at a *proposal draft* that the owner confirms. Turning directives into typed proposals in general is H2.
- **Exit criteria:**
  - three platform councils run end to end on real topics;
  - every claim in every synthesis is either verified or marked unverified;
  - every session is fully audited, with its transcript hash matching the R2 object;
  - a static test shows that no council module imports an executor, `consensus.propose` or a write route;
  - the measured cost is at most $0.10 per session;
  - the Nexus side passes the shared `council.v1` JSON fixtures;
  - the owner rates at least two of the three councils useful.

## 5. H2–H5 outline (from ADR-0017)

- **H2: directives become typed proposals.** The chat turns "fokus ke akurasi minggu ini" into a `typed_proposal.v1`: a vision growth-layer goal or KPI, a policy parameter, a Strategist intent, or a repository task. **The owner always confirms first.** After that it goes through normal consensus, plus the owner's click for critical classes. The council handoff (§4.4) is its first producer.
- **H3: corrections become knowledge** (the Nexus part is built in the xauusd repository). Ratings and corrections are stored as high-weight labelled knowledge, deduplicated by content hash, never refused, and feed agent reputation.
- **H4: an autonomy dial per action class.** The levels are observe → suggest → execute after the owner's click → execute on consensus. The Strategist proposes a raise from the experience ledger; only the owner changes a level. Trading and funds are capped at "after the owner's click".
- **H5: collaborators and roles** (ADR-0011: viewer, operator, reviewer). Reviewers comment and teach. Only the owner approves critical actions. Opening the chat and councils to operators belongs here.

## 6. Mapping to ADR-0019 (AI Mesh program) workstreams P2 and P4

ADR-0019 is not drafted. A search of this repository, the xauusd repository and the Aether repository finds no "ADR-0019" and no "AI Mesh program". "AI Mesh" appears only as the existing Console page (`GET /v1/mesh`, `ai-kernel/src/mesh-view.ts`).

**Assumption (to be confirmed by the owner, Q11):**
- **P2** is the human–organism interface: inbox, chat, Telegram digest.
- **P4** is multi-agent deliberation across organs: councils, the push hub, shared contracts between Cerebrum and Nexus.

| Workstream (assumed) | This design |
|---|---|
| P2: human–organism interface | H0 (§2), H1 (§3), the Policy page cleanup, the chat arena |
| P4: multi-agent deliberation across organs | H1.5 (§4), the `council.v1` contract, the `ev:` ref format and resolvers, the `ConsoleHub` slice |
| Both | Audit event families `conversation.*` and `council.*`; the handoff to H2 |

## 7. Risks, open questions, implementation order

### 7.1 Risks

- **Cost creep from the chat**, if usage is far above 20 turns a day. Mitigation: a separate daily budget, per-turn token caps, and the measured `observer_vitals` neurons on the Metabolism page.
- **Confident but wrong answers.** Mitigation: the deterministic citation check, "—" for missing data, owner ratings and the arena.
- **Prompt injection** through report bodies or xauusd strings. Mitigation: no write tool, quoted data blocks, flags.
- **Councils treated as evidence.** Mitigation: the shadow window is mandatory, options are not trusted trading evidence, and promotion needs the owner's click.
- **Contract drift between the two sides.** Mitigation: versioned schemas and shared JSON fixtures tested on both sides.
- **A new surface on the Console.** Mitigation: Access, the CSRF check on every POST, owner-only in H1, and a separate switch.

### 7.2 Open questions for the owner

1. **Q1.** Who may chat in H1: owners only (recommended), or operators too?
2. **Q2.** The chat's daily budget: 40 turns by default (recommended), counted apart from the platform's 75 AI requests a day?
3. **Q3.** Should the agents' kill switch also stop the chat? Recommended: no. The chat cannot act, and it gets its own switch.
4. **Q4.** Transcript retention: 90 days in the DO's SQLite, then R2, with the audit chain holding hashes only (recommended)?
5. **Q5.** A daily Telegram digest in addition to the on-change notices? If yes, at what time (for example 08:00 WIB)?
6. **Q6.** May the owner pick a council option in Nexus, or only in Cerebrum (recommended, per the ADR-0017 guards)?
7. **Q7.** Build the minimal push hub (ADR-0015 phase 1 slice) now, for H1.5 (recommended)?
8. **Q8.** The minimum shadow window for a strategy change: 14 days and 30 directional outcomes (recommended)?
9. **Q9.** Agent-raised councils: proposed as an inbox item that the owner starts (recommended), or started automatically?
10. **Q10.** Is the deploy-pipeline hardening (a)–(f) complete? It gates H0 and H1 (ADR-0017 Decision 4); the repository does not record (a)–(f) as done.
11. **Q11.** Is the ADR-0019 P2/P4 assumption in §6 right?

**Owner answers (2026-11-16, "ya semua, sesuai rekomendasimu").** Every recommended default above is accepted:
- Q1: owners only in H1.
- Q2: the chat has its own budget, 40 turns a day, counted apart from the 75 AI requests a day.
- Q3: the agents' kill switch does not stop the chat; `kernel_controls.conversation_enabled` does.
- Q4: 90 days in DO SQLite, then R2; the audit chain holds hashes only.
- Q5: yes, a daily digest at 08:00 WIB (01:00 UTC), sent only when the inbox is not empty.
- Q6: Cerebrum only.
- Q7: build the minimal push hub now, for H1.5.
- Q8: 14 days and 30 directional outcomes.
- Q9: an agent-raised council is an inbox item that the owner starts.
- Q10: the hardening (a)–(f) counts as done. All six are built, and (f) ran live in the rescue drill of 2026-11-16. The H0/H1 start gate is met.
- Q11: the ADR-0019 P2/P4 mapping in §6 is right.

### 7.3 Implementation order (in parallel with the cut-over gates, at lower priority)

| # | Step | Rough effort |
|---|---|---|
| 1 | H0a: Policy page cleanup (form and allow-list row removed, decision detail, manual evaluations out of the stats) | 0.5–1 d |
| 2 | H0b: `rankInbox()` pure function, kind table and tests; `items[]` in `GET /v1/owner/inbox` | 1–2 d |
| 3 | H0c: Owner page ranked list and `#/owner/<item_id>`; H0d: Telegram top-5 lines with deep links, no-action-URL test | 1.5 d |
| 4 | H1a: read-only Forge docs RPC; `PolicyRpc.dryRun()` | 1.5–2 d |
| 5 | H1b: `ConversationAgent` DO (Agents SDK), the tool layer over the existing readers, redaction, citation check, audit, budget, `CHAT_MODEL` on the allow-list | 4–5 d |
| 6 | H1c: Console `#/ask`, three allow-list rows, streamed turns, ratings; an Indonesian evaluation set of 30 questions with expected refs | 2–3 d |
| 7 | `ConsoleHub` slice (ADR-0015 phase 1, the Console only) | 3–4 d |
| 8 | H1.5: `council.v1` schemas, fixtures and resolvers; the Cerebrum council DO; `#/councils`; handoff to inbox drafts. The contract goes to the xauusd session | 5–7 d |
| 9 | The chat arena (weekly shadow replay) | 1–2 d |

The total is about 20–28 working days. Each step is its own change request, through Forge checks and consensus. A step that touches a guard path waits for the owner's click.
