# TP-003 Cluster Dependency Inventory — REPORT

State: blocked

## Tooling

- kubectl: NOT installed in worker environment; no kubeconfig found.
- vault: NOT installed; no VAULT_ADDR.
- No cluster endpoint or credentials provided.

Because cluster access is unavailable, a live dependency inventory could not be performed. Tables below reflect that limitation; all entries are "unknown" pending tooling/credentials from owner.

## Table 1 — Safe to stop

| Resource | Namespace | Owner | Notes |
|---|---|---|---|
| (none verified) | — | — | No cluster access to confirm safe-to-stop resources |

## Table 2 — Needs data export

| Resource | Namespace | Data class | Export required before stop | Notes |
|---|---|---|---|---|
| (none verified) | — | — | — | No cluster access |

## Table 3 — Unknown

| Item | Why unknown | Next step |
|---|---|---|
| All cluster resources/workloads | kubectl not installed; no kubeconfig/endpoint | Owner to provide kubeconfig or run inventory on cluster host |
| Vault status (sealed/threshold/shares/version) | vault binary/endpoint not available | Owner to run `vault status` and share redacted output |
| Namespace/owner mapping | No cluster access | Owner to provide or grant read-only kubectl |

## Evidence

- `which kubectl vault` → not found
- `find / -name kubeconfig*` → none
- `env | grep -i kube/vault` → none
