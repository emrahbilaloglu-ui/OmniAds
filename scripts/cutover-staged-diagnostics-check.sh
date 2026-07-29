#!/usr/bin/env bash
# deploy-disabled must SURFACE the failed predicate, never discard it.
#
# The incident: staged_check redirected stdout+stderr to /dev/null, so 30
# identical silent attempts produced "See the reason code above" with no reason
# code above. The container was recreated immediately afterwards, so the worker's
# own boot refusal was lost too and the cause could not be determined at all.
set -euo pipefail
cd "$(dirname "$0")/.."
L="[cutover-staged-diagnostics]"; F=0
pass(){ printf '%s PASS %s\n' "$L" "$1"; }
fail(){ printf '%s FAIL %s\n' "$L" "$1" >&2; F=$((F+1)); }
BODY="$(awk '/staged_check\(\)/,/full healthcheck payload/' scripts/hetzner-sync-cutover.sh)"
# The whole phase, for assertions about where things happen relative to the recreate.
PHASE="$(awk '/^  deploy-disabled\)/,/deploy-disabled OK/' scripts/hetzner-sync-cutover.sh)"

case "$BODY" in
  *'>/dev/null 2>&1'*) fail "D1 staged_check STILL discards its output" ;;
  *) pass "D1 staged_check no longer discards output" ;;
esac
case "$BODY" in
  *'> "${staged_log}" 2>&1'*) pass "D2 output is captured to a durable log" ;;
  *) fail "D2 output is not captured to a log" ;;
esac
for k in reason stagedWorkers onlineWorkers runnerLeases jobLocks; do
  case "$BODY" in *"$k"*) : ;; *) fail "D3 predicate '$k' is not surfaced"; esac
done
case "$BODY" in *reason*stagedWorkers*) pass "D3 per-predicate fields are surfaced (reason, stagedWorkers, online, leases, locks)" ;; esac
case "$BODY" in
  *'docker compose logs'*worker*) pass "D4 the worker container log tail is captured (boot refusals survive recreate)" ;;
  *) fail "D4 no worker log capture on failure" ;;
esac
case "$BODY" in
  *'secret|token|password|api[_-]?key'*) pass "D5 output is filtered on the secret denylist" ;;
  *) fail "D5 no secret filtering on the surfaced output" ;;
esac
case "$BODY" in
  *'produced NO output at all'*) pass "D6 an empty payload is reported distinctly from a failed predicate" ;;
  *) fail "D6 empty output is not distinguished" ;;
esac
# No arbitrary sleeps or weakened deadline: still 30 attempts x 2s.
case "$BODY" in
  *'wait_for "staged worker" 30 2'*) pass "D7 the deadline is unchanged (30 attempts x 2s), no added sleep" ;;
  *) fail "D7 the polling deadline was altered" ;;
esac
# The gate itself must not be weakened: failure still dies.
case "$BODY" in
  *'die "the worker did not come up staged'*) pass "D8 failure still aborts the phase (gate not weakened)" ;;
  *) fail "D8 the abort was removed or softened" ;;
esac
# The staged worker has to prove it IS the pinned release. Without this the
# phase only ever proves that SOME worker staged, and a stale APP_BUILD_ID on
# the host certifies a build it did not produce.
case "$BODY" in
  *'--expect-build-id "${EXPECTED_SHA}"'*) pass "D9 the staged check pins the target build identity" ;;
  *) fail "D9 --expect-build-id \${EXPECTED_SHA} is not passed to the staged check" ;;
esac
# The staged worker must be THIS run, not a registration left by the container
# that was just replaced.
case "$BODY" in
  *'--min-heartbeat-after "${worker_started_at}"'*) pass "D10 the staged check pins this container's start time" ;;
  *) fail "D10 --min-heartbeat-after is no longer bound to the container start" ;;
esac
# The new refusal codes have to reach the operator, or a build/run mismatch
# aborts with no reason printed — the exact failure D1-D6 exist to prevent.
for k in stagedWorkerBuildId stagedIsThisRun stagedBuildIdMatches expectBuildId; do
  case "$BODY" in *"$k"*) : ;; *) fail "D11 predicate '$k' is not surfaced on failure"; esac
done
case "$BODY" in
  *stagedBuildIdMatches*) pass "D11 the identity and run predicates are surfaced on failure" ;;
esac
# The outgoing worker has to be captured BEFORE the recreate and retired only
# after it is proven stopped. Capturing afterwards would compare the database
# against a picture the retirement itself produced, which proves nothing.
case "$PHASE" in
  *'capture --online-instance'*) pass "D12 the outgoing worker's census is captured" ;;
  *) fail "D12 no outgoing-worker census is captured" ;;
esac
case "$PHASE" in
  *'--container-stopped'*) pass "D13 retirement asserts the container is stopped" ;;
  *) fail "D13 retirement does not assert a stopped container" ;;
esac
case "$PHASE" in
  *'is still running after the recreate; refusing to retire a live'*) pass "D14 a still-running outgoing container refuses" ;;
  *) fail "D14 no refusal when the outgoing container survives the recreate" ;;
esac
# Ordering: capture must appear before the recreate, and retirement after it.
cap_line="$(printf '%s\n' "$PHASE" | grep -n 'capture --online-instance' | head -1 | cut -d: -f1)"
rec_line="$(printf '%s\n' "$PHASE" | grep -n 'up -d --force-recreate web worker' | head -1 | cut -d: -f1)"
ret_line="$(printf '%s\n' "$PHASE" | grep -n 'sync-worker-retire.ts retire' | head -1 | cut -d: -f1)"
if [ -n "$cap_line" ] && [ -n "$rec_line" ] && [ -n "$ret_line" ] \
   && [ "$cap_line" -lt "$rec_line" ] && [ "$ret_line" -gt "$rec_line" ]; then
  pass "D15 capture precedes the recreate and retirement follows it"
else
  fail "D15 capture/recreate/retire are out of order (capture=$cap_line recreate=$rec_line retire=$ret_line)"
fi
[ "$F" -ne 0 ] && { printf '%s %s FAILED\n' "$L" "$F" >&2; exit 1; }
printf '%s PASS — the failed predicate and worker refusal are surfaced, and outgoing-worker retirement is captured early, proven stopped and refused when unsafe\n' "$L"
