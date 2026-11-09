# Single source of truth: current topology

`CLAUDE.md` and `AGENTS.md` point here. This page says what runs where **today**. The decisions behind it are in `architecture/adr/` (0001–0013). When this page and an ADR disagree, the newer ADR wins and this page is corrected.

Last reviewed: 2026-11-08 (`docs/RETROSPECTIVE-2026-11-08.md`).

## Platform rules

These hold everywhere:

- **Advisory only.** No trading, no funds, no orders, no price levels (ADR-0009, the knowledge validator).
- **No containers.** Production runs on Workers and their bindings only (ADR-0005 decision 1). The Forge type-check, which does not fit in an isolate, runs on Workers Builds from the Artifacts repository (ADR-0012 §5c, owner 2026-11-08; first report passed 2026-11-09).
- **Never weaken Access, auth or tests.** No test is skipped. A test that cannot run somewhere keeps running where it can.
- **The owner creates every secret and credential.** None is created by an agent or stored in the repository.
- **Data deletion and irreversible actions are critical.** The owner decides them.
- **The brake always works.** Consensus mode `shadow` and the kill switch (`kernel_controls.agents_enabled`) can be used at any time.
- **Repositories out of scope.** `cryptophys-adm/xauusd-ai-trading-assistant` (Nexus) and `cryptophys-adm/cryptophys-aether` are not changed from this repository.

## Entry point and sign-in (ADR-0008, ADR-0010, ADR-0011)

- **Hosts.** `https://nexus.cryptophys.work` is the only public origin. The Cerebrum Console is mounted at `/console/`, through the Workers route `nexus.cryptophys.work/console*`. `console.` and `home.` redirect there.
- **Sign-in.** Cloudflare Access is the only login. The identity providers are Google, Microsoft (OIDC) and one-time PIN (kept for now by owner decision, 2026-11-08). There is one Access application, `cryptophys-cloud-platform`, so there is one AUD and one 8-hour session.
- **Roles.** Configured identities come from `OPERATOR_IDENTITIES` and `APPROVER_IDENTITIES` (the owners). Accounts live in D1 `platform_accounts`:
  - `admin`: viewer, operator or approver;
  - `user`: Nexus only.

  Every Worker checks roles itself through `control-plane-shared/src/access.ts`.
- **Writes that shape production** (a recovery plan by hand, a service record, a desired version) need the approver role for a person (`requireApproverOrServiceOperator`, 2026-11-08). The deploy workflows' service token keeps recording versions and its verification plan, which is marked `synthetic` and hidden from the Console list.
- **Console sign-out.**
  - Sign out goes to `/cdn-cgi/access/logout`.
  - Switch account goes to `/console/switch-account`.
  - A Nexus-only account that opens the Console gets the access page.

## Workers

| Worker | Role | Cron (UTC minutes) |
|---|---|---|
| `cryptophys-console` | Backend-for-frontend with no authority of its own: the caller's JWT, a 50-route allow-list, CSP, CSRF | — |
| `cryptophys-platform-api` | Overview for the Console | — |
| `cryptophys-platform-registry` | Service registry, desired versions, accounts, Access group sync | — |
| `cryptophys-policy-engine` | Policy decisions (deploy, recovery, consensus.execute, agent syscalls) | — |
| `cryptophys-audit-ledger` | Hash-chained audit events | — |
| `cryptophys-recovery-manager` | Recovery plans and execution; daily D1 backup to R2 | :13 |
| `cryptophys-drift-detector` | Desired-versus-observed versions and health; reports once per episode | every 15 min |
| `cryptophys-deployment-orchestrator` | Deploy requests, the deployments list (Console Pipelines), native rollback (Deployments API), ledger reconcile | :02/:10/:17/:25/:32/:40/:47/:55 |
| `cryptophys-ai-kernel` | Agent registry, syscall gate, Supervisor, Auditor, consensus (ADR-0009), owner notices, knowledge | :07/:22/:37/:52 |
| `cryptophys-forge` | ADR-0012: source on Artifacts, Forge checks in Dynamic Workers, type-check reported by Workers Builds | :04/:19/:34/:49 |
| `cryptophys-forge-typecheck` | Workers Builds stub for the type-check and the Console UI build (`workers/forge-typecheck`, TypeScript 7): no route, no bindings, not in the registry | — |
| `cryptophys-home` | Retired (redirects to Nexus); scheduled for removal | — |
| `cryptophys-signal-engine` | Disabled (TP-018) | — |

**Observed only (health, not version):** four `xauusd-*` Workers and `cryptophys-aether`.

**Internal calls** use RPC service bindings (`HealthRpc`, `DriftRpc`, `RegistryRpc`, `DeployRpc`, `AgentRpc`). There are no shared secrets between Workers.

## Data

- **D1 `cryptophys-control-plane`.** One database for every service. Migrations live in `workers/control-plane-migrations/`, numbered from 0001; each Worker's readiness lists the ones it needs.
  - Migrations are applied **only by the Control Plane deploy**, so a commit with a new migration deploys the Control Plane first.
  - Every service requires `REQUIRED_MIGRATIONS` (`control-plane-shared/src/readiness.ts`). The Forge also requires 0031–0033 and 0035.
