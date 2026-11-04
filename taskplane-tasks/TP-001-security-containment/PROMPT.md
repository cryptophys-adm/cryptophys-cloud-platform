# TP-001 — Contain leaked credentials (OWNER GATES)

**Why:** ADR-0005 §Security found the following.
- `cryptophys-work/platform-gitops` is publicly readable and commits three Vault unseal shares in `platform/infrastructure/vault-system/vault__unseal-keys-secret.yaml`.
- `cryptophys-work/apps-gitops` history contains:
  - `apps/user/03-execution-swarms/omega/core/vault/genesis.key`, a 64-hex value that is likely a wallet private key;
  - `.../omega/core/vault/binance_hmac.json`, a Binance API key and secret;
  - a NATS literal password (`risk_guard` / `trading_brain` users). The committed literal is a 14-character env-var-style name, not a random secret; confirm that the NATS server does not accept it.
  - an ArgoCD `cryptophys.work/reconcile-token` annotation.
- *(Corrected 2026-11-04 after the worker's inventory, PR #46.)* The `PAGERDUTY_ROUTINGKEY` in the draft PR `cryptophys-work/apps-gitops#110` is a placeholder, not a real key. It is not part of this task.

All of these values must be treated as public.

## Steps

1. **Read-only inventory.** Confirm each item above still exists. Report its path, commit and `sha256[:8]` only. For Vault, record `vault status` (sealed, threshold, shares, version) without unsealing anything.
2. **OWNER GATE: make `cryptophys-work/platform-gitops` private.** This needs org-admin rights. If your `gh` token has them, run `gh repo edit cryptophys-work/platform-gitops --visibility private --accept-visibility-change-consequences`. Otherwise set `State: awaiting_owner` and give the owner that exact command. Verify with an unauthenticated `git ls-remote https://github.com/cryptophys-work/platform-gitops HEAD`; it must fail.
3. **OWNER GATE: Vault rekey.** Follow `platform/docs/runbooks/vault-unseal-procedure.md` from platform-gitops.
   - Run `vault operator rekey -init` with new shares and threshold that the owner chooses.
   - Deliver the new shares only to the owner's chosen holders, out of band. They must never be written to git, a ticket or a log.
   - Then delete the in-cluster `vault-system/vault-unseal-keys` Secret, and the auto-unseal controller's dependency on it, with the owner's approval.
   - Evidence: `vault status` before and after, showing the new key count and threshold. No shares.
4. **Rotate dependent secrets.** Do this in Vault and in the systems themselves:
   - NATS users;
   - the ArgoCD `reconcile-token` annotations.
   Evidence: the name and `sha256[:8]` of the old and new values, plus a successful consumer health check after rotation.
5. **OWNER GATE: Binance and wallet.**
   - **Binance:** the owner revokes the API key in the Binance account. You only confirm with a single unauthenticated-equivalent check that the old key is rejected, or state that you cannot.
   - **`genesis.key`:** derive the public address locally, without printing the key, and report the address and its on-chain balance using a public read-only RPC. Moving funds is the owner's action, never yours.
6. **History purge (optional, OWNER GATE).** Propose a `git filter-repo` plan for both repositories. Do not run it. Rewriting history is irreversible and needs every clone re-cut.

**Done when:** `platform-gitops` is not anonymously readable, Vault is rekeyed, the leaked credentials are revoked or rotated with evidence, and `STATUS.md` lists any item that only the owner can finish.
