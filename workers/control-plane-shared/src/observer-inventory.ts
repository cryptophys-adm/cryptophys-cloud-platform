/**
 * The Observer's account inventory (owner 2026-11-14), every 30 minutes (Platform API cron :27 and :57): what lives
 * on the Cloudflare account against what the platform knows of itself.
 *
 * Known: the union of all DNA, as the Forge's latest census recorded it (forge_organism_census.genome: every
 * workers/<dir>/organism.json of main plus the external organs read over EXT_ORGANISM_*), and the resources the
 * repository's wrangler.toml files bind (DECLARED_RESOURCES; storage resources have no DNA yet, a later change
 * extends the schema). Live: the account's lists (Workers scripts, D1, KV, R2, Queues, Durable Object namespaces),
 * read with the Observer's token, and the scripts the analytics saw in the last 7 days (observer_vitals).
 *
 * Findings: undeclared_worker (live, with traffic, in no DNA), undeclared_resource (informational), orphaned_declaration
 * (declared, gone from the account), idle_worker (no traffic for 7 days, once the Observer has 7 days of senses).
 * Never reported: preview or environment copies of a declared Worker (<name>-preview, -staging, -dev, -pr-<n>,
 * -cr-<n>), Workers the registry marks disabled (being retired), and the organs of an external origin whose DNA the
 * census could not read. Aether is report only. A list the token may not read (401/403) is a capability finding
 * naming the permission, checked again after 24 h; nothing is guessed from its absence.
 */
import type { D1Database } from "./types.ts";
import { THRESHOLDS, REPORT_ONLY_WORKERS, observerCredentials, recordRun, storeFindings, type Finding, type ObserverEnv } from "./observer.ts";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
const DAY_MS = 86_400_000;

/** What the repository's wrangler.toml files bind (a test keeps this equal to the files). */
export const DECLARED_RESOURCES = Object.freeze({
  d1: Object.freeze(["cryptophys-control-plane"]),
  r2: Object.freeze(["cryptophys-d1-backups", "cryptophys-forge-bundles"]),
  kv: Object.freeze([] as string[]),
  queues: Object.freeze([] as string[]),
});

/** A preview or environment copy of `base` (Workers Builds previews, wrangler environments). */
export const PREVIEW_SUFFIX = /^(.+?)-(preview|staging|dev|pr-\d+|cr-\d+)$/;
export function previewOf(script: string, declared: ReadonlySet<string>): string | null {
  const m = PREVIEW_SUFFIX.exec(script);
  return m && declared.has(m[1]) ? m[1] : null;
}

export type ListKey = "scripts" | "d1" | "kv" | "r2" | "queues" | "durable_objects";
export const LISTS: Readonly<Record<ListKey, { path: string; permission: string }>> = Object.freeze({
  scripts: { path: "workers/scripts", permission: "Account > Workers Scripts > Read" },
  d1: { path: "d1/database?per_page=100", permission: "Account > D1 > Read" },
  kv: { path: "storage/kv/namespaces?per_page=100", permission: "Account > Workers KV Storage > Read" },
  r2: { path: "r2/buckets", permission: "Account > Workers R2 Storage > Read" },
  queues: { path: "queues", permission: "Account > Queues > Read" },
  durable_objects: { path: "workers/durable_objects/namespaces?per_page=100", permission: "Account > Workers Scripts > Read" },
});

export interface LiveItem { id: string; name: string; script?: string }
export type ListResult = { status: "ok"; items: LiveItem[] } | { status: "permission_missing"; http: number } | { status: "unavailable"; reason: string } | { status: "skipped" };

