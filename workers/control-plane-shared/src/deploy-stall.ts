// The deploy stall alarm (owner 2026-11-14, after the incident of that day: from about 15:00 UTC main kept moving and
// its Forge checks were green, but no deploy ran for over 6 hours; the Forge's plan listed no unit
// (forge_units "[]", forge_skipped control-plane compare_failed_or_diverged and new_migration_control_plane_unavailable),
// and nothing told the owner).
//
// The platform is stalled when, all from D1:
//   - main's head (the newest commit the Forge planned) passed the Forge's checks (forgeReady, the deploy gate);
//   - at least one deploy unit does not run it (a service's desired_version is not the head's tag);
//   - the deploy loop has something to do or is held: the plan for the head (forgePendingDeploys, what the Supervisor
//     reads) lists a unit or a skip. A plan with neither means every unit behind is unchanged since its version (a
//     README commit), so nothing is due; a disabled or unregistered unit's skip is a decision, not a fault;
//   - no deploy_commit has executed for more than STALL_AFTER_MS, counted from the later of the last executed
//     deploy_commit and the first plan with work for a newer commit, so a commit on a quiet morning does not alarm
//     before the loop has had its 2 hours.
//
// The alarm is a WARNING report, never critical: an open critical report is the consensus brake (consensus-rules.ts
// baseline(): every voter rejects every routine action), so a critical stall alarm would block the deploy_commit and the
// merge_change that end the stall until the owner acknowledged it. The owner is reached instead through the owner
// notice production_unhandled (ai-kernel owner-inbox.ts, code deploys_stalled), which goes to Telegram.
//
// One alarm per stall episode: its alert_key is deploy_stall:<the last executed deploy_commit's proposal id, or none>.
// It stays open until a deploy_commit executes (the key changes) or no unit is behind and nothing is due; a head whose
// checks are still running does not close it. The report uses the alert_key / state convention that the kernel's
// reports overview already reads (ai-kernel syscall.ts resolvedLaterSql): a later "Resolved:" report with the same key
// closes it.
import type { D1Database } from "./types.ts";
import { DEPLOY_UNITS, type Skip } from "./deploy-units.ts";
import { forgePendingDeploys } from "./forge-gate.ts";

export const STALL_AFTER_MS = 2 * 3_600_000;
export const STALL_ALERT_PREFIX = "deploy_stall:";
/** The agent that publishes the alarm: the Platform API's, whose Observer runs it (reports.publish, tier 1). */
export const STALL_AGENT = "platform-api";
/** Open alarms are looked for this far back (an alarm stays open until its episode ends). */
export const STALL_LOOKBACK_MS = 30 * 86_400_000;
/** Skips that are a decision, not a fault: a unit whose Workers are disabled or unregistered is not waiting. */
export const NOT_WAITING_SKIPS: ReadonlySet<string> = new Set(["not_registered_or_disabled"]);

export type StallReason =
  | "stalled" | "forge_unavailable" | "main_unknown" | "main_not_green" | "units_current" | "nothing_due" | "waiting";
/** Verdicts that end an open alarm of the same episode. Every other one keeps it open (a red head is not a deploy). */
export const STALL_CLEARED: ReadonlySet<StallReason> = new Set(["units_current", "nothing_due"]);

export interface LastDeploy { proposal_id: string; target: string; unit: string | null; commit_sha: string | null; executed_at: string }
export interface UnitBehind { unit: string; runs: string[] }
export interface StallVerdict {
  schema: "deploy-stall.v1";
  stalled: boolean;
  reason: StallReason;
  /** deploy_stall:<last executed deploy_commit proposal id | none>; null when the deploy history is unreadable. */
  alert_key: string | null;
  main_sha: string | null;
  main_ready: boolean;
  /** What the Supervisor's deploy loop sees for the head: the planned units and every skip with its reason. */
  pending: { units: string[]; skipped: Skip[] };
  /** The newest plan the Forge recorded for the head, as stored (forge_deploy_plans). */
  plan: { at: string; units: string[]; skipped: Skip[] } | null;
  last_deploy: LastDeploy | null;
  last_deploy_age_min: number | null;
  stall_since: string | null;
  stalled_for_min: number | null;
  threshold_min: number;
  units_behind: UnitBehind[];
}
export interface OpenStallAlarm { report_id: string; alert_key: string; created_at: string; subject: string }

