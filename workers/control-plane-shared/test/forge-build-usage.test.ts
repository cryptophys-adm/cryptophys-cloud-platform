// Owner 2026-11-12 ("apakah pembatasan sudah sesuai batas free tier build cloudflare?" → "ya kerjakan opsi 2"):
// the Forge measures the account's Workers Builds minutes hourly; the Console and the owner notices read the
// month against the free-tier budget. Measured only: a build without a start and a stop is unmeasured.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OPERATOR_JWT, OUTSIDER_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import forge from "../../forge/src/index.ts";
import { buildUsageTick, measure, USAGE_INTERVAL_MS } from "../../forge/src/build-usage.ts";
import { BUILD_MINUTES_BUDGET, BUILD_MINUTES_INCLUDED, buildUsage, usageStatus } from "../src/build-usage.ts";
import { collectNotices } from "../../ai-kernel/src/owner-notices.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const ACCOUNT = "f".repeat(32);
const TAG_MAIN = "a".repeat(32), TAG_CR = "b".repeat(32), TAG_PLAIN = "c".repeat(32);
const NOW = Date.parse("2026-11-12T09:04:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function build(uuid: string, startMs: number, seconds: number | null, extra: Record<string, unknown> = {}) {
  return {
    build_uuid: uuid, status: seconds === null ? "running" : "stopped", build_outcome: seconds === null ? null : "success",
    created_on: iso(startMs - 5_000), initializing_on: iso(startMs), running_on: iso(startMs + 2_000),
    stopped_on: seconds === null ? null : iso(startMs + seconds * 1000),
    build_trigger_metadata: { branch: "main", commit_hash: "d".repeat(40) }, ...extra,
  };
}

function buildsApi(lists: { main?: unknown[][]; cr?: unknown[]; previews?: unknown[]; previewBuilds?: Record<string, unknown[]> }) {
  const calls: string[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push(url);
    assert.equal((init?.headers as Record<string, string>)?.authorization, "Bearer test-token");
    assert.equal(init?.method ?? "GET", "GET", "the Forge only reads");
    const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result }), { status: 200 });
    const missing = () => new Response(JSON.stringify({ success: false, errors: [{ message: "not found" }] }), { status: 404 });
    if (url.endsWith("/accounts?per_page=5")) return ok([{ id: ACCOUNT }]);
    if (url.endsWith(`/accounts/${ACCOUNT}/workers/scripts`)) return ok([{ id: "cryptophys-forge-typecheck", tag: TAG_MAIN }, { id: "cryptophys-forge-typecheck-cr", tag: TAG_CR }, { id: "cryptophys-policy-engine", tag: TAG_PLAIN }]);
    const page = Number(new URL(url).searchParams.get("page") ?? "1");
    if (url.includes(`/builds/workers/${TAG_MAIN}/builds`)) return ok(lists.main?.[page - 1] ?? []);
    if (url.includes(`/builds/workers/${TAG_CR}/builds`)) return ok(page === 1 ? lists.cr ?? [] : []);
    if (url.includes(`/builds/workers/${TAG_PLAIN}/`)) return missing();
    if (url.endsWith(`/builds/workers/${TAG_MAIN}/previews`)) return ok([]);
    if (url.endsWith(`/builds/workers/${TAG_CR}/previews`)) return ok(lists.previews ?? []);
    const pb = url.match(/\/previews\/([^/]+)\/builds$/);
    if (pb) return ok(lists.previewBuilds?.[pb[1]] ?? []);
    return missing();
  };
  return { calls, fetchImpl };
}

const rows = (db: ReturnType<typeof migratedDb>) => db.raw.prepare("SELECT build_uuid, worker, preview_id, duration_s, billed_minutes, queued_s FROM forge_builds ORDER BY build_uuid").all() as any[];

test("U1. a build's minutes are measured from its start to its stop, rounded up per build; either field spelling", () => {
  const m = measure(build("u-1", NOW - 600_000, 61))!;
  assert.deepEqual([m.duration_s, m.billed_minutes, m.queued_s, m.finished, m.branch], [61, 2, 7, true, "main"]);
  assert.equal(measure(build("u-2", NOW, 5))!.billed_minutes, 1, "a short build still counts one minute");
  const running = measure(build("u-3", NOW, null))!;
  assert.deepEqual([running.finished, running.duration_s, running.billed_minutes], [false, null, null]);
  const camel = measure({ buildUuid: "u-4", status: "failed", buildOutcome: "failure", createdAt: iso(NOW), runningAt: iso(NOW + 1000), stoppedAt: iso(NOW + 121_000), buildTriggerMetadata: { branch: "cr/7", commitHash: "ABC" } })!;
  assert.deepEqual([camel.duration_s, camel.billed_minutes, camel.outcome, camel.commit_sha], [120, 2, "failure", "abc"]);
  const noTimes = measure({ build_uuid: "u-5", status: "stopped", build_outcome: "success" })!;
  assert.deepEqual([noTimes.finished, noTimes.billed_minutes], [true, null], "no start or stop: unmeasured, not guessed");
  assert.equal(measure({ status: "stopped" }), null);
});

