import { useState } from "react";
import { Cpu, Power, PowerOff } from "lucide-react";
import { Badge, Empty, ErrorBox, Panel, Skeleton } from "./ui";
import { DataTable } from "./viz";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { useSession } from "../lib/session";
import { ago } from "../lib/format";

/**
 * AIR1 (ADR-0007 amendment 2026-11-25; owner: "Approve, but Cerebrum only"): the model router on the Organism page's
 * Telemetry tab. One read of GET /v1/model-router (kernel.model_router): the router's global state, today's Beam and
 * Workers AI calls and tokens per purpose (D1 model_calls_daily), why Beam did not answer (fallbacks by reason), and the
 * router's own counters against Cerebrum's share. Every value comes from that answer; a missing one is "—". Only the owner
 * sees the switch: on is free_only, or paid_capped with an explicit cap; after a paid sign, free_only only with the owner's
 * confirmation that it was not a charge (confirm_free, its own phrase BEAM ON FREE), or paid_capped; off is a plain owner
 * click. The kernel checks the owner and the body again.
 *
 * Owner 2026-11-26 ("pandu aktifkan beam", "buatkan togglenya di cerebrum > command"): MODEL_ROUTER is on in the kernel's
 * wrangler.toml, so this switch is the owner's Beam toggle; Cerebrum → Command shows it compact (the effective state and
 * why, today's Beam and Workers AI calls, the fallbacks, the same owner-only switch), Organism → Telemetry in full.
 * "Disabled" names its cause from the kernel's `configured` block (the var, whether the key is set, never the key).
 *
 * Owner 2026-11-26 ("tambahkan untuk semua beam toggle dari cta dan juga xauusd di command"; migration 0091): one switch
 * per system, Cerebrum, CTA and xauusd (its news_compare), from the GET's `systems` rows, each with its effective state
 * and why, and the owner's on and off (the same three phrases, the dialog naming the system; the body names it). CTA's
 * and xauusd's rows say "not connected yet" until their router has read its switch (`last_status_read_at`), then when it
 * last did. A paid sign from any system is one global stop (`global.paid_off`): every row reads off (a paid sign), and
 * turning any system on again (free only with BEAM ON FREE, or with a paid cap) clears it for all.
 */

const MISSING = "—";
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v.toLocaleString("en-US") : MISSING);
const STATE_LABEL: Record<string, string> = {
  on: "on", off: "off (never turned on)", off_owner: "off (the owner)", off_paid: "off (a paid sign)", off_retention: "off (data retention)", disabled: "disabled on this deploy",
};
const PROVIDER_LABEL: Record<string, string> = { reflection: "Beam", workers_ai: "Workers AI" };
const REASON_LABEL: Record<string, string> = {
  unreachable: "unreachable or unusable answer", rate: "provider rate limit", budget: "Cerebrum's share used", paid: "paid sign", retention: "data retention",
  breaker: "breaker open", off: "router off", disabled: "not configured", output_budget: "cut at its output limit",
};

type System = "cerebrum" | "cta" | "xauusd";
const SYSTEMS: System[] = ["cerebrum", "cta", "xauusd"];
const SYSTEM_LABEL: Record<System, string> = { cerebrum: "Cerebrum", cta: "CTA", xauusd: "xauusd (news_compare)" };
/** What Beam answers for each system once its switch is on (the dialogs' first line). */
const SYSTEM_SCOPE: Record<System, string> = {
  cerebrum: "Beam then answers Cerebrum's chat, directive drafts and councils first; Workers AI answers whenever Beam does not.",
  cta: "CTA's own router may then call Beam within CTA's share; it falls back as it does today whenever Beam does not answer.",
  xauusd: "xauusd's own router may then call Beam for shadow:news_compare only (behind xauusd's FS1 switch); Workers AI answers whenever Beam does not.",
};
const toneOf = (e: string | null) => (e === "on" ? "green" : e === "off_paid" || e === "off_retention" ? "red" : e === "disabled" ? "amber" : "slate");

