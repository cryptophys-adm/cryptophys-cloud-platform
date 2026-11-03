#!/usr/bin/env bash
# Summarize a Drift Detector GET /v1/drift report for alerting.
#
# Usage: drift-summary.sh REPORT_JSON NOW_EPOCH [MAX_AGE_SECONDS]
# Prints one JSON object: {state, fingerprint, problems, markdown}
#   state = "in_sync" | "drift"  (drift also covers unhealthy, missing and stale observations)
#   fingerprint = stable hash of the problem set, so an alert is updated only when it changes
set -euo pipefail

report="${1:?usage: drift-summary.sh REPORT_JSON NOW_EPOCH [MAX_AGE_SECONDS]}"
now="${2:?usage: drift-summary.sh REPORT_JSON NOW_EPOCH [MAX_AGE_SECONDS]}"
max_age="${3:-2700}"
[[ "$now" =~ ^[0-9]+$ && "$max_age" =~ ^[0-9]+$ ]] || { echo "::error::NOW_EPOCH and MAX_AGE_SECONDS must be integers" >&2; exit 1; }
expected='["cryptophys-audit-ledger","cryptophys-deployment-orchestrator","cryptophys-drift-detector","cryptophys-platform-api","cryptophys-platform-registry","cryptophys-policy-engine","cryptophys-recovery-manager"]'

summary="$(jq -c --argjson now "$now" --argjson max "$max_age" --argjson expected "$expected" '
  def age: $now - (.observed_at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601);
  (.services // error("report has no services")) as $s
  | ([$s[] | select(.drifted == true)
      | {service_id, problem: ((.evidence.reasons // []) | join(", ")), desired: .evidence.desired_version, observed: .evidence.probe.version_tag}])
    + ([$expected[] as $e | select([$s[].service_id] | index($e) | not) | {service_id: $e, problem: "no_observation"}])
    + ([$s[] | select(age > $max) | {service_id, problem: "stale_observation"}])
  | sort_by(.service_id, .problem) as $p
  | {
      state: (if ($p | length) == 0 then "in_sync" else "drift" end),
      problems: $p,
      fingerprint: ($p | map("\(.service_id):\(.problem)") | join(";")),
      markdown: (if ($p | length) == 0 then "All \($expected | length) Workers are healthy and at their desired versions."
        else "| Service | Problem | Desired | Observed |\n| --- | --- | --- | --- |\n"
          + ($p | map("| `\(.service_id)` | \(.problem) | \(.desired // "-") | \(.observed // "-") |") | join("\n")) end)
    }' "$report")"
fp="$(printf '%s' "$summary" | jq -r .fingerprint | sha256sum | cut -c1-16)"
printf '%s' "$summary" | jq -c --arg fp "$fp" '.fingerprint = $fp'