const iso = (ms: number) => new Date(ms).toISOString();
const minutes = (ms: number) => Math.floor(ms / 60_000);
const list = (v: string | null): unknown[] => { try { const a = JSON.parse(v ?? "[]"); return Array.isArray(a) ? a : []; } catch { return []; } };
const skips = (v: string | null): Skip[] => list(v).flatMap((s) => {
  const o = s as { unit?: unknown; reason?: unknown };
  return typeof o?.unit === "string" && typeof o?.reason === "string" ? [{ unit: o.unit.slice(0, 60), reason: o.reason.slice(0, 120) }] : [];
});

async function lastExecutedDeploy(db: D1Database): Promise<LastDeploy | null> {
  const r = await db.prepare(
    `SELECT proposal_id, target, json_extract(params_json, '$.unit') AS unit, json_extract(params_json, '$.commit_sha') AS commit_sha, decided_at
     FROM consensus_proposals WHERE action = 'deploy_commit' AND status = 'executed' ORDER BY decided_at DESC, rowid DESC LIMIT 1`,
  ).first<{ proposal_id: string; target: string; unit: string | null; commit_sha: string | null; decided_at: string }>();
  return r ? { proposal_id: r.proposal_id, target: r.target, unit: r.unit ?? null, commit_sha: r.commit_sha ?? null, executed_at: r.decided_at } : null;
}

/** The deploy units whose Workers do not all run `head` (their registry desired_version is another commit's tag). */
async function unitsBehind(db: D1Database, head: string): Promise<UnitBehind[]> {
  const services = DEPLOY_UNITS.flatMap((u) => [...u.services]);
  const rows = (await db.prepare(`SELECT service_id, status, desired_version FROM service_registry WHERE service_id IN (${services.map(() => "?").join(", ")})`)
    .bind(...services).all<{ service_id: string; status: string; desired_version: string | null }>()).results ?? [];
  const byId = new Map(rows.map((r) => [r.service_id, r]));
  const out: UnitBehind[] = [];
  for (const u of DEPLOY_UNITS) {
    const rs = u.services.map((s) => byId.get(s));
    if (rs.some((r) => !r || r.status === "disabled")) continue; // not deployed by the loop at all
    const runs = [...new Set(rs.map((r) => r!.desired_version ?? "unset"))];
    if (runs.every((v) => v.length >= 7 && head.startsWith(v))) continue;
    out.push({ unit: u.unit, runs: runs.sort() });
  }
  return out;
}

