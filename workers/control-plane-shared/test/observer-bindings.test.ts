// The Observer's binding index (owner 2026-11-15, "tambahkan"): every live Worker's bindings, read from
// GET /accounts/{account}/workers/scripts/{name}/settings, stored per Worker (migration 0068), part of the inventory's
// digest; unbound_resource and binding_to_missing_resource; boundBy answers "is KV X bound by any live Worker?".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migratedDb } from "./harness.ts";
import { observerView, type Finding } from "../src/observer.ts";
import { LISTS, compareInventory, runInventory, type KnownOrganism, type ListKey, type ListResult } from "../src/observer-inventory.ts";
import { BINDING_READ_CAP, boundBy, indexDatasetLine, parseBindings, readBindingIndex, settingsUrl, type BindingIndex } from "../src/observer-bindings.ts";

const SETTINGS = JSON.parse(readFileSync(new URL("./fixtures/observer-worker-settings.json", import.meta.url), "utf8"));
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ENV = { CF_ANALYTICS_TOKEN: "analytics-token", CF_ACCOUNT_ID: ACCOUNT };
const KV_A = "49d3a9580000000000000000000000aa"; // mt5-mcp-oauth
const KV_B = "8044368b0000000000000000000000bb"; // mt5-readonly-mcp-oauth-staging
const KV_C = "addf03d30000000000000000000000cc"; // xauusd-preview-oauth-store
const kinds = (fs: Finding[]) => fs.map((f) => `${f.metric} ${f.worker}`).sort();
const settings = (...bindings: unknown[]) => ({ success: true, errors: [], messages: [], result: { compatibility_date: "2026-10-01", bindings } });
const kv = (name: string, id: string) => ({ type: "kv_namespace", name, namespace_id: id });
const index = (workers: BindingIndex["workers"]): BindingIndex => ({ workers, listed: Object.keys(workers).length, cap: BINDING_READ_CAP });

