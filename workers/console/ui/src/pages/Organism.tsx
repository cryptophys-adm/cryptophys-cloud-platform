import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Brain,
  CandlestickChart,
  CheckCircle2,
  Clock,
  Cpu,
  Database,
  Flame,
  Gauge,
  HardDrive,
  HeartPulse,
  Layers,
  Leaf,
  Scale,
  Server,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Sparkles,
  Zap
} from "lucide-react";
import { Badge, Dot, Panel, Skeleton } from "../components/ui";
import { useOverview } from "../lib/overview";
import CloudflareUsage from "../components/CloudflareUsage";
import { usePoll } from "../lib/usePoll";
import { call } from "../lib/api";
import { ago } from "../lib/format";


export default function Organism() {
  const { ov, loading } = useOverview();
  const services = ov?.services ?? [];
  const omegaService = services.find((s) => s.service_id === "xauusd-omega");
  const aetherService = services.find((s) => s.service_id === "cryptophys-aether");

  // Live values from AI Kernel (GET /v1/metabolism), never computed or invented in the browser.
  const metabolism = usePoll(() => call("kernel.metabolism"), 60_000);
  const live: any = (metabolism.data as any)?.live ?? {};
  const isWeekend = live.market_status === "closed" || live.market_status === "holiday";
  const mode = String(live.power_mode ?? "");
  const powerMode = mode ? mode.toUpperCase() + (live.power_mode_override && live.power_mode_override !== "none" ? " (OWNER OVERRIDE)" : "") : "—";
  const usd = (v: unknown) => (typeof v === "number" ? `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}` : "—");
  const balance = usd(live.treasury_reserve_usd);
  const burn = typeof live.infra_burn_cost_24h === "number" ? `$${live.infra_burn_cost_24h.toFixed(2)}/day` : "—";
  const runwayDays = typeof live.runway_days === "number" ? Math.floor(live.runway_days) : "—";
  // AI budget the AI Engine applies: 25% in survival, 200% only with the owner's growth override.
  const aiQuota = mode === "survival" ? 25 : mode === "growth" ? 200 : mode ? 100 : "—";


  return (
    <div className="flex flex-col gap-4">
      {/* Header Banner */}
      <div className="glass p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="relative flex h-3.5 w-3.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-emerald-500"></span>
            </span>
            <div>
              <h1 className="text-lg font-bold text-white flex items-center gap-2">
                Autonomous Living Digital Organism
                <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                  SELF-SUSTAINING
                </span>
              </h1>
              <p className="text-xs text-slate-400 mt-0.5">
                Autonomous treasury control plane, living nervous system, Cloudflare infrastructure billing homeostasis, and epigenetic evolutionary loop.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={mode === "survival" ? "amber" : mode === "growth" ? "cyan" : "green"}>
              {powerMode}
            </Badge>
          </div>
        </div>
      </div>

      {/* Grid of Key Pillars */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        
        {/* Metric 1: Treasury Ledger */}
        <Panel title="Self-Sustaining Treasury" icon={<Database className="h-3.5 w-3.5 text-emerald-400" />}>
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="mono text-2xl font-bold text-emerald-400">{balance}</span>
              <span className="text-xs text-slate-400">Genesis Liquidity Buffer</span>
            </div>
            <div className="glass-inner p-2.5 space-y-1.5 text-xs">
              <div className="flex justify-between text-slate-400">
                <span>Estimated Burn Rate:</span>
                <span className="mono text-amber-300">{burn}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Survival Runway:</span>
                <span className="mono text-cyan-300">{runwayDays} Days Autonomous</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Deal result 24 h:</span>
                <span className="mono text-emerald-400">{usd(live.trading_net_pnl_24h)} deal result 24 h (read only)</span>
              </div>
            </div>
            <p className="text-[10px] text-slate-500">
              EA/Omega deal results are only read, to steer AI spending. The platform never moves funds or places orders.
            </p>
          </div>
        </Panel>

        {/* Metric 2: Power Policy & Quota */}
        <Panel title="Power Policy & Quotas" icon={<Scale className="h-3.5 w-3.5 text-cyan-400" />}>
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="mono text-2xl font-bold text-cyan-300">{aiQuota}%</span>
              <span className="text-xs text-slate-400">AI Daily Quota Limit</span>
            </div>
            <div className="glass-inner p-2.5 space-y-1.5 text-xs">
              <div className="flex justify-between text-slate-400">
                <span>Market State:</span>
                <span className={`mono font-semibold ${isWeekend ? "text-amber-300" : "text-emerald-400"}`}>
                  {live.market_status ? String(live.market_status).toUpperCase() : "OPEN (ACTIVE)"}
                </span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Throttling Policy:</span>
                <span className="mono text-slate-200">Survival: memory &amp; knowledge only</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Supervisor Cycle:</span>
                <span className="mono text-emerald-400">15m Heartbeat</span>
              </div>
            </div>
            <p className="text-[10px] text-slate-500">
              Survival saves AI spending and never blocks consensus. Growth applies only with the owner's override.
            </p>
          </div>
        </Panel>

        {/* Metric 3: Nervous System & Mesh */}
        <Panel title="Nervous System & Mesh" icon={<Activity className="h-3.5 w-3.5 text-purple-400" />}>
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="mono text-2xl font-bold text-purple-300">{services.length || "—"}</span>
              <span className="text-xs text-slate-400">Registered Services</span>
            </div>
            <div className="glass-inner p-2.5 space-y-1.5 text-xs">
              <div className="flex justify-between text-slate-400">
                <span>xauusd-omega:</span>
                <span className={`mono ${omegaService?.drifted ? "text-amber-400" : "text-emerald-400"}`}>
                  {!omegaService ? "Not observed" : omegaService.drifted ? "Drifted" : "In sync"}
                </span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>cryptophys-aether:</span>
                <span className={`mono ${aetherService?.drifted ? "text-amber-400" : "text-emerald-400"}`}>
                  {!aetherService ? "Not observed" : aetherService.drifted ? "Drifted" : "In sync"}
                </span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Decision Engine:</span>
                <span className="mono text-emerald-400">15m SSOT Awareness</span>
              </div>
            </div>
            <p className="text-[10px] text-slate-500">
              RPC Service Bindings interconnect all organs seamlessly without plain-text credentials.
            </p>
          </div>
        </Panel>

      </div>

      {/* Real Cloudflare usage (GET /v1/usage), owner 2026-11-10: measured values only */}
      <CloudflareUsage />

      {/* Epigenetic Evolution & Canon Protection */}
      <Panel title="Epigenetic Evolution & Canon Integrity" icon={<ShieldCheck className="h-3.5 w-3.5 text-amber-300" />}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="glass-inner p-3 space-y-2">
            <div className="font-semibold text-white flex items-center gap-1.5">
              <Sparkles className="h-3 w-3 text-purple-400" />
              Aether Canon Synchronizer (scripts/sync-canon-kb.mjs)
            </div>
            <p className="text-slate-400 leading-relaxed">
              Verifies SHA-256 hash alignment between trading assistant indicator knowledge base and Aether canon. Doctrinal adjustments are promoted strictly through deterministically reviewed PRs.
            </p>
            <div className="mono text-[11px] text-emerald-400 bg-white/5 px-2 py-1 rounded">
              Status: checked by the XAUUSD repository CI; not reported to this Console
            </div>
          </div>

          <div className="glass-inner p-3 space-y-2">
            <div className="font-semibold text-white flex items-center gap-1.5">
              <Zap className="h-3 w-3 text-cyan-400" />
              Epigenetic Promotion Bridge (scripts/propose-learned-promotion.mjs)
            </div>
            <p className="text-slate-400 leading-relaxed">
              Audits consensus weighting candidates in shadow execution. Mandatory criteria: discovery sample ≥ 50 bars, Holm–Bonferroni statistical test (α=0.05), and holdout out-of-sample ≥ 100 bars.
            </p>
            <div className="mono text-[11px] text-cyan-300 bg-white/5 px-2 py-1 rounded">
              Gate: Holm-Bonferroni α=0.05 (rule, not a live status)
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
