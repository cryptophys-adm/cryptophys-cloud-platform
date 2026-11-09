#!/usr/bin/env bash
# Read-only diagnosis of the CI service token against Cloudflare Access (see access-diagnose.yml).
# Prints names, dates, booleans and status codes only: never a Client ID, secret or token value.
# Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCESS_API_TOKEN, CF_ACCESS_CLIENT_ID,
#      CF_ACCESS_CLIENT_SECRET; optional CF_API_BASE, ACCESS_APP_NAME (default cryptophys-cloud-platform).
set -uo pipefail
api="${CF_API_BASE:-https://api.cloudflare.com/client/v4}/accounts/${CLOUDFLARE_ACCOUNT_ID:?}"
app_name="${ACCESS_APP_NAME:-cryptophys-cloud-platform}"
here="$(cd "$(dirname "$0")" && pwd)"
get() { curl --silent --show-error --proto '=https' --max-time 20 --header "Authorization: Bearer $1" "$2"; }
say() { printf '%s\n' "$*"; echo "$*" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"; }

say "### Access service token diagnosis ($(date -u +%FT%TZ))"

# 1. The stored secrets' shape.
clean() { printf '%s' "$1" | tr -d '\r\n' | sed -E "s/^[[:space:]]*($2:)?[[:space:]]*//I; s/[[:space:]]+$//"; }
id="$(clean "${CF_ACCESS_CLIENT_ID:-}" "CF-Access-Client-Id")"
secret="$(clean "${CF_ACCESS_CLIENT_SECRET:-}" "CF-Access-Client-Secret")"
shape() { local v="$1" s="length ${#1}"; [[ "$v" == *.access ]] && s+=", ends .access"; [[ "$v" == cfast_* ]] && s+=", starts cfast_"; [[ "$v" =~ ^[0-9a-f]{64}$ ]] && s+=", 64 hex"; printf '%s' "$s"; }
say "- Stored CF_ACCESS_CLIENT_ID: $(shape "$id")"
say "- Stored CF_ACCESS_CLIENT_SECRET: $(shape "$secret")"

# 2. The token the stored Client ID names.
tokens="$(get "$CLOUDFLARE_ACCESS_API_TOKEN" "${api}/access/service_tokens?per_page=50")"
if ! jq -e '.success == true' <<<"$tokens" >/dev/null 2>&1; then
  say "- Could not list service tokens: $(jq -c '[.errors[]?.message]' <<<"$tokens" 2>/dev/null)"
  exit 1
fi
say "- Service tokens in the account: $(jq -r '[.result[] | "\(.name) (expires \(.expires_at // "never"), last seen \(.last_seen_at // "never"), updated \(.updated_at // "?"))"] | join("; ")' <<<"$tokens")"
match="$(jq -c --arg c "$id" '[.result[] | select(.client_id == $c or .client_id == ($c + ".access"))]' <<<"$tokens")"
count="$(jq length <<<"$match")"
token_id=""
if [[ "$count" == 1 ]]; then
  token_id="$(jq -r '.[0].id' <<<"$match")"
  say "- The stored Client ID names token **$(jq -r '.[0].name' <<<"$match")**; expires $(jq -r '.[0].expires_at // "never"' <<<"$match"), updated $(jq -r '.[0].updated_at // "?"' <<<"$match"), last seen $(jq -r '.[0].last_seen_at // "never"' <<<"$match")"
  exp="$(jq -r '.[0].expires_at // empty' <<<"$match")"
  if [[ -n "$exp" ]] && [[ "$(date -u -d "$exp" +%s 2>/dev/null || echo 9999999999)" -lt "$(date -u +%s)" ]]; then say "- **The token has expired.**"; fi
else
  say "- **No service token has the stored Client ID** (matches: ${count}). The token was deleted or re-created, or the GitHub secret holds another account's ID."
fi

# 3. The Access application's Service Auth policy.
apps="$(get "$CLOUDFLARE_ACCESS_API_TOKEN" "${api}/access/apps?per_page=1000")"
app="$(jq -c --arg n "$app_name" '[.result[]? | select(.name == $n)] | .[0] // empty' <<<"$apps")"
if [[ -z "$app" ]]; then
  say "- Access application ${app_name} not found."
else
  policy_tokens="$(jq -c '[.policies[]? | select(.decision == "non_identity") | .include[]?.service_token.token_id // empty]' <<<"$app")"
  say "- Application ${app_name}: $(jq -r '[.policies[]? | "\(.name) (\(.decision))"] | join(", ")' <<<"$app")"
  if [[ -n "$token_id" ]]; then
    if jq -e --arg t "$token_id" 'index($t) != null' <<<"$policy_tokens" >/dev/null; then say "- The Service Auth policy names the stored token: yes"
    else say "- **The Service Auth policy does not name the stored token** (it names $(jq length <<<"$policy_tokens") other token(s)). Re-run provision-access.yml to point it at the current token."; fi
  fi
fi

# 4. What the Forge answers to the CI headers.
subdomain="$(get "$CLOUDFLARE_API_TOKEN" "${api}/workers/subdomain" | jq -r '.result.subdomain // empty')"
if [[ -n "$subdomain" ]]; then
  headers="$(mktemp)"; trap 'rm -f "$headers"' EXIT
  if "$here/access-headers.sh" "$headers" 2>/dev/null; then
    code="$(curl --silent --proto '=https' --max-time 20 --header "@${headers}" --output /dev/null --write-out '%{http_code}' "https://cryptophys-forge.${subdomain}.workers.dev/health")"
    say "- Forge /health with the CI headers: HTTP ${code}"
  else
    say "- The stored values could not form Access headers (empty, or ID and secret swapped)."
  fi
fi
say "- Reading: 302 with a matching, unexpired token named in the policy means the stored **secret** is not the token's current secret (rotated/refreshed). Fix: put the token's current secret in the GitHub production secret CF_ACCESS_CLIENT_SECRET."
