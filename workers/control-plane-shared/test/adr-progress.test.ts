// The ADR Steward, step 1 (docs/design/ADR-STEWARD.md §2.2, §8, §11; owner 2026-11-16, "ya semua, sesuai
// rekomendasimu"): every ADR has a progress manifest in architecture/adr/progress/ (adr.progress.v1). This test checks
// the schema, that each manifest's document quotes are on this commit, its lifecycle against the ADR's Status line,
// its dependencies, its `built` paths and the names its evidence uses, and that the manifests of the guarded ADRs are
// guard paths (Q2). Plain fs reads relative to the repository root, so the Forge runner can bundle it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import {
  ADR_PREDICATE_KINDS, ADR_PROGRESS_SCHEMA, ADR_READINGS, ADR_REPORT_KINDS, MAX_PREDICATE_DEPTH, adrManifestProblems, parseAdrManifest, predicateLeaves,
  type AdrManifest, type AdrPredicate,
} from "../src/adr-progress.ts";
import { CRITICAL_PATHS, criticalPathReason } from "../src/guard-paths.ts";
import { CONSENSUS_ACTIONS } from "../src/consensus-rules.ts";
import { pathRefusal } from "../src/evolution-limits.ts";
import { criticalReasons } from "../../forge/src/changes.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");
const exists = (p: string) => existsSync(new URL(p, ROOT));
const isFile = (p: string) => exists(p) && statSync(new URL(p, ROOT)).isFile();
const list = (dir: string) => readdirSync(new URL(dir.endsWith("/") ? dir : dir + "/", ROOT)) as string[];

const PROGRESS = "architecture/adr/progress/";
const manifestFiles = () => list(PROGRESS).filter((f) => f.endsWith(".json")).sort();
const manifestText = (f: string) => read(PROGRESS + f);
const manifests = (): AdrManifest[] => manifestFiles().map((f) => JSON.parse(manifestText(f)));
const adrFiles = () => list("architecture/adr/").filter((f) => /^[0-9]{4}-[a-z0-9-]+\.md$/.test(f)).sort();
const statusLine = (adrFile: string) => read(adrFile).split("\n").find((l) => l.startsWith("- **Status:**")) ?? "";
const leaves = (m: AdrManifest) => m.phases.flatMap((ph) => predicateLeaves(ph.evidence).map((p) => ({ phase: ph.id, p })));
const byId = (id: string) => manifests().find((m) => m.adr === id)!;

test("AP1. every file in architecture/adr/progress/ is a valid adr.progress.v1 named <adr>.json, as 2-space JSON with a trailing newline", () => {
  const files = list(PROGRESS);
  assert.ok(files.length >= 20);
  for (const f of files) {
    assert.match(f, /^[0-9]{4}\.json$/, `only <NNNN>.json files live in ${PROGRESS}`);
    const m = JSON.parse(manifestText(f));
    assert.deepEqual(adrManifestProblems(m, f), [], `${f} is invalid`);
    assert.equal(m.schema, ADR_PROGRESS_SCHEMA);
    assert.equal(manifestText(f), JSON.stringify(m, null, 2) + "\n", `${f}: 2-space JSON with a trailing newline`);
    assert.ok(parseAdrManifest(m, f));
  }
});

