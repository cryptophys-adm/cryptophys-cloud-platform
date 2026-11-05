# XAUUSD integration: what is live, and the optional next step for the xauusd repository

This document is written for the owner of `cryptophys-adm/xauusd-ai-trading-assistant`. **This repository never changes the xauusd repository.** Every step below happens in that repository, under its own rules (`AGENTS.md`, `docs/SSOT.md`) and its own CI.

## Live today (no change needed in the xauusd repository)

| Platform capability | How it works |
|---|---|
| **Health monitoring** | The Drift Detector probes `/health` on the four xauusd Workers every 15 minutes through plain in-account Service Bindings. Drift Alert opens a GitHub issue when one is unhealthy. |
| **Decision relay** (TP-017) | The AI Kernel's Signal Analyst reads `GET /api/decisions` (read-only) at minute 22 of every hour. It publishes `xauusd_digest` reports in these cases:<br>• a new decision;<br>• a BUY↔SELL flip (warning);<br>• a 6 h heartbeat;<br>• **stale analysis**: no decision for a closed H1 candle after 90 minutes;<br>• the API is unavailable or returns no items.<br><br>The relay is deterministic. It copies fields as they are, drops `position_size_pct`, and adds no advice. |
| **Operator overview** (TP-019) | `/v1/overview`, `/v1/status` and MCP `platform_status` show `xauusd_latest`: decision, confidence, candle and time. |
| **Agent registry** | 21 xauusd agents are registered in the kernel at tier 1 (migration 0016): 7 chain, bus and room agents, plus 14 HUD agents. They are subject to the global kill switch. They cannot publish until the binding below exists. |

## Connect the xauusd agents to the platform (instructions for the xauusd owner)

### 0. The agents are already registered

Migration 0016 registered **21 agents**. Every one has these properties:
- `host_worker = "xauusd-ai-trading-assistant"`;
- `tier_max = 1`;
- status `enabled`.

| Group | agent_id |
|---|---|
| H1 synthesis chain | `xauusd-analyst`, `xauusd-counselor`, `xauusd-reasoner` |
| Bus, room and news threads | `xauusd-technical-analyst`, `xauusd-news-analyst`, `xauusd-risk-manager`, `xauusd-moderator` |
| Pine HUD (14) | `hud-r37-funnel`, `hud-prophet`, `hud-trade-management`, `hud-interstellar-eyes`, `hud-kinetic-engine-tva`, `hud-fabio-amt-sensors`, `hud-chronos-matrix`, `hud-aegis-footprint-matrix`, `hud-tactical-muscles`, `hud-macro-aether-sensors`, `hud-gabfx-price-action`, `hud-playbook-execution`, `hud-decision-matrix`, `hud-grid-bot-protocol` |

**Grants** (the same for every agent):

| Capability | Tier | Limit | Input |
|---|---|---|---|
| `reports.publish` | 1 | 4 per hour per agent | see §2 |
| `memory.remember` | 1 | 12 per hour per agent | `{ kind ≤ 80, text ≤ 1000, source_ref? ≤ 200 }` |
| `memory.recall` | 0 | — | `{ query ≤ 1000, top_k ≤ 5 }`; only the agent's own memories |
| `signals.observe` | 0 | — | Not needed. It reads the xauusd API itself. |

**Agents cannot register themselves.** To add, rename or retire an agent, send the platform owner its `agent_id`, display name and purpose. The platform changes the registry through a reviewed D1 migration.

Today the agents **cannot publish**, because the xauusd Worker has no binding to the kernel. The steps below add it.

### 1. Add one RPC Service Binding to the `xauusd-ai-trading-assistant` Worker only

```jsonc
// wrangler.jsonc of xauusd-ai-trading-assistant
"services": [
  // …existing bindings…
  {
    "binding": "AGENTS",
    "service": "cryptophys-ai-kernel",
    "entrypoint": "AgentRpc",
    "props": { "host_worker": "xauusd-ai-trading-assistant" }
  }
]
```

The binding is safe by construction (ADR-0007 §1.1, TP-011, TP-022):

- **No secret, no token.** The caller's identity is the `host_worker` pinned in the binding.
- **Only this Worker can act as the 21 agents.**
  - Any other xauusd Worker gets `agent_not_hosted_by_caller`.
  - An agent hosted by the AI Kernel gets `kernel_agent_internal`.
  - Never set `host_worker` to anything else.
- **Only tier ≤ 1.** Every call goes through:
  - grants and prohibitions;
  - agent status;
  - the global kill switch;
  - the rate limit;
  - the Policy Engine;
  - the audit chain.

### 2. Call shape (copy this pattern)

