/**
 * Classification of policy denials for the Platform Auditor (owner 2026-11-14, "setuju dan kerjakan").
 *
 * Measured in production on 2026-11-14 (24 h): almost every denial was a guard working as designed:
 * the Supervisor's consensus.propose refused by rate_limit (19), the Auditor's and the Signal Analyst's
 * memory.remember (9 + 4) and the Aether curator's knowledge.propose (1) refused by power_mode_survival
 * (weekend survival mode), the CI token's deploy of platform-api refused by ci_green (4), and one
 * merge_change refused by consensus_passed. The Auditor nevertheless warned of "an increase in denied
 * system calls" and its digest told the owner to review the Supervisor's instructions.
 *
 * A denial is EXPECTED when every check it failed is in EXPECTED_DENIAL_CHECKS (the exact check ids
 * of the Policy Engine and of capabilities.ts agentSyscallChecks). Any other failed check is
 * UNEXPECTED: a capability, grant, tier or scope violation, a prohibited action, not_human_only,
 * an unknown capability, or a reason code that is in neither list (a new code is unexpected).
 *
 * Warning rule (the Auditor's only denial-driven warning):
 *  - baseline_daily_unexpected = unexpected denials in the 7 days before the last 24 h, divided by 7;
 *  - "above_baseline": unexpected_24h > 0 and unexpected_24h >= UNEXPECTED_WARNING_RATIO x baseline
 *    (so with a zero baseline any unexpected denial warns);
 *  - "new_reason": an unexpected reason code seen in the last 24 h that did not occur in the baseline
 *    window warns whatever the totals;
 *  - expected denials never warn, however many there are.
 *
 * Learning blocked (owner 2026-11-14, "learning is core"): a denial of memory.remember or knowledge.propose is never an
 * expected guard outcome, whatever check refused it. From 2026-11-12 survival mode refused them every day and the
 * Auditor counted that as a brake working as designed, while no knowledge proposal was written for three days. Such a
 * denial is counted on its own (learning_blocked_24h, by capability, subject and reason) and warns whenever it is > 0
 * in the last 24 hours. A learning denial that also failed an unexpected check is counted as unexpected as well; one
 * that failed only expected checks is no longer counted as expected. The rest of the classification is unchanged.
 *
 * Learning mandate (owner 2026-11-14, "learning tidak boleh dibatasi siapa pun, itu adalah mandat tertinggi"): learning
 * has no rate limit, no daily cap and no power-mode denial any more, so neither rate_limit nor power_mode_survival can
 * refuse it. rate_limit and power_mode_survival stay expected guards for every other capability; any denial of a
 * learning capability that still occurs (a revoked grant, the kill switch, a regression) is a real problem and warns.
 */
import { LEARNING_CAPABILITIES, isLearningCapability } from "../../control-plane-shared/src/power-mode.ts";

/** Guard outcomes that mean the platform's brakes worked: counted and shown, never a warning. */
export const EXPECTED_DENIAL_CHECKS: readonly string[] = ["power_mode_survival", "rate_limit", "ci_green", "consensus_passed"];

/** Days in the baseline window before the last 24 hours. */
export const DENIAL_BASELINE_DAYS = 7;
/** An unexpected count at least this many times the baseline daily average warns. */
export const UNEXPECTED_WARNING_RATIO = 2;

const EXPECTED = new Set(EXPECTED_DENIAL_CHECKS);

/** Plain words for the expected guards (operator text has no codes). */
export const EXPECTED_DENIAL_TEXT: Record<string, string> = {
  power_mode_survival: "survival mode throttle",
  rate_limit: "hourly rate limit",
  ci_green: "CI not green",
  consensus_passed: "vote did not pass",
};

/** "failed: rate_limit, power_mode_survival" -> ["rate_limit", "power_mode_survival"]; any other text is one code. */
export function denialReasonCodes(reason: string | null | undefined): string[] {
  const r = String(reason ?? "").trim();
  if (!r) return ["unknown"];
  const failed = /^failed:\s*(.*)$/i.exec(r);
  const codes = (failed ? failed[1] : r).split(/[,;]\s*/).map((c) => c.trim()).filter(Boolean);
  return codes.length ? codes : ["unknown"];
}

export const isExpectedCode = (code: string): boolean => EXPECTED.has(code);

/** A denial is expected only when every failed check is an expected guard. */
export function isExpectedDenial(reason: string | null | undefined): boolean {
  return denialReasonCodes(reason).every(isExpectedCode);
}

/**
 * One aggregated row of policy_decisions (decision = 'deny'); recent = 1 for the last 24 h, 0 for the baseline window.
 * learning_capability is the capability of an agent.syscall denial of a learning capability, otherwise null or absent.
 */
export interface DenialRow { subject: string; action: string; reason: string | null; recent: number; count: number; learning_capability?: string | null }
/** One aggregated row of agent_actions (outcome denied or failed) in the last 24 h; reason and learning capability only for denied. */
export interface AgentOutcomeRow { agent_id: string; outcome: string; reason: string | null; count: number; learning_capability?: string | null }

