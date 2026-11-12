// ADR-0012 G5: the Forge's replacement for GitHub's Dependabot alerts (vulnerable npm dependencies).
//
// At most once a day per head of main (and an hour after a failed run), the Forge:
//   1. walks main's tree in the Artifacts repository and reads every package-lock.json (lockfileVersion 2 or 3:
//      the `packages` map; version 1's nested `dependencies` too), skipping node_modules, build output and links;
//   2. collects each package name with its installed versions, and which lockfiles hold them;
//   3. asks the npm registry's bulk advisory endpoint, the one `npm audit` uses, in batches. Only package names
//      and versions are sent, never a path, a token or anything else of the repository;
//   4. re-checks each advisory's vulnerable_versions against each installed version, so a finding names the
//      exact affected version;
//   5. records one run row and one row per finding (migration 0050), kept 90 days, and audits a changed set.
// A lockfile is `runtime` when it belongs to a Worker (workers/<dir> with a wrangler.toml, the Console UI build
// under workers/console/ui included); any other lockfile is tooling. Failures are recorded, never thrown.
// GitHub secret scanning is replaced by the Forge's secret scan of every checked commit (runner/core.ts,
// scanSecrets; ADR-0012 §5i). Automatic upgrade pull requests (Dependabot's other half) are not replaced yet.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { SEVERITIES, type Severity } from "../../control-plane-shared/src/dependency-audit.ts";
import { SKIP_DIRS } from "./runner/core.ts";
import { canonicalMainHead } from "./census.ts";
import type { ArtifactsReader } from "./checks.ts";

export const ADVISORY_URL = "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk";
/** A head of main is audited again after this long (advisories are published every day). */
export const AUDIT_INTERVAL_MS = 24 * 3_600_000;
/** A failed run of the same head is retried after this long. */
export const RETRY_FAILED_MS = 3_600_000;
export const RETENTION_DAYS = 90;
/** Package names per bulk request (npm audit sends a whole tree in one; the registry accepts large bodies). */
export const BATCH_PACKAGES = 900;
export const MAX_REQUESTS = 20;
export const MAX_LOCKFILES = 50;
export const MAX_LOCKFILE_BYTES = 10_000_000;
export const MAX_TREES = 2_000;
export const REQUEST_TIMEOUT_MS = 20_000;
const MAX_FINDINGS = 500;
const LOCKFILE = "package-lock.json";
const WRANGLER_CONFIG = new Set(["wrangler.toml", "wrangler.json", "wrangler.jsonc"]);
const TREE_CONCURRENCY = 16;
const HEX40 = /^[0-9a-f]{40}$/;
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9._~-][a-z0-9._~-]*$/i;

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

// ---------------------------------------------------------------------------------------------------------------
// Lockfiles

