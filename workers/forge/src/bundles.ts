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
// And, for the whole commit (G2b), `migrations`: the D1 migration files at that commit. Only the GitHub
// Control Plane deploy applies migrations, so a native deploy requires the running and target lists to be equal.
// Old bundles are deleted after BUNDLE_RETENTION_DAYS; Workers keep their own uploaded versions for rollback.
export const BUNDLE_RETENTION_DAYS = 14;
export const BUNDLE_PREFIX = "bundles/";
const HEX40 = /^[0-9a-f]{40}$/;

/** The subset of an R2 bucket binding the Forge uses. */
export interface BundleBucket {
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  list(options?: { prefix?: string; cursor?: string; limit?: number; delimiter?: string }): Promise<{ objects: Array<{ key: string; uploaded: Date }>; truncated: boolean; cursor?: string; delimitedPrefixes?: string[] }>;
  delete(keys: string | string[]): Promise<void>;
}

export interface BuiltModule { dir: string; text: string; toml: string; external: string[] }

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
}

/** `migrations` was added in G2b (still schema v1: a reader treats a manifest without it as "migrations unknown"). */
export interface BundleManifest { schema: "forge-bundles.v1"; commit: string; built_at: string; workers: ManifestWorker[]; migrations?: string[] }

export const MIGRATIONS_PATH = /^workers\/control-plane-migrations\/([^/]+\.sql)$/;

/** The sorted D1 migration file names of a commit's snapshot (paths relative to the repository root). */
export function migrationsOf(paths: Iterable<string>): string[] {
  const out: string[] = [];
  for (const p of paths) { const m = MIGRATIONS_PATH.exec(p); if (m) out.push(m[1]); }
  return out.sort();
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
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
  };
}

/** Write a passed commit's modules and manifest. Returns the manifest written. */
export async function storeBundles(bucket: BundleBucket, commit: string, built: BuiltModule[], nowMs = Date.now(), migrations?: string[]): Promise<BundleManifest> {
  if (!HEX40.test(commit)) throw new Error("invalid_commit_sha");
  const workers: ManifestWorker[] = [];
  for (const m of built) {
    const entry = await manifestEntry(m);
    await bucket.put(`${BUNDLE_PREFIX}${commit}/${entry.module}`, m.text, {
      httpMetadata: { contentType: "application/javascript+module" },
      customMetadata: { sha256: entry.sha256, commit },
    });
    workers.push(entry);
  }
  workers.sort((a, b) => a.name.localeCompare(b.name));
  const manifest: BundleManifest = { schema: "forge-bundles.v1", commit, built_at: new Date(nowMs).toISOString(), workers };
  if (migrations) manifest.migrations = [...migrations].sort();
  // The manifest goes last: a reader that finds it finds every module it names.
  await bucket.put(`${BUNDLE_PREFIX}${commit}/manifest.json`, JSON.stringify(manifest), { httpMetadata: { contentType: "application/json" } });
  return manifest;
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
