// 2026-11-13: the native control-plane deploy at fb511a0 failed with not_live_at_tag at the Drift Detector,
// because the Orchestrator verifies every Worker through DRIFT.probeService and the detector is not one of its
// own targets. It now answers for itself from its version metadata, as observe() does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeService } from "../../drift-detector/src/index.ts";

test("DS1. the Drift Detector probes itself from its version metadata; unknown services still throw", async () => {
  const env = { CF_VERSION_METADATA: { id: "ver-new", tag: "fb511a098683" } } as never;
  assert.deepEqual(await probeService(env, "cryptophys-drift-detector"),
    { reachable: true, healthy: true, version_tag: "fb511a098683", error: null });
  assert.deepEqual(await probeService({} as never, "cryptophys-drift-detector"),
    { reachable: true, healthy: true, version_tag: null, error: null }, "no metadata: no tag, so the deploy check still fails closed");
  await assert.rejects(probeService(env, "cryptophys-nope"), /unknown_service/);
});
