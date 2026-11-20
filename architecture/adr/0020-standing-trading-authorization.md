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

## Amendment 6 (owner, 2026-11-19): TP2 before the TP1 lock, with the stop at break-even

- **Origin.** The owner chose the break-even option for the Position Manager's outward take profit ("Merge #490 + kerjakan opsi BE", given to the xauusd session and relayed by the orchestrator). The owner confirmed it directly to the platform session on 2026-11-19 ("Yes, write Amendment 6"), after being told that the worst case of such a position becomes about zero instead of the TP1 profit.
- **Why.** xauusd's ladder (Amendment 4) sends the outward take profit, the Position Manager's TP2, only once the stop locks TP1. From the ladder's start (2026-11-18 08:38 UTC) to 2026-11-19, 8 Omega positions reached no TP1 lock (only the earlier lock at TP0, 5 times), so TP2 never reached the broker: Scalp targets lie a few dollars from the entry and are hit before a TP1 lock can happen.
- **The rule.** Under the TP ladder an outward take-profit may also be sent before the TP1 lock when the Position Manager's council approves it (momentum not weakening, thesis intact), the position is in profit, and the same modification moves the stop to break-even plus the spread or better (never below the entry); a broker that refuses the stop leaves both unchanged.
- **Relation to Amendments 1 and 4.** It adds a path; it removes none. Amendment 4's ladder from the TP1 lock onwards, and its other rules, are unchanged.
- **One modification.** The take profit and the stop are sent together. The take profit never moves outward on its own before the TP1 lock: either both change or neither does.
- **The trade-off, as the owner accepted it.** Once the stop sits at break-even plus the spread, the position can no longer end in a loss, but its worst case is about zero, where after a TP1 lock it was the TP1 profit. From the TP1 lock onwards, Amendment 4 applies as before.
- **Unchanged:**
  - the stop loss only tightens: never widened, and never below the entry under this amendment;
  - the Position Manager never opens, adds to, reverses or hedges a position;
  - the Decision Engine veto, auto-disarm, and Omega's live arm;
  - funds are never moved;
  - the xauusd external ceiling and the platform's trading capability rules.
- **The constitution's line is unchanged.** This is a risk rule of the Position Manager under the existing standing arm, not a new trading authority.
- **Order of events.** xauusd's change that implements it waits until this amendment is merged.

## Amendment 7 (owner, 2026-11-20): resting limit entries, held by the council

