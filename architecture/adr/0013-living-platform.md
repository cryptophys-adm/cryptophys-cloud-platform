# ADR-0013: The living platform: DNA, census and self-registration

- **Status:** Accepted (owner, 2026-11-09)
- **Owner direction (2026-11-09):** "tidak hanya Ai Mesh jadikan semuanya autonomous seperti living digital organism" (not only the AI mesh: make everything autonomous, like a living digital organism).
- **Owner decisions (2026-11-09):**
  1. **New agents and engines** become active by **consensus**. The owner's click is needed only when they ask for a privileged capability (deploy, secrets, Access, data).
  2. **New council seats (voters)** need **consensus plus the owner's click**, because they change who decides. One vote per Worker.
- **Builds on:** ADR-0007 (AI Worker OS), ADR-0009 (consensus autonomy), ADR-0012 (the Forge).

## Context

An audit on 2026-11-09 found that the platform sees itself but does not recognise anything new on its own:

- **Agents** exist only through migrations. All 36 rows in `agents` say `updated_by: migration:00xx`. No API, no `agent.registered` event, and nothing is reported to consensus or the owner.
- **The council** (`VOTERS`, 9 ids), the kernel agents and the vote bindings are fixed in code and repeated in five or more places. A new agent never votes.
- **The Worker list** is repeated in eight places:
  - deploy units;
  - drift probes;
  - Access (`PLATFORM_WORKERS`);
  - the rollback allow-list;
  - the Control Plane deploy order;
  - plain-English names (Forge was missing);
  - and others.

  A Worker missed in one of them is silently not deployed, not protected or not observed.
- **AI engines** have no catalogue.
- **Text** in the Console and in SSOT stated fixed component lists and counts that were already wrong.

What is already living:

- The Drift Detector observes every registered Worker.
- The Supervisor proposes recovery and deploys.
- Consensus executes routine actions, rolls back, and alerts the owner.
- The registry reports a newly registered service.

## Decision

### 1. DNA: every Worker declares itself (`workers/<dir>/organism.json`)

The DNA is validated by `control-plane-shared/src/organism.ts`. It records:

- the service and its kind (`service`, `portal` or `build-stub`);
- its deploy unit;
- whether Access protects it;
- whether rollback is allowed;
- how the Drift Detector observes it;
- the agents it hosts: capabilities, tier, whether each is a voter, and the vote binding;
- the AI engines (tasks) it runs.

**The DNA is the single source of the platform's knowledge of itself.** Security lists stay static in code and workflows. The DNA does not replace them; it keeps them consistent and visible:

- the route allow-list;
- the rollback and retire allow-lists;
- Access;
- wrangler service bindings.

### 2. Phases

| Phase | What | Owner needed |
|---|---|---|
| **1 (this change)** | DNA for every Worker. CI requires every static list to equal the DNA: deploy units and the Control Plane order, drift probes and bindings, Access, rollback, voters, kernel agents, vote bindings and their wrangler blocks, AI engines, plain-English names, agent seeds. Dynamic Console footer (live organs from the overview). Report kind `knowledge_audit` in the Console and the shared type. The Supervisor finds kernel agents by `host_worker`, not by a fixed list. | no |
| **2. Census (done 2026-11-09)** | The Forge reads the DNA of each new `main` commit from Artifacts and compares it with `service_registry`, `agents` and a new `engines` table. It records new, missing and changed organs, publishes an "organism" report to the kernel, and raises an owner notice when something is missing. | no |
| **3. Self-registration (done 2026-11-09)** | New consensus actions: `register_agent` and `register_engine` (routine), `register_privileged_agent` and `admit_voter` (critical). The Supervisor proposes them from the census. When one passes, the AI Kernel writes the row. Removed organs are reported; retiring them stays the existing critical `retire_worker`. | voter seats and privileged capabilities |
| **4. Dynamic council (done with phase 3)** | The council is read from `agents.voter` (admitted seats only). A seat admitted after the founders votes only through its own Worker; without a vote binding it abstains and is reported, never replaced by the kernel's rule. | done by phase 3 admissions |

