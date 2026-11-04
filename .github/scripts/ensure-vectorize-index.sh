#!/usr/bin/env bash
# Idempotently provision the Vectorize index and agent_id metadata index for long-term agent memory (TP-008).
# Never deletes or mutates an existing index. Fails closed if an existing index has the wrong dimensions or metric.
#
# Usage: ensure-vectorize-index.sh [INDEX_NAME]
set -euo pipefail

index_name="${1:-cryptophys-agent-memory}"
expected_dims=384
expected_metric="cosine"
metadata_prop="agent_id"

[[ "$index_name" =~ ^cryptophys-[a-z0-9-]+$ ]] || {
  echo "::error::refusing to provision Vectorize index ${index_name}: not a cryptophys index name" >&2
  exit 1
}

list_json="$(npx wrangler vectorize list --json)"
existing="$(jq -c --arg name "$index_name" 'map(select(.name == $name)) | first // null' <<<"$list_json")"

if [[ "$existing" != "null" ]]; then
  actual_dims="$(jq -r '(.config.dimensions // .dimensions // empty)' <<<"$existing")"
  actual_metric="$(jq -r '(.config.metric // .metric // "cosine")' <<<"$existing")"
  if [[ "$actual_dims" != "$expected_dims" ]]; then
    echo "::error::Vectorize index ${index_name} exists with dimensions=${actual_dims} (expected ${expected_dims}); refusing to modify" >&2
    exit 1
  fi
  if [[ "$actual_metric" != "$expected_metric" ]]; then
    echo "::error::Vectorize index ${index_name} exists with metric=${actual_metric} (expected ${expected_metric}); refusing to modify" >&2
    exit 1
  fi
  echo "Vectorize index ${index_name} already exists (${expected_dims}d, ${expected_metric}); no-op."
  exit 0
fi

npx wrangler vectorize create "$index_name" --dimensions "$expected_dims" --metric "$expected_metric" >/dev/null
npx wrangler vectorize create-metadata-index "$index_name" --property-name "$metadata_prop" --type string >/dev/null
echo "Created Vectorize index ${index_name} (${expected_dims}d, ${expected_metric}) with metadata index ${metadata_prop}."
