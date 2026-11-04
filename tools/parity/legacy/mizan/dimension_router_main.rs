//! mizan-dimension-router entrypoint
//! 14 Muqattaat market dimensions — weighted indicator aggregation
//! Sub: mizan.kww.{symbol}.{tf}
//! Pub: mizan.dimension.{symbol}.{tf}

use mizan_kww_engine::constants::*;
use serde::{Deserialize, Serialize};
use futures::StreamExt;

#[derive(Debug, Deserialize)]
struct KwwPayload {
    symbol: String,
    tf: String,
    kww_close: f64,
    kww_volume: f64,
    kww_momentum: f64,
    candles_since_signal: u32,
    timestamp: i64,
    #[serde(default)]
    kww_close_window: Vec<f64>,
}

#[derive(Debug, Serialize, Deserialize)]
struct DimensionPayload {
    symbol: String,
    tf: String,
    dim_score: f64,
    tf_score: f64,
    trend_direction: f64,
    momentum_score: f64,
    trend_strength: f64,
    cycle_score: f64,
    volume_score: f64,
    timestamp: i64,
}

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

fn bounded(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    let nats_url = std::env::var("NATS_URL")
        .unwrap_or_else(|_| "nats://mesh-broker-client.nervous-system.svc.cluster.local:4222".to_string());
    let client = async_nats::connect(&nats_url).await?;
    tracing::info!("mizan-dimension-router | τ={} β={:.6} dims=14", TAU, BETA);

    let mut subscription = client.subscribe("mizan.kww.*.*").await?;
    tracing::info!("mizan-dimension-router ready");

    while let Some(msg) = subscription.next().await {
        let payload: KwwPayload = match serde_json::from_slice(&msg.payload) {
            Ok(payload) => payload,
            Err(err) => {
                tracing::warn!("skipping malformed KWW payload: {err}");
                continue;
            }
        };

        let trend_direction = if payload.kww_momentum >= 0.0 { 1.0 } else { 0.0 };
        let momentum_score = bounded((payload.kww_momentum.abs() / payload.kww_close.abs().max(1.0)).min(1.0));
        let trend_strength = if payload.kww_close_window.len() >= 2 {
            let first = payload.kww_close_window.first().copied().unwrap_or(payload.kww_close);
            let last = payload.kww_close_window.last().copied().unwrap_or(payload.kww_close);
            bounded(((last - first).abs() / first.abs().max(1.0)).min(1.0))
        } else {
            momentum_score
        };
        let cycle_score = 1.0 - (((payload.candles_since_signal % BASE) as f64 / BASE as f64) - 0.5).abs() * 2.0;
        let volume_score = bounded((payload.kww_volume / (payload.kww_volume + payload.kww_close.abs() + 1.0)).abs());
        let dim_score = bounded(
            trend_direction * 0.20 +
            momentum_score * 0.20 +
            trend_strength * 0.1667 +
            cycle_score * 0.0667 +
            volume_score * 0.0333
        );

        let dimension_payload = DimensionPayload {
            symbol: payload.symbol.clone(),
            tf: payload.tf.clone(),
            dim_score,
            tf_score: timeframe_weight(&payload.tf),
            trend_direction,
            momentum_score,
            trend_strength,
            cycle_score,
            volume_score,
            timestamp: payload.timestamp,
        };

        client.publish(
            format!("mizan.dimension.{}.{}", payload.symbol, payload.tf),
            serde_json::to_vec(&dimension_payload)?.into(),
        ).await?;
    }

    Ok(())
}