### 3. Guardrails (unchanged by autonomy)

- **No Sybil council.** There is one seat per Worker. A seat needs a vote binding in reviewed code and an owner click.
- **Capabilities are fixed at registration.** Changing them means re-registering the agent, which goes through the same gate.
- **Critical actions keep the owner click.** These are Access, secrets, policy, consensus rules, destructive migrations, retirement (`retire_worker`, and `retire_agent` since 2026-11-11) and trading. Trading stays prohibited.
- **The kill switch and the `shadow` mode still stop everything.**

### 4. Phase 2 as built (2026-11-09)

- **`forge/src/census.ts`.** Each Forge tick reads `workers/*/organism.json` at main's head from Artifacts and validates it. It compares the DNA with `service_registry` and `agents`.
- **Finding kinds:** `unregistered_service`, `disabled_service`, `unregistered_agent` (flagged when it asks for a council seat), `undeclared_agent`, `agent_host_changed`, `agent_capabilities_changed`, and `invalid_dna`.
- **Storage.** One row per main commit in `forge_organism_census` (migration 0040), holding the counts (organs, agents, seats, engines) and the genome summary.
- **Audit.** `forge.organism_census` is audited only when the findings change.
- **Owner notice.** The AI Kernel's notices gain the topic `organism`, which goes to the Console and to email when configured.
- **Console.** `GET /v1/forge/census` (route `forge.census`) feeds the Agents page panel "Organism census".
- **Scope.** The census reads only. Registration is phase 3.

### 5. Phase 3 as built (2026-11-09)

- **Migration 0041.** Adds `agents.voter`, seeded with exactly the nine founding seats of ADR-0009 §2, and the table `engines` (service, task, status), seeded with the engines the DNA declares. CI checks that the seeds equal the DNA.
- **Census.** New finding kinds: `unregistered_engine`, `undeclared_engine`, `voter_seat_requested`, `voter_seat_vacated`. The genome summary keeps each agent's full gene (name, capabilities, tier, seat). A census of an unchanged head is retaken every 30 minutes, so registrations show up without a new commit.
- **Proposals.** In each scheduled cycle the Supervisor proposes at most one registration, and each action and target at most once a day:
  - an unregistered agent becomes `register_agent`, or `register_privileged_agent` when it asks for a capability above tier 1 or for `consensus.propose`;
  - an unregistered engine becomes `register_engine`;
  - a requested seat becomes `admit_voter`.
- **Votes.** Every seat checks the same facts:
  - the agent is not registered yet;
  - its host Worker is registered and active;
  - its capabilities are known, not prohibited and not tier 3;
  - privileged capabilities are proposed as `register_privileged_agent`;
  - an engine task is a lowercase identifier;
  - a seat goes to an enabled agent whose Worker holds no seat.
- **Execution** (`ai-kernel/src/organism.ts`).
  - Each executor re-verifies the passed proposal and its Policy Engine decision.
  - It takes the gene from the latest census, not from the proposal: a proposal whose host or capabilities differ from the DNA fails.
  - A new agent is registered enabled and without a seat. The audit events are `agent.registered`, `engine.registered` and `consensus.voter_admitted`.
  - A seat also needs a vote binding in reviewed code that is bound in the deployment (or a founding seat's own rule). Without one, the admission fails even after the owner's click.
- **Critical actions run only in mode `critical`.** In mode `deploy`, `register_privileged_agent` and `admit_voter` are recorded and do not reach the owner. Raising the mode stays the owner's decision.
- **Founding exception.** The kernel hosts two founding seats (Supervisor and Auditor). This predates the one-seat-per-Worker rule, so no further kernel seat can be admitted.

## Consequences

- Adding a Worker, agent or engine means writing its DNA. CI fails until every list agrees. From phase 2 the platform notices on its own; from phase 3 it registers the newcomer itself once consensus passes.
- Counts in documents point to the DNA instead of stating fixed numbers.