/** name -> installed versions, from one package-lock.json. Throws on text that is not a lockfile. */
export function lockfilePackages(text: string): Map<string, Set<string>> {
  const lock = JSON.parse(text) as { lockfileVersion?: unknown; packages?: unknown; dependencies?: unknown };
  if (!lock || typeof lock !== "object") throw new Error("not_a_lockfile");
  const out = new Map<string, Set<string>>();
  const add = (name: string, version: unknown) => {
    if (!NAME.test(name) || typeof version !== "string" || !parseVersion(version)) return;
    (out.get(name) ?? out.set(name, new Set()).get(name)!).add(version);
  };
  if (lock.packages && typeof lock.packages === "object") {
    // v2/v3: keys are install paths ("node_modules/a", "node_modules/a/node_modules/@s/b"); "" is the root.
    for (const [key, raw] of Object.entries(lock.packages as Record<string, unknown>)) {
      if (!key || !raw || typeof raw !== "object") continue;
      const entry = raw as { version?: unknown; link?: unknown; name?: unknown };
      if (entry.link === true) continue;
      const at = key.lastIndexOf("node_modules/");
      if (at < 0) continue; // a workspace folder, not an installed package
      // An alias (npm:real@1) is installed under its alias path and names the real package in `name`.
      add(typeof entry.name === "string" && entry.name ? entry.name : key.slice(at + "node_modules/".length), entry.version);
    }
    return out;
  }
  if (lock.dependencies && typeof lock.dependencies === "object") {
    // v1: nested dependencies.
    const walk = (deps: Record<string, unknown>, depth: number) => {
      if (depth > 64) return;
      for (const [name, raw] of Object.entries(deps)) {
        if (!raw || typeof raw !== "object") continue;
        const d = raw as { version?: unknown; dependencies?: unknown };
        // An alias is "npm:<real name>@<version>".
        const alias = typeof d.version === "string" ? /^npm:(@?[^@]+)@(.+)$/.exec(d.version) : null;
        if (alias) add(alias[1], alias[2]);
        else add(name, d.version);
        if (d.dependencies && typeof d.dependencies === "object") walk(d.dependencies as Record<string, unknown>, depth + 1);
      }
    };
    walk(lock.dependencies as Record<string, unknown>, 0);
    return out;
  }
  throw new Error("not_a_lockfile");
}

/** Whether a lockfile belongs to a Worker's build (runtime) or to tooling, from its path and the Worker dirs. */
export function isRuntimeLockfile(path: string, workerDirs: ReadonlySet<string>): boolean {
  const parts = path.split("/");
  return parts.length >= 3 && parts[0] === "workers" && workerDirs.has(parts[1]);
}

interface LockfileRef { path: string; hash: string }

/** Every package-lock.json of a commit, and the workers/<dir> that are Workers (they hold a wrangler.toml). */
export async function findLockfiles(repo: ArtifactsReader, commit: string): Promise<{ lockfiles: LockfileRef[]; workerDirs: Set<string> }> {
  const c = await repo.readCommit(commit);
  if (!c || !HEX40.test(c.treeHash)) throw new Error("commit_not_mirrored");
  const lockfiles: LockfileRef[] = [];
  const workerDirs = new Set<string>();
  let level: Array<{ prefix: string; hash: string }> = [{ prefix: "", hash: c.treeHash }];
  let trees = 0;
  while (level.length) {
    const next: typeof level = [];
    trees += level.length;
    if (trees > MAX_TREES) throw new Error("tree_too_large");
    const read: Array<{ t: (typeof level)[number]; entries: Awaited<ReturnType<ArtifactsReader["readTree"]>> }> = [];
    for (let i = 0; i < level.length; i += TREE_CONCURRENCY) {
      read.push(...await Promise.all(level.slice(i, i + TREE_CONCURRENCY).map(async (t) => ({ t, entries: await repo.readTree(t.hash) }))));
    }
    for (const { t, entries } of read) {
      if (!entries) throw new Error("tree_not_found");
      const workerDir = /^workers\/([^/]+)\/$/.exec(t.prefix)?.[1];
      for (const e of entries) {
        if (!e.name || e.name.includes("/") || e.name === "." || e.name === "..") continue;
        if (e.type === "tree") { if (!SKIP_DIRS.has(e.name)) next.push({ prefix: `${t.prefix}${e.name}/`, hash: e.hash }); continue; }
        if (e.type !== "blob" && e.type !== "exec") continue;
        if (workerDir && WRANGLER_CONFIG.has(e.name)) workerDirs.add(workerDir);
        if (e.name === LOCKFILE) lockfiles.push({ path: t.prefix + e.name, hash: e.hash });
      }
    }
    level = next;
  }
  lockfiles.sort((a, b) => a.path.localeCompare(b.path));
  if (lockfiles.length > MAX_LOCKFILES) throw new Error("too_many_lockfiles");
  return { lockfiles, workerDirs };
}

// ---------------------------------------------------------------------------------------------------------------
// Versions and ranges (the subset of node-semver that advisory ranges use)

