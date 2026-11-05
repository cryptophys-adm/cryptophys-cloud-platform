// TP-008: Long-term agent memory with Vectorize, memory.recall, memory.remember, recallContextForAgent, rememberOutcomeForAgent, pruneExpiredMemories.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APPROVER_EMAIL, CI_CLIENT_ID, OPERATOR_EMAIL, baseEnv, call, fakeWorkflow, migratedDb, req,
} from "./harness.ts";
import { verifyAuditChain } from "../src/audit.ts";
import { DEFAULT_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from "../src/ai-engine.ts";
import { CAPABILITIES, verifySyscallDecision } from "../src/capabilities.ts";
import { decide, parsePolicyRequest } from "../../policy-engine/src/index.ts";
import { proposeFromAgent } from "../../recovery-manager/src/index.ts";
import kernel from "../../ai-kernel/src/index.ts";
import {
  RETENTION_BATCH_LIMIT, RETENTION_DAYS, type VectorizeBinding, type VectorizeMatch,
  pruneExpiredMemories, rememberMemory,
} from "../../ai-kernel/src/memory.ts";
import { AUDITOR_ID, runAuditCycle } from "../../ai-kernel/src/auditor.ts";
import { DISCLAIMER, SIGNAL_ANALYST_ID, runSignalCycle } from "../../ai-kernel/src/signal-analyst.ts";
import { runCycle } from "../../ai-kernel/src/supervisor.ts";
import { syscall } from "../../ai-kernel/src/syscall.ts";

type Db = ReturnType<typeof migratedDb>;

interface TestVector {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
}

interface TestQueryOptions {
  topK?: number;
  filter?: Record<string, unknown>;
  returnMetadata?: boolean | "none" | "indexed" | "all";
}

function memory() {
  const m = new Map<string, unknown>();
  return { m, async get<T>(k: string) { return m.get(k) as T | undefined; }, async put(k: string, v: unknown) { m.set(k, structuredClone(v)); } };
}

function makeVector(seed = 1): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => Number((((i + seed) % 17) / 17).toFixed(4)));
}

function fakeVectorize() {
  const vectors = new Map<string, TestVector>();
  const queries: Array<{ vector: number[]; options: TestQueryOptions }> = [];
  const upserts: TestVector[][] = [];
  const deletes: string[][] = [];
  const binding: VectorizeBinding = {
    async upsert(batch: TestVector[]) {
      upserts.push(structuredClone(batch));
      for (const v of batch) {
        vectors.set(v.id, structuredClone(v));
      }
      return { count: batch.length };
    },
    async query(vector: number[], options: TestQueryOptions = {}) {
      queries.push({ vector: [...vector], options: structuredClone(options) });
      const filterAgent = options.filter?.agent_id;
      const matches: VectorizeMatch[] = [];
      for (const v of vectors.values()) {
        if (filterAgent && v.metadata?.agent_id !== filterAgent) continue;
        matches.push({ id: v.id, score: 0.91, metadata: v.metadata });
      }
      return { matches: matches.slice(0, options.topK ?? 3) };
    },
    async deleteByIds(ids: string[]) {
      deletes.push([...ids]);
      for (const id of ids) {
        vectors.delete(id);
      }
      return { count: ids.length };
    },
  };
  return { binding, vectors, queries, upserts, deletes };
}

function makeAiWithEmbeddings(opts: {
  embedVector?: number[] | (() => unknown);
  chatResponse?: unknown | ((model: string, input: Record<string, unknown>) => unknown);
} = {}) {
  const calls: Array<{ model: string; input: Record<string, unknown> }> = [];
  const binding = {
    async run(model: string, input: Record<string, unknown>) {
      calls.push({ model, input: structuredClone(input) });
      if (model === DEFAULT_EMBEDDING_MODEL) {
        if (typeof opts.embedVector === "function") {
          return opts.embedVector();
        }
        return { shape: [1, EMBEDDING_DIMENSIONS], data: [opts.embedVector ?? makeVector(1)] };
      }
      if (typeof opts.chatResponse === "function") {
        return opts.chatResponse(model, input);
      }
      return opts.chatResponse ?? { response: "{}" };
    },
  };
  return { binding, calls };
}

