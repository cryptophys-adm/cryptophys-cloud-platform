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
    { commit: "3dbbead07e50e78fedd94db712f38a0f7eb0cdb4", status: "passed", runner: "forge-runner/1", files: 44, pass: 339, fail: 0, skip: 0, failures: [], started_at: "2026-11-08T09:34:00.000Z", finished_at: "2026-11-08T09:34:43.000Z", duration_ms: 43000, github: "success", agrees: true },
    { commit: "8588e21c0ffee0000000000000000000000000000", status: "failed", runner: "forge-runner/1", files: 43, pass: 321, fail: 1, skip: 0, failures: ["home-tp025.test.ts :: TP-025 Home Worker Wrangler dry-run bundle: child_process is not available in the Forge runner, which is a very long line that has to wrap on a phone"], started_at: "2026-11-08T09:19:49.000Z", finished_at: "2026-11-08T09:20:33.000Z", duration_ms: 43287, github: "success", agrees: false },
  ] },
  "/api/forge/v1/forge/commits": { commits: [{ sha: "3dbbead07e50e78fedd94db712f38a0f7eb0cdb4", title: "fix(forge): read Artifacts commit metadata defensively (#215)", author: "cryptophys-adm", date: "2026-11-08T05:18:00.000Z" }] },
  "/api/kernel/v1/notices": { email: "not_configured", notices: [
    { topic: "owner_attention", active: true, fingerprint: "f", title: "1 item(s) wait for your approval", link: "https://nexus.cryptophys.work/console/#/", lines: ["Recovery plan for Cerebrum Console (by agent:supervisor): review at https://nexus.cryptophys.work/console/#/recovery/plan_00000000-0000-4000-8000-000000000000"] },
    { topic: "drift", active: false, fingerprint: "", title: "All services are healthy", link: "https://nexus.cryptophys.work/console/#/infrastructure", lines: [] },
  ] },
  "/api/kernel/v1/knowledge": { counts: { pending: 1 }, proposals: [{ proposal_id: "knw_00000000-0000-4000-8000-000000000000", proposer_agent_id: "aether-curator", item_id: "k-prophet-trap", item_version: 1, kind: "caution", content_sha256: "0".repeat(64), status: "pending", decided_by: null, reason: null, created_at: "2026-11-07T12:00:00.000Z", decided_at: null, item: { text: "Its bearish lean was wrong in 11 of 14 such bars.", audience: { agents: ["prophet"], charts: ["60"] }, evidence: { bars: 14, wrong: 11 }, provenance: { card_ids: [] } } }] },
  "/api/kernel/v1/consensus/report": { window_days: 7, total: 0, scored: 0, agree: 0, false_positive: 0, false_negative: 0, pending: 0, agreement_rate: null, by_action: {}, items: [] },
};
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
