/**
 * The consensus modes in which a critical proposal waits for, and executes after, the owner's approval click.
 * Mirrors OWNER_CLICK_MODES in workers/ai-kernel/src/consensus.ts (owner 2026-11-13: "Tombol muncul di mode
 * deploy"). The kernel decides; this only shows the button where the kernel would accept the click.
 */
export const OWNER_CLICK_MODES: readonly string[] = ["deploy", "critical"];

export function ownerClickMode(mode: string | null | undefined): boolean {
  return typeof mode === "string" && OWNER_CLICK_MODES.includes(mode);
}
