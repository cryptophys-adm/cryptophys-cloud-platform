# ADR-0008: Cerebrum portal, operator Console, and Cloudflare Access sign-in

- **Status:** Accepted
- **Date:** 2026-11-05
- **Owner decisions (2026-11-05):**
  - "pisah dulu dengan console.cryptophys.work, langsung dengan tombol aksi lengkap semua fitur cloud-platform control plane. kedua domain ini nanti akan digabung di fase 2" (keep the Console separate at console.cryptophys.work for now, with action buttons for every control-plane feature; the Console and Nexus are merged in phase 2).
  - The home portal at `home.cryptophys.work` is named **Cerebrum**. Sign-in is **Cloudflare Access with an OIDC identity provider** (owner: "setuju").
- **Builds on:** ADR-0004 (control plane, Access in front of every Worker), ADR-0007 (AI Worker OS).

## Context

- Operators drive the control plane today through `curl`, GitHub workflows and MCP. There is no UI for the owner.
- `nexus.cryptophys.work` is the XAUUSD room. It lives in `cryptophys-adm/xauusd-ai-trading-assistant`, is public, and this repository never changes it.
- The legacy ALDO estate used an organism vocabulary. Cerebrum was its drift sentinel, Synapse its portal, Corpus and Aether its analysis lenses, and Omega, Aladdin and Execution its execution layers. The current platform uses functional names for services; that stays.
- Every platform Worker already verifies the Access JWT (`cf-access-jwt-assertion`) in code against one Access application (`cryptophys-cloud-platform`, one AUD). It enforces `OPERATOR_IDENTITIES`, and, where needed, `APPROVER_IDENTITIES` and separation of duties.

## Decision

### 1. Names and hosts

| Host | Name | Role | Phase |
| --- | --- | --- | --- |
| `console.cryptophys.work` | **Console** | Operator control plane, with every action | 1 (TP-023, TP-024) |
| `home.cryptophys.work` | **Cerebrum** | Home portal: sign-in landing and navigation panel (Console, Nexus, later modules) | 1 (TP-025) |
| `nexus.cryptophys.work` | **Nexus** | XAUUSD room (xauusd repository) | merged into Cerebrum in phase 2 |

- Services keep their functional names (AI Kernel, Policy Engine, Audit Ledger, …).
- The organism names are reserved for portal surfaces only.
- **Omega, Aladdin and Execution are retired names.** They belonged to trade-execution layers, which stay prohibited (ADR-0005), and must not be reused.

### 2. Sign-in: Cloudflare Access, not application-managed OIDC

- Access is the only login. The owner connects an OIDC identity provider (GitHub or Google) in Zero Trust, with one-time PIN as the fallback. This is an owner action in the dashboard.
- One sign-in covers `home.`, `console.` and, after phase 2, `nexus.`, through the Access team-domain session.
- New Workers join the existing application by adding them to `PLATFORM_WORKERS` in `provision-access.yml`.
  - The destination type is `worker`, so the custom domain and `workers.dev` are covered.
  - The Workers share the same AUD.
- The application stores no session, secret or token of its own.

### 3. The Console is a backend-for-frontend with no authority of its own

- **One Worker, `cryptophys-console`:** it serves a static UI, `GET /api/whoami`, and `/api/{service}/…`.
- **Forwarding.** `/api/{service}/…` forwards an allow-listed request to the platform Worker's `fetch` handler through a Service Binding. It carries the **operator's own verified Access JWT**, unchanged, and nothing else of the browser's headers: no cookies.
- **Identity is preserved.** The target Worker verifies the JWT itself, exactly as for a direct call. The operator rule, the approver rule, separation of duties and the audit actor are therefore those of the person, never of the Console. The Console cannot mint, widen or change an identity.
- **Allow-list.** Every route the Console may forward is listed by service, method and path pattern. These are excluded:
  - the kernel's `/mcp` (agents only);
  - raw audit append `POST /v1/events` (every action is already audited by the Worker that performs it).
- **UI gating is cosmetic.** Approver-only buttons are hidden for non-approvers. The target Worker is the enforcement point.
- **Browser hardening:**
  - non-GET `/api` calls require same-origin `Origin` and a custom header (CSRF);
  - strict CSP with `script-src 'self'`;
  - no inline script, and no `innerHTML` with data;
  - `frame-ancestors 'none'`;
  - `no-store`.
- **Typed confirmations** guard every state-changing action that is costly to undo: kill switch, suspend/resume, principals, plan approve/execute/disable, desired version and deployment request.
- **No trading actions exist.** The Console exposes advisory data only.

### 4. AI engine exemption

The Console and Cerebrum are presentation surfaces. They own no AI engine. This is an explicit exemption from `architecture/AI-ENGINE-REQUIREMENT.md` and from the ADR-0007 owner note that every Worker is AI-based.

AI output is still shown, but it comes from the capability Workers' own engines, for example Platform API `?advisory=true`, reports and the AI-failure view.

### 5. Phases

1. **TP-023:** Console Worker: forwarding, allow-list, `whoami`, hardening, health/ready, and a minimal shell page.
2. **TP-024:** Console UI: every screen and action button.
3. **TP-025:** Cerebrum (`home.cryptophys.work`): landing page and navigation panel (Console; Nexus as an external link).
4. **Phase 2 (owner action in the xauusd repository):** put Nexus behind the same Access sign-in and inside Cerebrum. This is a topology change under that repository's `docs/SSOT.md`; this repository does not make it.

## Consequences

- The Console adds no new credential and no new authority. A compromised Console can only replay a JWT a signed-in operator already holds, and only within the allow-list. Its deployment is still security-sensitive, so it is reviewed and deployed through CI like every other Worker.
- An Access JWT accepted by one platform Worker is accepted by all of them; that is already true for direct calls.
- **Cost:** one or two extra Workers with no D1, AI or Durable Objects. This stays within the Workers Paid included quotas.
- **The orchestrator owns the `.github` changes:**
  - a deploy workflow for the Console;
  - adding it to `provision-access.yml`;
  - adding it to validation;
  - the Drift Detector and registry entries, if wanted.

## Alternatives considered

- **App-managed OIDC (our own login, sessions and tokens).** Rejected. It duplicates Access, adds secrets and session storage, and creates a second identity path that the Workers do not verify.
- **The Console calls the Workers' RPC entrypoints and passes an actor.** Rejected. The Console would assert identity instead of proving it, which weakens separation of duties.
- **Put the actions into Nexus now.** Rejected for phase 1. Nexus lives in another repository with its own rules, and it is public today.
