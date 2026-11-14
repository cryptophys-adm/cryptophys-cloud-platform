// ADR-0016 (Telos) T0: the schema of the organism's living vision, `organism/vision.json` (organism.vision.v1).
//
// Two layers. The core (mission, identity, constitution) is the owner's: this file and the vision are guard paths
// (guard-paths.ts, reason "vision_core"), so a change to either is a merge_owner_change. The growth layer holds the
// goals and their KPIs; a KPI that has not been measured yet carries null, never a default number.
//
// visionProblems() is pure: it returns every problem it finds, or an empty list for a valid vision. CI validates
// organism/vision.json with it, and the AI Kernel checks it again before serving GET /v1/vision.
//
// This file is itself a guard path.

export const VISION_SCHEMA = "organism.vision.v1";
export const VISION_HORIZONS = ["now", "quarter", "year"] as const;
export type VisionHorizon = (typeof VISION_HORIZONS)[number];
export const GOAL_ID = /^g-[a-z0-9-]+$/;

export interface VisionKpi {
  id: string;
  /** The measured starting value; null until it has been measured. */
  baseline: number | null;
  /** A number, a direction or rule in words ("decreasing", "monthly pass"), or null until the owner sets one. */
  target: number | string | null;
  /** Where the measurement comes from (a table, an organ, an API). */
  source: string;
}

export interface VisionGoal {
  id: string;
  horizon: VisionHorizon;
  organs: string[];
  kpis: VisionKpi[];
  evidence: string;
  hypotheses?: string[];
}

export interface Vision {
  $comment?: string;
  schema: typeof VISION_SCHEMA;
  core: {
    mission: string;
    identity: { core_organ: string; organs: string[] };
    constitution: string[];
  };
  growth: { goals: VisionGoal[] };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function unknownKeys(o: Record<string, unknown>, allowed: readonly string[], at: string, out: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) out.push(`${at}.${k}: unknown field`);
}

function textList(v: unknown, at: string, out: string[], nonEmpty: boolean): void {
  if (!Array.isArray(v)) { out.push(`${at}: must be an array of strings`); return; }
  if (nonEmpty && v.length === 0) out.push(`${at}: must not be empty`);
  v.forEach((s, i) => { if (!isText(s)) out.push(`${at}[${i}]: must be a non-empty string`); });
}

function kpiProblems(k: unknown, at: string, out: string[]): void {
  if (!isObject(k)) { out.push(`${at}: must be an object`); return; }
  unknownKeys(k, ["id", "baseline", "target", "source"], at, out);
  if (!isText(k.id)) out.push(`${at}.id: must be a non-empty string`);
  if (!("baseline" in k)) out.push(`${at}.baseline: required (null when not measured yet)`);
  else if (k.baseline !== null && !isNumber(k.baseline)) out.push(`${at}.baseline: must be a number or null`);
  if (!("target" in k)) out.push(`${at}.target: required (null when not set yet)`);
  else if (k.target !== null && !isNumber(k.target) && !isText(k.target)) out.push(`${at}.target: must be a number, a non-empty string or null`);
  if (!isText(k.source)) out.push(`${at}.source: must be a non-empty string`);
}

function goalProblems(g: unknown, at: string, out: string[]): void {
  if (!isObject(g)) { out.push(`${at}: must be an object`); return; }
  unknownKeys(g, ["id", "horizon", "organs", "kpis", "evidence", "hypotheses"], at, out);
  if (typeof g.id !== "string" || !GOAL_ID.test(g.id)) out.push(`${at}.id: must match ${GOAL_ID}`);
  if (!(VISION_HORIZONS as readonly unknown[]).includes(g.horizon)) out.push(`${at}.horizon: must be one of ${VISION_HORIZONS.join(", ")}`);
  textList(g.organs, `${at}.organs`, out, true);
  if (!Array.isArray(g.kpis) || g.kpis.length === 0) out.push(`${at}.kpis: must be a non-empty array`);
  else {
    const seen = new Set<string>();
    g.kpis.forEach((k, i) => {
      kpiProblems(k, `${at}.kpis[${i}]`, out);
      const id = isObject(k) ? k.id : undefined;
      if (typeof id === "string") { if (seen.has(id)) out.push(`${at}.kpis[${i}].id: duplicate "${id}" in this goal`); seen.add(id); }
    });
  }
  if (!isText(g.evidence)) out.push(`${at}.evidence: must be a non-empty string`);
  if ("hypotheses" in g) textList(g.hypotheses, `${at}.hypotheses`, out, false);
}

/** Every problem of a candidate vision (organism.vision.v1); empty when it is valid. */
export function visionProblems(v: unknown): string[] {
  const out: string[] = [];
  if (!isObject(v)) return ["vision: must be a JSON object"];
  unknownKeys(v, ["$comment", "schema", "core", "growth"], "vision", out);
  if ("$comment" in v && typeof v.$comment !== "string") out.push("vision.$comment: must be a string");
  if (v.schema !== VISION_SCHEMA) out.push(`vision.schema: must be "${VISION_SCHEMA}"`);

  const core = v.core;
  if (!isObject(core)) out.push("core: must be an object");
  else {
    unknownKeys(core, ["mission", "identity", "constitution"], "core", out);
    if (!isText(core.mission)) out.push("core.mission: must be a non-empty string");
    const id = core.identity;
    if (!isObject(id)) out.push("core.identity: must be an object");
    else {
      unknownKeys(id, ["core_organ", "organs"], "core.identity", out);
      if (!isText(id.core_organ)) out.push("core.identity.core_organ: must be a non-empty string");
      textList(id.organs, "core.identity.organs", out, true);
    }
    textList(core.constitution, "core.constitution", out, true);
  }

  const growth = v.growth;
  if (!isObject(growth)) out.push("growth: must be an object");
  else {
    unknownKeys(growth, ["goals"], "growth", out);
    if (!Array.isArray(growth.goals)) out.push("growth.goals: must be an array");
    else {
      const seen = new Set<string>();
      growth.goals.forEach((g, i) => {
        goalProblems(g, `growth.goals[${i}]`, out);
        const gid = isObject(g) ? g.id : undefined;
        if (typeof gid === "string") { if (seen.has(gid)) out.push(`growth.goals[${i}].id: duplicate "${gid}"`); seen.add(gid); }
      });
    }
  }
  return out;
}

/** The vision, typed, when it is valid; null otherwise. */
export function parseVision(v: unknown): Vision | null {
  return visionProblems(v).length === 0 ? (v as Vision) : null;
}
