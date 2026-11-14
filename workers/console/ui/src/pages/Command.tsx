import { AlertTriangle, Bot, CheckCircle, Power, ShieldAlert, Wrench, Server, Gavel } from "lucide-react";
import HealthRing from "../components/HealthRing";
import { Badge, Dot, Empty, Kpi, Panel, Skeleton } from "../components/ui";
import { healthScore, useOverview } from "../lib/overview";
import { useSession } from "../lib/session";
import { ago, listOf } from "../lib/format";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import CognitionPanel from "../components/CognitionPanel";
import { statusTone } from "./Consensus";
import { DataTable, STATUS, StatusBar, VoteBar } from "../components/viz";

export default function Command() {
  const { ov, loading, refresh } = useOverview();
  const { who, act } = useSession();
  const services = ov?.services ?? [];
  const drifted = services.filter((s) => s.drifted);
  const counts = ov?.agent_reports_24h?.counts ?? {};
  const plans = ov?.open_agent_plans ?? [];
  const score = healthScore(ov);
  const gate = !ov ? "—" : (counts.critical ?? 0) > 0 || drifted.some((d) => d.persistent) ? "BLOCKED" : "GO";
  const x = ov?.xauusd_latest;
  const cns = usePoll(() => call("kernel.consensus", undefined, undefined, { limit: "6" }), 60_000);
  const cnsRows = listOf(cns.data, "proposals");
  // ADR-0012 phase 2: owner notices from the AI Kernel (replaces the GitHub issues).
  const notices = usePoll(() => call("kernel.notices"), 60_000);
  const active = listOf(notices.data, "notices").filter((n: any) => n?.active);
  // Live digital metabolism (GET /v1/metabolism); nothing here is computed in the browser.
  const metabolism = usePoll(() => call("kernel.metabolism"), 60_000);
  const mtb: any = (metabolism.data as any)?.live ?? {};

  return (
    <div className="flex flex-col gap-3">
      {/* AI Cognition (Ask the platform AI) for phones and laptops; on 2xl screens it is in the right rail (2026-11-07). */}
      <div className="2xl:hidden"><CognitionPanel /></div>
      <h1 className="sr-only">Command center</h1>

      {active.length > 0 && (
        <Panel title="Needs your attention" icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-300" />}
          right={<Badge tone="amber">{notices.data?.email === "configured" ? "Email enabled" : "Console only"}</Badge>}>
          <div className="space-y-2">
            {active.map((n: any) => (
              <div key={n.topic} className="glass-inner px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <Dot tone={n.topic === "owner_attention" ? "amber" : "red"} pulse />
                  <span className="min-w-0 flex-1 break-words text-[12px] text-slate-200">{n.title}</span>
                  {/* Owner 2026-11-13: only approvals and critical reports reach the owner; the kernel says which channel each notice uses. */}
                  <Badge tone={n.channel === "owner" ? "amber" : "slate"}>{n.channel === "owner" ? "owner channel" : n.channel === "console" ? "Console only" : "—"}</Badge>
                  <a href={String(n.link ?? "").replace(/^.*#/, "#")} className="text-[10px] uppercase tracking-widest text-cyan-300 hover:underline">Open →</a>
                </div>
                <ul className="mt-1.5 space-y-1 pl-4 text-[11px] leading-relaxed text-slate-400">
                  {(Array.isArray(n.lines) ? n.lines : []).slice(0, 8).map((l: string, i: number) => <li key={i} className="list-disc break-words">{l}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <div className="grid grid-cols-2 items-stretch gap-3 lg:grid-cols-[auto_1fr_1fr_1fr_1fr]">
        <div className="glass col-span-2 flex items-center px-6 py-4 lg:col-span-1">
          <HealthRing score={score} stats={[
            { l: "services", v: `${services.length - drifted.length}/${services.length || "—"}`, c: drifted.length ? "#d29922" : "#3fb950" },
            { l: "drifted", v: String(drifted.length), c: drifted.length ? "#f85149" : "#e6edf3" },
            { l: "approvals", v: String(plans.length), c: plans.length ? "#d29922" : "#e6edf3" },
            { l: "plane", v: "cloudflare", c: "#58a6ff" },
          ]} />
        </div>
        <Kpi label="Drift" value={ov ? String(drifted.length) : "—"} sub={`of ${services.length} services`} color={drifted.length ? "#f85149" : "#3fb950"} icon={<AlertTriangle size={12} />} />
        <Kpi label="Critical 24h" value={ov ? String(counts.critical ?? 0) : "—"} sub={`${counts.warning ?? 0} warn · ${counts.info ?? 0} info`} color={(counts.critical ?? 0) ? "#f85149" : "#3fb950"} icon={<ShieldAlert size={12} />} />
        <Kpi label="AI Mesh" value={ov ? (ov.agents_enabled ? "LIVE" : "HALT") : "—"} sub="global kill switch" color={ov?.agents_enabled === false ? "#f85149" : "#bc8cff"} icon={<Bot size={12} />} />
        <Kpi label="Evidence Gate" value={gate} sub={gate === "GO" ? "no critical evidence" : gate === "BLOCKED" ? "critical evidence open" : "loading"} color={gate === "BLOCKED" ? "#f85149" : gate === "GO" ? "#3fb950" : "#58a6ff"} icon={<CheckCircle size={12} />} />
      </div>

      {/* Living Organism Metabolism Banner */}
      <div className={`glass p-4 flex flex-wrap items-center justify-between gap-3 border ${mtb.power_mode ? "border-emerald-500/20 bg-emerald-500/5" : "border-white/10"}`}>
        <div className="flex items-center gap-3">
          {/* Green and pulsing only while the kernel reports a power mode (measured data only). */}
          <Dot tone={mtb.power_mode ? "green" : "slate"} pulse={Boolean(mtb.power_mode)} />
          <div>
            <div className="text-xs font-bold text-white flex items-center gap-2">
              Autonomous Living Organism · Digital Metabolism
              <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-emerald-500/20 text-emerald-300">
                {mtb.power_mode ? "LIVE" : "—"}
              </span>
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">
              Treasury: <strong className={`mono ${mtb.treasury_source === "placeholder" ? "text-slate-500" : "text-emerald-300"}`}>{typeof mtb.treasury_reserve_usd === "number" ? `$${mtb.treasury_reserve_usd.toFixed(2)}${mtb.treasury_source === "placeholder" ? " (placeholder)" : ""}` : "—"}</strong> · Burn: <strong className="mono text-amber-300">{typeof mtb.infra_burn_cost_24h === "number" ? `$${mtb.infra_burn_cost_24h.toFixed(2)}/day` : "—"}</strong> · Runway: <strong className="mono text-cyan-300">{typeof mtb.runway_days === "number" ? `${Math.floor(mtb.runway_days)} Days` : "—"}</strong> · Power: <strong className="mono text-emerald-400">{mtb.power_mode ? String(mtb.power_mode).toUpperCase() : "—"}</strong>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a href="#/organism" className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 transition">
            Organism Hub →
          </a>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Approval Queue" icon={<Gavel className="h-3.5 w-3.5 text-amber-300" />} right={<div className="flex items-center gap-2"><Badge tone={plans.length ? "amber" : "green"}>{plans.length} pending</Badge><a href="#/owner" className="text-[10px] uppercase tracking-widest text-slate-500 hover:text-cyan-300">Owner →</a></div>}>
          {loading && !ov ? <Skeleton /> : plans.length === 0 ? <Empty>No proposals waiting for a human. The mesh is acting within its mandate.</Empty> : (
            <div className="space-y-2">
              {plans.map((p) => (
                <div key={p.plan_id} className="glass-inner flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <Dot tone="amber" pulse />
                  <div className="min-w-0 flex-1">
                    <a href={`#/recovery/${p.plan_id}`} className="mono block truncate text-[12px] text-cyan-200 hover:underline">{p.plan_id}</a>
                    <div className="text-[11px] text-slate-500">{p.service_id} · {p.status} · {ago(p.created_at)}</div>
                  </div>
                  <a href={`#/recovery/${p.plan_id}`} className="btn btn-approve text-[11px]"><Wrench className="h-3.5 w-3.5" />Review</a>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Kill Switch" icon={<Power className="h-3.5 w-3.5 text-rose-300" />} right={<Badge tone={ov?.agents_enabled === false ? "red" : "green"}>{ov?.agents_enabled === false ? "agents stopped" : "agents running"}</Badge>}>
          <p className="mb-3 text-[12px] leading-relaxed text-slate-400">Stopping the mesh halts every agent syscall at once. Any operator may stop it; only an approver may restart it.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-danger" onClick={() => act({ route: "kernel.agents_disabled", body: { enabled: false }, title: "Stop all agents", lines: ["Sets the global kill switch: no agent acts until an approver turns agents on again."], done: "Agents are stopped.", after: () => void refresh() })}>
              <Power className="h-3.5 w-3.5" />Agents OFF
            </button>
            {who.approver && (
              <button type="button" className="btn btn-approve" onClick={() => act({ route: "kernel.agents_enabled", body: { enabled: true }, title: "Restart all agents", lines: ["Lets enabled agents act again."], done: "Agents are running.", after: () => void refresh() })}>
                <Power className="h-3.5 w-3.5" />Agents ON
              </button>
            )}
          </div>
        </Panel>
      </div>

      <Panel title="Consensus · AI mesh decisions" icon={<Gavel className="h-3.5 w-3.5 text-violet-300" />}
        right={<div className="flex items-center gap-2"><Badge tone={cns.data?.mode === "shadow" ? "amber" : "purple"}>mode · {cns.data?.mode ?? "—"}</Badge><a href="#/consensus" className="text-[10px] uppercase tracking-widest text-slate-500 hover:text-cyan-300">All →</a></div>}>
        {cns.loading && !cns.data ? <Skeleton rows={2} /> : (
          <DataTable rows={cnsRows} rowKey={(p) => p.proposal_id} onRowClick={() => { window.location.hash = "#/consensus"; }} maxHeight={260} dense
            empty="No proposals yet. Agents propose when they see persistent drift." columns={[
              { key: "status", header: "status", cell: (p) => <span className="inline-flex items-center gap-1.5"><Dot tone={statusTone(p.status) as any} pulse={p.status === "pending_owner"} />{String(p.status).replace("_", " ")}</span> },
              { key: "action", header: "action", cell: (p) => <span className="mono text-cyan-200">{p.action}</span> },
              { key: "target", header: "target", cell: (p) => <span className="mono text-[11px] text-slate-400">{p.target}</span> },
              { key: "votes", header: "votes", cell: (p) => <VoteBar approvals={p.approvals} rejections={p.rejections} eligible={p.eligible} /> },
              { key: "when", header: "when", cell: (p) => <span className="text-slate-500">{ago(p.created_at)}</span> },
            ]} />
        )}
      </Panel>

      <Panel title="Service Mesh" icon={<Server className="h-3.5 w-3.5 text-cyan-300" />} right={<a href="#/infrastructure" className="text-[10px] uppercase tracking-widest text-slate-500 hover:text-cyan-300">Infrastructure →</a>}>
        {loading && !ov ? <Skeleton rows={4} /> : (<>
          <StatusBar className="mb-3" segments={[
            { key: "ok", label: "in sync", value: services.length - drifted.length, color: STATUS.good },
            { key: "transient", label: "drift (new)", value: drifted.filter((d) => !d.persistent).length, color: STATUS.warning },
            { key: "persistent", label: "drift (persistent)", value: drifted.filter((d) => d.persistent).length, color: STATUS.critical },
          ]} />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {services.map((s) => (
              <div key={s.service_id} className={`glass-inner flex items-center gap-2.5 px-3 py-2.5 ${s.drifted ? "border-rose-400/20" : ""}`}>
                <Dot tone={s.drifted ? (s.persistent ? "red" : "amber") : "green"} pulse={s.drifted} />
                <span className="mono min-w-0 flex-1 truncate text-[11px] text-slate-200">{s.service_id}</span>
                <span className="shrink-0 text-[10px] text-slate-600">{ago(s.last_seen_at ?? s.observed_at)}</span>
              </div>
            ))}
          </div>
        </>)}
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Attention · last 24h" icon={<ShieldAlert className="h-3.5 w-3.5 text-amber-300" />} right={<a href="#/cognition" className="text-[10px] uppercase tracking-widest text-slate-500 hover:text-cyan-300">Reports →</a>}>
          <StatusBar className="mb-3" segments={[
            { key: "info", label: "info", value: counts.info ?? 0, color: STATUS.info },
            { key: "warning", label: "warning", value: counts.warning ?? 0, color: STATUS.warning },
            { key: "critical", label: "critical", value: counts.critical ?? 0, color: STATUS.critical },
          ]} />
          <DataTable rows={ov?.agent_reports_24h?.latest_attention ?? []} rowKey={(r) => r.report_id} maxHeight={240} dense empty="No warnings or critical reports in 24 hours." columns={[
            { key: "sev", header: "severity", cell: (r) => <span className="inline-flex items-center gap-1.5"><Dot tone={r.severity === "critical" ? "red" : "amber"} />{r.severity}</span> },
            { key: "subject", header: "subject", className: "wrap", cell: (r) => <span className="text-slate-200">{r.subject}</span> },
            { key: "agent", header: "agent", cell: (r) => <span className="mono text-[11px] text-slate-400">{r.agent_id}</span> },
            { key: "when", header: "when", cell: (r) => <span className="text-slate-500">{ago(r.created_at)}</span> },
          ]} />
        </Panel>
        <Panel title="XAUUSD · display only" icon={<Dot tone="cyan" />} right={<a href="#/markets" className="text-[10px] uppercase tracking-widest text-slate-500 hover:text-cyan-300">Markets →</a>}>
          {!x ? <Empty>No decision relayed yet.</Empty> : x.error ? <Empty>Relay unavailable.</Empty> : (
            <div className="flex items-center gap-6">
              <div className={`mono text-[34px] font-extrabold ${x.decision === "BUY" ? "text-emerald-400" : x.decision === "SELL" ? "text-rose-400" : "text-amber-300"}`} style={{ textShadow: "0 0 20px currentColor" }}>{x.decision ?? "—"}</div>
              <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-1 text-[11px]">
                <span className="text-slate-500">confidence</span><span className="mono text-slate-200">{x.confidence ?? "—"}</span>
                <span className="text-slate-500">candle</span><span className="mono truncate text-slate-200">{x.candle_key ?? "—"}</span>
                <span className="text-slate-500">decided</span><span className="mono text-slate-200">{x.decided_at ?? "—"}</span>
              </div>
            </div>
          )}
          <p className="mt-3 text-[10px] uppercase tracking-widest text-slate-600">Advisory relay · not an order</p>
        </Panel>
      </div>
    </div>
  );
}
