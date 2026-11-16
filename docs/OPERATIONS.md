# Operations

## Health checks

- GET /health or /healthz: process-level health metadata.
- GET /ready or /readyz: readiness; currently no external dependencies.
- GET /: service metadata and implemented endpoints.
- Unsupported paths return JSON 404; non-GET/HEAD methods return JSON 405.

## Incident handling

1. To pause deployments, pull the brake: consensus mode `shadow` or the kill switch (`kernel_controls.agents_enabled`). Restricting the GitHub production Environment also stops the workflow fallback.
2. Inspect the deployments ledger (Console Pipelines, `GET /v1/deployments`), the commit SHA, the workflow run if the fallback ran, and the Cloudflare Worker logs.
3. Roll back natively (consensus `rollback_worker_version`, or an approved recovery plan), or revert through a reviewed change that the agents then deploy by consensus; do not use force-push as routine rollback. Since 2026-11-14 (owner) there is no Console or Orchestrator path that deploys outside consensus (`docs/SSOT.md`, "Paths to production"). When the Forge, the Orchestrator and consensus are all down, the owner uses "Last resort: the organism is down" below.
4. If a token or secret is exposed, revoke/rotate it at its issuer immediately.
5. Record the timeline, impact, mitigation, and follow-up work in a reviewed document or issue.

## Control-plane checks

- Audit integrity: `GET /v1/verify` on the Audit Ledger must return `"valid": true`.
- Drift: the Drift Detector runs every 15 minutes; `GET /v1/drift` shows the latest observation per Worker. A Worker is `degraded` when its live version tag differs from the registry `desired_version`, and `unavailable` when its health check fails.
- Registry and drift inventory (TP-026): the Platform Registry holds 10 platform Workers (`cryptophys-platform-api`, `cryptophys-deployment-orchestrator`, `cryptophys-platform-registry`, `cryptophys-policy-engine`, `cryptophys-drift-detector`, `cryptophys-audit-ledger`, `cryptophys-recovery-manager`, `cryptophys-ai-kernel`, `cryptophys-console`, `cryptophys-forge`), the external Workers (the `xauusd-*` Workers, among them `xauusd-ai-trading-assistant`, `xauusd-fundamental-news-ingestion`, `xauusd-tradingview-pull-adapter`, `xauusd-nexus-dashboard`, and `cryptophys-aether`), and two retired rows kept with status `disabled`: `cryptophys-signal-engine` (0020) and `cryptophys-home` (0055, 2026-11-13), both marked retired by 0064 (2026-11-14, `metadata.retired_at`; both Workers are deleted). The Drift Detector probes the 9 other platform Workers over their `HealthRpc` entrypoint service bindings and the external Workers over HTTP, except `cryptophys-cta` (2026-11-16), which it probes over `EXT_CRYPTOPHYS_CTA`, the `CtaHealth` entrypoint's `health()` (healthy when it answers `ok: true` for `cryptophys-cta`; health-managed only), once a registry row for it exists; a `disabled` row is recorded with reason `disabled`, never probed and never drift; a retired row is skipped entirely (no probe, no observation, no heartbeat) and is left out of `GET /v1/drift` and the kernel's platform view.
- Owner notices (ADR-0012 phase 2): the AI Kernel computes three notices at :22 and :52, sends them to the Console, and emails them to the owners (`APPROVER_IDENTITIES`) from `alerts@notify.cryptophys.work`. They replace the former GitHub issues of `drift-alert.yml` and `owner-attention.yml`:
  - `owner_attention`: draft recovery plans, critical proposals and pending knowledge proposals waiting for an owner click. Since 2026-11-11 (owner: "buat notif telegram jika ada yang perlu approve owner di semua cerebrum") this topic also goes to the owner's Telegram through the Service Binding `OWNER_TELEGRAM` (the xauusd AI Worker's `OwnerNotifier`, which holds the bot; the platform holds no Telegram credential): one message when items open or change and one when they are resolved; a failed send is retried at the next run;
  - `drift`: drifted, unhealthy, never observed, or not observed for 45 minutes;
  - `critical_reports`: critical agent reports in the last 24 h.
  - `production_unhandled` (Telegram): production problems no agent is handling, among them the deploy stall alarm below.
  - Each opened, changed or closed notice is an `owner.notice_*` audit event. A failed email is retried at the next run.
  - The live notices are at `GET /v1/notices` on the AI Kernel and in the Console under Command → "Needs your attention".
