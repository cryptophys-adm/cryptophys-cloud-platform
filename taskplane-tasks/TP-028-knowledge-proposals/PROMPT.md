# TP-028: Learned-knowledge proposals for Aether (tier 1)

Owner go: 2026-11-07 ("lanjutkan A6"), RFC_AETHER_KNOWLEDGE_GUARDIAN phase A6, in `cryptophys-adm/xauusd-ai-trading-assistant` `docs/`.

## Goal

Aether's curator and calibrator may propose learned-knowledge candidates. Only a person who is an approver approves one (for shadow testing) or rejects it. This is the kernel's tier 1 "propose" (ADR-0007), with the same separation of duties as the consensus owner decision.

## Files

- `workers/control-plane-migrations/0029_knowledge_proposals.sql` (new): the `knowledge_proposals` table and the grants.
- `workers/ai-kernel/src/knowledge.ts` (new): the validator, propose, status, list and decide.
- `workers/control-plane-shared/src/capabilities.ts`: `knowledge.propose` (tier 1, 6 an hour) and `knowledge.status` (tier 0).
- `workers/ai-kernel/src/syscall.ts` (dispatch and tier 0 handler) and `workers/ai-kernel/src/index.ts` (HTTP routes).
- Console: routes, allow list, the Knowledge page and the render smoke.
- `readiness.ts` (`REQUIRED_MIGRATION` 0029), migration pins in tests, a new `knowledge-tp028.test.ts`, and `docs/AETHER-INTEGRATION.md`.

## Requirements

1. Only `aether-curator` and `aether-calibrator` hold the two capabilities; both stay `tier_max 1`.
2. Every candidate is validated in the kernel (RFC §8.3), and refused with the reasons otherwise.
3. Only an approver's person identity decides, once. A service token or an agent never decides, and the proposer never reviews its own proposal.
4. A pending proposal expires after 14 days. An agent may propose at most 20 a day.
5. Every proposal and decision goes into the audit chain.
6. Approval never changes a live agent: promotion stays an owner PR in the xauusd repository.
