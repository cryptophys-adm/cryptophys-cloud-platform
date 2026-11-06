#!/usr/bin/env bash
# Record a deployed Worker's version tag as its desired version in the Platform Registry, so
# the Drift Detector compares the live version against it. Authenticated only by the CI
# Cloudflare Access service token (an OPERATOR_IDENTITIES member); no shared token exists.
#
# Usage: record-desired-version.sh SERVICE_ID COMMIT_SHA|VERSION_TAG
# A 12-character version tag is accepted for rollbacks to an earlier version (Wave B).
# Env:   CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN (Workers read), CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
set -euo pipefail

service="${1:?usage: record-desired-version.sh SERVICE_ID COMMIT_SHA}"
sha="${2:?usage: record-desired-version.sh SERVICE_ID COMMIT_SHA}"
[[ "$service" =~ ^cryptophys-[a-z0-9-]+$ ]] || { echo "::error::invalid service id" >&2; exit 1; }
[[ "$sha" =~ ^[0-9a-f]{40}$ || "$sha" =~ ^[0-9a-f]{12}$ ]] || { echo "::error::full lowercase commit SHA or 12-character version tag required" >&2; exit 1; }
tag="${sha:0:12}"
api_base="${CLOUDFLARE_API_BASE:-https://api.cloudflare.com/client/v4}"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
"$here/access-headers.sh" "$tmp/access"

subdomain="$(curl --fail --silent --show-error --proto '=https' --max-time 20 \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}" \
  "${api_base}/accounts/${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}/workers/subdomain" \
  | jq -er '.result.subdomain | select(test("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$"))')"
url="https://cryptophys-platform-registry.${subdomain}.workers.dev/v1/services/${service}/desired-version"

status="$(curl --silent --show-error --proto '=https' --tlsv1.2 --max-time 30 --request PUT "$url" \
  --header "Content-Type: application/json" --header "@$tmp/access" \
  --data "$(jq -cn --arg v "$tag" '{desired_version: $v}')" \
  --output "$tmp/body" --write-out '%{http_code}')"
[[ "$status" == "200" ]] || { echo "::error::Registry returned HTTP ${status}: $(head -c 500 "$tmp/body")" >&2; exit 1; }
jq -e --arg v "$tag" '.service.desired_version == $v' "$tmp/body" >/dev/null \
  || { echo "::error::Registry did not record desired_version ${tag}" >&2; exit 1; }
echo "Desired version ${tag} recorded for ${service}"
