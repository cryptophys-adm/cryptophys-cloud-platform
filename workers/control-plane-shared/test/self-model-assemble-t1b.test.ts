// ADR-0016 (Telos) T1b, docs/design/TELOS-T1-SELF-MODEL.md §5, §6 and §12 step 2 (owner 2026-11-22, "setuju semua"): the
// assembler of the daily self-model over node:sqlite fixtures built from the real migrations (harness.ts migratedDb).
// Every query is a bounded SELECT on an index; rows written after window_end change nothing; a missing table gives
// missing_table; an empty source gives no_rows, never 0; trading values pass only through the whitelist; the document
// passes selfModelProblems() and stays under 64 KB. Plain fs reads relative to the repository root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migratedDb, registeredByConsensus, lastReviewedRecord } from "./harness.ts";
import { BUNDLED_VISION, SELF_MODEL_MAX_BYTES, canonicalJson, selfModelContentHash, selfModelProblems, type Measure } from "../src/self-model.ts";
import {
  ORGAN_HEALTH_METRIC_NAMES, SELF_MODEL_MAX_STATEMENTS, SELF_MODEL_SOURCE_IDS, VITALS_SUBJECTS, organHealthWhitelist, readSelfModelSources, selfModelWindows,
  type SelfModelDb,
} from "../src/self-model-read.ts";
import { SELF_MODEL_AUTONOMY_GROUPS, SELF_MODEL_FREE_LIMITS, SELF_MODEL_KPI_INPUTS } from "../src/self-model-sections.ts";
import { assembleFromReadings, assembleSelfModel, cutLists, type KpiBinding } from "../src/self-model-assemble.ts";
import { FREE_LIMITS } from "../src/cf-usage.ts";
import { AUTONOMY_GROUPS } from "../src/autonomy-dial.ts";
import { DEPLOY_UNITS } from "../src/deploy-units.ts";
import { EXTERNAL_ORIGINS } from "../src/organism.ts";
import type { Vision } from "../src/vision.ts";
import { presentOrganHealth } from "../../ai-kernel/src/syscall.ts";
import { ORGAN_HEALTH_METRICS } from "../../ai-kernel/src/signal-analyst.ts";

const ROOT = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, ROOT), "utf8");

const DAY = "2026-11-22";
const END = Date.parse("2026-11-23T00:00:00.000Z");
const HOUR = 3_600_000;
/** Hours before window_end (negative: after it). */
const at = (hoursBefore: number) => new Date(END - hoursBefore * HOUR).toISOString();
const COMPUTED = "2026-11-23T00:52:00Z";
type Db = ReturnType<typeof migratedDb>;
const hex = (n: number, len: number) => n.toString(16).padStart(len, "0").slice(-len);

// ------------------------------------------------------------------ fixture rows (real columns of the migrations)

let seq = 0;
const next = () => ++seq;
const PRICE = 2345.67;

