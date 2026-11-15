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
 * Bindings (owner 2026-11-15, "tambahkan"; observer-bindings.ts): every listed Worker's bindings are read and stored as
 * an index, part of the digest. unbound_resource (informational): a listed KV/D1/R2/Queue that no live Worker binds
 * and no wrangler.toml declares, only when every Worker was read. binding_to_missing_resource (warning): a Worker binds
 * a KV/D1/R2/Queue that a readable list does not contain. bindings_unread / bindings_cap_exceeded name what was not read.
 * Queues (2026-11-15): a queue is referenced by a binding, by a consumer (a Worker or HTTP pull) or as the
 * dead_letter_queue of another queue's consumer (consumer settings, read from the queues list or the consumers
 * endpoint); unbound_resource for queues only when every queue's consumers were read, else queue_consumers_unread.
 * ci_preview (informational): a resource that would be unbound but is named in a CI preview config (CI_PREVIEW_RESOURCES).
 * Never reported: preview or environment copies of a declared Worker (<name>-preview, -staging, -dev, -pr-<n>,
 * -cr-<n>), Workers the registry marks disabled (being retired), and the organs of an external origin whose DNA the
 * census could not read. Aether is report only. A list the token may not read (401/403) is a capability finding
 * naming the permission, checked again after 24 h; nothing is guessed from its absence.
 */
import type { D1Database } from "./types.ts";
import { THRESHOLDS, REPORT_ONLY_WORKERS, observerCredentials, recordRun, storeFindings, type Finding, type ObserverEnv } from "./observer.ts";
import {
  BINDINGS_PERMISSION, QUEUE_CONSUMERS_PERMISSION, RESOURCE_BINDING, indexComplete, indexDatasetLine, indexDigestInput, listedConsumers, queueConsumersDatasetLine,
  queueConsumersDigestInput, queueReferences, readBindingIndex, readQueueConsumerIndex, storeBindingIndex,
  type BindingIndex, type QueueConsumer, type QueueConsumerIndex, type QueueConsumers, type WorkerBindings,
} from "./observer-bindings.ts";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
const DAY_MS = 86_400_000;
/**
 * A list (or the binding reads) refused with the same token is asked again after this long. It was 24 h until
 * 2026-11-15: the owner fixed the token's permissions, and the Observer kept reporting the old refusals, because the
 * 24 h counted from the last recorded row, which an unchanged inventory never renews. A changed token (its
 * fingerprint, never its value) is asked again at once.
 */
export const REFUSED_RETRY_MS = 3_600_000;

/** What the repository's wrangler.toml files bind (a test keeps this equal to the files). */
export const DECLARED_RESOURCES = Object.freeze({
  d1: Object.freeze(["cryptophys-control-plane"]),
  r2: Object.freeze(["cryptophys-d1-backups", "cryptophys-forge-bundles"]),
  kv: Object.freeze([] as string[]),
  queues: Object.freeze([] as string[]),
});

/**
 * Resources used intermittently by CI preview Workers (2026-11-15). The xauusd repository's deploy-preview-worker.yml
 * deploys a temporary preview Worker on every pull request from wrangler.preview.jsonc, runs its E2E tests and deletes
 * it, so between pull requests nothing binds or consumes these, and they were reported as unbound_resource. Such a
 * resource is `ci_preview` (informational), never unbound_resource. The census reads an external organ's DNA over
 * RPC (EXT_ORGANISM_*, OrganismDna.dna()), never its repository's files, so it cannot see a preview config; this
 * reviewed list names each resource with its source, a CI preview config: a wrangler.preview.jsonc, or the
 * `previews` / `env.preview` block of a wrangler.jsonc or wrangler.toml. A KV namespace or D1 database matches by its
 * id (the config's) or its name on the account; a queue (the config names queues) by its name.
 */
