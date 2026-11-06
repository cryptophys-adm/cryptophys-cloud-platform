#!/usr/bin/env bash
# Hermetic test for wait-cron-window.sh: every safe minute keeps deploy + verification clear of
# the drift (:00/:15/:30/:45) and kernel (:07/:22/:37/:52) crons; every cron-adjacent minute waits.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crons=(0 7 15 22 30 37 45 52)
safe_count=0
for m in $(seq 0 59); do
  clash=0
  for c in "${crons[@]}"; do
    d=$(( (c - m + 60) % 60 )); back=$(( (m - c + 60) % 60 ))
    if (( d <= 4 || back == 1 )); then clash=1; fi
  done
  if bash "$here/wait-cron-window.sh" --check "$m"; then
    (( clash == 0 )) || { echo "FAIL: minute $m is marked safe but clashes with a cron"; exit 1; }
    safe_count=$((safe_count + 1))
  fi
done
(( safe_count >= 10 )) || { echo "FAIL: too few safe minutes ($safe_count)"; exit 1; }
for m in 0 7 15 22 30 37 45 52 58 5 13; do
  if bash "$here/wait-cron-window.sh" --check "$m"; then echo "FAIL: minute $m should wait"; exit 1; fi
done
echo "wait-cron-window.sh: all tests passed ($safe_count safe minutes)"
