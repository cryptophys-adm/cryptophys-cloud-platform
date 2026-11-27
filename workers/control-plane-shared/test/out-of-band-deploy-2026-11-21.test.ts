// Deploy provenance (owner 2026-11-21): on 21 Nov two `wrangler deploy` runs from a VPS replaced the AI Kernel with a
// build of an old checkout, and a secret of the Platform API was re-set. The platform read both as a harmless
// "dashboard change" and told nobody. The Orchestrator now reads each Worker's active version from Cloudflare, tells a
// settings change from a code upload, and the Owner page, the drift reason and a report say so.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { migratedDb } from "./harness.ts";
import {
  OOB_CLEARED, OOB_DETECTED, OOB_REASON, bindingNames, classifyVersion, lastProvenanceEvent, openCodeUpload, platformTags, provenanceReport, provenanceSweep, provenanceTargets, TRUSTED_REQUEST_STATUSES,
  type DeploymentLike, type ProvenanceReader, type VersionLike,
} from "../src/provenance.ts";
import { OOB_NOTIFIED, PROVENANCE_CRITICAL, PROVENANCE_DIRECT, provenanceTick } from "../../deployment-orchestrator/src/provenance-tick.ts";
import { WATCHED, watchOrchestrator } from "../../recovery-manager/src/provenance-watch.ts";
import { unhandledProblems } from "../../ai-kernel/src/owner-inbox.ts";
import { onlyUntaggedVersion } from "../../ai-kernel/src/supervisor.ts";
import { PROBLEM_KINDS } from "../src/owner-inbox-rank.ts";
import { explainReason } from "../src/plain.ts";

const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
const KERNEL = "cryptophys-ai-kernel", PAPI = "cryptophys-platform-api", CONSOLE = "cryptophys-console", ORCH = "cryptophys-deployment-orchestrator";
const MAIN = "1b6507682d40cfdba144ad89e2a6819523741a4b";
const TAG = MAIN.slice(0, 12);
const NOW = Date.parse("2026-11-21T00:40:00.000Z");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const version = (n: number, o: { tag?: string; etag: string; source?: string; trig?: string; bindings?: string[] }): VersionLike => ({
  id: id(n), annotations: { ...(o.tag ? { "workers/tag": o.tag } : {}), "workers/triggered_by": o.trig ?? "version_upload" }, metadata: { source: o.source ?? "api" },
  resources: { script: { etag: o.etag }, bindings: (o.bindings ?? ["d1:DB", "secret_text:CF_ACCOUNT_ID"]).map((b) => ({ type: b.split(":")[0], name: b.split(":")[1], text: "never read" })) },
});
/** A fake Cloudflare: per Worker, its deployments newest first, each one version. */
function cloudflare(state: Record<string, Array<{ at: string; source: string; v: VersionLike }>>, opts: { fail?: string[] } = {}) {
  const calls: string[] = [];
  const reader: ProvenanceReader = {
    async deployments(script) {
      calls.push(`deployments:${script}`);
      if (opts.fail?.includes(script)) throw new Error("cloudflare_api_500");
      return (state[script] ?? []).map((d): DeploymentLike => ({ created_on: d.at, source: d.source, versions: [{ version_id: d.v.id, percentage: 100 }] }));
    },
    async version(script, versionId) {
      calls.push(`version:${script}`);
      const d = (state[script] ?? []).find((x) => x.v.id === versionId);
      if (!d) throw new Error("cloudflare_api_404");
      return d.v;
    },
  };
  return { reader, calls };
}
function db0() {
  const db = migratedDb();
  for (const s of [KERNEL, PAPI, CONSOLE, ORCH]) {
    db.raw.prepare(`INSERT INTO service_registry (service_id, display_name, environment, status, desired_version, created_at, updated_at) VALUES (?, ?, 'production', 'healthy', ?, '2026-11-01T00:00:00.000Z', '2026-11-20T12:00:00.000Z')
      ON CONFLICT(service_id) DO UPDATE SET status = 'healthy', desired_version = excluded.desired_version`).run(s, s, TAG);
  }
  return db;
}
const events = (db: ReturnType<typeof migratedDb>, type: string) =>
  (db.raw.prepare("SELECT subject, outcome, payload_json FROM audit_events WHERE event_type = ? ORDER BY rowid").all(type) as any[]).map((r) => ({ subject: r.subject, outcome: r.outcome, payload: JSON.parse(r.payload_json) }));
