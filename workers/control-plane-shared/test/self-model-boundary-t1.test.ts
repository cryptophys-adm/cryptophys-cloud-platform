// ADR-0016 (Telos) T1, docs/design/TELOS-T1-SELF-MODEL.md §8 "What it never does" (owner 2026-11-22, "setuju semua"): a
// static test of the self-model's modules (control-plane-shared/src/self-model*.ts). They import no kernel, consensus,
// trading, policy or AI module; they make no network, AI, syscall, proposal or executor call; their SQL writes nothing;
// and they read no table outside the §2.1 list of the design. Plain fs reads relative to the repository root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { criticalPathReason } from "../src/guard-paths.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const SRC = "workers/control-plane-shared/src/";
/** Every T1 module, those of later steps included (self-model-kpis.ts in T1c). */
const MODULES = (readdirSync(new URL(SRC, ROOT)) as string[]).filter((f) => /^self-model(-[a-z]+)?\.ts$/.test(f)).sort().map((f) => SRC + f);
/** The code without its comments (the modules explain what they never do, in words the checks look for). */
const code = (p: string) => read(p).split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/ .*$/, "")).join("\n");
const importsOf = (src: string) => [...src.matchAll(/^import\s(type\s)?[^;]*?from\s+"([^"]+)"/gm)].map((m) => ({ spec: m[2], typeOnly: Boolean(m[1]) }));

/** What a T1 module may import: the contract, its own split files, and read-only helpers that hold no action. */
const ALLOWED_IMPORTS = new Set([
  "./self-model.ts", "./self-model-read.ts", "./self-model-sections.ts", "./self-model-assemble.ts", "./self-model-kpis.ts",
  "../../../organism/vision.json", "./vision.ts", "./council.ts", "./deploy-units.ts", "./drift-state.ts", "./organism.ts", "./retired.ts",
  "./teaching-record.ts", "./build-usage.ts",
]);
const FORBIDDEN_IMPORT = /kernel|consensus|trading|policy|ai-engine|analytics|syscall|executor|capabilit|power-mode|autonomy|knowledge|memory|evolver|evolution|cf-usage|audit|secrets|access|http/;

