# ADR-0017: Human–AI collaboration: the owner works with the organism directly

- **Status:** Accepted (owner, 2026-11-14: "setuju").
- **Owner direction (2026-11-14):** "roadmap berikutnya kita kembangkan Human Ai Interaction & Collaboration" (the next roadmap item is Human–AI Interaction & Collaboration). The owner accepted the four recommended decisions listed below.
- **Builds on:**
  - ADR-0009 (consensus and the owner's click);
  - ADR-0011 (accounts and roles);
  - ADR-0013 (census);
  - ADR-0015 (the push hub);
  - ADR-0016 (vision, self-model, Strategist);
  - the Observer.
- **Design:** `docs/design/HAIC-H0-H1.md` (H0, H1 and H1.5 Call for Councils; owner 2026-11-16: "setuju desain HAIC untuk awal").

## Context

The owner reaches the organism through scattered surfaces:

- Console clicks;
- Telegram notices;
- owner notices;
- Nexus;
- operator sessions acting as intermediaries.

The organism informs the owner and asks for clicks. It cannot be asked questions, cannot take direction, and does not learn from the owner's corrections. Autonomy is set by hand-written rules rather than by trust that has been earned.

## Decision

1. **"Needs you" inbox (Cerebrum)**
   - One queue for everything that waits on the owner: pending clicks (merge_owner_change, critical consensus), decisions, and agent questions.
   - Each item is metric-form: what, evidence, risk, the deadline or what it blocks, and a deep link to the action.
   - Items are ranked by urgency and by what they block.
   - Telegram carries a digest and deep links only.
2. **"Ask the organism": a conversational agent in Cerebrum, in English** (amended 2026-11-17, owner 2026-11-17: "all in englihs, hanya percakapan owner dengan sesi claude yang bahasa indonesia": everything the platform builds is English; only the owner's conversations with Claude sessions are in Indonesian)
   - Built on the Cloudflare Agents SDK, as one Durable Object per conversation, with its memory in DO SQLite.
   - Model: the Workers AI frontier model chosen by the ADR-0016 arena (default `@cf/deepseek-ai/deepseek-v4.1-flash-1017`).
   - Read-only tools: the self-model, Observer vitals and findings, census, outcome scores, consensus state, the ADR and SSOT index, and the cost and metabolism views.
   - Answers are metric-first, with evidence references. No narrative padding.
   - Live updates come through the ADR-0015 push hub.
3. **Directives become structured proposals**
   - A directive is something the owner says, such as "fokus ke akurasi minggu ini" (focus on accuracy this week).
   - The agent translates it into one or more typed proposals: a vision growth-layer goal or KPI target, a policy parameter, a Strategist intent, or a task for a repository session.
   - **The owner always confirms a directive first** (decision 2), including routine ones.
   - After confirmation the proposal goes through normal consensus, plus the owner's click for critical classes.
   - **The conversation never executes anything directly.**
4. **Teaching: owner corrections become knowledge (Nexus)**
   - Every agent post, metric reading, decision and card can be corrected or rated, e.g. "reading wrong", "invalidation too tight", "good call".
   - Corrections become labelled knowledge for Aether, with high weight (decision 3), and feed the agents' reputation.
   - This is consistent with the mandate that learning must not be limited by anyone (ADR-0016, the vision's constitution).
   - Corrections are deduplicated by content hash. They are never refused.
5. **Autonomy dial, per action class**
   - Four levels: observe → suggest → execute after the owner's click → execute on consensus.
   - The current level of each class is shown in Cerebrum.
   - The Strategist may propose raising a class when that class's experience-ledger record supports it. Only the owner changes a level, by a click.
   - Trading and fund movements can never rise above "execute after the owner's click".
6. **Collaborators**
   - Other people join under the ADR-0011 roles (viewer, operator, reviewer).
   - The owner-only actions stay owner-only.
   - Reviewers can comment and teach. Only the owner approves critical actions.

## Decisions taken with this ADR (owner, 2026-11-14)

1. The primary channel is chat in Cerebrum. Telegram is for notifications and light Q&A only.
2. Directives are always confirmed by the owner first. This may be relaxed later through the autonomy dial.
3. Corrections in Nexus are recorded as high-weight learning.
4. H0 and H1 start after the deploy-pipeline hardening (a)–(f) is done.
5. The Console Policy page's "Evaluate" panel is handled in H0 and H1, not separately (owner 2026-11-15: "oke, lanjutkan, masukan dalam plan Human Ai Interaction & Collaboration"; confirmed in the platform session). See "Policy page" under Phases.

## Guards (unchanged constitution)

- **Approvals.** Approvals happen only by a click in Cerebrum, under the owner's Cloudflare Access identity. Telegram and chat cannot approve critical actions.
- **Audit.** Every conversation turn, directive, confirmation and correction is audited.
- **External content is data.** News, web pages, repository text and agent outputs are treated as data, never as instructions. This is the defence against prompt injection.
- **No secrets** are accepted in chat, and secrets are never shown.
- **Unchanged:** consensus, the brake, rollback, the kill switches, guard paths, and the constitution.
- **Amendment 2026-11-16 (owner; ADR-0020):** arming and disarming an xauusd strategy is one click on the Nexus "Strategy Agents" page (owner-only Access identity, CSRF check, audit record), with no confirm step in Cerebrum. This exception to "Approvals" covers arm and disarm only; council picks, promotions and every other approval stay in Cerebrum.

## Phases

| # | Phase | Output |
|---|---|---|
| H0 | "Needs you" inbox and Telegram digest with deep links | One place for everything that waits on the owner |
| H1 | "Ask the organism" chat (read-only, English, metric-first, cited) | The owner talks to the organism directly |
| H2 | Directives as structured proposals, with the owner's confirmation | Intent becomes typed, governed change |
| H3 | Corrections and ratings in Nexus become knowledge | The organism learns from the owner |
| H4 | Autonomy dial per action class | Trust-based, measured autonomy |
| H5 | Collaborators and roles | Shared work with other humans |

The Nexus part of H3 (corrections on posts and decisions) is built in `cryptophys-adm/xauusd-ai-trading-assistant` by its own session.

### Policy page (owner 2026-11-15)

The "Evaluate" form on the Console's Policy page sends a real evaluation, so each manual test records a `policy_decisions` row and pollutes "decisions over time" and "failed checks". It is folded into the phases above. The Policy Engine's decision logic and guards do not change.

- **H0 (inbox and cockpit cleanup):**
  - the "Evaluate" form is removed;
  - each denial in "checks that denied" and each decision row opens a read-only detail: agent, action, resource, the failed check and its evidence;
  - evaluations that did not come from an agent (manual tests recorded before the form was removed) are left out of the stats.
- **H1 ("Ask the organism"):** a non-recording policy dry-run tool for the conversational agent. It answers "would X be allowed?" with the checks and their results, writes nothing to `policy_decisions`, and is audited only as a conversation turn.

## Consequences

- **Good:**
  - the owner steers through conversation and intent instead of scattered clicks;
  - operator sessions become optional;
  - learning gains human labels;
  - autonomy grows with evidence.
- **Costs and risks:**
  - a new conversational surface. Mitigated by read-only tools, confirmation, audit, Access identity and prompt-injection rules;
  - model quality. Mitigated by the arena.

## Amendment 2026-11-18: H4, the autonomy dial (the owner's answers)

The owner answered the H4 questions in the platform session on 2026-11-18:

1. **Range ("Hanya turun dari ADR").** The dial only makes an action stricter than its ADR-0009 class. The owner's click lowers a group to any level and raises it back, at most to the group's ceiling: routine actions to "execute on consensus", critical ones to "execute after the owner's click". Raising a critical action to consensus still needs a new ADR and a reviewed guard-path change. Trading never rises above the owner's click (§5).
2. **Per group ("Per kelompok").** Eight groups: deploys, merges into main, rollback and drift, the Platform Registry, agents and engines, policy and doctrine, data/secrets/Access, and trading. Every catalog action is in exactly one group; an action's effective level is the lower of its group's level and its own ceiling.
3. **Raise proposals ("30 eksekusi/14 hari, ≥95%").** A group below its ceiling with at least 30 executions in 14 days, at least 95% of them succeeded and no regression is shown to the owner as ready to rise one level. Only the owner's click raises it.
4. **Auto-downgrade ("Ya, turun satu level").** A regression attributed to a group lowers it one level at once and tells the owner on the Owner page (and in `owner_attention`); only the owner raises it again. A regression is a rollback of a Worker within 2 h after an executed deploy of it (the deploys group), or three failed executions in a row in one group, the latest within 24 h.

The levels mean:

- **observe** and **suggest**: a passed proposal is recorded, not executed and not put to the owner; suggest lists it on the Autonomy page as what the agents would have done.
- **owner_click**: a passed routine action waits in `pending_owner` for the owner's approval click, as a critical one does; the target Workers and the Policy Engine require that click (ADR-0009 amendment of the same day).
- **consensus**: unchanged ADR-0009 behaviour.

With no level set, every group is at its ceiling: the ADR-0009 class decides, as before H4. Directives stay always confirmed by the owner (decision 2); they are not part of the dial for now.

Implementation: `control-plane-shared/src/autonomy-dial.ts` (a guard path), migration 0083 (`autonomy_dial`, `consensus_proposals.autonomy_level`), `ai-kernel/src/autonomy.ts`, the kernel's `GET /v1/autonomy` and `POST /v1/autonomy/{group}` (the owner, phrase `SET <GROUP> <LEVEL>`), and the Console's Autonomy page.

## Amendment 2026-11-19: H3 and H5 (the owner's answers)

The owner accepted every recommended default of `docs/design/HAIC-H3.md` and `docs/design/HAIC-H5.md` on 2026-11-19 ("Setuju semua rekomendasi"), and asked for the owner-only fix of critical approvals at once ("Perbaiki sekarang").

**H3, corrections become knowledge.**
- One ledger in the platform's D1 (`corrections`, contract `correction.v1`): the owner's ratings and corrections on chat turns, council messages, claims and options, and the owner's reject reasons. Nexus sends in; Aether pulls. Telegram is not a correction channel.
- Never refused for its content: secrets redacted, price-like numbers masked as `[level]`, text truncated to 500 characters. A correction carries no parameter and changes no trading parameter, weight, proposal or gate.
- Weight 3 for the owner's ratings and corrections, 1 for the owner's reject reasons, 1 for any actor who is not the owner; it orders and feeds the teaching record and never skips a gate. A correction-derived note goes first in Aether's shadow queue and goes live only on the statistical verdict; the xauusd crowd weight changes only through a shadow replay and an owner PR. Only explicit reject reasons count among implicit signals; a changed rating is a new row that supersedes the old one; the existing chat ratings are backfilled once; no semantic recall (Vectorize) in H3.

**H5, collaborators and roles** (ADR-0011 amendment of the same day).
- The ladder viewer < reviewer < operator < approver account < owner; only the owner approves critical actions (the decision above, now enforced).
- Collaborators chat from their own pool (operators and approver accounts 10 turns a day each, reviewers 5, 20 a day in all) behind their own switch; the owner's 40 turns stay reserved; viewers do not chat; conversations are private to their author.
- Operators may propose a council (trigger kind `collaborator`), which waits until the owner begins it; collaborators never post owner messages, begin, pick or dismiss.
- Comments are for people only and never enter a model prompt; the owner may hide one, never delete it.
- Collaborators teach through the H3 ledger as `reviewer_correction`, on the contract's integer scale: weight 2 against the owner's 3 (the design's "collaborator 0.5 of the owner" expressed on that scale), deduplicated by content hash, never rate-limited; the owner may endorse or dispute.
- Directives (`POST /v1/proposals`) stay the owner's in H5.

Order and status: H3a (contract) and H3b (ledger) built, then H3c–H3d; H3e needs the owner's click. H5b (owner-only critical routes) built; H5c and H5e need the owner's click.

