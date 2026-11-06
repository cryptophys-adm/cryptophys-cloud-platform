import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Console Worker serves dist/ as Workers Static Assets behind its Access and operator
// checks. CSP is `script-src 'self'; style-src 'self'`, so the build emits only external
// module scripts and stylesheets: no inline script, no modulepreload polyfill.
export default defineConfig({
  plugins: [react()],
  // ADR-0010: relative asset URLs, so the same build works at nexus.cryptophys.work/console/ and at / on workers.dev.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    modulePreload: { polyfill: false },
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
  },
});