export function parseList(key: ListKey, body: any): LiveItem[] {
  const result = body?.result;
  const rows: any[] = key === "r2" ? (Array.isArray(result?.buckets) ? result.buckets : []) : Array.isArray(result) ? result : [];
  const out: LiveItem[] = [];
  for (const r of rows) {
    const item: LiveItem | null =
      key === "scripts" ? (r?.id ? { id: String(r.id), name: String(r.id) } : null)
      : key === "d1" ? (r?.uuid ? { id: String(r.uuid), name: String(r.name ?? r.uuid) } : null)
      : key === "kv" ? (r?.id ? { id: String(r.id), name: String(r.title ?? r.id) } : null)
      : key === "r2" ? (r?.name ? { id: String(r.name), name: String(r.name) } : null)
      : key === "queues" ? (r?.queue_id || r?.queue_name ? { id: String(r.queue_id ?? r.queue_name), name: String(r.queue_name ?? r.queue_id) } : null)
      : r?.id ? { id: String(r.id), name: String(r.class ?? r.name ?? r.id), ...(r.script ? { script: String(r.script) } : {}) } : null;
    if (item) out.push(item);
  }
  return out;
}

export async function readList(token: string, account: string, key: ListKey, fetcher: Fetch): Promise<ListResult> {
  let res: Response;
  try {
    res = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${account}/${LISTS[key].path}`, { headers: { authorization: `Bearer ${token}` } });
  } catch (err) {
    return { status: "unavailable", reason: String((err as Error)?.message ?? err).slice(0, 120) };
  }
  if (res.status === 401 || res.status === 403) { await res.body?.cancel(); return { status: "permission_missing", http: res.status }; }
  const body = await res.json().catch(() => null) as any;
  if (!res.ok || !body || body.success === false) return { status: "unavailable", reason: `http_${res.status}` };
  return { status: "ok", items: parseList(key, body) };
}

export interface KnownOrganism {
  /** Every service in the DNA union (main and external organs). */
  declared: Set<string>;
  /** Build stubs (never get traffic, so never idle). */
  stubs: Set<string>;
  /** Services of an external origin whose DNA the census could not read: neither undeclared nor orphaned. */
  unknown_origins: Set<string>;
  /** Registry rows marked disabled (retired or being retired). */
  disabled: Set<string>;
  census_at: string | null;
}

/** The DNA union from the Forge's latest census, and the registry's disabled services. Null without a census. */
export async function knownOrganism(db: D1Database, externalServices: Readonly<Record<string, readonly string[]>>): Promise<KnownOrganism | null> {
  const row = await db.prepare("SELECT genome, findings, taken_at FROM forge_organism_census ORDER BY taken_at DESC LIMIT 1").first<{ genome: string | null; findings: string; taken_at: string }>();
  if (!row) return null;
  let genome: Array<{ service?: string; kind?: string }> = [];
  let findings: Array<{ kind?: string; subject?: string }> = [];
  try { genome = JSON.parse(row.genome ?? "[]"); findings = JSON.parse(row.findings ?? "[]"); } catch { return null; }
  if (!Array.isArray(genome) || genome.length === 0) return null;
  const declared = new Set(genome.map((d) => String(d?.service ?? "")).filter(Boolean));
  const stubs = new Set(genome.filter((d) => d?.kind === "build-stub").map((d) => String(d.service)));
  const unknown_origins = new Set<string>();
  for (const f of Array.isArray(findings) ? findings : []) {
    if (f?.kind === "external_dna_unavailable") for (const s of externalServices[String(f.subject)] ?? []) unknown_origins.add(s);
  }
  const disabled = new Set(((await db.prepare("SELECT service_id FROM service_registry WHERE status = 'disabled'").all<{ service_id: string }>()).results ?? []).map((r) => r.service_id));
  return { declared, stubs, unknown_origins, disabled, census_at: row.taken_at };
}

export interface InventoryInput {
  known: KnownOrganism;
  lists: Partial<Record<ListKey, ListResult>>;
  /** Requests per script over the last 7 days (observer_vitals). */
  traffic7d: Map<string, number>;
  /** The Observer has stored senses for at least 7 days (idle findings need that). */
  senses_cover_7d: boolean;
  day: string;
}

const finding = (day: string, worker: string, metric: string, detail: string, sample: Record<string, unknown>, severity: "info" | "warning" = "info", report_only = true): Finding => ({
  worker, metric, kind: "inventory", severity, bucket: day, value: null, baseline_7d: null, z: null, since_deploy: null, sample, detail: detail.slice(0, 500), report_only,
});

/** Compare live with known (pure; exported for tests). */
export function compareInventory(i: InventoryInput): Finding[] {
  const out: Finding[] = [];
  const k = i.known;
  const scripts = i.lists.scripts?.status === "ok" ? i.lists.scripts.items.map((s) => s.name) : null;
  const live = new Set([...(scripts ?? []), ...i.traffic7d.keys()]);
  const known = (w: string) => k.declared.has(w) || k.unknown_origins.has(w) || k.disabled.has(w) || previewOf(w, k.declared) !== null;
  for (const w of [...live].sort()) {
    if (known(w)) continue;
    const requests = i.traffic7d.get(w) ?? 0;
    if (requests > 0) {
      out.push(finding(i.day, w, "undeclared_worker", `${w} is live with ${requests.toLocaleString("en-US")} requests in 7 days but no DNA declares it${REPORT_ONLY_WORKERS.has(w) ? " (observed only; report only)" : ""}`,
        { requests_7d: requests, in_scripts_list: scripts?.includes(w) ?? null }, REPORT_ONLY_WORKERS.has(w) ? "info" : "warning"));
    } else if (i.senses_cover_7d) {
      out.push(finding(i.day, w, "idle_worker", `${w} is on the account, in no DNA, and had no traffic for ${THRESHOLDS.IDLE_DAYS} days`, { requests_7d: 0, declared: false }));
    }
  }
  for (const w of [...k.declared].sort()) {
    if (k.disabled.has(w) || k.unknown_origins.has(w)) continue;
    if (scripts && !scripts.includes(w)) {
      out.push(finding(i.day, w, "orphaned_declaration", `${w} is declared in the DNA but is not on the account's Workers list`, { kind: k.stubs.has(w) ? "build-stub" : "worker" }, "warning"));
      continue;
    }
    if (i.senses_cover_7d && !k.stubs.has(w) && (i.traffic7d.get(w) ?? 0) === 0 && (scripts === null || scripts.includes(w))) {
      out.push(finding(i.day, w, "idle_worker", `${w} is declared but had no traffic for ${THRESHOLDS.IDLE_DAYS} days`, { requests_7d: 0, declared: true }));
    }
  }
  const resource = (key: "d1" | "kv" | "r2" | "queues", declared: readonly string[]) => {
    const l = i.lists[key];
    if (l?.status !== "ok") return;
    const names = new Set(l.items.map((x) => x.name));
    for (const x of l.items) {
      if (!declared.includes(x.name)) out.push(finding(i.day, `${key}:${x.name}`, "undeclared_resource", `${key.toUpperCase()} ${x.name} is on the account; no wrangler.toml of this repository binds it (storage has no DNA yet; informational)`, { resource: key, id: x.id, name: x.name }));
    }
    for (const d of declared) if (!names.has(d)) out.push(finding(i.day, `${key}:${d}`, "orphaned_declaration", `${key.toUpperCase()} ${d} is bound in this repository but is not on the account`, { resource: key, name: d }, "warning"));
  };
  resource("d1", DECLARED_RESOURCES.d1); resource("kv", DECLARED_RESOURCES.kv); resource("r2", DECLARED_RESOURCES.r2); resource("queues", DECLARED_RESOURCES.queues);
  const dos = i.lists.durable_objects;
  if (dos?.status === "ok") {
    for (const ns of dos.items) {
      if (ns.script && (known(ns.script))) continue;
      out.push(finding(i.day, `do:${ns.name}`, "undeclared_resource", `Durable Object namespace ${ns.name}${ns.script ? ` of ${ns.script}` : ""} belongs to no Worker in the DNA (informational)`, { resource: "durable_objects", id: ns.id, script: ns.script ?? null }));
    }
  }
  for (const [key, l] of Object.entries(i.lists) as Array<[ListKey, ListResult]>) {
    if (l.status === "permission_missing") {
      out.push({ ...finding(i.day, "account", `inventory_permission_missing:${key}`, `The Observer's token may not list ${key} (HTTP ${l.http}); the inventory needs ${LISTS[key].permission} on the same token (owner)`, { http: l.http, permission: LISTS[key].permission }), kind: "capability" });
    }
  }
  return out;
}

