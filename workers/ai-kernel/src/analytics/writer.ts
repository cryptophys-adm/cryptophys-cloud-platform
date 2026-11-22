// Ported 2026-11-22 from the owner's VPS work (commit 6bb8306, branch vps/analytics-engine-2026-11-21), reviewed;
// owner: "Pindahkan folder analytic engine ke platform". ADR-0015 decision 6: telemetry only.
import { tryConsumePoint } from "./budget.ts";
import {
  MAX_BLOB_TOTAL_BYTES,
  MAX_POINTS_PER_INVOCATION,
  type DatasetSchema,
} from "./schema.ts";

/** Structural type of the `AnalyticsEngineDataset` binding. */
export interface AnalyticsEngineBinding {
  writeDataPoint(point: {
    blobs?: (string | ArrayBuffer)[] | null;
    doubles?: number[] | null;
    indexes?: string[] | null;
  }): void;
}

export interface WriteOptions {
  /**
   * Client-side sampling rate in (0, 1]. Default 1 (write every point).
   * When below 1, skipped points are compensated by the `sample_weight` double
   * on the points that ARE written, so `SUM(_sample_interval * sample_weight)`
   * stays an unbiased estimate.
   */
  sampleRate?: number;
  /** Per-invocation point ceiling. Defaults to the platform limit of 250. */
  maxPointsPerInvocation?: number;
  /** Called whenever a point is dropped, for logging. Never throws. */
  onDrop?: (dataset: string, reason: string) => void;
}

const encoder = new TextEncoder();

/** Truncate a string to at most `maxBytes` UTF-8 bytes without splitting a code point. */
export function truncateUtf8(input: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (encoder.encode(input).length <= maxBytes) return input;
  let out = "";
  let bytes = 0;
  for (const char of input) {
    const size = encoder.encode(char).length;
    if (bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

/**
 * Keep the total blob payload under 16 KB. Shrinks proportionally, with a 32-byte
 * floor per field so short dimensions (status codes, versions) survive intact.
 */
function fitBlobBudget(blobs: string[]): string[] {
  const sizes = blobs.map((blob) => encoder.encode(blob).length);
  const total = sizes.reduce((sum, size) => sum + size, 0);
  if (total <= MAX_BLOB_TOTAL_BYTES) return blobs;

  const MIN_PER_FIELD = 32;
  const floorTotal = Math.min(MAX_BLOB_TOTAL_BYTES, MIN_PER_FIELD * blobs.length);
  const flexible = MAX_BLOB_TOTAL_BYTES - floorTotal;
  const flexibleTotal = Math.max(1, total - floorTotal);

  return blobs.map((blob, index) => {
    const size = sizes[index] ?? 0;
    const excess = Math.max(0, size - MIN_PER_FIELD);
    const allowance = Math.floor(MIN_PER_FIELD + (flexible * excess) / flexibleTotal);
    return truncateUtf8(blob, allowance);
  });
}

function normalizeSampleRate(rate: number | undefined): number {
  if (rate === undefined || !Number.isFinite(rate)) return 1;
  if (rate >= 1) return 1;
  if (rate <= 0.0001) return 0.0001;
  return rate;
}

function buildBlobs(schema: DatasetSchema, values: Record<string, unknown>): string[] {
  const raw = schema.blobs.map((name) => {
    const value = values[name];
    if (value === null || value === undefined) return "";
    return typeof value === "string" ? value : String(value);
  });
  return fitBlobBudget(raw);
}

function buildDoubles(
  schema: DatasetSchema,
  values: Record<string, unknown>,
  sampleRate: number,
): number[] {
  return schema.doubles.map((name) => {
    if (name === schema.weightField) {
      return sampleRate < 1 ? Math.round(1 / sampleRate) : 1;
    }
    const numeric = Number(values[name]);
    return Number.isFinite(numeric) ? numeric : 0;
  });
}

/**
 * Write one data point. Never throws — analytics must not break a request path.
 *
 * Returns true when the point was handed to the binding.
 */
export function writePoint(
  binding: AnalyticsEngineBinding | undefined,
  schema: DatasetSchema,
  values: Record<string, unknown>,
  options: WriteOptions = {},
): boolean {
  if (!binding) return false;

  const sampleRate = normalizeSampleRate(options.sampleRate);
  if (sampleRate < 1 && Math.random() >= sampleRate) return false;

  const limit = options.maxPointsPerInvocation ?? MAX_POINTS_PER_INVOCATION;
  if (!tryConsumePoint(limit)) {
    options.onDrop?.(schema.dataset, "budget");
    return false;
  }

  try {
    const blobs = buildBlobs(schema, values);
    const doubles = buildDoubles(schema, values, sampleRate);
    const rawIndex = values[schema.index.name];
    const index = truncateUtf8(
      rawIndex === null || rawIndex === undefined || rawIndex === ""
        ? "unknown"
        : String(rawIndex),
      schema.index.maxBytes,
    );

    binding.writeDataPoint({ blobs, doubles, indexes: [index] });
    return true;
  } catch (error) {
    options.onDrop?.(schema.dataset, `error:${(error as Error).message}`);
    return false;
  }
}

/**
 * Write many points in one call. Stops at the per-invocation ceiling.
 * Returns how many points were accepted.
 */
export function writePoints(
  binding: AnalyticsEngineBinding | undefined,
  schema: DatasetSchema,
  rows: Record<string, unknown>[],
  options: WriteOptions = {},
): number {
  let written = 0;
  for (const row of rows) {
    if (writePoint(binding, schema, row, options)) written += 1;
  }
  return written;
}
