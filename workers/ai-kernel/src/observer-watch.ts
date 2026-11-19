/**
 * The Supervisor's use of the account-wide Observer (owner 2026-11-14: production, no shadow phase).
 *
 * Each cycle reads the Observer's findings (observer_findings, written hourly by the Platform API):
 *  - an error or exception spike of a platform Worker right after its most recent deploy becomes one
 *    rollback_worker_version proposal through normal consensus, with the evidence in its params, only when
 *    rollbackGate() (control-plane-shared/src/observer.ts) lets it: >= 3 days of baseline, the absolute minimums and
 *    z, the 2 h post-deploy window of the Worker's most recent deploy, one proposal per target per 6 h, and the brake
 *    (open critical reports, unreadable counts as open). The Supervisor's consensus.propose rate window, every
 *    voter's baseline and the Policy Engine still decide after that; nothing here bypasses them. At most one per cycle,
 *    scheduled cycles only;
 *  - trading Workers, Aether, the AI Kernel itself and Workers without a platform deploy unit are reported only;
 *  - load spikes, CPU early warnings, inventory differences and missing capabilities are reported as cycle findings
 *    (advisory), once each (a cursor in the agent's memory).
 */
import type { JsonObject } from "../../control-plane-shared/src/http.ts";
import { latestDeploy, readFindings, rollbackGate, THRESHOLDS, type StoredFinding } from "../../control-plane-shared/src/observer.ts";
import { openCriticalReportRows } from "./owner-inbox.ts";
import type { CycleReport, KernelEnv, Memory } from "./supervisor.ts";
import type { SyscallResult } from "./syscall.ts";

export const OBSERVER_CURSOR = "observer_cursor";
/** Findings older than this are not looked at again (the proposal deadline is 3 h after a deploy). */
const LOOKBACK_MS = THRESHOLDS.PROPOSAL_DEADLINE_MS + 3_600_000;

const tableMissing = (err: unknown) => /no such table:\s*observer_/i.test(String((err as Error)?.message ?? err));

export async function observerCycle(
  env: KernelEnv, memory: Memory, report: CycleReport, trigger: "scheduled" | "operator",
  proposeConsensus: (input: JsonObject) => Promise<SyscallResult | null>, now = Date.now(),
): Promise<void> {
  let recent: StoredFinding[];
  try {
    recent = await readFindings(env.DB, new Date(now - LOOKBACK_MS).toISOString(), "1 = 1", [], 50);
  } catch (err) {
    // Before migration 0063 the Observer has nothing to say; any other read error is a finding, never a proposal.
    if (!tableMissing(err)) report.findings.push({ kind: "observer", action: "none", why: `observer findings unavailable: ${String((err as Error)?.message ?? err).slice(0, 120)}` });
    return;
  }
  const cursor = (await memory.get<string>(OBSERVER_CURSOR)) ?? "";
  const fresh = recent.filter((f) => f.created_at > cursor);
  for (const f of fresh.slice(0, 10)) {
    if (f.metric === "error_rate" || f.metric === "exception_rate") continue; // reported with the gate's verdict below
    report.findings.push({ kind: "observer", service_id: f.worker, metric: f.metric, action: "none", advisory: true, why: f.detail.slice(0, 300) });
  }
  if (recent.length) await memory.put(OBSERVER_CURSOR, recent.reduce((m, f) => (f.created_at > m ? f.created_at : m), cursor));

  // Newest first; within one hour an error-rate spike before the exception-rate spike of the same Worker.
  const spikes = recent.filter((f) => f.kind === "anomaly" && (f.metric === "error_rate" || f.metric === "exception_rate"))
    .sort((a, b) => b.bucket.localeCompare(a.bucket) || (a.metric === b.metric ? 0 : a.metric === "error_rate" ? -1 : 1));
  let proposed = false;
  for (const f of spikes) {
    const isNew = f.created_at > cursor;
    // A spike already judged in an earlier cycle is looked at again only while it could still lead to a proposal.
    if (!isNew && (proposed || trigger !== "scheduled")) continue;
    const deploy = await latestDeploy(env.DB, f.worker);
    const reg = await env.DB.prepare("SELECT desired_version FROM service_registry WHERE service_id = ?").bind(f.worker).first<{ desired_version: string | null }>();
    const recentRollback = await env.DB.prepare("SELECT 1 AS x FROM consensus_proposals WHERE action = 'rollback_worker_version' AND target = ? AND created_at >= ? LIMIT 1")
      .bind(f.worker, new Date(now - THRESHOLDS.ROLLBACK_COOLDOWN_MS).toISOString()).first();
    let brakeOpen = true;
    try { brakeOpen = (await openCriticalReportRows(env.DB, now, 1)).length > 0; } catch { brakeOpen = true; }
    const gate = rollbackGate({ finding: f, deploy, desired_version: reg?.desired_version ?? null, recent_rollback_proposal: Boolean(recentRollback), brake_open: brakeOpen, now });
    if (!gate.propose) {
      if (isNew) report.findings.push({ kind: "observer", service_id: f.worker, metric: f.metric, action: "none", report_only: gate.report_only, why: `${f.detail.slice(0, 180)}; no rollback: ${gate.reason}`.slice(0, 300) });
      continue;
    }
    if (proposed || trigger !== "scheduled") {
      report.findings.push({ kind: "observer", service_id: f.worker, metric: f.metric, action: "none", why: trigger !== "scheduled" ? "rollback proposals run in scheduled cycles only" : "one rollback proposal per cycle; the next cycle looks again" });
      continue;
    }
    const r = await proposeConsensus({
      action: "rollback_worker_version", target: f.worker,
      params: { version: gate.version, reason: `observer: ${f.metric} spike after deploy ${deploy?.version ?? "?"}`.slice(0, 200), evidence: gate.evidence as JsonObject, finding_id: f.finding_id },
    });
    if (!r) break; // the consensus.propose window is full (recorded once by the caller)
    proposed = true;
    report.actions.push(r);
    report.findings.push({ kind: "observer", service_id: f.worker, metric: f.metric, action: "consensus.propose", outcome: r.outcome, why: `rollback_worker_version to ${gate.version}: ${f.detail.slice(0, 200)}`.slice(0, 300) });
  }
}
