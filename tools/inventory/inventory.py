#!/usr/bin/env python3
"""Generate docs/TRANSFORMATION-INVENTORY.md from read-only checkouts of the legacy
Kubernetes GitOps repositories (ADR-0005).

Every component found in either repository must have a disposition below; an unmapped
component fails the run, so the inventory cannot silently omit anything.

Usage: inventory.py PLATFORM_GITOPS_DIR APPS_GITOPS_DIR > docs/TRANSFORMATION-INVENTORY.md
"""
import collections
import pathlib
import re
import subprocess
import sys

# Dispositions. "replaced" = an operational Cloudflare capability already covers it;
# "migrated" = ported to a Worker in this repository; "cloudflare-equivalent" = maps to a
# Cloudflare product within the Workers Paid plan, migrated when a consumer needs it;
# "retired" = Kubernetes/self-hosting machinery with no role on Cloudflare;
# "prohibited" = conflicts with the advisory-only baseline; "blocked-no-source" = only an
# image exists, so behaviour cannot be ported without inventing it.
PLATFORM = {
    "aide-policy-exclusions": ("retired", "Kyverno exclusions for AIDE agents; agents are not migrated"),
    "argocd": ("retired", "GitOps sync is replaced by GitHub Actions + Wrangler deploy workflows"),
    "argocd-crs": ("retired", "Argo CD resources"),
    "backup": ("cloudflare-equivalent", "Velero/MinIO -> D1 Time Travel (operational) and R2 for objects"),
    "backup-crs": ("retired", "Velero schedules; D1 Time Travel bookmarks are taken per deploy"),
    "certificates": ("replaced", "cert-manager/Let's Encrypt -> Cloudflare-managed edge certificates"),
    "cni": ("retired", "Cilium CNI; no cluster network"),
    "controllers": ("retired", "cluster controllers (metrics-server, ingress-nginx, ESO, ...)"),
    "controllers-gateway": ("retired", "Envoy gateway controller -> Workers routes/custom domains"),
    "crds": ("retired", "Kubernetes CRDs"),
    "crossplane": ("retired", "Crossplane provisioning; Cloudflare resources are created by reviewed workflows"),
    "crossplane-crs": ("retired", "Crossplane compositions"),
    "database": ("cloudflare-equivalent", "CloudNativePG/Postgres -> D1 per service (control plane already on D1)"),
    "database-crs": ("retired", "CNPG cluster resources"),
    "dns": ("replaced", "CoreDNS/NodeLocalDNS -> Cloudflare DNS"),
    "fabric": ("replaced", "Hyperledger Fabric ledger -> hash-chained Audit Ledger (D1)"),
    "flux-image-automation": ("retired", "image automation; no container images"),
    "gateway": ("replaced", "cluster ingress gateway -> Workers custom domains behind Cloudflare Access"),
    "gitea": ("retired", "self-hosted Git mirror; GitHub is the source of truth"),
    "harbor": ("retired", "container registry; no containers"),
    "kagenti": ("retired", "agent operator for Kubernetes workloads"),
    "kueue": ("retired", "batch job queueing -> Cloudflare Queues/Workflows when a job needs it"),
    "metallb": ("retired", "bare-metal load balancer"),
    "metallb-config": ("retired", "MetalLB address pools"),
    "namespaces": ("retired", "Kubernetes namespaces; isolation is per Worker and per D1 table ownership"),
    "networking": ("replaced", "NetworkPolicies -> no public surface without Access; Worker-to-Worker over RPC only"),
    "observability": ("cloudflare-equivalent", "Prometheus/Grafana/Loki -> Workers Logs and Observability, drift alert issues"),
    "policy": ("replaced", "Kyverno/Gatekeeper admission policy -> Policy Engine + CI validation"),
    "policy-exceptions": ("retired", "Kyverno exceptions"),
    "policy-rbac": ("replaced", "RBAC -> Access identity allow-lists (OPERATOR/APPROVER_IDENTITIES)"),
    "policy-reporter": ("replaced", "policy reports -> Policy Engine decisions in D1 + Audit Ledger"),
    "policy-ssot": ("replaced", "policy SSOT -> this repository (ADRs, Policy Engine rules)"),
    "ray": ("retired", "GPU/LLM serving cluster -> Workers AI"),
    "ray-warm-build": ("retired", "Ray image warm builds"),
    "resource-governance": ("replaced", "quotas/limits -> per-service Workers AI budgets and platform limits"),
    "scheduling": ("retired", "priority classes / node scheduling"),
    "secrets": ("replaced", "External Secrets -> Worker secrets from the GitHub production Environment"),
    "security-observability": ("retired", "Falco/Tetragon runtime sensors; no hosts to observe"),
    "sources": ("retired", "Flux Helm/Git sources"),
    "spire": ("replaced", "SPIFFE workload identity -> RPC service bindings + Access service tokens"),
    "spire-identities": ("replaced", "SPIFFE IDs -> service bindings declared per Worker"),
    "storage": ("cloudflare-equivalent", "Longhorn volumes -> D1/R2/KV per data class"),
    "tekton": ("retired", "image build pipelines; Workers are built and deployed by GitHub Actions"),
    "vault-system": ("replaced", "Vault -> Worker secrets + GitHub Environments. Leaked unseal keys: see ADR-0005 §Security"),
    "observability/flux-monitoring": ("retired", "Flux monitoring"),
    "observability/grafana-dashboards": ("cloudflare-equivalent", "dashboards -> Workers Observability"),
    "security/image-signing": ("retired", "cosign image signing; no images (actions are SHA-pinned)"),
    "security/rbac": ("replaced", "RBAC -> Access identity allow-lists"),
    "security/tracing-policies": ("retired", "Tetragon tracing policies"),
}

