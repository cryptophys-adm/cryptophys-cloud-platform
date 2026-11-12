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
  // D1 runs each batch atomically and one at a time. Queue them so concurrent batches never
  // interleave, whatever the runtime's microtask timing (Node or workerd, ADR-0012 phase 3).
  private queue: Promise<unknown> = Promise.resolve();
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
    const run = this.queue.then(() => this.runBatch(statements));
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async runBatch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
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
    OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL}`,
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
export const APPROVER_EMAIL = "approver@cryptophys.work";

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
// Emails arrive in whatever case the IdP returns; recorded actors are normalized to lower case.
export const OPERATOR_JWT = await signAccessJwt({ email: "Ops@Cryptophys.Work" });
export const APPROVER_JWT = await signAccessJwt({ email: APPROVER_EMAIL });
export const OUTSIDER_JWT = await signAccessJwt({ email: "someone@example.com" });

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

/** A request authenticated as `jwt` (default: the CI service token); pass null for no Access JWT. */
export function req(method: string, path: string, body?: unknown, jwt: string | null = CI_JWT, headers: Record<string, string> = {}): Request {
  const h: Record<string, string> = { ...headers };
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


// ---------------------------------------------------------------- Workflows
// A minimal stand-in for the Workflows engine: step.do runs the callback and retries it up to
// config.retries.limit times (attempt is 1-indexed); waitForEvent resolves with a queued event
// of that type, or throws as a timeout would. Sleeps and back-offs are not waited for.
export interface FakeWorkflow {
  binding: {
    create(o?: { id?: string; params?: unknown }): Promise<{ id: string }>;
    get(id: string): Promise<{ id: string; sendEvent(e: { type: string; payload?: unknown }): Promise<void>; terminate(): Promise<void>; status(): Promise<{ status: string }> }>;
  };
  created: { id: string; params: unknown }[];
  events: Record<string, string[]>;
  terminated: string[];
  step(instanceId: string): FakeStep;
}
export interface FakeStep {
  names: string[];
  attempts: Record<string, number>;
  timedOut: string[];
  do<T>(name: string, a: unknown, b?: unknown): Promise<T>;
  waitForEvent<T>(name: string, o: { type: string; timeout?: unknown }): Promise<{ payload: T; timestamp: Date; type: string }>;
  sleep(name: string, d: unknown): Promise<void>;
  slept: string[];
}

export function fakeWorkflow(opts: { failCreate?: boolean; existing?: string[] } = {}): FakeWorkflow {
  const created: { id: string; params: unknown }[] = [];
  const events: Record<string, string[]> = {};
  const terminated: string[] = [];
  const known = new Set(opts.existing ?? []);
  const wf: FakeWorkflow = {
    created, events, terminated,
    binding: {
      async create(o) {
        if (opts.failCreate) throw new Error("workflows unavailable");
        const id = o?.id ?? `wf-${created.length + 1}`;
        if (known.has(id)) throw new Error(`instance ${id} already exists`);
        known.add(id);
        created.push({ id, params: o?.params });
        return { id };
      },
      async get(id) {
        if (!known.has(id)) throw new Error(`instance ${id} not found`);
        return {
          id,
          async sendEvent(e) { (events[id] ??= []).push(e.type); },
          async terminate() { terminated.push(id); },
          async status() { return { status: terminated.includes(id) ? "terminated" : "running" }; },
        };
      },
    },
    step(instanceId) {
      const s: FakeStep = {
        names: [], attempts: {}, timedOut: [], slept: [],
        async sleep(name: string) { s.names.push(name); s.slept.push(name); },
        async do<T>(name: string, a: unknown, b?: unknown): Promise<T> {
          const config = (typeof a === "function" ? {} : a) as { retries?: { limit: number } };
          const fn = (typeof a === "function" ? a : b) as (ctx: { attempt: number }) => Promise<T>;
          s.names.push(name);
          const limit = config.retries?.limit ?? 0;
          for (let attempt = 1; ; attempt++) {
            s.attempts[name] = attempt;
            try { return await fn({ attempt }); } catch (err) { if (attempt > limit) throw err; }
          }
        },
        async waitForEvent<T>(name: string, o: { type: string }) {
          s.names.push(name);
          const queue = events[instanceId] ?? [];
          const i = queue.indexOf(o.type);
          if (i < 0) { s.timedOut.push(name); throw new Error(`waitForEvent ${name} timed out`); }
          queue.splice(i, 1);
          return { payload: {} as T, timestamp: new Date(), type: o.type };
        },
      };
      return s;
    },
  };
  return wf;
}

// ADR-0012 G1: deploy decisions read the Forge's plan and checks from D1. Tests that used to fake GitHub's compare
// and CI APIs record the same scenario as the Forge would: its plan for `main` from the changed files, under the
// current registry fingerprint (the same rules as workers/forge/src/deploy-plan.ts), and its check of `main`.
let forgeClock = 0;
export async function forgeSees(db: FakeD1, s: { main: string; files: string[]; ready: boolean }): Promise<void> {
  const { DEPLOY_UNITS, unitRegistryState, unitChanged, isMigration, orderPending, recordPlanSide, registryFingerprint } = await import("../src/deploy-units.ts");
  const tag = s.main.slice(0, 12);
  const pending: { unit: string; workflow: string; target: string; reason: string }[] = [];
  const skipped: { unit: string; reason: string }[] = [];
  let newMigration = false;
  for (const unit of DEPLOY_UNITS) {
    const state = await unitRegistryState(db as never, unit, tag);
    if ("skip" in state) { skipped.push({ unit: unit.unit, reason: state.skip }); continue; }
    if (state.behind.length === 0) continue;
    if (s.files.some(isMigration)) newMigration = true;
    if (unitChanged(unit, s.files)) pending.push({ unit: unit.unit, workflow: unit.workflow, target: unit.services[0], reason: `main ${tag} changes ${unit.unit}` });
  }
  forgeClock = Math.max(Date.now(), forgeClock + 1);
  await recordPlanSide(db as never, "forge", s.main, await registryFingerprint(db as never), orderPending(pending, newMigration, skipped), forgeClock);
  const steps = JSON.stringify({ typecheck: { status: s.ready ? "passed" : "failed", errors: 0, console_build: { status: "passed" } } });
  const at = new Date().toISOString();
  db.raw.prepare(`INSERT OR REPLACE INTO forge_check_runs (commit_sha, status, runner, files, pass, fail, skip, failures, started_at, finished_at, duration_ms, steps, guard_status, source)
    VALUES (?, ?, 'forge-runner/1', 1, 1, ?, 0, '[]', ?, ?, 1, ?, 'clean', 'main')`).run(s.main, s.ready ? "passed" : "failed", s.ready ? 0 : 1, at, at, steps);
}
