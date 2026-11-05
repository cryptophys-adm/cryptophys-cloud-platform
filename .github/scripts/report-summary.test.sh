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
 "critical_fingerprint":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
 "latest_critical":[],
 "latest_attention":[{"report_id":"rpt_w","agent_id":"policy-engine","kind":"platform_digest","severity":"warning","subject":"WARNING_SECRET_MUST_NOT_BE_PUBLIC","created_at":"2026-11-05T12:03:49.133Z"}]}}
J
out="$("$here/report-summary.sh" "$tmp/clear.json")"
if [[ "$(jq -r .state <<<"$out")" == "clear" ]]; then pass "no critical -> clear"; else bad "no critical -> clear"; fi
if jq -e '.markdown | contains("WARNING_SECRET_MUST_NOT_BE_PUBLIC")' <<<"$out" >/dev/null; then bad "warnings never leak"; else pass "warnings never leak"; fi

cat > "$tmp/crit.json" <<'J'
{"agent_reports_24h":{"since":"2026-11-04T14:00:00.000Z","counts":{"critical":2,"warning":1,"info":0},
 "critical_fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
 "latest_critical":[
  {"report_id":"rpt_a","agent_id":"audit-ledger","kind":"audit_digest","created_at":"2026-11-05T12:00:00.000Z","subject":"UNTRUSTED_SECRET_MARKER @cryptophys-adm [click](https://evil.invalid)"},
  {"report_id":"rpt_b","agent_id":"recovery-manager","kind":"platform_digest","created_at":"2026-11-05T13:00:00.000Z","subject":"SECOND_SECRET_MARKER"}
 ],
 "latest_attention":[
  {"report_id":"rpt_w","agent_id":"policy-engine","kind":"platform_digest","severity":"warning","subject":"warning","created_at":"2026-11-05T11:00:00.000Z"}]}}
J
out2="$("$here/report-summary.sh" "$tmp/crit.json")"
md="$(jq -r .markdown <<<"$out2")"
if [[ "$(jq -r .state <<<"$out2")" == "critical" && "$(jq -r .critical <<<"$out2")" == "2" ]]; then pass "critical -> critical state"; else bad "critical -> critical state"; fi
rows="$(grep '^| 2026' <<<"$md" || true)"
if [[ "$(grep -c "^| 2026" <<<"$rows")" == "2" && "$(head -1 <<<"$rows")" == *recovery-manager* ]]; then pass "only allow-listed metadata, newest first"; else bad "only allow-listed metadata, newest first"; fi
if grep -Eq 'UNTRUSTED_SECRET_MARKER|SECOND_SECRET_MARKER|@cryptophys-adm|evil.invalid|rpt_[ab]' <<<"$md"; then bad "untrusted subjects and report ids never leave the kernel"; else pass "untrusted subjects and report ids never leave the kernel"; fi
if [[ "$(jq -r .fingerprint <<<"$out2")" == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ]]; then pass "complete kernel fingerprint preserved"; else bad "complete kernel fingerprint preserved"; fi

jq '.agent_reports_24h.critical_fingerprint = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' "$tmp/crit.json" > "$tmp/crit-changed.json"
out3="$("$here/report-summary.sh" "$tmp/crit-changed.json")"
if [[ "$(jq -r .fingerprint <<<"$out2")" != "$(jq -r .fingerprint <<<"$out3")" ]]; then pass "changed report-id set changes fingerprint"; else bad "changed report-id set changes fingerprint"; fi

echo '{"agent_reports_24h":{"since":"x","counts":{"critical":0,"warning":0,"info":0},"critical_fingerprint":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","latest_critical":[],"latest_attention":[],"error":"reports_unavailable"}}' > "$tmp/err.json"
if "$here/report-summary.sh" "$tmp/err.json" >/dev/null 2>&1; then bad "unavailable summary fails loudly"; else pass "unavailable summary fails loudly"; fi
echo '{}' > "$tmp/none.json"
if "$here/report-summary.sh" "$tmp/none.json" >/dev/null 2>&1; then bad "missing summary fails loudly"; else pass "missing summary fails loudly"; fi
echo '{"agent_reports_24h":{"since":"x","counts":{"critical":1,"warning":0,"info":0},"critical_fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","latest_critical":[]}}' > "$tmp/missing-critical.json"
if "$here/report-summary.sh" "$tmp/missing-critical.json" >/dev/null 2>&1; then bad "critical count without metadata fails loudly"; else pass "critical count without metadata fails loudly"; fi

[[ "$fail" -eq 0 ]] || { echo "${fail} failure(s)"; exit 1; }
echo "all report-summary tests passed"
