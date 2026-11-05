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
 "latest_attention":[{"report_id":"rpt_w","agent_id":"policy-engine","kind":"platform_digest","severity":"warning","subject":"warning","created_at":"2026-11-05T11:00:00.000Z"}]}}
J
out2="$("$here/report-summary.sh" "$tmp/crit.json")"
md="$(jq -r .markdown <<<"$out2")"
if [[ "$(jq -r .state <<<"$out2")" == "critical" && "$(jq -r .critical <<<"$out2")" == "2" ]]; then pass "critical -> critical state"; else bad "critical -> critical state"; fi
rows="$(grep '^| 2026' <<<"$md" || true)"
if [[ "$(grep -c "^| 2026" <<<"$rows")" == "2" && "$(head -1 <<<"$rows")" == *recovery-manager* ]]; then pass "only allow-listed metadata, newest first"; else bad "only allow-listed metadata, newest first"; fi
if grep -Eq 'UNTRUSTED_SECRET_MARKER|SECOND_SECRET_MARKER|@cryptophys-adm|evil.invalid|rpt_[ab]' <<<"$md"; then bad "untrusted subjects and report ids never leave the kernel"; else pass "untrusted subjects and report ids never leave the kernel"; fi
if [[ "$(jq -r .fingerprint <<<"$out2" | grep -Ec '^[0-9a-f]{64}$')" == "1" ]]; then pass "v2 fingerprint is a full SHA-256"; else bad "v2 fingerprint is a full SHA-256"; fi

jq '.agent_reports_24h.critical_fingerprint = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"' "$tmp/crit.json" > "$tmp/crit-changed.json"
out3="$("$here/report-summary.sh" "$tmp/crit-changed.json")"
if [[ "$(jq -r .fingerprint <<<"$out2")" != "$(jq -r .fingerprint <<<"$out3")" ]]; then pass "changed report-id set changes fingerprint"; else bad "changed report-id set changes fingerprint"; fi

cat > "$tmp/legacy.json" <<'J'
{"agent_reports_24h":{"since":"2026-11-04T14:00:00.000Z","counts":{"critical":2,"warning":1,"info":0},
 "latest_attention":[
  {"report_id":"rpt_legacy_a","agent_id":"audit-ledger","kind":"audit_digest","severity":"critical","created_at":"2026-11-05T12:00:00.000Z","subject":"LEGACY_SECRET_MARKER"},
  {"report_id":"rpt_legacy_b","agent_id":"recovery-manager","kind":"platform_digest","severity":"critical","created_at":"2026-11-05T13:00:00.000Z","subject":"LEGACY_SECOND_SECRET"},
  {"report_id":"rpt_warning","agent_id":"policy-engine","kind":"platform_digest","severity":"warning","created_at":"2026-11-05T11:00:00.000Z","subject":"WARNING_SECRET"}]}}
J
legacy="$("$here/report-summary.sh" "$tmp/legacy.json")"
legacy_md="$(jq -r .markdown <<<"$legacy")"
if [[ "$(jq -r .state <<<"$legacy")" == "critical" && "$(grep -c '^| 2026' <<<"$legacy_md")" == "2" ]]; then pass "legacy kernel retains critical alerting"; else bad "legacy kernel retains critical alerting"; fi
if grep -Eq 'LEGACY_SECRET_MARKER|LEGACY_SECOND_SECRET|WARNING_SECRET|rpt_legacy' <<<"$legacy_md"; then bad "legacy alert also withholds subjects and ids"; else pass "legacy alert also withholds subjects and ids"; fi

cat > "$tmp/legacy-crowded.json" <<'J'
{"agent_reports_24h":{"since":"2026-11-04T14:00:00.000Z","counts":{"critical":3,"warning":6,"info":0},
 "latest_attention":[{"report_id":"rpt_w","agent_id":"policy-engine","kind":"platform_digest","severity":"warning","subject":"WARNING_SECRET_MUST_NOT_BE_PUBLIC","created_at":"2026-11-05T12:03:49.133Z"}]}}
J
crowded="$("$here/report-summary.sh" "$tmp/legacy-crowded.json")"
if [[ "$(jq -r .state <<<"$crowded")" == "critical" ]] && jq -e '.markdown | contains("metadata is unavailable") and (contains("WARNING_SECRET_MUST_NOT_BE_PUBLIC") | not)' <<<"$crowded" >/dev/null; then pass "legacy crowded critical set remains visible without leaking"; else bad "legacy crowded critical set remains visible without leaking"; fi

echo '{"agent_reports_24h":{"since":"x","counts":{"critical":0,"warning":0,"info":0},"latest_attention":[],"critical_fingerprint":"partial"}}' > "$tmp/partial.json"
if "$here/report-summary.sh" "$tmp/partial.json" >/dev/null 2>&1; then bad "partial v2 schema fails loudly"; else pass "partial v2 schema fails loudly"; fi
echo '{"agent_reports_24h":{"since":"x","counts":{"critical":0,"warning":0,"info":0},"latest_attention":[],"error":"reports_unavailable"}}' > "$tmp/err.json"
if "$here/report-summary.sh" "$tmp/err.json" >/dev/null 2>&1; then bad "unavailable summary fails loudly"; else pass "unavailable summary fails loudly"; fi
echo '{}' > "$tmp/none.json"
if "$here/report-summary.sh" "$tmp/none.json" >/dev/null 2>&1; then bad "missing summary fails loudly"; else pass "missing summary fails loudly"; fi
echo '{"agent_reports_24h":{"since":"x","counts":{"critical":1,"warning":0,"info":0},"critical_fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","latest_critical":[]}}' > "$tmp/missing-critical.json"
if "$here/report-summary.sh" "$tmp/missing-critical.json" >/dev/null 2>&1; then bad "critical count without metadata fails loudly"; else pass "critical count without metadata fails loudly"; fi

[[ "$fail" -eq 0 ]] || { echo "${fail} failure(s)"; exit 1; }
echo "all report-summary tests passed"
