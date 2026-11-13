// ADR-0010 (owner decision 2026-11-06): one subdomain. The Console is part of Nexus at
// nexus.cryptophys.work/console/; console.cryptophys.work and home.cryptophys.work redirect there;
// Nexus joins the platform Access application with Google and Microsoft OIDC sign-in.
// Amendment 2026-11-13: cryptophys-home and both old custom domains are retired
// (retire-home-adr0010.test.ts); the Console keeps its redirect code for the old host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, OUTSIDER_JWT, accessEnv } from "./harness.ts";
import consoleWorker, { MOUNT, SERVICE_BINDINGS } from "../../console/src/index.ts";

const ROOT = new URL("../../../", import.meta.url);
const NEXUS = "https://nexus.cryptophys.work";

function env(extra: Record<string, unknown> = {}) {
  const forwarded: Request[] = [];
  const assets: Request[] = [];
  const bindings: Record<string, unknown> = {};
  for (const name of Object.values(SERVICE_BINDINGS)) bindings[name] = { fetch: async (r: Request) => { forwarded.push(r); return Response.json({ ok: true }); } };
  const access = accessEnv();
  return {
    forwarded, assets,
    env: {
      SERVICE_NAME: "cryptophys-console", SERVICE_ENVIRONMENT: "production", API_CONTRACT_VERSION: "v1",
      CF_VERSION_METADATA: { id: "v", tag: "abc1234" },
      ACCESS_TEAM_DOMAIN: access.ACCESS_TEAM_DOMAIN, ACCESS_AUD: access.ACCESS_AUD,
      OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL,
      NEXUS_ORIGIN: NEXUS, LEGACY_HOSTS: "console.cryptophys.work",
      ASSETS: { fetch: async (r: Request) => { assets.push(r); return new Response("<html>", { headers: { "content-type": "text/html" } }); } },
      ...bindings, ...extra,
    },
  };
}

const req = (url: string, method = "GET", jwt: string | null = OPERATOR_JWT, headers: Record<string, string> = {}) =>
  new Request(url, { method, headers: { ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}), ...headers } });

test("1. the Console answers under /console on the Nexus host: UI assets and the API, with the prefix stripped", async () => {
  assert.equal(MOUNT, "/console");
  const e = env();
  const ui = await consoleWorker.fetch(req(`${NEXUS}/console/`), e.env as never);
  assert.equal(ui.status, 200);
  assert.equal(new URL(e.assets[0].url).pathname, "/", "the asset store sees the path inside the mount");
  await consoleWorker.fetch(req(`${NEXUS}/console/assets/index-x.js`), e.env as never);
  assert.equal(new URL(e.assets[1].url).pathname, "/assets/index-x.js");
  const who = await consoleWorker.fetch(req(`${NEXUS}/console/api/whoami`), e.env as never);
  assert.equal(who.status, 200);
  assert.equal((await who.json() as any).operator, true);
  const fwd = await consoleWorker.fetch(req(`${NEXUS}/console/api/kernel/v1/kernel`), e.env as never);
  assert.equal(fwd.status, 200);
  assert.equal(new URL(e.forwarded[0].url).pathname, "/v1/kernel", "forwarded to the Worker's own path");
});

test("2. /console without a slash redirects to /console/; unprefixed paths still work on workers.dev", async () => {
  const e = env();
  const r = await consoleWorker.fetch(req(`${NEXUS}/console?x=1`), e.env as never);
  assert.equal(r.status, 301);
  assert.equal(r.headers.get("location"), "/console/?x=1");
  const dev = await consoleWorker.fetch(req("https://cryptophys-console.x.workers.dev/api/whoami"), e.env as never);
  assert.equal(dev.status, 200);
});

