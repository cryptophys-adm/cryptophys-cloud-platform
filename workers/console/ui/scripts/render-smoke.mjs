// Wave C: render every Console screen in Chromium, in CI, at phone and desktop widths, under
// the ADR-0010 /console/ mount, against an empty-but-valid mocked API. Fails on any page error,
// failed request, CSP-breaking inline script, or horizontal scroll. No credentials or network.
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const ROUTES = ["owner", "", "agents", "agents/supervisor", "cognition", "consensus", "knowledge", "recovery", "recovery/plan_00000000-0000-0000-0000-000000000000",
  "infrastructure", "policy", "ledger", "pipelines", "markets", "users", "code", "organism"];
const MOCK = {
  "/api/whoami": { actor: "owner@example.com", type: "user", operator: true, approver: true, role: "approver", owner: true, viewer: false },
  "/api/registry/v1/accounts": {
    owners: ["owner@example.com"], configured_operators: [], login_sync: "not_configured",
    accounts: [
      { email: "analyst.with.a.rather.long.address@example-company.co.id", kind: "admin", privilege: "viewer", status: "active", note: "read only", created_by: "owner@example.com", created_at: "2026-11-07T09:00:00Z", updated_by: "owner@example.com", updated_at: "2026-11-07T09:00:00Z" },
      { email: "trader@example.com", kind: "user", privilege: null, status: "disabled", note: null, created_by: "owner@example.com", created_at: "2026-11-07T09:00:00Z", updated_by: "owner@example.com", updated_at: "2026-11-07T09:05:00Z" },
    ],
  },
  "/api/kernel/v1/consensus": { mode: "shadow", stats_24h: {}, proposals: [] },
  "/api/forge/v1/forge/status": { configured: true, source: "https://github.com/cryptophys-adm/cryptophys-cloud-platform", repo: { name: "platform", default_branch: "main", last_push_at: null }, head: { sha: "3dbbead07e50e78fedd94db712f38a0f7eb0cdb4", title: "fix(forge): read Artifacts commit metadata defensively (#215)", author: "cryptophys-adm", date: "2026-11-08T05:18:00.000Z" } },
  "/api/forge/v1/forge/checks": { parity: { target: 20, consecutive: 1, compared: 2, disagreements: ["8588e21c0ffee0000000000000000000000000000"] }, checks: [
    { commit: "3dbbead07e50e78fedd94db712f38a0f7eb0cdb4", status: "passed", runner: "forge-runner/1", files: 44, pass: 339, fail: 0, skip: 0, failures: [], started_at: "2026-11-08T09:34:00.000Z", finished_at: "2026-11-08T09:34:43.000Z", duration_ms: 43000, bundles: { workers: 11, failed: 0 }, guard_status: "clean", typecheck: { status: "failed", errors: 12, build_id: "b-1" }, github: "success", agrees: true },
    { commit: "8588e21c0ffee0000000000000000000000000000", status: "failed", runner: "forge-runner/1", files: 43, pass: 321, fail: 1, skip: 0, failures: ["home-tp025.test.ts :: TP-025 Home Worker Wrangler dry-run bundle: child_process is not available in the Forge runner, which is a very long line that has to wrap on a phone"], started_at: "2026-11-08T09:19:49.000Z", finished_at: "2026-11-08T09:20:33.000Z", duration_ms: 43287, github: "success", agrees: false },
  ] },
  "/api/forge/v1/forge/changes": { parity: { target: 10, consecutive: 1, compared: 1, late: 1, disagreements: [] }, changes: [
    { cr_id: "fg-claude-work-repo-push-with-a-rather-long-branch-name-x9", source: "forge", repo: "platform-work", blocked_reason: null, number: 0, branch: "claude/work-repo-push-with-a-rather-long-branch-name-x9", source_branch: "claude/work-repo-push-with-a-rather-long-branch-name-x9", title: "forge: a branch pushed to platform-work instead of a pull request", author: "Claude", head_sha: "4f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6", base_sha: "3dbbead07e50e78fedd94db712f38a0f7eb0cdb4", github_ci: null, status: "open", changed_paths: ["A workers/forge/src/work-repo.ts"], critical: [], check: { status: "passed", pass: 551, fail: 0, guard_status: "clean", typecheck: { status: "not_configured", errors: null, build_id: null, console_build: null }, ready: false }, verdict: "pending", reasons: ["no type-check source for this head: change requests pushed to platform-work have none yet (ADR-0012 §5j)"], merge_sha: null, agrees: null, created_at: "2026-11-12T07:00:00.000Z", updated_at: "2026-11-12T07:05:00.000Z", outcome_at: null },
    { cr_id: "fg-agent-stale", source: "forge", repo: "platform-work", blocked_reason: "not_based_on_main", number: 0, branch: "agent/stale", source_branch: "agent/stale", title: "agent: work on an old main", author: "pi", head_sha: "5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b", base_sha: "3dbbead07e50e78fedd94db712f38a0f7eb0cdb4", github_ci: null, status: "open", changed_paths: [], critical: [], check: null, verdict: "blocked", reasons: ["not_based_on_main: the head does not contain canonical main; merge or rebase main into the branch and push again"], merge_sha: null, agrees: null, created_at: "2026-11-12T06:00:00.000Z", updated_at: "2026-11-12T06:05:00.000Z", outcome_at: null },
    { cr_id: "gh-247", source: "github", repo: "platform", blocked_reason: null, number: 247, branch: "cr/247", source_branch: "claude/gracious-brown-tkc4e8", title: "forge: change requests in shadow, with a title long enough to wrap on a phone screen", author: "cryptophys-adm", head_sha: "3dbbead07e50e78fedd94db712f38a0f7eb0cdb4", base_sha: "8588e21c0ffee0000000000000000000000000000", github_ci: "success", status: "open", changed_paths: ["A workers/forge/src/changes.ts", "M architecture/adr/0012-github-independence.md"], critical: ["adr_0009_0012: architecture/adr/0012-github-independence.md"], check: { status: "passed", pass: 390, fail: 0, guard_status: "clean", typecheck: { status: "passed", errors: 0, build_id: "b", console_build: "passed" }, ready: true }, verdict: "needs_owner", reasons: ["adr_0009_0012: architecture/adr/0012-github-independence.md"], merge_sha: null, agrees: null, created_at: "2026-11-09T07:00:00.000Z", updated_at: "2026-11-09T07:05:00.000Z", outcome_at: null },
    { cr_id: "gh-246", source: "github", repo: "platform", blocked_reason: null, number: 246, branch: "cr/246", source_branch: "claude/gracious-brown-tkc4e8", title: "recovery: retire superseded drafts", author: "cryptophys-adm", head_sha: "bcd30c5b4e45f0921ae9fcbc3ccaee8c22a2e9f8", base_sha: "188b6bb31ed1a17cdaec44ea6180da087395e973", github_ci: "success", status: "merged", changed_paths: ["A workers/recovery-manager/src/superseded.ts"], critical: [], check: null, verdict: "would_merge", reasons: [], merge_sha: "b6979583cb906646513a922cd854a17e92e54d94", agrees: true, created_at: "2026-11-09T06:00:00.000Z", updated_at: "2026-11-09T06:10:00.000Z", outcome_at: "2026-11-09T06:10:00.000Z" },
  ] },
  "/api/forge/v1/forge/deploy-plans": { parity: { target: 10, consecutive: 2, compared: 3, disagreements: ["5bc3c94b14d1"] }, plans: [
    { main_sha: "9a6a31f2ae8af6ca4a57ddc976787ecbc63d7dde", forge_units: ["control-plane"], forge_skipped: [{ unit: "forge", reason: "control_plane_migration_first" }], forge_at: "2026-11-09T07:19:00.000Z", github_units: ["control-plane"], github_skipped: [], github_at: "2026-11-09T07:20:00.000Z", agrees: true },
    { main_sha: "188b6bb31ed1a17cdaec44ea6180da087395e973", forge_units: [], forge_skipped: [], forge_at: "2026-11-09T06:19:00.000Z", github_units: null, github_skipped: null, github_at: null, agrees: null },
  ] },
  "/api/forge/v1/forge/census": { census: [{ main_sha: "6872844" + "0".repeat(33), status: "changes", organs: 12, agents: 10, engines: 9, voters: 9, taken_at: "2026-11-09T12:04:00.000Z",
    findings: [{ kind: "unregistered_agent", subject: "forge-steward", detail: "agent forge-steward on cryptophys-forge is in the DNA but not registered (asks for a council seat), which is a long line that wraps on a phone" }], genome: [] }] },
  "/api/forge/v1/forge/build-usage": { usage: { schema: "build-usage.v1", month: "2026-11", month_start: "2026-11-01T00:00:00.000Z", budget_minutes: 3000, included_minutes: { free: 3000, paid: 6000 }, warn_ratio: 0.8,
    minutes: 412, builds: 214, unmeasured_builds: 1, avg_minutes: 1.9, projected_minutes: 1030, status: "ok",
    by_worker: [{ worker: "cryptophys-forge-typecheck", builds: 120, minutes: 240, unmeasured: 0 }, { worker: "cryptophys-forge-typecheck-cr", builds: 90, minutes: 166, unmeasured: 1 }, { worker: "cryptophys-aether", builds: 4, minutes: 6, unmeasured: 0 }],
    by_day: [{ day: "2026-11-12", builds: 20, minutes: 41 }], last_collection: { collected_at: "2026-11-12T09:04:00.000Z", outcome: "collected", workers: 3, builds_seen: 60, builds_new: 4, error: null }, observed_at: "2026-11-12T09:10:00.000Z" },
    builds: [{ build_uuid: "b-1", worker: "cryptophys-forge-typecheck-cr", branch: "cr/299", commit_sha: "b4766dc8f33efc2d8eab859314a8e2280ce6f5bf", outcome: "success", status: "stopped", created_on: "2026-11-12T07:47:50.000Z", stopped_on: "2026-11-12T07:49:40.000Z", duration_s: 104, billed_minutes: 2, queued_s: 3 },
      { build_uuid: "b-2", worker: "cryptophys-forge-typecheck", branch: "main", commit_sha: null, outcome: null, status: "stopped", created_on: "2026-11-12T08:10:00.000Z", stopped_on: null, duration_s: null, billed_minutes: null, queued_s: null }] },
  "/api/forge/v1/forge/dependency-audit": { audit: { schema: "dependency-audit.v1", status: "action_needed", stale: false,
    latest_run: { run_id: "dep_3dbbead07e50_1", main_sha: "3dbbead07e50e78fedd94db712f38a0f7eb0cdb4", ran_at: "2026-11-12T09:19:00.000Z", status: "failed", lockfiles: 0, packages: 0, advisories: 0, critical: 0, high: 0, moderate: 0, low: 0, info: 0, error: "advisories_http_503" },
    last_ok_run: { run_id: "dep_8588e21c0ffe_1", main_sha: "8588e21c0ffee0000000000000000000000000000", ran_at: "2026-11-11T09:19:00.000Z", status: "ok", lockfiles: 4, packages: 327, advisories: 2, critical: 0, high: 1, moderate: 1, low: 0, info: 0, error: null },
    findings: [
      { package: "@scope/a-package-with-a-rather-long-name", version: "1.2.3", advisory_id: "1100001", severity: "high", title: "Prototype pollution in a long advisory title that has to wrap on a phone screen", url: "https://github.com/advisories/GHSA-xxxx-xxxx-xxxx", vulnerable_versions: ">=1.0.0 <1.2.4", lockfiles: ["workers/console/ui/package-lock.json"], runtime: true },
      { package: "esbuild", version: "0.20.0", advisory_id: "1100002", severity: "moderate", title: "Dev server accepts cross-origin requests", url: null, vulnerable_versions: "<=0.24.2", lockfiles: ["workers/control-plane-shared/package-lock.json"], runtime: false },
    ], runtime_high_ids: ["1100001"], observed_at: "2026-11-12T09:20:00.000Z" } },
  "/api/forge/v1/forge/git-backup": { backup: { schema: "git-backup.v1", status: "failing", stale: false, retained_bundles: 12, retained_days: 30, stale_after_hours: 48,
    latest_run: { run_id: "gbk_3dbbead07e50_2", main_sha: "3dbbead07e50e78fedd94db712f38a0f7eb0cdb4", day: "2026-11-12", ran_at: "2026-11-12T09:19:00.000Z", status: "failed", r2_key: null, bundle_sha256: null, bundle_bytes: null, pack_bytes: null, pack_sha1: null, pack_version: null, objects: null, refs: null, error: "discovery_failed:discovery_http_401, a long reason that has to wrap on a phone screen without scrolling", pruned_at: null },
    last_ok_run: { run_id: "gbk_8588e21c0ffe_1", main_sha: "8588e21c0ffee0000000000000000000000000000", day: "2026-11-12", ran_at: "2026-11-12T00:04:00.000Z", status: "ok", r2_key: "git-backups/platform/2026-11-12-8588e21c0ffee0000000000000000000000000000.bundle", bundle_sha256: "5f1c0de2b7a94e3c8d6f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f", bundle_bytes: 2412345, pack_bytes: 2391000, pack_sha1: "c0ffee1234567890abcdef1234567890abcdef12", pack_version: 2, objects: 5114, refs: 41, error: null, pruned_at: null, ref_list: [{ name: "refs/heads/main", sha: "8588e21c0ffee0000000000000000000000000000" }] },
    runs: [
      { run_id: "gbk_3dbbead07e50_2", main_sha: "3dbbead07e50e78fedd94db712f38a0f7eb0cdb4", day: "2026-11-12", ran_at: "2026-11-12T09:19:00.000Z", status: "failed", r2_key: null, bundle_sha256: null, bundle_bytes: null, pack_bytes: null, pack_sha1: null, pack_version: null, objects: null, refs: null, error: "discovery_failed:discovery_http_401", pruned_at: null },
      { run_id: "gbk_8588e21c0ffe_1", main_sha: "8588e21c0ffee0000000000000000000000000000", day: "2026-11-12", ran_at: "2026-11-12T00:04:00.000Z", status: "ok", r2_key: "git-backups/platform/2026-11-12-8588e21c0ffee0000000000000000000000000000.bundle", bundle_sha256: "5f1c0de2b7a94e3c8d6f0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f", bundle_bytes: 2412345, pack_bytes: 2391000, pack_sha1: "c0ffee1234567890abcdef1234567890abcdef12", pack_version: 2, objects: 5114, refs: 41, error: null, pruned_at: null },
    ], observed_at: "2026-11-12T09:20:00.000Z" } },
  "/api/forge/v1/forge/commits": { commits: [{ sha: "3dbbead07e50e78fedd94db712f38a0f7eb0cdb4", title: "fix(forge): read Artifacts commit metadata defensively (#215)", author: "cryptophys-adm", date: "2026-11-08T05:18:00.000Z" }] },
  "/api/kernel/v1/notices": { email: "not_configured", notices: [
    { topic: "owner_attention", channel: "owner", active: true, fingerprint: "f", title: "3 item(s) wait for your approval", link: "https://nexus.cryptophys.work/console/#/owner", lines: ["Recovery plan for Cerebrum Console (by agent:supervisor)", "Critical action: admit forge-steward to the council (proposed by supervisor)", "Knowledge proposal k-param-prophet-r37-statemaxage-16@1 (param candidate, by aether-calibrator)"] },
    { topic: "drift", channel: "console", active: true, fingerprint: "d", title: "Drift in production: 1 service(s)", link: "https://nexus.cryptophys.work/console/#/infrastructure", lines: ["Policy Engine: the running version differs from the expected version (expected 7eaf570a4ed5, running c5b73b4c3711)"] },
  ], owner_channel_topics: ["owner_attention", "critical_reports", "production_unhandled"] },
  "/api/kernel/v1/knowledge": { counts: { pending: 1 }, proposals: [{ proposal_id: "knw_00000000-0000-4000-8000-000000000000", proposer_agent_id: "aether-curator", item_id: "k-prophet-trap", item_version: 1, kind: "caution", content_sha256: "0".repeat(64), status: "pending", decided_by: null, reason: null, created_at: "2026-11-07T12:00:00.000Z", decided_at: null, item: { text: "Its bearish lean was wrong in 11 of 14 such bars.", audience: { agents: ["prophet"], charts: ["60"] }, evidence: { bars: 14, wrong: 11 }, provenance: { card_ids: [] } } },
  { proposal_id: "knw_00000000-0000-4000-8000-000000000001", proposer_agent_id: "aether-calibrator", item_id: "k-param-prophet-r37-statemaxage-16", item_version: 1, kind: "param_candidate", content_sha256: "1".repeat(64), status: "pending", decided_by: null, reason: null, created_at: "2026-11-07T12:00:00.000Z", decided_at: null, item: { text: "Test the Prophet R37 latch at 16 bars in shadow.", audience: { agents: ["prophet"], charts: ["60"] }, evidence: { episodes: 3 }, params: { family: "prophet_r37", values: { stateMaxAge: 16 } }, provenance: { card_ids: [] } } }] },
  "/api/orchestrator/v1/deployments": {
    active: {
      requests: [{ request_id: "dep_1", service_id: "cryptophys-platform-api", version: "e0bd92815ac9cbae7481e14e1798238068e4b2a9", status: "running", requested_by: "consensus:cns_1", origin: "consensus", workflow: "deploy-platform-api.yml", proposal_id: "cns_1", run_url: null, note: null, created_at: "2026-11-08T14:02:00.000Z", updated_at: "2026-11-08T14:02:05.000Z" }],
      proposals: [{ proposal_id: "cns_2", action: "deploy_commit", target: "cryptophys-deployment-orchestrator-with-a-long-name", class: "routine", status: "executing", approvals: 9, eligible: 9, created_at: "2026-11-08T14:01:00.000Z", decided_at: "2026-11-08T14:01:30.000Z" }],
    },
    requests: [{ request_id: "dep_0", service_id: "cryptophys-platform-api", version: "6fafa095ce3eea19679398a3b2bfb6e596270f7b", status: "failed", requested_by: "edecae24a56f7a12c78455585f23e707.access", origin: "deploy workflow", workflow: "deploy-platform-api.yml", proposal_id: null, run_url: "https://github.com/cryptophys-adm/cryptophys-cloud-platform/actions/runs/1", note: "stale: no workflow run finished within 3 hours", created_at: "2026-11-08T10:00:00.000Z", updated_at: "2026-11-08T13:00:00.000Z" }],
    deploys: [{ service_id: "cryptophys-deployment-orchestrator", version: "e0bd92815ac9", previous: "6fafa095ce3e", origin: "deploy workflow", actor: "edecae24a56f7a12c78455585f23e707.access", at: "2026-11-08T14:24:17.000Z" }],
    generated_at: "2026-11-08T14:30:00.000Z",
  },
  "/api/kernel/v1/consensus/report": { window_days: 7, total: 0, scored: 0, agree: 0, false_positive: 0, false_negative: 0, pending: 0, agreement_rate: null, by_action: {}, items: [] },
};
// Visual hardening 2026-11-09: realistic volumes so the charts and scrollable tables render with data
// (timestamps relative to now, deterministic otherwise).
const NOW = Date.now();
const at = (min) => new Date(NOW - min * 60_000).toISOString();
const SVC = ["platform-api", "deployment-orchestrator", "platform-registry", "policy-engine", "drift-detector", "audit-ledger", "recovery-manager", "ai-kernel", "forge", "console", "home"].map((s) => `cryptophys-${s}`);
const STATUSES = ["executed", "shadow_passed", "shadow_blocked", "rejected", "failed", "pending_owner", "expired"];
const ACTIONS = ["deploy_commit", "observe_drift", "suspend_agent", "register_agent", "admit_voter", "rollback_worker_version"];
Object.assign(MOCK, {
  "/api/platform/v1/overview": { overview: { observed_at: at(1), agents_enabled: true,
    services: SVC.map((s, i) => ({ service_id: s, drifted: i === 3 || i === 9, persistent: i === 9, observed_at: at(i) })),
    open_agent_plans: [{ plan_id: "plan_00000000-0000-0000-0000-000000000000", service_id: SVC[9], status: "draft", created_at: at(40) }],
    agent_reports_24h: { counts: { critical: 1, warning: 4, info: 31, critical_acknowledged: 1 }, latest_attention: [
      { report_id: "r1", agent_id: "auditor", kind: "audit_digest", severity: "critical", subject: "Audit chain verified; 3 denied syscalls by platform-api in one hour, which is a long subject that wraps", created_at: at(30) },
      { report_id: "r2", agent_id: "supervisor", kind: "platform_digest", severity: "warning", subject: "Console drifts persistently", created_at: at(70) }] },
    xauusd_latest: { decision: "HOLD", confidence: 0.61, candle_key: "XAUUSD:60:2026-11-09T12:00", decided_at: at(20), reported_at: at(19) } } },
  "/api/kernel/v1/consensus": { mode: "deploy", stats_24h: { executed: 6, shadow_passed: 3, shadow_blocked: 2, rejected: 1, failed: 1, pending_owner: 1, expired: 1 },
    proposals: Array.from({ length: 60 }, (_, i) => ({ proposal_id: `cns_${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`, proposer_agent_id: "supervisor",
      action: ACTIONS[i % ACTIONS.length], target: i % 6 === 3 ? "forge-steward" : SVC[i % SVC.length], class: i % 6 === 4 ? "critical" : "routine",
      status: STATUSES[i % STATUSES.length], approvals: 6 + (i % 3), rejections: i % 3 === 2 ? 1 : 0, eligible: 8, passed: i % 7 < 3, policy_decision: i % 7 === 2 ? "deny" : "allow",
      created_at: at(i * 37), evidence: { policy_reason: i % 7 === 2 ? "failed: target_rate_limit" : "all policy checks passed" } })) },
  "/api/kernel/v1/agents": { agents_enabled: true, agents: [
    ...["supervisor", "signal-analyst", "auditor"].map((id) => ({ agent_id: id, display_name: id, host_worker: "cryptophys-ai-kernel", tier_max: id === "supervisor" ? 1 : 1, status: "enabled", capabilities: ["platform.observe", "reports.publish"] })),
    ...SVC.slice(0, 7).map((s) => ({ agent_id: s.replace("cryptophys-", ""), display_name: `${s} AI Agent`, host_worker: s, tier_max: 1, status: "enabled", capabilities: ["platform.observe", "memory.recall"] })),
    ...Array.from({ length: 21 }, (_, i) => ({ agent_id: `xauusd-agent-${i}`, display_name: `XAUUSD agent ${i}`, host_worker: i < 7 ? "xauusd-chain" : "xauusd-hud", tier_max: i % 5 === 0 ? 0 : 1, status: i === 4 ? "suspended" : "enabled", status_reason: i === 4 ? "5 failures in 1 h" : null, capabilities: ["signals.observe"] })),
  ] },
  "/api/kernel/v1/reports": { reports: Array.from({ length: 40 }, (_, i) => ({ report_id: `rep_${i}`, agent_id: ["auditor", "supervisor", "signal-analyst", "platform-api"][i % 4], kind: ["audit_digest", "platform_digest", "xauusd_digest", "platform_digest"][i % 4],
    severity: i % 13 === 0 ? "critical" : i % 4 === 1 ? "warning" : "info", subject: `Digest ${i}: everything nominal except a long sentence that must wrap inside the table cell`, ai_status: i % 5 ? "ok" : "unavailable",
    body: { decision: ["BUY", "SELL", "HOLD"][i % 3], confidence: 0.5 + (i % 5) / 10 }, created_at: at(i * 23),
    // ADR-0009 amendment 2026-11-13: one critical report acknowledged by an approver, the others open.
    acknowledgement: i === 13 ? { acknowledged_by: "owner@example.com", reason: "Cause fixed and live; production unchanged by the failed deploy.", acknowledged_at: at(i * 23 - 5) } : null })) },
  "/api/audit/v1/events": { events: Array.from({ length: 120 }, (_, i) => ({ event_id: `evt_${i}`, event_type: ["consensus.tallied", "consensus.executed", "agent.syscall", "deployment.dispatched", "forge.check", "drift.observed", "policy.decided", "recovery.plan_created", "account.updated"][i % 9],
    actor: i % 4 ? "agent:supervisor" : "owner@example.com", subject: SVC[i % SVC.length], outcome: i % 11 ? "succeeded" : "failed", event_hash: "ab".repeat(32), created_at: at(i * 9) })) },
  "/api/policy/v1/decisions": { decisions: Array.from({ length: 80 }, (_, i) => ({ decision_id: `dec_${i}`, subject: "agent:supervisor", action: ["consensus.execute", "agent.syscall", "deploy", "registry.update"][i % 4],
    resource: `deploy_commit:${SVC[i % SVC.length]}`, decision: i % 6 ? "allow" : "deny", reason: i % 6 ? "all policy checks passed" : "failed: target_rate_limit, platform_daily_limit", created_at: at(i * 14) })) },
  "/api/registry/v1/services": { services: SVC.map((s, i) => ({ service_id: s, display_name: s.replace("cryptophys-", ""), status: i === 10 ? "disabled" : "healthy", desired_version: "7eaf570a4ed5" })) },
  "/api/drift/v1/drift": { services: SVC.slice(0, 10).map((s, i) => ({ service_id: s, status: i === 3 ? "degraded" : "healthy", drifted: i === 3 || i === 9, desired_version: "7eaf570a4ed5", observed_version: i === 3 ? "c5b73b4c3711" : "7eaf570a4ed5", observed_at: at(i * 3) })) },
  "/api/recovery/v1/plans": { plans: Array.from({ length: 14 }, (_, i) => ({ plan_id: `plan_${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`, service_id: SVC[i % 5], title: `Recover ${SVC[i % 5]} from version mismatch`, status: ["draft", "approved", "executing", "completed", "failed", "disabled"][i % 6], created_by: "agent:supervisor", created_at: at(i * 90), steps: [{}, {}] })) },
});
{
  const ids = MOCK["/api/kernel/v1/agents"].agents;
  const caps = ["platform.observe", "consensus.propose", "reports.publish", "memory.recall", "signals.observe"];
  const activity = Array.from({ length: 140 }, (_, i) => ({ agent_id: ids[(i * 7) % ids.length].agent_id, capability: caps[i % caps.length], tier: 1, outcome: i % 13 === 0 ? "denied" : i % 29 === 0 ? "failed" : "succeeded", created_at: at(i * 9) }));
  MOCK["/api/kernel/v1/mesh"] = { observed_at: at(0), window: { hours: 24 },
    agents: ids.map((a, i) => ({ agent_id: a.agent_id, display_name: a.display_name, host_worker: a.host_worker, tier_max: a.tier_max, status: a.status, voter: i < 10,
      actions_24h: activity.filter((x) => x.agent_id === a.agent_id).length, last_action_at: i % 5 === 4 ? null : at(i * 11), last_capability: caps[i % caps.length], last_outcome: "succeeded",
      votes_24h: i < 10 ? 14 : 0, last_vote_at: i < 10 ? at(8) : null, reports_24h: i % 3, last_report_at: i % 3 ? at(i * 20) : null,
      last_seen_at: i % 5 === 4 ? null : at(i * 11), liveness: a.status !== "enabled" ? "suspended" : i % 5 === 4 ? "idle" : i * 11 <= 60 ? "active" : "recent" })),
    activity: activity.slice(0, 60), activity_24h: activity,
    census: Array.from({ length: 8 }, (_, i) => ({ main_sha: `${i}`.repeat(40), status: i === 2 ? "changes" : "consistent", organs: 12, agents: 10, engines: 9, voters: 9, taken_at: at(i * 45),
      findings: i === 2 ? [{ kind: "unregistered_engine", subject: "cryptophys-forge:summarize_checks", detail: "declared in the DNA, not in the engines table" }] : [] })),
    registrations: [{ proposal_id: "cns_00000000-0000-4000-8000-00000000r001", action: "register_engine", target: "cryptophys-forge", class: "routine", status: "executed", approvals: 8, rejections: 0, eligible: 8, created_at: at(95), decided_at: at(94), outcome: { executed: true } }],
    engines: [{ service_id: "cryptophys-ai-kernel", task: "draft_audit_digest", status: "enabled", registered_by: "migration:0041", updated_at: at(900) }],
    protocol: ["Self-awareness: the Forge takes a census of DNA versus the live registries on each main commit.", "Self-registration: a census finding makes the Supervisor propose its registration; the council votes.", "No finding means there is nothing to register."] };
}
MOCK["/api/kernel/v1/metabolism"] = {
  live: { source: "cryptophys-digital-metabolism", observed_at: at(1), market_status: "open", power_mode: "homeostasis", power_mode_override: "none", auto_adaptation_enabled: true,
    treasury_reserve_usd: 500, runway_days: 3333.3, infra_burn_cost_24h: 0.15, trading_net_pnl_24h: -12.5, metabolic_ratio: -83.33 },
  cycles: Array.from({ length: 60 }, (_, i) => ({ cycle_id: `mtb_${i}`, evaluated_at: at(i * 15), market_status: i > 40 ? "closed" : "open", trading_net_pnl_24h: i % 7 - 3, infra_burn_cost_24h: 0.15,
    metabolic_ratio: 1.2, treasury_reserve_usd: 500, runway_days: 3333.3, power_mode: i > 40 ? "survival" : "homeostasis", mode_reason: i > 40 ? "market closed (weekend): entering survival hibernation to conserve AI tokens and compute" : "baseline homeostasis: balanced operational state" })),
  ledger: [{ entry_id: "trz_seed", entry_type: "capital_injection", source: "genesis:runway_buffer", amount_usd: 500, balance_after_usd: 500, created_at: at(700) }],
  burn_14d: SVC.slice(0, 6).map((s, i) => ({ service_id: s, cost_usd: 0.5 + i * 0.3, requests: 1000 * (i + 1), ai_neurons: 10 })),
  mode_changes: [{ actor: "agent:supervisor", mode: "survival", previous_mode: "homeostasis", reason: "market closed (weekend)", at: at(615) }],
  rules: ["Survival throttles only AI spending; it never blocks consensus.", "Growth applies only with the owner's override.", "Read only: no orders, no funds."],
};
MOCK["/api/aether/v1/overview"] = { service: "cryptophys-aether", generated_at: at(1),
  canon: { version: "canon-v1", content_sha256: "a".repeat(64), files: 4, kb_version: 4, kb_content_sha256: "b".repeat(64),
    file_list: ["canon/doctrine.json", "canon/roles.json", "canon/definitions.json", "canon/indicator/kb-v4.json"].map((p, i) => ({ path: p, sha256: String(i).repeat(64) })),
    kb: { version: 4, status: "derived_from_pine_ssot", sections: ["input_lanes", "field_dictionary", "decision_policy", "analysis_requirements", "limitations", "news_policy", "provenance"], input_lanes: ["tradingview_webhook", "local_computation"] },
    roles: Array.from({ length: 12 }, (_, i) => ({ id: `agent_${i}`, name: `Agent ${i}`, kind: "engine", family: ["structure", "trend", "momentum"][i % 3] })),
    definitions: ["outcome_scoring", "stuck_states", "reputation", "shadow_promotion", "parity", "compliance_checks", "decision_card"],
    doctrine: [{ id: "execution_boundary", class: "constitutional", rule: "No Worker places an order or can read a broker credential.", since: "2026-10", updated: "2026-11-11", amended: null }, { id: "engine_thresholds", class: "operational", rule: "In the intraday mode the Decision Engine's BUY or SELL needs more than 50% of the witnesses' weight on its side.", since: "2026-11-11", amended: { amendment_id: "cns_2", action: "amend_doctrine", executed_at: at(200) } }] },
  knowledge: { counts: {}, items: [] },
  // The XAUUSD baseline model's report (owner 2026-11-13: the training module in Cerebrum).
  model: { model_id: "baseline@2026-11-13T01:03Z", generated_at: at(20), received_at: at(19), rows: 308,
    promotion: { status: "not_promoted", set: null, reason: "tight: long: 120 of 300 decisions; short: 118 of 300 decisions with a rather long explanation that wraps on a phone", since: null },
    gate: { min_n: 300, alpha: 0.05, min_auc: 0.55 },
    models: [{ id: "tight_long", walk_forward: { n: 86, skill: 0.0742, auc: 0.6984, picked: 3, picked_mean_r: 1.5, all_mean_r: -0.3314 }, prospective: { n: 120, skill: 0.03, p_value: 0.21, auc: 0.58, picked: 12, picked_mean_r: 0.4, all_mean_r: -0.1 }, top_features: ["time_hour_cos", "w_news_lean", "w_macro_drivers_lean", "x_10_year_yield_change_1d", "g_long_no_veto", "px_range_pos_20"] },
      { id: "wide_short", walk_forward: { n: 51, skill: -2.869, auc: 0.1111, picked: 0, picked_mean_r: null, all_mean_r: 1.2059 }, prospective: null, top_features: [] }],
    live_notes: [{ item_id: "k-role-chronos-matrix-calibration-talk", version: 1, status: "retired", agents: ["chronos_matrix"], chart: "60", promoted_at: at(3000), retired_at: at(60), reason: "worse live: 12 of 44 decided calls right since the promotion, against 50% in the test (p 0.002)" }] },
  sync: { version: "cryptophys.aether-sync.v1", overall: "warn", market_open: true, checks: { card_ingest: { status: "warn", age_minutes: 140, limit_minutes: 90 }, canon_index: { status: "ok" } } },
  weighting: [{ timeframe: "60", active: { id: "weighting@default" }, agents: [{ agent: "prophet", weight: 1.12 }, { agent: "gmi", weight: 0.94 }] }],
  doctrine: { version: "aether.canon.doctrine.v2", audited: "2026-11-11", applied: [{ amendment_id: "cns_1", rule: "omega_execution_gates", action: "amend_doctrine", executed_at: at(300) }],
    rules: [], retired: [{ id: "advisory_only", retired: "2026-11-11", superseded_by: "execution_boundary" }],
    council: { agent: "knowledge-council", schedule_utc: "daily 03:52", mode: "propose",
      last_session: { session_id: "kc_20261111-0352", held_at: at(240), mode: "propose", facts_at: at(250),
        review: [{ rule: "decision_engine_ssot", class: "operational", status: "in_sync" },
          { rule: "engine_thresholds", class: "operational", status: "propose", action: "amend_doctrine", drifts: [{ fact: "decision.min_rrr", doctrine: 1.5, observed: 1.2 }], seats: { aether: "agree", nexus: "agree" } },
          { rule: "omega_execution_gates", class: "operational", status: "observing", action: "amend_doctrine", drifts: [{ fact: "omega.max_spread_points", doctrine: 60, observed: 80 }], seats: { aether: "agree", omega: "observing" } },
          { rule: "parity_trust_only", class: "constitutional", status: "unreported", unreported: [{ fact: "parity.approval_candles", seat: "nexus" }] }],
        proposals: [{ rule: "engine_thresholds", action: "amend_doctrine", proposal_id: "cns_2", status: "executed" }] },
      proposals: [{ session_id: "kc_20261111-0352", rule_id: "engine_thresholds", action: "amend_doctrine", values: { "decision.min_rrr": 1.2 }, proposal_id: "cns_2", status: "executed", detail: null, created_at: at(240) }] },
    facts: { received_at: at(30), measured_at: at(30), seats: { nexus: { version_id: "ver-1", facts: 24 }, omega: { version_id: "ver-1", facts: 8 } } } },
  progress: {
    curation: { version: "cryptophys.aether-curation-progress.v1", schedule_utc: "daily 02:52", cards: 244,
      role_drift: { window_days: 7, cards: 244, span_days: 6, need: { span_days: 6, rooms: 20, rooms_with_break: 10, rate_pct_above: 5 }, ready: 0,
        agents: [{ agent: "prophet", rooms: 120, check: "calibration_talk", rooms_with_break: 4, rate_pct: 3, ready: false }, { agent: "moderator", rooms: 244, check: null, rooms_with_break: 0, rate_pct: 0, ready: false }] },
      caution: { window_days: 30, decisive_outcomes: 96, need: { decisive: 12, baseline_decisive: 12, alpha: 0.05 }, ready: 0,
        situations: [{ agent: "prophet", chart: "15", session: "london", decisive: 9, wrong_pct: 22, baseline_decisive: 30, baseline_wrong_pct: 17, ready: false }] },
      engine: { window_days: 30, need: { episodes: 3, cards: 10 }, ready: 0, families: [{ family: "prophet_r37", name: "Prophet", episodes: 1, cards: 4, longest_candles: 6, next_value: 16, ready: false }, { family: "gmi_v12_70", name: "GMI", episodes: 0, cards: 0, longest_candles: 0, next_value: 16, ready: false }] } },
    weighting: [{ timeframe: "15", mode: "auto", rooms: 216, window_days: 10, active: "weighting@default", candidates: 14, verdicts: { collecting: 14 }, discovery: { have: 116, need: 200 }, holdout: { have: 100, need: 100, complete: true }, received_at: at(20) },
      { timeframe: "60", mode: "auto", rooms: 59, window_days: 30, active: "weighting@default", candidates: 14, verdicts: { collecting: 14 }, discovery: { have: 0, need: 200 }, holdout: { have: 59, need: 100, complete: false }, received_at: at(30) }] } };
