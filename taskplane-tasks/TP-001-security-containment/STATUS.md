# TP-001 Security Containment (v2) — STATUS

State: done

## Evidence (Part A: Read-Only Containment Inventory, A1–A4)

A3 (issuer inventory) and A4 (written-only history plan) are recorded. A1 is pending compliant fingerprint re-validation, and A2 account details were withdrawn after identifying a public-test-vector disclosure risk. The earlier report's partial credential identifier and derived account disclosure are documented below and have been removed from this branch.

---

### A1. Binance Credential Field Inventory (Non-Revealing)

Inspection of `cryptophys-work/apps-gitops` Git history identified historical `api_key` and `api_secret` fields in `binance_hmac.json` at the paths listed below. The previous report included partial API-key characters and file/blob fingerprints; those identifiers have been withdrawn because they do not comply with the non-revealing evidence rule.

- **Fields:** `api_key` and `api_secret`.
- **Source paths:** `apps/user/omega/core/vault/binance_hmac.json`, `apps/user/omega/vault/binance_hmac.json`, and `apps/user/03-execution-swarms/omega/core/vault/binance_hmac.json`.
- **Source scope:** historical revisions of `cryptophys-work/apps-gitops` (including revisions around `48e2d2293`).
- **Fingerprint:** not recorded in this artifact. A1 must be rerun under the updated `PROMPT.md`; only the first eight hex characters of SHA-256 of the API-key value may be reported. Do not substitute a file hash, blob hash, length, or masked substring.
- **Secret handling:** no credential value is included here and no Binance API endpoint may be called.
- **Current tree:** the historical file is absent from `HEAD` of `cryptophys-work/apps-gitops`.

A1 is **pending compliant re-validation**. The owner must revoke the affected key and any other unused keys at Binance; this worker does not perform revocation.

---

### A2. Wallet Key Containment (Details Withheld)

The source `genesis.key` was identified in historical `cryptophys-work/apps-gitops` paths, including `apps/user/omega/core/vault/genesis.key`, `apps/user/omega/vault/genesis.key`, and `apps/user/03-execution-swarms/omega/core/vault/genesis.key`.

The previous report published a derived account identifier and explicitly associated it with a publicly known secp256k1 test-vector key. That association can disclose a publicly known signing key even without printing the raw file. The address, file fingerprint, chain balances, transaction counts, and nonce values have therefore been removed from this shared artifact.

Because the source key was stored in repository history that was readable before containment, it must be treated as compromised regardless of whether a public test-vector match can be independently confirmed.

- **Disposition:** never use the historical source key to sign, authorize, or control funds.
- **Worker boundary:** do not derive an address, query any chain/RPC, inspect or report balances, nonces, transaction history, or other account metadata. Do not publish an address or account identifier.
- **Evidence handling:** no private-key value, fingerprint, derived address, or account details are recorded here. Owner-only validation must occur through a secure, controlled channel outside this shared repository.
- **Prior activity:** the previous worker report stated that no transaction was signed or sent. That does not make the source key safe.
- **Owner gate B2:** owner must independently verify wallet ownership and determine the safe disposition. Do not rely on the withdrawn public report as proof of wallet ownership or zero exposure.

A2 is **awaiting owner validation**. No funds were moved and no wallet action was performed by this worker.

---


### A3. Inventory of What Vault and the Cluster Held

The full inventory of `ExternalSecret` / `ClusterExternalSecret` / `SecretStore` / `ClusterSecretStore` references, Vault KV paths, Kubernetes `Secret` resource names, and credential-shaped environment variables (`*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASSWORD`) across both `cryptophys-work/platform-gitops` and `cryptophys-work/apps-gitops` (current tree and Git history) is written to:

- [`taskplane-tasks/TP-001-security-containment/credential-issuers.md`](./credential-issuers.md)

