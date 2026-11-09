// Wave C: render every Console screen in Chromium, in CI, at phone and desktop widths, under
// the ADR-0010 /console/ mount, against an empty-but-valid mocked API. Fails on any page error,
// failed request, CSP-breaking inline script, or horizontal scroll. No credentials or network.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const ROUTES = ["", "agents", "agents/supervisor", "cognition", "consensus", "knowledge", "recovery", "recovery/plan_00000000-0000-0000-0000-000000000000",
  "infrastructure", "policy", "ledger", "pipelines", "markets", "users", "code"];
const MOCK = {
  "/api/whoami": { actor: "owner@example.com", type: "user", operator: true, approver: true, role: "approver", owner: true, viewer: false },
  "/api/registry/v1/accounts": {
    owners: ["owner@example.com"], configured_operators: [], login_sync: "not_configured",
    accounts: [
      { email: "analyst.with.a.rather.long.address@example-company.co.id", kind: "admin", privilege: "viewer", status: "active", note: "read only", created_by: "owner@example.com", created_at: "2026-11-07T09:00:00Z", updated_by: "owner@example.com", updated_at: "2026-11-07T09:00:00Z" },
      { email: "trader@example.com", kind: "user", privilege: null, status: "disabled", note: null, created_by: "owner@example.com", created_at: "2026-11-07T09:00:00Z", updated_by: "owner@example.com", updated_at: "2026-11-07T09:05:00Z" },
    ],
  },
  "/api/kernel/v1/consensus": { mode: "shadow", stats_24h: {}, proposals: [] },
  "/api/forge/v1/forge/status": { configured: true, source: "https://github.com/cryptophys-adm/cryptophys-cloud-platform", repo: { name: "platform", default_branch: "main", last_push_at: null }, head: { sha: "3dbbead07e50e78fedd94db712f38a0f7eb0cdb4", title: "fix(forge): read Artifacts commit metadata defensively (#215)", author: "cryptophys-adm", date: "2026-11-08T05:18:00.000Z" } },
  "/api/forge/v1/forge/checks": { parity: { target: 20, consecutive: 1, compared: 2, disagreements: ["8588e21c0ffee0000000000000000000000000000"] }, checks: [
    { commit: "3dbbead07e50e78fedd94db712f38a0f7eb0cdb4", status: "passed", runner: "forge-runner/1", files: 44, pass: 339, fail: 0, skip: 0, failures: [], started_at: "2026-11-08T09:34:00.000Z", finished_at: "2026-11-08T09:34:43.000Z", duration_ms: 43000, bundles: { workers: 11, failed: 0 }, guard_status: "clean", typecheck: { status: "failed", errors: 12, build_id: "b-1" }, github: "success", agrees: true },
    { commit: "8588e21c0ffee0000000000000000000000000000", status: "failed", runner: "forge-runner/1", files: 43, pass: 321, fail: 1, skip: 0, failures: ["home-tp025.test.ts :: TP-025 Home Worker Wrangler dry-run bundle: child_process is not available in the Forge runner, which is a very long line that has to wrap on a phone"], started_at: "2026-11-08T09:19:49.000Z", finished_at: "2026-11-08T09:20:33.000Z", duration_ms: 43287, github: "success", agrees: false },
  ] },
  "/api/forge/v1/forge/changes": { parity: { target: 10, consecutive: 1, compared: 1, late: 1, disagreements: [] }, changes: [
    { cr_id: "gh-247", number: 247, branch: "cr/247", source_branch: "claude/gracious-brown-tkc4e8", title: "forge: change requests in shadow, with a title long enough to wrap on a phone screen", author: "cryptophys-adm", head_sha: "3dbbead07e50e78fedd94db712f38a0f7eb0cdb4", base_sha: "8588e21c0ffee0000000000000000000000000000", github_ci: "success", status: "open", changed_paths: ["A workers/forge/src/changes.ts", "M architecture/adr/0012-github-independence.md"], critical: ["adr_0009_0012: architecture/adr/0012-github-independence.md"], check: { status: "passed", pass: 390, fail: 0, guard_status: "clean", typecheck: { status: "passed", errors: 0, build_id: "b", console_build: "passed" }, ready: true }, verdict: "needs_owner", reasons: ["adr_0009_0012: architecture/adr/0012-github-independence.md"], merge_sha: null, agrees: null, created_at: "2026-11-09T07:00:00.000Z", updated_at: "2026-11-09T07:05:00.000Z", outcome_at: null },
    { cr_id: "gh-246", number: 246, branch: "cr/246", source_branch: "claude/gracious-brown-tkc4e8", title: "recovery: retire superseded drafts", author: "cryptophys-adm", head_sha: "bcd30c5b4e45f0921ae9fcbc3ccaee8c22a2e9f8", base_sha: "188b6bb31ed1a17cdaec44ea6180da087395e973", github_ci: "success", status: "merged", changed_paths: ["A workers/recovery-manager/src/superseded.ts"], critical: [], check: null, verdict: "would_merge", reasons: [], merge_sha: "b6979583cb906646513a922cd854a17e92e54d94", agrees: true, created_at: "2026-11-09T06:00:00.000Z", updated_at: "2026-11-09T06:10:00.000Z", outcome_at: "2026-11-09T06:10:00.000Z" },
  ] },
  "/api/forge/v1/forge/deploy-plans": { parity: { target: 10, consecutive: 2, compared: 3, disagreements: ["5bc3c94b14d1"] }, plans: [
    { main_sha: "9a6a31f2ae8af6ca4a57ddc976787ecbc63d7dde", forge_units: ["control-plane"], forge_skipped: [{ unit: "forge", reason: "control_plane_migration_first" }], forge_at: "2026-11-09T07:19:00.000Z", github_units: ["control-plane"], github_skipped: [], github_at: "2026-11-09T07:20:00.000Z", agrees: true },
    { main_sha: "188b6bb31ed1a17cdaec44ea6180da087395e973", forge_units: [], forge_skipped: [], forge_at: "2026-11-09T06:19:00.000Z", github_units: null, github_skipped: null, github_at: null, agrees: null },
  ] },
  "/api/forge/v1/forge/census": { census: [{ main_sha: "6872844" + "0".repeat(33), status: "changes", organs: 12, agents: 10, engines: 9, voters: 9, taken_at: "2026-11-09T12:04:00.000Z",
    findings: [{ kind: "unregistered_agent", subject: "forge-steward", detail: "agent forge-steward on cryptophys-forge is in the DNA but not registered (asks for a council seat), which is a long line that wraps on a phone" }], genome: [] }] },
  "/api/forge/v1/forge/commits": { commits: [{ sha: "3dbbead07e50e78fedd94db712f38a0f7eb0cdb4", title: "fix(forge): read Artifacts commit metadata defensively (#215)", author: "cryptophys-adm", date: "2026-11-08T05:18:00.000Z" }] },
  "/api/kernel/v1/notices": { email: "not_configured", notices: [
    { topic: "owner_attention", active: true, fingerprint: "f", title: "1 item(s) wait for your approval", link: "https://nexus.cryptophys.work/console/#/", lines: ["Recovery plan for Cerebrum Console (by agent:supervisor): review at https://nexus.cryptophys.work/console/#/recovery/plan_00000000-0000-4000-8000-000000000000"] },
    { topic: "drift", active: false, fingerprint: "", title: "All services are healthy", link: "https://nexus.cryptophys.work/console/#/infrastructure", lines: [] },
  ] },
  "/api/kernel/v1/knowledge": { counts: { pending: 1 }, proposals: [{ proposal_id: "knw_00000000-0000-4000-8000-000000000000", proposer_agent_id: "aether-curator", item_id: "k-prophet-trap", item_version: 1, kind: "caution", content_sha256: "0".repeat(64), status: "pending", decided_by: null, reason: null, created_at: "2026-11-07T12:00:00.000Z", decided_at: null, item: { text: "Its bearish lean was wrong in 11 of 14 such bars.", audience: { agents: ["prophet"], charts: ["60"] }, evidence: { bars: 14, wrong: 11 }, provenance: { card_ids: [] } } }] },
  "/api/orchestrator/v1/deployments": {
    active: {
      requests: [{ request_id: "dep_1", service_id: "cryptophys-platform-api", version: "e0bd92815ac9cbae7481e14e1798238068e4b2a9", status: "running", requested_by: "consensus:cns_1", origin: "consensus", workflow: "deploy-platform-api.yml", proposal_id: "cns_1", run_url: null, note: null, created_at: "2026-11-08T14:02:00.000Z", updated_at: "2026-11-08T14:02:05.000Z" }],
      proposals: [{ proposal_id: "cns_2", action: "deploy_commit", target: "cryptophys-deployment-orchestrator-with-a-long-name", class: "routine", status: "executing", approvals: 9, eligible: 9, created_at: "2026-11-08T14:01:00.000Z", decided_at: "2026-11-08T14:01:30.000Z" }],
    },
    requests: [{ request_id: "dep_0", service_id: "cryptophys-platform-api", version: "6fafa095ce3eea19679398a3b2bfb6e596270f7b", status: "failed", requested_by: "edecae24a56f7a12c78455585f23e707.access", origin: "deploy workflow", workflow: "deploy-platform-api.yml", proposal_id: null, run_url: "https://github.com/cryptophys-adm/cryptophys-cloud-platform/actions/runs/1", note: "stale: no workflow run finished within 3 hours", created_at: "2026-11-08T10:00:00.000Z", updated_at: "2026-11-08T13:00:00.000Z" }],
    deploys: [{ service_id: "cryptophys-deployment-orchestrator", version: "e0bd92815ac9", previous: "6fafa095ce3e", origin: "deploy workflow", actor: "edecae24a56f7a12c78455585f23e707.access", at: "2026-11-08T14:24:17.000Z" }],
    generated_at: "2026-11-08T14:30:00.000Z",
  },
  "/api/kernel/v1/consensus/report": { window_days: 7, total: 0, scored: 0, agree: 0, false_positive: 0, false_negative: 0, pending: 0, agreement_rate: null, by_action: {}, items: [] },
};
// Visual hardening 2026-11-09: realistic volumes so the charts and scrollable tables render with data
// (timestamps relative to now, deterministic otherwise).
const NOW = Date.now();
const at = (min) => new Date(NOW - min * 60_000).toISOString();
const SVC = ["platform-api", "deployment-orchestrator", "platform-registry", "policy-engine", "drift-detector", "audit-ledger", "recovery-manager", "ai-kernel", "forge", "console", "home"].map((s) => `cryptophys-${s}`);
const STATUSES = ["executed", "shadow_passed", "shadow_blocked", "rejected", "failed", "pending_owner", "expired"];
const ACTIONS = ["deploy_commit", "observe_drift", "suspend_agent", "register_agent", "admit_voter", "rollback_worker_version"];
Object.assign(MOCK, {
  "/api/platform/v1/overview": { overview: { observed_at: at(1), agents_enabled: true,
    services: SVC.map((s, i) => ({ service_id: s, drifted: i === 3 || i === 9, persistent: i === 9, observed_at: at(i) })),
    open_agent_plans: [{ plan_id: "plan_00000000-0000-0000-0000-000000000000", service_id: SVC[9], status: "draft", created_at: at(40) }],
    agent_reports_24h: { counts: { critical: 1, warning: 4, info: 31 }, latest_attention: [
      { report_id: "r1", agent_id: "auditor", kind: "audit_digest", severity: "critical", subject: "Audit chain verified; 3 denied syscalls by platform-api in one hour, which is a long subject that wraps", created_at: at(30) },
      { report_id: "r2", agent_id: "supervisor", kind: "platform_digest", severity: "warning", subject: "Console drifts persistently", created_at: at(70) }] },
    xauusd_latest: { decision: "HOLD", confidence: 0.61, candle_key: "XAUUSD:60:2026-11-09T12:00", decided_at: at(20), reported_at: at(19) } } },
  "/api/kernel/v1/consensus": { mode: "deploy", stats_24h: { executed: 6, shadow_passed: 3, shadow_blocked: 2, rejected: 1, failed: 1, pending_owner: 1, expired: 1 },
    proposals: Array.from({ length: 60 }, (_, i) => ({ proposal_id: `cns_${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`, proposer_agent_id: "supervisor",
      action: ACTIONS[i % ACTIONS.length], target: i % 6 === 3 ? "forge-steward" : SVC[i % SVC.length], class: i % 6 === 4 ? "critical" : "routine",
      status: STATUSES[i % STATUSES.length], approvals: 6 + (i % 3), rejections: i % 3 === 2 ? 1 : 0, eligible: 8, passed: i % 7 < 3, policy_decision: i % 7 === 2 ? "deny" : "allow",
      created_at: at(i * 37), evidence: { policy_reason: i % 7 === 2 ? "failed: target_rate_limit" : "all policy checks passed" } })) },
  "/api/kernel/v1/agents": { agents_enabled: true, agents: [
    ...["supervisor", "signal-analyst", "auditor"].map((id) => ({ agent_id: id, display_name: id, host_worker: "cryptophys-ai-kernel", tier_max: id === "supervisor" ? 1 : 1, status: "enabled", capabilities: ["platform.observe", "reports.publish"] })),
    ...SVC.slice(0, 7).map((s) => ({ agent_id: s.replace("cryptophys-", ""), display_name: `${s} AI Agent`, host_worker: s, tier_max: 1, status: "enabled", capabilities: ["platform.observe", "memory.recall"] })),
    ...Array.from({ length: 21 }, (_, i) => ({ agent_id: `xauusd-agent-${i}`, display_name: `XAUUSD agent ${i}`, host_worker: i < 7 ? "xauusd-chain" : "xauusd-hud", tier_max: i % 5 === 0 ? 0 : 1, status: i === 4 ? "suspended" : "enabled", status_reason: i === 4 ? "5 failures in 1 h" : null, capabilities: ["signals.observe"] })),
  ] },
  "/api/kernel/v1/reports": { reports: Array.from({ length: 40 }, (_, i) => ({ report_id: `rep_${i}`, agent_id: ["auditor", "supervisor", "signal-analyst", "platform-api"][i % 4], kind: ["audit_digest", "platform_digest", "xauusd_digest", "platform_digest"][i % 4],
    severity: i % 13 === 0 ? "critical" : i % 4 === 1 ? "warning" : "info", subject: `Digest ${i}: everything nominal except a long sentence that must wrap inside the table cell`, ai_status: i % 5 ? "ok" : "unavailable",
    body: { decision: ["BUY", "SELL", "HOLD"][i % 3], confidence: 0.5 + (i % 5) / 10 }, created_at: at(i * 23) })) },
  "/api/audit/v1/events": { events: Array.from({ length: 120 }, (_, i) => ({ event_id: `evt_${i}`, event_type: ["consensus.tallied", "consensus.executed", "agent.syscall", "deployment.dispatched", "forge.check", "drift.observed", "policy.decided", "recovery.plan_created", "account.updated"][i % 9],
    actor: i % 4 ? "agent:supervisor" : "owner@example.com", subject: SVC[i % SVC.length], outcome: i % 11 ? "succeeded" : "failed", event_hash: "ab".repeat(32), created_at: at(i * 9) })) },
  "/api/policy/v1/decisions": { decisions: Array.from({ length: 80 }, (_, i) => ({ decision_id: `dec_${i}`, subject: "agent:supervisor", action: ["consensus.execute", "agent.syscall", "deploy", "registry.update"][i % 4],
    resource: `deploy_commit:${SVC[i % SVC.length]}`, decision: i % 6 ? "allow" : "deny", reason: i % 6 ? "all policy checks passed" : "failed: target_rate_limit, platform_daily_limit", created_at: at(i * 14) })) },
  "/api/registry/v1/services": { services: SVC.map((s, i) => ({ service_id: s, display_name: s.replace("cryptophys-", ""), status: i === 10 ? "disabled" : "healthy", desired_version: "7eaf570a4ed5" })) },
  "/api/drift/v1/drift": { services: SVC.slice(0, 10).map((s, i) => ({ service_id: s, status: i === 3 ? "degraded" : "healthy", drifted: i === 3 || i === 9, desired_version: "7eaf570a4ed5", observed_version: i === 3 ? "c5b73b4c3711" : "7eaf570a4ed5", observed_at: at(i * 3) })) },
  "/api/recovery/v1/plans": { plans: Array.from({ length: 14 }, (_, i) => ({ plan_id: `plan_${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`, service_id: SVC[i % 5], title: `Recover ${SVC[i % 5]} from version mismatch`, status: ["draft", "approved", "executing", "completed", "failed", "disabled"][i % 6], created_by: "agent:supervisor", created_at: at(i * 90), steps: [{}, {}] })) },
});
MOCK["/api/forge/v1/forge/checks"].checks.push(...Array.from({ length: 8 }, (_, i) => ({ commit: `${i}`.repeat(40), status: i === 5 ? "failed" : "passed", pass: 400 + i * 3, fail: i === 5 ? 2 : 0, duration_ms: 40000 + i * 1500, started_at: at(60 * (i + 2)), github: "success", agrees: i !== 5 })));

