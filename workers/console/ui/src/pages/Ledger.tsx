import { useState } from "react";
import { Database, Download, ShieldCheck } from "lucide-react";
import { Badge, Empty, Field, JsonView, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, listOf } from "../lib/format";
import { ActivityChart, BarList, CATEGORICAL, DataTable, STATUS, bucketize } from "../components/viz";

const family = (t: unknown) => String(t ?? "other").split(".")[0] || "other";

export default function Ledger() {
  const { notify } = useSession();
  const [type, setType] = useState("");
  const [subject, setSubject] = useState("");
  const { data, loading, refresh } = usePoll(() => call("audit.events", undefined, undefined, { limit: "200", event_type: type.trim(), subject: subject.trim() }), 60_000, [type, subject]);
  const [verify, setVerify] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const rows = listOf(data, "events");
  const v = verify?.verification ?? verify;
  // Categorical hues in fixed order by family size; past seven, the rest fold into "other".
  const fams = Object.entries(rows.reduce((m: Record<string, number>, r: any) => { const f = family(r.event_type); m[f] = (m[f] ?? 0) + 1; return m; }, {})).sort((a, b) => Number(b[1]) - Number(a[1]));
  const top = fams.slice(0, 7).map(([f]) => f);
  const series = [...top.map((f, i) => ({ key: f, label: f, color: CATEGORICAL[i] })), ...(fams.length > 7 ? [{ key: "other", label: "other", color: STATUS.neutral }] : [])];
  const { buckets, bin } = bucketize(rows, (r: any) => r.created_at, (r: any) => (top.includes(family(r.event_type)) ? family(r.event_type) : "other"));
  const byType = Object.entries(rows.reduce((m: Record<string, number>, r: any) => { m[r.event_type] = (m[r.event_type] ?? 0) + 1; return m; }, {})).map(([label, value]) => ({ label, value: Number(value) }));
  const byActor = Object.entries(rows.reduce((m: Record<string, number>, r: any) => { m[r.actor] = (m[r.actor] ?? 0) + 1; return m; }, {})).map(([label, value]) => ({ label, value: Number(value) }));

  function exportJson() {
    const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), events: rows, verify }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "cerebrum-audit-export.json";
    document.body.appendChild(a); a.click(); a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  return (
    <div className="flex flex-col gap-3">
      <Panel title="Hash Chain" icon={<ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />}
        right={<div className="flex gap-2">
          <button type="button" className="btn" onClick={() => call("audit.verify").then(setVerify).catch((e) => notify("err", e.message))}><ShieldCheck className="h-3.5 w-3.5" />Verify chain</button>
          <button type="button" className="btn" onClick={exportJson}><Download className="h-3.5 w-3.5" />Export JSON</button>
        </div>}>
        {!v ? <Empty>Verify recomputes every event hash from the genesis event.</Empty> : (
          <div className="flex flex-wrap items-center gap-4">
            <span className={`mono text-[28px] font-extrabold ${v.valid ? "text-emerald-400" : "text-rose-400"}`} style={{ textShadow: "0 0 18px currentColor" }}>{v.valid ? "VALID" : "BROKEN"}</span>
            <Badge tone="cyan">{v.events_checked} events checked</Badge>
            {v.first_invalid_event_id && <Badge tone="red">first invalid {v.first_invalid_event_id}</Badge>}
          </div>
        )}
      </Panel>
      {rows.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel title={`Events over time · last ${rows.length}`}><ActivityChart buckets={buckets} bin={bin} series={series} caption="audit events over time by family" /></Panel>
          <Panel title="By event type · by actor">
            <BarList items={byType} max={8} />
            <div className="mb-1.5 mt-4 text-[10px] uppercase tracking-widest text-slate-500">Actors</div>
            <BarList items={byActor} max={6} color={STATUS.owner} />
          </Panel>
        </div>
      )}
      <Panel title="Audit Events" icon={<Database className="h-3.5 w-3.5 text-cyan-300" />}>
        <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Field label="Event type"><input className="field mono" value={type} onChange={(e) => setType(e.target.value)} /></Field>
          <Field label="Subject"><input className="field mono" value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
          <div className="flex items-end"><button type="button" className="btn" onClick={() => void refresh()}>Load</button></div>
        </div>
        {loading && !data ? <Skeleton rows={6} /> : (
          <DataTable rows={rows} rowKey={(r) => r.event_id} initialSort={{ key: "when", dir: "desc" }} maxHeight={560} empty="No events." footer={<span>click a row for the full event</span>}
            onRowClick={(r) => call("audit.event", r.event_id).then(setDetail).catch((e) => notify("err", e.message))} columns={[
              { key: "type", header: "event", sort: (r) => r.event_type, cell: (r) => <span className="mono text-[11px] text-cyan-200">{r.event_type}</span> },
              { key: "outcome", header: "outcome", sort: (r) => r.outcome, cell: (r) => <span className="text-[11px]">{r.outcome}</span> },
              { key: "subject", header: "subject", sort: (r) => r.subject, cell: (r) => <span className="mono text-[11px]">{r.subject}</span> },
              { key: "actor", header: "actor", sort: (r) => r.actor, cell: (r) => <span className="mono text-[11px] text-slate-400">{r.actor}</span> },
              { key: "hash", header: "hash", cell: (r) => <span className="mono text-[10px] text-slate-500">{String(r.event_hash ?? "").slice(0, 12)}</span> },
              { key: "when", header: "when", sort: (r) => Date.parse(r.created_at) || 0, cell: (r) => <span className="text-slate-500" title={r.created_at}>{ago(r.created_at)}</span> },
            ]} />
        )}
      </Panel>
      {detail && <Panel title="Event"><JsonView value={detail} /></Panel>}
    </div>
  );
}