MOCK["/api/platform/v1/usage"] = { configured: true, observed_at: at(2), plan: "Workers Free", window: { from: "2026-11-04", to: "2026-11-10", resets: "00:00 UTC" },
  spend_summary: {
    billing_period: "Nov 2026",
    period_start: "2026-10-17",
    period_end: "2026-11-16",
    days_observed: 25,
    total_days: 31,
    total_cost: 2.61,
    projected_cost: 3.24,
    average_daily_cost: 0.10,
    currency: "USD",
  },
  billable_products: [
    { product: "Regular Twitch Neurons", category: "Workers AI", total_usage: "1,410,000 Neurons", billable_usage: "1,410,000 Neurons", usage_cost: 1.41 },
    { product: "Container Memory, per GiB-hr", category: "Compute", total_usage: "117 GiB-hr", billable_usage: "117 GiB-hr", usage_cost: 1.17 },
    { product: "Container Disk, per GB-hr", category: "Compute", total_usage: "30 GB-hr", billable_usage: "30 GB-hr", usage_cost: 0.03 },
  ],
  orchestrator_cost_intents: [
    { intent_id: "intent_throttle_ai_neurons", product: "Regular Twitch Neurons", cost_usd: 1.41, target_service: "cryptophys-ai-kernel", action: "throttle_ai_neurons", directive: "FREE_TIER_RESTRICTION: Cap daily AI neuron usage at 10,000 neurons/day." },
    { intent_id: "intent_reduce_container_memory", product: "Container Memory, per GiB-hr", cost_usd: 1.17, target_service: "compute-containers", action: "reduce_container_runtime", directive: "FREE_TIER_RESTRICTION: Curtail container idle runtime." },
  ],
  metrics: [
    { key: "workers_requests", label: "Workers requests", today: 41200, limit: 100000, unit: "requests", pct: 41.2, history: Array.from({ length: 7 }, (_, i) => ({ date: new Date(NOW - (6 - i) * 86400000).toISOString().slice(0, 10), value: 30000 + i * 2500 })) },
    { key: "d1_rows_read", label: "D1 rows read", today: 4300000, limit: 5000000, unit: "rows", pct: 86 },
    { key: "d1_rows_written", label: "D1 rows written", today: 12000, limit: 100000, unit: "rows", pct: 12 },
    { key: "ai_neurons", label: "Workers AI neurons", today: null, limit: 10000, unit: "neurons", pct: null, error: "unknown field totalNeurons on a long line that must wrap" },
    { key: "kv_reads", label: "KV reads", today: 0, limit: 100000, unit: "reads", pct: 0 },
    { key: "kv_writes", label: "KV writes", today: 0, limit: 1000, unit: "writes", pct: 0 },
  ],
  workers_today: SVC.map((s, i) => ({ script: s, requests: 9000 - i * 700 })), workers_errors_today: 4, source: "Cloudflare GraphQL Analytics & Billable Usage API" };
