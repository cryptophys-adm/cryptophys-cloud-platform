/** Glowing health ring from the original Nexus command dashboard. */
export default function HealthRing({ score, stats }: { score: number | null; stats: { l: string; v: string; c?: string }[] }) {
  const s = score ?? 0;
  const color = score === null ? "#484f58" : s < 60 ? "#f85149" : s < 85 ? "#d29922" : "#3fb950";
  const r = 42;
  const circ = 2 * Math.PI * r;
  const filled = (s / 100) * circ;
  return (
    <div className="flex items-center gap-5">
      <div className="relative h-[100px] w-[100px] shrink-0">
        <svg width={100} height={100} className="absolute inset-0" role="img" aria-label={`Platform health ${score ?? "unknown"} of 100`}>
          <circle cx={50} cy={50} r={r} fill="none" stroke="#21262d" strokeWidth={6} />
          <circle cx={50} cy={50} r={r} fill="none" stroke={color} strokeWidth={6} strokeDasharray={`${filled} ${circ}`}
            strokeDashoffset={circ * 0.25} strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 6px ${color})`, transition: "stroke-dasharray 1s ease" }} />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="mono text-[26px] font-extrabold leading-none" style={{ color, textShadow: `0 0 16px ${color}88` }}>{score ?? "—"}</span>
          <span className="mt-0.5 text-[8px] font-semibold uppercase tracking-[0.15em] text-[#484f58]">health</span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-5 gap-y-1.5">
        {stats.map((x) => (
          <div key={x.l}>
            <div className="text-[8px] font-semibold uppercase tracking-[0.12em] text-[#484f58]">{x.l}</div>
            <div className="mono text-[16px] font-bold leading-tight" style={{ color: x.c ?? "#e6edf3" }}>{x.v}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
