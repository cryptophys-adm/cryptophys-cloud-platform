#!/usr/bin/env bash
# Print the Cloudflare Access identity allow-lists as KEY=VALUE lines for $GITHUB_ENV:
#   OPERATOR_IDENTITIES  CI service token Client ID + operator emails (control-plane /v1, deployment requests)
#   APPROVER_IDENTITIES  operator emails only (recovery-plan approval; a person, never automation)
# Emails come from ACCESS_ALLOWED_EMAILS (comma/space separated, case-insensitive). The Client ID
# is normalised like access-headers.sh. Nothing secret is printed: a Client ID is an identifier.
#
# Usage: access-identities.sh [ENV_FILE]     Env: CF_ACCESS_CLIENT_ID, ACCESS_ALLOWED_EMAILS
# With ENV_FILE the lines are appended there and the Client ID is masked in the job log;
# without it they are printed to stdout.
set -euo pipefail

client_id="$(printf '%s' "${CF_ACCESS_CLIENT_ID:-}" | tr -d '\r\n' | sed -E 's/^[[:space:]]*(CF-Access-Client-Id:)?[[:space:]]*//I; s/[[:space:]]+$//')"
[[ -n "$client_id" ]] || { echo "::error::CF_ACCESS_CLIENT_ID is required" >&2; exit 1; }
[[ "$client_id" =~ ^[A-Za-z0-9._-]+$ && "$client_id" != cfast_* ]] || { echo "::error::CF_ACCESS_CLIENT_ID is not a Client ID" >&2; exit 1; }

emails=()
for e in $(printf '%s' "${ACCESS_ALLOWED_EMAILS:-}" | tr ',' ' '); do
  e="$(printf '%s' "$e" | tr '[:upper:]' '[:lower:]')"
  [[ "$e" =~ ^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$ ]] || { echo "::error::ACCESS_ALLOWED_EMAILS contains an invalid entry" >&2; exit 1; }
  [[ " ${emails[*]} " == *" $e "* ]] || emails+=("$e")
done
(( ${#emails[@]} > 0 )) || { echo "::error::ACCESS_ALLOWED_EMAILS must list at least one operator email" >&2; exit 1; }
if (( ${#emails[@]} < 2 )); then
  echo "::warning::Only one approver email: recovery plans it authors can never be approved (separation of duties)." >&2
fi

joined="$(IFS=,; printf '%s' "${emails[*]}")"
lines="$(printf 'OPERATOR_IDENTITIES=%s,%s\nAPPROVER_IDENTITIES=%s' "$client_id" "$joined" "$joined")"
if [[ -n "${1:-}" ]]; then
  echo "::add-mask::${client_id}"
  printf '%s\n' "$lines" >> "$1"
else
  printf '%s\n' "$lines"
fi
echo "Identity allow-lists: operators = CI service token + ${#emails[@]} email(s); approvers = ${#emails[@]} email(s)" >&2
