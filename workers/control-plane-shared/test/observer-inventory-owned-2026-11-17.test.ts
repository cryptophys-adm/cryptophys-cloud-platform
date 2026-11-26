// The Observer's inventory against what really exists and who owns it (owner 2026-11-17, "Ya, kerjakan").
//  1. Deleted Workers: on 2026-11-17 three deleted CI preview Workers (xauusd-ai-preview-<n>) and xauusd-content were
//     reported as undeclared_worker warnings from their 7-day analytics alone; none was on the account's scripts list.
//     A Worker is live only when its script is on a reliable scripts list; one the list does not hold is deleted_worker
//     (informational), never undeclared and never a warning.
//  2. External organs' storage: the xauusd and Aether repositories bind their own D1, KV, R2 and queues, so they were
//     undeclared_resource ("no wrangler.toml of this repository binds it"). They are organ_resource, "owned by organ
//     <origin>", with their evidence: a live Worker of the organ, a reviewed wrangler entry, or the labelled name prefix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migratedDb, lastReviewedRecord } from "./harness.ts";
import type { Finding } from "../src/observer.ts";
import {
  CI_PREVIEW_RESOURCES, DECLARED_RESOURCES, LISTS, ORGAN_NAME_PREFIXES, ORGAN_RESOURCES, compareInventory, organOwnerOf, runInventory,
  type KnownOrganism, type ListKey, type ListResult,
} from "../src/observer-inventory.ts";
import type { BindingIndex } from "../src/observer-bindings.ts";
import { EXTERNAL_ORIGINS } from "../src/organism.ts";
import { observerCycle } from "../../ai-kernel/src/observer-watch.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const ENV = { CF_ANALYTICS_TOKEN: "analytics-token", CF_ACCOUNT_ID: ACCOUNT };
const EXTERNAL = Object.fromEntries(EXTERNAL_ORIGINS.map((o) => [o.origin, o.services]));
const kinds = (fs: Finding[]) => fs.map((f) => `${f.metric} ${f.worker}`).sort();
const list = (...items: Array<[string, string]>): ListResult => ({ status: "ok", items: items.map(([id, name]) => ({ id, name })) });
const scripts = (...names: string[]): ListResult => ({ status: "ok", items: names.map((n) => ({ id: n, name: n })) });
const known = (over: Partial<KnownOrganism> = {}): KnownOrganism => ({
  declared: new Set(["cryptophys-console", "xauusd-ai-trading-assistant"]), stubs: new Set(), unknown_origins: new Set(), disabled: new Set(), census_at: "2026-11-17T09:00:00.000Z", ...over,
});

// The deleted Workers of 2026-11-17 and their 7-day requests, as the analytics saw them.
const DELETED: Array<[string, number]> = [["xauusd-ai-preview-43727660332", 96], ["xauusd-ai-preview-43772457234", 106], ["xauusd-ai-preview-43807699793", 102], ["xauusd-content", 5]];

// The account's storage on 2026-11-17 (D1 uuid and KV id as listed; R2 and queues by name).
const D1_LIST = list(["47f4462a-1871-4d1a-a74c-d265cf241c37", "aether-knowledge"], ["3f62fa1a-9bf5-4de0-9de5-7f235cddf550", "cryptophys-control-plane"],
  ["90f53f14-ff7b-46c1-b146-a1efd4e13018", "xauusd-signals-preview"], ["ff99b940-254e-4d44-ac1d-bccb9ed18f6e", "xauusd-signals"]);
const KV_LIST = list(["0cbd6ecc0fbc4dc99342960456ca71e5", "xauusd-preview-signal-cache"], ["2000943b5db042f582b03043c75d5b1c", "xauusd-preview-webhook-buffer"],
  ["4ada6196de5a4000a28a047bf6b30ff3", "xauusd-signal-cache"], ["773182e4a26c444e8f56c3e58a1987ef", "xauusd-preview-knowledge-base"],
  ["a1c0f1055bd1434192d681a45866614d", "xauusd-fundamental-news-oauth"], ["a7ceeae9a1d2471980e2bc71cb38e041", "xauusd-webhook-buffer"], ["f611edadb19c4260a111eb5796f2fba7", "xauusd-knowledge-base"]);
