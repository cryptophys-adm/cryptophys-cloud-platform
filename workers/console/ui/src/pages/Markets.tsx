import { CandlestickChart } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useOverview } from "../lib/overview";
import { ago, listOf } from "../lib/format";
import { ActivityChart, CATEGORICAL, DataTable, STATUS, StatusBar, bucketize } from "../components/viz";

// Display only: the share of advisory decisions per kind, never an instruction. Polarity, so the
// diverging pair (blue <-> red) with a neutral gray middle, not the status colours.
const DECISION = [
  { key: "BUY", label: "BUY (advisory)", color: CATEGORICAL[0] },
  { key: "HOLD", label: "HOLD / other", color: STATUS.neutral },
  { key: "SELL", label: "SELL (advisory)", color: CATEGORICAL[7] },
];
const dKey = (d?: string) => (d === "BUY" || d === "SELL" ? d : "HOLD");

export default function Markets() {
  const { ov } = useOverview();
  const x = ov?.xauusd_latest;
  const { data, loading } = usePoll(() => call("kernel.reports", undefined, undefined, { kind: "xauusd_digest", limit: "100" }), 60_000);
  const rows = listOf(data, "reports");
  const { buckets, bin } = bucketize(rows, (r: any) => r.created_at, (r: any) => dKey(r.body?.decision));
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
        {loading && !data ? <Skeleton rows={5} /> : rows.length === 0 ? <Empty>No digests yet.</Empty> : (<>
          <div className="mb-3 grid gap-3 lg:grid-cols-2">
            <div><div className="mb-1.5 text-[10px] uppercase tracking-widest text-slate-500">Relayed decisions · last {rows.length}</div>
              <StatusBar segments={DECISION.map((d) => ({ ...d, value: rows.filter((r: any) => dKey(r.body?.decision) === d.key).length }))} /></div>
            <ActivityChart buckets={buckets} bin={bin} series={DECISION} height={100} caption="advisory decisions over time" />
          </div>
          <DataTable rows={rows} rowKey={(r) => r.report_id} initialSort={{ key: "when", dir: "desc" }} maxHeight={420} columns={[
            { key: "decision", header: "decision", sort: (r) => r.body?.decision ?? "", cell: (r) => <span className={`mono font-bold ${tone(r.body?.decision)}`}>{r.body?.decision ?? "—"}</span> },
            { key: "confidence", header: "confidence", align: "right", sort: (r) => Number(r.body?.confidence ?? NaN) || null, cell: (r) => <span className="mono">{r.body?.confidence ?? "—"}</span> },
            { key: "subject", header: "subject", className: "wrap", cell: (r) => <span className="text-slate-300">{r.subject}</span> },
            { key: "when", header: "when", sort: (r) => Date.parse(r.created_at) || 0, cell: (r) => <span className="text-slate-500" title={r.created_at}>{ago(r.created_at)}</span> },
          ]} />
        </>)}
        <p className="mt-3 text-[10px] uppercase tracking-widest text-slate-600">Display only. The platform never places orders or moves funds.</p>
      </Panel>
    </div>
  );
}
