#!/usr/bin/env bash
# Render runner-only wrangler.deploy.toml files with the control-plane D1 database ID.
#
# The account-specific ID is never committed (ADR-0001). It is resolved from the
# Cloudflare API by exact database name, must match exactly one database, is
# masked in the log, and substituted for the __CONTROL_PLANE_D1_DATABASE_ID__
# placeholder, which must appear exactly once in each source config.
#
# Usage: render-d1-config.sh <worker-dir>...   (directories containing wrangler.toml)
# Env:   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_NAME
set -euo pipefail

placeholder="__CONTROL_PLANE_D1_DATABASE_ID__"
: "${D1_DATABASE_NAME:?D1_DATABASE_NAME is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
[[ $# -ge 1 ]] || { echo "usage: $0 <worker-dir>..." >&2; exit 2; }

response="$(curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 20 \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database?name=${D1_DATABASE_NAME}&per_page=100")"
database_id="$(printf '%s' "$response" | jq -er --arg n "$D1_DATABASE_NAME" '
  if .success != true then error("D1 list failed") else . end
  | [.result[] | select(.name == $n)]
  | if length == 1 then .[0].uuid else error("expected exactly one database named \($n), found \(length)") end')"
[[ "$database_id" =~ ^[0-9a-f-]{36}$ ]] || { echo "::error::Unexpected D1 database id format" >&2; exit 1; }
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::add-mask::${database_id}"; fi

for dir in "$@"; do
  src="${dir%/}/wrangler.toml"
  [[ "$(grep -c "$placeholder" "$src")" == "1" ]] || { echo "::error::$src must contain $placeholder exactly once" >&2; exit 1; }
  sed "s/${placeholder}/${database_id}/" "$src" > "${dir%/}/wrangler.deploy.toml"
  if grep -q "$placeholder" "${dir%/}/wrangler.deploy.toml"; then echo "::error::placeholder not replaced in $dir" >&2; exit 1; fi
done
echo "Resolved ${D1_DATABASE_NAME} and rendered wrangler.deploy.toml for: $*"
