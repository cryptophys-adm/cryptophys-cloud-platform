#!/usr/bin/env bash
# Verify a production Cloudflare Worker after `wrangler deploy`.
#
# Checks, in order, and fails closed on any of them:
#   1. The account workers.dev subdomain resolves through the Cloudflare API.
#   2. The Worker's workers.dev route is enabled.
#   3. The active deployment serves exactly one version at 100% and that
#      version is annotated with the expected commit SHA (wrangler --tag/--message).
#   4. GET /health and GET /ready on https://<script>.<subdomain>.workers.dev
#      return HTTP 200 and JSON that satisfies the supplied jq contract filters.
#
# TLS verification is always on. Credentials are read from the environment and
# are only ever sent in an Authorization header; they are never printed.
#
# Required environment: CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
# Optional environment: VERIFY_ATTEMPTS (default 10), VERIFY_DELAY_SECONDS (default 3),
#                       CF_API_BASE (default https://api.cloudflare.com/client/v4)
#
# Usage:
#   verify-worker-live.sh --script NAME --commit SHA \
#     --health-filter JQ --ready-filter JQ [--custom-domain HOSTNAME]
#
# --custom-domain is advisory: it is probed with full TLS verification and its
# Cloudflare registration is reported, but a failure there is surfaced as a
# workflow warning rather than masking the result of the deployed Worker itself.
set -euo pipefail

script_name=""
commit_sha=""
health_filter=""
ready_filter=""
custom_domain=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --script) script_name="${2:-}"; shift 2 ;;
    --commit) commit_sha="${2:-}"; shift 2 ;;
    --health-filter) health_filter="${2:-}"; shift 2 ;;
    --ready-filter) ready_filter="${2:-}"; shift 2 ;;
    --custom-domain) custom_domain="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

fail() { echo "::error::$*" >&2; exit 1; }

[[ "$script_name" =~ ^[a-z0-9][a-z0-9-]*$ ]] || fail "--script must be a Worker script name"
[[ "$commit_sha" =~ ^[0-9a-f]{40}$ ]] || fail "--commit must be a full lowercase 40-character SHA"
[[ -n "$health_filter" ]] || fail "--health-filter is required"
[[ -n "$ready_filter" ]] || fail "--ready-filter is required"
[[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] || fail "CLOUDFLARE_ACCOUNT_ID is not set"
[[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || fail "CLOUDFLARE_API_TOKEN is not set"
[[ "$CLOUDFLARE_ACCOUNT_ID" =~ ^[0-9a-f]{32}$ ]] || fail "CLOUDFLARE_ACCOUNT_ID is not a 32-character hex account ID"

attempts="${VERIFY_ATTEMPTS:-10}"
delay="${VERIFY_DELAY_SECONDS:-3}"
api_base="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"
account_path="/accounts/${CLOUDFLARE_ACCOUNT_ID}"

workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

# cf_get PATH -> prints the JSON body on success; fails on non-200 or success != true.
cf_get() {
  local path="$1" body="$workdir/cf.json" status
  status="$(curl --silent --show-error --proto '=https' --tlsv1.2 \
    --retry 3 --retry-all-errors --retry-delay 2 --max-time 20 \
    --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    --output "$body" --write-out '%{http_code}' \
    "${api_base}${path}")" || fail "Cloudflare API request failed for ${path/${CLOUDFLARE_ACCOUNT_ID}/<account>}"
  if [[ "$status" != "200" ]] || ! jq -e '.success == true' "$body" >/dev/null 2>&1; then
    local errors
    errors="$(jq -c '[.errors[]? | {code, message}]' "$body" 2>/dev/null || echo '"non-JSON response"')"
    fail "Cloudflare API ${path/${CLOUDFLARE_ACCOUNT_ID}/<account>} returned HTTP ${status}: ${errors}"
  fi
  cat "$body"
}

# 1. Account workers.dev subdomain.
account_subdomain="$(cf_get "${account_path}/workers/subdomain" \
  | jq -er '.result.subdomain | select(type == "string" and test("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$"))')" \
  || fail "Cloudflare API did not return a valid workers.dev account subdomain"

# 2. Script-level workers.dev route must be enabled (wrangler.toml workers_dev = true).
cf_get "${account_path}/workers/scripts/${script_name}/subdomain" \
  | jq -e '.result.enabled == true' >/dev/null \
  || fail "workers.dev route is not enabled for ${script_name}"

# 3. Active deployment must serve exactly one version, annotated with the commit.
deployments="$(cf_get "${account_path}/workers/scripts/${script_name}/deployments")"
active_version="$(printf '%s' "$deployments" | jq -er '
  .result.deployments[0].versions
  | if length == 1 and .[0].percentage == 100 then .[0].version_id else empty end')" \
  || fail "Active deployment of ${script_name} does not serve a single version at 100%"
version_json="$(cf_get "${account_path}/workers/scripts/${script_name}/versions/${active_version}")"
printf '%s' "$version_json" | jq -e --arg sha "$commit_sha" '[.result | .. | strings] | any(contains($sha))' >/dev/null \
  || fail "Active version ${active_version} of ${script_name} is not annotated with commit ${commit_sha}"
echo "Active Cloudflare version for ${script_name}: ${active_version} (commit ${commit_sha})"

base_url="https://${script_name}.${account_subdomain}.workers.dev"

# http_check NAME URL FILTER -> requires HTTP 200 and a JSON body matching FILTER.
http_check() {
  local name="$1" url="$2" filter="$3" body="$workdir/http.json" status="" i
  for ((i = 1; i <= attempts; i++)); do
    if status="$(curl --silent --show-error --proto '=https' --tlsv1.2 --max-time 20 \
        --output "$body" --write-out '%{http_code}' "$url")" \
      && [[ "$status" == "200" ]] \
      && jq -e "$filter" "$body" >/dev/null 2>&1; then
      echo "${name} OK (HTTP ${status}): $(jq -c . "$body")"
      return 0
    fi
    echo "${name} attempt ${i}/${attempts} not healthy yet (HTTP ${status:-none})" >&2
    (( i < attempts )) && sleep "$delay"
  done
  echo "Last ${name} response body:" >&2
  head -c 2000 "$body" >&2 2>/dev/null || true
  echo >&2
  fail "${name} check failed for ${url}"
}

http_check "health" "${base_url}/health" "$health_filter"
http_check "readiness" "${base_url}/ready" "$ready_filter"

# 4. Advisory custom-domain check (never disables TLS verification).
if [[ -n "$custom_domain" ]]; then
  domains="$(cf_get "${account_path}/workers/domains?service=${script_name}" 2>/dev/null || echo '{}')"
  registration="$(printf '%s' "$domains" | jq -c --arg h "$custom_domain" \
    '[.result[]? | select(.hostname == $h) | {hostname, zone_name, environment}]' 2>/dev/null || echo '[]')"
  echo "Custom domain registration for ${custom_domain}: ${registration}"
  if ! curl_err="$(curl --silent --show-error --proto '=https' --tlsv1.2 --max-time 20 \
      --output /dev/null "https://${custom_domain}/health" 2>&1)"; then
    echo "::warning::Custom domain ${custom_domain} failed TLS-verified request: ${curl_err//$'\n'/ }. The Worker itself is verified on workers.dev; fix the domain's certificate/zone separately."
  else
    echo "Custom domain ${custom_domain} responds over verified TLS."
  fi
fi

echo "Live verification passed for ${script_name} at ${base_url}"
