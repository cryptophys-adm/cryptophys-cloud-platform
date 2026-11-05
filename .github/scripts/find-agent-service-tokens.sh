#!/usr/bin/env bash
# Print, as a JSON array, the IDs of the Cloudflare Access service tokens that belong to
# external AI agents (ADR-0007, TP-009): tokens whose name starts with "cryptophys-agent-".
# Identifiers only; no Client ID or secret is printed. An empty array is valid.
#
# Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ACCESS_API_TOKEN
set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_ACCESS_API_TOKEN:?CLOUDFLARE_ACCESS_API_TOKEN is required}"
api="${CF_API_BASE:-https://api.cloudflare.com/client/v4}/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/service_tokens"
prefix="cryptophys-agent-"

ids="[]"
page=1
while :; do
  response="$(curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 20 \
    --header "Authorization: Bearer ${CLOUDFLARE_ACCESS_API_TOKEN}" "${api}?per_page=50&page=${page}")" \
    || { echo "::error::Listing Access service tokens failed" >&2; exit 1; }
  jq -e '.success == true' <<<"$response" >/dev/null || { echo "::error::Access service token API returned success=false" >&2; exit 1; }
  ids="$(jq -c --argjson acc "$ids" --arg p "$prefix" \
    '$acc + [.result[] | select((.name // "") | startswith($p)) | select(.id | test("^[0-9a-f-]{36}$")) | .id]' <<<"$response")"
  total_pages="$(jq -r '.result_info.total_pages // 1' <<<"$response")"
  (( page >= total_pages )) && break
  page=$((page + 1))
done
jq -c 'unique' <<<"$ids"
