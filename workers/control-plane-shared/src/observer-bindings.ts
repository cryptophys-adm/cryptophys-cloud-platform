/**
 * The Observer's binding index (owner 2026-11-15, "tambahkan"): for every Worker on the account's scripts list, the
 * bindings of its current version, read with the Observer's token (Account > Workers Scripts > Read) from
 * GET /accounts/{account}/workers/scripts/{name}/settings (Cloudflare API reference, "Workers > Scripts > Script And
 * Version Settings > Get"; its result.bindings array). So the platform can prove whether any live Worker binds a given
 * KV namespace, D1 database, R2 bucket or Queue, even while the token may not list those resources.
 *
 * - At most BINDING_READ_CAP reads per run; the rest are `skipped` and named in a finding.
 * - A read the token may not make (401/403) or that fails is recorded for that Worker only; the run goes on.
 * - Values never leave the API: plain_text, secret_text, json and secret_key bindings are dropped; every other
 *   binding is kept as {type, name} and, for a resource, the id it points at.
 * - Stored in observer_worker_bindings (migration 0068), one row per listed Worker, rewritten when the inventory
 *   records a run. `boundBy` answers "which live Workers bind X", and whether that answer is complete.
 */
import type { D1Database } from "./types.ts";

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Reads per run; 18 Workers today. Past the cap the remaining Workers are skipped (a finding says so). */
export const BINDING_READ_CAP = 50;
/** Concurrent reads (a Worker keeps at most six connections open). */
const BINDING_READ_CONCURRENCY = 6;
/** Bindings kept per Worker; a Worker with more is marked truncated. */
export const BINDINGS_PER_WORKER = 100;
export const BINDINGS_PERMISSION = "Account > Workers Scripts > Read";
export const settingsUrl = (account: string, script: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${encodeURIComponent(script)}/settings`;

/** A binding as the index keeps it: no values, only what it points at. */
export interface Binding { type: string; name: string; id?: string; class_name?: string; script_name?: string }
export type WorkerBindings =
  | { status: "ok"; bindings: Binding[]; truncated?: true }
  | { status: "permission_missing"; http: number }
  | { status: "unavailable"; reason: string }
  | { status: "skipped"; reason: "cap" | "capability_checked_recently" };
/** worker → what its settings said. `listed` is how many Workers the scripts list had. */
export interface BindingIndex { workers: Record<string, WorkerBindings>; listed: number; cap: number }

/** Binding types that carry a value (a variable, a secret, a key): never kept. */
const VALUE_TYPES: ReadonlySet<string> = new Set(["plain_text", "secret_text", "json", "secret_key"]);
/** The field that names what a binding points at, per binding type. */
const ID_FIELD: Readonly<Record<string, string>> = Object.freeze({
  kv_namespace: "namespace_id", d1: "database_id", r2_bucket: "bucket_name", queue: "queue_name", service: "service",
  durable_object_namespace: "namespace_id", workflow: "workflow_name", hyperdrive: "id", vectorize: "index_name",
  analytics_engine: "dataset", dispatch_namespace: "namespace", mtls_certificate: "certificate_id", pipelines: "pipeline",
  ratelimit: "namespace_id", vpc_service: "service_id", secrets_store_secret: "store_id",
});
/** The inventory's list keys and the binding type that points at each (and which list field it matches). */
export const RESOURCE_BINDING: Readonly<Record<"d1" | "kv" | "r2" | "queues", { type: string; match: "id" | "name" }>> = Object.freeze({
  d1: { type: "d1", match: "id" }, kv: { type: "kv_namespace", match: "id" }, r2: { type: "r2_bucket", match: "name" }, queues: { type: "queue", match: "name" },
});
const TYPE_ALIAS: Readonly<Record<string, string>> = Object.freeze({ kv: "kv_namespace", r2: "r2_bucket", queues: "queue", durable_objects: "durable_object_namespace", do: "durable_object_namespace" });

const str = (v: unknown, max = 128) => (typeof v === "string" && v ? v.slice(0, max) : typeof v === "number" ? String(v) : undefined);

/** The compact bindings of one settings response (pure; exported for tests). Null when it has no bindings array. */
export function parseBindings(body: any): { bindings: Binding[]; truncated: boolean } | null {
  const rows = body?.result?.bindings;
  if (!Array.isArray(rows)) return null;
  const out: Binding[] = [];
  for (const r of rows) {
    const type = str(r?.type, 64); const name = str(r?.name);
    if (!type || !name || VALUE_TYPES.has(type)) continue;
    const b: Binding = { type, name };
    // D1's `id` was renamed `database_id`; older versions still answer with `id`.
    const id = str(type === "d1" ? r.database_id ?? r.id : ID_FIELD[type] ? r[ID_FIELD[type]] : undefined);
    if (id) b.id = id;
    if (type === "durable_object_namespace" || type === "workflow") {
      const cls = str(r.class_name); const script = str(r.script_name);
      if (cls) b.class_name = cls;
      if (script) b.script_name = script;
    }
    out.push(b);
  }
  out.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  return { bindings: out.slice(0, BINDINGS_PER_WORKER), truncated: out.length > BINDINGS_PER_WORKER };
}

export async function readWorkerBindings(token: string, account: string, script: string, fetcher: Fetch): Promise<WorkerBindings> {
  let res: Response;
  try {
    res = await fetcher(settingsUrl(account, script), { headers: { authorization: `Bearer ${token}` } });
  } catch (err) {
    return { status: "unavailable", reason: String((err as Error)?.message ?? err).slice(0, 120) };
  }
  if (res.status === 401 || res.status === 403) { await res.body?.cancel(); return { status: "permission_missing", http: res.status }; }
  const body = await res.json().catch(() => null) as any;
  if (!res.ok || !body || body.success === false) return { status: "unavailable", reason: `http_${res.status}` };
  const parsed = parseBindings(body);
  if (!parsed) return { status: "unavailable", reason: "no_bindings_array" };
  return parsed.truncated ? { status: "ok", bindings: parsed.bindings, truncated: true } : { status: "ok", bindings: parsed.bindings };
}

/** Read the bindings of every listed Worker, at most `cap` of them (sorted by name), a few at a time. */
export async function readBindingIndex(token: string, account: string, scripts: readonly string[], fetcher: Fetch, cap = BINDING_READ_CAP): Promise<BindingIndex> {
  const names = [...new Set(scripts)].sort();
  const workers: Record<string, WorkerBindings> = {};
  const read = names.slice(0, cap);
  for (let i = 0; i < read.length; i += BINDING_READ_CONCURRENCY) {
    const chunk = read.slice(i, i + BINDING_READ_CONCURRENCY);
    const results = await Promise.all(chunk.map((w) => readWorkerBindings(token, account, w, fetcher)));
    chunk.forEach((w, j) => { workers[w] = results[j]; });
  }
  for (const w of names.slice(cap)) workers[w] = { status: "skipped", reason: "cap" };
  return { workers, listed: names.length, cap };
}

/** Every Worker read and every read answered: only then is "no Worker binds it" a proof. */
export const indexComplete = (index: BindingIndex) => Object.values(index.workers).every((w) => w.status === "ok");

/**
 * Which live Workers bind resource `id` of `type` (a binding type such as kv_namespace, or the inventory's list key:
 * kv, d1, r2, queues). `complete` is false when any listed Worker was not read; then an empty `bound_by` proves
 * nothing about the Workers in `unread`.
 */
export function boundBy(index: BindingIndex, type: string, id: string): { bound_by: Array<{ worker: string; binding: string }>; complete: boolean; unread: string[] } {
  const t = TYPE_ALIAS[type] ?? type;
  const bound_by: Array<{ worker: string; binding: string }> = [];
  const unread: string[] = [];
  for (const [worker, w] of Object.entries(index.workers).sort(([a], [b]) => a.localeCompare(b))) {
    if (w.status !== "ok") { unread.push(worker); continue; }
    for (const b of w.bindings) if (b.type === t && b.id === id) bound_by.push({ worker, binding: b.name });
  }
  return { bound_by, complete: unread.length === 0, unread };
}

/** A stable, compact form of the index for the inventory's digest: a binding change is a new run row. */
export function indexDigestInput(index: BindingIndex): unknown {
  return Object.entries(index.workers).sort(([a], [b]) => a.localeCompare(b)).map(([w, r]) =>
    [w, r.status === "ok" ? r.bindings.map((b) => [b.type, b.name, b.id ?? "", b.class_name ?? "", b.script_name ?? ""]) : r.status]);
}

/** The datasets line of a run: "ok: 18 of 18 Workers, 41 bindings", "partial: …", "permission_missing: http 403". */
export function indexDatasetLine(index: BindingIndex): string {
  const rows = Object.values(index.workers);
  const ok = rows.filter((r) => r.status === "ok") as Array<Extract<WorkerBindings, { status: "ok" }>>;
  const bindings = ok.reduce((n, r) => n + r.bindings.length, 0);
  if (rows.length === 0) return "ok: 0 Workers";
  const refused = rows.filter((r) => r.status === "permission_missing") as Array<Extract<WorkerBindings, { status: "permission_missing" }>>;
  if (refused.length === rows.length) return `permission_missing: http ${refused[0].http}`;
  if (ok.length === rows.length) return `ok: ${ok.length} of ${rows.length} Workers, ${bindings} bindings`;
  const by = (s: string) => rows.filter((r) => r.status === s).length;
  return `partial: ${ok.length} of ${rows.length} Workers read, ${bindings} bindings (${["permission_missing", "unavailable", "skipped"].filter((s) => by(s)).map((s) => `${by(s)} ${s}`).join(", ")})`;
}

// ------------------------------------------------------------------------------------------------ storage

const missingTable = (err: unknown) => /no such table/i.test(String((err as Error)?.message ?? err));

/**
 * Replace the stored index: one row per listed Worker, then the rows of Workers no longer listed are removed.
 * Called only with an index built from a reliable scripts list. Before migration 0068 it stores nothing.
 */
export async function storeBindingIndex(db: D1Database, index: BindingIndex, at: string): Promise<"ok" | "empty" | "no_table" | `error: ${string}`> {
  // An empty index never wipes the stored one: an empty scripts list is no proof that every Worker is gone.
  if (Object.keys(index.workers).length === 0) return "empty";
  const upsert = `INSERT INTO observer_worker_bindings (worker, status, bindings_json, detail, observed_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (worker) DO UPDATE SET status = excluded.status, bindings_json = excluded.bindings_json, detail = excluded.detail, observed_at = excluded.observed_at`;
  const stmts = Object.entries(index.workers).map(([w, r]) => db.prepare(upsert).bind(w, r.status,
    JSON.stringify(r.status === "ok" ? r.bindings : []),
    r.status === "ok" ? (r.truncated ? "truncated" : null) : r.status === "permission_missing" ? `http ${r.http}` : r.reason, at));
  stmts.push(db.prepare("DELETE FROM observer_worker_bindings WHERE observed_at <> ?").bind(at));
  try {
    await db.batch(stmts);
    return "ok";
  } catch (err) {
    return missingTable(err) ? "no_table" : `error: ${String((err as Error)?.message ?? err).slice(0, 80)}`;
  }
}

/** The stored index (as the last recorded inventory left it), or null before migration 0068 or the first run. */
export async function loadBindingIndex(db: D1Database): Promise<{ index: BindingIndex; observed_at: string } | null> {
  let rows: Array<{ worker: string; status: string; bindings_json: string; detail: string | null; observed_at: string }>;
  try {
    rows = (await db.prepare("SELECT worker, status, bindings_json, detail, observed_at FROM observer_worker_bindings ORDER BY worker LIMIT 1000").all<any>()).results ?? [];
  } catch (err) {
    if (missingTable(err)) return null;
    throw err;
  }
  if (rows.length === 0) return null;
  const workers: Record<string, WorkerBindings> = {};
  for (const r of rows) {
    let bindings: Binding[] = [];
    try { bindings = JSON.parse(r.bindings_json); } catch { bindings = []; }
    workers[r.worker] = r.status === "ok" ? (r.detail === "truncated" ? { status: "ok", bindings, truncated: true } : { status: "ok", bindings })
      : r.status === "permission_missing" ? { status: "permission_missing", http: Number(/http (\d+)/.exec(r.detail ?? "")?.[1] ?? 403) }
      : r.status === "skipped" ? { status: "skipped", reason: r.detail === "capability_checked_recently" ? "capability_checked_recently" : "cap" }
      : { status: "unavailable", reason: r.detail ?? "unknown" };
  }
  return { index: { workers, listed: rows.length, cap: BINDING_READ_CAP }, observed_at: rows.reduce((m, r) => (r.observed_at > m ? r.observed_at : m), "") };
}

/** GET /v1/observer's `inventory.bindings`: the stored index and what it can prove (read only). */
export async function bindingsView(db: D1Database): Promise<Record<string, unknown> | null> {
  const stored = await loadBindingIndex(db);
  if (!stored) return null;
  const { index, observed_at } = stored;
  const rows = Object.entries(index.workers);
  const by_type: Record<string, number> = {};
  for (const [, r] of rows) if (r.status === "ok") for (const b of r.bindings) by_type[b.type] = (by_type[b.type] ?? 0) + 1;
  return {
    observed_at, source: `GET /accounts/{account}/workers/scripts/{name}/settings (${BINDINGS_PERMISSION})`,
    workers: rows.length, read: rows.filter(([, r]) => r.status === "ok").length, complete: indexComplete(index),
    unread: rows.filter(([, r]) => r.status !== "ok").map(([worker, r]) => ({ worker, status: r.status })),
    by_type,
    index: Object.fromEntries(rows.filter(([, r]) => r.status === "ok").map(([w, r]) => [w, (r as Extract<WorkerBindings, { status: "ok" }>).bindings])),
  };
}
