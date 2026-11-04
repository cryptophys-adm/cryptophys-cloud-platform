# TP-005 — Staged decommission of the Kubernetes estate (OWNER GATE; after TP-004)

**Why:** ADR-0005 retires 55 components and replaces 37 with Cloudflare. Running the cluster after that only keeps cost and risk.

## Steps, each a separate PR comment and VALIDATED before the next

1. **Freeze GitOps.** Suspend the Flux Kustomizations and set the Argo CD Applications to manual sync, so nothing re-creates what you stop. Record how to revert.
2. **Stop retired and replaced workloads first.** Scale them to zero, namespace by namespace, in the order TP-003's "safe to stop" table gives. After each namespace, wait 24h, or a shorter window the owner states, and confirm that nothing broke:
   - Cloudflare drift is still 12/12 healthy (the orchestrator checks D1);
   - no inbound traffic errors on the hostnames TP-003 listed.
3. **Stop stateful stores.** Do this only after their TP-004 exports are verified.
4. **OWNER GATE: final teardown.** Delete the Talos nodes or VMs, MetalLB IPs, DNS records that pointed at the cluster, and the cloudflared tunnel. Archive `cryptophys-work/platform-gitops` and `apps-gitops` as read-only repositories.
5. **Update the record.** Open a PR that sets the remaining "Kubernetes estate" rows in `docs/TRANSFORMATION-INVENTORY.md` / ADR-0005 to *decommissioned*, with dates.

**Done when:** no cluster resources remain, nothing user-facing broke during the staged window, and the ADR and inventory record the decommission.
