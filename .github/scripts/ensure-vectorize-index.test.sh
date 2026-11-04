#!/usr/bin/env bash
# Hermetic tests for ensure-vectorize-index.sh with a fake npx on PATH.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"

cat > "$tmp/bin/npx" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NPX_LOG"
case "$*" in
  "wrangler vectorize list --json")
    printf '%s\n' "${FAKE_VECTORIZE_LIST:-[]}"
    ;;
  "wrangler vectorize list-metadata-index "*)
    cat "$FAKE_METADATA_FILE"
    ;;
  "wrangler vectorize create-metadata-index "*)
    property=""
    type=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --property-name) property="$2"; shift 2 ;;
        --type) type="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    [[ -n "$property" && -n "$type" ]] || exit 2
    jq --arg property "$property" --arg type "$type" '
      if type == "array" then
        . + [{"propertyName":$property,"indexType":$type}]
      elif type == "object" then
        .metadataIndexes = ((.metadataIndexes // .metadata_indexes // []) + [{"propertyName":$property,"indexType":$type}])
      else
        error("unexpected fake metadata response")
      end
    ' "$FAKE_METADATA_FILE" > "${FAKE_METADATA_FILE}.tmp"
    mv "${FAKE_METADATA_FILE}.tmp" "$FAKE_METADATA_FILE"
    printf '%s\n' '{"mutationId":"m1"}'
    ;;
  "wrangler vectorize create "*)
    printf '%s\n' '{"name":"cryptophys-agent-memory"}'
    ;;
  *)
    echo "unexpected npx call: $*" >&2
    exit 1
    ;;
esac
SH
chmod +x "$tmp/bin/npx"
export PATH="$tmp/bin:$PATH"

script="$here/ensure-vectorize-index.sh"
pass=0
fail=0

setup() {
  local name="$1"
  export NPX_LOG="$tmp/${name}.log"
  export FAKE_METADATA_FILE="$tmp/${name}.metadata.json"
  : > "$NPX_LOG"
  printf '%s\n' "$2" > "$FAKE_METADATA_FILE"
  export FAKE_VECTORIZE_LIST="$3"
}

expect_pass() {
  local name="$1"
  if "$script" cryptophys-agent-memory >"$tmp/out" 2>"$tmp/err"; then
    echo "PASS: $name"
    pass=$((pass + 1))
  else
    echo "FAIL: $name"
    cat "$tmp/err" >&2
    fail=$((fail + 1))
  fi
}

expect_fail() {
  local name="$1"
  if "$script" cryptophys-agent-memory >"$tmp/out" 2>"$tmp/err"; then
    echo "FAIL: $name (unexpected success)"
    fail=$((fail + 1))
  else
    echo "PASS: $name"
    pass=$((pass + 1))
  fi
}

# 1. Missing index -> create 384d cosine index and agent_id metadata index.
setup missing-index '{"metadataIndexes":[]}' '[]'
expect_pass "missing index is created with the required metadata index"
grep -Fq 'wrangler vectorize create cryptophys-agent-memory --dimensions 384 --metric cosine' "$NPX_LOG" || fail=$((fail + 1))
grep -Fq 'wrangler vectorize create-metadata-index cryptophys-agent-memory --property-name agent_id --type string' "$NPX_LOG" || fail=$((fail + 1))
jq -e 'any(.metadataIndexes[]; .propertyName == "agent_id" and .indexType == "string")' "$FAKE_METADATA_FILE" >/dev/null || fail=$((fail + 1))

# 2. Existing index and metadata index both match -> no mutation.
setup existing-complete '{"metadataIndexes":[{"propertyName":"agent_id","indexType":"string"}]}' '[{"name":"cryptophys-agent-memory","config":{"dimensions":384,"metric":"cosine"}}]'
expect_pass "existing index and metadata index are a no-op"
if grep -Eq 'vectorize create ' "$NPX_LOG" || grep -Fq 'vectorize create-metadata-index ' "$NPX_LOG"; then fail=$((fail + 1)); fi

# 3. Existing valid index but missing metadata index -> create only the metadata index.
setup missing-metadata '{"metadataIndexes":[]}' '[{"name":"cryptophys-agent-memory","config":{"dimensions":384,"metric":"cosine"}}]'
expect_pass "existing index gets a missing agent_id metadata index"
if grep -Eq 'vectorize create cryptophys-agent-memory ' "$NPX_LOG"; then fail=$((fail + 1)); fi
grep -Fq 'vectorize create-metadata-index cryptophys-agent-memory --property-name agent_id --type string' "$NPX_LOG" || fail=$((fail + 1))

# 4. Wrong dimensions -> fail closed without mutating the index.
setup wrong-dimensions '{"metadataIndexes":[]}' '[{"name":"cryptophys-agent-memory","config":{"dimensions":768,"metric":"cosine"}}]'
expect_fail "wrong dimensions are rejected"
if grep -Eq 'vectorize create |vectorize delete' "$NPX_LOG"; then fail=$((fail + 1)); fi

# 5. Wrong metric -> fail closed.
setup wrong-metric '{"metadataIndexes":[]}' '[{"name":"cryptophys-agent-memory","config":{"dimensions":384,"metric":"euclidean"}}]'
expect_fail "wrong metric is rejected"
if grep -Eq 'vectorize create |vectorize delete' "$NPX_LOG"; then fail=$((fail + 1)); fi

# 6. Missing metric -> fail closed instead of assuming cosine.
setup missing-metric '{"metadataIndexes":[]}' '[{"name":"cryptophys-agent-memory","config":{"dimensions":384}}]'
expect_fail "unknown metric is rejected"
if grep -Eq 'vectorize create |vectorize delete' "$NPX_LOG"; then fail=$((fail + 1)); fi

# 7. Existing agent_id metadata index with the wrong type -> fail closed.
setup wrong-metadata-type '{"metadataIndexes":[{"propertyName":"agent_id","indexType":"number"}]}' '[{"name":"cryptophys-agent-memory","config":{"dimensions":384,"metric":"cosine"}}]'
expect_fail "wrong metadata index type is rejected"
if grep -Fq 'vectorize create-metadata-index ' "$NPX_LOG"; then fail=$((fail + 1)); fi

# 8. Accept the array response shape returned by some Wrangler/API versions.
setup array-metadata '[{"propertyName":"agent_id","indexType":"string"}]' '[{"name":"cryptophys-agent-memory","config":{"dimensions":384,"metric":"cosine"}}]'
expect_pass "array-shaped metadata response is supported"
if grep -Fq 'vectorize create-metadata-index ' "$NPX_LOG"; then fail=$((fail + 1)); fi

echo "passed=$pass failed=$fail"
(( fail == 0 && pass == 8 ))
