import { useEffect, useState } from "react";
import { Eye, Pencil, Server } from "lucide-react";
import { Badge, Dot, Empty, Field, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, fmt, listOf } from "../lib/format";
import { BarList, DataTable, STATUS, StatusBar } from "../components/viz";

const ageMin = (iso?: string) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? Math.max(0, Math.round((Date.now() - t) / 60_000)) : null; };
/** When the Drift Detector last observed the service: last_seen_at (its heartbeat; rows are recorded only on change, 0061), else the row's observed_at. */
const seenAt = (d: any): string | undefined => d?.last_seen_at ?? d?.observed_at;

function Editor({ id, onDone }: { id: string; onDone: () => void }) {
  const { who, act, notify } = useSession();
  const svc = usePoll(() => call("registry.service", id), 0, [id]);
  const s = svc.data?.service ?? svc.data ?? {};
  const meta = s.metadata && typeof s.metadata === "object" && !Array.isArray(s.metadata) ? s.metadata : {};
  const [f, setF] = useState({ display_name: "", environment: "production", status: "registered", endpoint: "", owner: "", purpose: "", data_classification: "internal" });
  const [version, setVersion] = useState("");
  useEffect(() => {
    if (!svc.data) return;
    setF({ display_name: s.display_name ?? "", environment: s.environment ?? "production", status: s.status ?? "registered", endpoint: s.endpoint ?? "",
      owner: meta.owner ?? "", purpose: meta.purpose ?? "", data_classification: meta.data_classification ?? "internal" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svc.data]);
  if (svc.loading && !svc.data) return <Skeleton rows={3} />;
  // Hardening 2026-11-08: changing a service record or its desired version shapes production, so it is an approver's act.
  if (!who.approver) return <Panel title={<>Edit <span className="mono normal-case tracking-normal text-slate-200">{id}</span></>}><Empty>Only an approver can change a service record or its desired version.</Empty></Panel>;
  return (
    <Panel title={<>Edit <span className="mono normal-case tracking-normal text-slate-200">{id}</span></>} icon={<Pencil className="h-3.5 w-3.5 text-cyan-300" />}>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        <Field label="Display name"><input className="field" maxLength={120} value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></Field>
        <Field label="Environment"><select className="field" value={f.environment} onChange={(e) => setF({ ...f, environment: e.target.value })}>{["development", "preview", "production"].map((x) => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Status"><select className="field" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{["registered", "healthy", "degraded", "unavailable", "disabled"].map((x) => <option key={x}>{x}</option>)}</select></Field>
        <Field label="Endpoint (https, optional)"><input className="field mono" value={f.endpoint} onChange={(e) => setF({ ...f, endpoint: e.target.value })} /></Field>
        <Field label="Owner"><input className="field" value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} /></Field>
        <Field label="Data classification"><select className="field" value={f.data_classification} onChange={(e) => setF({ ...f, data_classification: e.target.value })}>{["public", "internal", "confidential", "restricted"].map((x) => <option key={x}>{x}</option>)}</select></Field>
      </div>
      <Field label="Purpose" className="mt-2"><input className="field" value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} /></Field>
      <button type="button" className="btn mt-3" onClick={() => {
        const b: any = { display_name: f.display_name.trim(), environment: f.environment, status: f.status, metadata: { ...meta, owner: f.owner.trim(), purpose: f.purpose.trim(), data_classification: f.data_classification } };
        if (f.endpoint.trim()) { if (!f.endpoint.trim().startsWith("https://")) { notify("err", "Endpoint must be an https URL."); return; } b.endpoint = f.endpoint.trim(); }
        if (!b.display_name) { notify("err", "Display name must be 1 to 120 characters."); return; }
        act({ route: "registry.upsert", params: id, body: b, title: `Update service ${id}`, lines: [`Replaces the registry record of ${id}.`], done: "Service updated.", after: onDone });
      }}>Update service…</button>
      <div className="mt-4 grid grid-cols-1 gap-2 border-t border-white/5 pt-4 sm:grid-cols-[1fr_auto]">
        <Field label="Desired version (7–40 hex)"><input className="field mono" maxLength={40} value={version} onChange={(e) => setVersion(e.target.value)} /></Field>
        <div className="flex items-end"><button type="button" className="btn" onClick={() => {
          const v = version.trim();
          if (!/^[0-9a-fA-F]{7,40}$/.test(v)) { notify("err", "Desired version must be 7 to 40 hex characters."); return; }
          act({ route: "registry.desired_version", params: id, body: { desired_version: v }, title: `Set desired version of ${id}`, lines: [`Drift is measured against ${v}.`], done: "Desired version set.", after: onDone });
        }}>Set desired version…</button></div>
      </div>
    </Panel>
  );
}

export default function Infrastructure() {
  const { act } = useSession();
  const reg = usePoll(() => call("registry.services"), 60_000);
  const drift = usePoll(() => call("drift.list"), 60_000);
  const [edit, setEdit] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const byId = new Map(listOf(drift.data, "services").map((d: any) => [d.service_id, d]));
  const services = listOf(reg.data, "services");
  const reload = () => { void reg.refresh(); void drift.refresh(); };

  return (
    <div className="flex flex-col gap-3">
      <Panel title="Services & Drift" icon={<Server className="h-3.5 w-3.5 text-cyan-300" />}
        right={<button type="button" className="btn" disabled={busy} onClick={() => { setBusy(true); act({ route: "drift.observe", body: {}, title: "Observe now", done: "Observation complete.", after: () => { setBusy(false); reload(); }, onError: () => setBusy(false) }); }}>
          <Eye className="h-3.5 w-3.5" />{busy ? "Observing…" : "Observe now"}</button>}>
        {reg.loading && !reg.data ? <Skeleton rows={6} /> : (<>
          {services.length > 0 && (
            <div className="mb-3 grid gap-3 lg:grid-cols-2">
              <div><div className="mb-1.5 text-[10px] uppercase tracking-widest text-slate-500">Fleet state</div>
                <StatusBar segments={[
                  { key: "sync", label: "in sync", value: services.filter((s: any) => s.status !== "disabled" && byId.get(s.service_id)?.drifted === false).length, color: STATUS.good },
                  { key: "drift", label: "drifted", value: services.filter((s: any) => s.status !== "disabled" && byId.get(s.service_id)?.drifted === true).length, color: STATUS.critical },
                  { key: "unk", label: "not observed / disabled", value: services.filter((s: any) => s.status === "disabled" || byId.get(s.service_id)?.drifted === undefined).length, color: STATUS.neutral },
                ]} /></div>
              <div><div className="mb-1.5 text-[10px] uppercase tracking-widest text-slate-500">Minutes since last observation</div>
                <BarList max={6} unit=" min" color={STATUS.info} items={services.map((s: any) => ({ label: String(s.service_id).replace(/^cryptophys-/, ""), value: ageMin(seenAt(byId.get(s.service_id))) ?? 0 }))} /></div>
            </div>
          )}
          <DataTable rows={services} rowKey={(s) => s.service_id} maxHeight={560} initialSort={{ key: "drift", dir: "desc" }} empty="No services registered." columns={[
            { key: "service", header: "service", sort: (s) => s.service_id, cell: (s) => <div><div className="text-slate-200">{s.display_name ?? s.service_id}</div><div className="mono text-[10px] text-slate-500">{s.service_id}</div></div> },
            { key: "status", header: "status", sort: (s) => byId.get(s.service_id)?.status ?? s.status, cell: (s) => { const d: any = byId.get(s.service_id) ?? {}; return <Badge tone={s.status === "disabled" ? "slate" : d.drifted ? "red" : "green"}>{d.status ?? s.status}</Badge>; } },
            { key: "drift", header: "drift", sort: (s) => { const d: any = byId.get(s.service_id); return d?.drifted ? 2 : d ? 0 : 1; }, cell: (s) => { const d: any = byId.get(s.service_id) ?? {}; return <span className="inline-flex items-center gap-1.5"><Dot tone={d.drifted === undefined ? "slate" : d.drifted ? "red" : "green"} pulse={d.drifted} />{d.drifted === undefined ? "—" : d.drifted ? "drifted" : "in sync"}</span>; } },
            { key: "desired", header: "desired", sort: (s) => byId.get(s.service_id)?.desired_version ?? s.desired_version, cell: (s) => <span className="mono text-[11px]">{fmt(byId.get(s.service_id)?.desired_version ?? s.desired_version)}</span> },
            { key: "observed", header: "observed", sort: (s) => byId.get(s.service_id)?.observed_version, cell: (s) => <span className="mono text-[11px]">{fmt(byId.get(s.service_id)?.observed_version)}</span> },
            { key: "seen", header: "last observed", sort: (s) => -(ageMin(seenAt(byId.get(s.service_id))) ?? 1e9), cell: (s) => <span className="text-slate-500">{ago(seenAt(byId.get(s.service_id)))}</span> },
            { key: "edit", header: "", cell: (s) => <button type="button" className="btn py-1 text-[11px]" onClick={() => setEdit(s.service_id)}><Pencil className="h-3 w-3" />Edit</button> },
          ]} />
        </>)}
      </Panel>
      {edit && <Editor key={edit} id={edit} onDone={reload} />}
    </div>
  );
}
