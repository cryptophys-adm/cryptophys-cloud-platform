import { useState } from "react";
import { Scale } from "lucide-react";
import { Badge, Empty, Field, JsonView, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, listOf } from "../lib/format";
import { ActivityChart, BarList, DataTable, STATUS, StatusBar, bucketize } from "../components/viz";

const DECISIONS = [{ key: "allow", label: "allow", color: STATUS.good }, { key: "deny", label: "deny", color: STATUS.critical }];

export default function Policy() {
  const { act, notify } = useSession();
  const { data, loading, refresh } = usePoll(() => call("policy.decisions", undefined, undefined, { limit: "100" }), 60_000);
  const [detail, setDetail] = useState<any>(null);
  const [f, setF] = useState({ action: "", resource: "", context: "{}" });
  const [result, setResult] = useState<any>(null);
  const rows = listOf(data, "decisions");
  const { buckets, bin } = bucketize(rows, (r: any) => r.created_at, (r: any) => (r.decision === "allow" ? "allow" : "deny"));
  const byAction = Object.values(rows.reduce((m: Record<string, any>, r: any) => {
    const e = (m[r.action] ??= { label: r.action, value: 0, a: 0, d: 0 });
    e.value += 1; if (r.decision === "allow") e.a += 1; else e.d += 1;
    return m;
  }, {})).map((e: any) => ({ label: e.label, value: e.value, parts: [{ key: "allow", label: "allow", value: e.a, color: STATUS.good }, { key: "deny", label: "deny", value: e.d, color: STATUS.critical }] }));
  const denyReasons = Object.entries(rows.filter((r: any) => r.decision !== "allow").reduce((m: Record<string, number>, r: any) => {
    for (const id of String(r.reason ?? "").replace(/^failed:\s*/, "").split(/,\s*/).filter(Boolean)) m[id] = (m[id] ?? 0) + 1;
    return m;
  }, {})).map(([label, value]) => ({ label, value: Number(value) }));

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
      {rows.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel title={`Decisions over time · last ${rows.length}`}>
            <StatusBar className="mb-3" segments={DECISIONS.map((d) => ({ ...d, value: rows.filter((r: any) => (r.decision === "allow") === (d.key === "allow")).length }))} legend={false} />
            <ActivityChart buckets={buckets} bin={bin} series={DECISIONS} caption="policy decisions over time" />
          </Panel>
          <Panel title="By action · failed checks">
            <BarList items={byAction} series={DECISIONS} />
            {denyReasons.length > 0 && <><div className="mb-1.5 mt-4 text-[10px] uppercase tracking-widest text-slate-500">Checks that denied</div><BarList items={denyReasons} color={STATUS.critical} /></>}
          </Panel>
        </div>
      )}
      <Panel title="Decisions" right={<Badge tone="purple">{rows.length}</Badge>}>
        {loading && !data ? <Skeleton rows={5} /> : (
          <DataTable rows={rows} rowKey={(r) => r.decision_id} initialSort={{ key: "when", dir: "desc" }} empty="No decisions." footer={<span>click a row for its evidence</span>}
            onRowClick={(r) => call("policy.decision", r.decision_id).then(setDetail).catch((e) => notify("err", e.message))} columns={[
              { key: "decision", header: "decision", sort: (r) => r.decision, cell: (r) => <Badge tone={r.decision === "allow" ? "green" : "red"}>{r.decision}</Badge> },
              { key: "action", header: "action", sort: (r) => r.action, cell: (r) => <span className="mono text-[11px] text-cyan-200">{r.action}</span> },
              { key: "resource", header: "resource", sort: (r) => r.resource, cell: (r) => <span className="mono text-[11px]">{r.resource}</span> },
              { key: "subject", header: "subject", sort: (r) => r.subject, cell: (r) => <span className="mono text-[11px] text-slate-400">{r.subject}</span> },
              { key: "reason", header: "reason", className: "wrap", cell: (r) => <span className="text-slate-400">{r.reason}</span> },
              { key: "when", header: "when", sort: (r) => Date.parse(r.created_at) || 0, cell: (r) => <span className="text-slate-500" title={r.created_at}>{ago(r.created_at)}</span> },
            ]} />
        )}
      </Panel>
      {detail && <Panel title="Decision evidence"><JsonView value={detail} /></Panel>}
    </div>
  );
}
