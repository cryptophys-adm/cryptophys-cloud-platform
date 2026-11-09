// ADR-0013 phase 2: the Forge's organism census compares the DNA of main's head with the live
// registries and records what differs; the AI Kernel raises it to the owner (topic "organism").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OPERATOR_JWT, OUTSIDER_JWT, baseEnv, call, migratedDb, req } from "./harness.ts";
import forge, { FORGE_MIGRATIONS } from "../../forge/src/index.ts";
import { censusTick, compare, latestCensus, readGenome } from "../../forge/src/census.ts";
import { collectNotices } from "../../ai-kernel/src/owner-notices.ts";
import type { ArtifactsReader, ArtifactsTreeEntry } from "../../forge/src/checks.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const MAIN = "9".repeat(40);
const DIRS = ["ai-kernel", "audit-ledger", "console", "deployment-orchestrator", "drift-detector", "forge", "forge-typecheck", "home", "platform-api", "platform-registry", "policy-engine", "recovery-manager"];

/** An Artifacts repo whose main head holds workers/<dir>/organism.json files. */
function repoWith(files: Record<string, string>, head = MAIN): ArtifactsReader {
  const trees: Record<string, ArtifactsTreeEntry[]> = {}; const blobs: Record<string, string> = {}; let n = 1;
  const id = () => (n++).toString(16).padStart(40, "e");
  function build(f: Record<string, string>): string {
    const here: Record<string, Record<string, string>> = {}; const entries: ArtifactsTreeEntry[] = [];
    for (const [p, t] of Object.entries(f)) {
      const i = p.indexOf("/");
      if (i < 0) { const h = id(); blobs[h] = t; entries.push({ name: p, type: "blob", mode: "100644", hash: h }); }
      else (here[p.slice(0, i)] ??= {})[p.slice(i + 1)] = t;
    }
    for (const [d, sub] of Object.entries(here)) entries.push({ name: d, type: "tree", mode: "40000", hash: build(sub) });
    const h = id(); trees[h] = entries; return h;
  }
  const root = build(files);
  return {
    async readCommit(h) { return h === head ? { hash: h, treeHash: root } : null; },
    async readTree(h) { return trees[h] ?? null; },
    async readBlob(h) { return h in blobs ? new Blob([blobs[h]]) : null; },
    async log() { return [{ hash: head }]; },
  };
}
const realDna = () => Object.fromEntries(DIRS.map((d) => [`workers/${d}/organism.json`, read(`workers/${d}/organism.json`)]));

test("C1. the repository's own DNA matches the migrated registries: a consistent census", async () => {
  const db = migratedDb();
  const repo = repoWith({ ...realDna(), "workers/control-plane-shared/package.json": "{}", "README.md": "x" });
  const { genome, files } = await readGenome(repo, MAIN);
  assert.equal(files, 12);
  assert.equal(genome.size, 12);
  assert.deepEqual(await compare(db as never, genome), []);
  assert.deepEqual(await censusTick(db as never, repo), { outcome: "recorded", main_sha: MAIN, status: "consistent", findings: 0 });
  assert.equal((await censusTick(db as never, repo)).outcome, "up_to_date", "once per main commit");
  const row = (await latestCensus(db as never)).census[0];
  assert.deepEqual([row.status, row.organs, row.agents, row.voters, row.engines], ["consistent", 12, 10, 9, 9]);
});

test("C2. findings: an unregistered organ and agent (with its council request), an undeclared agent, host and capability changes", async () => {
  const db = migratedDb();
  const dna = realDna();
  const forgeDna = JSON.parse(dna["workers/forge/organism.json"]);
  forgeDna.agents = [{ id: "forge-steward", display_name: "Forge Steward", capabilities: ["platform.observe"], tier_max: 1, voter: true, vote_binding: "VOTE_FORGE" }];
  const kernel = JSON.parse(dna["workers/ai-kernel/organism.json"]);
  kernel.agents = kernel.agents.filter((a: any) => a.id !== "signal-analyst");
  kernel.agents.find((a: any) => a.id === "auditor").capabilities = ["audit.verify"];
  const newWorker = { ...JSON.parse(dna["workers/home/organism.json"]), service: "cryptophys-new-organ", display_name: "New Organ", deploy_unit: "home" };
  const repo = repoWith({ ...dna, "workers/forge/organism.json": JSON.stringify(forgeDna), "workers/ai-kernel/organism.json": JSON.stringify(kernel), "workers/new-organ/organism.json": JSON.stringify(newWorker) });
  db.raw.prepare("UPDATE agents SET host_worker = 'cryptophys-console' WHERE agent_id = 'policy-engine'").run();
  const findings = await compare(db as never, (await readGenome(repo, MAIN)).genome);
  assert.deepEqual(findings.map((f) => `${f.kind}:${f.subject}`), [
    "agent_capabilities_changed:auditor", "agent_host_changed:policy-engine", "undeclared_agent:signal-analyst",
    "unregistered_agent:forge-steward", "unregistered_service:cryptophys-new-organ",
  ]);
  assert.match(findings.find((f) => f.subject === "forge-steward")!.detail, /asks for a council seat/);
  await censusTick(db as never, repo);
  const audit = (db as any).raw.prepare("SELECT outcome FROM audit_events WHERE event_type = 'forge.organism_census'").all().map((r: any) => r.outcome);
  assert.deepEqual(audit, ["changes"]);
  // The owner sees it among the notices.
  const notice = (await collectNotices(db as never)).find((n) => n.topic === "organism")!;
  assert.deepEqual([notice.active, notice.lines.length], [true, 5]);
  assert.match(notice.title, /differ: 5 item/);
});