/** Why the kernel reports Beam disabled on this deploy, from its `configured` block; null when it does not say. */
function disabledReasons(c: any): string[] | null {
  if (!c || typeof c !== "object") return null;
  const r: string[] = [];
  if (c.var_on !== true) r.push("var off");
  if (c.key_present !== true) r.push("key not set");
  if (c.base_url_valid !== true) r.push("base URL invalid");
  return r;
}

export default function ModelRouterPanel({ compact = false }: { compact?: boolean } = {}) {
  const { data, error, loading, refresh } = usePoll(() => call("kernel.model_router"), 60_000);
  const { who, act } = useSession();
  const [caps, setCaps] = useState<Record<string, string>>({});
  const d: any = data && data.schema === "model_router.status.v1" ? data : null;
  const st: any = d?.state ?? null;
  const effective: string | null = typeof d?.effective === "string" ? d.effective : null;
  const rows: any[] = Array.isArray(d?.ledger) ? d.ledger : [];
  const fallbacks: [string, number][] = d?.fallbacks && typeof d.fallbacks === "object" ? Object.entries(d.fallbacks as Record<string, number>).filter(([, v]) => typeof v === "number") : [];
  const totals = (p: string) => rows.filter((r) => r.provider === p).reduce((s, r) => ({ calls: s.calls + (Number(r.calls) || 0), in: s.in + (Number(r.in_tokens) || 0), out: s.out + (Number(r.out_tokens) || 0) }), { calls: 0, in: 0, out: 0 });
  const beam = totals("reflection"), wai = totals("workers_ai");
  const tone = toneOf(effective);
  const reasons = disabledReasons(d?.configured);
  const effectiveLabel = !effective ? null : effective === "disabled" ? (reasons && reasons.length ? `disabled (${reasons.join(", ")})` : STATE_LABEL.disabled) : STATE_LABEL[effective] ?? effective;
  const pendingLine = effective === "disabled" && reasons && reasons.length ? `Beam stays disabled (${reasons.join(", ")}) and Workers AI answers; the owner's switch takes effect once that is fixed.` : null;
  const global: any = d?.global && typeof d.global === "object" ? d.global : null;
  // Each system's row from the GET's `systems`; a kernel without them (before migration 0091) gives Cerebrum's alone.
  const sys: Record<System, any> = { cerebrum: null, cta: null, xauusd: null };
  if (Array.isArray(d?.systems)) { for (const r of d.systems) if (r && SYSTEMS.includes(r.system)) sys[r.system as System] = r; }
  else if (d) sys.cerebrum = { system: "cerebrum", state: st, effective, last_status_read_at: null };
  const paidStop = global?.paid_off === true || st?.state === "off_paid";

  const rowControls = (system: System, r: any) => {
    const rs: any = r?.state ?? null;
    const sw: string | null = typeof rs?.switch === "string" ? rs.switch : rs && rs.state !== "off_paid" ? rs.state : null;
    const name = SYSTEM_LABEL[system];
    const cap = caps[system] ?? "";
    const capValue = Number(cap);
    const capOk = cap.trim() !== "" && Number.isFinite(capValue) && capValue > 0 && capValue <= 100;
    const notConnected = system !== "cerebrum" && !r?.last_status_read_at ? `${name}'s router is not connected yet: the switch takes effect once it reads it.` : null;
    const pending = system === "cerebrum" ? pendingLine : notConnected;
    const clears = paidStop ? [`This clears the paid stop for every system: Cerebrum, CTA and xauusd then follow their own switches again.`] : [];
    if (!rs) return null;
    // The switch is the owner's alone (the kernel checks the owner and the body again); operators read the row only.
    const controls = who.owner ? (
      <div className="flex flex-wrap items-end gap-2">
        {!paidStop && sw !== "on" && (
          <button type="button" className="btn btn-approve py-1!" onClick={() => act({ route: "kernel.model_router_on", body: { system, state: "on", mode: "free_only" }, title: `Turn Beam on (free only) for ${name}`,
            lines: [SYSTEM_SCOPE[system], "Any paid sign, from any system, turns Beam off for every system at once, and you hear of it once.", ...(pending ? [pending] : [])],
            done: `Beam is on for ${name} (free only).`, after: refresh })}><Power className="h-3.5 w-3.5" />Turn on (free only)…</button>
        )}
        {(paidStop || sw !== "on") && (
          <label className="flex items-center gap-1.5 text-[11px] text-slate-400">Paid cap (USD)
            <input aria-label={`Paid cap in USD for ${name}`} inputMode="decimal" className="field mono w-20! py-1!" maxLength={8} value={cap} onChange={(e) => setCaps((c) => ({ ...c, [system]: e.target.value }))} />
            <button type="button" className="btn py-1!" disabled={!capOk} onClick={() => act({ route: "kernel.model_router_on", body: { system, state: "on", mode: "paid_capped", paid_cap_usd: capValue }, title: `Turn Beam on with a paid cap for ${name}`,
              lines: [`Beam may cost ${name} up to ${cap.trim()} USD before it turns itself off.`, SYSTEM_SCOPE[system], ...clears, ...(pending ? [pending] : [])], done: `Beam is on for ${name} (paid, capped).`, after: refresh })}>Turn on (paid, capped)…</button>
          </label>
        )}
        {sw === "on" && (
          <button type="button" className="btn btn-danger py-1!" onClick={() => act({ route: "kernel.model_router_off", body: { system, state: "off" }, title: `Turn Beam off for ${name}`,
            lines: [system === "cerebrum" ? "Cerebrum then answers on Workers AI only." : `${name}'s router then stops calling Beam at its next read of this switch.`, ...(paidStop ? ["The paid stop stays set; this keeps the system off once it is cleared."] : [])],
            done: `Beam is off for ${name}.`, after: refresh })}><PowerOff className="h-3.5 w-3.5" />Turn off…</button>
        )}
        {paidStop && (
          <button type="button" className="btn py-1!" onClick={() => act({ route: "kernel.model_router_on_free", body: { system, state: "on", mode: "free_only", confirm_free: true }, title: `Turn Beam on again (free only) for ${name}`,
            lines: [`Only if you are sure the paid sign was not a charge: ${SYSTEM_SCOPE[system]}`, ...clears, "Any later paid sign turns it off again at once, and you hear of it once.", ...(pending ? [pending] : [])],
            done: `Beam is on for ${name} (free only).`, after: refresh })}><Power className="h-3.5 w-3.5" />Turn on free (not a charge)…</button>
        )}
      </div>
    ) : null;
    return controls;
  };

  /** One system's row: its effective state and why, its router's connection, and (owner only) its switch. */
  const systemRow = (system: System) => {
    const r = sys[system];
    const rs: any = r?.state ?? null;
    const eff: string | null = system === "cerebrum" ? effective : typeof r?.effective === "string" ? r.effective : null;
    const label = system === "cerebrum" ? effectiveLabel : eff ? STATE_LABEL[eff] ?? eff : null;
    const connection = system === "cerebrum" ? "The kernel's own router." : !r ? null : r.last_status_read_at ? `Its router last read this switch ${ago(r.last_status_read_at)}.` : "Its router is not connected yet: it has not read this switch.";
    return (
      <div key={system} className="glass-inner flex flex-col gap-1.5 px-3 py-2" data-beam-system={system}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-[12px] font-semibold text-slate-200">{SYSTEM_LABEL[system]}</span>
          {label ? <Badge tone={toneOf(eff)}>{label}</Badge> : <span className="mono text-slate-500">{MISSING}</span>}
        </div>
        <div className="text-[11px] text-slate-400" data-beam-effective>
          Beam is <strong className="mono text-slate-100">{label ?? MISSING}</strong>.{" "}
          {system === "cerebrum" && d?.configured ? <>MODEL_ROUTER {d.configured.var_on ? "on" : "off"}, key {d.configured.key_present ? "set" : "not set"}. </> : null}
          {rs ? <>The owner's switch: <span className="mono text-slate-300">{STATE_LABEL[rs.switch ?? rs.state] ?? rs.switch ?? rs.state ?? MISSING}</span>{rs.mode ? <> ({rs.mode}{rs.mode === "paid_capped" ? `, cap ${n(rs.paid_cap_usd)} USD` : ""})</> : null}, set by <span className="mono">{rs.updated_by ?? MISSING}</span> {rs.updated_at ? ago(rs.updated_at) : MISSING}{rs.reason ? <>: {rs.reason}</> : null}. </> : null}
          {connection ? <span className={system !== "cerebrum" && r && !r.last_status_read_at ? "text-amber-300/90" : "text-slate-500"}>{connection}</span> : null}
        </div>
        {system === "cerebrum" && pendingLine ? <p className="text-[11px] text-amber-300/90">{pendingLine}</p> : null}
        {rowControls(system, r)}
      </div>
    );
  };
  const paidLine = paidStop ? (
    <p className="text-[11px] text-rose-300/90" data-beam-paid-stop>
      A paid sign stopped Beam for every system{global?.reason ? <> ({global.reason}{global.updated_by ? <>, {global.updated_by}</> : null}{global.updated_at ? <> {ago(global.updated_at)}</> : null})</> : null}. After a paid sign Beam turns on only with a paid cap, or free only once you confirm it was not a charge. Either clears the stop for every system.
    </p>
  ) : null;
  const switches = (
    <div className="flex flex-col gap-2" data-beam-switches>
      {paidLine}
      {SYSTEMS.map(systemRow)}
      {!who.owner ? <div className="text-[11px] text-slate-500">Only the owner turns Beam on or off.</div> : null}
    </div>
  );
  const fallbackBadges = (
          <div data-router-fallbacks>
            <div className="mb-1 text-[10px] uppercase tracking-widest text-slate-500">Fallbacks to Workers AI by reason, today</div>
            {fallbacks.length === 0 ? <p className="text-[11px] text-slate-500">None today.</p> : (
              <div className="flex flex-wrap gap-1.5">{fallbacks.map(([k, v]) => <Badge key={k} tone={k === "paid" || k === "retention" ? "red" : k === "off" || k === "disabled" ? "slate" : "amber"}>{REASON_LABEL[k] ?? k}: {n(v)}</Badge>)}</div>
            )}
          </div>
  );
  if (compact) {
    return (
      <Panel title="Beam · Cerebrum, CTA and xauusd" icon={<Cpu className="h-3.5 w-3.5 text-cyan-300" />}
        right={<div className="flex items-center gap-2">{paidStop ? <Badge tone="red">paid stop · all off</Badge> : null}<a href="#/organism/telemetry" className="text-[10px] uppercase tracking-widest text-slate-500 hover:text-cyan-300">Details →</a></div>}>
        <ErrorBox error={error} onRetry={refresh} stale={Boolean(data)} />
        {!d ? (loading ? <Skeleton rows={2} /> : <Empty>{MISSING}</Empty>) : d.available !== true ? (
          <Empty>The model router's table is not in D1 yet (migrations 0090 and 0091). Cerebrum answers on Workers AI.</Empty>
        ) : (
          <div className="flex flex-col gap-3 text-[12px]" data-beam-toggle>
            {switches}
            <div className="grid grid-cols-3 gap-2" data-router-tiles>
              <div className="glass-inner px-3 py-2"><div className="text-[10px] uppercase tracking-widest text-slate-500">Cerebrum · Beam today</div><div className="mono text-slate-200">{n(beam.calls)} calls</div></div>
              <div className="glass-inner px-3 py-2"><div className="text-[10px] uppercase tracking-widest text-slate-500">Cerebrum · Workers AI today</div><div className="mono text-slate-200">{n(wai.calls)} calls</div></div>
              <div className="glass-inner px-3 py-2"><div className="text-[10px] uppercase tracking-widest text-slate-500">Cerebrum · fallbacks today</div><div className="mono text-slate-200">{n(fallbacks.reduce((s, [, v]) => s + v, 0))}</div></div>
            </div>
            {fallbackBadges}
          </div>
        )}
      </Panel>
    );
  }
  return (
    <Panel title="Model router · Beam for Cerebrum, CTA and xauusd" icon={<Cpu className="h-3.5 w-3.5 text-cyan-300" />}
      right={effectiveLabel ? <Badge tone={tone}>{effectiveLabel}</Badge> : null}>
      <ErrorBox error={error} onRetry={refresh} stale={Boolean(data)} />
      {!d ? (loading ? <Skeleton rows={3} /> : <Empty>{MISSING}</Empty>) : d.available !== true ? (
        <Empty>The model router's table is not in D1 yet (migrations 0090 and 0091). Cerebrum answers on Workers AI.</Empty>
      ) : (
        <div className="flex flex-col gap-3 text-[12px]">
          <p className="text-[11px] text-slate-500">
            Beam ({d.model ?? MISSING}) may answer Cerebrum's chat, directive drafts and councils, free only; Workers AI answers every call it does not. CTA and xauusd's news_compare call it through their own routers, each with its own switch below; the evolver and Aether never use it.
          </p>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4" data-router-tiles>
            <div className="glass-inner px-3 py-2"><div className="text-[10px] uppercase tracking-widest text-slate-500">Mode</div><div className="mono text-slate-200">{st?.mode ?? MISSING}{st?.mode === "paid_capped" ? ` · cap ${n(st.paid_cap_usd)} USD` : ""}</div></div>
            <div className="glass-inner px-3 py-2"><div className="text-[10px] uppercase tracking-widest text-slate-500">Breaker</div><div className="mono text-slate-200">{d.health?.breaker ?? MISSING}{d.health?.rate_limited_until ? " · rate limited" : ""}</div></div>
            <div className="glass-inner px-3 py-2"><div className="text-[10px] uppercase tracking-widest text-slate-500">Beam today</div><div className="mono text-slate-200">{n(beam.calls)} calls · {n(beam.in)} in · {n(beam.out)} out</div></div>
            <div className="glass-inner px-3 py-2"><div className="text-[10px] uppercase tracking-widest text-slate-500">Workers AI today</div><div className="mono text-slate-200">{n(wai.calls)} calls · {n(wai.in)} in · {n(wai.out)} out</div></div>
          </div>
          <div className="text-[11px] text-slate-500">
            Cerebrum's share today: <span className="mono text-slate-300">{n(d.today?.requests)} / {n(d.limits?.requests_day)}</span> requests,{" "}
            <span className="mono text-slate-300">{n(d.today?.in_tokens)} / {n(d.limits?.input_tokens_day)}</span> input and{" "}
            <span className="mono text-slate-300">{n(d.today?.out_tokens)} / {n(d.limits?.output_tokens_day)}</span> output tokens; this minute{" "}
            <span className="mono text-slate-300">{n(d.today?.this_minute)} / {n(d.limits?.rpm)}</span>.
            {d.configured ? <> Deploy: MODEL_ROUTER {d.configured.var_on ? "on" : "off"}, key {d.configured.key_present ? "set" : "not set"}.</> : null}
          </div>
          <DataTable dense rows={rows} rowKey={(r: any) => `${r.purpose}:${r.provider}:${r.model}`} maxHeight={260} empty="No call of Cerebrum's tasks today." columns={[
            { key: "purpose", header: "Purpose", cell: (r: any) => <span className="mono">{r.purpose}</span>, sort: (r: any) => r.purpose },
            { key: "provider", header: "Provider", cell: (r: any) => PROVIDER_LABEL[r.provider] ?? r.provider, sort: (r: any) => r.provider },
            { key: "calls", header: "Calls", align: "right", cell: (r: any) => n(r.calls), sort: (r: any) => r.calls },
            { key: "in", header: "Tokens in", align: "right", cell: (r: any) => n(r.in_tokens), sort: (r: any) => r.in_tokens },
            { key: "out", header: "Tokens out", align: "right", cell: (r: any) => n(r.out_tokens), sort: (r: any) => r.out_tokens },
            { key: "fallbacks", header: "Why not Beam", cell: (r: any) => {
              const f = r.fallbacks && typeof r.fallbacks === "object" ? Object.entries(r.fallbacks as Record<string, number>) : [];
              return f.length ? f.map(([k, v]) => `${REASON_LABEL[k] ?? k} ${n(v)}`).join(", ") : MISSING;
            } },
          ]} />
          {fallbackBadges}
          {switches}
        </div>
      )}
    </Panel>
  );
}
