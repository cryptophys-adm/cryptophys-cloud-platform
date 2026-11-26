// HAIC H1b (docs/design/HAIC-H0-H1.md §3.2): the chat's tools. Every one reads, through a reader the Console already
// serves to operators; none writes, wakes, suspends or proposes. Each returns its data and its evidence refs.
// HAIC H3d: owner_corrections reads the corrections ledger (corrections-read.ts), matched on the subjects and refs of the
// turn's other tool results (the caller passes them as `context`), each correction cited as ev:platform/correction/<id>.
import { CHAT_TOOLS, type PlannedCall } from "../../control-plane-shared/src/conversation.ts";
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { ownerInbox } from "./owner-inbox.ts";
import { consensusMode, listProposals } from "./consensus.ts";
import { listReports } from "./reports.ts";
import { listAgents } from "./kernel.ts";
import { listKnowledge } from "./knowledge.ts";
import { metabolismView } from "./metabolism-view.ts";
import { meshView } from "./mesh-view.ts";
import { visionView } from "./vision-view.ts";
import { adrDetailView, adrListView, validAdrId } from "./adr-view.ts";
import { latestCensusRow } from "./organism.ts";
import { ownerCorrections, ownerCorrectionsSection, type CorrectionKeys } from "./corrections-read.ts";
import { modelRouterStatus } from "../../control-plane-shared/src/model-router.ts";

export interface DocsBinding { read(input: Record<string, unknown>): Promise<Record<string, unknown>> }
export interface PolicyDryRunBinding { dryRun?(input: Record<string, unknown>): Promise<Record<string, unknown>> }
export interface ToolEnv { DB: D1Database; FORGE_DOCS?: DocsBinding; POLICY?: PolicyDryRunBinding; [k: string]: unknown }
export interface ToolResult { name: string; ok: boolean; data: unknown; refs: string[]; error?: string }
/** What owner_corrections matches on when its arguments name nothing: the other results' keys, and a time floor. */
export interface ToolContext extends Partial<CorrectionKeys> { since?: string | null }

const at = (now: number) => new Date(now).toISOString();
/** The data without its `updated_by` fields (an operator's email), at any depth. */
const withoutActors = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (k, x) => (k === "updated_by" ? undefined : x)));
const own = (o: unknown, key: string): unknown[] => { const v = (o as Record<string, unknown> | null)?.[key]; return Array.isArray(v) ? v : []; };