function report(db: Db, agent: string, kind: string, subject: string, body: unknown, createdAt: string): string {
  const id = `rpt_${next()}`;
  db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at) VALUES (?, ?, ?, 'info', ?, ?, 'skipped', NULL, ?)")
    .run(id, agent, kind, subject, JSON.stringify(body), createdAt);
  return id;
}
/** A trading_organ_health.v1 body with every metric, plus price-bearing fields and text the whitelist must drop. */
function organBody(hit30: number | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "trading_organ_health.v1", observed_at: "2026-11-22T22:00:00.000Z", bar_minutes: 15, stale: false,
    entry_price: PRICE, sl: PRICE - 10, tp1: PRICE + 20, levels: [PRICE], note: `Gold at ${PRICE}, buy the dip`,
    metrics: [
      ...ORGAN_HEALTH_METRIC_NAMES.filter((m) => !m.startsWith("hit_rate_")).map((metric, i) => ({ metric, value: i / 10, baseline_7d: i / 20, z: 0.5, price: PRICE })),
      { metric: "hit_rate_7d", value: 0.61, baseline_7d: 0.58, z: 1.2, status: "ok", n_directional: 40, hit: 24, miss: 16, wait_accuracy: 0.7, subject: "engine:15", as_of: "2026-11-22T21:45:00Z", entry: PRICE },
      { metric: "hit_rate_30d", value: hit30, baseline_7d: 0.55, z: null, status: hit30 === null ? "no_scored_data" : "ok", n_directional: 120, hit: 66, miss: 54, wait_accuracy: 0.66, subject: "engine:15", as_of: "2026-11-22T21:45:00Z" },
      { metric: "entry_price", value: PRICE, baseline_7d: PRICE, z: 0 },
    ],
    ...extra,
  };
}
function proposal(db: Db, action: string, target: string, status: string, createdAt: string, decidedAt: string, params: Record<string, unknown> = {}, cls = "routine"): string {
  const id = `cns_${next()}`;
  db.raw.prepare(`INSERT INTO consensus_proposals (proposal_id, proposer_agent_id, action, target, class, params_json, evidence_json, mode, eligible, approvals, rejections, passed,
    policy_decision_id, policy_decision, status, outcome_json, created_at, decided_at) VALUES (?, 'supervisor', ?, ?, ?, ?, '{}', 'routine', 3, 3, 0, 1, NULL, NULL, ?, NULL, ?, ?)`)
    .run(id, action, target, cls, JSON.stringify(params), status, createdAt, decidedAt);
  return id;
}
function finding(db: Db, worker: string, metric: string, kind: string, z: number | null, createdAt: string): string {
  const id = `obs_${next()}`;
  db.raw.prepare(`INSERT INTO observer_findings (finding_id, worker, metric, kind, severity, bucket, value, baseline_7d, z, since_deploy_json, sample_json, detail, report_only, created_at)
    VALUES (?, ?, ?, ?, 'warning', ?, 1, 1, ?, NULL, '{}', 'fixture', 0, ?)`).run(id, worker, metric, kind, `${createdAt}#${id}`, z, createdAt);
  return id;
}
function vital(db: Db, subject: string, kind: string, hour: string, v: Partial<Record<"requests" | "errors" | "rows_read" | "rows_written" | "neurons" | "cpu_p99_ms" | "exceeded_cpu", number | null>>): void {
  db.raw.prepare(`INSERT INTO observer_vitals (subject, kind, hour, requests, errors, rows_read, rows_written, neurons, cpu_p50_ms, cpu_p99_ms, wall_p50_ms, wall_p99_ms, exceeded_cpu, exceeded_memory, exceptions, sample_json, recorded_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, NULL, NULL, '{}', ?)`)
    .run(subject, kind, hour, v.requests ?? null, v.errors ?? null, v.rows_read ?? null, v.rows_written ?? null, v.neurons ?? null, v.cpu_p99_ms ?? null, v.exceeded_cpu ?? null, hour);
}
function changeRequest(db: Db, id: string, status: string, outcomeAt: string | null): void {
  db.raw.prepare(`INSERT INTO forge_change_requests (cr_id, source, number, branch, source_branch, title, author, head_sha, base_sha, github_ci, status, created_at, updated_at, outcome_at, repo)
    VALUES (?, 'forge', 1, ?, ?, 'test', 'test', ?, ?, NULL, ?, ?, ?, ?, 'platform-work')`)
    .run(id, `cr/${id}`, `claude/${id}`, "a".repeat(40), "b".repeat(40), status, at(300), outcomeAt ?? at(300), outcomeAt);
}
function council(db: Db, state: string, createdAt: string, calls: number, usd: number): void {
  const id = `cs_${hex(next(), 36)}`;
  db.raw.prepare(`INSERT INTO councils (session_id, side, topic, state, owner_present, created_by, spent_calls, spent_usd, reason, transcript_sha256, created_at, updated_at, deadline)
    VALUES (?, 'cerebrum', 'fixture', ?, 0, 'test', ?, ?, NULL, NULL, ?, ?, ?)`).run(id, state, calls, usd, createdAt, createdAt, createdAt);
}
function intent(db: Db, state: string, createdAt: string): string {
  const id = `int_${hex(next(), 12)}`;
  db.raw.prepare(`INSERT INTO evolution_intents_v2 (intent_id, source, source_ref, target_repo, title, state, created_at, updated_at) VALUES (?, 'owner', ?, 'platform', 'fixture', ?, ?, ?)`)
    .run(id, `ref_${id}`, state, createdAt, createdAt);
  return id;
}
function evolution(db: Db, intentId: string, state: string, startedAt: string, refusals: unknown[] = []): void {
  db.raw.prepare(`INSERT INTO evolutions_v2 (evolution_id, intent_id, state, model, ai_calls, refusals_json, started_at) VALUES (?, ?, ?, 'test-model', 2, ?, ?)`)
    .run(`evo_${hex(next(), 12)}`, intentId, state, JSON.stringify(refusals), startedAt);
}
function correction(db: Db, subject: string, rating: "up" | "down", createdAt: string, actor = "owner@cryptophys.work", label = "owner_rating"): void {
  const n = next();
  db.raw.prepare(`INSERT INTO corrections (correction_id, side, source, label, rating, category, target_ref, subject, body_json, actor, attested_by, weight, supersedes, content_sha256, dedup_sha256, created_at)
    VALUES (?, 'cerebrum', 'console', ?, ?, NULL, ?, ?, '{"text":"secret correction text"}', ?, 'access', 1, NULL, ?, ?, ?)`)
    .run(`cor_${hex(n, 16)}`, label, rating, `ev:platform/report/rpt_t${n}`, subject, actor, hex(n, 64), hex(n + 1, 64), createdAt);
}
function knowledge(db: Db, status: string, createdAt: string): void {
  const n = next();
  db.raw.prepare(`INSERT INTO knowledge_proposals (proposal_id, proposer_agent_id, item_id, item_version, kind, item_json, content_sha256, status, decided_by, reason, decision_id, created_at, decided_at)
    VALUES (?, 'knowledge-council', ?, 1, 'caution', '{}', ?, ?, NULL, NULL, ?, ?, NULL)`).run(`knw_${n}`, `item_${n}`, hex(n, 64), status, `dec_${n}`, createdAt);
}
function memory(db: Db, agent: string, createdAt: string): void {
  db.raw.prepare("INSERT INTO agent_memories (memory_id, agent_id, kind, text, source_ref, created_at) VALUES (?, ?, 'note', 'a memory', NULL, ?)").run(`mem_${next()}`, agent, createdAt);
}
function adr(db: Db, id: string, status: string, percent: number, body: unknown, changedAt: string): void {
  db.raw.prepare(`INSERT INTO adr_progress (adr_id, revision, lifecycle, status, phases_total, phases_proven, phases_asserted, percent, percent_proven, manifest_sha256, body_sha256, body_json, explanation_json, changed_at)
    VALUES (?, 1, 'accepted', ?, 4, 1, 1, ?, ?, ?, ?, ?, NULL, ?)`).run(id, status, percent, Math.floor(percent / 2), "c".repeat(64), "d".repeat(64), JSON.stringify(body), changedAt);
}
const burn = (db: Db, day: string, service: string, usd: number) =>
  db.raw.prepare("INSERT INTO infra_burn_metrics (metric_id, period_day, service_id, ai_neurons, estimated_cost_usd, calculated_at) VALUES (?, ?, ?, 0, ?, ?)").run(`brn_${next()}`, day, service, usd, `${day}T12:00:00.000Z`);
const build = (db: Db, stopped: string, minutes: number | null) =>
  db.raw.prepare("INSERT INTO forge_builds (build_uuid, worker, status, outcome, created_on, started_on, stopped_on, duration_s, billed_minutes, seen_at) VALUES (?, 'cryptophys-forge', 'stopped', 'success', ?, ?, ?, 60, ?, ?)")
    .run(`b_${next()}`, stopped, stopped, stopped, minutes, stopped);
const depAudit = (db: Db, ranAt: string, status = "ok") =>
  db.raw.prepare("INSERT INTO forge_dependency_audits (run_id, main_sha, ran_at, status, lockfiles, packages, advisories, critical, high, moderate, low, info) VALUES (?, ?, ?, ?, 3, 400, 3, 0, 1, 2, 0, 0)")
    .run(`dep_${next()}`, "e".repeat(40), ranAt, status);
const aiUsage = (db: Db, service: string, day: string, requests: number, failures: number) =>
  db.raw.prepare("INSERT INTO ai_usage (service_id, day, requests, failures) VALUES (?, ?, ?, ?)").run(service, day, requests, failures);
const aiFailure = (db: Db, service: string, day: string, task: string, category: string, n: number) =>
  db.raw.prepare("INSERT INTO ai_failures (service_id, day, task, category, count) VALUES (?, ?, ?, ?, ?)").run(service, day, task, category, n);
