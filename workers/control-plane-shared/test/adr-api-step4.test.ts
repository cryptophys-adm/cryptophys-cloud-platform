// The ADR Steward, step 4 (docs/design/ADR-STEWARD.md §5, §11 row 4; owner 2026-11-16, "ya semua, sesuai
// rekomendasimu"): the read-only API. GET /v1/adr and GET /v1/adr/{id} on the AI Kernel, after requireOperator like
// GET /v1/vision (vision-telos-0016.test.ts V4): operators and viewer accounts read what the Steward stored in
// adr_progress and adr_progress_history; before the first pass the list is honestly empty; nothing is written. The two
// Console allow-list rows and the two UI routes, kernel.adr and kernel.adr_one. Plain fs reads relative to the
// repository root, so the Forge runner can bundle it. One migratedDb() per test at most (sql.js under the Forge).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, OUTSIDER_JWT, accessEnv, baseEnv, call, migratedDb, registeredDb, req, signAccessJwt } from "./harness.ts";
import { appendAuditEvent } from "../src/audit.ts";
import { criticalPathReason } from "../src/guard-paths.ts";
import { ADR_PROGRESS_DIR } from "../src/deploy-units.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { observeAdr } from "../../ai-kernel/src/adr-observe.ts";
import { ADR_STEWARD_ID, applyObservation, stewardState, type AdrProgressDoc, type StewardState } from "../../ai-kernel/src/adr-steward.ts";
import { ADR_CACHE_CONTROL, ADR_VIEW_SCHEMA, DETAIL_HISTORY, LIST_BLOCKERS, validAdrId } from "../../ai-kernel/src/adr-view.ts";
import consoleWorker, { CONSOLE_ALLOW_LIST } from "../../console/src/index.ts";
import { UI_ROUTES } from "../../console/src/ui/routes.ts";

type Db = ReturnType<typeof migratedDb>;
const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const MANIFEST_IDS = (readdirSync(new URL(ADR_PROGRESS_DIR, ROOT)) as string[]).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, 4)).sort();
const NOW = Date.UTC(2026, 10, 17, 12, 7, 0);
const MIN = 60_000;
const VIEWER_EMAIL = "viewer@cryptophys.work";
const VIEWER_JWT = await signAccessJwt({ email: VIEWER_EMAIL });

const STEWARD_KEYS = ["agent_id", "status", "last_pass_at", "last_full_pass_at", "deployed_commit", "ai_today"];
const ENTRY_KEYS = ["adr", "title", "lifecycle", "deferred", "status", "phases_total", "phases_proven", "phases_asserted", "percent", "percent_proven",
  "next_step", "blockers", "owner_actions", "drift_count", "stale", "revision", "changed_at", "explanation"];

