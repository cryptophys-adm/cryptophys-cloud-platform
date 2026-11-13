// ADR-0010 amendment 2026-11-13 (owner: "setuju pension domain lama"): after a week of Nexus as the
// single origin, cryptophys-home and the custom domains home.cryptophys.work and console.cryptophys.work
// are retired. cryptophys-console stays: it serves nexus.cryptophys.work/console* through its zone route.
// These tests hold the source side of the retirement (what retire-worker.yml's fail-closed check needs)
// and run the workflow's custom-domain detach step against a fake Cloudflare API.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { DEPLOY_UNITS, unitForService } from "../src/deploy-units.ts";
import { serviceName } from "../src/plain.ts";
import { targets } from "../../drift-detector/src/index.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const exists = (p: string) => existsSync(new URL(p, ROOT));
const HOME = "cryptophys-home";
const workerDirs = () => readdirSync(new URL("workers/", ROOT), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const workerConfigs = () => workerDirs().flatMap((d) => readdirSync(new URL(`workers/${d}/`, ROOT))
  .filter((f) => /^wrangler.*\.(toml|json|jsonc)$/.test(f)).map((f) => ({ path: `workers/${d}/${f}`, text: read(`workers/${d}/${f}`) })));

test("RH1. cryptophys-home is gone from source: no Worker, no deploy workflow, no DNA, no deploy unit, no drift target, no name", () => {
  assert.equal(exists("workers/home"), false, "workers/home is removed");
  assert.equal(exists(".github/workflows/deploy-home.yml"), false, "deploy-home.yml is removed");
  for (const d of workerDirs()) {
    if (exists(`workers/${d}/organism.json`)) assert.notEqual(JSON.parse(read(`workers/${d}/organism.json`)).service, HOME, `workers/${d} DNA`);
  }
  assert.equal(unitForService(HOME), null);
  assert.ok(DEPLOY_UNITS.every((u) => (u.unit as string) !== "home" && (u.workflow as string) !== "deploy-home.yml"));
  assert.equal(HOME in targets({} as never), false, "the Drift Detector has no target for it");
  assert.equal(serviceName(HOME), "Home", "historical rows still read as words");
  // retire-worker.yml's fail-closed check: no Worker config binds to it, and no deploy, validation or Access workflow lists it.
  for (const c of workerConfigs()) assert.equal(c.text.includes(`"${HOME}"`), false, `${c.path} still references ${HOME}`);
  for (const wf of ["deploy-control-plane.yml", "validate-control-plane.yml", "provision-access.yml", "rollback-worker.yml", "deploy-console.yml"]) {
    assert.equal(read(`.github/workflows/${wf}`).includes(HOME), false, `${wf} still lists ${HOME}`);
  }
  assert.doesNotMatch(read("workers/control-plane-tsconfig.json"), /home\/src/);
});

test("RH2. the old custom domains are declared nowhere; the Console keeps its Worker, its zone route and its checks", () => {
  for (const host of ["home.cryptophys.work", "console.cryptophys.work"]) {
    const declared = new RegExp(`pattern"?\\s*[:=]\\s*"${host.replace(/\./g, "\\.")}"`);
    for (const c of workerConfigs()) assert.doesNotMatch(c.text, declared, `${c.path} declares ${host}`);
  }
  const toml = read("workers/console/wrangler.toml");
  assert.match(toml, /^name = "cryptophys-console"$/m, "the Console Worker is kept");
  assert.doesNotMatch(toml, /^routes\s*=/m, "no routes: the zone route is attached by the deploy workflow");
  const deploy = read(".github/workflows/deploy-console.yml");
  assert.doesNotMatch(deploy, /console\.cryptophys\.work/, "the deploy no longer probes the retired host");
  assert.match(deploy, /ROUTE_PATTERN: nexus\.cryptophys\.work\/console\*/);
  assert.match(deploy, /https:\/\/nexus\.cryptophys\.work\/console\/health/);
  assert.equal(unitForService("cryptophys-console")?.workflow, "deploy-console.yml");
  assert.ok("cryptophys-console" in targets({} as never), "the Drift Detector still observes the Console");
  assert.match(read(".github/workflows/provision-access.yml"), /cryptophys-console cryptophys-forge\n/);
});

test("RH3. migration 0055 keeps the registry row and only disables it", () => {
  const sql = read("workers/control-plane-migrations/0055_retire_home.sql");
  const code = sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n").trim();
  assert.equal(code, "UPDATE service_registry SET status = 'disabled', updated_at = '2026-11-13T12:00:00.000Z' WHERE service_id = 'cryptophys-home';");
  assert.equal(exists("workers/control-plane-migrations/0022_register_console_and_home.sql"), true, "applied migrations are history");
});

const RETIRE = ".github/workflows/retire-worker.yml";
/** The `run:` script of a step of retire-worker.yml, unindented. */
function stepScript(name: string): string {
  const wf = read(RETIRE);
  const start = wf.indexOf(`      - name: ${name}`);
  assert.ok(start > 0, `step ${name}`);
  const end = wf.indexOf("\n      - name: ", start + 1);
  const block = wf.slice(start, end < 0 ? undefined : end);
  const run = block.indexOf("        run: |\n");
  assert.ok(run > 0, `step ${name} has a run block`);
  return block.slice(run + "        run: |\n".length).split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
}
const DETACH = "Detach the retired custom domains, then verify they are gone";

test("RH4. retire-worker.yml: cryptophys-home is retirable, its domains are detached before the Worker is deleted, signal-engine unchanged", () => {
  const wf = read(RETIRE);
  assert.match(wf, /cryptophys-signal-engine\) echo "WORKFLOW_NAME=cryptophys-signal-ingest" >> "\$GITHUB_ENV" ;;/);
  assert.match(wf, /cryptophys-home\) echo "DETACH_DOMAINS=home\.cryptophys\.work=cryptophys-home console\.cryptophys\.work=cryptophys-console" >> "\$GITHUB_ENV" ;;/);
  assert.doesNotMatch(wf, /^\s+cryptophys-console\)/m, "the Console is never retirable");
  const order = ["Validate request", "Checkout main", "Fail closed unless the Worker is fully retired in source", DETACH, "Delete the Workflow and the Worker"].map((s) => wf.indexOf(`- name: ${s}`));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), `step order ${order}`);
  assert.match(wf, new RegExp(`- name: ${DETACH}\\n\\s+if: env\\.DETACH_DOMAINS != ''`));
  const s = stepScript(DETACH);
  assert.match(s, /\/workers\/domains"/);
  assert.match(s, /call GET "\$\{api\}\?hostname=\$1"/);
  assert.match(s, /call DELETE "\$\{api\}\/\$\{id\}"/);
  assert.doesNotMatch(s, /set -x|echo[^\n]*\$\{?CLOUDFLARE_(ACCESS_)?API_TOKEN/, "the token is never printed");
  // The existing signal-engine deletion step is untouched: it still deletes the Workflow, then the script.
  const del = stepScript("Delete the Workflow and the Worker, then verify both are gone");
  assert.match(del, /call GET "\/workflows\/\$\{WORKFLOW_NAME\}"/);
  assert.match(del, /call DELETE "\/workers\/scripts\/\$\{WORKER\}"/);
  const ops = read(".github/workflows/ops-dispatch.yml");
  assert.match(ops, /retire-worker\.yml\) ref=main ;;/);
  assert.match(ops, /worker\) \[\[ "\$value" =~ \^cryptophys-\[a-z0-9-\]\{2,60\}\$ \]\]/);
});

