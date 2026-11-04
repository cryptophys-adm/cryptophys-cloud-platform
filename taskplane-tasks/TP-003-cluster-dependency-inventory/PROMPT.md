# TP-003 — Read-only dependency inventory of the Kubernetes estate (prerequisite for decommission)

**Why:** ADR-0005 says the cluster can be decommissioned only once the owner confirms that nothing outside the inventory depends on it. This task produces that evidence. **Read-only:** no apply, no delete, no scale.

## Steps

1. **Workloads.**
   - `kubectl get deploy,sts,ds,cronjob -A -o json`, reduced with `jq` to namespace, name, replicas, ready and image.
   - Flag anything running that `docs/TRANSFORMATION-INVENTORY.md` marks as `migrated`, `replaced` or `retired`; those should be safe to stop.
   - Flag anything that is not in the inventory at all.
2. **Inbound traffic.**
   - List the Ingress, Gateway/HTTPRoute and LoadBalancer Services with their hostnames and addresses.
   - For each hostname, resolve DNS and report whether it points at the cluster: MetalLB IPs, or the Cloudflare tunnel (`cloudflared`).
   - Check access logs or metrics (Loki or Prometheus) for request counts over the last 7 days per host.
3. **Outbound and data.** List the stateful stores and their sizes:
   - CloudNativePG databases;
   - Qdrant/Milvus collections;
   - immudb, MinIO buckets and Longhorn volumes.
   Report per store whether it holds data that is not already reproduced in Cloudflare D1 or R2.
4. **Schedules.** List the CronJobs and Tekton triggers that still run, and what they write to.
5. **Report.** Write `taskplane-tasks/TP-003-cluster-dependency-inventory/REPORT.md` with three tables:
   - safe to stop;
   - needs data export, which feeds TP-004;
   - unknown, which needs an owner answer.

**Done when:** the orchestrator has validated `REPORT.md` and every running workload is classified.