function agents() {
  const published: Array<{ agent: string; severity: string; subject: string; body: Record<string, unknown> }> = [];
  const binding = {
    async whoami() { return {}; }, async observe() { return {}; },
    async syscall(agent: string, capability: string, input?: Record<string, unknown>) {
      assert.equal(capability, "reports.publish");
      published.push({ agent, severity: String(input?.severity), subject: String(input?.subject), body: input?.body as Record<string, unknown> });
      return { outcome: "succeeded" };
    },
  };
  return { binding: binding as never, published };
}
// 21 Nov as Cloudflare recorded it: the native deploy of 1b65076 on 20 Nov, then wrangler.
const native = version(1, { tag: TAG, etag: "cefef1c6f4" });
const wrangler1 = version(2, { etag: "29de3333c7", source: "wrangler", bindings: ["d1:DB", "secret_text:CF_ACCOUNT_ID", "analytics_engine:ANALYTICS_AGENT_RUNTIME"] });
const wrangler2 = version(3, { etag: "507d37bdf6", source: "wrangler", bindings: ["d1:DB", "secret_text:CF_ACCOUNT_ID", "analytics_engine:ANALYTICS_AGENT_RUNTIME"] });
const secret = version(4, { etag: "aaaa000001", source: "wrangler", trig: "secret" });
const papiNative = version(5, { tag: TAG, etag: "aaaa000001" });

test("OB1. a version is the platform's by its tag, a settings change when the code is the platform's, and a code upload otherwise", () => {
  const tags = new Set([TAG]);
  assert.equal(classifyVersion(native, tags, null).kind, "platform");
  const code = classifyVersion(wrangler1, tags, native);
  assert.deepEqual([code.kind, code.code_same, code.bindings_added, code.bindings_removed], ["code_upload", false, ["analytics_engine:ANALYTICS_AGENT_RUNTIME"], []]);
  const settings = classifyVersion(secret, tags, papiNative);
  assert.deepEqual([settings.kind, settings.code_same, settings.bindings_added], ["settings_change", true, []]);
  // A tag the platform never deployed is not trusted, whatever the code.
  assert.equal(classifyVersion(version(9, { tag: "ffffffffffff", etag: "cefef1c6f4" }), tags, native).kind, "settings_change", "the same code under another tag is still the platform's code");
  assert.equal(classifyVersion(version(9, { tag: "ffffffffffff", etag: "other" }), tags, native).kind, "code_upload");
  // No reference: only Cloudflare's own "secret" trigger reads as a settings change; anything else fails closed.
  assert.equal(classifyVersion(secret, tags, null).kind, "settings_change");
  assert.equal(classifyVersion(wrangler1, tags, null).kind, "code_upload");
  assert.equal(classifyVersion(version(9, { etag: "" }), tags, version(8, { tag: TAG, etag: "" })).kind, "code_upload", "no etag to compare is not called harmless");
  assert.deepEqual(bindingNames(native), ["d1:DB", "secret_text:CF_ACCOUNT_ID"], "names only");
  assert.ok(!JSON.stringify(code).includes("never read"), "never a binding value");
});

