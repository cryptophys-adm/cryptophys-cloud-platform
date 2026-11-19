// Archive of the retired crypto signal tables (owner 2026-11-14, resource audit decision 2: "archive to R2 first,
// then drop by migration"). The crypto Signal Engine was retired on 2026-11-05 (migration 0020); its five tables
// still hold rows that only the daily backup reads. Each table is written once to the private bucket as a gzip SQL
// script (its CREATE TABLE and every row), read back, decompressed and counted against D1, and the result is audited
// as backup.archive_verified (outcome "verified" or "mismatch"). The DROP is a separate migration that the owner
// approves only after every table shows "verified". Nothing here deletes anything. The prefix is outside the
// bucket's 90-day lifecycle rule (control-plane/ only), so the archive is kept.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { sqlLiteral } from "./backup.ts";

export const RETIRED_SIGNAL_TABLES = ["market_candles", "signal_indicators", "signal_confluence", "signal_ingest_runs", "macro_context"] as const;
export const ARCHIVE_PREFIX = "archive/retired-signal-tables/";
const PAGE = 500;

export interface ArchiveBucket {
  head(key: string): Promise<unknown | null>;
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; customMetadata?: Record<string, string> } | null>;
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * A literal that never spans lines: a string's line breaks are written as char(10) and char(13), so every INSERT is
 * exactly one line and the read-back row count is exact (a value can never look like the start of a statement).
 */
export function oneLineLiteral(v: unknown): string {
  if (typeof v !== "string") return sqlLiteral(v);
  return `'${v.replace(/'/g, "''").replace(/\r/g, "'||char(13)||'").replace(/\n/g, "'||char(10)||'")}'`;
}
export const archiveKey = (table: string) => `${ARCHIVE_PREFIX}${table}.sql.gz`;

async function gzip(text: string): Promise<ArrayBuffer> {
  return new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
}
async function gunzip(buf: ArrayBuffer): Promise<string> {
  return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}
async function sha256(buf: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** One table as a SQL script: its CREATE TABLE, then every row (paged by rowid). */
export async function dumpTable(db: D1Database, table: string): Promise<{ sql: string; rows: number }> {
  const schema = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first<{ sql: string }>();
  if (!schema?.sql) throw new Error(`table_missing:${table}`);
  const parts = [`${schema.sql};`];
  let rows = 0;
  let after = -9e15;
  for (;;) {
    const page = (await db.prepare(`SELECT rowid AS "__archive_rowid", * FROM ${ident(table)} WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE}`).bind(after)
      .all<Record<string, unknown>>()).results;
    for (const row of page) {
      after = Number(row.__archive_rowid);
      const cols = Object.keys(row).filter((c) => c !== "__archive_rowid");
      parts.push(`INSERT INTO ${ident(table)} (${cols.map(ident).join(",")}) VALUES(${cols.map((c) => oneLineLiteral(row[c])).join(",")});`);
    }
    rows += page.length;
    if (page.length < PAGE) break;
  }
  return { sql: parts.join("\n") + "\n", rows };
}

/** Rows of `table` in an archived script: its lines that are an INSERT into it (one statement per line, see
 * oneLineLiteral). The read-back count is compared with D1's count; only an exact match is audited as "verified". */
export function archivedRows(sql: string, table: string): number {
  const marker = `INSERT INTO ${ident(table)} (`;
  return sql.split("\n").filter((line) => line.startsWith(marker)).length;
}

export type ArchiveOutcome =
  | { status: "no_binding" }
  | { status: "done"; tables: Array<{ table: string; state: "dropped" | "verified" | "mismatch"; rows?: number; d1_rows?: number; key?: string }> };

async function alreadyVerified(db: D1Database, key: string): Promise<boolean> {
  const r = await db.prepare("SELECT 1 AS x FROM audit_events WHERE event_type = 'backup.archive_verified' AND subject = ? AND outcome = 'verified' LIMIT 1")
    .bind(key).first();
  return Boolean(r);
}

/**
 * Hourly and idempotent. For each retired table that still exists and has no "verified" archive yet: write the
 * archive object when it is missing, read it back and audit the comparison. A table already dropped, or already
 * verified, costs one D1 read and no R2 call.
 */
export async function archiveRetiredTables(env: { DB: D1Database; BACKUPS?: ArchiveBucket }, now = Date.now()): Promise<ArchiveOutcome> {
  if (!env.BACKUPS) return { status: "no_binding" };
  const present = new Set(((await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${RETIRED_SIGNAL_TABLES.map(() => "?").join(",")})`,
  ).bind(...RETIRED_SIGNAL_TABLES).all<{ name: string }>()).results ?? []).map((r) => r.name));
  const tables: Extract<ArchiveOutcome, { status: "done" }>["tables"] = [];
  for (const table of RETIRED_SIGNAL_TABLES) {
    if (!present.has(table)) { tables.push({ table, state: "dropped" }); continue; }
    const key = archiveKey(table);
    if (await alreadyVerified(env.DB, key)) { tables.push({ table, state: "verified", key }); continue; }
    if (!(await env.BACKUPS.head(key))) {
      const dump = await dumpTable(env.DB, table);
      const body = await gzip(dump.sql);
      await env.BACKUPS.put(key, body, {
        httpMetadata: { contentType: "application/gzip" },
        customMetadata: { source: "cryptophys-recovery-manager", table, rows: String(dump.rows), sha256: await sha256(body), archived_at: new Date(now).toISOString() },
      });
    }
    // Read back what the bucket holds, and count it against D1 now.
    const obj = await env.BACKUPS.get(key);
    if (!obj) throw new Error(`archive_unreadable:${table}`);
    const buf = await obj.arrayBuffer();
    const rows = archivedRows(await gunzip(buf), table);
    const d1 = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${ident(table)}`).first<{ n: number }>())?.n ?? -1;
    const state = rows === d1 ? "verified" : "mismatch";
    await appendAuditEvent(env.DB, {
      event_type: "backup.archive_verified", actor: "cryptophys-recovery-manager", subject: key, outcome: state,
      payload: { table, archived_rows: rows, d1_rows: d1, bytes: buf.byteLength, sha256: await sha256(buf), decision: "owner 2026-11-14: archive to R2, then drop" },
    });
    tables.push({ table, state, rows, d1_rows: d1, key });
  }
  return { status: "done", tables };
}