/** The Steward's Durable Object as the kernel sees it: its state() RPC over a memory, or one that throws. */
function stewardNs(state: () => Promise<StewardState>) {
  const calls: string[] = [];
  return {
    calls,
    ns: {
      idFromName: (n: string) => n,
      get: (id: unknown) => {
        assert.equal(id, ADR_STEWARD_ID);
        return { state: () => { calls.push("state"); return state(); }, cycle: () => { throw new Error("a read never runs a cycle"); }, status: async () => null };
      },
    },
  };
}
function memory() {
  const m = new Map<string, unknown>();
  return { async get<T>(k: string) { return m.get(k) as T | undefined; }, async put(k: string, v: unknown) { m.set(k, structuredClone(v)); } };
}
function kernelEnv(db: Db, extra: Record<string, unknown> = {}) {
  const mem = memory();
  const steward = stewardNs(() => stewardState(mem));
  const env = baseEnv("cryptophys-ai-kernel", db, { OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL, ADR_STEWARD: steward.ns, ...extra });
  return { env, mem, steward };
}
/** One Steward pass as step 3 runs it (adr.observe, then the write on change), and its state in the Durable Object. */
async function pass(db: Db, mem: ReturnType<typeof memory>, at: number) {
  const state = await stewardState(mem);
  const r = await applyObservation({ DB: db, CF_VERSION_METADATA: { id: "ver-self", tag: "abc1234def56" } }, state, (await observeAdr({ DB: db }, { now: at })) as never, new Date(at).toISOString());
  await mem.put("state", { ...state, last_pass_at: new Date(at).toISOString(), last_pass: r.pass });
  return r.pass;
}
const get = (env: unknown, path: string, jwt: string | null = OPERATOR_JWT) => call(kernel, env, req("GET", path, undefined, jwt));
async function getRaw(env: unknown, path: string) {
  const res = await kernel.fetch(req("GET", path, undefined, OPERATOR_JWT), env as never);
  return { status: res.status, cache: res.headers.get("cache-control"), body: await res.json() as any };
}
const count = (db: Db, table: string) => (db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const writes = (db: Db) => ["audit_events", "adr_progress", "adr_progress_history", "agents", "kernel_controls"].map((t) => count(db, t));

test("AR1. before the first pass: an honest empty state, no row invented, no number defaulted, nothing written", async () => {
  const db = registeredDb();
  const { env, steward } = kernelEnv(db);
  const before = writes(db);
  const r = await getRaw(env, "/v1/adr");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.cache, ADR_CACHE_CONTROL);
  assert.equal(ADR_CACHE_CONTROL, "private, max-age=60");
  assert.deepEqual(r.body, {
    schema: ADR_VIEW_SCHEMA, available: true,
    steward: { agent_id: "adr-steward", status: "enabled", last_pass_at: null, last_full_pass_at: null, deployed_commit: "abc1234def56", ai_today: { used: null, cap: null } },
    adrs: [],
  });
  assert.equal(ADR_VIEW_SCHEMA, "adr.progress-view.v1");
  assert.deepEqual(steward.calls, ["state"], "the Steward's state() RPC, never a cycle");
  // A well-formed id with no document yet is 404, not a default document.
  const one = await get(env, "/v1/adr/0012");
  assert.deepEqual([one.status, one.body.error, one.body.detail], [404, "not_found", "no document for ADR-0012"]);
  assert.deepEqual(writes(db), before, "reading writes nothing");
  // Without the Steward's binding or with its state unreadable, the pass times are null, never guessed.
  const bare = await get({ ...env, ADR_STEWARD: undefined }, "/v1/adr");
  assert.deepEqual([bare.status, bare.body.steward.last_pass_at, bare.body.steward.last_full_pass_at], [200, null, null]);
  const down = await get({ ...env, ADR_STEWARD: stewardNs(async () => { throw new Error("DO unavailable"); }).ns, CF_VERSION_METADATA: undefined }, "/v1/adr");
  assert.deepEqual([down.status, down.body.available, down.body.steward.last_pass_at, down.body.steward.deployed_commit], [200, true, null, null]);
  // The Steward suspended, the kill switch off, or the Steward not registered: the status says which.
  db.raw.prepare("UPDATE agents SET status = 'suspended' WHERE agent_id = ?").run(ADR_STEWARD_ID);
  assert.equal((await get(env, "/v1/adr")).body.steward.status, "suspended");
  db.raw.prepare("UPDATE kernel_controls SET value = '0' WHERE control = 'agents_enabled'").run();
  assert.equal((await get(env, "/v1/adr")).body.steward.status, "agents_disabled");
  db.raw.prepare("DELETE FROM agents WHERE agent_id = ?").run(ADR_STEWARD_ID);
  assert.equal((await get(env, "/v1/adr")).body.steward.status, "not_registered");
  // §4.9: without the adr_progress table (migration 0075 not applied) the list is available: false, with no rows.
  db.raw.exec("DROP TABLE adr_progress");
  const missing = await get(env, "/v1/adr");
  assert.deepEqual([missing.status, missing.body.schema, missing.body.available, missing.body.adrs], [200, ADR_VIEW_SCHEMA, false, []]);
  assert.deepEqual(Object.keys(missing.body.steward), STEWARD_KEYS);
  const gone = await get(env, "/v1/adr/0012");
  assert.deepEqual([gone.status, gone.body.error], [503, "not_available"]);
});