test("AP2. broken manifests are refused, each with a problem that names where it is", () => {
  const base = () => structuredClone(byId("0012")) as any;
  const problemsOf = (mutate: (m: any) => unknown, file = "0012.json") => { const m = base(); const r = mutate(m); return adrManifestProblems(r === undefined ? m : r, file); };
  const fails = (mutate: (m: any) => unknown, where: RegExp, file?: string) => {
    const p = problemsOf(mutate, file);
    assert.ok(p.some((x) => where.test(x)), `expected a problem matching ${where}, got ${JSON.stringify(p)}`);
  };
  for (const bad of [null, [], "x", 1]) assert.ok(adrManifestProblems(bad).length > 0, JSON.stringify(bad));
  assert.deepEqual(problemsOf(() => undefined), []);
  // Top level.
  fails((m) => { m.schema = "adr.progress.v2"; }, /^manifest\.schema/);
  fails((m) => { m.adr = "12"; }, /^manifest\.adr: must match/);
  fails(() => undefined, /^manifest\.adr: "0012" does not match the file name 0013\.json/, "0013.json");
  fails((m) => { m.title = "x"; }, /^manifest\.title/);
  fails((m) => { m.lifecycle = "done"; }, /^manifest\.lifecycle: must be one of/);
  fails((m) => { m.status = "done"; }, /^manifest\.status: unknown field/);
  fails((m) => { m.adr_file = "architecture/adr/0013-living-platform.md"; }, /^manifest\.adr_file: must be ADR-0012's file/);
  fails((m) => { m.adr_file = "docs/SSOT.md"; }, /^manifest\.adr_file: must match/);
  fails((m) => { m.adr_file = null; }, /^manifest\.adr_file: required when the lifecycle is accepted/);
  fails((m) => { m.lifecycle = "held"; m.lifecycle_note = "on a branch"; }, /^manifest\.adr_file: must be null when the lifecycle is held/);
  fails((m) => { m.lifecycle = "planned"; m.adr_file = null; }, /^manifest\.lifecycle_note: required when the lifecycle is planned/);
  fails((m) => { m.lifecycle = "superseded"; }, /^manifest\.superseded_by: required/);
  fails((m) => { m.superseded_by = "0020"; }, /^manifest\.superseded_by: only for a superseded ADR/);
  fails((m) => { m.scope = "github"; }, /^manifest\.scope/);
  fails((m) => { m.fits = ["19:P0"]; }, /^manifest\.fits\[0\]/);
  fails((m) => { m.groups.push({ id: "gates", title: "again" }); }, /^manifest\.groups\[2\]\.id: duplicate/);
  fails((m) => { m.groups[0].id = "Gates"; }, /^manifest\.groups\[0\]\.id: must match/);
  fails((m) => { m.phases = {}; }, /^manifest\.phases: must be an array/);
  fails((m) => { m.phases = Array.from({ length: 41 }, (_, i) => ({ id: `P${i}`, title: "x", evidence: { kind: "not_measurable_yet", reason: "x" } })); }, /^manifest\.phases: at most 40/);
  // Phases.
  fails((m) => { m.phases[1].id = m.phases[0].id; }, /^phases\[1\]\.id: duplicate/);
  fails((m) => { m.phases[0].id = "-G1"; }, /^phases\[0\]\.id: must match/);
  fails((m) => { m.phases[0].group = "nope"; }, /^phases\[0\]\.group: must name a group/);
  fails((m) => { m.phases[0].weight = 6; }, /^phases\[0\]\.weight/);
  fails((m) => { m.phases[0].weight = 1.5; }, /^phases\[0\]\.weight/);
  fails((m) => { m.phases[0].status = "done"; }, /^phases\[0\]\.status: unknown field/);
  fails((m) => { delete m.phases[0].evidence; }, /^phases\[0\]\.evidence: required/);
  fails((m) => { m.phases[0].depends_on = ["G99"]; }, /^phases\[0\]\.depends_on\[0\]: "G99" names no phase/);
  fails((m) => { m.phases[0].depends_on = ["G1"]; }, /^phases\[0\]\.depends_on\[0\]: a phase cannot depend on itself/);
  fails((m) => { m.phases[0].depends_on = ["0012:G99"]; }, /names no phase of this manifest/);
  assert.deepEqual(problemsOf((m) => { m.phases[0].depends_on = ["0016:T1", "0012:G2"]; }), [], "another ADR's phase is checked across manifests (AP6)");
  fails((m) => { m.phases[0].built = []; }, /^phases\[0\]\.built: must be a non-empty array/);
  fails((m) => { m.phases[0].built = [".github/workflows/ci.yml"]; }, /^phases\[0\]\.built\[0\]: must start with/);
  fails((m) => { m.phases[0].built = ["workers/../.github/x"]; }, /^phases\[0\]\.built\[0\]: must be a repository-relative path/);
  fails((m) => { m.phases[0].doc_claim = { state: "finished", ref: "docs/SSOT.md", quote: "abcdef" }; }, /\.doc_claim\.state/);
  fails((m) => { m.phases[0].doc_claim = { state: "done", ref: "/etc/passwd", quote: "abcdef" }; }, /\.doc_claim\.ref: must be a repository-relative path/);
  fails((m) => { m.phases[0].doc_claim = { state: "done", ref: "docs/SSOT.md", quote: "abc" }; }, /\.doc_claim\.quote: must be 6–200/);
  fails((m) => { m.phases[0].owner_action = { text: "click", href: "#/vision" }; }, /\.owner_action\.href/);
  fails((m) => { m.phases[0].owner_action = { text: "click", outside_platform: "yes" }; }, /\.owner_action\.outside_platform/);
  fails((m) => { m.phases[0].next = "x".repeat(161); }, /^phases\[0\]\.next/);
  // Predicates: kinds, their own fields, unknown fields, combinators and depth.
  const ev = (e: unknown) => (m: any) => { m.phases[0].evidence = e; };
  fails(ev({ kind: "sql", query: "SELECT 1" }), /\.evidence\.kind: must be one of/);
  fails(ev({ kind: "migration_applied", name: "0073" }), /\.evidence\.name: must be a migration file name/);
  fails(ev({ kind: "migration_applied", name: "0073_platform_identities.sql", sql: "x" }), /\.evidence\.sql: unknown field/);
  fails(ev({ kind: "audit_event" }), /\.evidence\.event_type: required for audit_event/);
  fails(ev({ kind: "audit_event", event_type: "merged" }), /\.evidence\.event_type: must match/);
  fails(ev({ kind: "audit_event", event_type: "forge.merged", payload: { executor: "x" } }), /\.payload\.executor: must be a JSON path/);
  fails(ev({ kind: "audit_event", event_type: "forge.merged", payload: { "$.a": 1, "$.b": 2, "$.c": 3, "$.d": 4 } }), /\.payload: must hold 1–3 paths/);
  fails(ev({ kind: "audit_event", event_type: "forge.merged", payload: { "$.a": null } }), /\.payload\.\$\.a: must be a string/);
  fails(ev({ kind: "audit_event", event_type: "forge.merged", min_count: 0 }), /\.min_count/);
  fails(ev({ kind: "audit_event", event_type: "forge.merged", since: "yesterday" }), /\.since: must be an ISO date/);
  fails(ev({ kind: "quiet_window", fail_types: [], success_type: "deployment.native_deploy_succeeded", hours: 24 }), /\.fail_types: must be a non-empty array/);
  fails(ev({ kind: "quiet_window", fail_types: ["a.b"], success_type: "deployment.native_deploy_succeeded", hours: 0 }), /\.hours/);
  fails(ev({ kind: "deploy_step", step: "unit:smoke_passed", step_suffix: ":smoke_passed" }), /exactly one of step or step_suffix/);
  fails(ev({ kind: "deploy_step" }), /exactly one of step or step_suffix/);
  fails(ev({ kind: "deploy_step", step_suffix: "topology_planned" }), /\.step_suffix: must start with ":"/);
  fails(ev({ kind: "merged_and_deployed", cr_id: "fg-x" }), /\.unit: required/);
  fails(ev({ kind: "merged_and_deployed", unit: "forge" }), /exactly one of cr_id or branch/);
  fails(ev({ kind: "census_clean", max_age_h: 0 }), /\.max_age_h/);
  fails(ev({ kind: "observer", source: "logs" }), /\.source: must be findings, vitals or runs/);
  fails(ev({ kind: "observer", source: "runs", expect: "many" }), /\.expect/);
  fails(ev({ kind: "kpi_threshold", source: "report_metric", metric: "m", op: ">", value: 1, max_age_h: 24, agent_id: "a", body_schema: "s" }), /\.op/);
  fails(ev({ kind: "kpi_threshold", source: "report_metric", metric: "m", op: ">=", value: 1, max_age_h: 24 }), /\.agent_id: required for report_metric/);
  fails(ev({ kind: "kpi_threshold", source: "observer_vitals", metric: "m", op: ">=", value: "1", max_age_h: 24, agent_id: "a" }), /\.value: must be a number/);
  fails(ev({ kind: "kpi_threshold", source: "observer_vitals", metric: "m", op: ">=", value: 1, max_age_h: 24, agent_id: "a" }), /\.agent_id: only for report_metric/);
  fails(ev({ kind: "consensus_executed", action: "Merge Change" }), /\.action: must be a consensus action name/);
  fails(ev({ kind: "consensus_executed", action: "merge_change", owner_approved: "yes" }), /\.owner_approved: must be a boolean/);
  fails(ev({ kind: "agent_registered", agent_id: "ADR Steward" }), /\.agent_id/);
  // agent_report (ADR-0020's xauusd evidence): a report kind, an agent, a body schema; body paths and item fields bounded.
  const rep = { kind: "agent_report", report_kind: "xauusd_digest", agent_id: "xauusd-risk-manager", body_schema: "strategy_arm.v1" };
  fails(ev({ ...rep, report_kind: "trade_order" }), /\.report_kind: must be one of/);
  fails(ev({ ...rep, agent_id: undefined }), /\.agent_id: (required|must be an agent id)/);
  fails(ev({ ...rep, agent_id: "xauusd-*" }), /\.agent_id: must be an agent id/);
  fails(ev({ ...rep, body_schema: "strategy arm" }), /\.body_schema: must be a body schema/);
  fails(ev({ ...rep, origin: "Xauusd Repo!" }), /\.origin: must be a repository or service name/);
  fails(ev({ ...rep, body: { mode: "auto" } }), /\.body\.mode: must be a JSON path/);
  fails(ev({ ...rep, body: { "$.schema": "x" } }), /\.body\.\$\.schema: use body_schema or origin/);
  fails(ev({ ...rep, body: { "$.a": 1, "$.b": 2, "$.c": 3, "$.d": 4 } }), /\.body: must hold 1–3 paths/);
  fails(ev({ ...rep, body: { "$.mode": ["auto"] } }), /\.body\.\$\.mode: must be a string, number or boolean/);
  fails(ev({ ...rep, item: { "$.event": "armed" } }), /\.item\.\$\.event: must be a field name/);
  fails(ev({ ...rep, item: { event: [] } }), /\.item\.event: must be a string, number or boolean, or a list of 1–4/);
  fails(ev({ ...rep, item: { event: ["a", "b", "c", "d", "e"] } }), /\.item\.event: must be/);
  fails(ev({ ...rep, item: { event: { $ne: 1 } } }), /\.item\.event: must be/);
  fails(ev({ ...rep, since: "yesterday" }), /\.since: must be an ISO date/);
  fails(ev({ ...rep, sql: "1=1" }), /\.sql: unknown field/);
  assert.deepEqual(problemsOf(ev({ ...rep, origin: "xauusd-ai-trading-assistant", body: { "$.mode": "auto" }, item: { event: ["armed", "disarmed"], reason: "owner" }, since: "2026-11-17" })), []);
  assert.deepEqual([...ADR_REPORT_KINDS].sort(), ["audit_digest", "hud_digest", "knowledge_audit", "platform_digest", "signal_digest", "xauusd_digest"]);
  fails(ev({ kind: "reading", name: "everything_fine" }), /\.name: must be one of/);
  fails(ev({ kind: "doc_asserted", ref: "docs/SSOT.md", quote: "short" }), /\.quote: must be 6–200/);
  fails(ev({ kind: "doc_asserted", ref: "../outside.md", quote: "long enough" }), /\.ref: must be a repository-relative path/);
  fails(ev({ kind: "external_asserted", source: "github", ref: "repository archived", as_of: null }), /\.as_of: must be an ISO date/);
  fails(ev({ kind: "external_asserted", source: "gitlab", ref: "x", as_of: "2026-11-16" }), /\.source: must be xauusd, aether, github or branch/);
  fails(ev({ kind: "not_measurable_yet" }), /\.reason: required/);
  fails(ev({ kind: "not_measurable_yet", reason: "" }), /\.reason: must be a non-empty string/);
  fails(ev({ kind: "all_of", of: [] }), /\.of: must hold 1–8 predicates/);
  fails(ev({ kind: "any_of", of: Array.from({ length: 9 }, () => ({ kind: "census_clean" })) }), /\.of: must hold 1–8 predicates/);
  fails(ev({ kind: "all_of", of: [{ kind: "census_clean", hours: 1 }] }), /\.evidence\.of\[0\]\.hours: unknown field/);
  const nested = (depth: number): AdrPredicate => depth === 1 ? { kind: "census_clean" } : { kind: "all_of", of: [nested(depth - 1)] };
  assert.deepEqual(problemsOf(ev(nested(MAX_PREDICATE_DEPTH))), []);
  fails(ev(nested(MAX_PREDICATE_DEPTH + 1)), /nesting deeper than 3 levels/);
  // Every kind of §3 is known, and every reading of §3 is in the fixed list.
  assert.deepEqual([...ADR_PREDICATE_KINDS].sort(), ["agent_registered", "agent_report", "all_of", "any_of", "audit_event", "census_clean", "consensus_executed", "deploy_step",
    "doc_asserted", "external_asserted", "kpi_threshold", "merged_and_deployed", "migration_applied", "not_measurable_yet", "observer", "quiet_window", "reading", "sequence"]);
  assert.equal(ADR_READINGS.length, 8);
  assert.equal(parseAdrManifest({}), null);
});

test("AP3. every ADR on main has a manifest; every manifest has its ADR, or is a held or planned record", () => {
  const ms = manifests();
  const byFile = new Map(ms.filter((m) => m.adr_file).map((m) => [m.adr_file, m]));
  for (const f of adrFiles()) {
    const m = byFile.get(`architecture/adr/${f}`);
    assert.ok(m, `architecture/adr/${f} has no manifest in ${PROGRESS}`);
    assert.equal(m.adr, f.slice(0, 4));
  }
  for (const m of ms) {
    if (m.adr_file) assert.ok(isFile(m.adr_file), `${m.adr}: adr_file ${m.adr_file} exists`);
    else assert.ok(m.lifecycle === "held" || m.lifecycle === "planned", `${m.adr}: no ADR file on main, so held or planned`);
  }
  // §8.4: 0018 is held on its branch and 0019 planned; ADR-0020 is on main (merged 2026-11-17).
  assert.equal(byId("0018").lifecycle, "held");
  assert.equal(byId("0018").adr_file ?? null, null);
  assert.equal(byId("0019").lifecycle, "planned");
  assert.deepEqual(byId("0019").phases, []);
  assert.equal(byId("0020").adr_file, "architecture/adr/0020-standing-trading-authorization.md");
  assert.ok(!exists("architecture/adr/0018-forge-deploys-external-organs.md"), "when ADR-0018 lands on main, its manifest becomes accepted with its adr_file");
  // The ADR index names every ADR on main.
  const index = read("architecture/adr/README.md");
  for (const f of adrFiles()) assert.ok(index.includes(`(${f})`), `README index links ${f}`);
});

test("AP4. the lifecycle agrees with the ADR's Status line", () => {
  for (const m of manifests()) {
    if (!m.adr_file) continue;
    const line = statusLine(m.adr_file);
    assert.ok(line, `${m.adr_file} has a "- **Status:**" line`);
    // "deferred" only when the line says deferred; a bold **deferred** defers the whole ADR (ADR-0014), while a
    // deferred clause (ADR-0002's state backend) leaves it accepted. "superseded" exactly when the line says so.
    if (m.lifecycle === "deferred") assert.match(line, /deferred/i, `${m.adr}: deferred, but the Status line does not say so`);
    if (/\*\*deferred\*\*/i.test(line)) assert.equal(m.lifecycle, "deferred", `${m.adr}: the Status line defers the ADR`);
    assert.equal(m.lifecycle === "superseded", /Superseded/.test(line), `${m.adr}: superseded only when the Status line says "Superseded"`);
    if (m.lifecycle === "accepted" || m.lifecycle === "deferred") assert.match(line, /^- \*\*Status:\*\* Accepted/, `${m.adr}: an accepted ADR`);
  }
  // ADR-0014 was deferred until the owner lifted it on 2026-11-17 (§11, "aktifkan evolver sekarang").
  assert.equal(byId("0014").lifecycle, "accepted");
  assert.doesNotMatch(statusLine(byId("0014").adr_file!), /\*\*deferred\*\*/i);
  assert.equal(byId("0002").lifecycle, "accepted");
});

test("AP5. every document quote occurs verbatim in the file it names, on this commit", () => {
  let quotes = 0;
  for (const m of manifests()) {
    const check = (where: string, ref: string, quote: string) => {
      assert.ok(isFile(ref), `${m.adr} ${where}: ${ref} exists`);
      assert.ok(read(ref).includes(quote), `${m.adr} ${where}: the quote ${JSON.stringify(quote)} is not in ${ref}; update the manifest with the document`);
      quotes++;
    };
    for (const { phase, p } of leaves(m)) if (p.kind === "doc_asserted") check(`${phase} evidence`, p.ref as string, p.quote as string);
    for (const ph of m.phases) if (ph.doc_claim) check(`${ph.id} doc_claim`, ph.doc_claim.ref, ph.doc_claim.quote);
  }
  assert.ok(quotes >= 20);
});

test("AP6. every depends_on names an existing phase, also across ADRs", () => {
  const ms = manifests();
  const phases = new Set(ms.flatMap((m) => m.phases.map((ph) => `${m.adr}:${ph.id}`)));
  for (const m of ms) for (const ph of m.phases) for (const d of ph.depends_on ?? []) {
    const key = d.includes(":") ? d : `${m.adr}:${d}`;
    assert.ok(phases.has(key), `${m.adr} ${ph.id}: depends_on ${d} names no phase`);
  }
});

test("AP7. every built path a manifest names exists in the repository", () => {
  let n = 0;
  for (const m of manifests()) for (const ph of m.phases) for (const b of ph.built ?? []) {
    assert.ok(isFile(b), `${m.adr} ${ph.id}: built path ${b} does not exist`);
    n++;
  }
  assert.ok(n >= 10);
});

test("AP8. the evidence names real things: migrations, audit events, consensus actions, executors (R6)", () => {
  const migrations = new Set(list("workers/control-plane-migrations/"));
  // Every string literal of the Workers' sources, to find event types and executor names the code really writes.
  const literals = new Set<string>();
  const walk = (dir: string): void => {
    for (const e of readdirSync(new URL(dir, ROOT), { withFileTypes: true })) {
      const p = dir + e.name;
      if (e.isDirectory()) walk(p + "/");
      else if (p.endsWith(".ts")) for (const x of read(p).matchAll(/["'`]([a-z0-9_.:-]+)["'`]/g)) literals.add(x[1]);
    }
  };
  for (const w of list("workers/")) if (exists(`workers/${w}/src/`)) walk(`workers/${w}/src/`);
  const events: string[] = [];
  for (const m of manifests()) for (const { phase, p } of leaves(m)) {
    const at = `${m.adr} ${phase}`;
    if (p.kind === "migration_applied") assert.ok(migrations.has(p.name as string), `${at}: migration ${p.name} is not in workers/control-plane-migrations/`);
    if (p.kind === "audit_event") events.push(p.event_type as string);
    if (p.kind === "quiet_window") events.push(p.success_type as string, ...(p.fail_types as string[]));
    if (p.kind === "agent_report") assert.ok(list("workers/control-plane-migrations/").some((f) => f.endsWith(".sql") && read(`workers/control-plane-migrations/${f}`).includes(`'${p.agent_id}'`)), `${at}: agent ${p.agent_id} is not registered by a migration`);
    if (p.kind === "consensus_executed") assert.ok((p.action as string) in CONSENSUS_ACTIONS, `${at}: ${p.action} is not a consensus action`);
    if (p.kind === "deploy_step" && p.executor) assert.ok(literals.has(p.executor as string), `${at}: executor ${p.executor} is not in the source`);
    if (p.kind === "audit_event" && p.payload) for (const v of Object.values(p.payload as Record<string, unknown>)) {
      if (typeof v === "string") assert.ok(literals.has(v), `${at}: payload value ${v} is not in the source`);
    }
  }
  assert.ok(events.length >= 15);
  for (const e of events) assert.ok(literals.has(e), `audit event ${e} is not written anywhere in workers/*/src`);
});

test("AP9. Q2: the manifests of ADR-0009, ADR-0012 and ADR-0014 are guard paths, under their ADR's reason", async () => {
  assert.equal(criticalPathReason("architecture/adr/progress/0009.json"), "adr_0009_0012");
  assert.equal(criticalPathReason("architecture/adr/progress/0012.json"), "adr_0009_0012");
  assert.equal(criticalPathReason("architecture/adr/progress/0014.json"), "evolution_guard");
  // Their ADRs stay guarded; the other manifests, the validator and this test are routine.
  assert.equal(criticalPathReason("architecture/adr/0009-consensus-autonomy.md"), "adr_0009_0012");
  assert.equal(criticalPathReason("architecture/adr/0012-github-independence.md"), "adr_0009_0012");
  assert.equal(criticalPathReason("architecture/adr/0014-evolution-loop.md"), "evolution_guard");
  for (const f of manifestFiles().filter((f) => !["0009.json", "0012.json", "0014.json"].includes(f))) {
    assert.equal(criticalPathReason(PROGRESS + f), null, f);
  }
  assert.equal(criticalPathReason("architecture/adr/progress/0012.json.bak"), null);
  assert.equal(criticalPathReason("architecture/adr/progress/00012.json"), null);
  assert.equal(criticalPathReason("workers/control-plane-shared/src/adr-progress.ts"), null);
  assert.equal(CRITICAL_PATHS.filter(([re]) => re.source.includes("progress")).length, 2);
  // The Forge's merge verdict reads the same list, so a change to one of them is merge_owner_change.
  const repo = { readBlob: async () => null } as never;
  const reasons = await criticalReasons(repo, ["architecture/adr/progress/0012.json", "architecture/adr/progress/0014.json", "architecture/adr/progress/0016.json"]
    .map((path) => ({ path, change: "modified", base: "x", head: "y" }) as never), false);
  assert.deepEqual(reasons, ["adr_0009_0012: architecture/adr/progress/0012.json", "evolution_guard: architecture/adr/progress/0014.json"]);
  // The evolver can never write a manifest (architecture/ is outside its scope).
  assert.equal(pathRefusal("architecture/adr/progress/0016.json"), "path_outside_scope");
});

test("AP10. the seed is honest: what the platform cannot see is open with a reason, an external assertion is dated", () => {
  for (const m of manifests()) for (const { phase, p } of leaves(m)) {
    if (p.kind === "external_asserted") assert.match(p.as_of as string, /^2026-/, `${m.adr} ${phase}`);
  }
  // ADR-0012 S6 and S7: nothing says GitHub's workflows are disabled or its repository archived yet.
  const s = (id: string) => byId("0012").phases.find((ph) => ph.id === id)!;
  for (const id of ["S6", "S7"]) assert.ok(predicateLeaves(s(id).evidence).some((p) => p.kind === "not_measurable_yet"), id);
  assert.equal(byId("0012").phases.length, 26);
  // ADR-0020: accepted, nothing built on the platform side; its implementation is the xauusd repository's RFC, measured
  // by the strategy_arm.v1 reports xauusd's Risk Manager publishes (2026-11-17): documents and those reports only.
  const a20 = byId("0020");
  assert.equal(a20.lifecycle, "accepted");
  assert.ok(a20.phases.every((ph) => !ph.built));
  assert.ok(a20.phases.flatMap((ph) => predicateLeaves(ph.evidence)).every((p) => p.kind === "doc_asserted" || p.kind === "agent_report"));
  assert.match(a20.lifecycle_note ?? "", /RFC_STRATEGY_RECOMMENDATION/);
  const report = { kind: "agent_report", report_kind: "xauusd_digest", agent_id: "xauusd-risk-manager", body_schema: "strategy_arm.v1", origin: "xauusd-ai-trading-assistant" };
  const p20 = (id: string) => a20.phases.find((ph) => ph.id === id)!;
  assert.deepEqual(p20("N").evidence, { ...report, item: { event: ["armed", "disarmed"], reason: "owner" } }, "N: an owner's arm or disarm click, mirrored");
  assert.deepEqual(p20("R").evidence, report, "R: any strategy_arm.v1 report");
  assert.deepEqual(p20("R").depends_on, ["N"]);
  assert.deepEqual(predicateLeaves(p20("A1").evidence).map((p) => p.kind), ["agent_report", "doc_asserted"], "A1: proven by a mode auto report, else the document");
  assert.deepEqual(predicateLeaves(p20("A1").evidence)[0], { ...report, body: { "$.mode": "auto" } });
  assert.equal(p20("D").evidence.kind, "doc_asserted");
  assert.deepEqual(p20("A3").evidence, { kind: "doc_asserted", ref: "architecture/adr/0020-standing-trading-authorization.md", quote: "The highest profile the agent may reach is set only by the owner" }, "A3: the owner-set ceiling, recorded in the ADR");
  assert.deepEqual(p20("A4").evidence, { kind: "doc_asserted", ref: "architecture/adr/0020-standing-trading-authorization.md", quote: "but only while its stop loss already locks a profit" }, "A4: the TP ladder only once the stop locks a profit");
  assert.deepEqual(p20("A5").evidence, { kind: "doc_asserted", ref: "architecture/adr/0020-standing-trading-authorization.md", quote: "A council failure, an invalid verdict or a timeout means the downgrade applies." }, "A5: the soft-downgrade veto fails safe");
  assert.deepEqual(p20("A6").evidence, { kind: "doc_asserted", ref: "architecture/adr/0020-standing-trading-authorization.md", quote: "a broker that refuses the stop leaves both unchanged" }, "A6: TP2 before the TP1 lock only together with the stop at break-even");
  assert.deepEqual(a20.phases.map((ph) => ph.id), ["D", "A1", "A2", "A3", "A4", "A5", "A6", "N", "R"]);
  assert.equal(criticalPathReason(`${PROGRESS}0020.json`), null, "0020.json is not a guard path");
  // ADR-0018: the registry migration 0074 is on main now, so X3 measures it.
  assert.ok(predicateLeaves(byId("0018").phases.find((ph) => ph.id === "X3")!.evidence).some((p) => p.kind === "migration_applied" && p.name === "0074_register_cta.sql"));
});

test("AP11. docs/SSOT.md names the manifests, and its 2026-11-16 entry records step 1", () => {
  const ssot = read("docs/SSOT.md");
  assert.match(ssot.split("\n").find((l) => l.startsWith("Last reviewed: "))!, /(?:^Last reviewed: |\); )2026-11-16 \([^\n]*ADR Steward step 1[^\n]*`architecture\/adr\/progress\/0001\.json`/);
  assert.match(ssot, /Each ADR's progress is described by its manifest in `architecture\/adr\/progress\/`/);
});
