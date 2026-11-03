#!/usr/bin/env bash
# Hermetic tests for verify-worker-live.sh. A fake `curl` on PATH serves
# fixture responses keyed by URL, so no network or credentials are used.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
subject="$here/verify-worker-live.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

sha="0123456789abcdef0123456789abcdef01234567"
other_sha="fedcba9876543210fedcba9876543210fedcba98"
account="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
token="test-token-must-never-be-printed"
health_filter='.status == "ok" and .service == "svc"'
ready_filter='.status == "ready" and .service == "svc"'

mkdir -p "$tmp/bin"
cat >"$tmp/bin/curl" <<'FAKE'
#!/usr/bin/env bash
# Minimal curl stand-in: honours --output/--write-out and the URL argument.
out=/dev/stdout; fmt=""; url=""; auth=""; headers=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) out="$2"; shift 2 ;;
    --write-out) fmt="$2"; shift 2 ;;
    --header)
      if [[ "$2" == @* ]]; then headers+="$(cat "${2#@}")"$'\n'; else auth="$2"; headers+="$2"$'\n'; fi
      shift 2 ;;
    --max-time|--retry|--retry-delay|--proto) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  https://api.cloudflare.test/*)
    [[ "$auth" == "Authorization: Bearer $EXPECTED_TOKEN" ]] || { echo '{"success":false}' >"$out"; printf 403; exit 0; } ;;
  https://*)
    [[ -z "$auth" ]] || { echo "credential leaked to $url" >&2; exit 99; }
    [[ "$headers" != *"$EXPECTED_TOKEN"* ]] || { echo "API token leaked to $url" >&2; exit 99; }
    if [[ "${FAKE_ACCESS:-0}" == 1 && "$url" == *workers.dev* ]] && \
       [[ "$headers" != *"CF-Access-Client-Id: $ACCESS_ID"* || "$headers" != *"CF-Access-Client-Secret: $ACCESS_SECRET"* ]]; then
      : >"$out"; [[ -n "$fmt" ]] && printf 302; exit 0
    fi ;;
esac
key="$(printf '%s' "$url" | sed -E 's#^https://##; s#[^A-Za-z0-9]+#_#g')"
fixture="$FIXTURES/$key"
if [[ -f "$fixture.err" ]]; then cat "$fixture.err" >&2; exit 60; fi
if [[ ! -f "$fixture" ]]; then echo '{"success":false,"errors":[{"code":404,"message":"no fixture"}]}' >"$out"; [[ -n "$fmt" ]] && printf 404; exit 0; fi
cat "$fixture" >"$out"
[[ -n "$fmt" ]] && printf '%s' "$(cat "$fixture.status" 2>/dev/null || echo 200)"
exit 0
FAKE
chmod +x "$tmp/bin/curl"

fx() { # fx URL BODY [STATUS]
  local key; key="$(printf '%s' "$1" | sed -E 's#^https://##; s#[^A-Za-z0-9]+#_#g')"
  printf '%s' "$2" >"$FIXTURES/$key"
  [[ -z "${3:-}" ]] || printf '%s' "$3" >"$FIXTURES/$key.status"
}

api="https://api.cloudflare.test/client/v4/accounts/$account/workers"
base="https://svc.acme.workers.dev"

setup_green() {
  export FIXTURES="$tmp/fx-$1"; rm -rf "$FIXTURES"; mkdir -p "$FIXTURES"
  fx "$api/subdomain" '{"success":true,"result":{"subdomain":"acme"}}'
  fx "$api/scripts/svc/subdomain" '{"success":true,"result":{"enabled":true}}'
  fx "$api/scripts/svc/deployments" '{"success":true,"result":{"deployments":[{"versions":[{"version_id":"v1","percentage":100}]}]}}'
  fx "$api/scripts/svc/versions/v1" "{\"success\":true,\"result\":{\"id\":\"v1\",\"annotations\":{\"workers/message\":\"commit $sha\"}}}"
  fx "$base/health" '{"status":"ok","service":"svc"}'
  fx "$base/ready" '{"status":"ready","service":"svc"}'
}

access_id="client-id.access"
access_secret="cfast_access-secret-must-never-be-printed"

run_subject() {
  PATH="$tmp/bin:$PATH" EXPECTED_TOKEN="$token" ACCESS_ID="$access_id" ACCESS_SECRET="$access_secret" \
    CLOUDFLARE_ACCOUNT_ID="$account" CLOUDFLARE_API_TOKEN="$token" \
    CF_API_BASE="https://api.cloudflare.test/client/v4" \
    VERIFY_ATTEMPTS=2 VERIFY_DELAY_SECONDS=0 \
    "$subject" --script svc --commit "$sha" \
      --health-filter "$health_filter" --ready-filter "$ready_filter" "$@" >"$tmp/out" 2>&1
}

