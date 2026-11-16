// ADR-0012 G6 gate 4 (owner 2026-11-15, "1 setuju"): the deploy workflows' smoke tests through Cloudflare Access,
// repeated by the native deploy (native-deploy.ts) after its own live check.
//
// Every deploy-*.yml workflow checks a Worker after `wrangler deploy` through its public hostname, behind Access,
// with the CI service token (`verify-worker-live.sh --require-access`: an unauthenticated GET /health is refused by
// Access, GET /health and GET /ready answer 200 with the workflow's jq contract), and some units then run their own
// smoke step (the Console's forwarding, allow-list and CSRF probes and the Nexus mount; the Control Plane's audit
// chain and kernel checks; the Forge's status). The native path verified live only through the Drift Detector's
// service binding (version tag and health), which does not pass through Access.
//
// SMOKE_TABLE holds the same checks, one entry per unit, each with the workflow's jq filter verbatim next to its
// translation. A test (gate4-access-vars-2026-11-15.test.ts) reads the workflows and requires every URL they probe
// to be either in the table or in the unit's `not_repeated` list (with the reason), and every jq filter in the table
// to appear in its workflow, so the table and the workflows cannot drift apart.
//
// Credentials. The probes send the Access service token as `CF-Access-Client-Id` / `CF-Access-Client-Secret`. The
// Orchestrator does not hold one today: the owner sets the Worker secrets CF_ACCESS_CLIENT_ID and
// CF_ACCESS_CLIENT_SECRET on cryptophys-deployment-orchestrator, with the values of the GitHub production secrets of
// the same names (the `cryptophys-ci` service token, which the Access policy `ci-service-token` includes and every
// Worker's OPERATOR_IDENTITIES lists; the Console's whoami probe requires exactly that: an operator, never an
// approver). Until both are set the smoke tests are skipped and the outcome says so (`smoke.status: "skipped"`);
// once set, a failed probe restores every changed Worker, exactly like a failed live check. Deleting the two secrets
// turns the probes off again.
//
// Reaching the public hostnames from a Worker. A global fetch() from one Worker to another Worker's workers.dev URL
// on the same account is refused (error 1042) unless the caller has the compatibility flag
// global_fetch_strictly_public, which routes the request "as if made on the public Internet", through Access
// (Cloudflare: Workers errors, 1042; compatibility flags). The Orchestrator's wrangler.toml sets that flag.
import { sleep } from "./native-rollback.ts";

const API = "https://api.cloudflare.com/client/v4";

/** The two Worker secrets the owner sets on the Orchestrator (the `cryptophys-ci` service token). */
export const SMOKE_SECRETS = ["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET"] as const;
export const SMOKE_ATTEMPTS = 5;
export const SMOKE_DELAY_MS = 3_000;

/** What a probe's check can read besides the body. */
export interface SmokeContext { service: string; tag: string; now: number }
/** The bodies are untrusted JSON; each check reads them defensively. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export interface SmokeProbe {
  /** Stable id, recorded in the outcome (`<unit>:<id>`). */
  id: string;
  /** The Worker whose workers.dev hostname is probed (`origin: "workers_dev"`), or whose route a fixed origin reaches. */
  service: string;
  origin: "workers_dev" | `https://${string}`;
  method: "GET" | "POST";
  /** The path and query, as the workflow requests it. */
  path: string;
  /** `service_token`: with the Access service token; `none`: without it, to prove Access stops the request first. */
  auth: "service_token" | "none";
  status: readonly number[];
  /** The workflow's jq filter, verbatim (shell variables `${name}` and `${tag}` as written there). */
  jq?: string;
  /** The jq filter's translation; required when `jq` is set. */
  check?: (body: Json, ctx: SmokeContext) => boolean;
  /** Extra request headers; `{base}` is replaced by the probed origin (the Console's Origin header). */
  headers?: Readonly<Record<string, string>>;
  body?: string;
  /** `service`: right after this Worker is verified live; `unit`: after every Worker of the unit, before the record. */
  after: "service" | "unit";
  attempts?: number;
}

/**
 * A URL a workflow requests that the native path does not repeat, and why. With `filter`, the URL is probed, but
 * that one term of the workflow's jq filter (`<filter> and <term>`) is not: the probe's `jq` is the workflow's
 * filter without ` and <term>`.
 */