export interface CiPreviewResource { resource: "d1" | "kv" | "r2" | "queues"; name: string; id?: string; source: string }
const XAUUSD_PREVIEW = "cryptophys-adm/xauusd-ai-trading-assistant wrangler.preview.jsonc";
const XAUUSD_PREVIEWS_BLOCK = `${XAUUSD_PREVIEW} and the previews block of its wrangler.jsonc`;
export const CI_PREVIEW_RESOURCES: readonly CiPreviewResource[] = Object.freeze([
  { resource: "kv", name: "xauusd-preview-signal-cache", id: "0cbd6ecc0fbc4dc99342960456ca71e5", source: `${XAUUSD_PREVIEWS_BLOCK} (SIGNAL_CACHE)` },
  { resource: "kv", name: "xauusd-preview-webhook-buffer", id: "2000943b5db042f582b03043c75d5b1c", source: `${XAUUSD_PREVIEWS_BLOCK} (WEBHOOK_BUFFER)` },
  { resource: "kv", name: "xauusd-preview-knowledge-base", id: "773182e4a26c444e8f56c3e58a1987ef", source: `${XAUUSD_PREVIEWS_BLOCK} (KNOWLEDGE_BASE)` },
  { resource: "d1", name: "xauusd-signals-preview", id: "90f53f14-ff7b-46c1-b146-a1efd4e13018", source: `${XAUUSD_PREVIEWS_BLOCK} (DB)` },
  { resource: "queues", name: "xauusd-webhook-events-preview", source: `${XAUUSD_PREVIEW} (queues.producers XAUUSD_EVENTS, queues.consumers)` },
  { resource: "queues", name: "xauusd-webhook-events-preview-dlq", source: `${XAUUSD_PREVIEW} (dead_letter_queue of xauusd-webhook-events-preview)` },
].map((r) => Object.freeze(r as CiPreviewResource)));
/** The CI preview entry a listed resource matches, if any. */
export function ciPreviewOf(key: "d1" | "kv" | "r2" | "queues", item: { id: string; name: string }, list: readonly CiPreviewResource[] = CI_PREVIEW_RESOURCES): CiPreviewResource | null {
  return list.find((r) => r.resource === key && ((r.id !== undefined && r.id === item.id) || r.name === item.name)) ?? null;
}

/** A preview or environment copy of `base` (Workers Builds previews, wrangler environments). */
export const PREVIEW_SUFFIX = /^(.+?)-(preview|staging|dev|pr-\d+|cr-\d+)$/;
export function previewOf(script: string, declared: ReadonlySet<string>): string | null {
  const m = PREVIEW_SUFFIX.exec(script);
  return m && declared.has(m[1]) ? m[1] : null;
}

/** Names the analytics use for traffic without a script name; never a Worker. */
export const ANALYTICS_PLACEHOLDERS: ReadonlySet<string> = new Set(["__unknown__"]);

export type ListKey = "scripts" | "d1" | "kv" | "r2" | "queues" | "durable_objects";
export const LISTS: Readonly<Record<ListKey, { path: string; permission: string }>> = Object.freeze({
  scripts: { path: "workers/scripts", permission: "Account > Workers Scripts > Read" },
  d1: { path: "d1/database?per_page=100", permission: "Account > D1 > Read" },
  kv: { path: "storage/kv/namespaces?per_page=100", permission: "Account > Workers KV Storage > Read" },
  r2: { path: "r2/buckets", permission: "Account > Workers R2 Storage > Read" },
  queues: { path: "queues", permission: "Account > Queues > Read" },
  durable_objects: { path: "workers/durable_objects/namespaces?per_page=100", permission: "Account > Workers Scripts > Read" },
});

/** `consumers`: a queue's consumers, only when the queues list carried all of them (else they are read per queue). */
export interface LiveItem { id: string; name: string; script?: string; consumers?: QueueConsumer[] }
export type ListResult = { status: "ok"; items: LiveItem[] } | { status: "permission_missing"; http: number } | { status: "unavailable"; reason: string } | { status: "skipped" };

