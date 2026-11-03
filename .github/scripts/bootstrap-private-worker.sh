#!/usr/bin/env bash
# Create a platform Worker that does not exist yet as a private, inert stub, so Cloudflare
# Access can protect it (Access destinations name an existing Worker) before any real code
# is deployed. The stub answers every request with 503 and has workers.dev and preview URLs
# disabled; the next deploy replaces it. An existing Worker is never touched.
#
# Usage: bootstrap-private-worker.sh NAME...
# Env:   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (Workers Scripts: Edit)
set -euo pipefail

(( $# > 0 )) || { echo "usage: bootstrap-private-worker.sh NAME..." >&2; exit 1; }
api_base="${CLOUDFLARE_API_BASE:-https://api.cloudflare.com/client/v4}"
base="${api_base}/accounts/${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}/workers/scripts"
auth="Authorization: Bearer ${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

cat > "$tmp/stub.mjs" <<'JS'
export default {
  fetch() {
    return new Response('{"error":"not_deployed"}', { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  },
};
JS
printf '%s' '{"main_module":"stub.mjs","compatibility_date":"2026-11-01"}' > "$tmp/metadata.json"

existing="$(curl --fail --silent --show-error --proto '=https' --max-time 30 --header "$auth" "$base" | jq -c '[.result[].id]')"
for name in "$@"; do
  [[ "$name" =~ ^cryptophys-[a-z0-9-]+$ ]] || { echo "::error::refusing to bootstrap ${name}: not a platform Worker name" >&2; exit 1; }
  if jq -e --arg n "$name" 'index($n) != null' <<<"$existing" >/dev/null; then
    echo "${name} exists; not touched."
    continue
  fi
  curl --fail --silent --show-error --proto '=https' --max-time 60 --request PUT --header "$auth" \
    --form "metadata=@$tmp/metadata.json;type=application/json" \
    --form "stub.mjs=@$tmp/stub.mjs;type=application/javascript+module" \
    "${base}/${name}" | jq -e '.success == true' >/dev/null
  curl --fail --silent --show-error --proto '=https' --max-time 30 --request POST --header "$auth" \
    --header "Content-Type: application/json" --data '{"enabled":false,"previews_enabled":false}' \
    "${base}/${name}/subdomain" | jq -e '.success == true' >/dev/null
  echo "Bootstrapped ${name} as a private 503 stub (workers.dev disabled)."
done
