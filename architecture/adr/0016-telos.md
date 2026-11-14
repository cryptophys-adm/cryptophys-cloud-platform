# ADR-0016: Telos: a living vision, a self-model, and the Strategist that grows the organism

- **Status:** Accepted (owner, 2026-11-14: "setuju"). T0 is built (see "T0 as built"); T1–T5 are not built yet.
- **Owner direction (2026-11-14):**
  - Earlier the owner asked: "sejauh mana supervisor punya visi masa depan system ini?" (how far does the Supervisor have a vision of this system's future?).
  - Then: "visi harus bertumbuh sesuai dengan learning dan knowledge termasuk kemampuan membaca dan mengevolusi nexus, aether, cerebrum dan semua komponen. Jadi harus punya model yang kuat, dia tidak bekerja setiap waktu tapi harus punya kesadaran diri dan ecosystem untuk terus berevolusi dan bertumbuh, semakin pintar semakin cerdas, resilience dan adaptif."
  - In English: the vision must grow with learning and knowledge, including the ability to read and evolve Nexus, Aether, Cerebrum and every component. So it needs a strong model. It does not work all the time, but it must be aware of itself and of its ecosystem, so that it keeps evolving and growing: smarter, more intelligent, resilient and adaptive.
- **Builds on:**
  - ADR-0009 (consensus, brake, owner's click);
  - ADR-0013 (DNA, census, self-registration);
  - ADR-0014 (evolution loop; E0 self-inventory, E2 evolver, E5 morphogenesis);
  - ADR-0015 (organs as cells; the AI Neuron is the core);
  - the Observer organ (in progress, 2026-11-14; not on main yet).

## Context

- **The Supervisor is a homeostasis organ.** Every 15 minutes it reacts to the present state: drift, pending deploys and merges, unregistered components, the Access plan, metabolism and stale proposals.
- **The organism has no direction of growth.** Nothing in it:
  - holds goals beyond "stay healthy";
  - reads the ADRs, the backlog or its own code to decide what to become next;
  - measures whether a change made the organism better.
- **The vision lives outside the organism:** in the owner, in the ADRs and in operator sessions.
- **The ingredients already exist, but nothing joins them toward a purpose:**
  - self-knowledge: census and DNA, and the Observer once it lands (in progress, 2026-11-14);
  - learning: outcome scores, reputation, Aether's knowledge and doctrine, and the Knowledge Council;
  - the ability to change: the Forge, consensus and the evolver groundwork.

## Decision

### 1. A living vision, in two layers (`organism/vision.json`, schema-validated)

- **Core.** Owned by the owner, on a guard path. It holds:
  - the mission;
  - the constitution: the guards that never change by AI;
  - the identity of the organism and its organs.

  The AI may propose amendments. An amendment takes effect only after `merge_owner_change` and the owner's click.
- **Growth layer.** It holds goals, each with:
  - measurable KPIs, a current baseline and a target;
  - a horizon: now, quarter or year;
  - the organs it touches;
  - the evidence that motivated it;
  - the hypotheses being tested.

  This layer grows from learning. The Strategist proposes new goals, revised targets and retired goals, and each proposal carries evidence. Adoption works like a doctrine amendment: by consensus, and with the owner's click until the owner relaxes that by a later amendment.
- Every vision change is versioned and audited. The Console shows the full history.

### 2. A self-model: the organism's knowledge of itself and its ecosystem

A **daily snapshot**, assembled deterministically (no AI) from existing organs:

- **Body:**
  - census and DNA;
  - account inventory, including undeclared items;
  - Observer vitals and anomalies;
  - costs from billing and the neuron allocation;
  - deploy history.
- **Mind:**
  - outcome scores and agent reputation;
  - the shadow arenas;
  - Aether's knowledge state (canon version, index state, Knowledge Council amendments);
  - doctrine.
- **Memory:** the ADR index and SSOT, the backlog, and the experience ledger (§5).
- **Code map:** the platform repository from the Forge (Artifacts), and the external repositories through their DNA and a read-only mirror where one is configured. Covered: Nexus, Cerebrum (Console), the kernel, the Forge, and the xauusd Workers.
- **Ecosystem:**
  - the Cloudflare changelog and model catalog: deprecations, new models and pricing (e.g. the 24 older Workers AI models that stop answering on 2026-11-20 with HTTP 410);
  - market regime and session calendar;
  - dependency advisories.

The snapshot is compact and stored in R2. Its index row is in D1.

### 3. The Strategist: a new organ, asleep most of the time

- **It does not run all the time.** It wakes in three cycles:
  - **Daily reflection** (light): what changed, which goals moved, which intents finished.
  - **Weekly strategy** (deep): it reads the whole self-model, computes the gap per goal, and ranks evolution intents.
  - **Triggered wakes:**
    - an Observer anomaly cluster;
    - a KPI regression after a deploy;
    - a new Aether canon or doctrine change;
    - a market-regime change;
    - an upcoming ecosystem deadline, such as a model deprecation;
    - a message from the owner.
- **Strong model, inside Cloudflare by default:** `@cf/deepseek-ai/deepseek-v4.1-flash-1017` on Workers AI. Facts verified against the Cloudflare documentation on 2026-11-14:
  - a context window of 1,048,576 tokens;
  - reasoning effort high by default;
  - $0.30 per million input tokens, $1.20 per million output tokens and $0.006 per million cached input tokens;
  - Cloudflare's deprecation notice of 2026-11-05 recommends it, together with `@cf/zai-org/glm-5.3`, for frontier needs; 24 older models stop on 2026-11-20 (HTTP 410).

  The model id and prices are checked against the Workers AI catalog again when the Strategist is built (T2).
  - The large, stable self-model prefix is cached. Cached input is billed at $0.006 per million tokens.
  - Escalation to a model outside Workers AI (through AI Gateway, within a daily budget the owner sets) is the owner's decision. ADR-0014 Q2 first allowed such a model for code, but its amendment of 2026-11-13 set the code model to `gpt-oss` on Workers AI only. This ADR does not change that: the Strategist writes intents, and the evolver alone writes code.
  - The Strategist's model is itself chosen by an arena (§6).
- **Output is metric-form, not prose.** Each evolution intent states:
  `{goal, kpi, current, target, gap, organ, proposed_change, expected_effect, risk, confidence, evidence_refs}`.
- **Budget.** The Strategist has its own neuron budget and kill switch, as the shadow arms do. Estimated cost: about $0.10 per deep cycle and $0.02 per reflection.

### 4. Closing the loop: intent → change → measurement

1. An intent becomes a task. For the platform repository, the evolver (ADR-0014 E2) writes the change within the E2 limits (1 change in flight and at most one started per 4 hours, 400 lines, 20 files, tests that only gain assertions). It goes through Forge checks and consensus, and the owner's click on guard paths.
2. For repositories with their own process, the Strategist files the intent with that repository's session:
   - **xauusd:** through its session.
   - **Aether:** report-only until the owner lifts the standing rule, as described under "Rules that do not change".
3. After the deploy, the Observer and the outcome scores measure the effect against the expected effect.

### 5. Experience ledger and getting smarter

- **Ledger.** Every intent is recorded with its evidence, its change, its measured effect and a verdict (worked, neutral, harmful, rolled back). The ledger is kept in D1, and older entries are archived to R2.
- **The Strategist earns a reputation,** as room agents do. Its later prompts carry its own track record: which kinds of intervention moved which KPIs. Wrong priors decay.
- **Knowledge flows into the vision.** A finding that proves out becomes doctrine through the Knowledge Council, or a new goal through §1. Examples: a metric reading that predicts outcomes, an engine that adds accuracy, a cheaper architecture.

### 6. Resilience and adaptation

- **Ecosystem watch.** Deprecations, pricing changes and quota trends become intents before they become incidents.
- **Recovery drills.** Once a month the Strategist schedules a drill, for example restoring the latest D1 backup into a scratch database and checking row counts, so that resilience is proven and not assumed.
- **Self-arena.** The Strategist's model and prompt are evaluated quarterly in shadow against alternatives, using the experience ledger as the score.

### 7. Visibility: a Vision page in the Console

The page shows, from top to bottom:

- the mission and constitution, read-only;
- goals → KPIs → current, target and trend;
- active intents and their status;
- the experience ledger, with verdicts;
- the Strategist's reputation;
- the vision version history.

All of it is metric-form and console-truthful.

## Rules that do not change

- Consensus, the brake, rollback, backups, the append-only audit chain and the kill switches.
- No fund movement. Trading actions need the owner's click. No widening of trading autonomy by any intent.
- Guard paths and the constitution change only through `merge_owner_change` and the owner's click.
- **cryptophys-aether is not modified by the platform** (a standing owner rule). The Strategist reads Aether's published state and proposes; it does not write to Aether until the owner explicitly lifts this rule.

## Phases (each in shadow first)

| # | Phase | Output |
|---|---|---|
| T0 | Vision schema, a core draft from the owner's directions, the Console Vision page (read-only) | The owner reviews and corrects the draft |
| T1 | Self-model snapshot, daily | Measured self-knowledge, including the ecosystem |
| T2 | Strategist in shadow: reflection, weekly strategy, triggered wakes | Ranked intents; no action taken |
| T3 | Intents → evolver (platform) and → repository sessions; experience ledger; Strategist reputation | A closed loop of evolution |
| T4 | Vision growth: the Strategist proposes goal and KPI amendments | The vision grows with learning |
| T5 | Morphogenesis (ADR-0014 E5): proposals for new organs | The organism grows new organs |

## T0 as built (2026-11-14)

- **The vision.** `organism/vision.json` holds the core drafted from the owner's directions and five growth goals. Every KPI baseline is `null` (not measured yet), and so are the targets the owner has not set. The owner reviews and corrects the draft.
- **The schema.** `control-plane-shared/src/vision.ts` validates `organism.vision.v1` as a pure function that lists every problem:
  - the core: a mission, an identity (`core_organ`, `organs`) and a non-empty constitution;
  - the goals: a unique id matching `g-[a-z0-9-]+`, a horizon (`now`, `quarter` or `year`), organs, KPIs and evidence;
  - each KPI: an id unique within its goal, a baseline (a number or `null`), a target (a number, a string or `null`) and a source.

  CI validates `organism/vision.json` with it (`test/vision-telos-0016.test.ts`), so an invalid vision fails CI.
- **Guard paths.** `organism/vision.json` and `control-plane-shared/src/vision.ts` are guard paths with the reason `vision_core` (`guard-paths.ts`). A change to either is `merge_owner_change` and waits for the owner's click, and the evolver can never write them.
- **Read-only route.** The AI Kernel bundles `organism/vision.json` at build time. It serves the vision at `GET /v1/vision` to operators, after checking it again: an invalid vision is reported with its problems and never served as valid. The route reads no table and writes nothing. A change to the vision redeploys the Control Plane unit, which holds the kernel (`deploy-units.ts`).
- **Console.** The Vision page (`#/vision`, in the nav after Organism) reads only `kernel.vision`, which is one more read-only row in the Console allow-list. It shows the mission, identity, constitution, and the goals with their KPIs. A `null` baseline or target is shown as "not measured yet", never as a number. The render smoke test renders the page.
- **Not built:** the self-model (T1), the Strategist (T2), intents and the experience ledger (T3), vision growth (T4), morphogenesis (T5), and the vision's version history on the Console.

## Consequences

- **Good.** The organism gains direction, memory of what worked, and foresight about its ecosystem. Growth becomes measurable. The owner steers the mission and the constitution, not every change.
- **Costs and risks:**
  - A new organ, and more autonomy in proposing change. This is mitigated by the shadow phases, the E2 limits, guard paths, budgets, the kill switch and full visibility.
  - Model quality is the bottleneck, which the self-arena addresses.