const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png" };

const server = http.createServer((req, res) => {
  let u = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (u === "/console") { res.writeHead(301, { location: "/console/" }); return res.end(); }
  if (!u.startsWith("/console/")) { res.writeHead(404); return res.end(); }
  u = u.slice("/console".length);
  if (u.startsWith("/api/")) {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(MOCK[u] ?? {}));
  }
  const file = path.join(dist, u === "/" ? "index.html" : u);
  if (!file.startsWith(dist) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.setHeader("content-type", TYPES[path.extname(file)] ?? "application/octet-stream");
  res.end(fs.readFileSync(file));
});

await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/console/`;
const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const problems = [];
if (/<script>|<script [^>]*>[^<]/.test(html)) problems.push("inline script in index.html");
const browser = await chromium.launch();
for (const width of [390, 1440]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.on("pageerror", (e) => problems.push(`${width}px page error: ${e.message}`));
  page.on("response", (r) => { if (r.status() >= 400) problems.push(`${width}px HTTP ${r.status()} ${r.url()}`); });
  for (const route of ROUTES) {
    await page.goto(`${base}#/${route}`);
    await page.waitForTimeout(700);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) problems.push(`${width}px #/${route}: horizontal scroll of ${overflow}px`);
    const text = await page.evaluate(() => document.body.innerText.length);
    if (text < 40) problems.push(`${width}px #/${route}: blank page`);
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${width}-${route.replace(/[^a-z0-9]+/gi, "_") || "home"}.png`), fullPage: true });
  }
  await page.close();
}
await browser.close();
server.close();
if (problems.length) {
  console.error(`Render smoke failed:\n- ${[...new Set(problems)].join("\n- ")}`);
  process.exit(1);
}
console.log(`Render smoke passed: ${ROUTES.length} screens x 2 widths under /console/.`);
