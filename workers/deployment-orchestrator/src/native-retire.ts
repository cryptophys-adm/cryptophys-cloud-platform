// ADR-0012 G6 gate 10 (docs/GITHUB-CUTOVER.md): retire a Worker without GitHub. The Orchestrator does what
// retire-worker.yml does, through the Cloudflare API with its own CF_DEPLOY_TOKEN:
//   1. only a Worker in RETIRABLE (owner decisions, the same list as the workflow's), disabled in the registry,
//      with no deploy unit, after a consensus proposal with the owner's approval click;
//   2. fails closed unless the Worker is fully retired in source: the Forge's bundles for main's head (the
//      Forge's own record, ADR-0012 G2a) build no Worker of that name, no stored wrangler.toml names it or still
//      declares a custom domain it detaches, and no deploy is pending, so the live Workers are main's;
//   3. reads every custom domain to detach and checks it is on the expected Worker before detaching any;
//   4. detaches them and verifies each hostname has none left;
//   5. deletes its Cloudflare Workflow (if any), then the script, never with `force`: Cloudflare refuses to
//      delete a script another Worker still binds to;
//   6. verifies both are gone. D1 data is never touched.
// Steps 1–3 only read. A refusal there changes nothing; the run records `changed: false`. Deleting is
// irreversible: the Worker's code stays in the Forge's bundles and in git, and the owner's rollback is the
// workflow's (revert, registry back to registered, redeploy).

import { readConfig, readManifest, type BundleReader } from "./native-deploy.ts";
import { sleep } from "./native-rollback.ts";

export const NATIVE_RETIRE_EXECUTOR = "native:retire";
const API = "https://api.cloudflare.com/client/v4";
export const RETIRE_VERIFY_ATTEMPTS = 5;
export const RETIRE_VERIFY_DELAY_MS = 3000;

export interface RetirableWorker {
  /** Its Cloudflare Workflow, deleted before the script; null when it has none. */
  workflow: string | null;
  /** Custom domains detached before the script is deleted: each hostname and the Worker it must be on. */
  detach: ReadonlyArray<{ host: string; worker: string }>;
}

/**
 * The owner's retirement decisions. The same list as RETIRABLE in .github/workflows/retire-worker.yml (a test
 * keeps the two equal). cryptophys-console is never deleted here: only its old custom domain is detached.
 */
export const RETIRABLE: Readonly<Record<string, RetirableWorker>> = {
  // Owner decision 2026-11-05 (TP-018).
  "cryptophys-signal-engine": { workflow: "cryptophys-signal-ingest", detach: [] },
  // Owner decision 2026-11-13 (ADR-0010 amendment): "setuju pension domain lama".
  "cryptophys-home": {
    workflow: null,
    detach: [
      { host: "home.cryptophys.work", worker: "cryptophys-home" },
      { host: "console.cryptophys.work", worker: "cryptophys-console" },
    ],
  },
};

const WORKER = /^cryptophys-[a-z0-9][a-z0-9-]{1,60}$/;
const HOST = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const RECORD_ID = /^[A-Za-z0-9-]{1,64}$/;
const ok2xx = (s: number) => s >= 200 && s < 300;

/** The Cloudflare calls a retirement makes. Every method returns the HTTP status; nothing here throws on a status. */
export class CloudflareRetire {
  private readonly token: string;
  private readonly account: string;
  private readonly fetcher: typeof fetch;
  constructor(token: string, account: string, fetcher: typeof fetch = fetch) {
    this.token = token;
    this.account = account;
    // Called as a plain function (see CloudflareWorkers): workerd throws "Illegal invocation" otherwise.
    this.fetcher = (input, init) => fetcher(input, init);
  }

  private async call(method: "GET" | "DELETE", path: string): Promise<{ status: number; body: { success?: boolean; result?: unknown } | null }> {
    const res = await this.fetcher(`${API}/accounts/${this.account}/${path}`, { method, headers: { authorization: `Bearer ${this.token}` } });
    const body = await res.json().catch(() => null) as { success?: boolean; result?: unknown } | null;
    return { status: res.status, body };
  }

