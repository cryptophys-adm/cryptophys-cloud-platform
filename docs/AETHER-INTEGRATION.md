# Aether integration (TP-027)

Aether is the Knowledge Guardian cluster of the AI Mesh.

| | |
|---|---|
| Worker | `cryptophys-aether` |
| Repository | `cryptophys-adm/cryptophys-aether` |
| Deployed by | Cloudflare Workers Builds |
| Design | RFC_AETHER_KNOWLEDGE_GUARDIAN in `cryptophys-adm/xauusd-ai-trading-assistant` |

## Agents (tier_max 1, host `cryptophys-aether`)

| Agent | Capabilities | Role |
|---|---|---|
| `aether-auditor` | `signals.observe`, `reports.publish` | Decision audit over the XAUUSD decision cards |
| `aether-guardian` | `signals.observe`, `reports.publish` | Agent compliance against role and doctrine |
| `aether-curator` | `reports.publish` | Learned-knowledge ledger; a person approves every item |
| `aether-calibrator` | `reports.publish` | Parameter candidates for shadow tests; the owner promotes by PR |

They publish `knowledge_audit` reports, `info` or `warning` only, advisory, never with price levels.

## How Aether reaches the kernel

The same pattern as xauusd: one RPC Service Binding in Aether's Wrangler configuration, with no secret.

```jsonc
"services": [{ "binding": "AGENTS", "service": "cryptophys-ai-kernel", "entrypoint": "AgentRpc", "props": { "host_worker": "cryptophys-aether" } }]
```

## State machine vs state market

| | Owner | Holds |
|---|---|---|
| State machine | The platform | Platform state, and the kernel's per-agent memory index `cryptophys-agent-memory` |
| State market | Aether | Market knowledge, in its own D1 and Vectorize indexes, separate from the kernel's |

Aether reports to the kernel and asks it for approvals. It never writes control-plane state, and the kernel never writes market knowledge.

## Drift observation

- `0027` added the row as `disabled`.
- After Aether's first deploy, `0028` sets it to `registered`, and the Drift Detector probes `/health` over its `EXT_AETHER` service binding. Aether is health-managed only, like the xauusd Workers.