test("OB2. 21 Nov: the kernel's wrangler upload is recorded once per version as a code upload, and cleared when a platform version runs again", async () => {
  const db = db0();
  const state = { [KERNEL]: [{ at: "2026-11-21T00:32:49.839Z", source: "wrangler", v: wrangler1 }, { at: "2026-11-20T12:26:36.324Z", source: "api", v: native }] };
  const cf = cloudflare(state);
  const targets = await provenanceTargets(db as never, [KERNEL]);
  assert.deepEqual(targets.map((t) => [t.service_id, t.desired_version]), [[KERNEL, TAG]]);
  const first = await provenanceSweep(db as never, cf.reader, targets, "test", NOW);
  assert.deepEqual([first.checked, first.findings.length, first.cleared, first.unreadable], [1, 1, [], []]);
  const f = first.findings[0];
  assert.deepEqual([f.kind, f.version_id, f.deployed_at, f.source, f.code_same, f.reference_version_id, f.recorded], ["code_upload", id(2), "2026-11-21T00:32:49.839Z", "wrangler", false, id(1), true]);
  assert.deepEqual(events(db, OOB_DETECTED).map((e) => [e.subject, e.outcome, e.payload.version_id]), [[KERNEL, "code_upload", id(2)]]);
  assert.deepEqual(await openCodeUpload(db as never, KERNEL), { version_id: id(2), deployed_at: "2026-11-21T00:32:49.839Z", source: "wrangler", detected_at: (await lastProvenanceEvent(db as never, KERNEL))!.created_at });
  // The next pass: the same version is not recorded again.
  const again = await provenanceSweep(db as never, cf.reader, targets, "test", NOW + 30 * 60_000);
  assert.equal(again.findings[0].recorded, false);
  assert.equal(events(db, OOB_DETECTED).length, 1);
  // 11:43: a second upload is a new version, so a new event.
  state[KERNEL].unshift({ at: "2026-11-21T11:43:43.939Z", source: "wrangler", v: wrangler2 });
  const second = await provenanceSweep(db as never, cf.reader, targets, "test", NOW + 12 * 3_600_000);
  assert.deepEqual([second.findings[0].version_id, second.findings[0].recorded, second.findings[0].reference_version_id], [id(3), true, id(1)]);
  assert.equal(events(db, OOB_DETECTED).length, 2);
  // The platform deploys main again: cleared, and nothing is open.
  state[KERNEL].unshift({ at: "2026-11-21T16:00:00.000Z", source: "api", v: version(6, { tag: TAG, etag: "cefef1c6f4" }) });
  const healed = await provenanceSweep(db as never, cf.reader, targets, "test", NOW + 16 * 3_600_000);
  assert.deepEqual([healed.findings, healed.cleared], [[], [KERNEL]]);
  assert.deepEqual(events(db, OOB_CLEARED).map((e) => [e.subject, e.payload.was, e.payload.was_version_id]), [[KERNEL, "code_upload", id(3)]]);
  assert.equal(await openCodeUpload(db as never, KERNEL), null);
  assert.deepEqual((await provenanceSweep(db as never, cf.reader, targets, "test", NOW + 17 * 3_600_000)).cleared, [], "cleared once");
});

test("OB3. a secret change is a settings change; a deploy the platform is running is trusted by its tag; an unreadable Worker records nothing", async () => {
  const db = db0();
  const next = "aea4703b7e0f";
  db.raw.prepare(`INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, idempotency_key, details_json, created_at, updated_at)
    VALUES ('dep_1', ?, ?, 'test', 'running', 'k1', ?, ?, ?)`).run(CONSOLE, next, JSON.stringify({ executor: "native:deploy", version_tag: next }), "2026-11-21T00:30:00.000Z", "2026-11-21T00:30:00.000Z");
  const cf = cloudflare({
    [PAPI]: [{ at: "2026-11-21T00:33:09.064Z", source: "wrangler", v: secret }, { at: "2026-11-20T13:10:16.649Z", source: "api", v: papiNative }],
    [CONSOLE]: [{ at: "2026-11-21T00:31:00.000Z", source: "api", v: version(7, { tag: next, etag: "new" }) }],
  }, { fail: [KERNEL] });
  const r = await provenanceSweep(db as never, cf.reader, await provenanceTargets(db as never, [KERNEL, PAPI, CONSOLE]), "test", NOW);
  assert.deepEqual([r.checked, r.unreadable, r.cleared], [2, [KERNEL], []]);
  assert.deepEqual(r.findings.map((f) => [f.service_id, f.kind, f.code_same, f.triggered_by]), [[PAPI, "settings_change", true, "secret"]], "the Console's running deploy is the platform's");
  assert.deepEqual(events(db, OOB_DETECTED).map((e) => [e.subject, e.outcome]), [[PAPI, "settings_change"]]);
  assert.equal(await openCodeUpload(db as never, PAPI), null, "a settings change is not a code upload");
  assert.equal(await openCodeUpload(db as never, KERNEL), null);
});

