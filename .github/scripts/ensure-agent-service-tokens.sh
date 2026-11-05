#!/usr/bin/env bash
# Idempotently ensure Cloudflare Access service tokens named "cryptophys-agent-<agent-id>"
# exist for the given agent IDs, and print a JSON array of non-secret metadata:
#   [{"agent_id":"...","name":"cryptophys-agent-...","id":"...","client_id":"....access","created":true|false}]
# Never prints or logs client_secret.
#
# Usage: ensure-agent-service-tokens.sh <agent-id> [<agent-id> ...]
# Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ACCESS_API_TOKEN
set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_ACCESS_API_TOKEN:?CLOUDFLARE_ACCESS_API_TOKEN is required}"
if [[ $# -eq 0 ]]; then
  echo "::error::At least one agent_id is required" >&2
  exit 1
fi

api="${CF_API_BASE:-https://api.cloudflare.com/client/v4}/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/service_tokens"

existing="[]"
page=1
while :; do
  response="$(curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 20 \
    --header "Authorization: Bearer ${CLOUDFLARE_ACCESS_API_TOKEN}" "${api}?per_page=50&page=${page}")" \
    || { echo "::error::Listing Access service tokens failed" >&2; exit 1; }
  jq -e '.success == true' <<<"$response" >/dev/null || { echo "::error::Access service token API returned success=false" >&2; exit 1; }
  existing="$(jq -c --argjson acc "$existing" \
    '$acc + [.result[] | {id: .id, name: .name, client_id: .client_id}]' <<<"$response")"
  total_pages="$(jq -r '.result_info.total_pages // 1' <<<"$response")"
  (( page >= total_pages )) && break
  page=$((page + 1))
done

out="[]"
for agent_id in "$@"; do
  if [[ ! "$agent_id" =~ ^[a-z0-9-]{2,40}$ ]]; then
    echo "::error::Invalid agent_id: ${agent_id}" >&2
    exit 1
  fi
  token_name="cryptophys-agent-${agent_id}"
  found="$(jq -c --arg n "$token_name" '[.[] | select(.name == $n)] | .[0] // empty' <<<"$existing")"
  if [[ -n "$found" ]]; then
    out="$(jq -c --arg aid "$agent_id" --argjson f "$found" \
      '. + [{agent_id: $aid, name: $f.name, id: $f.id, client_id: $f.client_id, created: false}]' <<<"$out")"
  else
    create_resp="$(curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 20 \
      --request POST "$api" \
      --header "Authorization: Bearer ${CLOUDFLARE_ACCESS_API_TOKEN}" \
      --header "Content-Type: application/json" \
      --data "$(jq -cn --arg n "$token_name" '{name: $n, duration: "8760h"}')")" \
      || { echo "::error::Creating Access service token ${token_name} failed" >&2; exit 1; }
    jq -e '.success == true and (.result.id | type == "string") and (.result.client_id | type == "string")' <<<"$create_resp" >/dev/null \
      || { echo "::error::Unexpected create response for ${token_name}" >&2; exit 1; }
    out="$(jq -c --arg aid "$agent_id" --argjson r "$(jq -c '{id: .result.id, name: .result.name, client_id: .result.client_id}' <<<"$create_resp")" \
      '. + [{agent_id: $aid, name: $r.name, id: $r.id, client_id: $r.client_id, created: true}]' <<<"$out")"
  fi
done

jq -c '.' <<<"$out"