APPS = {
    "core/00-genesis": ("retired", "cluster bootstrap (namespaces, Argo roots, Kagenti)"),
    "core/01-nervous-system/ats": ("blocked-no-source", "image only"),
    "core/01-nervous-system/auth-gateway": ("replaced", "auth gateway -> Cloudflare Access with in-Worker JWT verification"),
    "core/01-nervous-system/mesh": ("cloudflare-equivalent", "NATS mesh -> Queues (async), RPC service bindings (sync)"),
    "core/01-nervous-system/notification": ("cloudflare-equivalent", "notifications -> drift-alert issues; Telegram stays in xauusd"),
    "core/01-nervous-system/ray-build-worker": ("retired", "Ray image builder"),
    "core/02-cognitive-brain": ("replaced", "self-hosted LLMs (Ollama, Ray Serve, bitnet, reranker) -> Workers AI per-service engines"),
    "core/03-autonomous-execution": ("prohibited", "autonomous agents that execute/commit/remediate; conflicts with advisory-only and reviewed-change baseline"),
    "core/04-governance-heart": ("replaced", "DAO/consensus governance -> Policy Engine + separated recovery approval"),
    "core/05-sensory-perception": ("blocked-no-source", "chain/bridge watchers: image only"),
    "core/06-memory-storage/backup-vault": ("replaced", "backups -> D1 Time Travel / R2"),
    "core/06-memory-storage/trustedledger": ("replaced", "immudb ledger -> hash-chained Audit Ledger"),
    "core/06-memory-storage/vector-memory-gateway": ("cloudflare-equivalent", "Qdrant/Milvus -> Vectorize"),
    "core/07-peripheral-tools": ("blocked-no-source", "MCP/automation tools: image only"),
    "core/08-infra-ops": ("retired", "cluster ops (image factory, Kueue, wasmCloud, monitoring, security scanners)"),
    "core/09-neural-mesh": ("retired", "Kubernetes mesh wiring"),
    "dash/00-meta": ("retired", "Argo root"),
    "dash/01-identity": ("replaced", "Keycloak/authz -> Cloudflare Access"),
    "dash/02-connectivity": ("replaced", "domains/gateway -> Workers custom domains"),
    "dash/03-visceral-interfaces/jarvis-gateway": ("blocked-no-source", "image only"),
    "dash/03-visceral-interfaces/nexus": ("replaced", "cluster dashboard (NATS/SPIRE/Kagenti views) -> xauusd-nexus-dashboard Worker + control-plane APIs"),
    "dash/03-visceral-interfaces/synapse": ("blocked-no-source", "image only"),
    "dash/observer": ("replaced", "cluster observer -> Drift Detector"),
    "tekton": ("retired", "Tekton pipelines/operators; GitHub Actions builds and deploys Workers"),
    "user/00-infra": ("retired", "domain controller for Kubernetes"),
    "user/01-sensory-circulation": ("blocked-no-source", "corpus ingestion: image only"),
    "user/03-execution-swarms": ("prohibited", "trade execution swarms; advisory-only baseline forbids execution"),
    "user/cognitive-risk/signal-edge": ("migrated", "trend + volume indicator engines -> cryptophys-signal-engine Worker; other engines have no source"),
    "user/cognitive-risk/signal-engine": ("migrated", "namespace/stream wiring -> cryptophys-signal-engine Worker (cron + D1)"),
    "user/cognitive-risk/mizan-edge": ("blocked-no-source", "Mizan engines are images only; XAUUSD Mizan is owned by xauusd-mizan-engine (parity-gated); mizan-executor is prohibited"),
    "user/cognitive-risk/mizan": ("blocked-no-source", "kustomization only"),
    "user/cognitive-risk/risk-engine": ("blocked-no-source", "Dockerfile/manifests only"),
    "user/cognitive-risk/trading-decision": ("replaced", "LLM escalation controller -> Workers AI advisory engine; xauusd Analyst/Counselor/Reasoner"),
    "user/cognitive-risk/cognition-reasoning": ("replaced", "reasoning prompt helper -> Workers AI advisory engine"),
    "user/cognitive-risk/aether-edge": ("blocked-no-source", "124 lines of exploratory scripts without a contract"),
    "user/dynamic-agents": ("retired", "Kagenti dynamic agents"),
}

