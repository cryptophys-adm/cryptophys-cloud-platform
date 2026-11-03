#!/usr/bin/env bash
# Hermetic tests for the drift alert summarizer.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
now=1793800000                                   # 2026-11-03T15:46:40Z
at="$(date -u -d "@$((now - 600))" +%Y-%m-%dT%H:%M:%S.123Z)"
old="$(date -u -d "@$((now - 7200))" +%Y-%m-%dT%H:%M:%SZ)"
fail=0
check() { if ! jq -e "$2" <<<"$3" >/dev/null; then echo "::error::$1: $3" >&2; fail=$((fail + 1)); fi; }

svc() { # svc ID DRIFTED OBSERVED_AT [REASON]
  jq -cn --arg id "$1" --argjson d "$2" --arg at "$3" --arg r "${4:-}" \
    '{service_id: $id, drifted: $d, observed_at: $at, evidence: {reasons: (if $r == "" then [] else [$r] end), desired_version: "abc123def456", probe: {version_tag: (if $d then "000000000000" else "abc123def456" end)}}}'
}
one_drifted() {
  for s in "${all[@]}"; do
    if [[ $s == cryptophys-platform-api ]]; then svc "$s" true "$at" version_mismatch; else svc "$s" false "$at"; fi
  done
}
all=(cryptophys-audit-ledger cryptophys-deployment-orchestrator cryptophys-drift-detector cryptophys-platform-api cryptophys-platform-registry cryptophys-policy-engine cryptophys-recovery-manager cryptophys-signal-engine xauusd-ai-trading-assistant xauusd-fundamental-news-ingestion xauusd-nexus-dashboard xauusd-tradingview-pull-adapter)
report() { jq -s '{services: .}' > "$tmp/r.json"; }

for s in "${all[@]}"; do svc "$s" false "$at"; done | report
ok="$("$here/drift-summary.sh" "$tmp/r.json" "$now")"
check "in sync" '.state == "in_sync" and (.problems | length) == 0' "$ok"

one_drifted | report
drift="$("$here/drift-summary.sh" "$tmp/r.json" "$now")"
check "version drift" '.state == "drift" and .problems == [{service_id: "cryptophys-platform-api", problem: "version_mismatch", desired: "abc123def456", observed: "000000000000"}]' "$drift"
# shellcheck disable=SC2016 # backticks are Markdown inside a jq filter
check "markdown table" '.markdown | test("`cryptophys-platform-api` \\| version_mismatch")' "$drift"

{ for s in "${all[@]}"; do [[ $s == cryptophys-recovery-manager ]] || svc "$s" false "$at"; done; } | report
missing="$("$here/drift-summary.sh" "$tmp/r.json" "$now")"
check "missing service" '.state == "drift" and .problems[0] == {service_id: "cryptophys-recovery-manager", problem: "no_observation"}' "$missing"

for s in "${all[@]}"; do svc "$s" false "$old"; done | report
stale="$("$here/drift-summary.sh" "$tmp/r.json" "$now")"
check "stale observations" '.state == "drift" and (.problems | length) == 12 and all(.problems[]; .problem == "stale_observation")' "$stale"

[[ "$(jq -r .fingerprint <<<"$drift")" != "$(jq -r .fingerprint <<<"$missing")" ]] || { echo "::error::fingerprints must differ" >&2; fail=$((fail + 1)); }
one_drifted | report
[[ "$(jq -r .fingerprint <<<"$drift")" == "$("$here/drift-summary.sh" "$tmp/r.json" "$now" | jq -r .fingerprint)" ]] \
  || { echo "::error::fingerprint is not stable" >&2; fail=$((fail + 1)); }

echo '{"error":"forbidden"}' > "$tmp/bad.json"
if "$here/drift-summary.sh" "$tmp/bad.json" "$now" >/dev/null 2>&1; then echo "::error::a report without services was accepted" >&2; fail=$((fail + 1)); fi

(( fail == 0 )) || exit 1
echo "passed=8 failed=0"
