// Workers Builds build command for change requests (ADR-0012 §5d, owner 2026-11-11). Runs the same
// type-check and Console UI build as ../forge-typecheck/typecheck-and-report.mjs, with every credential
// removed from its environment, so it never reports to the Forge itself. That script prints its result on
// one log line (FORGE_TYPECHECK_RESULT {...}); the Forge reads the line through the Workers Builds API
// (workers/forge/src/cr-builds.ts). The build exits with the type-check's own status.
//
// CI-WB (2026-11-25): that script also runs the control-plane test suite natively, after the type-check, and prints its
// result on a second line (FORGE_TEST_RESULT {...}); here, with no credential, it posts nothing, and the Forge reads both
// lines from one read of this build's log (cr-builds.ts). Failed tests fail the build, after both lines are printed.
// A production build of main here runs no test (FORGE_SKIP_TESTS): ../forge-typecheck builds main too and posts its result.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STRIPPED = Object.freeze(["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "FORGE_URL"]);
export function secretFreeEnv(env) {
  const out = { ...env };
  for (const k of STRIPPED) delete out[k];
  return out;
}

/** The build's environment: secret-free, and on a build of main no test run (the main project reports main's tests). */
export function crBuildEnv(env) {
  const out = secretFreeEnv(env);
  const branch = typeof env.WORKERS_CI_BRANCH === "string" ? env.WORKERS_CI_BRANCH.trim() : "";
  if (branch === "main") out.FORGE_SKIP_TESTS = "1";
  else delete out.FORGE_SKIP_TESTS;
  return out;
}

const selfUrl = typeof import.meta.url === "string" ? import.meta.url : "";
if (selfUrl && typeof process !== "undefined" && process.argv?.[1] && path.resolve(process.argv[1]) === fileURLToPath(selfUrl)) {
  const here = path.dirname(fileURLToPath(selfUrl));
  const script = path.join(here, "..", "forge-typecheck", "typecheck-and-report.mjs");
  const r = spawnSync(process.execPath, [script], { stdio: "inherit", env: crBuildEnv(process.env) });
  process.exit(r.status ?? 1);
}