const queueItem = (r: any): LiveItem => {
  const item: LiveItem = { id: String(r.queue_id ?? r.queue_name), name: String(r.queue_name ?? r.queue_id) };
  const consumers = listedConsumers(r);
  if (consumers) item.consumers = consumers;
  return item;
};

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
      : key === "queues" ? (r?.queue_id || r?.queue_name ? queueItem(r) : null)
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
  /** The live Workers' bindings (null or absent: not read this run). */
  bindings?: BindingIndex | null;
  /** Every listed queue's consumers (null or absent: not read this run, so no queue is proven unbound). */
  queue_consumers?: QueueConsumerIndex | null;
  /** Requests per script over the last 7 days (observer_vitals). */
  traffic7d: Map<string, number>;
  /** The Observer has stored senses for at least 7 days (idle findings need that). */
  senses_cover_7d: boolean;
  day: string;
}

const finding = (day: string, worker: string, metric: string, detail: string, sample: Record<string, unknown>, severity: "info" | "warning" = "info", report_only = true): Finding => ({
  worker, metric, kind: "inventory", severity, bucket: day, value: null, baseline_7d: null, z: null, since_deploy: null, sample, detail: detail.slice(0, 500), report_only,
});

/**
 * The scripts list, when it can be trusted. A Workers list that comes back "ok" but leaves out every declared Worker
 * the analytics saw with traffic is not evidence that they are gone: on 2026-11-14 the token returned an empty list,
 * and all 17 declared Workers were reported as orphaned. Such a list is treated as unread.
 */
export function reliableScripts(scriptsList: ListResult | undefined, traffic7d: Map<string, number>, declared: ReadonlySet<string>): { listed: string[] | null; scripts: string[] | null; liveDeclared: string[] } {
  const listed = scriptsList?.status === "ok" ? scriptsList.items.map((s) => s.name) : null;
  const liveDeclared = [...traffic7d].filter(([w, n]) => n > 0 && !ANALYTICS_PLACEHOLDERS.has(w) && declared.has(w)).map(([w]) => w);
  const listUnreliable = listed !== null && liveDeclared.length > 0 && liveDeclared.every((w) => !listed.includes(w));
  return { listed, scripts: listUnreliable ? null : listed, liveDeclared };
}