export interface DenialReasonMetric { reason: string; expected: boolean; count_24h: number; baseline_daily: number; delta_vs_baseline: number }
export interface DenialSubjectMetric { subject: string; expected_24h: number; unexpected_24h: number }
export interface AgentDenialMetric { agent_id: string; denied: number; denied_expected: number; denied_learning: number; denied_unexpected: number; failed: number }
/** Denials of a learning capability (memory.remember, knowledge.propose): never expected, a warning when > 0 in 24 h. */
export interface LearningBlockedMetric {
  capabilities: string[];
  count_24h: number;
  baseline_daily: number;
  by_capability: Array<{ capability: string; count_24h: number }>;
  by_subject: Array<{ subject: string; count_24h: number }>;
  by_reason: Array<{ reason: string; count_24h: number }>;
}

export interface DenialMetrics {
  expected_reasons: string[];
  baseline_days: number;
  warning_ratio: number;
  total_24h: number;
  expected_24h: number;
  unexpected_24h: number;
  baseline_daily_expected: number;
  baseline_daily_unexpected: number;
  delta_expected_vs_baseline: number;
  delta_unexpected_vs_baseline: number;
  by_reason: DenialReasonMetric[];
  by_subject: DenialSubjectMetric[];
  by_agent: AgentDenialMetric[];
  new_unexpected_reasons: string[];
  /** Denials of learning capabilities in the last 24 h (owner 2026-11-14); also in learning_blocked.count_24h. */
  learning_blocked_24h: number;
  learning_blocked: LearningBlockedMetric;
  verdict: "none" | "expected_only" | "within_baseline" | "learning_blocked" | "above_baseline" | "new_reason";
  /** Unexpected denials warn: above the baseline or a new reason code. */
  unexpected_warn: boolean;
  /** Learning blocked warns whenever it is > 0 in 24 h. */
  learning_warn: boolean;
  /** The Auditor warns: unexpected_warn or learning_warn. */
  warn: boolean;
  /** Deterministic metric interpretations (one line each), shown in the report and used by the template. */
  interpretation: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const learningOf = (capability: string | null | undefined): string | null =>
  typeof capability === "string" && isLearningCapability(capability) ? capability : null;

export function classifyDenials(rows: DenialRow[], agentRows: AgentOutcomeRow[] = []): DenialMetrics {
  let expected24 = 0, unexpected24 = 0, expectedBase = 0, unexpectedBase = 0;
  let learning24 = 0, learningOnly24 = 0, learningBase = 0;
  const reasons = new Map<string, { recent: number; base: number }>();
  const subjects = new Map<string, DenialSubjectMetric>();
  const learnCaps = new Map<string, number>(), learnSubjects = new Map<string, number>(), learnReasons = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);
  for (const r of rows) {
    const n = Number(r.count) || 0;
    if (n <= 0) continue;
    const codes = [...new Set(denialReasonCodes(r.reason))];
    const learning = r.action === "agent.syscall" ? learningOf(r.learning_capability) : null;
    // A learning denial is never an expected guard outcome (owner 2026-11-14); unexpected codes stay unexpected.
    const guardsOnly = codes.every(isExpectedCode);
    const expected = guardsOnly && !learning;
    const recent = Number(r.recent) === 1;
    if (learning) {
      if (recent) {
        learning24 += n;
        if (guardsOnly) learningOnly24 += n;
        bump(learnCaps, learning, n);
        bump(learnSubjects, r.subject, n);
        for (const c of codes) bump(learnReasons, c, n);
      } else learningBase += n;
      // A learning denial refused only by guards is counted in learning_blocked alone, not as expected.
      if (guardsOnly) continue;
    }
    if (recent) {
      if (expected) expected24 += n; else unexpected24 += n;
      const s = subjects.get(r.subject) ?? { subject: r.subject, expected_24h: 0, unexpected_24h: 0 };
      if (expected) s.expected_24h += n; else s.unexpected_24h += n;
      subjects.set(r.subject, s);
    } else if (expected) expectedBase += n; else unexpectedBase += n;
    for (const c of codes) {
      const m = reasons.get(c) ?? { recent: 0, base: 0 };
      if (recent) m.recent += n; else m.base += n;
      reasons.set(c, m);
    }
  }
  const byReason: DenialReasonMetric[] = [...reasons.entries()].map(([reason, m]) => {
    const baseline = round2(m.base / DENIAL_BASELINE_DAYS);
    return { reason, expected: isExpectedCode(reason), count_24h: m.recent, baseline_daily: baseline, delta_vs_baseline: round2(m.recent - baseline) };
  }).sort((a, b) => b.count_24h - a.count_24h || a.reason.localeCompare(b.reason));

