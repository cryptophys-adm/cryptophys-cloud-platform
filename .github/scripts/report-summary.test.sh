#!/usr/bin/env bash
# Tests for report-summary.sh (run in CI next to the other script tests).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
fail=0
check() { if eval "$2"; then echo "ok - $1"; else echo "::error::not ok - $1"; fail=$((fail + 1)); fi; }

cat > "$tmp/clear.json" <<'J'
{"agent_reports_24h":{"since":"2026-11-04T14:00:00.000Z","counts":{"critical":0,"warning":2,"info":5},
 "latest_attention":[{"report_id":"rpt_w","agent_id":"policy-engine","kind":"platform_digest","severity":"warning","subject":"Policy denied deploy","created_at":"2026-11-05T12:03:49.133Z"}]}}
J
out="$("$here/report-summary.sh" "$tmp/clear.json")"
check "no critical -> clear" '[[ "$(jq -r .state <<<"$out")" == clear ]]'
check "warnings never alert" '! jq -e ".markdown | contains(\"Policy denied\")" <<<"$out" >/dev/null'

cat > "$tmp/crit.json" <<'J'
{"agent_reports_24h":{"since":"2026-11-04T14:00:00.000Z","counts":{"critical":2,"warning":1,"info":0},
 "latest_attention":[
  {"report_id":"rpt_b","agent_id":"recovery-manager","kind":"platform_digest","severity":"critical","subject":"Recovery plan p1 execution overdue","created_at":"2026-11-05T13:00:00.000Z"},
  {"report_id":"rpt_a","agent_id":"audit-ledger","kind":"audit_digest","severity":"critical","subject":"Audit chain | invalid\nat evt_1","created_at":"2026-11-05T12:00:00.000Z"},
  {"report_id":"rpt_w","agent_id":"policy-engine","kind":"platform_digest","severity":"warning","subject":"w","created_at":"2026-11-05T11:00:00.000Z"}]}}
J
out2="$("$here/report-summary.sh" "$tmp/crit.json")"
check "critical -> critical state" '[[ "$(jq -r .state <<<"$out2")" == critical && "$(jq -r .critical <<<"$out2")" == 2 ]]'
check "lists only critical, newest first" '[[ "$(jq -r .markdown <<<"$out2" | grep -c "^| 2026")" == 2 ]] && jq -r .markdown <<<"$out2" | grep -n "recovery-manager" | grep -q "^5:"'
check "table-breaking characters are neutralized" '! jq -r .markdown <<<"$out2" | grep -q "Audit chain | invalid"'
fp1="$(jq -r .fingerprint <<<"$out2")"
out3="$("$here/report-summary.sh" "$tmp/crit.json")"
check "fingerprint is stable" '[[ "$fp1" == "$(jq -r .fingerprint <<<"$out3")" ]]'

echo '{"agent_reports_24h":{"since":"x","counts":{"critical":0,"warning":0,"info":0},"latest_attention":[],"error":"reports_unavailable"}}' > "$tmp/err.json"
check "unavailable summary fails loudly" '! "$here/report-summary.sh" "$tmp/err.json" >/dev/null 2>&1'
echo '{}' > "$tmp/none.json"
check "missing summary fails loudly" '! "$here/report-summary.sh" "$tmp/none.json" >/dev/null 2>&1'

[[ "$fail" -eq 0 ]] || { echo "${fail} failure(s)"; exit 1; }
echo "all report-summary tests passed"
