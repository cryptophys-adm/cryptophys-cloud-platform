import { useState } from "react";
import { Check, ShieldAlert } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "./ui";
import { call, phraseFor } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useOverview } from "../lib/overview";
import { useSession } from "../lib/session";
import { ago, listOf } from "../lib/format";

/** The kernel's bounds for an acknowledgement reason (ADR-0009 amendment 2026-11-13). */
const REASON_MIN = 10;
const REASON_MAX = 500;

/**
 * ADR-0009 amendment 2026-11-13 (owner: "Tambah tombol 'acknowledge'"): a critical report of the last 24 hours
 * makes every voter reject routine actions until an approver acknowledges it as handled. The list, the counts
 * and every acknowledgement come from the kernel (GET /v1/reports, the overview); the kernel checks the role,
 * the phrase and the reason again.
 */
function AcknowledgeForm({ report, reload }: { report: any; reload: () => void }) {
  const { act } = useSession();
  const { refresh } = useOverview();
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();
  const ok = trimmed.length >= REASON_MIN && trimmed.length <= REASON_MAX;
  return (
    <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end">
      <label className="block flex-1">
        <span className="label">Reason (required, {REASON_MIN}–{REASON_MAX} characters)</span>
        <textarea className="field min-h-[56px]" maxLength={REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="What was done about it, and why it no longer needs to block the agents" />
      </label>
      <button type="button" className="btn btn-approve !py-1" disabled={!ok} onClick={() => act({
        route: "kernel.report_acknowledge", params: report.report_id,
        body: { confirm: phraseFor("kernel.report_acknowledge", report.report_id), reason: trimmed },
        title: `Acknowledge critical report ${report.report_id.slice(0, 12)}`,
        lines: [
          "Your acknowledgement is recorded under your Access identity in the audit chain, with your reason.",
          "The report then no longer counts as open: it stops blocking consensus actions. Other unacknowledged critical reports still block.",
          "The report itself is kept as it is.",
        ],
        done: "Acknowledged.", after: () => { setReason(""); reload(); void refresh(); },
      })}><Check className="h-3.5 w-3.5" />Acknowledge…</button>
    </div>
  );
}

/**
 * The report rows with their acknowledgement state: the acknowledge form for approvers, read-only for everyone else.
 * The Cognition page passes the latest critical reports; the Owner page passes the open ones (GET /v1/owner/inbox).
 */
export function CriticalReportList({ rows, reload, empty }: { rows: any[]; reload: () => void; empty: string }) {
  const { who } = useSession();
  if (rows.length === 0) return <Empty>{empty}</Empty>;
  return (
    <div className="space-y-2">
      {rows.map((r: any) => (
        <div key={r.report_id} className="glass-inner px-3 py-2 text-[12px]">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 break-words text-slate-200">{r.subject}</span>
            <span className="text-[11px] text-slate-500" title={r.created_at}>{ago(r.created_at)}</span>
          </div>
          <div className="mt-0.5 break-words text-[11px] text-slate-500"><span className="mono text-cyan-300">{r.agent_id}</span> · {r.kind} · <span className="mono">{r.report_id}</span></div>
          {r.acknowledgement ? (
            <div className="mt-1.5 text-[11px] text-emerald-300">
              Acknowledged by <span className="mono">{r.acknowledgement.acknowledged_by}</span> at <span title={r.acknowledgement.acknowledged_at}>{r.acknowledgement.acknowledged_at}</span>
              <div className="text-slate-400">{r.acknowledgement.reason}</div>
            </div>
          ) : who.approver ? (
            <AcknowledgeForm report={r} reload={reload} />
          ) : (
            <div className="mt-1.5 text-[11px] text-slate-500"><Badge tone="red">not acknowledged</Badge> Only an approver can acknowledge.</div>
          )}
        </div>
      ))}
    </div>
  );
}

export default function CriticalReports() {
  const { ov } = useOverview();
  const { data, loading, error, refresh } = usePoll(() => call("kernel.reports", undefined, undefined, { limit: "100" }), 60_000);
  const rows = listOf(data, "reports").filter((r: any) => r.severity === "critical").slice(0, 20);
  const counts = ov?.agent_reports_24h?.counts;
  const open = typeof counts?.critical === "number" ? String(counts.critical) : "—";
  const acknowledged = typeof counts?.critical_acknowledged === "number" ? String(counts.critical_acknowledged) : "—";
  return (
    <Panel title="Critical reports" icon={<ShieldAlert className="h-3.5 w-3.5 text-rose-300" />}
      right={<span className="flex gap-1.5"><Badge tone={counts?.critical ? "red" : "slate"}>{open} open · 24 h</Badge><Badge tone="slate">{acknowledged} acknowledged · 24 h</Badge></span>}>
      <p className="mb-2 text-[11px] text-slate-500">An open critical report of the last 24 hours makes the agents reject routine actions. An approver can acknowledge it once it is handled; warnings and info do not block.</p>
      {loading && !data ? <Skeleton rows={2} /> : error ? <Empty>{error}</Empty> : (
        <CriticalReportList rows={rows} reload={() => void refresh()} empty="No critical report among the latest 100 reports." />
      )}
    </Panel>
  );
}
