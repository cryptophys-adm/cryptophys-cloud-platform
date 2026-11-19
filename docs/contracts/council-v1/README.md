# council.v1: the shared contract of Call for Councils

The contract both sides implement for HAIC H1.5 (`docs/design/HAIC-H0-H1.md` §4.6): Cerebrum in this repository, Nexus in
`xauusd-ai-trading-assistant`. This repository never changes the xauusd repository; this folder is what the Nexus side
copies and checks against.

- `valid/`: a session, a position, a rebuttal, a synthesis and a decision that every implementation must accept.
- `invalid/`: one broken rule per file (a price in an evidence ref, a claim without a ref, a rebuttal that names no
  position, a synthesis without "no change", an option that widens trading autonomy, a decision not chosen by the owner,
  a shadow arm without its window, ...) that every implementation must refuse.
- `index.json`: each file, its kind (`session`, `message`, `decision`) and the error code expected for an invalid one.

Cerebrum's validators are `validateSession`, `validateMessage`, `validateOption` and `validateDecision` in
`workers/control-plane-shared/src/council.ts`; `test/council-contract-h15a.test.ts` runs them over every file here. The
Nexus side runs its own over the same files: the error codes are the contract, the wording of messages is not.

Rules that both sides keep, whatever the implementation:
- a council deliberates and ranks; it never acts, and "no change" is always one of the options;
- every metric claim cites at least one evidence ref `ev:<side>/<source>/<id>[@<as_of>][#<field>]`; a ref never names
  a price field; a claim whose refs do not resolve to its value is `verified: false` and adds no confidence;
- an option that touches a trading capability, raises an autonomy level or adds a capability is refused before ranking;
- the owner picks or dismisses in Cerebrum only (Q6); a pick becomes a `typed_proposal.v1` draft that requires the
  owner's confirmation, a shadow window for a strategy change (Q8: 14 days and 30 directional outcomes), and the owner's
  click to promote.
