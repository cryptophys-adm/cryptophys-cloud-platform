# TP-022 approval record

- **First push `b59dcf5`:** the production code was correct, and `STATUS.md` honestly reported `blocked` with 6 failures. Those failures were external-agent test fixtures bound to `signal-analyst`, a kernel-hosted agent the new rule now refuses. The orchestrator posted guidance.
- **PR #127: VALIDATED** at `4180751`. 143 tests pass, 0 skipped; 7 criterion tests; `test_migrations.py` PASS; CI green. Merged as `d1af398`.
  - Fixtures moved to `platform-api` (tier 1, not kernel-hosted).
  - The elevated-agent test uses `deploy.release`, because no tier-2 capability exists. It still proves `external_tier_limit`.
  - Cosmetic leftover: the `SIGNAL_ANALYST_ID` alias and a few comments in `external-agents.test.ts`.
- **Deploy verification**, changed by the orchestrator:
  - the supervisor must be `tier_max == 1`;
  - **no agent may have `tier_max >= 2`**.
- **DEPLOYED AND VERIFIED:** recorded after the Deploy Control Plane run below.
