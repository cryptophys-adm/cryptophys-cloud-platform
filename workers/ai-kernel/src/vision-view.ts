/**
 * ADR-0016 (Telos) T0: the organism's vision, read-only, for the Console's Vision page (GET /v1/vision).
 *
 * The vision is `organism/vision.json` of the deployed commit, bundled into the kernel at build time; nothing
 * here reads or writes D1, and the AI does not touch it. CI validates the file (control-plane-shared/src/vision.ts)
 * and this view checks it again: an invalid vision is reported with its problems and never served as valid.
 * A KPI with a null baseline or target is passed through as null; the Console shows "not measured yet".
 */
import visionFile from "../../../organism/vision.json" with { type: "json" };
import { VISION_SCHEMA, visionProblems, type Vision } from "../../control-plane-shared/src/vision.ts";

export const VISION_SOURCE = "organism/vision.json";

export interface VisionView {
  schema: "organism.vision-view.v1";
  source: typeof VISION_SOURCE;
  vision_schema: typeof VISION_SCHEMA;
  status: "valid" | "invalid";
  problems: string[];
  vision: Vision | null;
}

export function visionView(file: unknown = visionFile): VisionView {
  const problems = visionProblems(file);
  return {
    schema: "organism.vision-view.v1",
    source: VISION_SOURCE,
    vision_schema: VISION_SCHEMA,
    status: problems.length === 0 ? "valid" : "invalid",
    problems,
    vision: problems.length === 0 ? (file as Vision) : null,
  };
}