/** One tool call. A refusal or a failure is a result too (ok false), so the answer can say what was not measured. */
export async function runTool(env: ToolEnv, call: PlannedCall, now = Date.now(), context: ToolContext = {}): Promise<ToolResult> {
  const spec = CHAT_TOOLS.find((t) => t.name === call.name);
  if (!spec) return { name: call.name, ok: false, data: null, refs: [], error: "unknown_tool" };
  const a = call.args;
  const base = `ev:platform/${call.name}@${at(now)}`;
  const e = env as never;
  try {
    switch (call.name) {
      case "owner_inbox": {
        const d = await ownerInbox(env.DB, now);
        return { name: call.name, ok: true, data: d, refs: [base, ...own(d, "items").flatMap((i) => own(i, "evidence_refs") as string[]).slice(0, 30)] };
      }
      case "consensus": {
        const d = { mode: await consensusMode(e), ...(await listProposals(e, Number(a.limit ?? 20))) };
        return { name: call.name, ok: true, data: d, refs: [base, ...own(d, "proposals").map((p) => `ev:platform/consensus/${(p as { proposal_id?: string }).proposal_id}`).slice(0, 30)] };
      }
      case "reports": {
        const d = await listReports(env.DB, { agent_id: typeof a.agent_id === "string" ? a.agent_id : null, limit: Number(a.limit ?? 20) });
        const rows = own(d, "reports").filter((r) => typeof a.severity !== "string" || (r as { severity?: string }).severity === a.severity);
        return { name: call.name, ok: true, data: { ...d, reports: rows }, refs: [base, ...rows.map((r) => `ev:platform/report/${(r as { report_id?: string }).report_id}`).slice(0, 30)] };
      }
      case "agents": return { name: call.name, ok: true, data: await listAgents(e), refs: [base] };
      case "knowledge": return { name: call.name, ok: true, data: await listKnowledge(env.DB, { limit: Number(a.limit ?? 20), status: typeof a.status === "string" ? a.status : null }, now), refs: [base] };
      case "metabolism": return { name: call.name, ok: true, data: await metabolismView(e, now), refs: [base] };
      case "mesh": return { name: call.name, ok: true, data: await meshView(e, now), refs: [base] };
      case "vision": return { name: call.name, ok: true, data: visionView(), refs: [base] };
      case "adr_progress": {
        if (typeof a.adr === "string") {
          if (!validAdrId(a.adr)) return { name: call.name, ok: false, data: null, refs: [], error: "invalid_adr_id" };
          const one = await adrDetailView(e, a.adr);
          return one.ok ? { name: call.name, ok: true, data: one.view, refs: [`ev:adr/${a.adr}#phases`, base] } : { name: call.name, ok: false, data: null, refs: [], error: one.error };
        }
        return { name: call.name, ok: true, data: await adrListView(e, now), refs: [base] };
      }
      case "census": {
        const row = await latestCensusRow(e);
        return { name: call.name, ok: true, data: row ?? { available: false }, refs: [row ? `ev:platform/census/${(row as { main_sha?: string }).main_sha ?? "latest"}` : base] };
      }
      case "docs": {
        if (!env.FORGE_DOCS) return { name: call.name, ok: false, data: null, refs: [], error: "docs_not_bound" };
        const d = await env.FORGE_DOCS.read({ path: a.path, section: a.section, query: a.query, limit: 6 });
        const refs = [...own(d, "sections"), ...own(d, "results")].map((s) => (s as { ref?: string }).ref).filter((r): r is string => typeof r === "string");
        return { name: call.name, ok: d.available === true && !d.refused, data: d, refs: refs.length ? refs.slice(0, 30) : [base], ...(d.refused ? { error: String(d.refused) } : {}) };
      }
      // Owner 2026-11-26: the Command page's Beam panel read (GET /v1/model-router), read only. Who switched (updated_by,
      // an email) is left out: the result goes to the model, which may be an outside provider (Beam).
      case "model_router": return { name: call.name, ok: true, data: withoutActors(await modelRouterStatus(env.DB, e, now)), refs: [base] };
      case "owner_corrections": {
        // The arguments, when given, say what to match; otherwise the turn's other results do; with neither, the newest.
        const subject = typeof a.subject === "string" ? a.subject : null, target = typeof a.target === "string" ? a.target : null;
        if (subject !== null && !/^(agent|model|seat):[A-Za-z0-9_.:-]{1,100}$/.test(subject)) return { name: call.name, ok: false, data: null, refs: [], error: "invalid_subject" };
        if (target !== null && !/^ev:[a-z]+\/\S{1,280}$/.test(target)) return { name: call.name, ok: false, data: null, refs: [], error: "invalid_target" };
        const keys = subject || target ? { subjects: subject ? [subject] : [], refs: target ? [target] : [] } : { subjects: context.subjects ?? [], refs: context.refs ?? [] };
        const since = context.since ?? null;
        const rows = await ownerCorrections(env.DB, { ...keys, since, limit: Number(a.limit ?? 10) });
        const data = ownerCorrectionsSection(rows, { subjects: keys.subjects.length, refs: keys.refs.length, since });
        return { name: call.name, ok: true, data, refs: [base, ...rows.map((c) => c.ref)] };
      }
      case "policy_dry_run": {
        if (typeof env.POLICY?.dryRun !== "function") return { name: call.name, ok: false, data: null, refs: [], error: "dry_run_unavailable" };
        const d = await env.POLICY.dryRun({ subject: typeof a.subject === "string" ? a.subject : "chat:dry-run", action: a.action, resource: a.resource, context: a.context ?? {} });
        return { name: call.name, ok: true, data: d, refs: [base] };
      }
    }
  } catch (err) {
    return { name: call.name, ok: false, data: null, refs: [], error: String((err as Error)?.message ?? err).slice(0, 120) };
  }
  return { name: call.name, ok: false, data: null, refs: [], error: "unknown_tool" };
}
