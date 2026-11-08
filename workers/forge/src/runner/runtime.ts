// Wires the runner core to the Workers runtime: esbuild-wasm, sql.js and the Worker Loader.
// Shared by the Forge Worker (worker.ts) and the local harness (tools/forge-runner).
import * as assets from "./assets.js";
import { bundleSqlJs, type EsbuildLike, type SuiteDeps, type TestWorkerCode } from "./core.ts";

export interface WorkerLoader {
  load(code: TestWorkerCode & { limits?: { cpuMs?: number } }): { getEntrypoint(): { fetch(input: string): Promise<Response> } };
}

/** CPU allowed to one test Worker (a group of up to 8 test files). */
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
    async runWorker(code) {
      const worker = loader.load({ ...code, limits: { cpuMs: TEST_WORKER_CPU_MS } });
      const res = await worker.getEntrypoint().fetch("http://forge-runner/");
      if (!res.ok) throw new Error(`test Worker answered ${res.status}`);
      return await res.json();
    },
  };
}
