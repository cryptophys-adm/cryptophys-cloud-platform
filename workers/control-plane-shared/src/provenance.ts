// Deploy provenance (owner 2026-11-21, after two `wrangler deploy` runs from a VPS replaced the AI Kernel with a
// build of an old checkout and nothing told him: "kenapa system tidak bisa mencegah atau memberi tahu bukan kah ini
// akan menjadi lubang keamanan ?"; then "Rekomendasi").
//
// The Drift Detector reads only the version tag a Worker reports. A version without the tag was read as a harmless
// "dashboard change" since 2026-11-07 (supervisor.ts onlyUntaggedVersion): a secret change makes one. A full code
// upload by wrangler has no tag either, so the two could not be told apart, and a replaced Worker raised only a
// Console warning. The platform cannot prevent such an upload: a login with the account's rights is above it. It can
// tell what happened, from Cloudflare's own record of the active version:
//
//  - platform: the active version carries the tag of the desired version, or of a deploy the platform ran;
//  - settings_change: no such tag, but the code is byte-identical (the script etag) to the last version the platform
//    deployed: a secret, variable or binding changed outside a deploy. Informational;
//  - code_upload: no such tag and other code. The Worker runs code the platform did not deploy.
//
// A finding is one audit event per Worker and version (deployment.out_of_band_detected, outcome = the kind); when
// the Worker runs a platform version again, deployment.out_of_band_cleared. The Drift Detector adds the drift reason
// out_of_band_code_upload from it (so the Supervisor plans a redeploy, as for any other drift), and the Owner page
// lists it at once (ai-kernel owner-inbox.ts, out_of_band_deploy). Reads Cloudflare; writes only audit events.
import type { D1Database } from "./types.ts";
import { appendAuditEvent } from "./audit.ts";

export const OOB_DETECTED = "deployment.out_of_band_detected";
export const OOB_CLEARED = "deployment.out_of_band_cleared";
/** The drift reason the Drift Detector adds while a code upload outside the platform is the active version. */
export const OOB_REASON = "out_of_band_code_upload";
/** The platform's deploys of a Worker in this window are trusted tags besides the desired version. */
export const PLATFORM_DEPLOY_WINDOW_MS = 48 * 3_600_000;
/** How many earlier deployments are read to find the last version the platform deployed. */
export const REFERENCE_LOOKBACK = 8;

export type ProvenanceKind = "platform" | "settings_change" | "code_upload";

/** One deployment as `GET …/scripts/{name}/deployments` lists it. */
export interface DeploymentLike { created_on?: string; source?: string; annotations?: Record<string, string>; versions?: { version_id?: string; percentage?: number }[] }
/** One version as `GET …/scripts/{name}/versions/{id}` returns it. Secrets appear by type and name only. */
export interface VersionLike {
  id?: string;
  annotations?: Record<string, string>;
  metadata?: { source?: string; created_on?: string };
  resources?: { script?: { etag?: string }; bindings?: unknown };
}
export interface ProvenanceReader {
  deployments(script: string): Promise<DeploymentLike[]>;
  version(script: string, versionId: string): Promise<VersionLike>;
}

const API = "https://api.cloudflare.com/client/v4";
const UUID = /^[0-9a-f-]{36}$/;
const HEX12 = /^[0-9a-f]{12}$/;

/** A read-only reader on the Cloudflare API (Workers Scripts: Read is enough). Throws on any failure. */
export function cloudflareProvenanceReader(token: string, account: string, fetcher: typeof fetch = fetch): ProvenanceReader {
  // Called as a plain function: workerd's global fetch throws "Illegal invocation" as a method of another object.
  const get = (url: string, init: RequestInit) => fetcher(url, init);
  const call = async <T>(path: string): Promise<T> => {
    const res = await get(`${API}/accounts/${account}/workers/scripts/${path}`, { headers: { authorization: `Bearer ${token}` } });
    const body = await res.json().catch(() => null) as { success?: boolean; result?: T } | null;
    if (!res.ok || !body?.success) throw new Error(`cloudflare_api_${res.status}`);
    return body.result as T;
  };
  return {
    async deployments(script) { return (await call<{ deployments?: DeploymentLike[] }>(`${script}/deployments`)).deployments ?? []; },
    async version(script, versionId) {
      if (!UUID.test(versionId)) throw new Error("invalid_version_id");
      return call<VersionLike>(`${script}/versions/${versionId}`);
    },
  };
}

