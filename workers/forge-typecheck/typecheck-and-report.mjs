// Workers Builds build command (ADR-0012 §5c). Runs the control-plane type-check with the locked
// toolchain and reports the result for this commit to the Forge, then exits with the compiler's
// status so the build shows the same outcome. Reads Workers Builds' default variables
// (WORKERS_CI_COMMIT_SHA, WORKERS_CI_BUILD_UUID, WORKERS_CI_BRANCH) and the build secrets
// CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET (the CI service token) plus FORGE_URL.
// Nothing here prints a secret. Without FORGE_URL or the token it still type-checks, and says so.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_DIAGNOSTICS = 50;

export function parseDiagnostics(output) {
  return output.split("\n").filter((l) => /\berror TS\d+:/.test(l)).map((l) => l.trim().slice(0, 600));
}

export function summarize(status, output, toolchain) {
  const diagnostics = parseDiagnostics(output);
  const errors = status === 0 ? 0 : Math.max(diagnostics.length, 1);
  return { conclusion: status === 0 ? "success" : "failure", errors, diagnostics: diagnostics.slice(0, MAX_DIAGNOSTICS), toolchain };
}

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}` };
}

async function report(body, env) {
  const url = env.FORGE_URL;
  if (!url || !env.CF_ACCESS_CLIENT_ID || !env.CF_ACCESS_CLIENT_SECRET) {
    console.log("typecheck-report: FORGE_URL or the CI service token is not configured in this build; result not reported.");
    return;
  }
  const res = await fetch(new URL("/v1/forge/typecheck-report", url), {
    method: "POST",
    headers: { "content-type": "application/json", "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID, "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET },
    body: JSON.stringify({ confirm: "REPORT", ...body }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`typecheck-report: the Forge answered ${res.status}: ${text.slice(0, 300)}`);
  console.log(`typecheck-report: recorded ${body.conclusion} for ${body.commit} (${text.slice(0, 200)})`);
}

// Run as a script only (the Forge tests import the pure functions above; in that bundle import.meta.url is absent).
const selfUrl = typeof import.meta.url === "string" ? import.meta.url : "";
if (selfUrl && typeof process !== "undefined" && process.argv?.[1] && path.resolve(process.argv[1]) === fileURLToPath(selfUrl)) {
  const here = path.dirname(fileURLToPath(selfUrl));
  const shared = path.join(here, "..", "control-plane-shared");
  const env = process.env;
  const commit = env.WORKERS_CI_COMMIT_SHA ?? "";
  if (!/^[0-9a-f]{40}$/.test(commit)) { console.error("typecheck-and-report: WORKERS_CI_COMMIT_SHA is not a commit"); process.exit(2); }
  const install = run("npm", ["ci", "--no-audit", "--no-fund", "--ignore-scripts"], shared);
  if (install.status !== 0) { console.error(install.output.slice(-4000)); process.exit(2); }
  const require = createRequire(path.join(shared, "package.json"));
  const toolchain = { typescript: require("typescript/package.json").version, "@types/node": require("@types/node/package.json").version };
  const tc = run("npm", ["run", "typecheck", "--silent"], shared);
  console.log(tc.output.trim().slice(-20000));
  const summary = summarize(tc.status, tc.output, toolchain);
  await report({ commit, build_id: env.WORKERS_CI_BUILD_UUID ?? "manual", branch: env.WORKERS_CI_BRANCH ?? null, ...summary }, env);
  process.exit(tc.status === 0 ? 0 : 1);
}
