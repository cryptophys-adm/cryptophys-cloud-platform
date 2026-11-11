import {
  Activity,
  CheckCircle2,
  Database,
  HeartPulse,
  Landmark,
  Scale,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import { Badge, Dot, Empty, Panel } from "../components/ui";
import { useOverview } from "../lib/overview";
import CloudflareUsage from "../components/CloudflareUsage";
import { usePoll } from "../lib/usePoll";
import { call } from "../lib/api";
import { ago, listOf } from "../lib/format";
import {
  ActivityChart,
  BarList,
  DataTable,
  STATUS,
  StatusBar,
  bucketize,
} from "../components/viz";

const MODES = [
  { key: "homeostasis", label: "homeostasis", color: STATUS.good },
  { key: "growth", label: "growth (owner override)", color: STATUS.info },
  { key: "survival", label: "survival (saves AI)", color: STATUS.warning },
  { key: "unknown", label: "not reported", color: STATUS.neutral },
];
// Measured data only (AGENTS.md, hardening 2026-11-11): a mode the kernel did not report is "unknown",
// never a default "homeostasis", and only a reported mode gets a colour.
const modeKey = (m?: string) => (MODES.some((x) => x.key === m && x.key !== "unknown") ? String(m) : "unknown");
const tone = (m?: string) => (m === "survival" ? "amber" : m === "growth" ? "cyan" : m === "homeostasis" ? "green" : "slate") as "amber" | "cyan" | "green" | "slate";
const usd = (v: unknown) => (typeof v === "number" ? `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "—");
const num = (v: unknown, unit = "") => (typeof v === "number" ? `${v.toLocaleString("en-US", { maximumFractionDigits: 1 })}${unit}` : "—");

export default function Organism() {
  const { ov } = useOverview();
  const services = ov?.services ?? [];
  const omegaService = services.find((s) => s.service_id === "xauusd-omega");
  const aetherService = services.find((s) => s.service_id === "cryptophys-aether");

  // Live values from AI Kernel (GET /v1/metabolism), never computed or invented in the browser.
  const { data } = usePoll(() => call("kernel.metabolism"), 60_000);
  const live: any = data?.live ?? {};
  const cycles = listOf(data, "cycles");
  const ledger = listOf(data, "ledger");
  const burn = listOf(data, "burn_14d");
  const changes = listOf(data, "mode_changes");
  const rules: string[] = Array.isArray(data?.rules) ? data.rules : [];
  const { buckets, bin } = bucketize(cycles, (c: any) => c.evaluated_at, (c: any) => modeKey(c.power_mode));

  const isWeekend = live.market_status === "closed" || live.market_status === "holiday";
  const mode = String(live.power_mode ?? "");
  const override = live.power_mode_override && live.power_mode_override !== "none" ? String(live.power_mode_override) : null;
  const balance = usd(live.treasury_reserve_usd);
  const burnRate = typeof live.infra_burn_cost_24h === "number" ? `${usd(live.infra_burn_cost_24h)}/day` : "—";
  const runwayDays = typeof live.runway_days === "number" ? Math.floor(live.runway_days) : "—";
  const lastCycle: any = cycles[0] ?? null;
  const xauusdService = services.find((s) => s.service_id === "xauusd-ai-trading-assistant");

  return (
    <div className="flex flex-col gap-4">
      {/* Header Banner */}
      <div className="glass p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {/* Green and pulsing only while the kernel reports a power mode. */}
            <Dot tone={mode ? tone(mode) : "slate"} pulse={Boolean(mode)} />
            <div>
              <h1 className="text-lg font-bold text-white">Organism · digital metabolism</h1>
              <p className="text-xs text-slate-400 mt-0.5">
                The power mode, treasury, heartbeat cycles, ledger and infrastructure burn reported by the AI Kernel (GET /v1/metabolism), and the services the Drift Detector observes. Every value comes from those answers; a missing one shows a dash.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Badge tone={tone(live.power_mode)}>mode · {live.power_mode ?? "—"}</Badge>
            <Badge tone={live.market_status === "open" ? "green" : "slate"}>market · {live.market_status ?? "—"}</Badge>
            {override && <Badge tone="purple">owner override · {override}</Badge>}
            {live.auto_adaptation_enabled === false && <Badge tone="slate">auto adaptation off</Badge>}
          </div>
        </div>
      </div>

      {/* Grid of Key Pillars (Macro Overview) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Metric 1: Treasury Ledger */}
        <Panel title="Treasury" icon={<Database className="h-3.5 w-3.5 text-emerald-400" />}>
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="mono text-2xl font-bold text-emerald-400">{balance}</span>
              <span className="text-xs text-slate-400">treasury reserve</span>
            </div>
            <div className="glass-inner p-2.5 space-y-1.5 text-xs">
              <div className="flex justify-between text-slate-400">
                <span>Estimated Burn Rate:</span>
                <span className="mono text-amber-300">{burnRate}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Survival Runway:</span>
                <span className="mono text-cyan-300">{runwayDays === "—" ? "—" : `${runwayDays} days`}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Deal result 24 h:</span>
                <span className="mono text-emerald-400">{usd(live.trading_net_pnl_24h)} (read only)</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Metabolic Ratio:</span>
                <span className="mono text-slate-200">{num(live.metabolic_ratio)}</span>
              </div>
            </div>
            <p className="text-[10px] text-slate-500">
              EA/Omega deal results are only read, to steer AI spending. The platform never moves funds or places orders.
            </p>
          </div>
        </Panel>

        {/* Metric 2: Power Policy & Quota */}
        <Panel title="Power mode" icon={<Scale className="h-3.5 w-3.5 text-cyan-400" />}>
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="mono text-2xl font-bold text-cyan-300">{mode || "—"}</span>
              <span className="text-xs text-slate-400">reported by the kernel</span>
            </div>
            <div className="glass-inner p-2.5 space-y-1.5 text-xs">
              <div className="flex justify-between text-slate-400">
                <span>Market state:</span>
                <span className={`mono font-semibold ${!live.market_status ? "text-slate-500" : isWeekend ? "text-amber-300" : "text-emerald-400"}`}>
                  {live.market_status ? String(live.market_status).toUpperCase() : "—"}
                </span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Last heartbeat cycle:</span>
                <span className="mono text-slate-200" title={lastCycle?.evaluated_at ?? ""}>{lastCycle ? ago(lastCycle.evaluated_at) : "—"}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Its reason:</span>
                <span className="text-right text-slate-300">{lastCycle?.mode_reason ?? "—"}</span>
              </div>
            </div>
            <p className="text-[10px] text-slate-500">
              Policy (rule, not a reading): survival saves AI spending (memory and knowledge proposals, AI budgets at a quarter) and never blocks consensus; growth applies only with the owner's override.
            </p>
          </div>
        </Panel>

        {/* Metric 3: Nervous System & Mesh */}
        <Panel title="Observed services" icon={<Activity className="h-3.5 w-3.5 text-purple-400" />}>
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="mono text-2xl font-bold text-purple-300">{services.length || "—"}</span>
              <span className="text-xs text-slate-400">observed by the Drift Detector</span>
            </div>
            <div className="glass-inner p-2.5 space-y-1.5 text-xs">
              {[["xauusd-ai-trading-assistant", xauusdService], ["xauusd-omega", omegaService], ["cryptophys-aether", aetherService]].map(([name, svc]: any) => (
                <div key={name} className="flex justify-between text-slate-400">
                  <span>{name}:</span>
                  <span className={`mono ${!svc ? "text-slate-500" : svc.drifted ? "text-amber-400" : "text-emerald-400"}`}>
                    {!svc ? "not observed" : svc.drifted ? "drifted" : "in sync"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Panel>
      </div>

      {/* Real Cloudflare Usage & Throttling Intents */}
      <CloudflareUsage />

      {/* Metabolism Historical Telemetry (Integrated from Metabolism) */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title={`Power mode over time · ${cycles.length} cycles (14 d)`} icon={<Activity className="h-3.5 w-3.5 text-cyan-300" />}>
          {cycles.length === 0 ? (
            <Empty>No heartbeat cycle yet. The Supervisor records one each scheduled cycle once its metabolism code is deployed.</Empty>
          ) : (
            <>
              <StatusBar className="mb-3" legend={false} segments={MODES.map((m) => ({ ...m, value: cycles.filter((c: any) => modeKey(c.power_mode) === m.key).length }))} />
              <ActivityChart buckets={buckets} bin={bin} series={MODES} caption="metabolism cycles over time by power mode" />
            </>
          )}
        </Panel>
        <Panel title="Estimated burn per service · 14 d" icon={<Scale className="h-3.5 w-3.5 text-violet-300" />}>
          <BarList unit="" items={burn.filter((b: any) => typeof b.cost_usd === "number" && Number.isFinite(b.cost_usd)).map((b: any) => ({ label: String(b.service_id).replace(/^cryptophys-/, ""), value: Math.round(b.cost_usd * 100) / 100, sub: "USD" }))}
            empty="No burn metrics recorded yet." />
        </Panel>
      </div>

      {/* Heartbeat Cycles Log (Integrated from Metabolism) */}
      <Panel title="Heartbeat cycles" icon={<HeartPulse className="h-3.5 w-3.5 text-emerald-300" />} right={<Badge tone="slate">{cycles.length}</Badge>}>
        <DataTable rows={cycles} rowKey={(c) => c.cycle_id} initialSort={{ key: "when", dir: "desc" }} maxHeight={380} empty="No cycle recorded yet." columns={[
          { key: "mode", header: "mode", sort: (c) => c.power_mode, cell: (c) => <Badge tone={tone(c.power_mode)}>{c.power_mode ?? "—"}</Badge> },
          { key: "market", header: "market", sort: (c) => c.market_status, cell: (c) => <span className="text-[11px] text-slate-400">{c.market_status}</span> },
          { key: "pnl", header: "deal result 24 h", align: "right", sort: (c) => c.trading_net_pnl_24h, cell: (c) => <span className="mono">{usd(c.trading_net_pnl_24h)}</span> },
          { key: "burn", header: "burn 24 h", align: "right", sort: (c) => c.infra_burn_cost_24h, cell: (c) => <span className="mono">{usd(c.infra_burn_cost_24h)}</span> },
          { key: "reserve", header: "reserve", align: "right", sort: (c) => c.treasury_reserve_usd, cell: (c) => <span className="mono">{usd(c.treasury_reserve_usd)}</span> },
          { key: "runway", header: "runway", align: "right", sort: (c) => c.runway_days, cell: (c) => <span className="mono">{num(c.runway_days, " d")}</span> },
          { key: "reason", header: "reason", className: "wrap", cell: (c) => <span className="text-slate-400">{c.mode_reason}</span> },
          { key: "when", header: "when", sort: (c) => Date.parse(c.evaluated_at) || 0, cell: (c) => <span className="text-slate-500" title={c.evaluated_at}>{ago(c.evaluated_at)}</span> },
        ]} />
      </Panel>

      {/* Treasury Ledger & Mode Changes Audit Chain (Integrated from Metabolism) */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Treasury ledger" icon={<Landmark className="h-3.5 w-3.5 text-amber-300" />} right={<Badge tone="slate">{ledger.length}</Badge>}>
          <DataTable rows={ledger} rowKey={(e) => e.entry_id} initialSort={{ key: "when", dir: "desc" }} maxHeight={320} dense empty="No ledger entry." columns={[
            { key: "type", header: "entry", sort: (e) => e.entry_type, cell: (e) => <span className="text-[11px]">{String(e.entry_type).replace(/_/g, " ")}</span> },
            { key: "amount", header: "amount", align: "right", sort: (e) => e.amount_usd, cell: (e) => <span className={`mono ${Number(e.amount_usd) < 0 ? "text-rose-300" : "text-slate-200"}`}>{usd(e.amount_usd)}</span> },
            { key: "balance", header: "balance", align: "right", sort: (e) => e.balance_after_usd, cell: (e) => <span className="mono">{usd(e.balance_after_usd)}</span> },
            { key: "source", header: "source", cell: (e) => <span className="mono text-[10px] text-slate-500">{e.source}</span> },
            { key: "when", header: "when", sort: (e) => Date.parse(e.created_at) || 0, cell: (e) => <span className="text-slate-500">{ago(e.created_at)}</span> },
          ]} />
        </Panel>
        <Panel title="Mode changes · audit chain" icon={<ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />} right={<Badge tone="slate">{changes.length}</Badge>}>
          <DataTable rows={changes} rowKey={(c, i) => `${c.at}-${i}`} maxHeight={320} dense empty="No automatic mode change yet." columns={[
            { key: "change", header: "change", cell: (c) => <span className="text-[11px]">{c.previous_mode || "—"} → <Badge tone={tone(c.mode)}>{c.mode}</Badge></span> },
            { key: "reason", header: "reason", className: "wrap", cell: (c) => <span className="text-slate-400">{c.reason}</span> },
            { key: "by", header: "by", cell: (c) => <span className="mono text-[10px] text-slate-500">{c.actor}</span> },
            { key: "when", header: "when", cell: (c) => <span className="text-slate-500">{ago(c.at)}</span> },
          ]} />
          {rules.length > 0 && <ul className="mt-3 list-disc space-y-1 pl-4 text-[11px] text-slate-400">{rules.map((r, i) => <li key={i}>{r}</li>)}</ul>}
        </Panel>
      </div>

      {/* Epigenetic Evolution & Canon Protection */}
      <Panel title="Canon integrity and promotion rules (rules, not readings)" icon={<ShieldCheck className="h-3.5 w-3.5 text-amber-300" />}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="glass-inner p-3 space-y-2">
            <div className="font-semibold text-white flex items-center gap-1.5">
              <Sparkles className="h-3 w-3 text-purple-400" />
              Aether Canon Synchronizer (scripts/sync-canon-kb.mjs)
            </div>
            <p className="text-slate-400 leading-relaxed">
              Verifies SHA-256 hash alignment between trading assistant indicator knowledge base and Aether canon. Doctrinal adjustments are promoted strictly through deterministically reviewed PRs.
            </p>
            <div className="mono text-[11px] text-slate-400 bg-white/5 px-2 py-1 rounded">
              Status: checked by the XAUUSD repository CI; not reported to this Console
            </div>
          </div>

          <div className="glass-inner p-3 space-y-2">
            <div className="font-semibold text-white flex items-center gap-1.5">
              <Zap className="h-3 w-3 text-cyan-400" />
              Epigenetic Promotion Bridge (scripts/propose-learned-promotion.mjs)
            </div>
            <p className="text-slate-400 leading-relaxed">
              Audits weighting and parameter candidates in shadow. The rule in force (xauusd SHADOW_MIN_SAMPLE and HOLDOUT_BARS): at least 200 paired rooms for discovery, a Holm-adjusted one-sided sign test (α = 0.05), and the newest 100 rooms as a holdout.
            </p>
            <div className="mono text-[11px] text-slate-400 bg-white/5 px-2 py-1 rounded">
              Gate: Holm-Bonferroni α=0.05 (rule, not a live status)
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
