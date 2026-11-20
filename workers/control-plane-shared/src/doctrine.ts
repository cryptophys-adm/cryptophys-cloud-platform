/**
 * Doctrine amendments by the Knowledge Council (owner 2026-11-11: "autonomous doctrine protocol harus
 * dilakukan oleh knowledge council, dilakukan harian dan di propose ke cerebrum untuk eksekusinya").
 *
 * The council (a daily session in Aether with the Nexus, Omega and Aether seats) finds where the
 * doctrine of the Aether Canon no longer matches the measured state of the system and proposes the
 * amendment to the Cerebrum consensus. Cerebrum votes and, when it passes, executes it: the kernel
 * records the amendment in doctrine_amendments and the audit chain, and Aether applies only what the
 * kernel executed (doctrine.status).
 *
 * Two actions, two classes:
 *  - amend_doctrine (routine): only the operational facts below, only inside their hard bounds. The
 *    bounds live in this reviewed file, never in the database or in the proposal.
 *  - amend_constitution (critical): any other fact, including every constitutional rule. It executes
 *    only after one owner approval click (ADR-0009 phase 4).
 * Only the knowledge-council agent may propose either, and it may propose nothing else.
 */
import type { JsonObject } from "./http.ts";

export const DOCTRINE_COUNCIL_AGENT = "knowledge-council";
export const DOCTRINE_ACTIONS: ReadonlySet<string> = new Set(["amend_doctrine", "amend_constitution"]);

export type DoctrineBound =
  | { kind: "number"; min: number; max: number }
  | { kind: "integer"; min: number; max: number }
  | { kind: "text"; in: readonly string[] }
  | { kind: "weights"; keys: readonly string[]; max_each: number };

// The Decision Engine's witnesses (xauusd src/decision-engine.mjs EXTENDED_WITNESS_WEIGHTS): CALENDAR since
// 2026-11-12 (the economic calendar inside a release's horizon), STRATEGY_AGENTS since 2026-11-13 (the
// strategy agents' consensus, weighted like a timeframe room). A weight set naming a witness not listed
// here is refused, so a council amendment of decision.witness_weights must find every one of them.
const WITNESSES = ["D1", "H4", "H1", "M15", "NEWS", "MACRO", "STRATEGY", "KEY_LEVELS", "REGIME", "TREND_TF", "MACRO_DRIVERS", "SESSION", "CALENDAR", "STRATEGY_AGENTS"] as const;

