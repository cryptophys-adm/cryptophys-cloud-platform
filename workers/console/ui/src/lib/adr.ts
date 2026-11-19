// The Vision page's ADR panel (docs/design/ADR-STEWARD.md §6, §11 row 5): its wording (§6.3, English since the owner's
// "all in english please", 2026-11-17) and the
// little arithmetic it does on GET /v1/adr and GET /v1/adr/{id}. Pure and without imports, so the Node tests read
// the same functions the Console runs (control-plane-shared/test/adr-panel-step5.test.ts).
//
// Measured data only (AGENTS.md; console-truthfulness.test.ts): every number, status and label comes from the API
// response. A value the response does not carry is "—", never a default number, a default status or a green mark.

/** The owner's title for the panel (2026-11-16; English since 2026-11-17, "all in english please"). */
export const ADR_PANEL_TITLE = "ADR — Architecture Decision Records";
/** §6.5: no push hub exists yet, so the panel polls at the ADR-0015 §3 floor; usePoll skips a hidden tab. */
export const ADR_POLL_MS = 300_000;
export const MISSING = "—";
export const ADR_VIEW_SCHEMA = "adr.progress-view.v1";
/** `#/vision/adr/<id>`: an ADR id is four digits, as the kernel's `GET /v1/adr/{id}` requires. */
export const ADR_ID = /^[0-9]{4}$/;

export type Tone = "green" | "amber" | "red" | "cyan" | "slate" | "purple";
export type PhaseMark = "proven" | "asserted" | "open";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
/** A value as the response states it, or "—". */
export const shown = (v: unknown): string => {
  const n = num(v);
  return n !== null ? String(n) : str(v) ?? MISSING;
};

/** "in progress (X of Y phases)": X is the phases complete (proven and asserted), only when both counts were served. */
function phaseCount(e: any): string | null {
  const total = num(e?.phases_total), proven = num(e?.phases_proven), asserted = num(e?.phases_asserted);
  return total !== null && total > 0 && proven !== null && asserted !== null ? `${proven + asserted} of ${total} phases` : null;
}

/** §6.3 status labels. A status the panel does not know is shown as served; a missing one is "—". */
export function statusLabel(e: any): string {
  const count = phaseCount(e);
  switch (e?.status) {
    case "not_started": return "not started";
    case "in_progress": return count ? `in progress (${count})` : "in progress";
    case "done": return "done";
    case "superseded": return str(e?.superseded_by) ? `superseded by ADR-${e.superseded_by}` : "superseded";
    case "held": return count ? `held (${count})` : "held";
    case "planned": return count ? `planned (${count})` : "planned";
    default: return str(e?.status) ?? MISSING;
  }
}

/** Green only for an ADR done by evidence alone; done by document is not shown as proven (§6.4). */
export function statusTone(e: any): Tone {
  switch (e?.status) {
    case "done": return num(e?.percent_proven) === 100 ? "green" : "cyan";
    case "in_progress": return "amber";
    case "held": return "purple";
    case "superseded": return "slate";
    default: return "slate";
  }
}

/** Held and planned ADRs are not on main yet (§1.4): their rows are drawn apart from the accepted ones. */
export const outsideMain = (e: any): boolean => e?.status === "held" || e?.status === "planned" || e?.lifecycle === "held" || e?.lifecycle === "planned";
/** The deferred badge, "deferred", only when the document says so. */
export const isDeferred = (e: any): boolean => e?.deferred === true;

/**
 * The two-segment bar (§6.4): the proven share solid, the asserted share hatched. Both from `percent_proven` and
 * `percent` as served; null (drawn as "—") when either is missing, or when the ADR has no phase to measure.
 */
export function progressSegments(e: any): { proven: number; asserted: number; percent: number } | null {
  const percent = num(e?.percent), proven = num(e?.percent_proven), total = num(e?.phases_total);
  if (percent === null || proven === null || total === null || total === 0) return null;
  const p = Math.min(100, Math.max(0, proven));
  const all = Math.min(100, Math.max(p, percent));
  return { proven: p, asserted: all - p, percent: all };
}