test("OB4. the Orchestrator's check: critical for the kernel, a warning for another Worker, information for a settings change, each published once", async () => {
  const db = db0();
  const cf = cloudflare({
    [KERNEL]: [{ at: "2026-11-21T00:32:49.839Z", source: "wrangler", v: wrangler1 }, { at: "2026-11-20T12:26:36.324Z", source: "api", v: native }],
    [CONSOLE]: [{ at: "2026-11-21T00:35:00.000Z", source: "wrangler", v: version(8, { etag: "rogue", source: "wrangler" }) }, { at: "2026-11-20T13:23:11.000Z", source: "api", v: version(10, { tag: TAG, etag: "console" }) }],
    [PAPI]: [{ at: "2026-11-21T00:33:09.064Z", source: "wrangler", v: secret }, { at: "2026-11-20T13:10:16.649Z", source: "api", v: papiNative }],
    [ORCH]: [{ at: "2026-11-20T12:08:11.000Z", source: "api", v: version(11, { tag: TAG, etag: "orch" }) }],
  });
  const a = agents();
  assert.deepEqual(await provenanceTick({ DB: db as never, AGENTS: a.binding }, NOW), { outcome: "not_configured" }, "no token, no check");
  const r = await provenanceTick({ DB: db as never, AGENTS: a.binding }, NOW, cf.reader);
  assert.ok("findings" in r && r.findings.length === 3);
  const by = (s: string) => a.published.find((p) => p.body.service_id === s)!;
  assert.deepEqual(a.published.map((p) => p.agent), ["deployment-orchestrator", "deployment-orchestrator", "deployment-orchestrator"]);
  assert.deepEqual([by(KERNEL).severity, by(CONSOLE).severity, by(PAPI).severity], ["critical", "warning", "info"]);
  assert.match(by(KERNEL).subject, /^AI Kernel runs code the platform did not deploy \(uploaded by wrangler at 2026-11-21T00:32:49\.839Z\)$/);
  assert.match(String(by(KERNEL).body.explanation), /Bindings added: analytics_engine:ANALYTICS_AGENT_RUNTIME\..*break-glass plan/);
  assert.equal(by(KERNEL).body.alert_key, `out_of_band:${KERNEL}:${id(2)}`);
  // 21 Nov 21:35Z: the first text said the agents do not redeploy the kernel, which read as if only break-glass could restore it;
  // the brake is what holds the routine deploy, and acknowledging the report releases it.
  assert.match(String(by(KERNEL).body.explanation), /the council rejects every proposal \(the critical-report brake\)/);
  assert.match(String(by(KERNEL).body.explanation), /Acknowledge it on the Owner page: the routine deploy of main then restores this Worker/);
  assert.doesNotMatch(String(by(KERNEL).body.explanation), /do not redeploy/);
  assert.match(String(by(CONSOLE).body.explanation), /The Supervisor plans a redeploy of the desired version/);
  assert.match(by(PAPI).subject, /^A setting or secret of Platform API changed outside a deploy/);
  assert.deepEqual([...PROVENANCE_CRITICAL], [KERNEL, ORCH]);
  // The next tick publishes nothing new.
  await provenanceTick({ DB: db as never, AGENTS: a.binding }, NOW + 30 * 60_000, cf.reader);
  assert.equal(a.published.length, 3);
  assert.equal(provenanceReport({ ...("findings" in r ? r.findings[0] : null)!, kind: "code_upload" }, "X", false).severity, "warning");
});

