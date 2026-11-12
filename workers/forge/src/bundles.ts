// ADR-0012 G2a (owner 2026-11-12: "lanjutkan G2 sambil menunggu deploy"): the Forge keeps what it built.
//
// When a commit of main passes the Forge's checks with no secret found, the Worker modules the check bundled
// are written to R2 (`bundles/<sha>/<worker>.mjs`) with one manifest (`bundles/<sha>/manifest.json`). The
// Deployment Orchestrator uploads these as Worker versions in G2b, so a deploy no longer needs GitHub Actions
// to build. The manifest says, per Worker, what the deploy needs to decide whether the Forge's module alone is
// enough:
//   - `config_sha256`: the hash of its wrangler.toml. A deploy whose configuration is unchanged since the running
//     version keeps the running version's bindings; any configuration change still goes through the full deploy.
//   - `single_module`: false when the bundle imports files it does not inline (for example WebAssembly).
//   - `assets`: whether the Worker serves static assets, which the module alone does not carry.
// And, for the whole commit (G2b), `migrations`: the D1 migration files at that commit.
//
// G2c-1 (still schema v1; every new field is optional and a reader treats its absence as "unknown"):
//   - `migration_files`: each migration's sha256, with its SQL at `bundles/<sha>/migrations/<file>`, so the
//     Orchestrator can apply an additive migration itself and see an edited one;
//   - per Worker, `modules`: every file the bundle imports but does not inline, stored at
//     `bundles/<sha>/<worker>/<name>` with its Workers module type. The bundle's import of each one is renamed
//     to `./<name>`, the name the Orchestrator uploads it under. When any one cannot be resolved, the Worker has
//     `modules_error` instead and stays multi-module (the GitHub workflow);
//   - per Worker, `limits`: whether its wrangler.toml has `[limits]`, a setting a version upload does not carry.
// Old bundles are deleted after BUNDLE_RETENTION_DAYS; Workers keep their own uploaded versions for rollback.
import { moduleRules } from "./runner/core.ts";
import type { ExternalSource } from "./externals.ts";

export const BUNDLE_RETENTION_DAYS = 14;
export const BUNDLE_PREFIX = "bundles/";
const HEX40 = /^[0-9a-f]{40}$/;

type PutOptions = { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> };
/** The subset of an R2 bucket binding the Forge uses. */
export interface BundleBucket {
  put(key: string, value: string, options?: PutOptions): Promise<unknown>;
  list(options?: { prefix?: string; cursor?: string; limit?: number; delimiter?: string }): Promise<{ objects: Array<{ key: string; uploaded: Date }>; truncated: boolean; cursor?: string; delimitedPrefixes?: string[] }>;
  delete(keys: string | string[]): Promise<void>;
}
/** R2's put takes bytes as well; the interface keeps the text signature its callers' fakes implement. */
const putBytes = (bucket: BundleBucket, key: string, value: Uint8Array, options: PutOptions) =>
  (bucket.put as unknown as (k: string, v: Uint8Array, o: PutOptions) => Promise<unknown>).call(bucket, key, value, options);

/**
 * A bundled Worker module. `external` are the paths of the files it imports but does not inline; `specifiers`
 * (G2c-1) maps each of them to the import specifiers the bundle text uses for it.
 */
export interface BuiltModule { dir: string; text: string; toml: string; external: string[]; specifiers?: Record<string, string[]> }

/** The Workers module types the Forge stores (the multipart part content types of a version upload). */
export type ModuleType = "application/javascript+module" | "text/plain" | "application/octet-stream" | "application/wasm";
export interface ManifestModule { name: string; type: ModuleType; sha256: string; bytes: number }

export interface ManifestWorker {
  name: string;
  dir: string;
  module: string;
  main_module: string;
  sha256: string;
  bytes: number;
  config_sha256: string;
  compatibility_date: string | null;
  compatibility_flags: string[];
  single_module: boolean;
  external: string[];
  assets: boolean;
  /** G2c-1: whether wrangler.toml has [limits] (not carried by a version upload). */
  limits?: boolean;
  /** G2c-1: every external file as a stored module, when all of them could be stored. */
  modules?: ManifestModule[];
  /** G2c-1: why `modules` is absent for a Worker with external files. */
  modules_error?: string;
}

export interface MigrationFile { file: string; sha256: string }

/** `migrations` was added in G2b and `migration_files` in G2c-1 (still schema v1: a reader treats a missing field as unknown). */
export interface BundleManifest { schema: "forge-bundles.v1"; commit: string; built_at: string; workers: ManifestWorker[]; migrations?: string[]; migration_files?: MigrationFile[] }

