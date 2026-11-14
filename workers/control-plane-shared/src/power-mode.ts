/**
 * What each power mode does (owner rules 2026-11-10, amended 2026-11-14: "learning is core"). One list read by the
 * Policy Engine (which decides), the AI engine (which budgets model calls) and the metabolism view (which the Console
 * shows), so the three can never disagree about what a mode blocks.
 *
 *  - The learning mandate (owner 2026-11-14, "learning tidak boleh dibatasi siapa pun, itu adalah mandat tertinggi":
 *    learning must not be limited by anyone; it is the highest mandate). Learning (memory.remember, knowledge.propose)
 *    is never denied by a power mode, never rate limited (no max_per_hour in capabilities.ts), never capped per day
 *    (knowledge.ts), and the AI calls it needs (the embedding of a memory) are never refused by an AI request budget,
 *    in any mode, survival included. Those calls are still metered in ai_usage. From 2026-11-12 to 2026-11-14 survival
 *    denied both, and no knowledge proposal was written for three days.
 *  - What still applies to learning, because it is not a limit on learning: the capability grants (which agent may
 *    learn), the owner's kill switch (agents_enabled), identity and Access, the audit chain, the knowledge
 *    content-safety validator (no orders, prices or levels) and size and format bounds.
 *  - Survival throttles other AI-heavy work only: every other model call (drafts, the embeddings of a recall) reserves
 *    from the AI request budgets, which survival cuts to a quarter. It never blocks consensus.propose (deploys,
 *    rollbacks, suspensions).
 *  - Growth doubles the AI budgets only as the owner's override (power_mode_override = growth).
 *
 * This file is a guard path (guard-paths.ts, reason learning_mandate): no agent or evolver can reintroduce a learning
 * limit here without the owner's click. test/learning-mandate-2026-11-14.test.ts holds the invariants.
 */

export type PowerMode = "survival" | "homeostasis" | "growth";
export const POWER_MODES: readonly PowerMode[] = ["survival", "homeostasis", "growth"];
export const isPowerMode = (m: unknown): m is PowerMode => typeof m === "string" && (POWER_MODES as readonly string[]).includes(m);

/** The constitution's first line (organism/vision.json core.constitution[0]). */
export const LEARNING_MANDATE = "Learning is the highest mandate: no organ, mode, budget, rate limit or agent may limit it.";

/** Learning: no power mode denies these, no rate limit or daily cap applies to them. */
export const LEARNING_CAPABILITIES: readonly string[] = ["memory.remember", "knowledge.propose"];
export const isLearningCapability = (capability: string): boolean => LEARNING_CAPABILITIES.includes(capability);

/**
 * The purpose of an AI call made for learning (AiEngine.run/embed options.purpose). Such a call is recorded in
 * ai_usage like any other but is never refused by the per-service or account daily budget, in any mode. Only the
 * learning call sites pass it (today: the embedding in ai-kernel/src/memory.ts rememberMemory; knowledge.propose
 * makes no model call); the learning-mandate test checks that no other file does.
 */
export const LEARNING_AI_PURPOSE = "learning";
export type AiPurpose = typeof LEARNING_AI_PURPOSE;
export const isLearningAiPurpose = (purpose: unknown): purpose is AiPurpose => purpose === LEARNING_AI_PURPOSE;

/** Never throttled by a power mode: the platform's own safety (owner 2026-11-10). */
export const NEVER_THROTTLED_CAPABILITIES: readonly string[] = ["consensus.propose"];

/**
 * AI-heavy capabilities the Policy Engine denies in survival. None of the catalog's capabilities runs a model itself
 * today, so the list is empty and survival saves AI through the budgets below. A learning or never-throttled capability
 * is never denied, even if it is listed.
 */
export const SURVIVAL_DENIED_CAPABILITIES: readonly string[] = [];

/**
 * Survival's AI request budgets: a quarter of each daily budget, at most 20 per service and 50 per account. They
 * never refuse a learning AI call (LEARNING_AI_PURPOSE).
 */
export const SURVIVAL_AI_BUDGET = { ratio: 0.25, max_per_service: 20, max_account: 50 } as const;
/** The owner's growth override doubles them. */
export const GROWTH_AI_BUDGET_RATIO = 2;

/** True when survival denies this capability at the Policy Engine. */
export function survivalDenies(capability: string, denied: readonly string[] = SURVIVAL_DENIED_CAPABILITIES): boolean {
  if (isLearningCapability(capability) || NEVER_THROTTLED_CAPABILITIES.includes(capability)) return false;
  return denied.includes(capability);
}

export interface PowerModeEffects {
  mode: PowerMode;
  /** Capabilities the Policy Engine denies in this mode. */
  blocked_capabilities: string[];
  /** Allowed in every mode, with no rate limit, daily cap or AI budget refusal. */
  learning_capabilities: string[];
  never_throttled: string[];
  /** The AI request budgets as a share of each daily budget; caps only in survival. Learning AI calls are exempt. */
  ai_budget: { ratio: number; max_per_service: number | null; max_account: number | null };
}

/** The rules of a mode (rules, not readings); null for a mode that was not reported. */
export function powerModeEffects(mode: unknown, override: unknown = "none"): PowerModeEffects | null {
  if (!isPowerMode(mode)) return null;
  const blocked = mode === "survival" ? SURVIVAL_DENIED_CAPABILITIES.filter((c) => survivalDenies(c)) : [];
  const ai_budget = mode === "survival"
    ? { ratio: SURVIVAL_AI_BUDGET.ratio, max_per_service: SURVIVAL_AI_BUDGET.max_per_service, max_account: SURVIVAL_AI_BUDGET.max_account }
    // An automatic growth mode never raises budgets; only the owner's override does.
    : { ratio: mode === "growth" && override === "growth" ? GROWTH_AI_BUDGET_RATIO : 1, max_per_service: null, max_account: null };
  return {
    mode,
    blocked_capabilities: [...blocked],
    learning_capabilities: [...LEARNING_CAPABILITIES],
    never_throttled: [...NEVER_THROTTLED_CAPABILITIES],
    ai_budget,
  };
}
