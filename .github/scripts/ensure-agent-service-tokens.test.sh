#!/usr/bin/env bash
# Hermetic test for ensure-agent-service-tokens.sh verifying idempotent lookup, creation, and secret redaction.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
cat >"$tmp/bin/curl" <<'FAKE'
#!/usr/bin/env bash
method="GET"
for ((i=1; i<=$#; i++)); do
  arg="${!i}"
  if [[ "$arg" == "--request" ]]; then
    j=$((i + 1))
    method="${!j}"
  fi
done
if [[ "$method" == "POST" ]]; then
  echo '{"success":true,"result":{"id":"33333333-3333-3333-3333-333333333333","name":"cryptophys-agent-hud-prophet","client_id":"hud-prophet-client.access","client_secret":"SUPER_SECRET_NEVER_PRINT"}}'
else
  echo '{"success":true,"result_info":{"total_pages":1},"result":[
    {"id":"22222222-2222-2222-2222-222222222222","name":"cryptophys-agent-xauusd-analyst","client_id":"xauusd-analyst-client.access"}
  ]}'
fi
FAKE
chmod +x "$tmp/bin/curl"
chmod +x "$here/ensure-agent-service-tokens.sh"

out="$(PATH="$tmp/bin:$PATH" CLOUDFLARE_ACCOUNT_ID=a CLOUDFLARE_ACCESS_API_TOKEN=t CF_API_BASE=https://x "$here/ensure-agent-service-tokens.sh" xauusd-analyst hud-prophet)"
want='[{"agent_id":"xauusd-analyst","name":"cryptophys-agent-xauusd-analyst","id":"22222222-2222-2222-2222-222222222222","client_id":"xauusd-analyst-client.access","created":false},{"agent_id":"hud-prophet","name":"cryptophys-agent-hud-prophet","id":"33333333-3333-3333-3333-333333333333","client_id":"hud-prophet-client.access","created":true}]'
if [[ "$out" == *SUPER_SECRET* ]]; then
  echo "FAIL: client_secret leaked in output"
  exit 1
fi
if [[ "$out" == "$want" ]]; then
  echo "PASS: ensure-agent-service-tokens reuses existing token, creates missing token, and never outputs client_secret"
else
  echo "FAIL: got $out"
  exit 1
fi
