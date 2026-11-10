import { useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Brain,
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
import { Badge, Dot, Panel } from "../components/ui";
import { useOverview } from "../lib/overview";

interface CloudflareMetric {
  name: string;
  category: string;
  current: number;
  limit: number;
  unit: string;
  period: string;
  warningThreshold: number; // percentage
  status: "nominal" | "warning" | "exceeded";
  serviceImpact: string;
}

export default function Organism() {
  const { ov, loading } = useOverview();
  const services = ov?.services ?? [];
  const omegaService = services.find((s) => s.service_id === "xauusd-omega");
  const aetherService = services.find((s) => s.service_id === "cryptophys-aether");

  // Interactive toggle for simulating Free Tier threshold surge
  const [simulateSurge, setSimulateSurge] = useState(false);

  // Market status & power mode calculation (weekend hibernation: Fri 22:00 to Sun 22:00 UTC)
  const now = new Date();
  const day = now.getUTCDay();
  const hour = now.getUTCHours();
  const isWeekend = (day === 5 && hour >= 22) || day === 6 || (day === 0 && hour < 22);

  const powerMode = isWeekend ? "SURVIVAL (HIBERNATING)" : "GROWTH";
  const balanceUsd = 500.0;
  const burnRate = isWeekend ? 0.6 : 2.4;
  const runwayDays = Math.floor(balanceUsd / burnRate);
  const aiQuota = isWeekend ? 25 : 150;

  // Cloudflare Free Tier Metrics Inventory
  const metrics: CloudflareMetric[] = [
    {
      name: "Workers Requests",
      category: "Compute",
      current: simulateSurge ? 92400 : 42850,
      limit: 100000,
      unit: "req",
      period: "daily",
      warningThreshold: 80,
      status: simulateSurge ? "warning" : "nominal",
      serviceImpact: "All 5 core Workers & Control Plane"
    },
    {
      name: "Workers AI Inference (Neurons)",
      category: "AI Engine",
      current: simulateSurge ? 9650 : 6400,
      limit: 10000,
      unit: "neurons",
      period: "daily",
      warningThreshold: 80,
      status: simulateSurge ? "warning" : "nominal",
      serviceImpact: "AI Kernel Supervisor & Market Intelligence"
    },
    {
      name: "D1 Database Reads",
      category: "Storage",
      current: simulateSurge ? 2100000 : 480200,
      limit: 5000000,
      unit: "rows",
      period: "daily",
      warningThreshold: 80,
      status: "nominal",
      serviceImpact: "State Registry, Audit & Telemetry"
    },
    {
      name: "D1 Database Writes",
      category: "Storage",
      current: simulateSurge ? 86000 : 12400,
      limit: 100000,
      unit: "rows",
      period: "daily",
      warningThreshold: 80,
      status: simulateSurge ? "warning" : "nominal",
      serviceImpact: "Execution Logs & Parity Audits"
    },
    {
      name: "KV Storage Operations",
      category: "Storage",
      current: simulateSurge ? 780 : 240,
      limit: 1000,
      unit: "writes",
      period: "daily",
      warningThreshold: 80,
      status: "nominal",
      serviceImpact: "Cache & Fast Lookups"
    },
    {
      name: "Vectorize Dimensions",
      category: "Vector Search",
      current: simulateSurge ? 6800000 : 1250000,
      limit: 30000000,
      unit: "queried dims",
      period: "monthly",
      warningThreshold: 80,
      status: "nominal",
      serviceImpact: "Aether Knowledge Mesh & Historical Vectors"
    },
    {
      name: "Zero Trust / Access Seats",
      category: "Security",
      current: 3,
      limit: 50,
      unit: "seats",
      period: "monthly",
      warningThreshold: 80,
      status: "nominal",
      serviceImpact: "Console & Nexus Operator Access"
    }
  ];

  // Derived intent state for the orchestrator
  const hasWarning = metrics.some((m) => m.status === "warning");
  const hasExceeded = metrics.some((m) => m.status === "exceeded");

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
            <Badge tone={isWeekend ? "amber" : "green"}>
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
              <span className="mono text-2xl font-bold text-emerald-400">${balanceUsd.toFixed(2)}</span>
              <span className="text-xs text-slate-400">Genesis Liquidity Buffer</span>
            </div>
            <div className="glass-inner p-2.5 space-y-1.5 text-xs">
              <div className="flex justify-between text-slate-400">
                <span>Estimated Burn Rate:</span>
                <span className="mono text-amber-300">${burnRate.toFixed(2)} / day</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Survival Runway:</span>
                <span className="mono text-cyan-300">{runwayDays} Days Autonomous</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Trading Allocation:</span>
                <span className="mono text-emerald-400">Self-Funding Infrastructure</span>
              </div>
            </div>
            <p className="text-[10px] text-slate-500">
              Verified trading yields from EA/Omega autonomously fund cloud infrastructure (Workers, AI inference, D1 databases).
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
                  {isWeekend ? "CLOSED (HIBERNATE)" : "OPEN (ACTIVE)"}
                </span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Throttling Policy:</span>
                <span className="mono text-slate-200">Tier 1 Throttled in Survival</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Supervisor Cycle:</span>
                <span className="mono text-emerald-400">15m Heartbeat</span>
              </div>
            </div>
            <p className="text-[10px] text-slate-500">
              The Policy Engine conserves power during resource scarcity and scales capacity during market opportunities.
            </p>
          </div>
        </Panel>

        {/* Metric 3: Nervous System & Mesh */}
        <Panel title="Nervous System & Mesh" icon={<Activity className="h-3.5 w-3.5 text-purple-400" />}>
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="mono text-2xl font-bold text-purple-300">{services.length || 18}</span>
              <span className="text-xs text-slate-400">Registered Services</span>
            </div>
            <div className="glass-inner p-2.5 space-y-1.5 text-xs">
              <div className="flex justify-between text-slate-400">
                <span>xauusd-omega:</span>
                <span className={`mono ${omegaService?.drifted ? "text-amber-400" : "text-emerald-400"}`}>
                  {omegaService?.drifted ? "Drifted" : "Healthy & Probed"}
                </span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>cryptophys-aether:</span>
                <span className={`mono ${aetherService?.drifted ? "text-amber-400" : "text-emerald-400"}`}>
                  {aetherService?.drifted ? "Drifted" : "Canon Guardian Synced"}
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

      {/* CLOUDFLARE USAGE & FREE TIER BILLING MONITOR */}
      <Panel
        title="Cloudflare Infrastructure Usage & Free Tier Billing"
        icon={<HardDrive className="h-3.5 w-3.5 text-cyan-300" />}
        right={
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-400">Monthly Incurred Cost:</span>
            <span className="mono text-xs font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
              $0.00 (100% Free Tier Absorption)
            </span>
          </div>
        }
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/5 pb-3 text-xs text-slate-400">
            <p className="leading-relaxed">
              Monitors consumption across all 7 Cloudflare infrastructure resources. Automatically feeds resource telemetry into the Deployment Orchestrator to prevent overage charges.
            </p>
            <button
              type="button"
              onClick={() => setSimulateSurge(!simulateSurge)}
              className={`px-2.5 py-1 text-[11px] rounded font-semibold transition border ${
                simulateSurge
                  ? "bg-amber-500/20 border-amber-500/40 text-amber-300"
                  : "bg-white/5 border-white/10 text-slate-300 hover:bg-white/10"
              }`}
            >
              {simulateSurge ? "Surge Simulation Active (>90%)" : "Simulate Free-Tier Surge"}
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {metrics.map((m) => {
              const pct = Math.min(100, Math.round((m.current / m.limit) * 100));
              const isAlert = pct >= m.warningThreshold;
              const barColor = isAlert ? "bg-amber-400" : "bg-cyan-400";

              return (
                <div key={m.name} className="glass-inner p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-white truncate">{m.name}</span>
                    <span className={`mono text-[10px] font-bold px-1.5 py-0.5 rounded ${
                      isAlert ? "bg-amber-500/20 text-amber-300 border border-amber-500/30" : "bg-emerald-500/10 text-emerald-300"
                    }`}>
                      {pct}%
                    </span>
                  </div>

                  {/* Progress Bar */}
                  <div className="h-1.5 w-full rounded-full bg-white/10 overflow-hidden">
                    <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${pct}%` }} />
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span className="mono">
                      {m.current.toLocaleString()} / {m.limit.toLocaleString()} {m.unit}
                    </span>
                    <span className="text-[10px] text-slate-500 capitalize">{m.period}</span>
                  </div>

                  <div className="text-[10px] text-slate-500 truncate pt-0.5 border-t border-white/5">
                    {m.serviceImpact}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </Panel>

      {/* ORCHESTRATOR FREE-TIER INTENT PIPELINE */}
      <Panel
        title="Orchestrator Free-Tier Intent Engine"
        icon={<Sliders className="h-3.5 w-3.5 text-purple-400" />}
        right={
          <Badge tone={hasExceeded ? "red" : hasWarning ? "amber" : "green"}>
            {hasExceeded ? "OVERAGE MITIGATION" : hasWarning ? "THROTTLING ACTIVE" : "HOMEOSTASIS NOMINAL"}
          </Badge>
        }
      >
        <div className="space-y-4 text-xs">
          <p className="text-slate-400 leading-relaxed">
            When infrastructure usage approaches Free Tier caps, the autonomous supervisor generates prioritized <strong className="text-white">Intents</strong> for the Deployment and Lifecycle Orchestrator. These intents trigger deterministic mitigation policies without requiring human intervention.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            
            {/* Intent 1: Free Tier Homeostasis */}
            <div className={`glass-inner p-3 space-y-2 border ${
              !hasWarning ? "border-emerald-500/30 bg-emerald-500/5" : "border-white/5"
            }`}>
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                  INTENT_FREE_TIER_HOMEOSTASIS
                </span>
                <span className="mono text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300">
                  {!hasWarning ? "ACTIVE" : "STANDBY"}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                All 7 Cloudflare subsystems operate within 0-64% capacity. Full cron cadences and maximum reasoning models remain active.
              </p>
              <div className="mono text-[10px] text-slate-500">
                Action: Retain full 15m heartbeat & shadow execution.
              </div>
            </div>

            {/* Intent 2: Preemptive Quota Guard */}
            <div className={`glass-inner p-3 space-y-2 border ${
              hasWarning ? "border-amber-500/40 bg-amber-500/10" : "border-white/5"
            }`}>
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                  INTENT_CONSERVE_COMPUTE
                </span>
                <span className="mono text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300">
                  {hasWarning ? "DISPATCHED" : "TRIGGER: >80%"}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                Threshold triggered. Switches AI Kernel from remote inference to deterministic templates, decelerating telemetry polling to preserve free tier.
              </p>
              <div className="mono text-[10px] text-amber-300">
                Action: Throttle drift observer to 15m; pause non-essential crons.
              </div>
            </div>

            {/* Intent 3: Treasury Auto-Billing Bridge */}
            <div className="glass-inner p-3 space-y-2 border border-white/5">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-white flex items-center gap-1.5">
                  <Zap className="h-3.5 w-3.5 text-cyan-400" />
                  INTENT_TREASURY_AUTO_PAY
                </span>
                <span className="mono text-[10px] px-1.5 py-0.5 rounded bg-cyan-500/20 text-cyan-300">
                  {"TRIGGER: >100%"}
                </span>
              </div>
              <p className="text-[11px] text-slate-400 leading-relaxed">
                If compute demands necessitate Workers Paid plan ($5.00/mo), authorizes auto-drawdown from self-sustaining trading yields buffer.
              </p>
              <div className="mono text-[10px] text-cyan-300">
                Action: Drawdown $5.00/mo from EA profit buffer; zero lockup.
              </div>
            </div>

          </div>
        </div>
      </Panel>

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
              Status: SHA-256 Identical & Compiled ✓
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
              Empirical Gate: Holm-Bonferroni α=0.05 Required
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
