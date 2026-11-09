// ADR-0013 phase 2: the organism census. The Forge reads the DNA of main's head
// (workers/<dir>/organism.json, from the Artifacts repository) and compares it with the live
// registries. What is declared but unknown, known but no longer declared, or changed, is a finding.
// Findings are recorded per main commit (forge_organism_census, migration 0040), audited when they
// change, raised to the owner by the AI Kernel's notices (topic "organism"), and (phase 3) turned
// into registration proposals by the Supervisor (ai-kernel/src/organism.ts). The census reads only;
// it registers nothing. The genome summary keeps each agent's full gene, because the registration
// executors take the gene from here, never from a proposal's params.
import type { D1Database } from "../../control-plane-shared/src/types.ts";
import { appendAuditEvent } from "../../control-plane-shared/src/audit.ts";
import { DNA_FILE, genomeFrom, type Genome } from "../../control-plane-shared/src/organism.ts";
import type { ArtifactsReader } from "./checks.ts";

const HEX40 = /^[0-9a-f]{40}$/;

export type FindingKind = "invalid_dna" | "unregistered_service" | "disabled_service" | "unregistered_agent" | "undeclared_agent" | "agent_host_changed" | "agent_capabilities_changed"
  | "unregistered_engine" | "undeclared_engine" | "voter_seat_requested" | "voter_seat_vacated";
export interface Finding { kind: FindingKind; subject: string; detail: string }