function drift(db: Db, service: string, drifted: number, observedAt: string, streak = 1): void {
  db.raw.prepare("INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at, streak) VALUES (?, ?, 'x', 'y', ?, '{}', ?, ?)")
    .run(`drf_${next()}`, service, drifted, observedAt, streak);
}
function deployment(db: Db, service: string, status: string, createdAt: string): void {
  const id = `dep_req_${next()}`;
  db.raw.prepare(`INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, approval_id, idempotency_key, details_json, created_at, updated_at)
    VALUES (?, ?, ?, 'test', ?, NULL, ?, '{}', ?, ?)`).run(id, service, "a".repeat(40), status, `idem_${id}`, createdAt, createdAt);
}
function census(db: Db, sha: string, takenAt: string, origins: string[], status = "consistent"): void {
  const genome = [{ service: "cryptophys-ai-kernel", kind: "service", agents: [], engines: [] }, ...origins.map((o) => ({ service: `${o}-organ`, kind: "service", agents: [], engines: [], origin: o }))];
  db.raw.prepare("INSERT INTO forge_organism_census (main_sha, status, organs, agents, engines, voters, findings, genome, taken_at) VALUES (?, ?, 17, 33, 12, 5, ?, ?, ?)")
    .run(sha, status, JSON.stringify([{ kind: "unregistered_agent", subject: "x", detail: "fixture" }]), JSON.stringify(genome), takenAt);
}
const inventoryRun = (db: Db, ranAt: string, findings: unknown[], status = "ok") =>
  db.raw.prepare("INSERT INTO observer_runs (run_id, kind, bucket, ran_at, status, datasets_json, findings_json, digest) VALUES (?, 'inventory', ?, ?, ?, '{}', ?, NULL)")
    .run(`obr_${next()}`, ranAt, ranAt, status, JSON.stringify(findings));

/** Every source of §2.1 with rows in the window, and rows outside it (older than 30 days, or after window_end). */
function populate(db: Db): { rollbackFinding: string; reportId: string } {
  registeredByConsensus(db);
  db.raw.prepare("UPDATE service_registry SET desired_version = ?, observed_version = ? WHERE service_id NOT IN ('cryptophys-signal-engine', 'cryptophys-home')").run("a".repeat(40), "a".repeat(40));
  db.raw.prepare("UPDATE service_registry SET observed_version = ?, status = 'healthy' WHERE service_id = 'cryptophys-ai-kernel'").run("b".repeat(40));
  db.raw.prepare("UPDATE service_registry SET status = 'healthy' WHERE service_id = 'xauusd-ai-trading-assistant'").run();
  // Persistent drift on the console (two drifted rows); a single drifted row on the forge is not persistent.
  drift(db, "cryptophys-console", 1, at(30)); drift(db, "cryptophys-console", 1, at(5));
  drift(db, "cryptophys-forge", 0, at(50)); drift(db, "cryptophys-forge", 1, at(3));
  deployment(db, "cryptophys-console", "succeeded", at(10)); deployment(db, "cryptophys-console", "succeeded", at(20));
  deployment(db, "cryptophys-forge", "failed", at(40)); deployment(db, "cryptophys-forge", "succeeded", at(24 * 20));
  deployment(db, "cryptophys-forge", "succeeded", at(24 * 40));
  // A rollback 45 minutes after the finding it names; merges by consensus and by the owner's click.
  const rollbackFinding = finding(db, "cryptophys-console", "errors_per_request", "anomaly", 6.5, at(48));
  proposal(db, "rollback_worker_version", "cryptophys-console", "executed", at(47.5), at(47.25), { finding_id: rollbackFinding, version: "v1" });
  proposal(db, "merge_change", "cr_1", "executed", at(60), at(60));
  proposal(db, "merge_owner_change", "cr_2", "executed", at(70), at(70), {}, "critical");
  proposal(db, "deploy_worker", "cryptophys-console", "pending_owner", at(2), at(2), {}, "critical");
  changeRequest(db, "cr_1", "merged", at(59)); changeRequest(db, "cr_2", "merged", at(69)); changeRequest(db, "cr_3", "merged", at(80));
  changeRequest(db, "cr_4", "open", null); changeRequest(db, "cr_5", "merged", at(24 * 45));
  finding(db, "cryptophys-ai-kernel", "cpu_p99_near_limit", "early_warning", null, at(12));
  finding(db, "agent:auditor", "learning_volume", "anomaly", 3.1, at(6));
  finding(db, "cryptophys-forge", "d1_load", "anomaly", -4.2, at(30));
  for (let h = 1; h <= 30; h++) {
    vital(db, "cryptophys-ai-kernel", "worker", at(h), { requests: 1000, errors: h === 3 ? 10 : 0, cpu_p99_ms: 20 + h, exceeded_cpu: 0 });
    vital(db, "cryptophys-console", "worker", at(h), { requests: 200, errors: 1, cpu_p99_ms: 5, exceeded_cpu: 0 });
    vital(db, "xauusd-ai-trading-assistant", "worker", at(h), { requests: 300, errors: 3, cpu_p99_ms: 9, exceeded_cpu: 1 });
    vital(db, "d1:db1", "d1", at(h), { requests: 50, rows_read: 4000, rows_written: 20 });
    vital(db, "ai:@cf/meta/llama", "ai", at(h), { neurons: 12.5 });
  }
  vital(db, "cryptophys-ai-kernel", "worker", at(24 * 20), { requests: 500, errors: 5, cpu_p99_ms: 40, exceeded_cpu: 2 });
  vital(db, "ai:@cf/meta/llama", "ai", at(24 * 20), { neurons: 100 });
  inventoryRun(db, at(1), [{ worker: "ghost-worker", metric: "undeclared_worker" }, { worker: "old-worker", metric: "orphaned_declaration" }, { worker: "x", metric: "idle_worker" }]);
  census(db, "f".repeat(40), at(4), ["xauusd", "aether"]);
  burn(db, "2026-11-05", "cryptophys-platform-api", 0.12); burn(db, "2026-11-20", "cryptophys-ai-kernel", 0.5); burn(db, "2026-10-30", "cryptophys-platform-api", 9);
  build(db, at(30), 4); build(db, at(24 * 10), null); build(db, "2026-10-31T23:00:00.000Z", 50);
  depAudit(db, at(8));
  aiUsage(db, "cryptophys-ai-kernel", "2026-11-20", 10, 1); aiUsage(db, "cryptophys-ai-kernel", "2026-11-22", 4, 0); aiUsage(db, "cryptophys-ai-kernel", "2026-11-10", 99, 9);
  aiFailure(db, "cryptophys-ai-kernel", "2026-11-21", "chat_answer", "timeout", 2); aiFailure(db, "cryptophys-ai-kernel", "2026-11-22", "council_position", "schema:position", 1);
  council(db, "decided", at(30), 6, 0.04); council(db, "aborted", at(24 * 3), 2, 0.01);
  const i1 = intent(db, "proposed", at(30)); intent(db, "queued", at(10));
  evolution(db, i1, "proposed", at(29)); evolution(db, i1, "refused", at(28), [{ rule: "guard_path" }]);
  correction(db, "agent:auditor", "up", at(5)); correction(db, "agent:auditor", "down", at(24 * 10)); correction(db, "model:llama", "down", at(24 * 3));
  knowledge(db, "pending", at(6)); knowledge(db, "approved", at(24 * 5));
  for (const a of ["auditor", "auditor", "signal-analyst"]) memory(db, a, at(7));
  adr(db, "0016", "in_progress", 40, { drift: [{ x: 1 }], stale: false }, at(9)); adr(db, "0012", "done", 100, { drift: [], stale: true }, at(90));
  db.raw.prepare("INSERT INTO autonomy_dial (group_id, level, source, set_by, set_at, reason) VALUES ('merges', 'owner_click', 'owner', 'owner@cryptophys.work', ?, NULL)").run(at(100));
  const reportId = report(db, "signal-analyst", "xauusd_digest", "Trading organ health", organBody(0.55), at(2));
  report(db, "signal-analyst", "xauusd_digest", "Flip warning at 2345.67", { schema: "flip.v1", price: PRICE }, at(1));
  report(db, "knowledge-council", "knowledge_audit", "Knowledge audit: 3 cautions", { items: 3 }, at(11));
  return { rollbackFinding, reportId };
}

