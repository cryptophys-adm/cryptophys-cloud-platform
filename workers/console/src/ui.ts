// Static shell page of the Console (ADR-0008, TP-023; screens in TP-024). The screens live in
// ui/app-js.ts and the route table in ui/routes.ts. No dependency, no CDN, no inline script,
// no style attribute and no event-handler attribute; every value from the API is written with
// textContent.

export { APP_CSS } from "./ui/css.ts";
export { APP_JS } from "./ui/app-js.ts";

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
<nav aria-label="Console">
<a href="#/" data-nav="">Mission Control</a>
<a href="#/agents" data-nav="agents">Agents</a>
<a href="#/reports" data-nav="reports">Reports</a>
<a href="#/recovery" data-nav="recovery">Recovery</a>
<a href="#/services" data-nav="services">Services &amp; Drift</a>
<a href="#/policy" data-nav="policy">Policy</a>
<a href="#/audit" data-nav="audit">Audit</a>
<a href="#/deploy" data-nav="deploy">Deploy</a>
<a href="https://nexus.cryptophys.work" target="_blank" rel="noopener noreferrer">Nexus ↗</a>
</nav>
<div id="banner" class="banner" role="alert" hidden>
<span id="banner-text" class="error"></span>
<button type="button" id="banner-close">Dismiss</button>
</div>
<p id="notice" class="notice" role="status" hidden></p>
<main id="view"></main>
<script src="/assets/app.js"></script>
</body>
</html>
`;