// + cryptophys-council-transcripts, created 2026-11-18 for HAIC H1.5e (bound by the AI Kernel); + cryptophys-ledger-anchors,
// created 2026-11-20 for ADR-0021's tamper evidence (bound by the Recovery Manager).
const R2_LIST = list(["cryptophys-d1-backups", "cryptophys-d1-backups"], ["cryptophys-forge-bundles", "cryptophys-forge-bundles"], ["xauusd-room-transcripts", "xauusd-room-transcripts"], ["cryptophys-council-transcripts", "cryptophys-council-transcripts"], ["cryptophys-ledger-anchors", "cryptophys-ledger-anchors"]);
const QUEUE_NAMES = ["xauusd-webhook-events", "xauusd-webhook-events-dlq", "xauusd-webhook-events-preview", "xauusd-webhook-events-preview-dlq"];
const QUEUES_LIST = list(...QUEUE_NAMES.map((n) => [`q-${n}`, n] as [string, string]));
const OWNED = [
  "d1:aether-knowledge", "d1:xauusd-signals", "d1:xauusd-signals-preview",
  "kv:xauusd-fundamental-news-oauth", "kv:xauusd-knowledge-base", "kv:xauusd-preview-knowledge-base", "kv:xauusd-preview-signal-cache", "kv:xauusd-preview-webhook-buffer", "kv:xauusd-signal-cache", "kv:xauusd-webhook-buffer",
  "queues:xauusd-webhook-events", "queues:xauusd-webhook-events-dlq", "queues:xauusd-webhook-events-preview", "queues:xauusd-webhook-events-preview-dlq",
  "r2:xauusd-room-transcripts",
];

test("IO1. a Worker with 7-day analytics but no script on the scripts list is deleted_worker (info), never an undeclared warning; a listed undeclared one still is", () => {
  const fs = compareInventory({
    known: known(), lists: { scripts: scripts("cryptophys-console", "xauusd-ai-trading-assistant", "rogue-worker") },
    traffic7d: new Map<string, number>([["cryptophys-console", 900], ["xauusd-ai-trading-assistant", 50], ["rogue-worker", 42], ["gone-quiet", 0], ...DELETED]),
    senses_cover_7d: true, day: "2026-11-17",
  });
  assert.deepEqual(kinds(fs), [...DELETED.map(([w]) => `deleted_worker ${w}`), "undeclared_worker rogue-worker"].sort(), "gone-quiet: deleted and silent, so neither deleted_worker nor idle_worker");
  const rogue = fs.find((f) => f.worker === "rogue-worker")!;
  assert.deepEqual([rogue.severity, rogue.sample.in_scripts_list], ["warning", true], "a script that exists and is undeclared is still a warning");
  assert.equal(rogue.detail, "rogue-worker is live with 42 requests in 7 days but no DNA declares it");
  for (const f of fs.filter((x) => x.metric === "deleted_worker")) {
    assert.deepEqual([f.kind, f.severity, f.report_only, f.sample.in_scripts_list], ["inventory", "info", true, false]);
    assert.doesNotMatch(f.detail, /undeclared|no DNA declares|is live/);
  }
  assert.equal(fs.find((f) => f.worker === "xauusd-ai-preview-43727660332")!.detail,
    "xauusd-ai-preview-43727660332 is not on the account's Workers list (deleted); it still had 96 requests within 7 days (informational)");
  assert.equal(fs.find((f) => f.worker === "xauusd-content")!.detail, "xauusd-content is not on the account's Workers list (deleted); it still had 5 requests within 7 days (informational)");
  // Without a reliable scripts list, analytics alone prove neither live nor deleted: nothing is said of these Workers.
  for (const l of [{ status: "unavailable", reason: "http_500" }, { status: "permission_missing", http: 403 }] as ListResult[]) {
    const unread = compareInventory({ known: known(), lists: { scripts: l }, traffic7d: new Map<string, number>([["rogue-worker", 42], ...DELETED]), senses_cover_7d: true, day: "2026-11-17" });
    const analyticsOnly = ["rogue-worker", ...DELETED.map(([w]) => w)];
    assert.deepEqual(kinds(unread.filter((f) => analyticsOnly.includes(f.worker))), [], l.status);
  }
});

