/**
 * The ADR Steward's evidence read (docs/design/ADR-STEWARD.md §4.2, §4.4 step 4; owner 2026-11-16, "ya semua, sesuai
 * rekomendasimu"): the tier-0 syscall `adr.observe`. It evaluates the ADR progress manifests of this deploy against D1
 * with the step 2 evaluator (control-plane-shared/src/adr-evidence.ts) and returns each ADR's phases, status, counts,
 * blockers and next step. It writes nothing; the Steward (adr-steward.ts) decides what to store.
 *
 * What is bundled, as `organism/vision.json` is for the Vision page (vision-view.ts, ADR-0016 T0):
 *  - every `architecture/adr/progress/<NNNN>.json`, imported below, one import per file (CI checks the list equals the
 *    directory: test/adr-steward-step3.test.ts). A change to a manifest redeploys the Control Plane unit
 *    (deploy-units.ts ADR_PROGRESS_DIR), and the new version id makes the Steward run a full pass;
 *  - `organism/vision.json`, for the `vision_valid` reading and its document quote;
 *  - for the Markdown files the document predicates name (doc_asserted, doc_claim), the quotes the manifests anchor in
 *    them. test/adr-progress.test.ts AP5 proves on the same commit that each quote occurs verbatim in its file, so a
 *    quote bundled with its manifest reads exactly as the file of that commit would. The Markdown itself is not
 *    bundled: that needs a Text module rule in wrangler.toml, and the native deploy refuses a changed build rule
 *    (deployment-orchestrator/src/config-diff.ts build_rules_changed).
 * The handler takes only `now` and an optional list of ADR ids; a caller can never supply a predicate or a manifest.
 */
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import type { JsonObject } from "../../control-plane-shared/src/http.ts";
import { canonicalJson, sha256Hex } from "../../control-plane-shared/src/audit.ts";
import { evaluateAdrManifests } from "../../control-plane-shared/src/adr-evidence.ts";
import { ADR_ID, predicateLeaves, type AdrManifest } from "../../control-plane-shared/src/adr-progress.ts";
import { ADR_PROGRESS_DIR } from "../../control-plane-shared/src/deploy-units.ts";
import visionFile from "../../../organism/vision.json" with { type: "json" };
import m0001 from "../../../architecture/adr/progress/0001.json" with { type: "json" };
import m0002 from "../../../architecture/adr/progress/0002.json" with { type: "json" };
import m0003 from "../../../architecture/adr/progress/0003.json" with { type: "json" };
import m0004 from "../../../architecture/adr/progress/0004.json" with { type: "json" };
import m0005 from "../../../architecture/adr/progress/0005.json" with { type: "json" };
import m0006 from "../../../architecture/adr/progress/0006.json" with { type: "json" };
import m0007 from "../../../architecture/adr/progress/0007.json" with { type: "json" };
import m0008 from "../../../architecture/adr/progress/0008.json" with { type: "json" };
import m0009 from "../../../architecture/adr/progress/0009.json" with { type: "json" };
import m0010 from "../../../architecture/adr/progress/0010.json" with { type: "json" };
import m0011 from "../../../architecture/adr/progress/0011.json" with { type: "json" };
import m0012 from "../../../architecture/adr/progress/0012.json" with { type: "json" };
import m0013 from "../../../architecture/adr/progress/0013.json" with { type: "json" };
import m0014 from "../../../architecture/adr/progress/0014.json" with { type: "json" };
import m0015 from "../../../architecture/adr/progress/0015.json" with { type: "json" };
import m0016 from "../../../architecture/adr/progress/0016.json" with { type: "json" };
import m0017 from "../../../architecture/adr/progress/0017.json" with { type: "json" };
import m0018 from "../../../architecture/adr/progress/0018.json" with { type: "json" };
import m0019 from "../../../architecture/adr/progress/0019.json" with { type: "json" };
import m0020 from "../../../architecture/adr/progress/0020.json" with { type: "json" };

export interface BundledManifest { adr: string; file: string; manifest: unknown }

/** The manifests of this deploy, in ADR order. The id comes from the file name; the evaluator checks it equals `adr`. */
export const ADR_MANIFESTS: readonly BundledManifest[] = Object.freeze(([
  ["0001", m0001],
  ["0002", m0002],
  ["0003", m0003],
  ["0004", m0004],
  ["0005", m0005],
  ["0006", m0006],
  ["0007", m0007],
  ["0008", m0008],
  ["0009", m0009],
  ["0010", m0010],
  ["0011", m0011],
  ["0012", m0012],
  ["0013", m0013],
  ["0014", m0014],
  ["0015", m0015],
  ["0016", m0016],
  ["0017", m0017],
  ["0018", m0018],
  ["0019", m0019],
  ["0020", m0020],
] as Array<[string, unknown]>).map(([adr, manifest]) => Object.freeze({ adr, file: `${ADR_PROGRESS_DIR}${adr}.json`, manifest })));

const VISION_PATH = "organism/vision.json";

/** The quotes each document file is anchored by in the manifests (doc_asserted leaves and doc_claim). */
export function manifestQuotes(manifests: readonly BundledManifest[] = ADR_MANIFESTS): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (ref: unknown, quote: unknown) => {
    if (typeof ref !== "string" || typeof quote !== "string") return;
    const list = out.get(ref) ?? [];
    if (!list.includes(quote)) list.push(quote);
    out.set(ref, list);
  };
  for (const { manifest } of manifests) {
    const phases = (manifest as Partial<AdrManifest>)?.phases;
    if (!Array.isArray(phases)) continue;
    for (const ph of phases) {
      if (ph?.evidence && typeof ph.evidence === "object") for (const leaf of predicateLeaves(ph.evidence)) if (leaf.kind === "doc_asserted") add(leaf.ref, leaf.quote);
      if (ph?.doc_claim) add(ph.doc_claim.ref, ph.doc_claim.quote);
    }
  }
  return out;
}

const QUOTES = manifestQuotes();

/** The repository text this deploy carries for a path, or null when it carries none (the evaluator's `readFile`). */
export function bundledReadFile(path: string): string | null {
  if (path === VISION_PATH) return JSON.stringify(visionFile);
  const quotes = QUOTES.get(path);
  return quotes ? quotes.join("\n") : null;
}

/** sha256 of a manifest's canonical JSON (keys sorted): `manifest_sha256` of its document. */
export function manifestSha256(manifest: unknown): Promise<string> {
  return sha256Hex(canonicalJson(manifest));
}

/** Tier 0, `adr.observe`: evaluate the bundled manifests (all, or the ids in `input.adrs`) at `input.now`. */
export async function observeAdr(env: { DB: D1Database }, input: JsonObject, manifests: readonly BundledManifest[] = ADR_MANIFESTS): Promise<JsonObject> {
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  const want = Array.isArray(input.adrs) ? new Set(input.adrs.filter((a): a is string => typeof a === "string" && ADR_ID.test(a))) : null;
  const selected = want ? manifests.filter((m) => want.has(m.adr)) : manifests;
  const evaluations = await evaluateAdrManifests(selected.map((m) => m.manifest), {
    db: env.DB, readFile: bundledReadFile, now, manifestIds: manifests.map((m) => m.adr),
  });
  const listed: JsonObject[] = [];
  for (const m of selected) listed.push({ adr: m.adr, file: m.file, sha256: await manifestSha256(m.manifest) });
  return {
    schema: "adr.observe.v1",
    evaluated_at: new Date(now).toISOString(),
    manifests: listed,
    evaluations: evaluations as unknown as JsonObject[],
  };
}
