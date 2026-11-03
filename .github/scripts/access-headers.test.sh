#!/usr/bin/env bash
# Hermetic tests for Cloudflare Access service-token header normalisation.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

export CF_ACCESS_CLIENT_ID=$'  CF-Access-Client-Id: abc123.access  \r\n'
export CF_ACCESS_CLIENT_SECRET=$'  CF-Access-Client-Secret: secret-value  \r\n'
"$here/access-headers.sh" "$tmp/headers"

expected="$(printf 'CF-Access-Client-Id: abc123.access\nCF-Access-Client-Secret: secret-value')"
actual="$(cat "$tmp/headers")"
[[ "$actual" == "$expected" ]] || { echo "::error::header values were not fully normalised" >&2; exit 1; }
[[ "$(stat -c '%a' "$tmp/headers")" == "600" ]] || { echo "::error::header file is not mode 0600" >&2; exit 1; }

if CF_ACCESS_CLIENT_ID='cfast_swapped-secret' CF_ACCESS_CLIENT_SECRET='secret-value' \
  "$here/access-headers.sh" "$tmp/swapped" >/dev/null 2>&1; then
  echo "::error::a Client Secret was accepted as the Client ID" >&2
  exit 1
fi

echo "passed=3 failed=0"
