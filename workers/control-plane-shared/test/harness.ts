// Test harness: a D1-compatible adapter over node:sqlite with the real migrations applied.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AiBinding, D1Database, D1PreparedStatement, D1Result } from "../src/types.ts";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "../../control-plane-migrations");
const WORKERS = join(dirname(fileURLToPath(import.meta.url)), "../..");

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
  // The migrations seed agents with fixed dates. The Supervisor proposes to retire an agent that has done nothing for
  // RETIRE_IDLE_DAYS since it was registered, and most tests run its cycle on the real clock: on 2026-11-21T12:00Z the
  // aether-* agents (seeded 2026-11-07T12:00Z) crossed 14 days, every such cycle made one more proposal, and 20 tests
  // failed on a calendar date. A fresh registry is as old as the test: a test that wants an old agent adds its own.
  raw.prepare("UPDATE agents SET created_at = ? WHERE voter = 0").run(new Date().toISOString());
  return new FakeD1(raw);
}

/**
 * ADR-0013 phase 3 (migration 0041): "from here on, new agents, engines and seats are added only by consensus actions,
 * never by hand". The agents and engines main's DNA declared after 0041, which the census registers by consensus
 * (register_agent, register_engine), with no migration seeding them. A test that compares the repository's DNA with the
 * live registries applies them with registeredByConsensus(): the registries once consensus has registered what main
 * declares. organism-dna-0013 O8 checks each is declared, routine (no privileged capability) and seeded by no migration.
 */
