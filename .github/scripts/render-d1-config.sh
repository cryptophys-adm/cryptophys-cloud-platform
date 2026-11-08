#!/usr/bin/env bash
# Render runner-only wrangler.deploy.toml files with the control-plane D1 database ID
# and any owner-email recipient allowlist supplied by the protected Environment.
#
# The account-specific ID is never committed (ADR-0001). It is resolved from the
# Cloudflare API by exact database name, must match exactly one database, is
# masked in the log, and substituted for the __CONTROL_PLANE_D1_DATABASE_ID__
# placeholder, which must appear exactly once in each source config.
#
# Usage: render-d1-config.sh <worker-dir>...   (directories containing wrangler.toml)
# Env:   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, D1_DATABASE_NAME; optional APPROVER_IDENTITIES
set -euo pipefail

placeholder="__CONTROL_PLANE_D1_DATABASE_ID__"
email_placeholder="owner-notify-placeholder@example.invalid"
: "${D1_DATABASE_NAME:?D1_DATABASE_NAME is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
[[ $# -ge 1 ]] || { echo "usage: $0 <worker-dir>..." >&2; exit 2; }

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
status="$(curl --silent --show-error --proto '=https' --tlsv1.2 --max-time 20 \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" --output "$body" --write-out '%{http_code}' \
  "${CF_API_BASE:-https://api.cloudflare.com/client/v4}/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database?name=${D1_DATABASE_NAME}&per_page=100")"
if [[ "$status" != "200" ]]; then
  echo "::error::Cloudflare D1 API returned HTTP ${status}: $(jq -c '[.errors[]? | {code, message}]' "$body" 2>/dev/null || echo 'non-JSON response'). The token used for D1 needs Account > D1 > Edit on this account." >&2
  exit 1
fi
response="$(cat "$body")"
database_id="$(printf '%s' "$response" | jq -er --arg n "$D1_DATABASE_NAME" '
  if .success != true then error("D1 list failed") else . end
  | [.result[] | select(.name == $n)]
  | if length == 1 then .[0].uuid else error("expected exactly one database named \($n), found \(length)") end')"
[[ "$database_id" =~ ^[0-9a-f-]{36}$ ]] || { echo "::error::Unexpected D1 database id format" >&2; exit 1; }
if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::add-mask::${database_id}"; fi

for dir in "$@"; do
  src="${dir%/}/wrangler.toml"
  [[ "$(grep -c "$placeholder" "$src")" == "1" ]] || { echo "::error::$src must contain $placeholder exactly once" >&2; exit 1; }
  rendered="$(sed "s/${placeholder}/${database_id}/" "$src")"

  # Cloudflare's send_email binding is restricted to the human approver list at the binding
  # boundary, not only in application code. access-identities.sh writes this comma-separated,
  # email-only value to GITHUB_ENV before this renderer runs.
  if grep -Fq "$email_placeholder" "$src"; then
    matches="$(grep -F -o "$email_placeholder" "$src" | wc -l | tr -d '[:space:]')"
    [[ "$matches" == "1" ]] || { echo "::error::$src must contain $email_placeholder exactly once" >&2; exit 1; }
    : "${APPROVER_IDENTITIES:?APPROVER_IDENTITIES is required to render the owner-email allowlist}"
    IFS=',' read -r -a approvers <<< "$APPROVER_IDENTITIES"
    email_values=""
    seen="|"
    count=0
    for raw_email in "${approvers[@]}"; do
      email="$(printf '%s' "$raw_email" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
      [[ "$email" =~ ^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "::error::APPROVER_IDENTITIES contains an invalid email address" >&2; exit 1; }
      if [[ "$seen" == *"|${email}|"* ]]; then continue; fi
      seen+="${email}|"
      if [[ -n "${GITHUB_ACTIONS:-}" ]]; then echo "::add-mask::${email}"; fi
      if (( count > 0 )); then email_values+="\", \""; fi
      email_values+="${email}"
      count=$((count + 1))
    done
    (( count > 0 )) || { echo "::error::APPROVER_IDENTITIES must contain at least one human approver email" >&2; exit 1; }
    escaped_email_placeholder="${email_placeholder//./\\.}"
    rendered="$(printf '%s\\n' "$rendered" | sed "s|${escaped_email_placeholder}|${email_values}|")"
  fi

  printf '%s\\n' "$rendered" > "${dir%/}/wrangler.deploy.toml"
  if grep -q "$placeholder" "${dir%/}/wrangler.deploy.toml" || grep -Fq "$email_placeholder" "${dir%/}/wrangler.deploy.toml"; then
    echo "::error::a deploy-config placeholder was not replaced in $dir" >&2
    exit 1
  fi
done
echo "Resolved ${D1_DATABASE_NAME} and rendered wrangler.deploy.toml for: $*"
