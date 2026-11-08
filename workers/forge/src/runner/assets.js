// The runner toolchain the Forge Worker ships (ADR-0012 phase 3). Imported only by worker.ts, so the
// Node test suite never loads it. wrangler.toml imports the shims and the sql.js glue as Text.
export * as esbuild from "../../../control-plane-shared/node_modules/esbuild-wasm/esm/browser.js";
export { default as esbuildWasm } from "../../../control-plane-shared/node_modules/esbuild-wasm/esbuild.wasm";
export { default as sqlWasm } from "../../../control-plane-shared/node_modules/sql.js/dist/sql-wasm.wasm";
export { default as sqlWasmJs } from "../../../control-plane-shared/node_modules/sql.js/dist/sql-wasm.js";
import test from "./shims/node-test.js";
import sqlite from "./shims/node-sqlite.js";
import fs from "./shims/node-fs.js";
import os from "./shims/node-os.js";
import childProcess from "./shims/node-child_process.js";
export const shims = { test, sqlite, fs, os, child_process: childProcess };
