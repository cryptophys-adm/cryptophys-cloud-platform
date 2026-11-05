import { UI_ROUTES } from "./routes.ts";

// Client JavaScript of the Console (TP-024). Plain JS, no framework. Rules the tests check:
// the route table is embedded once, every API call goes through call(), the single network
// call site is inside api(), and data is written only with textContent.
export const APP_JS = String.raw`"use strict";
var UI_ROUTES = ${JSON.stringify(UI_ROUTES)};
var ROUTES = {};
UI_ROUTES.forEach(function (r) { ROUTES[r.id] = r; });
var SAFE = /^[A-Za-z0-9._@+:-]{1,128}$/;
var KERNEL_AGENTS = ["supervisor", "signal-analyst", "auditor"];
var KERNEL_HOST = "cryptophys-ai-kernel";
var REFRESH_MS = 60000;
var OBSERVE_LOCK_MS = 30000;
var who = { actor: "", approver: false };
var renderId = 0;
var missionBox = null;
var lastVerify = null;
var loadedEvents = [];

// ---------------------------------------------------------------- DOM helpers

function $(id) { return document.getElementById(id); }
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

var PLAIN_PROPS = ["value", "checked", "disabled", "hidden", "href", "download", "target", "rel", "type", "id", "name", "rows", "min", "max", "maxLength", "title", "colSpan", "autocomplete"];
var EVENT_PROPS = ["click", "change", "input", "keydown"];

function el(tag, props, children) {
  var node = document.createElement(tag);
  var p = props || {};
  Object.keys(p).forEach(function (k) {
    var v = p[k];
    if (v === undefined || v === null || v === false) return;
    if (k === "text") node.textContent = String(v);
    else if (k === "class") node.className = String(v);
    else if (k === "for") node.htmlFor = String(v);
    else if (EVENT_PROPS.indexOf(k) >= 0) node.addEventListener(k, v);
    else if (PLAIN_PROPS.indexOf(k) >= 0) node[k] = v;
    else if (k === "role" || k.indexOf("aria-") === 0) node.setAttribute(k, String(v));
  });
  (children || []).forEach(function (c) {
    if (c === undefined || c === null || c === false) return;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return node;
}

function fmt(v) {
  if (v === undefined || v === null) return "none";
  return typeof v === "string" ? v : JSON.stringify(v);
}
function pretty(v) {
  var data = v;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch (e) { return data; } }
  return JSON.stringify(data, null, 2);
}
function pick(row, keys) {
  for (var i = 0; i < keys.length; i++) if (row && row[keys[i]] !== undefined && row[keys[i]] !== null) return row[keys[i]];
  return undefined;
}
function list(body, key) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== "object") return [];
  if (Array.isArray(body[key])) return body[key];
  var keys = Object.keys(body), i, j;
  for (i = 0; i < keys.length; i++) if (Array.isArray(body[keys[i]])) return body[keys[i]];
  for (i = 0; i < keys.length; i++) {
    var inner = body[keys[i]];
    if (inner && typeof inner === "object") {
      var innerKeys = Object.keys(inner);
      for (j = 0; j < innerKeys.length; j++) if (Array.isArray(inner[innerKeys[j]])) return inner[innerKeys[j]];
    }
  }
  return [];
}

function addRow(dl, label, value) {
  dl.appendChild(el("dt", { text: label }));
  dl.appendChild(el("dd", { text: fmt(value) }));
}
function field(label, control, extra) {
  return el("label", { class: "field" + (extra ? " " + extra : "") }, [el("span", { text: label }), control]);
}
function button(text, onClick, extra) {
  return el("button", { type: "button", text: text, click: onClick, class: extra || "" });
}
function select(options, current) {
  var node = el("select", {}, options.map(function (o) { return el("option", { text: o === "" ? "(any)" : o, value: o }); }));
  if (current !== undefined) node.value = current;
  return node;
}
function table(headers, rows) {
  var head = el("tr", {}, headers.map(function (h) { return el("th", { text: h }); }));
  var body = rows.map(function (cells) {
    return el("tr", {}, cells.map(function (c) { return el("td", {}, [typeof c === "string" ? document.createTextNode(c) : c]); }));
  });
  return el("div", { class: "scroll" }, [el("table", {}, [el("thead", {}, [head]), el("tbody", {}, body)])]);
}
function genericTable(rows) {
  if (!rows.length) return el("p", { class: "muted", text: "No rows." });
  var keys = Object.keys(rows[0] || {}).slice(0, 7);
  return table(keys, rows.map(function (row) {
    return keys.map(function (k) { var v = row[k]; return typeof v === "string" ? v : fmt(v); });
  }));
}
function pre(value) { return el("pre", { text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }); }

// ---------------------------------------------------------------- messages

function showError(message) {
  $("banner-text").textContent = message;
  $("banner").hidden = false;
}
function notice(message) {
  var n = $("notice");
  n.textContent = message;
  n.hidden = false;
}
function resetMessages() { $("banner").hidden = true; $("notice").hidden = true; }

// ---------------------------------------------------------------- API

// Shared helper for every screen: same-origin call with the CSRF header; a non-2xx response
// becomes a visible error banner and a rejected promise.
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
    if (data && typeof data.message === "string" && data.message) message += " (" + data.message + ")";
    showError(message);
    var failure = new Error(message);
    failure.status = res.status;
    failure.data = data;
    throw failure;
  }
  return data;
}

// The only way the screens reach the API: a route id from UI_ROUTES, the values for its
// {id} segments in order, an optional JSON body and an optional query object (GET only).
async function call(routeId, params, body, query) {
  var route = ROUTES[routeId];
  if (!route) { showError("Unknown route " + routeId); throw new Error("unknown route"); }
  var values = Array.isArray(params) ? params.slice() : (params === undefined || params === null ? [] : [params]);
  var bad = false;
  var path = route.path.replace(/[{]id[}]/g, function () {
    var v = values.shift();
    if (v === undefined || !SAFE.test(String(v))) { bad = true; return "x"; }
    return String(v);
  });
  if (bad || values.length) { showError("Refused: " + routeId + " needs safe identifiers (A-Z a-z 0-9 . _ @ + : -, up to 128)."); throw new Error("invalid identifier"); }
  if (query && route.method === "GET") {
    var sp = new URLSearchParams();
    Object.keys(query).forEach(function (k) { if (query[k] !== undefined && query[k] !== "") sp.set(k, String(query[k])); });
    var qs = sp.toString();
    if (qs) path += "?" + qs;
  }
  return api(route.method, "/api/" + route.service + path, body);
}

// ---------------------------------------------------------------- confirmation modal

function phraseFor(route, params, body) {
  if (!route.confirm) return null;
  var first = Array.isArray(params) ? params[0] : params;
  var id = first === undefined ? "" : String(first);
  var sha = body && typeof body.commit_sha === "string" ? body.commit_sha : "";
  return route.confirm.split("{id13}").join(id.slice(0, 13)).split("{id}").join(id).split("{sha12}").join(sha.slice(0, 12));
}

function confirmModal(o) {
  var previous = document.activeElement;
  var input = el("input", { type: "text", id: "confirm-input", autocomplete: "off" });
  var ok = el("button", { type: "button", text: "Confirm", class: "danger", disabled: true });
  var overlay = el("div", { class: "overlay" });
  function close() {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (previous && previous.focus) previous.focus();
  }
  input.addEventListener("input", function () { ok.disabled = input.value !== o.phrase; });
  ok.addEventListener("click", function () { if (input.value === o.phrase) { close(); o.run(); } });
  overlay.addEventListener("keydown", function (ev) { if (ev.key === "Escape") close(); });
  var modal = el("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-labelledby": "confirm-title" }, [
    el("h2", { id: "confirm-title", text: o.title }),
  ].concat((o.lines || []).map(function (l) { return el("p", { text: l }); })).concat([
    el("p", {}, ["Type ", el("span", { class: "phrase", text: o.phrase }), " to continue."]),
    field("Confirmation phrase", input),
    el("div", { class: "row" }, [ok, button("Cancel", close)]),
  ]));
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  input.focus();
}

// act(): one state-changing click. Routes with a confirm phrase open the modal first.
function act(o) {
  var route = ROUTES[o.route];
  var phrase = phraseFor(route, o.params, o.body);
  function go() {
    return call(o.route, o.params, o.body, o.query).then(function (data) {
      notice(o.done || "Done.");
      if (o.after) return o.after(data);
    }).catch(function (e) { if (o.onError) o.onError(e); });
  }
  if (phrase === null) return go();
  confirmModal({ title: o.title, lines: o.lines, phrase: phrase, run: go });
}

function rerender() { return route(); }

// ---------------------------------------------------------------- screens

function startView(title) {
  var v = $("view");
  clear(v);
  v.appendChild(el("h2", { text: title }));
  return v;
}
function stale(tok) { return tok !== renderId; }
function card(title, nodes) { return el("section", { class: "card" }, [title ? el("h3", { text: title }) : null].concat(nodes || [])); }

// ---- Mission Control

async function fillOverview(box, tok) {
  var body = await call("platform.overview");
  if (stale(tok)) return;
  var o = (body && body.overview) || body || {};
  var dl = el("dl");
  addRow(dl, "Agents enabled (kill switch)", o.agents_enabled === undefined ? "unknown" : String(o.agents_enabled));

  var services = Array.isArray(o.services) ? o.services : null;
  var drifted = services === null ? null : services.filter(function (s) { return s && s.drifted === true; });
  if (drifted === null) addRow(dl, "Drift", "unknown");
  else {
    addRow(dl, "Drift", drifted.length + " drifted");
    if (drifted.length) addRow(dl, "Drifted services", drifted.map(function (s) {
      return fmt(s.service_id) + (s.persistent === true ? " (persistent)" : "");
    }).join(", "));
  }

  var reports = o.agent_reports_24h;
  var latestCritical = [];
  if (reports && typeof reports === "object" && !reports.error) {
    var counts = reports.counts && typeof reports.counts === "object" ? reports.counts : {};
    addRow(dl, "Agent reports (24h)", counts);
    latestCritical = Array.isArray(reports.latest_critical) ? reports.latest_critical : [];
    addRow(dl, "Latest critical reports", latestCritical.length);
  } else if (reports && reports.error) {
    addRow(dl, "Agent reports (24h)", "unavailable");
    addRow(dl, "Latest critical reports", "unavailable");
  } else {
    addRow(dl, "Agent reports (24h)", "unknown");
    addRow(dl, "Latest critical reports", "unknown");
  }

  var plans = Array.isArray(o.open_agent_plans) ? o.open_agent_plans : null;
  addRow(dl, "Open recovery proposals", plans === null ? "unknown" : plans.length);

  var x = o.xauusd_latest;
  if (x && typeof x === "object" && x.error) addRow(dl, "XAUUSD latest (display only)", "unavailable");
  else if (x && typeof x === "object") {
    addRow(dl, "XAUUSD decision (display only)", x.decision);
    addRow(dl, "XAUUSD confidence (display only)", x.confidence);
    addRow(dl, "XAUUSD candle (display only)", x.candle_key);
    addRow(dl, "XAUUSD decided at (display only)", x.decided_at);
  } else addRow(dl, "XAUUSD latest (display only)", x === null ? "none" : "unavailable");

  clear(box);
  box.appendChild(dl);

  if (reports && typeof reports === "object" && !reports.error) {
    var criticalRows = latestCritical.map(function (r) {
      return [fmt(r.agent_id), fmt(r.kind), fmt(pick(r, ["created_at", "time"]))];
    });
    box.appendChild(card("Latest critical reports", [criticalRows.length
      ? table(["Agent", "Kind", "Time"], criticalRows)
      : el("p", { class: "muted", text: "No recent critical reports." })]));
  }

  if (plans && plans.length) {
    var planLinks = el("ul");
    plans.forEach(function (plan) {
      var id = String(plan && plan.plan_id || "");
      var label = [id, plan && plan.service_id, plan && plan.status].filter(Boolean).join(" · ");
      if (SAFE.test(id)) planLinks.appendChild(el("li", {}, [el("a", { href: "#/recovery/" + id, text: label })]));
      else planLinks.appendChild(el("li", { text: label || "Invalid plan identifier" }));
    });
    box.appendChild(card("Open recovery proposals", [planLinks]));
  }
}

async function mission(tok) {
  var v = startView("Mission Control");
  var box = el("div");
  var ai = el("div");
  missionBox = { box: box, tok: tok };
  var summary = button("AI summary", function () {
    call("platform.overview", undefined, undefined, { advisory: "true" }).then(function (data) {
      clear(ai);
      ai.appendChild(pre(data));
    }).catch(function () {});
  });
  v.appendChild(card("Platform overview", [box, el("div", { class: "row" }, [summary]), ai]));
  var killNodes = [button("Agents OFF", function () {
    act({ route: "kernel.agents_disabled", body: { enabled: false }, title: "Turn all agents off", lines: ["Sets the kill switch: no agent will act until agents are turned on again."], done: "Agents are OFF.", after: rerender });
  }, "danger")];
  if (who.approver) killNodes.push(button("Agents ON", function () {
    act({ route: "kernel.agents_enabled", body: { enabled: true }, title: "Turn agents on", lines: ["Lets enabled agents act again."], done: "Agents are ON.", after: rerender });
  }));
  v.appendChild(card("Kill switch", [el("div", { class: "row" }, killNodes)]));
  await fillOverview(box, tok);
}

function refreshMission() {
  if (document.visibilityState !== "visible" || !missionBox || stale(missionBox.tok)) return;
  fillOverview(missionBox.box, missionBox.tok).catch(function () {});
}

// ---- Agents

async function agentsScreen(tok) {
  var v = startView("Agents");
  var body = await call("kernel.agents");
  if (stale(tok)) return;
  var agents = list(body, "agents");
  var hosts = [""];
  agents.forEach(function (a) { var h = a && a.host_worker; if (h && hosts.indexOf(h) < 0) hosts.push(h); });
  var filter = select(hosts);
  var out = el("div");
  function draw() {
    clear(out);
    var rows = agents.filter(function (a) { return !filter.value || (a && a.host_worker === filter.value); });
    out.appendChild(table(["agent_id", "display_name", "host_worker", "tier_max", "status", "status_reason"], rows.map(function (a) {
      return [el("a", { href: "#/agents/" + fmt(a.agent_id), text: fmt(a.agent_id) }), fmt(a.display_name), fmt(a.host_worker), fmt(a.tier_max), fmt(a.status), fmt(a.status_reason)];
    })));
  }
  filter.addEventListener("change", draw);
  v.appendChild(el("div", { class: "row" }, [field("Host worker", filter)]));
  v.appendChild(out);
  draw();
}

async function agentDetail(id, tok) {
  var v = startView("Agent " + id);
  v.appendChild(el("p", {}, [el("a", { href: "#/agents", text: "← All agents" })]));
  var results = await Promise.all([call("kernel.agent", id), call("kernel.agent_actions", id, undefined, { limit: "50" })]);
  if (stale(tok)) return;
  var agent = (results[0] && results[0].agent) || results[0] || {};
  var actions = list(results[1], "actions");
  var dl = el("dl");
  Object.keys(agent).forEach(function (k) { addRow(dl, k, agent[k]); });
  v.appendChild(card("Detail", [dl]));

  var reason = el("input", { type: "text", id: "suspend-reason", maxLength: 200 });
  var buttons = [];
  v.appendChild(card("Suspend", [el("div", { class: "row" }, [field("Reason (1–200 characters)", reason), button("Suspend…", function () {
    var text = reason.value.trim();
    if (text.length < 1 || text.length > 200) { showError("Reason must be 1 to 200 characters."); return; }
    act({ route: "kernel.suspend", params: id, body: { reason: text }, title: "Suspend " + id, lines: ["The agent stops acting until it is resumed by an approver.", "Reason: " + text], done: "Suspended " + id + ".", after: rerender });
  }, "danger")])]));
  if (who.approver) buttons.push(button("Resume…", function () {
    act({ route: "kernel.resume", params: id, title: "Resume " + id, lines: ["The agent may act again."], done: "Resumed " + id + ".", after: rerender });
  }));
  if (KERNEL_AGENTS.indexOf(id) >= 0) buttons.push(button("Wake…", function () {
    act({ route: "kernel.wake", params: id, title: "Wake " + id, lines: ["Runs one cycle of this agent now."], done: "Woke " + id + ".", after: rerender });
  }));
  if (buttons.length) v.appendChild(card("Actions", [el("div", { class: "row" }, buttons)]));

  if (who.approver && agent.host_worker !== KERNEL_HOST) {
    var identity = el("input", { type: "text", id: "principal-add", maxLength: 200 });
    var revoke = el("input", { type: "text", id: "principal-remove", maxLength: 200 });
    var known = Array.isArray(agent.principals) ? "Known principals: " + agent.principals.map(fmt).join(", ") : "";
    v.appendChild(card("External principals", [
      known ? el("p", { class: "muted", text: known }) : null,
      el("div", { class: "row" }, [field("Access email or service-token Client ID", identity), button("Add principal…", function () {
        var value = identity.value.trim();
        if (!value || value.length > 200) { showError("Enter an Access identity (up to 200 characters)."); return; }
        act({ route: "kernel.principal_add", params: id, body: { access_identity: value }, title: "Add principal to " + id, lines: ["This identity may act as " + id + " through MCP.", value], done: "Principal added.", after: rerender });
      }, "danger")]),
      el("div", { class: "row" }, [field("Principal to revoke", revoke), button("Remove principal…", function () {
        var value = revoke.value.trim();
        act({ route: "kernel.principal_remove", params: [id, value], title: "Revoke principal of " + id, lines: ["This identity can no longer act as " + id + ".", value], done: "Principal removed.", after: rerender });
      }, "danger")]),
    ]));
  }
  v.appendChild(card("Last 50 actions", [genericTable(actions)]));
}

// ---- Reports

async function reportsScreen(tok) {
  var v = startView("Reports");
  var agent = el("input", { type: "text", id: "rep-agent" });
  var kind = select(["", "signal_digest", "audit_digest", "platform_digest", "xauusd_digest", "hud_digest"]);
  var limit = el("input", { type: "number", id: "rep-limit", min: 1, max: 100, value: "20" });
  var out = el("div");
  async function load() {
    var n = Math.max(1, Math.min(100, parseInt(limit.value, 10) || 20));
    var body = await call("kernel.reports", undefined, undefined, { agent_id: agent.value.trim(), kind: kind.value, limit: String(n) });
    if (stale(tok)) return;
    clear(out);
    var rows = list(body, "reports");
    if (!rows.length) { out.appendChild(el("p", { class: "muted", text: "No reports." })); return; }
    var bodyRows = rows.map(function (r) {
      var detail = el("pre", { text: pretty(pick(r, ["body", "payload"]) === undefined ? r : pick(r, ["body", "payload"])), hidden: true });
      var toggle = button("Show", function () { detail.hidden = !detail.hidden; toggle.textContent = detail.hidden ? "Show" : "Hide"; });
      return [fmt(r.severity), fmt(r.kind), fmt(r.agent_id), el("span", {}, [fmt(r.subject), detail]), fmt(pick(r, ["created_at", "time"])), fmt(r.ai_status), toggle];
    });
    out.appendChild(table(["severity", "kind", "agent", "subject", "time", "ai_status", ""], bodyRows));
  }
  v.appendChild(el("div", { class: "row" }, [field("Agent id", agent), field("Kind", kind), field("Limit (1–100)", limit), button("Load", function () { load().catch(function () {}); })]));
  v.appendChild(out);
  await load();
}

// ---- Recovery

var PLAN_ACTIONS = ["rollback_worker_version", "redeploy_commit", "disable_service", "restore_d1_bookmark", "rotate_secret", "manual"];

async function recoveryScreen(tok) {
  var v = startView("Recovery");
  var status = el("input", { type: "text", id: "plan-status" });
  var out = el("div");
  async function load() {
    var body = await call("recovery.plans", undefined, undefined, { status: status.value.trim() });
    if (stale(tok)) return;
    clear(out);
    var plans = list(body, "plans");
    out.appendChild(plans.length ? table(["plan_id", "service_id", "title", "status", "created_by", "created_at"], plans.map(function (p) {
      return [el("a", { href: "#/recovery/" + fmt(p.plan_id), text: fmt(p.plan_id) }), fmt(p.service_id), fmt(p.title), fmt(p.status), fmt(p.created_by), fmt(p.created_at)];
    })) : el("p", { class: "muted", text: "No plans." }));
  }
  v.appendChild(el("div", { class: "row" }, [field("Status", status), button("Filter", function () { load().catch(function () {}); })]));
  v.appendChild(out);
  var servicesBody = await call("registry.services");
  if (stale(tok)) return;
  v.appendChild(createPlanCard(list(servicesBody, "services")));
  await load();
}

function createPlanCard(services) {
  var svc = el("select", { id: "plan-service" }, services.map(function (s) { var id = fmt(pick(s, ["service_id", "id"])); return el("option", { text: id, value: id }); }));
  var version = el("input", { type: "text", id: "plan-version", maxLength: 40, value: "1" });
  var title = el("input", { type: "text", id: "plan-title", maxLength: 160 });
  var rationale = el("textarea", { id: "plan-rationale", maxLength: 2000 });
  var stepBox = el("div");
  var steps = [];
  function addStep() {
    var s = { action: select(PLAN_ACTIONS, "manual"), description: el("input", { type: "text", maxLength: 500 }) };
    var row = el("div", { class: "row" }, [field("Step action", s.action), field("Step description (1–500)", s.description)]);
    row.appendChild(button("Remove step", function () {
      if (steps.length <= 1) return;
      steps.splice(steps.indexOf(s), 1);
      stepBox.removeChild(row);
    }));
    steps.push(s);
    stepBox.appendChild(row);
  }
  addStep();
  var submit = button("Create plan…", function () {
    var body = { service_id: svc.value, plan_version: version.value.trim(), title: title.value.trim(), rationale: rationale.value.trim(), steps: [] };
    if (!body.service_id || !body.plan_version || body.plan_version.length > 40) { showError("Choose a service and a plan version (up to 40 characters)."); return; }
    if (!body.title || body.title.length > 160) { showError("Title must be 1 to 160 characters."); return; }
    if (body.rationale.length > 2000) { showError("Rationale is limited to 2000 characters."); return; }
    for (var i = 0; i < steps.length; i++) {
      var d = steps[i].description.value.trim();
      if (!d || d.length > 500) { showError("Every step needs a description of 1 to 500 characters."); return; }
      body.steps.push({ action: steps[i].action.value, description: d });
    }
    if (body.steps.length < 1 || body.steps.length > 20) { showError("A plan has 1 to 20 steps."); return; }
    act({ route: "recovery.create", body: body, title: "Create recovery plan", lines: ["Creates a draft plan for " + body.service_id + ": " + body.title, "It runs nothing until it is approved and started."], done: "Plan created.", after: rerender });
  });
  return card("Create plan", [
    el("div", { class: "row" }, [field("Service", svc), field("Plan version", version), field("Title", title)]),
    field("Rationale", rationale), stepBox,
    el("div", { class: "row" }, [button("Add step", function () { if (steps.length < 20) addStep(); }), submit]),
  ]);
}

async function recoveryDetail(id, tok) {
  var v = startView("Recovery plan");
  v.appendChild(el("p", {}, [el("a", { href: "#/recovery", text: "← All plans" })]));
  var body = await call("recovery.plan", id);
  if (stale(tok)) return;
  var plan = (body && body.plan) || body || {};
  var pid = plan.plan_id ? String(plan.plan_id) : id;
  var status = plan.status;
  var dl = el("dl");
  Object.keys(plan).forEach(function (k) { if (k !== "steps") addRow(dl, k, plan[k]); });
  var detail = [dl];
  var steps = Array.isArray(plan.steps) ? plan.steps : null;
  if (steps) detail.push(el("ol", {}, steps.map(function (s) { return el("li", { text: fmt(s && s.action) + ": " + fmt(s && s.description) }); })));
  else if (plan.steps !== undefined) detail.push(pre(plan.steps));
  v.appendChild(card("Plan " + pid, detail));
  if (typeof plan.created_by === "string" && plan.created_by.indexOf("agent:") === 0) {
    v.appendChild(el("p", { class: "warn", text: "Proposed by an agent; check it before approving." }));
  }
  var nodes = [];
  if (status === "draft" && who.approver && plan.created_by !== who.actor) nodes.push(button("Approve…", function () {
    act({ route: "recovery.approve", params: pid, title: "Approve plan " + pid, lines: ["Approval is recorded under your identity. You cannot approve a plan you authored."], done: "Plan approved.", after: rerender });
  }));
  if (status !== "executing") nodes.push(button("Disable…", function () {
    act({ route: "recovery.disable", params: pid, title: "Disable plan " + pid, lines: ["The plan can no longer be approved or executed."], done: "Plan disabled.", after: rerender });
  }, "danger"));
  if (nodes.length) v.appendChild(card("Actions", [el("div", { class: "row" }, nodes)]));
  if (status === "approved") {
    var ack = el("input", { type: "checkbox", id: "start-ack" });
    var startNotes = el("textarea", { id: "start-notes", maxLength: 2000 });
    v.appendChild(card("Start execution", [
      field("I have read the steps", ack, "check"), field("Notes (optional, up to 2000)", startNotes),
      el("div", { class: "row" }, [button("Start execution…", function () {
        if (!ack.checked) { showError("Tick “I have read the steps” first."); return; }
        var notes = startNotes.value.trim();
        if (notes.length > 2000) { showError("Notes are limited to 2000 characters."); return; }
        var b = { phase: "start", operator_acknowledged: true };
        if (notes) b.notes = notes;
        act({ route: "recovery.execute_start", params: pid, body: b, title: "Start plan " + pid, lines: ["Marks the plan as executing. You carry out the steps; nothing runs automatically."], done: "Execution started.", after: rerender });
      })]),
    ]));
  }
  if (status === "executing") {
    var outcome = select(["completed", "failed"], "completed");
    var finishNotes = el("textarea", { id: "finish-notes", maxLength: 2000 });
    v.appendChild(card("Finish execution", [
      field("Outcome", outcome), field("Notes (optional, up to 2000)", finishNotes),
      el("div", { class: "row" }, [button("Finish execution…", function () {
        var notes = finishNotes.value.trim();
        if (notes.length > 2000) { showError("Notes are limited to 2000 characters."); return; }
        var b = { phase: "finish", outcome: outcome.value };
        if (notes) b.notes = notes;
        act({ route: "recovery.execute_finish", params: pid, body: b, title: "Finish plan " + pid, lines: ["Records the outcome: " + outcome.value + "."], done: "Execution finished.", after: rerender });
      })]),
    ]));
  }
}

// ---- Services & Drift

async function servicesScreen(tok) {
  var v = startView("Services & Drift");
  var observe = button("Observe now", function () {
    observe.disabled = true;
    setTimeout(function () { observe.disabled = false; }, OBSERVE_LOCK_MS);
    act({ route: "drift.observe", body: {}, done: "Observation requested.", after: load });
  });
  v.appendChild(el("div", { class: "row" }, [observe]));
  var out = el("div");
  var editor = el("div");
  v.appendChild(out);
  v.appendChild(editor);
  async function load() {
    var results = await Promise.all([call("registry.services"), call("drift.list")]);
    if (stale(tok)) return;
    var drifts = {};
    list(results[1], "drift").forEach(function (d) { var k = pick(d, ["service_id", "id", "service"]); if (k !== undefined) drifts[k] = d; });
    clear(out);
    out.appendChild(table(["service", "status", "desired", "observed", "drifted", "last observed", ""], list(results[0], "services").map(function (s) {
      var id = String(pick(s, ["service_id", "id"]));
      var d = drifts[id] || {};
      return [fmt(pick(s, ["display_name", "name"]) || id), fmt(s.status), fmt(pick(d, ["desired_version"]) !== undefined ? d.desired_version : s.desired_version),
        fmt(pick(d, ["observed_version"])), d.drifted === undefined ? "none" : String(d.drifted), fmt(pick(d, ["observed_at", "last_observed_at", "created_at"])),
        button("Edit " + id, function () { editService(id).catch(function () {}); })];
    })));
  }
  async function editService(id) {
    var body = await call("registry.service", id);
    if (stale(tok)) return;
    var s = (body && body.service) || body || {};
    var meta = s.metadata && typeof s.metadata === "object" && !Array.isArray(s.metadata) ? s.metadata : {};
    var name = el("input", { type: "text", id: "svc-name", maxLength: 120, value: fmt(s.display_name === undefined ? "" : s.display_name) });
    var env = select(["development", "preview", "production"], s.environment || "production");
    var st = select(["registered", "healthy", "degraded", "unavailable", "disabled"], s.status || "registered");
    var endpoint = el("input", { type: "text", id: "svc-endpoint", value: s.endpoint ? String(s.endpoint) : "" });
    var owner = el("input", { type: "text", id: "svc-owner", value: fmt(meta.owner === undefined ? "" : meta.owner) });
    var purpose = el("input", { type: "text", id: "svc-purpose", value: fmt(meta.purpose === undefined ? "" : meta.purpose) });
    var cls = select(["public", "internal", "confidential", "restricted"], meta.data_classification || "internal");
    var version = el("input", { type: "text", id: "svc-version", maxLength: 40 });
    clear(editor);
    editor.appendChild(card("Edit " + id, [
      el("div", { class: "row" }, [field("Display name", name), field("Environment", env), field("Status", st)]),
      el("div", { class: "row" }, [field("Endpoint (https, optional)", endpoint), field("Owner", owner), field("Purpose", purpose), field("Data classification", cls)]),
      el("div", { class: "row" }, [button("Update service…", function () {
        var m = {};
        Object.keys(meta).forEach(function (k) { m[k] = meta[k]; });
        m.owner = owner.value.trim(); m.purpose = purpose.value.trim(); m.data_classification = cls.value;
        var b = { display_name: name.value.trim(), environment: env.value, status: st.value, metadata: m };
        var ep = endpoint.value.trim();
        if (ep) {
          if (ep.indexOf("https://") !== 0) { showError("Endpoint must be an https URL."); return; }
          b.endpoint = ep;
        }
        if (!b.display_name || b.display_name.length > 120) { showError("Display name must be 1 to 120 characters."); return; }
        act({ route: "registry.upsert", params: id, body: b, title: "Update service " + id, lines: ["Replaces the registry record of " + id + "."], done: "Service updated.", after: load });
      })]),
      el("div", { class: "row" }, [field("Desired version (7–40 hex)", version), button("Set desired version…", function () {
        var sha = version.value.trim();
        if (!/^[0-9a-fA-F]{7,40}$/.test(sha)) { showError("Desired version must be 7 to 40 hex characters."); return; }
        act({ route: "registry.desired_version", params: id, body: { desired_version: sha }, title: "Set desired version of " + id, lines: ["Drift is measured against this version: " + sha], done: "Desired version set.", after: load });
      })]),
    ]));
  }
  await load();
}

// ---- Policy

async function policyScreen(tok) {
  var v = startView("Policy");
  var limit = el("input", { type: "number", id: "pol-limit", min: 1, max: 100, value: "20" });
  var out = el("div");
  var detail = el("div");
  async function load() {
    var n = Math.max(1, Math.min(100, parseInt(limit.value, 10) || 20));
    var body = await call("policy.decisions", undefined, undefined, { limit: String(n) });
    if (stale(tok)) return;
    clear(out);
    var rows = list(body, "decisions");
    var keys = rows.length ? Object.keys(rows[0]).filter(function (k) { return typeof rows[0][k] !== "object"; }).slice(0, 6) : [];
    out.appendChild(rows.length ? table(keys.concat([""]), rows.map(function (r) {
      var id = String(pick(r, ["decision_id", "id"]));
      return keys.map(function (k) { return fmt(r[k]); }).concat([button("View", function () {
        call("policy.decision", id).then(function (d) { clear(detail); detail.appendChild(card("Decision " + id, [pre(d)])); }).catch(function () {});
      })]);
    })) : el("p", { class: "muted", text: "No decisions." }));
  }
  v.appendChild(el("div", { class: "row" }, [field("Limit (1–100)", limit), button("Load", function () { load().catch(function () {}); })]));
  v.appendChild(out);
  v.appendChild(detail);
  var action = el("input", { type: "text", id: "eval-action" });
  var resource = el("input", { type: "text", id: "eval-resource" });
  var context = el("textarea", { id: "eval-context", value: "{}" });
  var result = el("div");
  v.appendChild(card("Evaluate", [
    el("p", { class: "muted", text: "Evaluation only records a decision. It changes nothing." }),
    el("div", { class: "row" }, [field("Action", action), field("Resource", resource)]),
    field("Context (JSON object)", context),
    el("div", { class: "row" }, [button("Evaluate", function () {
      var ctx;
      try { ctx = JSON.parse(context.value); } catch (e) { showError("Context is not valid JSON."); return; }
      if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) { showError("Context must be a JSON object."); return; }
      if (!action.value.trim() || !resource.value.trim()) { showError("Action and resource are required."); return; }
      act({ route: "policy.evaluate", body: { action: action.value.trim(), resource: resource.value.trim(), context: ctx }, done: "Evaluated.", after: function (d) { clear(result); result.appendChild(pre(d)); return load(); } });
    })]),
    result,
  ]));
  await load();
}

// ---- Audit

async function auditScreen(tok) {
  var v = startView("Audit");
  var limit = el("input", { type: "number", id: "aud-limit", min: 1, max: 100, value: "20" });
  var type = el("input", { type: "text", id: "aud-type" });
  var subject = el("input", { type: "text", id: "aud-subject" });
  var out = el("div");
  var detail = el("div");
  var verifyBox = el("div");
  async function load() {
    var n = Math.max(1, Math.min(100, parseInt(limit.value, 10) || 20));
    var body = await call("audit.events", undefined, undefined, { limit: String(n), event_type: type.value.trim(), subject: subject.value.trim() });
    if (stale(tok)) return;
    clear(out);
    var rows = list(body, "events");
    loadedEvents = rows;
    var keys = rows.length ? Object.keys(rows[0]).filter(function (k) { return typeof rows[0][k] !== "object"; }).slice(0, 6) : [];
    out.appendChild(rows.length ? table(keys.concat([""]), rows.map(function (r) {
      var id = String(pick(r, ["event_id", "id"]));
      return keys.map(function (k) { return fmt(r[k]); }).concat([button("View", function () {
        call("audit.event", id).then(function (d) { clear(detail); detail.appendChild(card("Event " + id, [pre(d)])); }).catch(function () {});
      })]);
    })) : el("p", { class: "muted", text: "No events." }));
  }
  v.appendChild(el("div", { class: "row" }, [field("Limit (1–100)", limit), field("Event type", type), field("Subject", subject), button("Load", function () { load().catch(function () {}); })]));
  v.appendChild(out);
  v.appendChild(detail);
  v.appendChild(card("Chain", [el("div", { class: "row" }, [
    button("Verify chain", function () {
      call("audit.verify").then(function (d) {
        lastVerify = d;
        clear(verifyBox);
        var r = (d && d.verification) || d || {};
        var dl = el("dl");
        addRow(dl, "valid", r.valid);
        addRow(dl, "events_checked", r.events_checked);
        if (r.first_invalid_event_id !== undefined && r.first_invalid_event_id !== null) addRow(dl, "first_invalid_event_id", r.first_invalid_event_id);
        verifyBox.appendChild(dl);
      }).catch(function () {});
    }),
    button("Export JSON", function () {
      var blob = new Blob([JSON.stringify({ events: loadedEvents, verify: lastVerify }, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var a = el("a", { href: url, download: "console-audit-export.json" });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 0);
    }),
  ]), verifyBox]));
  await load();
}

// ---- Deploy

function deployScreen() {
  var v = startView("Deploy");
  var sha = el("input", { type: "text", id: "deploy-sha", maxLength: 40 });
  var out = el("div");
  v.appendChild(card("Production deployment", [
    el("p", { class: "muted", text: "The orchestrator decides. A 403 (not on the deploy list) or a 503 (not configured) is expected for most operators." }),
    el("div", { class: "row" }, [field("Commit SHA (40 hex)", sha), button("Deploy…", function () {
      var value = sha.value.trim().toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(value)) { showError("Commit SHA must be 40 hex characters."); return; }
      act({
        route: "orchestrator.deploy", body: { commit_sha: value, confirm_production: "DEPLOY" }, title: "Deploy " + value.slice(0, 12),
        lines: ["Requests a production deployment of commit " + value + "."], done: "Deployment request sent.",
        after: function (d) { clear(out); out.appendChild(pre(d)); },
        onError: function (e) { clear(out); out.appendChild(pre({ status: e.status, response: e.data })); },
      });
    }, "danger")]),
    out,
  ]));
}

// ---------------------------------------------------------------- router

function route() {
  var tok = ++renderId;
  missionBox = null;
  resetMessages();
  var parts = location.hash.replace(/^#[/]?/, "").split("/").filter(Boolean);
  var head = parts[0] || "";
  var id = parts[1];
  if (id !== undefined && !SAFE.test(id)) { head = ""; id = undefined; }
  var nav = head;
  var screen;
  if (head === "agents" && id) screen = agentDetail(id, tok);
  else if (head === "agents") screen = agentsScreen(tok);
  else if (head === "reports") screen = reportsScreen(tok);
  else if (head === "recovery" && id) screen = recoveryDetail(id, tok);
  else if (head === "recovery") screen = recoveryScreen(tok);
  else if (head === "services") screen = servicesScreen(tok);
  else if (head === "policy") screen = policyScreen(tok);
  else if (head === "audit") screen = auditScreen(tok);
  else if (head === "deploy") screen = deployScreen();
  else { nav = ""; screen = mission(tok); }
  Array.prototype.forEach.call(document.querySelectorAll("a[data-nav]"), function (a) {
    if (a.getAttribute("data-nav") === nav) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  return Promise.resolve(screen).catch(function () { /* already shown by api() */ });
}

async function main() {
  $("banner-close").addEventListener("click", function () { $("banner").hidden = true; });
  who = await api("GET", "/api/whoami");
  $("actor").textContent = who.actor;
  $("approver").hidden = !who.approver;
  window.addEventListener("hashchange", route);
  setInterval(refreshMission, REFRESH_MS);
  await route();
}

main().catch(function () { /* already shown by api() */ });
`;
