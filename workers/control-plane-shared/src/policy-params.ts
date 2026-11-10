/**
 * Policy Engine parameters the Cerebrum council may change by consensus (owner 2026-11-10: "Policy
 * Engine boleh dimodifikasi oleh cerebrum council", answer "Parameter, consensus saja").
 *
 * Only these numeric parameters are adjustable, and only inside the hard bounds below, which live in
 * reviewed code and never in the database. Everything else in the Policy Engine stays code: no
 * trading or funds, the owner click for critical actions, the kill switch, mode shadow and Access.
 * A value in policy_parameters (migration 0044) outside the bounds is clamped, never trusted.
 */
import type { D1Database } from "./types.ts";

export const POLICY_PARAMETERS = {
  "daily-deploy-limit": { default: 10, min: 1, max: 20, description: "Executed deploys or rollbacks per 24 h across the platform" },
  "target-actions-per-hour": { default: 1, min: 1, max: 3, description: "Executed actions per action and target per hour" },
} as const;
export type PolicyParameter = keyof typeof POLICY_PARAMETERS;

export const isPolicyParameter = (name: string): name is PolicyParameter => Object.hasOwn(POLICY_PARAMETERS, name);

/** A proposed value is valid when it is an integer inside the parameter's hard bounds. */
export function validPolicyValue(name: string, value: unknown): value is number {
  if (!isPolicyParameter(name)) return false;
  const p = POLICY_PARAMETERS[name];
  return typeof value === "number" && Number.isInteger(value) && value >= p.min && value <= p.max;
}

export async function readPolicyParameter(db: D1Database, name: PolicyParameter): Promise<number> {
  const p = POLICY_PARAMETERS[name];
  try {
    const row = await db.prepare("SELECT value FROM policy_parameters WHERE name = ?").bind(name).first<{ value: number }>();
    const v = Number(row?.value);
    if (!Number.isInteger(v)) return p.default;
    return Math.min(p.max, Math.max(p.min, v));
  } catch {
    return p.default; // before migration 0044
  }
}
