import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { APPROVER_EMAIL, APPROVER_JWT, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, OUTSIDER_JWT, accessEnv } from "./harness.ts";
import { UI_ROUTES } from "../../console/src/ui/routes.ts";
import consoleWorker, { CONSOLE_ALLOW_LIST, SERVICE_BINDINGS, type ConsoleService } from "../../console/src/index.ts";

const ORIGIN = "https://console.example.workers.dev";
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const UNSAFE = ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", 'setAttribute("on'];

interface Recorder { calls: Request[]; binding: { fetch(r: Request): Promise<Response> } }
function recorder(): Recorder {
  const calls: Request[] = [];
  return { calls, binding: { async fetch(r: Request) { calls.push(r); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }); } } };
}
function consoleEnv() {
  const bindings: Record<string, unknown> = {};
  for (const [service, name] of Object.entries(SERVICE_BINDINGS)) {
    bindings[name] = recorder().binding;
  }
  const env = {
    SERVICE_NAME: "cryptophys-console",
    SERVICE_ENVIRONMENT: "production",
    API_CONTRACT_VERSION: "v1",
    CF_VERSION_METADATA: { id: "ver-console", tag: "abc1234" },
    ACCESS_TEAM_DOMAIN: accessEnv().ACCESS_TEAM_DOMAIN,
    ACCESS_AUD: accessEnv().ACCESS_AUD,
    OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`,
    APPROVER_IDENTITIES: APPROVER_EMAIL,
    ASSETS: { async fetch() { return new Response('<!doctype html><script type="module" src="/assets/index-x.js"></script>', { headers: { "content-type": "text/html" } }); } },
    ...bindings,
  };
  return env;
}
interface Opts { jwt?: string | null; }
function creq(method: string, path: string, o: Opts = {}): Request {
  const h: Record<string, string> = {};
  if (o.jwt !== null) h["cf-access-jwt-assertion"] = o.jwt ?? OPERATOR_JWT;
  return new Request(`${ORIGIN}${path}`, { method, headers: h });
}
async function run(env: unknown, r: Request) {
  const res = await consoleWorker.fetch(r, env as never);
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* html or text */ }
  return { status: res.status, body, headers: res.headers, text };
}

// PROMPT.md §4, row by row: id, service, method, path, approverOnly, confirm.
const EXPECTED_TABLE: [string, string, string, string, boolean, string | null][] = [
  ["platform.overview", "platform", "GET", "/v1/overview", false, null],
  ["platform.usage", "platform", "GET", "/v1/usage", false, null],
  ["platform.observer", "platform", "GET", "/v1/observer", false, null],
  ["forge.status", "forge", "GET", "/v1/forge/status", false, null],
  ["forge.commits", "forge", "GET", "/v1/forge/commits", false, null],
  ["forge.checks", "forge", "GET", "/v1/forge/checks", false, null],
  ["forge.changes", "forge", "GET", "/v1/forge/changes", false, null],
  ["forge.deploy_plans", "forge", "GET", "/v1/forge/deploy-plans", false, null],
  ["forge.census", "forge", "GET", "/v1/forge/census", false, null],
  ["forge.build_usage", "forge", "GET", "/v1/forge/build-usage", false, null],
  ["forge.dependency_audit", "forge", "GET", "/v1/forge/dependency-audit", false, null],
  ["forge.git_backup", "forge", "GET", "/v1/forge/git-backup", false, null],
  ["kernel.kernel", "kernel", "GET", "/v1/kernel", false, null],
  ["kernel.status", "kernel", "GET", "/v1/status", false, null],
  ["kernel.notices", "kernel", "GET", "/v1/notices", false, null],
  ["kernel.owner_inbox", "kernel", "GET", "/v1/owner/inbox", false, null],
  ["kernel.metabolism", "kernel", "GET", "/v1/metabolism", false, null],
  ["kernel.mesh", "kernel", "GET", "/v1/mesh", false, null],
  // ADR-0016 T0: the Vision page (read-only).
  ["kernel.vision", "kernel", "GET", "/v1/vision", false, null],
  // ADR Steward step 4: the ADR panel's two read-only routes (docs/design/ADR-STEWARD.md §5).
  ["kernel.adr", "kernel", "GET", "/v1/adr", false, null],
  ["kernel.adr_one", "kernel", "GET", "/v1/adr/{id}", false, null],
  // HAIC H1c: "Ask the organism", owners only; no typed phrase (the chat cannot act).
  ["kernel.conversations", "kernel", "GET", "/v1/conversations", true, null],
  ["kernel.conversation", "kernel", "GET", "/v1/conversations/{id}", true, null],
  ["kernel.conversation_turn", "kernel", "POST", "/v1/conversations/{id}/turns", true, null],
  ["kernel.conversation_rate", "kernel", "POST", "/v1/conversations/{id}/turns/{id}/rating", true, null],
  // HAIC H1.5c: councils; operators read, the owner convenes, joins, picks and dismisses (phrases on convene, pick, dismiss).
  ["kernel.councils", "kernel", "GET", "/v1/councils", false, null],
  ["kernel.council", "kernel", "GET", "/v1/councils/{id}", false, null],
  ["kernel.council_start", "kernel", "POST", "/v1/councils", true, "CONVENE COUNCIL"],
  ["kernel.council_message", "kernel", "POST", "/v1/councils/{id}/messages", true, null],
  ["kernel.council_pick", "kernel", "POST", "/v1/councils/{id}/pick", true, "PICK {id13}"],
  ["kernel.council_dismiss", "kernel", "POST", "/v1/councils/{id}/dismiss", true, "DISMISS {id13}"],
  // HAIC H1.5d: the owner begins a proposed council (a typed phrase: it spends model calls).
  ["kernel.council_begin", "kernel", "POST", "/v1/councils/{id}/start", true, "CONVENE {id13}"],
  // HAIC push hub: the Console's WebSocket of change signals.
  ["kernel.hub", "kernel", "GET", "/v1/hub", false, null],
  // HAIC H2: typed proposals; the owner confirms or rejects a draft with a typed phrase.
  ["kernel.proposals", "kernel", "GET", "/v1/proposals", false, null],
  ["kernel.proposal", "kernel", "GET", "/v1/proposals/{id}", false, null],
  ["kernel.proposal_confirm", "kernel", "POST", "/v1/proposals/{id}/confirm", true, "CONFIRM {id13}"],
  ["kernel.proposal_reject", "kernel", "POST", "/v1/proposals/{id}/reject", true, "REJECT {id13}"],
  // HAIC H2b: a chat directive into a draft (no phrase: only a draft).
  ["kernel.proposal_draft", "kernel", "POST", "/v1/proposals", true, null],
  // HAIC H4: the autonomy dial; the owner sets a group's level with a phrase naming the group.
  ["kernel.autonomy", "kernel", "GET", "/v1/autonomy", false, null],
  ["kernel.autonomy_set", "kernel", "POST", "/v1/autonomy/{id}", true, "SET {id}"],
  ["kernel.reports", "kernel", "GET", "/v1/reports", false, null],
  ["kernel.report_acknowledge", "kernel", "POST", "/v1/reports/{id}/acknowledge", true, "ACKNOWLEDGE {id13}"],
  // Owner 2026-11-13: the Alerts page (Telegram alert channels), approvers only.
  ["kernel.alerts", "kernel", "GET", "/v1/alerts", false, null],
  ["kernel.alert_create", "kernel", "POST", "/v1/alerts", true, "ADD ALERT"],
  ["kernel.alert_update", "kernel", "POST", "/v1/alerts/{id}", true, "UPDATE {id13}"],
  ["kernel.alert_test", "kernel", "POST", "/v1/alerts/{id}/test", true, "TEST {id13}"],
  ["kernel.alert_delete", "kernel", "DELETE", "/v1/alerts/{id}", true, "DELETE {id13}"],
  ["kernel.agents", "kernel", "GET", "/v1/agents", false, null],
  ["kernel.agent", "kernel", "GET", "/v1/agents/{id}", false, null],
  ["kernel.agent_actions", "kernel", "GET", "/v1/agents/{id}/actions", false, null],
  ["kernel.consensus", "kernel", "GET", "/v1/consensus", false, null],
  ["kernel.consensus_proposal", "kernel", "GET", "/v1/consensus/{id}", false, null],
  ["kernel.consensus_report", "kernel", "GET", "/v1/consensus/report", false, null],
  ["kernel.consensus_mode_raise", "kernel", "POST", "/v1/consensus/mode", true, "RAISE MODE"],
  ["kernel.consensus_mode_shadow", "kernel", "POST", "/v1/consensus/mode", false, "SHADOW"],
  ["kernel.consensus_approve", "kernel", "POST", "/v1/consensus/{id}/approve", true, "APPROVE {id13}"],
  ["kernel.consensus_reject", "kernel", "POST", "/v1/consensus/{id}/reject", true, "REJECT {id13}"],
  ["kernel.knowledge", "kernel", "GET", "/v1/knowledge", false, null],
  ["aether.overview", "aether", "GET", "/v1/overview", false, null],
  ["kernel.knowledge_approve", "kernel", "POST", "/v1/knowledge/{id}/approve", true, "APPROVE {id13}"],
  ["kernel.knowledge_reject", "kernel", "POST", "/v1/knowledge/{id}/reject", true, "REJECT {id13}"],
  ["kernel.agents_disabled", "kernel", "POST", "/v1/kernel/agents-enabled", false, "AGENTS OFF"],
  ["kernel.agents_enabled", "kernel", "POST", "/v1/kernel/agents-enabled", true, "AGENTS ON"],
  ["kernel.wake", "kernel", "POST", "/v1/agents/{id}/wake", false, "WAKE {id}"],
  ["kernel.suspend", "kernel", "POST", "/v1/agents/{id}/suspend", false, "SUSPEND {id}"],
  ["kernel.resume", "kernel", "POST", "/v1/agents/{id}/resume", true, "RESUME {id}"],
  ["kernel.principal_add", "kernel", "POST", "/v1/agents/{id}/principals", true, "PRINCIPAL {id}"],
  ["kernel.principal_remove", "kernel", "DELETE", "/v1/agents/{id}/principals/{id}", true, "REVOKE {id}"],
  ["recovery.plans", "recovery", "GET", "/v1/plans", false, null],
  ["recovery.plan", "recovery", "GET", "/v1/plans/{id}", false, null],
  ["recovery.create", "recovery", "POST", "/v1/plans", true, "CREATE PLAN"],
  ["recovery.approve", "recovery", "POST", "/v1/plans/{id}/approve", true, "APPROVE {id13}"],
  ["recovery.disable", "recovery", "POST", "/v1/plans/{id}/disable", false, "DISABLE {id13}"],
  ["registry.services", "registry", "GET", "/v1/services", false, null],
  ["registry.service", "registry", "GET", "/v1/services/{id}", false, null],
  // Owner 2026-11-15 ("tombol Edit tidak berfungsi"): registry.upsert and registry.desired_version are removed with
  // the Infrastructure page's Edit form.
  ["registry.accounts", "registry", "GET", "/v1/accounts", false, null],
  ["registry.account_upsert", "registry", "POST", "/v1/accounts", true, "GRANT"],
  ["registry.account_disable", "registry", "POST", "/v1/accounts/{id}/disable", true, "REVOKE"],
  ["registry.accounts_sync", "registry", "POST", "/v1/accounts/sync-login", true, "SYNC"],
  // Owner 2026-11-16: the deploy-time identity lists' source (Users page); the write is an owner's, with a typed phrase.
  ["registry.identities", "registry", "GET", "/v1/identities", false, null],
  ["registry.identities_update", "registry", "POST", "/v1/identities", true, "IDENTITIES"],
  ["policy.decisions", "policy", "GET", "/v1/decisions", false, null],
  ["policy.decision", "policy", "GET", "/v1/decisions/{id}", false, null],
  ["policy.evaluate", "policy", "POST", "/v1/evaluate", false, null],
  ["drift.list", "drift", "GET", "/v1/drift", false, null],
  // Owner 2026-11-15: the service detail panel reads a service's recorded drift changes (read only).
  ["drift.service", "drift", "GET", "/v1/drift/{id}", false, null],
  ["drift.observe", "drift", "POST", "/v1/observe", false, null],
  ["audit.events", "audit", "GET", "/v1/events", false, null],
  ["audit.event", "audit", "GET", "/v1/events/{id}", false, null],
  ["audit.verify", "audit", "GET", "/v1/verify", false, null],
  ["orchestrator.deployments", "orchestrator", "GET", "/v1/deployments", false, null],
  // Owner 2026-11-14 ("hapus aja, karena roadmap berikutnya kita kembangkan Human Ai Interaction & Collaboration"):
  // orchestrator.deploy (POST /v1/deployments, "DEPLOY {sha12}") is removed.
];
const EXPECTED_IDS = EXPECTED_TABLE.map((r) => r[0]);

test("1. route table: exactly the 91 ids with those fields, matching allow-list rows", async () => {
  // + the Observer's read-only view (owner 2026-11-14).
  // - the manual deploy route orchestrator.deploy (owner 2026-11-14).
  // - registry.upsert and registry.desired_version, + drift.service (owner 2026-11-15).
  // + registry.identities and registry.identities_update (owner 2026-11-16).
  // + kernel.adr and kernel.adr_one (ADR Steward step 4, read-only).
  // + kernel.conversations, kernel.conversation, kernel.conversation_turn, kernel.conversation_rate (HAIC H1c).
  // + kernel.councils, kernel.council, kernel.council_start, kernel.council_message, kernel.council_pick, kernel.council_dismiss (HAIC H1.5c).
  // + kernel.council_begin (HAIC H1.5d).
  // + kernel.hub (HAIC push hub).
  // + kernel.proposals, kernel.proposal, kernel.proposal_confirm, kernel.proposal_reject (HAIC H2).
  // + kernel.proposal_draft (HAIC H2b).
  // + kernel.autonomy, kernel.autonomy_set (HAIC H4).
  assert.equal(UI_ROUTES.length, 91);
  assert.deepEqual(UI_ROUTES.map((r) => r.id).sort(), [...EXPECTED_IDS].sort());
  const allowKey = (s: string, m: string, p: string) => `${s} ${m} ${p}`;
  const allowSet = new Set(CONSOLE_ALLOW_LIST.map((r) => allowKey(r.service, r.method, r.path)));
  for (const r of UI_ROUTES) {
    // allow-list uses placeholders; compare pattern by segment
    const matched = CONSOLE_ALLOW_LIST.some((a) => a.service === r.service && a.method === r.method && a.path.split("/").length === r.path.split("/").length && a.path.split("/").every((seg, i) => seg === "{id}" || seg === r.path.split("/")[i]));
    assert.ok(matched, `no allow-list match for ${r.id}`);
  }
  assert.equal(new Set(UI_ROUTES.map((r) => r.id)).size, 91);
  assert.ok(!UI_ROUTES.some((r) => r.id === "orchestrator.deploy"), "the manual deploy route is gone");
  assert.ok(!UI_ROUTES.some((r) => r.id === "registry.upsert" || r.id === "registry.desired_version"), "the registry edit routes are gone (owner 2026-11-15)");
  assert.ok(!UI_ROUTES.some((r) => r.service === "registry" && r.method === "PUT"), "no UI route writes a service record or a desired version");
  assert.ok(!UI_ROUTES.some((r) => r.service === "orchestrator" && r.method !== "GET"), "no UI route writes to the Orchestrator");
  assert.ok(!UI_ROUTES.some((r) => r.confirm?.includes("{sha12}")), "no phrase template needs a commit SHA any more");
  // every field equals §4, in order
  assert.deepEqual(
    UI_ROUTES.map((r) => ({ ...r })),
    EXPECTED_TABLE.map(([id, service, method, path, approverOnly, confirm]) => ({ id, service, method, path, approverOnly, confirm })),
  );
});

test("2. approver flags: exactly the thirty-three approverOnly ids (since 2026-11-18 the owners' chat, HAIC H1c, the owner's council clicks, HAIC H1.5c and H1.5d, the typed proposal decisions, HAIC H2, and the autonomy dial, HAIC H4; owner clicks: approve, reject, raise mode, accounts, knowledge reviews; since 2026-11-08 also plan creation; since 2026-11-13 the acknowledgement of a critical report and the alert channels; the registry writes left on 2026-11-15; since 2026-11-16 the identity lists)", () => {
  const got = UI_ROUTES.filter((r) => r.approverOnly).map((r) => r.id).sort();
  assert.deepEqual(got, ["kernel.alert_create","kernel.alert_delete","kernel.alert_test","kernel.alert_update","kernel.agents_enabled","kernel.autonomy_set","kernel.conversation","kernel.conversation_rate","kernel.conversation_turn","kernel.conversations","kernel.consensus_approve","kernel.consensus_mode_raise","kernel.council_begin","kernel.council_dismiss","kernel.council_message","kernel.council_pick","kernel.council_start","kernel.consensus_reject","kernel.knowledge_approve","kernel.knowledge_reject","kernel.principal_add","kernel.principal_remove","kernel.proposal_confirm","kernel.proposal_draft","kernel.proposal_reject","kernel.report_acknowledge","kernel.resume","recovery.approve","recovery.create","registry.account_disable","registry.account_upsert","registry.accounts_sync","registry.identities_update"].sort());
});

test("3. confirmations: non-GET have confirm except policy.evaluate and drift.observe; GET have null", () => {
  for (const r of UI_ROUTES) {
    if (r.method === "GET") assert.equal(r.confirm, null, r.id);
    else {
      // HAIC H1c: asking and rating the read-only chat need no typed phrase; it cannot act.
      // HAIC H1.5c: a message to a running council needs none either; convening, picking and dismissing do.
      if (r.id === "policy.evaluate" || r.id === "drift.observe" || r.id === "kernel.conversation_turn" || r.id === "kernel.conversation_rate" || r.id === "kernel.council_message" || r.id === "kernel.proposal_draft") assert.equal(r.confirm, null, r.id);
      else assert.ok(r.confirm, r.id);
    }
  }
});

// ---------------------------------------------------------------- UI source (React SPA, workers/console/ui)
// Since the Nexus redesign the client is a React SPA built into Workers Static Assets (by esbuild since 2026-11-17).
// These criteria keep TP-024's guarantees by checking the UI source the bundle is built from.
const UI = new URL("../../console/ui/", import.meta.url).pathname;
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => { const f = join(dir, n); return statSync(f).isDirectory() ? walk(f) : [f]; });
}
const SRC = walk(join(UI, "src")).filter((f) => /\.(tsx?|css)$/.test(f));
const read = (rel: string) => readFileSync(join(UI, rel), "utf8");
const all = () => SRC.map((f) => ({ f: f.slice(UI.length), t: readFileSync(f, "utf8") }));

test("4. no unsafe DOM or eval in the UI source, and the HTML entry has no inline script/style/on*", () => {
  for (const { f, t } of all()) {
    for (const bad of [...UNSAFE, "dangerouslySetInnerHTML"]) assert.ok(!t.includes(bad), `${f} contains ${bad}`);
  }
  const html = read("index.html");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/);
  assert.doesNotMatch(html, /\sstyle=|\son[a-z]+=/i);
  // The build emits no inline script and no modulepreload polyfill (CSP script-src 'self'): build.mjs (esbuild since
  // 2026-11-17) writes only an external module script and an external stylesheet into the shell, and refuses an
  // index.html that lost its single entry script tag.
  const build = read("build.mjs");
  assert.match(build, /<script type="module" crossorigin src="\$\{href\(jsPath\)\}"><\/script>/);
  assert.match(build, /<link rel="stylesheet" crossorigin href="\$\{href\(cssPath\)\}">/);
  assert.match(build, /throw new Error\("index\.html no longer has the entry script tag"\)/);
  assert.doesNotMatch(build, /modulepreload|<style|<script>/);
});

test("5. assets come only from the ASSETS binding, after the operator check, with the exact CSP", async () => {
  const env = consoleEnv() as Record<string, unknown>;
  const seen: string[] = [];
  env.ASSETS = { async fetch(r: Request) { seen.push(new URL(r.url).pathname); return new Response("x", { headers: { "content-type": "text/javascript", "set-cookie": "a=1" } }); } };
  const ok = await run(env, creq("GET", "/assets/index-x.js", { jwt: OPERATOR_JWT }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "text/javascript");
  assert.equal(ok.headers.get("content-security-policy"), CSP);
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  assert.equal(ok.headers.get("set-cookie"), null);
  assert.equal((await run(env, creq("GET", "/assets/index-x.js", { jwt: OUTSIDER_JWT }))).status, 403);
  assert.equal((await run(env, creq("POST", "/", { jwt: OPERATOR_JWT }))).status, 405);
  assert.deepEqual(seen, ["/assets/index-x.js"]);
  const missing = await run({ ...env, ASSETS: undefined }, creq("GET", "/", { jwt: OPERATOR_JWT }));
  assert.equal(missing.status, 503);
});

test("6. single call path: fetch( appears only in lib/api.ts; every call() route id exists in UI_ROUTES", () => {
  const ids = new Set(UI_ROUTES.map((r) => r.id));
  for (const { f, t } of all()) {
    if (f !== "src/lib/api.ts") {
      assert.ok(!/\bfetch\(/.test(t.replace(/ASSETS\.fetch|\.fetch\(/g, "")), `${f} calls fetch directly`);
      assert.ok(!t.includes('"/api/'), `${f} builds an /api/ path itself`);
    }
    for (const m of t.matchAll(/\b(?:call|act)\(\s*(?:\{\s*route:\s*)?"([a-z_.]+)"/g)) assert.ok(ids.has(m[1]), `${f} uses unknown route ${m[1]}`);
    for (const m of t.matchAll(/route:\s*"([a-z_.]+)"/g)) assert.ok(ids.has(m[1]), `${f} uses unknown route ${m[1]}`);
  }
  const api = read("src/lib/api.ts");
  assert.equal((api.match(/\bfetch\(/g) ?? []).length, 1);
  // ADR-0010: every API path is prefixed with the mount (/console on the Nexus host, empty elsewhere).
  assert.match(api, /`\$\{MOUNT\}\/api\/whoami`/);
  assert.match(api, /export const MOUNT = typeof location !== "undefined" && location\.pathname\.startsWith\("\/console"\) \? "\/console" : ""/);
  assert.match(api, /x-cryptophys-console/);
});

test("7. the client is built from the same UI_ROUTES table the allow-list test checks", () => {
  assert.match(read("src/lib/api.ts"), /import \{ UI_ROUTES[^}]*\} from "\.\.\/\.\.\/\.\.\/src\/ui\/routes\.ts"/);
  assert.match(read("src/lib/api.ts"), /route\.confirm\.split\("\{id13\}"\)/);
});

test("8. no regressions: the TP-023 server surface is unchanged (allow-list, CSP, whoami, forwarding)", async () => {
  // + the Owner page's read-only inbox (owner 2026-11-13).
  // + the Alerts page's five rows (owner 2026-11-13).
  // + the Vision page's read-only row (ADR-0016 T0).
  // + the Observer's read-only view (owner 2026-11-14).
  // - the manual deploy row, orchestrator POST /v1/deployments (owner 2026-11-14).
  // - the two registry PUT rows, a service record and a desired version (owner 2026-11-15).
  // + the registry's GET and POST /v1/identities (owner 2026-11-16).
  // + the kernel's read-only GET /v1/adr and GET /v1/adr/{id} (ADR Steward step 4).
  // + the kernel's four chat rows (HAIC H1c).
  // + the kernel's six council rows (HAIC H1.5c), its start row (HAIC H1.5d), the hub (HAIC push hub) and four typed proposal rows (HAIC H2).
  // + the kernel's POST /v1/proposals (HAIC H2b).
  // + the kernel's GET /v1/autonomy and POST /v1/autonomy/{id} (HAIC H4).
  assert.equal(CONSOLE_ALLOW_LIST.length, 89);
  assert.ok(!CONSOLE_ALLOW_LIST.some((a) => a.service === "registry" && a.method === "PUT"), "no registry write of a service record or desired version is forwarded");
  assert.ok(!CONSOLE_ALLOW_LIST.some((a) => a.path === "/mcp" || (a.service === "audit" && a.method === "POST")));
  assert.ok(!CONSOLE_ALLOW_LIST.some((a) => a.service === "orchestrator" && a.method !== "GET"), "the Orchestrator is read only from the Console");
  const env = consoleEnv();
  const html = await run(env, creq("GET", "/", { jwt: OPERATOR_JWT }));
  assert.equal(html.headers.get("content-security-policy"), CSP);
  const who = await run(env, creq("GET", "/api/whoami", { jwt: APPROVER_JWT }));
  assert.equal(who.status, 200);
  assert.equal(who.body.approver, true);
  assert.equal(who.body.actor, APPROVER_EMAIL.toLowerCase());
  const mcp = await run(env, creq("GET", "/api/kernel/mcp", { jwt: OPERATOR_JWT }));
  assert.equal(mcp.status, 404);
  assert.equal(mcp.body.error, "not_allowed");
  // Owner 2026-11-14: a deploy request through the Console is not forwarded, even with the Console's CSRF headers.
  const orchestrator = recorder();
  (env as Record<string, unknown>).ORCHESTRATOR = orchestrator.binding;
  const deploy = creq("POST", "/api/orchestrator/v1/deployments", { jwt: APPROVER_JWT });
  deploy.headers.set("origin", ORIGIN);
  deploy.headers.set("x-cryptophys-console", "1");
  const refused = await run(env, deploy);
  assert.deepEqual([refused.status, refused.body.error], [404, "not_allowed"]);
  assert.equal(orchestrator.calls.length, 0, "the Orchestrator is never reached");
  assert.equal((await run(env, creq("GET", "/api/orchestrator/v1/deployments", { jwt: OPERATOR_JWT }))).status, 200, "the read-only list is still forwarded");
  assert.equal(orchestrator.calls.length, 1);
});

test("9. SAFE principal identifiers containing @, + and : reach the Worker unencoded", async () => {
  const api = read("src/lib/api.ts");
  assert.match(api, /return String\(v\);/);
  assert.doesNotMatch(api, /encodeURIComponent/);
  const env = consoleEnv();
  const kernel = recorder();
  (env as Record<string, unknown>).KERNEL = kernel.binding;
  const identity = "ops@cryptophys.work:svc+1";
  const request = creq("DELETE", `/api/kernel/v1/agents/platform-api/principals/${identity}`);
  request.headers.set("origin", ORIGIN);
  request.headers.set("x-cryptophys-console", "1");
  const response = await run(env, request);
  assert.equal(response.status, 200);
  assert.equal(kernel.calls.length, 1);
  assert.equal(new URL(kernel.calls[0].url).pathname, `/v1/agents/platform-api/principals/${identity}`);
  assert.ok(!/%40|%2B|%3A/.test(kernel.calls[0].url));
});

test("10. Mission Control reads the actual observe() overview fields", () => {
  const ov = read("src/lib/overview.tsx");
  assert.match(ov, /\(await call\("platform\.overview"\)\)\?\.overview/);
  const cmd = read("src/pages/Command.tsx");
  for (const k of ["ov?.services", "ov?.open_agent_plans", "agent_reports_24h?.counts", "ov?.xauusd_latest", "x.decision", "x.confidence", "x.candle_key", "x.decided_at"]) {
    assert.ok(cmd.includes(k), `Command.tsx does not read ${k}`);
  }
  assert.ok(read("src/components/AppShell.tsx").includes("latest_critical"));
});

test("11. maxLength on bounded inputs, and the approval text states the actual separation-of-duties rule", () => {
  assert.match(read("src/pages/AgentDetail.tsx"), /maxLength=\{200\}/);
  assert.match(read("src/pages/Recovery.tsx"), /maxLength=\{160\}/);
  assert.match(read("src/pages/Recovery.tsx"), /maxLength=\{500\}/);
  const d = read("src/pages/RecoveryDetail.tsx");
  assert.ok(d.includes("You cannot approve a plan you authored."));
  assert.match(d, /plan\.created_by !== who\.actor/);
});

test("12. audit export defers object URL revocation until after the click task", () => {
  assert.match(read("src/pages/Ledger.tsx"), /window\.setTimeout\(\(\) => URL\.revokeObjectURL\(url\), 0\)/);
});

test("13. confirmation dialog traps Tab focus, cancels on Escape and enables only on the phrase (case and spaces aside)", async () => {
  const m = read("src/components/ConfirmModal.tsx");
  assert.match(m, /e\.key === "Escape"/);
  assert.match(m, /e\.shiftKey && document\.activeElement === first/);
  assert.match(m, /document\.activeElement === last/);
  // Owner 2026-11-11: Confirm stayed disabled on a phone (auto-capitalisation) and on the id's trailing "-".
  assert.match(m, /const ok = normalizePhrase\(typed\) === normalizePhrase\(phrase\)/);
  assert.match(m, /disabled=\{!ok\}/);
  assert.match(m, /autoCapitalize="none" autoCorrect="off"/);
  assert.match(m, /e\.key === "Enter" && ok/);
  const api = read("src/lib/api.ts");
  assert.match(api, /id\.slice\(0, 13\)\.replace\(\/\[-_\.:\]\+\$\/, ""\)/, "{id13} drops a trailing separator");
  // The normaliser keeps the words and the id: only case and spaces are ignored.
  const normalize = (s: string) => String(s ?? "").trim().replace(/\s+/g, " ").toUpperCase();
  assert.equal(normalize("  approve   knw_1a2b3c4d "), normalize("APPROVE knw_1a2b3c4d"));
  assert.notEqual(normalize("APPROVE knw_1a2b3c4e"), normalize("APPROVE knw_1a2b3c4d"));
  assert.notEqual(normalize("REJECT knw_1a2b3c4d"), normalize("APPROVE knw_1a2b3c4d"));
});

test("14. Observe now stays disabled until its request settles, with no lock timer", () => {
  const inf = read("src/pages/Infrastructure.tsx");
  assert.match(inf, /route: "drift\.observe"/, "Observe now stays (owner 2026-11-15)");
  assert.match(inf, /disabled=\{busy\}/);
  assert.match(inf, /after: \(\) => \{ setBusy\(false\)/);
  assert.match(inf, /onError: \(\) => setBusy\(false\)/);
  assert.doesNotMatch(inf, /setTimeout/);
});

test("10. Aether's overview: GET reaches the AETHER binding as GET /v1/overview; nothing else does", async () => {
  const env = consoleEnv();
  const aether = recorder();
  (env as Record<string, unknown>).AETHER = aether.binding;
  const ok = await run(env, creq("GET", "/api/aether/v1/overview"));
  assert.equal(ok.status, 200);
  assert.equal(aether.calls.length, 1);
  assert.equal(new URL(aether.calls[0].url).pathname, "/v1/overview");
  assert.equal(aether.calls[0].method, "GET");
  for (const [method, path] of [["POST", "/api/aether/v1/overview"], ["GET", "/api/aether/health"], ["GET", "/api/aether/v1/learned-pack"]]) {
    const r = creq(method, path);
    if (method !== "GET") r.headers.set("origin", ORIGIN);
    assert.notEqual((await run(env, r)).status, 200, `${method} ${path} is not allowed`);
  }
  assert.equal(aether.calls.length, 1, "refused requests never reach Aether");
  assert.equal(SERVICE_BINDINGS.aether, "AETHER");
});

test("15. owner 2026-11-15: the registry edit routes are gone; the Console refuses them without reaching the Registry", async () => {
  const env = consoleEnv();
  const registry = recorder();
  (env as Record<string, unknown>).REGISTRY = registry.binding;
  for (const path of ["/api/registry/v1/services/cryptophys-platform-api", "/api/registry/v1/services/cryptophys-platform-api/desired-version"]) {
    const put = creq("PUT", path, { jwt: APPROVER_JWT });
    put.headers.set("origin", ORIGIN);
    put.headers.set("x-cryptophys-console", "1");
    const refused = await run(env, put);
    assert.deepEqual([refused.status, refused.body.error], [404, "not_allowed"], `PUT ${path} is not forwarded`);
  }
  assert.equal(registry.calls.length, 0, "the Registry is never reached");
  // Reads stay: the list and one record; the detail panel's drift history is a GET of an allow-listed row.
  assert.equal((await run(env, creq("GET", "/api/registry/v1/services", { jwt: OPERATOR_JWT }))).status, 200);
  assert.equal((await run(env, creq("GET", "/api/registry/v1/services/cryptophys-platform-api", { jwt: OPERATOR_JWT }))).status, 200);
  assert.equal(registry.calls.length, 2);
  assert.equal((await run(env, creq("GET", "/api/drift/v1/drift/cryptophys-platform-api", { jwt: OPERATOR_JWT }))).status, 200);
  // Owner 2026-11-16: the owner's identity lists are the one other Registry write (an owner's, with a typed phrase).
  assert.ok(UI_ROUTES.every((r) => r.service !== "registry" || r.method === "GET" || r.id.startsWith("registry.account") || r.id === "registry.identities_update"), "only account routes and the identity lists write to the Registry");
});
