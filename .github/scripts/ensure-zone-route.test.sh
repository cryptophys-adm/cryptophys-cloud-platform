#!/usr/bin/env bash
# Hermetic test for ensure-zone-route.sh with a fake curl keeping routes in a file.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
export FX="$tmp" TOKEN="tok-never-printed"
echo '[]' >"$tmp/routes.json"
mkdir -p "$tmp/bin"
cat >"$tmp/bin/curl" <<'FAKE'
#!/usr/bin/env bash
method=GET; data=""; auth=""; url=""
while [[ $# -gt 0 ]]; do case "$1" in --request) method="$2"; shift 2;; --data) data="$2"; shift 2;; --header) [[ "$2" == Authorization:* ]] && auth="$2"; shift 2;; --max-time|--retry|--retry-delay|--proto) shift 2;; -*) shift;; *) url="$1"; shift;; esac; done
[[ "$auth" == "Authorization: Bearer $TOKEN" ]] || { echo '{"success":false,"errors":[{"message":"auth"}]}'; exit 0; }
case "$method $url" in
  "GET "*"/zones?name=cryptophys.work") echo '{"success":true,"result":[{"id":"z1"}]}' ;;
  "GET "*"/zones/z1/workers/routes") jq -c '{success: true, result: .}' "$FX/routes.json" ;;
  "POST "*"/zones/z1/workers/routes") jq -c --argjson b "$data" '. + [$b + {id: "r1"}]' "$FX/routes.json" >"$FX/n" && mv "$FX/n" "$FX/routes.json"; echo '{"success":true}'; echo POST >>"$FX/calls" ;;
  "PUT "*"/zones/z1/workers/routes/r1") jq -c --argjson b "$data" 'map(if .id == "r1" then $b + {id: "r1"} else . end)' "$FX/routes.json" >"$FX/n" && mv "$FX/n" "$FX/routes.json"; echo '{"success":true}'; echo PUT >>"$FX/calls" ;;
  *) echo '{"success":false}' ;;
esac
FAKE
chmod +x "$tmp/bin/curl"
run() { PATH="$tmp/bin:$PATH" CLOUDFLARE_ACCESS_API_TOKEN="$TOKEN" ZONE_NAME=cryptophys.work ROUTE_PATTERN='nexus.cryptophys.work/console*' SCRIPT="${1:-cryptophys-console}" CF_API_BASE=https://api.test bash "$here/ensure-zone-route.sh"; }
out="$(run)"; [[ "$out" == *created* && "$out" != *"$TOKEN"* ]] || { echo "FAIL create: $out"; exit 1; }
out="$(run)"; [[ "$out" == *"already points"* ]] || { echo "FAIL idempotent: $out"; exit 1; }
out="$(run other-worker)"; [[ "$out" == *updated* ]] || { echo "FAIL update: $out"; exit 1; }
[[ "$(grep -c . "$tmp/calls")" == "2" ]] || { echo "FAIL calls"; exit 1; }
if PATH="$tmp/bin:$PATH" CLOUDFLARE_ACCESS_API_TOKEN=wrong ZONE_NAME=cryptophys.work ROUTE_PATTERN='nexus.cryptophys.work/console*' SCRIPT=x CF_API_BASE=https://api.test bash "$here/ensure-zone-route.sh" >/dev/null 2>&1; then echo "FAIL bad token accepted"; exit 1; fi
echo "ensure-zone-route.sh: all tests passed"
