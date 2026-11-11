import { useMemo, useState } from "react";
import { Activity, BarChart3, Bot, Dna, Network, Radio, UserPlus } from "lucide-react";
import MeshGraph from "../components/MeshGraph";
import { Badge, Dot, Empty, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { ago, fmt, listOf, navigate } from "../lib/format";
import { ActivityChart, BarList, DataTable, STATUS, Stat, StatusBar, bucketize, type Column } from "../components/viz";

/**
 * AI Mesh (owner 2026-11-11: "masih statis belum autonomous dan dinamis"). The graph, the activity and
 * the roster come from GET /v1/mesh: what each agent did in the last 24 h (syscalls, council votes,
 * reports), the Forge census (self-awareness) and the self-registration proposals. Polled every 30 s.
 */
const TIER_RAMP = ["#86b6ef", "#3987e5", "#1c5cab"];
const LIVENESS = [
  { key: "active", label: "active (1 h)", color: STATUS.good, tone: "green" },
  { key: "recent", label: "recent (24 h)", color: STATUS.info, tone: "cyan" },
  { key: "idle", label: "idle", color: STATUS.neutral, tone: "slate" },
  { key: "suspended", label: "suspended", color: STATUS.serious, tone: "amber" },
] as const;
const OUTCOMES = [
  { key: "succeeded", label: "succeeded", color: STATUS.good },
  { key: "denied", label: "denied by policy", color: STATUS.warning },
  { key: "failed", label: "failed", color: STATUS.critical },
];
const liveTone = (l?: string) => (LIVENESS.find((x) => x.key === l)?.tone ?? "slate") as "green" | "cyan" | "slate" | "amber";
const caps = (a: any): string[] => Array.isArray(a.capabilities) ? a.capabilities.map((c: any) => String(c?.capability ?? c)) : [];
const short = (s: string) => String(s ?? "").replace(/^cryptophys-/, "");

const ROSTER: Column<any>[] = [
  { key: "agent", header: "agent", sort: (a) => a.agent_id, cell: (a) => <a href={`#/agents/${a.agent_id}`} className="mono text-cyan-200 hover:underline" onClick={(e) => e.stopPropagation()}>{a.agent_id}</a> },
  { key: "live", header: "liveness", sort: (a) => LIVENESS.findIndex((x) => x.key === a.liveness), cell: (a) => a.liveness ? <Badge tone={liveTone(a.liveness)}>{a.liveness}</Badge> : <span className="text-slate-600">—</span> },
  { key: "seen", header: "last seen", sort: (a) => Date.parse(a.last_seen_at ?? "") || 0, cell: (a) => <span className="text-slate-400" title={a.last_seen_at ?? ""}>{a.last_seen_at ? ago(a.last_seen_at) : "—"}</span> },
  { key: "last", header: "last action", className: "wrap", cell: (a) => a.last_capability ? <span className="mono text-[11px] text-slate-300">{a.last_capability}{a.last_outcome && a.last_outcome !== "succeeded" ? <span className="text-amber-300"> · {a.last_outcome}</span> : null}</span> : <span className="text-slate-600">—</span> },
  { key: "acts", header: "actions 24 h", align: "right", sort: (a) => a.actions_24h ?? -1, cell: (a) => <span className="mono">{a.actions_24h ?? "—"}</span> },
  { key: "votes", header: "votes 24 h", align: "right", sort: (a) => a.votes_24h ?? -1, cell: (a) => <span className="mono">{a.voter ? a.votes_24h ?? "—" : <span className="text-slate-600">no seat</span>}</span> },
  { key: "reps", header: "reports 24 h", align: "right", sort: (a) => a.reports_24h ?? -1, cell: (a) => <span className="mono">{a.reports_24h ?? "—"}</span> },
  { key: "host", header: "host", sort: (a) => a.host_worker, cell: (a) => <span className="mono text-[11px] text-slate-400">{a.host_worker}</span> },
  { key: "tier", header: "tier", sort: (a) => a.tier_max, align: "right", cell: (a) => <span className="mono">{a.tier_max}</span> },
  { key: "caps", header: "caps", sort: (a) => caps(a).length, align: "right", cell: (a) => <span className="mono" title={caps(a).join(", ")}>{caps(a).length || "—"}</span> },
  { key: "status", header: "status", sort: (a) => a.status, cell: (a) => <span className="inline-flex items-center gap-1.5"><Dot tone={a.status === "enabled" ? "green" : "slate"} />{a.status}</span> },
];
const STREAM: Column<any>[] = [
  { key: "when", header: "when", sort: (x) => Date.parse(x.created_at) || 0, cell: (x) => <span className="text-slate-500" title={x.created_at}>{ago(x.created_at)}</span> },
  { key: "agent", header: "agent", sort: (x) => x.agent_id, cell: (x) => <a href={`#/agents/${x.agent_id}`} className="mono text-[11px] text-cyan-200 hover:underline">{x.agent_id}</a> },
  { key: "cap", header: "capability", sort: (x) => x.capability, cell: (x) => <span className="mono text-[11px] text-slate-200">{x.capability}</span> },
  { key: "tier", header: "tier", align: "right", cell: (x) => <span className="mono">{x.tier}</span> },
  { key: "out", header: "outcome", sort: (x) => x.outcome, cell: (x) => <Badge tone={x.outcome === "succeeded" ? "green" : x.outcome === "denied" ? "amber" : "red"}>{x.outcome}</Badge> },
];
const CENSUS: Column<any>[] = [
  { key: "when", header: "taken", sort: (c) => Date.parse(c.taken_at) || 0, cell: (c) => <span className="text-slate-500" title={c.taken_at}>{ago(c.taken_at)}</span> },
  { key: "sha", header: "main", cell: (c) => <span className="mono text-[11px]">{String(c.main_sha).slice(0, 7)}</span> },
  { key: "status", header: "status", sort: (c) => c.status, cell: (c) => <Badge tone={c.status === "consistent" ? "green" : c.status === "invalid" ? "red" : "amber"}>{c.status}</Badge> },
  { key: "find", header: "findings", align: "right", sort: (c) => c.findings?.length ?? 0, cell: (c) => <span className="mono">{c.findings?.length ?? 0}</span> },
  { key: "org", header: "organs · agents · engines · seats", align: "right", cell: (c) => <span className="mono text-[11px] text-slate-400">{c.organs} · {c.agents} · {c.engines} · {c.voters}</span> },
];
const FINDINGS: Column<any>[] = [
  { key: "kind", header: "finding", sort: (f) => f.kind, cell: (f) => <span className="mono text-[11px] text-amber-200">{f.kind}</span> },
  { key: "subject", header: "subject", sort: (f) => f.subject, cell: (f) => <span className="mono text-[11px] text-slate-200">{f.subject}</span> },
  { key: "detail", header: "detail", className: "wrap", cell: (f) => <span className="text-slate-400">{f.detail}</span> },
];
const REGISTRATIONS: Column<any>[] = [
  { key: "when", header: "proposed", sort: (r) => Date.parse(r.created_at) || 0, cell: (r) => <span className="text-slate-500" title={r.created_at}>{ago(r.created_at)}</span> },
  { key: "action", header: "action", sort: (r) => r.action, cell: (r) => <span className="mono text-[11px] text-slate-200">{String(r.action).replace(/_/g, " ")}</span> },
  { key: "target", header: "target", cell: (r) => <span className="mono text-[11px] text-slate-400">{short(r.target)}</span> },
  { key: "class", header: "class", cell: (r) => <Badge tone={r.class === "critical" ? "purple" : "slate"}>{r.class === "critical" ? "owner click" : "consensus"}</Badge> },
  { key: "votes", header: "votes", align: "right", cell: (r) => <span className="mono">{r.approvals}/{r.eligible}{r.rejections ? ` · ${r.rejections} no` : ""}</span> },
  { key: "status", header: "status", sort: (r) => r.status, cell: (r) => <Badge tone={r.status === "executed" ? "green" : /fail|reject|expired/.test(r.status) ? "red" : "amber"}>{r.status}</Badge> },
];

export default function Agents() {
  const { data, loading, error } = usePoll(() => call("kernel.agents"), 60_000);
  const mesh = usePoll(() => call("kernel.mesh"), 30_000);
  const registry = listOf(data, "agents");
  const live = new Map(listOf(mesh.data, "agents").map((a: any) => [a.agent_id, a]));
  const agents = registry.map((a: any) => ({ ...a, ...(live.get(a.agent_id) ?? {}) }));
  const [host, setHost] = useState("");
  const [q, setQ] = useState("");
  const hosts = useMemo(() => [...new Set(agents.map((a: any) => a.host_worker))].sort() as string[], [agents]);
  const rows = agents.filter((a: any) => (!host || a.host_worker === host) && (!q || a.agent_id.includes(q.toLowerCase())));
  const enabled = agents.filter((a: any) => a.status === "enabled").length;
  const hasLive = live.size > 0;
  const count = (k: string) => agents.filter((a: any) => a.liveness === k).length;

  const activity24 = listOf(mesh.data, "activity_24h");
  const stream = listOf(mesh.data, "activity");
  const { buckets, bin } = bucketize(activity24, (x: any) => x.created_at, (x: any) => x.outcome);
  const busiest = agents.filter((a: any) => (a.actions_24h ?? 0) + (a.votes_24h ?? 0) + (a.reports_24h ?? 0) > 0)
    .map((a: any) => ({ label: a.agent_id, value: (a.actions_24h ?? 0) + (a.votes_24h ?? 0) + (a.reports_24h ?? 0), href: `#/agents/${a.agent_id}`,
      parts: [{ key: "a", label: "actions", value: a.actions_24h ?? 0, color: STATUS.info }, { key: "v", label: "votes", value: a.votes_24h ?? 0, color: STATUS.owner }, { key: "r", label: "reports", value: a.reports_24h ?? 0, color: STATUS.good }] }));
  const capMix = Object.entries(activity24.reduce((m: Record<string, number>, x: any) => { m[x.capability] = (m[x.capability] ?? 0) + 1; return m; }, {})).map(([label, value]) => ({ label, value: Number(value) }));

  const censusRows = listOf(mesh.data, "census");
  const latest = censusRows[0];
  const findings: any[] = latest?.findings ?? [];
  const regs = listOf(mesh.data, "registrations");
  const protocol: string[] = Array.isArray(mesh.data?.protocol) ? mesh.data.protocol : [];
  const tiers = [0, 1, 2].map((t) => ({ key: String(t), label: `tier ${t}`, value: agents.filter((a: any) => Number(a.tier_max) === t).length, color: TIER_RAMP[t] }));

  return (
    <div className="flex flex-col gap-3">
      <h1 className="sr-only">AI Mesh</h1>
      <Panel title="AI Mesh · live" icon={<Network className="h-3.5 w-3.5 text-violet-300" />}
        right={<div className="flex flex-wrap justify-end gap-2">
          <Badge tone="purple">{agents.length} agents</Badge>
          {hasLive ? <><Badge tone="green">{count("active")} active</Badge><Badge tone="cyan">{count("recent")} recent</Badge><Badge tone="slate">{count("idle")} idle</Badge></> : <Badge tone="green">{enabled} enabled</Badge>}
          {data?.agents_enabled === false && <Badge tone="red">kill switch on</Badge>}
          {mesh.data?.observed_at && <Badge tone="slate">{ago(mesh.data.observed_at)}</Badge>}
        </div>}>
        {loading && !data ? <Skeleton rows={6} /> : error && !data ? <Empty>{error}</Empty> : <MeshGraph agents={agents} onSelect={(id) => navigate(`#/agents/${id}`)} />}
        <div className="mt-2 flex flex-wrap gap-4 text-[10px] uppercase tracking-widest text-slate-500">
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-violet-400" />kernel-hosted</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-cyan-400" />platform Workers</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-amber-400" />XAUUSD</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full border border-slate-400" />idle (no action in 24 h)</span>
          <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-slate-600" />suspended</span>
          <span>pulsing ring = acted in the last hour</span>
        </div>
        {hasLive && <StatusBar className="mt-3" segments={LIVENESS.map((l) => ({ key: l.key, label: l.label, value: count(l.key), color: l.color }))} />}
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title={`Agent activity · 24 h · ${activity24.length} syscalls`} icon={<Activity className="h-3.5 w-3.5 text-cyan-300" />}>
          {mesh.loading && !mesh.data ? <Skeleton rows={3} /> : activity24.length ? (
            <>
              <ActivityChart buckets={buckets} bin={bin} series={OUTCOMES} caption="agent syscalls over 24 h by outcome" />
              <div className="mt-3 text-[10px] uppercase tracking-widest text-slate-500">By capability</div>
              <div className="mt-1.5"><BarList items={capMix} max={8} color={STATUS.info} /></div>
            </>
          ) : <Empty>{mesh.error ? `The mesh view is not available yet: ${mesh.error}` : "No agent syscall in the last 24 h."}</Empty>}
        </Panel>
        <Panel title="Most active agents · 24 h" icon={<BarChart3 className="h-3.5 w-3.5 text-violet-300" />}>
          {mesh.loading && !mesh.data ? <Skeleton rows={4} /> : (
            <BarList items={busiest} max={12} series={[{ label: "actions", color: STATUS.info }, { label: "council votes", color: STATUS.owner }, { label: "reports", color: STATUS.good }]} empty="No agent activity in the last 24 h." />
          )}
        </Panel>
      </div>

      <Panel title="Live activity stream" icon={<Radio className="h-3.5 w-3.5 text-emerald-300" />} right={<Badge tone="slate">refreshes every 30 s</Badge>}>
        {mesh.loading && !mesh.data ? <Skeleton rows={5} /> : (
          <DataTable rows={stream} columns={STREAM} rowKey={(x, i) => `${x.agent_id}:${x.created_at}:${i}`} initialSort={{ key: "when", dir: "desc" }} maxHeight={360} dense empty="No agent syscall in the last 24 h." />
        )}
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Self-awareness · organism census" icon={<Dna className="h-3.5 w-3.5 text-emerald-300" />}
          right={latest ? <Badge tone={latest.status === "consistent" ? "green" : latest.status === "invalid" ? "red" : "amber"}>{latest.status} · {findings.length} finding{findings.length === 1 ? "" : "s"}</Badge> : null}>
          {mesh.loading && !mesh.data ? <Skeleton /> : !latest ? <Empty>The Forge has not taken a census yet.</Empty> : (
            <div className="space-y-3 text-[12px]">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="organs" value={latest.organs} /><Stat label="agents" value={latest.agents} /><Stat label="council seats" value={latest.voters} /><Stat label="AI engines" value={latest.engines} />
              </div>
              <StatusBar segments={[
                { key: "consistent", label: "consistent", value: censusRows.filter((c: any) => c.status === "consistent").length, color: STATUS.good },
                { key: "changes", label: "changes found", value: censusRows.filter((c: any) => c.status === "changes").length, color: STATUS.warning },
                { key: "invalid", label: "invalid", value: censusRows.filter((c: any) => c.status === "invalid").length, color: STATUS.critical },
              ]} />
              {findings.length > 0 && <DataTable rows={findings} columns={FINDINGS} rowKey={(f, i) => `${f.kind}:${f.subject}:${i}`} maxHeight={220} dense />}
              <DataTable rows={censusRows} columns={CENSUS} rowKey={(c) => c.main_sha} initialSort={{ key: "when", dir: "desc" }} maxHeight={260} dense />
            </div>
          )}
        </Panel>
        <Panel title="Self-registration · consensus" icon={<UserPlus className="h-3.5 w-3.5 text-violet-300" />} right={<Badge tone="slate">{regs.length} proposal{regs.length === 1 ? "" : "s"}</Badge>}>
          {mesh.loading && !mesh.data ? <Skeleton /> : regs.length ? (
            <DataTable rows={regs} columns={REGISTRATIONS} rowKey={(r) => r.proposal_id} initialSort={{ key: "when", dir: "desc" }} maxHeight={300} dense />
          ) : (
            <Empty>{latest && !findings.length
              ? "No registration proposed yet: the latest census found every declared agent, engine and seat already registered. A new declaration in a Worker's organism.json starts the protocol on the next main commit."
              : "No registration proposed yet."}</Empty>
          )}
          {protocol.length > 0 && <ol className="mt-3 list-decimal space-y-1 pl-4 text-[11px] leading-relaxed text-slate-400">{protocol.map((p, i) => <li key={i}>{p}</li>)}</ol>}
          <div className="mt-3 text-[10px] uppercase tracking-widest text-slate-500">Highest tier an agent may use (ADR-0007)</div>
          <StatusBar className="mt-1.5" segments={tiers} />
        </Panel>
      </div>

      <Panel title="Agent Roster" icon={<Bot className="h-3.5 w-3.5 text-cyan-300" />}
        right={<div className="flex flex-wrap justify-end gap-2">
          <input className="field w-full py-1.5 sm:w-40" placeholder="search agent" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search agent" />
          <select className="field w-full py-1.5 sm:w-48" value={host} onChange={(e) => setHost(e.target.value)} aria-label="Host worker">
            <option value="">all hosts</option>{hosts.map((h) => <option key={h} value={h}>{h}</option>)}
          </select>
        </div>}>
        {loading && !data ? <Skeleton rows={6} /> : (
          <DataTable rows={rows} columns={ROSTER} rowKey={(a) => a.agent_id} onRowClick={(a) => navigate(`#/agents/${a.agent_id}`)} initialSort={{ key: hasLive ? "seen" : "host", dir: hasLive ? "desc" : "asc" }} maxHeight={520} empty="No agent matches." />
        )}
        <p className="mt-2 text-[10px] text-slate-500">{fmt(hasLive ? "Liveness, last action and 24 h counts are read from the syscall log, council votes and agent reports." : "Live activity appears once the kernel serves GET /v1/mesh.")}</p>
      </Panel>
    </div>
  );
}
