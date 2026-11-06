import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ShieldAlert } from "lucide-react";

/** Typed confirmation: the button enables only on the exact phrase; Tab is trapped, Esc cancels. */
export default function ConfirmModal({ title, lines, phrase, onCancel, onConfirm }: {
  title: string; lines: string[]; phrase: string; onCancel: () => void; onConfirm: () => void;
}) {
  const [typed, setTyped] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const previous = useRef<Element | null>(document.activeElement);
  useEffect(() => {
    input.current?.focus();
    const prev = previous.current;
    return () => { (prev as HTMLElement | null)?.focus?.(); };
  }, []);
  const ok = typed === phrase;

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") { onCancel(); return; }
    if (e.key !== "Tab" || !box.current) return;
    const f = box.current.querySelectorAll<HTMLElement>("button:not([disabled]), input");
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onKeyDown={onKey}>
      <motion.div ref={box} role="dialog" aria-modal="true" aria-labelledby="confirm-title"
        initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }}
        className="w-full max-w-[480px] rounded-2xl border border-rose-400/20 bg-[#0b0f18] p-5 shadow-[0_0_60px_rgba(244,63,94,0.12)]">
        <div className="mb-3 flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 text-rose-300" />
          <h2 id="confirm-title" className="text-sm font-semibold text-white">{title}</h2>
        </div>
        <div className="space-y-1.5 text-[12px] text-slate-400">{lines.map((l, i) => <p key={i}>{l}</p>)}</div>
        <p className="mt-3 text-[12px] text-slate-400">Type <span className="mono rounded bg-white/5 px-1.5 py-0.5 text-cyan-200">{phrase}</span> to continue.</p>
        <label className="mt-2 block">
          <span className="label">Confirmation phrase</span>
          <input ref={input} className="field mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          <button type="button" className="btn btn-danger" disabled={!ok} onClick={() => ok && onConfirm()}>Confirm</button>
        </div>
      </motion.div>
    </div>
  );
}
