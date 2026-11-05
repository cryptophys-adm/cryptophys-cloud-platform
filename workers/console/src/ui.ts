// Static shell page of the Console (ADR-0008, TP-023). TP-024 builds the real screens on the
// shared api() helper. No dependency, no CDN, no inline script or style attribute; every value
// from the API is written with textContent, never innerHTML.

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cerebrum · Console</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>
<header>
<h1>Cerebrum · Console</h1>
<span id="actor" class="muted">…</span>
<span id="approver" class="badge" hidden>approver</span>
</header>
<main>
<section class="card" id="overview-card">
<h2>Platform overview</h2>
<p id="error" class="error" hidden></p>
<dl id="overview"></dl>
</section>
</main>
<script src="/assets/app.js"></script>
</body>
</html>
`;

export const APP_CSS = `body { margin: 0; font-family: system-ui, sans-serif; background: #0f1419; color: #e6e6e6; }
header { display: flex; align-items: center; gap: 12px; padding: 12px 20px; border-bottom: 1px solid #2a323c; }
h1 { font-size: 18px; margin: 0; flex: 1; }
h2 { font-size: 15px; margin: 0 0 8px; }
main { padding: 20px; }
.card { background: #171d24; border: 1px solid #2a323c; border-radius: 6px; padding: 14px; max-width: 720px; }
.muted { color: #8b96a3; }
.badge { background: #2d6a4f; color: #fff; border-radius: 10px; padding: 2px 8px; font-size: 12px; }
.error { color: #ff7b72; }
dt { color: #8b96a3; font-size: 12px; margin-top: 8px; }
dd { margin: 0; word-break: break-word; }
[hidden] { display: none; }
`;

export const APP_JS = `"use strict";
// Shared helper for every screen: same-origin call with the CSRF header; a non-2xx response
// becomes a visible error line and a rejected promise.
function showError(message) {
  var el = document.getElementById("error");
  el.textContent = message;
  el.hidden = false;
}

async function api(method, path, body) {
  var headers = { "x-cryptophys-console": "1" };
  var init = { method: method, headers: headers, credentials: "same-origin" };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  var res = await fetch(path, init);
  var data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    var code = data && data.error ? data.error : "error";
    var message = method + " " + path + ": " + res.status + " " + code;
    showError(message);
    throw new Error(message);
  }
  return data;
}

function addRow(list, label, value) {
  var dt = document.createElement("dt");
  dt.textContent = label;
  var dd = document.createElement("dd");
  dd.textContent = typeof value === "string" ? value : JSON.stringify(value);
  list.appendChild(dt);
  list.appendChild(dd);
}

async function main() {
  var who = await api("GET", "/api/whoami");
  document.getElementById("actor").textContent = who.actor;
  document.getElementById("approver").hidden = !who.approver;

  var body = await api("GET", "/api/platform/v1/overview");
  var o = (body && body.overview) || {};
  var list = document.getElementById("overview");
  var drift = o.drift;
  if (drift && typeof drift === "object" && !Array.isArray(drift) && Array.isArray(drift.services)) drift = drift.services;
  addRow(list, "Agents enabled", o.agents_enabled === undefined ? "unknown" : String(o.agents_enabled));
  addRow(list, "Drift count", Array.isArray(drift) ? String(drift.length) : (drift === undefined ? "unknown" : drift));
  addRow(list, "Agent reports (24h)", o.agent_reports_24h === undefined ? "none" : o.agent_reports_24h);
  if (o.xauusd_latest) addRow(list, "XAUUSD latest", o.xauusd_latest);
}

main().catch(function () { /* already shown by api() */ });
`;
