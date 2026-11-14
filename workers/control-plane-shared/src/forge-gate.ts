// ADR-0012 G1 (owner 2026-11-12: "ya mulai G1, lanjutkan semua"): deploy decisions read the Forge, not GitHub.
//
// The Forge records, in D1, the deploy plan of main's head (forge_deploy_plans, from the Artifacts repository)
// and the checks of every main commit (forge_check_runs: tests, bundles, secret scan, type-check and Console
// build). Parity with GitHub was reached before this switch: 78 of 78 plans and 34 of 34 checks agreed
// (targets 10 and 20). From G1 on:
//   - main's head is the newest commit the Forge planned;
//   - "CI green" is the Forge's `ready` (every gate passed, no secret, types and Console build passed);
//   - the pending deploy units are the Forge's plan for that head and the current registry fingerprint.
// Until G2 moves the deploy itself off GitHub Actions, the Orchestrator still dispatches the unit's workflow,
// which deploys only GitHub's main head, so the dispatch also checks that GitHub's main is that same commit.
import type { D1Database } from "./types.ts";
import { DEPLOY_UNITS, registryFingerprint, type PlannedUnit, type Skip } from "./deploy-units.ts";

const HEX40 = /^[0-9a-f]{40}$/;

/** The gate: a passed check with no secret, a passed type-check and a passed Console build. */
export function isReady(status: string, guard: string | null, typecheck: { status: string; console_build: "passed" | "failed" | null } | null): boolean {
  return status === "passed" && guard === "clean" && typecheck?.status === "passed" && typecheck.console_build === "passed";
}

/** The type-check step of a check run's steps JSON, as the gate reads it. */
export function typecheckOfSteps(steps: string | null): { status: string; console_build: "passed" | "failed" | null } | null {
  try {
    const t = (JSON.parse(steps ?? "null") as { typecheck?: { status?: unknown; console_build?: { status?: unknown } } } | null)?.typecheck;
    if (!t) return null;
    const cb = t.console_build?.status;
    return { status: String(t.status), console_build: cb === "passed" || cb === "failed" ? cb : null };
  } catch { return null; }
}

/** The Forge's verdict on one commit of main: ready only when every gate passed. */
export async function forgeReady(db: D1Database, sha: string): Promise<{ ready: boolean; reason: string; status: string | null }> {
  if (!HEX40.test(sha)) return { ready: false, reason: "invalid_commit_sha", status: null };
  const r = await db.prepare("SELECT status, guard_status, steps FROM forge_check_runs WHERE commit_sha = ?")
    .bind(sha).first<{ status: string; guard_status: string | null; steps: string | null }>();
  if (!r) return { ready: false, reason: "forge_checks_pending", status: null };
  const ready = isReady(r.status, r.guard_status ?? null, typecheckOfSteps(r.steps));
  return { ready, reason: ready ? "forge_ready" : r.status === "running" ? "forge_checks_pending" : "forge_checks_not_ready", status: r.status };
}

/**
 * main's head as the Forge last saw it: the newest commit it planned. The Forge records a plan only when main
 * or the registry changes, so a plan's age says nothing about freshness: a unit can wait hours for a deploy
 * slot under an unchanged plan. While the GitHub workflows deploy (until G2), the dispatch checks GitHub's main
 * equals this head, which catches a Forge that stopped mirroring; G2 adds the Forge's own freshness signal.
 */
export async function forgeMainHead(db: D1Database, _nowMs = Date.now()): Promise<{ sha: string | null; reason: string }> {
  const row = await db.prepare("SELECT main_sha FROM forge_deploy_plans WHERE forge_at IS NOT NULL ORDER BY forge_at DESC LIMIT 1")
    .first<{ main_sha: string }>();
  if (!row || !HEX40.test(row.main_sha)) return { sha: null, reason: "forge_plan_missing" };
  return { sha: row.main_sha, reason: "forge_head" };
}

export interface ForgePending {
  main_sha: string | null;
  ci_green: boolean;
  units: PlannedUnit[];
  skipped: Skip[];
}

const list = (v: string | null): unknown[] | null => { try { const a = JSON.parse(v ?? "null"); return Array.isArray(a) ? a : null; } catch { return null; } };

/**
 * The deploy units pending on main's head, decided by the Forge: its readiness for the head and its plan for
 * the head under the current registry fingerprint. Fails closed (nothing pending) on any missing evidence.
 */
export async function forgePendingDeploys(db: D1Database, nowMs = Date.now()): Promise<ForgePending> {
  try {
    return await pendingFromForge(db, nowMs);
  } catch {
    // Before the Forge's tables exist, or on a D1 error: nothing is pending.
    return { main_sha: null, ci_green: false, units: [], skipped: [{ unit: "*", reason: "forge_unavailable" }] };
  }
}

