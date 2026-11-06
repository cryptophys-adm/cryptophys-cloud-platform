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
#                       CF_API_BASE (default https://api.cloudflare.com/client/v4),
#                       CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET (Cloudflare Access service token)
#
# --require-access: the Worker must sit behind Cloudflare Access. The service token is
# then mandatory (sent from a 0600 header file, never on the command line), and an
# unauthenticated GET /health must be rejected by Access (HTTP 302, 401 or 403).
#
# Usage:
#   verify-worker-live.sh --script NAME --commit SHA \
#     --health-filter JQ --ready-filter JQ [--require-access] [--custom-domain HOSTNAME] [--require-custom-domain]
#
# --custom-domain is advisory by default: a failure is surfaced as a warning.
# --require-custom-domain makes the hostname part of the deployment contract: it must be
# registered as an enabled production Worker domain, reject unauthenticated requests via
# Access, and serve the expected health/readiness contracts over verified TLS.
# This strict mode also requires --require-access.
set -euo pipefail

script_name=""
commit_sha=""
health_filter=""
ready_filter=""
custom_domain=""
require_access=false
require_custom_domain=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --script) script_name="${2:-}"; shift 2 ;;
    --commit) commit_sha="${2:-}"; shift 2 ;;
    --health-filter) health_filter="${2:-}"; shift 2 ;;
    --ready-filter) ready_filter="${2:-}"; shift 2 ;;
    --custom-domain) custom_domain="${2:-}"; shift 2 ;;
    --require-access) require_access=true; shift ;;
    --require-custom-domain) require_custom_domain=true; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

fail() { echo "::error::$*" >&2; exit 1; }

[[ "$require_custom_domain" != true || -n "$custom_domain" ]] || fail "--require-custom-domain requires --custom-domain HOSTNAME"
[[ "$require_custom_domain" != true || "$require_access" == true ]] || fail "--require-custom-domain requires --require-access"
if [[ -n "$custom_domain" ]]; then
  [[ "$custom_domain" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]] || fail "--custom-domain must be a lowercase DNS hostname"
fi

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

# Cloudflare Access service-token headers for requests to the Worker itself.
access_args=()
if [[ -n "${CF_ACCESS_CLIENT_ID:-}" || -n "${CF_ACCESS_CLIENT_SECRET:-}" ]]; then
  [[ -n "${CF_ACCESS_CLIENT_ID:-}" && -n "${CF_ACCESS_CLIENT_SECRET:-}" ]] || fail "Set both CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET"
  "$(dirname "${BASH_SOURCE[0]}")/access-headers.sh" "$workdir/access-headers" || fail "invalid Cloudflare Access service token secrets"
  access_args=(--header "@$workdir/access-headers")
elif [[ "$require_access" == true ]]; then
  fail "--require-access needs CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET (Cloudflare Access service token)"
fi

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
# The deployments list is eventually consistent: right after `wrangler deploy` it can still
# report the previous version (seen in production, run 41823740347), so this is retried
# with the same budget as the health checks before failing.
active_version=""
for ((v = 1; v <= attempts; v++)); do
  deployments="$(cf_get "${account_path}/workers/scripts/${script_name}/deployments")"
  candidate="$(printf '%s' "$deployments" | jq -er '
    .result.deployments[0].versions
    | if length == 1 and .[0].percentage == 100 then .[0].version_id else empty end')" || candidate=""
  if [[ -n "$candidate" ]]; then
    version_json="$(cf_get "${account_path}/workers/scripts/${script_name}/versions/${candidate}")"
    if printf '%s' "$version_json" | jq -e --arg sha "$commit_sha" '[.result | .. | strings] | any(contains($sha))' >/dev/null; then
      active_version="$candidate"
      break
    fi
    echo "Active version ${candidate} of ${script_name} is not yet commit ${commit_sha} (attempt ${v}/${attempts})" >&2
  else
    echo "Active deployment of ${script_name} does not yet serve a single version at 100% (attempt ${v}/${attempts})" >&2
  fi
  (( v < attempts )) && sleep "$delay"
done
if [[ -z "$active_version" && -n "$candidate" ]]; then
  fail "Active version ${candidate} of ${script_name} is not annotated with commit ${commit_sha} after ${attempts} attempts"
