import { test } from "node:test";
import assert from "node:assert/strict";

test("TP-017 signal analyst module loads", async () => {
  const m = await import("../../ai-kernel/src/signal-analyst.ts");
  assert.ok(m.runSignalCycle);
  assert.ok(m.SIGNAL_ANALYST_ID);
});