function memoryTestEnv(db: Db = migratedDb(), extra: Record<string, unknown> = {}) {
  const policyEnv = baseEnv("cryptophys-policy-engine", db);
  const recoveryEnv = { ...baseEnv("cryptophys-recovery-manager", db), RECOVERY_LIFECYCLE: fakeWorkflow().binding };
  const supMem = memory();
  const sigMem = memory();
  const audMem = memory();
  const vec = fakeVectorize();
  const ai = makeAiWithEmbeddings();
  const env: Record<string, unknown> = {
    ...baseEnv("cryptophys-ai-kernel", db, {
      OPERATOR_IDENTITIES: `${CI_CLIENT_ID},${OPERATOR_EMAIL},${APPROVER_EMAIL}`,
      APPROVER_IDENTITIES: APPROVER_EMAIL,
    }),
    AI: ai.binding,
    MEMORY: vec.binding,
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
  env.AUDITOR = {
    idFromName: (n: string) => n,
    get: () => ({ cycle: (t: "scheduled" | "operator") => runAuditCycle(env as never, audMem, t), status: async () => (await audMem.get("last_cycle")) ?? null }),
  };
  return { env, db, supMem, sigMem, audMem, vec, ai };
}

// ---------------------------------------------------------------- AC 1: memory.recall isolates by caller agent_id

test("memory.recall only returns the caller's memories and passes metadata filter { agent_id } to Vectorize", async () => {
  const { env, db, vec } = memoryTestEnv();
  assert.equal(CAPABILITIES["memory.recall"].tier, 0);
  assert.deepEqual(
    [CAPABILITIES["memory.remember"].tier, CAPABILITIES["memory.remember"].reversible, CAPABILITIES["memory.remember"].max_per_hour],
    [1, true, 12],
  );

  // Store one memory for supervisor and one memory for signal-analyst.
  const supRemember = await syscall(env as never, "supervisor", "memory.remember", {
    kind: "recovery_proposal",
    text: "Supervisor proposed recovery for cryptophys-platform-api.",
    source_ref: "plan_1",
  });
  assert.equal(supRemember.outcome, "succeeded");
  const supMemoryId = (supRemember.result as any).memory.memory_id as string;

  const sigRemember = await syscall(env as never, SIGNAL_ANALYST_ID, "memory.remember", {
    kind: "signal_digest",
    text: "Signal Analyst published BTCUSDT BUY confluence digest.",
    source_ref: "rpt_1",
  });
  assert.equal(sigRemember.outcome, "succeeded");
  const sigMemoryId = (sigRemember.result as any).memory.memory_id as string;

  // Supervisor recalls with an attempted spoofed agent_id in input; filter must still be { agent_id: "supervisor" }.
  const recalledSup = await syscall(env as never, "supervisor", "memory.recall", {
    query: "recent recovery and signal digests",
    top_k: 5,
    agent_id: SIGNAL_ANALYST_ID,
  });
  assert.equal(recalledSup.outcome, "succeeded");
  const lastQuery = vec.queries.at(-1)!;
  assert.deepEqual(lastQuery.options.filter, { agent_id: "supervisor" });
  assert.equal(lastQuery.options.topK, 5);
  const supMemories = (recalledSup.result as any).memories as Array<{ memory_id: string; text: string }>;
  assert.deepEqual(supMemories.map((m) => m.memory_id), [supMemoryId]);

  // Even if Vectorize misbehaved and returned another agent's memory_id, D1 hydration filters by WHERE agent_id = caller.
  const customVec = fakeVectorize();
  await customVec.binding.upsert([
    { id: supMemoryId, values: makeVector(1), metadata: { agent_id: "supervisor", kind: "recovery_proposal" } },
    { id: sigMemoryId, values: makeVector(2), metadata: { agent_id: "supervisor", kind: "signal_digest" } }, // forged metadata in vector index
  ]);
  const { env: envForged } = memoryTestEnv(db, { MEMORY: customVec.binding });
  const recalledForged = await syscall(envForged as never, "supervisor", "memory.recall", {
    query: "any memory",
    top_k: 10,
  });
  assert.equal(recalledForged.outcome, "succeeded");
  assert.deepEqual(customVec.queries.at(-1)!.options.filter, { agent_id: "supervisor" });
  assert.equal(customVec.queries.at(-1)!.options.topK, 5, "top_k is capped at 5");
  assert.deepEqual(((recalledForged.result as any).memories as any[]).map((m) => m.memory_id), [supMemoryId]);
});

// ---------------------------------------------------------------- AC 2: memory.remember writes D1 & Vectorize with same memory_id, metadata { agent_id, kind }, and rate limit

test("memory.remember writes D1 row and vector with identical memory_id and metadata { agent_id, kind }, enforces decision verification, and is rate-limited by policy", async () => {
  const { env, db, vec } = memoryTestEnv();

  const res = await syscall(env as never, AUDITOR_ID, "memory.remember", {
    kind: "audit_digest",
    text: "Audit chain verified across 42 events with 0 denied syscalls.",
    source_ref: "rpt_audit_1",
  });
  assert.equal(res.outcome, "succeeded");
  const memoryId = (res.result as any).memory.memory_id as string;
  assert.match(memoryId, /^mem_/);

  const row = db.raw.prepare("SELECT memory_id, agent_id, kind, text, source_ref FROM agent_memories WHERE memory_id = ?").get(memoryId) as any;
  assert.ok(row);
  assert.deepEqual(
    [row.memory_id, row.agent_id, row.kind, row.text, row.source_ref],
    [memoryId, AUDITOR_ID, "audit_digest", "Audit chain verified across 42 events with 0 denied syscalls.", "rpt_audit_1"],
  );

  const vector = vec.vectors.get(memoryId);
  assert.ok(vector, "vector must be upserted with the exact same memory_id");
  assert.equal(vector.values.length, EMBEDDING_DIMENSIONS);
  assert.deepEqual(vector.metadata, { agent_id: AUDITOR_ID, kind: "audit_digest" });

  // Direct call to rememberMemory without a valid decision_id is rejected by verifySyscallDecision.
  await assert.rejects(
    rememberMemory(env as never, AUDITOR_ID, "" as string, { kind: "audit_digest", text: "unverified" }),
    /policy_decision_required/,
  );

  // If Vectorize upsert throws, no D1 row is written.
  const failingVec: VectorizeBinding = {
    ...vec.binding,
    async upsert() {
      throw new Error("vectorize_upsert_failed");
    },
  };
  const { env: failEnv } = memoryTestEnv(db, { MEMORY: failingVec });
  const failedWrite = await syscall(failEnv as never, AUDITOR_ID, "memory.remember", {
    kind: "audit_digest",
    text: "Should not be written to D1 if upsert fails",
  });
  assert.equal(failedWrite.outcome, "failed");
  assert.equal(
    (db.raw.prepare("SELECT COUNT(*) AS n FROM agent_memories WHERE text LIKE 'Should not be written%'").get() as any).n,
    0,
  );

  // Rate limit: max_per_hour is 12 for memory.remember. 2 decisions were already consumed above for auditor.
  for (let i = 0; i < 10; i++) {
    const ok = await syscall(env as never, AUDITOR_ID, "memory.remember", {
      kind: "audit_digest",
      text: `Audit note #${i}`,
    });
    assert.equal(ok.outcome, "succeeded");
  }
  const thirteenth = await syscall(env as never, AUDITOR_ID, "memory.remember", {
    kind: "audit_digest",
    text: "Exceeds 12/hour rate limit",
  });
  assert.equal(thirteenth.outcome, "denied");
  assert.match(thirteenth.reason, /rate_limit/);
  assert.equal((await verifyAuditChain(db)).valid, true);
});

// ---------------------------------------------------------------- AC 3: Failing or missing MEMORY or embedding never fails a cycle or changes its actions
// Restored by the orchestrator after TP-017: the Signal Analyst no longer uses memory recall or AI,
// so this covers the supervisor and auditor (the TP-017 tests cover the Signal Analyst).

test("failing or missing MEMORY binding or embedding failure never fails a supervisor or auditor cycle or changes its actions", async () => {
  const db = migratedDb();
  const t1 = new Date(Date.now() - 20 * 60_000).toISOString();
  const t2 = new Date(Date.now() - 5 * 60_000).toISOString();
  db.raw.prepare(
    `INSERT INTO drift_observations (observation_id, service_id, desired_hash, observed_hash, drifted, evidence_json, observed_at)
     VALUES ('obs_1', 'cryptophys-platform-api', 'd', 'o', 1, '{"reasons":["version_mismatch"],"desired_version":"aaaaaaaaaaaa","probe":{"version_tag":"bbbbbbbbbbbb"}}', ?),
            ('obs_2', 'cryptophys-platform-api', 'd', 'o', 1, '{"reasons":["version_mismatch"],"desired_version":"aaaaaaaaaaaa","probe":{"version_tag":"bbbbbbbbbbbb"}}', ?)`,
  ).run(t1, t2);

  // Case A: MEMORY binding is missing (undefined); readiness reports memory_binding: false (503).
  const noMem = memoryTestEnv(db, { MEMORY: undefined });
  const unready = await call(kernel, noMem.env, req("GET", "/ready"));
  assert.deepEqual([unready.status, unready.body.checks.memory_binding], [503, false]);

  const supCycle = await runCycle(noMem.env as never, noMem.supMem, "scheduled");
  assert.equal(supCycle.memory, "unavailable");
  assert.deepEqual(
    supCycle.findings.map((f) => `${f.kind}:${f.action}:${f.outcome}`),
    ["drift:recovery.propose:succeeded"],
  );

  // Case B: MEMORY throws on query/upsert and embedding returns malformed data.
  const brokenVec: VectorizeBinding = {
    async upsert() { throw new Error("vectorize down"); },
    async query() { throw new Error("vectorize down"); },
    async deleteByIds() { throw new Error("vectorize down"); },
  };
  const brokenAi = makeAiWithEmbeddings({ embedVector: () => ({ data: [[1, 2, 3]] }) }); // wrong dimension -> embedding fails closed
  const broken = memoryTestEnv(db, { MEMORY: brokenVec, AI: brokenAi.binding });
  const audCycle = await runAuditCycle(broken.env as never, broken.audMem, "scheduled", Date.parse("2026-11-04T00:37:00.000Z"));
  assert.equal(audCycle.memory, "unavailable");
  assert.equal(audCycle.findings[0].action, "reports.publish");
  assert.equal(audCycle.findings[0].outcome, "succeeded");
});

// ---------------------------------------------------------------- AC 5: Retention deletes rows older than 90 days in both D1 and Vectorize, capped at 100 per cycle

test("retention deletes memories older than 90 days in both D1 and Vectorize with a cap of 100 per cycle", async () => {
  const { env, db, vec, audMem } = memoryTestEnv();
  const nowMs = Date.parse("2026-11-04T00:37:00.000Z");
  const expiredIso = new Date(nowMs - (RETENTION_DAYS + 5) * 86_400_000).toISOString();
  const freshIso = new Date(nowMs - 10 * 86_400_000).toISOString();

  // Insert 105 expired memories and 2 fresh memories in both D1 and Vectorize.
  const insertStmt = db.raw.prepare(
    `INSERT INTO agent_memories (memory_id, agent_id, kind, text, source_ref, created_at)
     VALUES (?, 'supervisor', 'recovery_proposal', ?, NULL, ?)`,
  );
  const batch: TestVector[] = [];
  for (let i = 0; i < 105; i++) {
    const id = `mem_old_${String(i).padStart(3, "0")}`;
    insertStmt.run(id, `Old memory ${i}`, expiredIso);
    batch.push({ id, values: makeVector(i), metadata: { agent_id: "supervisor", kind: "recovery_proposal" } });
  }
  for (let i = 0; i < 2; i++) {
    const id = `mem_fresh_${i}`;
    insertStmt.run(id, `Fresh memory ${i}`, freshIso);
    batch.push({ id, values: makeVector(i + 200), metadata: { agent_id: "supervisor", kind: "recovery_proposal" } });
  }
  await vec.binding.upsert(batch);
  assert.equal(vec.vectors.size, 107);

  // Running the auditor daily 00:37 UTC cycle triggers pruneExpiredMemories (cap 100).
  await runAuditCycle(env as never, audMem, "scheduled", nowMs);
  assert.equal(vec.deletes.at(-1)!.length, RETENTION_BATCH_LIMIT);
  // 5 old + 2 fresh remain in D1.
  const remainingOld = (db.raw.prepare("SELECT COUNT(*) AS n FROM agent_memories WHERE memory_id LIKE 'mem_old_%'").get() as any).n;
  const remainingFresh = (db.raw.prepare("SELECT COUNT(*) AS n FROM agent_memories WHERE memory_id LIKE 'mem_fresh_%'").get() as any).n;
  assert.equal(remainingOld, 5);
  assert.equal(remainingFresh, 2);

  // Second prune clears the remaining 5 expired rows.
  const secondPrune = await pruneExpiredMemories(env as never, nowMs);
  assert.equal(secondPrune.deleted, 5);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_memories WHERE memory_id LIKE 'mem_old_%'").get() as any).n, 0);
  assert.equal((db.raw.prepare("SELECT COUNT(*) AS n FROM agent_memories WHERE memory_id LIKE 'mem_fresh_%'").get() as any).n, 2);
  assert.equal(vec.vectors.has("mem_fresh_0"), true);
  assert.equal(vec.vectors.has("mem_old_000"), false);
});
