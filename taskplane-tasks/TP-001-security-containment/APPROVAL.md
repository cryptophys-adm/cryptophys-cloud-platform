# TP-001: Gate record (authoritative for the worker)

The worker does not read PR comments, so gate decisions for this task are recorded here.

| Gate | Decision | By | When |
|---|---|---|---|
| Step 2 (v1): make platform-gitops private | **DONE** (both gitops repositories report private) | owner, recorded by the orchestrator | 2026-11-04 |
| Plan v2: containment by cluster retirement (replaces Vault rekey and NATS/ArgoCD rotation) | **OWNER AUTHORIZATION: GRANTED** ("setuju") | owner, recorded by the orchestrator | 2026-11-05 |
| A1–A4 read-only steps | **VALIDATED** (PR #75, which contains no secret values; #74 was withdrawn and closed unmerged) | orchestrator | 2026-11-05 |
| B1 Binance | **DONE, as stated by the owner** ("Bagian A sudah selesai, bagian B1,2,4,5 juga sudah dilakukan owner"). Not independently verifiable: the worker and orchestrator may not use the credential. | owner | 2026-11-05 |
| B2 Wallet | **DONE, as stated by the owner** ("Bagian A sudah selesai, bagian B1,2,4,5 juga sudah dilakukan owner"). The source key stays compromised and must never be used (it matches a public test vector; see STATUS A2). | owner | 2026-11-05 |
| B3 Cluster retirement | **DONE, as stated by the owner** ("cluster talos juga sudah musnah": the Talos cluster has been destroyed). Vault unseal shares, NATS users and ArgoCD reconcile tokens are contained by retirement. Provider evidence is optional; attach it to `STATUS.md` if available. | owner | 2026-11-05 |
| B4 External issuer rotation (items #1–#20 in credential-issuers.md) | **DONE, as stated by the owner** ("Bagian A sudah selesai, bagian B1,2,4,5 juga sudah dilakukan owner"). Not independently verifiable. | owner | 2026-11-05 |
| B5 Archive or delete the gitops repositories | **PARTIAL, by orchestrator verification (2026-11-05)**: `platform-gitops` is not anonymously readable. `apps-gitops` is **private but not archived**, per the GitHub API `archived: false`. Open until `apps-gitops` is archived or deleted, or the owner records that private-only is final. | owner (stated ("Bagian A sudah selesai, bagian B1,2,4,5 juga sudah dilakukan owner")) | 2026-11-05 |

Close PR #46 (stale base). Do the v2 work on a fresh branch from `main`, named `worker/TP-001-v2-containment`.
