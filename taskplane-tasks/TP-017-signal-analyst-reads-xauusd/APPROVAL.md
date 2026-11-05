# TP-017 approval record

## PR #103: CHANGES REQUESTED (orchestrator, 2026-11-05)

The full list is in the PR comment. Fix exactly these items, push to the **same branch**, and do not open a new PR:

1. **CI is red: typecheck fails** in `test/agent-memory.test.ts` (line 404). `STATUS.md` claimed "no errors". Report only what you actually observed.
2. **Two tests were disabled with `return;`** in `agent-memory.test.ts`. This is forbidden. Rewrite them for the new Signal Analyst (no AI) and keep the supervisor and auditor parts.
3. **The acceptance tests are missing.** Write one `test()` per criterion, 1–11. The test count fell from 135 to 127, and it must rise.
4. **Make the `observeSignals` timeout injectable** (default 5000 ms), and test `xauusd_timeout`.
5. **Empty but available data:** publish one `warning`, "XAUUSD decisions empty", at most once per 6 h (memory key `last_empty_report_at`). Remove the empty `if` block.
6. **Cleanup:**
   - remove the legacy memory-key reads;
   - remove the unused `recallContextForAgent` import and `SERVICE`;
   - restore a header doc comment.
7. **`ai-diagnostics-tp016.test.ts`:** keep one assertion that uses `draftAuditDigestTask` with `diagnose`.

Before pushing, run `npm run typecheck` and `npm test` and paste their real output tails into `STATUS.md`.