- **Retention.** `drift_observations` keeps 90 days and `agent_syscall_consumptions` 7 days (owner, 2026-11-05). Other tables are kept.
- **Backups.** The R2 bucket `cryptophys-d1-backups` gets a daily backup written by the Recovery Manager, with a 90-day lifecycle. D1 Time Travel is also available. A restore is critical (owner).

## The living platform (ADR-0013)

- **DNA.** Every Worker declares itself in `workers/<dir>/organism.json`: service, deploy unit, Access, rollback, drift probe, hosted agents (voter or not), AI engines. CI fails when a static list (deploy units, drift probes, Access, rollback, council, kernel agents, vote bindings, engines, names) disagrees with the DNA.
- **Census (phase 2).** The Forge compares the DNA of each main commit with `service_registry`, `agents` (and their seats) and `engines` (`forge_organism_census`, retaken every 30 min). Differences become the owner notice `organism` and appear on the Console Agents page.
- **Self-registration (phase 3).** The Supervisor turns census findings into consensus proposals, one per cycle:
  - `register_agent` and `register_engine` are routine: consensus only.
  - `register_privileged_agent` (a capability above tier 1, or `consensus.propose`) and `admit_voter` (a council seat, one per Worker) are critical: consensus plus the owner's click, in mode `critical` only.
  - The kernel takes the gene from the census, never from the proposal, so only merged DNA can register. Tier 3, unknown and trading capabilities are never registered.
  - A new seat must vote through a reviewed vote binding; without one it is refused. A seat the DNA no longer asks for is reported, never removed by an agent.

## Autonomy (ADR-0007, ADR-0009)

- **Current state.** Consensus mode is `deploy` (owner, 2026-11-07). The kill switch is on.
- **Routine actions.** Agents propose. The council votes: the enabled agents holding a seat (`agents.voter`, ADR-0013). Migration 0041 seeded the nine founding seats; new ones come only through `admit_voter`. The Policy Engine has a veto.
- **Limits.** One deploy per target per hour and six per 24 hours. Deploys run only at SAFE minutes.
- **Critical actions.** Auth and Access, the Policy Engine, the consensus rules and the kill switch, secrets, and destructive migrations need an owner click.
- **Workers AI.** It uses the free tier, capped at 250 requests a day. AI only drafts; every decision is deterministic.
- **CI gate for consensus deploys.** The gate requires a green push run of `Validate Control Plane Workers` on the main commit, every other push run green, and a green combined status. Renaming a required workflow silently stops deploys: from 2026-11-08 to 2026-11-09 the gate still required the removed `Validate` workflow, and no consensus deploy ran (fixed in #251). A test now requires every name the gate needs to be an existing workflow.

## Source, CI and deploy (ADR-0012)

| Step | Today | After phase 4–5 |
|---|---|---|
| Source of truth | GitHub `cryptophys-adm/cryptophys-cloud-platform` (`main`) | Artifacts `cryptophys/platform` |
| Mirror | `mirror-to-forge.yml` on every push (also reports pull request outcomes to the Forge) | — |
| Deploy plan (shadow) | Forge cron computes pending deploy units for main from Artifacts; the Orchestrator records its GitHub-based plan for the same inputs (`forge_deploy_plans`); plan parity towards 10 (ADR-0012 §5d) | Forge-planned deploys |
| Change requests (shadow) | `forge-change-request.yml` after CI on each same-repository PR: head to `cr/<n>`, registered as `gh-<n>`; Forge verdict vs GitHub outcome, merge parity towards 10 (ADR-0012 §5d) | Forge merges |
| CI | GitHub Actions (`validate-control-plane.yml` for every PR and main push, `forge-runner-parity.yml`) | Forge checks |
| Forge checks | Each new `main` commit: tests, bundles of every Worker, secret scan, plus the Workers Builds type-check and Console UI build; `ready` when all pass; `GET /v1/forge/checks`; parity with GitHub CI towards 20 | merge gate (phase 4 requires `ready`) |
| Deploy | `ops-dispatch.yml` (request files in `ops/requests/`), then `deploy-*.yml` (wait for SAFE minute, deploy, verify live, roll back on failure) | Orchestrator: Scripts API upload and Deployments API |
| Rollback | Native in the Orchestrator (`CF_DEPLOY_TOKEN`); `rollback-worker.yml` until the native path has run | native |

**Owner notices** run as a cron Worker in the AI Kernel (:22/:52). They show in the Console inbox and go by email from `alerts@notify.cryptophys.work`.

## Backlog that changes this page

| Item | Phase |
|---|---|
| Worker secrets to Secrets Store | ADR-0012 phase 4 |
| Deploy from the Forge, shadowed over 10 deploys | phase 4 |
| GitHub archived | phase 5 |
| `cryptophys-home` removed | after the redirect week |

See `docs/RETROSPECTIVE-2026-11-08.md` §7 for the order of work.
