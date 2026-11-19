# correction.v1: the shared contract of HAIC H3

The contract every side implements for HAIC H3 (`docs/design/HAIC-H3.md` §4): Cerebrum in this repository, Nexus in
`xauusd-ai-trading-assistant` and the conversion in `cryptophys-aether`. This repository never changes the other two;
this folder is what they copy and check against.

- `valid/`: a chat rating, a correction on a council claim, an owner's reject reason, a Nexus rating by an actor who
  is not an owner (weight 1), and a correction whose text had a secret redacted and a price masked.
- `invalid/`: one broken rule per file (a parameter field, a price-like key, a price in a ref or the text, a secret in
  the text, text over 500 characters, a weight that is not the label's, a rating label without a rating, a reject
  reason without its reason, an unknown category or source, a subject that is not an agent, model or seat).
- `index.json`: each file and the error code expected for an invalid one.
- `vectors.json`: inputs with the stored fields and both hashes they must give (`build`), and the only inputs that are
  refused, all structurally empty or carrying a parameter (`refused`).

Cerebrum's functions are `buildCorrection` and `validateCorrection` in `workers/control-plane-shared/src/correction.ts`;
`test/correction-contract-h3a.test.ts` runs them over every file here. The error codes and the hashes are the
contract, the wording of messages is not.

Rules that every side keeps:
- a correction is never refused for its content: secrets are redacted, price-like numbers masked as `[level]`, text
  truncated to 500 characters, an unknown category stored as `other`; each step is flagged in `redactions`;
- a record never carries a parameter, a value to set or a price-like field; a correction changes no trading parameter,
  no weight, no proposal and no gate;
- weight 3 for the owner's ratings and corrections, 1 for the owner's reject reasons, 2 for H5 reviewers and 1 for any
  other actor; it orders and feeds the teaching record and never skips a gate;
- `dedup_sha256` is `sha256(JSON.stringify(["cryptophys.correction-dedup.v1", actor, target.ref, label, rating,
  category, normalizedText, sortedRefs]))`, with whitespace runs collapsed and case kept.
