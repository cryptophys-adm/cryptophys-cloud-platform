# TP-001 Security Containment (v2) — STATUS

State: awaiting_owner

## Evidence (Part A: Read-Only Containment Inventory, A1–A4)

All read-only steps (`A1`–`A4`) authorized in `APPROVAL.md` have been completed without outputting or using any secret, calling any Binance endpoint, or signing any transaction. Validated evidence from PR #46 is preserved and extended below.

---

### A1. Masked Binance Key Identifier (`binance_hmac.json`)

Inspection of `cryptophys-work/apps-gitops` Git history across all commits touching `**/binance_hmac.json` (`apps/user/omega/core/vault/binance_hmac.json`, `apps/user/omega/vault/binance_hmac.json`, and `apps/user/03-execution-swarms/omega/core/vault/binance_hmac.json`) identified **two distinct historical file blobs**:

| Blob / Revision Scope | Git Blob Prefix | File `sha256[:8]` | Masked `api_key` (`first4...last4`) | `api_key` Length | Notes |
|---|---|---|---|---|---|
| Earlier commits (`09864b840`, `8db3c4cc6`, `5120b92e1` up to `1b65a7955^`, `40806c10d^`, `4673512f1^`) | `6c7d404a36` | **`d5d05543`** | **`BqpV...jgkY`** | 64 chars | **Live-format 64-char Binance API key** — match and delete this key in Binance API Management (Gate B1). |
| Later commit (`48e2d2293^` and `aa912bbff^`) | `9a5dc8209f` | **`bd715dea`** | **`REDA...VERY`** | 27 chars | Redacted placeholder committed before file deletion. |

- **Secret handling:** `api_secret` was never printed or logged. Zero Binance API endpoints (signed or unsigned) were called.
- **Current tree:** Absent from `HEAD` of `cryptophys-work/apps-gitops`.

---

### A2. Wallet Address and Multi-Chain Read-Only Balances (`genesis.key`)

- **Source in `cryptophys-work/apps-gitops` history:** `apps/user/omega/core/vault/genesis.key` (also historical paths `apps/user/omega/vault/genesis.key` and `apps/user/03-execution-swarms/omega/core/vault/genesis.key` at `48e2d2293^` and earlier; git blob `bcccf401fa`).
- **File `sha256[:8]`:** **`c302d918`** (67 bytes raw; valid `0x`-prefixed 32-byte hex secp256k1 scalar).
- **Derivation method:** Derived locally in memory using pinned `eth-account==0.13.4` inside a throwaway virtual environment (`/tmp/tp001-venv`), which was deleted immediately after execution. The private key was never printed, stored, or transmitted, and no transaction or message was signed.
- **Derived EVM Address (checksummed):** **`0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf`**
  - *Security note for Gate B2:* `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf` is the well-known public secp256k1 generator-point (`G`, scalar `1`) test vector address, which is publicly known and continuously swept by automated bots on all public EVM chains.

| Chain | Public Read-Only RPC Used | Native Balance (`eth_getBalance`) | Raw Balance Hex | Transaction Count (`eth_getTransactionCount`) | Raw Nonce Hex |
|---|---|---|---|---|---|
| **Ethereum** | `https://ethereum-rpc.publicnode.com` | **`0 ETH`** (`0` wei) | `0x0` | **`5151`** | `0x141f` |
| **BNB Smart Chain** | `https://bsc-dataseed.binance.org` | **`0 BNB`** (`0` wei) | `0x0` | **`13225`** | `0x33a9` |
| **Polygon** | `https://polygon-bor-rpc.publicnode.com` | **`0 POL`** (`0` wei) | `0x0` | **`3909`** | `0xf45` |
| **Arbitrum** | `https://arb1.arbitrum.io/rpc` | **`0 ETH`** (`0` wei) | `0x0` | **`1600`** | `0x640` |
| **Base** | `https://mainnet.base.org` | **`0 ETH`** (`0` wei) | `0x0` | **`2767`** | `0xacf` |

---

### A3. Inventory of What Vault and the Cluster Held

