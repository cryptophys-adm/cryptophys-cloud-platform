// ADR-0016 (Telos) T0, accepted by the owner on 2026-11-14 ("setuju"): the organism's living vision.
// organism/vision.json is validated here (CI fails on an invalid vision), its core and schema are guard paths, the AI
// Kernel serves it read-only at GET /v1/vision, and the Console's Vision page shows it without inventing a number.
// One migratedDb() per test at most (the Forge runs these under sql.js, whose wasm heap never shrinks).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, OUTSIDER_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import { GOAL_ID, VISION_HORIZONS, VISION_SCHEMA, parseVision, visionProblems } from "../src/vision.ts";
import { CRITICAL_PATHS, criticalPathReason } from "../src/guard-paths.ts";
import { pathRefusal } from "../src/evolution-limits.ts";
import { DEPLOY_UNITS, VISION_FILE, unitChanged, unitForService } from "../src/deploy-units.ts";
import { criticalReasons } from "../../forge/src/changes.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { VISION_SOURCE, visionView } from "../../ai-kernel/src/vision-view.ts";
import { UI_ROUTES } from "../../console/src/ui/routes.ts";
import { CONSOLE_ALLOW_LIST } from "../../console/src/index.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const visionText = () => read("organism/vision.json");
const vision = () => JSON.parse(visionText());

test("V1. organism/vision.json is a valid organism.vision.v1, formatted as 2-space JSON with a trailing newline", () => {
  const v = vision();
  assert.deepEqual(visionProblems(v), [], "CI fails on an invalid vision");
  assert.equal(v.schema, VISION_SCHEMA);
  assert.equal(visionText(), JSON.stringify(v, null, 2) + "\n");
  assert.ok(parseVision(v));
  assert.ok(v.core.constitution.length > 0);
  for (const g of v.growth.goals) {
    assert.match(g.id, GOAL_ID);
    assert.ok((VISION_HORIZONS as readonly string[]).includes(g.horizon));
  }
  // An unmeasured baseline stays null in the file: the vision never invents a starting value.
  assert.ok(v.growth.goals.every((g: any) => g.kpis.every((k: any) => k.baseline === null || typeof k.baseline === "number")));
});

