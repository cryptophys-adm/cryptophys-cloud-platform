//! mizan-confluence entrypoint
//! Sub: mizan.dimension.{symbol}.{tf}
//! Pub: mizan.confluence.{symbol}.{tf}
//! Gate: publishes mizan.signal.{symbol}.{tf} when phi >= CONFIDENCE_MIN

use std::collections::HashMap;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use mizan_confluence::{signal_rank, signal_tier, position_size_pct, sl_atr, tp_atr};
use mizan_kww_engine::constants::CONFIDENCE;

#[derive(Debug, Deserialize)]
struct DimensionPayload {
    symbol: String,
    tf: String,
    dim_score: f64,
    tf_score: f64,
    timestamp: i64,
}

#[derive(Debug, Deserialize, Clone)]
struct RegimePayload {
    symbol: String,
    regime_score: f64,
    regime_zone: String,
}

#[derive(Debug, Serialize)]
struct ConfluencePayload {
    symbol: String,
    tf: String,
    phi: f64,
    dim_score: f64,
    tf_score: f64,
    regime_score: f64,
    signal_tier: String,
    signal_rank: u32,
    position_size_pct: f64,
    sl_atr: f64,
    tp_atr: f64,
    regime_zone: String,
    timestamp: i64,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    let nats_url = std::env::var("NATS_URL")
        .unwrap_or_else(|_| "nats://mesh-broker-client.nervous-system.svc.cluster.local:4222".to_string());
    let client = async_nats::connect(&nats_url).await?;
    let mut dimension_sub = client.subscribe("mizan.dimension.*.*").await?;
    let mut regime_sub = client.subscribe("mizan.regime.*").await?;
    let mut regime_by_symbol: HashMap<String, RegimePayload> = HashMap::new();
    tracing::info!("mizan-confluence | confidence_min={}", CONFIDENCE);
    tracing::info!("mizan-confluence ready");

    loop {
        tokio::select! {
            Some(msg) = regime_sub.next() => {
                match serde_json::from_slice::<RegimePayload>(&msg.payload) {
                    Ok(payload) => {
                        regime_by_symbol.insert(payload.symbol.clone(), payload);
                    }
                    Err(err) => tracing::warn!("skipping malformed regime payload: {err}"),
                }
            }
            Some(msg) = dimension_sub.next() => {
                let payload: DimensionPayload = match serde_json::from_slice(&msg.payload) {
                    Ok(payload) => payload,
                    Err(err) => {
                        tracing::warn!("skipping malformed dimension payload: {err}");
                        continue;
                    }
                };

                let regime = regime_by_symbol.get(&payload.symbol).cloned().unwrap_or(RegimePayload {
                    symbol: payload.symbol.clone(),
                    regime_score: 1.0,
                    regime_zone: "unknown".to_string(),
                });

                let phi = (payload.dim_score * payload.tf_score * regime.regime_score).clamp(0.0, 1.0);
                let rank = signal_rank(phi);
                let confluence = ConfluencePayload {
                    symbol: payload.symbol.clone(),
                    tf: payload.tf.clone(),
                    phi,
                    dim_score: payload.dim_score,
                    tf_score: payload.tf_score,
                    regime_score: regime.regime_score,
                    signal_tier: signal_tier(phi).to_string(),
                    signal_rank: rank,
                    position_size_pct: position_size_pct(rank),
                    sl_atr: sl_atr(),
                    tp_atr: tp_atr(),
                    regime_zone: regime.regime_zone.clone(),
                    timestamp: payload.timestamp,
                };

                client.publish(
                    format!("mizan.confluence.{}.{}", payload.symbol, payload.tf),
                    serde_json::to_vec(&confluence)?.into(),
                ).await?;

                if phi >= CONFIDENCE {
                    client.publish(
                        format!("mizan.signal.{}.{}", payload.symbol, payload.tf),
                        serde_json::to_vec(&confluence)?.into(),
                    ).await?;
                }
            }
            else => break,
        }
    }

    Ok(())
}
