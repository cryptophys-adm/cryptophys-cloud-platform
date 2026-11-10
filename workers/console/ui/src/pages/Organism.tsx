import { Activity, CandlestickChart, Database, Flame, HeartPulse, Leaf, Scale, Server, ShieldCheck, Sparkles, Zap } from "lucide-react";
import { Badge, Dot, Empty, Panel, Skeleton } from "../components/ui";
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

  // Live values from the AI Kernel (GET /v1/metabolism), never computed or invented in the browser.
  // Owner rules 2026-11-10: survival saves AI only; growth applies only with the owner's override.
  const metabolism = usePoll(() => call("kernel.metabolism"), 60_000);
  const live: any = (metabolism.data as any)?.live ?? {};
  const isWeekend = live.market_status === "closed" || live.market_status === "holiday";
  const mode = String(live.power_mode ?? "");
  const powerMode = mode ? mode.toUpperCase() + (live.power_mode_override && live.power_mode_override !== "none" ? " (OWNER OVERRIDE)" : "") : "—";
  const usd = (v: unknown) => (typeof v === "number" ? `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}` : "—");
  const balance = usd(live.treasury_reserve_usd);
  const burn = usd(live.infra_burn_cost_24h);
  const runwayDays = typeof live.runway_days === "number" ? Math.floor(live.runway_days) : "—";
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
                Pusat kendali metabolisme kas mandiri, sistem saraf otonom, dan jalur evolusi epigenetik Cryptophys.
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
        <Panel title="Kas Swasembada (Treasury)" icon={<Database className="h-3.5 w-3.5 text-emerald-400" />}>
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="mono text-2xl font-bold text-emerald-400">{balance}</span>
              <span className="text-xs text-slate-400">Genesis Buffer</span>
            </div>
            <div className="glass-inner p-2.5 space-y-1.5 text-xs">
              <div className="flex justify-between text-slate-400">
                <span>Estimasi Burn Rate:</span>
                <span className="mono text-amber-300">{burn} / day</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Runway Bertahan:</span>
                <span className="mono text-cyan-300">{runwayDays} Hari Mandiri</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>Hasil deal 24 jam:</span>
                <span className="mono text-emerald-400">{usd(live.trading_net_pnl_24h)} (dibaca saja)</span>
              </div>
            </div>
            <p className="text-[10px] text-slate-500">
              Hasil deal EA/Omega hanya dibaca untuk mengatur belanja AI. Platform tidak pernah memindahkan dana atau mengirim order.
            </p>
          </div>
        </Panel>

        {/* Metric 2: Power Policy & Quota */}
        <Panel title="Mode Daya & Kebijakan" icon={<Scale className="h-3.5 w-3.5 text-cyan-400" />}>
          <div className="space-y-3">
            <div className="flex items-baseline justify-between">
              <span className="mono text-2xl font-bold text-cyan-300">{aiQuota}%</span>
              <span className="text-xs text-slate-400">AI Daily Quota Limit</span>
            </div>
            <div className="glass-inner p-2.5 space-y-1.5 text-xs">
              <div className="flex justify-between text-slate-400">
                <span>Status Pasar:</span>
                <span className={`mono font-semibold ${isWeekend ? "text-amber-300" : "text-emerald-400"}`}>
                  {live.market_status ? String(live.market_status).toUpperCase() : "—"}
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
              Survival menghemat AI dan tidak pernah memblokir consensus. Growth hanya aktif lewat override owner.
            </p>
          </div>
        </Panel>

        {/* Metric 3: Nervous System & Mesh */}
        <Panel title="Sistem Saraf & Mesh" icon={<Activity className="h-3.5 w-3.5 text-purple-400" />}>
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
              Koneksi RPC Service Bindings menghubungkan seluruh organ tanpa rahasia plain-text.
            </p>
          </div>
        </Panel>

      </div>

      {/* Real Cloudflare usage (GET /v1/usage), owner 2026-11-10 */}
      <CloudflareUsage />

      {/* Epigenetic Evolution & Canon Protection */}
      <Panel title="Evolusi Epigenetik & Keutuhan Canon" icon={<ShieldCheck className="h-3.5 w-3.5 text-amber-300" />}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div className="glass-inner p-3 space-y-2">
            <div className="font-semibold text-white flex items-center gap-1.5">
              <Sparkles className="h-3 w-3 text-purple-400" />
              Aether Canon Synchronizer (scripts/sync-canon-kb.mjs)
            </div>
            <p className="text-slate-400 leading-relaxed">
              Memverifikasi keselarasan hash SHA-256 antara knowledge base indikator trading assistant dengan canon Aether. Perubahan doktrin hanya dipromosikan melalui PR yang telah direview secara deterministik.
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
              Mengaudit kandidat tuning bobot konsensus di *shadow execution*. Wajib lulus discovery sample ≥ 50 bar, uji statistik Holm–Bonferroni (α=0.05), dan holdout out-of-sample ≥ 100 bar.
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
