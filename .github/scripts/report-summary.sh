#!/usr/bin/env bash
# Summarize the AI Kernel GET /v1/status agent_reports_24h block for public alerting.
#
# Usage: report-summary.sh STATUS_JSON
# Prints one JSON object: {state, fingerprint, critical, markdown}.
# Public issue content is deliberately limited to time, agent id and report kind.
# Never copy report subjects, report ids or report bodies into the public repository.
# A legacy fallback keeps alerting functional until the updated AI Kernel is deployed.
set -euo pipefail

status="${1:?usage: report-summary.sh STATUS_JSON}"
summary="$(jq -c '
  def safe_rows:
    map({
      time: (if (.created_at | type) == "string" and (.created_at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+Z$")) then .created_at else "unknown" end),
      agent: (if (.agent_id | type) == "string" and (.agent_id | test("^[a-z0-9-]{1,64}$")) then .agent_id else "unknown" end),
      kind: (if (.kind | type) == "string" and (.kind | test("^[a-z0-9_-]{1,64}$")) then .kind else "unknown" end)
    });
  def render($n; $since; $rows; $legacy):
    if $n == 0 then "No critical agent report in the last 24 hours (since \($since))."
    elif ($rows | length) == 0 then "Critical report(s) exist since \($since), but metadata is unavailable from the pre-upgrade kernel. Subjects and bodies are withheld."
    else "\($n) critical report(s) since \($since). Newest (up to 5; subjects withheld):\n\n| Time (UTC) | Agent | Kind |\n| --- | --- | --- |\n"
      + ($rows | map("| \(.time) | \(.agent) | \(.kind) |") | join("\n"))
    end;
  (.agent_reports_24h // error("status has no agent_reports_24h")) as $r
  | if ($r.error // null) != null then error("report summary unavailable: \($r.error)") else . end
  | ($r.counts.critical // error("status has no critical count")) as $n
  | if ($n | type) != "number" or $n < 0 or ($n | floor) != $n then error("invalid critical count") else . end
  | (($r | has("critical_fingerprint")) as $has_fp
     | ($r | has("latest_critical")) as $has_latest
     | if $has_fp != $has_latest then error("partial critical-report v2 metadata")
       elif $has_fp then
         ($r.critical_fingerprint | if type == "string" and test("^[0-9a-f]{64}$") then . else error("invalid critical report fingerprint") end) as $fp
         | ($r.latest_critical | if type == "array" and length <= 5 then . else error("invalid latest_critical list") end | sort_by(.created_at) | reverse) as $raw
         | if $n > 0 and ($raw | length) == 0 then error("critical reports exist but no critical metadata was returned") else . end
         | ($raw | safe_rows) as $rows
         | {state:(if $n > 0 then "critical" else "clear" end),critical:$n,fingerprint_input:("v2:" + $fp),markdown:render($n;$r.since;$rows;false)}
       else
         ($r.latest_attention | if type == "array" and length <= 5 then . else error("invalid legacy latest_attention list") end
          | map(select(.severity == "critical") | {report_id,agent_id,kind,created_at})
          | sort_by(.created_at) | reverse) as $raw
         | ($raw | safe_rows) as $rows
         | {state:(if $n > 0 then "critical" else "clear" end),critical:$n,
            fingerprint_input:("legacy:" + ($n|tostring) + ":" + ($raw | map(.report_id // "") | sort | join(";"))),
            markdown:render($n;$r.since;$rows;true)}
       end)
' "$status")"
fp_input="$(printf '%s' "$summary" | jq -r .fingerprint_input)"
fp="$(printf '%s' "$fp_input" | sha256sum | cut -c1-64)"
printf '%s' "$summary" | jq -c --arg fp "$fp" 'del(.fingerprint_input) | .fingerprint = $fp'