export const MIGRATIONS_PATH = /^workers\/control-plane-migrations\/([^/]+\.sql)$/;

/** The sorted D1 migration file names of a commit's snapshot (paths relative to the repository root). */
export function migrationsOf(paths: Iterable<string>): string[] {
  const out: string[] = [];
  for (const p of paths) { const m = MIGRATIONS_PATH.exec(p); if (m) out.push(m[1]); }
  return out.sort();
}

async function sha256(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const tomlString = (toml: string, key: string) => new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m").exec(toml)?.[1] ?? null;
function tomlList(toml: string, key: string): string[] {
  const m = new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(toml);
  return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : [];
}

/** The manifest entry of one built Worker. */
export async function manifestEntry(m: BuiltModule): Promise<ManifestWorker> {
  const name = tomlString(m.toml, "name");
  if (!name || !/^[a-z0-9-]{1,63}$/.test(name)) throw new Error(`invalid worker name in ${m.dir}`);
  const module = `${name}.mjs`;
  return {
    name, dir: m.dir, module, main_module: module,
    sha256: await sha256(m.text), bytes: new TextEncoder().encode(m.text).length,
    config_sha256: await sha256(m.toml),
    compatibility_date: tomlString(m.toml, "compatibility_date"),
    compatibility_flags: tomlList(m.toml, "compatibility_flags"),
    single_module: m.external.length === 0,
    external: [...m.external].sort(),
    assets: /^\[assets\]/m.test(m.toml),
    limits: /^\[limits\]/m.test(m.toml),
  };
}

/** A module name the Orchestrator accepts: a relative path of plain segments. */
export const MODULE_NAME = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*$/;

/**
 * The Workers module type of an external file, as Wrangler types it: a Text or Data rule of the Worker's
 * wrangler.toml (matched against the import specifier, like Wrangler), else WebAssembly by extension, else an
 * ES module for JavaScript that reads as one. Anything else is not typed (null).
 */
export function moduleTypeOf(path: string, specifiers: string[], toml: string, bytes: Uint8Array): ModuleType | null {
  const rule = moduleRules(toml).find((r) => specifiers.some((s) => r.re.test(s)) || r.re.test(path));
  if (rule?.type === "Data") return "application/octet-stream";
  let text: string | null = null;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { text = null; }
  if (rule?.type === "Text") return text === null ? null : "text/plain";
  if (/\.wasm$/.test(path)) return "application/wasm";
  if (/\.m?js$/.test(path) && text !== null && /^\s*(?:export|import)\b/m.test(text)) return "application/javascript+module";
  return null;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const importOf = (quoted: string) => new RegExp(`(\\bfrom\\s*|\\bimport\\s*\\(\\s*|\\bimport\\s*)${escapeRe(quoted)}`, "g");

/**
 * Rename every import of an external file in the bundle to `./<name>`. Afterwards no import uses an original
 * specifier and every module is imported under its name; otherwise this throws (`import_rewrite_failed`).
 */
export function renameImports(text: string, renames: Array<{ name: string; specifiers: string[] }>): string {
  let out = text;
  for (const { name, specifiers } of renames) {
    for (const s of specifiers) out = out.replace(importOf(JSON.stringify(s)), (_m, lead: string) => `${lead}${JSON.stringify("./" + name)}`);
  }
  for (const { name, specifiers } of renames) {
    if (specifiers.length === 0 || specifiers.some((s) => importOf(JSON.stringify(s)).test(out))) throw new Error("import_rewrite_failed");
    if (!importOf(JSON.stringify("./" + name)).test(out)) throw new Error("import_rewrite_failed");
  }
  return out;
}

export interface StoreOptions {
  /** G2c-1: the SQL of each migration file named in `migrations`, by file name. */
  migrationSql?: Record<string, string>;
  /** G2c-1: where the external files of a multi-module Worker come from. */
  externals?: ExternalSource;
}

/** The extra modules of one Worker: stored, typed and imported under their names, or the reason they are not. */
async function storeModules(bucket: BundleBucket, commit: string, worker: string, m: BuiltModule, externals: ExternalSource | undefined):
  Promise<{ text: string; modules: ManifestModule[] } | { error: string }> {
  if (!externals) return { error: "no_external_source" };
  const paths = [...m.external].sort();
  if (paths.some((p) => !MODULE_NAME.test(p))) return { error: "module_name_invalid" };
  let found: Map<string, Uint8Array>;
  try { found = await externals(paths); } catch (e) { return { error: `external_unavailable: ${String((e as Error)?.message ?? e).slice(0, 120)}` }; }
  const modules: ManifestModule[] = [];
  const typed: Array<{ name: string; type: ModuleType; bytes: Uint8Array; specifiers: string[] }> = [];
  for (const p of paths) {
    const bytes = found.get(p);
    if (!bytes) return { error: `external_unresolved: ${p}` };
    const specifiers = m.specifiers?.[p] ?? [];
    const type = moduleTypeOf(p, specifiers, m.toml, bytes);
    if (!type) return { error: `module_type_unknown: ${p}` };
    typed.push({ name: p, type, bytes, specifiers });
  }
  let text: string;
  try { text = renameImports(m.text, typed); } catch (e) { return { error: String((e as Error)?.message ?? e) }; }
  for (const t of typed) {
    const digest = await sha256(t.bytes);
    await putBytes(bucket, `${BUNDLE_PREFIX}${commit}/${worker}/${t.name}`, t.bytes, { httpMetadata: { contentType: t.type }, customMetadata: { sha256: digest, commit } });
    modules.push({ name: t.name, type: t.type, sha256: digest, bytes: t.bytes.length });
  }
  return { text, modules };
}

/** Write a passed commit's modules and manifest. Returns the manifest written. */
export async function storeBundles(bucket: BundleBucket, commit: string, built: BuiltModule[], nowMs = Date.now(), migrations?: string[], options: StoreOptions = {}): Promise<BundleManifest> {
  if (!HEX40.test(commit)) throw new Error("invalid_commit_sha");
  const workers: ManifestWorker[] = [];
  for (const m of built) {
    let source = m;
    let extra: { modules?: ManifestModule[]; modules_error?: string } = {};
    if (m.external.length > 0) {
      const name = (await manifestEntry(m)).name;
      const r = await storeModules(bucket, commit, name, m, options.externals);
      if ("error" in r) extra = { modules_error: r.error };
      else { source = { ...m, text: r.text }; extra = { modules: r.modules }; }
    }
    const entry = { ...(await manifestEntry(source)), ...extra };
    await bucket.put(`${BUNDLE_PREFIX}${commit}/${entry.module}`, source.text, {
      httpMetadata: { contentType: "application/javascript+module" },
      customMetadata: { sha256: entry.sha256, commit },
    });
    workers.push(entry);
  }
  workers.sort((a, b) => a.name.localeCompare(b.name));
  const manifest: BundleManifest = { schema: "forge-bundles.v1", commit, built_at: new Date(nowMs).toISOString(), workers };
  if (migrations) {
    manifest.migrations = [...migrations].sort();
    // G2c-1: each migration's SQL, only when every file of the list is at hand.
    if (options.migrationSql && manifest.migrations.every((f) => typeof options.migrationSql![f] === "string")) {
      const files: MigrationFile[] = [];
      for (const file of manifest.migrations) {
        const sql = options.migrationSql[file];
        const digest = await sha256(sql);
        await bucket.put(`${BUNDLE_PREFIX}${commit}/migrations/${file}`, sql, { httpMetadata: { contentType: "text/plain" }, customMetadata: { sha256: digest, commit } });
        files.push({ file, sha256: digest });
      }
      manifest.migration_files = files;
    }
  }
  // The manifest goes last: a reader that finds it finds every module it names.
  await bucket.put(`${BUNDLE_PREFIX}${commit}/manifest.json`, JSON.stringify(manifest), { httpMetadata: { contentType: "application/json" } });
  return manifest;
}

/** The migration SQL of a snapshot, by file name, for storeBundles. */
export function migrationSqlOf(snapshot: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [p, text] of Object.entries(snapshot)) { const m = MIGRATIONS_PATH.exec(p); if (m) out[m[1]] = text; }
  return out;
}

/** Delete bundles older than the retention. Bounded per call; the next tick continues. */
export async function pruneBundles(bucket: BundleBucket, nowMs = Date.now(), maxDeletes = 500): Promise<number> {
  const cutoff = nowMs - BUNDLE_RETENTION_DAYS * 86_400_000;
  let cursor: string | undefined;
  let deleted = 0;
  do {
    const page = await bucket.list({ prefix: BUNDLE_PREFIX, cursor, limit: 500 });
    const old = page.objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key).slice(0, maxDeletes - deleted);
    if (old.length) { await bucket.delete(old); deleted += old.length; }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && deleted < maxDeletes);
  return deleted;
}
