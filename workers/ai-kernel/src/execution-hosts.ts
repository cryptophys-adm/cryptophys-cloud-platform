/**
 * Execution hosts in the AI Mesh (owner 2026-11-12: "bagaimana kita juga ingin menampilkan remote vps atau
 * omega engine dengan EA nya bisa termonitor di Ai Mesh"). Omega, the owner's MT5 VPS bridge and its EA run
 * outside Cloudflare; the xauusd AI Worker records their heartbeats and serves them read-only through the RPC
 * entrypoint OmegaHealth (binding XAUUSD_OMEGA_HEALTH, schema omega-health.v1).
 *
 * Only known fields of the expected type are kept; anything else is null. Nothing is estimated: a host that
 * does not answer is "unreachable", and one whose binding is missing is "not_bound". No control and no
 * account figure passes through here.
 */
import type { JsonObject } from "../../control-plane-shared/src/http.ts";

export interface OmegaHealthBinding { health(): Promise<unknown> }

export const OMEGA_HEALTH_SCHEMA = "omega-health.v1";
export const EXECUTION_HOST_TIMEOUT_MS = 3_000;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);
const str = (v: unknown, n = 40): string | null => (typeof v === "string" && v ? v.slice(0, n) : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});

/** omega-health.v1 → the fields the mesh shows, each checked for its type. */
export function omegaHostFrom(raw: unknown): JsonObject | null {
  const h = obj(raw);
  if (h.schema !== OMEGA_HEALTH_SCHEMA) return null;
  const ea = obj(h.ea), bridge = obj(h.bridge), control = h.control == null ? null : obj(h.control);
  return {
    engine_enabled: bool(h.engine_enabled),
    ea: {
      seen: bool(ea.seen), connected: bool(ea.connected), heartbeat_age_ms: num(ea.heartbeat_age_ms), stale_after_ms: num(ea.stale_after_ms),
      version: str(ea.version), mode: str(ea.mode), trading_allowed: bool(ea.trading_allowed), open_positions: num(ea.open_positions),
      reported_control: str(ea.reported_control),
    },
    control: control ? { mode: str(control.mode, 16), set_ms: num(control.set_ms) } : null,
    bridge: {
      seen: bool(bridge.seen), connected: bool(bridge.connected), synced_age_ms: num(bridge.synced_age_ms), stale_after_ms: num(bridge.stale_after_ms),
      bridge_version: str(bridge.bridge_version), credentials_stored: bool(bridge.credentials_stored),
      terminal_connected: bool(bridge.terminal_connected), trade_allowed: bool(bridge.trade_allowed), terminal_state_age_ms: num(bridge.terminal_state_age_ms),
    },
  };
}

/** "online": EA and bridge both fresh; "degraded": one of them; "offline": neither. */
export function hostLiveness(h: JsonObject): "online" | "degraded" | "offline" {
  const ea = (h.ea ?? {}) as JsonObject, bridge = (h.bridge ?? {}) as JsonObject;
  const up = [ea.connected === true, bridge.connected === true].filter(Boolean).length;
  return up === 2 ? "online" : up === 1 ? "degraded" : "offline";
}

export async function executionHosts(
  env: { XAUUSD_OMEGA_HEALTH?: OmegaHealthBinding },
  now = Date.now(),
  timeoutMs = EXECUTION_HOST_TIMEOUT_MS,
): Promise<JsonObject[]> {
  const base = { host_id: "omega", name: "Omega · MT5 VPS bridge + EA", reported_by: "xauusd-ai-trading-assistant", observed_at: new Date(now).toISOString() };
  const binding = env.XAUUSD_OMEGA_HEALTH;
  if (typeof binding?.health !== "function") return [{ ...base, status: "not_bound", liveness: null, error: null, health: null }];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      binding.health(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); }),
    ]);
    const health = omegaHostFrom(raw);
    if (!health) return [{ ...base, status: "unreachable", liveness: null, error: "unexpected_schema", health: null }];
    return [{ ...base, status: "observed", liveness: hostLiveness(health), error: null, health }];
  } catch (e) {
    const error = e instanceof Error && e.message === "timeout" ? "timeout" : "rpc_failed";
    return [{ ...base, status: "unreachable", liveness: null, error, health: null }];
  } finally {
    if (timer) clearTimeout(timer);
  }
}