Summary of findings in `credential-issuers.md`:
- **External / Unknown-Issuer Credentials (20 entries, Items #1–#20):** Categorized by issuer (**Binance**, **an exchange**, **Cloudflare**, **GitHub**, **an LLM provider**, **email/SMTP**, **a cloud provider**, and **unknown**) for owner revocation/rotation in **B1**, **B2**, and **B4**.
- **Cluster-Internal Only Credentials (8 subsystem groups, Items #21–#28):** Vault unseal shares and internal tokens, NATS JetStream mesh credentials and a weak literal credential reference, ArgoCD admin/server secrets and reconcile-token annotations, Gitea, Harbor, PostgreSQL/Redis/ImmuDB, MinIO/Velero, and Keycloak/OAuth2-Proxy/Grafana/Headlamp/Tekton/Cosign/WasmCloud/SPIRE/Kagenti internal secrets. All are **contained and closed by Step B3** (Talos cluster retirement, confirmed **DONE** by the owner on 2026-11-05).

---

### A4. History Purge Plan (Written Only — Neither Option Executed)

Because `cryptophys-work/platform-gitops` and `cryptophys-work/apps-gitops` are deprecated (their legacy reference logic already lives in `tools/parity/legacy` per ADR-0005) and both repositories were historically readable before being made private, rewriting history in place with `git filter-repo` adds operational risk without making previously exposed credentials safe. Instead, the owner should choose one of the two options below under **Gate B5** (neither has been run by the worker):

#### Option 1: Archive Both Repositories on GitHub (Recommended Default)
- **Procedure (Owner):**
  1. Ensure repository visibility remains **Private** (`gh repo view cryptophys-work/platform-gitops --json isPrivate` and `gh repo view cryptophys-work/apps-gitops --json isPrivate`).
  2. Archive both repositories (`gh repo archive cryptophys-work/platform-gitops --yes` and `gh repo archive cryptophys-work/apps-gitops --yes`, or via GitHub Settings -> Archive this repository).
  3. Revoke any remaining collaborator tokens, deploy keys, or webhooks on both repositories.
- **Consequences:**
  - Both repositories become strictly **private and read-only** (no pushes, PRs, issues, or workflow runs can be triggered).
  - Full historical commit graph and audit trail remain accessible to the owner on GitHub without risking accidental force-push corruption.
  - Historical blobs still exist inside the private GitHub archive, so **every external credential in `credential-issuers.md` (Part 1) MUST still be revoked at its issuer (B1, B2, B4)**.

#### Option 2: Delete Both Repositories on GitHub After an Offline Local Backup
- **Procedure (Owner):**
  1. Create a complete bare mirror backup of both repositories on an encrypted offline storage medium controlled by the owner:
     - `git clone --mirror git@github.com:cryptophys-work/platform-gitops.git platform-gitops.git`
     - `git clone --mirror git@github.com:cryptophys-work/apps-gitops.git apps-gitops.git`
     - Package and verify checksums (`tar -czf gitops-offline-backup-2026-11-05.tar.gz platform-gitops.git apps-gitops.git && sha256sum gitops-offline-backup-2026-11-05.tar.gz`) and store offline.
  2. Permanently delete both repositories on GitHub (GitHub Settings -> Danger Zone -> Delete this repository).
- **Consequences:**
  - Eliminates any possibility of future exposure from GitHub account/org misconfiguration or token compromise because the repositories no longer exist on GitHub.
  - Breaks any external links, PR references, or CI scripts that still attempt to query `cryptophys-work/platform-gitops` or `cryptophys-work/apps-gitops` on GitHub (`gh repo view` will return not found).
  - Because the repositories were readable prior to containment, deletion does **not** invalidate previously leaked credentials; **every external credential in `credential-issuers.md` (Part 1) MUST still be revoked at its issuer (B1, B2, B4)**.

#### Why `git filter-repo` Is Not Recommended
- Rewriting history does not un-expose secrets that were already readable before the repositories were made private, while destroying commit SHAs referenced in incident logs and parity documentation (`ADR-0005`). Archiving (Option 1) or deleting after an offline mirror backup (Option 2) combined with external credential revocation (B1, B2, B4) and cluster retirement (B3) achieves full containment cleanly.

---

## Gate Summary (Per `APPROVAL.md`)

| Gate | Status | Notes |
|---|---|---|
| Step 2 (v1): Make `platform-gitops` & `apps-gitops` private | **DONE** (2026-11-04) | Both repositories verified `PRIVATE`. |
| Plan v2: Containment by cluster retirement | **GRANTED** (2026-11-05) | Authorized by owner ("setuju"). |
| Part A (`A1`–`A4`): Read-only containment inventory | **PARTIAL** | A3 inventory and A4 written plan are recorded. A1 requires compliant fingerprint re-validation; A2 account details were withdrawn and require owner validation. |
| **B1: Binance** | `awaiting_owner` | Owner to revoke the historical Binance key and any unused keys. A1 must first be revalidated using only the approved SHA-256 value fingerprint; no partial identifier is retained here. |
| **B2: Wallet** | `awaiting_owner` | Treat the historical source key as compromised because the withdrawn report linked its derivation to a publicly known test-vector key. Owner to validate wallet ownership and balances securely and determine disposition; no address or key fingerprint is published here. |
| **B3: Cluster retirement** | **DONE** (2026-11-05) | Owner confirmed in `APPROVAL.md` ("cluster talos juga sudah musnah"). Contained all `cluster-internal only` items (#21–#28 in `credential-issuers.md`). |
| **B4: External issuer rotation** | `awaiting_owner` | Owner to revoke/rotate external items #1–#20 in `credential-issuers.md` (Binance, exchanges/market data, Cloudflare API token & tunnel, GitHub tokens, LLM keys, SMTP key, Docker Hub/Terraform/Quay, Telegram/X/Brave/Slack/Stripe). |
| **B5: Archive or delete gitops repositories** | `awaiting_owner` | Owner to execute Option 1 (Archive) or Option 2 (Delete after offline backup) from Step A4. |

---

## Changes

- Closed stale PR #46 (`worker/TP-001-security-containment`, already marked `CLOSED` on GitHub) and created fresh branch `worker/TP-001-v2-containment` from `main`.
- Populated `taskplane-tasks/TP-001-security-containment/credential-issuers.md` with the complete A3 secret and credential issuer inventory across `platform-gitops` and `apps-gitops`.
- Updated `taskplane-tasks/TP-001-security-containment/STATUS.md` with a non-revealing A1 field/path inventory, withdrawal of disallowed partial identifiers, withholding of A2 account details after identifying a public-test-vector disclosure risk, the A3 issuer inventory, the A4 written history purge plan, and corrected owner-gate statuses.
- The prior report did not print a raw credential string, but it did include partial API-key characters and a derived account association with a publicly known test-vector key. Those disclosures have been withdrawn from the current artifacts; treat the historical source credentials as compromised. Temporary worker artifacts were removed. No credential was used, no Binance endpoint was called, and no transaction was signed or sent.

---

## Part C: orchestrator verification (2026-11-05)

- **Part A** (PR #75): validated. No credential values, partial identifiers, derived addresses or key fingerprints appear in the merged artifacts.
- PR #74 and PR #71 were closed unmerged. #74 contained partial Binance key characters and a derived wallet association, both now withdrawn. Its branch should be deleted; the owner may also ask GitHub support to purge the PR diff if desired.
- **B1, B2, B4:** recorded as done on the owner's statement. They cannot be independently verified without using the credentials, which is prohibited.
- **B3:** done (cluster destroyed, owner statement).
- **B5:**
  - `platform-gitops`: an anonymous `git ls-remote` fails, so it is not publicly readable.
  - `apps-gitops`: the GitHub API reports `private: true, archived: false`. It is private but **not archived**.
  - B5 closes when `apps-gitops` is archived (`gh repo archive cryptophys-work/apps-gitops --yes`) or deleted, or when the owner records that private-only is the final state.

### Closure (2026-11-05)

B5 is complete. `apps-gitops` is verified as `private: true, archived: true`; `platform-gitops` is not anonymously readable and was archived by the owner. All TP-001 gates are done. The historical credentials remain compromised by definition and must never be reused.
