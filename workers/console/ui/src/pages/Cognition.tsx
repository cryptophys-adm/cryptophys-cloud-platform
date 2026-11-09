import { useState } from "react";
import { BarChart3, Brain, LineChart } from "lucide-react";
import { Badge, Empty, Field, JsonView, Panel, Skeleton, severityTone } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { ago, listOf } from "../lib/format";
import { explainCode } from "../lib/plain";
import CognitionPanel from "../components/CognitionPanel";
import { ActivityChart, BarList, DataTable, STATUS, StatusBar, bucketize } from "../components/viz";

const SEVERITY = [
  { key: "info", label: "info", color: STATUS.info },
  { key: "warning", label: "warning", color: STATUS.warning },
  { key: "critical", label: "critical", color: STATUS.critical },
];
const sevKey = (s?: string) => (s === "critical" || s === "warning" ? s : "info");

const KINDS = ["", "signal_digest", "audit_digest", "platform_digest", "xauusd_digest", "hud_digest", "knowledge_audit"];

export default function Cognition() {
  const [agent, setAgent] = useState("");
  const [kind, setKind] = useState("");
  const [limit, setLimit] = useState("30");
  const q = { agent_id: agent.trim(), kind, limit: String(Math.max(1, Math.min(100, parseInt(limit, 10) || 30))) };
  const { data, loading, error, refresh } = usePoll(() => call("kernel.reports", undefined, undefined, q), 60_000, [agent, kind, limit]);
  const rows = listOf(data, "reports");
  const { buckets, bin } = bucketize(rows, (r: any) => r.created_at, (r: any) => sevKey(r.severity));
  const byAgent = Object.values(rows.reduce((m: Record<string, any>, r: any) => {
    const e = (m[r.agent_id] ??= { label: r.agent_id, href: `#/agents/${r.agent_id}`, value: 0, c: { info: 0, warning: 0, critical: 0 } });
    e.value += 1; e.c[sevKey(r.severity)] += 1;
    return m;
  }, {})).map((e: any) => ({ ...e, parts: SEVERITY.map((s) => ({ ...s, value: e.c[s.key] })) }));
  const ai = rows.filter((r: any) => r.ai_status === "ok").length;
  return (
    <div className="flex flex-col gap-3">
    {/* The AI Cognition rail sits in the right column only on very wide screens (2xl); show it here otherwise (2026-11-07). */}
    <div className="2xl:hidden"><CognitionPanel /></div>
    {rows.length > 0 && (
      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title={`Reports over time · last ${rows.length}`} icon={<LineChart className="h-3.5 w-3.5 text-cyan-300" />}>
          <ActivityChart buckets={buckets} bin={bin} series={SEVERITY} caption="reports over time by severity" />
        </Panel>
        <Panel title="By agent" icon={<BarChart3 className="h-3.5 w-3.5 text-violet-300" />}>
          <BarList items={byAgent} series={SEVERITY} />
          <div className="mt-3 text-[10px] uppercase tracking-widest text-slate-500">Written by</div>
          <StatusBar className="mt-1.5" segments={[{ key: "ai", label: "AI", value: ai, color: STATUS.info }, { key: "tpl", label: "template (AI unavailable)", value: rows.length - ai, color: STATUS.neutral }]} />
        </Panel>
      </div>
    )}
    <Panel title="Agent Reports" icon={<Brain className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone="cyan">{rows.length} shown</Badge>}>
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_120px_auto]">
        <Field label="Agent id"><input className="field mono" value={agent} onChange={(e) => setAgent(e.target.value)} /></Field>
        <Field label="Kind"><select className="field" value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k} value={k}>{k || "(any)"}</option>)}</select></Field>
        <Field label="Limit"><input className="field mono" type="number" min={1} max={100} value={limit} onChange={(e) => setLimit(e.target.value)} /></Field>
        <div className="flex items-end"><button type="button" className="btn" onClick={() => void refresh()}>Load</button></div>
      </div>
      {loading && !data ? <Skeleton rows={5} /> : error ? <Empty>{error}</Empty> : (
        <DataTable rows={rows} rowKey={(r) => r.report_id} initialSort={{ key: "when", dir: "desc" }} maxHeight={520} empty="No reports." expand={(r) => <JsonView value={r.body ?? r} />} columns={[
          { key: "sev", header: "severity", sort: (r) => ({ critical: 3, warning: 2 } as Record<string, number>)[r.severity] ?? 1, cell: (r) => <Badge tone={severityTone(r.severity)}>{r.severity}</Badge> },
          { key: "subject", header: "subject", className: "wrap", sort: (r) => r.subject, cell: (r) => <span className="text-slate-200">{r.subject}</span> },
          { key: "agent", header: "agent", sort: (r) => r.agent_id, cell: (r) => <span className="mono text-[11px] text-cyan-300">{r.agent_id}</span> },
          { key: "kind", header: "kind", sort: (r) => r.kind, cell: (r) => <span className="text-[11px] text-slate-400">{r.kind}</span> },
          { key: "ai", header: "written by", sort: (r) => r.ai_status, cell: (r) => <span className="text-[11px] text-slate-500" title={explainCode(String(r.ai_status ?? ""))}>{r.ai_status === "ok" ? "AI" : "template"}</span> },
          { key: "when", header: "when", sort: (r) => Date.parse(r.created_at) || 0, cell: (r) => <span className="text-slate-500" title={r.created_at}>{ago(r.created_at)}</span> },
        ]} />
      )}
    </Panel>
    </div>
  );
}
