// The platform's guard paths: changes that stay with the owner under ADR-0012 §2.4, extended by ADR-0014 §3
// (the evolution loop's own limits, the evolver's registration and capabilities, and the GitHub workflows and
// scripts), by ADR-0016 §1 (the vision's core and its schema) and by the owner's learning mandate (2026-11-14,
// power-mode.ts). The Forge's merge verdict (forge/src/changes.ts criticalReasons) and the evolver's refusals
// (evolution-limits.ts) read this one list, so the two can never disagree about what is guarded.
//
// This file is itself a guard path.

export const CRITICAL_PATHS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^workers\/control-plane-shared\/src\/access\.ts$/, "auth_access"],
  [/^\.github\/workflows\/provision-access\.yml$/, "auth_access"],
  [/^\.github\/scripts\/(access-[a-z-]+|resolve-access|find-service-token|find-agent-service-tokens|bootstrap-private-worker)\.sh$/, "auth_access"],
  // Owner 2026-11-16: the native source of the identity lists replaces access-identities.sh after the cut-over. The rules
  // of a valid list, its owner-only write and the native deploy that writes the values decide who operates and approves.
  [/^workers\/control-plane-shared\/src\/identity-source\.ts$/, "auth_access"],
  [/^workers\/platform-registry\/src\/identities\.ts$/, "auth_access"],
  [/^workers\/deployment-orchestrator\/src\/deploy-vars\.ts$/, "auth_access"],
  [/^workers\/policy-engine\//, "policy_engine"],
  [/^workers\/control-plane-shared\/src\/consensus-(rules|exec|vote)\.ts$/, "consensus_kill_switch"],
  // HAIC H4 (owner 2026-11-18): the autonomy dial lowers what consensus may execute; its rules are the consensus's own.
  [/^workers\/control-plane-shared\/src\/autonomy-dial\.ts$/, "consensus_kill_switch"],
  // Review 2026-11-22: the census executors (a privileged agent's capability change keeps only the privileged capabilities
  // it already holds) are the consensus's own rules too.
  [/^workers\/ai-kernel\/src\/organism\.ts$/, "consensus_kill_switch"],
  [/^\.github\/scripts\/remove-worker-secrets\.sh$/, "secrets"],
  [/^workers\/control-plane-shared\/src\/secrets\.ts$/, "secrets"],
  [/^architecture\/adr\/00(09|12)-/, "adr_0009_0012"],
  // ADR Steward Q2 (owner 2026-11-16, "ya semua, sesuai rekomendasimu"): the progress manifest of a guarded ADR says how
  // its gates are measured, so it is guarded with the ADR, under the same reason (docs/design/ADR-STEWARD.md §2.1).
  [/^architecture\/adr\/progress\/00(09|12)\.json$/, "adr_0009_0012"],
  // ADR-0012 §5d: a change request's type-check runs its own code, so a change to the harness is the owner's.
  [/^workers\/forge-typecheck(-cr)?\//, "typecheck_harness"],
  [/^workers\/(control-plane-tsconfig\.json|forge\/src\/cr-builds\.ts)$/, "typecheck_harness"],
  [/^workers\/(control-plane-shared|console\/ui)\/(package(-lock)?\.json|tsconfig[^/]*\.json|vite\.config\.[a-z]+|build\.mjs)$/, "typecheck_harness"],
  // ADR-0014 §3: the evolution loop's own guards.
  [/^architecture\/adr\/0014-/, "evolution_guard"],
  [/^architecture\/adr\/progress\/0014\.json$/, "evolution_guard"],
  [/^workers\/control-plane-shared\/src\/(evolution-limits|guard-paths|capabilities)\.ts$/, "evolution_guard"],
  [/^workers\/ai-kernel\/(organism\.json|src\/evolver\.ts)$/, "evolution_guard"],
  [/^workers\/forge\/src\/(evolution|git-write)\.ts$/, "evolution_guard"],
  // ADR-0016 §1 (Telos): the vision's core (mission, identity, constitution) and its schema are the owner's; an
  // amendment, including one the Strategist proposes, takes effect only through merge_owner_change.
  [/^organism\/vision\.json$/, "vision_core"],
  [/^workers\/control-plane-shared\/src\/vision\.ts$/, "vision_core"],
  // Owner 2026-11-14 ("naikan batas kapabilitas aether"): the external capability ceilings (the general one and
  // Aether's per-agent one) live in organism.ts; raising any of them is the owner's, never a routine merge.
  [/^workers\/control-plane-shared\/src\/organism\.ts$/, "capability_ceiling"],
  // Review 2026-11-22: consensus.status scopes the read to the caller's own proposals; widening it reveals other agents'.
  [/^workers\/ai-kernel\/src\/consensus-status\.ts$/, "capability_ceiling"],
  // Hardening (d), 2026-11-14: the break-glass deploy bypasses the deploy planner, so its rules are the owner's.
  [/^workers\/control-plane-shared\/src\/break-glass\.ts$/, "break_glass"],
  [/^workers\/deployment-orchestrator\/src\/recovery-deploy\.ts$/, "break_glass"],
  // Cut-over gate 2026-11-15: the rescue executor deploys the Orchestrator's Worker from the Recovery Manager with its
  // own Workers Scripts Edit credential, bypassing the Orchestrator; its rules are the owner's as well.
  [/^workers\/control-plane-shared\/src\/executor-rescue\.ts$/, "break_glass"],
  // The learning mandate (owner 2026-11-14, "learning tidak boleh dibatasi siapa pun, itu adalah mandat tertinggi"):
  // power-mode.ts says what learning is and that no mode, budget or rate limit applies to it. No agent or evolver
  // reintroduces a learning limit there without the owner's click.
  [/^workers\/control-plane-shared\/src\/power-mode\.ts$/, "learning_mandate"],
  // The learning mandate's invariant tests: a limit put back in knowledge.ts, memory.ts or ai-engine.ts fails them,
  // and the tests themselves change only by the owner's click.
  [/^workers\/control-plane-shared\/test\/learning-(mandate|observe)-2026-11-14\.test\.ts$/, "learning_mandate"],
];

/** The guard-path reason of one repository path, or null for a routine path. */
export function criticalPathReason(path: string): string | null {
  for (const [re, reason] of CRITICAL_PATHS) if (re.test(path)) return reason;
  return null;
}
