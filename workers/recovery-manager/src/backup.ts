// Cloudflare-native D1 backup (owner decision 2026-11-07: "fallback build internal cloudflare saja
// jika action github tidak bisa"). The nightly GitHub Action (d1-backup.yml) needs an API token
// with R2 permissions; this fallback needs none: it reads D1 and writes R2 through the Worker's own
// bindings. It runs hourly and writes a dump only when no backup object was uploaded in the last
// 24 hours, so a working GitHub Action keeps being the primary and this never duplicates it.
//
// Format: a SQL script like `wrangler d1 export` (CREATE TABLE, INSERT rows, then indexes,
// triggers and views), gzip-compressed, at control-plane/<UTC stamp>.sql.gz in the private bucket.
// Restoring stays an owner decision (ADR-0009 critical class). Nothing is ever deleted here.
import type { D1Database, D1PreparedStatement } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";

/** The subset of the R2 binding this module uses. */
export interface R2BucketLike {
  list(options?: { prefix?: string; limit?: number }): Promise<{ objects: { key: string; uploaded: Date; size: number }[] }>;
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
}

export interface BackupEnv {
  DB: D1Database;
  BACKUPS?: R2BucketLike;
}

export const BACKUP_PREFIX = "control-plane/";
const MAX_AGE_MS = 24 * 3_600_000;
const PAGE = 500;

interface SchemaRow { type: string; name: string; sql: string | null }

/** SQLite literal for one value. */
export function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "boolean") return v ? "1" : "0";
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v) || Array.isArray(v)) {
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : Array.isArray(v) ? Uint8Array.from(v as number[]) : new Uint8Array((v as ArrayBufferView).buffer, (v as ArrayBufferView).byteOffset, (v as ArrayBufferView).byteLength);
    return `X'${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}'`;
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Tables D1 manages itself are left out, as `wrangler d1 export` does. */
const internal = (name: string) => name.startsWith("sqlite_") || name.startsWith("_cf_");

/** Builds the SQL dump: schema, rows (paged by rowid), then indexes, triggers and views. */
export async function dumpSql(db: D1Database): Promise<{ sql: string; tables: number; rows: number }> {
  const schema = (await db.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid").all<SchemaRow>()).results
    .filter((r) => !internal(r.name));
  const parts: string[] = ["PRAGMA defer_foreign_keys=TRUE;"];
  let rows = 0;
  const tables = schema.filter((r) => r.type === "table");
  for (const t of tables) parts.push(`${t.sql};`);
  for (const t of tables) {
    const withoutRowid = /WITHOUT\s+ROWID/i.test(t.sql ?? "");
    let after: number | null = null;
    for (let offset = 0; ; offset += PAGE) {
      const stmt: D1PreparedStatement = withoutRowid
        ? db.prepare(`SELECT * FROM ${ident(t.name)} LIMIT ${PAGE} OFFSET ${offset}`)
        : db.prepare(`SELECT rowid AS "__backup_rowid", * FROM ${ident(t.name)} WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE}`).bind(after ?? -9e15);
      const page: Record<string, unknown>[] = (await stmt.all<Record<string, unknown>>()).results;
      for (const row of page) {
        if (!withoutRowid) after = Number(row.__backup_rowid);
        const cols = Object.keys(row).filter((c) => c !== "__backup_rowid");
        parts.push(`INSERT INTO ${ident(t.name)} (${cols.map(ident).join(",")}) VALUES(${cols.map((c) => sqlLiteral(row[c])).join(",")});`);
      }
      rows += page.length;
      if (page.length < PAGE) break;
    }
  }
  // Indexes, triggers and views after the rows, so the append-only triggers never fire on restore.
  for (const kind of ["index", "trigger", "view"]) for (const r of schema.filter((s) => s.type === kind)) parts.push(`${r.sql};`);
  return { sql: parts.join("\n") + "\n", tables: tables.length, rows };
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

async function sha256(buf: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)), (b) => b.toString(16).padStart(2, "0")).join("");
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Latest backup upload time within today and yesterday (UTC); keys are date-stamped. */
async function latestBackup(bucket: R2BucketLike, now: number): Promise<number | null> {
  let latest: number | null = null;
  for (const d of [day(now), day(now - 86_400_000)]) {
    for (const o of (await bucket.list({ prefix: `${BACKUP_PREFIX}${d}`, limit: 100 })).objects) {
      const t = new Date(o.uploaded).getTime();
      if (latest === null || t > latest) latest = t;
    }
  }
  return latest;
}

export type BackupOutcome =
  | { status: "no_binding" }
  | { status: "fresh"; latest: string }
  | { status: "written"; key: string; bytes: number; sha256: string; tables: number; rows: number };

/** The hourly fallback: write a backup only when none was uploaded in the last 24 hours. */
export async function backupIfStale(env: BackupEnv, now = Date.now()): Promise<BackupOutcome> {
  if (!env.BACKUPS) return { status: "no_binding" };
  const latest = await latestBackup(env.BACKUPS, now);
  if (latest !== null && now - latest < MAX_AGE_MS) return { status: "fresh", latest: new Date(latest).toISOString() };
  const dump = await dumpSql(env.DB);
  const body = await gzip(dump.sql);
  const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const key = `${BACKUP_PREFIX}${new Date(now).toISOString().slice(0, 10)}T${stamp.slice(9)}.sql.gz`;
  const digest = await sha256(body);
  await env.BACKUPS.put(key, body, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: { source: "cryptophys-recovery-manager", sha256: digest, tables: String(dump.tables), rows: String(dump.rows) },
  });
  await appendAuditEvent(env.DB, {
    event_type: "backup.d1_written", actor: "cryptophys-recovery-manager", subject: key, outcome: "succeeded",
    payload: { bytes: body.byteLength, sha256: digest, tables: dump.tables, rows: dump.rows, reason: latest === null ? "no backup in 48 h" : "last backup older than 24 h" },
  });
  return { status: "written", key, bytes: body.byteLength, sha256: digest, tables: dump.tables, rows: dump.rows };
}