const digestOf = async (s: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");
/** An unchanged inventory is written again only after this long (the heartbeat), never every run. */
export const INVENTORY_HEARTBEAT_MS = 6 * 3_600_000;

export async function runInventory(env: ObserverEnv, now: number, fetcher: Fetch, externalServices: Readonly<Record<string, readonly string[]>>): Promise<{ outcome: "not_configured" | "no_census" | "unchanged" | "recorded"; findings?: number }> {
  const creds = observerCredentials(env);
  if (!creds || !env.DB) return { outcome: "not_configured" };
  const db = env.DB;
  const known = await knownOrganism(db, externalServices);
  if (!known) return { outcome: "no_census" };
  const at = new Date(now).toISOString();
  const last = await db.prepare("SELECT ran_at, datasets_json, digest FROM observer_runs WHERE kind = 'inventory' ORDER BY ran_at DESC LIMIT 1").first<{ ran_at: string; datasets_json: string; digest: string | null }>();
  let previous: Record<string, string> = {};
  try { previous = JSON.parse(last?.datasets_json ?? "{}"); } catch { previous = {}; }
  const lists: Partial<Record<ListKey, ListResult>> = {};
  const datasets: Record<string, string> = {};
  for (const key of Object.keys(LISTS) as ListKey[]) {
    // Capability check: a list refused in the last 24 h is not asked again until then.
    const refused = /^permission_missing/.test(previous[key] ?? "") && last && now - Date.parse(last.ran_at) < DAY_MS;
    if (refused) {
      datasets[key] = previous[key];
      lists[key] = { status: "permission_missing", http: Number(/http (\d+)/.exec(previous[key])?.[1] ?? 403) };
      continue;
    }
    const r = await readList(creds.token, creds.account, key, fetcher);
    lists[key] = r;
    datasets[key] = r.status === "ok" ? `ok: ${r.items.length}` : r.status === "permission_missing" ? `permission_missing: http ${r.http}` : r.status === "unavailable" ? `unavailable: ${r.reason}` : "skipped";
  }
  const since = new Date(now - THRESHOLDS.IDLE_DAYS * DAY_MS).toISOString();
  const traffic = new Map(((await db.prepare("SELECT subject, SUM(requests) AS n FROM observer_vitals WHERE kind = 'worker' AND hour >= ? GROUP BY subject").bind(since).all<{ subject: string; n: number }>()).results ?? []).map((r) => [r.subject, Number(r.n ?? 0)]));
  const oldest = await db.prepare("SELECT MIN(bucket) AS b FROM observer_runs WHERE kind = 'senses' AND status <> 'unavailable'").first<{ b: string | null }>();
  const cover = Boolean(oldest?.b && now - Date.parse(oldest.b) >= THRESHOLDS.IDLE_DAYS * DAY_MS);
  const day = at.slice(0, 10);
  const findings = compareInventory({ known, lists, traffic7d: traffic, senses_cover_7d: cover, day });
  const digest = await digestOf(JSON.stringify({ f: findings.map((f) => [f.worker, f.metric]), d: datasets }));
  if (last && last.digest === digest && now - Date.parse(last.ran_at) < INVENTORY_HEARTBEAT_MS) return { outcome: "unchanged", findings: findings.length };
  await storeFindings(db, findings, at);
  const status = Object.values(datasets).every((s) => s.startsWith("ok")) ? "ok" : Object.values(datasets).some((s) => s.startsWith("ok")) ? "partial" : "unavailable";
  await recordRun(db, { kind: "inventory", bucket: at, ran_at: at, status, datasets: { ...datasets, census_at: known.census_at, senses_cover_7d: cover }, findings: findings.map((f) => ({ worker: f.worker, metric: f.metric, severity: f.severity, detail: f.detail })), digest });
  return { outcome: "recorded", findings: findings.length };
}
