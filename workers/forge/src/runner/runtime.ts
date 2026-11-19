// Wires the runner core to the Workers runtime: esbuild-wasm, sql.js and the Worker Loader.
// Shared by the Forge Worker (worker.ts) and the local harness (tools/forge-runner).
import * as assets from "./assets.js";
import { TEST_WORKER_ID_PREFIX, bundleSqlJs, type EsbuildLike, type SuiteDeps, type TestWorkerCode } from "./core.ts";

/**
 * The Worker Loader binding, as far as the Forge uses it. `get(id, getCode)` returns the Worker with that id,
 * calling `getCode` only when no warm instance of it exists; a Worker is billed once per unique id and code per
 * day. (`load(code)` makes a new Worker on every call; the Forge no longer uses it, 2026-11-14.)
 */
export interface WorkerLoader {
  get(id: string, getCode: () => Promise<TestWorkerCode>): { getEntrypoint(): { fetch(input: string, init?: RequestInit): Promise<Response> } };
}

/** CPU allowed to one request to a test Worker (a group of up to FILES_PER_WORKER test files). */
export const TEST_WORKER_CPU_MS = 60_000;

let ready: Promise<{ esbuild: EsbuildLike; sqlJs: string }> | null = null;

/** esbuild-wasm and the sql.js module, initialised once per isolate. */
export function toolchain(): Promise<{ esbuild: EsbuildLike; sqlJs: string }> {
  ready ??= (async () => {
    // Wrangler imports these as Text (wrangler.toml [[rules]]). Fail loudly if it ever stops.
    for (const [name, text] of Object.entries({ ...assets.shims, "sql-wasm.js": assets.sqlWasmJs })) {
      if (typeof text !== "string" || text.length === 0) throw new Error("runner_asset_not_text: " + name);
    }
    await assets.esbuild.initialize({ wasmModule: assets.esbuildWasm, worker: false });
    return { esbuild: assets.esbuild, sqlJs: await bundleSqlJs(assets.esbuild, assets.sqlWasmJs) };
  })();
  ready.catch(() => { ready = null; });
  return ready;
}

export async function suiteDeps(loader: WorkerLoader, bundler: unknown): Promise<SuiteDeps> {
  const { esbuild, sqlJs } = await toolchain();
  return {
    esbuild,
    shims: assets.shims,
    sqlJs,
    sqlWasm: assets.sqlWasm,
    bundler,
    limits: { cpuMs: TEST_WORKER_CPU_MS },
    async runWorker(code, request) {
      // The id is the hash of exactly this code (core.ts testWorkerId), so a warm Worker of the same id runs the same code.
      if (code.globalOutbound !== null || code.limits?.cpuMs !== TEST_WORKER_CPU_MS) throw new Error("test_worker_unconfined");
      if (!request.id.startsWith(TEST_WORKER_ID_PREFIX)) throw new Error("test_worker_id_invalid");
      const worker = loader.get(request.id, async () => code);
      const res = await worker.getEntrypoint().fetch("http://forge-runner/", { method: "POST", headers: { "content-type": "application/json" }, body: request.body });
      if (!res.ok) throw new Error(`test Worker answered ${res.status}`);
      return await res.json();
    },
  };
}
