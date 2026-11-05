#!/usr/bin/env bash
# Summarize the AI Kernel GET /v1/status agent_reports_24h block for public alerting.
#
# Usage: report-summary.sh STATUS_JSON
# Prints one JSON object: {state, fingerprint, critical, markdown}.
# Public issue content is deliberately limited to time, agent id and report kind.
# Never copy report subjects, report ids or report bodies into the public repository.
set -euo pipefail

status="${1:?usage: report-summary.sh STATUS_JSON}"
summary="$(jq -c '
  (.agent_reports_24h // error("status has no agent_reports_24h")) as $r
  | if ($r.error // null) != null then error("report summary unavailable: \\($r.error)") else . end
  | ($r.counts.critical // error("status has no critical count")) as $n
  | if ($n | type) != "number" or $n < 0 or ($n | floor) != $n then error("invalid critical count") else . end
  | ($r.critical_fingerprint
      | if type == "string" and test("^[0-9a-f]{64}$") then . else error("invalid critical report fingerprint") end) as $fp
  | ($r.latest_critical
      | if type == "array" and length <= 5 then . else error("invalid latest_critical list") end) as $rows
  | if $n > 0 and ($rows | length) == 0 then error("critical reports exist but no critical metadata was returned") else . end
  | ($rows | map({
      time: (if (.created_at | type) == "string" and (.created_at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+Z$")) then .created_at else "unknown" end),
      agent: (if (.agent_id | type) == "string" and (.agent_id | test("^[a-z0-9-]{1,64}$")) then .agent_id else "unknown" end),
      kind: (if (.kind | type) == "string" and (.kind | test("^[a-z0-9_-]{1,64}$")) then .kind else "unknown" end)
    })) as $safe
  | {
      state: (if $n > 0 then "critical" else "clear" end),
      critical: $n,
      fingerprint: $fp,
      markdown: (if $n == 0 then "No critical agent report in the last 24 hours (since \\($r.since))."
        else "\\($n) critical report(s) since \\($r.since). Newest (up to 5; subjects withheld):\\n\\n| Time (UTC) | Agent | Kind |\\n| --- | --- | --- |\\n"
          + ($safe | map("| \\(.time) | \\(.agent) | \\(.kind) |") | join("\\n")) end)
    }' "$status")"
printf '%s' "$summary"
