// Workers Builds build command for change requests (ADR-0012 §5d, owner 2026-11-11). Runs the same
// type-check and Console UI build as ../forge-typecheck/typecheck-and-report.mjs, with every credential
// removed from its environment, so it never reports to the Forge itself. That script prints its result on
// one log line (FORGE_TYPECHECK_RESULT {...}); the Forge reads the line through the Workers Builds API
// (workers/forge/src/cr-builds.ts). The build exits with the type-check's own status.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const STRIPPED = Object.freeze(["CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "FORGE_URL"]);
export function secretFreeEnv(env) {
  const out = { ...env };
  for (const k of STRIPPED) delete out[k];
  return out;
}

const selfUrl = typeof import.meta.url === "string" ? import.meta.url : "";
if (selfUrl && typeof process !== "undefined" && process.argv?.[1] && path.resolve(process.argv[1]) === fileURLToPath(selfUrl)) {
  const here = path.dirname(fileURLToPath(selfUrl));
  const script = path.join(here, "..", "forge-typecheck", "typecheck-and-report.mjs");
  const r = spawnSync(process.execPath, [script], { stdio: "inherit", env: secretFreeEnv(process.env) });
  process.exit(r.status ?? 1);
}
