# TP-001 Security Containment — STATUS

State: in_progress

## Evidence

Read-only inventory of leaked items (values not printed; sha256[:8] of file/content only).

1. Vault unseal shares — `cryptophys-work/platform-gitops`
   - Path: `platform/infrastructure/vault-system/vault__unseal-keys-secret.yaml`
   - Commit: ef58494a (fix(vault): correct auto-unseal keys double-base64 encoding)
   - sha256[:8] of file: `315afe52`
   - Still exists: YES (public repo)
   - Vault status: UNAVAILABLE — vault binary/endpoint not present in this worker environment; no VAULT_ADDR/VAULT_TOKEN. Owner must provide `vault status` output (sealed, threshold, shares, version). Do not unseal.

2. genesis.key (likely wallet private key) — `cryptophys-work/apps-gitops` (history)
   - Path: `apps/user/omega/core/vault/genesis.key` (also `apps/user/03-execution-swarms/...`, `apps/user/omega/vault/...`)
   - Commit (last containing): 48e2d2293 (refactor(taxonomy): ...)
   - sha256[:8] of content: `c302d918`
   - Still exists in current tree: NO (removed in cleanup commits) — present in git history only.
   - Public address/balance: NOT derived (no RPC/owner approval yet). Owner action for funds.

3. Binance API key/secret — `cryptophys-work/apps-gitops` (history)
   - Path: `apps/user/omega/core/vault/binance_hmac.json` (also `apps/user/03-execution-swarms/...`, `apps/user/omega/vault/...`)
   - Commit (last containing): 48e2d2293
   - sha256[:8] of content: `bd715dea`
   - Still exists in current tree: NO — present in git history only.
   - Revocation: OWNER (Binance account). Worker can only confirm rejection after owner revokes.

4. NATS password (RISK_PWD_SECRET / trading_brain user) — `cryptophys-work/apps-gitops`
   - Path: `apps/user/cognitive-risk/risk-engine/domain-controller/src/main.py` (and mizan-executor)
   - The code references env var `TRADING_PWD_SECRET` / literal `"RISK_PWD_SECRET"`; no plaintext password found in current tree or scanned history.
   - Status: NO plaintext password located; confirm via owner if a real value was ever committed in a Secret manifest.

5. ArgoCD reconcile-token annotation — `cryptophys-work/apps-gitops`
   - Paths: `apps/core/08-infra-ops/platform-ui/platform-ui__argocd-app.yaml`, `apps/core/00-genesis/kagenti/metadata/argocd-app.yaml`, `apps/dash/01-identity/identity/argocd-app.yaml`, `apps/user/cognitive-risk/aether-edge/argocd-app.yaml`
   - Annotation: `cryptophys.work/reconcile-token`
   - Still exists: YES (current tree). Values: vendor-mirror-v1, live-agentcards-v3, vendor-mirror-v1, user-aether-path-v2. sha256[:8] of each value reported by name only (not printed). Rotate with owner.

6. PagerDuty routing key — `cryptophys-work/apps-gitops` (PR #110 draft)
   - Path: `apps/falco-pagerduty/manifests/falco-pagerduty-secret.yaml` (commit 8a280536c)
   - Value in that commit: placeholder `YOUR_PAGERDUTY_INTEGRATION_KEY` (not a real key). sha256[:8] of file: `87f86de2`.
   - A real-looking key, if any, would be in the draft PR branch; not found in main. Owner to confirm PR #110 status.

Tooling:
- gh: OK
- kubectl: NOT installed
- vault: NOT installed

## Changes

None (read-only step 1).

## Open questions

- Owner: provide vault status output and endpoint; approve rekey (step 3) and Binance/wallet handling (step 5).
- platform-gitops is public; step 2 needs org-admin (gh token may lack rights) — owner to run `gh repo edit cryptophys-work/platform-gitops --visibility private --accept-visibility-change-consequences` if needed.
