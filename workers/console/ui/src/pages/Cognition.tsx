import { useState } from "react";
import { Brain } from "lucide-react";
import { Badge, Empty, Field, JsonView, Panel, Skeleton, severityTone } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { ago, listOf } from "../lib/format";

const KINDS = ["", "signal_digest", "audit_digest", "platform_digest", "xauusd_digest", "hud_digest"];

export default function Cognition() {
  const [agent, setAgent] = useState("");
  const [kind, setKind] = useState("");
  const [limit, setLimit] = useState("30");
  const [open, setOpen] = useState<string | null>(null);
  const q = { agent_id: agent.trim(), kind, limit: String(Math.max(1, Math.min(100, parseInt(limit, 10) || 30))) };
  const { data, loading, error, refresh } = usePoll(() => call("kernel.reports", undefined, undefined, q), 60_000, [agent, kind, limit]);
  const rows = listOf(data, "reports");
  return (
    <Panel title="Agent Reports" icon={<Brain className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone="cyan">{rows.length} shown</Badge>}>
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_120px_auto]">
        <Field label="Agent id"><input className="field mono" value={agent} onChange={(e) => setAgent(e.target.value)} /></Field>
        <Field label="Kind"><select className="field" value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k} value={k}>{k || "(any)"}</option>)}</select></Field>
        <Field label="Limit"><input className="field mono" type="number" min={1} max={100} value={limit} onChange={(e) => setLimit(e.target.value)} /></Field>
        <div className="flex items-end"><button type="button" className="btn" onClick={() => void refresh()}>Load</button></div>
      </div>
      {loading && !data ? <Skeleton rows={5} /> : error ? <Empty>{error}</Empty> : rows.length === 0 ? <Empty>No reports.</Empty> : (
        <div className="space-y-1.5">
          {rows.map((r: any) => (
            <div key={r.report_id} className="glass-inner px-3 py-2">
              <button type="button" className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => setOpen(open === r.report_id ? null : r.report_id)} aria-expanded={open === r.report_id}>
                <Badge tone={severityTone(r.severity)}>{r.severity}</Badge>
                <span className="min-w-0 flex-1 truncate text-[12px] text-slate-200">{r.subject}</span>
                <span className="mono text-[10px] text-cyan-300">{r.agent_id}</span>
                <span className="text-[10px] text-slate-500">{r.kind}</span>
                <span className="text-[10px] text-slate-600">{r.ai_status} · {ago(r.created_at)}</span>
              </button>
              {open === r.report_id && <div className="mt-2"><JsonView value={r.body ?? r} /></div>}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