test("AR2. after a pass: one entry per stored ADR in §5's shape, sorted, every value from the stored row and body", async () => {
  const db = registeredDb();
  const { env, mem } = kernelEnv(db);
  const written = await pass(db, mem, NOW);
  assert.deepEqual(written.written, MANIFEST_IDS);
  const r = await get(env, "/v1/adr");
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ["schema", "available", "steward", "adrs"]);
  assert.deepEqual(r.body.steward, { agent_id: "adr-steward", status: "enabled", last_pass_at: new Date(NOW).toISOString(), last_full_pass_at: new Date(NOW).toISOString(), deployed_commit: "abc1234def56", ai_today: { used: null, cap: null } });
  assert.deepEqual(r.body.adrs.map((a: any) => a.adr), MANIFEST_IDS, "sorted by ADR number");
  const rows = db.raw.prepare("SELECT * FROM adr_progress ORDER BY adr_id").all() as any[];
  for (const [i, a] of (r.body.adrs as any[]).entries()) {
    const row = rows[i];
    const body = JSON.parse(row.body_json) as AdrProgressDoc;
    assert.deepEqual(Object.keys(a), ENTRY_KEYS, a.adr);
    assert.deepEqual(a, {
      adr: row.adr_id, title: body.title, lifecycle: row.lifecycle, deferred: body.deferred, status: row.status,
      phases_total: row.phases_total, phases_proven: row.phases_proven, phases_asserted: row.phases_asserted, percent: row.percent, percent_proven: row.percent_proven,
      next_step: body.next_step, blockers: body.blockers.slice(0, 3), owner_actions: body.owner_actions, drift_count: body.drift.length, stale: body.stale,
      revision: row.revision, changed_at: row.changed_at, explanation: JSON.parse(row.explanation_json),
    }, a.adr);
    assert.ok(a.blockers.length <= LIST_BLOCKERS);
    assert.equal(a.explanation.source, "template");
  }
  assert.equal(LIST_BLOCKERS, 3);
  const byId = Object.fromEntries((r.body.adrs as any[]).map((a) => [a.adr, a]));
  assert.ok(JSON.parse(rows.find((x) => x.adr_id === "0012").body_json).blockers.length > 3, "0012 has more blockers than the list shows");
  assert.equal(byId["0012"].blockers.length, 3);
  assert.deepEqual([byId["0019"].status, byId["0019"].phases_total, byId["0019"].next_step], ["planned", 0, null], "the planned ADR comes from its manifest");
  assert.equal(byId["0018"].status, "held");
});

