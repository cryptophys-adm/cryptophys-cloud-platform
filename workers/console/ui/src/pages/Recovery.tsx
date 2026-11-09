import { useState } from "react";
import { Plus, Trash2, Wrench } from "lucide-react";
import { Badge, Empty, Field, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, listOf, navigate } from "../lib/format";
import { BarList, DataTable, STATUS, StatusBar } from "../components/viz";

const PLAN_STATUS = [
  { key: "completed", label: "completed", color: STATUS.good },
  { key: "approved", label: "approved", color: STATUS.info },
  { key: "draft", label: "draft (waits for approval)", color: STATUS.warning },
  { key: "executing", label: "executing", color: STATUS.owner },
  { key: "failed", label: "failed", color: STATUS.critical },
  { key: "other", label: "disabled / superseded", color: STATUS.neutral },
];
const planKey = (s?: string) => (PLAN_STATUS.some((x) => x.key === s) ? String(s) : "other");

export const STEP_ACTIONS = ["rollback_worker_version", "redeploy_commit", "disable_service", "restore_d1_bookmark", "rotate_secret", "manual"];
export const statusTone = (s?: string) => s === "draft" ? "amber" : s === "approved" ? "cyan" : s === "executing" ? "purple" : s === "completed" ? "green" : s === "failed" ? "red" : "slate";