export interface NotRepeated { method: string; url: string; why: string; filter?: string }
export interface UnitSmoke { unit: string; workflow: string; probes: SmokeProbe[]; not_repeated: NotRepeated[] }

const isObj = (v: unknown): v is Record<string, Json> => Boolean(v) && typeof v === "object" && !Array.isArray(v);
/** jq `[.checks[]] | all`: every value truthy (jq: not false and not null); iterating null is an error. */
const allChecks = (c: unknown) => (Array.isArray(c) ? c : isObj(c) ? Object.values(c) : null)?.every((v) => v !== false && v !== null) ?? false;

/**
 * verify-worker-live.sh --require-access, for one Worker: GET /health without credentials is refused by Access
 * (302, 401 or 403), then GET /health and GET /ready with the service token answer 200 and the workflow's filters.
 */
function live(service: string, health: { jq: string; check: SmokeProbe["check"] }, ready: { jq: string; check: SmokeProbe["check"] }): SmokeProbe[] {
  return [
    { id: `${service}:access_required`, service, origin: "workers_dev", method: "GET", path: "/health", auth: "none", status: [302, 401, 403], after: "service" },
    { id: `${service}:health`, service, origin: "workers_dev", method: "GET", path: "/health", auth: "service_token", status: [200], ...health, after: "service" },
    { id: `${service}:ready`, service, origin: "workers_dev", method: "GET", path: "/ready", auth: "service_token", status: [200], ...ready, after: "service" },
  ];
}
const healthTagged = (expected: string) => (b: Json, c: SmokeContext) =>
  isObj(b) && b.status === "ok" && b.service === expected && b.environment === "production" && b.contract_version === "v1" && isObj(b.version) && b.version.tag === c.tag;
const healthUntagged = (expected: string) => (b: Json) =>
  isObj(b) && b.status === "ok" && b.service === expected && b.environment === "production" && b.contract_version === "v1";
const readyProduction = (expected: string) => (b: Json) =>
  isObj(b) && b.status === "ready" && b.service === expected && b.production_ready === true && allChecks(b.checks);

/** The Control Plane loop's filters (deploy-control-plane.yml), the same for every Worker of the unit. */
const CP_HEALTH = '.status == "ok" and .service == "${name}" and .environment == "production" and .contract_version == "v1" and .version.tag == "${tag}"';
const CP_READY = '.status == "ready" and .service == "${name}" and .production_ready == true and ([.checks[]] | all)';
export const CONTROL_PLANE_DIRS = ["policy-engine", "audit-ledger", "platform-registry", "recovery-manager", "drift-detector", "ai-kernel"] as const;

const CONSOLE = "cryptophys-console";
const KERNEL = "cryptophys-ai-kernel";
const consoleProbe = (id: string, method: "GET" | "POST", path: string, status: number, jq: string, check: SmokeProbe["check"], headers?: Record<string, string>): SmokeProbe =>
  ({ id: `console:${id}`, service: CONSOLE, origin: "workers_dev", method, path, auth: "service_token", status: [status], jq, check, ...(headers ? { headers } : {}), after: "unit" });
const CONSOLE_WRITE = { Origin: "{base}", "x-cryptophys-console": "1" };
const XAUUSD_KEYS = ["candle_key", "confidence", "decided_at", "decision", "report_id", "reported_at"];

