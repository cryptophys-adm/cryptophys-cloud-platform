// The platform's guard paths: changes that stay with the owner under ADR-0012 §2.4, extended by ADR-0014 §3
// (the evolution loop's own limits, the evolver's registration and capabilities, and the GitHub workflows and
// scripts) and by ADR-0016 §1 (the vision's core and its schema). The Forge's merge verdict (forge/src/changes.ts criticalReasons) and the evolver's refusals
// (evolution-limits.ts) read this one list, so the two can never disagree about what is guarded.
//
// This file is itself a guard path.

export const CRITICAL_PATHS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^workers\/control-plane-shared\/src\/access\.ts$/, "auth_access"],
  [/^\.github\/workflows\/provision-access\.yml$/, "auth_access"],
  [/^\.github\/scripts\/(access-[a-z-]+|resolve-access|find-service-token|find-agent-service-tokens|bootstrap-private-worker)\.sh$/, "auth_access"],
  [/^workers\/policy-engine\//, "policy_engine"],
  [/^workers\/control-plane-shared\/src\/consensus-(rules|exec|vote)\.ts$/, "consensus_kill_switch"],
  [/^\.github\/scripts\/remove-worker-secrets\.sh$/, "secrets"],
  [/^workers\/control-plane-shared\/src\/secrets\.ts$/, "secrets"],
  [/^architecture\/adr\/00(09|12)-/, "adr_0009_0012"],
  // ADR-0012 §5d: a change request's type-check runs its own code, so a change to the harness is the owner's.
  [/^workers\/forge-typecheck(-cr)?\//, "typecheck_harness"],
  [/^workers\/(control-plane-tsconfig\.json|forge\/src\/cr-builds\.ts)$/, "typecheck_harness"],
  [/^workers\/(control-plane-shared|console\/ui)\/(package(-lock)?\.json|tsconfig[^/]*\.json|vite\.config\.[a-z]+)$/, "typecheck_harness"],
  // ADR-0014 §3: the evolution loop's own guards.
  [/^architecture\/adr\/0014-/, "evolution_guard"],
  [/^workers\/control-plane-shared\/src\/(evolution-limits|guard-paths|capabilities)\.ts$/, "evolution_guard"],
  [/^workers\/ai-kernel\/(organism\.json|src\/evolver\.ts)$/, "evolution_guard"],
  [/^workers\/forge\/src\/(evolution|git-write)\.ts$/, "evolution_guard"],
  // ADR-0016 §1 (Telos): the vision's core (mission, identity, constitution) and its schema are the owner's; an
  // amendment, including one the Strategist proposes, takes effect only through merge_owner_change.
  [/^organism\/vision\.json$/, "vision_core"],
  [/^workers\/control-plane-shared\/src\/vision\.ts$/, "vision_core"],
];

/** The guard-path reason of one repository path, or null for a routine path. */
export function criticalPathReason(path: string): string | null {
  for (const [re, reason] of CRITICAL_PATHS) if (re.test(path)) return reason;
  return null;
}