MOCK["/api/forge/v1/forge/checks"].checks.push(...Array.from({ length: 8 }, (_, i) => ({ commit: `${i}`.repeat(40), status: i === 5 ? "failed" : "passed", pass: 400 + i * 3, fail: i === 5 ? 2 : 0, duration_ms: 40000 + i * 1500, started_at: at(60 * (i + 2)), github: "success", agrees: i !== 5 })));

// Owner 2026-11-13: the Owner page (#/owner) reads GET /v1/owner/inbox: approvals and open critical reports only.
MOCK["/api/kernel/v1/owner/inbox"] = { schema: "owner-inbox.v1", observed_at: at(0), consensus_mode: "critical",
  approvals: {
    recovery_plans: [{ plan_id: "plan_00000000-0000-4000-8000-000000000000", service_id: SVC[9], plan_version: "7eaf570a4ed5", created_by: "agent:supervisor", created_at: at(40), approve_by: at(-60 * 71),
      title: "Drift on cryptophys-console: version_mismatch, a title long enough to wrap on a phone screen", rationale: "Two consecutive drifted observations.", synthetic: false,
      steps: [{ action: "redeploy_commit", description: "Redeploy the desired version 7eaf570a4ed5 of cryptophys-console through the deploy workflow." }, { action: "manual", description: "Confirm health and drift are back in sync after the deploy." }] }],
    consensus: [
      { proposal_id: "cns_00000005-0000-4000-8000-000000000000", action: "admit_voter", target: "forge-steward", proposer_agent_id: "supervisor", created_at: at(90), expires_at: at(-60 * 22), approvals: 7, rejections: 1, eligible: 8, executable: true },
      { proposal_id: "cns_00000011-0000-4000-8000-000000000000", action: "rotate_secret", target: "cryptophys-platform-registry", proposer_agent_id: "supervisor", created_at: at(200), expires_at: at(-60 * 20), approvals: 6, rejections: 0, eligible: 8, executable: false },
    ],
    knowledge: [{ proposal_id: "knw_00000000-0000-4000-8000-000000000001", item_id: "k-param-prophet-r37-statemaxage-16", item_version: 1, kind: "param_candidate", proposer_agent_id: "aether-calibrator", created_at: at(300), expires_at: at(-60 * 24 * 13),
      item: { text: "Test the Prophet R37 latch at 16 bars in shadow; a long sentence that has to wrap on a phone screen." } }],
  },
  critical_reports: [{ report_id: "rpt_00000000-0000-4000-8000-000000000000", agent_id: "deployment-orchestrator", kind: "platform_digest", severity: "critical", subject: "Rollback of Cerebrum Console to 6fafa095ce3e failed, which is a long subject that wraps", created_at: at(30) }],
  production_problems: [
    { code: "self_unhealthy", subject: "cryptophys-ai-kernel", detail: "AI Kernel is drifted or unhealthy (version_mismatch); the agents do not recover their own Worker", since: at(50), link: "#/infrastructure" },
    { code: "observations_stale", subject: "cryptophys-policy-engine", detail: "Policy Engine: not observed since 2026-11-13T01:00:00.000Z; the Drift Detector may have stopped", since: at(120), link: "#/infrastructure" },
    { code: "recovery_failed", subject: "plan_00000000-0000-4000-8000-000000000009", detail: "Recovery plan for Cerebrum Console failed at 2026-11-13T02:00:00.000Z", since: at(90), link: "#/recovery/plan_00000000-0000-4000-8000-000000000009" },
  ],
  counts: { approvals: 4, critical_reports: 1, production_problems: 3 } };