test("AR3. GET /v1/adr/{id}: the stored adr.progress-doc.v1 body, its explanation and the newest 10 history entries", async () => {
  const db = registeredDb();
  const { env, mem } = kernelEnv(db);
  await pass(db, mem, NOW);
  const row = () => db.raw.prepare("SELECT * FROM adr_progress WHERE adr_id = '0012'").get() as any;
  const first = await getRaw(env, "/v1/adr/0012");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.cache, ADR_CACHE_CONTROL);
  const body = JSON.parse(row().body_json) as AdrProgressDoc;
  assert.deepEqual(first.body, { ...body, revision: 1, changed_at: row().changed_at, explanation: JSON.parse(row().explanation_json), history: [{ revision: 1, status: body.status, percent: body.percent, created_at: row().changed_at }] });
  assert.equal(first.body.schema, "adr.progress-doc.v1");
  // A watched gate event proves ADR-0012 S3: the next pass writes revision 2, and the detail shows the newest first.
  await appendAuditEvent(db, { event_type: "forge.git_backup_written", actor: "forge", subject: "git-backup", outcome: "written", payload: {} });
  // (The second pass also rewrites 0016 once: T1's adr_index_live half now reads the rows, adr-steward-step3 AS8.)
  assert.deepEqual((await pass(db, mem, NOW + 30 * MIN)).written, ["0012", "0016"]);
  const second = await get(env, "/v1/adr/0012");
  assert.equal(second.body.revision, 2);
  assert.equal(second.body.phases_proven, body.phases_proven + 1);
  assert.deepEqual(second.body.history.map((h: any) => h.revision), [2, 1]);
  assert.deepEqual(Object.keys(second.body.history[0]), ["revision", "status", "percent", "created_at"]);
  assert.equal((await get(env, "/v1/adr")).body.adrs.find((a: any) => a.adr === "0012").revision, 2);
  // History is bounded: of 13 revisions, the newest 10.
  const h = db.raw.prepare("SELECT * FROM adr_progress_history WHERE adr_id = '0019' AND revision = 1").get() as any;
  for (let rev = 2; rev <= 13; rev++) {
    db.raw.prepare("INSERT INTO adr_progress_history (adr_id, revision, status, percent, body_json, explanation_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("0019", rev, h.status, h.percent, h.body_json, h.explanation_json, new Date(NOW + rev * MIN).toISOString());
  }
  const many = await get(env, "/v1/adr/0019");
  assert.equal(DETAIL_HISTORY, 10);
  assert.deepEqual(many.body.history.map((x: any) => x.revision), [13, 12, 11, 10, 9, 8, 7, 6, 5, 4]);
  // A well-formed id the Steward has no document for is 404.
  const unknown = await get(env, "/v1/adr/9999");
  assert.deepEqual([unknown.status, unknown.body.error], [404, "not_found"]);
});

test("AR4. {id} is four digits (400 otherwise); other paths under /v1/adr are 404; no method but GET is served", async () => {
  const db = registeredDb();
  const { env, mem } = kernelEnv(db);
  await pass(db, mem, NOW);
  for (const bad of ["12", "012", "00120", "abcd", "0x12", "001a", "-001", "1e10"]) {
    const r = await get(env, `/v1/adr/${bad}`);
    assert.deepEqual([r.status, r.body.error], [400, "invalid_request"], bad);
    assert.equal(validAdrId(bad), false, bad);
  }
  for (const ok of ["0001", "0012", "0019"]) assert.equal(validAdrId(ok), true, ok);
  for (const p of ["/v1/adr/", "/v1/adr/0012/history", "/v1/adr/0012/", "/v1/adrs", "/v1/adr-index"]) {
    const r = await get(env, p);
    assert.deepEqual([r.status, r.body.error], [404, "not_found"], p);
  }
  // No write path: every other method is refused, for operators and approvers, and nothing changes.
  const before = writes(db);
  const docs = () => db.raw.prepare("SELECT adr_id, revision, body_sha256, changed_at FROM adr_progress ORDER BY adr_id").all();
  const stored = docs();
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
    for (const path of ["/v1/adr", "/v1/adr/0012"]) {
      for (const jwt of [OPERATOR_JWT, APPROVER_JWT]) {
        const res = await kernel.fetch(req(method, path, method === "POST" || method === "PUT" || method === "PATCH" ? { status: "done" } : undefined, jwt), env as never);
        assert.equal(res.status, 405, `${method} ${path}`);
      }
    }
  }
  assert.deepEqual(writes(db), before);
  assert.deepEqual(docs(), stored);
});

