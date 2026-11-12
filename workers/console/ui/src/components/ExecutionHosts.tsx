import { Server } from "lucide-react";
import { Badge, Empty, Panel, Skeleton } from "./ui";
import { Stat } from "./viz";
import { fmt } from "../lib/format";

/**
 * Execution hosts outside Cloudflare (owner 2026-11-12: "remote vps atau omega engine dengan EA nya bisa
 * termonitor di Ai Mesh"). GET /v1/mesh → execution_hosts, read by the kernel from the xauusd AI Worker's
 * OmegaHealth entrypoint. Read-only: no control here (Omega's own page holds them). A value nobody measured
 * shows "—".
 */
const age = (ms: unknown): string => {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const s = Math.round(ms / 1000);
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 172800 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const yesNo = (v: unknown): string => (v === true ? "yes" : v === false ? "no" : "—");
const LIVE_TONE: Record<string, "green" | "amber" | "red"> = { online: "green", degraded: "amber", offline: "red" };
const STATUS_TEXT: Record<string, string> = {
  not_bound: "The kernel has no XAUUSD_OMEGA_HEALTH binding yet.",
  unreachable: "The xauusd AI Worker did not answer",
};

export default function ExecutionHosts({ hosts, loading }: { hosts: any[]; loading: boolean }) {
  return (
    <Panel title="Execution hosts · outside Cloudflare" icon={<Server className="h-3.5 w-3.5 text-amber-300" />}
      right={<Badge tone="slate">read-only</Badge>}>
      {loading && !hosts.length ? <Skeleton rows={3} /> : !hosts.length ? <Empty>The kernel does not report execution hosts yet.</Empty> : (
        <div className="flex flex-col gap-3">
          {hosts.map((h) => {
            const ea = h.health?.ea ?? {}, bridge = h.health?.bridge ?? {}, control = h.health?.control ?? null;
            return (
              <div key={h.host_id} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2 text-[12px] text-slate-200">
                  <span className="font-semibold">{fmt(h.name)}</span>
                  {h.status === "observed"
                    ? <Badge tone={LIVE_TONE[h.liveness] ?? "slate"}>{fmt(h.liveness)}</Badge>
                    : <Badge tone="slate">{fmt(h.status)}</Badge>}
                  {control?.mode && <Badge tone={control.mode === "active" ? "green" : control.mode === "paused" ? "amber" : "red"}>control {control.mode}</Badge>}
                  {h.health && <Badge tone={h.health.engine_enabled ? "cyan" : "slate"}>engine {h.health.engine_enabled ? "on" : "off"}</Badge>}
                  <span className="text-[10px] text-slate-500">reported by {fmt(h.reported_by)}</span>
                </div>
                {h.status !== "observed" ? (
                  <Empty>{STATUS_TEXT[h.status] ?? fmt(h.status)}{h.error ? ` (${h.error})` : ""}.</Empty>
                ) : (
                  <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                    <Stat label="EA heartbeat" value={age(ea.heartbeat_age_ms)} tone={ea.connected ? "good" : ea.seen ? "critical" : "neutral"}
                      sub={`${ea.connected ? "fresh" : ea.seen ? "stale" : "never seen"} · stale after ${age(ea.stale_after_ms).replace(" ago", "")}`} />
                    <Stat label="EA" value={fmt(ea.version)} sub={`mode ${fmt(ea.mode)} · trading allowed ${yesNo(ea.trading_allowed)} · positions ${fmt(ea.open_positions)}`} />
                    <Stat label="VPS bridge sync" value={age(bridge.synced_age_ms)} tone={bridge.connected ? "good" : bridge.seen ? "critical" : "neutral"}
                      sub={`${bridge.connected ? "fresh" : bridge.seen ? "stale" : "never seen"} · bridge ${fmt(bridge.bridge_version)}`} />
                    <Stat label="MT5 terminal" value={yesNo(bridge.terminal_connected)}
                      sub={`trade allowed ${yesNo(bridge.trade_allowed)} · state ${age(bridge.terminal_state_age_ms)} · credentials ${yesNo(bridge.credentials_stored)}`} />
                  </div>
                )}
              </div>
            );
          })}
          <p className="text-[10px] text-slate-500">Heartbeats are recorded by the xauusd AI Worker when the EA and the bridge call in; nothing here is estimated. Controls stay on Omega's own page.</p>
        </div>
      )}
    </Panel>
  );
}
