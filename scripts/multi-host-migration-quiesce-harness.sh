#!/usr/bin/env bash
set -Eeuo pipefail

# The coordinator is sourced exactly as the workflow sources it. Network and
# remote work are replaced below; this harness proves only orchestration order,
# failure propagation, and best-effort restoration of every attempted host.
# shellcheck source=../.github/scripts/hetzner-ssh.sh
. "$(dirname "$0")/../.github/scripts/hetzner-ssh.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
failures=0

PRIMARY_DEPLOY_HOST="10.0.0.1"
PUBLIC_DEPLOY_HOST_IP="10.0.0.2"

run_case() {
  local name="$1"
  local fail_event="$2"
  local fail_status="$3"
  local expected_status="$4"
  local expected_events="$5"
  local event_file="${WORK}/events"
  local status=0

  : > "${event_file}"
  run_remote_phase_on_host() {
    local host="$1"
    local label="$2"
    local phase="$3"
    local event="${phase}:${label}:${host}"
    printf '%s\n' "${event}" >> "${event_file}"
    if [ -n "${fail_event}" ] && [ "${event}" = "${fail_event}" ]; then
      return "${fail_status}"
    fi
    return 0
  }

  run_migrations_with_all_schedulers_paused >/dev/null 2>&1 || status=$?
  if [ "${status}" -ne "${expected_status}" ]; then
    echo "  FAIL  ${name}: expected status ${expected_status}, got ${status}"
    failures=$((failures + 1))
    return
  fi
  if [ "$(cat "${event_file}")" != "${expected_events}" ]; then
    echo "  FAIL  ${name}: event order differed"
    diff -u <(printf '%s\n' "${expected_events}") "${event_file}" || true
    failures=$((failures + 1))
    return
  fi
  echo "  PASS  ${name}"
}

echo "Cross-host migration scheduler orchestration"

run_case \
  "both hosts stay paused through both migrations" \
  "" 0 0 \
  $'pause_scheduler:primary:10.0.0.1\npause_scheduler:public:10.0.0.2\nrun_migrations:primary:10.0.0.1\nrun_migrations:public:10.0.0.2\nresume_scheduler:public:10.0.0.2\nresume_scheduler:primary:10.0.0.1'

run_case \
  "a second-host pause failure restores every attempted host and runs no migration" \
  "pause_scheduler:public:10.0.0.2" 23 23 \
  $'pause_scheduler:primary:10.0.0.1\npause_scheduler:public:10.0.0.2\nresume_scheduler:public:10.0.0.2\nresume_scheduler:primary:10.0.0.1'

run_case \
  "a migration failure preserves its status and restores both hosts" \
  "run_migrations:primary:10.0.0.1" 41 41 \
  $'pause_scheduler:primary:10.0.0.1\npause_scheduler:public:10.0.0.2\nrun_migrations:primary:10.0.0.1\nresume_scheduler:public:10.0.0.2\nresume_scheduler:primary:10.0.0.1'

run_case \
  "a restore failure fails an otherwise successful window and does not skip the other host" \
  "resume_scheduler:public:10.0.0.2" 9 75 \
  $'pause_scheduler:primary:10.0.0.1\npause_scheduler:public:10.0.0.2\nrun_migrations:primary:10.0.0.1\nrun_migrations:public:10.0.0.2\nresume_scheduler:public:10.0.0.2\nresume_scheduler:primary:10.0.0.1'

if [ "${failures}" -ne 0 ]; then
  echo "FAILED: ${failures} case(s)"
  exit 1
fi
echo "All cases passed."
