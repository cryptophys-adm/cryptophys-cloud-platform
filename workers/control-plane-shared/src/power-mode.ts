/**
 * What each power mode does (owner rules 2026-11-10, amended 2026-11-14: "learning is core"). One list read by the
 * Policy Engine (which decides), the AI engine (which budgets model calls) and the metabolism view (which the Console
 * shows), so the three can never disagree about what a mode blocks.
 *
 *  - Learning (memory.remember, knowledge.propose) is never denied by a power mode, including weekend survival. From
 *    2026-11-12 to 2026-11-14 survival denied both, and no knowledge proposal was written for three days.
 *  - Survival throttles AI-heavy work only: every model call (drafts, the embeddings of memory) reserves from the AI
 *    request budgets, which survival cuts to a quarter. It never blocks consensus.propose (deploys, rollbacks,
 *    suspensions).
 *  - Growth doubles the AI budgets only as the owner's override (power_mode_override = growth).
 */

export type PowerMode = "survival" | "homeostasis" | "growth";
export const POWER_MODES: readonly PowerMode[] = ["survival", "homeostasis", "growth"];
export const isPowerMode = (m: unknown): m is PowerMode => typeof m === "string" && (POWER_MODES as readonly string[]).includes(m);

/** Learning is core: a power mode never denies these. */
export const LEARNING_CAPABILITIES: readonly string[] = ["memory.remember", "knowledge.propose"];
export const isLearningCapability = (capability: string): boolean => LEARNING_CAPABILITIES.includes(capability);

/** Never throttled by a power mode: the platform's own safety (owner 2026-11-10). */
export const NEVER_THROTTLED_CAPABILITIES: readonly string[] = ["consensus.propose"];

/**
 * AI-heavy capabilities the Policy Engine denies in survival. None of the catalog's capabilities runs a model itself
 * today, so the list is empty and survival saves AI through the budgets below. A learning or never-throttled capability
 * is never denied, even if it is listed.
 */
export const SURVIVAL_DENIED_CAPABILITIES: readonly string[] = [];

/** Survival's AI request budgets: a quarter of each daily budget, at most 20 per service and 50 per account. */
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
  /** Allowed in every mode. */
  learning_capabilities: string[];
  never_throttled: string[];
  /** The AI request budgets as a share of each daily budget; caps only in survival. */
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
