# Forge type-check on Workers Builds (ADR-0012 §5c)

The TypeScript compiler needs about 190 MB for this repository; a Workers isolate has 128 MB. The
owner decided on 2026-11-08 that the type-check runs on **Workers Builds** from the Artifacts
repository `cryptophys/platform`. No GitHub, no Container.

## How it works

1. Every push to the Artifacts repository (the mirror of `main`, and later every branch) starts a
   build of this project, with this directory as its root.
2. The **build command** `node typecheck-and-report.mjs` installs the locked toolchain in
   `../control-plane-shared` (`npm ci --ignore-scripts`), runs `npm run typecheck`
   (`tsc --noEmit -p ../control-plane-tsconfig.json`), and reports the result for the commit to the
   Forge: `POST /v1/forge/typecheck-report`, with the CI service token. Diagnostics contain only file, line and TypeScript error code; compiler messages and source literals are neither printed to build logs nor sent to Forge. Existing D1 report and check rows are sanitized when read; historical values are not rewritten.
   The same build then installs `../console/ui` and runs its `npm run build` (the UI's own
   `tsc --noEmit` and the Vite build, as GitHub CI's "Build the Console UI" step) and reports it in
   the same request as `console_build` (conclusion, errors, diagnostics, output size).
3. The Forge records the report (`forge_typecheck_reports`, migration 0035) and folds it into its
   check of the same commit as the `typecheck` step. A type error or a failed Console build fails that
   check. Until the report arrives the step reads `pending`. A check is **ready** when its tests and
   bundles passed, no secret was found, the types passed and the Console built (migration 0036
   stores the Console build).
4. The **deploy command** `npx wrangler deploy` deploys this stub Worker. It has no route, no
   `workers.dev` URL and no bindings; it exists because Workers Builds deploys a Worker.

The build finds its commit from `WORKERS_CI_COMMIT_SHA` when Workers Builds sets a full SHA, and
otherwise from `git rev-parse HEAD` of the checkout (builds from Artifacts may not set it).

## One-time setup (owner, Cloudflare dashboard)

1. **Workers & Pages → Create application → Continue with Artifacts.** Namespace `cryptophys`,
   repository `platform`.
2. Project name `cryptophys-forge-typecheck` (it must match `name` in `wrangler.toml`).
3. **Advanced settings → Root directory:** `workers/forge-typecheck`.
4. **Build command:** `node typecheck-and-report.mjs`. **Deploy command:** `npx wrangler deploy`.
5. **Build variables and secrets:**
   - `FORGE_URL` = the Forge's URL (`https://cryptophys-forge.<subdomain>.workers.dev`), plain;
   - `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` = the existing CI service token, both as
     **secrets** (the same values the GitHub `production` environment holds; no new credential).
     These go under **Settings → Build → Variables and secrets**, not under the Worker's runtime
     **Variables and Secrets**: runtime secrets are not visible to the build command.
     If the build log says `Cloudflare Access refused the CI service token (HTTP 302 ...)`, the
     build secret differs from the token's current secret; paste it again (or rotate the token and
     update GitHub `production` and these build secrets together).
6. **Deploy.** The first build runs on the current `main`; later builds run on every push.
7. **Do not enable preview builds with the CI service token (security, 2026-11-09).** A build
   runs the checked-out branch's own code: `typecheck-and-report.mjs`, the Vite config and the npm
   scripts all come from that branch. A preview build of a change request would therefore run
   unreviewed code with `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` in its environment, and the
   CI service token is operator-level across the control plane. On GitHub, pull request code never
   sees production secrets (the `production` environment is main-only); this must stay true here.
   Production builds of `main` (reviewed, merged code) keep the build secrets. Type-checks of change
   requests need a build with **no secrets** whose result the Forge reads itself; that design waits
   for the owner (ADR-0012 §5d). Until then change requests stay `pending` on the type-check, and
   GitHub CI type-checks every pull request as before.

The Console Code page then shows `types ok` / `N type errors` / `types pending` per commit.
