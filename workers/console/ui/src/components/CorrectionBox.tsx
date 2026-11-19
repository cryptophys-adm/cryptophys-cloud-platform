import { useState } from "react";
import { useSession } from "../lib/session";

/**
 * HAIC H3c (docs/design/HAIC-H3.md §3, §11 step 3; owner 2026-11-19, "Setuju semua rekomendasi"): the owner's
 * correction of one agent output (a council's message, claim or option, or a typed proposal), like the Ask page's note:
 * an optional category and a short note, kept as the owner's correction (weight 3). It decides nothing: no pick, no
 * confirmation, no approval. The kernel resolves the target and whose output it is; a secret is redacted, never refused.
 * The page passes `submit`, which names the route; owners only (the kernel refuses anyone else).
 */

/** The correction.v1 categories (control-plane-shared/src/correction.ts CORRECTION_CATEGORIES; test H3c-10 keeps them equal). */
export const CORRECTION_CATEGORIES = [
  "reading_wrong", "invalidation_too_tight", "invalidation_too_loose", "evidence_wrong", "evidence_missing",
  "overconfident", "underconfident", "rule_broken", "good_call", "other",
] as const;

export function CorrectionBox({ what, submit }: { what: string; submit: (body: { category?: string; text?: string }) => Promise<any> }) {
  const { notify } = useSession();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState("");
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  if (!open) {
    return <button type="button" className="text-[10px] text-slate-500 hover:text-cyan-300 hover:underline" onClick={() => setOpen(true)} title={`Correct ${what}`}>Correct…</button>;
  }
  const note = text.trim();
  const send = () => {
    if (sending || (!note && !category)) return;
    setSending(true);
    submit({ category: category || undefined, text: note || undefined })
      .then((d) => { notify("ok", d?.deduplicated ? "Already recorded." : "Correction recorded."); setText(""); setCategory(""); setOpen(false); })
      .catch((e) => notify("err", e.message))
      .finally(() => setSending(false));
  };
  return (
    <div className="mt-1.5 flex w-full basis-full flex-wrap items-center gap-1.5">
      <select className="field w-auto! px-2! py-0.5! text-[10px]!" value={category} onChange={(e) => setCategory(e.target.value)} aria-label={`Correction category for ${what}`}>
        <option value="">category (optional)</option>
        {CORRECTION_CATEGORIES.map((c) => <option key={c} value={c}>{c.replace(/_/g, " ")}</option>)}
      </select>
      <input type="text" className="field min-w-0 flex-1 px-2! py-0.5! text-[10px]!" maxLength={500} placeholder="what was wrong (optional)" aria-label={`Correction note for ${what}`}
        title="Kept as your correction (at most 500 characters; a secret is redacted)" value={text} onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") send(); }} disabled={sending} />
      <button type="button" className="btn px-2! py-0.5! text-[10px]!" onClick={send} disabled={sending || (!note && !category)}>Submit</button>
      <button type="button" className="text-[10px] text-slate-500 hover:text-slate-300" onClick={() => setOpen(false)}>Cancel</button>
    </div>
  );
}