test("3. the mount changes nothing about security: Access, operators, CSRF and the allow-list still apply", async () => {
  const e = env();
  assert.equal((await consoleWorker.fetch(req(`${NEXUS}/console/api/whoami`, "GET", null), e.env as never)).status, 403, "no Access JWT, no Console");
  assert.equal((await consoleWorker.fetch(req(`${NEXUS}/console/api/whoami`, "GET", OUTSIDER_JWT), e.env as never)).status, 403);
  assert.equal((await consoleWorker.fetch(req(`${NEXUS}/console/`, "GET", OUTSIDER_JWT), e.env as never)).status, 403);
  const csrf = await consoleWorker.fetch(req(`${NEXUS}/console/api/drift/v1/observe`, "POST", OPERATOR_JWT, { origin: "https://evil.example", "x-cryptophys-console": "1" }), e.env as never);
  assert.equal(csrf.status, 403);
  const ok = await consoleWorker.fetch(req(`${NEXUS}/console/api/drift/v1/observe`, "POST", OPERATOR_JWT, { origin: NEXUS, "x-cryptophys-console": "1" }), e.env as never);
  assert.equal(ok.status, 200, "same-origin on the Nexus host is accepted");
  assert.equal((await consoleWorker.fetch(req(`${NEXUS}/console/api/kernel/mcp`, "POST", OPERATOR_JWT, { origin: NEXUS, "x-cryptophys-console": "1" }), e.env as never)).status, 404);
  // Outsiders cost one role lookup each (GET /v1/accounts/me); only the operator's observe is forwarded.
  assert.equal(e.forwarded.filter((r) => !new URL(r.url).pathname.endsWith("/v1/accounts/me")).length, 1);
});

test("4. console.cryptophys.work redirects to the Nexus mount, keeping the path; health stays for verification", async () => {
  const e = env();
  const root = await consoleWorker.fetch(req("https://console.cryptophys.work/", "GET", null), e.env as never);
  assert.deepEqual([root.status, root.headers.get("location")], [301, `${NEXUS}/console/`]);
  const deep = await consoleWorker.fetch(req("https://console.cryptophys.work/api/whoami?a=1", "GET", null), e.env as never);
  assert.equal(deep.headers.get("location"), `${NEXUS}/console/api/whoami?a=1`);
  const post = await consoleWorker.fetch(req("https://console.cryptophys.work/api/drift/v1/observe", "POST", null), e.env as never);
  assert.equal(post.status, 308, "methods other than GET keep their method");
  const health = await consoleWorker.fetch(req("https://console.cryptophys.work/health"), e.env as never);
  assert.equal(health.status, 200);
  assert.equal(e.forwarded.length, 0);
});

test("6. wiring: Workers route on the Nexus host, the UI is mount-relative, Access covers nexus.cryptophys.work with Google and Microsoft", () => {
  const toml = readFileSync(new URL("workers/console/wrangler.toml", ROOT), "utf8");
  // The zone route is attached by the deploy workflow with CLOUDFLARE_ACCESS_API_TOKEN (the Workers
  // deploy token cannot hold zone route permissions), before verification; the redirect is on.
  assert.doesNotMatch(toml, /^\s*\{ pattern = "nexus/m, "wrangler does not manage the zone route");
  assert.match(toml, /^LEGACY_HOSTS = "console\.cryptophys\.work"/m);
  // Amendment 2026-11-13: the old custom domain is no longer declared (retire-worker.yml detaches it).
  assert.doesNotMatch(toml, /custom_domain/, "the Console declares no custom domain");
  const wf = readFileSync(new URL(".github/workflows/deploy-console.yml", ROOT), "utf8");
  const deploy = wf.indexOf("npx wrangler deploy"), route = wf.indexOf("ensure-zone-route.sh"), verify = wf.indexOf("nexus.cryptophys.work/console/health");
  assert.ok(deploy > 0 && route > deploy && verify > route, "deploy, then attach the route, then verify it through Access");
  assert.match(wf, /CLOUDFLARE_ACCESS_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_ACCESS_API_TOKEN \}\}\n\s+ZONE_NAME: cryptophys\.work\n\s+ROUTE_PATTERN: nexus\.cryptophys\.work\/console\*/);
  assert.match(toml, /NEXUS_ORIGIN = "https:\/\/nexus\.cryptophys\.work"/);
  assert.match(readFileSync(new URL("workers/console/ui/vite.config.ts", ROOT), "utf8"), /base: "\.\/"/);
  const shell = readFileSync(new URL("workers/console/ui/src/components/AppShell.tsx", ROOT), "utf8");
  assert.doesNotMatch(shell, /home\.cryptophys\.work|console\.cryptophys\.work/, "no links to retired hosts");
  const prov = readFileSync(new URL(".github/workflows/provision-access.yml", ROOT), "utf8");
  assert.match(prov, /PUBLIC_HOSTNAMES: nexus\.cryptophys\.work/);
  assert.match(prov, /\{type: "public", uri: \$h\}/);
  assert.match(prov, /\.type == "google" or \.type == "azureAD" or \.type == "oidc" or \.type == "onetimepin"/);
  assert.match(prov, /allowed_idps: \[\$idps\[\]\.id\]/);
});
