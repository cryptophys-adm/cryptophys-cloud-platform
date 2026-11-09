/**
 * ADR-0012 §4, phase 4 backlog (owner, 2026-11-08): Worker secrets move to Cloudflare Secrets Store.
 * During the move a secret may be either form:
 *   - a plain Worker secret, read synchronously as `env.NAME` (today);
 *   - a Secrets Store binding `NAME_STORE` ([[secrets_store_secrets]], `await env.NAME_STORE.get()`).
 * The entry points resolve both once per invocation into a copy of `env` where `NAME` is a string,
 * so the code that reads `env.NAME` does not change. The store binding wins when it answers; a
 * failing or empty store binding falls back to the Worker secret, so the switch is reversible until
 * the owner deletes the old Worker secrets. Values are never logged.
 */
export interface SecretsStoreSecret { get(): Promise<string> }

const isStore = (v: unknown): v is SecretsStoreSecret => Boolean(v) && typeof (v as SecretsStoreSecret).get === "function";

export type SecretSource = "secrets_store" | "worker_secret" | "missing";

/** A copy of `env` in which each named secret is a plain string, read from its Secrets Store binding when there is one. */
export async function resolveSecrets<E extends object>(env: E, names: readonly string[]): Promise<E> {
  const record = env as Record<string, unknown>;
  if (!names.some((n) => isStore(record[`${n}_STORE`]))) return env;
  const out: Record<string, unknown> = { ...record };
  await Promise.all(names.map(async (name) => {
    const store = record[`${name}_STORE`];
    if (!isStore(store)) return;
    try {
      const value = await store.get();
      if (typeof value === "string" && value.trim()) out[name] = value;
    } catch { /* keep the Worker secret, if any */ }
  }));
  return out as E;
}

/** Where each named secret comes from, for readiness output (never the value). */
export function secretSources(env: object, names: readonly string[]): Record<string, SecretSource> {
  const record = env as Record<string, unknown>;
  return Object.fromEntries(names.map((n) => [n, isStore(record[`${n}_STORE`]) ? "secrets_store" : typeof record[n] === "string" && (record[n] as string) ? "worker_secret" : "missing"]));
}
