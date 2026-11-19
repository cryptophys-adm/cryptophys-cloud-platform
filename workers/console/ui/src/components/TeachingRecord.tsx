import { GraduationCap } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "./ui";
import { DataTable, Stat, type Column } from "./viz";
import { ago } from "../lib/format";

/**
 * HAIC H3d (docs/design/HAIC-H3.md §6.1; owner 2026-11-19, "Setuju semua rekomendasi"): the teaching record, the
 * owner-judgement side of reputation, from GET /v1/reputation. Per subject and window (7 and 30 days): the shrunk score
 * (up_w + 5) / (up_w + down_w + 10) over the owner's newest correction per target, how many were counted, the weights
 * up and down and the categories. Measured data only: a subject or window with nothing counted shows "—", never 0.5.
 * Context only: it gates nothing (no vote, no seat, no autonomy level).
 */

const arr = (v: unknown): any[] => (Array.isArray(v) ? v : []);
/** The record of one subject in a GET /v1/reputation answer, or null when it has none. */
export const teachingOf = (rep: any, subject: string): any | null => arr(rep?.subjects).find((s: any) => s?.subject === subject) ?? null;
/** A window's score at two decimals, or "—" when nothing was counted (or nothing was read). */
export const scoreText = (w: any): string => (typeof w?.score === "number" ? w.score.toFixed(2) : "—");
/** A chat model id as its correction subject (ai-kernel/src/corrections.ts modelSubject): its last path segment. */
export const modelSubjectOf = (model: unknown): string | null => {
  if (typeof model !== "string" || !model) return null;
  const last = (model.split("/").pop() ?? "").replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 100);
  return last ? `model:${last}` : null;
};
const categories = (w: any) => Object.entries(w?.by_category ?? {}).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(" · ");

/** One line: "0.62 · n 4 (30 d) · 7 d —". */
export function TeachingLine({ record }: { record: any | null }) {
  const w30 = record?.windows?.["30d"], w7 = record?.windows?.["7d"];
  return (
    <span className="mono" title="The owner's teaching record: (up + 5) / (up + down + 10) over the newest correction per target; context only">
      {scoreText(w30)}{typeof w30?.n === "number" && w30.n > 0 ? ` · n ${w30.n}` : ""} (30 d) · 7 d {scoreText(w7)}
    </span>
  );
}

/** The record of one subject (agent detail, Ask): both windows, or "—" with the reason. */
export function TeachingPanel({ subject, rep, loading, error }: { subject: string | null; rep: any; loading?: boolean; error?: string | null }) {
  const record = subject ? teachingOf(rep, subject) : null;
  return (
    <Panel title="Teaching record · owner judgements" icon={<GraduationCap className="h-3.5 w-3.5 text-emerald-300" />}
      right={<Badge tone="slate">context only · gates nothing</Badge>}>
      {loading && !rep ? <Skeleton rows={2} /> : (
        <div className="space-y-2 text-[12px]">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {(["30d", "7d"] as const).map((id) => {
              const w = record?.windows?.[id];
              return <Stat key={id} label={`score ${id === "30d" ? "30 d" : "7 d"}`} value={scoreText(w)}
                sub={w && w.n > 0 ? `n ${w.n} · up ${w.up_w} · down ${w.down_w}` : "—"} />;
            })}
            <Stat label="last correction" value={record?.windows?.["30d"]?.last_at ? ago(record.windows["30d"].last_at) : "—"} />
            <Stat label="subject" value={<span className="mono text-[11px]">{subject ?? "—"}</span>} />
          </div>
          {record && categories(record.windows?.["30d"]) && <p className="text-[11px] text-slate-400">Categories (30 d): {categories(record.windows["30d"])}</p>}
          <p className="text-[10px] text-slate-500">{error && !rep ? `The teaching record is not available: ${error}` : record ? "The owner's ratings and corrections, newest per target, each weighted by its correction weight, shrunk toward the middle with a prior of 10." : "— No correction of this subject in the last 30 days."}</p>
        </div>
      )}
    </Panel>
  );
}

const COLUMNS: Column<any>[] = [
  { key: "subject", header: "subject", sort: (s) => s.subject, cell: (s) => /^agent:/.test(s.subject)
    ? <a href={`#/agents/${s.subject.slice(6)}`} className="mono text-[11px] text-cyan-200 hover:underline">{s.subject}</a> : <span className="mono text-[11px] text-slate-200">{s.subject}</span> },
  { key: "s30", header: "score 30 d", align: "right", sort: (s) => s.windows?.["30d"]?.score ?? -1, cell: (s) => <span className="mono">{scoreText(s.windows?.["30d"])}</span> },
  { key: "n30", header: "n 30 d", align: "right", sort: (s) => s.windows?.["30d"]?.n ?? -1, cell: (s) => <span className="mono">{s.windows?.["30d"]?.n ?? "—"}</span> },
  { key: "s7", header: "score 7 d", align: "right", sort: (s) => s.windows?.["7d"]?.score ?? -1, cell: (s) => <span className="mono">{scoreText(s.windows?.["7d"])}</span> },
  { key: "cats", header: "categories 30 d", className: "wrap", cell: (s) => <span className="text-[11px] text-slate-400">{categories(s.windows?.["30d"]) || "—"}</span> },
  { key: "last", header: "last", sort: (s) => Date.parse(s.windows?.["30d"]?.last_at ?? "") || 0, cell: (s) => <span className="text-slate-500" title={s.windows?.["30d"]?.last_at ?? ""}>{s.windows?.["30d"]?.last_at ? ago(s.windows["30d"].last_at) : "—"}</span> },
];

/** Every subject's record (Agents page). */
export function TeachingTable({ rep, loading, error }: { rep: any; loading?: boolean; error?: string | null }) {
  const subjects = arr(rep?.subjects);
  return (
    <Panel title="Teaching record · owner judgements" icon={<GraduationCap className="h-3.5 w-3.5 text-emerald-300" />}
      right={<Badge tone="slate">{rep ? `${subjects.length} subject${subjects.length === 1 ? "" : "s"} · context only` : "—"}</Badge>}>
      {loading && !rep ? <Skeleton rows={3} /> : !rep ? <Empty>{error ? `The teaching record is not available: ${error}` : "—"}</Empty> : (
        <DataTable rows={subjects} columns={COLUMNS} rowKey={(s) => s.subject} initialSort={{ key: "s30", dir: "asc" }} maxHeight={320} dense
          empty="— No correction in the last 30 days: no teaching record yet." />
      )}
      <p className="mt-2 text-[10px] text-slate-500">Score = (up + 5) / (up + down + 10) over the owner's newest rating or correction per target, each by its weight (3 for the owner), in metric form; a reject reason is not scored. It gates nothing: no vote, no council seat, no autonomy level.</p>
    </Panel>
  );
}
