/**
 * ADR-0013 (owner, 2026-11-09: "jadikan semuanya autonomous seperti living digital organism"):
 * the platform's DNA. Every Worker in this repository declares itself in `workers/<dir>/organism.json`:
 * what it is, how it is deployed, protected, observed and rolled back, which agents it hosts (and
 * whether they vote), and which AI engines (tasks) it runs. The DNA is the single source of the
 * platform's knowledge of itself:
 *   - phase 1: CI requires every static list (deploy units, drift probes, Access, rollback, voters,
 *     kernel agents, AI engines) to match the DNA, so nothing new can be added and silently missed;
 *   - phase 2: the Forge reads the DNA of each new main commit and takes a census against the live
 *     registries (service_registry, agents, engines), reporting what is new, missing or changed;
 *   - phase 3: what is new is proposed to consensus and registered when it passes (owner decisions
 *     2026-11-09: agents/engines by consensus, privileged capabilities and voter seats also need the
 *     owner's click; one vote per Worker).
 * Security lists stay static in code and workflows; the DNA only makes them consistent and visible.
 */

export const DNA_FILE = "organism.json";
export const DNA_SCHEMA_VERSION = 1;

export type OrganKind = "service" | "portal" | "build-stub";
export interface AgentGene {
  id: string;
  display_name: string;
  capabilities: string[];
  tier_max: number;
  /** A council seat (consensus voter). One per Worker; admission needs consensus and the owner. */
  voter: boolean;
  /** The ai-kernel service binding to this Worker's VoteRpc; absent for kernel-hosted voters. */
  vote_binding?: string;
  /**
   * When the agent works (owner 2026-11-14: "jangan pensiun aether calibrator karena cara kerjanya memang idle
   * sampai jadwalnya kerja"). A scheduled agent is quiet between its runs by design; the Supervisor judges its
   * idleness against this schedule (agent-idle.ts), not against the fixed window. See SCHEDULE_CRON.
   */
  schedule?: AgentSchedule;
}
/** `{ "cron": "52 2 * * *" }`: the agent's run, in the subset of cron that SCHEDULE_CRON accepts. */
export interface AgentSchedule { cron: string }
export interface EngineGene { task: string }
export interface Dna {
  $schema_version: number;
  service: string;
  display_name: string;
  kind: OrganKind;
  /** The deploy unit (deploy-units.ts) that ships this Worker; null for a build stub. */
  deploy_unit: string | null;
  /** In the platform Access application (provision-access.yml PLATFORM_WORKERS). */
  access: boolean;
  /** In the rollback-worker.yml allow-list. */
  rollback: boolean;
  /** How the Drift Detector observes it: a HealthRpc service binding, itself, or not at all. */
  drift: { via: "rpc"; binding: string } | { via: "self" } | null;
  agents: AgentGene[];
  engines: EngineGene[];
}

const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SERVICE = /^(cryptophys|xauusd)-[a-z0-9-]{2,60}$/;
const BINDING = /^[A-Z][A-Z0-9_]{1,62}$/;
// A capability id: two or three dot-separated segments (council.decisions.read, ADR-0014 §11, has three).
const CAPABILITY = /^[a-z]+\.[a-z_]+(\.[a-z_]+)?$/;
const TASK = /^[a-z][a-z0-9_]{2,62}$/;

/**
 * The cron subset an agent's schedule may use (five fields, UTC): a fixed minute, then
 *   "M * * * *"  hourly          "M H * * *"  daily
 *   "M H * * D"  weekly (D 0-6)  "M H d * *"  monthly (d 1-28)
 * Nothing else (no lists, ranges, steps, months or names), so the period between two runs is never ambiguous.
 */
const SCHEDULE_CRON = /^([0-5]?[0-9]) (\*|[01]?[0-9]|2[0-3]) (\*|[1-9]|1[0-9]|2[0-8]) \* (\*|[0-6])$/;
const HOUR_MS = 3_600_000;
/** The longest period a schedule may declare (a monthly run). */
export const SCHEDULE_MAX_PERIOD_MS = 31 * 24 * HOUR_MS;

