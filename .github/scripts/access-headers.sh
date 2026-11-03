#!/usr/bin/env bash
# Write Cloudflare Access service-token headers to FILE (mode 0600) for `curl --header @FILE`.
# Normalises the secrets the same way find-service-token.sh does: strips CR/LF, surrounding
# whitespace and an accidentally copied "CF-Access-Client-Id:" / "CF-Access-Client-Secret:"
# prefix. Values are never printed.
#
# Usage: access-headers.sh FILE      Env: CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
set -euo pipefail

file="${1:?usage: access-headers.sh FILE}"
: "${CF_ACCESS_CLIENT_ID:?CF_ACCESS_CLIENT_ID is required}"
: "${CF_ACCESS_CLIENT_SECRET:?CF_ACCESS_CLIENT_SECRET is required}"

clean() { # clean VALUE HEADER-NAME
  printf '%s' "$1" | tr -d '\r\n' | sed -E "s/^[[:space:]]*($2:)?[[:space:]]*//I; s/[[:space:]]+\$//"
}
id="$(clean "$CF_ACCESS_CLIENT_ID" "CF-Access-Client-Id")"
secret="$(clean "$CF_ACCESS_CLIENT_SECRET" "CF-Access-Client-Secret")"
[[ -n "$id" && -n "$secret" ]] || { echo "::error::Cloudflare Access service token values are empty" >&2; exit 1; }
[[ "$id" != cfast_* ]] || { echo "::error::CF_ACCESS_CLIENT_ID looks like a Client Secret; the two secrets appear swapped" >&2; exit 1; }

(umask 077; printf 'CF-Access-Client-Id: %s\nCF-Access-Client-Secret: %s\n' "$id" "$secret" > "$file")
