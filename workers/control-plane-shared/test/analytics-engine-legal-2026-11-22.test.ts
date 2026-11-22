// ADR-0015 decision 6, phase 3 (owner 2026-11-22: "upgrade kernel agar binding itu menjadi legal dan digunakan maksimal
// serta assess bagaimana memanfaatkan dan juga tervisualisasi", confirmed in the platform session: "Ya").
//
// A wrangler upload from outside the platform (2026-11-21) bound two Analytics Engine datasets and a variable to the AI
// Kernel. The consensus deploy that restored the kernel's code kept them, because a code deploy keeps live bindings.
// This change makes them part of main: the kernel's wrangler.toml declares them with the live values, and the native
// deploy adopts a newly declared binding only when the live record is exactly the declaration. Telemetry stays
// telemetry: only the modules listed here may touch the datasets, and none of them reads the data back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { bindingsFromToml, parseToml, planConfigChange, type BindingRecord, type ConfigPlan } from "../../deployment-orchestrator/src/config-diff.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const KERNEL = read("workers/ai-kernel/wrangler.toml");

/** The three records as Cloudflare returned them for kernel version 1b82a1c5 (2026-11-22, read only). */
const LIVE: BindingRecord[] = [
  { type: "analytics_engine", name: "ANALYTICS_AGENT_RUNTIME", dataset: "cryptophys_agent_runtime" },
  { type: "analytics_engine", name: "ANALYTICS_CONTROL_PLANE", dataset: "cryptophys_control_plane" },
  { type: "plain_text", name: "ANALYTICS_SAMPLE_RATE", text: "1" },
];
const KEYS = LIVE.map((b) => `${b.type}:${b.name}`).sort();

/** The kernel's config as main had it before this change: no datasets, no sample-rate variable. */
const RUNNING = KERNEL
  .replace(/\n# ADR-0015 decision 6, phase 3 \(owner 2026-11-22\): Workers Analytics Engine[\s\S]*?dataset = "cryptophys_control_plane"\n/, "\n")
  .replace(/# ADR-0015 decision 6, phase 3 \(owner 2026-11-22, [^\n]*\n# the kernel's Analytics Engine[^\n]*\nANALYTICS_SAMPLE_RATE = "1"\n/, "");

function activeFor(toml: string): BindingRecord[] {
  return bindingsFromToml(parseToml(toml)!).bindings!.map((r) => {
    const o: BindingRecord = { ...r };
    if (o.type === "d1") o.id = "0f6a3c1e-1111-4222-8333-944445555666";
    if (o.type === "service") o.environment = "production";
    if (o.type === "durable_object_namespace") o.namespace_id = "a".repeat(32);
    if (o.type === "send_email") o.allowed_destination_addresses = ["owner@example.com"];
    return o;
  });
}
const ok = (r: ReturnType<typeof planConfigChange>): ConfigPlan => { assert.equal(r.eligible, true, JSON.stringify(r)); return r as ConfigPlan; };
const reason = (r: ReturnType<typeof planConfigChange>) => (r.eligible ? "eligible" : r.reason);

test("AL1. the kernel's wrangler.toml declares the two datasets and the variable exactly as they are live", () => {
  assert.notEqual(RUNNING, KERNEL, "the running config is the kernel's without the new declarations");
  assert.doesNotMatch(RUNNING, /ANALYTICS_/);
  const declared = bindingsFromToml(parseToml(KERNEL)!).bindings!.filter((b) => /^ANALYTICS_/.test(b.name));
  assert.deepEqual(declared.map((b) => `${b.type}:${b.name}`).sort(), KEYS);
  for (const live of LIVE) assert.deepEqual(declared.find((b) => b.name === live.name), live, live.name);
});

test("AL2. the native deploy adopts a newly declared binding that is live with exactly that record, and nothing else", () => {
  const active = [...activeFor(RUNNING), ...LIVE];
  const plan = ok(planConfigChange(RUNNING, KERNEL, active));
  assert.deepEqual(plan.changes.adopted, KEYS);
  assert.deepEqual(plan.changes.added, [], "adopted bindings are not reported as added");
  for (const k of KEYS) assert.equal(plan.sources[k], "active", `${k} is kept verbatim`);
  for (const live of LIVE) assert.deepEqual(plan.bindings.find((b) => b.name === live.name), live);
  // A plan with nothing to adopt carries no `adopted` list (the audit payload stays as it was).
  assert.equal(ok(planConfigChange(KERNEL, KERNEL, [...activeFor(RUNNING), ...LIVE])).changes.adopted, undefined);

  // Any difference is still refused: another dataset, another value, a field the declaration does not have.
  const other = active.map((b) => (b.name === "ANALYTICS_CONTROL_PLANE" ? { ...b, dataset: "someone_elses" } : b));
  assert.equal(reason(planConfigChange(RUNNING, KERNEL, other)), "binding_set_outside_config:analytics_engine:ANALYTICS_CONTROL_PLANE");
  const rate = active.map((b) => (b.name === "ANALYTICS_SAMPLE_RATE" ? { ...b, text: "0.1" } : b));
  assert.equal(reason(planConfigChange(RUNNING, KERNEL, rate)), "binding_set_outside_config:plain_text:ANALYTICS_SAMPLE_RATE");
  // Declared but not live: an ordinary addition, built from the config.
  const fresh = ok(planConfigChange(RUNNING, KERNEL, activeFor(RUNNING)));
  assert.deepEqual(fresh.changes.added.filter((k) => /ANALYTICS_/.test(k)), KEYS);
  assert.equal(fresh.changes.adopted, undefined);
  for (const k of KEYS) assert.equal(fresh.sources[k], "config");
});

function* sources(dir: URL): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "test" || name === "dist") continue;
    const u = new URL(name, dir);
    if (statSync(u).isDirectory()) yield* sources(new URL(`${name}/`, dir));
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) yield u.pathname.slice(ROOT.pathname.length);
  }
}

