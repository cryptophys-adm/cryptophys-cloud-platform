# ADR-0005: Transform the Kubernetes GitOps estate into Cloudflare

- **Status:** Accepted
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
     - It fetches **closed** klines from Binance's public market-data API (`data-api.binance.vision`, no keys).
     - It computes the indicators deterministically.
     - It stores candles and indicators in D1, then exposes them read-only behind Access.
   - Usage: about 3k invocations, 30k subrequests and well under 100k D1 rows written per month, all far inside the included quotas.
7. **xauusd integration without modifying its repository.**
   - The live xauusd Workers are registered in the Platform Registry as externally deployed services (`metadata.deployed_by = cryptophys-adm/xauusd-ai-trading-assistant`).
   - The Drift Detector probes their `/health` through service bindings.
   - Their releases stay in the xauusd repository's own workflows.
   - The XAUUSD Mizan/Prophet/GMI engines remain owned by xauusd and gated by its parity requirements.

## Security

`cryptophys-work/platform-gitops` is publicly readable and commits `platform/infrastructure/vault-system/vault__unseal-keys-secret.yaml`. That file holds three high-entropy values in Vault Shamir share format (33 bytes each). They must be treated as compromised:

1. Make the repository private.
2. `vault operator rekey`.
3. Rotate every secret held in that Vault, at minimum the Binance and NATS credentials used by `apps-gitops`.
4. Purge the file from history.

None of these secrets is carried into Cloudflare. The equivalents are new Worker secrets.

## Consequences

- Kubernetes-only machinery (53 components) is retired. 37 components are already replaced by operational Cloudflare capabilities. 8 have a named Cloudflare equivalent and migrate when a consumer needs them.
- 13 components are blocked for lack of source, and 9 are prohibited. They are listed, not silently dropped.
- The cluster can be decommissioned once the owner confirms that nothing outside this inventory depends on it. Decommissioning is an owner action on the cluster and is not automated from here.