export interface Version { major: number; minor: number; patch: number; pre: Array<string | number> }

export function parseVersion(v: string): Version | null {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(v);
  if (!m) return null;
  const pre = m[4] ? m[4].split(".").map((p) => (/^\d+$/.test(p) ? Number(p) : p)) : [];
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre };
}

export function compareVersions(a: Version, b: Version): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x < y ? -1 : 1;
    if (typeof x === "number") return -1;
    if (typeof y === "number") return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

type Op = "<" | "<=" | ">" | ">=" | "=";
interface Comparator { op: Op; v: Version }
const ZERO: Version = { major: 0, minor: 0, patch: 0, pre: [] };
const v3 = (major: number, minor: number, patch: number, pre: Array<string | number> = []): Version => ({ major, minor, patch, pre });

/** A partial version ("1", "1.2", "1.2.x", "*") as its numbers, with null for a wildcard part. */
function partial(s: string): { parts: Array<number | null>; full: Version | null } | null {
  const full = parseVersion(s);
  if (full) return { parts: [full.major, full.minor, full.patch], full };
  const m = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(s);
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].map((p) => (p === undefined || /^[xX*]$/.test(p) ? null : Number(p)));
  // Once a part is a wildcard, the parts after it are too.
  const first = parts.indexOf(null);
  return { parts: first < 0 ? parts : parts.map((p, i) => (i >= first ? null : p)), full: null };
}

/** One comparator token (op + partial version) as plain comparators; null when it cannot be read. */
function expand(op: string, s: string): Comparator[] | null {
  const p = partial(s);
  if (!p) return null;
  if (p.full && op !== "^" && op !== "~") return [{ op: (op || "=") as Op, v: p.full }];
  const [ma, mi, pa] = p.parts;
  if (ma === null) return op === "<" || op === ">" ? [{ op: "<", v: ZERO }] : []; // "*" matches all; "<*" none
  const lo = v3(ma, mi ?? 0, pa ?? 0, p.full?.pre ?? []);
  const hiNext = mi === null ? v3(ma + 1, 0, 0, [0]) : pa === null ? v3(ma, mi + 1, 0, [0]) : v3(ma, mi, pa + 1, [0]);
  switch (op) {
    case "^": {
      const hi = ma > 0 || mi === null ? v3(ma + 1, 0, 0, [0]) : (mi > 0 || pa === null) ? v3(0, mi + 1, 0, [0]) : v3(0, 0, (pa ?? 0) + 1, [0]);
      return [{ op: ">=", v: lo }, { op: "<", v: hi }];
    }
    case "~": return [{ op: ">=", v: lo }, { op: "<", v: mi === null ? v3(ma + 1, 0, 0, [0]) : v3(ma, mi + 1, 0, [0]) }];
    case "<": return [{ op: "<", v: v3(ma, mi ?? 0, pa ?? 0, [0]) }];
    case "<=": return [{ op: "<", v: hiNext }];
    case ">": return [{ op: ">=", v: hiNext }];
    case ">=": return [{ op: ">=", v: lo }];
    default: return [{ op: ">=", v: lo }, { op: "<", v: hiNext }];
  }
}

const holds = (c: Comparator, v: Version) => {
  const d = compareVersions(v, c.v);
  return c.op === "<" ? d < 0 : c.op === "<=" ? d <= 0 : c.op === ">" ? d > 0 : c.op === ">=" ? d >= 0 : d === 0;
};

/**
 * Parse a range: `||` is OR, whitespace is AND, `a - b` is a hyphen range, with `<`, `<=`, `>`, `>=`, `=`, `^`,
 * `~`, `*` and x-ranges. Null when any part cannot be read (the caller then treats the version as affected).
 */
