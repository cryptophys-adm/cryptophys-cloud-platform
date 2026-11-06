import { motion } from "framer-motion";

export interface MeshAgent { agent_id: string; host_worker: string; status: string; tier_max: number }

const HOST_COLOR = (h: string) => h === "cryptophys-ai-kernel" ? "#bc8cff" : h.startsWith("xauusd") ? "#d29922" : "#39d0d8";

/** Radial AI-mesh: the kernel at the centre, one spoke per host Worker, its agents orbiting it. */
export default function MeshGraph({ agents, onSelect }: { agents: MeshAgent[]; onSelect: (id: string) => void }) {
  const W = 720, H = 460, cx = W / 2, cy = H / 2;
  const hosts = [...new Set(agents.map((a) => a.host_worker))].sort();
  const R = Math.min(W, H) * 0.34;
  const hostPos = new Map(hosts.map((h, i) => {
    const ang = (i / Math.max(hosts.length, 1)) * Math.PI * 2 - Math.PI / 2;
    return [h, { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang), ang }];
  }));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`AI mesh: ${agents.length} agents on ${hosts.length} host Workers`}>
      <defs>
        <radialGradient id="core" cx="50%" cy="50%" r="50%"><stop offset="0%" stopColor="#bc8cff" stopOpacity="0.9" /><stop offset="100%" stopColor="#bc8cff" stopOpacity="0" /></radialGradient>
      </defs>
      {hosts.map((h) => {
        const p = hostPos.get(h)!;
        return <line key={`l-${h}`} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke={HOST_COLOR(h)} strokeOpacity={0.22} strokeWidth={1} />;
      })}
      {hosts.map((h, hi) => {
        const p = hostPos.get(h)!;
        const group = agents.filter((a) => a.host_worker === h);
        const r = group.length > 8 ? 46 : group.length > 3 ? 34 : 22;
        return (
          <g key={h}>
            {group.map((a, i) => {
              const spread = group.length === 1 ? 0 : group.length > 8 ? Math.PI * 1.15 : Math.PI * 0.8;
              const ang = p.ang + (group.length === 1 ? 0 : (i / (group.length - 1) - 0.5) * spread);
              const x = p.x + r * Math.cos(ang), y = p.y + r * Math.sin(ang);
              const on = a.status === "enabled";
              return (
                <g key={a.agent_id} className="cursor-pointer" onClick={() => onSelect(a.agent_id)} role="button" tabIndex={0} aria-label={`${a.agent_id}, ${a.status}`}
                  onKeyDown={(e) => { if (e.key === "Enter") onSelect(a.agent_id); }}>
                  <line x1={p.x} y1={p.y} x2={x} y2={y} stroke={HOST_COLOR(h)} strokeOpacity={0.15} />
                  <motion.circle cx={x} cy={y} r={4} fill={on ? HOST_COLOR(h) : "#484f58"}
                    animate={on ? { opacity: [0.55, 1, 0.55] } : { opacity: 0.6 }} transition={{ duration: 2.4 + (i % 5) * 0.4, repeat: Infinity, delay: (hi + i) * 0.13 }}
                    style={{ filter: on ? `drop-shadow(0 0 4px ${HOST_COLOR(h)})` : undefined }} />
                  <title>{`${a.agent_id} · ${a.status} · tier ${a.tier_max}`}</title>
                </g>
              );
            })}
            <circle cx={p.x} cy={p.y} r={7} fill="#0b0f18" stroke={HOST_COLOR(h)} strokeWidth={1.5} />
            <text x={cx + (R - 30) * Math.cos(p.ang)} y={cy + (R - 30) * Math.sin(p.ang) + 3} textAnchor="middle" className="fill-slate-400"
              style={{ fontSize: 9, letterSpacing: "0.08em", paintOrder: "stroke", stroke: "#05070c", strokeWidth: 3 }}>
              {h.replace(/^cryptophys-/, "").replace(/^xauusd-ai-trading-assistant$/, "xauusd")} · {group.length}
            </text>
          </g>
        );
      })}
      <circle cx={cx} cy={cy} r={46} fill="url(#core)" opacity={0.35} />
      <motion.circle cx={cx} cy={cy} r={18} fill="#0b0f18" stroke="#bc8cff" strokeWidth={2}
        animate={{ r: [18, 21, 18] }} transition={{ duration: 3, repeat: Infinity }} style={{ filter: "drop-shadow(0 0 10px #bc8cff)" }} />
      <text x={cx} y={cy + 4} textAnchor="middle" className="fill-violet-200" style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.12em" }}>KERNEL</text>
    </svg>
  );
}
