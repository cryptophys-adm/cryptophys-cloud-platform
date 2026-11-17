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
