//! mizan-kww-engine
//! KWW memory kernel: M(t) = exp(-(t/τ)^β)
//! Contract: ssot-core/contracts/mizan/mizan-kww-contract.yaml

pub mod constants {
    pub const BETA: f64 = 0.577_350_269; // 1/√3
    pub const TAU:  f64 = 14.0;
    pub const BASE: u32 = 19;
    pub const PHI:  f64 = 1.618_033_989;
    pub const H_QURAN:   f64 = 0.845_299;
    pub const ATR_MULT:  f64 = 3.050_8;
    pub const MAX_ALLOC: f64 = 0.051_80;
    pub const CONFIDENCE: f64 = 0.60;
}

use constants::*;

/// KWW memory weight: M(t) = exp(-(t/τ)^β)
#[inline]
pub fn kww_memory(t: f64) -> f64 {
    (-(t / TAU).powf(BETA)).exp()
}

/// EMA weight (comparison only)
#[inline]
pub fn ema_weight(t: f64) -> f64 { (-t / TAU).exp() }

/// KWW-weighted moving average (normalized)
pub fn kww_ma(series: &[f64]) -> f64 {
    if series.is_empty() { return 0.0; }
    let (weighted_sum, w_sum) = series.iter().enumerate().fold((0.0, 0.0), |(ws, s), (i, p)| {
        let w = kww_memory(i as f64);
        (ws + p * w, s + w)
    });
    if w_sum == 0.0 { 0.0 } else { weighted_sum / w_sum }
}

/// KWW momentum (derivative of smoothed series)
pub fn kww_momentum(series: &[f64]) -> f64 {
    if series.len() < 2 { return 0.0; }
    kww_ma(series) - kww_ma(&series[..series.len()-1])
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct KwwPayload {
    pub symbol: String,
    pub tf: String,
    pub kww_close: f64,
    pub kww_volume: f64,
    pub kww_momentum: f64,
    pub memory_weight: f64,
    pub candles_since_signal: u32,
    pub timestamp: i64,
    #[serde(default)]
    pub kww_close_window: Vec<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn kww_at_tau_equals_e_inverse() {
        assert!((kww_memory(constants::TAU) - (-1.0_f64).exp()).abs() < 1e-9);
    }
    #[test]
    fn kww_greater_ema_at_long_lag() {
        assert!(kww_memory(28.0) > ema_weight(28.0));
    }
    #[test]
    fn crossover_at_tau() {
        assert!((kww_memory(constants::TAU) - ema_weight(constants::TAU)).abs() < 1e-10);
    }
    #[test]
    fn law_v_confidence() {
        let law_v = (-1.0_f64).exp() * constants::PHI;
        assert!((constants::CONFIDENCE - law_v).abs() < 0.01);
    }
}
