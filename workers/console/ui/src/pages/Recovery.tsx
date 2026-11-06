import { useState } from "react";
import { Plus, Trash2, Wrench } from "lucide-react";
import { Badge, Empty, Field, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, listOf, navigate } from "../lib/format";

export const STEP_ACTIONS = ["rollback_worker_version", "redeploy_commit", "disable_service", "restore_d1_bookmark", "rotate_secret", "manual"];
export const statusTone = (s?: string) => s === "draft" ? "amber" : s === "approved" ? "cyan" : s === "executing" ? "purple" : s === "completed" ? "green" : s === "failed" ? "red" : "slate";

export default function Recovery() {
  const { act, notify } = useSession();
  const [status, setStatus] = useState("");
  const plans = usePoll(() => call("recovery.plans", undefined, undefined, { status }), 60_000, [status]);
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
        right={<select className="field w-40 py-1.5" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
          {["", "draft", "approved", "executing", "completed", "failed", "disabled"].map((s) => <option key={s} value={s}>{s || "all statuses"}</option>)}</select>}>
        {plans.loading && !plans.data ? <Skeleton rows={4} /> : rows.length === 0 ? <Empty>No plans.</Empty> : (
          <div className="table-wrap"><table className="tbl">
            <thead><tr><th>plan</th><th>service</th><th>title</th><th>status</th><th>author</th><th>created</th></tr></thead>
            <tbody>{rows.map((p: any) => (
              <tr key={p.plan_id} className="cursor-pointer" onClick={() => navigate(`#/recovery/${p.plan_id}`)}>
                <td><a className="mono text-cyan-200 hover:underline" href={`#/recovery/${p.plan_id}`}>{p.plan_id.slice(0, 18)}…</a></td>
                <td className="mono text-[11px]">{p.service_id}</td><td>{p.title}</td>
                <td><Badge tone={statusTone(p.status) as any}>{p.status}</Badge></td>
                <td className="mono text-[11px] text-slate-400">{p.created_by}</td><td className="text-slate-500">{ago(p.created_at)}</td>
              </tr>))}</tbody>
          </table></div>
        )}
      </Panel>

      <Panel title="Create Plan" icon={<Plus className="h-3.5 w-3.5 text-cyan-300" />}>
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
      </Panel>
    </div>
  );
}
