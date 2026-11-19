# Design: HAIC H5, collaborators and roles

- **Status:** accepted by the owner on 2026-11-19 (every recommended default in §9); H5b is built (`claude/haic-h5b-owner-only`), the rest follows the order in §10.
- **Implements:** ADR-0017 Decision 6 ("Collaborators") and phase H5. It also settles the H1 question Q1 (`docs/design/HAIC-H0-H1.md` §3.7, §7.2), where the owner chose "owners only in H1, operators in H5".
- **Reads with:** ADR-0009 (consensus, the owner's click), ADR-0011 (accounts and privileges), ADR-0017 (H0–H4 and the guards), `docs/design/HAIC-H0-H1.md` (chat, councils, budgets), `AGENTS.md` (Console: measured data only; guard paths need the owner's click) and `workers/control-plane-shared/src/guard-paths.ts`.
- **Baseline:** canonical `main` at `b251b08` ("Owner page: the Incidents panel"). Every "exists" claim below names a file and line. A claim that something is new says so.

## 1. Goals and non-goals

**Goals**
- Other people can work with the organism and with the owner under named roles: viewer, reviewer, operator and approver accounts, with the owner (configuration) above them.
- **Reviewers comment and teach.** A comment is a note for people. A correction is a labelled lesson for the organism (the H3 path).
- Operators and reviewers can use the chat (`#/ask`) inside their own budget. That budget never takes turns from the owner's.
- Operators can take part in councils: they read, comment and may propose one. The owner still begins, joins, picks and dismisses.
- **Only the owner approves critical actions** (ADR-0017 §6). Today approver *accounts* can also approve them (§2.4). H5 closes that gap.
- One table says which role may do what on which surface. It lives in a guard path, so a later widening needs the owner's click.

**Non-goals and fixed guards** (unchanged constitution)
- This document changes no code, consensus rule, guard path or workflow.
- **The root of trust stays in configuration** (ADR-0011): the owners are `APPROVER_IDENTITIES`, kept in `platform_identities` (`identity-source.ts`). No collaborator role can be added to the configured lists from the Users page.
- No collaborator approves a critical action, sets the autonomy dial, confirms a typed proposal, picks a council option, manages accounts or edits the identity lists.
- Trading autonomy is never widened, and funds never move (ADR-0009, ADR-0020). A collaborator's text is never trading evidence.
- **The learning mandate is untouched.** A correction is never refused for its count or rate (ADR-0017 §4; `power-mode.ts`). Only the content-safety checks apply: size, secrets and price wording.
- Telegram stays the owner's channel. Collaborators get no Telegram notices (`owner-notices.ts` sends only to `OWNER_TELEGRAM`).
- Nexus (xauusd) roles are out of scope. H5 keeps the ADR-0011 rule that a kind `user` account may sign in to Nexus only.

## 2. What exists today

### 2.1 Identities and the root of trust

- **Access JWT.** Every HTTP request carries a verified Cloudflare Access JWT (`control-plane-shared/src/access.ts:73-115`). A JWT with an email claim is a `user`; one with a `common_name` is a `service_token`. Worker-to-Worker calls use RPC bindings, not HTTP.
- **Configured identities.**
  - `OPERATOR_IDENTITIES` holds the operators and the CI token. `APPROVER_IDENTITIES` holds the owners.
  - Since migration 0073 their emails come from D1 `platform_identities`, read only through `identity-source.ts` (a guard path, `guard-paths.ts:15`). Only an owner writes that row, with the phrase `IDENTITIES` (`platform-registry/src/identities.ts:8-14`, also a guard path, `guard-paths.ts:16`). The deployment's `deploy-vars.ts` writes the values (guard path, `guard-paths.ts:17`).
  - `identitySourceOf()` refuses a row whose operator and approver email lists differ (`identity-source.ts:96-97`, `identity_lists_differ`). **Every configured person is therefore both an operator and an owner today.** A configured non-owner operator person cannot exist in the native source.
- **Accounts.** Migration `0026_platform_accounts.sql` defines `platform_accounts`:
  - `email`, `kind` (`admin` | `user`), `privilege` (`viewer` | `operator` | `approver`, only for `admin`), `status` (`active` | `disabled`), `note`, and created/updated by and at (lines 12-24);
  - the CHECK at line 16 allows only those three privileges, and line 23 ties a privilege to `kind = 'admin'`.
  - Migration 0026 is in readiness's `REQUIRED_MIGRATIONS` (`control-plane-shared/src/readiness.ts:23`).

### 2.2 How a request's role is decided

