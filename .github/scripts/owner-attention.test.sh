#!/usr/bin/env bash
# Hermetic test for owner-attention.sh.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cat >"$tmp/plans.json" <<'J'
{"plans":[{"plan_id":"plan_1","service_id":"cryptophys-console","status":"draft","created_by":"agent:supervisor","approve_by":"2026-11-09T00:00:00Z","plan":{"title":"Drift on console"}},
          {"plan_id":"plan_2","service_id":"cryptophys-home","status":"completed","plan":{"title":"done"}}]}
J
cat >"$tmp/cons.json" <<'J'
{"proposals":[{"proposal_id":"cns_a","target":"cryptophys-home","action":"retire_worker","status":"pending_owner","proposer_agent_id":"supervisor"},
              {"proposal_id":"cns_b","target":"x","action":"deploy_commit","status":"shadow_passed","proposer_agent_id":"supervisor"}]}
J
out="$(bash "$here/owner-attention.sh" "$tmp/plans.json" "$tmp/cons.json" "https://nexus.cryptophys.work/console/")"
[[ "$(jq -r .count <<<"$out")" == "2" ]] || { echo "FAIL count"; exit 1; }
jq -e '.markdown | contains("https://nexus.cryptophys.work/console/#/recovery/plan_1") and contains("retire_worker") and (contains("plan_2") | not) and (contains("cns_b") | not)' <<<"$out" >/dev/null || { echo "FAIL markdown"; exit 1; }
fp1="$(jq -r .fingerprint <<<"$out")"
echo '{"plans":[]}' >"$tmp/empty.json"; echo '{"proposals":[]}' >"$tmp/emptyc.json"
out2="$(bash "$here/owner-attention.sh" "$tmp/empty.json" "$tmp/emptyc.json" "x")"
[[ "$(jq -r .count <<<"$out2")" == "0" ]] && [[ "$(jq -r .fingerprint <<<"$out2")" != "$fp1" ]] || { echo "FAIL empty"; exit 1; }
echo "owner-attention.sh: all tests passed"
