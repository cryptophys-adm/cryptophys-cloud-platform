// TP-006: Signal Analyst agent (tier 1), signals.observe, reports.publish, agent_reports, HTTP and MCP.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, OPERATOR_JWT, OUTSIDER_JWT, baseEnv, call, fakeAi, fakeWorkflow, migratedDb, req,
} from "./harness.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { CAPABILITIES, verifySyscallDecision } from "../src/capabilities.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { proposeFromAgent } from "../../recovery-manager/src/index.ts";
import kernel from "../../ai-kernel/src/index.ts";
import { publishReport } from "../../ai-kernel/src/reports.ts";
import {
  DISCLAIMER, DIGEST_INTERVAL_MS, SIGNAL_ANALYST_ID, SignalAnalystCycleQueue, draftSignalDigestTask, runSignalCycle, templateDigest,
} from "../../ai-kernel/src/signal-analyst.ts";
import { runCycle } from "../../ai-kernel/src/supervisor.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";

type Db = ReturnType<typeof migratedDb>;

test("Signal Analyst cycle queue serializes concurrent work and recovers after rejection", async () => {
  const queue = new SignalAnalystCycleQueue();
  let active = 0;
  let maxActive = 0;
  const order: number[] = [];
  const tasks = [1, 2, 3].map((n) => queue.run(async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(n);
    active--;
    return n;
  }));
  assert.deepEqual(await Promise.all(tasks), [1, 2, 3]);
  assert.equal(maxActive, 1);
  assert.deepEqual(order, [1, 2, 3]);
  await assert.rejects(queue.run(async () => { throw new Error("queue test failure"); }), /queue test failure/);
  assert.equal(await queue.run(async () => 42), 42);
});

function memory() {
  const m = new Map<string, unknown>();
  return { m, async get<T>(k: string) { return m.get(k) as T | undefined; }, async put(k: string, v: unknown) { m.set(k, structuredClone(v)); } };
}

