# ADR-0020: Standing trading authorization: arming a strategy is the owner's standing click

- **Status:** Accepted (owner, 2026-11-16: "Ya, benar", confirmed directly to the platform session). It takes effect when this change is merged by `merge_owner_change`: it amends the vision's core (`organism/vision.json`, a guard path, reason `vision_core`).
- **Numbering.** 0018 is held on an unmerged branch (`adr-0018`), and 0019 is reserved (owner-confirmed, not drafted yet). This record is therefore 0020.
- **Owner direction (2026-11-16):** a future xauusd feature, "Strategy Recommendation / Armed". The owner confirmed every point of the Decision below.
- **Builds on:**
  - ADR-0009 (consensus; the amendment of 2026-11-12: trading allowed with the owner's click, fund movement prohibited);
  - ADR-0013 (census and the external ceiling);
  - ADR-0016 (the vision's core and its constitution);
  - ADR-0017 (Human–AI collaboration; its "Approvals" guard).

## Context

- **The core rule.** The constitution's second line read: "Never move funds; a trading action needs the owner's click." Since the ADR-0009 amendment of 2026-11-12 this has meant one owner click per trading execution.
- **A per-trade click does not scale for strategies.** A strategy opens and closes positions when its conditions hold, often several times a day and at hours the owner is not watching. A click per entry and per close either makes the strategy useless (the moment passes before the click) or turns the click into a reflex that no longer means a decision.
- **What the owner actually decides** is whether a given strategy may trade at all, and for how long. That is one decision per strategy, not one per trade.

## Decision

The owner's decision of 2026-11-16, for the xauusd feature "Strategy Recommendation / Armed":

- **Arm and disarm in Nexus.** Each is one click, directly on the xauusd Nexus "Strategy Agents" page, with no confirm step in Cerebrum. Required: the owner-only Access identity, a CSRF check and an audit record. This is an owner-decided exception to the HAIC rule that approvals happen in Cerebrum only. It covers arm and disarm only; council picks and promotions stay in Cerebrum.
- **No shadow prerequisite.** A strategy needs no shadow run before it can be armed.
- **At most 3 strategies armed at once.**
- **Nothing armed means nothing opens.** If no strategy is armed, no positions are opened. *Superseded on 2026-11-17 by Amendment 1 below: with none armed, AUTO selection applies under Omega's live arm.*
- **Auto-disarm** happens on the trading kill switch and on the daily loss limit.
- **The Decision Engine keeps its veto.**
- **What arming does.** An armed strategy is used by the Signal Engine and Omega for entry and close.
- **Constitutional meaning.** Arming is the owner's standing click. It authorises that strategy's entries and closes until it is disarmed, within Decision Engine compliance.
- **Unchanged.** "Never move funds" stays: arming never permits deposits or withdrawals. Leverage and risk limits stay with the Decision Engine and Omega.

The constitution's line now reads: "Never move funds; a trading action needs the owner's click, given per action or as a standing arm of one strategy (at most 3 armed, auto-disarmed on the kill switch or the daily loss limit, Decision Engine veto kept)."

## Amendment 1 (owner, 2026-11-17): AUTO when nothing is armed; the Position Manager only reduces risk

- **Owner's words** (relayed by the orchestrator, confirmed by the owner directly to the platform session on 2026-11-17, "Ya, benar, amandemen"): "jika tidak ada strategy yang di-Armed maka kembali ke asal pakai semua strategy dan wajib memilih strategy terbaik dengan tingkat confidence dan confluence tertinggi. Langsung live."
- **AUTO.** With no strategy armed, Omega's global live arm (`live_armed`, the owner's standing click) authorises AUTO: the engine considers every strategy and may act only on the single best one, ranked by measured agent confidence × confluence. The minimum confidence and confluence thresholds, and every other entry rule, are unchanged; below them nothing opens.
- **One to three armed.** Only the armed strategies are eligible, as decided on 2026-11-16. AUTO does not apply.
- **Omega's live arm off** means nothing opens, armed or not. Turning it on or off is the owner's click.
- **The 5-minute Position Manager** (xauusd #412) acts on open positions under the same standing arm, and only to reduce risk:
  - it may close a position, tighten a stop loss, or move a take profit outward once, to TP2 (Amendment 4 of 2026-11-18 allows further moves once the stop locks a profit, and partial closes);
  - it never opens, adds to, reverses or hedges a position, and never widens a stop loss.
- **Kept:** the Decision Engine veto; auto-disarm on the trading kill switch and on the daily loss limit, which also stops AUTO and switches Omega's live arm off until the owner turns it on again; no fund movement, ever; the xauusd external ceiling and the platform's trading capability rules unchanged.
- **The constitution's line now reads:** "Never move funds; a trading action needs the owner's click, given per action or as a standing arm of one strategy (at most 3 armed) or, with none armed, as Omega's live arm for AUTO selection of the single best strategy by measured confidence and confluence; auto-disarm on the kill switch or the daily loss limit, Decision Engine veto kept."
- **Recording (recommended to xauusd):** the `strategy_arm.v1` digest also carries `mode` (`auto` or `armed`), and each AUTO pick names the chosen strategy with its measured confidence and confluence, so that the owner inbox and the audit chain can see why a strategy traded.
- **Order of events.** xauusd #413 turned AUTO on live (`STRATEGY_ARM_MODE=live`) before this amendment was merged. From its merge, the constitution covers it.

## Amendment 2 (owner, 2026-11-17): Council auto-arm

- **Owner's words** (relayed by the orchestrator, confirmed by the owner directly to the platform session on 2026-11-17, "Ya, benar, amandemen"): "council boleh langsung arm/disarm otomatis jika owner mengaktifkan mode auto."
- **The toggle.** "Council auto-arm" (`STRATEGY_COUNCIL_ARM`, `off` or `on`) is owner-only, default `off`, and switched only by the owner in Nexus under the same identity, CSRF and audit rules as arm and disarm. Switching it on is the owner's standing click that authorises the xauusd strategy council to arm and disarm strategies itself, within the gates below; switching it off ends that authority at once.
- **Off:** the council's daily verdicts (walk-forward and proposal) are suggestions only; arm and disarm stay the owner's click.
- **On, within these gates:**
  - the council arms a strategy only on a passing walk-forward gate;
  - at most 3 strategies are armed at once, the same cap as for the owner;
  - at most one change per strategy per UTC day, with hysteresis;
  - an auto-disarm on the kill switch or the daily loss limit overrides the council, and the council cannot re-arm before the next UTC day;
  - the owner's own arm or disarm always wins and pins that strategy against the council;
  - on any council failure, nothing changes;
  - every council action is audited with actor `council`, sent to the owner on Telegram, and recorded in `strategy_arm.v1` with `council_auto`.
- **Unchanged:** funds are never moved; the Decision Engine veto; the risk-only Position Manager; the Entry and Stop Grid acts only before an order is placed, never on an open position's stop; auto-disarm; AUTO under Omega's live arm when nothing is armed (Amendment 1); the xauusd external ceiling and the platform's trading capability rules.
- **The constitution's line now reads:** "Never move funds; a trading action needs the owner's click, given per action or as a standing arm of one strategy (at most 3 armed, by the owner or, while the owner's Council auto-arm is on, by the council within its gates) or, with none armed, as Omega's live arm for AUTO selection of the single best strategy by measured confidence and confluence; auto-disarm on the kill switch or the daily loss limit, Decision Engine veto kept."
- **Order of events.** xauusd builds the toggle with its default `off` until this amendment is merged.

## Amendment 3 (owner, 2026-11-18): account risk profiles; an autonomous profile upgrade rests on an owner-set ceiling

- **Origin.** The owner approved the xauusd RFC "Account Profiles & Dynamic Mode" (relayed by the orchestrator). The platform session's reading check found one point that changes who decides: the profile agent raising an account's profile on its own. The owner confirmed this amendment directly to the platform session on 2026-11-18 ("Ya, tulis Amendment 3").
- **Needs no amendment.** These stay within "leverage and risk limits stay with the Decision Engine and Omega":
  - per-account risk profiles Safe, Conservative and Aggressive, with per-trade hard caps of 2%, 5% and 10% of the account;
  - sizing from the stop loss, using the broker specification the EA reports, with nothing hard-coded to a broker;
  - the scalp, intraday and swing mode selector, gated on measured evidence like the Entry and Stop Grid's adaptation;
  - the Position Manager's thresholds expressed in R. It stays risk-only (Amendment 1).
  - None of these changes who may open a trade. The Decision Engine's gates are the same for every profile, and the owner's arm, Council auto-arm (Amendment 2) and AUTO (Amendment 1) keep exactly their authority.
- **Downgrade.** The profile agent may move an account to a lower profile at any time, on its own. A downgrade only reduces risk, like a disarm, and nothing may block or delay it. Amendment 5 narrows this for soft triggers only: a bounded council review may veto one.
- **Upgrade.** An autonomous upgrade raises an account's per-trade risk cap without a per-change owner click. It therefore rests on a standing click, as the council's arm does in Amendment 2:
  - **The ceiling is the owner's.** The highest profile the agent may reach is set only by the owner, under the owner-only Access identity, CSRF check and audit record that arm and disarm require. Another user's approval never raises an account above that ceiling. Until the owner sets a ceiling above an account's current profile, the agent does not upgrade it.
  - **Never mid-trade.** An upgrade is never applied while the account has an open position or a pending order.
  - **One step at a time.** Safe to Conservative, or Conservative to Aggressive, and only on passing evidence. Missing evidence or any failure of the profile agent raises nothing.
  - **The kill switch and the daily loss limit** return the account to Safe. No autonomous upgrade follows before the next UTC day.
  - **Lowering the ceiling** takes effect at once: an account above the new ceiling is downgraded to it.
- **Recording.** Every profile change is audited in xauusd and sent to the owner on Telegram, whoever made it: the agent, a user or the owner. xauusd mirrors it to the platform (recommended) as an `xauusd_digest` report over `reports.publish`, as for arm and disarm above:
  - `body.schema` is `risk_profile.v1`, with an opaque account reference (never the broker account number), `from`, `to`, the actor, the reason, an evidence reference and the time;
  - `severity` is `info`, or `warning` for a downgrade forced by the kill switch or the daily loss limit, never `critical`;
  - no price level, lot size or imperative (§3 rule 1).
- **Unchanged:**
  - funds are never moved;
  - the Decision Engine veto;
  - the risk-only Position Manager;
  - auto-disarm;
  - the xauusd external ceiling and the platform's trading capability rules.
- **The constitution's line is unchanged.** A profile sets how much a trade may risk, not who may open it, so `organism/vision.json` is not amended.
- **Order of events.** Until this amendment is merged, an upgrade is the owner's click only. Autonomous downgrades may run from the start.

## Amendment 4 (owner, 2026-11-18): the Position Manager's take-profit ladder and partial closes

- **Origin.** The owner decided on a live take-profit ladder with progressive partial profit-taking for the xauusd Position Manager ("a, langsung live, termasuk agent juga bisa dinamis mengatur TP sebagian secara progresive"; relayed by the orchestrator). The owner confirmed it directly to the platform session on 2026-11-18 ("Ya, benar, tulis Amendment 4"). It replaces Amendment 1's "move a take profit outward once, to TP2". The owner then extended it to every mode, Scalp included (relayed by the orchestrator; confirmed directly to the platform session on 2026-11-18, "Ya, semua mode").
- **Take profit outward, more than once.** The Position Manager may move a position's take profit outward again and again, but only while its stop loss already locks a profit: the stop sits at TP1, or further in the trade's favour. From then on no move can turn the position into a loss. Before that lock, Amendment 1's single move to TP2 still applies.
- **Partial closes.** At a take-profit level the Position Manager may close a bounded part of the position (xauusd sets the fraction, for example 25–50%). A partial close only reduces risk. The part closed and the part left open follow the broker's `volume_step`, the part left open is never below the broker's `volume_min`, and nothing is added or reopened. A position too small to split (for example 0.01 lots at a `volume_min` of 0.01) gets the stop lock only.
- **The ladder** (xauusd's design, for the record): when price passes TPx by the configured distance, the stop is locked to TPx−1, and the take profit moves outward to TPx+1 if momentum holds; otherwise the position is closed, wholly or in part. Every mode uses it: Scalp, Intraday and Swing. The distances and fractions are xauusd parameters, within the rules above.
- **Unchanged:**
  - the stop loss only tightens: never widened;
  - the Position Manager never opens, adds to, reverses or hedges a position;
  - the Decision Engine veto, auto-disarm, and Omega's live arm;
  - funds are never moved;
  - the xauusd external ceiling and the platform's trading capability rules.
- **The constitution's line is unchanged.** These are risk rules of the Position Manager under the existing standing arm, not a new trading authority.
- **Order of events.** xauusd builds the stop lock and the partial closes now (both already within Amendment 1). The multi-step take-profit moves go live after this amendment is merged.

## Amendment 5 (owner, 2026-11-18): a bounded council veto on soft-trigger profile downgrades

- **Origin.** The owner chose "Council boleh menolak" for the xauusd profile agent's downgrades (relayed by the orchestrator), knowingly narrowing Amendment 3's "nothing may block or delay it" for soft triggers only. The owner confirmed it directly to the platform session on 2026-11-18 ("Ya, tulis Amendment 5"), after being told that it weakens Amendment 3's protection.
- **Soft triggers.** A drawdown of 20% or more from the account's drawdown reference (`dd_ref`), 4 losses in a row, or an extreme ATR.
- **The review.** On a soft trigger the profile agent convenes the council once per trigger episode. The review is capped at about 2 minutes.
- **The veto.** A `keep` verdict vetoes that downgrade. The veto holds for at most 24 hours, and ends at once if the trigger worsens: a drawdown of 25% or more, or 6 losses in a row. The downgrade then applies without the council, and no second review follows in the same episode.
- **Fail-safe.** A council failure, an invalid verdict or a timeout means the downgrade applies.
- **Never vetoable.** The kill switch and the daily loss limit still return the account to Safe at once (Amendment 3). Nothing in this amendment blocks or delays them, a disarm, or a downgrade from lowering the owner's ceiling.
- **Recording.** Every veto is audited in xauusd, sent to the owner on Telegram, and mirrored as a `risk_profile.v1` `xauusd_digest` report at severity `warning`, with the trigger, the verdict, the evidence reference and when the veto ends (§3 rule 1 holds: no price level, lot size or imperative).
- **Unchanged:** upgrades (Amendment 3: the owner's ceiling, never mid-trade, one step at a time); funds are never moved; the Decision Engine veto; the risk-only Position Manager; auto-disarm; the xauusd external ceiling and the platform's trading capability rules. The constitution's line is unchanged.
- **Order of events.** xauusd builds it behind `OMEGA_PROFILE_COUNCIL_DOWNGRADE`, default `off`, and turns it on only after this amendment is merged. Until then every downgrade applies as Amendment 3 says.

## Guards

- **Funds are never moved.** Arming authorises entries and closes only. No deposit, withdrawal, transfer or wallet action, at any tier, armed or not.
- **The Decision Engine veto stays.** An armed strategy's entry or close that the Decision Engine refuses does not happen. Arming adds no path around it, and leverage and risk limits stay with the Decision Engine and Omega.
- **The cap of 3.** A fourth arm is refused while 3 are armed; the owner disarms one first.
- **Auto-disarm.** The trading kill switch and the daily loss limit disarm every armed strategy. Re-arming after either is a new owner click.
- **Owner-only identity, CSRF and audit for arm and disarm.** Each click is accepted only from the owner's Cloudflare Access identity, passes a CSRF check, and writes an audit record (who, which strategy, arm or disarm, the reason, when). A click without all three is refused.
- **No widening of platform rules.** Arming never widens the xauusd external ceiling (`organism.ts` `EXTERNAL_CEILING`: tier 1, `signals.observe`, `reports.publish`, `memory.recall`, `memory.remember`) or the platform's trading capability rules (ADR-0009: a platform trading action is critical, a trading capability is tier 2 or above and privileged). This ADR changes neither the Decision Engine, the risk limits, the capabilities nor the consensus rules.
- **Disarm always works,** including while the brake or the kill switch is on. Nothing may block or delay a disarm.

## Consequences

- **Good:**
  - a strategy can trade at the moment its conditions hold, within an authorization the owner gave on purpose;
  - the owner's click keeps its meaning: one decision per strategy, revocable at any time with one click;
  - the default is safe: Omega's live arm off, nothing opens; the kill switch and the daily loss limit disarm everything and stop AUTO (Amendment 1 replaced "nothing armed, nothing opens").
- **Costs and risks:**
  - between arm and disarm, entries and closes happen without a per-trade click. Mitigated by the cap of 3, auto-disarm, the Decision Engine veto, and the audit record of every arm and disarm;
  - no shadow run is required, so a strategy can be armed before it has a track record. This is the owner's choice; the Decision Engine and the risk limits still apply to every trade;
  - one more approval surface outside Cerebrum (below). Mitigated by its narrow scope and by the identity, CSRF and audit requirements.

## The HAIC Q6 exception (ADR-0017 "Approvals")

- ADR-0017's guard says approvals happen only by a click in Cerebrum, under the owner's Access identity. The owner made one exception: **arm and disarm** of an xauusd strategy happen by one click on the Nexus "Strategy Agents" page, with no confirm step in Cerebrum.
- The exception covers arm and disarm only. Council picks, promotions, critical consensus actions, `merge_owner_change` and every other approval stay in Cerebrum. Telegram and chat still approve nothing.

## Platform-side recording (recommended to xauusd)

- **Recommendation.** xauusd publishes each arm and disarm as one `reports.publish` report of kind `xauusd_digest` over its existing `AGENTS` binding (`docs/XAUUSD-INTEGRATION.md` §2), so the platform's audit chain records it and the owner's inbox can show it. No new grant, report kind, binding or migration is needed.
- **Shape** (subject at most 200 characters, body a JSON object of at most 16 KiB):

  ```ts
  await env.AGENTS.syscall("<an xauusd agent with reports.publish>", "reports.publish", {
    kind: "xauusd_digest", severity: "info", subject: "strategy.disarmed <strategy_id> (daily_loss_limit)", ai_status: "deterministic",
    body: { schema: "strategy_arm.v1", event: "strategy.disarmed", strategy_id: "<id>", reason: "daily_loss_limit", armed_count: 0, at: "<ISO time>", audit_ref: "<xauusd audit id>" },
  });
  ```

  - `event` is `strategy.armed` or `strategy.disarmed`. A disarm carries `reason`: `owner`, `kill_switch` or `daily_loss_limit`.
  - `severity` is `info` for an owner's arm or disarm and `warning` for an auto-disarm. **Never `critical`**: a critical report is for real failures only and counts toward the consensus brake (§3 rule 3, §6).
  - No price level, lot size, `position_size_pct` or imperative, as for every xauusd report (§3 rule 1).
- **Within the existing limit.** `reports.publish` allows 4 reports per hour per agent. Arms and disarms are owner clicks or rare auto-disarms; when several fall in one hour (an auto-disarm of 3 strategies), they go in one report whose body lists them.
- **Non-fatal and not authoritative.** The xauusd audit record is the authority. The platform report is a mirror: a denied or failed publish (for example `failed: agents_enabled` while the platform's kill switch is off) never blocks an arm or a disarm, and is not retried in a loop (§3 rule 5); a later report may list the events that were not recorded.
- **Where it shows today.** Every report is chained into the platform's audit ledger and stored in `agent_reports`. The Console's Owner page shows only open critical reports, and the "Needs you" inbox (ADR-0017 H0) is not built yet, so an arm record appears there only once H0 lists informational xauusd items.

## What this does not decide

- **The xauusd implementation.** The Nexus page, the arm store, the cap, auto-disarm, the Signal Engine and Omega integration, and the reports above are designed and built in the xauusd repository, as RFC_STRATEGY_RECOMMENDATION, under its own rules and CI. The same holds for the account profiles, the profile agent and the mode selector of Amendment 3 (RFC "Account Profiles & Dynamic Mode"). This repository never changes the xauusd repository.
- **The platform's own trading.** Nothing in the platform trades. ADR-0009's rule for platform trading actions (critical, consensus, then one owner click) is not changed.
- **Code.** This ADR changes no code: not the Decision Engine, the risk limits, the capabilities, the consensus rules or any trading path. It records the decision and amends the vision's core.