test("AR5. who reads: operators, approvers and viewer accounts read, the same as the vision; outsiders and no JWT do not", async () => {
  const db = registeredDb();
  db.raw.prepare("INSERT INTO platform_accounts (email, kind, privilege, status, created_by, created_at, updated_by, updated_at) VALUES (?, 'admin', 'viewer', 'active', 'o', 't', 'o', 't')").run(VIEWER_EMAIL);
  const { env, mem } = kernelEnv(db);
  await pass(db, mem, NOW);
  for (const path of ["/v1/adr", "/v1/adr/0012", "/v1/vision"]) {
    for (const jwt of [OPERATOR_JWT, APPROVER_JWT, VIEWER_JWT]) assert.equal((await get(env, path, jwt)).status, 200, path);
    assert.equal((await get(env, path, OUTSIDER_JWT)).status, 403, path);
    assert.equal((await get(env, path, null)).status, 403, `${path}: no Access JWT`);
  }
  // A viewer's write is refused before any route (requireOperator); there is no ADR write route anyway.
  assert.equal((await kernel.fetch(req("POST", "/v1/adr/0012", {}, VIEWER_JWT), env as never)).status, 403);
  // The kernel's service listing names both routes, read-only.
  const meta = await get(env, "/");
  assert.ok(JSON.stringify(meta.body).includes('"GET /v1/adr"') && JSON.stringify(meta.body).includes('"GET /v1/adr/{id}"'));
  assert.ok(!/(POST|PUT|PATCH|DELETE) \/v1\/adr/.test(JSON.stringify(meta.body)));
});

