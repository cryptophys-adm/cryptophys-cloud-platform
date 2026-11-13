import { useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import {
  Activity, Bot, Brain, CandlestickChart, ChevronRight, Database, GitBranch, Menu, Scale, Server, ShieldCheck,
  Sparkles, Terminal, Wrench, X, ExternalLink, Home, Gavel, Users,
  FolderGit2, LogOut, UserRound, ArrowLeftRight, Inbox, BellRing } from "lucide-react";
import { ACCESS_LOGOUT, SWITCH_ACCOUNT } from "../lib/api";
import { useSession } from "../lib/session";
import { useOverview } from "../lib/overview";
import { Dot } from "./ui";
import CognitionPanel from "./CognitionPanel";
import LiveEventBus from "./LiveEventBus";
import { ago } from "../lib/format";
import { serviceName } from "../lib/plain";

export const NAV = [
  // Owner 2026-11-13: approvals and open critical reports, the only things that need a person, come first.
  { label: "Owner", href: "#/owner", key: "owner", icon: Inbox },
  { label: "Command", href: "#/", key: "", icon: Terminal },
  { label: "Organism", href: "#/organism", key: "organism", icon: Sparkles },
  { label: "AI Mesh", href: "#/agents", key: "agents", icon: Bot },
  { label: "Cognition", href: "#/cognition", key: "cognition", icon: Brain },
  { label: "Consensus", href: "#/consensus", key: "consensus", icon: Gavel },
  { label: "Knowledge", href: "#/knowledge", key: "knowledge", icon: Sparkles },
  { label: "Recovery", href: "#/recovery", key: "recovery", icon: Wrench },
  { label: "Infrastructure", href: "#/infrastructure", key: "infrastructure", icon: Server },
  { label: "Policy", href: "#/policy", key: "policy", icon: Scale },
  { label: "Ledger", href: "#/ledger", key: "ledger", icon: Database },
  { label: "Pipelines", href: "#/pipelines", key: "pipelines", icon: GitBranch },
  { label: "Code", href: "#/code", key: "code", icon: FolderGit2 },
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

/**
 * The footer lists the organs the Drift Detector observes right now (ADR-0013: no fixed list of
 * components), each with its drift state, then the platform's shared substrate.
 */
function OrganStrip() {
  const { ov } = useOverview();
  const organs = [...(ov?.services ?? [])].sort((a, b) => serviceName(a.service_id).localeCompare(serviceName(b.service_id)));
  return (
    <>
      {organs.map((s) => (
        <span key={s.service_id} className="inline-flex items-center gap-1.5 whitespace-nowrap" title={s.drifted ? "drifted" : "in sync"}>
          <Dot tone={s.drifted ? "amber" : "green"} />{serviceName(s.service_id)}
        </span>
      ))}
      {["Workers AI", "D1", "Vectorize", "Artifacts"].map((s) => <span key={s} className="whitespace-nowrap text-slate-600">{s}</span>)}
    </>
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

/** The signed-in person's role, as /api/whoami reports it. */
export function roleLabel(who: { owner?: boolean; approver: boolean; role?: string; viewer?: boolean }): string {
  if (who.owner) return "Owner";
  if (who.approver) return "Approver";
  if (who.viewer || who.role === "viewer") return "Viewer";
  return "Operator";
}

/** Account menu: who is signed in, and Cloudflare Access logout (sign out, or switch account). */
function AccountMenu() {
  const { who } = useSession();
  return (
    <details className="group relative">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[12px] text-slate-300 hover:text-white [&::-webkit-details-marker]:hidden"
        aria-label="Account menu">
        <UserRound className="h-4 w-4 text-cyan-300" />
        <span className="hidden max-w-[180px] truncate lg:inline">{who.actor}</span>
      </summary>
      <div className="absolute right-0 z-40 mt-2 w-64 rounded-xl border border-white/10 bg-obsidian-panel/95 p-2 shadow-xl backdrop-blur" role="menu">
        <div className="px-3 py-2">
          <div className="text-[10px] uppercase tracking-widest text-slate-500">Signed in as</div>
          <div className="mono break-all text-[12px] text-slate-200">{who.actor}</div>
          <div className="mt-1 text-[11px] text-cyan-200">{roleLabel(who)}</div>
        </div>
        <a role="menuitem" href="#/alerts" className="flex items-center gap-2 rounded-md px-3 py-2 text-[13px] text-slate-300 hover:bg-white/5 hover:text-white"><BellRing className="h-4 w-4 text-slate-500" />Alerts</a>
        <a role="menuitem" href={SWITCH_ACCOUNT} className="flex items-center gap-2 rounded-md px-3 py-2 text-[13px] text-slate-300 hover:bg-white/5 hover:text-white"><ArrowLeftRight className="h-4 w-4 text-slate-500" />Switch account</a>
        <a role="menuitem" href={ACCESS_LOGOUT} className="flex items-center gap-2 rounded-md px-3 py-2 text-[13px] text-rose-200 hover:bg-rose-500/10"><LogOut className="h-4 w-4" />Sign out</a>
      </div>
    </details>
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
      <header className="relative z-30 border-b border-white/10 bg-obsidian-panel/90 backdrop-blur">
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
            <span className={`chip ${who.approver ? "border-violet-400/20 bg-violet-400/10 text-violet-200" : "border-cyan-400/20 bg-cyan-400/10 text-cyan-200"}`}>{roleLabel(who)}</span>
            <span className={`chip ${agentsOn === false ? "border-rose-400/20 bg-rose-400/10 text-rose-300" : "border-amber-400/20 bg-amber-400/10 text-amber-200"}`}>
              <Dot tone={agentsOn === false ? "red" : "green"} pulse={agentsOn !== false} />{agentsOn === false ? "Mesh halted" : "Mesh live"}
            </span>
            <AccountMenu />
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
            <div className="mt-1 border-t border-white/10 px-4 pt-3 text-[11px] text-slate-500">Signed in as <span className="mono break-all text-slate-300">{who.actor}</span> · {roleLabel(who)}</div>
            <a href={SWITCH_ACCOUNT} className="inline-flex items-center gap-3 rounded-md px-4 py-3 text-[13px] font-semibold text-slate-400 hover:text-white"><ArrowLeftRight className="h-4 w-4 text-slate-500" />Switch account</a>
            <a href={ACCESS_LOGOUT} className="inline-flex items-center gap-3 rounded-md px-4 py-3 text-[13px] font-semibold text-rose-200 hover:text-rose-100"><LogOut className="h-4 w-4" />Sign out</a>
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
          <OrganStrip />
          <a href="https://nexus.cryptophys.work/" className="ml-auto inline-flex items-center gap-1 whitespace-nowrap text-cyan-300/80 hover:text-cyan-200">Nexus <ExternalLink className="h-3 w-3" /></a>
        </div>
      </footer>
    </div>
  );
}