/** Rows written after window_end in every windowed source (§5.3): none of them may change the document. */
function writeAfterWindow(db: Db): void {
  const later = at(-0.5);
  drift(db, "cryptophys-console", 0, later); drift(db, "cryptophys-ai-kernel", 1, later, 2);
  deployment(db, "cryptophys-console", "failed", later);
  const f = finding(db, "cryptophys-ai-kernel", "errors_per_request", "anomaly", 9.9, later);
  proposal(db, "rollback_worker_version", "cryptophys-ai-kernel", "executed", later, later, { finding_id: f });
  proposal(db, "merge_change", "cr_9", "executed", later, later); changeRequest(db, "cr_9", "merged", later);
  vital(db, "cryptophys-ai-kernel", "worker", new Date(END).toISOString(), { requests: 99999, errors: 999, cpu_p99_ms: 999, exceeded_cpu: 9 });
  vital(db, "ai:@cf/meta/llama", "ai", new Date(END).toISOString(), { neurons: 9999 });
  inventoryRun(db, later, [{ worker: "late", metric: "undeclared_worker" }, { worker: "late2", metric: "undeclared_worker" }]);
  census(db, "9".repeat(40), later, [], "invalid");
  burn(db, "2026-11-23", "cryptophys-platform-api", 7); build(db, later, 30); depAudit(db, later, "failed");
  aiUsage(db, "cryptophys-ai-kernel", "2026-11-23", 500, 50); aiFailure(db, "cryptophys-ai-kernel", "2026-11-23", "chat_answer", "timeout", 40);
  council(db, "decided", later, 9, 1); const i = intent(db, "merged", later); evolution(db, i, "merged", later);
  correction(db, "agent:auditor", "down", later); knowledge(db, "rejected", later); memory(db, "auditor", later);
  report(db, "signal-analyst", "xauusd_digest", "Trading organ health", organBody(0.99), later);
  report(db, "knowledge-council", "knowledge_audit", "Late audit", {}, later);
}

/** A spy on the D1 reader: every SQL text with its bound values. */
function spy(db: SelfModelDb): { db: SelfModelDb; seen: { sql: string; args: unknown[] }[] } {
  const seen: { sql: string; args: unknown[] }[] = [];
  return { seen, db: { prepare: (sql: string) => ({ bind: (...args: unknown[]) => { seen.push({ sql, args }); return db.prepare(sql).bind(...args); } }) } };
}

const assemble = (db: SelfModelDb, extra: Record<string, unknown> = {}) => assembleSelfModel(db, DAY, { computedAt: COMPUTED, ...extra });
const get = (doc: unknown, path: string): any => path.split(".").reduce<any>((o, k) => (o === undefined || o === null ? undefined : o[k]), doc);
const sec = (doc: any, path: string): any => get(doc.sections, path);

/** Every measure of a document with its path. */
function measures(n: unknown, path = "", out: { path: string; m: Measure }[] = []): { path: string; m: Measure }[] {
  if (Array.isArray(n)) n.forEach((v, i) => measures(v, `${path}[${i}]`, out));
  else if (n && typeof n === "object") {
    if ("value" in n || "reason" in n) out.push({ path, m: n as Measure });
    else for (const [k, v] of Object.entries(n)) measures(v, path ? `${path}.${k}` : k, out);
  }
  return out;
}
/** The source id a measure's `source` names (its first part; agent_reports is two sources). */
function sourceIdOf(source: string): string {
  if (source.startsWith("agent_reports:trading_organ_health")) return "trading_organ_health";
  if (source.startsWith("agent_reports:knowledge_audit")) return "knowledge_audit";
  return source.split(":")[0];
}

// ------------------------------------------------------------------ tests

