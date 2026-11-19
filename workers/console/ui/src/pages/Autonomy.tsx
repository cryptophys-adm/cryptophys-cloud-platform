import { useState } from "react";
import { Gauge, TriangleAlert } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "../components/ui";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago } from "../lib/format";
import { hubLabel, useDebounced, useHub } from "../lib/hub";

/**
 * HAIC H4 (ADR-0017 §5; owner answers of 2026-11-18): the autonomy dial, per group of consensus actions. Four levels:
 * observe → suggest → execute after the owner's click → execute on consensus. The dial only lowers a group below its
 * ADR-0009 class and raises it back to that class; a regression lowers a group one level at once; a group with 30
 * executions in 14 days, at least 95% succeeded and no regression, is shown as ready to rise. Only the owner sets a level.
 */

const LEVELS = ["observe", "suggest", "owner_click", "consensus"] as const;
const RANK: Record<string, number> = { observe: 0, suggest: 1, owner_click: 2, consensus: 3 };
const LABEL: Record<string, string> = { observe: "observe", suggest: "suggest", owner_click: "after your click", consensus: "on consensus" };
const TONE: Record<string, "slate" | "amber" | "purple" | "green"> = { observe: "slate", suggest: "amber", owner_click: "purple", consensus: "green" };
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
const pct = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? `${Math.round(v * 1000) / 10}%` : "—");

function Group({ g, owner, refresh }: { g: any; owner: boolean; refresh: () => void }) {
  const { act } = useSession();
  const [level, setLevel] = useState<string>(g.level);
  const [reason, setReason] = useState("");
  const allowed = LEVELS.filter((l) => RANK[l] <= RANK[g.ceiling]);
  const set = () => act({
    route: "kernel.autonomy_set", params: g.group,
    body: { level, confirmation: `SET ${String(g.group).toUpperCase()} ${level.toUpperCase()}`, reason: reason.trim() || undefined },
    title: `${g.label}: ${LABEL[g.level] ?? g.level} → ${LABEL[level] ?? level}`,
    lines: [
      RANK[level] < RANK[g.level] ? "Lowering: these actions then wait for you, or are only recorded." : RANK[level] > RANK[g.level] ? `Raising, at most to ${LABEL[g.ceiling]} (its ADR-0009 class).` : "The level stays; the note is recorded.",
      "Your change is audited under your Access identity.",
    ],
    done: "Level set.", after: () => { setReason(""); refresh(); },
  });
  const s = g.stats ?? {};
  return (
    <li className="py-2.5">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-semibold text-white">{g.label}</span>
        <Badge tone={TONE[g.level] ?? "slate"}>{LABEL[g.level] ?? g.level}</Badge>
        <span className="text-slate-500">ceiling: {LABEL[g.ceiling] ?? g.ceiling}</span>
        {g.source === "auto_downgrade" && <span className="inline-flex items-center gap-1 text-amber-300"><TriangleAlert className="h-3 w-3" />lowered after a regression</span>}
        {g.raise_to && <Badge tone="cyan">ready to rise to {LABEL[g.raise_to] ?? g.raise_to}</Badge>}
        <span className="ml-auto text-slate-500">{s.executions ?? 0} executions · {pct(s.success_rate)} · {s.regressions ?? 0} regression(s), 14 days</span>
      </div>
      {g.reason && <div className="mt-1 text-[11px] text-slate-400">{g.source === "owner" ? "your note" : "why"}: {g.reason}{g.set_at ? <> · <span title={g.set_at}>{ago(g.set_at)}</span></> : null}</div>}
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {arr(g.actions).map((a: any) => (
          <span key={a.action} className="mono rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-slate-300" title={`${a.class} in ADR-0009; at most ${a.ceiling}`}>
            {a.action} · <span className={a.effective === "consensus" ? "text-emerald-300" : a.effective === "owner_click" ? "text-violet-300" : "text-amber-300"}>{LABEL[a.effective] ?? a.effective ?? "—"}</span>
          </span>
        ))}
        {arr(g.actions).length === 0 && <span className="text-[11px] text-slate-500">No action of this group is in the catalog yet; trading never rises above your click.</span>}
      </div>
      {arr(g.regressions).length > 0 && (
        <ul className="mt-1 text-[11px] text-amber-200">{arr(g.regressions).map((r: any) => <li key={`${r.ref}:${r.at}`}>{r.detail} <span className="text-slate-500" title={r.at}>{ago(r.at)}</span></li>)}</ul>
      )}
      {owner && (
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="block">
            <span className="label">Level</span>
            <select className="field" value={level} onChange={(e) => setLevel(e.target.value)}>
              {allowed.map((l) => <option key={l} value={l}>{LABEL[l]}</option>)}
            </select>
          </label>
          <label className="block min-w-48 flex-1">
            <span className="label">Note (optional)</span>
            <input className="field" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why you set this level" />
          </label>
          <button type="button" className="btn btn-approve py-1!" disabled={level === g.level && g.source !== "auto_downgrade"} onClick={set}>Set…</button>
        </div>
      )}
    </li>
  );
}

export default function Autonomy() {
  const { who } = useSession();
  const owner = who.owner === true;
  const { data, loading, error, refresh } = usePoll(() => call("kernel.autonomy"), 5 * 60_000);
  const live = useHub(["inbox"], useDebounced(() => void refresh()));
  const groups = arr(data?.groups);
  const held = arr(data?.held);
  return (
    <div className="flex flex-col gap-3">
      <h1 className="sr-only">Autonomy</h1>
      <Panel title="Autonomy dial" icon={<Gauge className="h-3.5 w-3.5 text-cyan-300" />}
        right={<span className={`text-[10px] ${live === "live" ? "text-emerald-300" : "text-slate-500"}`}>{hubLabel(live)}</span>}>
        <p className="mb-2 text-[12px] text-slate-400">
          Each group of actions runs at one level: observe, suggest, after your click, or on consensus. You can lower any group and raise it back up to its ADR-0009 class, never above it.
          A regression lowers a group one level at once. A group with {data?.raise_rule?.min_executions ?? 30} executions in {data?.raise_rule?.window_days ?? 14} days, at least {Math.round((data?.raise_rule?.min_success ?? 0.95) * 100)}% succeeded and no regression, is shown as ready to rise. Only you raise it.
        </p>
        {loading && !data ? <Skeleton rows={4} /> : error && !data ? <Empty>{error}</Empty> : data?.available === false ? (
          <Empty>The autonomy dial is not available yet: its table is not migrated. Every group runs at its ADR-0009 class.</Empty>
        ) : <ul className="divide-y divide-white/5">{groups.map((g: any) => <Group key={`${g.group}:${g.level}:${g.set_at ?? ""}`} g={g} owner={owner} refresh={() => void refresh()} />)}</ul>}
      </Panel>
      <Panel title="Held by the dial" right={<span className="text-[10px] text-slate-500">passed proposals recorded at observe or suggest, 7 days</span>}>
        {held.length === 0 ? <Empty>Nothing was held.</Empty> : (
          <ul className="divide-y divide-white/5 text-[12px]">
            {held.map((h: any) => (
              <li key={h.proposal_id} className="flex flex-wrap items-center gap-2 py-1.5">
                <Badge tone={TONE[h.autonomy_level] ?? "slate"}>{LABEL[h.autonomy_level] ?? h.autonomy_level}</Badge>
                <span className="mono text-slate-200">{h.action}</span><span className="text-slate-500">on</span><span className="mono text-slate-300">{h.target}</span>
                <span className="ml-auto text-slate-500" title={h.created_at}>{h.created_at ? ago(h.created_at) : "—"}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
