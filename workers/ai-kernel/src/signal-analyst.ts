/**
 * The Signal Analyst agent (TP-006, ADR-0007), a Durable Object process in the AI Kernel.
 *
 * Once an hour it reads the Signal Engine's latest confluence, decision and Mizan per symbol,
 * plus the macro context (tier 0: signals.observe). When any symbol's action changed from the
 * one stored in memory, or when 6 hours have passed since the last digest, it drafts an
 * advisory digest with its AI engine (strictly validated against the deterministic symbol set
 * and actions, falling back to templateDigest) and publishes it through the policy-gated
 * reports.publish syscall (tier 1).
 */
import type { JsonObject } from "../../control-plane-shared/src/http.ts";
import { boundedString, engineFor, type AiTask } from "../../control-plane-shared/src/ai-engine.ts";
import { agentsEnabled, getAgent } from "../../control-plane-shared/src/capabilities.ts";
import { syscall } from "./syscall.ts";
import type { CycleReport, KernelEnv, Memory } from "./supervisor.ts";
import type { ReportSeverity } from "./reports.ts";

export const SIGNAL_ANALYST_ID = "signal-analyst";
export const DISCLAIMER = "advisory only; not an order";
const SERVICE = "cryptophys-ai-kernel";
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

export interface ObservedSymbol {
  symbol: string;
  basis_close_time: number;
  confluence_score: number;
  action: string;
  confidence: number | null;
  decision: { action: string; confidence: number | null };
  mizan: { phi: number | null; tier: string | null; signal_tier: string | null; direction: string | null; direction_bias: string | null } | null;
  computed_at?: string;
}

export interface SignalObservation {
  observed_at: string;
  symbols: ObservedSymbol[];
  macro: JsonObject | null;
}

export interface DigestSymbolNote {
  symbol: string;
  action: string;
  note: string;
}

export interface SignalDigestDraft {
  headline: string;
  summary: string;
  symbols: DigestSymbolNote[];
}

export function draftSignalDigestTask(expectedSymbols: readonly { symbol: string; action: string }[]): AiTask<SignalDigestDraft> {
  const expected = new Map(expectedSymbols.map((s) => [s.symbol, s.action]));
  return {
    name: "draft_signal_digest",
    instructions:
      "You are the Signal Analyst agent of a Cloudflare Workers control plane. Summarize the supplied deterministic signal confluence and macro context for a human operator. " +
      'Return {"headline": at most 160 characters, "summary": at most 800 characters, "symbols": array of {"symbol": string, "action": string, "note": at most 200 characters}}. ' +
      "Every symbol and its action in symbols MUST match the input exactly. Never recommend orders, execution or position sizing.",
    maxInputChars: 6000,
    maxOutputTokens: 600,
    validate(output) {
      const o = output as Record<string, unknown>;
      const headline = boundedString(o?.headline, 160);
      const summary = boundedString(o?.summary, 800);
      if (!headline || !summary || !Array.isArray(o?.symbols)) return null;
      if (o.symbols.length !== expected.size) return null;
      const seen = new Set<string>();
      const bySymbol = new Map<string, DigestSymbolNote>();
      for (const raw of o.symbols as Record<string, unknown>[]) {
        const symbol = typeof raw?.symbol === "string" ? raw.symbol : "";
        const action = typeof raw?.action === "string" ? raw.action : "";
        const note = boundedString(raw?.note, 200);
        if (!symbol || seen.has(symbol) || !expected.has(symbol) || expected.get(symbol) !== action || !note) {
          return null;
        }
        seen.add(symbol);
        bySymbol.set(symbol, { symbol, action, note });
      }
      if (seen.size !== expected.size) return null;
      return {
        headline,
        summary,
        symbols: expectedSymbols.map((s) => bySymbol.get(s.symbol)!),
      };
    },
  };
}

/** Deterministic fallback digest when AI is unavailable or returns invalid output. */
export function templateDigest(obs: SignalObservation): SignalDigestDraft {
  const parts = obs.symbols.map((s) => `${s.symbol} ${s.action}`);
  const headline = `Signal digest: ${parts.join(", ") || "no symbols"}`.slice(0, 160);
  const details = obs.symbols.map(
    (s) => `${s.symbol} is ${s.action} (score ${s.confluence_score}, confidence ${s.confidence ?? "n/a"}, Mizan tier ${s.mizan?.tier ?? "n/a"})`,
  );
  const macroText = obs.macro
    ? ` Macro Fear & Greed: ${String(obs.macro.fear_greed ?? "n/a")} (${String(obs.macro.fear_greed_class ?? "n/a")}).`
    : "";
  const summary = (`Advisory signal digest across ${obs.symbols.length} symbol(s): ${details.join("; ")}.${macroText}`).slice(0, 800);
  const symbols: DigestSymbolNote[] = obs.symbols.map((s) => ({
    symbol: s.symbol,
    action: s.action,
    note: `Confluence ${s.confluence_score}, confidence ${s.confidence ?? "n/a"}, Mizan phi ${s.mizan?.phi ?? "n/a"} (${s.mizan?.direction ?? "n/a"}).`.slice(0, 200),
  }));
  return { headline, summary, symbols };
}

function flippedBuySell(prev: string | undefined, next: string): boolean {
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
  const obs = observed.result as unknown as SignalObservation;
  if (!obs.symbols.length) {
    report.findings.push({ kind: "signals", action: "none" });
    await memory.put("last_cycle", report);
    return report;
  }

  const prevActions = (await memory.get<Record<string, string>>("last_actions")) ?? {};
  const lastDigestAt = (await memory.get<number>("last_digest_at")) ?? 0;

  const prevKeys = Object.keys(prevActions);
  const actionChanged =
    prevKeys.length !== obs.symbols.length ||
    obs.symbols.some((s) => prevActions[s.symbol] !== s.action);
  const sixHoursPassed = lastDigestAt === 0 || now - lastDigestAt >= DIGEST_INTERVAL_MS;

  if (!actionChanged && !sixHoursPassed) {
    report.findings.push({ kind: "signals", action: "none" });
    await memory.put("last_cycle", report);
    return report;
  }

  const severity: ReportSeverity = obs.symbols.some((s) => flippedBuySell(prevActions[s.symbol], s.action)) ? "warning" : "info";
  const task = draftSignalDigestTask(obs.symbols);
  const ai = await engineFor(env, SERVICE, [task.name]).run(task, obs, `${SIGNAL_ANALYST_ID}:${now}`);
  const draft = ai.status === "ok" ? ai.data : templateDigest(obs);
  const sourceBasisCloseTimes = Object.fromEntries(obs.symbols.map((s) => [s.symbol, s.basis_close_time]));

  const body: JsonObject = {
    headline: draft.headline,
    summary: draft.summary,
    symbols: draft.symbols as unknown as JsonObject[],
    macro: obs.macro,
    source_basis_close_times: sourceBasisCloseTimes,
    disclaimer: DISCLAIMER,
  };

  const published = await syscall(env, SIGNAL_ANALYST_ID, "reports.publish", {
    kind: "signal_digest",
    severity,
    subject: draft.headline,
    ai_status: ai.status,
    body,
  });
  report.actions.push(published);
  report.findings.push({
    kind: "signals",
    action: "reports.publish",
    outcome: published.outcome,
    severity,
    ai: ai.status,
  });

  if (published.outcome === "succeeded") {
    const nextActions = Object.fromEntries(obs.symbols.map((s) => [s.symbol, s.action]));
    await memory.put("last_actions", nextActions);
    await memory.put("last_digest_at", now);
  }
  await memory.put("last_cycle", report);
  return report;
}