/** Whether the platform's deploys are stalled now, and every fact the alarm names. Read-only. */
export async function deployStall(db: D1Database, now = Date.now()): Promise<StallVerdict> {
  const v: StallVerdict = {
    schema: "deploy-stall.v1", stalled: false, reason: "forge_unavailable", alert_key: null, main_sha: null, main_ready: false,
    pending: { units: [], skipped: [] }, plan: null, last_deploy: null, last_deploy_age_min: null, stall_since: null, stalled_for_min: null,
    threshold_min: minutes(STALL_AFTER_MS), units_behind: [],
  };
  try {
    v.last_deploy = await lastExecutedDeploy(db);
  } catch {
    return v;
  }
  v.alert_key = `${STALL_ALERT_PREFIX}${v.last_deploy?.proposal_id ?? "none"}`;
  const lastAt = v.last_deploy ? Date.parse(v.last_deploy.executed_at) : NaN;
  if (Number.isFinite(lastAt)) v.last_deploy_age_min = minutes(now - lastAt);

  const pending = await forgePendingDeploys(db, now);
  v.pending = { units: pending.units.map((u) => u.unit), skipped: pending.skipped };
  if (pending.skipped.some((s) => s.unit === "*" && s.reason === "forge_unavailable")) return v;
  if (!pending.main_sha) { v.reason = "main_unknown"; return v; }
  v.main_sha = pending.main_sha;
  try {
    const p = await db.prepare("SELECT forge_units, forge_skipped, forge_at FROM forge_deploy_plans WHERE main_sha = ? AND forge_at IS NOT NULL ORDER BY forge_at DESC LIMIT 1")
      .bind(pending.main_sha).first<{ forge_units: string | null; forge_skipped: string | null; forge_at: string }>();
    if (p) v.plan = { at: p.forge_at, units: list(p.forge_units).map((u) => String(u).slice(0, 60)), skipped: skips(p.forge_skipped) };
    v.units_behind = await unitsBehind(db, pending.main_sha);
  } catch {
    return v;
  }
  v.main_ready = pending.ci_green;
  if (!pending.ci_green) { v.reason = "main_not_green"; return v; }
  if (!v.units_behind.length) { v.reason = "units_current"; return v; }
  if (!pending.units.length && pending.skipped.every((s) => NOT_WAITING_SKIPS.has(s.reason))) { v.reason = "nothing_due"; return v; }

  // The stall's clock: the first plan with work (a unit or a skip) for a commit newer than the last deployed one,
  // recorded after that deploy; or the deploy itself, when the work left over is its own commit's.
  let firstWork: string | null = null;
  try {
    firstWork = (await db.prepare(
      `SELECT MIN(forge_at) AS at FROM forge_deploy_plans WHERE forge_at IS NOT NULL AND forge_at > ? AND main_sha <> ?
         AND (COALESCE(forge_units, '[]') <> '[]' OR COALESCE(forge_skipped, '[]') <> '[]')`,
    ).bind(v.last_deploy?.executed_at ?? "", v.last_deploy?.commit_sha ?? "").first<{ at: string | null }>())?.at ?? null;
  } catch { firstWork = null; }
  const since = Math.max(...[lastAt, Date.parse(firstWork ?? v.plan?.at ?? "")].filter(Number.isFinite));
  if (Number.isFinite(since)) { v.stall_since = iso(since); v.stalled_for_min = minutes(now - since); }
  if (Number.isFinite(since) && now - since <= STALL_AFTER_MS) { v.reason = "waiting"; return v; }
  v.stalled = true;
  v.reason = "stalled";
  return v;
}

/** Open stall alarms: warnings of STALL_AGENT with a deploy_stall: key and no later report that resolved the key. */
export async function openStallAlarms(db: D1Database, now = Date.now()): Promise<OpenStallAlarm[]> {
  const rows = (await db.prepare(
    `SELECT r.report_id, r.created_at, r.subject, json_extract(r.body_json, '$.alert_key') AS alert_key FROM agent_reports r
     WHERE r.agent_id = ? AND r.severity = 'warning' AND r.created_at >= ?
       AND substr(COALESCE(json_extract(r.body_json, '$.alert_key'), ''), 1, ?) = ?
       AND NOT EXISTS (SELECT 1 FROM agent_reports z WHERE z.agent_id = r.agent_id
         AND z.created_at >= r.created_at AND (z.created_at > r.created_at OR z.rowid > r.rowid)
         AND json_extract(z.body_json, '$.alert_key') = json_extract(r.body_json, '$.alert_key')
         AND (json_extract(z.body_json, '$.state') = 'resolved' OR z.subject LIKE 'Resolved:%'))
     ORDER BY r.created_at DESC, r.rowid DESC LIMIT 20`,
  ).bind(STALL_AGENT, iso(now - STALL_LOOKBACK_MS), STALL_ALERT_PREFIX.length, STALL_ALERT_PREFIX).all<OpenStallAlarm>()).results ?? [];
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.alert_key) && seen.add(r.alert_key));
}

export interface StallState {
  verdict: StallVerdict;
  open: OpenStallAlarm[];
  /** The alarm is up: stalled now, or an alarm of this episode is open and nothing has ended it. */
  active: boolean;
  /** The alarm to raise now (stalled, and no alarm of this episode is open yet). */
  raise: boolean;
  /** Open alarms whose episode ended: a deploy executed since (the key changed), or nothing is behind or due. */
  resolve: { alarm: OpenStallAlarm; why: string }[];
}

