# XAUUSD integration: what is live, and the optional next step for the xauusd repository

This document is written for the owner of `cryptophys-adm/xauusd-ai-trading-assistant`. **This repository never changes the xauusd repository.** Every step below happens in that repository, under its own rules (`AGENTS.md`, `docs/SSOT.md`) and its own CI.

## Live today (no change needed in the xauusd repository)

| Platform capability | How it works |
|---|---|
| **Health monitoring** | The Drift Detector probes `/health` on the four xauusd Workers every 15 minutes through plain in-account Service Bindings. Drift Alert opens a GitHub issue when one is unhealthy. |
| **Trading organ health** (TP-017; metrics since 2026-11-15) | The AI Kernel's Signal Analyst reads `GET /api/engine/decisions` (falling back to `GET /api/decisions`; read-only, the newest 50) at minute 22 of every hour. It no longer relays each decision (Nexus and the Telegram heartbeat do). It publishes `xauusd_digest` reports in these cases:<br>• a BUY↔SELL flip (warning, once per flipped candle);<br>• **stale analysis**: no decision for a closed H1 candle after 90 minutes (warning);<br>• the API is unavailable or returns no items (warning);<br>• a metric snapshot (`trading_organ_health.v1`: decision shares, flips, confidence, the latest decision's age and staleness incidents, each with a 7-day baseline and z), on a material change or every 6 h.<br><br>The reports are deterministic and add no advice. They never carry a price level: `entry_price`, `stop_loss`, `take_profit` and `position_size_pct` are dropped when the decisions are read (owner rule, 2026-11-07). The 7- and 30-day hit rates come from the `outcome_summary` the decisions endpoint serves (xauusd 8a27029): subject `engine:15` (timeframe `15`) on `/api/engine/decisions`, `chain:h1` (timeframe `60`) on `/api/decisions`. The kernel keeps only its known, typed fields and only for the subject of the endpoint it read; a hit rate is `ok`, `no_scored_data` (nothing directional scored yet, for example while the market is closed) or `unavailable_source_field` (the summary is absent or null). |
| **Execution hosts in the AI Mesh** (owner 2026-11-12) | The AI Mesh page (`GET /v1/mesh` → `execution_hosts`) shows Omega, the owner's MT5 VPS bridge and its EA. The kernel calls the xauusd AI Worker's RPC entrypoint `OmegaHealth.health()` (binding `XAUUSD_OMEGA_HEALTH`, schema `omega-health.v1`, 3 s timeout): the EA heartbeat's age and freshness, version, mode, trading allowed and open positions; the Omega control mode; the bridge's sync age and freshness, version, and the terminal's connected and trade-allowed. Only known fields of the expected type are kept (`execution-hosts.ts`); no control and no account figure. A host that does not answer is `unreachable`; without the binding it is `not_bound`. |
| **Organism census and self-registration** (owner 2026-11-12, ADR-0013 §6) | The Forge reads the XAUUSD organs' DNA on each census (binding `EXT_ORGANISM_XAUUSD` → the AI Worker's `OrganismDna.dna()`, `xauusd-organism.v1`). The DNA covers the five Workers, the 13 kernel agents and the AI tasks of its code. A new XAUUSD agent within the external ceiling registers itself by consensus: tier 1, no seat, `signals.observe`, `reports.publish`, `memory.recall` and `memory.remember` only. Anything above the ceiling is a census finding, never a registration. Its AI tasks register as engines by consensus too, one per hour (since 2026-11-12, when the Policy Engine's trading guard stopped reading target names; ADR-0009 amendment). |
| **Operator overview** (TP-019) | `/v1/overview`, `/v1/status` and MCP `platform_status` show `xauusd_latest` (decision, confidence, candle and time, from the newest flip warning or snapshot) and, since 2026-11-15, `trading_organ_health` (the newest metric snapshot). |
| **Agent registry** | 21 xauusd agents are registered in the kernel at tier 1 (migration 0016): 7 chain, bus and room agents, plus 14 HUD agents. They are subject to the global kill switch. They cannot publish until the binding below exists. |

## Connect the xauusd agents to the platform (instructions for the xauusd owner)

### 0. The agents are already registered

Migration 0016 registered **21 agents**. Every one has these properties:
- `host_worker = "xauusd-ai-trading-assistant"`;
- `tier_max = 1`;
- status `enabled`.

| Group | agent_id |
|---|---|
| H1 synthesis chain | `xauusd-reasoner` (`xauusd-analyst` and `xauusd-counselor`, never used, were deleted by 0048) |
| Bus, room and news threads | `xauusd-risk-manager`, `xauusd-moderator` (`xauusd-technical-analyst` and `xauusd-news-analyst`, never used, were deleted by 0047) |
| Pine HUD (11) | `hud-prophet`, `hud-trade-management`, `hud-interstellar-eyes`, `hud-kinetic-engine-tva`, `hud-fabio-amt-sensors`, `hud-chronos-matrix`, `hud-aegis-footprint-matrix`, `hud-tactical-muscles`, `hud-macro-aether-sensors`, `hud-decision-matrix`, `hud-mizan-oracle` (0087, 2026-11-22; R37 Funnel, GabFx Price Action, Playbook Execution and Grid Bot Protocol were dismantled on 2026-11-11) |

**Grants** (the same for every agent):

| Capability | Tier | Limit | Input |
|---|---|---|---|
| `reports.publish` | 1 | 4 per hour per agent | see §2 |
| `memory.remember` | 1 | 12 per hour per agent | `{ kind ≤ 80, text ≤ 1000, source_ref? ≤ 200 }` |
| `memory.recall` | 0 | — | `{ query ≤ 1000, top_k ≤ 5 }`; only the agent's own memories |
| `signals.observe` | 0 | — | Not needed. It reads the xauusd API itself. |

**Per-agent grants** (`XAUUSD_CEILING` in `control-plane-shared/src/organism.ts`, a guard path). Four xauusd agents differ from the table above:

| agent_id | Capabilities | Registered by |
|---|---|---|
| `xauusd-moderator` | the four above, plus `council.decisions.read` (tier 0, the council return path) | migration 0016; the grant by the census (ADR-0014 §11) |
| `nexus-teacher` | `corrections.record` only (tier 1, learning) | migration 0086 (HAIC H3e) |
| `shadow-knowledge` | `knowledge.verdict` only (tier 1, learning: no rate limit) | not seeded: the xauusd DNA declares it, then the census's routine `register_agent` (PF3, 2026-11-24) |
| `xauusd-model-router` | `model_router.status` (tier 0) and `model_router.report_paid` (tier 1, at most 4 an hour) only: the client of xauusd's own Beam router for its one Beam caller, `shadow:news_compare` (ADR-0007 amendment 2026-11-25; owner: "news_compare saja") | not seeded: the xauusd DNA declares it, then the census's routine `register_agent` (AIR1, 2026-11-25) |

**`knowledge.verdict`** (PF3; owner 2026-11-24, "harus dibuat jalurnya untuk feedback loop"). The shadow-knowledge arm writes its verdict on one of Aether's autonomous knowledge items (kinds `caution` and `role_reminder`) back to the platform; Aether's curator reads it with `knowledge.status` (`latest_verdict`). Declare the agent in xauusd's `organism.json` with exactly `capabilities: ["knowledge.verdict"]`, `tier_max: 1` and no seat; any other capability is above the ceiling and the census refuses the gene. The agent id is the one constant `SHADOW_KNOWLEDGE_AGENT`; renaming it is a one-line platform change.

```ts
await env.AGENTS.syscall("shadow-knowledge", "knowledge.verdict", {
  item_id: "k-prophet-trap",          // /^k-[a-z0-9-]{1,40}$/, the knowledge item's id
  item_version: 1,                    // integer 1..999
  verdict: "not_better",              // live | retired | not_better | worse | holdout_failed (terminal)
                                      // collecting | inconclusive | not_tested (not terminal)
  reason: "Treat 9 hits against control 26 over the window.", // 10..300 characters after whitespace is collapsed
  evidence: {                         // optional, and every key in it is optional; no other key is accepted
    arm: "treat",                     // /^[a-z0-9_.-]{1,32}$/, no run of 3+ digits
    window_start: "2026-11-10T00:00:00Z", window_end: "2026-11-23T00:00:00Z", // ISO UTC (Z), stored with milliseconds
    rows: 140, scored: 35, treat_hits: 9, control_hits: 26, aa_changed: 0, aa_total: 20, // non-negative integers
    p_value: 0.4124, p_holm: 0.82,    // numbers in 0..1, stored rounded to 4 decimals
    charts: ["60", "240"],            // at most 8, each /^[0-9]{1,4}$|^[a-z0-9_]{1,16}$/ ("1d", not "1D")
    rule: "holm_0.05+aa",             // /^[a-z0-9_.+-]{1,40}$/, no run of 3+ digits
  },
});
```

- The proposal is found by `(item_id, item_version)` in any status, from any proposer; the newest when several match. An unknown one fails with `knowledge_proposal_not_found: <item_id>@<version>`; a `param_candidate` fails with `knowledge_verdict_kind_refused`; a bad input fails with `invalid_knowledge_verdict: <errors>` and writes nothing.
- The reason is never refused for its content: secrets are redacted and prices masked as `[level]`, as in `correction.v1`. A forbidden key (a price, level, entry, stop, take profit, lot, param, action or vote word, as in the self-model) is refused at the top level and in `evidence`.
- Idempotent on `(proposal, verdict, window_end)`: a repeat returns the stored row with `deduplicated: true`. A new `window_end` is a new row, so send `collecting` with each window's end.
- The answer: `{ verdict_id, proposal_id, item_id, item_version, verdict, terminal, reason, evidence, window_end, created_at, deduplicated }`. The proposal's status is never changed by a verdict.

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
7. **The xauusd read API is behind Access (owner 2026-11-08).** `provision-access.yml` adds `ai.cryptophys.work/api/*` as a path destination of the one platform Access application, with the same policies.
   - **Who gets in:** the CI service token, the operators and the Nexus accounts.
   - **What stays public:** the rest of that host. TradingView posts to `/webhook`, which is protected by its secret, and the deploys probe `/health` and `/ready`.
   - **Who is unaffected:** the AI Kernel (`XAUUSD_AI`) and Nexus (`AI_WORKER`). Both read `/api/*` over Service Bindings, which do not pass through Access.
   - **How it is checked:** each provisioning run verifies the lock on `/api/status` and that `/health` is still open.

### 4. In the xauusd repository (its rules, not ours)

- The binding is an inter-Worker RPC Service Binding with no shared secret, which `AGENTS.md` rule 7 allows. Whether it counts as a topology change under `docs/SSOT.md` §5 is the owner's call. If it does, update `docs/SSOT.md`, `AGENTS.md` and `test/ssot-topology.test.mjs` in the same PR, with the owner's approval.
- Deploy only by merging into `main` there.

### 5. Verification after the xauusd deploy

1. From the Worker, `await env.AGENTS.whoami("xauusd-moderator")` returns:
   - `tier_max: 1`;
   - `status: "enabled"`;
   - the four capabilities above.
2. Publish one `info` report from `xauusd-moderator`, then tell the platform orchestrator. The orchestrator verifies it in D1 `agent_reports` and in `/v1/overview` (`agent_reports_24h`).

### 6. Relay to the Cerebrum chat (topic `ea_heartbeat`, owner 2026-11-16)

Owner 2026-11-16 ("pakai cara 2 lewat kernel"): the EA's heartbeat and terminal-health messages (for example `src/omega-broker.mjs`'s "Cerebrum Self-Healing Action", directive `restart_terminal` or `remediate_algo_trading` with its reason, or the Decision Engine's hourly "still <stance>" heartbeat) stop going to the xauusd Worker's own `TELEGRAM_CHAT_ID` (the Cryptophys-Nexus chat). The xauusd Worker publishes each one as an agent report; the AI Kernel forwards it to the alert channels that list the topic `ea_heartbeat` (Console → Alerts), which today means the "Cerebrum alerts" channel once the owner ticks the topic there. Code: `workers/ai-kernel/src/report-relay.ts`.

**The contract.** A report is relayed only when all of these hold; anything else is ignored (stored as an ordinary report, never sent):

| Field | Required value |
|---|---|
| `agent_id` | A registered agent whose `host_worker` is a service of the xauusd origin (`EXTERNAL_ORIGINS`: `xauusd-ai-trading-assistant` and the other xauusd Workers). The binding's pinned `host_worker` is what proves it; no other check is needed on the xauusd side. Registered and enabled on 2026-11-16, each with `reports.publish`: `xauusd-reasoner`, `xauusd-moderator`, `xauusd-risk-manager` and the ten `hud-*` agents of §0. No new grant is needed |
| capability | `reports.publish` (tier 1, 4 per hour per agent, unchanged) |
| `kind` | `xauusd_digest` |
| `severity` | `info` or `warning`. **Never `critical`**: a critical report is not relayed, and it counts toward the consensus brake |
| `subject` | Any (at most 200 characters, as for every report); not sent |
| `body.telegram_topic` | Exactly `"ea_heartbeat"` |
| `body.text` | The message, a non-empty string. Sent as plain text (no `parse_mode`): HTML tags such as `<b>` and `<code>` are removed, control characters (except new lines) and invisible formatting characters are removed, runs of blank lines are collapsed, anything shaped like a bot token is replaced by `[redacted]`, and the result is cut to 2000 characters (the last one `…`). Send it without HTML. A text that is empty after this is dropped (`invalid_text`) |
| other `body` fields | Allowed (16 KiB in all), not sent |

**Delivery.**
- At every kernel cron tick (:07, :22, :37, :52 UTC), so a message reaches the chat within about 15 minutes of its report.
- Each report is sent once, as one Telegram message, to every enabled alert channel with its own bot whose topics list `ea_heartbeat`. Never through the default channel (the xauusd bot it came from): the kernel refuses `ea_heartbeat` on `alc_default`.
- A report older than 2 hours when the kernel first sees it is dropped as `stale`. A report seen while no channel lists the topic is recorded as `no_channel` and is not sent later.
- At most 20 messages per hour per topic are sent. When more arrive, the newest are sent, the excess is dropped and folded into one summary line on the next message sent ("(N more ea_heartbeat messages not forwarded: at most 20 an hour)").
- A failed send is retried on the failed channel only, at most 3 times (`MAX_DELIVERY_RETRIES`).
- Each step is audited (`owner.relay_forwarded`, `owner.relay_delivery_retry`, `owner.relay_dropped`, subject `relay:<report_id>`) with the report, agent and channel ids and the outcome, never the text.

**The per-agent limit is the binding one.** `reports.publish` allows 4 reports per hour per agent (a guard path; this change does not raise it), and the kernel denies the fifth (`failed: rate_limit`), which rule 5 of §3 says not to work around. Terminal-health alerts can come every 3 minutes, about 20 an hour, so:
- **Batch.** Publish at most one relay report per 15 minutes per agent, its `text` holding every message since the last one, separated by a blank line (2000 characters fit about ten such alerts).
- **Choose the agent.** `xauusd-risk-manager` is the operational-risk agent, but it already publishes the health alerts (`src/health-alerts.mjs`, up to 3 an hour on 2026-11-15/16), so its budget is shared. The cleaner choice is a dedicated agent declared in the xauusd DNA (`organism.json`), for example `xauusd-ea-sentinel` with `signals.observe` and `reports.publish` and `tier_max: 1` (`reports.publish` is tier 1; a gene without `tier_max` registers at 0). The Forge's census reports it (`unregistered_agent`) and the Supervisor proposes the routine consensus action `register_agent`, within the external ceiling, with no owner click (ADR-0013). Once registered it has its own 4 an hour, and the kernel relays it like any other xauusd agent; until then publish as `xauusd-risk-manager`.

**Call shape** (as in §2):

```ts
await env.AGENTS.syscall("xauusd-risk-manager", "reports.publish", {
  kind: "xauusd_digest", severity: "info", subject: "EA terminal health", ai_status: "deterministic",
  body: { telegram_topic: "ea_heartbeat", text: "Cerebrum Self-Healing Action\nDirective: restart_terminal\nReason: terminal_disconnected\nStatus: Dispatched to VPS Host Bridge" },
});
```

Keep the xauusd-side Telegram send as a fallback only while the relay is not yet verified. Once a relayed message has reached the Cerebrum chat, stop sending these messages to `TELEGRAM_CHAT_ID`.

### What the platform needs to do

Nothing. The agents, their grants and the report kinds (`xauusd_digest`, `hud_digest`) already exist.