/** The kernel's wrangler.toml without the ConversationAgent (HAIC H1b), the CouncilAgent (H1.5b), the ConsoleHub (push hub) and the transcripts bucket (H1.5e): what the earlier steps' wiring tests compare. */
export const withoutConversation = (toml: string): string => toml
  .replace(/\n# HAIC push hub \(docs\/design\/HAIC-H0-H1\.md §4\.5[^\n]*\n\[\[durable_objects\.bindings\]\]\nname = "HUB"\nclass_name = "ConsoleHub"\n/, "\n")
  .replace(/\n\[\[migrations\]\]\ntag = "v9"\nnew_sqlite_classes = \["ConsoleHub"\]\n/, "\n")
  .replace(/\n# HAIC H1\.5b \(docs\/design\/HAIC-H0-H1\.md §4\)[^\n]*\n\[\[durable_objects\.bindings\]\]\nname = "COUNCIL"\nclass_name = "CouncilAgent"\n/, "\n")
  .replace(/\n\[\[migrations\]\]\ntag = "v8"\nnew_sqlite_classes = \["CouncilAgent"\]\n/, "\n")
  .replace(/\n# HAIC H1b \(docs\/design\/HAIC-H0-H1\.md §3\.1\)[^\n]*\n\[\[durable_objects\.bindings\]\]\nname = "CONVERSATION"\nclass_name = "ConversationAgent"\n/, "\n")
  .replace(/\n\[\[migrations\]\]\ntag = "v7"\nnew_sqlite_classes = \["ConversationAgent"\]\n/, "\n");

export const CONSENSUS_REGISTERED: { agents: ReadonlyArray<{ service: string; agent_id: string; privileged?: true }>; engines: ReadonlyArray<{ service: string; task: string }> } = {
  // ADR Steward (docs/design/ADR-STEWARD.md §4.1, step 3). The evolver (ADR-0014 §11, docs/design/EVOLVER.md step V5)
  // holds code.propose (tier 2): register_privileged_agent, consensus and then the owner's click.
  agents: [{ service: "cryptophys-ai-kernel", agent_id: "adr-steward" }, { service: "cryptophys-ai-kernel", agent_id: "evolver", privileged: true }],
  engines: [
    { service: "cryptophys-ai-kernel", task: "draft_adr_explanation" },
    { service: "cryptophys-ai-kernel", task: "evolve_plan" },
    { service: "cryptophys-ai-kernel", task: "evolve_write" },
    // HAIC H1b (docs/design/HAIC-H0-H1.md §3): the chat's two model tasks, registered by consensus after the deploy.
    { service: "cryptophys-ai-kernel", task: "chat_plan" },
    { service: "cryptophys-ai-kernel", task: "chat_answer" },
    // HAIC H1.5b (docs/design/HAIC-H0-H1.md §4): the council's three model tasks.
    { service: "cryptophys-ai-kernel", task: "council_position" },
    { service: "cryptophys-ai-kernel", task: "council_rebuttal" },
    { service: "cryptophys-ai-kernel", task: "council_synthesis" },
    // HAIC H2b: a chat directive into a typed proposal draft.
    { service: "cryptophys-ai-kernel", task: "directive_draft" },
  ],
};

/** Write the CONSENSUS_REGISTERED rows as the registration executors do (ai-kernel/src/organism.ts), each gene from its DNA. */
export function registeredByConsensus(db: FakeD1): FakeD1 {
  const at = "2026-11-17T12:00:00.000Z";
  const dirOf = (service: string) => service.replace(/^cryptophys-/, "");
  for (const a of CONSENSUS_REGISTERED.agents) {
    const dna = JSON.parse(readFileSync(join(WORKERS, dirOf(a.service), "organism.json"), "utf8")) as { agents: Array<{ id: string; display_name: string; capabilities: string[]; tier_max: number }> };
    const gene = dna.agents.find((g) => g.id === a.agent_id);
    if (!gene) throw new Error(`${a.agent_id} is not in ${a.service}'s DNA`);
    db.raw.prepare(`INSERT OR IGNORE INTO agents (agent_id, display_name, host_worker, purpose, tier_max, capabilities_json, status, status_reason, updated_by, created_at, updated_at, voter)
      VALUES (?, ?, ?, ?, ?, ?, 'enabled', NULL, 'consensus:test', ?, ?, 0)`)
      .run(gene.id, gene.display_name, a.service, `Declared in ${a.service}'s DNA; registered by consensus (test).`, gene.tier_max, JSON.stringify(gene.capabilities), at, at);
  }
  for (const e of CONSENSUS_REGISTERED.engines) {
    db.raw.prepare("INSERT OR IGNORE INTO engines (service_id, task, status, registered_by, created_at, updated_at) VALUES (?, ?, 'enabled', 'consensus:test', ?, ?)").run(e.service, e.task, at, at);
  }
  return db;
}

/** A migrated database whose registries also hold what consensus registers from main's DNA (CONSENSUS_REGISTERED). */
export const registeredDb = (options: { recordLedger?: boolean } = {}): FakeD1 => registeredByConsensus(migratedDb(options));

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

/**
 * The Access settings of a test env, without a database. In the Forge's runner every migratedDb() lives in the
 * sql.js wasm heap, which never shrinks, so building a migrated database only to read these two constants pushed
 * console-tp023 past the Worker memory limit on its own (2026-11-12).
 */
export function accessEnv(): { ACCESS_TEAM_DOMAIN: string; ACCESS_AUD: string } {
  return { ACCESS_TEAM_DOMAIN: ACCESS_TEAM, ACCESS_AUD };
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

// ---------------------------------------------------------------- the SSOT's "Last reviewed" record (owner 2026-11-26)

/** The pointer that ends docs/SSOT.md line 5 since the history moved out of it ("Ya, setuju pindahkan", 2026-11-26). */
export const SSOT_HISTORY_POINTER = "; older entries: `docs/ssot-history/` (newest first), then `docs/SSOT-HISTORY.md`).";
export const SSOT_HISTORY_MARKER = "<!-- remainder -->";
export const SSOT_ROTATED_FILE = /^\d{4}-\d{2}-\d{2}-\d{2}-[a-z0-9-]+\.md$/;

/**
 * The whole "Last reviewed" record, newest first, as one line in the form line 5 had before 2026-11-26: line 5's
 * entries (without the pointer), then the entries pushed out of it (docs/ssot-history/, by file name, newest first,
 * each on its file's third line), then the frozen rest (docs/SSOT-HISTORY.md, the line after its marker). Tests that
 * read their own entry read it here, wherever it now lives.
 */
export function lastReviewedRecord(root = join(WORKERS, "..")): string {
  const line5 = readFileSync(join(root, "docs/SSOT.md"), "utf8").split("\n")[4];
  if (!line5.startsWith("Last reviewed: ") || !line5.endsWith(SSOT_HISTORY_POINTER)) throw new Error("docs/SSOT.md line 5 is not the Last reviewed line with its history pointer");
  const head = line5.slice(0, -SSOT_HISTORY_POINTER.length);
  let rotated: string[] = [];
  try {
    rotated = (readdirSync(join(root, "docs/ssot-history")) as string[]).filter((n) => SSOT_ROTATED_FILE.test(n)).sort().reverse()
      .map((n) => readFileSync(join(root, "docs/ssot-history", n), "utf8").split("\n")[2]);
  } catch { rotated = []; }
  const archive = readFileSync(join(root, "docs/SSOT-HISTORY.md"), "utf8").split("\n");
  const at = archive.indexOf(SSOT_HISTORY_MARKER);
  if (at < 0 || !archive[at + 1]) throw new Error("docs/SSOT-HISTORY.md has no remainder after its marker");
  return [head, ...rotated, archive[at + 1]].join("; ");
}

// ---------------------------------------------------------------- runner support (2026-11-26, the Forge's workerd runner)

/**
 * Whether this runner can start a child process. The Forge's own runner (workerd) has no child_process: a test that
 * measures memory in its own process skips that measurement there, explicitly, and keeps its other assertions.
 */
export async function canSpawn(): Promise<boolean> {
  try {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, ["-e", "0"], { encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
}
export const NO_CHILD_PROCESS = "child_process unavailable in this runner";

/** `n` pseudo-random bytes from a seed (xorshift32): no crypto.getRandomValues, which workerd caps at 64 KiB a call. */
export function pseudoRandom(n: number, seed = 0x9e3779b9): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < n; i++) { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; out[i] = x & 0xff; }
  return out;
}
