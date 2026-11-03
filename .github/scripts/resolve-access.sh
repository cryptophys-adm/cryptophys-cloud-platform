#!/usr/bin/env bash
# Resolve the Cloudflare Access team domain and the AUD tag of the platform's Access
# application, and export them as ACCESS_TEAM_DOMAIN / ACCESS_AUD for the deploy step
# (passed to Workers with `wrangler deploy --var`). Fails closed if the application
# is missing, ambiguous, or does not protect the expected Workers.
#
# Env: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ACCESS_API_TOKEN, ACCESS_APP_NAME,
#      optional EXPECTED_WORKERS (space-separated Worker names that must be protected),
#      GITHUB_ENV (when running in Actions).
set -euo pipefail

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_ACCESS_API_TOKEN:?CLOUDFLARE_ACCESS_API_TOKEN is required (Access: Apps and Policies Read/Edit)}"
: "${ACCESS_APP_NAME:?ACCESS_APP_NAME is required}"
api_base="${CF_API_BASE:-https://api.cloudflare.com/client/v4}/accounts/${CLOUDFLARE_ACCOUNT_ID}"

cf_get() {
  curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 20 \
    --header "Authorization: Bearer ${CLOUDFLARE_ACCESS_API_TOKEN}" "${api_base}$1"
}

team_domain="$(cf_get /access/organizations | jq -er '
  if .success != true then error("organizations lookup failed") else .result.auth_domain end
  | select(type == "string" and test("^[a-z0-9-]+\\.cloudflareaccess\\.com$"))')" \
  || { echo "::error::Could not resolve the Zero Trust team domain" >&2; exit 1; }

apps="$(cf_get "/access/apps?per_page=1000")"
app="$(printf '%s' "$apps" | jq -ec --arg n "$ACCESS_APP_NAME" '
  if .success != true then error("apps lookup failed") else . end
  | [.result[] | select(.name == $n)]
  | if length == 1 then .[0] else error("expected exactly one Access application named \($n), found \(length)") end')" \
  || { echo "::error::Access application ${ACCESS_APP_NAME} not found; run the Provision Cloudflare Access workflow" >&2; exit 1; }
aud="$(printf '%s' "$app" | jq -er '.aud | select(type == "string" and test("^[0-9a-f]{64}$"))')" \
  || { echo "::error::Access application has no valid AUD tag" >&2; exit 1; }

if [[ -n "${EXPECTED_WORKERS:-}" ]]; then
  scripts="$(cf_get "/workers/scripts")"
  for name in $EXPECTED_WORKERS; do
    tag="$(printf '%s' "$scripts" | jq -er --arg n "$name" '[.result[] | select(.id == $n)] | if length == 1 then .[0].tag else error("missing") end')" \
      || { echo "::error::Worker ${name} not found in the account" >&2; exit 1; }
    printf '%s' "$app" | jq -e --arg t "$tag" '[.destinations[]? | select(.type == "worker" and .worker_id == $t)] | length == 1' >/dev/null \
      || { echo "::error::Access application ${ACCESS_APP_NAME} does not protect Worker ${name}; re-run Provision Cloudflare Access" >&2; exit 1; }
  done
fi

if [[ -n "${GITHUB_ENV:-}" ]]; then
  { echo "ACCESS_TEAM_DOMAIN=${team_domain}"; echo "ACCESS_AUD=${aud}"; } >> "$GITHUB_ENV"
fi
echo "Cloudflare Access: team ${team_domain}, application ${ACCESS_APP_NAME} protects: ${EXPECTED_WORKERS:-(not checked)}"