- **Origin.** The owner decided that Omega may enter by a resting limit order, held by the council, with every knob learned per mode inside doctrine bounds (xauusd RFC_OMEGA_LIMIT_ENTRY, xauusd #496 and #497, relayed by the orchestrator). The owner confirmed it directly to the platform session on 2026-11-20 ("setuju", then "keduanya" for both Amendments 7 and 8).
- **What a resting entry is.** An entry of the arm that waits at a price instead of filling at once: the same strategy, plan, stop, take profit and size the Decision Engine approved for a market entry, placed as a limit order. It is an entry under this ADR, not a new authority.
- **Where it rests.** The limit sits between the current price and the plan's entry side, no further from the current ask or bid than `omega.limit_band_<mode>` times the plan's |entry − stop| (at most 0.6). The stop and take profit are those of the plan, so the risk of a fill is the plan's risk, never more.
- **How long.** It is deleted after `omega.limit_life_min_<mode>` minutes from placement (at most 60 Scalp, 240 Intraday, 720 Swing, 240 Range) if it has not filled.
- **Moves.** While it rests it may be moved only toward the current price, by at most `omega.limit_move_max_atr_<mode>` times ATR(14) of closed 15m bars in total (at most 0.5), and always with its stop and take profit moved by the same amount, so the plan's distances and risk are unchanged. It is never moved away from the price and never widened.
- **Cancels.** The council cancels it when the order side's share of the Decision Engine's weighted witness quorum falls by `omega.limit_cancel_share_drop_<mode>` (0.03 to 0.10) from the placing decision, and always on any of: a disarm or auto-disarm of the strategy, the trading kill switch, the daily loss limit, a Decision Engine veto, or a profile downgrade to Safe. A broker that refuses a cancel is retried; while it stands the strategy places nothing new.
- **Market or limit, per signal (xauusd stage 3, owner 2026-11-20).** With xauusd's `entry_order` set to `council` by the owner (the default stays `market`), the entry council chooses per signal between a market entry, a resting limit or no entry, each with a measured reason; a silent council means a market entry, as before. A resting limit may be converted once per signal into a market entry: the limit is cancelled first (the market entry waits until the broker reports the order gone, and a fill in the meantime ends the conversion), and the market entry is a market entry like any other: it passes every gate a market entry passes, its stop is the market path's own (which, as for every market entry, may be wider than the plan's, for example the adaptive stop), and its volume is computed afresh from that stop, so the money at risk at the stop is never more than the plan's (`risk_pct` of equity, under the same caps). "Risk" in this amendment means that money at the stop, not the stop distance. No new kind of entry: both are entries this ADR already authorises.
- **Counts.** A resting entry counts as an open position for the cap of 3 armed strategies and for Omega's `omega.max_positions`, so resting orders never add exposure beyond what market entries could.
- **Learning.** The four knobs are doctrine facts per trading mode with the bounds above (`control-plane-shared/src/doctrine.ts`); the council and the learning protocol tune them inside the bounds, and an amendment of a bound is the owner's.
- **Unchanged:**
  - the Decision Engine veto and its limits, leverage and risk;
  - the risk-only Position Manager once a position is open (Amendments 1, 4 and 6);
  - auto-disarm, Omega's live arm and the cap of 3;
  - funds are never moved;
  - the xauusd external ceiling and the platform's trading capability rules.
- **The constitution's line is unchanged.** A resting entry is an entry under the existing standing arm.
- **Order of events.** xauusd keeps `LIMIT_ENTRY_AVAILABLE` false until this amendment and the doctrine bounds are merged.

## Amendment 8 (owner, 2026-11-20): a bounded loosening of an open position's stop, by the council

- **Origin.** The owner approved that the Position Manager's council may move a take profit either way and may loosen a stop within strict bounds ("setuju", given in xauusd and relayed by the orchestrator). The owner confirmed it directly to the platform session on 2026-11-20 ("setuju", then "keduanya" for both Amendments 7 and 8), after being told that it narrows Amendment 1's "never widens a stop loss" and the "stop loss only tightens" of Amendments 4 and 6.
- **For open positions only.** It narrows those rules for an open position as below. Resting entries (Amendment 7) are unchanged: never moved away from the price, never widened.
- **Take profit.** The council may move a take profit outward or inward. A take profit moved further never comes in the same modification as a looser stop.
- **How far a stop may loosen.**
  - Never beyond the position's original entry stop, so its money at risk stays at most the 1R sized at entry.
  - A stop that was tightened may move back toward the original stop, never past it, and only with a measured reason: an ATR expansion, a key level just outside the stop, or a scheduled high-impact release.
  - A stop at break-even or better never moves back into loss.
- **How often and by whom.** At most one loosening per position, by the council's consensus. Nothing loosens mechanically, and a silent council changes nothing.
- **Accounting.** After a loosening the position counts as unprotected again, and its risk at the new stop counts in the daily loss budget. The loosening is refused if the budget would not hold.
- **Learning.** The knobs (the ATR-expansion threshold, how far back toward the original stop) become doctrine facts per trading mode, with units and bounds proposed by xauusd, in `control-plane-shared/src/doctrine.ts`. An amendment of a bound is the owner's.
- **Unchanged:**
  - the Position Manager never opens, adds to, reverses or hedges a position;
  - no stop is ever moved beyond the original entry stop;
  - the Decision Engine veto, auto-disarm, Omega's live arm, the daily loss limit and the kill switch;
  - funds are never moved;
  - the xauusd external ceiling and the platform's trading capability rules.
- **The constitution's line is unchanged.** "Never widen trading autonomy without the owner": this widening is the owner's.
- **Order of events.** xauusd ships it behind a switch that is off by default, and turns it on only after this amendment is merged.

## Amendment 9 (owner, 2026-11-20): WAIT-with-bias entries, past the quorum share only

- **Origin.** xauusd proposed it (the WAIT-with-bias entry), and the owner confirmed its scope in the xauusd session. The owner then confirmed it directly to the platform session on 2026-11-20, choosing both the bias-side entry and the learned counter-bias multipliers ("1.b"). He was told first that it enters past one refusal of the Decision Engine, the quorum share, which Amendment 1's "every other entry rule" and the Guards' "arming adds no path around it" otherwise keep closed. The measured case, 18–20 Nov: bias-side plans PF 5.03, counter-bias plans PF 0.37.
- **When.** The 15m Decision Engine's stance is WAIT and its bias is BULLISH or BEARISH.
- **What may enter.**
  - One live strategy-agent plan on the bias side: the one with the best score, where the score is the agent's confidence on that side (0–1) times confluence (0–1).
  - Confluence is the mean of three parts: the plan's at_level flag; the Key Level Agent's lean toward the bias side, scaled to 0–1; and D1/H4/H1 room agreement.
  - The score must reach `omega.wait_bias_min_score_<mode>`.
- **What it must pass.**
  - Every guardrail of that side except the quorum share. A Decision Engine veto still blocks it.
  - TP1's RRR meets the mode's minimum on its own.
  - The entry council (Amendment 7) agrees and gives a measured reason. A silent council means no entry.
- **Size.** The smaller of Safe and the active profile.
- **Counter-bias plans.**
  - Blocked while the learned multiplier `omega.wait_bias_counter_<agent>_<mode>` is 0, its start value.
  - With a multiplier w above 0, agent A's counter-bias plan becomes a candidate with the score w × confidence × confluence, on its own side. It must still reach the minimum score and pass every gate above, so w = 0.5 needs twice the confidence × confluence of a bias-side plan. Its size is unchanged.
  - Only xauusd's tuning proposes w, from the counter-bias shadow: at least 200 discovery and 100 holdout fills, a bootstrap lower bound on mean R above 0, and Holm across cells. Aether sets it inside its bound; xauusd only reads it.
  - Scalp's bound is 0–0, so scalp never opens a counter-bias plan.
- **Bounds.** 56 doctrine facts in `control-plane-shared/src/doctrine.ts`, one per mode, and per strategy agent for the multiplier:
  - `omega.wait_bias_min_score_<mode>`: 0.20–0.60, start 0.30. Scalp has the fact, but xauusd does not read it for scalp until a later change (scalp's minimum RRR is 0).
  - `omega.wait_bias_counter_<agent>_<mode>`: 0–0.5 for intraday, swing and range, and 0–0 for scalp; start 0. The 13 agents are xauusd's STRATEGY_AGENTS: zone_pullback, sweep_reversal, breakout_retest, range_fade, pattern_peaks, pattern_lines, pattern_curve, pattern_bars, pattern_pole, pattern_gaps, pattern_legs, pattern_event, pattern_inside.
  - An amendment of a bound is the owner's.
- **Counts.** A WAIT-with-bias entry is an entry like any other: it counts for the cap of 3, `omega.max_positions` and the daily loss budget.
- **Unchanged:**
  - the Decision Engine veto and every guardrail other than the quorum share;
  - auto-disarm, Omega's live arm, the daily loss limit and the kill switch;
  - funds are never moved;
  - the xauusd external ceiling and the platform's trading capability rules.
- **The constitution's line is unchanged.** "Never widen trading autonomy without the owner": this widening is the owner's.
- **Order of events.** Stage 1 only measures (the ledger policy and the report to Aether, no live entries) and needs no amendment. Stage 2 enters live behind the owner's switch `wait_bias_entry`, off by default, and only after this amendment is merged.

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