test("IO2. the account's storage of 2026-11-17: every xauusd and Aether resource is owned by its organ (info), none undeclared; one matching no organ stays undeclared", () => {
  const fs = compareInventory({
    known: known(), traffic7d: new Map([["cryptophys-console", 1], ["xauusd-ai-trading-assistant", 1]]), senses_cover_7d: false, day: "2026-11-17",
    lists: { d1: D1_LIST, kv: KV_LIST, r2: R2_LIST, queues: QUEUES_LIST },
  });
  const storage = kinds(fs).filter((k) => /^(organ|undeclared)_resource /.test(k));
  assert.deepEqual(storage, OWNED.map((w) => `organ_resource ${w}`).sort(), "this repository's D1 and R2 are declared; the 15 others are an organ's");
  for (const f of fs.filter((x) => x.metric === "organ_resource")) {
    assert.deepEqual([f.severity, f.report_only, f.sample.origin, f.sample.evidence], ["info", true, f.worker === "d1:aether-knowledge" ? "aether" : "xauusd", "wrangler"], f.worker);
    assert.match(f.detail, / is owned by organ (xauusd|aether): bound in cryptophys-adm\/(xauusd-ai-trading-assistant|cryptophys-aether) /);
  }
  const detail = (w: string) => fs.find((f) => f.worker === w)!.detail;
  assert.equal(detail("d1:aether-knowledge"), "D1 aether-knowledge is owned by organ aether: bound in cryptophys-adm/cryptophys-aether wrangler.jsonc (AETHER_DB) and its organism.json storage.d1; no wrangler.toml of this repository binds it (informational)");
  assert.equal(detail("kv:xauusd-fundamental-news-oauth"), "KV xauusd-fundamental-news-oauth is owned by organ xauusd: bound in cryptophys-adm/xauusd-ai-trading-assistant fundamental-news-ingestion/wrangler.jsonc (OAUTH_STORE); no wrangler.toml of this repository binds it (informational)");
  assert.equal(detail("r2:xauusd-room-transcripts"), "R2 xauusd-room-transcripts is owned by organ xauusd: bound in cryptophys-adm/xauusd-ai-trading-assistant wrangler.jsonc (ROOM_TRANSCRIPTS); no wrangler.toml of this repository binds it (informational)");
  assert.match(detail("d1:xauusd-signals-preview"), /^D1 xauusd-signals-preview is owned by organ xauusd: bound in cryptophys-adm\/xauusd-ai-trading-assistant wrangler\.preview\.jsonc /);
  // A KV renamed on the account still matches by the config's id.
  const renamed = compareInventory({ known: known(), traffic7d: new Map(), senses_cover_7d: false, day: "2026-11-17", lists: { kv: list(["f611edadb19c4260a111eb5796f2fba7", "renamed-kb"]) } });
  assert.deepEqual(kinds(renamed), ["organ_resource kv:renamed-kb"]);
  // Not in any reviewed list: an organ's name prefix is a labelled fallback; a resource that matches no organ stays as it was.
  const other = compareInventory({ known: known(), traffic7d: new Map(), senses_cover_7d: false, day: "2026-11-17", lists: { r2: list(["xauusd-new-bucket", "xauusd-new-bucket"], ["stray-bucket", "stray-bucket"], ...DECLARED_RESOURCES.r2.map((n) => [n, n] as [string, string])) } });
  assert.deepEqual(kinds(other), ["organ_resource r2:xauusd-new-bucket", "undeclared_resource r2:stray-bucket"]);
  const prefixed = other.find((f) => f.metric === "organ_resource")!;
  assert.deepEqual([prefixed.severity, prefixed.sample.evidence, prefixed.sample.prefix], ["info", "name_prefix", "xauusd-"]);
  assert.equal(prefixed.detail, "R2 xauusd-new-bucket is owned by organ xauusd: by the name prefix xauusd- only, a naming rule: no live Worker or reviewed wrangler file of the organ names it; no wrangler.toml of this repository binds it (informational)");
  assert.equal(other.find((f) => f.metric === "undeclared_resource")!.detail, "R2 stray-bucket is on the account; no wrangler.toml of this repository binds it (storage has no DNA yet; informational)");
});