fi
[[ -n "$active_version" ]] \
  || fail "Active deployment of ${script_name} does not serve a single version at 100% after ${attempts} attempts"
echo "Active Cloudflare version for ${script_name}: ${active_version} (commit ${commit_sha})"

base_url="https://${script_name}.${account_subdomain}.workers.dev"

# http_check NAME URL FILTER -> requires HTTP 200 and a JSON body matching FILTER.
http_check() {
  local name="$1" url="$2" filter="$3" body="$workdir/http.json" status="" i
  for ((i = 1; i <= attempts; i++)); do
    if status="$(curl --silent --show-error --proto '=https' --tlsv1.2 --max-time 20 \
        "${access_args[@]}" --output "$body" --write-out '%{http_code}' "$url")" \
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

if [[ "$require_access" == true ]]; then
  # Without credentials, Cloudflare Access must stop the request before the Worker.
  unauth="$(curl --silent --show-error --proto '=https' --tlsv1.2 --max-time 20 \
    --output /dev/null --write-out '%{http_code}' "${base_url}/health")" || fail "unauthenticated probe of ${base_url} failed to connect"
  [[ "$unauth" =~ ^(302|401|403)$ ]] || fail "${base_url}/health answered HTTP ${unauth} without credentials; it is not protected by Cloudflare Access"
  echo "Cloudflare Access rejects unauthenticated requests to ${base_url} (HTTP ${unauth})"
fi

http_check "health" "${base_url}/health" "$health_filter"
http_check "readiness" "${base_url}/ready" "$ready_filter"

# 4. Custom-domain verification. Keep the default advisory mode for existing callers;
# Home opts into strict mode because home.cryptophys.work is its canonical entrypoint.
if [[ -n "$custom_domain" ]]; then
  if ! domains="$(cf_get "${account_path}/workers/domains?service=${script_name}" 2>/dev/null)"; then
    if [[ "$require_custom_domain" == true ]]; then
      fail "Could not verify Cloudflare registration for required custom domain ${custom_domain}"
    fi
    domains='{}'
  fi
  registration="$(printf '%s' "$domains" | jq -c --arg h "$custom_domain" --arg s "$script_name" \
    '[.result[]? | select(.hostname == $h and .service == $s and .environment == "production" and .enabled == true and .previews_enabled == false) | {hostname, zone_name, environment, enabled, previews_enabled}]' 2>/dev/null || echo '[]')"
  echo "Custom domain registration for ${custom_domain}: ${registration}"

  if [[ "$require_custom_domain" == true ]]; then
    jq -e 'length == 1' <<<"$registration" >/dev/null \
      || fail "Required custom domain ${custom_domain} is not registered as exactly one enabled production Worker domain with preview routing disabled for ${script_name}"
    domain_url="https://${custom_domain}"
    if ! unauth_status="$(curl --silent --show-error --proto '=https' --tlsv1.2 --max-time 20 \
        --output /dev/null --write-out '%{http_code}' "${domain_url}/health")"; then
      fail "Required custom domain ${custom_domain} failed TLS-verified request"
    fi
    [[ "$unauth_status" =~ ^(302|401|403)$ ]] \
      || fail "Required custom domain ${custom_domain} is not protected by Cloudflare Access (unauthenticated HTTP ${unauth_status})"
    echo "Cloudflare Access rejects unauthenticated requests to ${domain_url} (HTTP ${unauth_status})"
    http_check "custom-domain health" "${domain_url}/health" "$health_filter"
    http_check "custom-domain readiness" "${domain_url}/ready" "$ready_filter"
  else
    if ! curl_err="$(curl --silent --show-error --proto '=https' --tlsv1.2 --max-time 20 \
        --output /dev/null "https://${custom_domain}/health" 2>&1)"; then
      echo "::warning::Custom domain ${custom_domain} failed TLS-verified request: ${curl_err//$'\\n'/ }. The Worker itself is verified on workers.dev; fix the domain's certificate/zone separately."
    else
      echo "Custom domain ${custom_domain} responds over verified TLS."
    fi
  fi
fi

echo "Live verification passed for ${script_name} at ${base_url}"
