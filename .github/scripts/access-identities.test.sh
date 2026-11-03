#!/usr/bin/env bash
# Hermetic tests for the Access identity allow-list builder.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail=0
expect() { # expect NAME EXPECTED ACTUAL
  if [[ "$2" != "$3" ]]; then echo "::error::$1: expected [$2] got [$3]" >&2; fail=$((fail + 1)); fi
}

out="$(CF_ACCESS_CLIENT_ID=$' CF-Access-Client-Id: abc123.access \r\n' ACCESS_ALLOWED_EMAILS=' Ops@Example.com, second@example.com ops@example.com' "$here/access-identities.sh" 2>/dev/null)"
expect "normalised lists" $'OPERATOR_IDENTITIES=abc123.access,ops@example.com,second@example.com\nAPPROVER_IDENTITIES=ops@example.com,second@example.com' "$out"

warn="$(CF_ACCESS_CLIENT_ID=abc.access ACCESS_ALLOWED_EMAILS=one@example.com "$here/access-identities.sh" 2>&1 >/dev/null)"
[[ "$warn" == *"separation of duties"* ]] || { echo "::error::single approver did not warn" >&2; fail=$((fail + 1)); }

envfile="$(mktemp)"; trap 'rm -f "$envfile"' EXIT
masked="$(CF_ACCESS_CLIENT_ID=abc.access ACCESS_ALLOWED_EMAILS=a@example.com,b@example.com "$here/access-identities.sh" "$envfile" 2>/dev/null)"
expect "client id masked" "::add-mask::abc.access" "$masked"
expect "env file" $'OPERATOR_IDENTITIES=abc.access,a@example.com,b@example.com\nAPPROVER_IDENTITIES=a@example.com,b@example.com' "$(cat "$envfile")"

refuse() { # refuse NAME ID EMAILS
  if CF_ACCESS_CLIENT_ID="$2" ACCESS_ALLOWED_EMAILS="$3" "$here/access-identities.sh" >/dev/null 2>&1; then
    echo "::error::$1 was accepted" >&2; fail=$((fail + 1))
  fi
}
refuse "missing client id" "" "a@example.com"
refuse "client secret as id" "cfast_abc" "a@example.com"
refuse "no emails" "abc.access" " , "
refuse "invalid email" "abc.access" "a@example.com,not-an-email"
refuse "comma injection" "abc.access" "a@example.com=x"

(( fail == 0 )) || exit 1
echo "passed=9 failed=0"