| Step | Where | What it does |
|---|---|---|
| Owner | `access.ts:198-200` `isOwner()` | A person (`type = user`) in `APPROVER_IDENTITIES` |
| Account role | `access.ts:203-216` `accountRole()` | Looks up an active `platform_accounts` row. Configured identities never inherit a row (line 205). `kind user` → `user`; otherwise the privilege. A lookup error grants nothing (lines 212-215) |
| Display role | `access.ts:219-224` `roleOf()` | Owner → `approver` with `owner: true`; configured operator → `operator`; else the account role. Served as `GET /v1/accounts/me` (`platform-registry/src/accounts.ts:49-54`) |
| Operator gate | `access.ts:233-250` `requireOperator()` | Configured operators; `operator` and `approver` accounts; `viewer` accounts for GET/HEAD only (line 243). An owner who is not in `OPERATOR_IDENTITIES` is not an operator (line 237); in practice every owner is one (§2.1) |
| Approver gate | `access.ts:267-278` `requireApprover()` | A person who is an owner **or an `approver` account** (lines 271-272). Never a service token |
| Deploy-record gate | `access.ts:257-261` | Service tokens operate; a person must be an approver |
| Console gate | `console/src/index.ts:181-210` `consoleGate()` | Configured operator or owner from the Worker's own variables (lines 185-189); otherwise it asks the Registry's `/v1/accounts/me` with the caller's JWT and accepts only `viewer`, `operator` or `approver` (lines 191-198). It refuses on any failure |
| Console write block | `console/src/index.ts:350` | A `viewer` gets `viewer_read_only` on any non-GET; the downstream Worker refuses too |
| Console CSRF | `console/src/index.ts:352-357` | Same `origin` and `x-cryptophys-console: 1` on every non-GET |
| UI flags | `console/src/index.ts:333-343` (`/api/whoami`), `ui/src/lib/session.tsx:7` (`Who`), `ui/src/components/AppShell.tsx:113-117` (`roleLabel`) | `operator`, `approver`, `owner`, `viewer`. Pages hide controls with `who.owner` or `who.approver`. The server checks again |

**No "reviewer" role exists anywhere in code, migrations or the Console.** A search for `reviewer` finds it only in ADR-0017 (lines 56, 58), in `HAIC-H0-H1.md:459`, and in unrelated uses (GitHub Environment reviewers; a prompt in `recovery-manager/src/index.ts:64`). ADR-0017 says collaborators join "under the ADR-0011 roles (viewer, operator, reviewer)", but **ADR-0011 defines viewer, operator and approver, not reviewer**. H5 has to add the role and amend ADR-0011 (§8, H5a).

### 2.3 Who may do what today (by route)

Checks are server-side. `RO` = `requireOperator`, `RA` = `requireApprover` / `isApprover` (owners plus approver accounts), `OWN` = `isOwner` (owners only).