/** Compare live with known (pure; exported for tests). */
export function compareInventory(i: InventoryInput): Finding[] {
  const out: Finding[] = [];
  const k = i.known;
  // Analytics placeholders are not Workers (2026-11-14: "__unknown__" was reported as an undeclared Worker).
  const traffic7d = new Map([...i.traffic7d].filter(([w]) => !ANALYTICS_PLACEHOLDERS.has(w)));
  const { listed, scripts, liveDeclared } = reliableScripts(i.lists.scripts, traffic7d, k.declared);
  const listUnreliable = listed !== null && scripts === null;
  if (listUnreliable) {
    out.push({ ...finding(i.day, "account", "inventory_permission_missing:scripts", `The Workers list came back with ${listed!.length} Worker(s) and none of the ${liveDeclared.length} declared Workers that had traffic in 7 days; the token likely lacks ${LISTS.scripts.permission} (owner)`, { listed: listed!.length, live_declared: liveDeclared.length, permission: LISTS.scripts.permission }), kind: "capability" });
  }
  const live = new Set([...(scripts ?? []), ...traffic7d.keys()]);
  const known = (w: string) => k.declared.has(w) || k.unknown_origins.has(w) || k.disabled.has(w) || previewOf(w, k.declared) !== null;
  for (const w of [...live].sort()) {
    if (known(w)) continue;
    const requests = traffic7d.get(w) ?? 0;
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
    if (i.senses_cover_7d && !k.stubs.has(w) && (traffic7d.get(w) ?? 0) === 0 && (scripts === null || scripts.includes(w))) {
      out.push(finding(i.day, w, "idle_worker", `${w} is declared but had no traffic for ${THRESHOLDS.IDLE_DAYS} days`, { requests_7d: 0, declared: true }));
    }
  }
  const queueRefs = i.queue_consumers ? queueReferences(i.queue_consumers) : null;
  const resource = (key: "d1" | "kv" | "r2" | "queues", declared: readonly string[]) => {
    const l = i.lists[key];
    if (l?.status !== "ok") return;
    const names = new Set(l.items.map((x) => x.name));
    for (const x of l.items) {
      // A queue's consumers and the queues that name it as their dead-letter queue (what references it besides bindings).
      const refs = key === "queues" && queueRefs ? { referenced_by: (queueRefs.refs.get(x.name) ?? []).slice(0, 10) } : {};
      if (!declared.includes(x.name)) out.push(finding(i.day, `${key}:${x.name}`, "undeclared_resource", `${key.toUpperCase()} ${x.name} is on the account; no wrangler.toml of this repository binds it (storage has no DNA yet; informational)`, { resource: key, id: x.id, name: x.name, ...refs }));
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
  out.push(...compareQueueConsumers(i.day, i.lists.queues, i.queue_consumers ?? null));
  if (i.bindings) out.push(...compareBindings(i.day, i.bindings, i.lists, i.queue_consumers ?? null));
  for (const [key, l] of Object.entries(i.lists) as Array<[ListKey, ListResult]>) {
    if (l.status === "permission_missing") {
      out.push({ ...finding(i.day, "account", `inventory_permission_missing:${key}`, `The Observer's token may not list ${key} (HTTP ${l.http}); the inventory needs ${LISTS[key].permission} on the same token (owner)`, { http: l.http, permission: LISTS[key].permission }), kind: "capability" });
    }
  }
  return out;
}

/**
 * What the run could not read of the queues' consumer settings (pure; part of compareInventory, exported for tests).
 * While any is unread, no queue is reported unbound: it may be consumed, or be another queue's dead-letter queue.
 */
export function compareQueueConsumers(day: string, queues: ListResult | undefined, index: QueueConsumerIndex | null): Finding[] {
  if (queues?.status !== "ok" || queues.items.length === 0) return [];
  if (!index) return [finding(day, "account", "queue_consumers_unread", `The consumers of the account's ${queues.items.length} queue(s) were not read this run; "no consumer and no dead-letter reference" is not proven, so no queue is reported unbound`, { queues: queues.items.length, unread: queues.items.slice(0, 20).map((q) => q.name) })];
  const rows = Object.entries(index.queues);
  const { unread } = queueReferences(index);
  if (unread.length === 0) return [];
  const refused = rows.filter(([, r]) => r.status === "permission_missing") as Array<[string, Extract<QueueConsumers, { status: "permission_missing" }>]>;
  if (refused.length === unread.length && rows.every(([, r]) => r.status !== "ok" || r.source === "list")) {
    // Every endpoint read refused: one capability finding naming the permission (the queues list needs the same one).
    return [{ ...finding(day, "account", "inventory_permission_missing:queue_consumers", `The Observer's token may not read the consumers of ${refused.length} queue(s) (HTTP ${refused[0][1].http}); reading them needs ${QUEUE_CONSUMERS_PERMISSION} on the same token (owner), and until then no queue is reported unbound`, { http: refused[0][1].http, permission: QUEUE_CONSUMERS_PERMISSION, unread: refused.slice(0, 20).map(([q]) => q) }), kind: "capability" }];
  }
  return [finding(day, "account", "queue_consumers_unread", `The consumers of ${unread.length} of ${rows.length} queue(s) could not be read (${unread.slice(0, 5).map((u) => `${u.queue}: ${u.status}`).join(", ")}${unread.length > 5 ? ", …" : ""}); "no consumer and no dead-letter reference" is not proven, so no queue is reported unbound`, { queues: rows.length, unread: unread.slice(0, 20), cap: index.cap })];
}

/** The binding index against the readable resource lists (pure; part of compareInventory, exported for tests). */
export function compareBindings(day: string, index: BindingIndex, lists: Partial<Record<ListKey, ListResult>>, queueConsumers: QueueConsumerIndex | null = null): Finding[] {
  const out: Finding[] = [];
  const rows = Object.entries(index.workers).sort(([a], [b]) => a.localeCompare(b));
  const refused = rows.filter(([, r]) => r.status === "permission_missing") as Array<[string, Extract<WorkerBindings, { status: "permission_missing" }>]>;
  if (rows.length > 0 && refused.length === rows.length) {
    out.push({ ...finding(day, "account", "inventory_permission_missing:bindings", `The Observer's token may not read any Worker's bindings (HTTP ${refused[0][1].http}); the binding index needs ${BINDINGS_PERMISSION} on the same token (owner)`, { http: refused[0][1].http, permission: BINDINGS_PERMISSION, workers: rows.length }), kind: "capability" });
    return out;
  }
  const skipped = rows.filter(([, r]) => r.status === "skipped" && r.reason === "cap").map(([w]) => w);
  if (skipped.length) out.push(finding(day, "account", "bindings_cap_exceeded", `The account lists ${index.listed} Workers; the Observer reads the bindings of ${index.cap} per run, so ${skipped.length} were not read and "no Worker binds it" is not proven`, { listed: index.listed, cap: index.cap, skipped: skipped.slice(0, 20) }));
  for (const [w, r] of rows) {
    if (r.status === "permission_missing" || r.status === "unavailable") {
      out.push(finding(day, w, "bindings_unread", `The bindings of ${w} could not be read (${r.status === "permission_missing" ? `HTTP ${r.http}, ${BINDINGS_PERMISSION}` : r.reason}); "no Worker binds it" is not proven while it is unread`, r.status === "permission_missing" ? { status: r.status, http: r.http } : { status: r.status, reason: r.reason }));
    }
  }
  const complete = indexComplete(index);
  // Queues are referenced by bindings, consumers and dead-letter settings; unproven while any consumer is unread.
  const queueRefs = queueConsumers ? queueReferences(queueConsumers) : null;
  const missing = new Map<string, Array<{ resource: string; name: string; id: string }>>();
  for (const key of ["d1", "kv", "r2", "queues"] as const) {
    const l = lists[key];
    if (l?.status !== "ok") continue;
    const { type, match } = RESOURCE_BINDING[key];
    const onAccount = new Set(l.items.map((x) => (match === "id" ? x.id : x.name)));
    const bound = new Map<string, string[]>();
    for (const [w, r] of rows) if (r.status === "ok") for (const b of r.bindings) if (b.type === type && b.id) (bound.get(b.id) ?? bound.set(b.id, []).get(b.id)!).push(w);
    // Unbound: only when every Worker was read, never from a partial index.
    if (complete && (key !== "queues" || queueRefs?.complete)) {
      const declared = DECLARED_RESOURCES[key] as readonly string[];
      for (const x of l.items) {
        const ref = match === "id" ? x.id : x.name;
        if (bound.has(ref) || declared.includes(x.name)) continue;
        if (key === "queues" && queueRefs!.refs.has(x.name)) continue; // consumed, or another queue's dead-letter queue
        const queueSample = key === "queues" ? { referenced_by: [], queues_read: Object.keys(queueConsumers!.queues).length } : {};
        // Bound only while a CI preview Worker exists (one per pull request): informational, never unbound.
        const preview = ciPreviewOf(key, x);
        if (preview) {
          out.push(finding(day, `${key}:${x.name}`, "ci_preview", `${key.toUpperCase()} ${x.name} (${ref}) is used intermittently by CI previews (${preview.source}); no live Worker binds it between pull requests (informational)`, { resource: key, id: x.id, name: x.name, source: preview.source, workers_read: rows.length, ...queueSample }));
          continue;
        }
        out.push(finding(day, `${key}:${x.name}`, "unbound_resource", `${key.toUpperCase()} ${x.name} (${ref}) is on the account; no live Worker binds it${key === "queues" ? ", it has no consumer, no queue names it as its dead-letter queue," : ""} and no wrangler.toml of this repository declares it (informational)`, { resource: key, id: x.id, name: x.name, workers_read: rows.length, ...queueSample }));
      }
    }
    for (const [w, r] of rows) {
      if (r.status !== "ok") continue;
      for (const b of r.bindings) if (b.type === type && b.id && !onAccount.has(b.id)) (missing.get(w) ?? missing.set(w, []).get(w)!).push({ resource: key, name: b.name, id: b.id });
    }
  }
  // One warning per Worker (findings are unique per worker, metric and day), naming every missing resource.
  for (const [w, m] of [...missing].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(finding(day, w, "binding_to_missing_resource", `${w} binds ${m.map((b) => `${b.resource.toUpperCase()} ${b.name} → ${b.id}`).join(", ")}, which the account's lists do not contain`, { bindings: m.slice(0, 20) }, "warning"));
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
  // A 12-hex fingerprint of the token (SHA-256 with a fixed prefix; never the value): a new token is asked at once.
  const tokenFp = (await digestOf(`observer-token:${creds.token}`)).slice(0, 12);
  const sameToken = previous.token_fp === tokenFp;
  const recentlyRefused = (v: string | undefined) => /^permission_missing/.test(v ?? "") && Boolean(last) && sameToken && now - Date.parse(last!.ran_at) < REFUSED_RETRY_MS;
  datasets.token_fp = tokenFp;
  for (const key of Object.keys(LISTS) as ListKey[]) {
    // Capability check: a list refused with this token in the last hour is not asked again until then.
    const refused = recentlyRefused(previous[key]);
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
  // The bindings of every Worker on a reliable scripts list (at most BINDING_READ_CAP reads). A token refused for
  // every Worker is asked again after REFUSED_RETRY_MS, or at once with a new token, like a refused list.
  const { scripts } = reliableScripts(lists.scripts, traffic, known.declared);
  let bindings: BindingIndex | null = null;
  if (scripts) {
    const refused = recentlyRefused(previous.bindings);
    bindings = refused
      ? { workers: Object.fromEntries([...new Set(scripts)].sort().map((w) => [w, { status: "permission_missing", http: Number(/http (\d+)/.exec(previous.bindings)?.[1] ?? 403) } as WorkerBindings])), listed: new Set(scripts).size, cap: 0 }
      : await readBindingIndex(creds.token, creds.account, scripts, fetcher);
    datasets.bindings = indexDatasetLine(bindings);
  } else {
    datasets.bindings = "skipped: no reliable scripts list";
  }
  // The consumers of every listed queue (consumer Workers, pull consumers and dead-letter queues are consumer settings,
  // not bindings): from the queues list when it carries them, else per queue (at most QUEUE_CONSUMER_READ_CAP reads).
  let queueConsumers: QueueConsumerIndex | null = null;
  const queues = lists.queues;
  if (queues?.status === "ok") {
    const refusedHttp = recentlyRefused(previous.queue_consumers) ? Number(/http (\d+)/.exec(previous.queue_consumers)?.[1] ?? 403) : null;
    queueConsumers = await readQueueConsumerIndex(creds.token, creds.account, queues.items, fetcher, undefined, refusedHttp);
    datasets.queue_consumers = queueConsumersDatasetLine(queueConsumers);
  } else {
    datasets.queue_consumers = "skipped: no queues list";
  }
  const findings = compareInventory({ known, lists, bindings, queue_consumers: queueConsumers, traffic7d: traffic, senses_cover_7d: cover, day });
  const digest = await digestOf(JSON.stringify({ f: findings.map((f) => [f.worker, f.metric]), d: datasets, b: bindings ? indexDigestInput(bindings) : null, q: queueConsumers ? queueConsumersDigestInput(queueConsumers) : null }));
  if (last && last.digest === digest && now - Date.parse(last.ran_at) < INVENTORY_HEARTBEAT_MS) return { outcome: "unchanged", findings: findings.length };
  await storeFindings(db, findings, at);
  const bindingsStored = bindings ? await storeBindingIndex(db, bindings, at) : "not_read";
  const results = Object.entries(datasets).filter(([k]) => k !== "token_fp").map(([, v]) => v);
  const status = results.every((s) => s.startsWith("ok")) ? "ok" : results.some((s) => s.startsWith("ok")) ? "partial" : "unavailable";
  await recordRun(db, { kind: "inventory", bucket: at, ran_at: at, status, datasets: { ...datasets, bindings_stored: bindingsStored, census_at: known.census_at, senses_cover_7d: cover }, findings: findings.map((f) => ({ worker: f.worker, metric: f.metric, severity: f.severity, detail: f.detail })), digest });
  return { outcome: "recorded", findings: findings.length };
}
