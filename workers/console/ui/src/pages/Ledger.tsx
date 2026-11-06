import { useState } from "react";
import { Database, Download, ShieldCheck } from "lucide-react";
import { Badge, Empty, Field, JsonView, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, listOf } from "../lib/format";

export default function Ledger() {
  const { notify } = useSession();
  const [type, setType] = useState("");
  const [subject, setSubject] = useState("");
  const { data, loading, refresh } = usePoll(() => call("audit.events", undefined, undefined, { limit: "50", event_type: type.trim(), subject: subject.trim() }), 60_000, [type, subject]);
  const [verify, setVerify] = useState<any>(null);
  const [detail, setDetail] = useState<any>(null);
  const rows = listOf(data, "events");
  const v = verify?.verification ?? verify;

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
      <Panel title="Audit Events" icon={<Database className="h-3.5 w-3.5 text-cyan-300" />}>
        <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <Field label="Event type"><input className="field mono" value={type} onChange={(e) => setType(e.target.value)} /></Field>
          <Field label="Subject"><input className="field mono" value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
          <div className="flex items-end"><button type="button" className="btn" onClick={() => void refresh()}>Load</button></div>
        </div>
        {loading && !data ? <Skeleton rows={6} /> : rows.length === 0 ? <Empty>No events.</Empty> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>event</th><th>actor</th><th>subject</th><th>outcome</th><th>hash</th><th>when</th></tr></thead>
            <tbody>{rows.map((r: any) => (
              <tr key={r.event_id} className="cursor-pointer" onClick={() => call("audit.event", r.event_id).then(setDetail).catch((e) => notify("err", e.message))}>
                <td className="mono text-[11px] text-cyan-200">{r.event_type}</td><td className="mono text-[11px]">{r.actor}</td>
                <td className="mono max-w-[220px] truncate text-[11px]">{r.subject}</td><td>{r.outcome}</td>
                <td className="mono text-[10px] text-slate-500">{String(r.event_hash ?? "").slice(0, 12)}</td><td className="text-slate-500">{ago(r.created_at)}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </Panel>
      {detail && <Panel title="Event"><JsonView value={detail} /></Panel>}
    </div>
  );
}
