import { useMemo, useState } from "react";
import { Bot, Network } from "lucide-react";
import MeshGraph from "../components/MeshGraph";
import { Badge, Dot, Empty, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { fmt, listOf, navigate } from "../lib/format";

export default function Agents() {
  const { data, loading, error } = usePoll(() => call("kernel.agents"), 60_000);
  const agents = listOf(data, "agents");
  const [host, setHost] = useState("");
  const [q, setQ] = useState("");
  const hosts = useMemo(() => [...new Set(agents.map((a: any) => a.host_worker))].sort() as string[], [agents]);
  const rows = agents.filter((a: any) => (!host || a.host_worker === host) && (!q || a.agent_id.includes(q.toLowerCase())));
  const enabled = agents.filter((a: any) => a.status === "enabled").length;

  return (
    <div className="flex flex-col gap-3">
      <Panel title="AI Mesh" icon={<Network className="h-3.5 w-3.5 text-violet-300" />} right={<div className="flex flex-wrap justify-end gap-2"><Badge tone="purple">{agents.length} agents</Badge><Badge tone="green">{enabled} enabled</Badge>{data?.agents_enabled === false && <Badge tone="red">kill switch on</Badge>}</div>}>
        {loading && !data ? <Skeleton rows={6} /> : error && !data ? <Empty>{error}</Empty> : <MeshGraph agents={agents} onSelect={(id) => navigate(`#/agents/${id}`)} />}
        <div className="mt-2 flex flex-wrap gap-4 text-[10px] uppercase tracking-widest text-slate-500">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-violet-400" />kernel-hosted</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-cyan-400" />platform Workers</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-400" />XAUUSD</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-slate-600" />suspended</span>
        </div>
      </Panel>

      <Panel title="Agent Roster" icon={<Bot className="h-3.5 w-3.5 text-cyan-300" />}
        right={<div className="flex flex-wrap justify-end gap-2">
          <input className="field w-full py-1.5 sm:w-40" placeholder="search agent" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search agent" />
          <select className="field w-full py-1.5 sm:w-48" value={host} onChange={(e) => setHost(e.target.value)} aria-label="Host worker">
            <option value="">all hosts</option>{hosts.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
        </div>}>
        {loading && !data ? <Skeleton rows={6} /> : (
          <div className="table-wrap">
            <table className="tbl">
              <thead><tr><th>agent</th><th>name</th><th>host</th><th>tier</th><th>status</th><th>reason</th></tr></thead>
              <tbody>
                {rows.map((a: any) => (
                  <tr key={a.agent_id} className="cursor-pointer" onClick={() => navigate(`#/agents/${a.agent_id}`)}>
                    <td><a href={`#/agents/${a.agent_id}`} className="mono text-cyan-200 hover:underline">{a.agent_id}</a></td>
                    <td>{fmt(a.display_name)}</td>
                    <td className="mono text-[11px] text-slate-400">{a.host_worker}</td>
                    <td className="mono">{a.tier_max}</td>
                    <td><span className="inline-flex items-center gap-1.5"><Dot tone={a.status === "enabled" ? "green" : "slate"} />{a.status}</span></td>
                    <td className="text-slate-500">{fmt(a.status_reason)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