  const agents = new Map<string, AgentDenialMetric>();
  for (const r of agentRows) {
    const n = Number(r.count) || 0;
    const a = agents.get(r.agent_id) ?? { agent_id: r.agent_id, denied: 0, denied_expected: 0, denied_learning: 0, denied_unexpected: 0, failed: 0 };
    if (r.outcome === "denied") {
      a.denied += n;
      const guardsOnly = isExpectedDenial(r.reason);
      if (learningOf(r.learning_capability)) a.denied_learning += n;
      if (!guardsOnly) a.denied_unexpected += n; else if (!learningOf(r.learning_capability)) a.denied_expected += n;
    } else if (r.outcome === "failed") a.failed += n;
    agents.set(r.agent_id, a);
  }

  const baseExpected = round2(expectedBase / DENIAL_BASELINE_DAYS);
  const baseUnexpected = round2(unexpectedBase / DENIAL_BASELINE_DAYS);
  const newReasons = byReason.filter((m) => !m.expected && m.count_24h > 0 && reasons.get(m.reason)!.base === 0).map((m) => m.reason);
  const aboveBaseline = unexpected24 > 0 && unexpected24 >= UNEXPECTED_WARNING_RATIO * baseUnexpected;
  const learningWarn = learning24 > 0;
  const verdict: DenialMetrics["verdict"] = newReasons.length > 0 ? "new_reason"
    : aboveBaseline ? "above_baseline"
    : learningWarn ? "learning_blocked"
    : unexpected24 > 0 ? "within_baseline"
    : expected24 > 0 ? "expected_only" : "none";
  const unexpectedWarn = newReasons.length > 0 || aboveBaseline;
  const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const label = (code: string) => EXPECTED_DENIAL_TEXT[code] ?? code.replace(/[_:]+/g, " ");
  const expectedParts = byReason.filter((m) => m.expected && m.count_24h > 0).map((m) => `${label(m.reason)} ${m.count_24h}`);
  const unexpectedParts = byReason.filter((m) => !m.expected && m.count_24h > 0).map((m) => `${label(m.reason)} ${m.count_24h}`);
  const signed = (n: number) => (n >= 0 ? `+${n}` : String(n));
  const interpretation = [
    `Expected guard outcomes: ${expected24} in 24 h (7-day baseline ${baseExpected}/day, ${signed(round2(expected24 - baseExpected))})${expectedParts.length ? `: ${expectedParts.join(", ")}` : ""}. Guards working as designed; no action.`,
    `Unexpected refusals: ${unexpected24} in 24 h (7-day baseline ${baseUnexpected}/day, ${signed(round2(unexpected24 - baseUnexpected))})${unexpectedParts.length ? `: ${unexpectedParts.join(", ")}` : ""}.` +
      (verdict === "new_reason" ? ` New reason not seen in the previous 7 days: ${newReasons.map(label).join(", ")}. Warning.`
        : verdict === "above_baseline" ? ` At least ${UNEXPECTED_WARNING_RATIO}x the baseline. Warning.`
        : unexpected24 > 0 ? ` Below ${UNEXPECTED_WARNING_RATIO}x the baseline; no warning.` : " Nothing to review."),
    `Learning blocked (memory or knowledge proposals refused): ${learning24} in 24 h` +
      (learningWarn ? `: ${sorted(learnCaps).map(([c, k]) => `${c === "memory.remember" ? "memory" : "knowledge proposals"} ${k}`).join(", ")}. Learning is core. Warning.` : "."),
  ].map((s) => s.slice(0, 200));

  return {
    expected_reasons: [...EXPECTED_DENIAL_CHECKS],
    baseline_days: DENIAL_BASELINE_DAYS,
    warning_ratio: UNEXPECTED_WARNING_RATIO,
    total_24h: expected24 + unexpected24 + learningOnly24,
    expected_24h: expected24,
    unexpected_24h: unexpected24,
    baseline_daily_expected: baseExpected,
    baseline_daily_unexpected: baseUnexpected,
    delta_expected_vs_baseline: round2(expected24 - baseExpected),
    delta_unexpected_vs_baseline: round2(unexpected24 - baseUnexpected),
    by_reason: byReason,
    by_subject: [...subjects.values()].sort((a, b) => (b.unexpected_24h + b.expected_24h) - (a.unexpected_24h + a.expected_24h) || a.subject.localeCompare(b.subject)),
    by_agent: [...agents.values()].sort((a, b) => a.agent_id.localeCompare(b.agent_id)),
    new_unexpected_reasons: newReasons,
    learning_blocked_24h: learning24,
    learning_blocked: {
      capabilities: [...LEARNING_CAPABILITIES],
      count_24h: learning24,
      baseline_daily: round2(learningBase / DENIAL_BASELINE_DAYS),
      by_capability: sorted(learnCaps).map(([capability, count_24h]) => ({ capability, count_24h })),
      by_subject: sorted(learnSubjects).map(([subject, count_24h]) => ({ subject, count_24h })),
      by_reason: sorted(learnReasons).map(([reason, count_24h]) => ({ reason, count_24h })),
    },
    verdict,
    unexpected_warn: unexpectedWarn,
    learning_warn: learningWarn,
    warn: unexpectedWarn || learningWarn,
    interpretation,
  };
}
