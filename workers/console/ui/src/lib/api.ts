// Every API call goes through call(), built from the TP-024 route table that the tests prove
// equals the Console Worker's allow-list. No other path to /api exists besides /api/whoami.
import { UI_ROUTES, type UiRoute } from "../../../src/ui/routes.ts";

export type Json = any;
export const ROUTES: Record<string, UiRoute> = Object.fromEntries(UI_ROUTES.map((r) => [r.id, r]));
const SAFE = /^[A-Za-z0-9._@+:-]{1,128}$/;

/** ADR-0010: on the Nexus host the Console is mounted at /console/; elsewhere (workers.dev) at /. */
export const MOUNT = typeof location !== "undefined" && location.pathname.startsWith("/console") ? "/console" : "";

export class ApiError extends Error {
  constructor(message: string, public status: number, public data: Json) { super(message); }
}

async function api(method: string, path: string, body?: unknown): Promise<Json> {
  const headers: Record<string, string> = { "x-cryptophys-console": "1" };
  const init: RequestInit = { method, headers, credentials: "same-origin" };
  if (body !== undefined) { headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const res = await fetch(path, init);
  let data: Json = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    let message = `${method} ${path}: ${res.status} ${data?.error ?? "error"}`;
    if (typeof data?.message === "string" && data.message) message += ` (${data.message})`;
    throw new ApiError(message, res.status, data);
  }
  return data;
}

export function whoami(): Promise<{ actor: string; type: string; operator: boolean; approver: boolean; role?: string; owner?: boolean; viewer?: boolean }> {
  return api("GET", `${MOUNT}/api/whoami`);
}

export function call(routeId: string, params?: string | string[], body?: unknown, query?: Record<string, string | undefined>): Promise<Json> {
  const route = ROUTES[routeId];
  if (!route) return Promise.reject(new Error(`Unknown route ${routeId}`));
  const values = params === undefined ? [] : Array.isArray(params) ? [...params] : [params];
  let bad = false;
  let path = route.path.replace(/[{]id[}]/g, () => {
    const v = values.shift();
    if (v === undefined || !SAFE.test(String(v))) { bad = true; return "x"; }
    return String(v);
  });
  if (bad || values.length) return Promise.reject(new Error(`Refused: ${routeId} needs safe identifiers (A-Z a-z 0-9 . _ @ + : -, up to 128).`));
  if (query && route.method === "GET") {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") sp.set(k, v);
    const qs = sp.toString();
    if (qs) path += `?${qs}`;
  }
  return api(route.method, `${MOUNT}/api/${route.service}${path}`, body);
}

/** The typed confirmation phrase of a route, from its UI_ROUTES template. */
export function phraseFor(routeId: string, params?: string | string[], body?: Json): string | null {
  const route = ROUTES[routeId];
  if (!route?.confirm) return null;
  const first = Array.isArray(params) ? params[0] : params;
  const id = first === undefined ? "" : String(first);
  const sha = typeof body?.commit_sha === "string" ? body.commit_sha : "";
  return route.confirm.split("{id13}").join(id.slice(0, 13)).split("{id}").join(id).split("{sha12}").join(sha.slice(0, 12));
}
