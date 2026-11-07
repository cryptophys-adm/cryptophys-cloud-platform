import { useState } from "react";
import { BookOpenCheck, Check, Sparkles, X } from "lucide-react";
import { Badge, Dot, Empty, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, listOf } from "../lib/format";

/** TP-028: learned-knowledge proposals from Aether (tier 1 drafts). Approval is for shadow testing only. */
const tone = (s?: string): "green" | "amber" | "red" | "slate" =>
  s === "approved" ? "green" : s === "pending" ? "amber" : s === "rejected" ? "red" : "slate";
const KIND_TEXT: Record<string, string> = {
  caution: "A measured pattern where an agent has been wrong more often than usual.",
  role_reminder: "An agent keeps breaking its role or the doctrine; a reminder of its role.",
  param_candidate: "A parameter value from a reviewed grid, to test in shadow.",
};

function Item({ p }: { p: any }) {
  const item = p.item ?? {};
  const ev = item.evidence ?? {};
  return (
    <div className="mt-2 space-y-2 text-[11px]">
      <p className="text-[12px] leading-relaxed text-slate-200">{item.text}</p>
      <div className="flex flex-wrap gap-2">
        <Badge tone="slate">audience · {(item.audience?.agents ?? []).join(", ")}</Badge>
        {(item.audience?.charts ?? []).length > 0 && <Badge tone="slate">charts · {item.audience.charts.join(", ")}</Badge>}
        <Badge tone="slate">{item.provenance?.card_ids?.length ?? 0} decision cards cited</Badge>
      </div>
      <pre className="glass-inner mono max-h-40 overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-[10px] text-slate-400">{JSON.stringify(ev, null, 2)}</pre>
      {item.params && <pre className="glass-inner mono overflow-auto whitespace-pre-wrap break-all px-3 py-2 text-[10px] text-slate-400">{JSON.stringify(item.params, null, 2)}</pre>}
    </div>
  );
}

export default function Knowledge() {
  const { who, act } = useSession();
  const { data, loading, error, refresh } = usePoll(() => call("kernel.knowledge", undefined, undefined, { limit: "100" }), 60_000);
  const [open, setOpen] = useState<string | null>(null);
  const rows = listOf(data, "proposals");
  const counts: Record<string, number> = data?.counts ?? {};
  const pending = rows.filter((p: any) => p.status === "pending");
  const reload = () => void refresh();
  return (
    <div className="flex flex-col gap-3">
      <Panel title="Learned Knowledge · Aether" icon={<Sparkles className="h-3.5 w-3.5 text-violet-300" />} right={<Badge tone={pending.length ? "amber" : "slate"}>{pending.length} pending</Badge>}>
        <p className="text-[12px] leading-relaxed text-slate-400">
          Aether's curator and calibrator propose what they measured. Your approval only lets a proposal run in shadow on the XAUUSD rooms; it never changes a live agent. Promotion is a separate owner PR in the XAUUSD repository. Proposals expire after 14 days. Advisory only: no levels, sizes or orders.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {["pending", "approved", "rejected", "expired"].map((k) => <Badge key={k} tone={tone(k)}>{k} · {counts[k] ?? 0}</Badge>)}
        </div>
      </Panel>
      <Panel title="Proposals" icon={<BookOpenCheck className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone="cyan">{rows.length}</Badge>}>
        {loading && !data ? <Skeleton rows={5} /> : error && !data ? <Empty>{error}</Empty> : rows.length === 0 ? <Empty>No proposals yet. Aether proposes once it has enough decision cards and outcomes.</Empty> : (
          <div className="space-y-1.5">
            {rows.map((p: any) => (
              <div key={p.proposal_id} className="glass-inner px-3 py-2.5">
                <button type="button" className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => setOpen(open === p.proposal_id ? null : p.proposal_id)} aria-expanded={open === p.proposal_id}>
                  <Dot tone={tone(p.status)} pulse={p.status === "pending"} />
                  <span className="mono text-[12px] text-cyan-200">{p.item_id}@{p.item_version}</span>
                  <Badge tone="purple">{String(p.kind).replace("_", " ")}</Badge>
                  <span className="text-[11px] text-slate-400">{KIND_TEXT[p.kind] ?? ""}</span>
                  <span className="ml-auto flex items-center gap-2"><Badge tone={tone(p.status)}>{p.status}</Badge><span className="text-[10px] text-slate-600">{ago(p.created_at)}</span></span>
                </button>
                <div className="mt-1 text-[10px] text-slate-500">
                  proposed by <span className="mono">{p.proposer_agent_id}</span>
                  {p.decided_by && <> · {p.status} by <span className="mono">{p.decided_by}</span> {ago(p.decided_at)}</>}
                  {p.reason && <> · {p.reason}</>}
                </div>
                {open === p.proposal_id && <Item p={p} />}
                {p.status === "pending" && (who.approver ? (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" className="btn btn-approve" onClick={() => act({ route: "kernel.knowledge_approve", params: p.proposal_id, body: { reason: "approved for shadow testing in the Console" },
                      title: `Approve ${p.item_id}@${p.item_version} for shadow testing`,
                      lines: ["Recorded under your Access identity in the audit chain.", "Aether exports it in the approved pack; the XAUUSD shadow arm tests it. No live agent changes.", "Promotion still needs your PR in the XAUUSD repository."],
                      done: "Approved for shadow testing.", after: reload })}><Check className="h-3.5 w-3.5" />Approve…</button>
                    <button type="button" className="btn btn-danger" onClick={() => act({ route: "kernel.knowledge_reject", params: p.proposal_id, body: { reason: "rejected in the Console" },
                      title: `Reject ${p.item_id}@${p.item_version}`, lines: ["The proposal is closed as rejected. Aether does not propose the same version again."],
                      done: "Rejected.", after: reload })}><X className="h-3.5 w-3.5" />Reject…</button>
                  </div>
                ) : <div className="mt-1 text-[11px] text-slate-500">Only an approver can decide.</div>)}
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
