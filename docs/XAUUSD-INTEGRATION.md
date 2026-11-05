# XAUUSD integration: what is live, and the optional next step for the xauusd repository

This document is written for the owner of `cryptophys-adm/xauusd-ai-trading-assistant`. **This repository never changes the xauusd repository.** Every step below happens in that repository, under its own rules (`AGENTS.md`, `docs/SSOT.md`) and its own CI.

## Live today (no change needed in the xauusd repository)

| Platform capability | How it works |
|---|---|
| **Health monitoring** | The Drift Detector probes `/health` on the four xauusd Workers every 15 minutes through plain in-account Service Bindings. Drift Alert opens a GitHub issue when one is unhealthy. |
| **Decision relay** (TP-017) | The AI Kernel's Signal Analyst reads `GET /api/decisions` (read-only) at minute 22 of every hour. It publishes `xauusd_digest` reports in these cases:<br>• a new decision;<br>• a BUY↔SELL flip (warning);<br>• a 6 h heartbeat;<br>• **stale analysis**: no decision for a closed H1 candle after 90 minutes;<br>• the API is unavailable or returns no items.<br><br>The relay is deterministic. It copies fields as they are, drops `position_size_pct`, and adds no advice. |
| **Operator overview** (TP-019) | `/v1/overview`, `/v1/status` and MCP `platform_status` show `xauusd_latest`: decision, confidence, candle and time. |
| **Agent registry** | 21 xauusd agents are registered in the kernel at tier ≤ 1 (migration 0016): 7 chain, bus and room agents, plus 14 HUD agents. They are subject to the global kill switch. |

## Optional: let the xauusd agents report through the platform

Today the 21 registered xauusd agents **cannot publish reports**. The xauusd Worker has no binding to the kernel. If the owner wants their findings in the platform's audit-chained report store and in the critical-report alert, the xauusd repository would add **one RPC Service Binding**:

```jsonc
// wrangler.jsonc of xauusd-ai-trading-assistant
"services": [
  // …existing NEWS_INGESTION binding…
  {
    "binding": "AGENTS",
    "service": "cryptophys-ai-kernel",
    "entrypoint": "AgentRpc",
    "props": { "host_worker": "xauusd-ai-trading-assistant" }
  }
]
```

The binding is safe by construction (ADR-0007 §1.1, TP-011):

- **No secret, no token.** The caller's identity is the `host_worker` pinned in the binding.
- The Worker can act **only** as the agents whose `host_worker` is `xauusd-ai-trading-assistant`, and only at **tier ≤ 1**.
- Every call goes through the Policy Engine. It is rate-limited, audited, and stopped by the kill switch.
- Reports are advisory and stored with the disclaimer `advisory only; not an order`. The platform's advisory-language guard rejects AI-drafted trading advice.

The call shape mirrors this repository's helper, `workers/control-plane-shared/src/agents.ts`:

```ts
await env.AGENTS.syscall("xauusd-moderator", "reports.publish", {
  kind: "xauusd_digest",            // or "hud_digest" for HUD agents
  severity: "info",                 // "warning" / "critical" only for real attention items
  subject: "…at most 200 characters…",
  ai_status: "deterministic",       // or the engine outcome
  body: { /* bounded JSON, max 16 KiB */ },
});
```

The call never throws for policy reasons. A denial comes back as data: `{ outcome: "denied", reason }`. Wrap the call so that a kernel outage never fails the xauusd chain.

### In the xauusd repository (its rules, not ours)

- The binding is an inter-Worker RPC Service Binding with no shared secret, which `AGENTS.md` rule 7 allows. Whether it counts as a topology change under `docs/SSOT.md` §5 is the owner's call. If it does, update `docs/SSOT.md`, `AGENTS.md` and `test/ssot-topology.test.mjs` in the same PR, with the owner's approval.
- Deploy only by merging into `main` there.

### What the platform needs to do after that

Nothing. The agents, their grants (`reports.publish`) and the report kinds (`xauusd_digest`, `hud_digest`) already exist. The orchestrator can verify the first report in D1 `agent_reports` once the binding is live.
