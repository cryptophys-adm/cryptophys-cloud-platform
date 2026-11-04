//! mizan-confluence — Master signal scorer Phi(t)
//! Phi(t) = [sum w_i*I_i] * [sum W_t*KWW(t)] * Regime(t)
//! Contract: ssot-core/contracts/mizan/mizan-confluence-contract.yaml

use mizan_kww_engine::constants::*;

pub mod tf_weights {
    pub const W_5M: f64  = 0.4018;
    pub const W_15M: f64 = 0.3313;
    pub const W_1H: f64  = 0.2001;
    pub const W_4H: f64  = 0.0652;
    pub const W_1D: f64  = 0.0016;
}

pub mod dim_weights {
    pub const TREND_DIR: f64  = 0.2000;
    pub const MOMENTUM: f64   = 0.2000;
    pub const TREND_STR: f64  = 0.1667;
    pub const ROC: f64        = 0.0667;
    pub const CYCLE: f64      = 0.0667;
    pub const REST: f64       = 0.0333;
}

pub fn regime_score(h: f64, sigma: f64) -> f64 {
    (-(h - H_QURAN).powi(2) / (2.0 * sigma * sigma)).exp()
}

pub fn signal_tier(phi: f64) -> &'static str {
    match phi {
        p if p >= 0.90 => "extreme",
        p if p >= 0.75 => "strong",
        p if p >= 0.60 => "standard",
        p if p >= 0.45 => "weak",
        _               => "neutral",
    }
}

/// Position size % by rank (Bismillah sizing law)
pub fn position_size_pct(rank: u32) -> f64 {
    let kww_w = (-(rank as f64 / TAU).powf(BETA)).exp();
    MAX_ALLOC * kww_w * 100.0
}

pub fn signal_rank(phi: f64) -> u32 {
    match phi {
        p if p >= 0.90 => 1,
        p if p >= 0.80 => 2,
        p if p >= 0.75 => 3,
        p if p >= 0.70 => 5,
        p if p >= 0.65 => 7,
        _ => 10,
    }
}

/// SL distance: ATR × 14^(1 − 1/√3)
pub fn sl_atr() -> f64 { ATR_MULT }
/// TP = SL × φ (golden ratio R:R)
pub fn tp_atr() -> f64 { ATR_MULT * PHI }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn regime_peak_at_quran_hurst() {
        assert!((regime_score(H_QURAN, 0.15) - 1.0).abs() < 1e-9);
    }
    #[test]
    fn position_rank1_approx_4pct() {
        assert!((position_size_pct(1) - 4.17).abs() < 0.1);
    }
    #[test]
    fn rr_ratio_is_phi() {
        assert!((tp_atr() / sl_atr() - PHI).abs() < 1e-4);
    }
}
