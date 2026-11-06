#!/usr/bin/env bash
# Hermetic tests for worker-rollback.sh. A fake `curl` keeps each Worker's active deployment
# in a file, serves it on GET and replaces it on POST; no network or credentials are used.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
subject="$here/worker-rollback.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export FAKE_DIR="$tmp/cf" EXPECTED_TOKEN="test-token-must-never-be-printed"
mkdir -p "$FAKE_DIR" "$tmp/bin"

cat >"$tmp/bin/curl" <<'FAKE'
#!/usr/bin/env bash
method=GET; data=""; auth=""; url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --request) method="$2"; shift 2 ;;
    --data) data="$2"; shift 2 ;;
    --header) [[ "$2" == Authorization:* ]] && auth="$2"; shift 2 ;;
    --max-time|--proto) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
[[ "$auth" == "Authorization: Bearer $EXPECTED_TOKEN" ]] || exit 22
script="$(sed -E 's#.*/workers/scripts/([^/]+)/deployments$#\1#' <<<"$url")"
file="$FAKE_DIR/$script"
[[ -f "$file" ]] || exit 22
if [[ "$method" == POST ]]; then
  [[ -f "$FAKE_DIR/$script.refuse" ]] && { echo '{"success":false}'; exit 22; }
  jq -c '.versions' <<<"$data" >"$file"
  echo "$data" >"$FAKE_DIR/$script.posted"
  echo '{"success":true}'
else
  jq -c '{success: true, result: {deployments: [
    {created_on: "2026-01-01T00:00:00Z", versions: [{version_id: "00000000-0000-0000-0000-000000000000", percentage: 100}]},
    {created_on: "2026-11-06T00:00:00Z", versions: .}]}}' "$file"
fi
FAKE
chmod +x "$tmp/bin/curl"

v() { printf '[{"version_id":"%s","percentage":100}]' "$1"; }
OLD_A=11111111-1111-1111-1111-111111111111; NEW_A=22222222-2222-2222-2222-222222222222
OLD_B=33333333-3333-3333-3333-333333333333
v "$OLD_A" >"$FAKE_DIR/worker-a"; v "$OLD_B" >"$FAKE_DIR/worker-b"
run() { PATH="$tmp/bin:$PATH" CLOUDFLARE_ACCOUNT_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa CLOUDFLARE_API_TOKEN="$EXPECTED_TOKEN" CLOUDFLARE_API_BASE=https://api.cloudflare.test/client/v4 bash "$subject" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
state="$tmp/state.json"

# 1. capture records the latest deployment of every Worker.
out="$(run capture "$state" worker-a worker-b)"
[[ "$(jq -r '.["worker-a"][0].version_id' "$state")" == "$OLD_A" ]] || fail "capture worker-a"
[[ "$(jq -r '.["worker-b"][0].version_id' "$state")" == "$OLD_B" ]] || fail "capture worker-b"
[[ "$out" != *"$EXPECTED_TOKEN"* ]] || fail "token printed"

# 2. restore rolls back only the Worker the deploy changed.
v "$NEW_A" >"$FAKE_DIR/worker-a"
out="$(run restore "$state" 2>&1)" || fail "restore exited non-zero: $out"
[[ "$(jq -r '.[0].version_id' "$FAKE_DIR/worker-a")" == "$OLD_A" ]] || fail "worker-a not rolled back"
[[ ! -f "$FAKE_DIR/worker-b.posted" ]] || fail "worker-b was redeployed although unchanged"
[[ "$(jq -r '.strategy' "$FAKE_DIR/worker-a.posted")" == percentage ]] || fail "strategy"
[[ "$out" == *"worker-b: unchanged"* && "$out" != *"$EXPECTED_TOKEN"* ]] || fail "restore output: $out"

# 3. a refused rollback fails the step.
v "$NEW_A" >"$FAKE_DIR/worker-a"; touch "$FAKE_DIR/worker-a.refuse"
if run restore "$state" >/dev/null 2>&1; then fail "refused rollback reported success"; fi
rm -f "$FAKE_DIR/worker-a.refuse"

# 4. invalid input and missing state fail closed.
if run capture "$state" "Bad_Name" >/dev/null 2>&1; then fail "invalid name accepted"; fi
if run restore "$tmp/missing.json" >/dev/null 2>&1; then fail "missing state accepted"; fi
if run capture "$state" worker-unknown >/dev/null 2>&1; then fail "unreadable deployment accepted"; fi

echo "worker-rollback.sh: all tests passed"