/** The period between two runs of a schedule's cron, or null when the cron is outside SCHEDULE_CRON. */
export function schedulePeriodMs(cron: unknown): number | null {
  if (typeof cron !== "string") return null;
  const m = SCHEDULE_CRON.exec(cron);
  if (!m) return null;
  const [, , hour, dom, dow] = m;
  if (hour === "*") return dom === "*" && dow === "*" ? HOUR_MS : null;
  if (dom !== "*" && dow !== "*") return null;
  return dow !== "*" ? 7 * 24 * HOUR_MS : dom !== "*" ? SCHEDULE_MAX_PERIOD_MS : 24 * HOUR_MS;
}

/** Parse and validate one organism.json. Throws with the first problem found. */
export function parseDna(text: string, where = DNA_FILE): Dna {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(text); } catch { throw new Error(`${where}: not JSON`); }
  const fail = (m: string): never => { throw new Error(`${where}: ${m}`); };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("not an object");
  if (raw.$schema_version !== DNA_SCHEMA_VERSION) fail(`$schema_version must be ${DNA_SCHEMA_VERSION}`);
  if (typeof raw.service !== "string" || !SERVICE.test(raw.service)) fail("service");
  if (typeof raw.display_name !== "string" || !raw.display_name.trim() || raw.display_name.length > 80) fail("display_name");
  if (!["service", "portal", "build-stub"].includes(raw.kind as string)) fail("kind");
  if (raw.deploy_unit !== null && (typeof raw.deploy_unit !== "string" || !ID.test(raw.deploy_unit))) fail("deploy_unit");
  if (typeof raw.access !== "boolean" || typeof raw.rollback !== "boolean") fail("access/rollback");
  const drift = raw.drift as Dna["drift"];
  if (drift !== null && !(drift && typeof drift === "object" && (drift.via === "self" || (drift.via === "rpc" && BINDING.test((drift as { binding?: string }).binding ?? ""))))) fail("drift");
  if (!Array.isArray(raw.agents) || !Array.isArray(raw.engines)) fail("agents/engines");
  const agents = raw.agents as AgentGene[];
  const seen = new Set<string>();
  for (const a of agents) {
    if (!a || !ID.test(a.id) || seen.has(a.id)) fail(`agent ${a?.id}`);
    seen.add(a.id);
    if (typeof a.display_name !== "string" || !a.display_name.trim()) fail(`agent ${a.id}: display_name`);
    if (!Array.isArray(a.capabilities) || a.capabilities.some((c) => !CAPABILITY.test(c))) fail(`agent ${a.id}: capabilities`);
    if (!Number.isInteger(a.tier_max) || a.tier_max < 0 || a.tier_max > 2) fail(`agent ${a.id}: tier_max`);
    if (typeof a.voter !== "boolean") fail(`agent ${a.id}: voter`);
    if (a.vote_binding !== undefined && (!a.voter || !BINDING.test(a.vote_binding))) fail(`agent ${a.id}: vote_binding`);
    if (a.schedule !== undefined) {
      const sch = a.schedule as unknown as Record<string, unknown>;
      if (!sch || typeof sch !== "object" || Array.isArray(sch) || Object.keys(sch).some((k) => k !== "cron") || schedulePeriodMs(sch.cron) === null) fail(`agent ${a.id}: schedule`);
    }
  }
  if (agents.filter((a) => a.voter && a.vote_binding).length > 1) fail("one vote per Worker");
  const tasks = new Set<string>();
  for (const e of raw.engines as EngineGene[]) {
    if (!e || !TASK.test(e.task) || tasks.has(e.task)) fail(`engine ${e?.task}`);
    tasks.add(e.task);
  }
  if (raw.kind === "build-stub" && (raw.deploy_unit !== null || raw.access || raw.rollback || agents.length || tasks.size)) fail("a build stub has no unit, Access, rollback, agents or engines");
  return raw as unknown as Dna;
}

/** The genome: every Worker's DNA, keyed by service. */
export type Genome = Map<string, Dna>;