const EMPTY_INBOX = { schema: "owner-inbox.v1", observed_at: at(0), consensus_mode: "deploy", approvals: { recovery_plans: [], consensus: [], knowledge: [] }, critical_reports: [], production_problems: [], counts: { approvals: 0, critical_reports: 0, production_problems: 0 } };
const OPERATOR = { actor: "ops@example.com", type: "user", operator: true, approver: false, role: "operator", owner: false, viewer: false };
/** Per-check replacements of mocked responses (the Owner page as an operator, and with nothing open). */
let OVERRIDE = {};

const TYPES = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html", ".svg": "image/svg+xml", ".png": "image/png" };

const server = http.createServer((req, res) => {
  let u = decodeURIComponent((req.url ?? "/").split("?")[0]);
  if (u === "/console") { res.writeHead(301, { location: "/console/" }); return res.end(); }
  if (!u.startsWith("/console/")) { res.writeHead(404); return res.end(); }
  u = u.slice("/console".length);
  if (u.startsWith("/api/")) {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(OVERRIDE[u] ?? MOCK[u] ?? {}));
  }
  const file = path.join(dist, u === "/" ? "index.html" : u);
  if (!file.startsWith(dist) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end(); }
  res.setHeader("content-type", TYPES[path.extname(file)] ?? "application/octet-stream");
  res.end(fs.readFileSync(file));
});

