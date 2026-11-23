// ADR-0016 (Telos) T1b (docs/design/TELOS-T1-SELF-MODEL.md §5.2, §5.3, §5.5, §6; owner 2026-11-22, "setuju semua"): the
// assembler of the daily self-model. One run, as §5.2 says:
//
//   1. read the vision (the bundled organism/vision.json unless a test passes another) and validate it;
//   2. window_end is 00:00 UTC of the day after `day`;
//   3. read each source once (self-model-read.ts): a failed, missing or slow source is marked and the rest go on;
//   4. compute Body, Mind, Memory and Ecosystem with pure functions (self-model-sections.ts), then Will last, through the
//      KPI bindings (§6): a KPI without a binding is null with no_binding;
//   5. put the document in canonical form, hash it and validate it (self-model.ts).
//
// Step 6 (the write and the audit event) is T1d's: this module returns the document and its problems and writes nothing.
// The bindings themselves are T1c's (self-model-kpis.ts); until then every KPI reads no_binding, and the inputs each §6
// binding needs are in the sections already (SELF_MODEL_KPI_INPUTS).
//
// Deterministic (§5.3): the same rows and the same vision give the same content_sha256, whatever is written after
// window_end; only the point-in-time sources (marked so) can differ, and only the budgets read the clock.
import {
  BUNDLED_VISION, SELF_MODEL_MAX_BYTES, SELF_MODEL_SCHEMA, canonicalJson, canonicalSelfModel, selfModelContentHash, selfModelProblems, selfModelStatus,
  visionSha256, type Measure, type SelfModelDocument, type SnapshotStatus, type SourceRead, type WillKpi, type WillSection,
} from "./self-model.ts";
import { readSelfModelSources, selfModelWindows, type ReadOptions, type SelfModelDb, type SelfModelReadings, type SelfModelWindows } from "./self-model-read.ts";
import { bodySection, ecosystemSection, memorySection, mindSection, nul } from "./self-model-sections.ts";
import { VISION_SCHEMA, visionProblems, type Vision } from "./vision.ts";

/** The four sections a binding reads (Will is computed from them). */
export interface SelfModelSections {
  body: Record<string, unknown>;
  mind: Record<string, unknown>;
  memory: Record<string, unknown>;
  ecosystem: Record<string, unknown>;
}

/** §6: a named, pure function from the other sections to one KPI's measure, with the one-line definition shown beside it. */
export interface KpiBinding {
  goal_id: string;
  kpi_id: string;
  definition: string;
  measure(sections: SelfModelSections, windows: SelfModelWindows): Measure;
}

/** Will (§3, §5.5): every KPI of the vision once, baseline, target and source verbatim, the value through its binding. */
export function willSection(vision: unknown, sections: SelfModelSections, windows: SelfModelWindows, bindings: readonly KpiBinding[] = []): WillSection {
  const problems = visionProblems(vision);
  // An invalid vision lists its problems and no KPI is measured; the other sections are still written.
  if (problems.length) return { goals: [], problems };
  const byKey = new Map(bindings.map((b) => [`${b.goal_id}/${b.kpi_id}`, b]));
  return {
    goals: (vision as Vision).growth.goals.map((g) => ({
      id: g.id,
      kpis: g.kpis.map((k): WillKpi => {
        const b = byKey.get(`${g.id}/${k.id}`);
        return {
          id: k.id, baseline: k.baseline, target: k.target, source: k.source,
          definition: b ? b.definition : null,
          measured: b ? b.measure(sections, windows) : nul("no_binding"),
        };
      }),
    })),
  };
}

/** The measures of a section, counted as selfModelProblems counts them. */
function countMeasures(n: unknown, c: { measured: number; nulls: number }): void {
  if (Array.isArray(n)) { n.forEach((v) => countMeasures(v, c)); return; }
  if (!n || typeof n !== "object") return;
  if ("value" in n || "reason" in n) { if ((n as { value: unknown }).value === null || (n as { value: unknown }).value === undefined) c.nulls++; else c.measured++; return; }
  for (const v of Object.values(n)) countMeasures(v, c);
}

/**
 * §5.4: a body stays within 64 KB by cutting its lists. Every bounded list is a `top` array beside its `omitted` count;
 * this keeps at most `keep` entries of each and adds what it cut to `omitted`. Deterministic: the same sections and the
 * same `keep` give the same result.
 */
export function cutLists<T>(node: T, keep: number): T {
  if (Array.isArray(node)) return node.map((v) => cutLists(v, keep)) as T;
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = cutLists(v, keep);
  if (Array.isArray(out.top) && out.top.length > keep && !("value" in out) && !("reason" in out)) {
    out.omitted = (typeof out.omitted === "number" ? out.omitted : 0) + (out.top.length - keep);
    out.top = out.top.slice(0, keep);
  }
  return out as T;
}
/** The list lengths tried, in order, when a body is over the bound: the full lists first. */
const CUTS = [Infinity, 10, 5, 3, 1, 0];

