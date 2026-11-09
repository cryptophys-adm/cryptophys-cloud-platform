// xauusd read API behind Access (owner 2026-11-08, option a): provision-access.yml adds only the
// /api/* path of the AI Worker's custom domain to the single platform Access application. The rest of
// that host stays public (TradingView's /webhook, the deploy probes /health and /ready).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("../../../", import.meta.url);
const prov = readFileSync(new URL(".github/workflows/provision-access.yml", ROOT), "utf8");
const envList = (name: string) => (prov.match(new RegExp(`^  ${name}: (.+)$`, "m"))?.[1] ?? "").trim().split(/\s+/).filter(Boolean);

test("only the xauusd /api/* path joins the Access application, never its whole host", () => {
  assert.deepEqual(envList("PUBLIC_PATHS"), ["ai.cryptophys.work/api/*"]);
  assert.deepEqual(envList("PUBLIC_HOSTNAMES"), ["nexus.cryptophys.work", "omega.cryptophys.work"], "ai.cryptophys.work is not a whole-host destination; Omega is (ADR-0010 amendment 2026-11-09)");
  assert.match(prov, /\{type: "public", uri: \$p\}/);
  // The destination count check includes the paths, so a dropped destination fails the run.
  assert.match(prov, /\$\(wc -w <<< "\$PUBLIC_HOSTNAMES"\) \+ \$\(wc -w <<< "\$PUBLIC_PATHS"\)/);
  // Same single application and policies: no second app, no new policy.
  assert.equal((prov.match(/^  ACCESS_APP_NAME: /gm) || []).length, 1);
  assert.equal((prov.match(/\{name: "[a-z-]+", decision:/g) || []).length, 3);
});

test("the path guard rejects a bare host or a host-wide wildcard", () => {
  const src = prov.match(/\[\[ "\$path" =~ (\S+) \]\]/)?.[1];
  assert.ok(src, "path destinations are validated");
  const guard = new RegExp(src);
  assert.ok(guard.test("ai.cryptophys.work/api/*"));
  assert.ok(guard.test("ai.cryptophys.work/api"));
  for (const bad of ["ai.cryptophys.work", "ai.cryptophys.work/", "ai.cryptophys.work/*", "*.cryptophys.work/api/*", "ai.cryptophys.work/api/../webhook", "https://ai.cryptophys.work/api/*"]) {
    assert.ok(!guard.test(bad), `${bad} is refused`);
  }
});

test("provisioning verifies the lock and that the rest of the host stays public", () => {
  const paths = envList("PUBLIC_PATHS").map((p) => p.replace(/\*$/, ""));
  const probes = envList("PATH_PROBES");
  assert.ok(probes.length > 0);
  for (const probe of probes) assert.ok(paths.some((p) => probe.startsWith(p)), `${probe} lies under a protected path`);
  assert.deepEqual(envList("OPEN_PROBES"), ["ai.cryptophys.work/health"]);
  for (const open of envList("OPEN_PROBES")) assert.ok(!paths.some((p) => open.startsWith(p)), `${open} is outside every protected path`);
  const verify = prov.slice(prov.indexOf("- name: Verify Access is enforced at the edge"));
  assert.match(verify, /for probe in \$PATH_PROBES; do[\s\S]+?\^\(302\|401\|403\)\$[\s\S]+?--header "@\$headers"[\s\S]+?== "200"/);
  assert.match(verify, /for probe in \$OPEN_PROBES; do[\s\S]+?\[\[ "\$open" == "200" \]\]/);
});
