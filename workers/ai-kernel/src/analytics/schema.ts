// Ported 2026-11-22 from the owner's VPS work (commit 6bb8306, branch vps/analytics-engine-2026-11-21), reviewed;
// owner: "Pindahkan folder analytic engine ke platform". ADR-0015 decision 6: telemetry only.
/**
 * Positional schema registry for Workers Analytics Engine.
 *
 * Analytics Engine stores fields positionally: `blob1..blob20`, `double1..double20`,
 * `index1`. There are no column names in the store. If the order of a field changes
 * in one Worker and not another, the data silently becomes wrong.
 *
 * Therefore every dataset is declared exactly once, here, and every write goes
 * through `writePoint()` which maps names -> positions. Nothing else in the
 * codebase may build a `blobs` / `doubles` array by hand.
 *
 * Hard limits enforced below (see developers.cloudflare.com/analytics/analytics-engine/limits):
 *   - 20 blobs, 20 doubles, 1 index per data point
 *   - 16 KB total blob payload per data point
 *   - 96 bytes per index
 *   - 250 data points per Worker invocation
 */

export const MAX_BLOBS = 20;
export const MAX_DOUBLES = 20;
export const MAX_INDEX_BYTES = 96;
export const MAX_BLOB_TOTAL_BYTES = 16 * 1024;
export const MAX_POINTS_PER_INVOCATION = 250;

export interface DatasetSchema {
  /** Dataset name. Must be a bare SQL identifier: lowercase, digits, underscores. */
  readonly dataset: string;
  /**
   * The sampling key. Keep this LOW cardinality (symbol, service, room type).
   * A unique-per-event index causes aggressive adaptive sampling and makes
   * every count an approximation of an approximation.
   */
  readonly index: { readonly name: string; readonly maxBytes: number };
  /** Blob field names, in write order. Position N becomes `blobN`. */
  readonly blobs: readonly string[];
  /** Double field names, in write order. Position N becomes `doubleN`. */
  readonly doubles: readonly string[];
  /** Which double carries the client-side sampling weight. */
  readonly weightField: string;
  /** What this dataset answers, in one sentence. */
  readonly description: string;
}

export function assertSchema(schema: DatasetSchema): void {
  const problems: string[] = [];

  if (!/^[a-z][a-z0-9_]*$/.test(schema.dataset)) {
    problems.push(`dataset name "${schema.dataset}" is not a bare SQL identifier (lowercase, digits, underscore)`);
  }
  if (schema.blobs.length > MAX_BLOBS) {
    problems.push(`${schema.blobs.length} blobs declared, maximum is ${MAX_BLOBS}`);
  }
  if (schema.doubles.length > MAX_DOUBLES) {
    problems.push(`${schema.doubles.length} doubles declared, maximum is ${MAX_DOUBLES}`);
  }
  if (schema.index.maxBytes > MAX_INDEX_BYTES) {
    problems.push(`index maxBytes ${schema.index.maxBytes} exceeds ${MAX_INDEX_BYTES}`);
  }
  if (!schema.doubles.includes(schema.weightField)) {
    problems.push(`weightField "${schema.weightField}" is not present in doubles`);
  }

  const seen = new Set<string>();
  for (const name of [...schema.blobs, ...schema.doubles, schema.index.name]) {
    if (seen.has(name)) problems.push(`duplicate field name "${name}"`);
    seen.add(name);
  }

  if (problems.length > 0) {
    throw new Error(`Invalid Analytics Engine schema "${schema.dataset}":\n- ${problems.join("\n- ")}`);
  }
}
