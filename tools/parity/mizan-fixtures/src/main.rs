//! Parity fixtures for workers/signal-engine/src/mizan.ts from the recovered Rust sources in
//! ../legacy/mizan (cryptophys-work/apps-gitops, see ../legacy/PROVENANCE.tsv).
//! `kww_lib.rs` and `confluence_lib.rs` are included verbatim except for their serde derive and
//! cross-crate `use` lines (rewritten by include_lib! below); the dimension math is copied from
//! dimension_router_main.rs. Output: JSON on stdout.


pub mod mizan_kww_engine {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/target/gen/kww_lib.rs"));
}
pub mod mizan_confluence {
    include!(concat!(env!("CARGO_MANIFEST_DIR"), "/target/gen/confluence_lib.rs"));
}

use mizan_confluence::{position_size_pct, regime_score, signal_rank, signal_tier, sl_atr, tp_atr};
use mizan_kww_engine::constants::*;
use mizan_kww_engine::{kww_ma, kww_memory, kww_momentum};

// ---- copied verbatim from dimension_router_main.rs ----
fn timeframe_weight(tf: &str) -> f64 {
    match tf {
        "5m" => 0.4018,
        "15m" => 0.3313,
        "1h" => 0.2001,
        "4h" => 0.0652,
        "1d" => 0.0016,
        _ => 0.05,
    }
}
fn bounded(value: f64) -> f64 { value.clamp(0.0, 1.0) }
fn dimension(kww_close: f64, kww_volume: f64, kww_mom: f64, candles_since_signal: u32, window: &[f64]) -> [f64; 6] {
    let trend_direction = if kww_mom >= 0.0 { 1.0 } else { 0.0 };
    let momentum_score = bounded((kww_mom.abs() / kww_close.abs().max(1.0)).min(1.0));
    let trend_strength = if window.len() >= 2 {
        let first = window.first().copied().unwrap_or(kww_close);
        let last = window.last().copied().unwrap_or(kww_close);
        bounded(((last - first).abs() / first.abs().max(1.0)).min(1.0))
    } else {
        momentum_score
    };
    let cycle_score = 1.0 - (((candles_since_signal % BASE) as f64 / BASE as f64) - 0.5).abs() * 2.0;
    let volume_score = bounded((kww_volume / (kww_volume + kww_close.abs() + 1.0)).abs());
    let dim_score = bounded(
        trend_direction * 0.20 + momentum_score * 0.20 + trend_strength * 0.1667 + cycle_score * 0.0667 + volume_score * 0.0333,
    );
    [dim_score, trend_direction, momentum_score, trend_strength, cycle_score, volume_score]
}
// ---- end copy ----

fn lcg(seed: &mut u64) -> f64 {
    *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    ((*seed >> 11) as f64) / ((1u64 << 53) as f64)
}

fn num(x: f64) -> String { if x.is_finite() { format!("{:?}", x) } else { "null".into() } }
fn arr(v: &[f64]) -> String { format!("[{}]", v.iter().map(|x| num(*x)).collect::<Vec<_>>().join(",")) }

fn main() {
    let mut out = Vec::new();
    let mut seed = 7u64;
    for (case, n, base) in [("w100", 100usize, 2000.0), ("w37", 37, 65000.0), ("w2", 2, 1.5), ("w1", 1, 30.0), ("w19", 19, 0.8)] {
        let mut window = Vec::new();
        let mut p = base;
        for _ in 0..n { p *= 1.0 + (lcg(&mut seed) - 0.5) * 0.02; window.push(p); }
        let volume = lcg(&mut seed) * 5000.0;
        let kc = kww_ma(&window);
        let km = kww_momentum(&window);
        let since = window.len().saturating_sub(1) as u32;
        let mut tfs = Vec::new();
        for tf in ["5m", "15m", "1h", "4h", "1d", "1w"] {
            let d = dimension(kc, volume, km, since, &window);
            tfs.push(format!("\"{}\":{{\"tf_score\":{},\"dim\":{}}}", tf, num(timeframe_weight(tf)), arr(&d)));
        }
        out.push(format!(
            "{{\"name\":\"{}\",\"window\":{},\"volume\":{},\"kww_close\":{},\"kww_momentum\":{},\"memory_weight\":{},\"candles_since_signal\":{},\"tf\":{{{}}}}}",
            case, arr(&window), num(volume), num(kc), num(km), num(kww_memory(since as f64)), since, tfs.join(",")
        ));
    }
    let phis: Vec<String> = [0.0, 0.2, 0.44999, 0.45, 0.6, 0.65, 0.7, 0.75, 0.8, 0.9, 0.95, 1.0]
        .iter()
        .map(|&p| format!("{{\"phi\":{},\"tier\":\"{}\",\"rank\":{},\"size_pct\":{}}}", num(p), signal_tier(p), signal_rank(p), num(position_size_pct(signal_rank(p)))))
        .collect();
    let regimes: Vec<String> = [0.0, 0.5, 0.7, H_QURAN, 0.95].iter().map(|&h| format!("[{},{}]", num(h), num(regime_score(h, 0.15)))).collect();
    println!(
        "{{\"generator\":\"tools/parity/mizan-fixtures\",\"constants\":{{\"BETA\":{},\"TAU\":{},\"BASE\":{},\"PHI\":{},\"H_QURAN\":{},\"ATR_MULT\":{},\"MAX_ALLOC\":{},\"CONFIDENCE\":{},\"sl_atr\":{},\"tp_atr\":{}}},\"kww\":[{}],\"phi\":[{}],\"rust_regime_score\":[{}]}}",
        num(BETA), num(TAU), BASE, num(PHI), num(H_QURAN), num(ATR_MULT), num(MAX_ALLOC), num(CONFIDENCE), num(sl_atr()), num(tp_atr()),
        out.join(","), phis.join(","), regimes.join(",")
    );
}