export function genomeFrom(entries: Array<{ path: string; text: string }>): Genome {
  const genome: Genome = new Map();
  for (const { path, text } of entries) {
    const dna = parseDna(text, path);
    if (genome.has(dna.service)) throw new Error(`${path}: service ${dna.service} declared twice`);
    genome.set(dna.service, dna);
  }
  return genome;
}

/** Derived views (what the static lists must equal). */
export const voters = (g: Genome) => [...g.values()].flatMap((d) => d.agents.filter((a) => a.voter).map((a) => a.id)).sort();
export const agentsOf = (g: Genome, service: string) => (g.get(service)?.agents ?? []).map((a) => a.id).sort();
export const servicesWhere = (g: Genome, pred: (d: Dna) => boolean) => [...g.values()].filter(pred).map((d) => d.service).sort();

/**
 * External organs (owner 2026-11-12: "DNA untuk XAUUSD dan Omega dengan auto-register"). A repository outside
 * this one declares its Workers' DNA and serves it read-only over RPC; the Forge's census reads it next to main's.
 * Such a DNA was not reviewed here, so it is held to a ceiling: only the listed services of its origin, no deploy
 * unit, Access or rollback entry of this platform, no council seat, tier 1 at most and only the capabilities below.
 * A gene above the ceiling is refused (a census finding, never a proposal); the kernel's executor checks it again.
 *
 * An origin without its own ceiling has EXTERNAL_CEILING. An origin with one (Aether, owner 2026-11-14) names the
 * exact capabilities of each of its agents; an agent of that origin it does not name has the origin's `capabilities`.
 * `proposals` lists, per agent, the only consensus actions an agent holding consensus.propose may propose.
 */
export interface ExternalCeilingSpec {
  tier_max: number;
  /** An agent of the origin not named in `agents`. */
  capabilities: readonly string[];
  agents: Readonly<Record<string, readonly string[]>>;
  proposals: Readonly<Record<string, readonly string[]>>;
}
export interface ExternalOrigin { origin: string; schema: string; binding: string; services: readonly string[]; ceiling?: ExternalCeilingSpec }
export const EXTERNAL_CEILING = Object.freeze({
  tier_max: 1,
  capabilities: Object.freeze(["signals.observe", "reports.publish", "memory.recall", "memory.remember"]),
});

/**
 * Aether's ceiling (owner 2026-11-14: "naikan batas kapabilitas aether"): exactly what its five agents hold today,
 * no more. The grants are those of migrations 0027 (guardian, auditor; reports.publish for curator and calibrator),
 * 0029 (knowledge.propose, knowledge.status for curator and calibrator) and 0045 (knowledge-council), which
 * Aether's own DNA (cryptophys-aether organism.json, aether-organism.v1) declares. knowledge-council may propose
 * the two doctrine actions and nothing else, as the kernel already enforces (ai-kernel/src/consensus.ts propose,
 * doctrine.ts DOCTRINE_ACTIONS); amend_constitution stays critical (the owner's click). An Aether agent not named
 * here has only what both ceilings allow (signals.observe, reports.publish): no memory, trading, deploy, merge or
 * fund capability, no seat, tier 1. HAIC H3e (docs/design/HAIC-H3.md §7.3; owner 2026-11-19) adds one read: the
 * curator's corrections.read (tier 0), the Aether pull of the Nexus corrections. Owner 2026-11-22 ("ya kerjakan nomor 1
 * dan semuanya") adds one more read: knowledge-council's consensus.status (tier 0), the outcome of its own proposals.
 */
