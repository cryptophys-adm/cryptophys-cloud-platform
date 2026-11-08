// Two pages for signing in as someone else.
//
// 1. The page a signed-in person sees when their account may use Nexus but not the Cerebrum Console
// (ADR-0011: kind 'user', a disabled account, or no account). Instead of a bare 403 it says who they
// are signed in as and offers to switch to an account that has access: Cloudflare Access's own
// logout (/cdn-cgi/access/logout on the same host) ends the session for every platform application,
// so the next visit asks them to sign in again. It grants nothing and reads nothing else.
//
// 2. Switch account (/console/switch-account). Access's logout page has no way to send the person
// back, so they had to find the Console again by hand. This page signs them out in the background
// (the logout URL loaded as an image, on this host and on the team domain) and then reloads the
// Console, which Access answers with its sign-in page; after sign-in Access returns them to the
// Console. No script: a meta refresh, plus a link for browsers that ignore it.

/** Set on the Console gate's own 403, so the UI can tell it from a downstream role check. */
export const CONSOLE_ACCESS_HEADER = "x-cryptophys-console-access";

/** Cloudflare Access logout on the current host. It revokes the Access session for all applications. */
export const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";
/** The Console's own switch-account page (inside the mount). */
export const SWITCH_ACCOUNT_PATH = "/switch-account";
/** Seconds the switch page waits for the logout before it reloads the Console. */
export const SWITCH_DELAY_S = 3;

const STYLE = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:#05070d;color:#e2e8f0;font:14px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:480px;border:1px solid rgba(255,255,255,.1);border-radius:16px;background:rgba(15,23,42,.72);padding:28px 24px}
.eyebrow{font-size:11px;letter-spacing:.3em;text-transform:uppercase;color:rgba(103,232,249,.8)}
h1{margin:6px 0 14px;font-size:20px;color:#fff}
p{margin:0 0 12px;color:#94a3b8}
.who{display:block;margin:4px 0 14px;padding:8px 12px;border:1px solid rgba(255,255,255,.08);border-radius:10px;background:rgba(255,255,255,.03);color:#e2e8f0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;overflow-wrap:anywhere}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
a.btn{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:8px 16px;border-radius:10px;border:1px solid rgba(255,255,255,.12);color:#e2e8f0;text-decoration:none;font-weight:600}
a.primary{border-color:rgba(34,211,238,.45);background:rgba(34,211,238,.12);color:#cffafe}
a.btn:hover,a.btn:focus-visible{border-color:rgba(255,255,255,.3)}
.hint{margin-top:16px;font-size:12px;color:#64748b}
`;

let styleHash: Promise<string> | null = null;
function hashOfStyle(): Promise<string> {
  styleHash ??= crypto.subtle.digest("SHA-256", new TextEncoder().encode(STYLE)).then((d) => {
    let bin = "";
    for (const b of new Uint8Array(d)) bin += String.fromCharCode(b);
    return "sha256-" + btoa(bin);
  });
  return styleHash;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The 403 page for a browser that asked for the Console with an account that has no access to it. */
export async function deniedPage(actor: string, nexusOrigin: string | undefined, method: string, mount = ""): Promise<Response> {
  const nexus = nexusOrigin ? nexusOrigin.replace(/\/$/, "") + "/" : "/";
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Cerebrum Console · access needed</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="eyebrow">Cryptophys Cerebrum</div>
<h1>This account cannot open the Cerebrum Console</h1>
<p>You are signed in as</p>
<span class="who">${escapeHtml(actor)}</span>
<p>This account can use Nexus. The Cerebrum Console needs an admin account (viewer, operator or approver).</p>
<p>Sign in with an account that has access, or ask an owner to grant this one access on the Console's Users page.</p>
<div class="actions">
<a class="btn primary" href="${mount}${SWITCH_ACCOUNT_PATH}">Switch account</a>
<a class="btn" href="${escapeHtml(nexus)}">Back to Nexus</a>
</div>
<p class="hint">Switch account signs you out and brings you straight back to the sign-in page. If your identity provider signs you in automatically, choose another account there.</p>
</main>
</body>
</html>`;
  const csp = `default-src 'none'; style-src '${await hashOfStyle()}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  return new Response(method === "HEAD" ? null : html, {
    status: 403,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp, "cache-control": "no-store" },
  });
}

/**
 * Switch account: sign out in the background, then reload the Console so Access asks for a sign-in.
 * `teamDomain` is the Access team domain (validated by the caller's configuration check).
 */
export async function switchAccountPage(mount: string, teamDomain: string | undefined, method: string): Promise<Response> {
  const home = `${mount}/`;
  const team = teamDomain && /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain) ? teamDomain : null;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="${SWITCH_DELAY_S};url=${home}">
<title>Cerebrum Console · switching account</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<div class="eyebrow">Cryptophys Cerebrum</div>
<h1>Switching account</h1>
<p>Signing you out of Cloudflare Access. In a moment the Console asks you to sign in again.</p>
<p>Choose the account that has access to the Cerebrum Console. If your identity provider signs you in automatically, pick "use another account" there.</p>
<div class="actions">
<a class="btn primary" href="${home}">Continue to sign in</a>
</div>
<p class="hint">If you come back as the same account, wait half a minute and select Continue to sign in again: Access can take up to 30 seconds to end the old session everywhere.</p>
<img src="${ACCESS_LOGOUT_PATH}" alt="" width="1" height="1">
${team ? `<img src="https://${team}${ACCESS_LOGOUT_PATH}" alt="" width="1" height="1">` : ""}
</main>
</body>
</html>`;
  const img = team ? `'self' https://${team}` : "'self'";
  const csp = `default-src 'none'; style-src '${await hashOfStyle()}'; img-src ${img}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  return new Response(method === "HEAD" ? null : html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": csp, "cache-control": "no-store" },
  });
}

/** A browser navigation, as opposed to the UI's own API calls. */
export function wantsHtml(request: Request): boolean {
  return (request.headers.get("accept") ?? "").toLowerCase().includes("text/html");
}
