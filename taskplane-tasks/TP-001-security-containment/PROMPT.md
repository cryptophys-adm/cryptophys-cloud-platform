# TP-001: Contain leaked credentials (revised 2026-11-05)

**Worker:** pi agent on the VPS (read-only steps only). **Owner:** every revoke, move, delete or archive.

## Why this plan changed

The owner decided on 2026-11-04 that the Talos/Kubernetes cluster is **deprecated** and its data is not kept.

- **Containment by retirement.** Secrets that only ever lived *inside* the cluster (Vault unseal shares, NATS users, ArgoCD reconcile tokens) are contained by turning the cluster off for good and destroying its disks. Rekeying Vault or rotating NATS and ArgoCD on a cluster that is being destroyed adds risk and no value.
- **External credentials stay live.** What remains dangerous are credentials that work **outside** the cluster: the Binance API key, the `genesis.key` wallet, and any credential Vault held that is valid at an external issuer.
- **History still matters.** Both gitops repositories are now private, but they were readable before, so every value in their history must be treated as public, whatever happens to the repositories.

The read-only inventory from the first version (PR #46) remains valid evidence. Its findings are reused below.

## Steps

### A. Worker: read-only (no gate; open a PR from a fresh branch on `main`)

1. **Non-revealing Binance API-key fingerprint.**
   - From `binance_hmac.json` in apps-gitops history, identify the API-key value field without assuming its name. If the field is ambiguous, stop and report the ambiguity.
   - Report only the field name, source path/commit, and the first 8 hex characters of `sha256(API-key value)`. Do not report any prefix, suffix, substring, length, encoded form, file hash, blob hash, or full value of the key or its paired secret.
   - **Never output the secret or any part of either credential.** Never call any Binance endpoint with either value, signed or unsigned.
   - If the approved value fingerprint cannot be computed safely in memory, mark A1 incomplete; do not substitute a file/blob hash or a masked substring.
   - Purpose: provide a non-reversible evidence fingerprint for the owner; the owner must identify and revoke the key in Binance API Management.
2. **Wallet key containment (owner-only validation)** (`genesis.key`).
   - Treat the historical source key as compromised because it was stored in repository history that was readable before containment.
   - The worker must not derive an address, query any chain/RPC, inspect or report balances, nonces, transaction history, or other account metadata. Do not publish an address or any account identifier, even if the source is not recognized as a public test vector.
   - The owner must independently validate wallet ownership and determine disposition through a secure, controlled channel outside this shared repository. Any address or financial details must remain in that owner-controlled channel.
   - Never print, store, transmit, sign with, send, approve, import, or otherwise use the private key. Do not disclose a test-vector scalar or other key material.
3. **Inventory of what Vault and the cluster held.**
   - From the two repositories' current tree and history, list every secret **name and path**, never values: `ExternalSecret` / `SecretStore` refs, Vault paths, Kubernetes `Secret` names, and env vars that look like credentials (`*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASSWORD`).
   - For each, name the **issuer**: Cloudflare, GitHub, Binance, an exchange, email/SMTP, a cloud provider, an LLM provider, cluster-internal only, or unknown.
   - Write a table to `taskplane-tasks/TP-001-security-containment/credential-issuers.md`.
   - Items marked cluster-internal only are closed by step B3. Every other item is an owner rotation in B4.
4. **History purge plan, written only.** Since the repositories are deprecated, the recommended plan is **archive, or delete after a final local backup that the owner keeps offline**, instead of `git filter-repo`. Write both options with their consequences. Run neither.

### B. Owner: actions (OWNER GATES; record each in `APPROVAL.md`)

1. **Binance, today.**
   - In Binance, open API Management and delete the key matching A1. Also delete any other API key you do not actively use.
   - Check that no withdrawal address whitelist entry, sub-account or device was added that you do not recognise.
   - Change the account password and 2FA if anything looks unfamiliar.
2. **Wallet.**
   - If A2 identifies a publicly known test-vector key, treat it as compromised regardless of reported balances; withhold the address/account details and require owner validation through a secure channel.
   - If A2 shows any balance, tokens or recent transactions, the owner must move everything to a **new** wallet generated offline (a hardware wallet is preferred).
   - If balances are zero and there is no history, never reuse the old key or address; owner confirmation is still required when the source key is a known test vector.
   - If everything is zero and has no history, simply never use the address again.
3. **Cluster retirement (replaces the Vault rekey and the NATS/ArgoCD rotation).**
   - Power off every Talos node, and delete or wipe their disks and volumes at the provider. That includes Longhorn and MinIO volumes and Vault storage.
   - Delete any load balancer or DNS record that pointed at the cluster.
   - Evidence for `STATUS.md`: a provider screenshot or console output showing that the nodes and volumes are deleted.
4. **Rotate at external issuers.** For every non-internal item in A3, revoke the old credential at its issuer, even if it is unused now.
5. **Repositories.** Archive `cryptophys-work/platform-gitops` and `cryptophys-work/apps-gitops`, which keeps them private and read-only, or delete them after an offline backup. Their logic already lives in this repository (`tools/parity/legacy`, ADR-0005).

### C. Worker: verification, after the owner records B1 to B5

- A2 balances again, if B2 moved funds: confirm that the old address is empty.
- An anonymous `git ls-remote` against both repositories fails.
- `gh repo view` shows archived (or not found if deleted).
- Update `STATUS.md` with `State: done`.

**Done when:**
- the Binance key is deleted, confirmed by the owner;
- the wallet is empty or confirmed unused;
- the cluster is destroyed, with evidence;
- every external issuer item is rotated;
- both gitops repositories are archived or deleted.