test("T1b-1. a full day assembles into a valid, complete document under 64 KB, with the values the rows hold", async () => {
  const db = migratedDb();
  const { rollbackFinding, reportId } = populate(db);
  const r = await assemble(db, { adrManifestIds: ["0012", "0016"] });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(selfModelProblems(r.document), []);
  assert.equal(r.status, "complete");
  assert.ok(r.bytes < SELF_MODEL_MAX_BYTES, `${r.bytes} bytes`);
  assert.equal(r.bytes, new TextEncoder().encode(canonicalJson(r.document)).length);
  assert.equal(r.document.content_sha256, await selfModelContentHash(r.document as unknown as Record<string, unknown>));
  assert.equal(r.document.window_end, "2026-11-23T00:00:00Z");
  for (const s of r.document.sources) assert.equal(s.status, "ok", `${s.id} is ${s.status}`);
  assert.deepEqual(r.document.sources.map((s) => s.id), SELF_MODEL_SOURCE_IDS);
  assert.ok(r.statements <= SELF_MODEL_MAX_STATEMENTS && r.statements > 0, `${r.statements} statements`);
  const d = r.document as any;
  const v = (p: string) => sec(d, p)?.value;

  // Body.
  assert.equal(v("body.workers.drifted_now"), 1, "only the console's drift is persistent");
  assert.equal(v("body.workers.versions_differ"), 1);
  assert.equal(v("body.workers.total"), 17, "the retired services are left out");
  assert.equal(v("body.deploys.requests_7d.total"), 3);
  assert.equal(v("body.deploys.requests_30d.total"), 4);
  assert.equal(v("body.deploys.rollbacks_executed_30d"), 1);
  assert.equal(v("body.deploys.finding_to_rollback_minutes_mean_30d"), 45);
  assert.equal(v("body.changes.merged_30d"), 3);
  assert.equal(v("body.changes.merged_by_consensus_30d"), 1);
  assert.equal(v("body.changes.merged_by_owner_click_30d"), 1);
  const kernel = sec(d, "body.vitals.workers.top").find((x: any) => x.worker === "cryptophys-ai-kernel");
  assert.equal(kernel.requests_24h.value, 24_000);
  assert.equal(kernel.error_ratio_24h.value, round4(10 / 24_000));
  assert.equal(kernel.cpu_p99_ms_worst_hour_24h.value, 44);
  assert.equal(kernel.requests_7d.value, 30_000);
  assert.equal(v("body.vitals.control_plane_unit.requests_30d"), 30_500, "the ai-kernel is in the control-plane unit; the console is not");
  assert.equal(v("body.vitals.control_plane_unit.errors_30d"), 15);
  assert.equal(v("body.account.workers_requests.used"), 24 * 1500);
  assert.equal(v("body.account.d1_rows_read.used"), 24 * 4000);
  assert.equal(v("body.account.ai_neurons.share_of_free"), round4((24 * 12.5) / 10_000));
  assert.equal(v("body.account.ai_neurons_30d"), 30 * 12.5 + 100);
  assert.equal(v("body.cost.mtd_usd.total"), 0.62, "October is outside the month to date");
  assert.equal(v("body.builds.builds_mtd"), 2);
  assert.equal(v("body.builds.unmeasured_builds_mtd"), 1);
  assert.equal(v("body.builds.minutes_mtd"), 4);
  assert.equal(v("body.anomalies.by_kind_7d.total"), 4);
  assert.deepEqual(sec(d, "body.anomalies.top_by_z_7d.top").map((x: any) => x.z.value), [6.5, -4.2, 3.1]);
  assert.equal(sec(d, "body.anomalies.top_by_z_7d.top")[0].z.ref, `ev:platform/observer_finding/${rollbackFinding}`);
  assert.equal(v("body.inventory.undeclared_worker"), 1);
  assert.equal(v("body.inventory.orphaned_declaration"), 1);
  assert.equal(v("body.inventory.status"), "ok");
  assert.equal(v("body.census.status"), "consistent");
  assert.equal(v("body.census.organs"), 17);
  assert.equal(v("body.controls.agents_enabled"), true);
  assert.equal(v("body.controls.consensus_mode"), "shadow");
  assert.equal(v("body.controls.power_mode"), "homeostasis");
  assert.equal(v("body.controls.autonomy.merges"), "owner_click");
  assert.equal(v("body.controls.autonomy.deploys"), "ceiling", "no row is the group at its ceiling (migration 0083)");

  // Mind.
  assert.equal(v("mind.trading_organ.metrics.hit_rate_30d.current"), 0.55);
  assert.equal(v("mind.trading_organ.metrics.hit_rate_30d.status"), "ok");
  assert.equal(v("mind.trading_organ.metrics.hit_rate_30d.hit"), 66);
  assert.equal(sec(d, "mind.trading_organ.metrics.hit_rate_30d.subject"), "engine:15");
  assert.equal(sec(d, "mind.trading_organ.metrics.hit_rate_30d.current.ref"), `ev:platform/report/${reportId}#metrics`);
  assert.equal(v("mind.trading_organ.report_age_h"), 2);
  assert.deepEqual(Object.keys(sec(d, "mind.trading_organ.metrics")).sort(), [...ORGAN_HEALTH_METRIC_NAMES].sort());
  assert.equal(v("mind.ai.requests_7d"), 14, "the day ten days back is outside 7 days");
  assert.equal(v("mind.ai.failures_7d"), 1);
  assert.equal(sec(d, "mind.ai.failures_by_task_7d.top").length, 2);
  assert.equal(v("mind.councils.total"), 2);
  assert.equal(v("mind.councils.calls"), 8);
  assert.equal(v("mind.consensus.waiting_owner_30d"), 1);
  assert.equal(v("mind.consensus.by_status_30d.total"), 4);
  assert.equal(v("mind.evolver.mode"), "on");
  assert.equal(v("mind.evolver.refused_30d"), 1);
  const auditor = sec(d, "mind.teaching.top").find((x: any) => x.subject === "agent:auditor");
  assert.equal(auditor.d7.n.value, 1);
  assert.equal(auditor.d30.n.value, 2);
  assert.equal(auditor.d30.score.value, 0.5);

  // Memory.
  assert.equal(sec(d, "memory.adr_index.top").length, 2);
  const a16 = sec(d, "memory.adr_index.top").find((x: any) => x.adr === "0016");
  assert.equal(a16.status.value, "in_progress");
  assert.equal(a16.drift_count.value, 1);
  assert.equal(a16.stale.value, false);
  assert.equal(v("memory.adr_index.adr_index_live"), true);
  assert.equal(v("memory.knowledge.pending_now"), 1);
  assert.equal(sec(d, "memory.knowledge.newest_audit.subject"), "Knowledge audit: 3 cautions");
  assert.equal(v("memory.corrections.d7.by_label.total"), 2, "the row ten days back is outside 7 days");
  assert.equal(v("memory.corrections.d30.by_label.total"), 3);
  assert.equal(v("memory.memories.total"), 3);
  assert.equal(v("memory.learning_watch_7d.learning_volume"), 1);
  assert.equal(sec(d, "memory.experience_ledger.reason"), "not_built");

  // Ecosystem.
  assert.equal(v("ecosystem.origins.xauusd.dna_read"), true);
  assert.equal(v("ecosystem.origins.aether.dna_read"), true);
  assert.equal(v("ecosystem.origins.cta.dna_read"), false, "the census genome holds no cta organ");
  const xa = sec(d, "ecosystem.origins.xauusd.services").find((x: any) => x.service === "xauusd-ai-trading-assistant");
  assert.equal(xa.status.value, "healthy");
  assert.equal(xa.requests_24h.value, 24 * 300);
  assert.equal(v("ecosystem.origins.xauusd.trading_organ_age_h"), 2);
  assert.equal(v("ecosystem.dependency_advisories.high"), 1);
  for (const k of ["workers_ai_models", "cloudflare_changelog", "omega_health", "market_regime", "session_calendar"]) assert.equal(sec(d, `ecosystem.${k}.reason`), "source_outside_platform");

  // Every measured value names a source that was read, and its as_of is not after window_end unless the source is point in time.
  const pit = new Set(r.document.sources.filter((s) => s.point_in_time).map((s) => s.id));
  for (const { path, m } of measures(d.sections)) {
    if (m.value === null) continue;
    assert.ok(SELF_MODEL_SOURCE_IDS.includes(sourceIdOf(m.source!) as never), `${path}: ${m.source}`);
    if (!pit.has(sourceIdOf(m.source!))) assert.ok(Date.parse(m.as_of!) <= END, `${path}: as_of ${m.as_of} is after window_end`);
  }
});

