/// <reference path="../../control-plane-shared/src/cloudflare-workers.d.ts" />
// Runtime entry point: the Access-gated HTTP API, the RPC health entrypoint for the Drift Detector,
// and the Forge checks (ADR-0012 phase 3): a cron tick and the bundler the test Workers call back.
import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { REPO, type Env } from "./index.ts";
import { healthBody, type HealthBody } from "../../control-plane-shared/src/http.ts";
import { cachedSnapshot, checksTick, snapshotFromArtifacts, tickWith } from "./checks.ts";
import { nextChangeHead } from "./changes.ts";
import { bundleWorkerDir, type WorkerBundle } from "./runner/core.ts";
import { suiteDeps, toolchain, type WorkerLoader } from "./runner/runtime.ts";
import { typecheckStep } from "./typecheck.ts";

type RunnerEnv = Env & { LOADER?: WorkerLoader };
interface RunnerCtx {
  exports?: { ForgeBundler?: (opts: { props: { commit: string } }) => unknown };
  props?: { commit?: string };
}

export default {
  fetch: worker.fetch,
  async scheduled(_controller: unknown, env: RunnerEnv, ctx: RunnerCtx): Promise<void> {
    const loader = env.LOADER;
    const bundler = ctx.exports?.ForgeBundler;
    const deps = loader && bundler ? async (commit: string) => ({ ...(await suiteDeps(loader, bundler({ props: { commit } }))), typecheck: (c: string) => typecheckStep(env.DB, c) }) : null;
    // Change request heads first (a merge waits on them), then the oldest unchecked commit of main.
    const started = Date.now();
    const change = await tickWith(env, REPO, deps, () => Date.now(), (repo) => nextChangeHead(env.DB, repo, Date.now()));
    console.log(JSON.stringify({ event: "forge.change_checks_tick", ...change }));
    if (change.outcome === "checked" && Date.now() - started > 120_000) return; // leave the main commit for the next tick
    const outcome = await checksTick(env, REPO, deps);
    console.log(JSON.stringify({ event: "forge.checks_tick", ...outcome }));
  },
};

export class HealthRpc extends WorkerEntrypoint<Env> {
  async health(): Promise<HealthBody> {
    return healthBody(this.env as never);
  }
}

/** Worker bundling for test Workers (TP-025): they have no esbuild, so they call back here. */
export class ForgeBundler extends WorkerEntrypoint<RunnerEnv> {
  async bundleWorker(dir: string): Promise<WorkerBundle> {
    if (typeof dir !== "string" || !/^[A-Za-z0-9_./-]{1,200}$/.test(dir) || dir.split("/").includes("..")) throw new Error("invalid_dir");
    const commit = (this.ctx as RunnerCtx).props?.commit ?? "";
    let snapshot = cachedSnapshot(commit);
    if (!snapshot) {
      if (!this.env.ARTIFACTS) throw new Error("artifacts_not_configured");
      const repo = await this.env.ARTIFACTS.get(REPO);
      try { snapshot = (await snapshotFromArtifacts(repo, commit)).snapshot; } finally { repo[Symbol.dispose]?.(); }
    }
    const { esbuild } = await toolchain();
    return bundleWorkerDir(esbuild, snapshot, dir);
  }
}
