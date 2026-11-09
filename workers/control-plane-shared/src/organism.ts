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
}
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
const CAPABILITY = /^[a-z]+\.[a-z_]+$/;
const TASK = /^[a-z][a-z0-9_]{2,62}$/;

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
