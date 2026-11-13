import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { baseEnv, call, migratedDb, req } from "./harness.ts";
import { observe } from "../../ai-kernel/src/syscall.ts";

const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);

function insertReport(db: any, opts: { severity: string; subject?: string; created_at: string; body?: string }) {
  const reportId = "rep_" + Math.random().toString(36).slice(2);
  db.raw.prepare("INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, created_at) VALUES (?, 'audit-ledger', 'audit_digest', ?, ?, ?, 'deterministic', ?)")
    .run(reportId, opts.severity, opts.subject ?? "subj", opts.body ?? "{}", opts.created_at);
  return reportId;
}

test("TP-015 counts", async () => {
  const db = migratedDb();
  const within = (h: number) => new Date(NOW - h * 3600_000).toISOString();
  insertReport(db, { severity: "critical", created_at: within(1) });
  insertReport(db, { severity: "critical", created_at: within(2) });
  insertReport(db, { severity: "warning", created_at: within(3) });
  for (let i = 0; i < 3; i++) insertReport(db, { severity: "info", created_at: within(4 + i) });
  insertReport(db, { severity: "critical", created_at: new Date(NOW - 25 * 3600_000).toISOString() });

  const env: any = baseEnv("cryptophys-ai-kernel", db);
  const res: any = await observe(env as never, NOW);
  assert.deepEqual(res.agent_reports_24h.counts, { critical: 2, warning: 1, info: 3, critical_acknowledged: 0 });
  assert.equal(res.agent_reports_24h.since, new Date(NOW - 24 * 3600_000).toISOString());
});

test("TP-015 latest attention", async () => {
  const db = migratedDb();
  for (let i = 0; i < 7; i++) {
    insertReport(db, { severity: i % 2 === 0 ? "critical" : "warning", created_at: new Date(NOW - (i + 1) * 1000).toISOString() });
  }
  const env: any = baseEnv("cryptophys-ai-kernel", db);
  const res: any = await observe(env as never, NOW);
  assert.equal(res.agent_reports_24h.latest_attention.length, 5);
  const keys = Object.keys(res.agent_reports_24h.latest_attention[0]).sort();
  assert.deepEqual(keys, ["agent_id", "created_at", "kind", "report_id", "severity", "subject"]);
  // newest first
  const times = res.agent_reports_24h.latest_attention.map((r: any) => r.created_at);
  const sorted = [...times].sort().reverse();
  assert.deepEqual(times, sorted);
});

test("TP-015 critical alert metadata is complete beyond latest_attention and excludes subjects", async () => {
  const db = migratedDb();
  const ids: string[] = [];
  for (let i = 0; i < 7; i++) {
    ids.push(insertReport(db, {
      severity: "critical",
      subject: "UNTRUSTED_SECRET_SUBJECT_" + i,
      created_at: new Date(NOW - (100 + i) * 1000).toISOString(),
    }));
  }
  for (let i = 0; i < 6; i++) {
    insertReport(db, {
      severity: "warning",
      created_at: new Date(NOW - (i + 1) * 1000).toISOString(),
    });
  }
  const env: any = baseEnv("cryptophys-ai-kernel", db);
  const res: any = await observe(env as never, NOW);
  assert.equal(res.agent_reports_24h.latest_attention.length, 5);
  assert.ok(res.agent_reports_24h.latest_attention.every((r: any) => r.severity === "warning"));
  assert.equal(res.agent_reports_24h.counts.critical, 7);
  assert.equal(res.agent_reports_24h.latest_critical.length, 5);
  assert.ok(res.agent_reports_24h.latest_critical.every((r: any) => r.kind === "audit_digest"));
  assert.ok(res.agent_reports_24h.latest_critical.every((r: any) => !("subject" in r)));
  assert.equal(
    res.agent_reports_24h.critical_fingerprint,
    createHash("sha256").update([...ids].sort().join(",")).digest("hex"),
  );
});

test("TP-015 no body leak", async () => {
  const db = migratedDb();
  insertReport(db, { severity: "critical", created_at: new Date(NOW - 1000).toISOString(), body: '{"SECRET_MARKER":"x"}' });
  const env: any = baseEnv("cryptophys-ai-kernel", db);
  const res: any = await observe(env as never, NOW);
  assert.equal(JSON.stringify(res).includes("SECRET_MARKER"), false);
});

test("TP-015 subject bounded", async () => {
  const db = migratedDb();
  insertReport(db, { severity: "warning", subject: "a".repeat(300), created_at: new Date(NOW - 1000).toISOString() });
  const env: any = baseEnv("cryptophys-ai-kernel", db);
  const res: any = await observe(env as never, NOW);
  assert.equal(res.agent_reports_24h.latest_attention[0].subject.length, 200);
});

test("TP-015 empty", async () => {
  const db = migratedDb();
  const env: any = baseEnv("cryptophys-ai-kernel", db);
  const res: any = await observe(env as never, NOW);
  assert.deepEqual(res.agent_reports_24h.counts, { critical: 0, warning: 0, info: 0, critical_acknowledged: 0 });
  assert.deepEqual(res.agent_reports_24h.latest_attention, []);
  assert.deepEqual(res.agent_reports_24h.latest_critical, []);
  assert.equal(res.agent_reports_24h.critical_fingerprint, createHash("sha256").update("").digest("hex"));
});

test("TP-015 fail-safe", async () => {
  const db = migratedDb();
  const wrapped: any = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (sql.includes("agent_reports")) throw new Error("boom");
          return target.prepare(sql);
        };
      }
      return (target as any)[prop];
    },
  });
  const env: any = baseEnv("cryptophys-ai-kernel", wrapped);
  const res: any = await observe(env as never, NOW);
  assert.ok(Array.isArray(res.services));
  assert.ok(Array.isArray(res.open_agent_plans));
  assert.ok(Array.isArray(res.agents_enabled) || typeof res.agents_enabled !== "undefined");
  assert.equal(res.agent_reports_24h.error, "reports_unavailable");
  assert.deepEqual(res.agent_reports_24h.latest_critical, []);
  assert.equal(res.agent_reports_24h.critical_fingerprint, null);
});

test("TP-015 surfaces", async () => {
  const env: any = baseEnv("cryptophys-ai-kernel", migratedDb());
  const r = await call((await import("../../ai-kernel/src/index.ts")).default, env, req("GET", "/v1/status"));
  assert.ok(r.body.agent_reports_24h);
});

