import { motion } from "framer-motion";
import clsx from "clsx";
import type { ReactNode } from "react";

export function Panel({ title, icon, right, children, className }: { title?: ReactNode; icon?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <motion.section initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.28, ease: "easeOut" }}
      className={clsx("glass p-4", className)}>
      {(title || right) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="eyebrow flex items-center gap-2">{icon}{title}</h2>
          {right}
        </div>
      )}
      {children}
    </motion.section>
  );
}

export function Kpi({ label, value, sub, color, icon }: { label: string; value: string; sub?: string; color: string; icon?: ReactNode }) {
  return (
    <div className="glass flex flex-col justify-between p-4">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-500">
        <span style={{ color }}>{icon}</span>{label}
      </div>
      <div className="mono mt-2 text-[26px] font-extrabold leading-none" style={{ color, textShadow: `0 0 18px ${color}55` }}>{value}</div>
      {sub && <div className="mt-1 text-[11px] text-slate-500">{sub}</div>}
    </div>
  );
}

export function Dot({ tone = "green", pulse = false }: { tone?: "green" | "amber" | "red" | "cyan" | "slate" | "purple"; pulse?: boolean }) {
  const c = { green: "bg-emerald-400", amber: "bg-amber-400", red: "bg-rose-400", cyan: "bg-cyan-400", slate: "bg-slate-600", purple: "bg-violet-400" }[tone];
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0">
      {pulse && <span className={clsx("absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping-slow", c)} />}
      <span className={clsx("relative inline-flex h-2 w-2 rounded-full", c)} />
    </span>
  );
}

export function Badge({ tone = "slate", children }: { tone?: "green" | "amber" | "red" | "cyan" | "slate" | "purple"; children: ReactNode }) {
  const c = {
    green: "border-emerald-400/20 bg-emerald-400/10 text-emerald-300",
    amber: "border-amber-400/20 bg-amber-400/10 text-amber-200",
    red: "border-rose-400/20 bg-rose-400/10 text-rose-300",
    cyan: "border-cyan-400/20 bg-cyan-400/10 text-cyan-200",
    purple: "border-violet-400/20 bg-violet-400/10 text-violet-200",
    slate: "border-white/10 bg-white/[0.04] text-slate-300",
  }[tone];
  return <span className={clsx("chip", c)}>{children}</span>;
}

export function JsonView({ value }: { value: unknown }) {
  return <pre className="glass-inner mono max-h-[420px] overflow-auto p-3 text-[11px] leading-relaxed text-slate-300">{JSON.stringify(value, null, 2)}</pre>;
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return <div className="animate-pulse space-y-2">{Array.from({ length: rows }, (_, i) => <div key={i} className="h-9 rounded-lg bg-white/5" />)}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-3 text-[12px] text-slate-500">{children}</p>;
}

export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return <label className={clsx("block", className)}><span className="label">{label}</span>{children}</label>;
}

export function severityTone(s?: string): "red" | "amber" | "green" | "slate" {
  return s === "critical" ? "red" : s === "warning" ? "amber" : s === "info" ? "green" : "slate";
}
