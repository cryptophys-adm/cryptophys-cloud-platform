# TP-001: Gate record (authoritative for the worker)

The worker does not read PR comments, so gate decisions for this task are recorded here.

| Gate | Decision | By | When |
|---|---|---|---|
| Step 2 (v1): make platform-gitops private | **DONE** (both gitops repositories report private) | owner, recorded by the orchestrator | 2026-11-04 |
| Plan v2: containment by cluster retirement (replaces Vault rekey and NATS/ArgoCD rotation) | **Proposed by the orchestrator**, awaiting owner confirmation | — | 2026-11-05 |
| A1–A4 read-only steps | **AUTHORIZED** (read-only; no secret output; no use of any credential) | orchestrator | 2026-11-05 |
| B1 Binance | awaiting owner | — | — |
| B2 Wallet | awaiting owner | — | — |
| B3 Cluster retirement | awaiting owner | — | — |
| B4 External issuer rotation | awaiting owner, after A3 | — | — |
| B5 Archive or delete the gitops repositories | awaiting owner | — | — |

Close PR #46 (stale base). Do the v2 work on a fresh branch from `main`, named `worker/TP-001-v2-containment`.
