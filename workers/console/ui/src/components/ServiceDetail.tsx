import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { Badge, Skeleton, severityTone } from "./ui";
import { Spark, msv, pct } from "./ObserverVitals";
import { call } from "../lib/api";
import { usePoll } from "../lib/usePoll";
import { ago, listOf } from "../lib/format";
import { explainCode } from "../lib/plain";
import { NOT_MEASURED, driftReasons, driftState, lastProbeAt } from "../lib/serviceDetail";

/**
 * One service, read only (owner 2026-11-15: the Edit form is gone; records come from the DNA, the census and
 * consensus deploys). A bottom sheet on a phone, a side panel on a desktop. Every value is read from an
 * allow-listed GET route; a value that was not measured reads "not measured", never a default number:
 *   - vitals: GET /v1/observer (observer_vitals, the hours it serves) and its findings (observer_findings, 7 days);
 *   - deploys: GET /v1/deployments (deployment_requests, and the recorded versions of the audit chain);
 *   - DNA: GET /v1/forge/census (the genome of main's latest census);
 *   - drift: GET /v1/drift (the latest state and the heartbeat) and GET /v1/drift/{id} (the recorded changes).
 */
const short = (v: unknown, n = 12) => (typeof v === "string" && v ? v.slice(0, n) : null);
const int = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-US") : null);

function Section({ title, source, children }: { title: string; source: string; children: ReactNode }) {
  return (
    <section className="border-t border-white/5 pt-3">
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2">
        <h3 className="text-[10px] font-semibold uppercase tracking-widest text-slate-400">{title}</h3>
        <span className="mono text-[9px] text-slate-600">{source}</span>
      </div>
      {children}
    </section>
  );
}

function Row({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,40%)_minmax(0,1fr)] items-baseline gap-2 py-0.5 text-[12px]">
      <span className="text-slate-500">{label}</span>
      <span className="min-w-0 wrap-break-word text-slate-200">{value ?? <Unmeasured />}{sub ? <span className="ml-1 text-[10px] text-slate-500">{sub}</span> : null}</span>
    </div>
  );
}

const Unmeasured = ({ why }: { why?: string }) => <span className="text-slate-500">{NOT_MEASURED}{why ? ` (${why})` : ""}</span>;

function Vital({ label, value, points }: { label: string; value: string | null; points: Array<number | null> }) {
  return (
    <div className="grid grid-cols-[minmax(0,40%)_auto_minmax(0,1fr)] items-center gap-2 py-0.5 text-[12px]">
      <span className="text-slate-500">{label}</span>
      {points.filter((p) => typeof p === "number").length >= 2 ? <Spark points={points} label={label} /> : <span className="text-[10px] text-slate-600">no series</span>}
      <span className="mono min-w-0 text-right text-slate-200">{value ?? <Unmeasured />}</span>
    </div>
  );
}

