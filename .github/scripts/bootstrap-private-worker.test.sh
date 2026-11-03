#!/usr/bin/env bash
# Hermetic tests for bootstrap-private-worker.sh with a fake curl on PATH.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"
cat > "$tmp/bin/curl" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CURL_LOG"
case "$*" in
  *"--request PUT"*) echo '{"success":true}' ;;
  *"/subdomain"*) echo '{"success":true}' ;;
  *) echo '{"success":true,"result":[{"id":"cryptophys-audit-ledger"}]}' ;;
esac
SH
chmod +x "$tmp/bin/curl"
export PATH="$tmp/bin:$PATH" CURL_LOG="$tmp/log" CLOUDFLARE_ACCOUNT_ID=acct CLOUDFLARE_API_TOKEN=t
fail=0

"$here/bootstrap-private-worker.sh" cryptophys-audit-ledger cryptophys-signal-engine >/dev/null
puts="$(grep -c -- '--request PUT' "$tmp/log" || true)"
[[ "$puts" == "1" ]] || { echo "::error::expected exactly one upload, got ${puts}" >&2; fail=$((fail + 1)); }
grep -q -- '--request PUT.*/scripts/cryptophys-signal-engine$' "$tmp/log" || { echo "::error::the missing Worker was not uploaded" >&2; fail=$((fail + 1)); }
grep -q -- '"enabled":false,"previews_enabled":false.*/scripts/cryptophys-signal-engine/subdomain' "$tmp/log" \
  || { echo "::error::workers.dev was not disabled for the stub" >&2; fail=$((fail + 1)); }
! grep -q 'cryptophys-audit-ledger$' <(grep -- '--request PUT' "$tmp/log") || { echo "::error::an existing Worker was overwritten" >&2; fail=$((fail + 1)); }

if "$here/bootstrap-private-worker.sh" xauusd-ai-trading-assistant >/dev/null 2>&1; then
  echo "::error::a non-platform Worker name was accepted" >&2; fail=$((fail + 1))
fi

(( fail == 0 )) || exit 1
echo "passed=5 failed=0"