const round4 = (n: number) => Number(n.toFixed(4)) + 0;

test("T1b-2. every query is a bounded, read-only SELECT on an index, and a run stays within 40 statements", async () => {
  const db = migratedDb();
  populate(db);
  const s = spy(db);
  const r = await assemble(s.db);
  assert.deepEqual(r.problems, []);
  assert.equal(r.statements, s.seen.length);
  assert.ok(s.seen.length <= SELF_MODEL_MAX_STATEMENTS, `${s.seen.length} statements`);
  // Small tables a plan may walk whole: the registry has one row per Worker (the IN lists of ai_usage and ai_failures,
  // and the drift join, walk it to reach the history tables by their keys).
  const SMALL = /^SCAN (service_registry|r)\b/;
  for (const { sql } of s.seen) {
    assert.match(sql, /^\s*SELECT\s/i, sql);
    assert.match(sql, /\sLIMIT\s+(\?|\d+)\s*$/i, `no LIMIT: ${sql}`);
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|ATTACH)\b|\bLIKE\b/i, sql);
  }
  for (const [sql, args] of new Map(s.seen.map((q) => [q.sql, q.args]))) {
    const plan = (db.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(args as (string | number | null)[])) as { detail: string }[]).map((x) => x.detail);
    for (const line of plan) {
      if (!/^SCAN /.test(line) || SMALL.test(line)) continue;
      assert.match(line, /USING (COVERING )?INDEX|USING (INTEGER )?PRIMARY KEY|VIRTUAL TABLE/, `full scan in ${sql}: ${plan.join(" | ")}`);
    }
    // The history tables are reached through an index on their time or key, never walked whole.
    for (const big of ["agent_reports", "observer_vitals", "observer_findings", "consensus_proposals", "drift_observations", "corrections", "ai_usage", "ai_failures", "infra_burn_metrics", "forge_builds"]) {
      for (const line of plan) assert.doesNotMatch(line, new RegExp(`^SCAN ${big}\\b`), `${big} is scanned in ${sql}: ${plan.join(" | ")}`);
    }
  }
});

test("T1b-3. rows written after window_end change nothing: the same content_sha256, byte for byte", async () => {
  const db = migratedDb();
  populate(db);
  const before = await assemble(db, { adrManifestIds: ["0012", "0016"] });
  writeAfterWindow(db);
  const after = await assemble(db, { adrManifestIds: ["0012", "0016"], computedAt: "2026-11-23T02:52:00Z", deployedCommit: "abc1234" });
  assert.deepEqual(after.problems, []);
  assert.equal(after.document.content_sha256, before.document.content_sha256);
  const strip = (doc: any) => canonicalJson({ ...doc, computed_at: null, deployed_commit: null });
  assert.equal(strip(after.document), strip(before.document));
  // The same readings give the same document: the sections are pure.
  const w = selfModelWindows(DAY)!;
  const { readings } = await readSelfModelSources(db, w);
  const again = await assembleFromReadings(structuredClone(readings), w, { computedAt: COMPUTED, adrManifestIds: ["0012", "0016"] });
  assert.equal(again.document.content_sha256, before.document.content_sha256);
});

test("T1b-4. a missing table gives missing_table, its values null with that reason, and the rest is still measured", async () => {
  const db = migratedDb();
  populate(db);
  db.raw.exec("DROP TABLE councils; DROP TABLE autonomy_dial; DROP TABLE adr_progress");
  const r = await assemble(db);
  assert.deepEqual(r.problems, []);
  assert.equal(r.status, "partial");
  const src = (id: string) => r.document.sources.find((s) => s.id === id)!;
  for (const id of ["councils", "autonomy_dial", "adr_progress"]) assert.deepEqual(src(id), { id, status: "missing_table", rows: null, as_of: null, point_in_time: src(id).point_in_time });
  const d = r.document as any;
  assert.equal(sec(d, "mind.councils.total.reason"), "missing_table");
  assert.equal(sec(d, "mind.councils.spend_usd.reason"), "missing_table");
  for (const g of SELF_MODEL_AUTONOMY_GROUPS) assert.equal(sec(d, `body.controls.autonomy.${g}.reason`), "missing_table", "never a default level");
  assert.equal(sec(d, "memory.adr_index.total.reason"), "missing_table");
  assert.equal(sec(d, "memory.adr_index.adr_index_live.reason"), "missing_table");
  assert.equal(sec(d, "body.workers.drifted_now.value"), 1, "the other sources go on");
  assert.equal(src("drift_observations").status, "ok");
});

test("T1b-5. an empty source gives no_rows, never 0; a default-0 column counts only from rows that exist", async () => {
  const db = migratedDb();
  const r = await assemble(db);
  assert.deepEqual(r.problems, []);
  assert.equal(r.status, "complete", "an empty source is not a failure");
  const d = r.document as any;
  const byId = new Map(r.document.sources.map((s) => [s.id, s]));
  for (const s of r.document.sources) {
    if (s.status === "empty") assert.deepEqual([s.rows, s.as_of], [0, null], s.id);
  }
  for (const p of [
    "body.workers.drifted_now", "body.deploys.requests_7d.total", "body.deploys.rollbacks_executed_30d", "body.deploys.finding_to_rollback_minutes_mean_30d",
    "body.changes.merged_30d", "body.changes.merged_by_consensus_30d", "body.vitals.control_plane_unit.requests_30d", "body.account.ai_neurons_30d",
    "body.account.workers_requests.used", "body.cost.mtd_usd.total", "body.builds.minutes_mtd", "body.anomalies.by_kind_7d.total",
    "body.inventory.undeclared_worker", "body.census.organs", "mind.trading_organ.report_age_h", "mind.trading_organ.metrics.hit_rate_30d.current",
    "mind.ai.requests_7d", "mind.ai.failures_7d", "mind.councils.total", "mind.councils.spend_usd", "mind.consensus.waiting_owner_30d",
    "mind.evolver.refused_30d", "memory.knowledge.pending_now", "memory.corrections.d7.total", "memory.memories.total",
    "memory.learning_watch_7d.learning_volume", "ecosystem.dependency_advisories.critical",
  ]) {
    const m = sec(d, p);
    assert.ok(m, p);
    assert.equal(m.value, null, `${p} must not be a number on an empty database`);
    assert.equal(m.reason, "no_rows", p);
  }
  // No measured value comes from a source that read nothing (the autonomy dial's ceiling is its one measured "no row").
  for (const { path, m } of measures(d.sections)) {
    if (m.value === null) continue;
    const id = sourceIdOf(m.source!);
    if (id === "autonomy_dial") { assert.equal(m.value, "ceiling", path); continue; }
    assert.equal(byId.get(id as never)?.status, "ok", `${path} measured from ${id}`);
  }
  // One burn row of $0 is a measured 0 (the row is the measurement); the month without one is no_rows.
  burn(db, "2026-11-21", "cryptophys-platform-api", 0);
  council(db, "decided", at(5), 0, 0);
  const r2 = await assemble(db);
  assert.equal(sec(r2.document, "body.cost.mtd_usd.total.value"), 0);
  assert.equal(sec(r2.document, "mind.councils.spend_usd.value"), 0);
  assert.equal(sec(r2.document, "mind.councils.total.value"), 1);
});

