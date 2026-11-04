# ADR-0005: Transform the Kubernetes GitOps estate into Cloudflare

- **Status:** Accepted; decision 3 amended by [ADR-0007](0007-ai-worker-os.md) (tier 2 reversible agent actions under policy)
- **Date:** 2026-11-03
- **Owner decision:** "transform everything into the Cloudflare environment and ecosystem, stay within the Workers Paid plan, no containers" (repository owner, 2026-11-03).
- **Inventory:** [docs/TRANSFORMATION-INVENTORY.md](../../docs/TRANSFORMATION-INVENTORY.md), generated from `cryptophys-work/platform-gitops` and `cryptophys-work/apps-gitops`. All 122 components are listed there.

## Context

`platform-gitops` runs a self-hosted Talos Kubernetes platform: 33 Helm releases, including Flux/Argo CD, Cilium, MetalLB, Longhorn, CloudNativePG, Vault/ESO, SPIRE, Kyverno/Gatekeeper/Falco/Tetragon, Harbor, Gitea, Tekton, Prometheus/Loki, Velero/MinIO, Crossplane, KubeRay, Kagenti and Hyperledger Fabric. `apps-gitops` deploys 154 Deployments onto it. These include agent fleets, self-hosted LLMs, a NATS mesh, and a crypto signal pipeline with execution components and Binance keys.

`xauusd-ai-trading-assistant` is already Cloudflare-native: 4 live Workers, with a target of 9.

## Decision

1. **Cloudflare only.** Production runs on Workers, D1, KV, R2, Queues, Durable Objects, Workflows, Vectorize, Workers AI and Cloudflare Access. There are no containers (no Cloudflare Containers, no Kubernetes) and no self-hosted runtime.
2. **Workers Paid plan, included usage only.**
   - No paid add-on product is introduced.
   - Every design states its usage against the included quotas. Workers AI keeps the per-service and account daily budgets set in `AI-ENGINE-REQUIREMENT.md`.
   - Scheduled work uses Cron Triggers, not polling loops.
3. **Advisory only.** Trade execution, broker or exchange order APIs, and autonomous agents that execute, commit or remediate are **prohibited**: `apps-gitops` `core/03-autonomous-execution`, `user/03-execution-swarms` and `mizan-executor`. Market data uses public, read-only endpoints with no account keys.
4. **Port only what has source.** A component whose behaviour exists only as a container image is `blocked-no-source`. Its logic is not reinvented. It is migrated only when its source or a written contract is supplied.
5. **Capability mapping.**

   | Legacy | Cloudflare |
   | --- | --- |
   | Keycloak/oauth2-proxy/RBAC | Access + identity allow-lists |
   | SPIRE | RPC service bindings |
   | Vault/ESO | Worker secrets from the GitHub `production` Environment |
   | Kyverno/Gatekeeper | Policy Engine |
   | Argo/Flux drift | Drift Detector + drift-alert issue |
   | immudb/Fabric | Audit Ledger |
   | Velero | D1 Time Travel |
   | Postgres | D1 |
   | MinIO/Longhorn | R2/D1/KV |
   | Qdrant/Milvus | Vectorize |
   | NATS | Queues (async) and service bindings (sync) |
   | Ollama/Ray/bitnet | Workers AI |
   | Tekton/Harbor/Gitea/Argo CD | GitHub + GitHub Actions + Wrangler |

6. **First migrated workload: `cryptophys-signal-engine`.**
   - It ports the trend and volume indicator engines, which are the only signal engines with source.
   - A cron runs every 15 minutes:
     - It fetches **closed** candles from a keyless public market-data API. *(Amended 2026-11-04.)* Binance (`data-api.binance.vision`) answered HTTP 403 to every production run from Cloudflare (recorded in `signal_ingest_runs`), so the default provider is Kraken (`api.kraken.com`, 1h/4h OHLC). Candles from different providers are never mixed in one series.
     - It computes the indicators deterministically.
     - It stores candles and indicators in D1, then exposes them read-only behind Access.
   - Usage: about 3k invocations, 30k subrequests and well under 100k D1 rows written per month, all far inside the included quotas.
7. **xauusd integration without modifying its repository.**
   - The live xauusd Workers are registered in the Platform Registry as externally deployed services (`metadata.deployed_by = cryptophys-adm/xauusd-ai-trading-assistant`).
   - The Drift Detector probes their `/health` through service bindings.
   - Their releases stay in the xauusd repository's own workflows.
   - The XAUUSD Mizan/Prophet/GMI engines remain owned by xauusd and gated by its parity requirements.

