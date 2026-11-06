#!/usr/bin/env bash
# Summarise what waits for the owner's approval click (Wave B).
#   owner-attention.sh PLANS_JSON CONSENSUS_JSON CONSOLE_URL
# Prints {count, fingerprint, markdown}. Inputs are the Recovery Manager's GET /v1/plans?status=draft
# and the AI Kernel's GET /v1/consensus. Only ids, services, actions and titles are printed.
set -euo pipefail
plans="${1:?plans json}"; consensus="${2:?consensus json}"; console="${3:?console url}"
jq -n --slurpfile p "$plans" --slurpfile c "$consensus" --arg console "$console" '
  ([$p[0].plans[]? | select(.status == "draft")
    | {kind: "plan", id: .plan_id, service: .service_id, title: ((.plan.title // "") | .[0:120]), by: (.created_by // ""), expires: (.approve_by // "")}]) as $plans
  | ([$c[0].proposals[]? | select(.status == "pending_owner")
    | {kind: "critical", id: .proposal_id, service: .target, title: .action, by: .proposer_agent_id, expires: ""}]) as $crit
  | ($plans + $crit) as $all
  | {
      count: ($all | length),
      fingerprint: ($all | map(.id) | sort | join(",") | @base64 | .[0:64]),
      markdown: (
        if ($all | length) == 0 then "Nothing waits."
        else
          "| What | Service | Item | Proposed by | Open |\n|---|---|---|---|---|\n" +
          ($all | map(
            "| \(if .kind == "plan" then "Recovery plan" else "Critical action" end) | `\(.service)` | \(.title) | `\(.by)` | [" +
            (if .kind == "plan" then "review" else "decide" end) + "](" +
            (if .kind == "plan" then "\($console)#/recovery/\(.id)" else "\($console)#/consensus" end) + ") |"
          ) | join("\n"))
        end)
    }'
