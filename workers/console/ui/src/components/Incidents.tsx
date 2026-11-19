import { useState } from "react";
import { ChevronDown, ChevronRight, History } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "./ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { ago } from "../lib/format";

/**
 * Owner 2026-11-19: the Incidents panel. Each incident (a critical report, or a native deploy that failed without a
 * full restore) with its status derived by the kernel (open, mitigated once acknowledged, resolved once a later deploy
 * of the unit succeeded and its Workers show no drift), one joined timeline, and the post-incident summary when one has
 * been written. Read only: GET /v1/incidents.
 */

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const TONE: Record<string, "red" | "amber" | "green"> = { open: "red", mitigated: "amber", resolved: "green" };
const time = (at: unknown) => (typeof at === "string" ? at.replace("T", " ").slice(0, 16) + " UTC" : "—");

function Incident({ i, initiallyOpen }: { i: any; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  const timeline = arr(i.timeline);
  const s = i.summary && typeof i.summary === "object" ? i.summary : null;
  return (
    <div className="glass-inner px-3 py-2 text-[12px]">
      <button type="button" className="flex w-full items-start gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" /> : <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />}
        <span className="min-w-0 flex-1 wrap-break-word text-slate-200">{i.title ?? "—"}</span>
        <Badge tone={TONE[i.status] ?? "slate"}>{String(i.status ?? "—")}</Badge>
      </button>
      <div className="mt-1 flex flex-wrap items-center gap-2 pl-5 text-[11px] text-slate-500">
        <span>opened <span title={i.opened_at}>{ago(i.opened_at)}</span></span>
        {i.resolved_at ? <span>· resolved <span title={i.resolved_at}>{ago(i.resolved_at)}</span></span> : null}
        <span className="wrap-break-word">· {i.status_reason}</span>
      </div>
      {open && (
        <div className="mt-2 space-y-3 pl-5">
          <ol className="space-y-1 border-l border-slate-700/60 pl-3">
            {timeline.map((e, n) => (
              <li key={`${e.at}:${n}`} className="text-[11px]">
                <span className="mono text-slate-500">{time(e.at)}</span>{" "}
                <span className="wrap-break-word text-slate-300">{e.text}</span>
              </li>
            ))}
          </ol>
          {s ? (
            <div className="space-y-1.5 text-[11px]">
              <div className="label">Post-incident summary</div>
              <p className="wrap-break-word text-slate-300"><span className="text-slate-500">Cause. </span>{s.cause}</p>
              <p className="wrap-break-word text-slate-300"><span className="text-slate-500">Impact. </span>{s.impact}</p>
              <p className="wrap-break-word text-slate-300"><span className="text-slate-500">Fix. </span>{s.fix}</p>
              {arr(s.lessons).length > 0 && (
                <ul className="list-disc space-y-0.5 pl-4 text-slate-300">{arr(s.lessons).map((l, n) => <li key={n} className="wrap-break-word">{l}</li>)}</ul>
              )}
            </div>
          ) : <p className="text-[11px] text-slate-500">No post-incident summary yet.</p>}
        </div>
      )}
    </div>
  );
}

export function IncidentsPanel() {
  const { data, loading, error } = usePoll(() => call("kernel.incidents"), 120_000);
  const rows = arr(data?.incidents);
  const active = rows.filter((i) => i.status !== "resolved").length;
  return (
    <Panel title="Incidents" icon={<History className="h-3.5 w-3.5 text-cyan-300" />}
      right={<Badge tone={active ? "red" : "slate"}>{active ? `${active} active` : String(rows.length)}</Badge>}>
      <p className="mb-2 text-[11px] text-slate-500">Critical reports and deploys that failed without a full restore, in the last {typeof data?.window_days === "number" ? data.window_days : 30} days. The status follows the records: mitigated once acknowledged, resolved once a later deploy succeeded and the Workers show no drift.</p>
      {loading && !data ? <Skeleton rows={2} /> : error && !data ? <Empty>{error}</Empty> : rows.length === 0 ? <Empty>No incident in this window.</Empty> : (
        <div className="space-y-2">{rows.map((i, n) => <Incident key={i.incident_id} i={i} initiallyOpen={n === 0 && i.status !== "resolved"} />)}</div>
      )}
    </Panel>
  );
}