test("T1b-6. a failing source is unavailable and a slow one budget_exceeded; the document is still valid and partial", async () => {
  const db = migratedDb();
  populate(db);
  const failing: SelfModelDb = { prepare: (sql) => ({ bind: (...a) => { if (/FROM councils\b/.test(sql)) throw new Error("D1_ERROR: network connection lost"); return db.prepare(sql).bind(...a); } }) };
  const r = await assemble(failing);
  assert.deepEqual(r.problems, []);
  assert.equal(r.status, "partial");
  assert.equal(r.document.sources.find((s) => s.id === "councils")!.status, "unavailable");
  assert.equal(sec(r.document, "mind.councils.total.reason"), "source_unavailable");

  const slow: SelfModelDb = {
    prepare: (sql) => ({
      bind: (...a) => {
        const stmt = db.prepare(sql).bind(...a);
        if (!/FROM corrections\b/.test(sql)) return stmt;
        return { first: () => new Promise((res) => setTimeout(() => res(stmt.first()), 200)), all: () => new Promise((res) => setTimeout(() => res(stmt.all()), 200)) } as never;
      },
    }),
  };
  const s = await assemble(slow, { read: { sourceBudgetMs: 20 } });
  assert.deepEqual(s.problems, []);
  assert.equal(s.document.sources.find((x) => x.id === "corrections")!.status, "budget_exceeded");
  assert.equal(sec(s.document, "memory.corrections.d7.total.reason"), "budget_exceeded");
  assert.equal(sec(s.document, "mind.teaching.total.reason"), "budget_exceeded");

  // The run's own budget: once it is spent, every source left is budget_exceeded, unread.
  const seen = spy(db);
  const z = await assemble(seen.db, { read: { runBudgetMs: 0 } });
  assert.deepEqual(z.problems, []);
  assert.equal(seen.seen.length, 0);
  assert.ok(z.document.sources.every((x) => x.status === "budget_exceeded"));
  assert.equal(z.document.counts.measured, 0);
});

test("T1b-7. trading values pass only through the whitelist: no price, no level, no text reaches the document", async () => {
  // The whitelist is presentOrganHealth's (ai-kernel/src/syscall.ts) field for field, and reads only ORGAN_HEALTH_METRICS.
  assert.deepEqual([...ORGAN_HEALTH_METRIC_NAMES], [...ORGAN_HEALTH_METRICS]);
  for (const body of [organBody(0.55), organBody(null, { stale: "yes", bar_minutes: "15" }), { metrics: "nope" }, {}]) {
    const json = JSON.stringify(body);
    assert.deepEqual(JSON.parse(JSON.stringify(organHealthWhitelist(json))), JSON.parse(JSON.stringify(presentOrganHealth(json))));
  }
  assert.deepEqual(organHealthWhitelist("not json"), presentOrganHealth("not json") as never);

  const db = migratedDb();
  populate(db);
  const w = selfModelWindows(DAY)!;
  const { readings } = await readSelfModelSources(db, w);
  const t = readings.trading_organ_health;
  assert.equal(t.status, "ok");
  assert.deepEqual(Object.keys(t.data!).sort(), ["created_at", "health", "report_id"], "the body never leaves the reader");
  assert.doesNotMatch(JSON.stringify(t.data), /2345|buy the dip|entry_price|"sl"|tp1|levels/);

  const r = await assemble(db);
  assert.deepEqual(r.problems, []);
  const text = canonicalJson(r.document);
  assert.doesNotMatch(text, /2345|buy the dip|Flip warning|entry_price|secret correction text|owner@cryptophys\.work/);
  assert.equal(sec(r.document, "mind.trading_organ.metrics.entry_price"), undefined, "a metric outside ORGAN_HEALTH_METRICS is dropped");

  // A hit rate without scored data is null with that reason, never 0.
  const db2 = migratedDb();
  report(db2, "signal-analyst", "xauusd_digest", "Trading organ health", organBody(null), at(3));
  const r2 = await assemble(db2);
  assert.deepEqual(r2.problems, []);
  assert.deepEqual([sec(r2.document, "mind.trading_organ.metrics.hit_rate_30d.current.value"), sec(r2.document, "mind.trading_organ.metrics.hit_rate_30d.current.reason")], [null, "no_scored_data"]);
});

test("T1b-8. Will lists every KPI once, verbatim, through its binding; no binding is no_binding; an invalid vision lists its problems", async () => {
  const db = migratedDb();
  populate(db);
  const r = await assemble(db);
  const vision = BUNDLED_VISION as Vision;
  const kpis = r.document.sections.will.goals.flatMap((g) => g.kpis.map((k) => ({ g: g.id, ...k })));
  assert.equal(kpis.length, vision.growth.goals.reduce((n, g) => n + g.kpis.length, 0));
  for (const k of kpis) {
    const vk = vision.growth.goals.find((g) => g.id === k.g)!.kpis.find((x) => x.id === k.id)!;
    assert.deepEqual([k.baseline, k.target, k.source], [vk.baseline, vk.target, vk.source]);
    assert.deepEqual([k.definition, k.measured.value, k.measured.reason], [null, null, "no_binding"]);
  }
  assert.deepEqual([r.document.counts.kpis_measured, r.document.counts.kpis_total], [0, kpis.length]);

  // Every §6 binding's inputs are in the sections already, and measured on a full day (T1c binds them).
  for (const [kpi, paths] of Object.entries(SELF_MODEL_KPI_INPUTS)) {
    assert.ok(kpis.some((k) => k.id === kpi), kpi);
    for (const p of paths) assert.notEqual(get(r.document.sections, p), undefined, `${kpi}: ${p}`);
  }

  const binding: KpiBinding = {
    goal_id: "g-self-knowledge", kpi_id: "undeclared_components", definition: "undeclared_worker findings in the newest Observer inventory run",
    measure: (s) => (s.body as any).inventory.undeclared_worker,
  };
  const b = await assemble(db, { bindings: [binding] });
  assert.deepEqual(b.problems, []);
  const bound = b.document.sections.will.goals.find((g) => g.id === "g-self-knowledge")!.kpis.find((k) => k.id === "undeclared_components")!;
  assert.equal(bound.measured.value, 1);
  assert.equal(bound.definition, binding.definition);
  assert.equal(b.document.counts.kpis_measured, 1);

  const broken = structuredClone(BUNDLED_VISION) as any;
  broken.growth.goals[0].kpis[0].baseline = "high";
  const x = await assemble(db, { vision: broken });
  assert.deepEqual(x.problems, []);
  assert.deepEqual(x.document.sections.will.goals, []);
  assert.ok((x.document.sections.will.problems ?? []).length > 0);
  assert.equal(x.document.vision.valid, false);
  assert.equal(sec(x.document, "body.workers.drifted_now.value"), 1, "the other sections are still written");
  assert.notDeepEqual(selfModelProblems(x.document), [], "against the bundled vision it is not that vision's document");
});