function analystEnv(db: Db = migratedDb(), extra: Record<string, unknown> = {}) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const recoveryEnv = { ...baseEnv("cryptophys-recovery-manager", db), RECOVERY_LIFECYCLE: fakeWorkflow().binding };
  const supMem = memory();
  const sigMem = memory();
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, {
      OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`,
      APPROVER_IDENTITIES: APPROVER_EMAIL,
    }),
    POLICY: {
      evaluate: async (input: Record<string, unknown>) => {
        const parsed = parsePolicyRequest(input);
        if (parsed instanceof Error) throw parsed;
        return decide(policyEnv as never, parsed);
      },
    },
    RECOVERY: {
      propose: async (agentId: string, decisionId: string, input: Record<string, unknown>) => {
        await verifySyscallDecision(db, decisionId, agentId, "recovery.propose");
        return proposeFromAgent(recoveryEnv as never, agentId, input);
      },
    },
    SIGNALS: {
      reingest: async (agentId: string, decisionId: string) => {
        await verifySyscallDecision(db, decisionId, agentId, "signals.reingest");
        return { run_id: "sig_test", series: 6, failed: 0 };
      },
    },
    ...extra,
  };
  env.SUPERVISOR = {
    idFromName: (n: string) => n,
    get: () => ({ cycle: (t: "scheduled" | "operator") => runCycle(env as never, supMem, t), status: async () => (await supMem.get("last_cycle")) ?? null }),
  };
  env.SIGNAL_ANALYST = {
    idFromName: (n: string) => n,
    get: () => ({ cycle: (t: "scheduled" | "operator") => runSignalCycle(env as never, sigMem, t), status: async () => (await sigMem.get("last_cycle")) ?? null }),
  };
  return { env, db, supMem, sigMem };
}

function seedConfluence(
  db: Db,
  symbol: string,
  basisCloseTime: number,
  score: number,
  action: "BUY" | "SELL" | "NEUTRAL",
  confidence = 0.32,
  mizan: { phi: number; signal_tier: string; direction_bias: string } = { phi: 0.08, signal_tier: "noise", direction_bias: "long" },
) {
  db.raw.prepare(
    `INSERT OR REPLACE INTO signal_confluence
     (symbol, basis_close_time, implementation, confluence_score, tf_scores_json, decision_json, mizan_json, computed_at)
     VALUES (?, ?, 'revised/1', ?, '{"1h":60}', ?, ?, '2026-11-04T12:00:00.000Z')`,
  ).run(symbol, basisCloseTime, score, JSON.stringify({ action, confidence }), JSON.stringify(mizan));
}

function seedMacro(db: Db, observedHour: number, fearGreed = 44, fgClass = "Fear", btcDom = 57.5) {
  db.raw.prepare(
    `INSERT OR REPLACE INTO macro_context
     (observed_hour, fear_greed, fear_greed_class, fear_greed_sentiment, fear_greed_time, btc_dominance, total_market_cap, sources_json, observed_at)
     VALUES (?, ?, ?, -0.12, ?, ?, 2500000000000, '{}', '2026-11-04T12:00:00.000Z')`,
  ).run(observedHour, fearGreed, fgClass, observedHour, btcDom);
}

// ---------------------------------------------------------------- AC 1: migration 0011

test("migration 0011 seeds signal-analyst at tier 1 and agent_reports rejects an unknown kind", () => {
  const db = migratedDb();
  const agent = db.raw.prepare("SELECT tier_max, status, host_worker, capabilities_json FROM agents WHERE agent_id = ?").get(SIGNAL_ANALYST_ID) as any;
  assert.deepEqual(
    [agent.tier_max, agent.status, agent.host_worker, JSON.parse(agent.capabilities_json)],
    [1, "enabled", "cryptophys-ai-kernel", ["signals.observe", "reports.publish"]],
  );
  assert.equal(CAPABILITIES["signals.observe"].tier, 0);
  assert.deepEqual(
    [CAPABILITIES["reports.publish"].tier, CAPABILITIES["reports.publish"].reversible, CAPABILITIES["reports.publish"].max_per_hour],
    [1, true, 4],
  );
  assert.throws(
    () => db.raw.prepare(
      `INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at)
       VALUES ('r1', 'signal-analyst', 'unknown_kind', 'info', 'subj', '{}', 'ok', NULL, 't0')`,
    ).run(),
    /CHECK/,
    "agent_reports must reject an unknown kind",
  );
  assert.throws(
    () => db.raw.prepare(
      `INSERT INTO agent_reports (report_id, agent_id, kind, severity, subject, body_json, ai_status, decision_id, created_at)
       VALUES ('r2', 'signal-analyst', 'signal_digest', 'fatal', 'subj', '{}', 'ok', NULL, 't0')`,
    ).run(),
    /CHECK/,
    "agent_reports must reject an unknown severity",
  );
});

// ---------------------------------------------------------------- AC 2: signals.observe & unknown tier-0

test("signals.observe returns the latest confluence per symbol and macro context; unknown tier-0 capabilities are denied", async () => {
  const { env, db } = analystEnv();
  seedConfluence(db, "BTCUSDT", 1000, 45, "NEUTRAL", 0.1, { phi: 0.04, signal_tier: "noise", direction_bias: "short" });
  seedConfluence(db, "BTCUSDT", 2000, 68, "BUY", 0.36, { phi: 0.12, signal_tier: "weak", direction_bias: "long" });
  seedConfluence(db, "ETHUSDT", 2000, 32, "SELL", 0.36, { phi: 0.09, signal_tier: "noise", direction_bias: "short" });
  seedMacro(db, 1000, 30, "Fear", 56.0);
  seedMacro(db, 2000, 62, "Greed", 58.2);

  const res = await syscall(env as never, SIGNAL_ANALYST_ID, "signals.observe");
  assert.equal(res.outcome, "succeeded");
  assert.equal(res.tier, 0);
  assert.equal(res.decision_id, null);
  const obs = (res as any).result;
  assert.equal(obs.symbols.length, 2);
  assert.deepEqual(
    obs.symbols.map((s: any) => [s.symbol, s.basis_close_time, s.confluence_score, s.action, s.confidence, s.mizan.phi, s.mizan.tier, s.mizan.direction]),
    [
      ["BTCUSDT", 2000, 68, "BUY", 0.36, 0.12, "weak", "long"],
      ["ETHUSDT", 2000, 32, "SELL", 0.36, 0.09, "noise", "short"],
    ],
  );
  assert.deepEqual([obs.macro.observed_hour, obs.macro.fear_greed, obs.macro.fear_greed_class], [2000, 62, "Greed"]);

  // Unknown capability not in catalog is denied.
  const unknownCap = await syscall(env as never, SIGNAL_ANALYST_ID, "unknown.observe");
  assert.equal(unknownCap.outcome, "denied");

  // Even a tier-0 capability in CAPABILITIES without a handler in syscall.ts is denied.
  CAPABILITIES["unwired.observe"] = { tier: 0, reversible: true, description: "test unwired tier 0" };
  db.raw.prepare("UPDATE agents SET capabilities_json = ? WHERE agent_id = ?")
    .run(JSON.stringify(["signals.observe", "reports.publish", "unwired.observe"]), SIGNAL_ANALYST_ID);
  try {
    const unwired = await syscall(env as never, SIGNAL_ANALYST_ID, "unwired.observe");
    assert.equal(unwired.outcome, "denied");
    assert.match((unwired as any).reason, /tier0_handler_missing/);
  } finally {
    delete CAPABILITIES["unwired.observe"];
    db.raw.prepare("UPDATE agents SET capabilities_json = ? WHERE agent_id = ?")
      .run(JSON.stringify(["signals.observe", "reports.publish"]), SIGNAL_ANALYST_ID);
  }
});

// ---------------------------------------------------------------- AC 3: deterministic trigger & publish trail

test("runSignalCycle publishes on action change or after 6 hours, records policy allow, agent_actions and audit chain, and skips when unchanged within 6 hours", async () => {
  const validAi = fakeAi({
    response: JSON.stringify({
      headline: "BTC BUY and ETH NEUTRAL",
      summary: "BTC confluence rose to BUY while ETH remains NEUTRAL.",
      symbols: [
        { symbol: "BTCUSDT", action: "BUY", note: "Score 66, bullish confluence." },
        { symbol: "ETHUSDT", action: "NEUTRAL", note: "Score 50, range-bound." },
      ],
    }),
  });
  const { env, db, sigMem } = analystEnv(migratedDb(), { AI: validAi });
  seedConfluence(db, "BTCUSDT", 1000, 66, "BUY", 0.32);
  seedConfluence(db, "ETHUSDT", 1000, 50, "NEUTRAL", 0.0);
  seedMacro(db, 1000, 52, "Neutral");

  const t0 = Date.UTC(2026, 10, 4, 1, 7, 0);
  const first = await runSignalCycle(env as never, sigMem, "scheduled", t0);
  assert.deepEqual(first.findings, [{ kind: "signals", action: "reports.publish", outcome: "succeeded", severity: "info", ai: "ok" }]);

  const rpt1 = db.raw.prepare("SELECT * FROM agent_reports").all() as any[];
  assert.equal(rpt1.length, 1);
  assert.deepEqual([rpt1[0].agent_id, rpt1[0].kind, rpt1[0].severity, rpt1[0].ai_status], [SIGNAL_ANALYST_ID, "signal_digest", "info", "ok"]);
  assert.ok(rpt1[0].decision_id.startsWith("dec_"));

  const dec = db.raw.prepare("SELECT decision, subject, action, resource FROM policy_decisions WHERE decision_id = ?").get(rpt1[0].decision_id) as any;
  assert.deepEqual([dec.decision, dec.subject, dec.action, dec.resource], ["allow", "agent:signal-analyst", "agent.syscall", "reports.publish"]);

  const act = db.raw.prepare("SELECT agent_id, capability, tier, outcome FROM agent_actions WHERE decision_id = ?").get(rpt1[0].decision_id) as any;
  assert.deepEqual([act.agent_id, act.capability, act.tier, act.outcome], [SIGNAL_ANALYST_ID, "reports.publish", 1, "succeeded"]);

  const aud = db.raw.prepare("SELECT actor, subject, outcome FROM audit_events WHERE event_type = 'agent.action' ORDER BY rowid DESC LIMIT 1").get() as any;
  assert.deepEqual([aud.actor, aud.subject, aud.outcome], ["agent:signal-analyst", "reports.publish", "succeeded"]);
  assert.equal((await verifyAuditChain(db)).valid, true);

  // Unchanged and < 6 hours -> no publish.
  const quiet = await runSignalCycle(env as never, sigMem, "scheduled", t0 + 3_600_000);
  assert.deepEqual(quiet.findings, [{ kind: "signals", action: "none" }]);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_reports").get() as any).n, 1);

  // 6 hours elapsed with same actions -> publishes periodic digest (info).
  const t6h = t0 + DIGEST_INTERVAL_MS;
  const periodic = await runSignalCycle(env as never, sigMem, "scheduled", t6h);
  assert.equal(periodic.findings[0].action, "reports.publish");
  assert.equal(periodic.findings[0].severity, "info");
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_reports").get() as any).n, 2);

  // Flip BUY -> SELL within 6 hours -> publishes immediately with warning severity.
  seedConfluence(db, "BTCUSDT", 3000, 30, "SELL", 0.4);
  validAi.reply = {
    response: JSON.stringify({
      headline: "BTC flipped to SELL",
      summary: "BTC reversed from BUY to SELL.",
      symbols: [
        { symbol: "BTCUSDT", action: "SELL", note: "Flipped BUY to SELL." },
        { symbol: "ETHUSDT", action: "NEUTRAL", note: "Still neutral." },
      ],
    }),
  };
  const flipped = await runSignalCycle(env as never, sigMem, "scheduled", t6h + 60_000);
  assert.deepEqual(flipped.findings, [{ kind: "signals", action: "reports.publish", outcome: "succeeded", severity: "warning", ai: "ok" }]);
  const latestRpt = db.raw.prepare("SELECT severity, body_json FROM agent_reports ORDER BY rowid DESC LIMIT 1").get() as any;
  assert.equal(latestRpt.severity, "warning");
  assert.deepEqual(JSON.parse(latestRpt.body_json).source_basis_close_times, { BTCUSDT: 3000, ETHUSDT: 1000 });
});

// ---------------------------------------------------------------- AC 4: AI validator, template fallback, disclaimer

test("draft_signal_digest rejects AI output that alters actions or symbols, falls back to templateDigest, and always includes the advisory disclaimer", async () => {
  const task = draftSignalDigestTask([
    { symbol: "BTCUSDT", action: "BUY" },
    { symbol: "ETHUSDT", action: "SELL" },
  ]);
  // Valid output passes.
  assert.ok(task.validate({
    headline: "Valid",
    summary: "Both match.",
    symbols: [
      { symbol: "BTCUSDT", action: "BUY", note: "ok" },
      { symbol: "ETHUSDT", action: "SELL", note: "ok" },
    ],
  }));
  // Changed action is rejected.
  assert.equal(task.validate({
    headline: "Hallucinated action",
    summary: "Changed BTC to SELL.",
    symbols: [
      { symbol: "BTCUSDT", action: "SELL", note: "wrong" },
      { symbol: "ETHUSDT", action: "SELL", note: "ok" },
    ],
  }), null);
  // Dropped symbol is rejected.
  assert.equal(task.validate({
    headline: "Dropped ETH",
    summary: "Missing symbol.",
    symbols: [{ symbol: "BTCUSDT", action: "BUY", note: "only one" }],
  }), null);
  // Added symbol is rejected.
  assert.equal(task.validate({
    headline: "Added SOL",
    summary: "Extra symbol.",
    symbols: [
      { symbol: "BTCUSDT", action: "BUY", note: "ok" },
      { symbol: "ETHUSDT", action: "SELL", note: "ok" },
      { symbol: "SOLUSDT", action: "BUY", note: "extra" },
    ],
  }), null);

  // Full cycle when AI changes an action -> invalid_output, templateDigest used, disclaimer present.
  const badAi = fakeAi({
    response: JSON.stringify({
      headline: "AI tries to flip BTC to SELL",
      summary: "Untrusted summary.",
      symbols: [{ symbol: "BTCUSDT", action: "SELL", note: "changed" }],
    }),
  });
  const { env, db, sigMem } = analystEnv(migratedDb(), { AI: badAi });
  seedConfluence(db, "BTCUSDT", 5000, 70, "BUY", 0.4);
  const res = await runSignalCycle(env as never, sigMem, "scheduled");
  assert.equal(res.findings[0].ai, "invalid_output");
  assert.equal(res.findings[0].outcome, "succeeded");
  const row = db.raw.prepare("SELECT ai_status, subject, body_json FROM agent_reports").get() as any;
  assert.equal(row.ai_status, "invalid_output");
  const body = JSON.parse(row.body_json);
  assert.equal(body.disclaimer, DISCLAIMER);
  assert.deepEqual(body.source_basis_close_times, { BTCUSDT: 5000 });
  assert.equal(body.symbols[0].action, "BUY");
  assert.equal(row.subject, templateDigest({ observed_at: "", symbols: [{ symbol: "BTCUSDT", basis_close_time: 5000, confluence_score: 70, action: "BUY", confidence: 0.4, decision: { action: "BUY", confidence: 0.4 }, mizan: null }], macro: null }).headline);
});

// ---------------------------------------------------------------- AC 5: capability & tier isolation

test("signal-analyst is denied recovery.propose and signals.reingest by capability grant and tier limit", async () => {
  const { env, db } = analystEnv();
  const prop = await syscall(env as never, SIGNAL_ANALYST_ID, "recovery.propose", { service_id: "cryptophys-platform-api" });
  assert.equal(prop.outcome, "denied");
  assert.match((prop as any).reason, /capability_granted/);

  const reing = await syscall(env as never, SIGNAL_ANALYST_ID, "signals.reingest");
  assert.equal(reing.outcome, "denied");
  assert.match((reing as any).reason, /capability_granted/);
  assert.match((reing as any).reason, /tier_within_agent_limit/);

  const deniedRows = db.raw.prepare("SELECT capability, outcome FROM agent_actions WHERE agent_id = ? ORDER BY rowid").all(SIGNAL_ANALYST_ID) as any[];
  assert.deepEqual(deniedRows.map((r) => [r.capability, r.outcome]), [
    ["recovery.propose", "denied"],
    ["signals.reingest", "denied"],
  ]);
});

// ---------------------------------------------------------------- AC 6: publishReport decision verification

test("publishReport rejects missing, mismatched, stale or already-used policy decision ids", async () => {
  const db = migratedDb();
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const validBody = { kind: "signal_digest", severity: "info", subject: "Test", ai_status: "ok", body: { disclaimer: DISCLAIMER } };

  await assert.rejects(publishReport(db, SIGNAL_ANALYST_ID, undefined, validBody), /policy_decision_required/);
  await assert.rejects(publishReport(db, SIGNAL_ANALYST_ID, "dec_00000000-0000-0000-0000-000000000000", validBody), /policy_decision_invalid/);

  const supDecision = await decide(policyEnv as never, { subject: "agent:supervisor", action: "agent.syscall", resource: "recovery.propose", context: {} });
  await assert.rejects(publishReport(db, SIGNAL_ANALYST_ID, supDecision.decision_id, validBody), /policy_decision_invalid/);

  const ok = await decide(policyEnv as never, { subject: "agent:signal-analyst", action: "agent.syscall", resource: "reports.publish", context: {} });
  const rpt = await publishReport(db, SIGNAL_ANALYST_ID, ok.decision_id, validBody);
  assert.equal(rpt.agent_id, SIGNAL_ANALYST_ID);

  // Record in agent_actions and verify replay is rejected.
  db.raw.prepare(
    `INSERT INTO agent_actions (action_id, agent_id, capability, tier, decision_id, outcome, input_json, result_json, created_at)
     VALUES ('act_used', 'signal-analyst', 'reports.publish', 1, ?, 'succeeded', '{}', '{}', ?)`,
  ).run(ok.decision_id, new Date().toISOString());
  await assert.rejects(publishReport(db, SIGNAL_ANALYST_ID, ok.decision_id, validBody), /policy_decision_already_used/);
});

// ---------------------------------------------------------------- AC 7: suspended agent & kill switch

test("runSignalCycle skips when signal-analyst is suspended or the global kill switch is off", async () => {
  const { env, db, sigMem } = analystEnv();
  seedConfluence(db, "BTCUSDT", 1000, 70, "BUY");

  db.raw.prepare("UPDATE agents SET status = 'suspended' WHERE agent_id = ?").run(SIGNAL_ANALYST_ID);
  const s1 = await runSignalCycle(env as never, sigMem, "scheduled");
  assert.equal(s1.skipped, "agent_suspended");
  assert.equal(s1.actions.length, 0);

  db.raw.prepare("UPDATE agents SET status = 'enabled' WHERE agent_id = ?").run(SIGNAL_ANALYST_ID);
  db.raw.prepare("UPDATE kernel_controls SET value = '0' WHERE control = 'agents_enabled'").run();
  const s2 = await runSignalCycle(env as never, sigMem, "scheduled");
  assert.equal(s2.skipped, "agents_disabled");
  assert.equal(s2.actions.length, 0);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_reports").get() as any).n, 0);
});

// ---------------------------------------------------------------- AC 8: HTTP, MCP, scheduling & readiness

test("HTTP GET /v1/reports, POST /v1/agents/signal-analyst/wake, MCP list_reports and wake_agent, scheduled minute-7 trigger, and readiness SIGNAL_ANALYST check", async () => {
  const { env, db } = analystEnv();
  seedConfluence(db, "BTCUSDT", 1000, 65, "BUY", 0.3);

  // Readiness requires SIGNAL_ANALYST.
  const ready = await call(kernel, env, req("GET", "/ready"));
  assert.deepEqual([ready.status, ready.body.checks.signal_analyst_binding], [200, true]);
  const unready = await call(kernel, { ...env, SIGNAL_ANALYST: undefined }, req("GET", "/ready"));
  assert.deepEqual([unready.status, unready.body.checks.signal_analyst_binding], [503, false]);
  const { SIGNAL_ANALYST: _signalAnalyst, ...withoutSignalAnalyst } = env;
  const absentBinding = await call(kernel, withoutSignalAnalyst, req("GET", "/ready"));
  assert.deepEqual([absentBinding.status, absentBinding.body.checks.signal_analyst_binding], [503, false]);

  // Operator wakes signal-analyst over HTTP.
  const woke = await call(kernel, env, req("POST", "/v1/agents/signal-analyst/wake", {}, OPERATOR_JWT));
  assert.equal(woke.status, 200);
  assert.equal(woke.body.agent_id, SIGNAL_ANALYST_ID);
  assert.equal(woke.body.trigger, "operator");
  assert.equal((await call(kernel, env, req("GET", "/v1/agents/signal-analyst", undefined, OPERATOR_JWT))).body.last_cycle.trigger, "operator");

  // GET /v1/reports requires an operator and supports filters.
  assert.equal((await call(kernel, env, req("GET", "/v1/reports", undefined, OUTSIDER_JWT))).status, 403);
  const reports = await call(kernel, env, req("GET", "/v1/reports?agent_id=signal-analyst&kind=signal_digest&limit=5", undefined, OPERATOR_JWT));
  assert.equal(reports.status, 200);
  assert.equal(reports.body.reports.length, 1);
  assert.equal(reports.body.reports[0].body.disclaimer, DISCLAIMER);

  // MCP list_reports and wake_agent(signal-analyst).
  const rpc = (body: unknown) => call(kernel, env, req("POST", "/mcp", body, OPERATOR_JWT));
  const tools = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.ok(tools.body.result.tools.some((t: any) => t.name === "list_reports"));
  const mcpReports = await rpc({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "list_reports", arguments: { agent_id: SIGNAL_ANALYST_ID, kind: "signal_digest", limit: 5 } },
  });
  assert.equal(JSON.parse(mcpReports.body.result.content[0].text).reports.length, 1);

  const mcpWake = await rpc({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "wake_agent", arguments: { agent_id: SIGNAL_ANALYST_ID } },
  });
  assert.equal(JSON.parse(mcpWake.body.result.content[0].text).agent_id, SIGNAL_ANALYST_ID);

  // Scheduled: minute 7 runs both supervisor and signal-analyst; minute 22 runs only supervisor.
  const waited7: Promise<unknown>[] = [];
  await kernel.scheduled({ cron: "7,22,37,52 * * * *", scheduledTime: Date.UTC(2026, 10, 4, 2, 7, 0) }, env as never, { waitUntil: (p) => waited7.push(p) });
  await Promise.all(waited7);
  assert.equal(waited7.length, 2);

  const waited22: Promise<unknown>[] = [];
  await kernel.scheduled({ cron: "7,22,37,52 * * * *", scheduledTime: Date.UTC(2026, 10, 4, 2, 22, 0) }, env as never, { waitUntil: (p) => waited22.push(p) });
  await Promise.all(waited22);
  assert.equal(waited22.length, 1);
});