  /** The custom domains on exactly this hostname: `{ id, service }` each. Throws when the list cannot be read. */
  async domains(host: string): Promise<Array<{ id: string; service: string }>> {
    if (!HOST.test(host)) throw new Error("invalid_hostname");
    const r = await this.call("GET", `workers/domains?hostname=${encodeURIComponent(host)}`);
    if (r.status !== 200 || r.body?.success !== true || !Array.isArray(r.body.result)) throw new Error(`domains_unreadable_${r.status}`);
    const out: Array<{ id: string; service: string }> = [];
    for (const d of r.body.result as Array<{ id?: unknown; hostname?: unknown; service?: unknown }>) {
      if (d?.hostname !== host) continue;
      if (typeof d.id !== "string" || !RECORD_ID.test(d.id) || typeof d.service !== "string") throw new Error("domains_unreadable_record");
      out.push({ id: d.id, service: d.service });
    }
    return out;
  }

  async detach(id: string): Promise<number> {
    if (!RECORD_ID.test(id)) throw new Error("invalid_domain_id");
    return (await this.call("DELETE", `workers/domains/${id}`)).status;
  }

  async workflowStatus(name: string): Promise<number> { return (await this.call("GET", `workflows/${name}`)).status; }
  async deleteWorkflow(name: string): Promise<number> { return (await this.call("DELETE", `workflows/${name}`)).status; }
  async scriptStatus(name: string): Promise<number> { return (await this.call("GET", `workers/scripts/${name}/settings`)).status; }
  /** Never with `force`: Cloudflare then refuses while another Worker binds to the script. */
  async deleteScript(name: string): Promise<number> { return (await this.call("DELETE", `workers/scripts/${name}`)).status; }
}

export type RetirePlan =
  | { ok: true; worker: string; main_sha: string; workflow: string | null; workflow_present: boolean; script_present: boolean; domains: Array<{ host: string; worker: string; ids: string[] }> }
  | { ok: false; reason: string; detail?: string };

/** Refusals that only mean CF_DEPLOY_TOKEN may not read something: the workflow path, with its own tokens, may. */
export const isPermissionRefusal = (reason: string) => /_(401|403)$/.test(reason);

/** The patterns a wrangler.toml declares a custom domain with (`pattern = "<host>"`, also inside JSON configs). */
const declares = (toml: string, host: string) => new RegExp(`pattern"?\\s*[:=]\\s*"${host.replace(/\./g, "\\.")}"`).test(toml);

/**
 * Read-only: everything a retirement checks before it changes anything. `pending` is the Forge's pending deploy
 * units for `mainSha` (forge-gate's `forgePendingDeploys`); a pending unit means a live Worker may still run
 * a config other than main's. Never throws: a failure to read is a refusal.
 */