/** Read every workers/<dir>/organism.json at a commit. */
export async function readGenome(repo: ArtifactsReader, commit: string): Promise<{ genome: Genome; files: number }> {
  const c = await repo.readCommit(commit);
  if (!c) throw new Error("commit_not_mirrored");
  const root = await repo.readTree(c.treeHash);
  const workers = root?.find((e) => e.name === "workers" && e.type === "tree");
  if (!workers) throw new Error("no_workers_directory");
  const entries: Array<{ path: string; text: string }> = [];
  for (const dir of (await repo.readTree(workers.hash)) ?? []) {
    if (dir.type !== "tree") continue;
    const dna = ((await repo.readTree(dir.hash)) ?? []).find((e) => e.name === DNA_FILE && e.type !== "tree");
    if (!dna) continue;
    const blob = await repo.readBlob(dna.hash);
    if (blob) entries.push({ path: `workers/${dir.name}/${DNA_FILE}`, text: await blob.text() });
  }
  return { genome: genomeFrom(entries), files: entries.length };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** Compare the DNA with service_registry, agents (and their seats) and engines. Read-only. */
export async function compare(db: D1Database, genome: Genome): Promise<Finding[]> {
  const findings: Finding[] = [];
  const services = new Map(((await db.prepare("SELECT service_id, status FROM service_registry").all<{ service_id: string; status: string }>()).results ?? []).map((r) => [r.service_id, r.status]));
  // Seats and engines arrive with migration 0041; before it the census compares what exists.
  let phase3 = true;
  let agents: Array<{ agent_id: string; host_worker: string; capabilities_json: string; voter?: number }>;
  try {
    agents = (await db.prepare("SELECT agent_id, host_worker, capabilities_json, voter FROM agents").all<{ agent_id: string; host_worker: string; capabilities_json: string; voter: number }>()).results ?? [];
  } catch {
    phase3 = false;
    agents = (await db.prepare("SELECT agent_id, host_worker, capabilities_json FROM agents").all<{ agent_id: string; host_worker: string; capabilities_json: string }>()).results ?? [];
  }
  let engines: Array<{ service_id: string; task: string }> = [];
  if (phase3) {
    try { engines = (await db.prepare("SELECT service_id, task FROM engines WHERE status = 'enabled'").all<{ service_id: string; task: string }>()).results ?? []; } catch { phase3 = false; }
  }
  const byId = new Map(agents.map((a) => [a.agent_id, a]));
  const declared = new Set<string>();
  for (const dna of genome.values()) {
    if (dna.kind !== "build-stub") {
      const status = services.get(dna.service);
      if (status === undefined) findings.push({ kind: "unregistered_service", subject: dna.service, detail: `${dna.display_name} is in the DNA but not in the Platform Registry` });
      else if (status === "disabled" && dna.deploy_unit) findings.push({ kind: "disabled_service", subject: dna.service, detail: `${dna.display_name} has a deploy unit but is disabled in the registry` });
    }
    for (const gene of dna.agents) {
      declared.add(gene.id);
      const row = byId.get(gene.id);
      if (!row) { findings.push({ kind: "unregistered_agent", subject: gene.id, detail: `agent ${gene.id} on ${dna.service} is in the DNA but not registered${gene.voter ? " (asks for a council seat)" : ""}` }); continue; }
      if (row.host_worker !== dna.service) findings.push({ kind: "agent_host_changed", subject: gene.id, detail: `agent ${gene.id} is registered on ${row.host_worker}; the DNA puts it on ${dna.service}` });
      let caps: string[] = [];
      try { const c = JSON.parse(row.capabilities_json ?? "[]"); if (Array.isArray(c)) caps = c.map(String); } catch { caps = []; }
      if (!sameSet(caps, gene.capabilities)) findings.push({ kind: "agent_capabilities_changed", subject: gene.id, detail: `agent ${gene.id}: registered [${[...caps].sort().join(", ")}], DNA [${[...gene.capabilities].sort().join(", ")}]` });
      if (phase3 && gene.voter && row.voter !== 1 && row.host_worker === dna.service) findings.push({ kind: "voter_seat_requested", subject: gene.id, detail: `agent ${gene.id} on ${dna.service} asks for a council seat (consensus and the owner's click)` });
      if (phase3 && !gene.voter && row.voter === 1) findings.push({ kind: "voter_seat_vacated", subject: gene.id, detail: `agent ${gene.id} holds a council seat its DNA no longer asks for` });
    }
    if (phase3) {
      const live = new Set(engines.filter((e) => e.service_id === dna.service).map((e) => e.task));
      for (const e of dna.engines) if (!live.has(e.task)) findings.push({ kind: "unregistered_engine", subject: `${dna.service}:${e.task}`, detail: `AI engine ${e.task} on ${dna.service} is in the DNA but not registered` });
      const tasks = new Set(dna.engines.map((e) => e.task));
      for (const t of live) if (!tasks.has(t)) findings.push({ kind: "undeclared_engine", subject: `${dna.service}:${t}`, detail: `AI engine ${t} is registered on ${dna.service}, but its DNA does not declare it` });
    }
  }
  for (const a of agents) {
    if (!declared.has(a.agent_id) && genome.has(a.host_worker)) findings.push({ kind: "undeclared_agent", subject: a.agent_id, detail: `agent ${a.agent_id} is registered on ${a.host_worker}, but its DNA does not declare it` });
  }
  return findings.sort((x, y) => (x.kind + x.subject).localeCompare(y.kind + y.subject));
}

/** A census of an unchanged head is retaken this often, so registrations by consensus show up in it. */
export const CENSUS_REFRESH_MS = 30 * 60_000;

/** One census per main head (retaken every CENSUS_REFRESH_MS): read the DNA, compare, record, and audit when the findings changed. */
export async function censusTick(db: D1Database, repo: ArtifactsReader, nowMs = Date.now()): Promise<{ outcome: "recorded" | "refreshed" | "up_to_date" | "no_main"; main_sha?: string; status?: string; findings?: number }> {
  const head = (await repo.log({ ref: "main", limit: 1 })).map((c) => (typeof c.hash === "string" ? c.hash : "")).find((h) => HEX40.test(h));
  if (!head) return { outcome: "no_main" };
  const existing = await db.prepare("SELECT taken_at FROM forge_organism_census WHERE main_sha = ?").bind(head).first<{ taken_at: string }>();
  if (existing && nowMs - Date.parse(existing.taken_at) < CENSUS_REFRESH_MS) return { outcome: "up_to_date", main_sha: head };
  let status: "consistent" | "changes" | "invalid";
  let findings: Finding[] = [];
  let genome: Genome = new Map();
  try {
    genome = (await readGenome(repo, head)).genome;
    findings = await compare(db, genome);
    status = findings.length ? "changes" : "consistent";
  } catch (e) {
    status = "invalid";
    findings = [{ kind: "invalid_dna", subject: head.slice(0, 12), detail: `the DNA could not be read: ${String((e as Error)?.message ?? e).slice(0, 300)}` }];
  }
  const dnas = [...genome.values()];
  const summary = dnas.map((d) => ({
    service: d.service, kind: d.kind,
    agents: d.agents.map((a) => ({ id: a.id, display_name: a.display_name, capabilities: [...a.capabilities].sort(), tier_max: a.tier_max, voter: a.voter, ...(a.vote_binding ? { vote_binding: a.vote_binding } : {}) })),
    engines: d.engines.map((e) => e.task),
  }));
  const counts = { organs: dnas.length, agents: dnas.reduce((n, d) => n + d.agents.length, 0), engines: dnas.reduce((n, d) => n + d.engines.length, 0), voters: dnas.reduce((n, d) => n + d.agents.filter((a) => a.voter).length, 0) };
  const previous = await db.prepare("SELECT findings FROM forge_organism_census ORDER BY taken_at DESC LIMIT 1").first<{ findings: string }>();
  const findingsJson = JSON.stringify(findings);
  await db.prepare(
    `INSERT INTO forge_organism_census (main_sha, status, organs, agents, engines, voters, findings, genome, taken_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (main_sha) DO UPDATE SET status = excluded.status, organs = excluded.organs, agents = excluded.agents, engines = excluded.engines,
       voters = excluded.voters, findings = excluded.findings, genome = excluded.genome, taken_at = excluded.taken_at`,
  ).bind(head, status, counts.organs, counts.agents, counts.engines, counts.voters, findingsJson, JSON.stringify(summary), new Date(nowMs).toISOString()).run();
  if (previous?.findings !== findingsJson) {
    await appendAuditEvent(db, { event_type: "forge.organism_census", actor: "system:forge-census", subject: head, outcome: status, payload: { ...counts, findings: findings.slice(0, 20) } });
  }
  return { outcome: existing ? "refreshed" : "recorded", main_sha: head, status, findings: findings.length };
}

export async function latestCensus(db: D1Database, limit = 5) {
  const rows = (await db.prepare("SELECT * FROM forge_organism_census ORDER BY taken_at DESC LIMIT ?").bind(Math.min(Math.max(limit, 1), 20))
    .all<{ main_sha: string; status: string; organs: number; agents: number; engines: number; voters: number; findings: string; genome: string | null; taken_at: string }>()).results ?? [];
  const parse = (v: string | null) => { try { return JSON.parse(v ?? "null"); } catch { return null; } };
  return { census: rows.map((r) => ({ ...r, findings: parse(r.findings) ?? [], genome: parse(r.genome) ?? [] })) };
}