test("IO3. organOwnerOf: a live Worker of an external origin is the first evidence, then the reviewed wrangler list, then the prefix; a platform Worker is never an organ's evidence", () => {
  const idx: BindingIndex = { listed: 3, cap: 50, workers: {
    "cryptophys-console": { status: "ok", bindings: [{ type: "r2_bucket", name: "STRAY", id: "stray-bucket" }] },
    "cryptophys-aether": { status: "ok", bindings: [{ type: "d1", name: "AETHER_DB", id: "47f4462a-1871-4d1a-a74c-d265cf241c37" }] },
    "xauusd-ai-trading-assistant": { status: "ok", bindings: [{ type: "d1", name: "DB", id: "ff99b940-254e-4d44-ac1d-bccb9ed18f6e" }, { type: "queue", name: "XAUUSD_EVENTS", id: "xauusd-webhook-events" }] },
  } };
  assert.deepEqual(organOwnerOf("d1", { id: "ff99b940-254e-4d44-ac1d-bccb9ed18f6e", name: "xauusd-signals" }, idx), { origin: "xauusd", evidence: "live_binding", worker: "xauusd-ai-trading-assistant", via: "binding DB" });
  assert.deepEqual(organOwnerOf("d1", { id: "47f4462a-1871-4d1a-a74c-d265cf241c37", name: "aether-knowledge" }, idx), { origin: "aether", evidence: "live_binding", worker: "cryptophys-aether", via: "binding AETHER_DB" });
  assert.deepEqual(organOwnerOf("queues", { id: "q1", name: "xauusd-webhook-events" }, idx)?.evidence, "live_binding");
  assert.equal(organOwnerOf("r2", { id: "stray-bucket", name: "stray-bucket" }, idx), null, "bound by a platform Worker: not an external organ's");
  // A queue consumed by a Worker of an origin.
  const qi = { cap: 50, queues: { "xauusd-other": { status: "ok" as const, source: "list" as const, consumers: [{ type: "worker", script: "xauusd-omega" }] } } };
  assert.deepEqual(organOwnerOf("queues", { id: "q2", name: "xauusd-other" }, null, qi), { origin: "xauusd", evidence: "live_binding", worker: "xauusd-omega", via: "queue consumer" });
  // The live finding text with a live binding.
  const fs = compareInventory({ known: known(), traffic7d: new Map(), senses_cover_7d: false, day: "2026-11-17", bindings: idx, lists: { d1: D1_LIST } });
  assert.equal(fs.find((f) => f.worker === "d1:xauusd-signals")!.detail, "D1 xauusd-signals is owned by organ xauusd: the live Worker xauusd-ai-trading-assistant of that organ uses it (binding DB); no wrangler.toml of this repository binds it (informational)");
  // The reviewed lists: every origin is an EXTERNAL_ORIGINS origin, every entry names its source, the CI preview entries are xauusd's,
  // and neither a reviewed entry nor a prefix can take a resource this repository declares.
  const origins = EXTERNAL_ORIGINS.map((o) => o.origin);
  for (const r of ORGAN_RESOURCES) {
    assert.ok(origins.includes(r.origin) && r.source && r.name, r.name);
    assert.ok(!(DECLARED_RESOURCES[r.resource] as readonly string[]).includes(r.name), r.name);
  }
  for (const r of CI_PREVIEW_RESOURCES) assert.ok(ORGAN_RESOURCES.some((o) => o.origin === "xauusd" && o.resource === r.resource && o.name === r.name), r.name);
  assert.deepEqual(ORGAN_NAME_PREFIXES.map((p) => [p.origin, p.prefix]), [["xauusd", "xauusd-"], ["aether", "aether-"]]);
  for (const p of ORGAN_NAME_PREFIXES) {
    assert.ok(origins.includes(p.origin));
    for (const names of Object.values(DECLARED_RESOURCES)) for (const n of names) assert.ok(!n.startsWith(p.prefix), n);
  }
});

