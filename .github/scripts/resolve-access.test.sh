#!/usr/bin/env bash
# Hermetic tests for resolve-access.sh with a fake curl routing by URL path.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
aud="$(printf 'a%.0s' $(seq 1 64))"

cat >"$tmp/bin/curl" <<'FAKE'
#!/usr/bin/env bash
url="${*: -1}"
case "$url" in
  */access/organizations) cat "$FX/org.json" ;;
  */access/apps*) cat "$FX/apps.json" ;;
  */workers/scripts) cat "$FX/scripts.json" ;;
  *) exit 22 ;;
esac
FAKE
chmod +x "$tmp/bin/curl"

export FX="$tmp"
echo '{"success":true,"result":{"auth_domain":"cryptophys.cloudflareaccess.com"}}' >"$tmp/org.json"
echo '{"success":true,"result":[{"id":"cryptophys-platform-api","tag":"t1"},{"id":"cryptophys-audit-ledger","tag":"t2"}]}' >"$tmp/scripts.json"
app() { printf '{"success":true,"result":[%s]}' "$1" >"$tmp/apps.json"; }
good="{\"name\":\"cryptophys-cloud-platform\",\"aud\":\"$aud\",\"destinations\":[{\"type\":\"worker\",\"worker_id\":\"t1\"},{\"type\":\"worker\",\"worker_id\":\"t2\"}]}"

run() {
  : >"$tmp/github_env"
  PATH="$tmp/bin:$PATH" GITHUB_ENV="$tmp/github_env" CLOUDFLARE_ACCOUNT_ID=acct CLOUDFLARE_ACCESS_API_TOKEN=tok \
    ACCESS_APP_NAME=cryptophys-cloud-platform EXPECTED_WORKERS="cryptophys-platform-api cryptophys-audit-ledger" \
    "$here/resolve-access.sh" >"$tmp/out" 2>&1
}
passed=0; failed=0
check() { if "$@"; then echo "ok   $name"; passed=$((passed + 1)); else echo "FAIL $name"; sed 's/^/    /' "$tmp/out"; failed=$((failed + 1)); fi; }

name="exports team domain and AUD when every Worker is protected"
app "$good"
run && check grep -q "ACCESS_AUD=$aud" "$tmp/github_env"
name="team domain exported"; check grep -q "ACCESS_TEAM_DOMAIN=cryptophys.cloudflareaccess.com" "$tmp/github_env"

name="fails when a Worker is not a destination"
app "{\"name\":\"cryptophys-cloud-platform\",\"aud\":\"$aud\",\"destinations\":[{\"type\":\"worker\",\"worker_id\":\"t1\"}]}"
check bash -c "! PATH='$tmp/bin:$PATH' GITHUB_ENV=/dev/null CLOUDFLARE_ACCOUNT_ID=a CLOUDFLARE_ACCESS_API_TOKEN=t ACCESS_APP_NAME=cryptophys-cloud-platform EXPECTED_WORKERS='cryptophys-platform-api cryptophys-audit-ledger' '$here/resolve-access.sh' >/dev/null 2>&1"

name="fails when the application is missing"; app ""
check bash -c "! PATH='$tmp/bin:$PATH' GITHUB_ENV=/dev/null CLOUDFLARE_ACCOUNT_ID=a CLOUDFLARE_ACCESS_API_TOKEN=t ACCESS_APP_NAME=cryptophys-cloud-platform '$here/resolve-access.sh' >/dev/null 2>&1"

name="fails when the application is ambiguous"; app "$good,$good"
check bash -c "! PATH='$tmp/bin:$PATH' GITHUB_ENV=/dev/null CLOUDFLARE_ACCOUNT_ID=a CLOUDFLARE_ACCESS_API_TOKEN=t ACCESS_APP_NAME=cryptophys-cloud-platform '$here/resolve-access.sh' >/dev/null 2>&1"

name="fails on a malformed AUD"; app '{"name":"cryptophys-cloud-platform","aud":"short","destinations":[]}'
check bash -c "! PATH='$tmp/bin:$PATH' GITHUB_ENV=/dev/null CLOUDFLARE_ACCOUNT_ID=a CLOUDFLARE_ACCESS_API_TOKEN=t ACCESS_APP_NAME=cryptophys-cloud-platform '$here/resolve-access.sh' >/dev/null 2>&1"

name="fails on a foreign team domain"; app "$good"
echo '{"success":true,"result":{"auth_domain":"evil.example.com"}}' >"$tmp/org.json"
check bash -c "! PATH='$tmp/bin:$PATH' GITHUB_ENV=/dev/null CLOUDFLARE_ACCOUNT_ID=a CLOUDFLARE_ACCESS_API_TOKEN=t ACCESS_APP_NAME=cryptophys-cloud-platform '$here/resolve-access.sh' >/dev/null 2>&1"

echo "passed=$passed failed=$failed"
[[ "$failed" -eq 0 ]]