8. **Recovered engines (2026-11-04).** The source of the "image only" engines was found in `apps-gitops` history: it had been committed and later deleted. The copies are in `tools/parity/legacy/`, with commits listed in `PROVENANCE.tsv`. The owner approved migrating them and turning `mizan-executor` into advisory risk levels; both are to be reassessed later.
   - **Signal engines.** Momentum, volatility, structure, the multi-timeframe aggregator and the decision engine now run in `cryptophys-signal-engine`.
     - They have parity with **`pandas_ta_classic` 0.4.47**, the version pinned in `signal-edge/requirements.txt`. The trend and volume kernels moved from 0.9.0 to 0.4.47; ADX, MFI and Supertrend differ between the two.
     - Fixtures are generated by running the recovered Python (`tools/parity/signal_fixtures.py`, `legacy_fixtures.py`).
   - **Mizan.** KWW, dimension-router, regime and confluence also run in the Signal Engine.
     - Rust fixtures come from compiling the recovered `lib.rs` files (`tools/parity/mizan-fixtures`).
     - Python fixtures come from the recovered `hurst.py`, with the deployment settings `H_QURAN=0.8453`, `HURST_SIGMA=0.15`, `ENTROPY_MAX=0.92`, `HURST_WINDOW=100`.
   - **Advisory risk levels** replace `mizan-executor`, which was a stub with no exchange calls.
     - They suggest a stop-loss of ATR(14) × 3.0508, a take-profit of that distance × φ, and the Bismillah size by rank.
     - They are emitted only where the source would have emitted `mizan.signal` (phi ≥ 0.60).
   - **Deliberate deviations, each a defect in the source:**
     1. Ichimoku, Bollinger and Keltner columns are read by name. The source read them by position and published the lower bands as "upper" and the Ichimoku spans as tenkan/kijun, which inverted the squeeze flag.
     2. The aggregator receives `close` with the trend indicators. The published trend payload lacked it, so every EMA comparison was dead code.
     3. The decision engine uses the intended base rate of 65/(65+35). The source called `base_rate_adjustment(tp=, fp=)` against parameters named `true_positives`/`false_positives`, so it raised `TypeError` and never published.
   - **Not migrated:** `forecasting.py` (it needs Prophet/Stan, which cannot run without containers), and corpus, omega and aether-edge (not yet assessed).
   - **Findings for the owner's reassessment.** The ported math is faithful, and these follow from it:
     - **Mizan phi** = dim_score × tf_weight × regime. The timeframe weight is at most 0.40 (5m) and 0.20 (1h), so phi can never reach the 0.45 "weak" tier, let alone the 0.60 signal threshold. Advisory risk levels are therefore never produced.
     - **Mizan regime** uses a 10-bin histogram entropy of *price levels*. This sits close to `ENTROPY_MAX` 0.92 for ordinary series: synthetic random walks exceeded it in the parity fixtures (`regime_score` 0), while live BTCUSDT 1h on 2026-11-04 read 0.903 (`regime_score` 0.41). The regime gate therefore switches on and off with the shape of the price distribution rather than with persistence.
     - **The decision engine** multiplies the 0–100 confluence by 0.65 before comparing it with BUY ≥ 62 and SELL ≤ 38. BUY needs a confluence of at least 95.4, while SELL triggers at 58.5 or below, which is a strong bearish bias.