```ts
interface AgentRpc {
  whoami(agentId: string): Promise<Record<string, unknown>>;
  syscall(agentId: string, capability: string, input?: Record<string, unknown>): Promise<Record<string, unknown>>;
}
// Env: AGENTS?: AgentRpc;

export function publishToPlatform(env: Env, ctx: ExecutionContext, agentId: string, report: {
  kind: "xauusd_digest" | "hud_digest";
  severity: "info" | "warning" | "critical";
  subject: string;                 // at most 200 characters
  ai_status: string;               // "deterministic" or the engine outcome
  body: Record<string, unknown>;   // JSON object, at most 16 KiB
}): void {
  if (!env.AGENTS) return;
  ctx.waitUntil((async () => {
    try {
      const r = await Promise.race([
        env.AGENTS!.syscall(agentId, "reports.publish", report),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000)),
      ]) as { outcome?: string; reason?: string };
      if (r?.outcome !== "succeeded") console.warn(JSON.stringify({ event: "platform_report_not_published", agentId, outcome: r?.outcome, reason: r?.reason }));
    } catch {
      console.warn(JSON.stringify({ event: "platform_report_failed", agentId }));
    }
  })());
}
```

- **Outcomes are data; the call never throws for policy reasons.** It returns one of:
  - `{ outcome: "succeeded", result }`;
  - `{ outcome: "denied", reason }`. The reason is a check list such as `failed: rate_limit`, `failed: agents_enabled` (kill switch off) or `failed: agent_enabled` (agent suspended), or a resolve error such as `agent_not_registered`;
  - `{ outcome: "failed", reason }`, for invalid input such as `invalid_report_kind` or `report_body_too_large`.
- **Every outcome other than `succeeded` is non-fatal.** The xauusd chain must keep running when the kernel is down, denies the call, or is slow.

### 3. Rules of engagement

1. **Advisory only.**
   - Nothing may place orders, execute trades, touch exchange accounts or wallets, or move funds, at any tier. Such capabilities do not exist, and the policy check `capability_not_prohibited` refuses them.
   - Do not send `position_size_pct`, lot sizes, or imperatives such as "buy now". State observations instead, for example "Decision BUY, confidence 0.62".
   - The platform stores reports with the disclaimer `advisory only; not an order`. The advisory-language guard rejects AI drafts with trading advice and fails closed.
2. **Publish on events, not on ticks.** The limit is 4 reports per hour per agent, so publish one report per meaningful event:
   - a new H1 decision;
   - a BUY↔SELL flip;
   - a Moderator consensus;
   - a material HUD state change.

   For room summaries, let the Moderator publish rather than every participant.
3. **Severity.**
   - `info` is routine.
   - `warning` means attention is needed, for example a flip or a stale feed.
   - `critical` is **only** for real failures, such as missing data or a stuck chain. A critical report **opens a GitHub issue automatically**, so never use it for market signals.
4. **Report content.**
   - No secrets, tokens, private URLs or personal data.
   - Reports are kept permanently and are chained into the audit ledger.
   - `subject` is at most 200 characters, and `body` is a JSON object of at most 16 KiB.
   - Use `kind` `xauusd_digest` for the chain, bus and room agents, and `hud_digest` for `hud-*` agents.
5. **The platform holds the controls.** The platform owner can suspend one agent or turn off all agents with the kill switch. When that happens, calls are denied. Do not work around it: no retry loops and no switching `agent_id`.
6. **No reverse access.** The binding only lets the xauusd Worker publish reports and memories. The platform keeps only **reading** `GET /api/decisions`, and never writes to the xauusd repository or its Workers.

### 4. In the xauusd repository (its rules, not ours)

- The binding is an inter-Worker RPC Service Binding with no shared secret, which `AGENTS.md` rule 7 allows. Whether it counts as a topology change under `docs/SSOT.md` §5 is the owner's call. If it does, update `docs/SSOT.md`, `AGENTS.md` and `test/ssot-topology.test.mjs` in the same PR, with the owner's approval.
- Deploy only by merging into `main` there.

### 5. Verification after the xauusd deploy

1. From the Worker, `await env.AGENTS.whoami("xauusd-moderator")` returns:
   - `tier_max: 1`;
   - `status: "enabled"`;
   - the four capabilities above.
2. Publish one `info` report from `xauusd-moderator`, then tell the platform orchestrator. The orchestrator verifies it in D1 `agent_reports` and in `/v1/overview` (`agent_reports_24h`).

### What the platform needs to do

Nothing. The agents, their grants and the report kinds (`xauusd_digest`, `hud_digest`) already exist.