const tagOf = (v: VersionLike | null | undefined) => (typeof v?.annotations?.["workers/tag"] === "string" ? v.annotations["workers/tag"] : "");
const etagOf = (v: VersionLike | null | undefined) => (typeof v?.resources?.script?.etag === "string" ? v.resources.script.etag : "");
/** `type:name` of every binding, sorted. Never a value. */
export function bindingNames(v: VersionLike | null | undefined): string[] {
  const list = Array.isArray(v?.resources?.bindings) ? v!.resources!.bindings as { type?: unknown; name?: unknown }[] : [];
  return list.filter((b) => typeof b?.type === "string" && typeof b?.name === "string").map((b) => `${b.type}:${b.name}`).sort();
}

export interface Classification {
  kind: ProvenanceKind;
  /** The code equals the reference version's (the script etag); null when there is no reference or no etag. */
  code_same: boolean | null;
  bindings_added: string[];
  bindings_removed: string[];
}

/**
 * What the active version is, given the tags the platform deployed and the last version it deployed (the reference).
 * Without a reference, only Cloudflare's own "secret" trigger reads as a settings change; anything else is a code
 * upload (fail closed: an unknown version is not called harmless).
 */
export function classifyVersion(active: VersionLike, platformTags: ReadonlySet<string>, reference: VersionLike | null): Classification {
  const none = { bindings_added: [] as string[], bindings_removed: [] as string[] };
  const tag = tagOf(active);
  if (tag && platformTags.has(tag)) return { kind: "platform", code_same: null, ...none };
  if (reference) {
    const a = etagOf(active), r = etagOf(reference);
    const same = Boolean(a) && Boolean(r) && a === r;
    const now = bindingNames(active), was = bindingNames(reference);
    return { kind: same ? "settings_change" : "code_upload", code_same: a && r ? same : null, bindings_added: now.filter((b) => !was.includes(b)), bindings_removed: was.filter((b) => !now.includes(b)) };
  }
  return { kind: active.annotations?.["workers/triggered_by"] === "secret" ? "settings_change" : "code_upload", code_same: null, ...none };
}

export interface ProvenanceFinding {
  service_id: string;
  kind: ProvenanceKind;
  version_id: string;
  /** When Cloudflare made this version the active one. */
  deployed_at: string | null;
  source: string | null;
  triggered_by: string | null;
  desired_version: string;
  reference_version_id: string | null;
  code_same: boolean | null;
  bindings_added: string[];
  bindings_removed: string[];
  /** This run recorded it (a version already recorded is not recorded twice). */
  recorded: boolean;
}
export interface ProvenanceResult { checked: number; findings: ProvenanceFinding[]; cleared: string[]; unreadable: string[] }

const newestFirst = (list: DeploymentLike[]) => [...list].sort((a, b) => Date.parse(b.created_on ?? "") - Date.parse(a.created_on ?? ""));
const mainVersion = (d: DeploymentLike | undefined) => [...(d?.versions ?? [])].sort((a, b) => (b.percentage ?? 0) - (a.percentage ?? 0))[0]?.version_id ?? "";