test("AR6. bounded reads: one query for the list, two for one ADR, each with a LIMIT and walking a primary key; the view module writes nothing", async () => {
  const db = registeredDb();
  const { env, mem } = kernelEnv(db);
  await pass(db, mem, NOW);
  const seen: string[] = [];
  const proxy = new Proxy(db, {
    get(target: any, prop: string | symbol) {
      if (prop === "prepare") return (sql: string) => { seen.push(sql); return target.prepare(sql); };
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as Db;
  const e = { ...env, DB: proxy };
  assert.equal((await get(e, "/v1/adr")).status, 200);
  const list = seen.filter((s) => /adr_progress/.test(s));
  seen.length = 0;
  assert.equal((await get(e, "/v1/adr/0012")).status, 200);
  const one = seen.filter((s) => /adr_progress/.test(s));
  assert.equal(list.length, 1, list.join("\n"));
  assert.equal(one.length, 2, one.join("\n"));
  for (const sql of [...list, ...one]) {
    assert.match(sql, /\bLIMIT \d+$/, sql);
    assert.ok(!/^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)/i.test(sql), sql);
    const plan = (db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(sql.includes("?") ? ["0012"] : [])) as any[]).map((r) => r.detail).join(" | ");
    assert.match(plan, /USING (INDEX sqlite_autoindex_adr_progress(_history)?_1|PRIMARY KEY)/, `${sql}\n${plan}`);
    assert.doesNotMatch(plan, /TEMP B-TREE/, `${sql}\n${plan}`);
  }
  assert.ok(!seen.some((s) => /^\s*(INSERT|UPDATE|DELETE)/i.test(s)));
  // The module that serves the routes has no write path at all: no write statement, no audit, no batch, no cycle.
  const src = read("workers/ai-kernel/src/adr-view.ts");
  assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|REPLACE)\b|appendAuditEvent|\.batch\(|\.run\(|\.cycle\(|\.put\(/);
  // The kernel's ADR route block answers GET only.
  const index = read("workers/ai-kernel/src/index.ts");
  const block = index.slice(index.indexOf('if (path === "/v1/adr" || path.startsWith("/v1/adr/"))'), index.indexOf('if (path === "/v1/consensus" && request.method === "GET")'));
  assert.match(block, /if \(request\.method !== "GET"\) return errorResponse\(405, "method_not_allowed"/);
  assert.match(block, /adrListView\(env\)/);
  assert.match(block, /adrDetailView\(env, adr\[1\]\)/);
});

test("AR7. the Console: two read-only allow-list rows and two UI routes, forwarded with the caller's JWT; a write is not forwarded", async () => {
  assert.deepEqual(CONSOLE_ALLOW_LIST.filter((a) => a.path.startsWith("/v1/adr")), [
    { service: "kernel", method: "GET", path: "/v1/adr" },
    { service: "kernel", method: "GET", path: "/v1/adr/{id}" },
  ]);
  assert.deepEqual(UI_ROUTES.filter((r) => r.path.startsWith("/v1/adr")), [
    { id: "kernel.adr", service: "kernel", method: "GET", path: "/v1/adr", approverOnly: false, confirm: null },
    { id: "kernel.adr_one", service: "kernel", method: "GET", path: "/v1/adr/{id}", approverOnly: false, confirm: null },
  ]);
  // End to end: a viewer account through the Console to the real kernel.
  const db = registeredDb();
  db.raw.prepare("INSERT INTO platform_accounts (email, kind, privilege, status, created_by, created_at, updated_by, updated_at) VALUES (?, 'admin', 'viewer', 'active', 'o', 't', 'o', 't')").run(VIEWER_EMAIL);
  const { env: kEnv, mem } = kernelEnv(db);
  await pass(db, mem, NOW);
  const forwarded: Request[] = [];
  const cEnv = {
    SERVICE_NAME: "cryptophys-console", SERVICE_ENVIRONMENT: "production", API_CONTRACT_VERSION: "v1",
    ...accessEnv(), OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL,
    KERNEL: { fetch: (r: Request) => { forwarded.push(r); return kernel.fetch(r, kEnv as never); } },
    REGISTRY: { fetch: async () => new Response(JSON.stringify({ role: "viewer" }), { headers: { "content-type": "application/json" } }) },
  };
  const creq = (method: string, path: string, jwt = VIEWER_JWT, headers: Record<string, string> = {}) =>
    new Request(`https://console.example.workers.dev${path}`, { method, headers: { "cf-access-jwt-assertion": jwt, ...headers } });
  const run = async (r: Request) => { const res = await consoleWorker.fetch(r, cEnv as never); return { status: res.status, body: await res.json() as any }; };
  const list = await run(creq("GET", "/api/kernel/v1/adr"));
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.deepEqual(list.body.adrs.map((a: any) => a.adr), MANIFEST_IDS);
  const one = await run(creq("GET", "/api/kernel/v1/adr/0012"));
  assert.deepEqual([one.status, one.body.adr, one.body.schema], [200, "0012", "adr.progress-doc.v1"]);
  assert.deepEqual([...new Set(forwarded.map((r) => r.headers.get("cf-access-jwt-assertion")))], [VIEWER_JWT], "the caller's own JWT");
  assert.deepEqual((await run(creq("GET", "/api/kernel/v1/adr/12"))).status, 400, "the kernel validates the id");
  // No write is forwarded: not for a viewer, not for an operator with the Console's CSRF headers.
  const n = forwarded.length;
  for (const method of ["POST", "PUT", "DELETE"]) {
    for (const path of ["/api/kernel/v1/adr", "/api/kernel/v1/adr/0012"]) {
      const r = await run(creq(method, path, OPERATOR_JWT, { origin: "https://console.example.workers.dev", "x-cryptophys-console": "1" }));
      assert.deepEqual([r.status, r.body.error], [404, "not_allowed"], `${method} ${path}`);
    }
  }
  assert.equal(forwarded.length, n);
});

test("AR8. no guard path is touched; docs/SSOT.md documents the endpoints and the design marks step 4 built", () => {
  for (const p of ["workers/ai-kernel/src/adr-view.ts", "workers/ai-kernel/src/index.ts", "workers/console/src/index.ts", "workers/console/src/ui/routes.ts",
    "workers/control-plane-shared/test/adr-api-step4.test.ts", "docs/SSOT.md", "docs/design/ADR-STEWARD.md"]) assert.equal(criticalPathReason(p), null, p);
  const ssot = read("docs/SSOT.md");
  assert.match(ssot.split("\n").find((l) => l.startsWith("Last reviewed: "))!, /^Last reviewed: 2026-11-16 \(ADR Steward step 4, the read-only API: [^()]*`GET \/v1\/adr`[^()]*`GET \/v1\/adr\/\{id\}`[^()]*; ADR Steward step 3, the agent: /);
  assert.match(ssot, /read API, `GET \/v1\/adr` and `GET \/v1\/adr\/\{id\}` on the AI Kernel/);
  assert.match(read("docs/design/ADR-STEWARD.md"), /\| 4 \| API: [^\n]*\*\*Built 2026-11-17\*\*/);
});
