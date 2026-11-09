import { BookOpenCheck, Check, Sparkles, X } from "lucide-react";
import { Badge, Dot, Empty, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, listOf } from "../lib/format";
import { DataTable, STATUS, StatusBar } from "../components/viz";

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
        <StatusBar className="mt-3" segments={[
          { key: "approved", label: "approved for shadow", value: counts.approved ?? 0, color: STATUS.good },
          { key: "pending", label: "pending", value: counts.pending ?? 0, color: STATUS.warning },
          { key: "rejected", label: "rejected", value: counts.rejected ?? 0, color: STATUS.serious },
          { key: "expired", label: "expired", value: counts.expired ?? 0, color: STATUS.neutral },
        ]} />
      </Panel>
      <Panel title="Proposals" icon={<BookOpenCheck className="h-3.5 w-3.5 text-cyan-300" />} right={<Badge tone="cyan">{rows.length}</Badge>}>
        {loading && !data ? <Skeleton rows={5} /> : error && !data ? <Empty>{error}</Empty> : (
          <DataTable rows={rows} rowKey={(p) => p.proposal_id} initialSort={{ key: "when", dir: "desc" }} maxHeight={560}
            footer={pending.length ? <span className="text-amber-300">open a pending row to review and decide</span> : null}
            empty="No proposals yet. Aether proposes once it has enough decision cards and outcomes." columns={[
              { key: "status", header: "status", sort: (p) => p.status, cell: (p) => <span className="inline-flex items-center gap-1.5"><Dot tone={tone(p.status)} pulse={p.status === "pending"} />{p.status}</span> },
              { key: "item", header: "item", sort: (p) => p.item_id, cell: (p) => <span className="mono text-cyan-200">{p.item_id}@{p.item_version}</span> },
              { key: "kind", header: "kind", sort: (p) => p.kind, cell: (p) => <span title={KIND_TEXT[p.kind] ?? ""}><Badge tone="purple">{String(p.kind).replace("_", " ")}</Badge></span> },
              { key: "text", header: "what it says", className: "wrap", cell: (p) => <span className="text-slate-300">{p.item?.text ?? "—"}</span> },
              { key: "proposer", header: "proposer", sort: (p) => p.proposer_agent_id, cell: (p) => <span className="mono text-[11px] text-slate-400">{p.proposer_agent_id}</span> },
              { key: "decided", header: "decided", sort: (p) => p.decided_by ?? "", cell: (p) => p.decided_by ? <span className="text-[11px] text-slate-400">{p.decided_by} · {ago(p.decided_at)}</span> : <span className="text-slate-600">—</span> },
              { key: "when", header: "proposed", sort: (p) => Date.parse(p.created_at) || 0, cell: (p) => <span className="text-slate-500" title={p.created_at}>{ago(p.created_at)}</span> },
            ]}
            expand={(p) => (
              <div>
                <p className="text-[11px] text-slate-400">{KIND_TEXT[p.kind] ?? ""}{p.reason ? ` · ${p.reason}` : ""}</p>
                <Item p={p} />
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
            )} />
        )}
      </Panel>
    </div>
  );
}
