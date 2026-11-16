/**
 * Cut-over gate of 2026-11-15 (owner, "1 setuju"): a fix to the deploy executor must reach production without
 * depending on the executor being fixed. On that day the native Control Plane deploy failed three times on a
 * read-after-upload 404; the fix lived in the Deployment Orchestrator, which executes every native deploy, and the
 * planner deployed the Control Plane first because a D1 migration was pending. This module answers one question,
 * read only, from main's own bundles: may the orchestrator unit be deployed before the pending migrations?
 *
 * Why the old rule existed and why it is narrower now. "Control Plane first while a migration is pending" dates from
 * 2026-11-07 (migration 0026), when every Worker's readiness required the newest migration. Since then readiness
 * requires a fixed list ending at REQUIRED_MIGRATION (readiness.ts, 0029), and a service that needs newer tables
 * passes its own extra list (only the Forge does; the orchestrator passes none). So a pending migration does not make
 * the orchestrator unready. What can still break it is its CODE at main: a query on a table or column the pending
 * migration creates, renames or seeds. That is what is checked here, conservatively:
 *   - every pending migration (main's list minus D1's ledger) is read from the Forge's bundles of main, checked
 *     against its sha256, and reduced to the identifiers it introduces or changes (`migrationIdentifiers`): a
 *     created, dropped or renamed table, view or trigger target, an added, dropped or renamed column, a table it
 *     writes rows into, and a UNIQUE index's table (an upsert may rely on it). A plain index introduces only its own
 *     name, which code never names. A statement of any other shape is unknown, and unknown means dependent;
 *   - the orchestrator's bundled module of main (one ES module with every shared file it imports, as the Forge built
 *     it, sha256 checked; a multi-module bundle is not inspected and counts as dependent) must not contain any of
 *     those identifiers as a word, case-insensitive (`identifiersUsed`). A mention anywhere, in a comment or a string,
 *     counts: a false "dependent" only keeps the old order, a false "independent" could ship a broken executor.
 * Anything unreadable or missing is dependent, except a main whose bundles the Forge has not stored yet
 * (`bundle_pending`): its checks, which store them, have not finished, and nothing can deploy it before they pass.
 *
 * Used by the Forge's deploy planner (forge/src/deploy-plan.ts, the ordering), by the orchestrator's own native deploy
 * (native-deploy.ts migrationPlan, so it accepts the plan) and by the Recovery Manager's rescue executor
 * (executor-rescue.ts). Pure apart from the bundle reads.
 */
import { splitSqlStatements, sqlWithoutComments } from "./migration-rules.ts";

export const ORCHESTRATOR_UNIT = "deployment-orchestrator";
export const ORCHESTRATOR_SERVICE = "cryptophys-deployment-orchestrator";
/** The Recovery Manager's rescue executor of the Orchestrator's Worker (executor-rescue.ts); the Registry accepts it. */
export const RESCUE_EXECUTOR = "rescue:deployment-orchestrator";
/** The planner's skip while main's bundles are not stored yet: it plans nothing and plans again once they are. */
export const EXECUTOR_FIRST_BUNDLE_PENDING = "executor_first_bundle_pending";

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MIGRATION_FILE = /^[0-9]{4}_[A-Za-z0-9_]{1,80}\.sql$/;