export const SMOKE_TABLE: Readonly<Record<string, UnitSmoke>> = {
  "deployment-orchestrator": {
    unit: "deployment-orchestrator", workflow: "deploy-deployment-orchestrator.yml",
    probes: live("cryptophys-deployment-orchestrator",
      { jq: '.status == "ok" and .service == "cryptophys-deployment-orchestrator" and .environment == "production" and .contract_version == "v1"', check: healthUntagged("cryptophys-deployment-orchestrator") },
      // The workflow's ready filter without `.production_dispatch_enabled == true` (not_repeated, below).
      { jq: '.status == "ready" and .service == "cryptophys-deployment-orchestrator" and ([.checks[]] | all)',
        check: (b) => isObj(b) && b.status === "ready" && b.service === "cryptophys-deployment-orchestrator" && allChecks(b.checks) }),
    not_repeated: [
      { method: "GET", url: "cryptophys-deployment-orchestrator/ready", filter: ".production_dispatch_enabled == true",
        why: "GitHub fallback readiness; not a native readiness condition (cut-over step 7 revokes GH_ACTIONS_TOKEN)" },
      { method: "GET", url: "https://deploy-orchestrator.cryptophys.work/health", why: "advisory in the workflow (--custom-domain: a failure is only a warning)" },
    ],
  },
  "control-plane": {
    unit: "control-plane", workflow: "deploy-control-plane.yml",
    probes: [
      ...CONTROL_PLANE_DIRS.flatMap((d) => live(`cryptophys-${d}`, { jq: CP_HEALTH, check: healthTagged(`cryptophys-${d}`) }, { jq: CP_READY, check: readyProduction(`cryptophys-${d}`) })),
      { id: "control-plane:audit_verify", service: "cryptophys-audit-ledger", origin: "workers_dev", method: "GET", path: "/v1/verify", auth: "service_token", status: [200],
        jq: ".valid == true and .events_checked > 0", check: (b) => isObj(b) && b.valid === true && typeof b.events_checked === "number" && b.events_checked > 0, after: "unit" },
      { id: "control-plane:kernel_mcp_tools", service: KERNEL, origin: "workers_dev", method: "POST", path: "/mcp", auth: "service_token", status: [200],
        headers: { "Content-Type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
        jq: '[.result.tools[].name] | index("platform_status") != null and index("set_agents_enabled") != null',
        check: (b) => { const t = isObj(b) && isObj(b.result) && Array.isArray(b.result.tools) ? b.result.tools.map((x: Json) => x?.name) : null; return Boolean(t?.includes("platform_status") && t.includes("set_agents_enabled")); },
        after: "unit" },
      { id: "control-plane:kernel_supervisor", service: KERNEL, origin: "workers_dev", method: "GET", path: "/v1/kernel", auth: "service_token", status: [200],
        jq: '.agents_enabled == true and ([.agents[] | select(.agent_id == "supervisor" and .tier_max == 1 and .status == "enabled")] | length == 1) and ([.agents[] | select(.tier_max >= 2)] | length == 0)',
        check: (b) => isObj(b) && b.agents_enabled === true && Array.isArray(b.agents)
          && b.agents.filter((a: Json) => a?.agent_id === "supervisor" && a.tier_max === 1 && a.status === "enabled").length === 1
          && b.agents.filter((a: Json) => typeof a?.tier_max === "number" && a.tier_max >= 2).length === 0,
        after: "unit" },
      { id: "control-plane:consensus_not_stuck", service: KERNEL, origin: "workers_dev", method: "GET", path: "/v1/consensus?limit=50", auth: "service_token", status: [200],
        jq: '(.mode | IN("shadow", "routine", "deploy", "critical")) and ([.proposals[] | select(.status == "executing" and .decided_at < $cutoff)] | length == 0)',
        // $cutoff: `date -u -d '-30 minutes' +%Y-%m-%dT%H:%M:%S`, compared as text like jq does.
        check: (b, c) => {
          const cutoff = new Date(c.now - 30 * 60_000).toISOString().slice(0, 19);
          return isObj(b) && ["shadow", "routine", "deploy", "critical"].includes(b.mode) && Array.isArray(b.proposals)
            && b.proposals.filter((p: Json) => p?.status === "executing" && typeof p.decided_at === "string" && p.decided_at < cutoff).length === 0;
        },
        after: "unit" },
      { id: "control-plane:kernel_reports_24h", service: KERNEL, origin: "workers_dev", method: "GET", path: "/v1/status", auth: "service_token", status: [200],
        jq: '.agent_reports_24h | (.counts | has("critical") and has("warning") and has("info")) and (.latest_attention | type == "array" and length <= 5) and (.latest_critical | type == "array" and length <= 5) and (.critical_fingerprint | type == "string" and test("^[0-9a-f]{64}$")) and (has("error") | not)',
        check: (b) => {
          const r = isObj(b) ? b.agent_reports_24h : null;
          return isObj(r) && isObj(r.counts) && ["critical", "warning", "info"].every((k) => k in r.counts)
            && Array.isArray(r.latest_attention) && r.latest_attention.length <= 5 && Array.isArray(r.latest_critical) && r.latest_critical.length <= 5
            && typeof r.critical_fingerprint === "string" && /^[0-9a-f]{64}$/.test(r.critical_fingerprint) && !("error" in r);
        },
        after: "unit" },
      { id: "control-plane:kernel_xauusd_latest", service: KERNEL, origin: "workers_dev", method: "GET", path: "/v1/status", auth: "service_token", status: [200],
        jq: 'has("xauusd_latest") and (.xauusd_latest == null or ((.xauusd_latest | keys) == ["candle_key","confidence","decided_at","decision","report_id","reported_at"] and (.xauusd_latest.decision | IN("BUY","SELL","WAIT","NO_TRADE","UNKNOWN"))))',
        check: (b) => {
          if (!isObj(b) || !("xauusd_latest" in b)) return false;
          const x = b.xauusd_latest;
          if (x === null) return true;
          return isObj(x) && JSON.stringify(Object.keys(x).sort()) === JSON.stringify(XAUUSD_KEYS) && ["BUY", "SELL", "WAIT", "NO_TRADE", "UNKNOWN"].includes(x.decision);
        },
        after: "unit" },
    ],
    not_repeated: [
      { method: "PUT", url: "cryptophys-platform-registry/v1/services/{service}/desired-version", why: "the native path records the desired versions through RegistryRpc.recordNativeDeploy" },
      { method: "POST", url: "cryptophys-drift-detector/v1/observe", why: "writes a drift run; the native live check probes each Worker through DriftRpc.probeService" },
      { method: "POST", url: "cryptophys-audit-ledger/v1/events", why: "appends to the audit chain; the native path audits through its own D1 binding" },
      { method: "POST", url: "cryptophys-policy-engine/v1/evaluate", why: "a policy decision request, not a read; the Policy Engine's own tests cover the ci_green deny" },
      { method: "POST", url: "cryptophys-recovery-manager/v1/plans", why: "creates a recovery plan and starts a lifecycle Workflow instance" },
      { method: "POST", url: "cryptophys-recovery-manager/v1/plans/{plan_id}/disable", why: "follows the plan creation above" },
      { method: "POST", url: "cryptophys-ai-kernel/v1/agents/supervisor/wake", why: "runs a supervisor cycle (agent actions)" },
    ],
  },
  console: {
    unit: "console", workflow: "deploy-console.yml",
    probes: [
      ...live(CONSOLE,
        { jq: '.status == "ok" and .service == "cryptophys-console" and .environment == "production" and .contract_version == "v1" and .version.tag == "${tag}"', check: healthTagged(CONSOLE) },
        { jq: '.status == "ready" and .service == "cryptophys-console" and .production_ready == true and ([.checks[]] | all)', check: readyProduction(CONSOLE) }),
      // The CI service token is an operator but never an approver.
      consoleProbe("whoami", "GET", "/api/whoami", 200, '.operator == true and .approver == false and .type == "service_token"',
        (b) => isObj(b) && b.operator === true && b.approver === false && b.type === "service_token"),
      consoleProbe("forward_overview", "GET", "/api/platform/v1/overview", 200, ".overview | type == \"object\"", (b) => isObj(b) && isObj(b.overview)),
      consoleProbe("forward_kernel", "GET", "/api/kernel/v1/kernel", 200, ".agents | type == \"array\"", (b) => isObj(b) && Array.isArray(b.agents)),
      consoleProbe("forward_audit_verify", "GET", "/api/audit/v1/verify", 200, ".valid == true", (b) => isObj(b) && b.valid === true),
      // The allow-list holds: no MCP, no raw audit append (refused by the Console before any forward).
      consoleProbe("deny_mcp", "POST", "/api/kernel/mcp", 404, '.error == "not_allowed"', (b) => isObj(b) && b.error === "not_allowed", CONSOLE_WRITE),
      consoleProbe("deny_audit_append", "POST", "/api/audit/v1/events", 404, '.error == "not_allowed"', (b) => isObj(b) && b.error === "not_allowed", CONSOLE_WRITE),
      // CSRF: a state-changing call without the console header is refused before any forward.
      consoleProbe("csrf", "POST", "/api/drift/v1/observe", 403, '.error == "csrf"', (b) => isObj(b) && b.error === "csrf", { Origin: "{base}" }),
      // ADR-0010: the same Console answers under the /console mount.
      consoleProbe("mount_whoami", "GET", "/console/api/whoami", 200, ".operator == true", (b) => isObj(b) && b.operator === true),
      consoleProbe("mount_kernel", "GET", "/console/api/kernel/v1/kernel", 200, ".agents | type == \"array\"", (b) => isObj(b) && Array.isArray(b.agents)),
      // The Nexus hostname routes /console* to the Console (the route is verified read only before the upload).
      { id: "console:nexus_mount", service: CONSOLE, origin: "https://nexus.cryptophys.work", method: "GET", path: "/console/health", auth: "service_token", status: [200],
        jq: '.service == "cryptophys-console"', check: (b) => isObj(b) && b.service === CONSOLE, after: "unit", attempts: 6 },
    ],
    not_repeated: [],
  },
  "platform-api": {
    unit: "platform-api", workflow: "deploy-platform-api.yml",
    probes: live("cryptophys-platform-api",
      { jq: '.status == "ok" and .service == "cryptophys-cloud-platform" and .environment == "production" and .contract_version == "v1"', check: healthUntagged("cryptophys-cloud-platform") },
      { jq: '.status == "ready" and .service == "cryptophys-cloud-platform" and .production_ready == true and ([.checks[]] | all)', check: readyProduction("cryptophys-cloud-platform") }),
    not_repeated: [],
  },
  forge: {
    unit: "forge", workflow: "deploy-forge.yml",
    probes: [
      ...live("cryptophys-forge",
        { jq: '.status == "ok" and .service == "cryptophys-forge" and .environment == "production" and .contract_version == "v1" and .version.tag == "${tag}"', check: healthTagged("cryptophys-forge") },
        { jq: '.status == "ready" and .service == "cryptophys-forge" and .production_ready == true and ([.checks[]] | all)', check: readyProduction("cryptophys-forge") }),
      { id: "forge:status", service: "cryptophys-forge", origin: "workers_dev", method: "GET", path: "/v1/forge/status", auth: "service_token", status: [200],
        jq: '.repo != null and (.head.sha | test("^[0-9a-f]{40}$"))', check: (b) => isObj(b) && b.repo != null && isObj(b.head) && typeof b.head.sha === "string" && /^[0-9a-f]{40}$/.test(b.head.sha),
        after: "unit" },
    ],
    not_repeated: [
      { method: "POST", url: "cryptophys-forge/v1/forge/import", why: "imports the repository from GitHub (a one-time bootstrap, state-changing); the status read after it is repeated" },
    ],
  },
};

export type SmokeOutcome = { ok: true; probes: string[] } | { ok: false; probe: string; reason: string; probes: string[] };

/** The smoke hooks executeNativeDeploy calls; `skipped` (the reason) when the runner cannot probe at all. */
export interface SmokeHooks {
  readonly skipped: string | null;
  afterService(unit: string, service: string, tag: string): Promise<SmokeOutcome>;
  afterUnit(unit: string, tag: string): Promise<SmokeOutcome>;
}

/** The Access service token as access-headers.sh normalises it; null when unset, or the reason it is unusable. */
export function smokeToken(env: { CF_ACCESS_CLIENT_ID?: string; CF_ACCESS_CLIENT_SECRET?: string }): { id: string; secret: string } | { reason: string } {
  if (!env.CF_ACCESS_CLIENT_ID && !env.CF_ACCESS_CLIENT_SECRET) return { reason: "access_service_token_not_set" };
  if (!env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) return { reason: "access_service_token_incomplete" };
  const clean = (v: string, header: string) => v.replace(/[\r\n]/g, "").replace(new RegExp(`^\\s*(${header}:)?\\s*`, "i"), "").replace(/\s+$/, "");
  const id = clean(env.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Id");
  const secret = clean(env.CF_ACCESS_CLIENT_SECRET, "CF-Access-Client-Secret");
  if (!id || !secret) return { reason: "access_service_token_empty" };
  if (id.startsWith("cfast_")) return { reason: "access_service_token_swapped" };
  return { id, secret };
}

export interface SmokeEnv { CF_ACCESS_CLIENT_ID?: string; CF_ACCESS_CLIENT_SECRET?: string; CF_DEPLOY_TOKEN?: string; CF_ACCOUNT_ID?: string }

/**
 * Runs the table's probes. Not configured (neither secret set): `skipped`. Set but unusable (one missing, empty or
 * swapped): every run fails, so a wrong token never passes for a skipped one.
 */
export class SmokeRunner implements SmokeHooks {
  readonly skipped: string | null;
  private readonly token: { id: string; secret: string } | { reason: string };
  private readonly fetcher: typeof fetch;
  private readonly delayMs: number;
  private readonly now: () => number;
  private readonly env: SmokeEnv;
  private subdomain: string | null = null;
  constructor(env: SmokeEnv, fetcher: typeof fetch = fetch, opts: { delayMs?: number; now?: () => number } = {}) {
    this.env = env;
    this.token = smokeToken(env);
    this.skipped = "reason" in this.token && this.token.reason === "access_service_token_not_set" ? this.token.reason : null;
    this.fetcher = (input, init) => fetcher(input, init);
    this.delayMs = opts.delayMs ?? SMOKE_DELAY_MS;
    this.now = opts.now ?? Date.now;
  }

  /** The account's workers.dev subdomain (`GET /accounts/{a}/workers/subdomain`, CF_DEPLOY_TOKEN), as the workflows read it. */
  private async workersDev(): Promise<string> {
    if (this.subdomain) return this.subdomain;
    const res = await this.fetcher(`${API}/accounts/${this.env.CF_ACCOUNT_ID}/workers/subdomain`, { headers: { authorization: `Bearer ${this.env.CF_DEPLOY_TOKEN}` } });
    const body = await res.json().catch(() => null) as { success?: boolean; result?: { subdomain?: unknown } } | null;
    const s = body?.result?.subdomain;
    if (!res.ok || !body?.success || typeof s !== "string" || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(s)) throw new Error("workers_subdomain_unreadable");
    return (this.subdomain = s);
  }

  private async probe(p: SmokeProbe, tag: string): Promise<string | null> {
    if ("reason" in this.token) return this.token.reason;
    let origin: string;
    try { origin = p.origin === "workers_dev" ? `https://${p.service}.${await this.workersDev()}.workers.dev` : p.origin; } catch (err) { return String((err as Error).message); }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(p.headers ?? {})) headers[k] = v.replace("{base}", origin);
    if (p.auth === "service_token") { headers["CF-Access-Client-Id"] = this.token.id; headers["CF-Access-Client-Secret"] = this.token.secret; }
    let last = "no_attempt";
    const attempts = p.attempts ?? SMOKE_ATTEMPTS;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(this.delayMs);
      let res: Response;
      try {
        res = await this.fetcher(origin + p.path, { method: p.method, headers, redirect: "manual", ...(p.body ? { body: p.body } : {}) });
      } catch { last = "fetch_failed"; continue; }
      if (!p.status.includes(res.status)) { last = `http_${res.status}`; await res.body?.cancel().catch(() => undefined); continue; }
      if (!p.check) { await res.body?.cancel().catch(() => undefined); return null; }
      const body = await res.json().catch(() => undefined);
      if (body === undefined) { last = "not_json"; continue; }
      let ok = false;
      try { ok = p.check(body, { service: p.service, tag, now: this.now() }); } catch { ok = false; }
      if (ok) return null;
      last = "contract_failed";
    }
    return last;
  }

  private async run(probes: SmokeProbe[], unit: string, tag: string): Promise<SmokeOutcome> {
    const done: string[] = [];
    for (const p of probes) {
      const failed = await this.probe(p, tag);
      if (failed) return { ok: false, probe: `${unit}:${p.id}`, reason: failed, probes: done };
      done.push(`${unit}:${p.id}`);
    }
    return { ok: true, probes: done };
  }

  afterService(unit: string, service: string, tag: string): Promise<SmokeOutcome> {
    const t = SMOKE_TABLE[unit];
    if (!t) return Promise.resolve({ ok: false, probe: `${unit}:*`, reason: "smoke_table_missing", probes: [] });
    return this.run(t.probes.filter((p) => p.after === "service" && p.service === service), unit, tag);
  }

  afterUnit(unit: string, tag: string): Promise<SmokeOutcome> {
    const t = SMOKE_TABLE[unit];
    if (!t) return Promise.resolve({ ok: false, probe: `${unit}:*`, reason: "smoke_table_missing", probes: [] });
    return this.run(t.probes.filter((p) => p.after === "unit"), unit, tag);
  }
}
