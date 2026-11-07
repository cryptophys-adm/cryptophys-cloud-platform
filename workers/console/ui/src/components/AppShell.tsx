import { useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import {
  Activity, Bot, Brain, CandlestickChart, ChevronRight, Database, GitBranch, Menu, Scale, Server, ShieldCheck,
  Sparkles, Terminal, Wrench, X, ExternalLink, Home, Gavel, Users,
} from "lucide-react";
import { useSession } from "../lib/session";
import { useOverview } from "../lib/overview";
import { Dot } from "./ui";
import CognitionPanel from "./CognitionPanel";
import LiveEventBus from "./LiveEventBus";
import { ago } from "../lib/format";

export const NAV = [
  { label: "Command", href: "#/", key: "", icon: Terminal },
  { label: "AI Mesh", href: "#/agents", key: "agents", icon: Bot },
  { label: "Cognition", href: "#/cognition", key: "cognition", icon: Brain },
  { label: "Consensus", href: "#/consensus", key: "consensus", icon: Gavel },
  { label: "Recovery", href: "#/recovery", key: "recovery", icon: Wrench },
  { label: "Infrastructure", href: "#/infrastructure", key: "infrastructure", icon: Server },
  { label: "Policy", href: "#/policy", key: "policy", icon: Scale },
  { label: "Ledger", href: "#/ledger", key: "ledger", icon: Database },
  { label: "Pipelines", href: "#/pipelines", key: "pipelines", icon: GitBranch },
  { label: "Markets", href: "#/markets", key: "markets", icon: CandlestickChart },
  { label: "Users", href: "#/users", key: "users", icon: Users },
];

function PriorityQueue() {
  const { ov, loading } = useOverview();
  const items: { id: string; label: string; tone: "red" | "amber" | "green"; href?: string }[] = [];
  if (ov) {
    if (ov.agents_enabled === false) items.push({ id: "kill", label: "Kill switch engaged: all agents stopped", tone: "red", href: "#/" });
    for (const c of ov.agent_reports_24h?.latest_critical ?? []) items.push({ id: c.report_id, label: `Critical report · ${c.agent_id} · ${c.kind}`, tone: "red", href: "#/cognition" });
    for (const s of (ov.services ?? []).filter((x) => x.drifted)) items.push({ id: s.service_id, label: `Drift · ${s.service_id}${s.persistent ? " (persistent)" : ""}`, tone: s.persistent ? "red" : "amber", href: "#/infrastructure" });
    for (const p of ov.open_agent_plans ?? []) items.push({ id: p.plan_id, label: `Approval pending · ${p.service_id ?? p.plan_id}`, tone: "amber", href: `#/recovery/${p.plan_id}` });
    if (!items.length) items.push({ id: "ok", label: "No open items. The mesh is nominal.", tone: "green" });
  }
  return (
    <div className="glass p-4">
      <div className="eyebrow mb-3">Priority Queue</div>
      {loading && !ov ? (
        <div className="animate-pulse space-y-3"><div className="h-10 rounded-xl bg-white/5" /><div className="h-10 rounded-xl bg-white/5" /></div>
      ) : (
        <div className="space-y-2 text-[13px]">
          {items.slice(0, 8).map((it) => (
            <a key={it.id} href={it.href ?? "#/"} className="glass-inner flex items-start gap-2.5 px-3 py-2 text-slate-300 transition hover:border-white/15 hover:text-white">
              <span className="mt-1.5"><Dot tone={it.tone} pulse={it.tone === "red"} /></span>
              <span className="flex-1">{it.label}</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function Doctrine() {
  const { ov } = useOverview();
  const verified = ov?.agents_enabled !== undefined;
  return (
    <div className="glass p-4">
      <div className="eyebrow mb-3">Cockpit Doctrine</div>
      <div className="space-y-2 text-[13px] text-slate-400">
        <div className="flex items-center gap-2"><ChevronRight className="h-4 w-4 text-cyan-300" />No anonymous operator surface</div>
        <div className="flex items-center gap-2"><ChevronRight className="h-4 w-4 text-cyan-300" />Every action links to evidence</div>
        <div className="flex items-center gap-2"><ChevronRight className="h-4 w-4 text-cyan-300" />Advisory only: no orders, no funds</div>
        <div className="flex items-center gap-2">
          <ChevronRight className={`h-4 w-4 ${verified ? "text-emerald-300" : "text-slate-500"}`} />
          <span className={verified ? "text-emerald-300" : "text-slate-500"}>{verified ? "Control plane verified" : "Awaiting control plane"}</span>
        </div>
      </div>
    </div>
  );
}

export default function AppShell({ current, children }: { current: string; children: ReactNode }) {
  const { who } = useSession();
  const { ov } = useOverview();
  const [open, setOpen] = useState(false);
  const agentsOn = ov?.agents_enabled;

  const navLinks = (mobile: boolean) => NAV.map((item) => {
    const active = item.key === current;
    return (
      <a key={item.key} href={item.href} onClick={() => setOpen(false)} aria-current={active ? "page" : undefined}
        className={`inline-flex items-center gap-2 rounded-md border font-semibold transition ${mobile ? "px-4 py-3 text-[13px]" : "px-3 py-2 text-[12px]"} ${active ? "border-cyan-400/40 bg-cyan-400/10 text-white" : "border-transparent text-slate-400 hover:border-white/10 hover:bg-white/5 hover:text-white"}`}>
        <item.icon className={`h-4 w-4 ${active ? "text-cyan-300" : "text-slate-500"}`} />{item.label}
      </a>
    );
  });

  return (
    <div className="min-h-screen text-slate-100">
      <header className="border-b border-white/10 bg-obsidian-panel/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1680px] items-center gap-3 px-3 py-3 sm:px-6 sm:py-4">
          <a href="https://nexus.cryptophys.work/" className="flex items-center gap-3" aria-label="Nexus home">
            <motion.div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-400/40 bg-cyan-400/10 sm:h-11 sm:w-11"
              animate={{ boxShadow: ["0 0 0 rgba(34,211,238,0)", "0 0 22px rgba(34,211,238,0.35)", "0 0 0 rgba(34,211,238,0)"] }}
              transition={{ duration: 4, repeat: Infinity }}>
              <Activity className="h-4 w-4 text-cyan-300 sm:h-5 sm:w-5" />
            </motion.div>
            <div>
              <div className="text-xs uppercase tracking-[0.35em] text-cyan-300/80">Cryptophys Cerebrum</div>
              <div className="text-sm font-semibold text-white">Autonomous Mission Control</div>
            </div>
          </a>
          <div className="ml-auto hidden items-center gap-2 sm:flex">
            <span className="chip border-emerald-400/20 bg-emerald-400/10 text-emerald-300"><ShieldCheck className="h-3 w-3" />Access Verified</span>
            <span className={`chip ${who.approver ? "border-violet-400/20 bg-violet-400/10 text-violet-200" : "border-cyan-400/20 bg-cyan-400/10 text-cyan-200"}`}>{who.approver ? "Approver" : "Operator"}</span>
            <span className={`chip ${agentsOn === false ? "border-rose-400/20 bg-rose-400/10 text-rose-300" : "border-amber-400/20 bg-amber-400/10 text-amber-200"}`}>
              <Dot tone={agentsOn === false ? "red" : "green"} pulse={agentsOn !== false} />{agentsOn === false ? "Mesh halted" : "Mesh live"}
            </span>
          </div>
          <button type="button" className="ml-auto rounded-md border border-white/10 bg-white/[0.04] p-2 text-slate-400 hover:text-white md:hidden"
            onClick={() => setOpen((o) => !o)} aria-label="Toggle navigation" aria-expanded={open}>
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </header>

      <nav className="border-b border-white/10 bg-obsidian-bar" aria-label="Console">
        <div className="mx-auto flex max-w-[1680px] items-center gap-2 px-3 py-3 sm:px-6">
          <div className="hidden flex-wrap items-center gap-1 md:flex">{navLinks(false)}</div>
          <div className="flex items-center gap-2 md:hidden">
            {NAV.filter((n) => n.key === current).map((n) => <span key={n.key} className="inline-flex items-center gap-2 text-[12px] font-semibold text-white"><n.icon className="h-4 w-4 text-cyan-300" />{n.label}</span>)}
          </div>
          <div className="ml-auto hidden items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-[11px] uppercase tracking-[0.2em] text-slate-500 lg:flex">
            <Sparkles className="h-3.5 w-3.5 text-cyan-300" />Observe → reason → act → attest
          </div>
        </div>
        {open && (
          <div className="mx-auto flex max-w-[1680px] flex-col gap-1 px-3 pb-3 md:hidden">
            {navLinks(true)}
            <a href="https://nexus.cryptophys.work/" className="inline-flex items-center gap-3 rounded-md px-4 py-3 text-[13px] font-semibold text-slate-400 hover:text-white"><Home className="h-4 w-4 text-slate-500" />Nexus</a>
          </div>
        )}
      </nav>

      <div className="mx-auto flex max-w-[1680px] gap-5 px-3 py-3 sm:px-6 sm:py-5">
        <aside className="hidden w-[260px] shrink-0 flex-col gap-4 xl:flex">
          <PriorityQueue />
          <Doctrine />
        </aside>
        <main className="min-w-0 flex-1">
          <div className="glass mb-5 flex flex-wrap items-center gap-2 px-4 py-3 text-[11px] uppercase tracking-[0.2em] text-slate-400">
            <span className="text-cyan-300">identity</span>
            <span className="mono normal-case tracking-normal text-slate-200">{who.actor}</span>
            <span className="text-slate-600">|</span>
            <span>source</span><span className="mono normal-case tracking-normal text-slate-300">cloudflare-access</span>
            <span className="text-slate-600">|</span>
            <span>observed</span><span className="mono normal-case tracking-normal text-slate-300">{ago(ov?.observed_at)}</span>
          </div>
          {children}
        </main>
        <aside className="hidden w-[320px] shrink-0 flex-col gap-4 2xl:flex">
          <CognitionPanel />
          <LiveEventBus />
        </aside>
      </div>

      <footer className="sticky bottom-0 z-20 border-t border-white/10 bg-obsidian-foot/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1680px] items-center gap-4 overflow-x-auto px-3 py-3 text-[11px] font-medium uppercase tracking-[0.2em] text-slate-500 sm:px-6">
          {["AI Kernel", "Policy Engine", "Audit Ledger", "Drift Detector", "Recovery", "Registry", "Workers AI", "D1", "Vectorize"].map((s) => <span key={s} className="whitespace-nowrap">{s}</span>)}
          <a href="https://nexus.cryptophys.work/" className="ml-auto inline-flex items-center gap-1 whitespace-nowrap text-cyan-300/80 hover:text-cyan-200">Nexus <ExternalLink className="h-3 w-3" /></a>
        </div>
      </footer>
    </div>
  );
}
