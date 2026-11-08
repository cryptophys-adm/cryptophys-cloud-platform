import type { EsbuildLike, ShimSources } from "./core.ts";
export declare const esbuild: EsbuildLike & { initialize(options: { wasmModule: WebAssembly.Module; worker: boolean }): Promise<void> };
export declare const esbuildWasm: WebAssembly.Module;
export declare const sqlWasm: WebAssembly.Module;
export declare const sqlWasmJs: string;
export declare const shims: ShimSources;
