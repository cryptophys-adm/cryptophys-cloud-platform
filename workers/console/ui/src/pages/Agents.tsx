import { useMemo, useState } from "react";
import { BarChart3, Bot, Dna, Network } from "lucide-react";
import MeshGraph from "../components/MeshGraph";
import { Badge, Dot, Empty, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { ago, fmt, listOf, navigate } from "../lib/format";
import { BarList, DataTable, STATUS, Stat, StatusBar, type Column } from "../components/viz";

/** Tiers are ordered: one blue ramp, light to dark (validated ordinal steps for the dark surface). */
const TIER_RAMP = ["#86b6ef", "#3987e5", "#1c5cab"];
const caps = (a: any): string[] => Array.isArray(a.capabilities) ? a.capabilities.map((c: any) => String(c?.capability ?? c)) : [];
const ROSTER: Column<any>[] = [
  { key: "agent", header: "agent", sort: (a) => a.agent_id, cell: (a) => <a href={`#/agents/${a.agent_id}`} className="mono text-cyan-200 hover:underline" onClick={(e) => e.stopPropagation()}>{a.agent_id}</a> },
  { key: "name", header: "name", sort: (a) => a.display_name, cell: (a) => fmt(a.display_name) },
  { key: "host", header: "host", sort: (a) => a.host_worker, cell: (a) => <span className="mono text-[11px] text-slate-400">{a.host_worker}</span> },
  { key: "tier", header: "tier", sort: (a) => a.tier_max, align: "right", cell: (a) => <span className="mono">{a.tier_max}</span> },
  { key: "caps", header: "capabilities", sort: (a) => caps(a).length, align: "right", cell: (a) => <span className="mono" title={caps(a).join(", ")}>{caps(a).length || "—"}</span> },
  { key: "status", header: "status", sort: (a) => a.status, cell: (a) => <span className="inline-flex items-center gap-1.5"><Dot tone={a.status === "enabled" ? "green" : "slate"} />{a.status}</span> },
  { key: "reason", header: "reason", className: "wrap", cell: (a) => <span className="text-slate-500">{fmt(a.status_reason)}</span> },
];
const FINDINGS: Column<any>[] = [
  { key: "kind", header: "finding", sort: (f) => f.kind, cell: (f) => <span className="mono text-[11px] text-amber-200">{f.kind}</span> },
  { key: "subject", header: "subject", sort: (f) => f.subject, cell: (f) => <span className="mono text-[11px] text-slate-200">{f.subject}</span> },
  { key: "detail", header: "detail", className: "wrap", cell: (f) => <span className="text-slate-400">{f.detail}</span> },
];

export default function Agents() {
  const { data, loading, error } = usePoll(() => call("kernel.agents"), 60_000);
  const agents = listOf(data, "agents");
  const [host, setHost] = useState("");
  const [q, setQ] = useState("");
  const hosts = useMemo(() => [...new Set(agents.map((a: any) => a.host_worker))].sort() as string[], [agents]);
  const rows = agents.filter((a: any) => (!host || a.host_worker === host) && (!q || a.agent_id.includes(q.toLowerCase())));
  const enabled = agents.filter((a: any) => a.status === "enabled").length;
  const census = usePoll(() => call("forge.census", undefined, undefined, { limit: "1" }), 120_000);
  const latest = listOf(census.data, "census")[0];
  const perHost = Object.values(agents.reduce((m: Record<string, any>, a: any) => {
    const e = (m[a.host_worker] ??= { label: String(a.host_worker).replace(/^cryptophys-/, ""), value: 0, on: 0, off: 0 });
    e.value += 1; if (a.status === "enabled") e.on += 1; else e.off += 1;
    return m;
  }, {})).map((e: any) => ({ label: e.label, value: e.value, parts: [{ key: "on", label: "enabled", value: e.on, color: STATUS.good }, { key: "off", label: "suspended", value: e.off, color: STATUS.neutral }] }));
  const tiers = [0, 1, 2].map((t) => ({ key: String(t), label: `tier ${t}`, value: agents.filter((a: any) => Number(a.tier_max) === t).length, color: TIER_RAMP[t] }));
  const findings: any[] = latest?.findings ?? [];
  const byKind = Object.entries(findings.reduce((m: Record<string, number>, f: any) => { m[f.kind] = (m[f.kind] ?? 0) + 1; return m; }, {})).map(([label, value]) => ({ label, value: Number(value) }));

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

      <div className="grid gap-3 lg:grid-cols-[1fr_1fr]">
        <Panel title="Agents per Worker" icon={<BarChart3 className="h-3.5 w-3.5 text-cyan-300" />}>
          {loading && !data ? <Skeleton rows={4} /> : <BarList items={perHost} max={12} series={[{ label: "enabled", color: STATUS.good }, { label: "suspended", color: STATUS.neutral }]} empty="No agents registered." />}
        </Panel>
        <Panel title="Autonomy tiers" icon={<Bot className="h-3.5 w-3.5 text-violet-300" />}>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="agents" value={agents.length} />
            <Stat label="enabled" value={enabled} tone="good" />
            <Stat label="suspended" value={agents.length - enabled} tone="neutral" />
          </div>
          <div className="mt-3 text-[10px] uppercase tracking-widest text-slate-500">Highest tier an agent may use (ADR-0007)</div>
          <StatusBar className="mt-1.5" segments={tiers} />
        </Panel>
      </div>

      <Panel title="Organism census · DNA vs registries" icon={<Dna className="h-3.5 w-3.5 text-emerald-300" />}
        right={latest ? <Badge tone={latest.status === "consistent" ? "green" : latest.status === "invalid" ? "red" : "amber"}>{latest.status} · {findings.length} finding{findings.length === 1 ? "" : "s"}</Badge> : null}>
        {census.loading && !census.data ? <Skeleton /> : !latest ? <Empty>The Forge has not taken a census yet.</Empty> : (
          <div className="space-y-2 text-[12px]">
            <div className="text-[11px] text-slate-400">main {String(latest.main_sha).slice(0, 7)} · {latest.taken_at ? ago(latest.taken_at) : ""}</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="organs" value={latest.organs} /><Stat label="agents" value={latest.agents} /><Stat label="council seats" value={latest.voters} /><Stat label="AI engines" value={latest.engines} />
            </div>
            {findings.length ? (
              <>
                {byKind.length > 1 && <BarList items={byKind} color={STATUS.warning} />}
                <DataTable rows={findings} columns={FINDINGS} rowKey={(f, i) => `${f.kind}:${f.subject}:${i}`} maxHeight={300} dense />
              </>
            ) : <p className="text-[11px] text-emerald-300">Every Worker, agent, seat and engine the DNA declares is registered, with the declared host and capabilities.</p>}
          </div>
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-slate-500">ADR-0013: each Worker declares itself in organism.json. The Forge compares that DNA with the live registries on every main commit; differences reach the owner's notices, and registration follows through consensus.</p>
      </Panel>

      <Panel title="Agent Roster" icon={<Bot className="h-3.5 w-3.5 text-cyan-300" />}
        right={<div className="flex flex-wrap justify-end gap-2">
          <input className="field w-full py-1.5 sm:w-40" placeholder="search agent" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search agent" />
          <select className="field w-full py-1.5 sm:w-48" value={host} onChange={(e) => setHost(e.target.value)} aria-label="Host worker">
            <option value="">all hosts</option>{hosts.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
        </div>}>
        {loading && !data ? <Skeleton rows={6} /> : (
          <DataTable rows={rows} columns={ROSTER} rowKey={(a) => a.agent_id} onRowClick={(a) => navigate(`#/agents/${a.agent_id}`)} initialSort={{ key: "host", dir: "asc" }} maxHeight={520} empty="No agent matches." />
        )}
      </Panel>
    </div>
  );
}