/** The only modules that may touch the datasets (step 2 adds the writer here). None of them reads the data back. */
export const TELEMETRY_MODULES: readonly string[] = [
  // Step 2 (2026-11-22): the writer and the one module that names the bindings.
  "workers/ai-kernel/src/analytics/telemetry.ts",
  "workers/ai-kernel/src/analytics/writer.ts",
];

test("AL3. telemetry only: no module outside the list touches the datasets, none reads them back, and only the kernel binds them", () => {
  const touching: string[] = [];
  for (const f of sources(new URL("workers/", ROOT))) {
    const text = read(f);
    if (/ANALYTICS_(AGENT_RUNTIME|CONTROL_PLANE)|writeDataPoint|analyticsEngine/.test(text)) touching.push(f);
  }
  assert.deepEqual(touching.sort(), [...TELEMETRY_MODULES].sort(), "a new reader or writer of Analytics Engine joins TELEMETRY_MODULES in review");
  // Reading the data back to decide anything is ruled out (ADR-0015 decision 6): no SQL query against the datasets in code.
  for (const f of TELEMETRY_MODULES) assert.doesNotMatch(read(f), /\.query\(|FROM\s+cryptophys_/i, `${f} writes only`);
  const binders = readdirSync(new URL("workers/", ROOT))
    .filter((d) => existsSync(new URL(`workers/${d}/wrangler.toml`, ROOT)) && /analytics_engine_datasets/.test(read(`workers/${d}/wrangler.toml`)));
  assert.deepEqual(binders, ["ai-kernel"]);
});

test("AL4. the SSOT and ADR-0015's progress say what is bound and what is not yet written", () => {
  const ssot = read("docs/SSOT.md");
  assert.match(ssot, /Analytics Engine \(ADR-0015 decision 6, phase 3/);
  assert.match(ssot, /cryptophys_agent_runtime/);
  assert.match(ssot, /cryptophys_control_plane/);
  const m = JSON.parse(read("architecture/adr/progress/0015.json")) as { phases: Array<{ id: string; group: string; evidence: { kind: string; reason?: string } }> };
  const p3 = m.phases.find((p) => p.id === "3" && p.group === "platform")!;
  assert.equal(p3.evidence.kind, "not_measurable_yet");
  assert.match(p3.evidence.reason!, /datasets bound on the AI Kernel since 2026-11-22/);
});
