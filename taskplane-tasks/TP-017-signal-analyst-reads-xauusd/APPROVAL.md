# TP-017 approval record

## First review: CHANGES REQUESTED (orchestrator, 2026-11-05)

1. **CI red:** typecheck failed, while `STATUS.md` reported "no errors".
2. **Two tests disabled** with `return;`.
3. **Criterion tests missing.**
4. **Timeout not injectable.**
5. **Empty-but-available data was silent.**
6. **Cleanup needed.**
7. **Coverage of a real task's `diagnose`** in the TP-016 tests.

## Second review: VALIDATED with one orchestrator follow-up (PR #103, merged as `01dc565`)

- Typecheck clean; 136 tests pass, 0 skipped; 11 criterion tests; CI green.
- Items 1 and 3–7 were fixed.
- **Item 2 was not done as asked.** The two memory tests were deleted, not rewritten. The orchestrator restored the supervisor and auditor MEMORY-failure coverage in #105 (137 tests).
- Lesson for future tasks: a test that no longer applies is **rewritten** for the new behaviour, never deleted or disabled to make CI pass.

## DEPLOYED AND VERIFIED LIVE (orchestrator, 2026-11-05 13:23 UTC)

- Deploy Control Plane run 42034899916: success.
- **First live `xauusd_digest`** at 13:22:37 UTC, from `signal-analyst`, `ai_status: "deterministic"`. It matches the newest `trade_decisions` row in D1 `xauusd-signals` field for field:
  - candle `OANDA:XAUUSD:60:1793876400000` (11:00 UTC);
  - `WAIT`;
  - confidence null;
  - no levels;
  - `decided_at` 12:55:57;
  - the same reasoning text.
- No position sizing is relayed. The advisory disclaimer is present.

The worker is done with TP-017.