export const AETHER_CEILING: ExternalCeilingSpec = Object.freeze({
  tier_max: 1,
  capabilities: Object.freeze(["signals.observe", "reports.publish"]),
  agents: Object.freeze({
    "aether-guardian": Object.freeze(["signals.observe", "reports.publish"]),
    "aether-auditor": Object.freeze(["signals.observe", "reports.publish"]),
    // HAIC H3e (docs/design/HAIC-H3.md §7.3; owner 2026-11-19): the curator pulls the Nexus corrections (read only), once
    // Aether's own DNA declares it (the census's update_agent_capabilities, routine).
    "aether-curator": Object.freeze(["reports.publish", "knowledge.propose", "knowledge.status", "corrections.read"]),
    "aether-calibrator": Object.freeze(["reports.publish", "knowledge.propose", "knowledge.status"]),
    // Owner 2026-11-22: the council reads the outcome of its own proposals (read only), once Aether's DNA declares it. Its
    // set holds the privileged consensus.propose, so the census proposes update_privileged_agent_capabilities, critical:
    // the owner's click ("Jalur klik owner (Rekomendasi)"; consensus-rules.ts, ai-kernel organism.ts).
    "knowledge-council": Object.freeze(["consensus.propose", "doctrine.status", "reports.publish", "consensus.status"]),
  }),
  proposals: Object.freeze({
    "knowledge-council": Object.freeze(["amend_doctrine", "amend_constitution"]),
  }),
});

/**
 * xauusd's ceiling (ADR-0014 §11, docs/design/EVOLVER.md §8; owner 2026-11-17: "aktifkan evolver sekarang termasuk jalur
 * balik"). Every xauusd agent keeps exactly EXTERNAL_CEILING. Only the council's moderator, which hands owner-accepted
 * council tasks to the platform, may also read their state back (council.decisions.read, tier 0, read only). No seat,
 * no proposal, tier 1, as before. HAIC H3e (docs/design/HAIC-H3.md §7.2; owner 2026-11-19): nexus-teacher, which relays
 * the owner's Nexus corrections, holds corrections.record (tier 1, learning) and only that.
 */
export const XAUUSD_CEILING: ExternalCeilingSpec = Object.freeze({
  tier_max: EXTERNAL_CEILING.tier_max,
  capabilities: EXTERNAL_CEILING.capabilities,
  agents: Object.freeze({
    "xauusd-moderator": Object.freeze([...EXTERNAL_CEILING.capabilities, "council.decisions.read"]),
    // HAIC H3e (docs/design/HAIC-H3.md §7.2; owner 2026-11-19, "Setuju semua rekomendasi"): the dedicated sender of the
    // owner's Nexus corrections (migration 0086). It holds corrections.record and nothing else, not even EXTERNAL_CEILING.
    "nexus-teacher": Object.freeze(["corrections.record"]),
  }),
  proposals: Object.freeze({}),
});

export const EXTERNAL_ORIGINS: readonly ExternalOrigin[] = Object.freeze([
  Object.freeze({
    origin: "xauusd", schema: "xauusd-organism.v1", binding: "EXT_ORGANISM_XAUUSD",
    services: Object.freeze(["xauusd-ai-trading-assistant", "xauusd-fundamental-news-ingestion", "xauusd-tradingview-pull-adapter", "xauusd-nexus-dashboard", "xauusd-omega"]),
    ceiling: XAUUSD_CEILING,
  }),
  // Owner 2026-11-14: Aether's DNA, read like xauusd's: cryptophys-aether's OrganismDna.dna() over EXT_ORGANISM_AETHER.
  Object.freeze({
    origin: "aether", schema: "aether-organism.v1", binding: "EXT_ORGANISM_AETHER",
    services: Object.freeze(["cryptophys-aether"]),
    ceiling: AETHER_CEILING,
  }),
  // Owner 2026-11-14/15 ("Buatkan aplikasi cta.cryptophys.work ... yang terhubung kernel, sebagai services/engine terpisah
  // dari xauusd-ai-trading-assistant"; "pindah content queue ke cta"): cryptophys-cta (repository cryptophys-adm/cryptophys-cta),
  // read over EXT_ORGANISM_CTA once the Forge binds it (the Worker is not deployed yet). The general EXTERNAL_CEILING applies.
  Object.freeze({
    origin: "cta", schema: "cta-organism.v1", binding: "EXT_ORGANISM_CTA",
    services: Object.freeze(["cryptophys-cta"]),
  }),
]);

/** The external origin whose services include this one, if any. */
export const externalOriginOf = (service: string): ExternalOrigin | undefined => EXTERNAL_ORIGINS.find((o) => o.services.includes(service));

