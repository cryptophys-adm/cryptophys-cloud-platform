// Retired services (owner 2026-11-14, migration 0064). A retired service is one whose Worker is gone for good:
// its registry row stays as the parent of its history (drift observations, deploy requests, recovery plans, AI
// usage and burn rows reference it; the audit chain names it), with status 'disabled' and metadata.retired_at
// set. Unlike a merely disabled service (one a recovery plan or the council disabled, or Aether before its
// first deploy), a retired one is no longer observed at all: the Drift Detector neither probes it nor records
// an observation or a heartbeat for it, and the platform's views (`GET /v1/drift`, the kernel's
// `platform.observe`) leave it out. Its history stays readable (`GET /v1/drift/{service_id}`, the registry).
//
// Retired by 0064: cryptophys-signal-engine (TP-018, disabled by 0020) and cryptophys-home (ADR-0010
// amendment, disabled by 0055). Both Workers are deleted from the Cloudflare account.

/** The metadata key a retirement sets (an ISO time). */
export const RETIRED_AT_KEY = "retired_at";

/** True when a registry row is retired: disabled, and its metadata carries retired_at. Malformed metadata is not retired. */
export function isRetiredService(row: { status: string; metadata_json: string | null | undefined }): boolean {
  if (row.status !== "disabled") return false;
  try {
    const m = JSON.parse(row.metadata_json ?? "{}") as Record<string, unknown> | null;
    return typeof m?.[RETIRED_AT_KEY] === "string" && (m[RETIRED_AT_KEY] as string).length > 0;
  } catch {
    return false;
  }
}

/**
 * SQL that is true for a service_registry row that is NOT retired, the same rule as isRetiredService. `alias` is
 * the table alias with its dot ("r.") or "". The CASE keeps json_extract away from malformed metadata (SQLite
 * does not promise to evaluate AND left to right), so such a row reads as not retired, as above.
 */
export const notRetiredSql = (alias = ""): string =>
  `NOT (${alias}status = 'disabled' AND COALESCE(CASE WHEN json_valid(${alias}metadata_json) THEN json_type(${alias}metadata_json, '$.${RETIRED_AT_KEY}') = 'text' AND length(json_extract(${alias}metadata_json, '$.${RETIRED_AT_KEY}')) > 0 END, 0))`;