test("T1b-9. a day with long lists stays under 64 KB: lists are cut to their top entries and say how many they left out", async () => {
  const db = migratedDb();
  populate(db);
  const agents = (db.raw.prepare("SELECT agent_id FROM agents ORDER BY agent_id").all() as { agent_id: string }[]).map((a) => a.agent_id);
  for (const a of agents) for (let i = 0; i < 3; i++) memory(db, a, at(i + 1));
  for (let i = 0; i < 40; i++) adr(db, String(1000 + i), "in_progress", i, { drift: [1, 2, 3], stale: true }, at(i + 1));
  for (let i = 0; i < 30; i++) correction(db, `model:subject-number-${String.fromCharCode(97 + (i % 26))}${i}`, i % 2 ? "up" : "down", at(i + 1), `actor${i}@example.com`);
  for (let i = 0; i < 60; i++) aiFailure(db, "cryptophys-ai-kernel", "2026-11-21", `task_${i}`, `schema:field_${i}`, i + 1);
  for (let i = 0; i < 30; i++) finding(db, `worker-${i}`, `metric_${i}`, "anomaly", i + 0.5, at(i + 1));
  for (const s of VITALS_SUBJECTS) for (let h = 31; h <= 56; h++) vital(db, s, "worker", at(h), { requests: 10, errors: 1, cpu_p99_ms: 3, exceeded_cpu: 0 });
  const services = ["cryptophys-console", "cryptophys-forge", "cryptophys-platform-api", "cryptophys-aether"];
  for (let i = 0; i < 12; i++) aiUsage(db, services[i % 4], `2026-11-${16 + Math.floor(i / 4)}`, 5, 1);
  const r = await assemble(db, { adrManifestIds: ["0012", "0016"] });
  assert.deepEqual(r.problems, []);
  assert.ok(r.bytes <= SELF_MODEL_MAX_BYTES, `${r.bytes} bytes`);
  const d = r.document as any;
  // Each list keeps its top entries and counts the rest: nothing read is silently lost.
  const listed = (p: string) => sec(d, `${p}.top`).length + (sec(d, `${p}.omitted`) ?? 0);
  assert.equal(listed("memory.adr_index"), 42);
  assert.equal(listed("mind.teaching"), 32);
  assert.equal(listed("mind.ai.failures_by_task_7d"), 62);
  assert.equal(listed("body.anomalies.top_by_z_7d"), 33);
  assert.equal(listed("memory.memories.by_agent"), agents.length);
  assert.equal(listed("body.vitals.workers"), new Set(DEPLOY_UNITS.flatMap((u) => [...u.services])).size);
  assert.ok(sec(d, "memory.adr_index.top").length <= 24 && sec(d, "memory.adr_index.omitted") >= 18);
  assert.equal(sec(d, "memory.memories.total.value"), agents.length * 3 + 3, "a total counts every row, whatever the list shows");
  // Will is computed from the full sections: a cut list never changes a KPI input.
  for (const paths of Object.values(SELF_MODEL_KPI_INPUTS)) for (const p of paths) assert.notEqual(get(d.sections, p), undefined, p);
  assert.doesNotMatch(canonicalJson(d), /@example\.com/);

  // The cut itself: deterministic, and it adds what it cuts to omitted.
  const node = { a: { top: [1, 2, 3, 4], omitted: 2 }, b: [{ top: [{ value: 1, reason: null }, { value: 2, reason: null }] }], c: { value: 1, reason: null, top: [1, 2] } };
  assert.deepEqual(cutLists(node, 1), { a: { top: [1], omitted: 5 }, b: [{ top: [{ value: 1, reason: null }], omitted: 1 }], c: { value: 1, reason: null, top: [1, 2] } });
  assert.deepEqual(cutLists(node, 1), cutLists(structuredClone(node), 1));
});

test("T1b-10. the copied constants match their modules, and the windows are the UTC day", () => {
  for (const [k, l] of Object.entries(SELF_MODEL_FREE_LIMITS)) assert.equal(l.limit, FREE_LIMITS[k as keyof typeof FREE_LIMITS].limit, k);
  assert.deepEqual([...SELF_MODEL_AUTONOMY_GROUPS], [...AUTONOMY_GROUPS]);
  assert.deepEqual(VITALS_SUBJECTS, [...new Set([...DEPLOY_UNITS.flatMap((u) => [...u.services]), ...EXTERNAL_ORIGINS.flatMap((o) => [...o.services])])].sort());
  const w = selfModelWindows("2026-11-22")!;
  assert.deepEqual(
    [w.end, w.h24, w.d7, w.d30, w.day7, w.day30, w.monthDay, w.monthStart],
    ["2026-11-23T00:00:00.000Z", "2026-11-22T00:00:00.000Z", "2026-11-16T00:00:00.000Z", "2026-10-24T00:00:00.000Z", "2026-11-16", "2026-10-24", "2026-11-01", "2026-11-01T00:00:00.000Z"],
  );
  assert.equal(selfModelWindows("2026-02-30"), null);
  assert.equal(selfModelWindows("22-11-2026"), null);
});

test("T1b-11. the build is recorded: the SSOT segment, and the design's Status says steps 1–2 are built", () => {
  const ssot = lastReviewedRecord();
  assert.match(ssot, /^Last reviewed: 2026-11-16 \((?:[^\n]*; )?Telos T1b, 2026-11-22: [^\n]*self-model-assemble\.ts[^\n]*?; /);
  const design = read("docs/design/TELOS-T1-SELF-MODEL.md");
  assert.match(design, /^- \*\*Status:\*\* [^\n]*step 1 \(T1a[^\n]*step 2 \(T1b, the assembler[^\n]*steps 1–2[^\n]*\) built, the rest not built\.$/m);
});
