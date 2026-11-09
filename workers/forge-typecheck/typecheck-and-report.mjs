// Workers Builds build command (ADR-0012 §5c). Runs the control-plane type-check with the locked
// toolchain, then the Console UI build (its own type-check and the Vite build, as GitHub CI's
// "Build the Console UI" step), reports both for this commit to the Forge, then exits non-zero if
// either failed so the build shows the same outcome. Reads Workers Builds' default variables
// (WORKERS_CI_COMMIT_SHA, WORKERS_CI_BUILD_UUID, WORKERS_CI_BRANCH) and the build secrets
// CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET (the CI service token) plus FORGE_URL.
// Nothing here prints a secret. Without FORGE_URL or the token it still type-checks, and says so.
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_DIAGNOSTICS = 50;

export function parseDiagnostics(output) {
  return output.split("\n").filter((l) => /\berror TS\d+:/.test(l)).map((l) => l.trim().slice(0, 600));
}

/**
 * The commit this build checks. Workers Builds sets WORKERS_CI_COMMIT_SHA for GitHub and GitLab; a
 * build from Artifacts may leave it empty or short, so the checked-out HEAD is the fallback.
 */
export function resolveCommit(envSha, gitHead) {
  const fromEnv = typeof envSha === "string" ? envSha.trim().toLowerCase() : "";
  if (/^[0-9a-f]{40}$/.test(fromEnv)) return { commit: fromEnv, source: "WORKERS_CI_COMMIT_SHA" };
  const head = typeof gitHead === "string" ? gitHead.trim().toLowerCase() : "";
  if (/^[0-9a-f]{40}$/.test(head) && (!fromEnv || head.startsWith(fromEnv))) return { commit: head, source: "git rev-parse HEAD" };
  return null;
}

export function summarize(status, output, toolchain) {
  const diagnostics = parseDiagnostics(output);
  const errors = status === 0 ? 0 : Math.max(diagnostics.length, 1);
  return { conclusion: status === 0 ? "success" : "failure", errors, diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS), toolchain };
}

/**
 * The Console UI build: `npm run build` (tsc --noEmit, then vite build). Its diagnostics are the
 * TypeScript errors, or, when Vite fails without one, the last lines of its output.
 */
export function summarizeConsoleBuild(status, output, bytes) {
  let diagnostics = parseDiagnostics(output);
  if (status !== 0 && diagnostics.length === 0) {
    diagnostics = output.split("\n").map((l) => l.trim()).filter(Boolean).slice(-5).map((l) => l.slice(0, 600));
  }
  const errors = status === 0 ? 0 : Math.max(diagnostics.length, 1);
  const result = { conclusion: status === 0 ? "success" : "failure", errors, diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS) };
  return status === 0 && Number.isInteger(bytes) ? { ...result, bytes } : result;
}

function dirBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirBytes(p) : statSync(p).size;
  }
  return total;
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

/** A credential as stored: strip CR/LF, surrounding spaces and a copied "Header-Name:" prefix (as access-headers.sh does). */
export function cleanCredential(value, headerName) {
  return String(value ?? "").replace(/[\r\n]/g, "").replace(new RegExp(`^\\s*(${headerName}:)?\\s*`, "i"), "").replace(/\s+$/, "");
}

/**
 * POST the report. Access answers a refused service token with a redirect to its sign-in page, so
 * redirects are not followed: anything but a JSON 200 that names this commit is a failure, and the
 * build fails with it. Returns the Forge's answer.
 */
export async function postReport(fetchImpl, forgeUrl, clientId, clientSecret, body) {
  const res = await fetchImpl(new URL("/v1/forge/typecheck-report", forgeUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret },
    body: JSON.stringify({ confirm: "REPORT", ...body }),
  });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`typecheck-report: Cloudflare Access refused the CI service token (HTTP ${res.status} to sign-in). Check CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET in the build variables.`);
  }
  const text = await res.text();
  let answer = null;
  try { answer = JSON.parse(text); } catch { /* not JSON */ }
  if (!res.ok || !answer || answer.commit !== body.commit) {
    throw new Error(`typecheck-report: the Forge did not record the report (HTTP ${res.status}): ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  }
  return answer;
}

async function report(body, env) {
  const url = cleanCredential(env.FORGE_URL, "");
  const id = cleanCredential(env.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Id");
  const secret = cleanCredential(env.CF_ACCESS_CLIENT_SECRET, "CF-Access-Client-Secret");
  if (!url || !id || !secret) {
    console.log("typecheck-report: FORGE_URL or the CI service token is not configured in this build; result not reported.");
    return;
  }
  const answer = await postReport(fetch, url, id, secret, body);
  console.log(`typecheck-report: the Forge recorded ${answer.conclusion} for ${answer.commit} (applied to its check: ${answer.applied_to_run})`);
}

// Run as a script only (the Forge tests import the pure functions above; in that bundle import.meta.url is absent).
const selfUrl = typeof import.meta.url === "string" ? import.meta.url : "";
if (selfUrl && typeof process !== "undefined" && process.argv?.[1] && path.resolve(process.argv[1]) === fileURLToPath(selfUrl)) {
  const here = path.dirname(fileURLToPath(selfUrl));
  const shared = path.join(here, "..", "control-plane-shared");
  const env = process.env;
  const head = run("git", ["rev-parse", "HEAD"], here);
  const resolved = resolveCommit(env.WORKERS_CI_COMMIT_SHA, head.status === 0 ? head.output : "");
  if (!resolved) {
    const seen = Object.keys(env).filter((k) => k.startsWith("WORKERS_CI")).sort().join(", ") || "none";
    console.error(`typecheck-and-report: cannot tell which commit this build checks (WORKERS_CI_* variables present: ${seen}; git rev-parse HEAD exit ${head.status})`);
    process.exit(2);
  }
  const { commit } = resolved;
  console.log(`typecheck-and-report: checking ${commit} (from ${resolved.source})`);
  const install = run("npm", ["ci", "--no-audit", "--no-fund", "--ignore-scripts"], shared);
  if (install.status !== 0) { console.error(install.output.slice(-4000)); process.exit(2); }
  const require = createRequire(path.join(shared, "package.json"));
  const toolchain = { typescript: require("typescript/package.json").version, "@types/node": require("@types/node/package.json").version };
  const tc = run("npm", ["run", "typecheck", "--silent"], shared);
  console.log(tc.output.trim().slice(-20000));
  const summary = summarize(tc.status, tc.output, toolchain);
  const ui = path.join(here, "..", "console", "ui");
  const uiInstall = run("npm", ["ci", "--no-audit", "--no-fund", "--ignore-scripts"], ui);
  const uiBuild = uiInstall.status === 0 ? run("npm", ["run", "build", "--silent"], ui) : uiInstall;
  console.log(uiBuild.output.trim().slice(-8000));
  let bytes;
  try { bytes = uiBuild.status === 0 ? dirBytes(path.join(ui, "dist")) : undefined; } catch { bytes = undefined; }
  const consoleBuild = summarizeConsoleBuild(uiBuild.status, uiBuild.output, bytes);
  console.log(`typecheck-and-report: control plane ${summary.conclusion} (${summary.errors} errors); Console UI build ${consoleBuild.conclusion}${bytes ? ` (${bytes} bytes)` : ""}`);
  try {
    await report({ commit, build_id: env.WORKERS_CI_BUILD_UUID ?? "manual", branch: env.WORKERS_CI_BRANCH ?? null, ...summary, console_build: consoleBuild }, env);
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(3);
  }
  process.exit(tc.status === 0 && uiBuild.status === 0 ? 0 : 1);
}