test("T1-B1. the modules import no kernel, consensus, trading, policy or AI module", () => {
  assert.deepEqual(MODULES, [`${SRC}self-model-assemble.ts`, `${SRC}self-model-read.ts`, `${SRC}self-model-sections.ts`, `${SRC}self-model.ts`]);
  for (const m of MODULES) {
    for (const { spec } of importsOf(read(m))) {
      assert.ok(ALLOWED_IMPORTS.has(spec), `${m} imports ${spec}`);
      assert.doesNotMatch(spec, FORBIDDEN_IMPORT, `${m} imports ${spec}`);
      assert.doesNotMatch(spec, /^\.\.\/\.\.\/(ai-kernel|policy-engine|deployment-orchestrator|platform-api|forge|console)\//, `${m} reaches into another Worker: ${spec}`);
    }
  }
  // The helpers they import are read-only themselves: no import of theirs but a type, and council.ts's one constant.
  for (const h of ["deploy-units.ts", "drift-state.ts", "organism.ts", "retired.ts", "teaching-record.ts", "build-usage.ts"]) {
    for (const { spec, typeOnly } of importsOf(read(SRC + h))) assert.ok(typeOnly, `${h} imports ${spec} at run time`);
  }
  assert.deepEqual(importsOf(read(`${SRC}council.ts`)).filter((i) => !i.typeOnly).map((i) => i.spec), ["./capabilities.ts"]);
});

test("T1-B2. no network, AI, telemetry, syscall, proposal, executor or write call, and no clock but the budgets'", () => {
  for (const m of MODULES) {
    const c = code(m);
    for (const banned of [
      /\bfetch\(/, /\benv\./, /\.AI\b/, /ai-engine/, /analytics\//, /\bsyscall\(/, /consensusPropose|proposeConsensus|insertDraft|castVote/, /[Ee]xecutor/,
      /\.run\(/, /\.batch\(/, /\.exec\(/, /appendAuditEvent/, /crypto\.randomUUID/, /new Date\(\)/, /setLevel|setPowerMode|remember\(|propose\(/,
    ]) assert.doesNotMatch(c, banned, `${m}: ${banned}`);
    // The only clock is the run's budget (self-model-read.ts ReadOptions.clock): no value depends on it.
    const clocks = c.match(/Date\.now/g) ?? [];
    if (m.endsWith("self-model-read.ts")) assert.deepEqual([clocks.length, /clock \?\? Date\.now/.test(c)], [1, true]);
    else assert.equal(clocks.length, 0, m);
  }
  // The D1 interface the readers take has no write method: prepare, bind, first and all only.
  const r = read(`${SRC}self-model-read.ts`);
  const iface = r.slice(r.indexOf("export interface SelfModelStatement"), r.indexOf("/** §5.4: at most this many statements"));
  assert.match(iface, /first<T/);
  assert.match(iface, /all<T/);
  assert.doesNotMatch(iface, /\brun\b|\bbatch\b|\bexec\b/);
});

test("T1-B3. their SQL writes nothing", () => {
  for (const m of MODULES) {
    const c = code(m);
    assert.doesNotMatch(c, /\b(INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|REPLACE\s+INTO|UPSERT|CREATE\s+(TABLE|INDEX|TRIGGER|VIEW)|DROP\s+(TABLE|INDEX)|ALTER\s+TABLE|PRAGMA|ATTACH)\b/i, m);
    assert.doesNotMatch(c, /ON CONFLICT/i, m);
    // Every SQL text is a SELECT.
    for (const lit of c.matchAll(/`([^`]*)`|"((?:[^"\\]|\\.)*)"/g)) {
      const sql = (lit[1] ?? lit[2] ?? "").trim();
      if (/^(SELECT|WITH)\b/i.test(sql) || /\bFROM\s+[a-z_]+/.test(sql) && /^[A-Z]/.test(sql)) assert.match(sql, /^SELECT\s/, `${m}: ${sql.slice(0, 80)}`);
    }
  }
});

/** The tables of §2.1: the backticked names in the first column of its table. */
function designTables(): Set<string> {
  const doc = read("docs/design/TELOS-T1-SELF-MODEL.md");
  const part = doc.slice(doc.indexOf("### 2.1 Sources the self-model can read"), doc.indexOf("### 2.2 What else exists"));
  const out = new Set<string>();
  for (const line of part.split("\n").filter((l) => l.startsWith("| ") && !l.startsWith("| Source") && !l.startsWith("|---"))) {
    for (const m of line.split("|")[1].matchAll(/`([a-z][a-z0-9_]*)`/g)) out.add(m[1]);
  }
  return out;
}

test("T1-B4. they read no table outside the §2.1 list", () => {
  const allowed = designTables();
  for (const t of ["agent_reports", "observer_vitals", "observer_findings", "observer_runs", "forge_organism_census", "service_registry", "deployment_requests",
    "drift_observations", "consensus_proposals", "consensus_controls", "kernel_controls", "autonomy_dial", "adr_progress", "knowledge_proposals", "corrections",
    "councils", "evolution_intents_v2", "evolutions_v2", "evolver_controls", "ai_usage", "ai_failures", "infra_burn_metrics", "metabolism_controls", "forge_builds",
    "forge_dependency_audits", "forge_change_requests", "agent_memories", "agents"]) assert.ok(allowed.has(t), `the §2.1 parse lost ${t}`);
  const seen = new Set<string>();
  for (const m of MODULES) {
    for (const x of code(m).matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/g)) {
      if (x[1] === "json_each") continue;
      seen.add(x[1]);
      assert.ok(allowed.has(x[1]), `${m} reads ${x[1]}, which §2.1 does not list`);
    }
  }
  // §8: never the parameters, the treasury, deals or another organ's data, and never the telemetry store.
  for (const t of ["policy_parameters", "metabolism_cycles", "audit_events", "agent_actions", "syscall_consumptions", "self_model_snapshots"]) assert.ok(!seen.has(t), t);
  assert.ok(seen.size >= 25, `${seen.size} tables read`);
});

test("T1-B5. no identity, text or price leaves the readers: the sections never touch actor, body_json or a deal", () => {
  const sections = code(`${SRC}self-model-sections.ts`) + code(`${SRC}self-model-assemble.ts`);
  for (const banned of [/\bactor\b/, /target_ref/, /body_json/, /findings_json/, /\bemail\b/, /profit|treasury|balance|deal/i, /detail\b/]) assert.doesNotMatch(sections, banned, String(banned));
  const reader = code(`${SRC}self-model-read.ts`);
  // A body_json is read in two readers only: the trading organ's, straight into the whitelist, and adr_progress's, inside
  // SQL (json_type and json_array_length of its drift and stale fields).
  const block = (id: string) => reader.slice(reader.indexOf(`  ${id}: {\n    id: "${id}"`), reader.indexOf("\n  },\n", reader.indexOf(`  ${id}: {\n    id: "${id}"`)));
  const organ = block("trading_organ_health"), adrs = block("adr_progress");
  assert.ok(organ.length > 0 && adrs.length > 0);
  assert.doesNotMatch(reader.replace(organ, "").replace(adrs, ""), /body_json/);
  assert.match(adrs, /json_type\(body_json, '\$\.stale'\)/);
  assert.doesNotMatch(adrs.replace(/`[^`]*`/g, ""), /body_json/, "adr_progress's body never leaves the SQL");
  assert.match(reader, /health: OrganHealth/);
  assert.match(reader, /organHealthWhitelist\(str\(r\.body_json\)\)/);
  // The correction text is never selected; actor and target_ref feed teachingRecord inside the reader only.
  const corr = reader.slice(reader.indexOf("corrections: {\n    id: \"corrections\""), reader.indexOf("knowledge_proposals: {\n    id:"));
  assert.doesNotMatch(corr, /SELECT[^`]*\bbody_json\b/);
  assert.match(corr, /rows = raw\.map\(\(r\) => \(\{ label: str\(r\.label\), source: str\(r\.source\), side: str\(r\.side\), created_at: str\(r\.created_at\) \}\)\)/);
});

test("T1-B6. the T1 files touch no guard path", () => {
  for (const p of [...MODULES, "workers/control-plane-shared/test/self-model-assemble-t1b.test.ts", "workers/control-plane-shared/test/self-model-boundary-t1.test.ts",
    "docs/design/TELOS-T1-SELF-MODEL.md", "docs/SSOT.md"]) assert.equal(criticalPathReason(p), null, p);
});
