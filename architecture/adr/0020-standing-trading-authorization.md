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
  - it may close a position, tighten a stop loss, or move a take profit outward once, to TP2;
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

- **The xauusd implementation.** The Nexus page, the arm store, the cap, auto-disarm, the Signal Engine and Omega integration, and the reports above are designed and built in the xauusd repository, as RFC_STRATEGY_RECOMMENDATION, under its own rules and CI. This repository never changes the xauusd repository.
- **The platform's own trading.** Nothing in the platform trades. ADR-0009's rule for platform trading actions (critical, consensus, then one owner click) is not changed.
- **Code.** This ADR changes no code: not the Decision Engine, the risk limits, the capabilities, the consensus rules or any trading path. It records the decision and amends the vision's core.
