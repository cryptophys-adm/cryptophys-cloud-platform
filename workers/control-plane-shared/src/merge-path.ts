// ADR-0012 G3b (cut-over step 4): where main of the platform moves.
//   github  GitHub merges pull requests and mirror-to-forge.yml copies main to the Forge (today);
//   forge   the Forge fast-forwards canonical main itself, after a consensus merge_change (or, for a change that
//           touches a guard path, merge_owner_change and the owner's click). Nothing else writes main.
// The switch is a row of forge_controls (migration 0057), flipped by a reviewed migration at the cut-over. A table
// that does not exist yet, an unknown value or a failed read all mean github: the Forge never merges by default.
import type { D1Database } from "./types.ts";

export type MergePath = "github" | "forge";

export async function mergePath(db: D1Database): Promise<MergePath> {
  try {
    const row = await db.prepare("SELECT value FROM forge_controls WHERE control = 'merge_path'").first<{ value: string }>();
    return row?.value === "forge" ? "forge" : "github";
  } catch {
    return "github";
  }
}

/** The state of one change request, as the Forge computes it for a merge vote (MergeRpc.changeState). */
export interface ChangeEvidence {
  cr_id: string;
  status: string;
  source: string;
  head_sha: string;
  verdict: string;
  reasons: string[];
  /** canonical main's head, read from the platform repository at vote time. */
  main_sha: string | null;
  /** whether the head contains that main (so the merge is a fast-forward). */
  contains_main: boolean;
}