9. **Assessment of corpus, omega, aether-edge and risk-engine (2026-11-04).** Their source was recovered from `apps-gitops` history and read before deciding.
   - **corpus: partly migrated.** Of 18 sources, only the keyless Fear & Greed index (`api.alternative.me`) and global market data (`api.coinlore.com`) are migrated, as hourly macro context in `cryptophys-signal-engine` (migration `0007`, `GET /v1/macro`). The rest:
     - **Dead:** the DEX sources on The Graph's hosted service.
     - **Need keys:** news, Twitter, FRED and Etherscan.
     - **Duplicate or blocked from Cloudflare:** Binance, Bybit and OKX.
     - **Deviation:** the source returned invented values on failure (`fng=50`, `dxy=103.5`, `vix=14.5`, with `confidence: 0.98`). The port stores nothing and records the failure.
     - `Macro_Score` is not computed, because 40% of its weight came from DXY/VIX scraped from an unofficial Yahoo endpoint.
   - **omega: prohibited, not migrated.** It contains order execution, request signing and MEV sandwich bundles against other users' transactions (`victim_tx_hash`, Flashbots relay).
   - **risk-engine: retired.** It is an execution gate whose "Z3 proof" uses hard-coded constants and whose crisis check always returns `False`. It needs live positions, which an advisory-only platform never has.
   - **aether-edge: retired.** It consists of physics metaphors in at least three overlapping versions:
     - the Lorentz factor of price velocity;
     - a "wave function";
     - an "entanglement" that is cosine similarity.
     Its formulas depend on scale (energy clamps to 1 for BTC), it needs order-book depth that is not ingested, and it has no specification or tests.

10. **Revised Mizan and decision formulas (owner decision 2026-11-04: "All").** The faithful ports stay in `mizan.ts` with their parity tests. Production uses `revised.ts` (`mizan-revised/1`), which makes four changes:
    1. **KWW recency.** The memory weight is `exp(-(lag/τ)^β)`, where lag 0 is the newest close. The source gave the oldest close weight 1.
    2. **Regime entropy.** Entropy is computed over log returns, not price levels. The gate is the per-symbol 95th percentile of rolling 100-candle entropies over the stored 1h history (628 windows on 2026-11-04). With fewer than 30 windows it falls back to the source's 0.92. If no regime is available, the score is 0 rather than the source's free 1.0.
    3. **phi per symbol.** `phi = Σ(w_tf · dim_tf) / Σ w_tf × regime_score`, using the source timeframe weights as mixing weights. The source multiplied each timeframe's dim by its weight, which capped phi at 0.40.
    4. **Symmetric decision.** BUY ≥ 62 / SELL ≤ 38 are applied to the raw confluence score. The 0.65 base rate stays only as the BUY win probability in EV/Kelly; the source also scaled the score by it.
    - **Before and after on production data (2026-11-04 07:10Z):**
      - **Regime score:** 0 → 0.28 for ETH and 0 → 0.42 for SOL. Both had been gated to "chaotic" by price-level entropy. BTC stayed at 0.33.
      - **KWW direction:** SOL flipped from down to up after its latest candles.
      - **Decision:** BTC at 42.7 and ETH at 53.3 moved from SELL to NEUTRAL. SOL at 34.5 stayed SELL.
      - **phi:** rose from 0–0.015 to 0.05–0.09.
    - **Remaining finding, not changed.** phi still cannot reach the signal threshold in ordinary markets, because the router's momentum and volume dimensions are `|Δkww| / price` and `volume / (volume + price)`. These sit near 1e-4, so `dim_score` stays near 0.23 of a 0.67 maximum, and advisory risk levels are not produced. Rescaling those dimensions would redesign Mizan and needs a separate owner decision.

## Security

`cryptophys-work/platform-gitops` is publicly readable and commits `platform/infrastructure/vault-system/vault__unseal-keys-secret.yaml`. That file holds three high-entropy values in Vault Shamir share format (33 bytes each). They must be treated as compromised:

1. Make the repository private.
2. `vault operator rekey`.
3. Rotate every secret held in that Vault, at minimum the Binance and NATS credentials used by `apps-gitops`.
4. Purge the file from history.

The recovered `apps-gitops` history also holds credentials that must be treated as compromised and rotated or abandoned:
- `apps/user/03-execution-swarms/omega/core/vault/genesis.key`: a 64-hex-character value, likely a private key, so any wallet it controls must be emptied;
- `omega/core/vault/binance_hmac.json`: a Binance HMAC API key and secret;
- a NATS password in `trading-decision`;
- a `reconcile-token` annotation in `aether-edge/argocd-app.yaml`.

None of these secrets is carried into Cloudflare. The equivalents are new Worker secrets.

## Consequences

- Kubernetes-only machinery (53 components) is retired. 37 components are already replaced by operational Cloudflare capabilities. 8 have a named Cloudflare equivalent and migrate when a consumer needs them.
- 13 components are blocked for lack of source, and 9 are prohibited. They are listed, not silently dropped.
- The cluster can be decommissioned once the owner confirms that nothing outside this inventory depends on it. Decommissioning is an owner action on the cluster and is not automated from here.
