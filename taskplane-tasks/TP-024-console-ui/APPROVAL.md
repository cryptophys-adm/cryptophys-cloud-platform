# TP-024 approval record

## PR #137 review history

- **First review: CHANGES REQUESTED** at `2d8bc7e`. Five items:
  1. Identifiers were percent-encoded. `@` became `%40`, so the Console server answered `400 invalid_path` and "Remove principal" never worked for an email identity. Reproduced in the browser.
  2. Mission Control read the wrong overview fields, so Drift showed "unknown" and Open recovery showed "none". The PROMPT had omitted the `observe()` shape; that was the orchestrator's omission.
  3. The approve text was wrong.
  4. `maxLength` was dropped.
  5. The export revoked its object URL synchronously.
- **Second review: VALIDATED** at `11eab95` and merged as `7505abb`.
  - All five items are fixed, with a regression test for item 1.
  - **Accepted extras:** a focus trap in the confirm dialog, and the observe button locked for the duration of its request instead of 30 s. The latter resolves a contradiction in the PROMPT.
  - The orchestrator re-ran the checks: typecheck clean, 167 tests pass with 0 skipped, and the dry-run uploads 61.34 KiB. CI was green.
  - `STATUS.md` states honestly who wrote what (agy, pi, a Claude Code session).

## Browser check (orchestrator)

Chromium ran against the real Console Worker with fake bindings, at 1280 px and 360 px.

- 10 screens, no JS errors, no horizontal scroll.
- **A plain operator** sees no Agents ON, Resume, principal or Approve buttons.
- **An approver** sees them.
- The typed confirmation enables the button only on the exact phrase.

## Deployment

**DEPLOYED AND VERIFIED** (orchestrator, 2026-11-05 22:55 UTC): Deploy Console run 42125349774 at `7505abb`, success.
- Health, readiness and the active version were verified through Access.
- The TP-023 smoke tests passed: whoami, forwarding, the allow-list and CSRF.

The worker is done with TP-024.
