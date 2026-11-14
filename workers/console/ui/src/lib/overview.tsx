import { createContext, useContext, type ReactNode } from "react";
import { call } from "./api";
import { usePoll } from "./usePoll";

export interface Overview {
  observed_at?: string;
  agents_enabled?: boolean;
  /** observed_at: when the current state was first seen; last_seen_at: when the Drift Detector last observed it (0061). */
  services?: { service_id: string; drifted: boolean; observed_at?: string; last_seen_at?: string; persistent?: boolean }[];
  open_agent_plans?: { plan_id: string; service_id?: string; status?: string; created_at?: string }[];
  agent_reports_24h?: {
    /** critical: open (not acknowledged) critical reports; critical_acknowledged: acknowledged by an approver (ADR-0009, 2026-11-13). */
    counts?: { critical?: number; warning?: number; info?: number; critical_acknowledged?: number };
    latest_attention?: { report_id: string; agent_id: string; kind: string; severity: string; subject: string; created_at: string }[];
    latest_critical?: { report_id: string; agent_id: string; kind: string; created_at: string }[];
    error?: string;
  };
  xauusd_latest?: { decision?: string; confidence?: number; candle_key?: string; decided_at?: string; reported_at?: string; error?: string } | null;
}

const Ctx = createContext<{ ov: Overview | null; error: string | null; loading: boolean; refresh: () => Promise<void> } | null>(null);
export const useOverview = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("no overview");
  return c;
};

/** One shared overview poll (60 s, only while visible) for the shell rails and Mission Control. */
export function OverviewProvider({ children }: { children: ReactNode }) {
  const { data, error, loading, refresh } = usePoll(async () => ((await call("platform.overview"))?.overview ?? null) as Overview | null, 60_000);
  return <Ctx.Provider value={{ ov: data, error, loading, refresh }}>{children}</Ctx.Provider>;
}

/** 0–100: drift, critical reports, kill switch and open proposals pull the score down. */
export function healthScore(ov: Overview | null): number | null {
  if (!ov || !Array.isArray(ov.services)) return null;
  const total = Math.max(ov.services.length, 1);
  const drifted = ov.services.filter((s) => s.drifted).length;
  const critical = ov.agent_reports_24h?.counts?.critical ?? 0;
  let s = 100 - Math.round((drifted / total) * 60) - Math.min(critical, 3) * 10;
  if (ov.agents_enabled === false) s -= 10;
  return Math.max(0, Math.min(100, s));
}
