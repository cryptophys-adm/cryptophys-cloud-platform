import { AnimatePresence, motion } from "framer-motion";
import { Radio } from "lucide-react";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { ago, listOf } from "../lib/format";
import { Dot } from "./ui";

function tone(outcome?: string): "green" | "amber" | "red" | "cyan" {
  if (!outcome) return "cyan";
  if (/(fail|deny|denied|error|invalid)/i.test(outcome)) return "red";
  if (/(suspend|disabled|drift|warn)/i.test(outcome)) return "amber";
  return "green";
}

/** Live audit-chain stream: every action in the mesh, newest first (60 s refresh). */
export default function LiveEventBus({ limit = 18 }: { limit?: number }) {
  const { data, error, loading } = usePoll(() => call("audit.events", undefined, undefined, { limit: String(limit) }), 60_000);
  const events = listOf(data, "events");
  return (
    <div className="glass flex min-h-0 flex-1 flex-col p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="eyebrow flex items-center gap-2"><Radio className="h-3 w-3 text-violet-300" />Live Event Bus</div>
        <Dot tone={error ? "red" : "green"} pulse={!error} />
      </div>
      {loading && !data ? <div className="animate-pulse space-y-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-8 rounded-lg bg-white/5" />)}</div>
        : error && !data ? <p className="text-[12px] text-rose-300">Audit ledger unreachable.</p>
        : (
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
            <AnimatePresence initial={false}>
              {events.map((e: any) => (
                <motion.a key={e.event_id} href="#/ledger" layout initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }}
                  className="glass-inner flex items-start gap-2 px-2.5 py-2 text-[11px] transition hover:border-white/15">
                  <span className="mt-1"><Dot tone={tone(e.outcome)} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex justify-between gap-2"><span className="mono truncate text-[10px] text-cyan-300">{e.event_type}</span><span className="shrink-0 text-[9px] text-slate-600">{ago(e.created_at)}</span></div>
                    <div className="mt-0.5 truncate text-[10px] text-slate-500">{e.actor} → {e.subject}{e.outcome ? ` · ${e.outcome}` : ""}</div>
                  </div>
                </motion.a>
              ))}
            </AnimatePresence>
          </div>
        )}
    </div>
  );
}