export async function planRetire(
  cf: Pick<CloudflareRetire, "domains" | "workflowStatus" | "scriptStatus">, bundles: BundleReader,
  head: { sha: string | null; ready: boolean; pending: string[] }, worker: string,
): Promise<RetirePlan> {
  try {
    if (!WORKER.test(worker) || !Object.hasOwn(RETIRABLE, worker)) return { ok: false, reason: "not_retirable" };
    const entry = RETIRABLE[worker];
    if (!head.sha) return { ok: false, reason: "forge_main_unknown" };
    if (!head.ready) return { ok: false, reason: "forge_checks_not_ready" };
    if (head.pending.length) return { ok: false, reason: "deploys_pending", detail: head.pending.join(",").slice(0, 200) };
    const manifest = await readManifest(bundles, head.sha);
    if (!manifest) return { ok: false, reason: "forge_bundles_missing" };
    // The workflow's "fail closed unless the Worker is fully retired in source", from the Forge's own record.
    if (manifest.workers.some((w) => w.name === worker)) return { ok: false, reason: "source_still_on_main" };
    for (const w of manifest.workers) {
      const cfg = await readConfig(bundles, head.sha, w);
      if ("reason" in cfg) return { ok: false, reason: cfg.reason, detail: w.name };
      if (cfg.toml.includes(`"${worker}"`)) return { ok: false, reason: "still_bound_on_main", detail: w.name };
      for (const d of entry.detach) {
        if (declares(cfg.toml, d.host)) return { ok: false, reason: "domain_still_declared_on_main", detail: `${d.host} in ${w.name}` };
      }
    }
    // Every hostname is read and checked before any is detached, so a surprise leaves nothing half done.
    const domains: Array<{ host: string; worker: string; ids: string[] }> = [];
    for (const d of entry.detach) {
      const found = await cf.domains(d.host);
      const other = found.find((x) => x.service !== d.worker);
      if (other) return { ok: false, reason: "domain_on_unexpected_worker", detail: `${d.host} is on ${other.service.slice(0, 63)}` };
      domains.push({ host: d.host, worker: d.worker, ids: found.map((x) => x.id) });
    }
    let workflowPresent = false;
    if (entry.workflow) {
      const s = await cf.workflowStatus(entry.workflow);
      if (s !== 200 && s !== 404) return { ok: false, reason: `workflow_unreadable_${s}` };
      workflowPresent = s === 200;
    }
    const s = await cf.scriptStatus(worker);
    if (s !== 200 && s !== 404) return { ok: false, reason: `script_unreadable_${s}` };
    return { ok: true, worker, main_sha: head.sha, workflow: entry.workflow, workflow_present: workflowPresent, script_present: s === 200, domains };
  } catch (err) {
    return { ok: false, reason: String((err as Error)?.message ?? err).slice(0, 120) };
  }
}

export interface RetireRun {
  ok: boolean;
  reason?: string;
  /** Whether anything was detached or deleted before the outcome: a failure with `changed` needs a person. */
  changed: boolean;
  steps: string[];
}

/** Execute a plan from `planRetire` (made right before). Never throws. */
export async function executeRetire(cf: CloudflareRetire, plan: Extract<RetirePlan, { ok: true }>, opts: { delayMs?: number } = {}): Promise<RetireRun> {
  const delay = opts.delayMs ?? RETIRE_VERIFY_DELAY_MS;
  const steps: string[] = [];
  let changed = false;
  const fail = (reason: string): RetireRun => ({ ok: false, reason, changed, steps });
  try {
    for (const d of plan.domains) {
      for (const id of d.ids) {
        const s = await cf.detach(id);
        // 404: already gone between the read and the delete; the check below confirms it.
        if (!ok2xx(s) && s !== 404) return fail(`domain_detach_${s}: ${d.host}`);
        changed = true;
      }
      let left = -1;
      for (let i = 0; i < RETIRE_VERIFY_ATTEMPTS; i++) {
        left = (await cf.domains(d.host)).length;
        if (left === 0) break;
        if (i < RETIRE_VERIFY_ATTEMPTS - 1) await sleep(delay);
      }
      if (left !== 0) return fail(`domain_still_attached: ${d.host}`);
      steps.push(`detached ${d.host}`);
    }
    if (plan.workflow && plan.workflow_present) {
      const s = await cf.deleteWorkflow(plan.workflow);
      if (!ok2xx(s)) return fail(`workflow_delete_${s}`);
      changed = true;
      steps.push(`deleted workflow ${plan.workflow}`);
    }
    if (plan.script_present) {
      const s = await cf.deleteScript(plan.worker);
      if (!ok2xx(s)) return fail(`script_delete_${s}`);
      changed = true;
      steps.push(`deleted ${plan.worker}`);
    }
    let status = 0;
    for (let i = 0; i < RETIRE_VERIFY_ATTEMPTS; i++) {
      status = await cf.scriptStatus(plan.worker);
      if (status === 404) break;
      if (i < RETIRE_VERIFY_ATTEMPTS - 1) await sleep(delay);
    }
    if (status !== 404) return fail(`script_still_present_${status}`);
    if (plan.workflow) {
      const w = await cf.workflowStatus(plan.workflow);
      if (w !== 404) return fail(`workflow_still_present_${w}`);
    }
    steps.push("verified absent");
    return { ok: true, changed, steps };
  } catch (err) {
    return fail(String((err as Error)?.message ?? err).slice(0, 120));
  }
}
