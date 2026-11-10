import { Activity, HeartPulse, Landmark, Scale, ShieldCheck } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { ActivityChart, BarList, DataTable, STATUS, Stat, StatusBar, bucketize } from "../components/viz";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import CloudflareUsage from "../components/CloudflareUsage";
import { ago, listOf } from "../lib/format";

/**
 * Digital metabolism (#263, #264, #265; owner 2026-11-10). The power mode only steers AI spending:
 * survival saves, growth needs the owner's override, consensus is never blocked. The treasury reads
 * deal results only: nothing here places orders or moves funds. Read-only page.
 */
const MODES = [
  { key: "homeostasis", label: "homeostasis", color: STATUS.good },
  { key: "growth", label: "growth (owner override)", color: STATUS.info },
  { key: "survival", label: "survival (saves AI)", color: STATUS.warning },
];
const modeKey = (m?: string) => (MODES.some((x) => x.key === m) ? String(m) : "homeostasis");
const tone = (m?: string) => (m === "survival" ? "amber" : m === "growth" ? "cyan" : "green") as "amber" | "cyan" | "green";
const usd = (v: unknown) => (typeof v === "number" ? `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "—");
const num = (v: unknown, unit = "") => (typeof v === "number" ? `${v.toLocaleString("en-US", { maximumFractionDigits: 1 })}${unit}` : "—");

export default function Metabolism() {
  const { data, loading, error } = usePoll(() => call("kernel.metabolism"), 60_000);
  const live = data?.live ?? {};
  const cycles = listOf(data, "cycles");
  const ledger = listOf(data, "ledger");
  const burn = listOf(data, "burn_14d");
  const changes = listOf(data, "mode_changes");
  const rules: string[] = Array.isArray(data?.rules) ? data.rules : [];
  const { buckets, bin } = bucketize(cycles, (c: any) => c.evaluated_at, (c: any) => modeKey(c.power_mode));
  const override = live.power_mode_override && live.power_mode_override !== "none" ? String(live.power_mode_override) : null;

  return (
    <div className="flex flex-col gap-3">
      <h1 className="sr-only">Metabolism</h1>
      <Panel title="Digital Metabolism" icon={<HeartPulse className="h-3.5 w-3.5 text-emerald-300" />}
        right={<div className="flex flex-wrap justify-end gap-2">
          <Badge tone={tone(live.power_mode)}>mode · {live.power_mode ?? "—"}</Badge>
          <Badge tone={live.market_status === "open" ? "green" : "slate"}>market · {live.market_status ?? "—"}</Badge>
          {override && <Badge tone="purple">owner override · {override}</Badge>}
          {live.auto_adaptation_enabled === false && <Badge tone="slate">auto adaptation off</Badge>}
        </div>}>
        {loading && !data ? <Skeleton rows={3} /> : error && !data ? <Empty>{error}</Empty> : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              <Stat label="Treasury reserve" value={usd(live.treasury_reserve_usd)} />
              <Stat label="Runway" value={num(live.runway_days, " d")} tone={typeof live.runway_days === "number" && live.runway_days < 7 ? "critical" : undefined} sub="reserve ÷ burn per day" />
              <Stat label="Infra burn 24 h" value={usd(live.infra_burn_cost_24h)} sub="estimated" />
              <Stat label="Deal result 24 h" value={usd(live.trading_net_pnl_24h)} sub="read from XAUUSD, advisory" />
              <Stat label="Metabolic ratio" value={num(live.metabolic_ratio)} sub="deal result ÷ burn" />
            </div>
            <p className="mt-3 text-[11px] text-slate-500">Observed {ago(live.observed_at)}. Values are estimates for steering AI spending, not accounting.</p>
          </>
        )}
      </Panel>

      <CloudflareUsage />

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title={`Power mode over time · ${cycles.length} cycles (14 d)`} icon={<Activity className="h-3.5 w-3.5 text-cyan-300" />}>
          {cycles.length === 0 ? <Empty>No heartbeat cycle yet. The Supervisor records one each scheduled cycle once its metabolism code is deployed.</Empty> : (
            <>
              <StatusBar className="mb-3" legend={false} segments={MODES.map((m) => ({ ...m, value: cycles.filter((c: any) => modeKey(c.power_mode) === m.key).length }))} />
              <ActivityChart buckets={buckets} bin={bin} series={MODES} caption="metabolism cycles over time by power mode" />
            </>
          )}
        </Panel>
        <Panel title="Estimated burn per service · 14 d" icon={<Scale className="h-3.5 w-3.5 text-violet-300" />}>
          <BarList unit="" items={burn.map((b: any) => ({ label: String(b.service_id).replace(/^cryptophys-/, ""), value: Math.round(Number(b.cost_usd ?? 0) * 100) / 100, sub: "USD" }))}
            empty="No burn metrics recorded yet." />
        </Panel>
      </div>

      <Panel title="Heartbeat cycles" icon={<HeartPulse className="h-3.5 w-3.5 text-emerald-300" />} right={<Badge tone="slate">{cycles.length}</Badge>}>
        <DataTable rows={cycles} rowKey={(c) => c.cycle_id} initialSort={{ key: "when", dir: "desc" }} maxHeight={380} empty="No cycle recorded yet." columns={[
          { key: "mode", header: "mode", sort: (c) => c.power_mode, cell: (c) => <Badge tone={tone(c.power_mode)}>{c.power_mode}</Badge> },
          { key: "market", header: "market", sort: (c) => c.market_status, cell: (c) => <span className="text-[11px] text-slate-400">{c.market_status}</span> },
          { key: "pnl", header: "deal result 24 h", align: "right", sort: (c) => c.trading_net_pnl_24h, cell: (c) => <span className="mono">{usd(c.trading_net_pnl_24h)}</span> },
          { key: "burn", header: "burn 24 h", align: "right", sort: (c) => c.infra_burn_cost_24h, cell: (c) => <span className="mono">{usd(c.infra_burn_cost_24h)}</span> },
          { key: "reserve", header: "reserve", align: "right", sort: (c) => c.treasury_reserve_usd, cell: (c) => <span className="mono">{usd(c.treasury_reserve_usd)}</span> },
          { key: "runway", header: "runway", align: "right", sort: (c) => c.runway_days, cell: (c) => <span className="mono">{num(c.runway_days, " d")}</span> },
          { key: "reason", header: "reason", className: "wrap", cell: (c) => <span className="text-slate-400">{c.mode_reason}</span> },
          { key: "when", header: "when", sort: (c) => Date.parse(c.evaluated_at) || 0, cell: (c) => <span className="text-slate-500" title={c.evaluated_at}>{ago(c.evaluated_at)}</span> },
        ]} />
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
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
    </div>
  );
}
