#!/usr/bin/env bash
# Idempotently provision the Vectorize index and agent_id metadata index for long-term agent memory (TP-008).
# Never deletes or changes an existing index. Fails closed if its dimensions, metric, or metadata index is wrong.
#
# Usage: ensure-vectorize-index.sh [INDEX_NAME]
set -euo pipefail

index_name="${1:-cryptophys-agent-memory}"
expected_dims=384
expected_metric="cosine"
metadata_prop="agent_id"
metadata_type="string"

fail() {
  echo "::error::$*" >&2
  exit 1
}

[[ "$index_name" =~ ^cryptophys-[a-z0-9-]+$ ]] || {
  fail "refusing to provision Vectorize index ${index_name}: not a cryptophys index name"
}

ensure_metadata_index() {
  local metadata_json entry actual_type attempt

  metadata_json="$(npx wrangler vectorize list-metadata-index "$index_name" --json)"
  entry="$(jq -c --arg property "$metadata_prop" '
    (.metadataIndexes // .metadata_indexes // .result.metadataIndexes // [])
    | map(select((.propertyName // .property_name) == $property))
    | first // null
  ' <<<"$metadata_json")"

  if [[ "$entry" != "null" ]]; then
    actual_type="$(jq -r '(.indexType // .index_type // "")' <<<"$entry")"
    [[ "$actual_type" == "$metadata_type" ]] || fail "Vectorize metadata index ${metadata_prop} exists with type=${actual_type:-unknown} (expected ${metadata_type}); refusing to modify"
    echo "Vectorize metadata index ${metadata_prop} already exists (${metadata_type}); no-op."
    return 0
  fi

  npx wrangler vectorize create-metadata-index "$index_name" --property-name "$metadata_prop" --type "$metadata_type" >/dev/null

  # Metadata-index mutations are asynchronous. Confirm the property becomes queryable
  # before allowing D1 migrations or Worker deployments to proceed.
  for attempt in {1..10}; do
    metadata_json="$(npx wrangler vectorize list-metadata-index "$index_name" --json)"
    entry="$(jq -c --arg property "$metadata_prop" '
      (.metadataIndexes // .metadata_indexes // .result.metadataIndexes // [])
      | map(select((.propertyName // .property_name) == $property))
      | first // null
    ' <<<"$metadata_json")"
    if [[ "$entry" != "null" ]]; then
      actual_type="$(jq -r '(.indexType // .index_type // "")' <<<"$entry")"
      [[ "$actual_type" == "$metadata_type" ]] || fail "Vectorize metadata index ${metadata_prop} was created with type=${actual_type:-unknown} (expected ${metadata_type})"
      echo "Vectorize metadata index ${metadata_prop} is ready (${metadata_type})."
      return 0
    fi
    (( attempt == 10 )) || sleep 3
  done

  fail "Vectorize metadata index ${metadata_prop} was not visible after 10 attempts"
}

list_json="$(npx wrangler vectorize list --json)"
existing="$(jq -c --arg name "$index_name" 'map(select(.name == $name)) | first // null' <<<"$list_json")"

if [[ "$existing" != "null" ]]; then
  actual_dims="$(jq -r '(.config.dimensions // .dimensions // "")' <<<"$existing")"
  actual_metric="$(jq -r '(.config.metric // .metric // "")' <<<"$existing")"
  [[ "$actual_dims" == "$expected_dims" ]] || fail "Vectorize index ${index_name} exists with dimensions=${actual_dims:-unknown} (expected ${expected_dims}); refusing to modify"
  [[ "$actual_metric" == "$expected_metric" ]] || fail "Vectorize index ${index_name} exists with metric=${actual_metric:-unknown} (expected ${expected_metric}); refusing to modify"
  echo "Vectorize index ${index_name} already exists (${expected_dims}d, ${expected_metric}); verifying metadata index."
else
  npx wrangler vectorize create "$index_name" --dimensions "$expected_dims" --metric "$expected_metric" >/dev/null
  echo "Created Vectorize index ${index_name} (${expected_dims}d, ${expected_metric})."
fi

ensure_metadata_index
echo "Vectorize index ${index_name} and metadata index ${metadata_prop} are ready."
