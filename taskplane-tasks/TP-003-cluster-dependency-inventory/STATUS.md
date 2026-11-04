# TP-003 — Status

State: **cancelled** (owner decision, 2026-11-04)

> "cluster lama sudah deprecated dan datanya tidak perlu disimpan, kita hanya mengadopsi cara kerja dan logicnya termasuk arsitekturnya."
> (The old cluster is deprecated and its data does not need to be kept; we only adopt its way of working, its logic and its architecture.)

- No cluster access (kubectl, Vault) is granted to the worker, and none is needed: the platform runs entirely on Cloudflare (ADR-0005, ADR-0007).
- Logic and architecture were already taken from the source in git (ADR-0005 inventory and parity ports); nothing is exported from the running cluster.
- Retiring the remaining nodes is done by the owner directly. Credential revocation stays in TP-001 (deferred by the owner).

The worker must not start this task.