/** The ceiling of one agent of an origin (EXTERNAL_CEILING when the origin has none of its own, or is not given). */
export function externalCeilingFor(origin: ExternalOrigin | undefined, agentId?: string): { tier_max: number; capabilities: readonly string[]; proposals: readonly string[] } {
  const c = origin?.ceiling;
  if (!c) return { tier_max: EXTERNAL_CEILING.tier_max, capabilities: EXTERNAL_CEILING.capabilities, proposals: [] };
  const named = agentId !== undefined && Object.hasOwn(c.agents, agentId);
  return {
    tier_max: c.tier_max,
    capabilities: named ? c.agents[agentId!] : c.capabilities,
    proposals: named && Object.hasOwn(c.proposals, agentId!) ? c.proposals[agentId!] : [],
  };
}

/** What in one gene its origin's ceiling refuses; empty when the gene is within it. Without an origin: EXTERNAL_CEILING. */
export function externalCeilingViolations(gene: { id?: string; tier_max?: number; voter?: boolean; vote_binding?: string; capabilities?: string[] }, origin?: ExternalOrigin): string[] {
  const ceiling = externalCeilingFor(origin, gene.id);
  const out: string[] = [];
  if (!Number.isInteger(gene.tier_max) || (gene.tier_max as number) > ceiling.tier_max) out.push(`tier_max ${gene.tier_max}`);
  if (gene.voter || gene.vote_binding) out.push("council seat");
  for (const c of gene.capabilities ?? []) if (!ceiling.capabilities.includes(c)) out.push(`capability ${c}`);
  return out;
}

/** Why an external origin's agent may not propose this consensus action (null when its ceiling allows it). */
export function externalProposalRefusal(origin: ExternalOrigin, agentId: string, action: string): string | null {
  const ceiling = externalCeilingFor(origin, agentId);
  if (!ceiling.capabilities.includes("consensus.propose")) return `consensus.propose is above the ${origin.origin} ceiling for ${agentId}`;
  return ceiling.proposals.includes(action) ? null : `${action} is above the ${origin.origin} ceiling for ${agentId}`;
}

export interface ExternalRefusal { kind: "external_organ_refused" | "external_agent_refused"; subject: string; detail: string }

/**
 * Parse an origin's RPC answer into organs within the ceiling. An organ that fails the DNA schema, names a
 * service outside the origin, or claims a unit, Access or rollback entry is refused whole; an agent above the
 * ceiling is dropped from its organ. Throws only when the answer is not the origin's schema at all.
 */
export function externalOrgans(origin: ExternalOrigin, raw: unknown): { organs: Dna[]; refused: ExternalRefusal[] } {
  const r = raw as { schema?: unknown; organs?: unknown };
  if (!r || typeof r !== "object" || r.schema !== origin.schema || !Array.isArray(r.organs)) throw new Error(`${origin.origin}: not ${origin.schema}`);
  const organs: Dna[] = []; const refused: ExternalRefusal[] = [];
  const seen = new Set<string>();
  for (const [i, o] of (r.organs as unknown[]).slice(0, 20).entries()) {
    let dna: Dna;
    try { dna = parseDna(JSON.stringify(o), `${origin.origin} organ ${i}`); } catch (e) {
      refused.push({ kind: "external_organ_refused", subject: `${origin.origin}:${i}`, detail: String((e as Error).message).slice(0, 200) }); continue;
    }
    const why = !origin.services.includes(dna.service) ? `${dna.service} is not a service of ${origin.origin}`
      : seen.has(dna.service) ? `${dna.service} declared twice`
      : dna.deploy_unit !== null || dna.access || dna.rollback ? `${dna.service} claims a platform deploy unit, Access or rollback entry`
      : null;
    if (why) { refused.push({ kind: "external_organ_refused", subject: dna.service, detail: why }); continue; }
    seen.add(dna.service);
    const agents = dna.agents.filter((a) => {
      const v = externalCeilingViolations(a, origin);
      if (v.length) refused.push({ kind: "external_agent_refused", subject: a.id, detail: `agent ${a.id} on ${dna.service} is above the external ceiling: ${v.join(", ")}`.slice(0, 300) });
      return v.length === 0;
    });
    organs.push({ ...dna, agents });
  }
  return { organs, refused };
}
