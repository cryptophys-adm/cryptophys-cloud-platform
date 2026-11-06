import { useState } from "react";
import { Scale } from "lucide-react";
import { Badge, Empty, Field, JsonView, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, listOf } from "../lib/format";

export default function Policy() {
  const { act, notify } = useSession();
  const { data, loading, refresh } = usePoll(() => call("policy.decisions", undefined, undefined, { limit: "40" }), 60_000);
  const [detail, setDetail] = useState<any>(null);
  const [f, setF] = useState({ action: "", resource: "", context: "{}" });
  const [result, setResult] = useState<any>(null);
  const rows = listOf(data, "decisions");

  return (
    <div className="flex flex-col gap-3">
      <Panel title="Evaluate" icon={<Scale className="h-3.5 w-3.5 text-violet-300" />} right={<span className="text-[10px] uppercase tracking-widest text-slate-600">records a decision · changes nothing</span>}>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          <Field label="Action"><input className="field mono" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })} /></Field>
          <Field label="Resource"><input className="field mono" value={f.resource} onChange={(e) => setF({ ...f, resource: e.target.value })} /></Field>
        </div>
        <Field label="Context (JSON object)" className="mt-2"><textarea className="field mono min-h-[80px]" value={f.context} onChange={(e) => setF({ ...f, context: e.target.value })} /></Field>
        <button type="button" className="btn mt-3" onClick={() => {
          let ctx: any;
          try { ctx = JSON.parse(f.context); } catch { notify("err", "Context is not valid JSON."); return; }
          if (!ctx || typeof ctx !== "object" || Array.isArray(ctx)) { notify("err", "Context must be a JSON object."); return; }
          if (!f.action.trim() || !f.resource.trim()) { notify("err", "Action and resource are required."); return; }
          act({ route: "policy.evaluate", body: { action: f.action.trim(), resource: f.resource.trim(), context: ctx }, title: "Evaluate", done: "Evaluated.", after: (d) => { setResult(d); void refresh(); } });
        }}>Evaluate</button>
        {result && <div className="mt-3"><JsonView value={result} /></div>}
      </Panel>
      <Panel title="Decisions" right={<Badge tone="purple">{rows.length}</Badge>}>
        {loading && !data ? <Skeleton rows={5} /> : rows.length === 0 ? <Empty>No decisions.</Empty> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>decision</th><th>subject</th><th>action</th><th>resource</th><th>reason</th><th>when</th></tr></thead>
            <tbody>{rows.map((r: any) => (
              <tr key={r.decision_id} className="cursor-pointer" onClick={() => call("policy.decision", r.decision_id).then(setDetail).catch((e) => notify("err", e.message))}>
                <td><Badge tone={r.decision === "allow" ? "green" : "red"}>{r.decision}</Badge></td>
                <td className="mono text-[11px]">{r.subject}</td><td className="mono text-[11px] text-cyan-200">{r.action}</td>
                <td className="mono max-w-[200px] truncate text-[11px]">{r.resource}</td><td className="max-w-[260px] truncate text-slate-400">{r.reason}</td><td className="text-slate-500">{ago(r.created_at)}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </Panel>
      {detail && <Panel title="Decision evidence"><JsonView value={detail} /></Panel>}
    </div>
  );
}
