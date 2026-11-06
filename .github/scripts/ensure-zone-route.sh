#!/usr/bin/env bash
# Ensure one Workers zone route exists and points at the given Worker (ADR-0010). Idempotent.
# Env: CLOUDFLARE_ACCESS_API_TOKEN (Zone: Workers Routes Edit on ZONE_NAME), ZONE_NAME,
#      ROUTE_PATTERN, SCRIPT; optional CF_API_BASE. The token is never printed.
set -euo pipefail
: "${CLOUDFLARE_ACCESS_API_TOKEN:?CLOUDFLARE_ACCESS_API_TOKEN is required}"
: "${ZONE_NAME:?}" "${ROUTE_PATTERN:?}" "${SCRIPT:?}"
[[ "$ZONE_NAME" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] || { echo "::error::invalid zone"; exit 1; }
[[ "$ROUTE_PATTERN" =~ ^[a-z0-9.-]+/[a-z0-9/*_-]*$ ]] || { echo "::error::invalid route pattern"; exit 1; }
[[ "$SCRIPT" =~ ^[a-z0-9][a-z0-9-]*$ ]] || { echo "::error::invalid script name"; exit 1; }
api="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"
auth="Authorization: Bearer ${CLOUDFLARE_ACCESS_API_TOKEN}"
call() { # METHOD PATH [JSON]
  local -a data=(); [[ $# -ge 3 ]] && data=(--header "Content-Type: application/json" --data "$3")
  curl --silent --show-error --proto '=https' --max-time 30 --retry 5 --retry-delay 10 --request "$1" --header "$auth" "${data[@]}" "${api}$2"
}
zone="$(call GET "/zones?name=${ZONE_NAME}" | jq -er '.result | if length == 1 then .[0].id else error("zone not found") end')" \
  || { echo "::error::Cannot read zone ${ZONE_NAME} with CLOUDFLARE_ACCESS_API_TOKEN (needs Zone: Zone Read and Workers Routes Edit on it)"; exit 1; }
routes="$(call GET "/zones/${zone}/workers/routes")"
jq -e '.success == true' <<<"$routes" >/dev/null || { echo "::error::Cannot list Workers routes on ${ZONE_NAME}: $(jq -c '[.errors[]?.message]' <<<"$routes")"; exit 1; }
existing="$(jq -c --arg p "$ROUTE_PATTERN" '[.result[] | select(.pattern == $p)][0] // empty' <<<"$routes")"
body="$(jq -cn --arg p "$ROUTE_PATTERN" --arg s "$SCRIPT" '{pattern: $p, script: $s}')"
if [[ -z "$existing" ]]; then
  out="$(call POST "/zones/${zone}/workers/routes" "$body")"; action=created
elif [[ "$(jq -r '.script // ""' <<<"$existing")" != "$SCRIPT" ]]; then
  out="$(call PUT "/zones/${zone}/workers/routes/$(jq -r .id <<<"$existing")" "$body")"; action=updated
else
  echo "Route ${ROUTE_PATTERN} already points at ${SCRIPT}."; exit 0
fi
jq -e '.success == true' <<<"$out" >/dev/null || { echo "::error::Could not ${action%d} route ${ROUTE_PATTERN}: $(jq -c '[.errors[]? | {code, message}]' <<<"$out")"; exit 1; }
echo "Route ${ROUTE_PATTERN} ${action} -> ${SCRIPT}."