test("C3. an invalid DNA is recorded as invalid, never thrown away; unchanged findings are not audited twice", async () => {
  const db = migratedDb();
  const bad = repoWith({ ...realDna(), "workers/forge/organism.json": "{ not json" });
  assert.equal((await censusTick(db as never, bad)).status, "invalid");
  assert.equal((await latestCensus(db as never)).census[0].findings[0].kind, "invalid_dna");
  const db2 = migratedDb();
  await censusTick(db2 as never, repoWith(realDna(), "1".repeat(40)));
  await censusTick(db2 as never, repoWith(realDna(), "2".repeat(40)));
  assert.equal((db2 as any).raw.prepare("SELECT count(*) n FROM audit_events WHERE event_type = 'forge.organism_census'").get().n, 1, "the second census found nothing new");
  assert.equal((await collectNotices(db2 as never)).find((n) => n.topic === "organism")!.active, false);
});

test("C4. GET /v1/forge/census for operators; migration 0040 required; the tick takes the census", async () => {
  const db = migratedDb();
  await censusTick(db as never, repoWith(realDna()));
  const env = baseEnv("cryptophys-forge", db);
  const r = await call(forge, env, req("GET", "/v1/forge/census?limit=1", undefined, OPERATOR_JWT));
  assert.deepEqual([r.status, r.body.census[0].status, r.body.census[0].genome.length], [200, "consistent", 12]);
  assert.equal((await call(forge, env, req("GET", "/v1/forge/census", undefined, OUTSIDER_JWT))).status, 403);
  assert.ok((FORGE_MIGRATIONS as readonly string[]).includes("0040_forge_organism_census.sql"));
  assert.match(read("workers/forge/src/tick.ts"), /step\("census"/);
  assert.match(read("workers/console/src/index.ts"), /"\/v1\/forge\/census"/);
});

test("C5. tier_max drift is reported rather than silently accepted", async () => {
  const db = migratedDb();
  db.raw.prepare("UPDATE agents SET tier_max = 0 WHERE agent_id = 'supervisor'").run();
  const findings = await compare(db as never, (await readGenome(repoWith(realDna(), "3".repeat(40)), "3".repeat(40))).genome);
  assert.deepEqual(findings.map((f) => `${f.kind}:${f.subject}`), ["agent_tier_changed:supervisor"]);
  const r = await censusTick(db as never, repoWith(realDna(), "3".repeat(40)));
  assert.deepEqual([r.status, r.findings], ["changes", 1]);
});

test("C6. a partially applied phase-3 schema fails closed when engines is missing", async () => {
  const db = migratedDb();
  db.raw.prepare("DROP TABLE engines").run();
  const r = await censusTick(db as never, repoWith(realDna()));
  assert.equal(r.status, "invalid");
  const row = (await latestCensus(db as never)).census[0];
  assert.equal(row.findings[0].kind, "invalid_dna");
  assert.match(row.findings[0].detail, /no such table: engines/i);
});

test("C7. unexpected registry query errors do not fall back to the legacy schema", async () => {
  const db = migratedDb();
  const broken = new Proxy(db as never, {
    get(target: any, property: string | symbol) {
      if (property === "prepare") return (sql: string) => {
        if (String(sql).includes("SELECT agent_id, host_worker, capabilities_json, tier_max, voter FROM agents")) throw new Error("database is locked");
        return target.prepare(sql);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const r = await censusTick(broken as never, repoWith(realDna()));
  assert.equal(r.status, "invalid");
  const row = (await latestCensus(db as never)).census[0];
  assert.equal(row.findings[0].kind, "invalid_dna");
  assert.match(row.findings[0].detail, /database is locked/);
});
