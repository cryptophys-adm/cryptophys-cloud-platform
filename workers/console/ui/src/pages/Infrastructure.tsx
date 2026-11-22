import { useCallback, useState } from "react";
import { ChevronRight, Eye, Server } from "lucide-react";
import { Badge, Dot, ErrorBox, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, fmt, listOf } from "../lib/format";
import { BarList, DataTable, STATUS, StatusBar } from "../components/viz";
import ServiceDetail from "../components/ServiceDetail";
import { driftState, lastProbeAt, minutesSince, probeAges } from "../lib/serviceDetail";

/**
 * Services & Drift. Read only (owner 2026-11-15, "tombol Edit tidak berfungsi"): the Edit form and its registry
 * writes are gone, because registry records come from the DNA, the census and consensus deploys, and a manual
 * edit conflicts with the DNA and creates false drift. A click on a service opens its detail (ServiceDetail).
 * "Observe now" stays. The age of a service's last probe is the Drift Detector's heartbeat (last_seen_at, i.e.
 * service_registry.updated_at), not the time of its last recorded observation, which is written only on change.
 */
export default function Infrastructure() {
  const { act } = useSession();
  const reg = usePoll(() => call("registry.services"), 60_000);
  const drift = usePoll(() => call("drift.list"), 60_000);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const byId = new Map(listOf(drift.data, "services").map((d: any) => [d.service_id, d]));
  const services = listOf(reg.data, "services");
  const reload = () => { void reg.refresh(); void drift.refresh(); };
  const close = useCallback(() => setOpen(null), []);
  const now = Date.now();
  const stateOf = (s: any) => driftState(byId.get(s.service_id), s.status);
  const count = (kind: string) => services.filter((s: any) => stateOf(s).kind === kind).length;
  const ages = probeAges(services.filter((s: any) => s.status !== "disabled").map((s: any) => String(s.service_id)), byId, now);
  const selected = open ? services.find((s: any) => s.service_id === open) : undefined;

  return (
    <div className="flex flex-col gap-3">
      <ErrorBox error={reg.error ?? drift.error} onRetry={reload} stale={Boolean(reg.data)} />
      <Panel title="Services & Drift" icon={<Server className="h-3.5 w-3.5 text-cyan-300" />}
        right={<button type="button" className="btn" disabled={busy} onClick={() => { setBusy(true); act({ route: "drift.observe", body: {}, title: "Observe now", done: "Observation complete.", after: () => { setBusy(false); reload(); }, onError: () => setBusy(false) }); }}>
          <Eye className="h-3.5 w-3.5" />{busy ? "Observing…" : "Observe now"}</button>}>
        {reg.loading && !reg.data ? <Skeleton rows={6} /> : (<>
          {services.length > 0 && (
            <div className="mb-3 grid gap-3 lg:grid-cols-2">
              <div><div className="mb-1.5 text-[10px] uppercase tracking-widest text-slate-500">Fleet state</div>
                <StatusBar segments={[
                  { key: "sync", label: "in sync", value: count("in_sync"), color: STATUS.good },
                  { key: "untagged", label: "untagged version", value: count("untagged"), color: STATUS.warning },
                  { key: "drift", label: "drifted", value: count("drifted"), color: STATUS.critical },
                  { key: "unk", label: "not observed / disabled", value: count("not_observed") + count("disabled"), color: STATUS.neutral },
                ]} /></div>
              <div><div className="mb-1.5 text-[10px] uppercase tracking-widest text-slate-500">Minutes since last probe · Drift Detector heartbeat</div>
                <BarList max={6} rest="max" unit=" min" color={STATUS.info} empty="No probe recorded yet."
                  items={ages.measured.map((a) => ({ label: a.service_id.replace(/^cryptophys-/, ""), value: a.minutes }))} />
                {ages.unmeasured.length > 0 && (
                  <p className="mt-1.5 text-[10px] text-slate-500">Not measured (never probed): <span className="mono">{ages.unmeasured.map((x) => x.replace(/^cryptophys-/, "")).join(", ")}</span></p>
                )}
              </div>
            </div>
          )}
          <DataTable rows={services} rowKey={(s) => s.service_id} maxHeight={560} initialSort={{ key: "drift", dir: "desc" }} empty="No services registered."
            onRowClick={(s) => setOpen(s.service_id)} columns={[
            { key: "service", header: "service", sort: (s) => s.service_id, cell: (s) => (
              <button type="button" className="group flex items-center gap-1 text-left" aria-label={`Details of ${s.service_id}`} onClick={(e) => { e.stopPropagation(); setOpen(s.service_id); }}>
                <div><div className="text-slate-200 group-hover:text-cyan-200">{s.display_name ?? s.service_id}</div><div className="mono text-[10px] text-slate-500">{s.service_id}</div></div>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-600 group-hover:text-cyan-300" />
              </button>
            ) },
            { key: "status", header: "status", sort: (s) => s.status, cell: (s) => <Badge tone={s.status === "healthy" ? "green" : s.status === "unavailable" ? "red" : s.status === "degraded" ? "amber" : "slate"}>{fmt(s.status)}</Badge> },
            { key: "drift", header: "drift", sort: (s) => ({ drifted: 3, untagged: 2, not_observed: 1 } as Record<string, number>)[stateOf(s).kind] ?? 0, cell: (s) => { const st = stateOf(s); return <span className="inline-flex items-center gap-1.5"><Dot tone={st.tone} pulse={st.kind === "drifted"} />{st.label}</span>; } },
            { key: "desired", header: "desired", sort: (s) => s.desired_version, cell: (s) => <span className="mono text-[11px]">{fmt(s.desired_version)}</span> },
            { key: "observed", header: "observed", sort: (s) => s.observed_version, cell: (s) => <span className="mono text-[11px]">{fmt(s.observed_version)}</span> },
            { key: "seen", header: "last probe", sort: (s) => -(minutesSince(lastProbeAt(byId.get(s.service_id)), now) ?? 1e9), cell: (s) => { const at = lastProbeAt(byId.get(s.service_id)); return <span className="text-slate-500">{at ? ago(at) : "not measured"}</span>; } },
          ]} />
        </>)}
      </Panel>
      {selected && <ServiceDetail service={selected} drift={byId.get(selected.service_id)} onClose={close} />}
    </div>
  );
}
