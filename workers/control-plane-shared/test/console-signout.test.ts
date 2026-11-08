// Owner request (2026-11-08): a Sign out menu in the Cerebrum Console, and a fallback for people
// whose account may use Nexus but not the Console: a page that says who they are signed in as and
// offers to switch to an account that has access (Cloudflare Access logout), instead of a bare 403.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, OUTSIDER_JWT, baseEnv, migratedDb, signAccessJwt } from "./harness.ts";
import consoleWorker, { SERVICE_BINDINGS } from "../../console/src/index.ts";
import { ACCESS_LOGOUT_PATH, CONSOLE_ACCESS_HEADER } from "../../console/src/denied.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const NEXUS = "https://nexus.cryptophys.work";
const HTML = { accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };

/** A Console env whose Registry knows one Nexus-only user and one admin viewer. */
function env(downstream?: (r: Request) => Response) {
  const bindings: Record<string, unknown> = {};
  for (const name of Object.values(SERVICE_BINDINGS)) bindings[name] = { fetch: async (r: Request) => (downstream ? downstream(r) : Response.json({ ok: true })) };
  bindings.REGISTRY = {
    fetch: async (r: Request) => {
      const jwt = r.headers.get("cf-access-jwt-assertion") ?? "";
      const email = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).email;
      if (new URL(r.url).pathname === "/v1/accounts/me") {
        if (email === "viewer@example.com") return Response.json({ email, kind: "admin", role: "viewer" });
        return Response.json({ email, kind: "user", role: null });
      }
      return downstream ? downstream(r) : Response.json({ ok: true });
    },
  };
  const access = baseEnv("x", migratedDb());
  return {
    SERVICE_NAME: "cryptophys-console", SERVICE_ENVIRONMENT: "production", API_CONTRACT_VERSION: "v1",
    ACCESS_TEAM_DOMAIN: access.ACCESS_TEAM_DOMAIN, ACCESS_AUD: access.ACCESS_AUD,
    OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`, APPROVER_IDENTITIES: APPROVER_EMAIL,
    NEXUS_ORIGIN: NEXUS,
    ASSETS: { fetch: async () => new Response("<html>spa</html>", { headers: { "content-type": "text/html" } }) },
    ...bindings,
  };
}
const get = (url: string, jwt: string | null, headers: Record<string, string> = {}) =>
  consoleWorker.fetch(new Request(url, { headers: { ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}), ...headers } }), env() as never);

test("SO1. a Nexus-only account opening the Console gets a page: who they are, Switch account, Back to Nexus", async () => {
  const jwt = await signAccessJwt({ email: "nexus.user+<b>@example.com" });
  const r = await get(`${NEXUS}/console/`, jwt, HTML);
  assert.equal(r.status, 403);
  assert.match(r.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const html = await r.text();
  assert.match(html, /This account cannot open the Cerebrum Console/);
  assert.ok(html.includes("nexus.user+&lt;b&gt;@example.com"), "the identity is shown, escaped");
  assert.ok(!html.includes("<b>@"), "never as markup");
  assert.ok(html.includes(`href="${ACCESS_LOGOUT_PATH}">Switch account</a>`));
  assert.ok(html.includes(`href="${NEXUS}/">Back to Nexus</a>`));
  assert.doesNotMatch(html, /<script/i, "no script on the page");
  // The page keeps the Console's strict CSP: no inline style without its hash, nothing else allowed.
  const csp = r.headers.get("content-security-policy") ?? "";
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1];
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(style));
  const hash = btoa(String.fromCharCode(...new Uint8Array(digest)));
  assert.equal(csp, `default-src 'none'; style-src 'sha256-${hash}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  assert.equal(r.headers.get("x-frame-options"), "DENY");
  const head = await consoleWorker.fetch(new Request(`${NEXUS}/console/`, { method: "HEAD", headers: { "cf-access-jwt-assertion": jwt, ...HTML } }), env() as never);
  assert.equal(head.status, 403);
  assert.equal(await head.text(), "");
});

test("SO2. API calls, non-browser requests and unauthenticated requests keep their JSON answers", async () => {
  const api = await get(`${NEXUS}/console/api/whoami`, OUTSIDER_JWT, HTML);
  assert.equal(api.status, 403);
  assert.deepEqual(await api.json(), { error: "forbidden", detail: "the Cerebrum Console is for admin accounts" });
  assert.equal(api.headers.get(CONSOLE_ACCESS_HEADER), "denied", "the UI can tell the Console's gate from a downstream check");
  const curl = await get(`${NEXUS}/console/`, OUTSIDER_JWT, { accept: "*/*" });
  assert.equal(curl.status, 403);
  assert.match(curl.headers.get("content-type") ?? "", /json/);
  const anon = await get(`${NEXUS}/console/`, null, HTML);
  assert.equal(anon.status, 403);
  assert.match(anon.headers.get("content-type") ?? "", /json/, "no identity, no page");
  assert.equal(anon.headers.get(CONSOLE_ACCESS_HEADER), null);
});

test("SO3. admin accounts still get the Console; a downstream 403 never looks like the Console's gate", async () => {
  const viewer = await signAccessJwt({ email: "viewer@example.com" });
  const ui = await get(`${NEXUS}/console/`, viewer, HTML);
  assert.equal(ui.status, 200);
  assert.equal(await ui.text(), "<html>spa</html>");
  assert.equal((await get(`${NEXUS}/console/`, OPERATOR_JWT, HTML)).status, 200);
  const deniedDownstream = await consoleWorker.fetch(
    new Request(`${NEXUS}/console/api/kernel/v1/kernel`, { headers: { "cf-access-jwt-assertion": OPERATOR_JWT } }),
    env(() => Response.json({ error: "forbidden" }, { status: 403, headers: { [CONSOLE_ACCESS_HEADER]: "denied" } })) as never,
  );
  assert.equal(deniedDownstream.status, 403);
  assert.equal(deniedDownstream.headers.get(CONSOLE_ACCESS_HEADER), null, "forwarded responses carry only their status and body");
});

test("SO4. the UI: account menu with Switch account and Sign out, the role shown as it is, and the gate's 403 reloads", () => {
  const api = read("workers/console/ui/src/lib/api.ts");
  assert.match(api, /export const ACCESS_LOGOUT = "\/cdn-cgi\/access\/logout";/);
  assert.match(api, /res\.status === 403 && res\.headers\.get\("x-cryptophys-console-access"\) === "denied"/);
  const shell = read("workers/console/ui/src/components/AppShell.tsx");
  assert.match(shell, /function AccountMenu\(\)/);
  assert.equal((shell.match(/href=\{ACCESS_LOGOUT\}/g) ?? []).length, 4, "Switch account and Sign out, in the desktop menu and the mobile menu");
  assert.match(shell, /Sign out/);
  assert.match(shell, /if \(who\.viewer \|\| who\.role === "viewer"\) return "Viewer";/, "a viewer is no longer labelled Operator");
  assert.match(shell, /\{roleLabel\(who\)\}<\/span>/);
  const main = read("workers/console/ui/src/main.tsx");
  assert.match(main, /err\?\.status === 403 \? <AccessNeeded \/>/);
  assert.match(main, /href=\{ACCESS_LOGOUT\}[^>]*>Switch account/);
});