test("U2. the hourly collection reads every connected Worker and its Previews, read-only, and pages until a held build", async () => {
  const db = migratedDb();
  assert.deepEqual(await buildUsageTick({ DB: db as never }, NOW), { outcome: "not_configured" });
  db.raw.prepare(`INSERT INTO forge_change_requests (cr_id, source, number, branch, source_branch, title, author, head_sha, base_sha, github_ci, status, changed_paths, critical, created_at, updated_at)
    VALUES ('gh-7', 'github', 7, 'cr/7', 'claude/x', 't', 'o', ?, ?, 'success', 'open', '[]', '[]', ?, ?)`).run("1".repeat(40), "2".repeat(40), iso(NOW - 3_600_000), iso(NOW - 3_600_000));
  const page1 = Array.from({ length: 50 }, (_, i) => build(`m-${String(i).padStart(3, "0")}`, NOW - (i + 1) * 3_600_000, 90));
  const page2 = [build("m-050", NOW - 60 * 3_600_000, 30)];
  const api = buildsApi({ main: [[build("m-run", NOW - 60_000, null), ...page1], page2], cr: [build("c-1", NOW - 7_200_000, 150, { build_trigger_metadata: { branch: "cr/7" } })],
    previews: [{ preview_id: "pv7", branch: "cr/7" }], previewBuilds: { pv7: [build("p-1", NOW - 5_400_000, 100, { build_trigger_metadata: { branch: "cr/7" } })] } });
  const env = { DB: db as never, CF_BUILDS_API_TOKEN: "test-token" };
  const r = await buildUsageTick(env, NOW, api.fetchImpl as never);
  assert.equal(r.outcome, "collected", JSON.stringify(r));
  assert.equal(r.workers, 2, "the Worker not connected to Workers Builds (404) is skipped");
  const stored = rows(db);
  assert.equal(stored.length, 53, "50 + 1 main builds, 1 CR build and 1 Preview build; the running build waits");
  assert.ok(!stored.some((b) => b.build_uuid === "m-run"));
  assert.deepEqual({ ...stored.find((b) => b.build_uuid === "p-1") }, { build_uuid: "p-1", worker: "cryptophys-forge-typecheck-cr", preview_id: "pv7", duration_s: 100, billed_minutes: 2, queued_s: 7 });
  assert.equal((await buildUsageTick(env, NOW + 10 * 60_000, api.fetchImpl as never)).outcome, "not_due");

  // An hour later: the running build has finished; page 1 reaches held builds, so page 2 is not read again.
  const later = buildsApi({ main: [[build("m-run", NOW - 60_000, 200), ...page1], page2], cr: [], previews: [{ preview_id: "pv7", branch: "cr/7" }], previewBuilds: { pv7: [] } });
  const r2 = await buildUsageTick(env, NOW + USAGE_INTERVAL_MS, later.fetchImpl as never);
  assert.deepEqual([r2.outcome, r2.builds_new], ["collected", 1]);
  assert.ok(!later.calls.some((u) => u.includes(`/builds/workers/${TAG_MAIN}/builds`) && u.includes("page=2")));
  assert.equal(rows(db).find((b) => b.build_uuid === "m-run")!.billed_minutes, 4);
  assert.match(read("workers/forge/src/tick.ts"), /step\("build_usage"/);
});

test("U3. the month's total, per Worker, unmeasured builds and the projection against the free-tier budget", async () => {
  const db = migratedDb();
  assert.equal(BUILD_MINUTES_BUDGET, BUILD_MINUTES_INCLUDED.free);
  assert.equal(BUILD_MINUTES_BUDGET, 3000);
  assert.equal((await buildUsage(db as never, NOW))!.status, "no_data", "no collection yet");
  const ins = db.raw.prepare("INSERT INTO forge_builds (build_uuid, worker, created_on, stopped_on, duration_s, billed_minutes, seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  ins.run("a", "cryptophys-forge-typecheck", iso(NOW - 3_600_000), iso(NOW - 3_500_000), 100, 2, iso(NOW));
  ins.run("b", "cryptophys-forge-typecheck", iso(NOW - 7_200_000), iso(NOW - 7_100_000), 150, 3, iso(NOW));
  ins.run("c", "cryptophys-forge-typecheck-cr", iso(NOW - 7_200_000), null, null, null, iso(NOW));
  ins.run("old", "cryptophys-forge-typecheck", "2026-10-30T10:00:00.000Z", "2026-10-30T10:02:00.000Z", 120, 2, iso(NOW));
  db.raw.prepare("INSERT INTO forge_build_collections (collected_at, outcome, workers, builds_seen, builds_new) VALUES (?, 'collected', 2, 4, 4)").run(iso(NOW - 600_000));
  const u = (await buildUsage(db as never, NOW))!;
  assert.deepEqual([u.month, u.minutes, u.builds, u.unmeasured_builds, u.avg_minutes], ["2026-11", 5, 3, 1, 2.5], "October's build is not this month's");
  assert.deepEqual(u.by_worker, [{ worker: "cryptophys-forge-typecheck", builds: 2, minutes: 5, unmeasured: 0 }, { worker: "cryptophys-forge-typecheck-cr", builds: 1, minutes: 0, unmeasured: 1 }]);
  // 5 minutes in 11.38 days → about 13 in 30 days.
  assert.equal(u.projected_minutes, Math.round((5 / ((NOW - Date.parse("2026-11-01T00:00:00Z")) / 86_400_000)) * 30));
  assert.equal(u.status, "ok");
  assert.equal((await buildUsage(db as never, NOW + 4 * 3_600_000))!.status, "stale", "three missed hourly collections");
  assert.deepEqual([usageStatus(100, 2300), usageStatus(100, 2400), usageStatus(2400, null), usageStatus(3000, 3000)], ["ok", "warning", "warning", "over"]);
  assert.equal((await buildUsage(db as never, Date.parse("2026-11-01T06:00:00Z")))!.projected_minutes, null, "no projection on the first day");
});

test("U4. the notice opens when the month's measured or projected minutes reach 80% of the budget and changes once per 10% step; console-only (owner 2026-11-13)", async () => {
  const db = migratedDb();
  const notice = async (now = NOW) => (await collectNotices(db as never, now)).find((n) => n.topic === "build_minutes")!;
  assert.equal((await notice()).active, false);
  db.raw.prepare("INSERT INTO forge_build_collections (collected_at, outcome, workers, builds_seen, builds_new) VALUES (?, 'collected', 2, 1, 1)").run(iso(NOW - 600_000));
  const ins = db.raw.prepare("INSERT INTO forge_builds (build_uuid, worker, created_on, stopped_on, duration_s, billed_minutes, seen_at) VALUES (?, 'cryptophys-forge-typecheck', ?, ?, ?, ?, ?)");
  ins.run("x1", iso(NOW - 86_400_000), iso(NOW - 86_000_000), 60_000, 1000, iso(NOW));
  const quiet = await notice();
  assert.equal(quiet.active, true, "1000 minutes by day 11 projects to about 2600 of 3000");
  assert.match(quiet.title, /near the free-tier budget \(1000\/3000/);
  assert.ok(quiet.lines.some((l) => /about \d+ minutes by the end of the month/.test(l)));
  assert.equal(quiet.link, "https://nexus.cryptophys.work/console/#/code");
  assert.equal(quiet.channel, "console", "owner 2026-11-13: shown in the Console, never emailed or sent to Telegram");
  ins.run("x2", iso(NOW - 3_600_000), iso(NOW - 3_500_000), 60, 1, iso(NOW));
  assert.equal((await notice()).fingerprint, quiet.fingerprint, "one more build in the same 10% step: no new notice event");
  ins.run("x3", iso(NOW - 3_600_000), iso(NOW - 3_500_000), 120_000, 2000, iso(NOW));
  const over = await notice();
  assert.match(over.title, /over the free-tier budget \(3001\/3000/);
  assert.notEqual(over.fingerprint, quiet.fingerprint);
});

test("U5. GET /v1/forge/build-usage for operators, in the Console's read-only allowlist", async () => {
  const db = migratedDb();
  db.raw.prepare("INSERT INTO forge_builds (build_uuid, worker, branch, created_on, stopped_on, duration_s, billed_minutes, seen_at) VALUES ('z', 'cryptophys-forge-typecheck', 'main', ?, ?, 90, 2, ?)").run(iso(Date.now() - 100_000), iso(Date.now() - 10_000), iso(Date.now()));
  const env = baseEnv("cryptophys-forge", db);
  const r = await call(forge, env, req("GET", "/v1/forge/build-usage?limit=5", undefined, OPERATOR_JWT));
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.usage.schema, r.body.usage.minutes, r.body.usage.budget_minutes, r.body.builds[0].build_uuid], ["build-usage.v1", 2, 3000, "z"]);
  assert.equal((await call(forge, env, req("GET", "/v1/forge/build-usage", undefined, OUTSIDER_JWT))).status, 403);
  assert.match(read("workers/console/src/index.ts"), /"\/v1\/forge\/build-usage"/);
  assert.match(read("workers/console/ui/src/pages/Code.tsx"), /<BuildMinutes /);
});
