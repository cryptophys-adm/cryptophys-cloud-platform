#!/usr/bin/env bash
# Wait until a production deploy may start without overlapping a platform cron (Wave A).
#
# The Drift Detector observes at :00/:15/:30/:45 and the AI Kernel's scheduled cycle runs at
# :07/:22/:37/:52 on the same Durable Object the deploy verification wakes. A deploy and its
# verification take about 4 minutes, so a deploy may only start at a minute m where no cron
# falls in [m-1, m+4]. On 2026-11-06 two control-plane deploys collided with the kernel cycle
# and were rolled back. This guard makes the rule structural for every dispatch path (ops
# requests, consensus, autonomous recovery and people).
#
#   wait-cron-window.sh            wait (at most 15 min) for the next safe minute
#   wait-cron-window.sh --check M  exit 0 if minute M is safe, 1 if not (tests)
set -euo pipefail
SAFE=" 2 9 10 17 24 25 32 39 40 47 54 55 "
safe() { [[ "$SAFE" == *" $1 "* ]]; }
if [[ "${1:-}" == "--check" ]]; then safe "$((10#${2:?minute}))"; exit; fi
deadline=$(( $(date -u +%s) + 900 ))
while :; do
  m=$((10#$(date -u +%M)))
  if safe "$m"; then echo "Minute :$(printf %02d "$m") is outside the cron windows; deploying."; exit 0; fi
  (( $(date -u +%s) < deadline )) || { echo "::error::no safe deploy window within 15 minutes"; exit 1; }
  sleep 15
done
