// Owner 2026-11-19 (after the deploy of ddfa6d3 was refused at 00:22 on both paths, d1_migrations_mismatch and
// github_main_not_mirrored): a consensus deploy that no path can run is a production problem at once, deploy_no_path,
// with both reasons and the way out, instead of waiting for the 2-hour stall alarm.
import { test } from "node:test";
import assert from "node:assert/strict";
import { migratedDb } from "./harness.ts";
import { NO_PATH_WINDOW_MS, unhandledProblems } from "../../ai-kernel/src/owner-inbox.ts";
import { PROBLEM_KINDS } from "../src/owner-inbox-rank.ts";

const NOW = Date.parse("2026-11-19T00:30:00Z");
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const SHA = "ddfa6d341cd188095d573974ee1382b4e0437dc4";
let n = 0;
function audit(db: ReturnType<typeof migratedDb>, type: string, subject: string, msAgo: number, payload: unknown) {
  n += 1;
  db.raw.prepare("INSERT INTO audit_events (event_id, event_type, actor, subject, outcome, payload_json, previous_hash, event_hash, created_at) VALUES (?, ?, 'test', ?, 'x', ?, ?, ?, ?)")
    .run(`evt_np_${n}`, type, subject, JSON.stringify(payload), `p${n}`, `h${n}`, at(msAgo));
}
const refusal = { commit_sha: SHA, github_gate: "github_main_not_mirrored", native_deploy: { reason: "d1_migrations_mismatch", service: "cryptophys-policy-engine" }, unit: "control-plane", workflow: "deploy-control-plane.yml" };
const items = async (db: ReturnType<typeof migratedDb>, now = NOW) => (await unhandledProblems(db as never, now)).filter((p) => p.code === "deploy_no_path");

test("NP1. a deploy refused on both paths is listed at once with both reasons, once per unit and commit, until a desired version is recorded", async () => {
  const db = migratedDb();
  assert.deepEqual(await items(db), []);
  audit(db, "deployment.no_path", "cryptophys-policy-engine", 8 * MIN, refusal);
  audit(db, "deployment.no_path", "cryptophys-policy-engine", 2 * MIN, refusal);
  const got = await items(db);
  assert.deepEqual(got.map((p) => [p.subject, p.link]), [["no_path:control-plane:ddfa6d341cd1", "#/recovery"]], "one item for the two refusals");
  assert.match(got[0].detail, /d1_migrations_mismatch on .*github_main_not_mirrored/);
  assert.match(got[0].detail, /force_redeploy_unit/);
  assert.deepEqual(PROBLEM_KINDS.deploy_no_path, { urgency: "critical", blocks: ["deploys"] });
  // Another Worker's desired version, or one recorded before the refusal, does not close it.
  audit(db, "registry.desired_version_set", "cryptophys-forge", 1 * MIN, {});
  audit(db, "registry.desired_version_set", "cryptophys-policy-engine", 20 * MIN, {});
  assert.equal((await items(db)).length, 1);
  // A desired version recorded for the refused Worker afterwards (any path deployed it) closes it.
  audit(db, "registry.desired_version_set", "cryptophys-policy-engine", 1 * MIN, {});
  assert.deepEqual(await items(db), []);
});

test("NP2. an old refusal, or a payload without a unit or a full commit, lists nothing", async () => {
  const db = migratedDb();
  audit(db, "deployment.no_path", "cryptophys-policy-engine", NO_PATH_WINDOW_MS + MIN, refusal);
  audit(db, "deployment.no_path", "cryptophys-forge", MIN, { ...refusal, unit: undefined });
  audit(db, "deployment.no_path", "cryptophys-forge", MIN, { ...refusal, commit_sha: "ddfa6d3" });
  assert.deepEqual(await items(db), []);
});
