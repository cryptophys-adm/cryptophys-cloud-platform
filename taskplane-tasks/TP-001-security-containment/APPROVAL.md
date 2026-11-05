# TP-001: Gate record (authoritative for the worker)

The worker does not read PR comments, so gate decisions for this task are recorded here.

| Gate | Decision | By | When |
|---|---|---|---|
| Step 2 (v1): make platform-gitops private | **DONE** (both gitops repositories report private) | owner, recorded by the orchestrator | 2026-11-04 |
| Plan v2: containment by cluster retirement (replaces Vault rekey and NATS/ArgoCD rotation) | **OWNER AUTHORIZATION: GRANTED** ("setuju") | owner, recorded by the orchestrator | 2026-11-05 |
| A1–A4 artifact review | **VALIDATED FOR NON-DISCLOSURE ONLY** (PR #75 merged; the shared artifacts contain no secret values, partial identifiers, derived wallet addresses or key fingerprints). This does not mark A1 fingerprint re-validation or A2 wallet validation complete; see `STATUS.md`. | orchestrator | 2026-11-05 |
| B1 Binance | **DONE, as stated by the owner** ("Bagian A sudah selesai, bagian B1,2,4,5 juga sudah dilakukan owner"). Not independently verifiable: the worker and orchestrator may not use the credential. | owner | 2026-11-05 |
| B2 Wallet | **DONE, as stated by the owner** ("Bagian A sudah selesai, bagian B1,2,4,5 juga sudah dilakukan owner"). The source key stays compromised and must never be used (it matches a public test vector; see STATUS A2). | owner | 2026-11-05 |
| B3 Cluster retirement | **DONE, as stated by the owner** ("cluster talos juga sudah musnah": the Talos cluster has been destroyed). Vault unseal shares, NATS users and ArgoCD reconcile tokens are contained by retirement. Provider evidence is optional; attach it to `STATUS.md` if available. | owner | 2026-11-05 |
| B4 External issuer rotation (items #1–#20 in credential-issuers.md) | **DONE, as stated by the owner** ("Bagian A sudah selesai, bagian B1,2,4,5 juga sudah dilakukan owner"). Not independently verifiable. | owner | 2026-11-05 |
| B5 Archive or delete the gitops repositories | **PARTIAL / AWAITING_OWNER**: `apps-gitops` is verified by the GitHub API as `private: true, archived: true`; `platform-gitops` is `private: true, archived: false` in the current GitHub API response (2026-11-05). This conflicts with the owner's statement ("sudah diarsip"). Do not mark B5 done until the API reports `archived: true` or the repository is deleted, or the owner formally amends the B5 requirement. | orchestrator verification | 2026-11-05 |

Close PR #46 (stale base). Do the v2 work on a fresh branch from `main`, named `worker/TP-001-v2-containment`.

**TP-001 remains `awaiting_owner`**: B5 is incomplete because the current GitHub API reports `platform-gitops` as not archived. The previous all-gates-closed statement is withdrawn pending owner resolution.
