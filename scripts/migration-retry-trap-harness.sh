#!/usr/bin/env bash
#
# Proves the migration retry wrapper under the REAL shell semantics of
# .github/scripts/hetzner-remote.sh — `set -Eeuo pipefail` plus
# `trap on_phase_error ERR` where the handler calls `exit`.
#
# This exists because the first version of that wrapper used
# `set +e; run_migrations_service; status=$?; set -e`, and a harness that did
# not install the ERR trap reported it as working. It was not: bash runs an ERR
# trap on a failing simple command whether or not errexit is enabled, so the
# trap exited the process before the status was ever read, and every "retry"
# was dead code. A harness that cannot reproduce the production trap cannot
# tell you that.
#
# Run: bash scripts/migration-retry-trap-harness.sh
set -Eeuo pipefail

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

log() { echo "[harness] $*"; }
is_positive_integer() { case "$1" in '' | *[!0-9]*) return 1 ;; *) [ "$1" -gt 0 ] ;; esac; }

# --- the production trap, verbatim in shape -------------------------------
phase="run_migrations"
dump_service_diagnostics() { echo "diagnostics-dumped"; }
on_phase_error() {
  status="$?"
  echo "deploy_phase=${phase} failed_command=${BASH_COMMAND:-unknown}"
  dump_service_diagnostics
  exit "${status}"
}
trap on_phase_error ERR

# --- functions under test, copied from hetzner-remote.sh -------------------
migration_failed_on_lock_contention() {
  log_path="${MIGRATION_LAST_LOG:-/tmp/adsecute-migrate.log}"
  [ -f "${log_path}" ] || return 1
  grep -qE "canceling statement due to lock timeout|55P03|lock_not_available|deadlock detected|40P01" "${log_path}"
}

run_migrations_service_with_contention_retry() {
  attempts="${DEPLOY_MIGRATION_CONTENTION_ATTEMPTS:-4}"
  is_positive_integer "${attempts}" || attempts=4
  attempt=1

  while :; do
    status=0
    run_migrations_service || status=$?

    [ "${status}" -eq 0 ] && return 0

    if ! migration_failed_on_lock_contention; then
      log "Migration failed for a reason other than lock contention; not retrying."
      return "${status}"
    fi

    if [ "${attempt}" -ge "${attempts}" ]; then
      log "Migration still blocked by lock contention after ${attempts} attempts."
      return "${status}"
    fi

    backoff="${HARNESS_BACKOFF_SECONDS:-$((attempt * 30))}"
    log "Migration attempt ${attempt}/${attempts} lost a lock race. Retrying in ${backoff}s."
    sleep "${backoff}"
    attempt=$((attempt + 1))
  done
}

# --- test double ----------------------------------------------------------
# Mirrors the real one's shape: it toggles errexit internally and RESTORES
# `set -e` before returning non-zero, exactly as run_migrations_service does.
run_migrations_service() {
  local n
  n=$(cat "${WORK}/attempts")
  n=$((n + 1))
  echo "${n}" >"${WORK}/attempts"

  set +e
  false
  local rc=$?
  set -e

  if [ "${n}" -lt "${SUCCEED_ON}" ]; then
    printf '%s\n' "${FAILMSG}" >"${MIGRATION_LAST_LOG}"
    return "${rc}"
  fi
  echo "migrations complete" >"${MIGRATION_LAST_LOG}"
  return 0
}

export HARNESS_BACKOFF_SECONDS=0
failures=0

# Each case runs in a SEPARATE bash process that installs the production trap
# and calls the wrapper the way production does: as a bare simple command, not
# on the left of `||`.
#
# That distinction is the whole point. Bash propagates the errexit/ERR
# suppression of a `cmd || ...` context into subshells created inside it, so a
# harness that invoked the wrapper as `wrapper || rc=$?` would run it with a
# suppression production never has -- and would pass code that production
# kills. An external `bash` child gets a clean context.
CASE_RUNNER="${WORK}/case.sh"
cat >"${CASE_RUNNER}" <<'RUNNER'
set -Eeuo pipefail
phase="run_migrations"
dump_service_diagnostics() { echo "diagnostics-dumped"; }
on_phase_error() {
  status="$?"
  echo "deploy_phase=${phase} failed_command=${BASH_COMMAND:-unknown}"
  dump_service_diagnostics
  exit "${status}"
}
trap on_phase_error ERR

log() { echo "[harness] $*"; }
is_positive_integer() { case "$1" in '' | *[!0-9]*) return 1 ;; *) [ "$1" -gt 0 ] ;; esac; }

migration_failed_on_lock_contention() {
  log_path="${MIGRATION_LAST_LOG:-/tmp/adsecute-migrate.log}"
  [ -f "${log_path}" ] || return 1
  grep -qE "canceling statement due to lock timeout|55P03|lock_not_available|deadlock detected|40P01" "${log_path}"
}

run_migrations_service() {
  n=$(cat "${ATTEMPTS_FILE}"); n=$((n + 1)); echo "${n}" >"${ATTEMPTS_FILE}"
  # Mirrors the real function: toggles errexit internally and RESTORES set -e
  # before returning non-zero.
  set +e
  false
  rc=$?
  set -e
  if [ "${n}" -lt "${SUCCEED_ON}" ]; then
    printf '%s\n' "${FAILMSG}" >"${MIGRATION_LAST_LOG}"
    return "${rc}"
  fi
  echo "migrations complete" >"${MIGRATION_LAST_LOG}"
  return 0
}

