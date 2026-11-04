#!/usr/bin/env bash
# Hermetic tests for ensure-vectorize-index.sh with a fake npx on PATH.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"

cat > "$tmp/bin/npx" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$NPX_LOG"
case "$*" in
  *"vectorize list --json"*)
    printf '%s\n' "${FAKE_VECTORIZE_LIST:-[]}"
    ;;
  *"vectorize create "*)
    echo '{"name":"cryptophys-agent-memory"}'
    ;;
  *"vectorize create-metadata-index "*)
    echo '{"mutationId":"m1"}'
    ;;
  *)
    echo "unexpected npx call: $*" >&2
    exit 1
    ;;
esac
SH
chmod +x "$tmp/bin/npx"
export PATH="$tmp/bin:$PATH"
fail=0

# 1. Missing index -> creates index (384 dims, cosine) and metadata index (agent_id, string).
export NPX_LOG="$tmp/log1"
export FAKE_VECTORIZE_LIST='[]'
"$here/ensure-vectorize-index.sh" cryptophys-agent-memory >/dev/null
grep -q '^wrangler vectorize create cryptophys-agent-memory --dimensions 384 --metric cosine$' "$tmp/log1" \
  || { echo "::error::missing index was not created with 384 dimensions and cosine metric" >&2; fail=$((fail + 1)); }
grep -q '^wrangler vectorize create-metadata-index cryptophys-agent-memory --property-name agent_id --type string$' "$tmp/log1" \
  || { echo "::error::metadata index on agent_id was not created" >&2; fail=$((fail + 1)); }

# 2. Existing index with matching 384 dimensions -> no-op (no create calls).
export NPX_LOG="$tmp/log2"
export FAKE_VECTORIZE_LIST='[{"name":"cryptophys-agent-memory","config":{"dimensions":384,"metric":"cosine"}}]'
"$here/ensure-vectorize-index.sh" cryptophys-agent-memory >/dev/null
if grep -q 'vectorize create' "$tmp/log2"; then
  echo "::error::existing valid index triggered a create call" >&2
  fail=$((fail + 1))
fi

# 3. Existing index with wrong dimensions -> fails closed without modifying or deleting it.
export NPX_LOG="$tmp/log3"
export FAKE_VECTORIZE_LIST='[{"name":"cryptophys-agent-memory","config":{"dimensions":768,"metric":"cosine"}}]'
if "$here/ensure-vectorize-index.sh" cryptophys-agent-memory >/dev/null 2>&1; then
  echo "::error::index with wrong dimensions (768) was accepted" >&2
  fail=$((fail + 1))
fi
if grep -q 'vectorize create\|vectorize delete' "$tmp/log3"; then
  echo "::error::wrong-dimension index was modified or deleted" >&2
  fail=$((fail + 1))
fi

(( fail == 0 )) || exit 1
echo "passed=3 failed=0"
