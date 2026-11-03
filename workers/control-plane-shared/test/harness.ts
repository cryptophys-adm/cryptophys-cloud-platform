// Test harness: a D1-compatible adapter over node:sqlite with the real migrations applied.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AiBinding, D1Database, D1PreparedStatement, D1Result, Fetcher } from "../src/types.ts";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../control-plane-migrations");

const norm = (v: unknown): string | number | bigint | null | Uint8Array => {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v as string | number;
};

class Statement implements D1PreparedStatement {
  readonly sql: string;
  readonly params: unknown[];
  private readonly db: DatabaseSync;
  constructor(db: DatabaseSync, sql: string, params: unknown[] = []) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }
  bind(...values: unknown[]): D1PreparedStatement {
    return new Statement(this.db, this.sql, values);
  }
  private args() {
    return this.params.map(norm) as (string | number | null)[];
  }
  async first<T>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.args()) as T | undefined) ?? null;
  }
  async all<T>(): Promise<D1Result<T>> {
    return { results: this.db.prepare(this.sql).all(...this.args()) as T[], success: true, meta: {} };
  }
  async run(): Promise<D1Result> {
    const r = this.db.prepare(this.sql).run(...this.args());
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export class FakeD1 implements D1Database {
  readonly raw: DatabaseSync;
  constructor(raw: DatabaseSync) {
    this.raw = raw;
  }
  prepare(sql: string): D1PreparedStatement {
    return new Statement(this.raw, sql);
  }
  async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    this.raw.exec("BEGIN");
    try {
      const out: D1Result[] = [];
      for (const s of statements) out.push(await s.run());
      this.raw.exec("COMMIT");
      return out;
    } catch (err) {
      this.raw.exec("ROLLBACK");
      throw err;
    }
  }
}

/** Fresh database with every repository migration applied and recorded like `wrangler d1 migrations apply`. */
export function migratedDb(options: { recordLedger?: boolean } = {}): FakeD1 {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
    if (options.recordLedger !== false) raw.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(file);
  }
  return new FakeD1(raw);
}

export const ADMIN = "admin-token-0123456789abcdef";
export const APPROVER = "approver-token-fedcba9876543210";

export interface FakeAi extends AiBinding {
  calls: { model: string; input: Record<string, unknown> }[];
  reply: unknown;
  fail?: Error;
  delayMs?: number;
}

export function fakeAi(reply: unknown = { response: "{}" }): FakeAi {
  const ai: FakeAi = {
    calls: [],
    reply,
    async run(model, input) {
      ai.calls.push({ model, input });
      if (ai.delayMs) await new Promise((r) => setTimeout(r, ai.delayMs));
      if (ai.fail) throw ai.fail;
      return ai.reply;
    },
  };
  return ai;
}

export function baseEnv(service: string, db: FakeD1, extra: Record<string, unknown> = {}) {
  return {
    SERVICE_NAME: service,
    SERVICE_ENVIRONMENT: "production",
    API_CONTRACT_VERSION: "v1",
    DB: db,
    AI: fakeAi(),
    AI_MODEL: "@cf/meta/llama-3.1-8b-instruct-fast",
    ADMIN_TOKEN: ADMIN,
    CF_VERSION_METADATA: { id: "ver-self", tag: "abc1234def56" },
    ACCESS_TEAM_DOMAIN: "cryptophys.cloudflareaccess.com",
    ACCESS_AUD: "test-audience-tag",
    ...extra,
  };
}

export function req(method: string, path: string, body?: unknown, token: string | null = ADMIN, headers: Record<string, string> = {}): Request {
  const h: Record<string, string> = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (body !== undefined) h["content-type"] = "application/json";
  return new Request(`https://svc.internal${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}

export async function call(worker: { fetch(r: Request, e: never): Promise<Response> }, env: unknown, r: Request) {
  const res = await worker.fetch(r, env as never);
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

/** Service binding that dispatches straight into another Worker module. */
export function binding(worker: { fetch(r: Request, e: never): Promise<Response> }, env: unknown): Fetcher {
  return { fetch: (input, init) => worker.fetch(new Request(input as string, init), env as never) };
}
