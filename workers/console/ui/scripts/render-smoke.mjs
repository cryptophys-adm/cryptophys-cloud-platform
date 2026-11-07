// Wave C: render every Console screen in Chromium, in CI, at phone and desktop widths, under
// the ADR-0010 /console/ mount, against an empty-but-valid mocked API. Fails on any page error,
// failed request, CSP-breaking inline script, or horizontal scroll. No credentials or network.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const ROUTES = ["", "agents", "agents/supervisor", "cognition", "consensus", "recovery", "recovery/plan_00000000-0000-0000-0000-000000000000",
  "infrastructure", "policy", "ledger", "pipelines", "markets", "users"];
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