/** The newest out-of-band event of a Worker (detected or cleared), by the (subject, created_at) index. */
export async function lastProvenanceEvent(db: D1Database, serviceId: string): Promise<{ event_type: string; outcome: string; created_at: string; payload: Record<string, unknown> } | null> {
  const row = await db.prepare(
    `SELECT event_type, outcome, created_at, payload_json FROM audit_events WHERE subject = ? AND event_type IN (?, ?) ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).bind(serviceId, OOB_DETECTED, OOB_CLEARED).first<{ event_type: string; outcome: string; created_at: string; payload_json: string | null }>();
  if (!row) return null;
  let payload: Record<string, unknown> = {};
  try { const p = JSON.parse(row.payload_json ?? "{}"); if (p && typeof p === "object" && !Array.isArray(p)) payload = p; } catch { payload = {}; }
  return { event_type: row.event_type, outcome: row.outcome, created_at: row.created_at, payload };
}

/** A code upload outside the platform is the Worker's newest provenance event (not cleared since). */
export async function openCodeUpload(db: D1Database, serviceId: string): Promise<{ version_id: string; deployed_at: string | null; source: string | null; detected_at: string } | null> {
  let last: Awaited<ReturnType<typeof lastProvenanceEvent>>;
  try { last = await lastProvenanceEvent(db, serviceId); } catch { return null; }
  if (!last || last.event_type !== OOB_DETECTED || last.outcome !== "code_upload") return null;
  const s = (v: unknown) => (typeof v === "string" && v ? v.slice(0, 80) : null);
  return { version_id: s(last.payload.version_id) ?? "", deployed_at: s(last.payload.deployed_at), source: s(last.payload.source), detected_at: last.created_at };
}

/**
 * One pass over the given Workers: reads each one's active version from Cloudflare, classifies it, and records what
 * changed since the last pass. A Worker whose record cannot be read is listed as unreadable and nothing is recorded
 * for it (no finding, no clearing). Never throws.
 */
export async function provenanceSweep(db: D1Database, reader: ProvenanceReader, services: readonly { service_id: string; desired_version: string }[], actor: string, nowMs = Date.now()): Promise<ProvenanceResult> {
  const out: ProvenanceResult = { checked: 0, findings: [], cleared: [], unreadable: [] };
  for (const s of services) {
    const desired = s.desired_version.slice(0, 12);
    if (!HEX12.test(desired)) continue;
    try {
      const deployments = newestFirst(await reader.deployments(s.service_id));
      const activeId = mainVersion(deployments[0]);
      if (!UUID.test(activeId)) throw new Error("active_deployment_unreadable");
      const active = await reader.version(s.service_id, activeId);
      out.checked++;
      const tags = new Set<string>([desired]);
      const recent = (await db.prepare(
        `SELECT json_extract(details_json, '$.version_tag') AS tag FROM deployment_requests WHERE service_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 20`,
      ).bind(s.service_id, new Date(nowMs - PLATFORM_DEPLOY_WINDOW_MS).toISOString()).all<{ tag: string | null }>()).results ?? [];
      for (const r of recent) if (typeof r.tag === "string" && HEX12.test(r.tag)) tags.add(r.tag);
      const last = await lastProvenanceEvent(db, s.service_id);
      if (tags.has(tagOf(active))) {
        if (last?.event_type === OOB_DETECTED) {
          await appendAuditEvent(db, { event_type: OOB_CLEARED, actor, subject: s.service_id, outcome: "cleared", payload: { service_id: s.service_id, version_id: activeId, tag: tagOf(active), was: last.outcome, was_version_id: last.payload.version_id ?? null } });
          out.cleared.push(s.service_id);
        }
        continue;
      }
      // The last version the platform deployed, among the deployments before the active one.
      let reference: VersionLike | null = null, referenceId: string | null = null;
      for (const d of deployments.slice(1, 1 + REFERENCE_LOOKBACK)) {
        const id = mainVersion(d);
        if (!UUID.test(id)) continue;
        const v = await reader.version(s.service_id, id);
        if (tags.has(tagOf(v))) { reference = v; referenceId = id; break; }
      }
      const c = classifyVersion(active, tags, reference);
      const already = last?.event_type === OOB_DETECTED && last.payload.version_id === activeId && last.outcome === c.kind;
      const finding: ProvenanceFinding = {
        service_id: s.service_id, kind: c.kind, version_id: activeId, deployed_at: deployments[0]?.created_on ?? null,
        source: typeof deployments[0]?.source === "string" ? deployments[0].source.slice(0, 40) : typeof active.metadata?.source === "string" ? active.metadata.source.slice(0, 40) : null,
        triggered_by: typeof active.annotations?.["workers/triggered_by"] === "string" ? active.annotations["workers/triggered_by"].slice(0, 40) : null,
        desired_version: desired, reference_version_id: referenceId, code_same: c.code_same,
        bindings_added: c.bindings_added.slice(0, 20), bindings_removed: c.bindings_removed.slice(0, 20), recorded: !already,
      };
      if (!already) {
        const { recorded: _r, kind, ...payload } = finding;
        await appendAuditEvent(db, { event_type: OOB_DETECTED, actor, subject: s.service_id, outcome: kind, payload: { ...payload, kind } });
      }
      out.findings.push(finding);
    } catch {
      out.unreadable.push(s.service_id);
    }
  }
  return out;
}

/** The Workers a sweep covers: every enabled platform Worker with a recorded desired version. */
export async function provenanceTargets(db: D1Database, serviceIds: readonly string[]): Promise<{ service_id: string; desired_version: string }[]> {
  if (!serviceIds.length) return [];
  const rows = (await db.prepare(
    `SELECT service_id, desired_version FROM service_registry WHERE status != 'disabled' AND desired_version IS NOT NULL AND service_id IN (${serviceIds.map(() => "?").join(", ")}) ORDER BY service_id`,
  ).bind(...serviceIds).all<{ service_id: string; desired_version: string }>()).results ?? [];
  return rows.filter((r) => /^[0-9a-f]{12,40}$/.test(r.desired_version));
}

/** The report a new finding is published as (reports.publish): its severity, subject and body. */
export function provenanceReport(f: ProvenanceFinding, name: string, critical: boolean): { kind: "platform_digest"; severity: "info" | "warning" | "critical"; subject: string; body: Record<string, unknown> } {
  const at = f.deployed_at ?? "an unknown time";
  const how = f.source ? ` by ${f.source}` : "";
  const bindings = [f.bindings_added.length ? `bindings added: ${f.bindings_added.join(", ")}` : "", f.bindings_removed.length ? `bindings removed: ${f.bindings_removed.join(", ")}` : ""].filter(Boolean).join("; ");
  if (f.kind === "code_upload") {
    return {
      kind: "platform_digest", severity: critical ? "critical" : "warning",
      subject: `${name} runs code the platform did not deploy (uploaded${how} at ${at})`.slice(0, 200),
      body: {
        explanation: (`${name} was replaced outside the platform's deploy: version ${f.version_id.slice(0, 8)} became active at ${at}${how}, without the tag of the desired version ${f.desired_version}`
          + `${f.code_same === false ? ", and its code differs from the last version the platform deployed" : ""}.${bindings ? ` ${bindings[0].toUpperCase()}${bindings.slice(1)}.` : ""} `
          + (critical ? "While this report is open, the council rejects every proposal (the critical-report brake), so nothing is deployed, including the deploy that would restore this Worker. Acknowledge it on the Owner page: the routine deploy of main then restores this Worker (the Deployment Orchestrator first if it is pending, then this unit). Or restore it now with a break-glass plan (Recovery), or confirm the change and bring it to main."
            : "The Supervisor plans a redeploy of the desired version; the Owner page lists it until the Worker runs a platform version again.")).slice(0, 2000),
        out_of_band: true, alert_key: `out_of_band:${f.service_id}:${f.version_id}`, state: "open", ...f,
      },
    };
  }
  return {
    kind: "platform_digest", severity: "info",
    subject: `A setting or secret of ${name} changed outside a deploy (at ${at})`.slice(0, 200),
    body: {
      explanation: `${name}: version ${f.version_id.slice(0, 8)} became active at ${at}${how}. Its code is the last version the platform deployed${f.code_same === null ? " (as Cloudflare records the change: a secret)" : ""}; only a secret, variable or binding changed.${bindings ? ` ${bindings[0].toUpperCase()}${bindings.slice(1)}.` : ""} The version tag is missing until the next deploy.`.slice(0, 2000),
      out_of_band: true, state: "info", ...f,
    },
  };
}
