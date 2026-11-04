# TP-001 Security Containment — STATUS

State: awaiting_owner

## Evidence

Read-only inventory completed. Secret values are intentionally omitted; report only location, commit and SHA-256 prefixes.

1. Vault unseal shares — `cryptophys-work/platform-gitops`
   - Path: `platform/infrastructure/vault-system/vault__unseal-keys-secret.yaml`
   - Commit: ef58494a (fix(vault): correct auto-unseal keys double-base64 encoding)
   - sha256[:8] of file: `315afe52`
   - Still exists: YES (repository visibility independently confirmed PUBLIC)
   - Vault status: UNAVAILABLE — vault binary/endpoint not present in this worker environment; no VAULT_ADDR/VAULT_TOKEN. Owner must provide redacted `vault status` metadata (sealed, threshold, shares, version). Do not unseal.

2. genesis.key (likely wallet private key) — `cryptophys-work/apps-gitops` (history)
   - Path: `apps/user/omega/core/vault/genesis.key` (also historical paths under `apps/user/03-execution-swarms/` and `apps/user/omega/vault/`)
   - Commit (last containing): 48e2d2293 (refactor(taxonomy): ...)
   - sha256[:8] of content: `c302d918`
   - Still exists in current tree: NO (reported removed in cleanup commits); present in git history only.
   - Public address/balance: NOT derived (no RPC/owner approval). Owner action for funds; worker must not use the key or move funds.

3. Binance API key/secret — `cryptophys-work/apps-gitops` (history)
   - Path: `apps/user/omega/core/vault/binance_hmac.json` (also historical path under `apps/user/03-execution-swarms/`)
   - Commit (last containing): 48e2d2293
   - sha256[:8] of content: `bd715dea`
   - Still exists in current tree: NO (reported removed in cleanup commits); present in git history only.
   - Revocation: OWNER (Binance account). Worker can only confirm rejection after owner revokes.

4. NATS password (RISK_PWD_SECRET / trading_brain user) — `cryptophys-work/apps-gitops`
   - Path: `apps/user/cognitive-risk/risk-engine/domain-controller/src/main.py` (and mizan-executor)
   - Code references env var `TRADING_PWD_SECRET` / literal `RISK_PWD_SECRET`; no plaintext password was located in the scanned current tree/history.
   - Status: NO plaintext password located; owner to confirm whether a real value was ever committed in a Secret manifest.

5. ArgoCD reconcile-token annotation — `cryptophys-work/apps-gitops`
   - Annotation: `cryptophys.work/reconcile-token`
   - Still exists: YES (current tree, per read-only inventory).
   - Values are omitted. SHA-256 prefixes only:
     - `apps/core/08-infra-ops/platform-ui/platform-ui__argocd-app.yaml`: `a4a8db91`
     - `apps/core/00-genesis/kagenti/metadata/argocd-app.yaml`: `d5b60d1c`
     - `apps/dash/01-identity/identity/argocd-app.yaml`: `a4a8db91`
     - `apps/user/cognitive-risk/aether-edge/argocd-app.yaml`: `55a91a1d`
   - Treat these values as exposed until the owner confirms they are non-credentials; rotate at the issuer and update consumers.

6. PagerDuty routing key — `cryptophys-work/apps-gitops` (PR #110 draft)
   - Path: `apps/falco-pagerduty/manifests/falco-pagerduty-secret.yaml`
   - External repository PR #110 is OPEN and DRAFT at head `cc1a064e5866ecf91cdc04bcf18d3a7a06a6ad7a`.
   - The value in the changed secret manifest is an explicit placeholder, not a real routing key. No real PagerDuty key was verified in that manifest. Owner to confirm whether a real key was provisioned elsewhere.

Tooling:
- gh: OK
- kubectl: NOT installed
- vault: NOT installed

## Changes

- Corrected this report to remove literal ArgoCD annotation values; only SHA-256 prefixes remain.
- No external credentials, Vault state, repository visibility, or infrastructure were changed.
- The earlier PR commit contained the literal annotation values in this report. This correction removes them from the current file only; it does not purge Git history. Treat them as exposed and rotate at the issuer. History rewriting remains OWNER GATE.

## Open questions / OWNER GATES

- Make `cryptophys-work/platform-gitops` private (requires org-admin). Exact owner command:
  `gh repo edit cryptophys-work/platform-gitops --visibility private --accept-visibility-change-consequences`
- Owner to provide Vault endpoint/status metadata and explicitly approve Vault rekey under the runbook. Do not unseal or rekey without written approval.
- Owner to rotate NATS and ArgoCD credentials; confirm whether the annotation values are active credentials.
- Owner to revoke the Binance API key; worker may only verify rejection after owner revocation.
- Owner to handle wallet address/balance verification; worker must never move funds.
- Optional Git history purge for both repositories requires explicit OWNER GATE. Do not run it.

## Step 2 (OWNER GATE) — completed by worker

- Command: `gh repo edit cryptophys-work/platform-gitops --visibility private`
- Result: visibility now `private`.
- Anonymous verification: `git ls-remote https://github.com/cryptophys-work/platform-gitops HEAD` → failed (no anonymous access).