// One SQL identifier, optionally schema-qualified (main.x), bare or quoted ("x", `x`, [x]).
const ID = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?(?:"[^"]+"|` + "`[^`]+`" + String.raw`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)`;
const G = `(${ID})`;
const IFNE = String.raw`(?:IF\s+NOT\s+EXISTS\s+)?`;
const IFE = String.raw`(?:IF\s+EXISTS\s+)?`;
const TEMP = String.raw`(?:TEMP\s+|TEMPORARY\s+)?`;

/** The bare name of a matched identifier (schema and quotes removed), or null when it is not a plain name. */
function bare(raw: string): string | null {
  const last = raw.replace(/^[A-Za-z_][A-Za-z0-9_]*\s*\.\s*/, "");
  const inner = /^"(.*)"$|^`(.*)`$|^\[(.*)\]$/s.exec(last);
  const name = inner ? (inner[1] ?? inner[2] ?? inner[3] ?? "") : last;
  return NAME.test(name) ? name : null;
}

type Rule = { re: RegExp; ids: (m: RegExpExecArray) => Array<string | undefined> };
const RULES: Rule[] = [
  { re: new RegExp(String.raw`^CREATE\s+${TEMP}TABLE\s+${IFNE}${G}`, "i"), ids: (m) => [m[1]] },
  // A UNIQUE index can be what an upsert's ON CONFLICT relies on: its table counts. A plain one only adds its name.
  { re: new RegExp(String.raw`^CREATE\s+UNIQUE\s+INDEX\s+${IFNE}${G}\s+ON\s+${G}`, "i"), ids: (m) => [m[1], m[2]] },
  { re: new RegExp(String.raw`^CREATE\s+INDEX\s+${IFNE}${G}\s+ON\s+${ID}`, "i"), ids: (m) => [m[1]] },
  { re: new RegExp(String.raw`^CREATE\s+${TEMP}VIEW\s+${IFNE}${G}`, "i"), ids: (m) => [m[1]] },
  { re: new RegExp(String.raw`^CREATE\s+${TEMP}TRIGGER\s+${IFNE}${G}\s[\s\S]*?\bON\s+${G}`, "i"), ids: (m) => [m[1], m[2]] },
  { re: new RegExp(String.raw`^ALTER\s+TABLE\s+${G}\s+RENAME\s+TO\s+${G}`, "i"), ids: (m) => [m[1], m[2]] },
  { re: new RegExp(String.raw`^ALTER\s+TABLE\s+${ID}\s+RENAME\s+(?:COLUMN\s+)?${G}\s+TO\s+${G}`, "i"), ids: (m) => [m[1], m[2]] },
  { re: new RegExp(String.raw`^ALTER\s+TABLE\s+${ID}\s+ADD\s+(?:COLUMN\s+)?${G}`, "i"), ids: (m) => [m[1]] },
  { re: new RegExp(String.raw`^ALTER\s+TABLE\s+${ID}\s+DROP\s+(?:COLUMN\s+)?${G}`, "i"), ids: (m) => [m[1]] },
  { re: new RegExp(String.raw`^(?:INSERT\s+(?:OR\s+[A-Za-z]+\s+)?|REPLACE\s+)INTO\s+${G}`, "i"), ids: (m) => [m[1]] },
  { re: new RegExp(String.raw`^UPDATE\s+(?:OR\s+[A-Za-z]+\s+)?${G}\s+SET\b`, "i"), ids: (m) => [m[1]] },
  { re: new RegExp(String.raw`^DELETE\s+FROM\s+${G}`, "i"), ids: (m) => [m[1]] },
  { re: new RegExp(String.raw`^DROP\s+(?:TABLE|VIEW|INDEX|TRIGGER)\s+${IFE}${G}`, "i"), ids: (m) => [m[1]] },
];

/**
 * The identifiers one migration introduces or changes, sorted and unique; null when any statement has a shape this
 * reading does not know (or the SQL cannot be split), which callers treat as "the orchestrator depends on it".
 */
export function migrationIdentifiers(sql: string): string[] | null {
  let statements: string[];
  try { statements = splitSqlStatements(sql); } catch { return null; }
  const out = new Set<string>();
  for (const s of statements) {
    const text = sqlWithoutComments(s).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const rule = RULES.map((r) => ({ r, m: r.re.exec(text) })).find((x) => x.m);
    if (!rule) return null;
    for (const raw of rule.r.ids(rule.m!)) {
      const name = raw === undefined ? null : bare(raw);
      if (!name) return null;
      out.add(name.toLowerCase());
    }
  }
  return [...out].sort();
}

/** The identifiers that occur in `text` as a whole word (letters, digits and `_`), case-insensitive. */
export function identifiersUsed(text: string, identifiers: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return [...new Set(identifiers.map((i) => i.toLowerCase()))].filter((id) => {
    if (!NAME.test(id)) return true;
    return new RegExp(`(?<![a-z0-9_])${id}(?![a-z0-9_])`).test(lower);
  }).sort();
}

/** The read-only subset of the Forge's bundle bucket (R2) this module reads. */
export interface BundleTextReader {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

export type ExecutorFirstVerdict =
  | { state: "independent"; checked: string[] }
  | { state: "bundle_pending" }
  | { state: "dependent"; reason: string; file?: string; uses?: string[] };

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The orchestrator's entry and the migration hashes of main's manifest, read strictly; null when absent. */
export async function readOrchestratorManifest(bundles: BundleTextReader, commit: string):
  Promise<{ manifest: null } | { manifest: { worker: Record<string, unknown> | null; migrations: string[] | null; files: Map<string, string> | null } }> {
  const obj = await bundles.get(`bundles/${commit}/manifest.json`);
  if (!obj) return { manifest: null };
  let m: { schema?: unknown; commit?: unknown; workers?: unknown; migrations?: unknown; migration_files?: unknown };
  try { m = JSON.parse(await obj.text()); } catch { throw new Error("manifest_unreadable"); }
  if (m?.schema !== "forge-bundles.v1" || m.commit !== commit || !Array.isArray(m.workers)) throw new Error("manifest_unreadable");
  const worker = (m.workers as Array<Record<string, unknown>>).find((w) => w?.name === ORCHESTRATOR_SERVICE) ?? null;
  const migrations = Array.isArray(m.migrations) && m.migrations.every((f) => typeof f === "string") ? [...m.migrations as string[]].sort() : null;
  let files: Map<string, string> | null = null;
  if (Array.isArray(m.migration_files)) {
    const list = m.migration_files as Array<{ file?: unknown; sha256?: unknown }>;
    if (list.every((f) => typeof f?.file === "string" && MIGRATION_FILE.test(f.file) && typeof f.sha256 === "string" && HEX64.test(f.sha256))) {
      files = new Map(list.map((f) => [f.file as string, f.sha256 as string]));
    }
  }
  return { manifest: { worker, migrations, files } };
}

/** The orchestrator's single bundled module of `commit`, hash checked, or the reason it cannot be read. */
export async function readOrchestratorModule(bundles: BundleTextReader, commit: string, worker: Record<string, unknown> | null): Promise<{ text: string } | { reason: string }> {
  if (!worker) return { reason: "orchestrator_not_in_bundle" };
  if (worker.module !== `${ORCHESTRATOR_SERVICE}.mjs` || worker.main_module !== worker.module) return { reason: "bundle_unreadable" };
  if (worker.single_module !== true) return { reason: "multi_module" };
  if (typeof worker.sha256 !== "string" || !HEX64.test(worker.sha256)) return { reason: "bundle_unreadable" };
  const obj = await bundles.get(`bundles/${commit}/${worker.module}`);
  if (!obj) return { reason: "bundle_module_missing" };
  const text = await obj.text();
  if (await sha256Hex(text) !== worker.sha256 || (typeof worker.bytes === "number" && new TextEncoder().encode(text).length !== worker.bytes)) return { reason: "bundle_module_hash_mismatch" };
  return { text };
}

/**
 * May the orchestrator at `commit` run before the `pending` migrations (file names, main's list minus D1's ledger)?
 * Read from the Forge's bundles of `commit` only. Never throws.
 */
export async function executorFirstVerdict(bundles: BundleTextReader, commit: string, pending: readonly string[]): Promise<ExecutorFirstVerdict> {
  if (!HEX40.test(commit)) return { state: "dependent", reason: "invalid_commit_sha" };
  try {
    const read = await readOrchestratorManifest(bundles, commit);
    if (!read.manifest) return { state: "bundle_pending" };
    const { worker, migrations, files } = read.manifest;
    const module = await readOrchestratorModule(bundles, commit, worker);
    if ("reason" in module) return { state: "dependent", reason: module.reason };
    if (!migrations || !files) return { state: "dependent", reason: "migrations_unknown" };
    const checked: string[] = [];
    for (const file of [...pending].sort()) {
      const sha = files.get(file);
      if (!migrations.includes(file) || !sha) return { state: "dependent", reason: "migration_not_in_bundle", file };
      const obj = await bundles.get(`bundles/${commit}/migrations/${file}`);
      if (!obj) return { state: "dependent", reason: "migration_missing", file };
      const sql = await obj.text();
      if (await sha256Hex(sql) !== sha) return { state: "dependent", reason: "migration_hash_mismatch", file };
      const ids = migrationIdentifiers(sql);
      if (!ids) return { state: "dependent", reason: "migration_unparsed", file };
      const uses = identifiersUsed(module.text, ids);
      if (uses.length) return { state: "dependent", reason: "orchestrator_reads_migration", file, uses };
      checked.push(file);
    }
    return { state: "independent", checked };
  } catch (e) {
    return { state: "dependent", reason: String((e as Error)?.message ?? e) === "manifest_unreadable" ? "manifest_unreadable" : "bundle_read_failed" };
  }
}
