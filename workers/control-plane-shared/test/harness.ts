// Test harness: a D1-compatible adapter over node:sqlite with the real migrations applied.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AiBinding, D1Database, D1PreparedStatement, D1Result } from "../src/types.ts";

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
    ACCESS_TEAM_DOMAIN: ACCESS_TEAM,
    ACCESS_AUD,
    ...extra,
  };
}

// ---------------------------------------------------------------- Cloudflare Access test identity
// Every HTTP request in the tests carries a real RS256 Access JWT, so the production gate
// runs unmodified. The team's certs endpoint is served from an in-process key pair.

export const ACCESS_TEAM = "cryptophys.cloudflareaccess.com";
export const ACCESS_AUD = "test-audience-tag";
export const CI_CLIENT_ID = "ci-client.access";
export const OPERATOR_EMAIL = "ops@cryptophys.work";

const accessKeys = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"],
) as CryptoKeyPair;
const accessJwk = { ...(await crypto.subtle.exportKey("jwk", accessKeys.publicKey)), kid: "harness" };

export async function signAccessJwt(claims: Record<string, unknown>): Promise<string> {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = `${enc({ alg: "RS256", kid: "harness", typ: "JWT" })}.${enc({ aud: [ACCESS_AUD], iss: `https://${ACCESS_TEAM}`, iat: now, exp: now + 86400, ...claims })}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", accessKeys.privateKey, new TextEncoder().encode(body));
  return `${body}.${Buffer.from(sig).toString("base64url")}`;
}

export const CI_JWT = await signAccessJwt({ common_name: CI_CLIENT_ID });
export const OPERATOR_JWT = await signAccessJwt({ email: OPERATOR_EMAIL });

/** True when a fetch targets the Access certs endpoint; tests that stub fetch delegate these here. */
export function isAccessCerts(url: string): boolean {
  return url === `https://${ACCESS_TEAM}/cdn-cgi/access/certs`;
}
export function accessCertsResponse(): Response {
  return new Response(JSON.stringify({ keys: [accessJwk] }));
}
const baseFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
  isAccessCerts(String(input)) ? accessCertsResponse() : baseFetch(input, init)) as typeof fetch;

export function req(method: string, path: string, body?: unknown, token: string | null = ADMIN, headers: Record<string, string> = {}, jwt: string | null = CI_JWT): Request {
  const h: Record<string, string> = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (jwt) h["cf-access-jwt-assertion"] = jwt;
  if (body !== undefined) h["content-type"] = "application/json";
  return new Request(`https://svc.example.workers.dev${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
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

