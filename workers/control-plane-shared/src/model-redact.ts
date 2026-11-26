// Review 2026-11-26 (chat flex, item c): Beam is an outside provider, so no person's email may leave the platform in a
// model's input. redactForModel runs in the AI engine over every task's input (tool results, history turns, evidence)
// after redact() and before any model call, Beam and Workers AI alike. An email becomes a role word: "the owner" for
// an owner (APPROVER_IDENTITIES), "an operator" for anyone else. Client IDs, refs and every other value are unchanged.

/** An email address. A ref such as ev:platform/owner_inbox@2026-11-26T09:00:00.000Z is not one (no letter TLD). */
export const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g;
export const OWNER_WORD = "the owner";
export const OPERATOR_WORD = "an operator";
const MAX_DEPTH = 12;

/** The owners of a comma list (APPROVER_IDENTITIES), lower case. */
export function ownersOf(list: unknown): Set<string> {
  return new Set(String(typeof list === "string" ? list : "").split(",").map((v) => v.trim().toLowerCase()).filter((v) => v.includes("@")));
}

/** The text with every email replaced by its role word. */
export function redactEmails(text: string, owners: ReadonlySet<string> = new Set()): string {
  return text.replace(EMAIL_PATTERN, (m) => (owners.has(m.toLowerCase()) ? OWNER_WORD : OPERATOR_WORD));
}

/** A copy of `value` with every email in a string (or a key) replaced by its role word, at any depth. */
export function redactForModel(value: unknown, owners: ReadonlySet<string> = new Set(), depth = 0): unknown {
  if (typeof value === "string") return redactEmails(value, owners);
  if (value === null || typeof value !== "object") return value;
  if (depth > MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => redactForModel(v, owners, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[redactEmails(k, owners)] = redactForModel(v, owners, depth + 1);
  return out;
}