export function parseRange(range: string): Comparator[][] | null {
  const sets: Comparator[][] = [];
  for (const alt of range.trim().split("||")) {
    let s = alt.trim().replace(/(<=|>=|<|>|=|\^|~)\s+/g, "$1");
    const set: Comparator[] = [];
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(s);
    if (hyphen) {
      const lo = expand(">=", hyphen[1]), hi = expand("<=", hyphen[2]);
      if (!lo || !hi) return null;
      sets.push([...lo, ...hi]);
      continue;
    }
    if (s === "") s = "*";
    for (const tok of s.split(/\s+/)) {
      const m = /^(<=|>=|<|>|=|\^|~>?|)(.+)$/.exec(tok);
      if (!m) return null;
      const c = expand(m[1] === "~>" ? "~" : m[1], m[2]);
      if (!c) return null;
      set.push(...c);
    }
    sets.push(set);
  }
  return sets;
}

/**
 * Whether an installed version is in an advisory's vulnerable range. Prerelease versions are compared by full
 * precedence (node-semver's includePrerelease), which reports more rather than less; an unreadable range or
 * version counts as affected.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  const sets = parseRange(range || "*");
  if (!v || !sets) return true;
  return sets.some((set) => set.every((c) => holds(c, v)));
}

// ---------------------------------------------------------------------------------------------------------------
// Advisories

export interface Advisory { id: string; url: string | null; title: string | null; severity: Severity; vulnerable_versions: string }

const severityOf = (s: unknown): Severity => {
  const v = String(s ?? "").toLowerCase();
  if (v === "medium") return "moderate";
  return (SEVERITIES as readonly string[]).includes(v) ? v as Severity : "high"; // npm audit's default
};
const text = (v: unknown, n: number) => (typeof v === "string" && v ? v.slice(0, n) : null);

/** The request bodies: { name: [versions] }, at most BATCH_PACKAGES names each, names in a stable order. */
export function batches(packages: Map<string, Set<string>>, size = BATCH_PACKAGES): Array<Record<string, string[]>> {
  const names = [...packages.keys()].sort();
  const out: Array<Record<string, string[]>> = [];
  for (let i = 0; i < names.length; i += size) {
    out.push(Object.fromEntries(names.slice(i, i + size).map((n) => [n, [...packages.get(n)!].sort()])));
  }
  return out;
}