/** §6.3 phase labels; the two states the table does not name are said plainly, and are open, never complete. */
export const PHASE_LABEL: Record<string, string> = {
  proven: "proven",
  doc_asserted: "asserted by document",
  external_asserted: "asserted by external source",
  open: "open",
  not_measurable_yet: "not measurable yet",
  unknown: "unreadable",
};
export const phaseLabel = (state: unknown): string => (typeof state === "string" && PHASE_LABEL[state]) || shown(state);
export function phaseMark(state: unknown): PhaseMark {
  return state === "proven" ? "proven" : state === "doc_asserted" || state === "external_asserted" ? "asserted" : "open";
}
export const MARK: Record<PhaseMark, string> = { proven: "●", asserted: "◆", open: "○" };
export const MARK_LEGEND: readonly [PhaseMark, string][] = [["proven", "proven"], ["asserted", "asserted by document"], ["open", "open"]];

/** The Steward's state (adr-view.ts StewardStatus), in the panel's words. */
export const STEWARD_LABEL: Record<string, string> = {
  enabled: "active",
  suspended: "suspended",
  agents_disabled: "disabled (agent kill switch)",
  not_registered: "not registered",
};
export const stewardLabel = (status: unknown): string => (typeof status === "string" && STEWARD_LABEL[status]) || shown(status);
export const stewardTone = (status: unknown): Tone => (status === "enabled" ? "green" : status === "not_registered" ? "amber" : typeof status === "string" ? "red" : "slate");

/**
 * The Steward's AI explanations today against the daily cap (`steward.ai_today` of GET /v1/adr, design step 6), as
 * "2/6"; "—" when the kernel could not read the Steward's counter (either value null).
 */
export function aiTodayLabel(steward: any): string {
  const used = num(steward?.ai_today?.used), cap = num(steward?.ai_today?.cap);
  return used !== null && cap !== null ? `${used}/${cap}` : MISSING;
}

/** "2026-11-17 22:37 UTC", or "—". */
export function utcMinute(iso: unknown): string {
  const s = str(iso);
  if (!s || Number.isNaN(Date.parse(s))) return MISSING;
  return `${s.slice(0, 10)} ${s.slice(11, 16)} UTC`;
}

/** "Last change": the stored revision and when it was written. */
export function lastChange(e: any): string {
  const rev = num(e?.revision);
  return `${rev !== null ? `rev ${rev}` : MISSING} · ${utcMinute(e?.changed_at)}`;
}

/** §6.3 explanation source: the deterministic sentence is "automatic text", an AI one "explained by AI". */
export function explanationSource(x: any): string {
  return x?.source === "template" ? "automatic text" : x?.source === "ai" ? "explained by AI" : MISSING;
}

/** "stale data: <source> unreadable". */
export const staleLabel = (sources: unknown): string => {
  const list = Array.isArray(sources) ? sources.filter((s) => typeof s === "string" && s) : [];
  return `stale data: ${list.length ? list.join(", ") : "source"} unreadable`;
};
export const DRIFT_LABEL = "Document does not match evidence";

/** The pages an owner action may link to (adr-progress.ts OWNER_ACTION_HREFS), with §6.3's words. Nothing else is linked. */
export const OWNER_LINK: Record<string, string> = {
  "#/owner": "Open the Owner page",
  "#/consensus": "Open Consensus",
  "#/code": "Open the Code page",
  "#/users": "Open the Users page",
};
export const OWNER_WAITING = "Waiting for the owner's click";
export const OUTSIDE_PLATFORM = "outside the platform";
export function ownerLink(a: any): { href: string; label: string } | null {
  return typeof a?.href === "string" && OWNER_LINK[a.href] ? { href: a.href, label: OWNER_LINK[a.href] } : null;
}

/**
 * An evidence ref (`ev:platform/<source>/<id>…`, adr-evidence.ts evRef) and the Console page it lives on, where one
 * exists (§6.4: Code, Consensus, Ledger, Organism). Other refs are shown without a link.
 */
export function evidenceLink(ref: unknown): { text: string; href: string | null } | null {
  if (typeof ref !== "string") return null;
  const m = /^ev:platform\/([a-z0-9_.-]+)\/([^\s@#]+)/.exec(ref);
  if (!m) return { text: ref, href: null };
  const [, source, id] = m;
  const href = source === "consensus" ? "#/consensus" : source === "audit" ? "#/ledger" : source.startsWith("forge.") ? "#/code" : source.startsWith("observer.") ? "#/organism" : null;
  return { text: `ev:${source}/${id.length > 14 ? `${id.slice(0, 12)}…` : id}`, href };
}

/** `#/vision/adr/<id>`: the ADR to open, or null for anything that is not four digits. */
export const openAdrId = (section: string | undefined, item: string | undefined): string | null =>
  section === "adr" && typeof item === "string" && ADR_ID.test(item) ? item : null;
