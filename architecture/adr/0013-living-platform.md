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
| **2. Census** | The Forge reads the DNA of each new `main` commit from Artifacts and compares it with `service_registry`, `agents` and a new `engines` table. It records new, missing and changed organs, publishes an "organism" report to the kernel, and raises an owner notice when something is missing. | no |
| **3. Self-registration** | New consensus actions: `register_agent` and `register_engine`. They are routine; they become critical when an agent asks for a privileged capability. Also `admit_voter`, which is always critical. The Supervisor proposes them from the census. When one passes, the Platform Registry writes the row. Removed organs are proposed for retirement, which is always critical. | voter seats and privileged capabilities |
| **4. Dynamic council** | `VOTERS` is derived from `agents.voter` (admitted seats only), with one seat per Worker. A seat whose vote binding is missing is reported, not silently replaced by the kernel's rule. | done by phase 3 admissions |

### 3. Guardrails (unchanged by autonomy)

- **No Sybil council.** There is one seat per Worker. A seat needs a vote binding in reviewed code and an owner click.
- **Capabilities are fixed at registration.** Changing them means re-registering the agent, which goes through the same gate.
- **Critical actions keep the owner click.** These are Access, secrets, policy, consensus rules, destructive migrations, retirement and trading. Trading stays prohibited.
- **The kill switch and the `shadow` mode still stop everything.**

## Consequences

- Adding a Worker, agent or engine means writing its DNA. CI fails until every list agrees. From phase 2 the platform notices on its own; from phase 3 it registers the newcomer itself once consensus passes.
- Counts in documents point to the DNA instead of stating fixed numbers.