if [ "${USE_BROKEN_FORM:-0}" = "1" ]; then
  # The ORIGINAL form the review rejected.
  run_migrations_service_with_contention_retry() {
    while :; do
      set +e
      run_migrations_service
      status=$?
      set -e
      echo "REACHED_CLASSIFIER status=${status}"
      return "${status}"
    done
  }
else
  run_migrations_service_with_contention_retry() {
    attempts="${DEPLOY_MIGRATION_CONTENTION_ATTEMPTS:-4}"
    is_positive_integer "${attempts}" || attempts=4
    attempt=1
    while :; do
      status=0
      run_migrations_service || status=$?
      [ "${status}" -eq 0 ] && return 0
      if ! migration_failed_on_lock_contention; then
        log "Migration failed for a reason other than lock contention; not retrying."
        return "${status}"
      fi
      if [ "${attempt}" -ge "${attempts}" ]; then
        log "Migration still blocked by lock contention after ${attempts} attempts."
        return "${status}"
      fi
      backoff="${HARNESS_BACKOFF_SECONDS:-$((attempt * 30))}"
      log "Migration attempt ${attempt}/${attempts} lost a lock race. Retrying in ${backoff}s."
      sleep "${backoff}"
      attempt=$((attempt + 1))
    done
  }
fi

# Bare call, exactly as the run_migrations phase does it.
run_migrations_service_with_contention_retry
RUNNER

run_case() {
  name="$1"; expect_rc="$2"; expect_attempts="$3"
  echo 0 >"${WORK}/attempts"
  : >"${WORK}/migrate.log"
  rc=0
  env MIGRATION_LAST_LOG="${WORK}/migrate.log" ATTEMPTS_FILE="${WORK}/attempts" \
      SUCCEED_ON="${SUCCEED_ON}" FAILMSG="${FAILMSG}" \
      HARNESS_BACKOFF_SECONDS=0 USE_BROKEN_FORM="${USE_BROKEN_FORM:-0}" \
      bash "${CASE_RUNNER}" >"${WORK}/case.out" 2>&1 || rc=$?
  got_attempts="$(cat "${WORK}/attempts")"
  if [ "${rc}" -eq "${expect_rc}" ] && [ "${got_attempts}" -eq "${expect_attempts}" ]; then
    echo "  PASS  ${name} (rc=${rc}, attempts=${got_attempts})"
  else
    echo "  FAIL  ${name}: expected rc=${expect_rc} attempts=${expect_attempts}, got rc=${rc} attempts=${got_attempts}"
    sed 's/^/        /' "${WORK}/case.out"
    failures=$((failures + 1))
  fi
}

echo "Retry wrapper under set -Eeuo pipefail + ERR trap"

# The regression this harness exists for: with the old set-+e form the ERR trap
# fired and killed the process here, so nothing below ever ran.
FAILMSG="ERROR: canceling statement due to lock timeout" SUCCEED_ON=3 \
  run_case "lock timeout clears on the 3rd attempt" 0 3

FAILMSG="ERROR: 55P03 lock_not_available" SUCCEED_ON=99 \
  run_case "permanent lock contention stops at the bound" 1 4

FAILMSG="ERROR: deadlock detected (40P01)" SUCCEED_ON=2 \
  run_case "deadlock is contention and retries" 0 2

# Negative cases: none of these may ever be retried.
FAILMSG="ERROR: canceling statement due to statement timeout" SUCCEED_ON=99 \
  run_case "statement_timeout is NOT contention (slow migration)" 1 1

FAILMSG="ERROR: column \"foo\" of relation \"bar\" already exists" SUCCEED_ON=99 \
  run_case "a real migration error is never retried" 1 1

FAILMSG="ERROR: out of shared memory" SUCCEED_ON=99 \
  run_case "resource exhaustion is never retried" 1 1

FAILMSG="ERROR: database query timed out after 30000ms" SUCCEED_ON=99 \
  run_case "an app-level query timeout is never retried" 1 1

# --- control: prove this harness detects the ORIGINAL broken form ----------
#
# Runs the exact `set +e; run_migrations_service; status=$?` shape the review
# rejected, in the same child-process conditions. It must NOT reach the
# classifier: the ERR trap exits first. If this ever prints REACHED_CLASSIFIER,
# the harness has stopped modelling production and every PASS above is worthless.
echo 0 >"${WORK}/attempts"
: >"${WORK}/migrate.log"
printf '%s\n' "ERROR: canceling statement due to lock timeout" >"${WORK}/migrate.log"
control_rc=0
env MIGRATION_LAST_LOG="${WORK}/migrate.log" ATTEMPTS_FILE="${WORK}/attempts" \
    SUCCEED_ON=99 FAILMSG="ERROR: canceling statement due to lock timeout" \
    USE_BROKEN_FORM=1 \
    bash "${CASE_RUNNER}" >"${WORK}/control.out" 2>&1 || control_rc=$?
if grep -q "REACHED_CLASSIFIER" "${WORK}/control.out"; then
  echo "  FAIL  control: the old set-+e form reached the classifier, so this harness does not model the production ERR trap"
  failures=$((failures + 1))
else
  echo "  PASS  control: the old set-+e form is killed by the ERR trap before classifying (rc=${control_rc}) -- the bug the review caught"
fi

if [ "${failures}" -ne 0 ]; then
  echo "FAILED: ${failures} case(s)"
  exit 1
fi
echo "All cases passed."
