#!/usr/bin/env bash
# Hermetic test for find-agent-service-tokens.sh with a fake curl serving two pages.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
cat >"$tmp/bin/curl" <<'FAKE'
#!/usr/bin/env bash
for a in "$@"; do url="$a"; done
case "$url" in
  *page=1) echo '{"success":true,"result_info":{"total_pages":2},"result":[
    {"id":"11111111-1111-1111-1111-111111111111","name":"cryptophys-ci"},
    {"id":"22222222-2222-2222-2222-222222222222","name":"cryptophys-agent-external-observer"},
    {"id":"not-a-uuid","name":"cryptophys-agent-bad"}]}' ;;
  *page=2) echo '{"success":true,"result_info":{"total_pages":2},"result":[
    {"id":"33333333-3333-3333-3333-333333333333","name":"cryptophys-agent-ide"},
    {"id":"44444444-4444-4444-4444-444444444444","name":"other-agent-x"}]}' ;;
esac
FAKE
chmod +x "$tmp/bin/curl"
out="$(PATH="$tmp/bin:$PATH" CLOUDFLARE_ACCOUNT_ID=a CLOUDFLARE_ACCESS_API_TOKEN=t CF_API_BASE=https://x "$here/find-agent-service-tokens.sh")"
want='["22222222-2222-2222-2222-222222222222","33333333-3333-3333-3333-333333333333"]'
if [[ "$out" == "$want" ]]; then echo "PASS: only cryptophys-agent-* tokens with valid ids, across pages"; else echo "FAIL: got $out"; exit 1; fi
