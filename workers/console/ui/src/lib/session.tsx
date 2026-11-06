import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, X, AlertTriangle } from "lucide-react";
import { call, phraseFor, type Json } from "./api";
import ConfirmModal from "../components/ConfirmModal";

export interface Who { actor: string; type: string; operator: boolean; approver: boolean }
interface Toast { id: number; tone: "ok" | "err"; text: string }
interface ActOptions {
  route: string; params?: string | string[]; body?: Json; query?: Record<string, string>;
  title: string; lines?: string[]; done?: string;
  after?: (data: Json) => void; onError?: (e: Error) => void;
}
interface Session { who: Who; act: (o: ActOptions) => void; notify: (tone: "ok" | "err", text: string) => void }

const Ctx = createContext<Session | null>(null);
export const useSession = () => {
  const s = useContext(Ctx);
  if (!s) throw new Error("no session");
  return s;
};

export function SessionProvider({ who, children }: { who: Who; children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pending, setPending] = useState<(ActOptions & { phrase: string }) | null>(null);

  const notify = useCallback((tone: "ok" | "err", text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "err" ? 12000 : 5000);
  }, []);

  const run = useCallback((o: ActOptions) => {
    call(o.route, o.params, o.body, o.query)
      .then((data) => { notify("ok", o.done ?? "Done."); o.after?.(data); })
      .catch((e: Error) => { notify("err", e.message); o.onError?.(e); });
  }, [notify]);

  const act = useCallback((o: ActOptions) => {
    const phrase = phraseFor(o.route, o.params, o.body);
    if (phrase === null) run(o);
    else setPending({ ...o, phrase });
  }, [run]);

  return (
    <Ctx.Provider value={{ who, act, notify }}>
      {children}
      {pending && (
        <ConfirmModal title={pending.title} lines={pending.lines ?? []} phrase={pending.phrase}
          onCancel={() => setPending(null)} onConfirm={() => { const p = pending; setPending(null); run(p); }} />
      )}
      <div className="pointer-events-none fixed bottom-16 right-4 z-50 flex w-[min(420px,calc(100vw-2rem))] flex-col gap-2" aria-live="polite">
        <AnimatePresence>
          {toasts.map((t) => (
            <motion.div key={t.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 8 }}
              role={t.tone === "err" ? "alert" : "status"}
              className={`pointer-events-auto flex items-start gap-2 rounded-xl border px-3 py-2 text-[12px] backdrop-blur ${t.tone === "err" ? "border-rose-400/30 bg-rose-950/80 text-rose-200" : "border-emerald-400/30 bg-emerald-950/80 text-emerald-200"}`}>
              {t.tone === "err" ? <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              <span className="flex-1 break-words">{t.text}</span>
              <button type="button" aria-label="Dismiss" className="opacity-60 hover:opacity-100" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}><X className="h-3.5 w-3.5" /></button>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  );
}