test("V2. broken shapes are refused, each with a problem that names where it is", () => {
  const base = () => structuredClone(vision());
  const problemsOf = (mutate: (v: any) => unknown) => { const v = base(); const r = mutate(v); return visionProblems(r === undefined ? v : r); };
  const fails = (mutate: (v: any) => unknown, where: RegExp) => {
    const p = problemsOf(mutate);
    assert.ok(p.some((x) => where.test(x)), `expected a problem matching ${where}, got ${JSON.stringify(p)}`);
  };
  for (const bad of [null, [], "x", 1]) assert.ok(visionProblems(bad).length > 0, JSON.stringify(bad));
  fails((v) => { v.schema = "organism.vision.v2"; }, /^vision\.schema/);
  fails((v) => { delete v.core; }, /^core: must be an object/);
  fails((v) => { v.core.mission = " "; }, /^core\.mission/);
  fails((v) => { delete v.core.identity; }, /^core\.identity: must be an object/);
  fails((v) => { v.core.identity.core_organ = 7; }, /^core\.identity\.core_organ/);
  fails((v) => { v.core.identity.organs = "Forge"; }, /^core\.identity\.organs/);
  fails((v) => { v.core.constitution = []; }, /^core\.constitution: must not be empty/);
  fails((v) => { v.core.constitution = ["ok", ""]; }, /^core\.constitution\[1\]/);
  fails((v) => { delete v.growth; }, /^growth: must be an object/);
  fails((v) => { v.growth.goals = {}; }, /^growth\.goals: must be an array/);
  fails((v) => { v.growth.goals[0].id = "accuracy"; }, /^growth\.goals\[0\]\.id: must match/);
  fails((v) => { v.growth.goals[0].id = "g-Accuracy"; }, /^growth\.goals\[0\]\.id: must match/);
  fails((v) => { v.growth.goals[1].id = v.growth.goals[0].id; }, /^growth\.goals\[1\]\.id: duplicate/);
  fails((v) => { v.growth.goals[0].horizon = "decade"; }, /^growth\.goals\[0\]\.horizon/);
  fails((v) => { v.growth.goals[0].organs = []; }, /^growth\.goals\[0\]\.organs: must not be empty/);
  fails((v) => { v.growth.goals[0].kpis = []; }, /^growth\.goals\[0\]\.kpis: must be a non-empty array/);
  fails((v) => { v.growth.goals[0].evidence = ""; }, /^growth\.goals\[0\]\.evidence/);
  fails((v) => { v.growth.goals[0].kpis[1].id = v.growth.goals[0].kpis[0].id; }, /^growth\.goals\[0\]\.kpis\[1\]\.id: duplicate/);
  fails((v) => { v.growth.goals[0].kpis[0].baseline = "0.5"; }, /^growth\.goals\[0\]\.kpis\[0\]\.baseline: must be a number or null/);
  fails((v) => { v.growth.goals[0].kpis[0].baseline = Number.NaN; }, /\.baseline: must be a number or null/);
  fails((v) => { delete v.growth.goals[0].kpis[0].baseline; }, /\.baseline: required/);
  fails((v) => { delete v.growth.goals[0].kpis[0].target; }, /\.target: required/);
  fails((v) => { v.growth.goals[0].kpis[0].target = true; }, /\.target: must be a number, a non-empty string or null/);
  fails((v) => { v.growth.goals[0].kpis[0].source = null; }, /\.source: must be a non-empty string/);
  fails((v) => { v.growth.goals[0].kpis[0].baselin = 1; }, /\.kpis\[0\]\.baselin: unknown field/);
  fails((v) => { v.core.motto = "x"; }, /^core\.motto: unknown field/);
  fails((v) => { v.$comment = 1; }, /^vision\.\$comment/);
  // The same KPI id in two different goals is allowed (ids are unique within a goal); hypotheses are optional strings.
  assert.deepEqual(problemsOf((v) => { v.growth.goals[1].kpis[0].id = v.growth.goals[0].kpis[0].id; }), []);
  assert.deepEqual(problemsOf((v) => { v.growth.goals[0].hypotheses = ["grounded agents call better"]; v.growth.goals[0].kpis[0].baseline = 0.4; v.growth.goals[0].kpis[0].target = "increasing"; }), []);
  fails((v) => { v.growth.goals[0].hypotheses = [3]; }, /\.hypotheses\[0\]/);
  assert.equal(parseVision({}), null);
});

test("V3. the vision's core and its schema are guard paths (reason vision_core): a change is merge_owner_change", async () => {
  assert.equal(criticalPathReason("organism/vision.json"), "vision_core");
  assert.equal(criticalPathReason("workers/control-plane-shared/src/vision.ts"), "vision_core");
  assert.equal(criticalPathReason("organism/vision.json.bak"), null);
  assert.equal(criticalPathReason("workers/ai-kernel/src/vision-view.ts"), null, "the read-only view is routine; the data and schema are guarded");
  assert.equal(CRITICAL_PATHS.filter(([, reason]) => reason === "vision_core").length, 2);
  const repo = { readBlob: async () => null } as never;
  const reasons = await criticalReasons(repo, ["organism/vision.json", "workers/control-plane-shared/src/vision.ts"].map((path) => ({ path, change: "modified", base: "x", head: "y" }) as never), false);
  assert.deepEqual(reasons, ["vision_core: organism/vision.json", "vision_core: workers/control-plane-shared/src/vision.ts"]);
  // The evolver (ADR-0014 E2) can never write either one.
  assert.equal(pathRefusal("workers/control-plane-shared/src/vision.ts"), "guard_path:vision_core");
  assert.notEqual(pathRefusal("organism/vision.json"), null);
});

