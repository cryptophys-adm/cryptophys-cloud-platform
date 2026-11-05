import type { BaseEnv } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";

const CONSUMPTION_RETENTION_DAYS = 7;
const RETENTION_BATCH = 2000;
const RETENTION_MAX_BATCHES = 5;

export async function pruneSyscallConsumptions(env: BaseEnv, now = Date.now()): Promise<{ deleted: number; cutoff: string; batches: number }> {
  const cutoff = new Date(now - CONSUMPTION_RETENTION_DAYS * 86_400_000).toISOString();
  let deleted = 0;
  let batches = 0;
  for (let i = 0; i < RETENTION_MAX_BATCHES; i++) {
    const res = await env.DB.prepare(
      `DELETE FROM agent_syscall_consumptions WHERE decision_id IN (
         SELECT decision_id FROM agent_syscall_consumptions WHERE consumed_at < ? ORDER BY consumed_at LIMIT ?)`,
    ).bind(cutoff, RETENTION_BATCH).run();
    const n = res.meta.changes ?? 0;
    deleted += n;
    batches++;
    if (n < RETENTION_BATCH) break;
  }
  if (deleted > 0) {
    await appendAuditEvent(env.DB, {
      event_type: "maintenance.retention",
      actor: "cryptophys-ai-kernel",
      subject: "agent_syscall_consumptions",
      outcome: "deleted",
      payload: { deleted, cutoff, retention_days: 7, decision: "owner 2026-11-05" },
    });
  }
  return { deleted, cutoff, batches };
}
