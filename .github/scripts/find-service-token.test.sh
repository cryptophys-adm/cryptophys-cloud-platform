#!/usr/bin/env bash
# Hermetic tests for find-service-token.sh (fake curl serving two pages of tokens).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"

cat >"$tmp/bin/curl" <<'FAKE'
#!/usr/bin/env bash
url="${*: -1}"
case "$url" in
  *page=1) cat "$FX/page1.json" ;;
  *page=2) cat "$FX/page2.json" ;;
  *) exit 22 ;;
esac
FAKE
chmod +x "$tmp/bin/curl"
export FX="$tmp"

uuid="5f1c1a2e-1111-4222-8333-944455556666"
echo '{"success":true,"result_info":{"total_pages":2},"result":[{"id":"aaaaaaaa-0000-4000-8000-000000000001","name":"other","client_id":"zzz.access","expires_at":"2027-01-01T00:00:00Z"}]}' >"$tmp/page1.json"
echo "{\"success\":true,\"result_info\":{\"total_pages\":2},\"result\":[{\"id\":\"$uuid\",\"name\":\"cryptophys-ci\",\"client_id\":\"abc123.access\",\"expires_at\":\"2027-11-03T00:00:00Z\"}]}" >"$tmp/page2.json"

passed=0; failed=0
run() { # run EXPECT(pass|fail) NAME CLIENT_ID [grep]
  local want="$1" name="$2" value="$3" pattern="${4:-}" got=pass
  PATH="$tmp/bin:$PATH" CLOUDFLARE_ACCOUNT_ID=a CLOUDFLARE_ACCESS_API_TOKEN=t CF_ACCESS_CLIENT_ID="$value" \
    "$here/find-service-token.sh" >"$tmp/out" 2>"$tmp/err" || got=fail
  if [[ "$got" == "$want" ]] && { [[ -z "$pattern" ]] || grep -q -- "$pattern" "$tmp/out" "$tmp/err"; } \
     && ! grep -q 'abc123' "$tmp/err"; then
    echo "ok   $name"; passed=$((passed + 1))
  else
    echo "FAIL $name (want $want, got $got)"; sed 's/^/    /' "$tmp/out" "$tmp/err"; failed=$((failed + 1))
  fi
}

run pass "exact Client ID on the second page" "abc123.access" "$uuid"
run pass "surrounding whitespace and CRLF are ignored" $'  abc123.access\r\n' "$uuid"
run pass "copied header prefix is ignored" "CF-Access-Client-Id: abc123.access" "$uuid"
run pass "missing .access suffix still matches, with a note" "abc123" "without the .access suffix"
run pass "token UUID matches, with a note to store the Client ID" "$uuid" "store the Client ID instead"
run fail "unknown Client ID fails and lists visible token names" "nope.access" "cryptophys-ci (expires"
run fail "a Client SECRET pasted as the ID is diagnosed" "cfast_0123456789abcdef" "secrets may be swapped"

echo "passed=$passed failed=$failed"
[[ "$failed" -eq 0 ]]
