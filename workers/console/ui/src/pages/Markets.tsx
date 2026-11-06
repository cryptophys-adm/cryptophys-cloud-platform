import { CandlestickChart } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useOverview } from "../lib/overview";
import { ago, listOf } from "../lib/format";

export default function Markets() {
  const { ov } = useOverview();
  const x = ov?.xauusd_latest;
  const { data, loading } = usePoll(() => call("kernel.reports", undefined, undefined, { kind: "xauusd_digest", limit: "25" }), 60_000);
  const rows = listOf(data, "reports");
  const tone = (d?: string) => d === "BUY" ? "text-emerald-400" : d === "SELL" ? "text-rose-400" : "text-amber-300";
  return (
    <div className="flex flex-col gap-3">
      <Panel title="XAUUSD · latest decision" icon={<CandlestickChart className="h-3.5 w-3.5 text-amber-300" />} right={<Badge tone="amber">advisory relay · not an order</Badge>}>
        {!x ? <Empty>No decision relayed yet.</Empty> : x.error ? <Empty>Relay unavailable.</Empty> : (
          <div className="flex flex-wrap items-center gap-8">
            <div className={`mono text-[48px] font-extrabold leading-none ${tone(x.decision)}`} style={{ textShadow: "0 0 28px currentColor" }}>{x.decision}</div>
            <div className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-8 gap-y-1.5 text-[12px]">
              <span className="text-slate-500">confidence</span><span className="mono text-slate-100">{x.confidence}</span>
              <span className="text-slate-500">candle</span><span className="mono break-all text-slate-100">{x.candle_key}</span>
              <span className="text-slate-500">decided at</span><span className="mono text-slate-100">{x.decided_at}</span>
              <span className="text-slate-500">relayed</span><span className="mono text-slate-100">{ago(x.reported_at)}</span>
            </div>
          </div>
        )}
      </Panel>
      <Panel title="Signal Analyst digests">
        {loading && !data ? <Skeleton rows={5} /> : rows.length === 0 ? <Empty>No digests yet.</Empty> : (
          <div className="space-y-1.5">{rows.map((r: any) => (
            <div key={r.report_id} className="glass-inner flex flex-wrap items-center gap-3 px-3 py-2 text-[12px]">
              <span className={`mono w-12 font-bold ${tone(r.body?.decision)}`}>{r.body?.decision ?? "—"}</span>
              <span className="min-w-0 flex-1 truncate text-slate-300">{r.subject}</span>
              <span className="text-[10px] text-slate-600">{ago(r.created_at)}</span>
            </div>))}
          </div>
        )}
        <p className="mt-3 text-[10px] uppercase tracking-widest text-slate-600">Display only. The platform never places orders or moves funds.</p>
      </Panel>
    </div>
  );
}
