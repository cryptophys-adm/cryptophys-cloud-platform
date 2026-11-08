import { useState } from "react";
import { ArrowLeft, Bot, KeyRound, Pause, Play, Zap } from "lucide-react";
import { Badge, Dot, Empty, Field, JsonView, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, fmt, listOf } from "../lib/format";

const KERNEL_AGENTS = ["supervisor", "signal-analyst", "auditor"];

export default function AgentDetail({ id }: { id: string }) {
  const { who, act, notify } = useSession();
  const agent = usePoll(() => call("kernel.agent", id), 0, [id]);
  const actions = usePoll(() => call("kernel.agent_actions", id, undefined, { limit: "50" }), 60_000, [id]);
  const [reason, setReason] = useState("");
  const [principal, setPrincipal] = useState("");
  const [revoke, setRevoke] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [showPrincipals, setShowPrincipals] = useState(false);
  const a = agent.data?.agent ?? agent.data ?? {};
  const kernelHosted = a.host_worker === "cryptophys-ai-kernel";
  const reload = () => { void agent.refresh(); void actions.refresh(); };

  return (
    <div className="flex flex-col gap-3">
      <a href="#/agents" className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-widest text-slate-500 hover:text-cyan-300"><ArrowLeft className="h-3 w-3" />AI Mesh</a>
      <Panel title={<span className="mono normal-case tracking-normal text-slate-200">{id}</span>} icon={<Bot className="h-3.5 w-3.5 text-cyan-300" />}
        right={<div className="flex gap-2"><Badge tone={a.status === "enabled" ? "green" : "slate"}>{a.status ?? "—"}</Badge><Badge tone="purple">tier {a.tier_max ?? "—"}</Badge></div>}>
        {agent.loading && !agent.data ? <Skeleton rows={4} /> : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {Object.entries(a).filter(([k]) => k !== "capabilities").map(([k, v]) => (
              <div key={k}><dt className="label">{k}</dt><dd className="mono break-words text-[12px] text-slate-200">{fmt(v)}</dd></div>
            ))}
            {Array.isArray(a.capabilities) && <div className="sm:col-span-2"><dt className="label">capabilities</dt><dd className="flex flex-wrap gap-1.5">{a.capabilities.map((c: any) => <Badge key={String(c.capability ?? c)} tone="cyan">{String(c.capability ?? c)}</Badge>)}</dd></div>}
          </dl>
        )}
      </Panel>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel title="Lifecycle" icon={<Zap className="h-3.5 w-3.5 text-amber-300" />}>
          <Field label="Suspend reason (1–200 characters)"><input className="field" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn btn-danger" onClick={() => {
              const r = reason.trim();
              if (!r) { notify("err", "A suspend reason of 1 to 200 characters is required."); return; }
              act({ route: "kernel.suspend", params: id, body: { reason: r }, title: `Suspend ${id}`, lines: ["The agent stops acting until an approver resumes it.", `Reason: ${r}`], done: `Suspended ${id}.`, after: reload });
            }}><Pause className="h-3.5 w-3.5" />Suspend…</button>
            {who.approver && <button type="button" className="btn btn-approve" onClick={() => act({ route: "kernel.resume", params: id, title: `Resume ${id}`, lines: ["The agent may act again."], done: `Resumed ${id}.`, after: reload })}><Play className="h-3.5 w-3.5" />Resume…</button>}
            {KERNEL_AGENTS.includes(id) && <button type="button" className="btn" onClick={() => act({ route: "kernel.wake", params: id, title: `Wake ${id}`, lines: ["Runs one cycle of this agent now."], done: `Woke ${id}.`, after: reload })}><Zap className="h-3.5 w-3.5" />Wake…</button>}
          </div>
        </Panel>
        {who.approver && !kernelHosted && !showPrincipals && (
          <Panel title="External principals" icon={<KeyRound className="h-3.5 w-3.5 text-violet-300" />}>
            <p className="text-[12px] text-slate-500">No external agent uses this platform yet (TP-009). The principal controls stay hidden until one does.</p>
            <button type="button" className="btn mt-2" onClick={() => setShowPrincipals(true)}>Manage principals…</button>
          </Panel>
        )}
        {who.approver && !kernelHosted && showPrincipals && (
          <Panel title="External principals" icon={<KeyRound className="h-3.5 w-3.5 text-violet-300" />}>
            <Field label="Access email or service-token Client ID"><input className="field mono" maxLength={200} value={principal} onChange={(e) => setPrincipal(e.target.value)} /></Field>
            <button type="button" className="btn btn-danger mt-2" onClick={() => {
              const v = principal.trim();
              if (!v) { notify("err", "Enter an Access identity."); return; }
              act({ route: "kernel.principal_add", params: id, body: { access_identity: v }, title: `Add principal to ${id}`, lines: [`This identity may act as ${id} through MCP.`, v], done: "Principal added.", after: reload });
            }}>Add principal…</button>
            <Field label="Principal to revoke" className="mt-3"><input className="field mono" maxLength={200} value={revoke} onChange={(e) => setRevoke(e.target.value)} /></Field>
            <button type="button" className="btn btn-danger mt-2" onClick={() => {
              const v = revoke.trim();
              act({ route: "kernel.principal_remove", params: [id, v], title: `Revoke principal of ${id}`, lines: [`This identity can no longer act as ${id}.`, v], done: "Principal removed.", after: reload });
            }}>Remove principal…</button>
          </Panel>
        )}
      </div>

      <Panel title="Syscall history · last 50" icon={<Dot tone="cyan" />}>
        {actions.loading && !actions.data ? <Skeleton rows={4} /> : listOf(actions.data, "actions").length === 0 ? <Empty>No actions recorded.</Empty> : (
          <div className="space-y-1.5">
            {listOf(actions.data, "actions").map((x: any, i: number) => {
              const key = String(x.action_id ?? i);
              return (
                <div key={key} className="glass-inner px-3 py-2">
                  <button type="button" className="flex w-full items-center gap-2 text-left text-[12px]" onClick={() => setOpen(open === key ? null : key)} aria-expanded={open === key}>
                    <Dot tone={x.outcome === "succeeded" ? "green" : x.outcome === "denied" ? "amber" : "red"} />
                    <span className="mono text-cyan-200">{fmt(x.capability)}</span>
                    <span className="text-slate-500">{fmt(x.outcome)}</span>
                    <span className="ml-auto text-[10px] text-slate-600">{ago(x.created_at)}</span>
                  </button>
                  {open === key && <div className="mt-2"><JsonView value={x} /></div>}
                </div>
              );
            })}
          </div>
        )}
      </Panel>
    </div>
  );
}
