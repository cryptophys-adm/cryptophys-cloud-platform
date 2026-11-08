// ADR-0012 §5c: the type-check. The compiler needs about 190 MB for this repository and a Workers
// isolate has 128 MB, so it runs in a Cloudflare Container (owner decision 2026-11-08: Containers
// for the type-check only). The Container (../typecheck) has no internet; the Forge sends it the
// commit's files under workers/ and it runs `tsc --noEmit -p workers/control-plane-tsconfig.json`
// with the compiler versions locked in workers/control-plane-shared/package-lock.json.
import type { Snapshot } from "./runner/core.ts";

export const TYPECHECK_CONFIG = "workers/control-plane-tsconfig.json";
/** The tsconfig's typeRoots parent: the Container links its locked packages here. */
export const TYPECHECK_MODULES = "workers/control-plane-shared/node_modules";
export const TYPECHECK_LOCKFILE = "workers/control-plane-shared/package-lock.json";
export const TYPECHECK_PORT = 8080;
const TOOLCHAIN_PACKAGES = ["typescript", "@types/node"] as const;
const MAX_DIAGNOSTICS_STORED = 50;
const START_ATTEMPTS = 120;
const START_WAIT_MS = 500;

export type Toolchain = Record<(typeof TOOLCHAIN_PACKAGES)[number], string>;
export interface TypecheckStep {
  status: "passed" | "failed" | "error" | "not_configured";
  files?: number; errors?: number; diagnostics?: string[]; ms?: number;
  toolchain?: Toolchain; locked?: Toolchain; reason?: string;
}
/** Sends one type-check request to the Container (worker.ts) or a stand-in (tests). */
export type TypecheckCall = (body: { files: Snapshot; config: string; modules: string }) => Promise<Response>;

/** The compiler versions the commit's lockfile pins, the ones GitHub CI's `npm ci` installs. */
export function lockedToolchain(snapshot: Snapshot): Toolchain | null {
  try {
    const lock = JSON.parse(snapshot[TYPECHECK_LOCKFILE] ?? "null") as { packages?: Record<string, { version?: string }> } | null;
    const out: Partial<Toolchain> = {};
    for (const name of TOOLCHAIN_PACKAGES) {
      const v = lock?.packages?.[`node_modules/${name}`]?.version;
      if (typeof v !== "string" || !v) return null;
      out[name] = v;
    }
    return out as Toolchain;
  } catch { return null; }
}

/** The files the compiler may read: everything of the commit under workers/. */
export function typecheckFiles(snapshot: Snapshot): Snapshot {
  return Object.fromEntries(Object.entries(snapshot).filter(([p]) => p.startsWith("workers/")));
}

/**
 * Type-check one commit. A type error is a result ("failed"). A Container that cannot answer, or a
 * compiler that is not the locked one, is "error": recorded, never counted as a pass.
 */
export async function runTypecheck(call: TypecheckCall | undefined, snapshot: Snapshot): Promise<TypecheckStep> {
  if (!call) return { status: "not_configured" };
  const locked = lockedToolchain(snapshot);
  if (!locked) return { status: "error", reason: "lockfile_missing" };
  if (!snapshot[TYPECHECK_CONFIG]) return { status: "error", reason: "tsconfig_missing" };
  try {
    const res = await call({ files: typecheckFiles(snapshot), config: TYPECHECK_CONFIG, modules: TYPECHECK_MODULES });
    const body = await res.json().catch(() => null) as { toolchain?: Toolchain; files?: number; errors?: number; diagnostics?: string[]; ms?: number; error?: string } | null;
    if (!res.ok || !body) return { status: "error", reason: `container_${res.status}${body?.error ? `: ${String(body.error).slice(0, 200)}` : ""}`, locked };
    const toolchain = body.toolchain;
    if (!toolchain || TOOLCHAIN_PACKAGES.some((n) => toolchain[n] !== locked[n])) return { status: "error", reason: "toolchain_mismatch", toolchain, locked };
    const errors = Number(body.errors);
    if (!Number.isInteger(errors) || errors < 0) return { status: "error", reason: "invalid_response", locked };
    return {
      status: errors === 0 ? "passed" : "failed", files: Number(body.files) || 0, errors,
      diagnostics: (Array.isArray(body.diagnostics) ? body.diagnostics : []).slice(0, MAX_DIAGNOSTICS_STORED).map((d) => String(d).slice(0, 600)),
      ms: Number(body.ms) || 0, toolchain, locked,
    };
  } catch (e) {
    return { status: "error", reason: String((e as Error)?.message ?? e).slice(0, 200), locked };
  }
}

/** The part of `ctx.container` the type-check uses (Containers runtime API). */
export interface ContainerApi {
  running: boolean;
  start(opts?: { enableInternet?: boolean }): void;
  getTcpPort(port: number): { fetch(input: string, init?: RequestInit): Promise<Response> };
  destroy(reason?: unknown): Promise<void>;
}

/**
 * Behind the Durable Object (typecheck-container.ts): start the Container without internet, wait for
 * it, forward one check, and stop it, so an instance only runs for the length of a check.
 */
export async function forwardTypecheck(container: ContainerApi | undefined, request: Request, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<Response> {
  if (!container) return Response.json({ error: "container_unavailable" }, { status: 503 });
  if (request.method !== "POST" || new URL(request.url).pathname !== "/typecheck") return Response.json({ error: "not_found" }, { status: 404 });
  const body = await request.text();
  if (!container.running) container.start({ enableInternet: false });
  try {
    const port = container.getTcpPort(TYPECHECK_PORT);
    let up = false;
    for (let i = 0; i < START_ATTEMPTS && !up; i++) {
      try { up = (await port.fetch("http://container/health")).ok; } catch { /* not listening yet */ }
      if (!up) await wait(START_WAIT_MS);
    }
    if (!up) return Response.json({ error: "container_not_ready" }, { status: 503 });
    const res = await port.fetch("http://container/typecheck", { method: "POST", headers: { "content-type": "application/json" }, body });
    return new Response(await res.text(), { status: res.status, headers: { "content-type": "application/json" } });
  } finally {
    await container.destroy().catch(() => undefined);
  }
}