// A fake curl for the detach step: domains in $FAKE_CF/domains ("<id> <hostname> <service>" lines);
// tokens in $FAKE_CF/denied get 403; $FAKE_CF/list_status or delete_status force a status. Every call is
// logged as "<METHOD> <path> <token>" to $FAKE_CF/log.
const FAKE_CURL = String.raw`
curl() {
  local out="" method="GET" url="" token=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --output) out="$2"; shift 2 ;;
      --request) method="$2"; shift 2 ;;
      --header) token="\${2#Authorization: Bearer }"; shift 2 ;;
      --write-out|--max-time|--proto) shift 2 ;;
      --silent|--show-error) shift ;;
      *) url="$1"; shift ;;
    esac
  done
  local base="https://api.cloudflare.com/client/v4/accounts/acc/workers/domains" path
  [[ "$url" == "$base"* ]] || { echo "unexpected url $url" >&2; return 7; }
  path="\${url#"$base"}"
  echo "$method \${path} $token" >> "$FAKE_CF/log"
  local refused='{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}'
  if [[ "$method" == GET ]]; then
    if [[ -f "$FAKE_CF/list_status" ]]; then echo "$refused" > "$out"; cat "$FAKE_CF/list_status"; return 0; fi
    jq -nc --arg h "\${path#\?hostname=}" --rawfile d "$FAKE_CF/domains" \
      '{success: true, errors: [], result: [$d | split("\n")[] | select(length > 0) | split(" ") | {id: .[0], hostname: .[1], service: .[2]} | select(.hostname == $h)]}' > "$out"
    printf 200; return 0
  fi
  local id="\${path#/}"
  if grep -qxF "$token" "$FAKE_CF/denied"; then echo "$refused" > "$out"; printf 403; return 0; fi
  if [[ -f "$FAKE_CF/delete_status" ]]; then echo '{"success":false,"errors":[{"code":10013,"message":"internal"}]}' > "$out"; cat "$FAKE_CF/delete_status"; return 0; fi
  grep -v "^$id " "$FAKE_CF/domains" > "$FAKE_CF/domains.new" || true
  mv "$FAKE_CF/domains.new" "$FAKE_CF/domains"
  : > "$out"; printf 200
}
`.replaceAll("\\${", "${"); // String.raw keeps "\${" (written so to avoid interpolation): bash wants "${"