passed=0; failed=0
expect() { # expect pass|fail NAME [grep-pattern]
  local want="$1" name="$2" pattern="${3:-}" got=pass
  run_subject "${extra_args[@]}" || got=fail
  if grep -qE "$token|$access_secret" "$tmp/out"; then echo "FAIL $name: secret printed"; failed=$((failed+1)); return; fi
  if [[ "$got" != "$want" ]] || { [[ -n "$pattern" ]] && ! grep -q -- "$pattern" "$tmp/out"; }; then
    echo "FAIL $name (wanted $want, got $got)"; sed 's/^/    /' "$tmp/out"; failed=$((failed+1))
  else
    echo "ok   $name"; passed=$((passed+1))
  fi
}
extra_args=()

setup_green green; expect pass "healthy worker passes" "Live verification passed"

setup_green bad-subdomain-api
fx "$api/subdomain" '{"success":false,"errors":[{"code":10000,"message":"Authentication error"}]}' 403
expect fail "subdomain API HTTP error fails" "HTTP 403"

setup_green missing-subdomain
fx "$api/subdomain" '{"success":true,"result":{}}'
expect fail "missing subdomain fails" "valid workers.dev account subdomain"

setup_green injected-subdomain
fx "$api/subdomain" '{"success":true,"result":{"subdomain":"evil.com/x"}}'
expect fail "malformed subdomain is rejected" "valid workers.dev account subdomain"

setup_green route-disabled
fx "$api/scripts/svc/subdomain" '{"success":true,"result":{"enabled":false}}'
expect fail "disabled workers.dev route fails" "not enabled"

setup_green split-traffic
fx "$api/scripts/svc/deployments" '{"success":true,"result":{"deployments":[{"versions":[{"version_id":"v1","percentage":50},{"version_id":"v0","percentage":50}]}]}}'
expect fail "split deployment fails" "single version at 100%"

setup_green stale-version
fx "$api/scripts/svc/versions/v1" "{\"success\":true,\"result\":{\"id\":\"v1\",\"annotations\":{\"workers/message\":\"commit $other_sha\"}}}"
expect fail "version for another commit fails" "not annotated with commit"

setup_green health-500
fx "$base/health" '{"status":"error"}' 500
expect fail "health HTTP 500 fails" "health check failed"

setup_green health-contract
fx "$base/health" '{"status":"ok","service":"wrong"}'
expect fail "health contract mismatch fails" "health check failed"

setup_green ready-503
fx "$base/ready" '{"status":"not_configured","service":"svc"}' 503
expect fail "readiness 503 fails" "readiness check failed"

setup_green ready-not-json
fx "$base/ready" '<html>oops</html>'
expect fail "non-JSON readiness fails" "readiness check failed"

setup_green custom-domain-tls
key="$(printf '%s' "https://custom.example.test/health" | sed -E 's#^https://##; s#[^A-Za-z0-9]+#_#g')"
echo "curl: (60) SSL: no alternative certificate subject name matches target hostname" >"$FIXTURES/$key.err"
fx "$api/domains?service=svc" '{"success":true,"result":[{"hostname":"custom.example.test","zone_name":"example.test","environment":"production"}]}'
extra_args=(--custom-domain custom.example.test)
expect pass "custom-domain TLS failure is a warning, not a pass-through" "::warning::Custom domain custom.example.test failed TLS-verified request"
extra_args=()

setup_green access-ok
export FAKE_ACCESS=1 CF_ACCESS_CLIENT_ID="$access_id" CF_ACCESS_CLIENT_SECRET="$access_secret"
extra_args=(--require-access)
expect pass "Access-protected worker verifies with the service token" "Cloudflare Access rejects unauthenticated requests"
unset CF_ACCESS_CLIENT_SECRET
expect fail "only one Access credential set fails" "Set both"
unset CF_ACCESS_CLIENT_ID
expect fail "--require-access without a service token fails" "needs CF_ACCESS_CLIENT_ID"
export FAKE_ACCESS=0 CF_ACCESS_CLIENT_ID="$access_id" CF_ACCESS_CLIENT_SECRET="$access_secret"
expect fail "worker that answers without credentials is not accepted as protected" "not protected by Cloudflare Access"
export FAKE_ACCESS=1 CF_ACCESS_CLIENT_SECRET="wrong-secret"
expect fail "wrong Access secret cannot reach health" "health check failed"
unset FAKE_ACCESS CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET
extra_args=()

if FIXTURES="$tmp/none" PATH="$tmp/bin:$PATH" CLOUDFLARE_ACCOUNT_ID="$account" CLOUDFLARE_API_TOKEN="" \
  "$subject" --script svc --commit "$sha" --health-filter . --ready-filter . >"$tmp/out" 2>&1; then
  echo "FAIL empty token accepted"; failed=$((failed+1))
else
  echo "ok   empty token rejected"; passed=$((passed+1))
fi

if PATH="$tmp/bin:$PATH" CLOUDFLARE_ACCOUNT_ID="$account" CLOUDFLARE_API_TOKEN="$token" \
  "$subject" --script svc --commit "abc" --health-filter . --ready-filter . >"$tmp/out" 2>&1; then
  echo "FAIL short SHA accepted"; failed=$((failed+1))
else
  echo "ok   short SHA rejected"; passed=$((passed+1))
fi

echo "passed=$passed failed=$failed"
[[ "$failed" -eq 0 ]]