| Surface | Read | Act | Where |
|---|---|---|---|
| Owner page (`GET /v1/owner/inbox`) | RO, so viewers too | Each item's action goes to its own route below | `ai-kernel/src/index.ts:143` |
| Chat (`/v1/conversations…`) | OWN | OWN (turns, ratings) | `ai-kernel/src/index.ts:159-162` (403 `owner_required`); test `conversation-h1b.test.ts:138-139` ("operators do not chat (Q1)") |
| Councils | RO (`GET /v1/councils[/{id}]`) | OWN for open, messages, pick, dismiss and start | `ai-kernel/src/index.ts:247-259`; test `council-h15b.test.ts:150, 160` |
| Typed proposals (H2) | RO | OWN: draft from a directive (line 219), confirm or reject (line 236) | `ai-kernel/src/index.ts:212-236` |
| Autonomy dial (H4) | RO | OWN (`SET <GROUP> <LEVEL>`) | `ai-kernel/src/index.ts:193-200` |
| Evolver mode | RO | `off`: operators; `on`: OWN | `ai-kernel/src/index.ts:271-279` |
| Consensus | RO | Critical owner decision approve/reject: **RA** (lines 317-321). Mode raise: **RA**, and a person (`consensus.ts:631-632`); lower: operators | `ai-kernel/src/index.ts:284-321` |
| Knowledge proposals | RO | Approve/reject: RA, never the proposer (`knowledge.ts:411`) | `ai-kernel/src/index.ts:297-303` |
| Critical report acknowledge (releases the brake) | RO | RA | `ai-kernel/src/index.ts:375-380` |
| Alert channels (the owner's Telegram) | RO | RA | `ai-kernel/src/index.ts:337-356` |
| Kill switch | RO | Off: operators; back on: RA | `ai-kernel/src/index.ts:402` |
| Agents | RO | Wake and suspend: operators (lines 440-447); resume: RA (line 449); principals: RA (lines 412, 419) | `ai-kernel/src/index.ts` |
| Recovery plans | RO | Create: RA or the deploy service token (`recovery-manager/src/index.ts:355`); approve: RA (line 347), never the author (line 218); disable: operators | `recovery-manager/src/index.ts` |
| Forge one-time actions (merge spike, work repository) | — | RA | `forge/src/index.ts:220, 236` |
| Users page: accounts | Owners, or RO (viewers too) | Owner only: `GRANT`, `REVOKE`, `SYNC`; no self-change; configured identities refused | `platform-registry/src/index.ts:260-276`; `accounts.ts:66-68, 90-91, 120-123` |
| Users page: identity lists | Owners, or RO | Owner only: `IDENTITIES` | `platform-registry/src/index.ts:284-293`; `identities.ts` |

The kernel's route index says "`APPROVER_IDENTITIES`" for consensus approvals, mode raises, report acks and alerts (`ai-kernel/src/index.ts:83-88`). The code calls `requireApprover`, which also admits approver accounts.

### 2.4 The gap against ADR-0017 §6

- ADR-0011 gives approver accounts "approvals: recovery plans, owner-queue decisions, raising the consensus mode". The Users page says the same: "also approves recovery plans and critical actions" (`console/ui/src/pages/Users.tsx:14`).
- ADR-0017 §6 says "Only the owner approves critical actions."
- The Policy Engine checks only that an `approve` row exists in `consensus_owner_decisions`, not who wrote it (`policy-engine/src/index.ts:113-115`). `consensus-exec.ts:41` reads the same row. So an approver account's click satisfies the critical-action gate today.
- The repository cannot tell whether any approver account exists in production. The Users page lists them.

### 2.5 Teaching today

- The chat stores a thumbs up or down per turn (`ai-kernel/src/conversation.ts:198-208`, audit `conversation.rated`). Nothing turns a rating into knowledge.
- **No correction path exists in this repository.** There is no table, route or module for "reading wrong" style corrections, and no reputation. A search for `correction` in `workers/` finds nothing, and a search for `reputation` finds nothing either.
- ADR-0017 puts the Nexus part of H3 in the xauusd repository. A search of the local xauusd checkout (`b0e4ca8`) for `correction` finds only model-output retries (`src/multi-agent-bus.mjs`, `src/agent-threads.mjs`), not owner corrections. That checkout may be behind.
- Knowledge proposals (`knowledge.ts`) are Aether's drafts. They need at least 10 cited decision cards (`MIN_CITED_CARDS`), so a person's correction does not fit them.
- Agent memory (`memory.ts`, table `agent_memories`, migration 0014) is written only through the `memory.remember` agent syscall. That syscall needs a Policy Engine decision id (`memory.ts:108-115`). Memory is advisory context for AI drafts, never input to triggers or validators (`memory.ts:11`).

### 2.6 Budgets today

- **Chat:** one global budget per UTC day. `conversation_budget(day, turns)` (migration 0078) is checked against `CHAT_DAILY_TURN_LIMIT` = 40 (`control-plane-shared/src/conversation.ts:14`; `ai-kernel/wrangler.toml:42`). `reserveTurn()` (`ai-kernel/src/conversation.ts:58-63`) is not per person.
- **Councils:** `COUNCIL_LIMITS` (`control-plane-shared/src/council.ts:37-44`):
  - 2 open at once, 4 started a day, 16 model calls, 60 messages and 20 owner messages each;
  - 1,200 characters per message and $0.10 per council.
- **Owner messages feed the model.** `ownerNotes()` puts every owner message into the position and synthesis prompts (`ai-kernel/src/council.ts:280, 318, 351`).

## 3. The role model

A ladder: each role has every right of the role below it. Recommended in Q1.

| Role | Who | Stored as | Console |
|---|---|---|---|
| `user` | Nexus-only accounts | `platform_accounts.kind = 'user'` (unchanged) | Refused (fallback page) |
| `viewer` | Read-only accounts | `kind admin`, `privilege viewer` (unchanged) | Reads everything; no writes |
| **`reviewer`** (new) | Comment and teach | `kind admin`, `privilege viewer`, plus the new flag `reviewer = 1` (Q2) | Reads everything. May POST only the reviewer routes (§4.3): comments, corrections, own chat |
| `operator` | Routine actions | `privilege operator` (unchanged) | As today, plus reviewer rights, the chat and council proposals |
| `approver` | Delegated, non-critical approvals | `privilege approver` (unchanged), **narrowed** (Q3) | As today, minus the critical decisions listed in §4.1 |
| **owner** | People in `APPROVER_IDENTITIES` | Configuration (`platform_identities`), never an account row | Everything, including every critical approval and every grant |

- The service token stays an operator and is never a reviewer, approver or owner.
- The highest role wins. A configured identity never inherits a row (`access.ts:205`, unchanged).
- A failed lookup grants nothing.
- **Fail-safe rollout.** A reviewer row read by code from before H5 has `privilege viewer`, so it reads as a viewer: read only. Code that has not caught up can only under-grant.

## 4. Permission matrix

`R` = read, `C` = comment, `T` = teach (correct), `A` = act. "—" means refused. **Bold** marks a change from today.

### 4.1 By surface

| Surface | viewer | reviewer | operator | approver | owner |
|---|---|---|---|---|---|
| Owner page ("Needs you") | R | R, **C** on items | R, **C** | R, **C**; decides recovery plans, knowledge, report acks | Everything |
| Chat `#/ask` | — | **own conversations, reviewer budget** | **own conversations, operator budget** | **as operator** | As today; own budget, untouched by others |
| Chat: draft a directive (`POST /v1/proposals`) | — | — | — (Q10) | — (Q10) | A |
| Councils: read | R | R | R | R | R |
| Councils: comment | — | **C** (not in the transcript, not in prompts; §5.1) | **C** | **C** | C, plus owner messages (as today) |
| Councils: propose | — | — | **propose; the owner begins it** (Q5) | **propose** | Open, begin, join, pick, dismiss |
| Typed proposals (H2) | R | R, **C** | R, **C** | R, **C** | Confirm or reject |
| Autonomy dial (H4) | R | R | R | R | Set (unchanged) |
| Consensus: critical decisions in `pending_owner`, including routine actions held at `owner_click` | R | R, **C** | R, **C** | **R, C (was: approve or reject)** | Approve or reject |
| Consensus mode: raise | — | — | — | **— (was RA)** | A |
| Consensus mode: lower; kill switch off | — | — | A | A | A |
| Kill switch back on | — | — | — | **— (was RA)** (Q3) | A |
| Recovery plans | R | R, **C** | R; disable | Create, approve (not one's own) | Everything |
| Knowledge proposals | R | R, **C**, **T** | R, C, T | Approve or reject (unchanged) | Everything |
| Critical report acknowledge | R | R, **C** | R, C | A (unchanged) | A |
| Alert channels (the owner's Telegram) | R | R | R | **— (was RA)** (Q3) | A |
| Agents: wake, suspend; resume; principals | R | R | Wake, suspend | Resume; **principals: — (was RA)** (Q3) | Everything |
| Corrections on agent reports, turns, council messages, cards | — | **T** | **T** | **T** | T (high weight, ADR-0017 decision 3) |
| Users page: list and history | R | R | R | R | R |
| Users page: grant, change, disable, sync, identity lists | — | — | — | — | A (unchanged: owner only, typed phrase, no self-change) |

The critical decisions moved from approver accounts to the owner (Q3) are:
- `POST /v1/consensus/{id}/approve|reject`;
- raising the consensus mode;
- turning the kill switch back on;
- registering or revoking agent principals;
- the owner's alert channels;
- the Forge one-time spikes (`/v1/forge/merge-spike`, `/v1/forge/work-repo`).

Approver accounts keep what ADR-0011 calls separated human approval outside the ADR-0009 critical class:
- recovery plans, never one's own;
- knowledge reviews;
- critical-report acknowledgements;
- resuming an agent.

### 4.2 The matrix lives in one module

New: `control-plane-shared/src/collaborators.ts`. It is pure and has no I/O. It exports:
- `ROLE_RANK`: user < viewer < reviewer < operator < approver < owner;
- `SURFACE_RULES`: `{surface, verb} → minimum role` for every row of §4.1;
- `REVIEWER_POST_ROUTES`: the Console routes a reviewer may POST (§4.3);
- `CHAT_BUDGETS` (§6).

The kernel, the Recovery Manager, the Forge and the Console import it. Since every route check reads this one table, a test can enumerate the table against the routes. **It is added to `guard-paths.ts` under `auth_access`** (Q9), so widening any row is a `merge_owner_change`.

### 4.3 Reviewer writes through the Console

- Today the Console refuses every viewer write wholesale (`console/src/index.ts:350`). A reviewer is a new Console role, `reviewer`, and its non-GET requests are refused unless the matched rule is in `REVIEWER_POST_ROUTES`:
  - `kernel POST /v1/comments`;
  - `kernel POST /v1/corrections`;
  - `kernel POST /v1/conversations/{id}/turns`;
  - `kernel POST /v1/conversations/{id}/turns/{id}/rating`.
- CSRF applies as for every other write.
- Anything not listed is refused: the default is deny.
- The kernel checks again with `requireReviewer` (§7). The Console's check only fails early.

## 5. "Reviewers comment and teach", concretely

### 5.1 Comments (for people)

- **What.** A note of up to 1,200 characters (the council message bound) on one target, named by an `ev:` ref (HAIC-H0-H1 §4.6):
  - `ev:platform/council/<cs_…>[#<seq>]` (a council or one of its messages);
  - `ev:platform/typed_proposal/<tp_…>`;
  - `ev:platform/consensus/<cns_…>`;
  - `ev:platform/knowledge/<knw_…>`;
  - `ev:platform/recovery_plan/<plan_…>`;
  - `ev:platform/report/<report_id>`;
  - `ev:platform/inbox/<item_id>`;
  - `ev:platform/conversation/<cnv_…>#<turn>`, only on one's own conversations (Q4).
- **Who reads them.** People only. Comments show beside their target on the Councils, Proposals, Consensus, Knowledge, Recovery and Owner pages, each with its author and role.
- **Never in a prompt.** Comments do not enter any model prompt: not the council's (`ownerNotes()` stays owner-only), not the chat's, and not an agent's. A static test asserts that `council.ts`, `conversation.ts`, `conversation-tools.ts` and the agents' task builders do not import the comments module.
- **Councils are unchanged.** `council.v1` (`control-plane-shared/src/council.ts`, shared with Nexus) does not change: comments are not council messages, so the Nexus fixtures stay valid.
- **Moderation.** The owner may hide a comment (`POST /v1/comments/{id}/hide`, phrase `HIDE`). It is hidden, never deleted, and audited.
- **Content safety.** A text that `secretInText()` flags is refused (`control-plane-shared/src/conversation.ts:107`). The rest is stored redacted (`redactText()`, line 110). `injectionFlags()` (line 126) is recorded as `collab.injection_flagged` but does not refuse the comment, because nothing executes it.
- **No action from a comment.** A comment is never an approval, a vote or a directive, and no route reads one as such.

### 5.2 Corrections (teaching the organism, the H3 path)

- **What.** A labelled lesson on one target that an agent produced:
  - an agent report;
  - a chat answer (one's own turn);
  - a council position or synthesis;
  - an Observer finding;
  - a card.
- **Shape.** `{ target_ref, agent_id, label, text ≤ 600, evidence_refs[] }`, where `label` is one of `reading_wrong`, `number_wrong`, `missing_evidence`, `invalidation_too_tight`, `invalidation_too_loose`, `good_call` and `other`.
- **Never refused for count or rate** (ADR-0017 §4 and the learning mandate).
  - Deduplicated by `sha256(target_ref, label, normalized text)`. A duplicate returns the existing record with 200.
  - The only refusals are content safety, as in `knowledge.ts`: the secret check, the size bound, and for xauusd targets the price, level and order wording (`PRICE`, `ORDER`, `knowledge.ts:41-42`).
- **Weight by role** (Q7):
  - the owner 1.0 ("high weight", ADR-0017 decision 3);
  - approver and operator accounts 0.5;
  - reviewers 0.5.
  - The owner may **endorse** a correction (to 1.0) or **dispute** it (to 0, kept, with its history). Neither deletes it.
- **Where it goes.**
  - Into the new D1 table `human_feedback`.
  - When the target is a platform agent, into that agent's memory as `kind = 'human_correction'`. The memory text is `"[correction by <role>, weight w] <label>: <text>"`, and `source_ref` is the target ref.
  - A new kernel writer, `teachAgent()`, does the memory write. It is not the `memory.remember` syscall, because a person is not an agent and holds no Policy decision id. Its embedding is a learning AI call (`LEARNING_AI_PURPOSE`), so no AI budget refuses it. It is audited as `collab.correction_taught`.
  - Recall stays as it is: advisory context for drafts, never for triggers or validators (`memory.ts:11`).
  - Corrections on xauusd targets are stored and shown. H5 does not forward them to Nexus. That waits for the Nexus H3 contract (Q7).
- **Reputation.** No agent reputation exists (§2.5). H5 stores the labels so that a later reputation can read them. It invents no score.

## 6. Per-role chat budgets

- **The owner's pool does not change**: `conversation_budget`, `CHAT_DAILY_TURN_LIMIT` = 40 a day. No collaborator turn is counted against it.
- **The collaborator pool is new**: table `conversation_collab_budget(day, actor, role, turns)`, with primary key `(day, actor)`. Limits come from `CHAT_BUDGETS` in `collaborators.ts` (Q4):

| Role | Per person per UTC day | Shared collaborator pool per day |
|---|---|---|
| reviewer | 5 turns | 20 turns, all collaborators together |
| operator, approver | 10 turns | (same pool) |

- Both limits are reserved atomically, the same way `reserveTurn()` works. Over either one, the turn is refused with `conversation.budget_refused`, whose payload carries `{pool: "collaborator", role}`. The refusal costs no model call.
- The existing per-turn caps still apply (`MAX_CALLS_PER_TURN` = 3, `MAX_QUESTION_CHARS` = 2,000; `control-plane-shared/src/conversation.ts:16, 18`).
- `conversation_controls.enabled` stops everyone's chat. A new control, `collaborators_enabled`, stops only collaborators: the owner may turn it off with phrase `CHAT OFF`, and any operator may also turn it off, as a brake.
- **Cost** (per-turn costs from HAIC-H0-H1 §3.6: typical $0.0055, at most $0.017):
  - a full collaborator pool is 600 turns a month: about **$3.3** typical, **$10** at the per-turn caps;
  - with the owner's pool full as well (1,200 turns a month), the chat at the caps would be about $30, which equals `infra-budget-usd-month` (30, `policy-params.ts`); typical use is about $10;
  - the Metabolism page shows the measured neurons for `CHAT_MODEL`, which only the chat uses.
- **Councils.** A collaborator's council proposal spends nothing until the owner begins it. It then counts against the existing council limits (2 open, 4 a day), which still bound the owner's councils too.

## 7. Storage, grants and audit

### 7.1 Storage (one additive migration, 0084)

- `platform_accounts`:
  - add `reviewer INTEGER NOT NULL DEFAULT 0 CHECK (reviewer IN (0, 1))`;
  - optionally add `expires_at TEXT` (Q8).
  - `ALTER TABLE … ADD COLUMN` is not destructive under `DESTRUCTIVE_SQL` (`control-plane-shared/src/migration-rules.ts:18`), so this is not a `deploy_destructive_migration`.
  - The rule "reviewer = 1 only with `kind admin` and `privilege viewer`" is checked in `accounts.ts` and tested. A cross-column CHECK would need a table rebuild, which is destructive.
- New tables:
  - `collab_comments`: `comment_id`, `target_ref`, `author`, `author_role`, `text`, `content_sha256`, `status` (`visible` | `hidden`), `hidden_by`, `created_at`;
  - `human_feedback`: `feedback_id`, `target_ref`, `agent_id`, `label`, `text`, `content_sha256` UNIQUE, `author`, `author_role`, `weight`, `endorsement` (`none` | `endorsed` | `disputed`), `memory_id`, `created_at`, `updated_at`;
  - `conversation_collab_budget` (§6).
  - A `conversation_controls` row for `collaborators_enabled`. Its CHECK admits only `'enabled'` (migration 0078), so the new control needs its own table, `collab_controls`.
- Readiness: add `0084_…` to `REQUIRED_MIGRATIONS`.
- Deploy order (ADR-0011): the Control Plane applies the migration and deploys first, alone.

### 7.2 Who grants what

- **Only the owner grants**, exactly as today. This covers `POST /v1/accounts` with `GRANT` and `POST /v1/accounts/{email}/disable` with `REVOKE` (`accounts.ts:66-68`).
- The API accepts `privilege: "reviewer"` and stores `(viewer, reviewer = 1)`. `GET /v1/accounts` and `/me` return `role: "reviewer"`.
- Approver accounts cannot grant. Nobody changes their own access (`accounts.ts:90, 120`). Configured identities stay out of the table (`accounts.ts:91, 121-123`).
- Disabling ends every role at once in every Worker. Access-group membership may stay stale until the sync runs (ADR-0011, unchanged), and the Users page already says so.
- The identity lists (`platform_identities`) stay the owners' only. H5 adds no role there and does not change `identity-source.ts` (Q9).

### 7.3 Audit trail

Every write goes through `appendAuditEventWithMutation` (`control-plane-shared/src/audit.ts`), so the row and its event are one write, as in `accounts.ts:94-106`.

- **Account events** (exist): `account.created`, `account.changed` and `account.disabled`. Their payload gains `reviewer` and `previous.reviewer`.
- **New events:**
  - `collab.comment_posted`, `collab.comment_hidden`, `collab.injection_flagged`;
  - `collab.correction_recorded`, `collab.correction_taught`, `collab.correction_endorsed`, `collab.correction_disputed`;
  - `collab.chat_switch_changed`.
- **Chat events** (exist): the `conversation.*` events gain `role` in their payload.
- **Council proposals:** a collaborator's proposal is `council.proposed`, with `trigger.kind = "collaborator"` (Q5).
- **Payloads** hold ids, refs, hashes, role and weight. The text stays in D1, within the 16 KiB payload bound.
- **Users page:** a "History" panel per account reads these events from the audit chain. It shows measured data only (AGENTS.md).

## 8. Guard-path changes and the owner's click

| Change | Files | Guard path? | Path to `main` |
|---|---|---|---|
| Add `reviewer`; `requireReviewer()`; `requireOwner()`; reviewer reads only through `requireOperator` | `control-plane-shared/src/access.ts` | **Yes** (`guard-paths.ts:10`, `auth_access`) | `merge_owner_change`: **the owner's click** |
| The role→surface table | new `control-plane-shared/src/collaborators.ts`, plus its line in `guard-paths.ts` | **Yes** (`guard-paths.ts` itself is guarded at line 35, `evolution_guard`) | **The owner's click** |
| Defence in depth: the `owner_approved` check also requires that `decided_by` is an owner | `workers/policy-engine/` (needs `APPROVER_IDENTITIES`, written by `deploy-vars.ts`) | **Yes** (`policy_engine`; `deploy-vars.ts` is `auth_access`) | **The owner's click** (Q3) |
| Identity lists | `identity-source.ts`, `platform-registry/src/identities.ts` | Yes | **No change in H5** |
| Owner-only critical routes; reviewer routes; chat and council roles; budgets | `ai-kernel/src/index.ts`, `consensus.ts`, `conversation.ts`, `council*.ts`, `recovery-manager/src/index.ts`, `forge/src/index.ts` | No | Consensus (`merge_change`). Once `collaborators.ts` is guarded, these files only *read* the guarded table |
| Accounts API and Users page | `platform-registry/src/accounts.ts`, `console/ui/src/pages/Users.tsx` | No | Consensus |
| Console gate, whoami, reviewer POST rule | `console/src/index.ts`, `ui/src/lib/session.tsx`, `AppShell.tsx` | No (only the Console's build harness files are guarded, `guard-paths.ts:31`) | Consensus |
| Migration 0084 | `control-plane-migrations/0084_*.sql` | No; additive, so not destructive | Consensus; the Control Plane deploys first |

- **Why the table belongs in a guard path.** Today the chat's and councils' owner-only checks sit in `ai-kernel/src/index.ts`, which is not a guard path. A routine merge could widen them. Moving the matrix to a guarded module is the fix (Q9).
- **Tests.**
  - Existing tests are not weakened. `accounts-0026.test.ts` U4 ("approver approves") stays true for `requireApprover`. A new test asserts that the critical *routes* answer `owner_required` to an approver account.
  - Two assertions change because the owner's answer changes the rule:
    - `conversation-h1b.test.ts:138-139` ("operators do not chat (Q1)");
    - `council-h15b.test.ts:150, 160` ("operators do not open councils"; operators may not post messages).
  - Each is replaced by stronger ones: viewers are still refused; operators and reviewers chat only inside their pool; the owner's pool is unchanged; operators may only *propose* a council; nobody but the owner posts owner messages, begins, picks or dismisses.

## 9. Open questions for the owner

1. **Q1. The role model.**
   - Option A: a ladder, viewer < reviewer < operator < approver < owner, where operators and approvers also comment and teach.
   - Option B: reviewer as a separate flag that can sit on any account.
   - **Recommended: the ladder (A).** It matches ADR-0011's single privilege and is the easiest to explain on the Users page.
2. **Q2. Storing the reviewer.**
   - Option A: an additive `reviewer` column on viewer accounts, with privilege `"reviewer"` in the API.
   - Option B: rebuild `platform_accounts` with `reviewer` in the privilege CHECK. That is a destructive migration: `deploy_destructive_migration` and the owner's click.
   - **Recommended: additive (A).**
3. **Q3. Narrowing approver accounts.** Today approver accounts may approve critical consensus proposals, raise the consensus mode, turn agents back on, manage agent principals, change the owner's alert channels and run the Forge spikes (§2.3, §2.4). ADR-0017 §6 says only the owner approves critical actions.
   - **Recommended:** move those to the owner only. Keep recovery plans, knowledge reviews, critical-report acknowledgements and agent resume with approver accounts. Add the Policy Engine check that `decided_by` is an owner (a guard path; the owner's click).
4. **Q4. The chat for collaborators.**
   - **Recommended:**
     - operators and approver accounts get 10 turns a day each, reviewers 5, with a shared collaborator pool of 20 a day;
     - the owner's 40 turns stay reserved;
     - conversations are private to their author, and the owner sees per-person counts and audit metadata, not the text;
     - viewers do not chat;
     - a separate `collaborators_enabled` switch (owner on and off; operators off).
5. **Q5. Councils for operators.**
   - Option A: read and comment only.
   - Option B: also propose a council, which waits as an inbox item until the owner begins it, like an agent's proposal (Q9 of H1.5). This needs a new `trigger.kind = "collaborator"` in `council.v1`, plus updated Nexus fixtures.
   - Option C: operators open and run councils within their own daily quota.
   - **Recommended: B.** Collaborators never post owner messages, begin, pick or dismiss.
6. **Q6. Comments.** **Recommended:**
   - comments on councils and their messages, typed proposals, consensus proposals, knowledge proposals, recovery plans, reports, inbox items and one's own chat turns;
   - comments are for people only and never enter a model prompt;
   - the owner may hide one (`HIDE`), never delete it.
7. **Q7. Teaching weight and reach.** **Recommended:**
   - weights: owner 1.0, every collaborator 0.5;
   - no count or rate limit (the learning mandate); deduplication by content hash; content-safety refusals only;
   - the owner may endorse (to 1.0) or dispute (to 0, kept);
   - platform-agent corrections go to the target agent's memory as `human_correction`;
   - xauusd-targeted corrections are stored but not forwarded to Nexus until the Nexus H3 contract exists.
8. **Q8. Grant expiry.**
   - **Recommended:** an optional `expires_at` the owner sets per grant, with no default.
   - An expired account reads as having no role. It is shown on the Users page and in `owner_attention` 7 days before it expires.
   - Grants stay owner-only, with `GRANT`.
9. **Q9. Guard paths.** **Recommended:**
   - put the role→surface table in a new `collaborators.ts` listed in `guard-paths.ts` (`auth_access`);
   - change `access.ts` once for `reviewer`, `requireReviewer` and `requireOwner`;
   - leave `identity-source.ts` and `identities.ts` unchanged.
   - Each guard-path step waits for the owner's click.
10. **Q10. Directives from collaborators.**
    - **Recommended: no** in H5. `POST /v1/proposals` (a chat directive into a typed draft) stays the owner's. A directive is the owner's intent (ADR-0017 decision 2).
    - A collaborator who wants a change writes a comment on the inbox item or proposes a council.

**Owner answers (2026-11-19, "Setuju semua rekomendasi").** Every recommended default in this section is accepted. Migration numbers: the first of H3b and H5d to land takes 0084, the other the next free one. H5b (owner-only critical routes) was built first, on the owner's "Perbaiki sekarang".

## 10. Risks

- **Privilege escalation through a widened route.** The owner-only checks live in a file that is not guarded (§8).
  - Mitigation: the guarded matrix, and a test that enumerates every route against `SURFACE_RULES`.
  - The Console's reviewer POST list is closed and denies by default.
  - The Console gate accepts only role strings from a closed set (`console/src/index.ts:197`, extended with `reviewer`).
- **Approver accounts as de facto owners** (§2.4). Mitigation: Q3 (route checks, then the Policy Engine check on `decided_by`).
- **Self-grant and lock-out.** Unchanged: only owners grant, nobody changes their own access, and configured identities are not rows (`accounts.ts:66-68, 90-91`).
- **Stale access after a disable.** The role ends at once in every Worker. The Nexus Access group may stay stale until the sync (ADR-0011, unchanged). An open Access session lasts up to 8 h but carries no role.
- **Prompt injection through collaborator text.**
  - Comments never reach a prompt (static test).
  - Corrections reach agents only as recalled memory: quoted data, labelled with author role and weight, advisory only, never a trigger or validator input (`memory.ts:11`).
  - Every text passes `secretInText` and `redactText`. `injectionFlags` is recorded.
  - Chat questions from collaborators run through the H1 pipeline: read-only tools, citation post-check, `conversation.injection_flagged`. The chat has no write tool, so at worst a collaborator gets a wrong answer for themselves.
- **Teaching poisoning** (many reviewers pushing one lesson).
  - Collaborator weight is half the owner's, and the owner can dispute.
  - Deduplication collapses identical text.
  - Memory never changes a trigger, a threshold or a parameter.
  - Grants are owner-only and expire if the owner sets an expiry (Q8).
- **Social engineering of the owner** ("please approve cns_…" in a comment). Comments show author and role, never look like system text, and carry no action buttons. Approval stays the existing route, click and phrase.
- **Cost creep.** Separate pools, per-person caps and a switch (§6). The owner's pool cannot be drained.
- **Contract drift with Nexus** if Q5 B adds a trigger kind. Mitigation: bump the fixtures in the same step and hand the change to the xauusd session.

## 11. Implementation order (small mergeable steps)

| # | Step | Tests | Owner's click? | Rough effort |
|---|---|---|---|---|
| H5a | ADR-0011 amendment (reviewer, narrowed approver) and ADR-0017 amendment (H5 answers); `docs/SSOT.md` "Human–AI collaboration" | ADR progress manifest checks, if the Steward adds one | Owner accepts the text (ADR-0011 and ADR-0017 are not guard paths) | 0.5 d |
| H5b | Owner-only critical routes (Q3): kernel consensus approve/reject, mode raise, kill switch on, principals, alerts; Forge spikes. UI: these buttons use `who.owner`; Users page privilege text | New: an approver account gets `owner_required` on each route, and an owner still succeeds. U4 unchanged. `console-truthfulness` unchanged | No (narrowing; consensus) | 1 d |
| H5c | Policy Engine `owner_approved` also requires `decided_by` ∈ `APPROVER_IDENTITIES`; the variable is added to the Policy Engine's deploy | Policy tests: an approve row by a non-owner fails the check; by an owner it passes | **Yes** (`policy_engine`, `deploy-vars.ts`) | 1 d |
| H5d | Migration 0084 (§7.1); readiness `REQUIRED_MIGRATIONS` | `test_migrations.py`; a CHECK test per new table; not destructive under `migration-rules.ts` | No; the Control Plane deploys first | 0.5–1 d |
| H5e | `access.ts`: `reviewer` role, `requireReviewer`, `requireOwner`; new `collaborators.ts`; its line in `guard-paths.ts` | `access.test.ts`: reviewer reads, reviewer write refused by `requireOperator`, accepted by `requireReviewer`; service token never a reviewer; lookup failure grants nothing; a stale row never upgrades a configured identity (as U8). Matrix test: every kernel, Recovery and Forge route is in `SURFACE_RULES` | **Yes** (`auth_access`, `evolution_guard`) | 1.5–2 d |
| H5f | Registry: `privilege: "reviewer"` in `POST /v1/accounts`, `/me` and the list; optional `expires_at`. Users page: the role option, expiry, the History panel. Console: `reviewer` in `consoleGate`, whoami `reviewer`, the reviewer POST rule | `accounts-0026` U10+: GRANT reviewer, reviewer on operator refused, REVOKE ends it, expiry ends it. `console-tp023`: the reviewer may POST only the listed routes. `console-signout`: the fallback page unchanged | No | 1.5 d |
| H5g | Comments: `GET/POST /v1/comments`, `POST /v1/comments/{id}/hide` (owner, `HIDE`); panels on Councils, Proposals, Consensus, Knowledge, Recovery and Owner item detail; Console allow-list rows | Secrets refused, text redacted, injection flagged; hidden not deleted; audit atomic; a static test that no prompt builder imports comments; viewer refused; allow-list test updated | No | 2–3 d |
| H5h | Corrections: `POST /v1/corrections`; `teachAgent()` into `agent_memories` as `human_correction`; owner endorse and dispute | Dedup returns the same record; no count limit (a learning-mandate style test); price wording refused for xauusd targets; weight by role; memory recalled as quoted data; audit events | No (it does not touch `power-mode.ts` or the learning-mandate tests) | 2–3 d |
| H5i | Chat for collaborators: the role check from `collaborators.ts`; `conversation_collab_budget`; `collaborators_enabled`; the `#/ask` nav for reviewers and operators | Replace `conversation-h1b.test.ts:138-139` with: a viewer is refused; an operator and a reviewer chat within their caps; the pool refuses at 20; the owner's 40 are untouched; a conversation is not readable by another actor | No (the matrix is already guarded since H5e) | 1.5–2 d |
| H5j | Councils for operators (Q5 B): propose only, `trigger.kind = "collaborator"`; `council.v1` fixtures; the handoff note to the xauusd session | Replace `council-h15b.test.ts:150, 160` with: an operator may propose and may not open, begin, message, pick or dismiss; a proposal spends no model call until the owner begins it | No | 1.5 d |
| H5k | Owner page "Collaborators" summary (active accounts by role, today's chat pool use, corrections this week), measured only | `console-truthfulness`: "—" when a value is missing | No | 0.5–1 d |

- **Total:** about 13–17 working days.
- **Order:** H5b can merge first, because it only narrows. H5e must come before H5f–H5j. H5d must come before H5f.
- **Review:** each step is its own change request, through the Forge checks and consensus. H5c and H5e are `merge_owner_change` and wait for the owner's click.

### 11.1 Exit criteria

- One reviewer account and one operator account exist, granted by the owner with `GRANT`. Each used its rights for a week, inside its budget.
- An approver account cannot approve a critical proposal, by route or through the Policy Engine.
- Every comment and correction is in the audit chain with its hash.
- The static test shows that no prompt builder reads comments.
- The owner's chat pool was never charged for a collaborator's turn.
- The matrix test covers every route.
