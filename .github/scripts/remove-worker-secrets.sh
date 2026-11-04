#!/usr/bin/env bash
# Idempotently delete retired secrets from a Worker. `wrangler deploy` never removes secrets,
# so a credential the code no longer reads would otherwise stay bound forever.
#
# Usage: remove-worker-secrets.sh SCRIPT_NAME SECRET_NAME...
# Env:   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
set -euo pipefail

script="${1:?usage: remove-worker-secrets.sh SCRIPT_NAME SECRET_NAME...}"; shift
(( $# > 0 )) || { echo "::error::no secret names given" >&2; exit 1; }
api_base="${CLOUDFLARE_API_BASE:-https://api.cloudflare.com/client/v4}"
base="${api_base}/accounts/${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}/workers/scripts/${script}"
auth="Authorization: Bearer ${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"

bindings="$(curl --fail --silent --show-error --proto '=https' --max-time 20 --header "$auth" "${base}/settings" | jq -c '[.result.bindings[].name]')"
for name in "$@"; do
  [[ "$name" =~ ^[A-Z][A-Z0-9_]*$ ]] || { echo "::error::invalid secret name" >&2; exit 1; }
  if printf '%s' "$bindings" | jq -e --arg n "$name" 'index($n) != null' >/dev/null; then
    curl --fail --silent --show-error --proto '=https' --max-time 20 --request DELETE --header "$auth" "${base}/secrets/${name}" \
      | jq -e '.success == true' >/dev/null
    echo "Removed ${name} from ${script}."
  else
    echo "${name} is not bound to ${script}."
  fi
done

if [[ "$script" == "cryptophys-ai-kernel" && "${VECTORIZE_INDEX_ENSURED:-}" != "1" && -z "${CLOUDFLARE_API_BASE:-}" ]]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -x "${script_dir}/ensure-vectorize-index.sh" ]]; then
    "${script_dir}/ensure-vectorize-index.sh"
  fi
fi
