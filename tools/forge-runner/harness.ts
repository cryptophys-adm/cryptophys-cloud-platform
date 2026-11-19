// Local harness for the Forge checks (ADR-0012 phase 3): the Forge's own checks code, run in local
// workerd by run.mjs. The only stand-in is the Artifacts repo, which run.mjs builds from the
// working tree (repo.json.txt). Bundling, the Dynamic Workers and the bundler callback are real.
import { checkCommit, type ArtifactsReader, type ArtifactsTreeEntry } from "../../workers/forge/src/checks.ts";
import { suiteDeps, type WorkerLoader } from "../../workers/forge/src/runner/runtime.ts";
// @ts-expect-error text module supplied by run.mjs
import dumpText from "./repo.json.txt";
export { ForgeBundler } from "../../workers/forge/src/worker.ts";

interface Dump { head: string; commits: Record<string, { hash: string; treeHash: string }>; trees: Record<string, ArtifactsTreeEntry[]>; blobs: Record<string, string> }

function fakeRepo(dump: Dump): ArtifactsReader {
  return {
    async readCommit(hash) { return dump.commits[hash] ?? null; },
    async readTree(hash) { return dump.trees[hash] ?? null; },
    async readBlob(hash) { return hash in dump.blobs ? new Blob([dump.blobs[hash]]) : null; },
    async log() { return [{ hash: dump.head }]; },
  };
}

export default {
  async fetch(request: Request, env: { LOADER: WorkerLoader }, ctx: { exports: { ForgeBundler(o: { props: Record<string, never> }): unknown } }): Promise<Response> {
    const dump = JSON.parse(dumpText as string) as Dump;
    const url = new URL(request.url);
    const only = url.searchParams.get("only");
    // The real Worker Loader, counting how often it had to build a Worker (no warm one with that id).
    const cold: number[] = [];
    let built = 0;
    const loader: WorkerLoader = { get: (id, getCode) => env.LOADER.get(id, async () => { built++; return getCode(); }) };
    // ?runs=2 runs the same commit again: every test runs again, on the Workers the first run left warm.
    const runs = Math.min(Math.max(Number(url.searchParams.get("runs") ?? 1) || 1, 1), 3);
    let run;
    for (let i = 0; i < runs; i++) {
      const before = built;
      run = await checkCommit(fakeRepo(dump), dump.head, () => suiteDeps(loader, ctx.exports.ForgeBundler({ props: {} })), Date.now,
        only ? ["workers/control-plane-shared/test/" + only] : undefined);
      cold.push(built - before);
      if (run.status !== "passed") break;
    }
    return Response.json({ ...run, cold });
  },
};
