export { APP_CSS } from "./ui/css.ts";
export { APP_JS } from "./ui/app-js.ts";

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cerebrum</title>
<link rel="stylesheet" href="/assets/app.css">
</head>
<body>
<header>
<h1>Cerebrum</h1>
<span id="actor"></span>
<span id="approver" hidden>approver</span>
</header>
<nav aria-label="Primary navigation">
<a href="/" id="nav-home" aria-current="page">Home</a>
<a href="https://console.cryptophys.work">Console</a>
<div class="nav-group">
<a href="https://nexus.cryptophys.work" target="_blank" rel="noopener noreferrer">Nexus ↗</a>
<small class="muted">XAUUSD room (separate site until phase 2)</small>
</div>
<span class="disabled" aria-disabled="true">More modules (phase 2)</span>
</nav>
<main id="main">
<button type="button" id="refresh">Refresh</button>
<div id="banner" class="banner" role="alert" hidden></div>
<div id="content"><p class="muted">Loading platform status…</p></div>
</main>
<script src="/assets/app.js"></script>
</body>
</html>
`;
