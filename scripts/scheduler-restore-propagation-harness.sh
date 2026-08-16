#!/usr/bin/env bash
#
# The scheduler-restore contract, under the production shell semantics:
# `set -Eeuo pipefail`, `trap on_phase_error ERR` whose handler exits, and the
# EXIT trap that must decide the final status.
#
# Three outcomes have to hold, and the middle one is the reason this exists:
# the previous version logged a warning and returned 0, so a green deploy could
# leave production with no scheduler and nothing in the exit status to say so.
set -Eeuo pipefail
WORK="$(mktemp -d)"; trap 'rm -rf "${WORK}"' EXIT
failures=0

CASE="${WORK}/case.sh"
cat >"${CASE}" <<'RUNNER'
set -Eeuo pipefail
phase="run_migrations"
log() { echo "[deploy] $*"; }
dump_service_diagnostics() { :; }
on_phase_error() { status=$?; echo "deploy_phase=${phase} failed"; exit "${status}"; }
trap on_phase_error ERR

DEPLOY_SCHEDULER_STATE_DIR="${WORK_STATE}"
DEPLOY_SCHEDULER_RESTORE_FAILED_STATUS=75

rootcron_resume() { [ "${RESUME_OK}" = "1" ]; }

deploy_scheduler_resume() {
  [ "${DEPLOY_SCHEDULER_PAUSED:-0}" = "1" ] || return 0
  DEPLOY_SCHEDULER_PAUSED=0
  if rootcron_resume "${DEPLOY_SCHEDULER_STATE_DIR}"; then return 0; fi
  log "ABORT the Sync cron block could NOT be restored"
  return 1
}
deploy_scheduler_resume_on_exit() {
  __deploy_status=$?
  if deploy_scheduler_resume; then exit "${__deploy_status}"; fi
  if [ "${__deploy_status}" -eq 0 ]; then exit "${DEPLOY_SCHEDULER_RESTORE_FAILED_STATUS}"; fi
  log "the phase was already failing with status ${__deploy_status}; preserving it"
  exit "${__deploy_status}"
}

DEPLOY_SCHEDULER_PAUSED=1
trap deploy_scheduler_resume_on_exit EXIT

if [ "${PHASE_FAILS}" = "1" ]; then
  # A real failing command, so the ERR trap participates exactly as in production.
  false
fi
echo "phase body completed"
RUNNER

run_case() {
  name="$1"; phase_fails="$2"; resume_ok="$3"; expect="$4"
  rc=0
  env WORK_STATE="${WORK}/state" PHASE_FAILS="${phase_fails}" RESUME_OK="${resume_ok}" \
    bash "${CASE}" >"${WORK}/out" 2>&1 || rc=$?
  if [ "${rc}" -eq "${expect}" ]; then
    echo "  PASS  ${name} (exit=${rc})"
  else
    echo "  FAIL  ${name}: expected exit ${expect}, got ${rc}"
    sed 's/^/        /' "${WORK}/out"
    failures=$((failures + 1))
  fi
}

echo "Scheduler restore propagation"
run_case "success + restore succeeds -> success"                 0 1 0
run_case "success + restore FAILS -> deploy fails (75)"          0 0 75
run_case "phase fails + restore succeeds -> original failure"    1 1 1
run_case "phase fails + restore FAILS -> original failure kept"  1 0 1

# The restoration failure must still be visible in the already-failing case.
env WORK_STATE="${WORK}/state" PHASE_FAILS=1 RESUME_OK=0 bash "${CASE}" >"${WORK}/out" 2>&1 || true
if grep -q "could NOT be restored" "${WORK}/out" && grep -q "preserving it" "${WORK}/out"; then
  echo "  PASS  a masked restoration failure is still logged loudly"
else
  echo "  FAIL  the restoration failure was not logged when the phase already failed"
  failures=$((failures + 1))
fi

if [ "${failures}" -ne 0 ]; then echo "FAILED: ${failures} case(s)"; exit 1; fi
echo "All cases passed."
