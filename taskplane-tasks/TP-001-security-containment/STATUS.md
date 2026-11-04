# TP-001 Security Containment — STATUS

State: awaiting_owner

## Evidence

Read-only inventory completed. Secret values are intentionally omitted; report only locations, commits and SHA-256 prefixes.

1. Vault unseal shares — `cryptophys-work/platform-gitops`
   - Path: `platform/infrastructure/vault-system/vault__unseal-keys-secret.yaml`
   - Commit: ef58494a (fix(vault): correct auto-unseal keys double-base64 encoding)
   - sha256[:8] of file: `315afe52`
   - Current tree: YES (verified by recursive Git tree inspection).
   - Repository visibility: PRIVATE (verified from current GitHub repository metadata). The repository is no longer anonymously readable, but the committed material remains in the current tree/history and must still be treated as compromised.
   - Vault status: UNAVAILABLE — Vault CLI/endpoint and VAULT_ADDR/VAULT_TOKEN are not available in this worker environment. Owner must provide redacted `vault status` metadata (sealed, threshold, shares, version). Do not unseal.

2. `genesis.key` (likely wallet private key) — `cryptophys-work/apps-gitops` history
   - Path: `apps/user/omega/core/vault/genesis.key` (also historical paths under `apps/user/03-execution-swarms/` and `apps/user/omega/vault/`)
   - Commit (last containing): 48e2d2293 (refactor(taxonomy): ...)
   - sha256[:8] of content: `c302d918`
   - Current tree: NO (verified by recursive Git tree inspection); present in Git history only.
   - Public address/balance: NOT derived. Owner handles funds; worker must not use the key or move funds.

3. Binance API key/secret — `cryptophys-work/apps-gitops` history
   - Path: `apps/user/omega/core/vault/binance_hmac.json` (also historical path under `apps/user/03-execution-swarms/`)
   - Commit (last containing): 48e2d2293
   - sha256[:8] of content: `bd715dea`
   - Current tree: NO (verified by recursive Git tree inspection); present in Git history only.
   - Revocation: OWNER (Binance account). Worker may only confirm rejection after owner revokes.

4. NATS weak literal password — `cryptophys-work/apps-gitops`
   - Source: `apps/user/cognitive-risk/risk-engine/domain-controller/src/main.py` and related mizan-executor configuration.
   - The corrected TP-001 prompt on main records that the committed literal is a 14-character environment-variable-style name used as the password, not a random secret.
   - Status: NOT VERIFIED whether the NATS server accepts it. Owner/authorized operator must confirm rejection or rotate the affected NATS users. Do not disclose the literal.

5. ArgoCD reconcile-token annotations — `cryptophys-work/apps-gitops`
   - Annotation: `cryptophys.work/reconcile-token`
   - Locations and SHA-256 prefixes from the read-only inventory:
     - `apps/core/08-infra-ops/platform-ui/platform-ui__argocd-app.yaml`: `a4a8db91`
     - `apps/core/00-genesis/kagenti/metadata/argocd-app.yaml`: `d5b60d1c`
     - `apps/dash/01-identity/identity/argocd-app.yaml`: `a4a8db91`
     - `apps/user/cognitive-risk/aether-edge/argocd-app.yaml`: `55a91a1d`
   - Values are omitted. Treat them as exposed until the owner confirms they are non-credentials; rotate at the issuer and update consumers.

PagerDuty was removed from TP-001 scope by the corrected prompt merged in PR #49: the value inspected in apps-gitops#110 was a placeholder, not a verified live routing key.

## Tooling and access

- gh: OK
- kubectl: NOT installed
- vault: NOT installed
- GitHub metadata: `cryptophys-work/platform-gitops` and `cryptophys-work/apps-gitops` both currently report PRIVATE.
- Recursive tree inspection: complete (not truncated) for both repositories; no secret file contents were fetched.

## Changes

- Removed the obsolete PagerDuty item and aligned the NATS finding with the corrected TP-001 prompt on main (PR #49).
- Corrected the Vault repository visibility from PUBLIC to PRIVATE based on current GitHub metadata; confirmed the Vault manifest path still exists in the current tree.
- Confirmed the wallet and Binance files are absent from the current apps-gitops tree; their historical commits remain relevant.
- Earlier PR history contained literal ArgoCD annotation values in this report. The current file omits them, but this update does not purge Git history. Treat them as exposed and rotate at the issuer. History rewriting remains an OWNER GATE.
- No Vault state, credential, Binance key, NATS user, ArgoCD token, wallet, Cloudflare resource, or production infrastructure was changed by this report update.

## Owner gates / remaining work

- Step 2 (make platform-gitops private): completed by the worker after owner approval was recorded in PR #46. Current GitHub metadata confirms PRIVATE visibility; the worker previously reported anonymous `git ls-remote` access was denied.
- Vault rekey: OWNER GATE. Requires Vault endpoint/status and explicit approval under the platform-gitops runbook. Do not unseal or rekey without written authorization.
- ArgoCD: owner/authorized operator to confirm whether the annotations are active credentials, rotate them at the issuer, update consumers, and provide successful health evidence.
- NATS: owner/authorized operator to verify the old weak literal is rejected by the server or rotate the affected users; report only redacted evidence.
- Binance: owner revokes the historical API key; worker may only perform a rejection check after owner revocation.
- Wallet: owner handles address/balance decisions and all funds. Worker must not use the key or move funds.
- Optional Git history purge for both repositories requires explicit OWNER GATE; propose a plan only, do not run it.

## Step 2 note

Owner approval: confirmed by owner to orchestrator, 2026-11-04
