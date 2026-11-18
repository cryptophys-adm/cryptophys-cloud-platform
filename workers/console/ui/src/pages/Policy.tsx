import { useState } from "react";
import { Badge, JsonView, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago, listOf } from "../lib/format";
import { ActivityChart, BarList, DataTable, STATUS, StatusBar, bucketize } from "../components/viz";

const DECISIONS = [{ key: "allow", label: "allow", color: STATUS.good }, { key: "deny", label: "deny", color: STATUS.critical }];

// HAIC H0a (ADR-0017 Decision 5, docs/design/HAIC-H0-H1.md §2.7): the page only reads. The "Evaluate" form and its
// allow-list row are gone. A manual evaluation was recorded under the operator's bare Access identity (an email with
// no "agent:", "owner:" or "ai:" prefix); such rows stay in the list but are left out of the stats, so the charts
// show what the platform's agents, owner clicks and deploys were decided, not tests.
const isManualEvaluation = (subject: unknown) => typeof subject === "string" && subject.includes("@") && !/^[a-z]+:/.test(subject);
const failedChecks = (reason: unknown) => String(reason ?? "").replace(/^failed:\s*/, "").split(/,\s*/).filter((id) => id && id !== "all policy checks passed");

export default function Policy() {
  const { notify } = useSession();
  const { data, loading } = usePoll(() => call("policy.decisions", undefined, undefined, { limit: "100" }), 60_000);
  const [detail, setDetail] = useState<any>(null);
  const [check, setCheck] = useState<string | null>(null);
  const rows = listOf(data, "decisions");
  const stats = rows.filter((r: any) => !isManualEvaluation(r.subject));
  const manual = rows.length - stats.length;
  const { buckets, bin } = bucketize(stats, (r: any) => r.created_at, (r: any) => (r.decision === "allow" ? "allow" : "deny"));
  const byAction = Object.values(stats.reduce((m: Record<string, any>, r: any) => {
    const e = (m[r.action] ??= { label: r.action, value: 0, a: 0, d: 0 });
    e.value += 1; if (r.decision === "allow") e.a += 1; else e.d += 1;
    return m;
  }, {})).map((e: any) => ({ label: e.label, value: e.value, parts: [{ key: "allow", label: "allow", value: e.a, color: STATUS.good }, { key: "deny", label: "deny", value: e.d, color: STATUS.critical }] }));
  const denyCounts = stats.filter((r: any) => r.decision !== "allow").reduce((m: Record<string, number>, r: any) => {
    for (const id of failedChecks(r.reason)) m[id] = (m[id] ?? 0) + 1;
    return m;
  }, {});
  const denyReasons = Object.entries(denyCounts).map(([label, value]) => ({ label, value: Number(value) }));
  const shown = check ? rows.filter((r: any) => r.decision !== "allow" && failedChecks(r.reason).includes(check)) : rows;
  const open = (id: string) => call("policy.decision", id).then((d: any) => setDetail(d?.decision ?? d)).catch((e) => notify("err", e.message));
  const checks: any[] = Array.isArray(detail?.evidence?.checks) ? detail.evidence.checks : [];
  const failed = checks.filter((c) => c && c.passed === false);

  return (
    <div className="flex flex-col gap-3">
      {stats.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-2">
          <Panel title={`Decisions over time · last ${stats.length}`} right={manual > 0 ? <span className="text-[10px] text-slate-500">{manual} manual evaluation{manual === 1 ? "" : "s"} not counted</span> : undefined}>
            <StatusBar className="mb-3" segments={DECISIONS.map((d) => ({ ...d, value: stats.filter((r: any) => (r.decision === "allow") === (d.key === "allow")).length }))} legend={false} />
            <ActivityChart buckets={buckets} bin={bin} series={DECISIONS} caption="policy decisions over time" />
          </Panel>
          <Panel title="By action · failed checks">
            <BarList items={byAction} series={DECISIONS} />
            {denyReasons.length > 0 && <>
              <div className="mb-1.5 mt-4 text-[10px] uppercase tracking-widest text-slate-500">Checks that denied</div>
              <BarList items={denyReasons} color={STATUS.critical} />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {denyReasons.sort((a, b) => b.value - a.value).map((d) => (
                  <button key={d.label} type="button" className={`mono rounded-full border px-2 py-0.5 text-[10px] text-red-200 hover:bg-red-500/10 ${check === d.label ? "border-red-400 bg-red-500/15" : "border-red-500/30"}`} aria-pressed={check === d.label}
                    onClick={() => setCheck(check === d.label ? null : d.label)}>{d.label} · {d.value}</button>
                ))}
              </div>
            </>}
          </Panel>
        </div>
      )}
      <Panel title={check ? `Decisions denied by ${check}` : "Decisions"} right={<span className="flex items-center gap-2">{check && <button type="button" className="text-[10px] text-slate-400 hover:text-slate-200" onClick={() => setCheck(null)}>show all</button>}<Badge tone="purple">{shown.length}</Badge></span>}>
        {loading && !data ? <Skeleton rows={5} /> : (
          <DataTable rows={shown} rowKey={(r) => r.decision_id} initialSort={{ key: "when", dir: "desc" }} empty="No decisions." footer={<span>click a row for its checks and evidence</span>}
            onRowClick={(r) => open(r.decision_id)} columns={[
              { key: "decision", header: "decision", sort: (r) => r.decision, cell: (r) => <Badge tone={r.decision === "allow" ? "green" : "red"}>{r.decision}</Badge> },
              { key: "action", header: "action", sort: (r) => r.action, cell: (r) => <span className="mono text-[11px] text-cyan-200">{r.action}</span> },
              { key: "resource", header: "resource", sort: (r) => r.resource, cell: (r) => <span className="mono text-[11px]">{r.resource}</span> },
              { key: "subject", header: "subject", sort: (r) => r.subject, cell: (r) => <span className="mono text-[11px] text-slate-400">{r.subject}{isManualEvaluation(r.subject) ? <span className="ml-1 text-slate-600">(manual)</span> : null}</span> },
              { key: "reason", header: "reason", className: "wrap", cell: (r) => <span className="text-slate-400">{r.reason}</span> },
              { key: "when", header: "when", sort: (r) => Date.parse(r.created_at) || 0, cell: (r) => <span className="text-slate-500" title={r.created_at}>{ago(r.created_at)}</span> },
            ]} />
        )}
      </Panel>
      {detail && (
        <Panel title="Decision" right={<button type="button" className="text-[10px] text-slate-400 hover:text-slate-200" onClick={() => setDetail(null)}>close</button>}>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12px]">
            <dt className="text-slate-500">decision</dt><dd><Badge tone={detail.decision === "allow" ? "green" : "red"}>{detail.decision ?? "—"}</Badge></dd>
            <dt className="text-slate-500">subject</dt><dd className="mono">{detail.subject ?? "—"}</dd>
            <dt className="text-slate-500">action</dt><dd className="mono text-cyan-200">{detail.action ?? "—"}</dd>
            <dt className="text-slate-500">resource</dt><dd className="mono">{detail.resource ?? "—"}</dd>
            <dt className="text-slate-500">when</dt><dd className="text-slate-400" title={detail.created_at}>{detail.created_at ? ago(detail.created_at) : "—"}</dd>
            <dt className="text-slate-500">checks</dt><dd className="text-slate-300">{checks.length ? `${checks.length - failed.length} of ${checks.length} passed` : "—"}</dd>
          </dl>
          {failed.length > 0 && (
            <div className="mt-3">
              <div className="mb-1 text-[10px] uppercase tracking-widest text-slate-500">Failed checks</div>
              <ul className="space-y-1 text-[12px]">
                {failed.map((c) => <li key={c.id}><span className="mono text-red-300">{c.id}</span> <span className="text-slate-400">{c.detail}</span></li>)}
              </ul>
            </div>
          )}
          <div className="mb-1 mt-3 text-[10px] uppercase tracking-widest text-slate-500">Evidence</div>
          <JsonView value={detail.evidence ?? detail} />
        </Panel>
      )}
    </div>
  );
}
