# ADR-0010: Nexus is the single origin; the Console is a Nexus menu; OIDC sign-in

- **Status:** Accepted (owner decision 2026-11-06); amended 2026-11-13 (retirement of `cryptophys-home` and the old custom domains)
- **Date:** 2026-11-06
- **Owner decisions (2026-11-06):**
  - "nexus sudah menyediakan placeholder menu/navigator console, saatnya integrasikan sehingga sekarang hanya ada 1 subdomain nexus, lalu integrasikan nexus dengan OIDC cloudflare. Sekarang console akan menjadi bagian dari menu nexus." (Nexus already has a placeholder menu entry for the Console. Integrate it now, so that there is only one subdomain, nexus, and put Nexus behind Cloudflare's OIDC sign-in. The Console becomes part of the Nexus menu.)
  - **Identity providers:** Google and Microsoft, with the one-time PIN as fallback.
  - **`home.cryptophys.work` (Cerebrum):** redirect to Nexus now, and retire the Worker after a week with no issues.
  - **Nexus:** the whole of Nexus requires sign-in.
- **Supersedes:** ADR-0008 §1 (hosts) and §5 phase 2. There, Cerebrum at `home.` was to be the hub and Nexus was to merge into it. Nexus is now the hub. ADR-0008 §2–§4 stay in force: Access is the only login; the Console is a backend-for-frontend with no authority of its own; and the AI-engine exemption.

## Decision

### 1. One origin: `nexus.cryptophys.work`

| Path | Served by | Repository |
|---|---|---|
| `/` and everything else | `xauusd-nexus-dashboard` (the XAUUSD room), through its Custom Domain | `xauusd-ai-trading-assistant` |
| `/console`, `/console/*` | `cryptophys-console`, through a Workers **route** `nexus.cryptophys.work/console*` | this repository |

- **Route precedence.** Cloudflare gives a Workers route precedence over a Custom Domain on the same hostname. The Console therefore takes `/console*` without any change to the Nexus Worker. The Nexus repository is not modified: its menu entry "Cerebrum Console" already points at `console.cryptophys.work`, which now redirects to the Nexus mount.
- **The Console under the mount:**
  - it strips `/console` before serving its assets and API;
  - it redirects `/console` to `/console/`;
  - it still answers without the prefix on `workers.dev`, for the deploy verification;
  - the UI is built with relative asset URLs, and computes its API base (`/console/api` or `/api`) from its own location.

  Security is unchanged: the Access JWT, the operator and approver rules, CSRF (same origin, now the Nexus origin), the allow-list, CSP and typed confirmations.
- **Retired hostnames** answer only with redirects; health and readiness stay, for verification and drift:
  - `console.cryptophys.work` redirects to `https://nexus.cryptophys.work/console/<path>`, with 301 for GET and HEAD and 308 otherwise;
  - `home.cryptophys.work` redirects to `https://nexus.cryptophys.work/`.

  After a week with no issues, both custom domains are removed. Retiring the `cryptophys-home` Worker is critical (ADR-0009 §1): it runs through the owner's approval click, or the narrow Retire Worker workflow.

### 2. Sign-in: Access with OIDC (Google, Microsoft), one application

- `nexus.cryptophys.work` joins the existing Access application `cryptophys-cloud-platform` as a **public hostname destination**, next to the Worker destinations. One application means one AUD, so the JWT that Access issues on the Nexus hostname is the one the Console verifies. A separate application for Nexus would have broken the Console behind it.
- **Identity providers.** `provision-access.yml` sets `allowed_idps` to the Google, Microsoft (Entra ID or Microsoft OIDC) and one-time-PIN providers it finds, with `auto_redirect_to_identity: false`. The owner adds the providers in Zero Trust: their client secrets never pass through this repository. The steps are in `docs/OWNER-OIDC-SETUP.md`. Who may enter is still `ACCESS_ALLOWED_EMAILS`, plus the CI service token and the external agent tokens.
- **Service bindings** (the Drift Detector's probes of Nexus) do not pass through Access, so they are unaffected.
- **The Nexus Worker** does not verify the Access JWT itself. Access enforces sign-in at the edge for the hostname, and the Console verifies the JWT in code as before. Making the Nexus Worker also verify the JWT is a later change in the Nexus repository, under its own rules.

### 3. Rollout

1. **Provision Access.** Nexus becomes sign-in-only. The run verifies that the Nexus hostname refuses anonymous requests and admits the CI service token.
2. **Deploy Console.** This adds the `/console*` route and the redirect. The smoke test now covers:
   - `/console/api/*` on `workers.dev`;
   - `https://nexus.cryptophys.work/console/health` through Access;
   - the redirect from `console.cryptophys.work`.
3. **Deploy Home** (the redirect). The smoke test checks the redirect from `home.cryptophys.work`.
4. **Owner step:** add Google and Microsoft in Zero Trust, after which Provision Access runs again.
5. **After a week:** remove the `console.` and `home.` custom domains, and retire `cryptophys-home`.

## Consequences

- The XAUUSD room is no longer public. Only the owners, CI and registered agents can open it.
- One sign-in, one session (8 hours) and one origin. The Console's CSRF origin is the Nexus origin.
- The Console's deploy depends on the Nexus hostname being a proxied Cloudflare hostname, which it is through its Custom Domain. If the Nexus Worker's Custom Domain were removed, the route would need a proxied DNS record.
- The deploy token needs **Workers Routes: Edit** on the `cryptophys.work` zone for the new route. If it is missing, the Console deploy fails before its verification and rolls back automatically (ADR-0009 §3.3).

## Rollout record, 2026-11-06

| Step | Result |
|---|---|
| Provision Access, run 42205641441 | **Success.** `nexus.cryptophys.work` is in the platform Access application; anonymous requests are refused and the CI token is admitted. Nexus now requires sign-in. |
| Deploy Console, run 42205741321 | **Failed at the route, then rolled back automatically.** The deploy token lacks **Workers Routes: Edit** on the `cryptophys.work` zone ("No access to the specified resource"). The rollback restored the previous Console version, and `console.cryptophys.work` kept working. |
| Deploy Home, run 42206302631 | **Success.** `home.cryptophys.work` redirects to Nexus. |

**Staged until the owner acts.** The Nexus route and the Console redirect are disabled in `workers/console/wrangler.toml`; the Console keeps serving `console.cryptophys.work` with the mount-aware code, and the deploy smoke test checks the Nexus route only once it is enabled. **Owner action:** in Cloudflare → My Profile → API Tokens, edit the token stored as the `CLOUDFLARE_API_TOKEN` GitHub secret and add **Zone → Workers Routes → Edit** for `cryptophys.work`. This adds a permission to the existing token; no new secret is needed. The orchestrator then re-enables the route and the redirect and deploys the Console.

**Owner decision (2026-11-06): "Gunakan CLOUDFLARE_ACCESS_API_TOKEN".** The Workers deploy token cannot be given the **Workers Routes: Edit** permission. The zone route `nexus.cryptophys.work/console*` is therefore not managed by `wrangler deploy`:
- `deploy-console.yml` attaches the route right after the Worker deploy, with `CLOUDFLARE_ACCESS_API_TOKEN`, through the zone routes API (`.github/scripts/ensure-zone-route.sh`). The script is idempotent and has a hermetic test.
- The smoke test then verifies `nexus.cryptophys.work/console/health` through Access, and the redirect from `console.cryptophys.work`, which is now enabled again.
- If that token cannot read the zone or edit its routes, the step fails with the missing permission named, and the automatic rollback restores the previous Console, whose redirect is off.

**Live (2026-11-06, 12:24 UTC).**

| Run | Result |
|---|---|
| Deploy Console 42216213383 (`7428c7e`) | **Rolled back automatically.** The route was created with `CLOUDFLARE_ACCESS_API_TOKEN`, but the probe ran before the new route had reached the edge and hit Nexus (404). |
| Deploy Console 42216870947 (`a68894f`) | **Success.** The probe now waits up to 2 minutes for the route to propagate. |

Run 42216870947 verified:
- `https://nexus.cryptophys.work/console/health` returns 200 from `cryptophys-console`, through Access;
- `/console/api/*` answers;
- `https://console.cryptophys.work/` returns 301 to `https://nexus.cryptophys.work/console/`.

Nexus is now the single origin.

**Remaining:**
- ~~The owner adds the Google and Microsoft identity providers, then Provision Access runs again.~~ **Closed 2026-11-07 (owner):** setting up Google and Microsoft sign-in failed because of the providers' own policies, so Nexus keeps the Cloudflare Access **one-time PIN** by email as its sign-in. Nothing else changes: Access still guards all of Nexus, `ACCESS_ALLOWED_EMAILS` still decides who may enter, and `provision-access.yml` still binds whichever Google, Microsoft or one-time-PIN providers exist, so OIDC can be added later without a code change (`docs/OWNER-OIDC-SETUP.md`).
- ~~After a week with no issues, remove the `console.` and `home.` custom domains and retire `cryptophys-home`.~~ **Approved 2026-11-13 (owner):** see the amendment below.

## Amendment 2026-11-13: retirement of `cryptophys-home` and the old custom domains

**Owner decision (2026-11-13, verbatim):** "setuju pension domain lama" (approved: retire the old domains). Nexus has been the single origin for a week (since 2026-11-06) with no issue that needed the old hostnames. Deleting a Worker is irreversible and critical (ADR-0009 §1); this decision is the owner's approval, and it runs through the narrow Retire Worker workflow.

**Removed**

- The `cryptophys-home` Worker: its source (`workers/home/`), its deploy workflow (`deploy-home.yml`), its DNA (`organism.json`), its deploy unit, its Drift Detector binding and probe (`SVC_HOME`), its plain-English name, and its entries in `provision-access.yml` (`PLATFORM_WORKERS`) and `rollback-worker.yml`. The tests that existed only for this Worker (`home-tp025.test.ts`, and the Home redirect case of `nexus-adr0010.test.ts`) are removed with it; `retire-home-adr0010.test.ts` holds the retirement itself.
- The custom domain `home.cryptophys.work` (from `cryptophys-home`) and the custom domain `console.cryptophys.work` (from `cryptophys-console`). `workers/console/wrangler.toml` declares no routes any more, and `deploy-console.yml` no longer checks the old host.
- After merge, one run of `retire-worker.yml` with `worker: cryptophys-home` and `confirm_production: DELETE` (ops request `{"workflow":"retire-worker.yml","inputs":{"worker":"cryptophys-home","confirm_production":"DELETE"}}`):
  1. it fails closed unless the source, the bindings and the deploy, validation and Access entries are gone from main, and unless no Worker config declares either hostname;
  2. it reads both hostnames through the Workers Custom Domains API (`GET /accounts/{account}/workers/domains?hostname=…`) and stops, detaching nothing, if either is attached to another Worker than expected;
  3. it detaches each (`DELETE /accounts/{account}/workers/domains/{id}`) and verifies that no custom domain is left on the hostname. Cloudflare removes the read-only DNS record it added for the custom domain; the Advanced Certificate it issued is not deleted automatically (follow-up below);
  4. only then it deletes the `cryptophys-home` script and verifies it is gone (404).

  Wrangler publishes only the routes it is given and leaves an undeclared custom domain attached, which is why the workflow detaches them explicitly. The calls use `CLOUDFLARE_API_TOKEN`. Cloudflare's current Workers authorization asks for Workers edit access plus **Zone → Workers Routes → Edit** on the zone to remove a Custom Domain, which that token may not hold (decision of 2026-11-06 above); on HTTP 401 or 403 the DELETE is retried once with `CLOUDFLARE_ACCESS_API_TOKEN`, which holds Workers Routes: Edit on `cryptophys.work`. Any other status, or a refusal of both, fails the run before the Worker is deleted.

**Kept**

- `cryptophys-console` is **not** deleted. It keeps serving `https://nexus.cryptophys.work/console/` through the zone route `nexus.cryptophys.work/console*`, which `deploy-console.yml` attaches and verifies as before and which the Retire Worker run never touches. Its redirect code and `LEGACY_HOSTS = "console.cryptophys.work"` stay, so the old host keeps redirecting to the mount until the run detaches it; afterwards nothing reaches it.
- D1 data is never deleted. Migration 0055 keeps the `cryptophys-home` row of `service_registry` and sets its status to `disabled`, as 0020 did for `cryptophys-signal-engine`: the Drift Detector records it with reason `disabled`, never probes it and never counts it as drift, so no owner notice or recovery plan follows; the Forge census reports nothing for a disabled row without DNA. Its drift history, deployment requests and audit events stay. Migration 0022 is history and unchanged.
- The Nexus Worker and its repository are unchanged (see the Nexus menu follow-up).

**Owner follow-ups**

- **Access.** The platform Access application keeps a `cryptophys-home` Worker destination until Provision Access runs again; run it once after the Retire Worker run, so the destinations equal `PLATFORM_WORKERS` (running it before would leave the Worker's `workers.dev` outside Access while it still exists). Any other Access application or destination that still names `home.cryptophys.work` or `console.cryptophys.work` is harmless once the hostnames have no DNS record, and this repository does not remove it: the owner removes it in Zero Trust when convenient.
- **Certificates.** Cloudflare does not delete the Advanced Certificate of a removed Custom Domain. The two certificates for `home.cryptophys.work` and `console.cryptophys.work` are harmless; the owner may delete them under SSL/TLS → Edge Certificates.
- **Nexus menu.** The Nexus Worker's "Cerebrum Console" menu entry still points at `console.cryptophys.work`; after the run it should point at `https://nexus.cryptophys.work/console/` (a change in `cryptophys-adm/xauusd-ai-trading-assistant`, not here).
- **Ops dispatch.** `ops-dispatch.yml` still allow-lists `deploy-home.yml`; a request for it fails because the workflow no longer exists. Removing the entry is a later workflow change.

**Rollback.** The Retire Worker run is irreversible on Cloudflare's side: a deleted Worker and a detached domain come back only by redeploying from Git history. Revert the retirement commit on main in a reviewed pull request (this restores `workers/home/`, `deploy-home.yml`, the lists and the Console's custom domain), add a forward migration that sets the registry row back to `registered`, then run Provision Access, Deploy Control Plane, Deploy Home and Deploy Console; Wrangler re-attaches the custom domains it is given. Before the run, rolling back is only reverting the commit.

**Verification after the run**

- `home.cryptophys.work` and `console.cryptophys.work` resolve to nothing (no DNS record), or at least no longer reach a Worker.
- `GET /accounts/{account}/workers/domains?hostname=home.cryptophys.work` and `…?hostname=console.cryptophys.work` return no record; `GET /accounts/{account}/workers/scripts/cryptophys-home/settings` returns 404.
- `https://nexus.cryptophys.work/console/health` still returns 200 from `cryptophys-console` through Access, and the Console UI loads under `/console/`.
- `GET /v1/drift` shows `cryptophys-home` with status `disabled` and reason `disabled`, not drifted.
