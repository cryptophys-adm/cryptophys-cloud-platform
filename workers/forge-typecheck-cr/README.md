# Forge change-request type-check on Workers Builds (ADR-0012 §5d)

Owner decision 2026-11-11 ("langkah B"). The control-plane type-check of `main` runs in
`../forge-typecheck` with the CI service token as a build secret. Change requests (`cr/<number>`
branches) cannot use that project: a build runs the branch's own code, so a change request would run
unreviewed code next to the token. This project type-checks them with **no build secrets at all**.

## How it works

1. A push to `cr/<number>` in the Artifacts repository `cryptophys/platform` starts a Preview build of
   this project. Pushes to `main` start a production build (the same type-check; harmless).
2. The **build command** `node typecheck-and-report.mjs` runs `../forge-typecheck/typecheck-and-report.mjs`
   with `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` and `FORGE_URL` removed. That script prints one log
   line, `FORGE_TYPECHECK_RESULT {...}` (commit, build id, branch, conclusion, error counts, file:line:code
   diagnostics only, toolchain, Console build), and exits non-zero when a check failed.
3. Each Forge tick (`workers/forge/src/cr-builds.ts`) lists this Worker's builds through the Workers Builds
   API with its own secret `CF_BUILDS_API_TOKEN`, reads the log of the newest finished build of each open
   change request's `cr/<number>` branch, and records the line as that head's type-check report when its
   commit equals the head. The Forge verdict of the change request then stops waiting on the type-check.
4. The result comes from the change request's own code, which could change the check. A change request
   that touches the type-check harness (`workers/forge-typecheck*/`, the TypeScript configs, the
   `package.json` and lockfiles of `control-plane-shared` and `console/ui`, the Vite config) is therefore
   an owner path: its verdict is `needs owner`.

## One-time setup (owner, Cloudflare dashboard)

1. **Workers & Pages → Create application → Continue with Artifacts.** Namespace `cryptophys`, repository
   `platform`.
2. Project name `cryptophys-forge-typecheck-cr` (it must match `name` in `wrangler.toml`).
3. **Root directory:** `workers/forge-typecheck-cr`. **Build command:** `node typecheck-and-report.mjs`.
   **Deploy command:** `npx wrangler deploy`.
4. **API token:** create a new token for this project only.
5. **Build variables and secrets: none**, for production and for Previews.
6. **Settings → Builds → Previews Base:** turn on **Builds for Preview branches**; Preview command
   `npx wrangler preview`; no variables, secrets or bindings in the Preview settings.
7. The Forge's reader token: a user API token with `Account · Workers Builds Configuration · Edit` (the
   Builds API documents no read-only level) and `Account · Workers Scripts · Read`, for this account only,
   stored as the Forge secret `CF_BUILDS_API_TOKEN` (**Workers & Pages → cryptophys-forge → Settings →
   Variables and Secrets → Add → Secret**).

## Residual risk

The Preview build holds this project's build token, which can deploy Workers. Change-request code could
use it while it builds. Keep this project's build token separate from every other credential.
