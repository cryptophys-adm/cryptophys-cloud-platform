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
  // ADR-0020 Amendment 10 (owner 2026-11-21, "tabel disetujui"): Omega's risk bounds follow the account profile
  // (xauusd src/account-spec.mjs PROFILES): each ceiling is the profile's hard limit. risk_pct: percent of the account
  // per trade; max_daily_loss_pct: percent of the account per UTC day; max_positions: open positions. The limits in
  // force are the smaller of the profile's and the engine's setting. The single facts (omega.risk_pct,
  // omega.max_daily_loss_pct, omega.max_positions: the engine's stored settings) are information now, unbounded, so
  // the council amends risk only under the per-profile names. The Custom profile (the engine's settings, with no
  // limit of its own in xauusd) is bounded as Aggressive (owner, "2a").
  "omega.risk_pct_safe": { kind: "number", min: 0.1, max: 2 },
  "omega.risk_pct_conservative": { kind: "number", min: 0.1, max: 5 },
  "omega.risk_pct_aggressive": { kind: "number", min: 0.1, max: 10 },
  "omega.max_daily_loss_pct_safe": { kind: "number", min: 0.1, max: 3 },
  "omega.max_daily_loss_pct_conservative": { kind: "number", min: 0.1, max: 6 },
  "omega.max_daily_loss_pct_aggressive": { kind: "number", min: 0.1, max: 10 },
  "omega.max_positions_safe": { kind: "integer", min: 1, max: 1 },
  "omega.max_positions_conservative": { kind: "integer", min: 1, max: 2 },
  "omega.max_positions_aggressive": { kind: "integer", min: 1, max: 3 },
  "omega.risk_pct_custom": { kind: "number", min: 0.1, max: 10 },
  "omega.max_daily_loss_pct_custom": { kind: "number", min: 0.1, max: 10 },
  "omega.max_positions_custom": { kind: "integer", min: 1, max: 3 },
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
  // ADR-0020 Amendment 9 (owner 2026-11-20, "1.b"): WAIT-with-bias entries. min_score: the minimum confidence x confluence
  // (both 0-1) of a bias-side plan, per mode (xauusd does not read scalp's yet). counter_<agent>_<mode>: the multiplier
  // (0-1 in kind, bounded to 0-0.5) on a counter-bias plan's score, 0 = never; scalp is fixed at 0. The 13 agents are
  // xauusd's STRATEGY_AGENTS ids (src/strategy-agents.mjs); the units and bounds are xauusd's (relay 2026-11-20 09:09).
  "omega.wait_bias_min_score_scalp": { kind: "number", min: 0.2, max: 0.6 },
  "omega.wait_bias_min_score_intraday": { kind: "number", min: 0.2, max: 0.6 },
  "omega.wait_bias_min_score_swing": { kind: "number", min: 0.2, max: 0.6 },
  "omega.wait_bias_min_score_range": { kind: "number", min: 0.2, max: 0.6 },
  "omega.wait_bias_counter_zone_pullback_scalp": { kind: "number", min: 0, max: 0 },
  "omega.wait_bias_counter_zone_pullback_intraday": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_zone_pullback_swing": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_zone_pullback_range": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_sweep_reversal_scalp": { kind: "number", min: 0, max: 0 },
  "omega.wait_bias_counter_sweep_reversal_intraday": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_sweep_reversal_swing": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_sweep_reversal_range": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_breakout_retest_scalp": { kind: "number", min: 0, max: 0 },
  "omega.wait_bias_counter_breakout_retest_intraday": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_breakout_retest_swing": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_breakout_retest_range": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_range_fade_scalp": { kind: "number", min: 0, max: 0 },
  "omega.wait_bias_counter_range_fade_intraday": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_range_fade_swing": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_range_fade_range": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_peaks_scalp": { kind: "number", min: 0, max: 0 },
  "omega.wait_bias_counter_pattern_peaks_intraday": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_peaks_swing": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_peaks_range": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_lines_scalp": { kind: "number", min: 0, max: 0 },
  "omega.wait_bias_counter_pattern_lines_intraday": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_lines_swing": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_lines_range": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_curve_scalp": { kind: "number", min: 0, max: 0 },
  "omega.wait_bias_counter_pattern_curve_intraday": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_curve_swing": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_curve_range": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_bars_scalp": { kind: "number", min: 0, max: 0 },
  "omega.wait_bias_counter_pattern_bars_intraday": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_bars_swing": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_bars_range": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_pole_scalp": { kind: "number", min: 0, max: 0 },
  "omega.wait_bias_counter_pattern_pole_intraday": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_pole_swing": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_pole_range": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_gaps_scalp": { kind: "number", min: 0, max: 0 },
  "omega.wait_bias_counter_pattern_gaps_intraday": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_gaps_swing": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_gaps_range": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_legs_scalp": { kind: "number", min: 0, max: 0 },
  "omega.wait_bias_counter_pattern_legs_intraday": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_legs_swing": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_legs_range": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_event_scalp": { kind: "number", min: 0, max: 0 },
  "omega.wait_bias_counter_pattern_event_intraday": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_event_swing": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_event_range": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_inside_scalp": { kind: "number", min: 0, max: 0 },
  "omega.wait_bias_counter_pattern_inside_intraday": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_inside_swing": { kind: "number", min: 0, max: 0.5 },
  "omega.wait_bias_counter_pattern_inside_range": { kind: "number", min: 0, max: 0.5 },
  // ADR-0021 (owner 2026-11-20, "3. All protocols live"): the Self-Improvement Protocol's validator gates. Each floor
  // is the owner's starting value, so a tuning may only make the validator stricter, never looser; the ceilings stop a
  // tuning from making it impossible to pass. sim_samples: simulated fills per candidate (and per mode); oos_pf: the
  // out-of-sample profit factor; wf_windows_positive: positive walk-forward windows out of 4; sensitivity_pct: the
  // parameter change (plus and minus) under which the result must not collapse.
  "validator.min_sim_samples": { kind: "integer", min: 100, max: 1000 },
  "validator.min_sim_samples_per_mode": { kind: "integer", min: 50, max: 500 },
  "validator.min_oos_pf": { kind: "number", min: 1.2, max: 3 },
  "validator.min_wf_windows_positive": { kind: "integer", min: 3, max: 4 },
  "validator.sensitivity_pct": { kind: "integer", min: 20, max: 50 },
  // xauusd's Positioning & Liquidity analyst (#505; live on merge as a breakglass under ADR-0021, owner: "Sekarang
  // breakglass urgent jadi langsung live"). Aether moves these inside their bounds; the units and bounds are xauusd's
  // (relay 2026-11-20 10:13). Per mode: de_weight, the share of the Decision Engine's witness weight; crowd_pctl, the
  // percentile of the managed-money net over 156 weeks; flow_z, standard deviations of the weekly change in net;
  // council_weight, 0 (muted) to 1; spike_pctl / thin_pctl, percentiles of M1 / 15m tick volume within its hour of the
  // week; spread_widen, the live spread over the hour's median; sweep_lookback_min and profile_window_min, minutes of M1
  // bars; pool_tol_atr, a multiple of ATR(14) on 15m bars; hvn_pctl, the percentile of the profile bins. Per lens:
  // score_floor, the hit share; score_window, the scored readings.
  "positioning.de_weight_scalp": { kind: "number", min: 0.02, max: 0.04 },
  "positioning.de_weight_intraday": { kind: "number", min: 0.02, max: 0.06 },
  "positioning.de_weight_swing": { kind: "number", min: 0.02, max: 0.1 },
  "positioning.de_weight_range": { kind: "number", min: 0.02, max: 0.05 },
  "positioning.crowd_pctl_scalp": { kind: "number", min: 0.8, max: 0.95 },
  "positioning.crowd_pctl_intraday": { kind: "number", min: 0.8, max: 0.95 },
  "positioning.crowd_pctl_swing": { kind: "number", min: 0.8, max: 0.95 },
  "positioning.crowd_pctl_range": { kind: "number", min: 0.8, max: 0.95 },
  "positioning.flow_z_scalp": { kind: "number", min: 0.5, max: 2 },
  "positioning.flow_z_intraday": { kind: "number", min: 0.5, max: 2 },
  "positioning.flow_z_swing": { kind: "number", min: 0.5, max: 2 },
  "positioning.flow_z_range": { kind: "number", min: 0.5, max: 2 },
  "liquidity.council_weight_scalp": { kind: "number", min: 0, max: 0.8 },
  "liquidity.council_weight_intraday": { kind: "number", min: 0, max: 0.6 },
  "liquidity.council_weight_swing": { kind: "number", min: 0, max: 0.4 },
  "liquidity.council_weight_range": { kind: "number", min: 0, max: 0.6 },
  "liquidity.spike_pctl_scalp": { kind: "number", min: 0.9, max: 0.99 },
  "liquidity.spike_pctl_intraday": { kind: "number", min: 0.9, max: 0.99 },
  "liquidity.spike_pctl_swing": { kind: "number", min: 0.9, max: 0.99 },
  "liquidity.spike_pctl_range": { kind: "number", min: 0.9, max: 0.99 },
  "liquidity.thin_pctl_scalp": { kind: "number", min: 0.05, max: 0.3 },
  "liquidity.thin_pctl_intraday": { kind: "number", min: 0.05, max: 0.3 },
  "liquidity.thin_pctl_swing": { kind: "number", min: 0.05, max: 0.3 },
  "liquidity.thin_pctl_range": { kind: "number", min: 0.05, max: 0.3 },
  "liquidity.spread_widen_scalp": { kind: "number", min: 1.5, max: 4 },
  "liquidity.spread_widen_intraday": { kind: "number", min: 1.5, max: 4 },
  "liquidity.spread_widen_swing": { kind: "number", min: 1.5, max: 4 },
  "liquidity.spread_widen_range": { kind: "number", min: 1.5, max: 4 },
  "liquidity.sweep_lookback_min_scalp": { kind: "integer", min: 30, max: 120 },
  "liquidity.sweep_lookback_min_intraday": { kind: "integer", min: 60, max: 360 },
  "liquidity.sweep_lookback_min_swing": { kind: "integer", min: 240, max: 1440 },
  "liquidity.sweep_lookback_min_range": { kind: "integer", min: 60, max: 360 },
  "liquidity.pool_tol_atr_scalp": { kind: "number", min: 0.02, max: 0.15 },
  "liquidity.pool_tol_atr_intraday": { kind: "number", min: 0.02, max: 0.15 },
  "liquidity.pool_tol_atr_swing": { kind: "number", min: 0.02, max: 0.15 },
  "liquidity.pool_tol_atr_range": { kind: "number", min: 0.02, max: 0.15 },
  "liquidity.hvn_pctl_scalp": { kind: "number", min: 0.8, max: 0.95 },
  "liquidity.hvn_pctl_intraday": { kind: "number", min: 0.8, max: 0.95 },
  "liquidity.hvn_pctl_swing": { kind: "number", min: 0.8, max: 0.95 },
  "liquidity.hvn_pctl_range": { kind: "number", min: 0.8, max: 0.95 },
  "liquidity.profile_window_min_scalp": { kind: "integer", min: 120, max: 480 },
  "liquidity.profile_window_min_intraday": { kind: "integer", min: 480, max: 2880 },
  "liquidity.profile_window_min_swing": { kind: "integer", min: 2880, max: 14400 },
  "liquidity.profile_window_min_range": { kind: "integer", min: 480, max: 2880 },
  "positioning.score_floor": { kind: "number", min: 0.4, max: 0.5 },
  "liquidity.score_floor": { kind: "number", min: 0.4, max: 0.5 },
  "positioning.score_window": { kind: "integer", min: 40, max: 200 },
  "liquidity.score_window": { kind: "integer", min: 50, max: 300 },
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
