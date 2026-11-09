// ADR-0013 phase 1: the platform's DNA (workers/<dir>/organism.json) is the single source of its
// knowledge of itself. Every static list that must stay in code or workflows (deploy units, drift
// probes, Access, rollback, council seats, kernel agents, vote bindings, AI engines, service names)
// must equal what the DNA declares, so adding a Worker, agent or engine can never be silently missed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { DNA_FILE, agentsOf, genomeFrom, parseDna, servicesWhere, voters, type Genome } from "../src/organism.ts";
import { DEPLOY_UNITS } from "../src/deploy-units.ts";
import { KERNEL_AGENTS, VOTERS } from "../src/consensus-rules.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const exists = (p: string) => existsSync(new URL(p, ROOT));
const WORKER_DIRS = readdirSync(new URL("workers/", ROOT), { withFileTypes: true })
  .filter((d) => d.isDirectory() && exists(`workers/${d.name}/wrangler.toml`)).map((d) => d.name).sort();
const genome: Genome = genomeFrom(WORKER_DIRS.filter((d) => exists(`workers/${d}/${DNA_FILE}`)).map((d) => ({ path: `workers/${d}/${DNA_FILE}`, text: read(`workers/${d}/${DNA_FILE}`) })));
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const wranglerServices = (dir: string) => {
  const out: Record<string, string> = {};
  for (const block of read(`workers/${dir}/wrangler.toml`).split("[[services]]").slice(1)) {
    const b = /^binding = "([A-Z0-9_]+)"/m.exec(block)?.[1]; const s = /^service = "([a-z0-9-]+)"/m.exec(block)?.[1];
    if (b && s) out[b] = s;
  }
  return out;
};

test("O1. every Worker in the repository has DNA naming itself", () => {
  for (const dir of WORKER_DIRS) {
    assert.ok(exists(`workers/${dir}/${DNA_FILE}`), `workers/${dir} has no ${DNA_FILE}`);
    const name = /^name = "([a-z0-9-]+)"/m.exec(read(`workers/${dir}/wrangler.toml`))?.[1];
    assert.equal(parseDna(read(`workers/${dir}/${DNA_FILE}`)).service, name, `workers/${dir}: DNA service = wrangler name`);
  }
  assert.equal(genome.size, WORKER_DIRS.length);
});

test("O2. the DNA validator refuses malformed genes", () => {
  const ok = JSON.parse(read("workers/platform-api/organism.json"));
  const bad = (patch: Record<string, unknown>, re: RegExp) => assert.throws(() => parseDna(JSON.stringify({ ...ok, ...patch })), re);
  bad({ $schema_version: 2 }, /schema_version/);
  bad({ service: "evil" }, /service/);
  bad({ kind: "organ" }, /kind/);
  bad({ drift: { via: "rpc" } }, /drift/);
  bad({ agents: [{ ...ok.agents[0], capabilities: ["Trade.Execute!"] }] }, /capabilities/);
  bad({ agents: [ok.agents[0], { ...ok.agents[0], id: "second-voter", vote_binding: "VOTE_SECOND" }] }, /one vote per Worker/);
  bad({ agents: [{ ...ok.agents[0], voter: false }] }, /vote_binding/);
  bad({ engines: [{ task: "x" }] }, /engine/);
  bad({ kind: "build-stub" }, /build stub/);
  assert.throws(() => genomeFrom([{ path: "a", text: JSON.stringify(ok) }, { path: "b", text: JSON.stringify(ok) }]), /declared twice/);
});

test("O3. deploy units ship exactly the Workers the DNA assigns them", () => {
  for (const unit of DEPLOY_UNITS) assert.deepEqual(sorted(unit.services), servicesWhere(genome, (d) => d.deploy_unit === unit.unit), unit.unit);
  assert.deepEqual(sorted(DEPLOY_UNITS.map((u) => u.unit)), sorted([...genome.values()].map((d) => d.deploy_unit).filter((u): u is string => !!u)));
  const wf = read(".github/workflows/deploy-control-plane.yml");
  const order = /DEPLOY_ORDER: "([a-z -]+)"/.exec(wf)![1].split(" ").map((d) => `cryptophys-${d}`);
  const expected = /EXPECTED_WORKERS: "([a-z -]+)"/.exec(wf)![1].split(" ");
  const cp = servicesWhere(genome, (d) => d.deploy_unit === "control-plane");
  assert.deepEqual(sorted(order), cp, "deploy-control-plane.yml DEPLOY_ORDER");
  assert.deepEqual(sorted(expected), cp, "deploy-control-plane.yml EXPECTED_WORKERS");
});