/** POST each batch to the bulk advisory endpoint; name -> advisories. Throws on a failed or malformed answer. */
export async function fetchAdvisories(fetchImpl: Fetch, bodies: Array<Record<string, string[]>>): Promise<Map<string, Advisory[]>> {
  if (bodies.length > MAX_REQUESTS) throw new Error("too_many_packages");
  const out = new Map<string, Advisory[]>();
  for (const body of bodies) {
    const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined;
    const res = await fetchImpl(ADVISORY_URL, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`advisories_http_${res.status}`);
    const data = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("advisories_malformed");
    for (const [name, list] of Object.entries(data)) {
      if (!(name in body) || !Array.isArray(list)) continue; // only what was asked about
      const advisories = list.flatMap((a): Advisory[] => {
        if (!a || typeof a !== "object") return [];
        const r = a as Record<string, unknown>;
        const id = String(r.id ?? "").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64);
        if (!id) return [];
        const url = text(r.url, 300);
        return [{ id, url: url && /^https:\/\//.test(url) ? url : null, title: text(r.title, 300), severity: severityOf(r.severity), vulnerable_versions: text(r.vulnerable_versions, 300) ?? "*" }];
      });
      out.set(name, [...(out.get(name) ?? []), ...advisories]);
    }
  }
  return out;
}

export interface AuditFinding {
  package: string; version: string; advisory_id: string; severity: Severity; title: string | null; url: string | null;
  vulnerable_versions: string; lockfiles: string[]; runtime: boolean;
}

/** One finding per installed version that an advisory's range covers, with the lockfiles that install it. */
export function matchFindings(advisories: Map<string, Advisory[]>, installed: Map<string, Set<string>>, where: Map<string, Set<string>>, runtimeLockfiles: ReadonlySet<string>): AuditFinding[] {
  const out: AuditFinding[] = [];
  for (const [name, list] of advisories) {
    const seen = new Set<string>();
    for (const a of list) {
      for (const version of [...(installed.get(name) ?? [])].sort()) {
        if (seen.has(`${a.id}@${version}`) || !satisfies(version, a.vulnerable_versions)) continue;
        seen.add(`${a.id}@${version}`);
        const files = [...(where.get(`${name}@${version}`) ?? [])].sort();
        out.push({ package: name, version, advisory_id: a.id, severity: a.severity, title: a.title, url: a.url, vulnerable_versions: a.vulnerable_versions,
          lockfiles: files, runtime: files.some((f) => runtimeLockfiles.has(f)) });
      }
    }
  }
  return out.sort((x, y) => x.package.localeCompare(y.package) || x.version.localeCompare(y.version) || x.advisory_id.localeCompare(y.advisory_id));
}

// ---------------------------------------------------------------------------------------------------------------
// The tick

export interface DependencyAuditEnv { DB: D1Database }

/** Audit main's head: the lockfiles, the advisories and the findings. Throws on any failure (the tick records it). */
export async function auditCommit(repo: ArtifactsReader, commit: string, fetchImpl: Fetch): Promise<{ lockfiles: number; packages: number; findings: AuditFinding[] }> {
  const { lockfiles, workerDirs } = await findLockfiles(repo, commit);
  const byName = new Map<string, Set<string>>();
  /** "name@version" -> the lockfiles that install it. */
  const where = new Map<string, Set<string>>();
  const runtime = new Set<string>();
  for (const lf of lockfiles) {
    const blob = await repo.readBlob(lf.hash);
    if (!blob) throw new Error(`blob_not_found: ${lf.path}`);
    if (blob.size > MAX_LOCKFILE_BYTES) throw new Error(`lockfile_too_large: ${lf.path}`);
    let pkgs: Map<string, Set<string>>;
    try { pkgs = lockfilePackages(await blob.text()); } catch (e) { throw new Error(`lockfile_unreadable: ${lf.path} (${String((e as Error)?.message ?? e).slice(0, 80)})`); }
    if (isRuntimeLockfile(lf.path, workerDirs)) runtime.add(lf.path);
    for (const [name, versions] of pkgs) {
      for (const v of versions) {
        (byName.get(name) ?? byName.set(name, new Set()).get(name)!).add(v);
        const key = `${name}@${v}`;
        (where.get(key) ?? where.set(key, new Set()).get(key)!).add(lf.path);
      }
    }
  }
  const advisories = byName.size ? await fetchAdvisories(fetchImpl, batches(byName)) : new Map<string, Advisory[]>();
  return { lockfiles: lockfiles.length, packages: where.size, findings: matchFindings(advisories, byName, where, runtime).slice(0, MAX_FINDINGS) };
}

/**
 * One dependency audit of main's head, at most once per AUDIT_INTERVAL_MS per head (a failed run is retried after
 * RETRY_FAILED_MS). Records the run and its findings; never throws.
 */
export async function dependencyAuditTick(env: DependencyAuditEnv, repo: ArtifactsReader, nowMs = Date.now(), fetchImpl: Fetch = fetch): Promise<Record<string, unknown>> {
  let head: string;
  try {
    const sha = await canonicalMainHead(repo);
    if (!sha) return { outcome: "no_main" };
    head = sha;
    const last = await env.DB.prepare("SELECT ran_at, status FROM forge_dependency_audits WHERE main_sha = ? ORDER BY ran_at DESC LIMIT 1").bind(head).first<{ ran_at: string; status: string }>();
    if (last && nowMs - Date.parse(last.ran_at) < (last.status === "ok" ? AUDIT_INTERVAL_MS : RETRY_FAILED_MS)) return { outcome: "not_due", main_sha: head, last: last.ran_at };
  } catch (e) {
    return { outcome: "failed", error: String((e as Error)?.message ?? e).slice(0, 300), recorded: false };
  }
  const ranAt = new Date(nowMs).toISOString();
  const runId = `dep_${head.slice(0, 12)}_${nowMs}`;
  const db = env.DB;
  try {
    const r = await auditCommit(repo, head, fetchImpl);
    const ids = new Map<string, Severity>();
    for (const f of r.findings) ids.set(f.advisory_id, f.severity);
    const counts = Object.fromEntries(SEVERITIES.map((s) => [s, [...ids.values()].filter((v) => v === s).length])) as Record<Severity, number>;
    const previous = await db.prepare("SELECT run_id FROM forge_dependency_audits WHERE status = 'ok' ORDER BY ran_at DESC LIMIT 1").first<{ run_id: string }>();
    const before = previous ? new Set(((await db.prepare("SELECT advisory_id FROM forge_dependency_findings WHERE run_id = ?").bind(previous.run_id).all<{ advisory_id: string }>()).results ?? []).map((x) => x.advisory_id)) : null;
    await db.prepare(
      `INSERT INTO forge_dependency_audits (run_id, main_sha, ran_at, status, lockfiles, packages, advisories, critical, high, moderate, low, info, error)
       VALUES (?, ?, ?, 'ok', ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).bind(runId, head, ranAt, r.lockfiles, r.packages, ids.size, counts.critical, counts.high, counts.moderate, counts.low, counts.info).run();
    for (const f of r.findings) {
      await db.prepare(
        `INSERT OR IGNORE INTO forge_dependency_findings (run_id, package, version, advisory_id, severity, title, url, vulnerable_versions, lockfiles, runtime)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(runId, f.package, f.version, f.advisory_id, f.severity, f.title, f.url, f.vulnerable_versions, JSON.stringify(f.lockfiles), f.runtime ? 1 : 0).run();
    }
    const changed = !before || before.size !== ids.size || [...ids.keys()].some((id) => !before.has(id));
    if (changed) {
      await appendAuditEvent(db, { event_type: "forge.dependency_audit", actor: "system:forge-dependency-audit", subject: head, outcome: ids.size ? "findings" : "clean",
        payload: { run_id: runId, lockfiles: r.lockfiles, packages: r.packages, ...counts, advisories: [...ids.keys()].sort().slice(0, 30), runtime_high: r.findings.filter((f) => f.runtime && (f.severity === "high" || f.severity === "critical")).length } }).catch(() => undefined);
    }
    await prune(db, nowMs);
    return { outcome: "recorded", main_sha: head, lockfiles: r.lockfiles, packages: r.packages, advisories: ids.size, findings: r.findings.length };
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 300);
    try {
      await db.prepare("DELETE FROM forge_dependency_findings WHERE run_id = ?").bind(runId).run();
      await db.prepare("DELETE FROM forge_dependency_audits WHERE run_id = ?").bind(runId).run();
      await db.prepare("INSERT INTO forge_dependency_audits (run_id, main_sha, ran_at, status, error) VALUES (?, ?, ?, 'failed', ?)").bind(runId, head, ranAt, error).run();
      await prune(db, nowMs);
      return { outcome: "failed", main_sha: head, error };
    } catch {
      return { outcome: "failed", main_sha: head, error, recorded: false };
    }
  }
}

async function prune(db: D1Database, nowMs: number): Promise<void> {
  const before = new Date(nowMs - RETENTION_DAYS * 86_400_000).toISOString();
  await db.prepare("DELETE FROM forge_dependency_findings WHERE run_id IN (SELECT run_id FROM forge_dependency_audits WHERE ran_at < ?)").bind(before).run();
  await db.prepare("DELETE FROM forge_dependency_audits WHERE ran_at < ?").bind(before).run();
}