await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}/console/`;
const html = fs.readFileSync(path.join(dist, "index.html"), "utf8");
const problems = [];
if (/<script>|<script [^>]*>[^<]/.test(html)) problems.push("inline script in index.html");
const browser = await chromium.launch();
for (const width of [390, 1440]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  page.on("pageerror", (e) => problems.push(`${width}px page error: ${e.message}`));
  page.on("response", (r) => { if (r.status() >= 400) problems.push(`${width}px HTTP ${r.status()} ${r.url()}`); });
  for (const route of ROUTES) {
    await page.goto(`${base}#/${route}`);
    await page.waitForTimeout(700);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) problems.push(`${width}px #/${route}: horizontal scroll of ${overflow}px`);
    const text = await page.evaluate(() => document.body.innerText.length);
    if (text < 40) problems.push(`${width}px #/${route}: blank page`);
    if (route === "code") {
      // ADR-0012 gate 8: the git backup panel shows the measured values of GET /v1/forge/git-backup.
      const body = await page.evaluate(() => document.body.innerText);
      for (const want of ["5f1c0de2b7a94e3c", "5114 objects · 41 branches", "2.3 MiB", "discovery_failed:discovery_http_401"]) {
        if (!body.includes(want)) problems.push(`${width}px #/code: git backup panel does not show "${want}"`);
      }
    }
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${width}-${route.replace(/[^a-z0-9]+/gi, "_") || "home"}.png`), fullPage: true });
  }
  await page.close();
}
// The Owner page: both sections with their actions for an approver, read-only for an operator, and the empty state.
const OWNER_CHECKS = [
  { name: "approver", override: {}, want: ["Waiting for your approval", "Open critical reports", "Production problems no agent is handling", "kernel or Drift Detector", "recovery failed", "Recovery plans", "Critical actions", "Learned knowledge", "Approve…", "Reject…", "Disable…", "Acknowledge…", "No platform executor"], not: ["Nothing needs you"] },
  { name: "operator", override: { "/api/whoami": OPERATOR }, want: ["Waiting for your approval", "Open critical reports", "Production problems no agent is handling", "Only an approver can decide.", "Only an approver can acknowledge."], not: ["Approve…", "Reject…", "Disable…", "Acknowledge…"] },
  { name: "empty", override: { "/api/kernel/v1/owner/inbox": EMPTY_INBOX }, want: ["Nothing needs you"], not: ["Waiting for your approval", "Open critical reports", "Production problems no agent is handling", "Approve…"] },
];
for (const width of [390, 1440]) {
  for (const check of OWNER_CHECKS) {
    OVERRIDE = check.override;
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    page.on("pageerror", (e) => problems.push(`${width}px owner/${check.name} page error: ${e.message}`));
    await page.goto(`${base}#/owner`);
    await page.waitForTimeout(700);
    // textContent, not innerText: section titles are upper-cased by CSS.
    const main = await page.evaluate(() => document.querySelector("main")?.textContent ?? "");
    for (const w of check.want) if (!main.includes(w)) problems.push(`${width}px #/owner (${check.name}): missing "${w}"`);
    for (const w of check.not) if (main.includes(w)) problems.push(`${width}px #/owner (${check.name}): shows "${w}"`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (overflow > 1) problems.push(`${width}px #/owner (${check.name}): horizontal scroll of ${overflow}px`);
    if (process.env.SHOTS) await page.screenshot({ path: path.join(process.env.SHOTS, `${width}-owner-${check.name}.png`), fullPage: true });
    await page.close();
  }
}
OVERRIDE = {};
await browser.close();
server.close();
if (problems.length) {
  console.error(`Render smoke failed:\n- ${[...new Set(problems)].join("\n- ")}`);
  process.exit(1);
}
console.log(`Render smoke passed: ${ROUTES.length} screens x 2 widths under /console/, and the Owner page as approver, operator and empty.`);