test("O4. the Drift Detector probes every Worker the DNA says it observes, through the declared bindings", () => {
  const src = read("workers/drift-detector/src/index.ts");
  const body = src.slice(src.indexOf("export function targets"), src.indexOf("export function externalTargets"));
  const probed = Object.fromEntries([...body.matchAll(/"(cryptophys-[a-z-]+)": env\.([A-Z_]+)/g)].map((m) => [m[1], m[2]]));
  const declared = Object.fromEntries([...genome.values()].filter((d) => d.drift?.via === "rpc").map((d) => [d.service, (d.drift as { binding: string }).binding]));
  assert.deepEqual(probed, declared);
  const bindings = wranglerServices("drift-detector");
  for (const [service, binding] of Object.entries(declared)) assert.equal(bindings[binding], service, `drift-detector/wrangler.toml ${binding} -> ${service}`);
  assert.deepEqual(servicesWhere(genome, (d) => d.drift?.via === "self"), ["cryptophys-drift-detector"]);
});

test("O5. Access protects and rollback allows exactly the Workers the DNA says", () => {
  const access = /PLATFORM_WORKERS: >-\n((?:\s+[a-z -]+\n)+)/.exec(read(".github/workflows/provision-access.yml"))![1].split(/\s+/).filter(Boolean);
  assert.deepEqual(sorted(access), servicesWhere(genome, (d) => d.access), "provision-access.yml PLATFORM_WORKERS");
  const rollback = /case "\$WORKER" in\n\s+([a-z|-]+)\)/.exec(read(".github/workflows/rollback-worker.yml"))![1].split("|");
  assert.deepEqual(sorted(rollback), servicesWhere(genome, (d) => d.rollback), "rollback-worker.yml allow-list");
});

test("O6. the council and the kernel agents are what the DNA declares; every vote binding exists", () => {
  assert.deepEqual(sorted(VOTERS), voters(genome), "VOTERS (consensus-rules.ts)");
  assert.deepEqual(sorted(KERNEL_AGENTS), agentsOf(genome, "cryptophys-ai-kernel"), "KERNEL_AGENTS (consensus-rules.ts)");
  // The Console's Wake button lists the kernel agents that have a wake implementation: all of them.
  const ui = /const KERNEL_AGENTS = (\[[^\]]+\])/.exec(read("workers/console/ui/src/pages/AgentDetail.tsx"))![1];
  assert.deepEqual(sorted(JSON.parse(ui)), agentsOf(genome, "cryptophys-ai-kernel"), "AgentDetail.tsx KERNEL_AGENTS");
  const consensus = read("workers/ai-kernel/src/consensus.ts");
  const mapped = Object.fromEntries([...consensus.slice(consensus.indexOf("const VOTE_BINDINGS")).split("};")[0].matchAll(/"([a-z-]+)": "(VOTE_[A-Z_]+)"/g)].map((m) => [m[1], m[2]]));
  const declared = Object.fromEntries([...genome.values()].flatMap((d) => d.agents.filter((a) => a.vote_binding).map((a) => [a.id, a.vote_binding!])));
  assert.deepEqual(mapped, declared, "VOTE_BINDINGS (ai-kernel/src/consensus.ts)");
  const bindings = wranglerServices("ai-kernel");
  for (const d of genome.values()) for (const a of d.agents) if (a.vote_binding) assert.equal(bindings[a.vote_binding], d.service, `ai-kernel/wrangler.toml ${a.vote_binding} -> ${d.service}`);
});

test("O7. every AI engine a Worker runs is declared in its DNA, and nothing more", () => {
  for (const dir of WORKER_DIRS) {
    const dna = parseDna(read(`workers/${dir}/${DNA_FILE}`));
    const src = readdirSync(new URL(`workers/${dir}/src/`, ROOT), { recursive: true }).map(String).filter((f) => f.endsWith(".ts"))
      .map((f) => read(`workers/${dir}/src/${f}`)).join("\n");
    const tasks = [...src.matchAll(/AiTask<[^>]+>\s*(?:=\s*)?\{?[\s\S]{0,40}?name: "([a-z_]+)"/g)].map((m) => m[1]);
    assert.deepEqual(sorted(tasks), sorted(dna.engines.map((e) => e.task)), `workers/${dir}: engines`);
  }
});

test("O8. every service the DNA declares has a plain-English name, and every DNA agent was seeded", () => {
  const plain = read("workers/control-plane-shared/src/plain.ts");
  for (const d of genome.values()) {
    if (d.kind === "build-stub") continue;
    assert.ok(plain.includes(`"${d.service}": "${d.display_name}"`), `plain.ts SERVICE_NAMES has ${d.service}: ${d.display_name}`);
  }
  const migrations = readdirSync(new URL("workers/control-plane-migrations/", ROOT)).filter((f) => f.endsWith(".sql")).map((f) => read(`workers/control-plane-migrations/${f}`)).join("\n");
  for (const d of genome.values()) for (const a of d.agents) assert.match(migrations, new RegExp(`'${a.id}'\\s*,\\s*'[^']*'\\s*,\\s*'${d.service}'`), `agent ${a.id} seeded on ${d.service}`);
});