export interface AssembleOptions {
  /** The vision to measure against; the bundled organism/vision.json by default. */
  vision?: unknown;
  /** The KPI bindings of §6 (T1c). None by default: every KPI is null with no_binding. */
  bindings?: readonly KpiBinding[];
  /** The ADR ids of the bundled progress manifests, for the reading adr_index_live. Without them it is null. */
  adrManifestIds?: readonly string[];
  /** When the snapshot is computed (ISO, at or after window_end). Not hashed. */
  computedAt: string;
  /** The deployed commit, when known. Not hashed. */
  deployedCommit?: string | null;
}

export interface AssembleResult {
  /** The canonical document (sorted keys, numbers at 4 decimals), hashed. Valid exactly when `problems` is empty. */
  document: SelfModelDocument;
  problems: string[];
  status: SnapshotStatus;
  sources_ok: number;
  sources_total: number;
  /** UTF-8 bytes of the canonical JSON (at most SELF_MODEL_MAX_BYTES when valid). */
  bytes: number;
}

/** §5.2 steps 1, 4 and 5 over readings already taken: pure apart from the hash. */
export async function assembleFromReadings(readings: SelfModelReadings, windows: SelfModelWindows, options: AssembleOptions): Promise<AssembleResult> {
  const vision = options.vision === undefined ? BUNDLED_VISION : options.vision;
  const visionOk = visionProblems(vision).length === 0;
  const visionSchema = visionOk ? VISION_SCHEMA
    : vision && typeof vision === "object" && typeof (vision as { schema?: unknown }).schema === "string" ? (vision as { schema: string }).schema : null;

  const full = {
    body: bodySection(readings, windows),
    mind: mindSection(readings, windows),
    memory: memorySection(readings, windows, options.adrManifestIds),
    ecosystem: ecosystemSection(readings, windows),
  };
  // Will is computed last, from the full sections, so a cut list never changes a KPI.
  const will = willSection(vision, full, windows, options.bindings);
  const sources: SourceRead[] = Object.values(readings).map((s) => ({ id: s.id, status: s.status, rows: s.rows, as_of: s.as_of, point_in_time: s.point_in_time }));
  const header = { visionSchema, visionSha: await visionSha256(vision), visionOk };
  let result: AssembleResult | null = null;
  for (const keep of CUTS) {
    const sections = keep === Infinity ? full : cutLists(full, keep);
    result = await documentOf(windows, sections, will, sources, header, options);
    if (result.bytes <= SELF_MODEL_MAX_BYTES) break;
  }
  return result!;
}

async function documentOf(
  windows: SelfModelWindows, sections: SelfModelSections, will: WillSection, sources: SourceRead[],
  header: { visionSchema: string | null; visionSha: string; visionOk: boolean }, options: AssembleOptions,
): Promise<AssembleResult> {
  const vision = options.vision === undefined ? BUNDLED_VISION : options.vision;

  const tally = { measured: 0, nulls: 0 };
  for (const s of Object.values(sections)) countMeasures(s, tally);
  const kpis = will.goals.flatMap((g) => g.kpis);
  for (const k of kpis) countMeasures(k.measured, tally);

  const raw = {
    schema: SELF_MODEL_SCHEMA,
    day: windows.day,
    window_end: `${windows.end.slice(0, 19)}Z`,
    vision: { schema: header.visionSchema, sha256: header.visionSha, valid: header.visionOk },
    sections: { ...sections, will },
    sources,
    counts: { measured: tally.measured, null: tally.nulls, kpis_measured: kpis.filter((k) => k.measured.value !== null).length, kpis_total: kpis.length },
    computed_at: options.computedAt,
    deployed_commit: options.deployedCommit ?? null,
  };
  const canonical = canonicalSelfModel(raw) as Record<string, unknown>;
  canonical.content_sha256 = await selfModelContentHash(canonical);
  const document = canonicalSelfModel(canonical) as SelfModelDocument;
  const problems = selfModelProblems(document, vision);
  const bytes = new TextEncoder().encode(canonicalJson(document)).length;
  const sources_ok = sources.filter((s) => s.status === "ok" || s.status === "empty").length;
  return { document, problems, status: selfModelStatus(sources), sources_ok, sources_total: sources.length, bytes };
}

/** One run (§5.2 steps 1–5): read every source of `day` from D1 and assemble the document. Writes nothing. */
export async function assembleSelfModel(db: SelfModelDb, day: string, options: AssembleOptions & { read?: ReadOptions }): Promise<AssembleResult & { statements: number }> {
  const windows = selfModelWindows(day);
  if (!windows) throw new Error(`self_model: ${JSON.stringify(day)} is not a UTC calendar day`);
  const { readings, statements } = await readSelfModelSources(db, windows, options.read);
  return { ...(await assembleFromReadings(readings, windows, options)), statements };
}