/** The operational facts the council may amend by consensus alone, with their hard bounds. */
export const DOCTRINE_BOUNDS: Readonly<Record<string, DoctrineBound>> = Object.freeze({
  // decision.trading_mode is no longer bounded (owner 2026-11-19, as Aether #36 unanchored it): the mode in force is
  // information only, so an amendment of it is amend_constitution.
  // The Decision Engine's thresholds, one fact per trading mode (owner 2026-11-19, the same per-mode split as the room
  // guardrail below), each with the bound the single fact had; a mode switch moves no anchor. The single facts (the
  // values in force) are information only on the xauusd side. Scalp has no reward minimum (owner 2026-11-12), so
  // decision.min_rrr_scalp, 0, is information only and has no bound. Mirrors Aether's src/doctrine.mjs.
  "decision.quorum_min_scalp": { kind: "number", min: 0.45, max: 0.7 },
  "decision.quorum_min_intraday": { kind: "number", min: 0.45, max: 0.7 },
  "decision.quorum_min_swing": { kind: "number", min: 0.45, max: 0.7 },
  "decision.quorum_min_range": { kind: "number", min: 0.45, max: 0.7 },
  "decision.lean_scalp": { kind: "number", min: 0.05, max: 0.3 },
  "decision.lean_intraday": { kind: "number", min: 0.05, max: 0.3 },
  "decision.lean_swing": { kind: "number", min: 0.05, max: 0.3 },
  "decision.lean_range": { kind: "number", min: 0.05, max: 0.3 },
  "decision.min_rrr_intraday": { kind: "number", min: 1, max: 3 },
  "decision.min_rrr_swing": { kind: "number", min: 1, max: 3 },
  "decision.min_rrr_range": { kind: "number", min: 1, max: 3 },
  "decision.min_confidence": { kind: "number", min: 0.3, max: 0.7 },
  // The room guardrail in 1H average ranges, one fact per trading mode (xauusd src/room-tuning.mjs; owner 2026-11-19:
  // "guardrail room biarkan protocol learning dan knowledge yang melakukan adjustment secara dinamis", bounds 0.5 to 1.5).
  // One anchor per mode, so a mode switch moves no anchor; decision.room_min_atr, the value in force, stays an
  // unanchored information fact on the xauusd side. Mirrors Aether's src/doctrine.mjs (cryptophys-aether #35, c2abe6b).
  "decision.room_min_atr_scalp": { kind: "number", min: 0.5, max: 1.5 },
  "decision.room_min_atr_intraday": { kind: "number", min: 0.5, max: 1.5 },
  "decision.room_min_atr_swing": { kind: "number", min: 0.5, max: 1.5 },
  "decision.room_min_atr_range": { kind: "number", min: 0.5, max: 1.5 },
  "decision.witness_weights": { kind: "weights", keys: WITNESSES, max_each: 0.3 },
  "rooms.quorum_share_default": { kind: "number", min: 0.5, max: 0.6 },
  "room.m15_unverified_confidence_cap": { kind: "number", min: 0.3, max: 0.5 },
  "weighting.activation_min_days": { kind: "integer", min: 7, max: 30 },
  "weighting.rollback_min_rooms": { kind: "integer", min: 50, max: 200 },
  "calendar.blackout_before_min": { kind: "integer", min: 60, max: 240 },
  "calendar.blackout_after_min": { kind: "integer", min: 15, max: 120 },
  "omega.max_signal_age_min": { kind: "number", min: 5, max: 15 },
  "omega.max_spread_points": { kind: "integer", min: 20, max: 100 },
  "omega.max_positions": { kind: "integer", min: 1, max: 3 },
  "omega.max_daily_loss_pct": { kind: "number", min: 1, max: 5 },
  "omega.risk_pct": { kind: "number", min: 0.1, max: 2 },
  // ADR-0020 Amendment 7 (owner 2026-11-20; xauusd RFC_OMEGA_LIMIT_ENTRY, #496/#497): Omega's resting limit entries,
  // one fact per trading mode, learned inside these bounds. life: integer minutes from the EA's placed_ms to deletion;
  // move_max_atr: total move toward price in ATR(14) of closed 15m bars; cancel_share_drop: absolute drop of the order
  // side's share of the Decision Engine's weighted witness quorum since the placing decision; band: the limit's distance
  // from the current ask/bid as a fraction of the placing plan's |entry - stop|. The names avoid the Policy Engine's
  // prohibited words (K2). No single (mode-less) fact is bounded.
  "omega.limit_life_min_scalp": { kind: "integer", min: 15, max: 60 },
  "omega.limit_life_min_intraday": { kind: "integer", min: 30, max: 240 },
  "omega.limit_life_min_swing": { kind: "integer", min: 60, max: 720 },
  "omega.limit_life_min_range": { kind: "integer", min: 30, max: 240 },
  "omega.limit_move_max_atr_scalp": { kind: "number", min: 0, max: 0.5 },
  "omega.limit_move_max_atr_intraday": { kind: "number", min: 0, max: 0.5 },
  "omega.limit_move_max_atr_swing": { kind: "number", min: 0, max: 0.5 },
  "omega.limit_move_max_atr_range": { kind: "number", min: 0, max: 0.5 },
  "omega.limit_cancel_share_drop_scalp": { kind: "number", min: 0.03, max: 0.1 },
  "omega.limit_cancel_share_drop_intraday": { kind: "number", min: 0.03, max: 0.1 },
  "omega.limit_cancel_share_drop_swing": { kind: "number", min: 0.03, max: 0.1 },
  "omega.limit_cancel_share_drop_range": { kind: "number", min: 0.03, max: 0.1 },
  "omega.limit_band_scalp": { kind: "number", min: 0.1, max: 0.6 },
  "omega.limit_band_intraday": { kind: "number", min: 0.1, max: 0.6 },
  "omega.limit_band_swing": { kind: "number", min: 0.1, max: 0.6 },
  "omega.limit_band_range": { kind: "number", min: 0.1, max: 0.6 },
  // ADR-0020 Amendment 8 (owner 2026-11-20): the Position Manager council's one bounded loosening of an open position's
  // stop, one fact per trading mode, with the units and bounds xauusd proposed (#504, relay 2026-11-20 09:05).
  // atr_expand: ATR(14) of the closed 15m bars now over the reference ATR (at the last tighten, or at entry if the stop
  // was never tightened); a loosening needs at least this expansion. back_share: the fraction of the way from the
  // current, tightened stop back toward the original entry stop; 1.0 is the original stop itself, never past it.
  "omega.pm_loosen_atr_expand_scalp": { kind: "number", min: 1.2, max: 2.5 },
  "omega.pm_loosen_atr_expand_intraday": { kind: "number", min: 1.2, max: 2.5 },
  "omega.pm_loosen_atr_expand_swing": { kind: "number", min: 1.2, max: 2.5 },
  "omega.pm_loosen_atr_expand_range": { kind: "number", min: 1.2, max: 2.5 },
  "omega.pm_loosen_back_share_scalp": { kind: "number", min: 0.25, max: 1 },
  "omega.pm_loosen_back_share_intraday": { kind: "number", min: 0.25, max: 1 },
  "omega.pm_loosen_back_share_swing": { kind: "number", min: 0.25, max: 1 },
  "omega.pm_loosen_back_share_range": { kind: "number", min: 0.25, max: 1 },
});