export default function Recovery() {
  const { who, act, notify } = useSession();
  const [status, setStatus] = useState("");
  const [synthetic, setSynthetic] = useState(false);
  // Deploy-verification plans (authored by the deploy workflow's service token) are hidden unless asked for.
  const plans = usePoll(() => call("recovery.plans", undefined, undefined, { status, include_synthetic: synthetic ? "1" : undefined }), 60_000, [status, synthetic]);
  const services = usePoll(() => call("registry.services"), 0);
  const [form, setForm] = useState({ service_id: "", plan_version: "1", title: "", rationale: "" });
  const [steps, setSteps] = useState([{ action: "manual", description: "" }]);
  const svcIds = listOf(services.data, "services").map((s: any) => s.service_id as string);

  function create() {
    const body = { ...form, service_id: form.service_id || svcIds[0] || "", title: form.title.trim(), rationale: form.rationale.trim(), plan_version: form.plan_version.trim(),
      steps: steps.map((s) => ({ action: s.action, description: s.description.trim() })) };
    if (!body.service_id || !body.plan_version || body.plan_version.length > 40) return notify("err", "Choose a service and a plan version (up to 40 characters).");
    if (!body.title || body.title.length > 160) return notify("err", "Title must be 1 to 160 characters.");
    if (body.rationale.length > 2000) return notify("err", "Rationale is limited to 2000 characters.");
    if (body.steps.some((s) => !s.description || s.description.length > 500)) return notify("err", "Every step needs a description of 1 to 500 characters.");
    act({ route: "recovery.create", body, title: "Create recovery plan", lines: [`Creates a draft plan for ${body.service_id}: ${body.title}`, "It runs nothing until it is approved and started."], done: "Plan created.", after: (d) => d?.plan?.plan_id ? navigate(`#/recovery/${d.plan.plan_id}`) : void plans.refresh() });
  }

  const rows = listOf(plans.data, "plans");
  return (
    <div className="flex flex-col gap-3">
      <Panel title="Recovery Plans" icon={<Wrench className="h-3.5 w-3.5 text-amber-300" />}
        right={<div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-[11px] text-slate-400"><input type="checkbox" checked={synthetic} onChange={(e) => setSynthetic(e.target.checked)} />deploy checks</label>
          <select className="field w-40 py-1.5" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
          {["", "draft", "approved", "executing", "completed", "failed", "disabled"].map((s) => <option key={s} value={s}>{s || "all statuses"}</option>)}</select></div>}>
        {plans.loading && !plans.data ? <Skeleton rows={4} /> : (<>
          {rows.length > 0 && (
            <div className="mb-3 grid gap-3 lg:grid-cols-2">
              <div><div className="mb-1.5 text-[10px] uppercase tracking-widest text-slate-500">By status</div>
                <StatusBar segments={PLAN_STATUS.map((s) => ({ ...s, value: rows.filter((p: any) => planKey(p.status) === s.key).length }))} /></div>
              <div><div className="mb-1.5 text-[10px] uppercase tracking-widest text-slate-500">By service</div>
                <BarList max={6} items={Object.entries(rows.reduce((m: Record<string, number>, p: any) => { m[p.service_id] = (m[p.service_id] ?? 0) + 1; return m; }, {})).map(([label, value]) => ({ label: label.replace(/^cryptophys-/, ""), value: Number(value) }))} /></div>
            </div>
          )}
          <DataTable rows={rows} rowKey={(p) => p.plan_id} onRowClick={(p) => navigate(`#/recovery/${p.plan_id}`)} initialSort={{ key: "created", dir: "desc" }} empty="No plans." columns={[
            { key: "status", header: "status", sort: (p) => p.status, cell: (p) => <span className="inline-flex gap-1"><Badge tone={statusTone(p.status) as any}>{p.status}</Badge>{p.synthetic ? <Badge tone="slate">deploy check</Badge> : null}</span> },
            { key: "plan", header: "plan", sort: (p) => p.plan_id, cell: (p) => <a className="mono text-cyan-200 hover:underline" href={`#/recovery/${p.plan_id}`} onClick={(e) => e.stopPropagation()}>{p.plan_id.slice(0, 18)}…</a> },
            { key: "service", header: "service", sort: (p) => p.service_id, cell: (p) => <span className="mono text-[11px]">{p.service_id}</span> },
            { key: "title", header: "title", className: "wrap", sort: (p) => p.title, cell: (p) => p.title },
            { key: "steps", header: "steps", align: "right", sort: (p) => (Array.isArray(p.steps) ? p.steps.length : 0), cell: (p) => <span className="mono">{Array.isArray(p.steps) ? p.steps.length : "—"}</span> },
            { key: "author", header: "author", sort: (p) => p.created_by, cell: (p) => <span className="mono text-[11px] text-slate-400">{p.created_by}</span> },
            { key: "created", header: "created", sort: (p) => Date.parse(p.created_at) || 0, cell: (p) => <span className="text-slate-500" title={p.created_at}>{ago(p.created_at)}</span> },
          ]} />
        </>)}
      </Panel>

      {who.approver && <Panel title="Create Plan" icon={<Plus className="h-3.5 w-3.5 text-cyan-300" />}>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
          <Field label="Service"><select className="field" value={form.service_id || svcIds[0] || ""} onChange={(e) => setForm({ ...form, service_id: e.target.value })}>{svcIds.map((s) => <option key={s}>{s}</option>)}</select></Field>
          <Field label="Plan version"><input className="field mono" maxLength={40} value={form.plan_version} onChange={(e) => setForm({ ...form, plan_version: e.target.value })} /></Field>
          <Field label="Title"><input className="field" maxLength={160} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
        </div>
        <Field label="Rationale" className="mt-2"><textarea className="field min-h-[70px]" maxLength={2000} value={form.rationale} onChange={(e) => setForm({ ...form, rationale: e.target.value })} /></Field>
        <div className="mt-3 space-y-2">
          {steps.map((s, i) => (
            <div key={i} className="grid grid-cols-1 gap-2 md:grid-cols-[220px_1fr_auto]">
              <Field label={`Step ${i + 1} action`}><select className="field" value={s.action} onChange={(e) => setSteps(steps.map((x, j) => j === i ? { ...x, action: e.target.value } : x))}>{STEP_ACTIONS.map((a) => <option key={a}>{a}</option>)}</select></Field>
              <Field label="Description (1–500)"><input className="field" maxLength={500} value={s.description} onChange={(e) => setSteps(steps.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} /></Field>
              <div className="flex items-end"><button type="button" className="btn" aria-label={`Remove step ${i + 1}`} disabled={steps.length <= 1} onClick={() => setSteps(steps.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></button></div>
            </div>
          ))}
        </div>
        <div className="mt-3 flex gap-2">
          <button type="button" className="btn" disabled={steps.length >= 20} onClick={() => setSteps([...steps, { action: "manual", description: "" }])}><Plus className="h-3.5 w-3.5" />Add step</button>
          <button type="button" className="btn btn-approve" onClick={create}>Create plan…</button>
        </div>
      </Panel>}
    </div>
  );
}
