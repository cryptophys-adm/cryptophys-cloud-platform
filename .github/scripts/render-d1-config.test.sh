#!/usr/bin/env bash
# Hermetic tests for render-d1-config.sh with a fake curl on PATH.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/w1" "$tmp/w2"
id="3f62fa1a-0000-4000-8000-000000000001"

cat >"$tmp/bin/curl" <<'FAKE'
#!/usr/bin/env bash
out=/dev/stdout; fmt=""
while [[ $# -gt 0 ]]; do
  case "$1" in --output) out="$2"; shift 2 ;; --write-out) fmt="$2"; shift 2 ;; *) shift ;; esac
done
cat "$FAKE_RESPONSE" >"$out"
[[ -z "$fmt" ]] || cat "${FAKE_RESPONSE}.status" 2>/dev/null || printf 200
FAKE
chmod +x "$tmp/bin/curl"

config='name = "x"
[[d1_databases]]
binding = "DB"
database_name = "cryptophys-control-plane"
database_id = "__CONTROL_PLANE_D1_DATABASE_ID__"'
printf '%s\n' "$config" >"$tmp/w1/wrangler.toml"
printf '%s\n' "$config" >"$tmp/w2/wrangler.toml"

run() {
  PATH="$tmp/bin:$PATH" FAKE_RESPONSE="$tmp/response.json" GITHUB_ACTIONS="" \
    CLOUDFLARE_ACCOUNT_ID=acct CLOUDFLARE_API_TOKEN=token D1_DATABASE_NAME=cryptophys-control-plane \
    "$here/render-d1-config.sh" "$@" >"$tmp/out" 2>&1
}
passed=0; failed=0
ok() { echo "ok   $1"; passed=$((passed + 1)); }
bad() { echo "FAIL $1"; sed 's/^/    /' "$tmp/out"; failed=$((failed + 1)); }

printf '{"success":true,"result":[{"name":"cryptophys-control-plane","uuid":"%s"},{"name":"other","uuid":"x"}]}' "$id" >"$tmp/response.json"
if run "$tmp/w1" "$tmp/w2" && grep -q "database_id = \"$id\"" "$tmp/w1/wrangler.deploy.toml" \
  && grep -q "database_id = \"$id\"" "$tmp/w2/wrangler.deploy.toml" && ! grep -q "$id" "$tmp/out" \
  && grep -q '__CONTROL_PLANE_D1_DATABASE_ID__' "$tmp/w1/wrangler.toml"; then
  ok "renders every config, leaves sources untouched, never prints the id"
else bad "renders every config"; fi

printf '{"success":true,"result":[{"name":"cryptophys-control-plane","uuid":"%s"},{"name":"cryptophys-control-plane","uuid":"%s"}]}' "$id" "$id" >"$tmp/response.json"
if run "$tmp/w1"; then bad "ambiguous name must fail"; else ok "ambiguous database name fails"; fi

printf '{"success":true,"result":[]}' >"$tmp/response.json"
if run "$tmp/w1"; then bad "missing database must fail"; else ok "missing database fails"; fi

printf '{"success":false,"result":null}' >"$tmp/response.json"
if run "$tmp/w1"; then bad "API failure must fail"; else ok "API failure fails"; fi

printf '{"success":true,"result":[{"name":"cryptophys-control-plane","uuid":"%s"}]}' "$id" >"$tmp/response.json"
printf 'name = "x"\n' >"$tmp/w2/wrangler.toml"
if run "$tmp/w2"; then bad "config without placeholder must fail"; else ok "config without placeholder fails"; fi

printf '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}' >"$tmp/response.json"; printf 401 >"$tmp/response.json.status"
if run "$tmp/w1"; then bad "HTTP 401 must fail"; elif grep -q 'HTTP 401.*Authentication error.*D1 > Edit' "$tmp/out"; then ok "HTTP 401 explains the missing D1 permission"; else bad "401 diagnosis"; fi
rm -f "$tmp/response.json.status"

echo "passed=$passed failed=$failed"
[[ "$failed" -eq 0 ]]
