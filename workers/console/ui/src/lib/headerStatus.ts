// The Console header's status cells (frontend mockup 2026-11-22, approved by the owner; ported from Nexus
// headerStatus.ts). Every cell is read from the overview the Console already loads; a value the API did not send is
// "off" with "—", never a default (AGENTS.md: measured data only). Tones: cyan ok, amber late, red fault, grey off;
// green stays for bullish only, so the header never uses it.
/** The overview fields the header reads (a structural subset of lib/overview.tsx's Overview, kept free of JSX). */
export interface Overview {
  observed_at?: string;
  agents_enabled?: boolean;
  services?: { service_id: string; drifted: boolean; persistent?: boolean }[];
  open_agent_plans?: { plan_id: string }[];
  agent_reports_24h?: { latest_critical?: { report_id: string }[] };
}

export type Tone = "ok" | "late" | "fault" | "off";
export interface Cell { label: string; code: string; detail: string | null; tone: Tone; title: string; href: string }

/** An observation older than this is late, older than OBSERVED_FAULT_MS a fault (the Drift Detector runs every 15 min). */
export const OBSERVED_LATE_MS = 20 * 60_000;
export const OBSERVED_FAULT_MS = 60 * 60_000;

const off = (label: string, href: string, title: string): Cell => ({ label, code: "—", detail: null, tone: "off", title, href });

export function meshCell(ov: Overview | null): Cell {
  if (ov?.agents_enabled === undefined) return off("Mesh", "#/", "Agent state not reported");
  return ov.agents_enabled
    ? { label: "Mesh", code: "LIVE", detail: null, tone: "ok", title: "Agents enabled", href: "#/" }
    : { label: "Mesh", code: "HALTED", detail: null, tone: "fault", title: "Kill switch engaged: all agents stopped", href: "#/" };
}

export function attentionCell(ov: Overview | null): Cell {
  const critical = ov?.agent_reports_24h?.latest_critical;
  const plans = ov?.open_agent_plans;
  if (!critical || !plans) return off("Owner", "#/owner", "Open items not reported");
  if (critical.length) return { label: "Owner", code: String(critical.length), detail: "critical", tone: "fault", title: `${critical.length} critical report(s) in 24 h`, href: "#/owner" };
  if (plans.length) return { label: "Owner", code: String(plans.length), detail: "waiting", tone: "late", title: `${plans.length} plan(s) waiting for approval`, href: "#/owner" };
  return { label: "Owner", code: "CLEAR", detail: null, tone: "ok", title: "Nothing waits for a person", href: "#/owner" };
}

export function driftCell(ov: Overview | null): Cell {
  const services = ov?.services;
  if (!services) return off("Drift", "#/infrastructure", "Services not reported");
  const drifted = services.filter((s) => s.drifted);
  if (!drifted.length) return { label: "Drift", code: "IN SYNC", detail: null, tone: "ok", title: `${services.length} services in sync`, href: "#/infrastructure" };
  const persistent = drifted.some((s) => s.persistent);
  return { label: "Drift", code: String(drifted.length), detail: persistent ? "persistent" : null, tone: persistent ? "fault" : "late", title: drifted.map((s) => s.service_id).join(", "), href: "#/infrastructure" };
}

export function observedCell(ov: Overview | null, now: number): Cell {
  const at = ov?.observed_at ? Date.parse(ov.observed_at) : Number.NaN;
  if (!Number.isFinite(at)) return off("Observed", "#/infrastructure", "No observation reported");
  const age = Math.max(0, now - at);
  const minutes = Math.round(age / 60_000);
  const tone: Tone = age > OBSERVED_FAULT_MS ? "fault" : age > OBSERVED_LATE_MS ? "late" : "ok";
  return { label: "Observed", code: `${minutes}m`, detail: "ago", tone, title: `Last observation ${ov!.observed_at}`, href: "#/infrastructure" };
}

const p2 = (n: number) => String(n).padStart(2, "0");

/** The clock: UTC with seconds, local hours and minutes, and the local offset (as Nexus). */
export function clockParts(now: Date) {
  const offset = -now.getTimezoneOffset();
  const abs = Math.abs(offset);
  const zone = offset === 0 ? "local" : `GMT${offset > 0 ? "+" : "-"}${Math.floor(abs / 60)}${abs % 60 ? `:${p2(abs % 60)}` : ""}`;
  return {
    utc: `${p2(now.getUTCHours())}:${p2(now.getUTCMinutes())}:${p2(now.getUTCSeconds())}`,
    utcShort: `${p2(now.getUTCHours())}:${p2(now.getUTCMinutes())}`,
    local: `${p2(now.getHours())}:${p2(now.getMinutes())}`,
    zone,
  };
}
