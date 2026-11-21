# Agent instructions

**Read first (2026-11-21).** The canonical repository is `cryptophys/platform` on Cloudflare Artifacts; any other copy (GitHub included) is a mirror that may be days behind. Read `docs/SSOT.md` before acting on any other document. Never deploy from a checkout: no `wrangler deploy`, `wrangler versions upload` or `wrangler secret put` against a platform Worker. Deploys go by consensus through the Deployment Orchestrator or by the owner's break-glass plan; a code upload from anywhere else is an out-of-band deploy and is raised to the owner.

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
  Deal results are read only. ADR-0009 (amended 2026-11-12): no fund movement, ever; a trading action needs the owner's click,
  given per action or, since ADR-0020 (2026-11-16), as a standing arm of one xauusd strategy, or, with none armed,
  as Omega's live arm for AUTO selection of the single best strategy (ADR-0020 amendment 1, 2026-11-17); while the owner's
  Council auto-arm is on, the council may arm and disarm within its gates (ADR-0020 amendment 2, 2026-11-17); an xauusd
  profile agent may raise an account's risk profile only up to the owner's ceiling, never mid-trade (ADR-0020 amendment 3, 2026-11-18);
  the Position Manager may ladder the take profit and close part of a position only once the stop locks a profit (amendment 4);
  a council may veto a soft-trigger profile downgrade for at most 24 h, failing safe, never the kill switch or daily loss limit (amendment 5).
- `workers/control-plane-shared/test/console-truthfulness.test.ts` enforces this in CI. Do not weaken
  or skip it; change the data source instead.
- Agents open pull requests; they do not merge them. The orchestrator (the Claude cloud session)
  reviews and merges, after CI is green.

## After the GitHub cut-over (ADR-0012 G6, migration 0058, 2026-11-13)

The canonical repository is `cryptophys/platform` on Cloudflare Artifacts; GitHub merges nothing.

- Push a branch named `claude/…`, `agent/…` or `cr/…` to the work repository `cryptophys/platform-work`,
  based on the current canonical `main`. The Forge registers it as change request `fg-<slug>`, copies its head
  to `cr/<cr_id>` of `platform` for the type-check, and runs the same checks as before.
- Nobody merges by hand. When every check passes, the Supervisor proposes `merge_change` and the council votes;
  a change that touches a guard path (`control-plane-shared/src/guard-paths.ts`) is `merge_owner_change` and
  waits for the owner's click. The Forge fast-forwards `main`; the agents then deploy it as before.
- A branch that does not contain the current `main` is `blocked` until it is rebased or merged with `main`.
- Rebase onto `main`, or merge with `main` as the FIRST parent; `git merge main` on the branch (main as the second parent) is refused as `main_not_first_parent` (incident 2026-11-14, `docs/SSOT.md`).

