#!/usr/bin/env bash
# The worker must be allowed to run its own shutdown cleanup.
#
# It releases the runner lease and the partitions it holds in a `finally`.
# Docker's default 10-second grace cannot cover a mid-flight provider tick, so
# the worker was SIGKILLed first and left a partition lease orphaned for the ~6
# minutes until it expired — which is what made deploy-disabled refuse to retire
# a worker it had already proven dead. Waiting that out instead would have been
# treating the symptom.
set -euo pipefail
cd "$(dirname "$0")/.."
L="[worker-stop-grace]"; F=0
pass(){ printf '%s PASS %s\n' "$L" "$1"; }
fail(){ printf '%s FAIL %s\n' "$L" "$1" >&2; F=$((F+1)); }

WORKER_BLOCK="$(awk '/^  worker:/{f=1} f&&/^  [a-z]/&&!/^  worker:/{exit} f' docker-compose.yml)"
case "${WORKER_BLOCK}" in
  *stop_grace_period*) pass "G1 the worker service declares a stop_grace_period" ;;
  *) fail "G1 the worker has no stop_grace_period; Docker's 10s default kills it before its cleanup runs" ;;
esac

GRACE="$(printf '%s\n' "${WORKER_BLOCK}" | sed -n 's/.*stop_grace_period:[[:space:]]*\([0-9]*\)s.*/\1/p' | head -1)"
if [ -n "${GRACE}" ] && [ "${GRACE}" -ge 60 ]; then
  pass "G2 the grace is ${GRACE}s, enough for an in-flight tick to finish and release its claims"
else
  fail "G2 the grace is '${GRACE:-unset}'; under 60s a provider tick cannot finish its cleanup"
fi

# The cleanup it exists for must still be on the shutdown path.
case "$(cat lib/sync/worker-runtime.ts)" in
  *cleanupOwnedLeasedPartitions*) pass "G3 the worker still releases the partitions it holds on the way out" ;;
  *) fail "G3 cleanupOwnedLeasedPartitions is gone; the grace period would protect nothing" ;;
esac
case "$(cat lib/sync/worker-runtime.ts)" in
  *releaseSyncRunnerLease*) pass "G4 the worker still releases its runner lease on the way out" ;;
  *) fail "G4 releaseSyncRunnerLease is gone" ;;
esac

# Retirement keeps its bounded backstop for the case where cleanup still cannot
# finish, so the grace period is not load-bearing on its own.
case "$(cat scripts/hetzner-sync-cutover.sh)" in
  *--wait-for-held-work-seconds*) pass "G5 retirement still has a bounded backstop wait" ;;
  *) fail "G5 the retirement backstop wait was removed; the grace period alone is not a proof" ;;
esac

[ "$F" -ne 0 ] && { printf '%s %s FAILED\n' "$L" "$F" >&2; exit 1; }
printf '%s PASS — the worker can clean up after itself, and retirement still has a backstop\n' "$L"
