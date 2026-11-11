# Aether integration (TP-027, TP-028)

Aether is the Knowledge Guardian cluster of the AI Mesh.

| | |
|---|---|
| Worker | `cryptophys-aether` |
| Repository | `cryptophys-adm/cryptophys-aether` |
| Deployed by | GitHub Actions on a merge to `main` (`.github/workflows/deploy.yml` in that repository) |
| Design | RFC_AETHER_KNOWLEDGE_GUARDIAN in `cryptophys-adm/xauusd-ai-trading-assistant` |

## Agents (tier_max 1, host `cryptophys-aether`)

| Agent | Capabilities | Role |
|---|---|---|
| `aether-auditor` | `signals.observe`, `reports.publish` | Decision audit over the XAUUSD decision cards |
| `aether-guardian` | `signals.observe`, `reports.publish` | Agent compliance against role and doctrine |
| `aether-curator` | `reports.publish`, `knowledge.propose`, `knowledge.status` | Learned-knowledge ledger; a person approves every item |
| `aether-calibrator` | `reports.publish`, `knowledge.propose`, `knowledge.status` | Parameter candidates for shadow tests; the owner promotes by PR |
| `knowledge-council` | `consensus.propose` (doctrine amendments only), `doctrine.status`, `reports.publish` | The Knowledge Council (migration 0045, owner 2026-11-11): proposes doctrine amendments; Cerebrum executes them |

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

## Learned-knowledge proposals (TP-028, RFC phase A6)

The curator and the calibrator draft learned-knowledge candidates. A person decides each one.

| Step | Where | Rule |
|---|---|---|
| Propose | `knowledge.propose` (tier 1, 6 an hour, 20 a day per agent) through `AgentRpc` | The kernel validates the item before it stores it (`workers/ai-kernel/src/knowledge.ts`, RFC §8.3). The claim is a measured outcome or a role reminder. The text is natural language of 300 characters or less, and every number in it appears in the evidence. It cites at least 10 decision cards. It never carries a price, level, size or order wording. |
| Review | Console **Knowledge** page, kernel `POST /v1/knowledge/{id}/approve` or `/reject` | Only an approver's own Access identity may decide; a service token or an agent never can. Each proposal is decided once and appended to the audit chain (`knowledge.proposed`, `knowledge.approved`, `knowledge.rejected`). A proposal still pending after 14 days expires. |
| Status | `knowledge.status` (tier 0) | Each agent reads only its own proposals and their decisions, without the item bodies. |

**Approval means "approved for shadow testing" only.** It never changes a live agent, a prompt or a parameter. Promotion stays an owner PR in `cryptophys-adm/xauusd-ai-trading-assistant`.

**Storage:** the proposals live in D1 `knowledge_proposals` (migration 0029). Aether keeps its own ledger and exports the approved pack.

## Doctrine amendments by the Knowledge Council (owner 2026-11-11, migration 0045)

Owner: "autonomous doctrine protocol harus dilakukan oleh knowledge council, dilakukan harian dan di
propose ke cerebrum untuk eksekusinya". The protocol itself is in the Aether repository, in
`docs/DOCTRINE_PROTOCOL.md`.

| Step | Where | What |
|---|---|---|
| Review | Aether, 03:52 UTC daily | The council's Nexus, Omega and Aether seats compare the doctrine's anchored facts with the facts the xauusd AI Worker reports every hour. A difference that the reporting seat measured twice from the same deployed version, and that the Aether seat validated, becomes a proposal. |
| Propose | `consensus.propose` as `knowledge-council` | `amend_doctrine` (routine): only the operational facts in `control-plane-shared/src/doctrine.ts` `DOCTRINE_BOUNDS`, each inside its hard bound. `amend_constitution` (critical): any other fact or a constitutional rule. Only this agent may propose these actions, and it may propose nothing else. |
| Vote | Cerebrum council | Every voter re-checks the amendment (`doctrineProblem`); the Policy Engine can veto it as usual. |
| Execute | kernel | `amend_doctrine` executes after the vote, in mode `routine` or higher. `amend_constitution` executes after one owner approval click on the Consensus page, in mode `critical`. Each execution writes `doctrine_amendments` and the audit event `doctrine.amended`. |
| Apply | Aether, hourly | `doctrine.status` (tier 0) returns the executed amendments. Aether applies only these, re-renders the rule and re-indexes its canon. The Console Knowledge page shows the session, the differences and the proposals. |