test("OB5. the Owner page lists a code upload at once (out_of_band_deploy), not a settings change, and closes it when the platform's version runs again", async () => {
  const db = db0();
  const state = {
    [KERNEL]: [{ at: "2026-11-21T00:32:49.839Z", source: "wrangler", v: wrangler1 }, { at: "2026-11-20T12:26:36.324Z", source: "api", v: native }],
    [PAPI]: [{ at: "2026-11-21T00:33:09.064Z", source: "wrangler", v: secret }, { at: "2026-11-20T13:10:16.649Z", source: "api", v: papiNative }],
  };
  const cf = cloudflare(state);
  const oob = async (at: number) => (await unhandledProblems(db as never, at)).filter((p) => p.code === "out_of_band_deploy");
  assert.deepEqual(await oob(Date.now()), []);
  await provenanceSweep(db as never, cf.reader, await provenanceTargets(db as never, [KERNEL, PAPI]), "test", NOW);
  const listed = await oob(Date.now() + 60_000);
  assert.deepEqual(listed.map((p) => [p.subject, p.since, p.link]), [[KERNEL, "2026-11-21T00:32:49.839Z", "#/infrastructure"]]);
  assert.match(listed[0].detail, /^AI Kernel runs code that the platform did not deploy: version 00000000 became active at 2026-11-21T00:32:49\.839Z by wrangler, outside the consensus deploy\. If it was not you, treat the account's credentials as exposed\./);
  assert.deepEqual(PROBLEM_KINDS.out_of_band_deploy, { urgency: "critical", blocks: ["deploys"] });
  assert.match(read("workers/console/ui/src/pages/Owner.tsx"), /out_of_band_deploy: "code not deployed by the platform"/);
  state[KERNEL].unshift({ at: "2026-11-21T16:00:00.000Z", source: "api", v: version(6, { tag: TAG, etag: "cefef1c6f4" }) });
  await provenanceSweep(db as never, cf.reader, await provenanceTargets(db as never, [KERNEL, PAPI]), "test", NOW + 16 * 3_600_000);
  assert.deepEqual(await oob(Date.now() + 120_000), []);
});

test("OB6. the drift reason ends the 'harmless untagged version' reading; the Recovery Manager watches the Orchestrator; both checks are wired", async () => {
  assert.equal(OOB_REASON, "out_of_band_code_upload");
  assert.equal(onlyUntaggedVersion({ reasons: ["observed_version_unavailable"] }), true, "a secret change alone stays informational");
  assert.equal(onlyUntaggedVersion({ reasons: ["observed_version_unavailable", OOB_REASON] }), false, "a code upload is planned for, like any drift");
  assert.match(explainReason(OOB_REASON), /runs code that the platform did not deploy/);
  const detector = read("workers/drift-detector/src/index.ts");
  assert.match(detector, /if \(managed && drifted && p\.version_tag !== row\.desired_version && await openCodeUpload\(env\.DB, row\.service_id\)\) reasons\.push\(OOB_REASON\);/);
  // The Recovery Manager's check of the Orchestrator alone, critical, with its own token.
  const db = db0();
  const a = agents();
  assert.deepEqual(await watchOrchestrator({ DB: db as never, AGENTS: a.binding }, NOW), { outcome: "not_configured" });
  const cf = cloudflare({ [ORCH]: [{ at: "2026-11-21T01:00:00.000Z", source: "wrangler", v: version(12, { etag: "rogue", source: "wrangler" }) }, { at: "2026-11-20T12:08:11.000Z", source: "api", v: version(11, { tag: TAG, etag: "orch" }) }] });
  const r = await watchOrchestrator({ DB: db as never, AGENTS: a.binding }, NOW, cf.reader);
  assert.ok("findings" in r && r.findings[0].kind === "code_upload");
  assert.deepEqual(cf.calls.filter((c) => c.startsWith("deployments:")), [`deployments:${ORCH}`], "only the Orchestrator");
  assert.deepEqual(a.published.map((p) => [p.agent, p.severity]), [["recovery-manager", "critical"]]);
  assert.equal(WATCHED, ORCH);
  assert.match(read("workers/deployment-orchestrator/src/index.ts"), /if \(minute === 10 \|\| minute === 40\) ctx\.waitUntil\(provenanceTick\(env, at\)/);
  assert.match(read("workers/recovery-manager/src/index.ts"), /ctx\.waitUntil\(watchOrchestrator\(env as never\)/);
});

test("OB7. the alarm outside the kernel: a code upload on the AI Kernel goes straight to the owner's Telegram from the Orchestrator, once, and is audited", async () => {
  const db = db0();
  const state = {
    [KERNEL]: [{ at: "2026-11-21T00:32:49.839Z", source: "wrangler", v: wrangler1 }, { at: "2026-11-20T12:26:36.324Z", source: "api", v: native }],
    [CONSOLE]: [{ at: "2026-11-21T00:35:00.000Z", source: "wrangler", v: version(8, { etag: "rogue", source: "wrangler" }) }, { at: "2026-11-20T13:23:11.000Z", source: "api", v: version(10, { tag: TAG, etag: "console" }) }],
    [PAPI]: [{ at: "2026-11-21T00:33:09.064Z", source: "wrangler", v: secret }, { at: "2026-11-20T13:10:16.649Z", source: "api", v: papiNative }],
  };
  const cf = cloudflare(state);
  const sent: Array<{ change: string; title: string; lines: string[]; link: string }> = [];
  let fail = false;
  const telegram = { notify: async (n: { change: string; title: string; lines: string[]; link: string }) => { if (fail) throw new Error("bot down"); sent.push(n); return { sent: true }; } };
  // The kernel's report path is gone (a replaced kernel): no AGENTS binding at all. The owner still hears.
  await provenanceTick({ DB: db as never, OWNER_TELEGRAM: telegram }, NOW, cf.reader);
  assert.deepEqual(sent.map((n) => [n.change, n.title, n.link]), [["opened", "AI Kernel runs code the platform did not deploy", "https://nexus.cryptophys.work/console/#/owner"]], "the kernel only: the Console and a secret change go the usual way");
  assert.match(sent[0].lines[0], /^Version 00000000 became active at 2026-11-21T00:32:49\.839Z by wrangler, outside the consensus deploy \(expected 1b6507682d40\)\.$/);
  assert.deepEqual(sent[0].lines.slice(1), ["Bindings added: analytics_engine:ANALYTICS_AGENT_RUNTIME", "This message comes from the Deployment Orchestrator, not from the AI Kernel. If it was not you, treat the account's credentials as exposed."]);
  assert.deepEqual(events(db, OOB_NOTIFIED).map((e) => [e.subject, e.outcome, e.payload.result]), [[KERNEL, "sent", "sent"]]);
  assert.deepEqual([...PROVENANCE_DIRECT], [KERNEL]);
  // The same version at the next tick: nothing more.
  await provenanceTick({ DB: db as never, OWNER_TELEGRAM: telegram }, NOW + 30 * 60_000, cf.reader);
  assert.equal(sent.length, 1);
  // A second upload while the bot is down, and without the binding: audited as failed, nothing thrown.
  fail = true;
  state[KERNEL].unshift({ at: "2026-11-21T11:43:43.939Z", source: "wrangler", v: wrangler2 });
  await provenanceTick({ DB: db as never, OWNER_TELEGRAM: telegram }, NOW + 12 * 3_600_000, cf.reader);
  state[KERNEL].unshift({ at: "2026-11-21T12:00:00.000Z", source: "wrangler", v: version(13, { etag: "third", source: "wrangler" }) });
  await provenanceTick({ DB: db as never }, NOW + 13 * 3_600_000, cf.reader);
  assert.deepEqual(events(db, OOB_NOTIFIED).map((e) => [e.outcome, e.payload.result]), [["sent", "sent"], ["failed", "failed: bot down"], ["failed", "failed: owner_telegram_not_bound"]]);
  // The binding is the kernel's own default channel: the xauusd OwnerNotifier; the Orchestrator holds no bot token.
  const toml = read("workers/deployment-orchestrator/wrangler.toml");
  assert.match(toml, /\[\[services\]\]\nbinding = "OWNER_TELEGRAM"\nservice = "xauusd-ai-trading-assistant"\nentrypoint = "OwnerNotifier"\n/);
  assert.doesNotMatch(toml, /TELEGRAM_BOT|BOT_TOKEN/);
});

test("OB8. review 2026-11-27: a consensus deploy through the unit's GitHub workflow (no version_tag in its request) is the platform's by its requested commit, for every Worker of the unit; a foreign tag still is a code upload", async () => {
  const db = db0();
  const sha = "0754003a1b2c3d4e5f60718293a4b5c6d7e8f901", tag = sha.slice(0, 12);
  // As deploy-orchestrator index.ts records a workflow fallback: requested_version is the commit, details_json has no version_tag.
  const workflow = JSON.stringify({ workflow: "deploy-control-plane.yml", unit: "control-plane", ref: "main", workflows: [], proposal_id: "cns_1", policy_decision_id: "pd_1" });
  db.raw.prepare(`INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, idempotency_key, details_json, created_at, updated_at)
    VALUES ('dep_w', ?, ?, 'consensus', 'running', 'k-w', ?, ?, ?)`).run(KERNEL, sha, workflow, "2026-11-21T00:30:00.000Z", "2026-11-21T00:30:00.000Z");
  const DRIFT = "cryptophys-drift-detector";
  db.raw.prepare(`INSERT INTO service_registry (service_id, display_name, environment, status, desired_version, created_at, updated_at) VALUES (?, ?, 'production', 'healthy', ?, '2026-11-01T00:00:00.000Z', '2026-11-20T12:00:00.000Z')
    ON CONFLICT(service_id) DO UPDATE SET status = 'healthy', desired_version = excluded.desired_version`).run(DRIFT, DRIFT, TAG);
  const cf = cloudflare({
    // wrangler deploy --tag <commit:12> by the workflow, before the ledger moves the desired version.
    [KERNEL]: [{ at: "2026-11-21T00:34:00.000Z", source: "wrangler", v: version(8, { tag, etag: "wf-kernel", source: "wrangler" }) }, { at: "2026-11-20T13:10:16.649Z", source: "api", v: native }],
    [DRIFT]: [{ at: "2026-11-21T00:34:10.000Z", source: "wrangler", v: version(9, { tag, etag: "wf-drift", source: "wrangler" }) }, { at: "2026-11-20T13:10:16.649Z", source: "api", v: version(10, { tag: TAG, etag: "d0" }) }],
    // The Console is in no unit with that request: the same tag there is not trusted.
    [CONSOLE]: [{ at: "2026-11-21T00:35:00.000Z", source: "wrangler", v: version(11, { tag, etag: "c1", source: "wrangler" }) }, { at: "2026-11-20T13:10:16.649Z", source: "api", v: version(12, { tag: TAG, etag: "c0" }) }],
  });
  const r = await provenanceSweep(db as never, cf.reader, await provenanceTargets(db as never, [KERNEL, DRIFT, CONSOLE]), "test", NOW);
  assert.equal(r.checked, 3);
  assert.deepEqual(r.findings.map((f) => [f.service_id, f.kind]), [[CONSOLE, "code_upload"]], "the kernel and the drift detector run the platform's workflow deploy");
  assert.deepEqual(events(db, OOB_DETECTED).map((e) => e.subject), [CONSOLE]);
  // A request outside the window is not trusted.
  const late = await provenanceSweep(db as never, cf.reader, await provenanceTargets(db as never, [KERNEL]), "test", NOW + 49 * 3_600_000);
  assert.deepEqual(late.findings.map((f) => [f.service_id, f.kind]), [[KERNEL, "code_upload"]]);
  // Coordinator review: only an approved, running or succeeded request is the platform's, by either tag. A pending,
  // rejected, cancelled or failed one for the same unit and commit leaves a code upload under that tag flagged.
  assert.deepEqual([...TRUSTED_REQUEST_STATUSES], ["approved", "running", "succeeded"]);
  for (const status of ["pending", "rejected", "cancelled", "failed"]) {
    const d = db0();
    d.raw.prepare(`INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, idempotency_key, details_json, created_at, updated_at)
      VALUES ('dep_w', ?, ?, 'consensus', ?, 'k-w', ?, ?, ?)`).run(KERNEL, sha, status, workflow, "2026-11-21T00:30:00.000Z", "2026-11-21T00:30:00.000Z");
    d.raw.prepare(`INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, idempotency_key, details_json, created_at, updated_at)
      VALUES ('dep_n', ?, ?, 'consensus', ?, 'k-n', ?, ?, ?)`).run(KERNEL, sha, status, JSON.stringify({ executor: "native:deploy", version_tag: tag }), "2026-11-21T00:31:00.000Z", "2026-11-21T00:31:00.000Z");
    const r2 = await provenanceSweep(d as never, cf.reader, await provenanceTargets(d as never, [KERNEL]), "test", NOW);
    assert.deepEqual(r2.findings.map((f) => [f.service_id, f.kind]), [[KERNEL, "code_upload"]], status);
    assert.deepEqual([...(await platformTags(d as never, KERNEL, TAG, NOW))], [TAG], status);
  }
  for (const status of ["approved", "succeeded"]) {
    const d = db0();
    d.raw.prepare(`INSERT INTO deployment_requests (request_id, service_id, requested_version, requested_by, status, idempotency_key, details_json, created_at, updated_at)
      VALUES ('dep_w', ?, ?, 'consensus', ?, 'k-w', ?, ?, ?)`).run(KERNEL, sha, status, workflow, "2026-11-21T00:30:00.000Z", "2026-11-21T00:30:00.000Z");
    assert.deepEqual([...(await platformTags(d as never, DRIFT, TAG, NOW))], [TAG, tag], status);
  }
});
