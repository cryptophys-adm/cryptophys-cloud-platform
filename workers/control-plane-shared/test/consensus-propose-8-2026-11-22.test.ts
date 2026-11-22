// Owner 2026-11-22: "naikan konsensus per 1 jam, usulan 4 siklus per jam". Merges and deploys shared four consensus
// proposals an hour; on 21 Nov the Console deploy waited a whole hour behind them. The hourly limit of consensus.propose
// is now 8, so each of the Supervisor's four cycles (:07, :22, :37, :52) can propose a deploy and a merge. The Supervisor
// still proposes at most one deploy per cycle, and every proposal still goes through the vote and the Policy Engine.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CAPABILITIES, hourlyLimit } from "../src/capabilities.ts";
import { MAX_DEPLOY_PROPOSALS_PER_CYCLE } from "../../ai-kernel/src/supervisor.ts";
import { readFileSync } from "node:fs";

test("CP1. consensus.propose allows 8 an hour; one deploy proposal per cycle, four cycles an hour", () => {
  assert.equal(hourlyLimit("consensus.propose"), 8);
  assert.equal(CAPABILITIES["consensus.propose"].tier, 1, "still tier 1: voting and the Policy Engine decide");
  assert.equal(MAX_DEPLOY_PROPOSALS_PER_CYCLE, 1);
  const toml = readFileSync(new URL("../../ai-kernel/wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /crons = \["7,22,37,52 \* \* \* \*"\]/, "four Supervisor cycles an hour");
  // A deploy and a merge in each of the four cycles fit in the hour.
  assert.ok(4 * (MAX_DEPLOY_PROPOSALS_PER_CYCLE + 1) <= hourlyLimit("consensus.propose")!);
});