const API_TOKEN = "fake-api-token-0123456789";
const ACCESS_TOKEN = "fake-access-token-9876543210";
interface Scenario { domains: string[]; denied?: string[]; listStatus?: number; deleteStatus?: number; accessToken?: string }
function detach(s: Scenario) {
  const dir = mkdtempSync(`${tmpdir()}/retire-home-`);
  try {
    writeFileSync(`${dir}/domains`, s.domains.map((d) => `${d}\n`).join(""));
    writeFileSync(`${dir}/denied`, (s.denied ?? []).map((t) => `${t}\n`).join(""));
    writeFileSync(`${dir}/log`, "");
    writeFileSync(`${dir}/summary`, "");
    if (s.listStatus) writeFileSync(`${dir}/list_status`, String(s.listStatus));
    if (s.deleteStatus) writeFileSync(`${dir}/delete_status`, String(s.deleteStatus));
    const r = spawnSync("bash", ["-c", `${FAKE_CURL}\n${stepScript(DETACH)}`], {
      cwd: ROOT.pathname, encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin", FAKE_CF: dir, GITHUB_STEP_SUMMARY: `${dir}/summary`,
        DETACH_DOMAINS: "home.cryptophys.work=cryptophys-home console.cryptophys.work=cryptophys-console",
        CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: API_TOKEN, CLOUDFLARE_ACCESS_API_TOKEN: s.accessToken ?? ACCESS_TOKEN,
      },
    });
    const output = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    assert.equal(r.error, undefined, String(r.error ?? ""));
    assert.equal(output.includes(API_TOKEN) || output.includes(ACCESS_TOKEN), false, "no token in the output");
    const lines = (f: string) => readFileSync(`${dir}/${f}`, "utf8").split("\n").filter(Boolean);
    return { status: r.status, output, log: lines("log"), left: lines("domains"), summary: lines("summary") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("RH5. the detach step against a fake Cloudflare API: detaches only the expected records, verifies, fails closed", () => {
  // In the Forge runner (workerd) there is no process to run bash in; the static checks above still run there.
  if ((globalThis as { __FORGE_BUNDLE?: unknown }).__FORGE_BUNDLE) { console.log("RH5: no child process in the Forge runner; covered on Node"); return; }
  const HOME_D = "d1 home.cryptophys.work cryptophys-home", CONSOLE_D = "d2 console.cryptophys.work cryptophys-console";
  const OTHER = "d9 nexus.cryptophys.work xauusd-nexus-dashboard";

  // 1. Both attached as expected: each is read, detached with CLOUDFLARE_API_TOKEN, and verified gone.
  let r = detach({ domains: [HOME_D, CONSOLE_D, OTHER] });
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(r.left, [OTHER], "nothing else is detached");
  assert.deepEqual(r.log.filter((l) => l.startsWith("DELETE")), [`DELETE /d1 ${API_TOKEN}`, `DELETE /d2 ${API_TOKEN}`]);
  assert.deepEqual(r.summary, [
    "- Custom domain `home.cryptophys.work` detached from `cryptophys-home` (verified absent).",
    "- Custom domain `console.cryptophys.work` detached from `cryptophys-console` (verified absent).",
  ]);

  // 2. Already detached: nothing to delete, still verified.
  r = detach({ domains: [OTHER] });
  assert.equal(r.status, 0, r.output);
  assert.equal(r.log.filter((l) => l.startsWith("DELETE")).length, 0);
  assert.equal(r.summary.length, 2);

  // 3. A hostname attached to another Worker than expected: fail before detaching anything.
  r = detach({ domains: [HOME_D, "d2 console.cryptophys.work cryptophys-forge"] });
  assert.notEqual(r.status, 0);
  assert.match(r.output, /console\.cryptophys\.work is attached to cryptophys-forge, not cryptophys-console; nothing was detached/);
  assert.equal(r.log.filter((l) => l.startsWith("DELETE")).length, 0, "home was not detached either");

  // 4. CLOUDFLARE_API_TOKEN refused (no Workers Routes: Edit): retried once with CLOUDFLARE_ACCESS_API_TOKEN.
  r = detach({ domains: [HOME_D, CONSOLE_D], denied: [API_TOKEN] });
  assert.equal(r.status, 0, r.output);
  assert.deepEqual(r.log.filter((l) => l.startsWith("DELETE")), [`DELETE /d1 ${API_TOKEN}`, `DELETE /d1 ${ACCESS_TOKEN}`, `DELETE /d2 ${API_TOKEN}`, `DELETE /d2 ${ACCESS_TOKEN}`]);
  assert.deepEqual(r.left, []);

  // 5. Both tokens refused, or no fallback token: fail closed, the Worker deletion never runs.
  r = detach({ domains: [HOME_D, CONSOLE_D], denied: [API_TOKEN, ACCESS_TOKEN] });
  assert.notEqual(r.status, 0);
  assert.match(r.output, /Detaching home\.cryptophys\.work from cryptophys-home failed: HTTP 403 \[\{"code":10000,"message":"Authentication error"\}\]\. The token needs Workers edit access and Zone > Workers Routes > Edit/);
  assert.deepEqual(r.left, [HOME_D, CONSOLE_D]);
  r = detach({ domains: [HOME_D], denied: [API_TOKEN], accessToken: "" });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.log.filter((l) => l.startsWith("DELETE")), [`DELETE /d1 ${API_TOKEN}`]);

  // 6. Any other unexpected status fails closed: a failed list, a failed delete.
  r = detach({ domains: [HOME_D, CONSOLE_D], listStatus: 403 });
  assert.notEqual(r.status, 0);
  assert.match(r.output, /Listing the custom domains of home\.cryptophys\.work failed: HTTP 403/);
  assert.equal(r.log.filter((l) => l.startsWith("DELETE")).length, 0);
  r = detach({ domains: [HOME_D, CONSOLE_D], deleteStatus: 500 });
  assert.notEqual(r.status, 0);
  assert.match(r.output, /failed: HTTP 500/);
  assert.deepEqual(r.left, [HOME_D, CONSOLE_D]);
});