type Answer = unknown | (() => Response);
/** A fake Cloudflare API: the account lists and one settings response per Worker. Records every call. */
function fakeCf(over: Record<string, Answer> = {}) {
  const calls: string[] = [];
  const answer = (key: string, fallback: unknown) => {
    const v = Object.hasOwn(over, key) ? over[key] : fallback;
    return typeof v === "function" ? (v as () => Response)() : Response.json(v);
  };
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    assert.equal((init?.headers as Record<string, string>)?.authorization, "Bearer analytics-token", "every call uses the Observer's token");
    assert.equal(init?.method ?? "GET", "GET", "read only");
    const path = url.replace(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/`, "");
    const s = /^workers\/scripts\/([^/]+)\/settings$/.exec(path);
    if (s) { const w = decodeURIComponent(s[1]); calls.push(`settings:${w}`); return answer(`settings:${w}`, settings()); }
    const key = (Object.keys(LISTS) as ListKey[]).find((k) => LISTS[k].path === path);
    assert.ok(key, `unexpected ${url}`);
    calls.push(`list:${key}`);
    return answer(`list:${key}`, { success: true, result: key === "r2" ? { buckets: [] } : [] });
  };
  return { fetcher, calls };
}

const known = (over: Partial<KnownOrganism> = {}): KnownOrganism => ({
  declared: new Set(["cryptophys-console", "cryptophys-forge"]), stubs: new Set(), unknown_origins: new Set(), disabled: new Set(), census_at: "2026-11-15T09:00:00.000Z", ...over,
});
const kvList = (...items: Array<[string, string]>): ListResult => ({ status: "ok", items: items.map(([id, name]) => ({ id, name })) });

test("BI1. parseBindings: the settings response's bindings, compact, sorted, without any value", () => {
  const parsed = parseBindings(SETTINGS)!;
  assert.equal(parsed.truncated, false);
  assert.deepEqual(parsed.bindings, [
    { type: "ai", name: "AI" },
    { type: "analytics_engine", name: "EVENTS", id: "mt5_events" },
    { type: "d1", name: "DB", id: "5c6f2a1e-0000-4000-8000-000000000001" },
    { type: "d1", name: "LEGACY_DB", id: "5c6f2a1e-0000-4000-8000-000000000002" }, // the deprecated `id` field
    { type: "durable_object_namespace", name: "SESSIONS", id: "do000000000000000000000000000001", class_name: "McpSession" },
    { type: "durable_object_namespace", name: "SUPERVISOR", class_name: "SupervisorAgent", script_name: "cryptophys-ai-kernel" },
    { type: "kv_namespace", name: "OAUTH_KV", id: KV_A },
    { type: "queue", name: "JOBS", id: "mt5-jobs" },
    { type: "r2_bucket", name: "BUNDLES", id: "cryptophys-forge-bundles" },
    { type: "service", name: "AGENTS", id: "cryptophys-ai-kernel" },
    { type: "version_metadata", name: "VERSION" },
    { type: "workflow", name: "FLOW", id: "mt5-sync", class_name: "SyncFlow" },
  ]);
  const text = JSON.stringify(parsed);
  for (const gone of ["PLATFORM_NAME", "must never be stored", "UPSTREAM_TOKEN", "FEATURES", "SIGNING", "HMAC"]) assert.ok(!text.includes(gone), `${gone} is not kept`);
  assert.equal(parseBindings({ success: true, result: {} }), null, "no bindings array is not an empty one");
  const many = parseBindings(settings(...Array.from({ length: 120 }, (_, n) => kv(`K${String(n).padStart(3, "0")}`, `id${n}`))))!;
  assert.deepEqual([many.bindings.length, many.truncated], [100, true]);
  assert.equal(settingsUrl(ACCOUNT, "mt5 mcp"), `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/mt5%20mcp/settings`);
});

test("BI2. a Worker whose bindings the token may not read, or that fails, is recorded for that Worker only", async () => {
  const cf = fakeCf({
    "settings:mt5-mcp": SETTINGS,
    "settings:locked": () => new Response("{}", { status: 403 }),
    "settings:broken": () => new Response("oops", { status: 500 }),
    "settings:offline": () => { throw new Error("network down"); },
  });
  const idx = await readBindingIndex("analytics-token", ACCOUNT, ["offline", "mt5-mcp", "locked", "broken", "cryptophys-console"], cf.fetcher);
  assert.deepEqual(Object.fromEntries(Object.entries(idx.workers).map(([w, r]) => [w, r.status])),
    { broken: "unavailable", "cryptophys-console": "ok", locked: "permission_missing", "mt5-mcp": "ok", offline: "unavailable" });
  assert.deepEqual(idx.workers.offline, { status: "unavailable", reason: "network down" });
  assert.match(indexDatasetLine(idx), /^partial: 2 of 5 Workers read, 12 bindings \(1 permission_missing, 2 unavailable\)$/);
  const fs = compareInventory({ known: known(), lists: { scripts: { status: "ok", items: [] }, kv: kvList([KV_A, "mt5-mcp-oauth"], [KV_B, "mt5-readonly-mcp-oauth-staging"]) }, bindings: idx, traffic7d: new Map(), senses_cover_7d: false, day: "2026-11-15" });
  assert.deepEqual(kinds(fs).filter((k) => !k.startsWith("undeclared") && !k.startsWith("orphaned")), ["bindings_unread broken", "bindings_unread locked", "bindings_unread offline"],
    "no unbound_resource from a partial index: KV_B may be bound by a Worker that was not read");
  // Every Worker refused: one capability finding naming the permission, nothing per Worker.
  const all = await readBindingIndex("analytics-token", ACCOUNT, ["a", "b"], fakeCf({ "settings:a": () => new Response("", { status: 403 }), "settings:b": () => new Response("", { status: 403 }) }).fetcher);
  assert.equal(indexDatasetLine(all), "permission_missing: http 403");
  const refused = compareInventory({ known: known(), lists: {}, bindings: all, traffic7d: new Map(), senses_cover_7d: false, day: "2026-11-15" });
  assert.deepEqual(kinds(refused), ["inventory_permission_missing:bindings account"]);
  assert.deepEqual([refused[0].kind, refused[0].sample.permission], ["capability", "Account > Workers Scripts > Read"]);
});

test("BI3. the cap: at most 50 settings reads per run; the rest are skipped and named", async () => {
  const names = Array.from({ length: 57 }, (_, n) => `w${String(n).padStart(2, "0")}`);
  const cf = fakeCf();
  const idx = await readBindingIndex("analytics-token", ACCOUNT, names, cf.fetcher);
  assert.equal(BINDING_READ_CAP, 50);
  assert.equal(cf.calls.length, 50, "50 calls, never more");
  assert.deepEqual(Object.entries(idx.workers).filter(([, r]) => r.status === "skipped").map(([w]) => w), names.slice(50));
  assert.equal(indexDatasetLine(idx), "partial: 50 of 57 Workers read, 0 bindings (7 skipped)");
  const fs = compareInventory({ known: known(), lists: { kv: kvList([KV_A, "mt5-mcp-oauth"]) }, bindings: idx, traffic7d: new Map(), senses_cover_7d: false, day: "2026-11-15" });
  const cap = fs.find((f) => f.metric === "bindings_cap_exceeded")!;
  assert.deepEqual([cap.worker, cap.severity, cap.sample.listed, cap.sample.cap], ["account", "info", 57, 50]);
  assert.ok(!fs.some((f) => f.metric === "unbound_resource"), "not proven while Workers were skipped");
  assert.deepEqual(boundBy(idx, "kv", KV_A).unread, names.slice(50));
});

test("BI4. unbound_resource (informational) and binding_to_missing_resource (warning)", () => {
  const idx = index({
    "mt5-mcp": { status: "ok", bindings: parseBindings(SETTINGS)!.bindings },
    "cryptophys-console": { status: "ok", bindings: [{ type: "d1", name: "DB", id: "cp-uuid" }, { type: "kv_namespace", name: "GHOST", id: "deadbeef" }] },
    "xauusd-omega": { status: "ok", bindings: [] },
  });
  const fs = compareInventory({
    known: known(), traffic7d: new Map(), senses_cover_7d: false, day: "2026-11-15", bindings: idx,
    lists: {
      kv: kvList([KV_A, "mt5-mcp-oauth"], [KV_B, "mt5-readonly-mcp-oauth-staging"], [KV_C, "xauusd-preview-oauth-store"]),
      d1: kvList(["cp-uuid", "cryptophys-control-plane"], ["5c6f2a1e-0000-4000-8000-000000000001", "mt5-db"], ["old-uuid", "old-db"]),
      r2: { status: "ok", items: [{ id: "cryptophys-forge-bundles", name: "cryptophys-forge-bundles" }, { id: "cryptophys-d1-backups", name: "cryptophys-d1-backups" }, { id: "stray", name: "stray" }] },
      queues: { status: "permission_missing", http: 403 },
    },
  });
  const binding = kinds(fs).filter((k) => /unbound|missing_resource/.test(k));
  assert.deepEqual(binding, [
    "binding_to_missing_resource cryptophys-console",
    "binding_to_missing_resource mt5-mcp",
    "unbound_resource d1:old-db",
    "unbound_resource kv:mt5-readonly-mcp-oauth-staging",
    "unbound_resource kv:xauusd-preview-oauth-store",
    "unbound_resource r2:stray",
  ], "cryptophys-d1-backups is unbound but declared by a wrangler.toml; queues are unreadable, so JOBS is not reported missing");
  for (const f of fs.filter((x) => x.metric === "unbound_resource")) assert.equal(f.severity, "info");
  const ghost = fs.find((f) => f.metric === "binding_to_missing_resource" && f.worker === "cryptophys-console")!;
  assert.equal(ghost.severity, "warning");
  assert.deepEqual(ghost.sample.bindings, [{ resource: "kv", name: "GHOST", id: "deadbeef" }]);
  const mt5 = fs.find((f) => f.metric === "binding_to_missing_resource" && f.worker === "mt5-mcp")!;
  assert.deepEqual(mt5.sample.bindings, [{ resource: "d1", name: "LEGACY_DB", id: "5c6f2a1e-0000-4000-8000-000000000002" }], "one finding per Worker, every missing resource in it");
  assert.equal(fs.find((f) => f.worker === "kv:xauusd-preview-oauth-store" && f.metric === "unbound_resource")!.sample.id, KV_C);
});

test("BI5. boundBy: is KV id X bound by any live Worker, and is the answer complete", () => {
  const full = index({
    "mt5-mcp": { status: "ok", bindings: [{ type: "kv_namespace", name: "OAUTH_KV", id: KV_A }] },
    "mt5-readonly": { status: "ok", bindings: [{ type: "kv_namespace", name: "OAUTH_KV", id: KV_A }, { type: "d1", name: "DB", id: KV_B }] },
    "cryptophys-console": { status: "ok", bindings: [] },
  });
  assert.deepEqual(boundBy(full, "kv_namespace", KV_A), { bound_by: [{ worker: "mt5-mcp", binding: "OAUTH_KV" }, { worker: "mt5-readonly", binding: "OAUTH_KV" }], complete: true, unread: [] });
  assert.deepEqual(boundBy(full, "kv", KV_B), { bound_by: [], complete: true, unread: [] }, "a D1 with the same id is not a KV binding: proven unbound");
  assert.deepEqual(boundBy(full, "kv", KV_C).bound_by, []);
  const partial = index({ ...full.workers, "xauusd-omega": { status: "permission_missing", http: 403 } });
  assert.deepEqual(boundBy(partial, "kv", KV_C), { bound_by: [], complete: false, unread: ["xauusd-omega"] }, "empty, but not proven");
});

test("BI6. runInventory: the index is stored per Worker and is part of the digest; GET /v1/observer shows it", async () => {
  const db = migratedDb();
  const now = Date.parse("2026-11-15T10:27:00.000Z");
  db.raw.prepare("INSERT INTO forge_organism_census (main_sha, status, organs, agents, engines, voters, findings, genome, taken_at) VALUES (?, 'consistent', 2, 0, 0, 0, '[]', ?, ?)").run(
    "e".repeat(40), JSON.stringify([{ service: "cryptophys-console", kind: "service" }, { service: "mt5-mcp", kind: "service" }]), new Date(now - 3_600_000).toISOString());
  const answers = (kvId: string) => ({
    "list:scripts": { success: true, result: [{ id: "cryptophys-console" }, { id: "mt5-mcp" }, { id: "xauusd-omega" }] },
    "list:kv": () => new Response("{}", { status: 403 }),
    "settings:mt5-mcp": settings(kv("OAUTH_KV", kvId), { type: "plain_text", name: "MODE", text: "live" }),
    "settings:xauusd-omega": () => new Response("{}", { status: 403 }),
  });
  const cf = fakeCf(answers(KV_A));
  assert.equal((await runInventory({ ...ENV, DB: db }, now, cf.fetcher, {})).outcome, "recorded");
  assert.deepEqual(cf.calls.filter((c) => c.startsWith("settings:")).sort(), ["settings:cryptophys-console", "settings:mt5-mcp", "settings:xauusd-omega"]);
  const rows = () => db.raw.prepare("SELECT worker, status, bindings_json, detail FROM observer_worker_bindings ORDER BY worker").all() as any[];
  assert.deepEqual(rows().map((r) => [r.worker, r.status, r.bindings_json, r.detail]), [
    ["cryptophys-console", "ok", "[]", null],
    ["mt5-mcp", "ok", JSON.stringify([{ type: "kv_namespace", name: "OAUTH_KV", id: KV_A }]), null],
    ["xauusd-omega", "permission_missing", "[]", "http 403"],
  ]);
  const run = () => db.raw.prepare("SELECT datasets_json FROM observer_runs WHERE kind = 'inventory' ORDER BY ran_at DESC LIMIT 1").get() as any;
  assert.equal(JSON.parse(run().datasets_json).bindings, "partial: 2 of 3 Workers read, 1 bindings (1 permission_missing)");
  assert.equal(JSON.parse(run().datasets_json).bindings_stored, "ok");
  // The "is KV X bound" query of the report, on the stored rows.
  const isBound = db.raw.prepare(`SELECT w.worker, w.status FROM observer_worker_bindings w WHERE w.status <> 'ok' OR EXISTS (SELECT 1 FROM json_each(w.bindings_json) b
    WHERE json_extract(b.value, '$.type') = 'kv_namespace' AND json_extract(b.value, '$.id') LIKE ?) ORDER BY w.worker`);
  assert.deepEqual((isBound.all("49d3a958%") as any[]).map((r) => `${r.worker} ${r.status}`), ["mt5-mcp ok", "xauusd-omega permission_missing"]);
  assert.deepEqual((isBound.all("8044368b%") as any[]).map((r) => `${r.worker} ${r.status}`), ["xauusd-omega permission_missing"]);
  // Same bindings 30 minutes later: unchanged, no new row.
  const count = () => (db.raw.prepare("SELECT COUNT(*) AS n FROM observer_runs WHERE kind = 'inventory'").get() as any).n;
  assert.equal((await runInventory({ ...ENV, DB: db }, now + 30 * 60_000, fakeCf(answers(KV_A)).fetcher, {})).outcome, "unchanged");
  assert.equal(count(), 1);
  // One binding points elsewhere: the digest changes, a new row is recorded and the stored index follows.
  assert.equal((await runInventory({ ...ENV, DB: db }, now + 60 * 60_000, fakeCf(answers(KV_B)).fetcher, {})).outcome, "recorded");
  assert.equal(count(), 2);
  assert.equal(rows().find((r) => r.worker === "mt5-mcp").bindings_json, JSON.stringify([{ type: "kv_namespace", name: "OAUTH_KV", id: KV_B }]));
  // A Worker gone from the scripts list loses its row.
  const gone = { ...answers(KV_B), "list:scripts": { success: true, result: [{ id: "cryptophys-console" }, { id: "mt5-mcp" }] } };
  assert.equal((await runInventory({ ...ENV, DB: db }, now + 90 * 60_000, fakeCf(gone).fetcher, {})).outcome, "recorded");
  assert.deepEqual(rows().map((r) => r.worker), ["cryptophys-console", "mt5-mcp"]);
  // The view: read only, the stored index and whether it is complete.
  const view = await observerView({ ...ENV, DB: db } as any, now + 91 * 60_000) as any;
  assert.equal(view.available, true);
  const b = view.inventory.bindings;
  assert.deepEqual([b.workers, b.read, b.complete, b.unread, b.by_type], [2, 2, true, [], { kv_namespace: 1 }]);
  assert.deepEqual(b.index["mt5-mcp"], [{ type: "kv_namespace", name: "OAUTH_KV", id: KV_B }]);
  assert.ok(!JSON.stringify(view).includes("\"live\""), "no binding value reaches the view");
  // No reliable scripts list: nothing read, the stored index is left as it was.
  const none = fakeCf({ ...answers(KV_A), "list:scripts": () => new Response("{}", { status: 403 }) });
  assert.equal((await runInventory({ ...ENV, DB: db }, now + 120 * 60_000, none.fetcher, {})).outcome, "recorded");
  assert.ok(!none.calls.some((c) => c.startsWith("settings:")));
  assert.equal(JSON.parse(run().datasets_json).bindings, "skipped: no reliable scripts list");
  assert.deepEqual(rows().map((r) => r.worker), ["cryptophys-console", "mt5-mcp"]);
});

test("BI7. a token refused for every Worker's bindings is asked again only after 24 h; the view is null before any index", async () => {
  const db = migratedDb();
  assert.equal(((await observerView({ ...ENV, DB: db } as any)) as any).inventory.bindings, null, "nothing stored: null, never an empty claim");
  const now = Date.parse("2026-11-15T10:27:00.000Z");
  db.raw.prepare("INSERT INTO forge_organism_census (main_sha, status, organs, agents, engines, voters, findings, genome, taken_at) VALUES (?, 'consistent', 1, 0, 0, 0, '[]', ?, ?)").run(
    "f".repeat(40), JSON.stringify([{ service: "cryptophys-console", kind: "service" }]), new Date(now - 3_600_000).toISOString());
  const refused = { "list:scripts": { success: true, result: [{ id: "cryptophys-console" }] }, "settings:cryptophys-console": () => new Response("{}", { status: 403 }) };
  assert.equal((await runInventory({ ...ENV, DB: db }, now, fakeCf(refused).fetcher, {})).outcome, "recorded");
  const later = fakeCf(refused);
  await runInventory({ ...ENV, DB: db }, now + 30 * 60_000, later.fetcher, {});
  assert.ok(!later.calls.some((c) => c.startsWith("settings:")), "not asked again within 24 h");
  const dayLater = fakeCf(refused);
  await runInventory({ ...ENV, DB: db }, now + 25 * 3_600_000, dayLater.fetcher, {});
  assert.deepEqual(dayLater.calls.filter((c) => c.startsWith("settings:")), ["settings:cryptophys-console"]);
  const f = db.raw.prepare("SELECT metric, kind FROM observer_findings WHERE metric LIKE '%bindings%'").all() as any[];
  assert.deepEqual([...new Set(f.map((x) => `${x.metric} ${x.kind}`))], ["inventory_permission_missing:bindings capability"]);
});