/** The alarm's state, shared by the Observer (which publishes) and the owner notice (which tells the owner). */
export async function stallState(db: D1Database, now = Date.now()): Promise<StallState> {
  const verdict = await deployStall(db, now);
  let open: OpenStallAlarm[] = [];
  try { open = await openStallAlarms(db, now); } catch { open = []; }
  if (verdict.alert_key === null) return { verdict, open, active: open.length > 0, raise: false, resolve: [] };
  const cleared = STALL_CLEARED.has(verdict.reason);
  const resolve = open.filter((a) => a.alert_key !== verdict.alert_key || cleared)
    .map((alarm) => ({ alarm, why: alarm.alert_key !== verdict.alert_key ? "deploy_executed" : verdict.reason }));
  const current = open.some((a) => a.alert_key === verdict.alert_key);
  return { verdict, open, active: verdict.stalled || (current && !cleared), raise: verdict.stalled && !current, resolve };
}

const hours = (min: number | null) => (min === null ? "?" : (min / 60).toFixed(1));
const short = (sha: string | null) => (sha ? sha.slice(0, 12) : "unknown");

/** The plan's skip reasons as one line ("control-plane compare_failed_or_diverged, * new_migration_..."). */
export function skipReasons(v: StallVerdict): string {
  const all = [...(v.plan?.skipped ?? []), ...v.pending.skipped];
  const seen = new Set<string>();
  const out = all.map((s) => `${s.unit} ${s.reason}`).filter((s) => !seen.has(s) && seen.add(s));
  if (!out.length && v.pending.units.length) return `planned ${v.pending.units.join(", ")}, not deployed`;
  return out.join(", ") || "no reason recorded";
}

/** One line for the Owner page and the Telegram message. */
export function stallDetail(v: StallVerdict): string {
  const last = v.last_deploy
    ? `the last deploy_commit executed ${hours(v.last_deploy_age_min)} h ago (${v.last_deploy.unit ?? v.last_deploy.target} ${short(v.last_deploy.commit_sha)})`
    : "no deploy_commit has executed yet";
  const behind = v.units_behind.map((u) => `${u.unit} (runs ${u.runs.join("/")})`).join(", ") || "none";
  return (`Deploys stalled: main ${short(v.main_sha)} ${v.main_ready ? "passed the Forge checks" : "is not green right now"}, but ${last}; `
    + `the Forge's plan: ${skipReasons(v)}; units behind: ${behind}`).slice(0, 600);
}

/** The alarm report (reports.publish input): a warning in metric form, never critical (it must not hold the brake). */
export function stallReport(v: StallVerdict): Record<string, unknown> {
  return {
    kind: "platform_digest", severity: "warning", ai_status: "not_used",
    subject: `Deploys stalled ${hours(v.stalled_for_min)} h: main ${short(v.main_sha)} green, ${v.units_behind.length} unit(s) behind; ${skipReasons(v)}`.slice(0, 200),
    body: {
      source: "deploy_stall", alert_key: v.alert_key, state: "open",
      metric: "deploy_stall_minutes", value: v.stalled_for_min, threshold: v.threshold_min,
      main_sha: v.main_sha, main_ready: v.main_ready,
      forge_skipped: (v.plan?.skipped ?? []).slice(0, 30), forge_units: (v.plan?.units ?? []).slice(0, 10), plan_at: v.plan?.at ?? null,
      pending: { units: v.pending.units.slice(0, 10), skipped: v.pending.skipped.slice(0, 30) },
      last_deploy: v.last_deploy, last_deploy_age_min: v.last_deploy_age_min, stall_since: v.stall_since,
      units_behind: v.units_behind.slice(0, 10),
    },
  };
}

/** The report that closes an alarm: info, "Resolved:", the same alert_key and state "resolved". */
export function stallResolvedReport(alarm: OpenStallAlarm, why: string, v: StallVerdict): Record<string, unknown> {
  const how = why === "deploy_executed" && v.last_deploy
    ? `deploy_commit ${v.last_deploy.unit ?? v.last_deploy.target} ${short(v.last_deploy.commit_sha)} executed at ${v.last_deploy.executed_at}`
    : why === "units_current" ? "every deploy unit runs main's head" : "nothing is due on main's head";
  return {
    kind: "platform_digest", severity: "info", ai_status: "not_used",
    subject: `Resolved: deploys stalled (${how})`.slice(0, 200),
    body: {
      source: "deploy_stall", alert_key: alarm.alert_key, state: "resolved", resolution: why, opened_report_id: alarm.report_id, opened_at: alarm.created_at,
      main_sha: v.main_sha, last_deploy: v.last_deploy, units_behind: v.units_behind.slice(0, 10),
    },
  };
}
