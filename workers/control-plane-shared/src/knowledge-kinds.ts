// Owner 2026-11-13 ("Batasi User/Owner hanya untuk critical dan permintaan approval only"; #310): learned-knowledge
// text proposals (a caution, a role reminder) run by themselves, with an optional veto; only the kinds that change a
// parameter still need the owner's approval. This is the one definition: the AI Kernel's owner notice and Owner inbox
// (ai-kernel/src/owner-inbox.ts) import it, and the Console's Knowledge page holds the same set, checked by
// test/owner-inbox.test.ts.

/** Knowledge proposal kinds that need no approval: they run unless an approver vetoes them. */
export const AUTONOMOUS_KNOWLEDGE_KINDS = ["caution", "role_reminder"] as const;

/** A pending proposal whose kind still needs the owner's approval (today: param_candidate). */
export function knowledgeNeedsOwner(p: { status?: unknown; kind?: unknown } | null | undefined): boolean {
  return p?.status === "pending" && !(AUTONOMOUS_KNOWLEDGE_KINDS as readonly unknown[]).includes(p?.kind);
}