type Answer = unknown | (() => Response);
/** A fake Cloudflare API (read only): the account lists, each Worker's settings and each queue's consumers. */
function fakeCf(over: Record<string, Answer>) {
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    assert.equal(init?.method ?? "GET", "GET", "read only");
    const path = url.replace(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/`, "");
    const s = /^workers\/scripts\/([^/]+)\/settings$/.exec(path);
    const c = /^queues\/([^/]+)\/consumers$/.exec(path);
    const key = s ? `settings:${decodeURIComponent(s[1])}` : c ? `consumers:${decodeURIComponent(c[1])}` : `list:${(Object.keys(LISTS) as ListKey[]).find((k) => LISTS[k].path === path)}`;
    const fallback = s ? { success: true, result: { bindings: [] } } : { success: true, result: key === "list:r2" ? { buckets: [] } : [] };
    const v = Object.hasOwn(over, key) ? over[key] : fallback;
    return typeof v === "function" ? (v as () => Response)() : Response.json(v);
  };
  return fetcher;
}

test("IO4. runInventory on the 2026-11-17 account, then the Supervisor's cycle: the info findings are stored, and nothing proposes, retires or reports on them", async () => {
  const db = migratedDb();
  const now = Date.parse("2026-11-17T09:57:00.000Z");
  db.raw.prepare("INSERT INTO forge_organism_census (main_sha, status, organs, agents, engines, voters, findings, genome, taken_at) VALUES (?, 'consistent', 3, 0, 0, 0, '[]', ?, ?)").run(
    "e".repeat(40), JSON.stringify([{ service: "cryptophys-console", kind: "service" }, { service: "xauusd-ai-trading-assistant", kind: "service", origin: "xauusd" }, { service: "cryptophys-aether", kind: "service", origin: "aether" }]),
    new Date(now - 3_600_000).toISOString());
  const vitals = db.raw.prepare("INSERT INTO observer_vitals (subject, kind, hour, requests, errors, recorded_at) VALUES (?, 'worker', ?, ?, 0, ?)");
  const hour = new Date(now - 2 * 86_400_000).toISOString();
  for (const [w, n] of [["cryptophys-console", 900], ["xauusd-ai-trading-assistant", 50], ["cryptophys-aether", 20], ...DELETED] as Array<[string, number]>) vitals.run(w, hour, n, hour);
  const row = (n: string, consumers: unknown[]) => ({ queue_id: `q-${n}`, queue_name: n, consumers, consumers_total_count: consumers.length });
  const fetcher = fakeCf({
    "list:scripts": { success: true, result: [{ id: "cryptophys-console" }, { id: "xauusd-ai-trading-assistant" }, { id: "cryptophys-aether" }] },
    "list:d1": { success: true, result: D1_LIST.status === "ok" ? D1_LIST.items.map((x) => ({ uuid: x.id, name: x.name })) : [] },
    "list:kv": { success: true, result: KV_LIST.status === "ok" ? KV_LIST.items.map((x) => ({ id: x.id, title: x.name })) : [] },
    "list:r2": { success: true, result: { buckets: R2_LIST.status === "ok" ? R2_LIST.items.map((x) => ({ name: x.name })) : [] } },
    "list:queues": { success: true, result: [row("xauusd-webhook-events", [{ type: "worker", script_name: "xauusd-ai-trading-assistant", dead_letter_queue: "xauusd-webhook-events-dlq" }]), ...QUEUE_NAMES.slice(1).map((n) => row(n, []))] },
    "settings:xauusd-ai-trading-assistant": { success: true, result: { bindings: [{ type: "d1", name: "DB", database_id: "ff99b940-254e-4d44-ac1d-bccb9ed18f6e" }, { type: "queue", name: "XAUUSD_EVENTS", queue_name: "xauusd-webhook-events" }] } },
  });
  assert.equal((await runInventory({ ...ENV, DB: db } as never, now, fetcher, EXTERNAL)).outcome, "recorded");
  const stored = db.raw.prepare("SELECT worker, metric, severity, report_only, sample_json FROM observer_findings WHERE kind = 'inventory' ORDER BY worker, metric").all() as any[];
  const by = (m: string) => stored.filter((r) => r.metric === m).map((r) => r.worker);
  assert.deepEqual(by("undeclared_worker"), [], "no deleted Worker is undeclared");
  assert.deepEqual(by("undeclared_resource"), [], "no organ's storage is undeclared");
  assert.deepEqual(by("deleted_worker"), DELETED.map(([w]) => w).sort());
  assert.deepEqual(by("organ_resource"), [...OWNED].sort());
  assert.ok(stored.every((r) => r.severity === "info" && r.report_only === 1), JSON.stringify(stored.filter((r) => r.severity !== "info")));
  const evidence = (w: string) => JSON.parse(stored.find((r) => r.worker === w).sample_json).evidence;
  assert.deepEqual([evidence("d1:xauusd-signals"), evidence("queues:xauusd-webhook-events"), evidence("queues:xauusd-webhook-events-dlq")], ["live_binding", "live_binding", "wrangler"]);
  // The Supervisor's cycle: inventory findings are advisory, action none; no proposal is made from them.
  const mem = new Map<string, unknown>();
  const memory = { async get<T>(k: string) { return mem.get(k) as T | undefined; }, async put(k: string, v: unknown) { mem.set(k, v); } };
  const report = { agent_id: "supervisor", trigger: "scheduled", cycle_at: new Date(now).toISOString(), findings: [] as any[], actions: [] as any[] };
  const proposed: unknown[] = [];
  await observerCycle({ DB: db } as never, memory as never, report as never, "scheduled", async (input) => { proposed.push(input); return null; }, now + 60_000);
  assert.deepEqual(proposed, [], "no proposal (rollback, retire or any other) from an inventory finding");
  assert.deepEqual(report.actions, []);
  assert.ok(report.findings.length > 0 && report.findings.every((f) => f.kind === "observer" && f.action === "none" && f.advisory === true));
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM consensus_proposals").get() as any).n, 0);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_reports").get() as any).n, 0, "no report is published from the inventory");
});

test("IO5. docs/SSOT.md: the 2026-11-17 inventory fixes in the Last reviewed group and the Observer's inventory description", () => {
  const ssot = read("docs/SSOT.md");
  assert.match(lastReviewedRecord(), /(?:^Last reviewed: |\); )2026-11-16 \([^\n]*the Observer's inventory against what exists and who owns it: [^()]*`deleted_worker`[^()]*`organ_resource`[^()]*; /);
  const inventory = ssot.split("\n").find((l) => l.startsWith("- **Inventory (:27 and :57).**"))!;
  for (const want of ["`deleted_worker`", "`organ_resource`", "`ORGAN_RESOURCES`", "`ORGAN_NAME_PREFIXES`", "owned by organ"]) assert.ok(inventory.includes(want), want);
});
