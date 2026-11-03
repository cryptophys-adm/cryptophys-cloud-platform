#!/usr/bin/env bash
# Find the Cloudflare Access service token whose Client ID is CF_ACCESS_CLIENT_ID and
# print its token ID (needed for the Service Auth policy).
#
# Tolerates the common ways a Client ID gets pasted into a secret: surrounding
# whitespace/CR, a copied "CF-Access-Client-Id:" prefix, a missing ".access" suffix,
# or the token's own UUID instead of the Client ID. Pages through every token.
#
# On failure it explains why without printing the secret or any Client ID: it lists
# the visible token names and describes the shape of the supplied value.
#
# Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ACCESS_API_TOKEN, CF_ACCESS_CLIENT_ID
set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_ACCESS_API_TOKEN:?CLOUDFLARE_ACCESS_API_TOKEN is required}"
: "${CF_ACCESS_CLIENT_ID:?CF_ACCESS_CLIENT_ID is required}"
api="${CF_API_BASE:-https://api.cloudflare.com/client/v4}/accounts/${CLOUDFLARE_ACCOUNT_ID}/access/service_tokens"

# Normalise: strip CR/LF, surrounding whitespace and an accidental header-name prefix.
client_id="$(printf '%s' "$CF_ACCESS_CLIENT_ID" | tr -d '\r\n' \
  | sed -E 's/^[[:space:]]*([Cc][Ff]-[Aa]ccess-[Cc]lient-[Ii]d:)?[[:space:]]*//; s/[[:space:]]+$//')"

tokens="[]"
page=1
while :; do
  response="$(curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 20 \
    --header "Authorization: Bearer ${CLOUDFLARE_ACCESS_API_TOKEN}" "${api}?per_page=50&page=${page}")" \
    || { echo "::error::Listing Access service tokens failed (check CLOUDFLARE_ACCESS_API_TOKEN has Access: Service Tokens Read)" >&2; exit 1; }
  jq -e '.success == true' <<<"$response" >/dev/null || { echo "::error::Access service token API returned success=false" >&2; exit 1; }
  tokens="$(jq -c --argjson acc "$tokens" '$acc + (.result // [])' <<<"$response")"
  total_pages="$(jq -r '.result_info.total_pages // 1' <<<"$response")"
  (( page >= total_pages )) && break
  page=$((page + 1))
  (( page <= 100 )) || break
done

match="$(jq -c --arg c "$client_id" '[.[] | select(.client_id == $c or .client_id == ($c + ".access") or .id == $c)]' <<<"$tokens")"
case "$(jq length <<<"$match")" in
  1)
    jq -r '.[0].id' <<<"$match"
    how="$(jq -r --arg c "$client_id" '.[0] | if .client_id == $c then "client_id" elif .id == $c then "token id (UUID) — store the Client ID instead" else "client_id without the .access suffix" end' <<<"$match")"
    echo "Matched service token \"$(jq -r '.[0].name' <<<"$match")\" by ${how}" >&2
    ;;
  0)
    shape="length ${#client_id}"
    [[ "$client_id" == *.access ]] && shape+=", ends with .access" || shape+=", no .access suffix"
    [[ "$client_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] && shape+=", UUID-shaped"
    [[ "$client_id" =~ ^cfast_ ]] && shape+=", looks like a Client SECRET (cfast_…) — the secrets may be swapped"
    [[ "$client_id" != "$CF_ACCESS_CLIENT_ID" ]] && shape+=", had whitespace/prefix that was removed"
    echo "::error::No Access service token in this account matches CF_ACCESS_CLIENT_ID (${shape})." >&2
    echo "::error::Visible service tokens ($(jq length <<<"$tokens")): $(jq -r '[.[] | "\(.name) (expires \(.expires_at // "never"))"] | join(", ") | if . == "" then "none" else . end' <<<"$tokens")" >&2
    echo "::error::Set CF_ACCESS_CLIENT_ID to the token's Client ID (ends with .access) from Zero Trust → Access → Service credentials, in the same account as CLOUDFLARE_ACCOUNT_ID." >&2
    exit 1
    ;;
  *)
    echo "::error::CF_ACCESS_CLIENT_ID matches more than one service token" >&2
    exit 1
    ;;
esac
