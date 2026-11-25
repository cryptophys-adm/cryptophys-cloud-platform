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

export default function ModelRouterPanel() {
  const { data, error, loading, refresh } = usePoll(() => call("kernel.model_router"), 60_000);
  const { who, act } = useSession();
  const [cap, setCap] = useState("");
  const d: any = data && data.schema === "model_router.status.v1" ? data : null;
  const st: any = d?.state ?? null;
  const effective: string | null = typeof d?.effective === "string" ? d.effective : null;
  const rows: any[] = Array.isArray(d?.ledger) ? d.ledger : [];
  const fallbacks: [string, number][] = d?.fallbacks && typeof d.fallbacks === "object" ? Object.entries(d.fallbacks as Record<string, number>).filter(([, v]) => typeof v === "number") : [];
  const totals = (p: string) => rows.filter((r) => r.provider === p).reduce((s, r) => ({ calls: s.calls + (Number(r.calls) || 0), in: s.in + (Number(r.in_tokens) || 0), out: s.out + (Number(r.out_tokens) || 0) }), { calls: 0, in: 0, out: 0 });
  const beam = totals("reflection"), wai = totals("workers_ai");
  const capValue = Number(cap);
  const capOk = cap.trim() !== "" && Number.isFinite(capValue) && capValue > 0 && capValue <= 100;
  const paidOnly = st?.state === "off_paid";
  const tone = effective === "on" ? "green" : effective === "off_paid" || effective === "off_retention" ? "red" : "slate";
  return (
    <Panel title="Model router · Beam for Cerebrum" icon={<Cpu className="h-3.5 w-3.5 text-cyan-300" />}
      right={effective ? <Badge tone={tone}>{STATE_LABEL[effective] ?? effective}</Badge> : null}>
      <ErrorBox error={error} onRetry={refresh} stale={Boolean(data)} />
      {!d ? (loading ? <Skeleton rows={3} /> : <Empty>{MISSING}</Empty>) : d.available !== true ? (
        <Empty>The model router's table is not in D1 yet (migration 0090). Cerebrum answers on Workers AI.</Empty>
      ) : (
        <div className="flex flex-col gap-3 text-[12px]">
          <p className="text-[11px] text-slate-500">
            Beam ({d.model ?? MISSING}) may answer only Cerebrum's chat, directive drafts and councils, free only; Workers AI answers every call it does not. The evolver, xauusd and Aether never use it.
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
            {st ? <> State set by <span className="mono">{st.updated_by ?? MISSING}</span> {st.updated_at ? ago(st.updated_at) : MISSING}{st.reason ? <>: {st.reason}</> : null}.</> : null}
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
          <div data-router-fallbacks>
            <div className="mb-1 text-[10px] uppercase tracking-widest text-slate-500">Fallbacks to Workers AI by reason, today</div>
            {fallbacks.length === 0 ? <p className="text-[11px] text-slate-500">None today.</p> : (
              <div className="flex flex-wrap gap-1.5">{fallbacks.map(([k, v]) => <Badge key={k} tone={k === "paid" || k === "retention" ? "red" : k === "off" || k === "disabled" ? "slate" : "amber"}>{REASON_LABEL[k] ?? k}: {n(v)}</Badge>)}</div>
            )}
          </div>
          {who.owner ? (
            <div className="flex flex-wrap items-end gap-2 border-t border-white/5 pt-2">
              {st?.state !== "on" && !paidOnly && (
                <button type="button" className="btn btn-approve py-1!" onClick={() => act({ route: "kernel.model_router_on", body: { state: "on", mode: "free_only" }, title: "Turn Beam on (free only)",
                  lines: ["Beam then answers Cerebrum's chat, directive drafts and councils first; Workers AI answers whenever Beam does not.", "Any paid sign turns it off again at once, and you hear of it once."],
                  done: "Beam is on (free only).", after: refresh })}><Power className="h-3.5 w-3.5" />Turn on (free only)…</button>
              )}
              {st?.state !== "on" && (
                <label className="flex items-center gap-1.5 text-[11px] text-slate-400">Paid cap (USD)
                  <input aria-label="Paid cap in USD" inputMode="decimal" className="field mono w-20! py-1!" maxLength={8} value={cap} onChange={(e) => setCap(e.target.value)} />
                  <button type="button" className="btn py-1!" disabled={!capOk} onClick={() => act({ route: "kernel.model_router_on", body: { state: "on", mode: "paid_capped", paid_cap_usd: capValue }, title: "Turn Beam on with a paid cap",
                    lines: [`Beam may cost up to ${cap.trim()} USD before it turns itself off.`, "Workers AI answers whenever Beam does not."], done: "Beam is on (paid, capped).", after: refresh })}>Turn on (paid, capped)…</button>
                </label>
              )}
              {st?.state === "on" && (
                <button type="button" className="btn btn-danger py-1!" onClick={() => act({ route: "kernel.model_router_off", body: { state: "off" }, title: "Turn Beam off",
                  lines: ["Cerebrum then answers on Workers AI only."], done: "Beam is off.", after: refresh })}><PowerOff className="h-3.5 w-3.5" />Turn off…</button>
              )}
              {paidOnly && (
                <button type="button" className="btn py-1!" onClick={() => act({ route: "kernel.model_router_on_free", body: { state: "on", mode: "free_only", confirm_free: true }, title: "Turn Beam on again (free only)",
                  lines: ["Only if you are sure the paid sign was not a charge: Beam then answers Cerebrum's chat, directive drafts and councils first again.", "Any later paid sign turns it off again at once, and you hear of it once."],
                  done: "Beam is on (free only).", after: refresh })}><Power className="h-3.5 w-3.5" />Turn on free (not a charge)…</button>
              )}
              {paidOnly && <span className="text-[11px] text-slate-500">After a paid sign Beam turns on only with a paid cap, or free only once you confirm it was not a charge.</span>}
            </div>
          ) : <div className="text-[11px] text-slate-500">Only the owner turns Beam on or off.</div>}
        </div>
      )}
    </Panel>
  );
}
