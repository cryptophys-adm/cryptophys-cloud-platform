export type SummaryValue = string | number;
export interface HomeSummary {
  agents: string;
  drift: number | "unknown";
  driftIds: string[] | "unknown";
  critical: number | "unknown";
  warning: number | "unknown";
  info: number | "unknown";
  latestCritical: number | "unknown";
  plans: number | "unknown";
  xauusd: {
    decision: SummaryValue;
    confidence: SummaryValue;
    candle_key: SummaryValue;
    decided_at: SummaryValue;
  };
}

/** Pure formatter for the wrapped Platform API overview response. */
export function summarize(body: any): HomeSummary {
  const isRecord = (value: any): value is Record<string, any> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  const wrapper = isRecord(body) ? body : {};
  const overview = isRecord(wrapper.overview) ? wrapper.overview : wrapper;
  const displayValue = (value: any): SummaryValue =>
    typeof value === "string" && value.length > 0
      ? value
      : typeof value === "number" && Number.isFinite(value)
        ? value
        : "unknown";
  const countValue = (value: any): number | "unknown" =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : "unknown";

  const services = Array.isArray(overview.services) ? overview.services : null;
  const drifted = services ? services.filter((service: any) => isRecord(service) && service.drifted === true) : null;
  const reports = isRecord(overview.agent_reports_24h) ? overview.agent_reports_24h : {};
  const counts = isRecord(reports.counts) ? reports.counts : {};
  const plans = Array.isArray(overview.open_agent_plans) ? overview.open_agent_plans.length : "unknown";
  const latestCritical = Array.isArray(reports.latest_critical) ? reports.latest_critical.length : "unknown";

  let xauusd: HomeSummary["xauusd"] = {
    decision: "unknown",
    confidence: "unknown",
    candle_key: "unknown",
    decided_at: "unknown",
  };
  if (Object.prototype.hasOwnProperty.call(overview, "xauusd_latest")) {
    const latest = overview.xauusd_latest;
    if (latest === null) {
      xauusd = { decision: "none", confidence: "none", candle_key: "none", decided_at: "none" };
    } else if (isRecord(latest) && latest.error) {
      xauusd = { decision: "unavailable", confidence: "unavailable", candle_key: "unavailable", decided_at: "unavailable" };
    } else if (isRecord(latest)) {
      xauusd = {
        decision: displayValue(latest.decision),
        confidence: displayValue(latest.confidence),
        candle_key: displayValue(latest.candle_key),
        decided_at: displayValue(latest.decided_at),
      };
    }
  }

  return {
    agents: typeof overview.agents_enabled === "boolean"
      ? (overview.agents_enabled ? "running" : "stopped (kill switch)")
      : "unknown",
    drift: services ? drifted!.length : "unknown",
    driftIds: services
      ? drifted!.map((service: any) => (typeof service.service_id === "string" && service.service_id.length > 0 ? service.service_id : "unknown") + (service.persistent === true ? " (persistent)" : ""))
      : "unknown",
    critical: countValue(counts.critical),
    warning: countValue(counts.warning),
    info: countValue(counts.info),
    latestCritical,
    plans,
    xauusd,
  };
}