export default function ServiceDetail({ service, drift, onClose }: { service: any; drift: any; onClose: () => void }) {
  const id: string = service.service_id;
  const observer = usePoll(() => call("platform.observer"), 0, []);
  const deployments = usePoll(() => call("orchestrator.deployments", undefined, undefined, { limit: "100" }), 0, []);
  const census = usePoll(() => call("forge.census", undefined, undefined, { limit: "1" }), 0, []);
  const history = usePoll(() => call("drift.service", id), 0, [id]);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const state = driftState(drift, service.status);
  const reasons = driftReasons(drift);
  const probe = lastProbeAt(drift);

  // Observer: vitals and findings of this Worker only.
  const o: any = observer.data ?? {};
  const observerUp = o.available === true;
  const organ = listOf(o, "organs").find((x: any) => x.worker === id);
  const series: any[] = Array.isArray(organ?.series) ? organ.series : [];
  const findings = listOf(o, "anomalies").filter((f: any) => f.worker === id);
  const est = o.estimates?.rows_per_request;

  // Deploys: the latest deploy request and the latest recorded version of this service.
  const dep: any = deployments.data ?? {};
  const request = listOf(dep, "requests").find((r: any) => r.service_id === id);
  const recorded = listOf(dep, "deploys").find((r: any) => r.service_id === id);

  // DNA: this organ's gene in main's latest census.
  const latest = listOf(census.data, "census")[0];
  const gene = Array.isArray(latest?.genome) ? latest.genome.find((g: any) => g.service === id) : undefined;

  const changes = listOf(history.data, "observations").slice(0, 5);

  return (
    <div className="fixed inset-0 z-45" data-testid="service-detail-layer">
      <button type="button" aria-label="Close details" className="absolute inset-0 h-full w-full cursor-default bg-black/60 backdrop-blur-[1px]" onClick={onClose} tabIndex={-1} />
      <aside role="dialog" aria-modal="true" aria-labelledby="service-detail-title" data-testid="service-detail"
        className="absolute inset-x-0 bottom-0 flex max-h-[85vh] flex-col rounded-t-2xl border border-white/10 bg-obsidian-panel shadow-[0_-10px_40px_rgba(0,0,0,0.5)]
          lg:inset-y-0 lg:left-auto lg:right-0 lg:max-h-none lg:w-[480px] lg:rounded-none lg:rounded-l-2xl">
        <div className="flex items-start justify-between gap-3 border-b border-white/5 px-4 py-3">
          <div className="min-w-0">
            <h2 id="service-detail-title" className="truncate text-sm font-semibold text-white">{service.display_name ?? id}</h2>
            <div className="mono truncate text-[10px] text-slate-500">{id}</div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge tone={state.tone}>{state.label}</Badge>
            <button ref={closeRef} type="button" className="btn px-2 py-1" aria-label="Close" onClick={onClose}><X className="h-3.5 w-3.5" /></button>
          </div>
        </div>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto overflow-x-hidden px-4 pb-5 pt-1">
          <p className="pt-2 text-[11px] text-slate-500">Read only. Service records come from the DNA, the census and consensus deploys.</p>

          <Section title="Drift" source="GET /v1/drift">
            <Row label="State" value={state.label} />
            <Row label="Reasons" value={!drift ? null : reasons.length ? (
              <ul className="space-y-0.5">{reasons.map((r) => <li key={r}><span className="mono text-[11px] text-slate-300">{r}</span> <span className="text-slate-500">· {explainCode(r)}</span></li>)}</ul>
            ) : "none"} />
            <Row label="Desired version" value={short(service.desired_version)} />
            <Row label="Observed version" value={short(service.observed_version) ?? (reasons.includes("observed_version_unavailable") ? "not reported (untagged)" : null)} />
            <Row label="Last probe" value={probe ? ago(probe) : null} sub={probe ? "registry heartbeat" : undefined} />
            <Row label="State first seen" value={drift?.observed_at ? ago(drift.observed_at) : null} sub={typeof drift?.streak === "number" ? `seen by ${drift.streak >= 2 ? "2+ runs" : "1 run"}` : undefined} />
            <div className="mt-1.5">
              <div className="mb-1 text-[10px] uppercase tracking-widest text-slate-600">Recorded changes</div>
              {history.loading && !history.data ? <Skeleton rows={1} /> : history.error ? <Unmeasured why="drift history unavailable" /> : changes.length ? (
                <ul className="space-y-1">{changes.map((c: any) => (
                  <li key={c.observation_id} className="text-[11px]">
                    <span className="text-slate-500">{ago(c.observed_at)}</span>{" "}
                    <span className={c.drifted ? "text-rose-300" : "text-emerald-300"}>{c.drifted ? "drifted" : "in sync"}</span>{" "}
                    <span className="mono break-all text-slate-400">{driftReasons(c).join(", ") || "no reason"}</span>
                  </li>
                ))}</ul>
              ) : <Unmeasured why="no recorded observation" />}
            </div>
          </Section>

          <Section title="Vitals" source="GET /v1/observer · observer_vitals">
            {observer.loading && !observer.data ? <Skeleton rows={2} /> : !observerUp ? <Unmeasured why={o.configured === false ? "the Observer is not configured" : "the Observer view is unavailable"} /> : (<>
              {organ ? <div className="mb-1 text-[10px] text-slate-500">{series.length} stored hour{series.length === 1 ? "" : "s"} · last hour {ago(organ.last_hour)}</div>
                : <div className="mb-1 text-[11px] text-slate-500">{NOT_MEASURED}: no vitals stored for this Worker in the hours served</div>}
              <Vital label="Error rate" value={organ && typeof organ.measured?.error_rate === "number" ? pct(organ.measured.error_rate) : null} points={series.map((s) => s.error_rate)} />
              <Vital label="CPU p99" value={organ && typeof organ.measured?.cpu_p99_ms === "number" ? msv(organ.measured.cpu_p99_ms) : null} points={series.map((s) => s.cpu_p99_ms)} />
              <Vital label="Requests per hour" value={organ ? int(organ.measured?.requests) : null} points={series.map((s) => s.requests)} />
              <Row label="D1 rows per request" value={<Unmeasured why="D1 is not attributed to a Worker" />}
                sub={est && typeof est.value === "number" ? `account-wide ${est.value} · estimated` : undefined} />
            </>)}
          </Section>

          <Section title="Latest deploy" source="GET /v1/deployments">
            {deployments.loading && !deployments.data ? <Skeleton rows={2} /> : deployments.error ? <Unmeasured why="deployments unavailable" /> : (<>
              <Row label="Recorded version" value={recorded ? <span className="mono">{short(recorded.version)}</span> : null}
                sub={recorded ? `${ago(recorded.at)} · ${recorded.origin ?? recorded.actor ?? ""}${recorded.previous ? ` · was ${short(recorded.previous)}` : ""}` : "none among the last 100 recorded"} />
              <Row label="Latest request" value={request ? <span><Badge tone={request.status === "succeeded" ? "green" : request.status === "failed" ? "red" : "amber"}>{request.status}</Badge> <span className="mono">{short(request.version)}</span></span> : null}
                sub={request ? `${ago(request.created_at)} · ${request.origin ?? ""}${request.workflow ? ` · ${request.workflow}` : ""}` : "none among the last 100 requests"} />
              {request?.note && <p className="wrap-break-word text-[11px] text-slate-500">{request.note}</p>}
            </>)}
          </Section>

          <Section title="DNA" source="GET /v1/forge/census · genome">
            {census.loading && !census.data ? <Skeleton rows={2} /> : !latest ? <Unmeasured why="no census taken" /> : !gene ? (
              <p className="text-[12px] text-slate-500">{NOT_MEASURED}: not in the genome of main {short(latest.main_sha)} (census {ago(latest.taken_at)})</p>
            ) : (<>
              <Row label="Kind" value={gene.kind} sub={gene.origin ? `from ${gene.origin}` : `main ${short(latest.main_sha)} · ${ago(latest.taken_at)}`} />
              <Row label="Agents" value={Array.isArray(gene.agents) && gene.agents.length ? (
                <ul className="space-y-0.5">{gene.agents.map((a: any) => <li key={a.id}><span className="mono text-[11px]">{a.id}</span> <span className="text-[10px] text-slate-500">tier {a.tier_max}{a.voter ? " · council seat" : ""}{Array.isArray(a.capabilities) ? ` · ${a.capabilities.length} capabilities` : ""}</span></li>)}</ul>
              ) : "none declared"} />
              <Row label="AI engines" value={Array.isArray(gene.engines) && gene.engines.length ? <span className="mono text-[11px]">{gene.engines.join(", ")}</span> : "none declared"} />
            </>)}
          </Section>

          <Section title="Anomaly findings" source="GET /v1/observer · observer_findings, 7 days">
            {observer.loading && !observer.data ? <Skeleton rows={1} /> : !observerUp ? <Unmeasured why="the Observer view is unavailable" /> : findings.length ? (
              <ul className="space-y-1.5">{findings.slice(0, 10).map((f: any) => (
                <li key={f.finding_id} className="text-[11px]">
                  <div className="flex flex-wrap items-center gap-1.5"><Badge tone={severityTone(f.severity)}>{f.severity}</Badge><span className="mono text-slate-300">{f.metric}</span><span className="text-slate-500">{ago(f.created_at)}</span></div>
                  <p className="mt-0.5 wrap-break-word text-slate-400">{f.detail}</p>
                </li>
              ))}</ul>
            ) : <p className="text-[12px] text-slate-400">None for this Worker in the last 7 days.</p>}
          </Section>
        </div>
      </aside>
    </div>
  );
}
