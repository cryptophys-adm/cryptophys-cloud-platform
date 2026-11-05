#!/usr/bin/env bash
# Summarize the AI Kernel GET /v1/status agent_reports_24h block for alerting.
#
# Usage: report-summary.sh STATUS_JSON
# Prints one JSON object: {state, fingerprint, critical, markdown}
#   state = "clear" | "critical"
#   fingerprint = stable hash of the critical report ids, so the alert updates only on change
# Only report_id, agent_id, kind, subject and created_at are used (never report bodies).
set -euo pipefail

status="${1:?usage: report-summary.sh STATUS_JSON}"
summary="$(jq -c '
  (.agent_reports_24h // error("status has no agent_reports_24h")) as $r
  | if ($r.error // null) != null then error("report summary unavailable: \($r.error)") else . end
  | ([$r.latest_attention[]? | select(.severity == "critical")
      | {report_id, agent_id, kind, created_at, subject: (.subject | tostring | gsub("[|\\r\\n`]"; " ") | .[0:200])}]
     | sort_by(.created_at) | reverse) as $c
  | ($r.counts.critical // 0) as $n
  | {
      state: (if $n > 0 then "critical" else "clear" end),
      critical: $n,
      fingerprint: ($c | map(.report_id) | sort | join(";")),
      markdown: (if $n == 0 then "No critical agent report in the last 24 hours (since \($r.since))."
        else "\($n) critical report(s) since \($r.since). Newest (up to 5):\n\n| Time (UTC) | Agent | Kind | Subject |\n| --- | --- | --- | --- |\n"
          + ($c | map("| \(.created_at) | `\(.agent_id)` | \(.kind) | \(.subject) |") | join("\n")) end)
    }' "$status")"
fp="$(printf '%s' "$summary" | jq -r '"\(.critical):\(.fingerprint)"' | sha256sum | cut -c1-16)"
printf '%s' "$summary" | jq -c --arg fp "$fp" '.fingerprint = $fp'