test("V4. GET /v1/vision on the AI Kernel: operators read the bundled vision, validated; nothing else is served or written", async () => {
  const db = migratedDb();
  const env = baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL });
  const events = () => (db.raw.prepare("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n;
  const before = events();
  const r = await call(kernel, env, req("GET", "/v1/vision", undefined, OPERATOR_JWT));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.schema, r.body.source, r.body.vision_schema, r.body.status, r.body.problems], ["organism.vision-view.v1", "organism/vision.json", VISION_SCHEMA, "valid", []]);
  assert.deepEqual(r.body.vision, vision(), "exactly the file, null KPIs included");
  assert.equal(events(), before, "reading the vision writes nothing");
  assert.equal((await call(kernel, env, req("GET", "/v1/vision", undefined, APPROVER_JWT))).status, 200);
  assert.equal((await call(kernel, env, req("GET", "/v1/vision", undefined, OUTSIDER_JWT))).status, 403);
  assert.equal((await call(kernel, env, req("GET", "/v1/vision", undefined, null))).status, 403, "no Access JWT");
  assert.equal((await call(kernel, env, req("POST", "/v1/vision", {}, APPROVER_JWT))).status, 404, "the vision is never changed through the kernel");
  // An invalid vision is reported with its problems and never served as one.
  const broken = visionView({ schema: VISION_SCHEMA });
  assert.deepEqual([broken.status, broken.vision, broken.source], ["invalid", null, VISION_SOURCE]);
  assert.ok(broken.problems.length > 0);
  // A change to the vision redeploys the kernel that bundles it, and only that unit.
  assert.equal(VISION_FILE, "organism/vision.json");
  assert.deepEqual(DEPLOY_UNITS.filter((u) => unitChanged(u, [VISION_FILE])).map((u) => u.unit), [unitForService("cryptophys-ai-kernel")!.unit]);
  assert.match(read("workers/ai-kernel/src/vision-view.ts"), /import visionFile from "\.\.\/\.\.\/\.\.\/organism\/vision\.json" with \{ type: "json" \};/);
});

test("V5. the Console's Vision page: one read-only route, in the nav, measured values only, rendered by the smoke test", () => {
  assert.deepEqual(UI_ROUTES.find((r) => r.id === "kernel.vision"), { id: "kernel.vision", service: "kernel", method: "GET", path: "/v1/vision", approverOnly: false, confirm: null });
  assert.deepEqual(CONSOLE_ALLOW_LIST.filter((a) => a.path.startsWith("/v1/vision")), [{ service: "kernel", method: "GET", path: "/v1/vision" }]);
  assert.match(read("workers/console/ui/src/App.tsx"), /case "vision": page = <Vision \/>; break;/);
  assert.match(read("workers/console/ui/src/components/AppShell.tsx"), /\{ label: "Vision", href: "#\/vision", key: "vision", icon: Compass \}/);
  const page = read("workers/console/ui/src/pages/Vision.tsx");
  assert.deepEqual([...page.matchAll(/\b(?:call|act)\(\s*(?:\{\s*route:\s*)?"([a-z_.]+)"/g)].map((m) => m[1]), ["kernel.vision"], "one read, no action");
  assert.doesNotMatch(page, /route:\s*"/, "no write route on the page");
  assert.match(page, /export const NOT_MEASURED = "not measured yet";/);
  assert.match(page, /: NOT_MEASURED;/, "a null or missing baseline or target is shown as not measured yet");
  assert.doesNotMatch(page, /\?\? 0\b|\|\| 0\b/, "no default number");
  const smoke = read("workers/console/ui/scripts/render-smoke.mjs");
  assert.match(smoke, /const ROUTES = \[[^\]]*"vision"\]/);
  assert.match(smoke, /MOCK\["\/api\/kernel\/v1\/vision"\]/);
  assert.match(smoke, /if \(unmeasured !== 3\)/);
});
