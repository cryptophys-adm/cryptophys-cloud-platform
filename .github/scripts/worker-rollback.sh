#!/usr/bin/env bash
# Automatic rollback for production deploys (ADR-0009 §3.3, phase 3).
#
#   worker-rollback.sh capture STATE_FILE SCRIPT_NAME...
#       Records each Worker's active deployment (version ids and percentages) before a deploy.
#   worker-rollback.sh restore STATE_FILE
#       For every captured Worker whose active deployment changed, creates a new deployment
#       that serves the captured versions again. Workers the deploy never reached are left alone.
#
# Only Worker versions are rolled back. D1 migrations are forward-only and additive; the
# deploy workflow prints the pre-migration Time Travel bookmark, and restoring data stays an
# owner decision (critical class). A rollback across a Durable Object migration is refused
# by Cloudflare and reported as a failure.
#
# Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (Workers Scripts Edit); optional
#      CLOUDFLARE_API_BASE, ROLLBACK_MESSAGE. The token is never printed.
set -euo pipefail

mode="${1:?usage: worker-rollback.sh capture STATE_FILE SCRIPT... | restore STATE_FILE}"
state="${2:?STATE_FILE is required}"
api_base="${CLOUDFLARE_API_BASE:-https://api.cloudflare.com/client/v4}"
account="${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
auth="Authorization: Bearer ${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
[[ "$account" =~ ^[0-9a-f]{32}$ ]] || { echo "::error::invalid CLOUDFLARE_ACCOUNT_ID" >&2; exit 1; }

active() { # SCRIPT -> JSON array of {version_id, percentage}, sorted
  curl --fail --silent --show-error --proto '=https' --max-time 20 --header "$auth" \
    "${api_base}/accounts/${account}/workers/scripts/$1/deployments" \
    | jq -ce '.result.deployments | sort_by(.created_on) | last | .versions
        | map({version_id, percentage}) | sort_by(.version_id)
        | select(length > 0 and all(.version_id | test("^[0-9a-f-]{36}$")))'
}

case "$mode" in
  capture)
    shift 2
    (( $# > 0 )) || { echo "::error::no Worker names given" >&2; exit 1; }
    echo '{}' >"$state"
    for script in "$@"; do
      [[ "$script" =~ ^[a-z0-9][a-z0-9-]{1,62}$ ]] || { echo "::error::invalid Worker name" >&2; exit 1; }
      versions="$(active "$script")" || { echo "::error::cannot read the active deployment of ${script}" >&2; exit 1; }
      jq --arg s "$script" --argjson v "$versions" '.[$s] = $v' "$state" >"${state}.tmp" && mv "${state}.tmp" "$state"
      echo "Captured ${script}: $(jq -r '[.[] | "\(.version_id)@\(.percentage)%"] | join(", ")' <<<"$versions")"
    done
    ;;
  restore)
    [[ -s "$state" ]] || { echo "::error::no captured state; nothing can be rolled back" >&2; exit 1; }
    message="${ROLLBACK_MESSAGE:-automatic rollback after a failed deploy verification}"
    failed=0
    while IFS= read -r script; do
      want="$(jq -c --arg s "$script" '.[$s]' "$state")"
      now="$(active "$script" || echo null)"
      if [[ "$now" == "$want" ]]; then
        echo "${script}: unchanged by this deploy; nothing to roll back."
        continue
      fi
      body="$(jq -cn --argjson v "$want" --arg m "${message:0:100}" \
        '{strategy: "percentage", versions: $v, annotations: {"workers/message": $m}}')"
      if curl --fail --silent --show-error --proto '=https' --max-time 30 --request POST \
          --header "$auth" --header "Content-Type: application/json" --data "$body" \
          "${api_base}/accounts/${account}/workers/scripts/${script}/deployments" | jq -e '.success == true' >/dev/null \
        && [[ "$(active "$script")" == "$want" ]]; then
        echo "::warning::${script} rolled back to $(jq -r '[.[].version_id] | join(", ")' <<<"$want")"
      else
        echo "::error::rollback of ${script} failed; manual action needed"
        failed=1
      fi
    done < <(jq -r 'keys_unsorted[]' "$state")
    exit "$failed"
    ;;
  *) echo "::error::unknown mode ${mode}" >&2; exit 1 ;;
esac
