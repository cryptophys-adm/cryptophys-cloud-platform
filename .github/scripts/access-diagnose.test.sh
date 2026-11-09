#!/usr/bin/env bash
# Hermetic tests for access-diagnose.sh: a fake curl serves the Cloudflare API and the Forge. The
# diagnosis must name the cause and never print the Client ID or the secret.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
cat >"$tmp/bin/curl" <<'FAKE'
#!/usr/bin/env bash
url="${*: -1}"
case "$url" in
  *access/service_tokens*) cat "$FX/tokens.json" ;;
  *access/apps*) cat "$FX/apps.json" ;;
  *workers/subdomain) echo '{"success":true,"result":{"subdomain":"acme"}}' ;;
  https://cryptophys-forge.acme.workers.dev/health) printf '%s' "$FX_FORGE" ;;
  *) exit 22 ;;
esac
FAKE
chmod +x "$tmp/bin/curl"
export FX="$tmp"
tok="11111111-2222-4333-8444-555555555555"
secret="supersecretvalue0123456789abcdef0123456789abcdef0123456789abcdef"

passed=0; failed=0
run() { # NAME TOKENS_JSON APPS_JSON FORGE_CODE PATTERN...
  local name="$1"; echo "$2" >"$tmp/tokens.json"; echo "$3" >"$tmp/apps.json"; export FX_FORGE="$4"; shift 4
  PATH="$tmp/bin:$PATH" CLOUDFLARE_ACCOUNT_ID=a CLOUDFLARE_API_TOKEN=t CLOUDFLARE_ACCESS_API_TOKEN=t \
    CF_ACCESS_CLIENT_ID="abc123.access" CF_ACCESS_CLIENT_SECRET="$secret" GITHUB_STEP_SUMMARY=/dev/null \
    "$here/access-diagnose.sh" >"$tmp/out" 2>&1 || true
  local ok=1
  for p in "$@"; do grep -q -- "$p" "$tmp/out" || ok=0; done
  grep -q -e 'abc123' -e "$secret" "$tmp/out" && ok=0
  if (( ok )); then echo "ok   $name"; passed=$((passed + 1)); else echo "FAIL $name"; sed 's/^/    /' "$tmp/out"; failed=$((failed + 1)); fi
}

tokens_ok="{\"success\":true,\"result\":[{\"id\":\"$tok\",\"name\":\"cryptophys-ci\",\"client_id\":\"abc123.access\",\"expires_at\":\"2099-01-01T00:00:00Z\",\"updated_at\":\"2026-11-09T00:20:00Z\",\"last_seen_at\":\"2026-11-08T22:10:00Z\"}]}"
app_with="{\"success\":true,\"result\":[{\"name\":\"cryptophys-cloud-platform\",\"policies\":[{\"name\":\"ci-service-token\",\"decision\":\"non_identity\",\"include\":[{\"service_token\":{\"token_id\":\"$tok\"}}]}]}]}"
app_without='{"success":true,"result":[{"name":"cryptophys-cloud-platform","policies":[{"name":"ci-service-token","decision":"non_identity","include":[{"service_token":{"token_id":"99999999-0000-4000-8000-000000000000"}}]}]}]}'

run "rotated secret: token found, in the policy, Forge 302" "$tokens_ok" "$app_with" 302 "names token \*\*cryptophys-ci\*\*" "policy names the stored token: yes" "HTTP 302" "updated 2026-11-09T00:20:00Z"
run "re-created token: not in the policy" "$tokens_ok" "$app_without" 302 "does not name the stored token" "provision-access.yml"
run "deleted token: no match" '{"success":true,"result":[{"id":"x","name":"other","client_id":"zzz.access"}]}' "$app_with" 302 "No service token has the stored Client ID" "other"
run "expired token" "${tokens_ok//2099-01-01/2020-01-01}" "$app_with" 302 "token has expired"
run "secret shape only" "$tokens_ok" "$app_with" 200 "Stored CF_ACCESS_CLIENT_SECRET: length 64" "HTTP 200"

echo "access-diagnose: ${passed} passed, ${failed} failed"
(( failed == 0 ))