KIND = re.compile(r"^kind:\s*(\S+)", re.M)
IMAGE = re.compile(r"image:\s*['\"]?([^\s'\"]+)")
SOURCE_EXT = {".py", ".ts", ".js", ".mjs", ".rs", ".go"}


def head(repo: pathlib.Path) -> str:
    return subprocess.run(["git", "-C", str(repo), "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()


def scan(path: pathlib.Path):
    kinds, images, source_lines = collections.Counter(), set(), 0
    for f in path.rglob("*"):
        if not f.is_file() or ".git" in f.parts:
            continue
        if f.suffix in SOURCE_EXT:
            source_lines += sum(1 for _ in f.open(errors="ignore"))
        if f.suffix in {".yaml", ".yml"}:
            text = f.read_text(errors="ignore")
            kinds.update(KIND.findall(text))
            images.update(i for i in IMAGE.findall(text) if "{{" not in i and "$" not in i)
    return kinds, images, source_lines


def lookup(table, key):
    """Longest mapped prefix of key."""
    parts = key.split("/")
    for n in range(len(parts), 0, -1):
        if "/".join(parts[:n]) in table:
            return table["/".join(parts[:n])]
    return None


def main(platform_dir: str, apps_dir: str) -> int:
    platform, apps = pathlib.Path(platform_dir), pathlib.Path(apps_dir)
    rows, missing = [], []
    components = [("platform", f"{p.parent.name}/{p.name}" if p.parent.name != "infrastructure" else p.name, p)
                  for base in ("platform/infrastructure", "platform/observability", "platform/security")
                  for p in sorted((platform / base).iterdir()) if p.is_dir()]
    components += [("apps", f"{p.parent.parent.name}/{p.parent.name}/{p.name}".removeprefix("apps/"), p)
                   for p in sorted((apps / "apps").glob("*/*/*")) if p.is_dir()]
    for repo, key, path in components:
        mapped = lookup(PLATFORM if repo == "platform" else APPS, key)
        if not mapped:
            missing.append(f"{repo}:{key}")
            continue
        kinds, images, src = scan(path)
        workloads = sum(kinds[k] for k in ("Deployment", "StatefulSet", "DaemonSet", "CronJob", "HelmRelease"))
        rows.append((repo, key, mapped[0], mapped[1], workloads, len(images), src))
    if missing:
        print("Unmapped components (add a disposition):\n  " + "\n  ".join(missing), file=sys.stderr)
        return 1

    totals = collections.Counter(r[2] for r in rows)
    out = [
        "# Transformation Inventory (generated)",
        "",
        "Generated by `tools/inventory/inventory.py` from read-only checkouts; do not edit by hand. Decisions: [ADR-0005](../architecture/adr/0005-cloudflare-transformation.md).",
        "",
        f"- `cryptophys-work/platform-gitops` at `{head(platform)}`",
        f"- `cryptophys-work/apps-gitops` at `{head(apps)}`",
        "",
        "| Disposition | Components |",
        "| --- | --- |",
        *[f"| {d} | {n} |" for d, n in sorted(totals.items())],
        "",
        "| Repo | Component | Disposition | Cloudflare outcome | Workloads | Images | Source lines |",
        "| --- | --- | --- | --- | ---: | ---: | ---: |",
        *[f"| {r} | `{k}` | {d} | {why} | {w} | {i} | {s} |" for r, k, d, why, w, i, s in rows],
        "",
    ]
    sys.stdout.write("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:3]))
