/// <reference path="../../control-plane-shared/src/cloudflare-workers.d.ts" />
// Runtime entry point: the Access-gated HTTP API, the RPC health entrypoint for the Drift Detector,
// and the Forge checks (ADR-0012 phase 3): a cron tick and the bundler the test Workers call back.
import { WorkerEntrypoint } from "cloudflare:workers";
import worker, { REPO, type Env } from "./index.ts";
import { healthBody, type HealthBody } from "../../control-plane-shared/src/http.ts";
import { cachedSnapshot, snapshotFromArtifacts } from "./checks.ts";
import { forgeTick } from "./tick.ts";
import { canonicalMainHead } from "./census.ts";
import { bundleWorkerDir, type WorkerBundle } from "./runner/core.ts";
import { suiteDeps, toolchain, type WorkerLoader } from "./runner/runtime.ts";
import { typecheckStep } from "./typecheck.ts";
import { WORK_REPO } from "./work-repo.ts";

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
    console.log(JSON.stringify({ event: "forge.tick", ...(await forgeTick(env, REPO, deps)) }));
  },
};

export class HealthRpc extends WorkerEntrypoint<Env> {
  async health(): Promise<HealthBody> {
    return healthBody(this.env as never);
  }
}

/**
 * The head of canonical main, read from Artifacts at call time (ADR-0013 §3, #262). The AI Kernel's
 * registration executors call it right before they write, so a census of an older head can never
 * authorize a registration after main has moved. Read only; no input.
 */
export class CanonicalMainRpc extends WorkerEntrypoint<Env> {
  async mainHead(): Promise<{ main_sha: string | null }> {
    if (!this.env.ARTIFACTS) return { main_sha: null };
    const repo = await this.env.ARTIFACTS.get(REPO);
    try { return { main_sha: await canonicalMainHead(repo as never) }; } finally { repo[Symbol.dispose]?.(); }
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
      // A change request head pushed to the work repository (G4) is not in platform: read it from platform-work.
      for (const name of [REPO, WORK_REPO]) {
        const repo = await this.env.ARTIFACTS.get(name);
        try {
          if (name === WORK_REPO || await repo.readCommit(commit)) { snapshot = (await snapshotFromArtifacts(repo, commit)).snapshot; break; }
        } finally { repo[Symbol.dispose]?.(); }
      }
      if (!snapshot) throw new Error("commit_not_found");
    }
    const { esbuild } = await toolchain();
    return bundleWorkerDir(esbuild, snapshot, dir);
  }
}