/**
 * Whether every registry input named in a stored fingerprint (`service=status-or-version`, comma-separated, as
 * registryFingerprint writes it) is unchanged now. Fails closed: a truncated, empty or unparsable fingerprint, a
 * service that no longer has a row, or any changed value is false.
 */
export async function fingerprintStillHolds(db: D1Database, stored: string): Promise<boolean> {
  if (typeof stored !== "string" || !stored || stored.length >= 2000) return false;
  const pairs = stored.split(",").map((p) => /^(cryptophys-[a-z0-9-]{1,60})=([A-Za-z0-9._-]{1,64})$/.exec(p));
  if (!pairs.length || pairs.some((m) => !m)) return false;
  const want = new Map(pairs.map((m) => [m![1], m![2]] as const));
  if (want.size !== pairs.length) return false;
  const ids = [...want.keys()];
  const rows = await db.prepare(`SELECT service_id, status, desired_version FROM service_registry WHERE service_id IN (${ids.map(() => "?").join(", ")})`)
    .bind(...ids).all<{ service_id: string; status: string; desired_version: string | null }>();
  const now = new Map((rows.results ?? []).map((r) => [r.service_id, r.status === "disabled" ? "disabled" : r.desired_version ?? "-"] as const));
  return ids.every((id) => now.get(id) === want.get(id));
}

async function pendingFromForge(db: D1Database, nowMs: number): Promise<ForgePending> {
  const out: ForgePending = { main_sha: null, ci_green: false, units: [], skipped: [] };
  const head = await forgeMainHead(db, nowMs);
  if (!head.sha) { out.skipped.push({ unit: "*", reason: head.reason }); return out; }
  out.main_sha = head.sha;
  const gate = await forgeReady(db, head.sha);
  out.ci_green = gate.ready;
  if (!gate.ready) { out.skipped.push({ unit: "*", reason: gate.reason }); return out; }
  // After the cut-over the Forge merges a change request's head, whose run is the change check. Only the run of
  // main stores the commit's bundles (G2a), and the native deploy needs them: proposing earlier sent the deploy
  // to the GitHub workflow (no_bundle; 2026-11-14 04:53, be20645). The Forge checks the head as main next tick.
  const run = await db.prepare("SELECT source FROM forge_check_runs WHERE commit_sha = ?").bind(head.sha).first<{ source: string | null }>();
  if (run?.source === "change") { out.skipped.push({ unit: "*", reason: "forge_main_check_pending" }); return out; }
  const fingerprint = await registryFingerprint(db);
  let plan = await db.prepare("SELECT forge_units, forge_skipped FROM forge_deploy_plans WHERE main_sha = ? AND fingerprint = ? AND forge_at IS NOT NULL")
    .bind(head.sha, fingerprint.slice(0, 2000)).first<{ forge_units: string | null; forge_skipped: string | null }>();
  if (!plan) {
    // 2026-11-13: a Forge and an Orchestrator built from different commits can list different deploy units (a unit
    // added or retired, as cryptophys-home in #316). Their fingerprints then never match and nothing is pending,
    // the Forge's own redeploy included. The Forge's newest plan for the head still holds when every registry input
    // it was made from is unchanged: each service it names has the same status and desired version now.
    const newest = await db.prepare("SELECT fingerprint, forge_units, forge_skipped FROM forge_deploy_plans WHERE main_sha = ? AND forge_at IS NOT NULL ORDER BY forge_at DESC LIMIT 1")
      .bind(head.sha).first<{ fingerprint: string; forge_units: string | null; forge_skipped: string | null }>();
    if (newest && await fingerprintStillHolds(db, newest.fingerprint)) plan = newest;
  }
  const names = list(plan?.forge_units ?? null);
  if (!plan || !names) { out.skipped.push({ unit: "*", reason: "forge_plan_pending" }); return out; }
  const tag = head.sha.slice(0, 12);
  for (const name of names) {
    const unit = DEPLOY_UNITS.find((u) => u.unit === name);
    if (!unit) { out.skipped.push({ unit: String(name).slice(0, 60), reason: "unknown_unit" }); continue; }
    out.units.push({ unit: unit.unit, workflow: unit.workflow, target: unit.services[0], reason: `main ${tag} changes ${unit.unit}` });
  }
  for (const s of list(plan.forge_skipped) ?? []) {
    const o = s as { unit?: unknown; reason?: unknown };
    if (typeof o?.unit === "string" && typeof o?.reason === "string") out.skipped.push({ unit: o.unit.slice(0, 60), reason: o.reason.slice(0, 120) });
  }
  return out;
}