The full inventory of `ExternalSecret` / `ClusterExternalSecret` / `SecretStore` / `ClusterSecretStore` references, Vault KV paths, Kubernetes `Secret` resource names, and credential-shaped environment variables (`*_TOKEN`, `*_KEY`, `*_SECRET`, `*_PASSWORD`) across both `cryptophys-work/platform-gitops` and `cryptophys-work/apps-gitops` (current tree and Git history) is written to:

- [`taskplane-tasks/TP-001-security-containment/credential-issuers.md`](./credential-issuers.md)

Summary of findings in `credential-issuers.md`:
- **External / Unknown-Issuer Credentials (20 entries, Items #1–#20):** Categorized by issuer (**Binance**, **an exchange**, **Cloudflare**, **GitHub**, **an LLM provider**, **email/SMTP**, **a cloud provider**, and **unknown**) for owner revocation/rotation in **B1**, **B2**, and **B4**.
- **Cluster-Internal Only Credentials (8 subsystem groups, Items #21–#28):** Vault unseal shares (`sha256[:8]=315afe52`) and internal tokens, NATS JetStream mesh credentials (including the 14-char weak literal password), ArgoCD admin/server secrets and `cryptophys.work/reconcile-token` annotations (`a4a8db91`, `d5b60d1c`, `55a91a1d`), Gitea, Harbor, PostgreSQL/Redis/ImmuDB, MinIO/Velero, and Keycloak/OAuth2-Proxy/Grafana/Headlamp/Tekton/Cosign/WasmCloud/SPIRE/Kagenti internal secrets. All are **contained and closed by Step B3** (Talos cluster retirement, confirmed **DONE** by the owner on 2026-11-05).

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
| Part A (`A1`–`A4`): Read-only containment inventory | **DONE** (2026-11-05) | Completed in this PR on branch `worker/TP-001-v2-containment`. |
| **B1: Binance** | `awaiting_owner` | Owner to delete API key matching `BqpV...jgkY` (`sha256[:8]=d5d05543`) and any unused keys in Binance API Management, and verify account security settings. |
| **B2: Wallet** | `awaiting_owner` | Address `0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf` (`sha256[:8]=c302d918`) has `0` native balance on Ethereum, BSC, Polygon, Arbitrum, and Base (known public test vector). Owner to confirm no personal wallet was used and never reuse this address. |
| **B3: Cluster retirement** | **DONE** (2026-11-05) | Owner confirmed in `APPROVAL.md` ("cluster talos juga sudah musnah"). Contained all `cluster-internal only` items (#21–#28 in `credential-issuers.md`). |
| **B4: External issuer rotation** | `awaiting_owner` | Owner to revoke/rotate external items #1–#20 in `credential-issuers.md` (Binance, exchanges/market data, Cloudflare API token & tunnel, GitHub tokens, LLM keys, SMTP key, Docker Hub/Terraform/Quay, Telegram/X/Brave/Slack/Stripe). |
| **B5: Archive or delete gitops repositories** | `awaiting_owner` | Owner to execute Option 1 (Archive) or Option 2 (Delete after offline backup) from Step A4. |

---

## Changes

- Closed stale PR #46 (`worker/TP-001-security-containment`, already marked `CLOSED` on GitHub) and created fresh branch `worker/TP-001-v2-containment` from `main`.
- Populated `taskplane-tasks/TP-001-security-containment/credential-issuers.md` with the complete A3 secret and credential issuer inventory across `platform-gitops` and `apps-gitops`.
- Updated `taskplane-tasks/TP-001-security-containment/STATUS.md` with A1 masked Binance key identifiers (`BqpV...jgkY` at `d5d05543` and `REDA...VERY` at `bd715dea`), A2 derived EVM address (`0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf`) and 5-chain read-only balances/nonces, A3 inventory summary, A4 written history purge plan, and B1–B5 gate statuses.
- Removed temporary virtual environment (`/tmp/tp001-venv`) and temporary scan artifacts. No secret values were printed, logged, or committed.
