/**
 * The Signal Analyst agent (TP-017, ADR-0007): a faithful, deterministic reader of
 * XAUUSD advisory decisions from xauusd-ai-trading-assistant.
 */
import type { JsonObject } from "../../control-plane-shared/src/http.ts";
import { agentsEnabled, getAgent } from "../../control-plane-shared/src/capabilities.ts";
import { rememberOutcomeForAgent } from "./memory.ts";
import { syscall } from "./syscall.ts";
import type { CycleReport, KernelEnv, Memory } from "./supervisor.ts";

export const SIGNAL_ANALYST_ID = "signal-analyst";
export const DISCLAIMER = "advisory only; not an order";
export const DIGEST_INTERVAL_MS = 6 * 3_600_000;

/** Serializes overlapping invocations of this agent's Durable Object cycle, including awaits. */
export class SignalAnalystCycleQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export interface XauusdDecision {
  candle_key: string;
  candle_open_ms: number;
  decided_at: string | null;
  decision: "BUY" | "SELL" | "WAIT" | "NO_TRADE" | "UNKNOWN";
  confidence: number | null;
  entry_price: number | null;
  stop_loss: number | null;
  take_profit: number | null;
  risk_reward: number | null;
  reasoning: string;
}

export interface XauusdObservation {
  source: string;
  observed_at: string;
  available: boolean;
  stale?: boolean;
  error?: string;
  latest: XauusdDecision | null;
  recent: XauusdDecision[];
}

interface MemoryState {
  last_empty_report_at?: number;
  last_candle_key?: string;
  last_decision?: string;
  last_digest_at?: number;
  last_stale_candle_key?: string;
  last_unavailable_report_at?: number;
}

function isoMs(ms: number): string {
  return new Date(ms).toISOString();
}

function flipBuySell(prev: string | undefined, next: string): boolean {
  return (prev === "BUY" && next === "SELL") || (prev === "SELL" && next === "BUY");
}

export async function runSignalCycle(
  env: KernelEnv,
  memory: Memory,
  trigger: "scheduled" | "operator",
  now = Date.now(),
): Promise<CycleReport> {
  const report: CycleReport = { agent_id: SIGNAL_ANALYST_ID, trigger, cycle_at: new Date(now).toISOString(), findings: [], actions: [] };
  const agent = await getAgent(env.DB, SIGNAL_ANALYST_ID);
  if (!agent || agent.status !== "enabled" || !(await agentsEnabled(env.DB))) {
    report.skipped = !agent ? "agent_not_registered" : agent.status !== "enabled" ? "agent_suspended" : "agents_disabled";
    await memory.put("last_cycle", report);
    return report;
  }

  const observed = await syscall(env, SIGNAL_ANALYST_ID, "signals.observe");
  report.actions.push(observed);
  if (observed.outcome !== "succeeded") {
    await memory.put("last_cycle", report);
    return report;
  }
  const obs = observed.result as unknown as XauusdObservation;

  const mem = (await memory.get<MemoryState>("xauusd_state")) ?? {};

  // Unavailable
  if (!obs.available) {
    const err = obs.error ?? "xauusd_unreachable";
    const last = mem.last_unavailable_report_at ?? 0;
    if (now - last >= DIGEST_INTERVAL_MS) {
      const subject = `XAUUSD decisions unavailable (${err})`;
      const published = await syscall(env, SIGNAL_ANALYST_ID, "reports.publish", {
        kind: "xauusd_digest",
        severity: "warning",
        subject,
        ai_status: "deterministic",
        body: { error: err, source: obs.source, disclaimer: DISCLAIMER },
      });
      report.actions.push(published);
      if (published.outcome === "succeeded") {
        mem.last_unavailable_report_at = now;
        await memory.put("xauusd_state", mem);
      }
    }
    await memory.put("last_cycle", report);
    return report;
  }

  const latest = obs.latest;
  // Stale report
  if (obs.stale && latest) {
    if (mem.last_stale_candle_key !== latest.candle_key) {
      const minutesSinceClose = Math.round((now - (latest.candle_open_ms + 3_600_000)) / 60_000);
      const subject = `XAUUSD analysis stale: no decision since candle ${isoMs(latest.candle_open_ms)}`;
      const published = await syscall(env, SIGNAL_ANALYST_ID, "reports.publish", {
        kind: "xauusd_digest",
        severity: "warning",
        subject: subject.slice(0, 200),
        ai_status: "deterministic",
        body: {
          last_candle_key: latest.candle_key,
          last_decided_at: latest.decided_at,
          minutes_since_close: minutesSinceClose,
          source: obs.source,
          disclaimer: DISCLAIMER,
        },
      });
      report.actions.push(published);
      if (published.outcome === "succeeded") {
        mem.last_stale_candle_key = latest.candle_key;
        await memory.put("xauusd_state", mem);
      }
    }
  }
  if (obs.available && !latest) {
    const last = mem.last_empty_report_at ?? 0;
    if (now - last >= DIGEST_INTERVAL_MS) {
      const subject = "XAUUSD decisions empty";
      const published = await syscall(env, SIGNAL_ANALYST_ID, "reports.publish", {
        kind: "xauusd_digest",
        severity: "warning",
        subject,
        ai_status: "deterministic",
        body: { source: obs.source, disclaimer: DISCLAIMER },
      });
      report.actions.push(published);
      if (published.outcome === "succeeded") {
        mem.last_empty_report_at = now;
        await memory.put("xauusd_state", mem);
      }
    }
  }

  // Digest
  if (latest) {
    const candleChanged = latest.candle_key !== mem.last_candle_key;
    const decisionChanged = latest.decision !== mem.last_decision;
    const sixHoursPassed = !mem.last_digest_at || now - mem.last_digest_at >= DIGEST_INTERVAL_MS;
    const shouldPublish = (candleChanged && decisionChanged) || sixHoursPassed;

    if (shouldPublish) {
      const flip = flipBuySell(mem.last_decision, latest.decision);
      const severity: "info" | "warning" = flip ? "warning" : "info";
      const confStr = latest.confidence === null ? "n/a" : latest.confidence;
      const subject = `XAUUSD H1 ${latest.decision} (confidence ${confStr}) for candle ${isoMs(latest.candle_open_ms)}`.slice(0, 200);
      const published = await syscall(env, SIGNAL_ANALYST_ID, "reports.publish", {
        kind: "xauusd_digest",
        severity,
        subject,
        ai_status: "deterministic",
        body: {
          candle_key: latest.candle_key,
          decision: latest.decision,
          previous_decision: mem.last_decision ?? null,
          confidence: latest.confidence,
          entry_price: latest.entry_price,
          stop_loss: latest.stop_loss,
          take_profit: latest.take_profit,
          risk_reward: latest.risk_reward,
          reasoning: latest.reasoning,
          decided_at: latest.decided_at,
          source: obs.source,
          disclaimer: DISCLAIMER,
        },
      });
      report.actions.push(published);
      if (published.outcome === "succeeded") {
        mem.last_candle_key = latest.candle_key;
        mem.last_decision = latest.decision;
        mem.last_digest_at = now;
        await memory.put("xauusd_state", mem);
        const reportId = String(((published.result.report as JsonObject | undefined)?.report_id) ?? "");
        await rememberOutcomeForAgent(env, SIGNAL_ANALYST_ID, "xauusd_digest", subject, reportId || null, report);
      }
    }
  }

  await memory.put("last_cycle", report);
  return report;
}