export const DOCTRINE_RULE = /^[a-z][a-z0-9_]{2,40}$/;
const FACT = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const CANON = /^[0-9a-f]{12}$/;
const SESSION = /^kc_[0-9a-z-]{6,48}$/;
const SEATS = new Set(["nexus", "omega", "aether"]);
const MAX_FACTS = 8;

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Null when the value sits inside the fact's hard bound; else the reason. */
export function boundProblem(fact: string, value: unknown): string | null {
  const b = DOCTRINE_BOUNDS[fact];
  if (!b) return `${fact} is not a council-amendable fact`;
  if (b.kind === "number" || b.kind === "integer") {
    if (!isNum(value) || (b.kind === "integer" && !Number.isInteger(value))) return `${fact} must be ${b.kind === "integer" ? "an integer" : "a number"}`;
    return value >= b.min && value <= b.max ? null : `${fact} ${value} is outside ${b.min}-${b.max}`;
  }
  if (b.kind === "text") return typeof value === "string" && b.in.includes(value) ? null : `${fact} must be one of ${b.in.join(", ")}`;
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${fact} must be an object of weights`;
  const entries = Object.entries(value as JsonObject);
  if (!entries.length) return `${fact} is empty`;
  for (const [k, w] of entries) {
    if (!b.keys.includes(k)) return `${fact} has an unknown witness ${k}`;
    if (!isNum(w) || w < 0 || w > b.max_each) return `${fact}.${k} must be from 0 to ${b.max_each}`;
  }
  const sum = entries.reduce((s, [, w]) => s + (w as number), 0);
  return Math.abs(sum - 1) <= 0.001 ? null : `${fact} must sum to 1 (got ${Math.round(sum * 1000) / 1000})`;
}

const plainValue = (v: unknown, depth = 0): boolean => {
  if (v === null || typeof v === "boolean" || typeof v === "string" || isNum(v)) return typeof v !== "string" || v.length <= 120;
  if (depth > 1) return false;
  if (Array.isArray(v)) return v.length <= 16 && v.every((x) => plainValue(x, depth + 1));
  if (typeof v === "object") return Object.keys(v as object).length <= 16 && Object.values(v as object).every((x) => plainValue(x, depth + 1));
  return false;
};

/**
 * Null when a doctrine proposal is well formed for its action; else the reason. The kernel checks it
 * at proposal time, every voter checks it in its vote, and the executor checks it once more.
 *   target  the rule id with "_" written "-" (the consensus target format)
 *   params  { rule, values: {fact: value}, previous: {fact: value}, canon: 12 hex, session: "kc_…",
 *             seats: { nexus|omega|aether: "agree" }, note?: string }
 */
export function doctrineProblem(action: string, target: string, params: JsonObject): string | null {
  if (!DOCTRINE_ACTIONS.has(action)) return "not a doctrine action";
  const rule = String(params.rule ?? "");
  if (!DOCTRINE_RULE.test(rule)) return "rule must be a doctrine rule id";
  if (target !== rule.replaceAll("_", "-")) return "target must be the rule id";
  if (!CANON.test(String(params.canon ?? ""))) return "canon must be the first 12 hex of the canon hash";
  if (!SESSION.test(String(params.session ?? ""))) return "session must be a council session id";
  const seats = params.seats as JsonObject | undefined;
  if (!seats || typeof seats !== "object" || Array.isArray(seats) || seats.aether !== "agree") return "the Aether seat must agree";
  for (const [seat, verdict] of Object.entries(seats)) {
    if (!SEATS.has(seat)) return `unknown seat ${seat}`;
    if (verdict !== "agree") return `the ${seat} seat does not agree`;
  }
  const values = params.values as JsonObject | undefined;
  const previous = params.previous as JsonObject | undefined;
  if (!values || typeof values !== "object" || Array.isArray(values)) return "values must be an object";
  if (!previous || typeof previous !== "object" || Array.isArray(previous)) return "previous must be an object";
  const facts = Object.keys(values);
  if (!facts.length || facts.length > MAX_FACTS) return `values must hold 1 to ${MAX_FACTS} facts`;
  for (const f of facts) {
    if (!FACT.test(f)) return `${f} is not a fact name`;
    if (!plainValue(values[f])) return `${f} is not a plain value`;
    if (!Object.hasOwn(previous, f)) return `previous must hold ${f}`;
  }
  if (params.note !== undefined && (typeof params.note !== "string" || params.note.length > 300)) return "note must be text of 300 characters or fewer";
  if (action === "amend_doctrine") {
    for (const f of facts) {
      const problem = boundProblem(f, values[f]);
      if (problem) return problem;
    }
  }
  return null;
}

/** The action a set of facts needs: routine when every one is bounded, else critical. */
export function doctrineActionFor(facts: string[], constitutional: boolean): "amend_doctrine" | "amend_constitution" {
  return !constitutional && facts.every((f) => Object.hasOwn(DOCTRINE_BOUNDS, f)) ? "amend_doctrine" : "amend_constitution";
}
