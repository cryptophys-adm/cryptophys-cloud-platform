# ADR-0021: The Self-Improvement Protocol: no AI approves what it proposed

- **Status:** Accepted (owner, 2026-11-20: "3. All protocols live", confirmed directly to the platform session; the orchestrator relayed the owner's "setuju" first). It takes effect when this change is merged.
- **Owner direction (2026-11-20):** a permanent protocol, a standing feature and not a one-off, across xauusd (the strategy engine, Omega and the Position Manager) and Aether (knowledge).
- **Builds on:**
  - ADR-0009 (consensus; doctrine amendments inside hard bounds);
  - ADR-0014 (the evolution loop: changes to code go by change request and review);
  - ADR-0016 (the constitution: "never widen trading autonomy without the owner");
  - ADR-0020 (standing trading authorization, and its amendments).

## Context

- xauusd's strategies and knobs, and Aether's knowledge, improve today by proposals that are reviewed one by one. Nothing keeps a record of every candidate, and nothing tests them all the same way.
- A model that proposes a change and also judges it grades its own work. The owner wants the judgement taken away from every proposer.

## Decision

- **The loop.** TRADE → RECORD → EVALUATE → IMPROVE → VALIDATE → DEPLOY, then again, without end.
- **The constitutional rule.** No AI approves a strategy or rule it proposed. Every candidate passes an independent, deterministic validator, and no model call takes part in the verdict.
- **Roles.**
  - Aether and the research agents find weaknesses, form hypotheses and build candidates.
  - The validator decides pass or fail. It is code, not a model.
  - Deploy:
    - a knob change inside `DOCTRINE_BOUNDS` that passes goes live automatically, and rolls back automatically if its live results degrade;
    - a change to code or to a rule goes by change request, the orchestrator's review and the owner's approval;
    - a candidate that fails goes back to research, with the validator's reasons.
- **The owner's controls.**
  - One switch pauses the whole loop.
  - The validator's thresholds are the owner's. Aether may tune them only inside their doctrine bounds.
- **The validator's gates** (the starting values are the owner's):
  - at least 100 simulated fills per candidate and 50 per mode;
  - an out-of-sample profit factor of at least 1.2, and not worse than the live incumbent (a paired test, Holm-corrected);
  - walk-forward: at least 3 of 4 windows positive;
  - parameter sensitivity: no collapse when each parameter moves by 20% either way;
  - real costs: the broker's per-minute spread and the measured fill gap;
  - regimes: no severe loss in any of trend-up, trend-down or range.
- **The registry.** Candidates and versions live in a strategy registry, each with its state (candidate, approved, rejected, retired) and its reasons. Every trade carries its `strategy_id` and version.

## Enforcement

The rule is enforced in code, not only stated:

- **On the platform.** The numeric gates are doctrine facts in `control-plane-shared/src/doctrine.ts` (`validator.*`). Each bound's floor is the owner's starting value, so a tuning can only make the validator stricter, never looser. A value outside its bound is refused by the Cerebrum consensus (`amend_doctrine`), and a change to a bound is the owner's (`amend_constitution`).
- **In xauusd and Aether.** The validator, the registry and the loop are built there, under their own rules and CI, with these tests:
  - the verdict path makes no model call;
  - the agent that built a candidate never records its verdict;
  - a failed gate means a failed candidate.

## Breakglass

- **What it is.** The owner may order a change live on merge, before the validator has judged it. The owner's words are recorded verbatim with the change.
- **What still holds:**
  - every hard guard: the doctrine bounds, the Decision Engine veto, the kill switch, the daily loss limit, and no movement of funds;
  - an automatic floor-drop: when a breakglass change's live results degrade, its learned weights drop to the floor of their bounds without waiting for anyone;
  - a retro-validation: once the validator exists, it judges the change like any candidate. A change that fails goes back to research, and its weights go to their floor.
- **First use.** xauusd's Positioning & Liquidity analyst (2026-11-20). The owner's words, given in the xauusd session: "Sekarang breakglass urgent jadi langsung live". Aether moves its weights inside the hard bounds that the analyst's change sets in `DOCTRINE_BOUNDS`.

## Tamper evidence (owner, 2026-11-20: "4a semuanya")

- **The rule.** The registry entries and validator verdicts are written to a hash-chained log anchored outside D1, and a broken chain blocks auto-deploys until it is verified.
- **xauusd's signal ledger** becomes an append-only, hash-chained `ledger_events` log, on the design of the platform's audit chain (`control-plane-shared/src/audit.ts`).
- **The anchor bucket.** The R2 bucket `cryptophys-ledger-anchors` has a bucket lock rule: every object is kept 3 years (1095 days). In that time no object can be deleted or overwritten, by anyone, the owner included.
- **The daily anchors.** Once per UTC day the Recovery Manager (`recovery-manager/src/anchor.ts`) writes two kinds of anchor:
  - the head of the platform's own `audit_events` chain, after verifying the chain, at `platform/audit_events/<day>.json`. A chain that does not verify is still anchored, with `chain_valid: false`;
  - the head of each xauusd ledger that xauusd publishes as a `ledger_anchor.v1` report (`reports.publish`, kind `xauusd_digest`; body `ledger`, `day`, `head_hash`, `events`), at `xauusd/<ledger>/<day>.json`.
- **Write-only for xauusd.** xauusd gets no binding to the bucket. It can only publish a head, through a grant it already holds, so it can neither read nor delete an anchor, and its external ceiling is unchanged.
- **OpenTimestamps.** Each anchor's SHA-256 is submitted to the public OpenTimestamps calendars (a and b), and each calendar's pending proof is stored next to the anchor as `<key>.<calendar>.ots`. `ots upgrade` later completes a proof against Bitcoin. An upgraded proof is written under a new key, because the lock refuses overwrites.
- **Audit.** Every anchor is audited as `ledger.anchor_written`, with its key, SHA-256 and head. A failure is audited as `ledger.anchor_failed`.
- **What a broken chain blocks.** On the platform, a broken audit chain already blocks every consensus action, auto-deploys included (the evidence `audit_valid`). In xauusd and Aether, a broken ledger blocks the loop's auto-deploys until it is verified.

## Costs

- **CPU.** Backtests and walk-forward runs are scheduled off-peak, so they do not compete with live trading.
- **Model tokens.** Research and candidate building only, under a daily cap. The validator spends none.
- **D1.** Candidates, verdicts and reasons are archived in D1, bounded by retention like every other ledger.
- **R2.** A few kilobytes of anchors and proofs a day, kept 3 years.

## Consequences

- **Good:**
  - every candidate is judged the same way, by code, against the live incumbent and real costs;
  - knob changes inside their bounds go live without an owner click, and roll back by themselves;
  - every trade can be traced to a strategy version.
- **Costs and risks:**
  - a validator that is too strict blocks every improvement. Mitigated by the owner's thresholds and the ceilings of their bounds;
  - a breakglass change runs before it is validated. Mitigated by the hard guards, the floor-drop and the retro-validation.

## What this does not decide

- **The implementation.** The validator, the registry, the loop and the switch are built in xauusd and Aether, as their own RFCs. This repository never changes those repositories.
- **The bounds of the other knobs.** Each learned knob's bounds come with its own change, as for ADR-0020's amendments.
- **The platform's own trading.** Nothing in the platform trades, and ADR-0009's rule for platform trading actions is unchanged.
