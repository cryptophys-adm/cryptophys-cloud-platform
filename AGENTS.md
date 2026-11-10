# Agent instructions

Coding agents working in this repository (for example Antigravity) start with
`taskplane-tasks/ANTIGRAVITY.md`, then `taskplane-tasks/CONTEXT.md`, then the task's `PROMPT.md`.
Never deploy, never merge, never commit secrets, and never touch `.github/workflows/*`.

## Cerebrum Console: measured data only (owner, 2026-11-10)

The Console is an operations instrument, not a mock-up. #267, #269 and #271 put invented numbers into
it (usage, burn, runway, "GROWTH 150%"), a usage "simulator" and a "treasury auto-pay" card; the
owner closed #269 and asked for a real panel instead (#270).

- Every number, status and mode on a Console page comes from an API response
  (`GET /v1/metabolism`, `GET /v1/usage`, the other allow-listed routes). When a value is missing,
  show "—". Never a default number, never a default mode, never a green check for something that is
  not measured.
- No simulation, demo or surge toggles, and no hardcoded metrics.
- No text that claims the platform moves funds, pays bills from trading, or "auto-funds" anything.
  Deal results are read only (ADR-0009: no trading, no funds).
- `workers/control-plane-shared/test/console-truthfulness.test.ts` enforces this in CI. Do not weaken
  or skip it; change the data source instead.
- Agents open pull requests; they do not merge them. The orchestrator (the Claude cloud session)
  reviews and merges, after CI is green.

