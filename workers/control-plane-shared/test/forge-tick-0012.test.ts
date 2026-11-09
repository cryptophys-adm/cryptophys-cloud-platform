// The Forge cron tick: the deploy plan, change request checks and main checks are independent steps.
// 2026-11-09 07:04 UTC: a tick recorded nothing at all; one failing step must never stop the others,
// and its failure must be visible in the audit chain, not only in Worker logs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migratedDb } from "./harness.ts";
import { forgeTick } from "../../forge/src/tick.ts";
import type { CheckDeps } from "../../forge/src/checks.ts";

const ROOT = new URL("../../../", import.meta.url);

test("FT1. a failing change request step is audited and does not stop the deploy plan or the main checks", async () => {
  const db = migratedDb();
  const now = new Date().toISOString();
  db.raw.prepare(`INSERT INTO forge_change_requests (cr_id, source, number, branch, source_branch, title, author, head_sha, base_sha, status, changed_paths, critical, created_at, updated_at)
    VALUES ('gh-9', 'github', 9, 'cr/9', 'b', 't', 'a', ?, ?, 'open', '[]', '[]', ?, ?)`).run("a".repeat(40), "b".repeat(40), now, now);
  const repo = { readCommit: async () => { throw new Error("artifacts read failed"); }, readTree: async () => null, readBlob: async () => null, log: async () => [] };
  const deps = async () => ({}) as CheckDeps;
  const steps = await forgeTick({ DB: db as never, ARTIFACTS: { get: async () => repo } }, "platform", deps);
  assert.deepEqual(steps, {
    deploy_plan: { outcome: "no_main" },
    census: { outcome: "no_main" },
    change_checks: { outcome: "failed", error: "artifacts read failed" },
    main_checks: { outcome: "up_to_date" },
  });
  const audit = db.raw.prepare("SELECT subject, outcome, payload_json FROM audit_events WHERE event_type = 'forge.tick_failed'").all().map((r: any) => ({ ...r }));
  assert.deepEqual(audit, [{ subject: "change_checks", outcome: "failed", payload_json: JSON.stringify({ error: "artifacts read failed" }) }]);
  // Without Artifacts or a runner nothing runs and nothing fails.
  assert.deepEqual(await forgeTick({ DB: db as never }, "platform", null), { change_checks: { outcome: "not_configured" }, main_checks: { outcome: "not_configured" } });
  assert.match(readFileSync(new URL("workers/forge/src/worker.ts", ROOT), "utf8"), /await forgeTick\(env, REPO, deps\)/);
});