- Deploy stall alarm (owner 2026-11-14, `control-plane-shared/src/deploy-stall.ts`; `docs/SSOT.md`, "The Observer"): at :27 and :57 the Platform API's Observer raises one warning report (`platform_digest`, agent `platform-api`, `body.source = "deploy_stall"`) per stall episode when main's head is `ready`, a deploy unit does not run it, the plan lists a unit or a skip, and no `deploy_commit` has executed for more than 2 hours. The report names main's sha, the plan's `forge_skipped` reasons, the age of the last executed `deploy_commit` and the units behind; the owner gets it on Telegram as the `production_unhandled` item `deploys_stalled`. It is a warning, not critical, so it never holds the consensus brake that the fixing deploy needs. It resolves itself (a `Resolved:` info report with the same `alert_key`, and the notice closes) once a `deploy_commit` executes. To act on it: read the skip reasons, fix the planner input (for `compare_failed_or_diverged`, a registry `desired_version` the Forge cannot find in main's history), and let the agents deploy. If the organism itself is down, see "Last resort: the organism is down" below.
- Readiness of every control-plane Worker lists the individual checks that failed.

## Recovery posture

Durable state lives only in D1 `cryptophys-control-plane` (owner `cryptophys-adm`).

- Backup: D1 Time Travel provides continuous point-in-time recovery within its 30-day window. `deploy-control-plane.yml` logs a bookmark before it migrates; the native deploy records one before any destructive migration (`deployment.restore_point_recorded`, "Destructive D1 migrations" below).
- RPO: minutes (Time Travel granularity). RTO: under 30 minutes (restore + redeploy through the workflow).
- Restore verification: after any restore, run `GET /v1/verify` on the Audit Ledger and a drift observation, and record the restore as a new audit event.
- Recovery plans for each service are stored in the Recovery Manager and need a second person to approve.

## Last resort: the organism is down

**For the owner only, and only when the organism is down:** the Forge, the Deployment Orchestrator and consensus are unavailable, so no `deploy_commit`, `rollback_worker_version` or approved recovery plan can run. While any of them works, use the normal paths above: they are the only paths to production (`docs/SSOT.md`, "Paths to production"). Agents never use this section. A person with the owner's Cloudflare login acts directly on the Workers, and records it afterwards. Checked against the Cloudflare docs on 2026-11-14:
- [Rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/), last updated 2026-11-12;
- [Wrangler Workers commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/), last updated 2026-10-26;
- [Versions and deployments](https://developers.cloudflare.com/workers/versions-and-deployments/) and [Infrastructure as code](https://developers.cloudflare.com/workers/platform/infrastructure-as-code/) (the REST calls);
- the API reference [List Versions](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/list/);
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), last updated 2026-11-06.

Re-check them before you act; commands and limits change.

**0. Before you touch anything.**
- Pull the brake if the AI Kernel still answers: `POST /v1/kernel/agents-enabled` with `{"enabled": false}` (any operator), or consensus mode `shadow`. Otherwise, once the organism comes back, the Drift Detector sees your version as drift from `desired_version`, and the Supervisor proposes to redeploy over it.
- Use your own credentials: the dashboard, `wrangler login`, or an API token you create for this (Account → Workers Scripts → Edit; D1 → Edit for a restore). Never use or copy a Worker's secret (`CF_DEPLOY_TOKEN` and the others), and never commit or paste a token.
- Prefer a rollback to an existing version. It keeps that version's code, bindings, vars and secrets exactly as they were deployed. A fresh `wrangler deploy` from a checkout needs what the deploy workflows substitute (the D1 `database_id` for `__CONTROL_PLANE_D1_DATABASE_ID__`, `OPERATOR_IDENTITIES`, the version `--tag`), so it is the last of the last resorts.

**1. Find the last good version.** Every platform deploy tags its version with the first 12 characters of the commit (`wrangler deploy --tag`, annotation `workers/tag`), and the registry records the same tag.
- What each Worker should run: `npx wrangler d1 execute cryptophys-control-plane --remote --command "SELECT service_id, desired_version, updated_at FROM service_registry WHERE status != 'disabled' ORDER BY service_id"`.
- What was deployed, and how it ended: `npx wrangler d1 execute cryptophys-control-plane --remote --command "SELECT service_id, requested_version, status, requested_by, updated_at, details_json FROM deployment_requests ORDER BY updated_at DESC LIMIT 30"`. A `succeeded` row before the trouble started is a good candidate; `details_json` names the unit, the workflow and the consensus proposal.
- The version id for that tag: `npx wrangler versions list --name <worker> --json` (the recent versions, with their tag and message), `npx wrangler deployments list --name <worker>` (which versions served traffic, and when), and `npx wrangler versions view <version-id> --name <worker>` to check one. Rollback reaches only the 100 most recent versions.
- Without D1: the dashboard's **Deployments** list (below) shows each version's tag and message (`commit <sha>`).

**2. Roll back or redeploy a Worker.** Worker names are those of the registry: `cryptophys-ai-kernel`, `cryptophys-deployment-orchestrator`, `cryptophys-forge`, and so on. A Control Plane problem may need all six Workers of the unit (`control-plane-shared/src/deploy-units.ts`).
- **Dashboard.** Workers & Pages → the Worker → **Deployments** lists its versions and its deployments. To roll back, select the three dots next to the version, then **Rollback**. A rollback is a new deployment with that version at 100 % of traffic, on all of the Worker's routes and domains.
- **Wrangler.** `npx wrangler rollback <version-id> --name <worker> --message "owner last resort: <why>"`. Without a version id it picks the version uploaded before the latest one, so always give the id. `npx wrangler versions deploy <version-id>@100% --name <worker> --message "owner last resort: <why>" -y` does the same for any recent version.
- **REST API** (base `https://api.cloudflare.com/client/v4`, header `Authorization: Bearer <your token>`):
  - list versions: `GET /accounts/{account_id}/workers/scripts/{script_name}/versions?per_page=100`;
  - inspect one: `GET .../versions/{version_id}`;
  - list deployments: `GET .../deployments`;
  - deploy (the call the Orchestrator's native rollback makes, `native-rollback.ts`): `POST .../deployments` with `{"strategy": "percentage", "versions": [{"version_id": "<id>", "percentage": 100}], "annotations": {"workers/message": "owner last resort: <why>"}}`.
- **Refusals.** Cloudflare refuses a rollback across a Durable Object class change (the AI Kernel holds Durable Objects), or to a version bound to an R2 bucket, KV namespace or queue that no longer exists.
- **Console assets.** Pages loaded before a Console rollback may still ask for the newer version's assets for a while.
- **New code.** When no existing version is good, the deploy workflows' own `workflow_dispatch` (`deploy-<unit>.yml`, input `commit_sha`, `confirm_production: DEPLOY`) is still on GitHub until the owner retires it (`docs/GITHUB-CUTOVER.md`). It deploys only GitHub's main head and keeps the substitutions, the SAFE minute and the live check.
- **Check.** `/health` and `/ready` of each Worker you changed answer, and `npx wrangler deployments status --name <worker>` shows your version.

**3. Restore the control-plane database (D1 Time Travel).** This is critical and destructive, and only the owner decides it (`docs/SSOT.md`, "Backups"). It overwrites `cryptophys-control-plane` in place for every service, so everything written after the restore point is gone from the live database: audit events, consensus, reports and registry changes. In-flight queries fail.
- **Window.** The account is on Workers Paid, so the window is 30 days (7 on Free).
- **Where to restore to.** A Control Plane deploy through `deploy-control-plane.yml` logs a pre-migration bookmark ("Pre-migration D1 bookmark" in its run summary). A native deploy that applies a destructive migration (an owner-approved `deploy_destructive_migration`, or a break-glass plan naming the file) records the bookmark first: the audit event `deployment.restore_point_recorded` and `details_json.restore_point` of its `deployment_requests` row ("Destructive D1 migrations" below). An additive native migration records only `restore_point_at`, a time. For any other point in time: `npx wrangler d1 time-travel info cryptophys-control-plane --timestamp=<RFC3339 or unix>`.
- **Restore.** `npx wrangler d1 time-travel restore cryptophys-control-plane --bookmark=<bookmark>` (or `--timestamp=...`).
- **Undo.** The restore prints the bookmark from before it, which undoes it. Write it down first.
- **Migrations.** `d1_migrations` goes back with the data, so after a restore to before a migration, roll the Control Plane Workers back to versions from before that migration too: their readiness requires every migration they were built with (`REQUIRED_MIGRATIONS`). Then let the next Control Plane deploy apply the migrations again.
- **Older than 30 days.** The daily backup in R2 `cryptophys-d1-backups` (Recovery Manager, 90 days) is the only copy.

**4. Afterwards: record it.**
- **Audit.** Once the Audit Ledger answers, record each action as an audit event: `POST /v1/events` on `cryptophys-audit-ledger` as yourself, through Access (the Console does not forward it). Use `{"event_type": "owner.last_resort_rollback" | "owner.last_resort_deploy" | "owner.d1_restore", "subject": "<worker or cryptophys-control-plane>", "outcome": "success" | "failed", "payload": {...}}`. The payload holds the from and to version ids and tags, the bookmark restored to and the undo bookmark, the time, and the reason. After a D1 restore, also run `GET /v1/verify` (it must return `"valid": true`) and a drift observation (Console Infrastructure → observe now).
- **Registry.** Make the registry match what runs: `PUT /v1/services/{service_id}/desired-version` on the Platform Registry (approver) with the tag now live. Or leave the old `desired_version` deliberately, so that the agents redeploy main once they are healthy. Then switch agents back on (`POST /v1/kernel/agents-enabled` `{"enabled": true}`, approver).
- **Owner page.** Acknowledge the critical reports the outage left open once they are handled, so that the brake releases.
- **The report.** Agents publish reports; a person does not. Write the incident record as a reviewed document (step 5 of "Incident handling": timeline, impact, every command run, versions and bookmarks, follow-up work), and submit it as a change request like any other.

## When the deploy executor's own fix is blocked (2026-11-15)

The Deployment Orchestrator executes every native deploy and every break-glass deploy of the other units. A bug in that path can block its fix: on 2026-11-15 the native Control Plane deploy failed on reading a version it had just uploaded (`cloudflare_api_404_100146`, a different Worker each time), the fix (4e64060) lived in the Orchestrator, and the planner deployed the Control Plane before the Orchestrator because a migration was pending.

Two changes close this (cut-over gate, owner 2026-11-15, "1 setuju"):
- **Executor first.** When main changes the orchestrator unit, the planner deploys it first and alone, also while a D1 migration is pending, provided no pending migration names a table, column or index that the Orchestrator's bundled code at main mentions (`control-plane-shared/src/executor-first.ts`; the Forge reads main's bundles and the migration SQL, the Orchestrator's own native deploy checks the same evidence). When one does, or the evidence cannot be read, the Control Plane goes first as before, and the plan's skip says why (`executor_first_not_proven:<reason>`). The Orchestrator's readiness needs no migration after 0029, so a pending migration alone never makes it unready.
- **Rescue deploy.** If the Orchestrator then cannot deploy itself, its unit is deployed by the Recovery Manager, without the Orchestrator ("Rescue deploy of the Deployment Orchestrator" below).

**Signs.** The Owner page lists "deploy executor blocked" (`executor_deploy_failed`): the Orchestrator's own last native deploy of its unit failed in the last 24 hours. Or the same `deploy_commit` of a unit fails again with the same reason, the fix for that reason is merged on main, and the fix is in `workers/deployment-orchestrator/` (or in what it imports) while the Orchestrator is not yet on that commit.

**Way out (owner).**
1. Acknowledge the critical report on the Owner page once production is checked (each failed native deploy restores the Workers it changed; the Drift Detector's tags show what runs).
2. Run the rescue deploy of the Orchestrator at main's head (below). The planner then continues with the remaining units through the fixed Orchestrator, on its own.
3. Only if the rescue deploy is not configured or refuses: until cut-over step 6, run `deploy-deployment-orchestrator.yml` (`confirm_production` = `DEPLOY`, `commit_sha` = main's full 40-character head, no trailing space) and, if the blocked unit is the Control Plane, `deploy-control-plane.yml` with the same inputs. Two dispatches of the same workflow queue behind each other (one concurrency group per unit).

## Rescue deploy of the Deployment Orchestrator

An owner-approved break-glass plan (`force_redeploy_unit`, "Break-glass deploy" below) whose service is `cryptophys-deployment-orchestrator` is not sent to the Orchestrator. The Recovery Manager's plan Workflow deploys the Orchestrator's Worker itself (`control-plane-shared/src/executor-rescue.ts`, a guard path), with its own credential and its own Cloudflare client that can address only that script. A bug in the Orchestrator's deploy code cannot block it. A bug in the shared files it uses (`break-glass.ts`, `forge-gate.ts`, `executor-first.ts`, `migration-rules.ts`, `audit.ts`, `agents.ts`), or a broken Recovery Manager, Drift Detector or Platform Registry, can.

**What it does.** At a SAFE minute (the Orchestrator's own deploy minutes), once per plan:
1. It re-checks the plan in its own code: executing, its own `recovery.execute` allow within 2 hours, written and approved by two different people, the full commit of main's head with the Forge's checks ready, and no destructive migration named (it applies no migration).
2. It reads the Orchestrator's module from the Forge's bundle of that commit and checks its hash. The Worker must be single-module, without static assets or `[limits]`, with the same `wrangler.toml` as the version it runs: a configuration change is the Orchestrator's own path.
3. A pending D1 migration is allowed only when the Orchestrator's code reads nothing it introduces (the executor-first rule). The Control Plane applies it afterwards.
4. It refuses while another native deploy is queued or running.
5. It captures the active deployment, uploads the module as a version that keeps every binding, and checks that the new version binds exactly what the active one binds; a 404 on reading it back is read again. Then it deploys at 100 %, verifies the version live through the Drift Detector (health and tag), and records the desired version through the Platform Registry. On any failure after the deploy call it restores the captured deployment.
6. The request is `deployment_requests` executor `rescue:deployment-orchestrator`, audited as `deployment.rescue_started`, `deployment.rescue_succeeded`, `deployment.rescue_failed` or `deployment.rescue_refused`. A success is a warning report from `recovery-manager` (Owner page "break-glass deploy", Telegram, no brake). A failure is a critical report that holds routine consensus until acknowledged. A refusal changes nothing and fails the plan (`recovery_failed`).

**One-time setup (owner).** Until these are set, the plan's step reports `blocked` and names what is missing; nothing is deployed and the Orchestrator is not asked instead.
1. Create a Cloudflare API token for this purpose only: dashboard → My Profile → API Tokens → Create Token → Custom token, permission **Account → Workers Scripts → Edit**, the platform account only. Use a new token rather than a copy of `CF_DEPLOY_TOKEN`, so either can be revoked alone.
2. Set it on `cryptophys-recovery-manager` (Workers → `cryptophys-recovery-manager` → Settings → Variables and Secrets → Add → Secret) as **`CF_ORCHESTRATOR_DEPLOY_TOKEN`**, and the account id (32 hex) as the secret **`CF_ACCOUNT_ID`**.
3. The bindings `BUNDLES` (R2 `cryptophys-forge-bundles`), `DRIFT` (Drift Detector `DriftRpc`) and `REGISTRY` (Platform Registry `RegistryRpc`) come with the Recovery Manager's `wrangler.toml`; they are live once the Control Plane runs the commit of this change.

**Proof drill (once; closes the cut-over gate of 2026-11-15).** Do it when the Orchestrator is healthy and nothing else is deploying, at a commit of main whose orchestrator bundle is code-only against the running version (any main head, if the Orchestrator's `wrangler.toml` has not changed since its running version).
1. On the Console's Code page, note main's full head and that its checks are ready. On Infrastructure, note the Orchestrator's running tag.
2. An approver writes the plan (Console → Recovery → Create Plan, or `POST /v1/plans`): service `cryptophys-deployment-orchestrator`, plan version the full 40-character head, one step `force_redeploy_unit` with no `destructive_migrations`, optionally a `manual` note "rescue drill".
3. The owner (another approver) approves it. That click is the only one.
4. Watch the plan's pipeline on the Recovery page. Within one SAFE minute (at most 8 minutes), step 1 reads "rescue deploy of the Orchestrator at <tag> succeeded without the Orchestrator (request dep_…)", and then verify succeeds.
5. Check the evidence:
   - the audit chain has `deployment.rescue_started` and `deployment.rescue_succeeded` for the request, and no `deployment.break_glass_queued` or `deployment.native_deploy_*` event for it;
   - `deployment_requests` has the row with executor `rescue:deployment-orchestrator`, status `succeeded`;
   - the Orchestrator's Worker runs a new version tagged with main's head (`npx wrangler deployments list --name cryptophys-deployment-orchestrator`), its message "rescue deploy …";
   - the Drift Detector shows the Orchestrator in sync, and the Owner page lists the "break-glass deploy" warning, which closes after 24 hours.
6. Record the request id, the plan id and the time in `docs/GITHUB-CUTOVER.md` (the gate's status line).

If the drill fails, the step's detail and the critical report give the reason, and the Orchestrator was restored. Fix the cause in a change request, then write a new plan: a plan deploys at most once.

## Registered platform and XAUUSD AI agents (ADR-0007, TP-009, 0016, 0017)

There are no third-party or IDE external agents. The AI Worker OS process table (`agents`) registers only:

1. **AI Worker Cloud Platform agents (`cryptophys-cloud-platform`):**
   - `cryptophys-ai-kernel` Durable Object agents: `supervisor`, `signal-analyst`, and `auditor` (all `tier_max = 1` after TP-022). All three are kernel-internal: they cannot receive external principals and cannot be invoked through AgentRpc.
   - Per-Worker AI agents (`tier_max = 1`) for the seven active platform Workers: `platform-api`, `deployment-orchestrator`, `platform-registry`, `policy-engine`, `drift-detector`, `audit-ledger`, and `recovery-manager`. The former `signal-engine` agent was suspended by TP-018 and deleted by migration 0047 (2026-11-11).
2. **XAUUSD AI Trading Assistant deployment agents (`host_worker = 'xauusd-ai-trading-assistant'`, `tier_max = 1`):**
   - H1 synthesis chain (`xauusd-reasoner`; the unused `xauusd-analyst` and `xauusd-counselor` identities were deleted by 0048, the chain's Analyst and Counselor model steps are unchanged) and multi-agent bus / news threads / live 15m room (`xauusd-risk-manager`, `xauusd-moderator`). `xauusd-technical-analyst` and `xauusd-news-analyst` were never used and were deleted by 0047.
   - 10 Pine HUD agents (`hud-prophet`, `hud-trade-management`, `hud-interstellar-eyes`, `hud-kinetic-engine-tva`, `hud-fabio-amt-sensors`, `hud-chronos-matrix`, `hud-aegis-footprint-matrix`, `hud-tactical-muscles`, `hud-macro-aether-sensors`, `hud-decision-matrix`). `hud-r37-funnel`, `hud-gabfx-price-action`, `hud-playbook-execution` and `hud-grid-bot-protocol` were dismantled on 2026-11-11 (owner: "dismantle sekarang"; 87-97 % NEUTRAL in the 15m War Room, never a BUY or SELL) and deleted by 0047.
   - **Dismantling (owner 2026-11-11: "dismantle dan delete agent yang sudah tidak berkontribusi"):** consensus action `retire_agent` is **critical** (owner 2026-11-11, "opsi 1", ADR-0013 §3: retirement keeps the owner click): after consensus it waits for one approval click, and only in consensus mode `deploy` or `critical` (owner 2026-11-13); in shadow and routine it is only recorded. After the click it deletes an agent no row refers to and otherwise suspends it with a `retired:` reason, so no history is lost and `resume_agent` can bring it back. Each scheduled Supervisor cycle proposes one enabled agent with no action, report or vote for 14 days (`RETIRE_IDLE_DAYS`), at most once a week per agent. Kernel agents, council seats and the agents of `xauusd-ai-trading-assistant` (judged on its own room data) are never retired; the executor enforces this whatever the vote. Aether agents are no longer exempt (owner 2026-11-11: "aether sudah operasional").

Since migrations 0047 and 0048 (2026-11-11) the D1 process table holds 28 rows, all enabled: 3 AI Kernel agents, 7 active per-Worker platform agents, 13 XAUUSD/HUD agents and 5 Aether agents (the Knowledge Council included). No registered agent has `tier_max >= 2` after TP-022. **A row being enabled does not mean that its host Worker is already wired to invoke it.** TP-011 added the `AgentRpc` entrypoint and report kinds in migration `0017`. **TP-011 part 2** added the `AGENTS` binding, pinned with `props.host_worker`, to the original 8 platform Workers. TP-018 removed the retired Signal Engine binding, leaving 7 active platform Worker hosts. The Drift Detector's `drift-detector` agent publishes a `platform_digest` when a scheduled observation finds drift; deploy-time manual observations are excluded. The former `signal-engine` agent was deleted by 0047.

The xauusd and HUD agents still need the owner to add the same binding in `xauusd-ai-trading-assistant`. No external principal is seeded. No external MCP agent can invoke the kernel until an owner-created Access identity is explicitly registered in `agent_principals`.

- **In-account RPC Service Binding (no token):** A caller Worker may bind to `cryptophys-ai-kernel` with `entrypoint = "AgentRpc"`. The binding must set `props = { host_worker = "<exact caller Worker name>" }`. The caller may invoke only D1 agents whose `host_worker` exactly matches that property and whose `tier_max <= 1`. AgentRpc explicitly rejects every agent whose `host_worker = 'cryptophys-ai-kernel'` (`supervisor`, `signal-analyst`, `auditor`), regardless of tier. Normal grants, suspension, kill switch, rate limit and Policy Engine checks still apply. Example for a future, separately reviewed caller-binding change:

  ```toml
  [[services]]
  binding = "AGENTS"
  service = "cryptophys-ai-kernel"
  entrypoint = "AgentRpc"
  props = { host_worker = "xauusd-ai-trading-assistant" }
  ```

  ```ts
  await env.AGENTS.syscall("xauusd-reasoner", "reports.publish", {
    kind: "xauusd_digest", severity: "info", subject: "H1 digest",
    ai_status: "ok", body: { summary: "..." }
  });
  ```

- **Trust boundary:** `host_worker` comes from the caller Worker's deployed Service Binding configuration, not from an HTTP request. The trust boundary is the Cloudflare account and the identities permitted to change/deploy that caller configuration. An actor with that deployment authority can change the asserted property; this is not protection against a malicious account deployer. The kernel checks the exact host match and tier limit before the normal syscall gate.
- **Agent reports:** `reports.publish` stores UTF-8 JSON bodies up to 16 KiB per report; oversized bodies fail closed and are audited as failed syscalls.
- **MCP:** Operator and CI Access identities always receive operator tools. No request header can select an agent. A non-operator Access identity receives agent tools only when its exact Access identity has an active `agent_principals` row for a tier-`<=1` non-kernel agent. The three AI-Kernel-hosted agents are excluded even if a stale active principal row exists: MCP resolution ignores that row, and a non-operator receives 403.
- **External service tokens:** Credential creation is an owner action in Cloudflare Zero Trust. The owner must securely retain the one-time `client_secret`, then have an approver register the token's Access identity through `POST /v1/agents/{id}/principals`. Do not generate credentials from repository scripts, and never print, commit or log the secret.

**Revocation.** An approver can revoke a principal with `DELETE /v1/agents/{id}/principals/{client_id}`. Deleting the service token in Zero Trust and re-running Provision Access removes it at the edge.

## Retiring a Worker (`retire-worker.yml`)

Deleting a Worker is irreversible and critical (ADR-0009 §1). `retire-worker.yml` (inputs `worker` and `confirm_production: DELETE`, from main, in the production Environment) deletes only a Worker in its `RETIRABLE` list, and only once its source, bindings and deploy, validation and Access entries are gone from main. For a Worker with custom domains it first detaches each one through the Workers Custom Domains API, after checking that every hostname is attached to the expected Worker, and verifies each is gone; then it deletes the Cloudflare Workflow, if any, and the script. Any unexpected status stops the run before the script is deleted. D1 data is never touched; the registry row is kept with status `disabled` by a migration.

- `cryptophys-signal-engine` (owner 2026-11-05, TP-018): Workflow `cryptophys-signal-ingest`.
- `cryptophys-home` (owner 2026-11-13, ADR-0010 amendment): no Workflow; detaches `home.cryptophys.work` from `cryptophys-home` and `console.cryptophys.work` from `cryptophys-console`. `cryptophys-console` is not deleted. Ops request: `{"workflow":"retire-worker.yml","inputs":{"worker":"cryptophys-home","confirm_production":"DELETE"}}`. After it, run Provision Access once so the Access application's destinations match `PLATFORM_WORKERS`.

**Without GitHub (ADR-0012 G6 gate 10, §5n).** An owner-approved consensus `retire_worker` is retired by the Orchestrator itself once `CF_DEPLOY_TOKEN`, `CF_ACCOUNT_ID` and the Forge's bundles are set.
- **Plan.** It plans read-only first, with the same gates read from the Forge's records for main:
  - `RETIRABLE` (kept equal to this workflow's list by a test);
  - registry `disabled`;
  - no build, binding or custom domain declaration for it on main, and no pending deploy;
  - every domain on the expected Worker.
- **Run.** The cron then runs it at a SAFE minute: it detaches, deletes without `force`, and verifies.
- **Outcomes.**
  - A refusal changes nothing and raises a warning.
  - A failure after something changed raises a critical report.
  - It uses this workflow only when `CF_DEPLOY_TOKEN` may not read something (401/403), for example a custom domain, which needs Zone → Workers Routes → Edit.

**Rollback.** A deleted Worker comes back only by redeploying it from Git history. The deploy workflows deploy main's head only, so revert the retirement commit on main in a reviewed pull request (for Home this restores `workers/home/`, `deploy-home.yml`, the lists and the Console's `console.cryptophys.work` custom domain), add a forward migration that sets the registry row back to `registered` (applied migrations are never edited), then run Provision Access (its bootstrap step recreates the Worker as a private stub and puts it back in the Access application), Deploy Control Plane, Deploy Home and Deploy Console; Wrangler re-attaches the custom domains it is given.

**Deploy plan after a retirement (2026-11-13).** The Forge plans under a registry fingerprint over its own list of deploy units; the Orchestrator looks the plan up by its own list. After `cryptophys-home` was removed from the units (#316), the Orchestrator (deployed first) no longer found the old Forge's plan, so nothing was pending, the Forge's own redeploy included, until the Forge was deployed by an ops request. Since then the Orchestrator also accepts the Forge's newest plan for main's head when every registry input that plan names is unchanged (`fingerprintStillHolds` in `forge-gate.ts`), so adding or retiring a unit no longer stalls the agents.

## Break-glass deploy (`force_redeploy_unit`, hardening (d))

**The Orchestrator's own unit** (service `cryptophys-deployment-orchestrator`) is the exception: its plan is run by the Recovery Manager's rescue executor, not by the Orchestrator ("Rescue deploy of the Deployment Orchestrator" above). Everything below describes the other units.

**When to use it.** Only when the normal paths cannot deploy: the Forge's deploy planner records no plan or plans nothing for main's head while a unit must be deployed (on 2026-11-14 it stopped planning any unit, so no consensus `deploy_commit` could deploy anything, its own fix included), or a recovery plan's `redeploy_commit` is skipped as "Already in sync" while the platform still needs the commit. Do not use it for routine deploys, for a commit that is not main's head, or while another deploy of the unit is queued or running.

**How.**
1. Check main's head on the Console's Code page (the Forge checks of main) and that its checks are ready. Note any pending migration that is destructive (drops, deletes or rewrites data): the pending ones are the files of `workers/control-plane-migrations/` at that commit that D1's ledger `d1_migrations` does not list. If you leave one out, the deploy refuses and names it (`destructive_migration_not_named`, in the audit event), so a first attempt without names is safe.
2. An approver writes a recovery plan (Console → Recovery → Create Plan, or `POST /v1/plans`): service = any Worker of the unit (for example `cryptophys-ai-kernel` for the Control Plane), plan version = the full 40-character commit of main, one step `force_redeploy_unit` (plus `manual` notes only), and, only if needed, the destructive migration files it may apply in `destructive_migrations`. Agents, AI drafts and service tokens cannot write this step.
3. The owner (another approver) approves the plan: that click is the only one. The Recovery Manager then runs it: the Policy Engine's `recovery.execute` (person-written, person-approved, full commit), then the Orchestrator re-checks the plan and queues one signed native request; at the next SAFE minute it applies D1's pending migrations (Control Plane only), uploads and deploys each Worker of the unit, verifies each live through the Drift Detector, records the desired versions, and on any failure restores every changed Worker (migrations stay; forward-only).
4. The owner hears of every outcome on Telegram.
   - **Succeeded:** a warning report and the Owner page item "break-glass deploy" (`production_unhandled`, code `break_glass_deployed`), one message per request. It does not engage the consensus brake, so the agents resume normal deploys at once. It needs no acknowledgement and closes after 24 hours (a "Resolved:" report, then a "Resolved:" Telegram message).
   - **Failed** (a deploy or live check failed and the unit was restored, or the restore itself did not complete) **or refused at run time:** a critical report (`critical_reports`). It holds routine consensus until an approver acknowledges it on the Owner page; acknowledge it once production is checked.
   - A refusal before anything is queued fails the plan, which reaches Telegram as a failed recovery plan (`recovery_failed`).

**Destructive topology changes (gate 4 part B, owner 2026-11-15).** After cut-over step 6 there is no GitHub fallback, so this is the only path, and it is owner-click: the routine native deploy refuses each of these with its reason, and a break-glass plan applies exactly the ones its `force_redeploy_unit` step names in `destructive_topology` (Console → Recovery → Create Plan, the field under the destructive migrations, or `POST /v1/plans`):
- `custom_domain_removal:<host>`: detaches the custom domain after the new version is verified live; re-attached on a later failure.
- `custom_domain_change:<host>`: a custom domain's `zone_id` / `zone_name` changed; detached and attached again with the new fields.
- `do_migration:<deleted_classes|renamed_classes|transferred_classes>:<worker>:<tag>`: the Durable Object migration with that tag, sent with the Worker's Script Upload. **Irreversible:** Cloudflare refuses a rollback across a Durable Object class change, and a deleted class's objects and storage are gone. Before the upload the Orchestrator records `deployment.destructive_topology_irreversible` (`restore_possible: false`); without that audit row nothing is applied. A later failure ends `restored: false`.
- `workflow_removal:<name>`: deletes the Workflow after the live check. **Irreversible:** its instances and their state are lost (same audit event first); a restore re-creates only the definition.
- `workers_dev_disable:<worker>`, `preview_urls_disable:<worker>`: turns workers.dev or its preview URLs off after the live check; turned on again on a later failure. Turning either on is not destructive and goes natively without a name.

Every named item is audited before it is applied (`deployment.destructive_topology_applying`, or `…_irreversible` for the two above) and after (`deployment.destructive_topology_applied`), and the owner notice lists the items applied and what no restore can give back (`destructive_topology_applied`, `irreversible`). An unnamed destructive change refuses with its own reason (`custom_domain_removal_owner_run:<host>`, `do_migration_destructive:<kind>:<tag>`, `workflow_removal_owner_run:<name>`, `workers_dev_disable_owner_run:<worker>`, …); a named item that main's change does not contain refuses the whole deploy (`named_topology_not_pending`, with the item). Write the plan with the names the first refusal reported.

Zone routes cannot be named. Creating or removing a Workers route on a zone needs Zone → Workers Routes → Edit, which `CF_DEPLOY_TOKEN` does not hold by the owner's decision of 2026-11-06 (ADR-0010). That is a settings decision, not a code gap: a new zone route deploys natively once it is attached (the script list reports it); otherwise `zone_route_needs_zone_token:<pattern>`, `zone_route_removal_owner_run:<pattern>` or `route_change_needs_zone_token:<pattern>`. Attaching or detaching one stays the owner's own act with a zone token in the dashboard, or a later owner decision to grant the permission.

**Refusals** (audited as `deployment.break_glass_refused`, nothing changed): the commit is not main's head or not ready, a destructive migration not named, a named file that is not a pending destructive migration, a destructive topology change not named, a named topology item not in main's change, a D1 migration main does not have, pending migrations on a unit other than the Control Plane (deploy the Control Plane first), the deploy lock held or another deploy of the unit under way, the native deploy not configured (there is no GitHub fallback), or a Worker the native deploy cannot plan (its reason is recorded). Write a new plan once the cause is fixed; a plan deploys at most once.

## Destructive D1 migrations (`deploy_destructive_migration`, cut-over gate, owner 2026-11-15)

A migration the Forge marks destructive drops, deletes or rewrites data (`DESTRUCTIVE_SQL`: `DROP`, `DELETE FROM`, `UPDATE … SET`, `ALTER TABLE … RENAME/DROP`). A routine `deploy_commit` never applies one: the native deploy refuses it (`destructive_migration`). Before the gate, such a deploy fell back to `deploy-control-plane.yml`, as 0069 did on 2026-11-15. Now it has a native path with the owner's click, and it needs no workflow after cut-over step 6.

**What the agents do.**
- When main's pending migrations for the Control Plane include destructive ones, the Supervisor proposes `deploy_destructive_migration` (critical) instead of `deploy_commit`. "Pending" means main has the file and D1's ledger `d1_migrations` does not.
- The params name the commit and each destructive file with its sha256.
- The council votes: every seat rejects malformed params, a target outside the Control Plane, or an open critical report (the brake).
- The Policy Engine checks it as a deploy (the daily deploy limit counts it).
- In mode `deploy` or `critical` it waits for the owner (`pending_owner`, 24 hours). The Supervisor proposes it once per commit. It proposes again only after a policy veto (an hour later), after the 24-hour window lapsed, or after a rejection caused only by the brake.
- Until the owner decides, the Control Plane unit waits. The deploy stall alarm may report it after 2 hours.

**How the owner approves.**
1. Console → Owner → "Waiting for your approval" shows the item with each file and the first 12 characters of its sha256. The Consensus page's Owner Approval Queue shows the same.
2. Read the SQL of each named file at that commit (`workers/control-plane-migrations/<file>` on main). The sha256 pins exactly that text: an edited file refuses the deploy (`named_migration_sha256_mismatch`).
3. Click approve, or reject. Reject when the data loss is not intended. Rejected, the commit does not deploy the Control Plane until a newer main commit is proposed.

**What the click does** (`deployDestructiveForConsensus`, `workers/deployment-orchestrator/src/index.ts`):
- The Orchestrator re-verifies the proposal: passed, the owner's approval, a fresh Policy Engine allow.
- The commit must be main's ready head. The Control Plane must be eligible natively with only the named destructive files allowed: a destructive file the approval does not name refuses (`destructive_migration`), and so does a named file that is no longer pending and destructive (`named_migration_not_pending_destructive`).
- It checks, read only, that the D1 bookmark can be read now.
- Then it queues one signed request (executor `native:destructive-deploy`, lock `destructive:deploy-control-plane.yml:<sha>`). A refusal changes nothing and is audited as `deployment.destructive_refused`, with the reason; the proposal ends `failed` with the same reason in its outcome.

**At the next SAFE minute**, the request is checked again: main's head, readiness, the plan and each sha256. Then:
1. **The restore point first.** The Orchestrator reads D1's current Time Travel bookmark: `GET /accounts/{account_id}/d1/database/{database_id}/time_travel/bookmark`. The database is the `DB` binding of the Orchestrator's own running version. It records the bookmark before any migration runs, in two places: `details_json.restore_point` (`bookmark`, `database_id`, `read_at`) of the `deployment_requests` row, and the audit event `deployment.restore_point_recorded`, whose payload also holds the restore command. If the bookmark cannot be read or recorded, the deploy stops before any change.
2. **Then the migrations**, in order: main's pending files, only the named destructive ones among them, each in its own D1 batch with its `d1_migrations` row.
3. **Then the Workers**, as in every native deploy: upload, check, deploy, verify live, record the desired version. Any failure restores the changed Workers. Migrations stay (forward-only).

The same bookmark step runs before a destructive migration that a break-glass plan names (`force_redeploy_unit`, above).

**Token permission (owner).** `CF_DEPLOY_TOKEN` on `cryptophys-deployment-orchestrator` needs **Account → D1 → Read** (D1 Edit also works) to read the bookmark. Without it the click is refused with `restore_point_unavailable` (`d1_permission_missing`), and the audit event names the permission. Edit the token where it was created in the dashboard (Account API Tokens, or My Profile → API Tokens): add the permission Account · D1 · Read. The token's value does not change, so the Worker secret stays as it is. The token never restores anything.

**Outcomes.**
- **Succeeded:** `deployment.destructive_deploy_succeeded`; the bookmark stays in the request row and the audit chain.
- **Refused at run time** (main moved, a file changed): a warning report; nothing changed.
- **Failed:** a critical report from `deployment-orchestrator`. Its body holds `d1_restore_point` (bookmark, database, time), `d1_restore_command`, the migrations applied and `action_required`. A bookmark that could not be read is reported as "nothing in production changed", with the permission named. The report holds the consensus brake until it is acknowledged on the Owner page.

**Where the bookmark is**, newest first:
- `SELECT payload_json FROM audit_events WHERE event_type = 'deployment.restore_point_recorded' ORDER BY rowid DESC LIMIT 5`;
- `SELECT request_id, status, json_extract(details_json, '$.restore_point') FROM deployment_requests WHERE json_extract(details_json, '$.executor') IN ('native:destructive-deploy', 'native:break-glass') ORDER BY created_at DESC LIMIT 5`;
- the critical report of a failed deploy.

**How to restore with it (owner only, never automatic).** A restore is critical and destructive: everything written after the bookmark is lost for every service. The Orchestrator never restores D1; the owner decides.
1. Fixing forward is usually better. A failed deploy restores the Workers; the applied migrations stay.
2. To restore: pull the brake first (step 0 of "Last resort" above). Then run `npx wrangler d1 time-travel restore cryptophys-control-plane --bookmark=<bookmark>` with your own credentials (D1 Edit). Write down the undo bookmark it prints.
3. Roll the Control Plane Workers back to versions from before the migration: their readiness requires every migration they were built with.
4. Record it as `owner.d1_restore` and verify the audit chain (step 4 of "Last resort").

## Data retention

Drift observations are pruned daily at 03:00 UTC by the Drift Detector: rows older than 90 days are deleted, but the 2 newest observations per service are always kept. Agent syscall consumptions are pruned daily at 03:07 UTC by the AI Kernel: rows older than 7 days are deleted. Audit events, policy decisions, agent reports, recovery plans, deployment requests, registry rows and crypto history tables are never deleted. Owner decision, 2026-11-05.

## Consensus (ADR-0009)

The AI Kernel records consensus proposals in `consensus_proposals` and their votes in `consensus_votes`. The mode is stored in `consensus_controls`.

**Phase 1 (`shadow`):**
- only the supervisor proposes, and only for persistent drift (`redeploy_desired_version`);
- 9 control-plane agents vote deterministically, and the proposer does not vote;
- a proposal needs a simple majority, plus a Policy Engine `consensus.execute` allow;
- **nothing executes.**

**Reading proposals:** `GET /v1/consensus` and `GET /v1/consensus/{id}` on the kernel, or the Console Consensus screen.

**Deploy verification** fails if the mode is not `shadow`, or if any proposal is `executing` or `executed`.

## Console

`cryptophys-console` (ADR-0008) is the operator Console, served at `https://nexus.cryptophys.work/console/` through the zone route `nexus.cryptophys.work/console*` (ADR-0010; its old custom domain `console.cryptophys.work` was retired on 2026-11-13). It has no authority of its own: every request needs an Access JWT of an `OPERATOR_IDENTITIES` identity, and `/api/{service}/…` forwards only allow-listed routes (`CONSOLE_ALLOW_LIST` in `workers/console/src/index.ts`) to the platform Workers through Service Bindings, carrying only the operator's own `cf-access-jwt-assertion`. The target Worker verifies it, so the operator rule, approver rule, separation of duties and audit actor are those of the person. The kernel `/mcp` and the audit `POST /v1/events` are never forwarded. Non-GET `/api` calls need a same-origin `Origin` and `x-cryptophys-console: 1`. `/health` and `/ready` follow the other Workers; `/ready` returns 503 when `APPROVER_IDENTITIES` is unset or a binding is missing.

UI (Nexus obsidian redesign): a React SPA (`workers/console/ui`, Vite, Tailwind, lucide-react, framer-motion, three.js) in the original Nexus design, built into `ui/dist` by the deploy and validation workflows and served as Workers Static Assets with `run_worker_first`, so every asset passes the Access, operator and CSP checks first. The shell has the neural-mesh background, a Priority Queue and Cockpit Doctrine on the left, AI Cognition and the Live Event Bus (audit chain) on the right. Screens: Command (health ring, KPIs, approval queue, kill switch, service mesh, attention, XAUUSD display), AI Mesh (radial agent graph and roster; detail with suspend/resume/wake/principals and syscall history), Cognition (reports), Recovery (plans, create, approve/start/finish/disable), Infrastructure (services and drift, observe now, edit service, desired version), Policy (decisions and evaluate), Ledger (events, verify chain, export JSON), Pipelines (what is running and what was deployed, read only), Markets (XAUUSD display only). Every API call goes through the TP-024 `UI_ROUTES` table. Approver-only actions (hidden unless `whoami.approver`): agents ON, resume, add/remove principal, approve recovery plan. Principal buttons are hidden for agents hosted by `cryptophys-ai-kernel`; Wake is shown only for supervisor, signal-analyst and auditor. State-changing actions require a typed confirmation phrase. No trading actions; XAUUSD data is display only.
