# TP-025 approval record

## PR #140 review history

- **Round 1: CHANGES REQUESTED** at `d4a305c`. The server side was correct, but the UI read the wrapped overview (`{ overview: … }`) as if it were flat.
  - Against a realistic overview it showed "Agents: stopped (kill switch)", Drift 0, all report counts 0 and XAUUSD none.
  - Further items: `latest_attention` was counted instead of `latest_critical`, the layout and tiles were missing, dead code remained, the wrangler comment was missing, and `STATUS.md` claimed an `OPERATIONS.md` change that was not in the diff and carried no real output tails.
- **Round 2: CHANGES REQUESTED** at `88bd2f0`.
  - The data was now correct.
  - Still open: the item-1 test only checked a substring, there were two `#refresh` buttons, the navigation and left panel were unchanged, the cards and tiles were unused, the theme differed from the Console, the "no regressions" test was `assert.ok(true)`, and there were no real output tails.
  - The orchestrator had missed the vacuous test in round 1.
- **VALIDATED** at `026d609` and merged as `80610a6`.
  - `summarize()` is a pure function with behavioural tests: realistic, empty, kill switch off, XAUUSD null or error, and persistent drift.
  - There is one Refresh button; `aria-current` is static; the Nexus caption is present; the left panel collapses under 720 px; the cards and tiles are in place; the colours are the Console's; the regression test is real.
  - The orchestrator re-ran the checks: typecheck clean and 179 tests passing. CI was green.
  - **Accepted extra:** a test that runs the exact wrangler dry-run inside `npm test`, offline and with no `.github` change.

## Browser check (orchestrator)

Chromium ran against the real Home Worker with a fake `PLATFORM` binding.

- **1280 px:** left panel; `Agents running · Drift 1 · warning 1 · info 12 · Open recovery proposals 1`; XAUUSD `BUY 0.62` as display only; two tiles.
- **360 px:** the panel becomes a top bar, with no horizontal scroll.
- No JS errors.

## Orchestrator change (#141)

- **Code:** the drifted-service list had no heading and appeared under "Open recovery proposals", so it read as a plan list. It now has a "Drifted services" heading.
- **Deployment wiring:**
  - `cryptophys-home` added to `PLATFORM_WORKERS`;
  - new `deploy-home.yml`;
  - home bundled in validation;
  - ops-dispatch allows `deploy-home.yml`.

## Deployment

- **Provision Access:** run 42136333305 at `2a3a32d`, success.
- **DEPLOYED AND VERIFIED** (orchestrator, 2026-11-06 00:26 UTC): Deploy Cerebrum Home run 42136755156 at `2a3a32d`, success.
  - Health, readiness and the active version were verified through Access.
  - **Smoke tests:**

    | Call | Result |
    |---|---|
    | `/api/whoami` | service token is an operator, not an approver |
    | `/api/platform/v1/overview` | 200 |
    | `/api/kernel/v1/agents` | 404 `not_allowed` |
    | `POST /` | 405 |
    | `POST /api/platform/v1/overview` | 405 |

  - `https://home.cryptophys.work/` without a session is redirected (302) to the Access login of the `cryptophys` team, with the same AUD as the Console.

Phase 1 of ADR-0008 is complete: the Console (TP-023, TP-024) and the Cerebrum home (TP-025). Phase 2 (Nexus inside Cerebrum, behind Access) is an owner action in the xauusd repository.

The worker is done with TP-025.
