#!/usr/bin/env bash
# Tests for report-summary.sh (run in CI next to the other script tests).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fail=0
pass() { echo "ok - $1"; }
bad() { echo "::error::not ok - $1"; fail=$((fail + 1)); }

cat > "$tmp/clear.json" <<'J'
{"agent_reports_24h":{"since":"2026-11-04T14:00:00.000Z","counts":{"critical":0,"warning":2,"info":5},
 "latest_attention":[{"report_id":"rpt_w","agent_id":"policy-engine","kind":"platform_digest","severity":"warning","subject":"Policy denied deploy","created_at":"2026-11-05T12:03:49.133Z"}]}}
J
out="$("$here/report-summary.sh" "$tmp/clear.json")"
if [[ "$(jq -r .state <<<"$out")" == "clear" ]]; then pass "no critical -> clear"; else bad "no critical -> clear"; fi
if jq -e '.markdown | contains("Policy denied")' <<<"$out" >/dev/null; then bad "warnings never alert"; else pass "warnings never alert"; fi

cat > "$tmp/crit.json" <<'J'
{"agent_reports_24h":{"since":"2026-11-04T14:00:00.000Z","counts":{"critical":2,"warning":1,"info":0},
 "latest_attention":[
  {"report_id":"rpt_a","agent_id":"audit-ledger","kind":"audit_digest","severity":"critical","subject":"Audit chain | invalid\nat evt_1","created_at":"2026-11-05T12:00:00.000Z"},
  {"report_id":"rpt_b","agent_id":"recovery-manager","kind":"platform_digest","severity":"critical","subject":"Recovery plan p1 execution overdue","created_at":"2026-11-05T13:00:00.000Z"},
  {"report_id":"rpt_w","agent_id":"policy-engine","kind":"platform_digest","severity":"warning","subject":"w","created_at":"2026-11-05T11:00:00.000Z"}]}}
J
out2="$("$here/report-summary.sh" "$tmp/crit.json")"
md="$(jq -r .markdown <<<"$out2")"
if [[ "$(jq -r .state <<<"$out2")" == "critical" && "$(jq -r .critical <<<"$out2")" == "2" ]]; then pass "critical -> critical state"; else bad "critical -> critical state"; fi
rows="$(grep '^| 2026' <<<"$md" || true)"
if [[ "$(wc -l <<<"$rows")" == "2" && "$(head -1 <<<"$rows")" == *recovery-manager* ]]; then pass "only critical rows, newest first"; else bad "only critical rows, newest first"; fi
if grep -qF 'Audit chain | invalid' <<<"$md"; then bad "table-breaking characters neutralized"; else pass "table-breaking characters neutralized"; fi
if [[ "$(jq -r .fingerprint <<<"$out2")" == "$(jq -r .fingerprint <<<"$("$here/report-summary.sh" "$tmp/crit.json")")" ]]; then pass "fingerprint is stable"; else bad "fingerprint is stable"; fi

echo '{"agent_reports_24h":{"since":"x","counts":{"critical":0,"warning":0,"info":0},"latest_attention":[],"error":"reports_unavailable"}}' > "$tmp/err.json"
if "$here/report-summary.sh" "$tmp/err.json" >/dev/null 2>&1; then bad "unavailable summary fails loudly"; else pass "unavailable summary fails loudly"; fi
echo '{}' > "$tmp/none.json"
if "$here/report-summary.sh" "$tmp/none.json" >/dev/null 2>&1; then bad "missing summary fails loudly"; else pass "missing summary fails loudly"; fi

[[ "$fail" -eq 0 ]] || { echo "${fail} failure(s)"; exit 1; }
echo "all report-summary tests passed"
