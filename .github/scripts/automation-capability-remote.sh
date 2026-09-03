#!/usr/bin/env bash
# PRE-DEPLOY AUDIT — Phase A -> B capability-open, the host-side phases.
#
# A deliberately LITERAL translation of `lib/meta/automation-capability-
# orchestrator.ts`'s `runCapabilityOpen`/`runCapabilityClose` — same order,
# same rollback trigger, same "never swallow a failure into success" rule.
# That module's tests are what proves the SEQUENCE is safe; this script is
# what actually executes it, over `docker compose` against the real host.
#
# CONCATENATED with `automation-capability-env.sh` over stdin into one `bash
# -s` invocation — the same idiom `run_remote_phase_on_host` in
# `.github/scripts/hetzner-ssh.sh` already uses for the main deploy phases
# (library first, phase script second, one process, no file ever landing on
# the host as a stray artifact). `atomic_set_env_var`, `atomic_restore_env_
# backup`, `count_env_var_lines` and `read_env_var_value` are therefore
# ALREADY DEFINED by the time this file's own code runs; it does not
# `source` anything itself. Invoked with PHASE set to one of:
#
#   capability_preflight   — read-only. Runs the automation-off readback +
#                             the six-business check inside the worker
#                             container and exits non-zero on any blocker.
#   capability_open        — baseline -> preflight -> write true ->
#                             recreate+verify(web AND worker) -> preflight
#                             again. On ANY failure after the baseline is
#                             proven: restore + force-close + verify closed,
#                             then exit non-zero regardless of the restore's
#                             own outcome (and the restore's OWN failure is
#                             its own named blocker, never swallowed).
#   capability_close       — write false -> recreate+verify(web AND worker).
#                             NEVER gated on the DB-backed preflight, and
#                             never gated on the baseline check either — a
#                             close must be reachable even when the database
#                             or the running containers are in an unknown
#                             state, which is exactly the situation an
#                             operator would be closing capability in
#                             response to.
#
# NEITHER phase EVER deploys a different release. `docker compose pull` /
# `up -d --force-recreate` here always run with `APP_IMAGE_TAG`/
# `APP_BUILD_ID` pinned to `EXPECTED_SHA` — the SAME exact commit the
# workflow's own freshness gate already validated is current main HEAD, and
# (for `capability_open`) the SAME exact commit `capability_verify_running_
# baseline` below proves is ALREADY what web and worker are running BEFORE
# this script writes anything. Recreating containers is the mechanism that
# makes an env-file change observable to a running process (env vars are
# read once at process start); it is not a deploy of new code.
#
# Every phase prints ONE redacted JSON summary line prefixed
# `CAPABILITY_JSON: ` to stdout — the workflow step greps for that prefix and
# writes it to the artifact file. Redacted: it never contains `.env.production`
# content beyond the single key this script manages, never a token, never a
# full file dump.
set -euo pipefail

PHASE="${PHASE:-}"
REMOTE_APP_DIR="${REMOTE_APP_DIR:-/var/www/adsecute}"
ENV_FILE="${REMOTE_APP_DIR}/.env.production"
ENV_KEY="META_AUTOMATION_LIVE_WRITES"
EXPECTED_SHA="${EXPECTED_SHA:?EXPECTED_SHA is required}"

if ! command -v atomic_set_env_var >/dev/null 2>&1; then
  echo "atomic_set_env_var is not defined — this script must be concatenated" >&2
  echo "AFTER automation-capability-env.sh in the same shell invocation." >&2
  exit 1
fi

log() { printf '\n[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }

# ── read-only preflight ──────────────────────────────────────────────────
capability_run_preflight() {
  # Runs INSIDE the worker container, where DATABASE_URL is the real
  # production connection — the same pattern `promote-release-gate-mode.yml`
  # already uses for `sync-control-plane-verify.ts`.
  docker compose exec -T worker \
    node --import tsx scripts/automation-capability-preflight-cli.ts
}

# ── runtime verification: env value + build id, no DB ───────────────────
capability_wait_for_build_info() {
  local attempts="${1:-30}" sleep_seconds="${2:-3}" attempt=1
  while [ "${attempt}" -le "${attempts}" ]; do
    if body="$(curl -fsS http://127.0.0.1:3000/api/build-info 2>/dev/null)"; then
      printf '%s\n' "${body}"
      return 0
    fi
    sleep "${sleep_seconds}"
    attempt=$((attempt + 1))
  done
  return 1
}

# capability_container_running SERVICE — true only if compose reports a
# container for SERVICE and docker itself reports it State.Running=true.
capability_container_running() {
  local service="$1" cid
  cid="$(docker compose ps -q "${service}" 2>/dev/null)" || return 1
  if [ -z "${cid}" ]; then
    echo "capability_container_running: no container for service '${service}'" >&2
    return 1
  fi
  local running
  running="$(docker inspect --format '{{.State.Running}}' "${cid}" 2>/dev/null)" || return 1
  [ "${running}" = "true" ]
}

# capability_container_label SERVICE LABEL — the image label's value, read
# from the ACTUAL running container (not the compose file, not the local
# image cache by tag) so a mis-wired compose service or a stale local image
# under the same tag cannot pass unnoticed.
capability_container_label() {
  local service="$1" label="$2" cid value
  cid="$(docker compose ps -q "${service}" 2>/dev/null)" || return 1
  if [ -z "${cid}" ]; then
    echo "capability_container_label: no container for service '${service}'" >&2
    return 1
  fi
  value="$(docker inspect --format "{{index .Config.Labels \"${label}\"}}" "${cid}" 2>/dev/null)" || return 1
  printf '%s' "${value}"
}

# capability_verify_container SERVICE ROLE — running, at the exact expected
# SHA (by the image's OWN `org.opencontainers.image.revision` label, not
# just an env var the process could theoretically disagree with), and
# labeled with the role the Dockerfile actually gives that service.
capability_verify_container() {
  local service="$1" role="$2" revision actual_role

  if ! capability_container_running "${service}"; then
    echo "capability_verify_container: ${service} is not running" >&2
    return 1
  fi

  revision="$(capability_container_label "${service}" org.opencontainers.image.revision)" || {
    echo "capability_verify_container: could not read ${service}'s revision label" >&2
    return 1
  }
  if [ "${revision}" != "${EXPECTED_SHA}" ]; then
    echo "capability_verify_container: ${service} image revision is '${revision}', expected '${EXPECTED_SHA}'" >&2
    return 1
  fi

  actual_role="$(capability_container_label "${service}" com.adsecute.release.role)" || {
    echo "capability_verify_container: could not read ${service}'s role label" >&2
    return 1
  }
  if [ "${actual_role}" != "${role}" ]; then
    echo "capability_verify_container: ${service} role label is '${actual_role}', expected '${role}'" >&2
    return 1
  fi
}

# capability_normalize_gate_value RAW — mirrors lib/meta/release-gates.ts's
# parseGate() EXACTLY: trim + lowercase, then an exact "true" comparison.
# Prints "true" or "false". A bash `[ "$x" = "true" ]` strict check would
# treat "TRUE", " true " or "True" as closed even though the app itself
# (which the live-env checks below run INSIDE, via node) treats every one
# of those as OPEN — this is the one normalization every gate-value
# comparison in this file must go through, file-based or live.
capability_normalize_gate_value() {
  local raw="$1" trimmed lowered
  trimmed="$(printf '%s' "${raw}" | tr -d '\n\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  lowered="$(printf '%s' "${trimmed}" | tr '[:upper:]' '[:lower:]')"
  if [ "${lowered}" = "true" ]; then
    echo "true"
  else
    echo "false"
  fi
}

# capability_read_live_gate_value SERVICE — SERVICE's OWN live process view
# of ${ENV_KEY}, read via `docker compose exec`, normalized INSIDE that same
# node process the exact way lib/meta/release-gates.ts's parseGate() does
# (trim + lowercase, then === "true") — never assumed from the env FILE
# this script writes. Prints "true" or "false"; returns non-zero only if
# the read itself could not be performed.
capability_read_live_gate_value() {
  local service="$1"
  docker compose exec -T "${service}" node -e \
    "process.stdout.write((process.env.${ENV_KEY} || '').trim().toLowerCase() === 'true' ? 'true' : 'false')" 2>/dev/null
}

# capability_verify_running_env SERVICE INTENDED — the SERVICE's OWN live
# process view of ${ENV_KEY}. Checked on BOTH web and worker by every
# caller below: the scheduled budget-automation job that actually reads
# this gate runs in the WORKER (`SYNC_WORKER_MODE=1`), so verifying only
# web would leave the one process that matters unchecked.
capability_verify_running_env() {
  local service="$1" intended="$2" observed
  observed="$(capability_read_live_gate_value "${service}")" || {
    echo "capability_verify_running_env: could not read ${ENV_KEY} from ${service}" >&2
    return 1
  }
  if [ "${observed}" != "${intended}" ]; then
    echo "capability_verify_running_env: ${service} reports ${ENV_KEY}=${observed}, expected ${intended}" >&2
    return 1
  fi
}

# capability_verify_running_baseline — proves, from what is ALREADY
# running, that web AND worker are at the exact deployed SHA and that
# ${ENV_KEY} is NOT currently open — BEFORE this script writes or
# recreates anything. The workflow's own "current main HEAD" freshness gate
# (upstream of this script) only proves EXPECTED_SHA is the latest commit;
# it says nothing about what is actually deployed and running. This does.
#
# "Not currently open" is checked THREE ways, ALL required: the env FILE
# (normalized, not a strict `= "true"`), web's LIVE process value, and
# worker's LIVE process value — the file alone can be stale or simply wrong
# relative to what the running processes actually observe, and the FILE was
# the only thing checked before this fix. Any read failure on any of the
# three is a refusal: unknown is never treated as closed.
#
# Read-only: no pull, no recreate, no write. capability_open calls this
# FIRST and refuses outright on any failure; capability_close never calls
# it (a close must be reachable from an unknown or broken baseline).
capability_verify_running_baseline() {
  local service
  for service in web worker; do
    capability_verify_container "${service}" "${service}-runner" || return 1
  done

  if [ ! -r "${ENV_FILE}" ]; then
    echo "capability_verify_running_baseline: ${ENV_FILE} is missing or unreadable — refusing" >&2
    return 1
  fi

  local file_raw file_normalized
  file_raw="$(read_env_var_value "${ENV_FILE}" "${ENV_KEY}")"
  file_normalized="$(capability_normalize_gate_value "${file_raw}")"
  if [ "${file_normalized}" = "true" ]; then
    echo "capability_verify_running_baseline: the env FILE's ${ENV_KEY} normalizes to true (raw value: '${file_raw}') — refusing capability_open without an explicit close first" >&2
    return 1
  fi

  local web_live
  web_live="$(capability_read_live_gate_value web)" || {
    echo "capability_verify_running_baseline: could not read web's LIVE ${ENV_KEY} — refusing (unknown is never treated as closed)" >&2
    return 1
  }
  if [ "${web_live}" = "true" ]; then
    echo "capability_verify_running_baseline: web's LIVE ${ENV_KEY} is already true — refusing (the running process disagrees with the env file, or a prior open never fully closed)" >&2
    return 1
  fi

  local worker_live
  worker_live="$(capability_read_live_gate_value worker)" || {
    echo "capability_verify_running_baseline: could not read worker's LIVE ${ENV_KEY} — refusing (unknown is never treated as closed)" >&2
    return 1
  }
  if [ "${worker_live}" = "true" ]; then
    echo "capability_verify_running_baseline: worker's LIVE ${ENV_KEY} is already true — refusing (the process that actually reads this gate disagrees with the env file)" >&2
    return 1
  fi

  # Not `local` — deliberately leaks into the caller (a plain function call,
  # same shell process, never invoked via `$(...)` here) so `capability_open`
  # can embed the ACTUAL pre-mutation state in the artifact, not just a bare
  # pass/fail declaration.
  CAP_BEFORE_JSON="$(capability_state_snapshot)"
}

# capability_state_snapshot — web/worker's OWN observed image revision and
# live ${ENV_KEY} value (normalized, see capability_read_live_gate_value),
# as one small JSON blob. Read-only; called both BEFORE any mutation (from
# the baseline check) and AFTER (from capability_recreate_and_verify), so
# the artifact carries real measured facts at both points instead of only
# a boolean.
capability_state_snapshot() {
  local web_revision web_env worker_revision worker_env
  web_revision="$(capability_container_label web org.opencontainers.image.revision 2>/dev/null)" || web_revision=""
  web_env="$(capability_read_live_gate_value web)" || web_env=""
  worker_revision="$(capability_container_label worker org.opencontainers.image.revision 2>/dev/null)" || worker_revision=""
  worker_env="$(capability_read_live_gate_value worker)" || worker_env=""

  WEB_REVISION="${web_revision}" WEB_ENV="${web_env}" WORKER_REVISION="${worker_revision}" WORKER_ENV="${worker_env}" python3 -c '
import json, os
print(json.dumps({
    "web": {"revision": os.environ.get("WEB_REVISION") or None, "envValue": os.environ.get("WEB_ENV") or None},
    "worker": {"revision": os.environ.get("WORKER_REVISION") or None, "envValue": os.environ.get("WORKER_ENV") or None},
}))
'
}

# capability_recreate_and_verify INTENDED — pulls the exact SHA images,
# force-recreates web AND worker, then verifies BOTH: running, at the exact
# image revision, correctly role-labeled, web's own build-info endpoint,
# and BOTH containers' own live view of ${ENV_KEY}. Every step's exit
# status is checked EXPLICITLY with `||`/`if !` — never left to bare
# `set -e`, which bash disables for the entire body of a function invoked
# as part of an `if`/`&&` condition (exactly how every caller below invokes
# this one), so an unchecked `docker compose pull`/`up` failure here would
# otherwise silently fall through to the verification steps instead of
# stopping immediately.
capability_recreate_and_verify() {
  local intended="$1" # "true" or "false"

  export APP_IMAGE_TAG="${EXPECTED_SHA}"
  export APP_BUILD_ID="${EXPECTED_SHA}"

  log "Pulling exact SHA images (web + worker)"
  if ! docker compose pull web worker; then
    echo "capability_recreate_and_verify: docker compose pull failed" >&2
    return 1
  fi

  log "Recreating web and worker"
  if ! docker compose up -d --force-recreate web worker; then
    echo "capability_recreate_and_verify: docker compose up failed" >&2
    return 1
  fi

  local service
  for service in web worker; do
    capability_verify_container "${service}" "${service}-runner" || return 1
  done

  log "Checking runtime build info (web)"
  local build_json build_id
  build_json="$(capability_wait_for_build_info 30 3)" || {
    echo "capability_recreate_and_verify: build-info never responded" >&2
    return 1
  }
  build_id="$(printf '%s' "${build_json}" | python3 -c 'import json,sys; print((json.load(sys.stdin).get("buildId") or ""), end="")')"
  if [ "${build_id}" != "${EXPECTED_SHA}" ]; then
    echo "capability_recreate_and_verify: build id is '${build_id}', expected '${EXPECTED_SHA}'" >&2
    return 1
  fi

  log "Checking the runtime's OWN view of ${ENV_KEY} on web AND worker"
  for service in web worker; do
    capability_verify_running_env "${service}" "${intended}" || return 1
  done

  # Not `local` — same reasoning as CAP_BEFORE_JSON above: every caller of
  # this function invokes it as a plain call, not via `$(...)`, so this
  # leaks into the caller on purpose. Captured LAST, after every check
  # above has already passed, so it reflects the verified end state.
  CAP_AFTER_JSON="$(capability_state_snapshot)"

  echo "runtime verified: build_id=${build_id} ${ENV_KEY}=${intended} web+worker running at revision ${EXPECTED_SHA}"
}

# emit_capability_json ACTION RESULT ROLLED_BACK ROLLBACK_VERIFIED
#                       BLOCKERS_CSV BEFORE_STATE_JSON AFTER_STATE_JSON
#                       [BEFORE_PREFLIGHT_JSON] [AFTER_PREFLIGHT_JSON]
#
# Builds the redacted summary line from ENV VARS (never shell-into-python
# string interpolation, which would be one stray quote away from a syntax
# error or, worse, an injection). BEFORE_STATE_JSON/AFTER_STATE_JSON are
# `capability_state_snapshot`'s own output (or the literal string "null");
# the two preflight args are the raw `capability_run_preflight` JSON output
# from before and after the mutation, or "null" — their `perBusiness` array
# (the exact six-business status list, not a bare count) is folded into the
# corresponding state blob. Every value this reads is either a fixed
# literal this script sets, already-serialized JSON this script itself
# produced, or EXPECTED_SHA, which the workflow has already validated as 40
# lowercase hex characters — this artifact is REAL measured evidence, not a
# bare declaration.
emit_capability_json() {
  ACTION="$1" RESULT="$2" ROLLED_BACK="$3" ROLLBACK_VERIFIED="$4" BLOCKERS_CSV="$5"   BEFORE_STATE_JSON="${6:-null}" AFTER_STATE_JSON="${7:-null}"   BEFORE_PREFLIGHT_JSON="${8:-null}" AFTER_PREFLIGHT_JSON="${9:-null}"   EXPECTED_SHA="${EXPECTED_SHA}" ENV_KEY="${ENV_KEY}"   python3 -c '
import json, os

def load(name):
    try:
        return json.loads(os.environ.get(name) or "null")
    except Exception:
        return None

def with_six_business(state, preflight):
    state = state if isinstance(state, dict) else {}
    if isinstance(preflight, dict):
        state = {**state,
                  "sixBusinessStatus": preflight.get("perBusiness"),
                  "preflightSectionsSeen": preflight.get("sectionsSeen"),
                  "preflightBlockers": preflight.get("blockers")}
    return state or None

blockers_csv = os.environ.get("BLOCKERS_CSV", "")
blockers = [b for b in blockers_csv.split(",") if b]
before = with_six_business(load("BEFORE_STATE_JSON"), load("BEFORE_PREFLIGHT_JSON"))
after = with_six_business(load("AFTER_STATE_JSON"), load("AFTER_PREFLIGHT_JSON"))
print("CAPABILITY_JSON: " + json.dumps({
    "action": os.environ["ACTION"],
    "result": os.environ["RESULT"],
    "blockers": blockers,
    "rolledBack": os.environ["ROLLED_BACK"] == "true",
    "rollbackVerified": os.environ["ROLLBACK_VERIFIED"] == "true",
    "expectedSha": os.environ["EXPECTED_SHA"],
    "envKey": os.environ["ENV_KEY"],
    "before": before,
    "after": after,
}))
'
}

# capability_rollback_to_closed BACKUP — the ONE recovery path every
# post-backup failure in capability_open funnels through. Tries
# atomic_restore_env_backup(BACKUP) first; if that succeeds, force-
# recreate+verify CLOSED (both runtime gates, via capability_recreate_
# and_verify). If the RESTORE itself fails, that failure is NEVER
# swallowed into a false "recovered" — but recovery is not abandoned
# either: an explicit, INDEPENDENT forced write of "false" is attempted
# (a fresh atomic_set_env_var call, not dependent on the broken backup),
# followed by the SAME two-runtime-gate CLOSED verification. Sets (not
# `local` — leaked to the caller, a plain function call in the same shell
# process) CAP_ROLLBACK_OK ("true" only if the runtime ends up verified
# CLOSED by EITHER path) and CAP_ROLLBACK_BLOCKER (always names restore_
# failed when the restore itself failed, even if the forced write then
# recovered the runtime — visibility of that failure is never dropped).
# The caller's own overall `result` must ALWAYS stay "fail" here
# regardless of CAP_ROLLBACK_OK — a rollback situation is never a pass.
capability_rollback_to_closed() {
  local backup="$1"
  CAP_ROLLBACK_OK="false"
  CAP_ROLLBACK_BLOCKER=""

  if atomic_restore_env_backup "${ENV_FILE}" "${backup}"; then
    if capability_recreate_and_verify "false" >/dev/null 2>&1; then
      CAP_ROLLBACK_OK="true"
    else
      CAP_ROLLBACK_BLOCKER="restore_recreate_verify_failed"
    fi
    return
  fi

  # The restore itself failed. NOT swallowed: restore_failed is always
  # named below. But recovery is still attempted via an independent path —
  # a fresh forced write of "false" does not depend on the backup file at
  # all, so a corrupt/missing/unreadable backup does not necessarily strand
  # the host open when a plain write would still succeed.
  log "Backup restore FAILED — attempting an independent forced-false write as a second recovery path"
  if atomic_set_env_var "${ENV_FILE}" "${ENV_KEY}" "false" >/dev/null 2>&1 \
    && capability_recreate_and_verify "false" >/dev/null 2>&1; then
    CAP_ROLLBACK_OK="true"
    CAP_ROLLBACK_BLOCKER="restore_failed"
  else
    CAP_ROLLBACK_BLOCKER="restore_failed"
  fi
}

capability_open() {
  local backup restore_ok="false" rolled_back="false" result="fail" blockers=""
  local before_preflight_json="null" after_preflight_json="null"
  CAP_BEFORE_JSON="null"
  CAP_AFTER_JSON="null"

  log "Baseline — proving web+worker are ALREADY at the exact expected SHA and capability is currently closed, before touching anything"
  if ! capability_verify_running_baseline; then
    emit_capability_json "open" "refused" "false" "false" "baseline_refused" "${CAP_BEFORE_JSON}" "null"
    return 1
  fi

  log "Preflight — before touching anything"
  local initial_preflight_status
  if before_preflight_json="$(capability_run_preflight)"; then
    initial_preflight_status=0
  else
    initial_preflight_status=$?
  fi
  if [ "${initial_preflight_status}" -ne 0 ]; then
    emit_capability_json "open" "refused" "false" "false" "preflight_refused" \
      "${CAP_BEFORE_JSON}" "null" "${before_preflight_json}" "null"
    return 1
  fi

  # The backup's path is recorded to a marker FILE (not just stdout) the
  # instant atomic_set_env_var creates it — BEFORE the strip/write/rename
  # is even attempted — so it is known here regardless of whether
  # atomic_set_env_var itself later reports success. This is what makes it
  # possible to roll back a failure discovered only AFTER the rename (the
  # post-write mode/owner/count verification inside atomic_set_env_var):
  # without it, a caller reading only the function's own return value has
  # no way to learn which backup to restore.
  log "Writing ${ENV_KEY}=true (atomic, backed up)"
  local backup_marker
  backup_marker="$(mktemp)"
  local write_ok="true"
  if ! backup="$(atomic_set_env_var "${ENV_FILE}" "${ENV_KEY}" "true" "${backup_marker}")"; then
    write_ok="false"
  fi

  local recovered_backup=""
  if [ -s "${backup_marker}" ]; then
    recovered_backup="$(cat "${backup_marker}")"
  fi
  rm -f "${backup_marker}"

  if [ "${write_ok}" != "true" ]; then
    if [ -z "${recovered_backup}" ]; then
      # No backup was ever created — cp -p itself failed, so the live file
      # is provably untouched. Nothing to roll back.
      emit_capability_json "open" "fail" "false" "false" "initial_backup_failed" \
        "${CAP_BEFORE_JSON}" "null" "${before_preflight_json}" "null"
      return 1
    fi
    # A backup WAS created — the write may have partially or fully landed
    # on disk (a post-rename verification failure is exactly this case).
    # Route through the SAME recovery path any later failure uses, never a
    # bare "nothing happened" story.
    log "FAILURE during the write itself (discovered after the backup was already created) — rolling back"
    capability_rollback_to_closed "${recovered_backup}"
    emit_capability_json "open" "fail" "true" "${CAP_ROLLBACK_OK}" "initial_write_failed,${CAP_ROLLBACK_BLOCKER}" \
      "${CAP_BEFORE_JSON}" "${CAP_AFTER_JSON}" "${before_preflight_json}" "null"
    return 1
  fi

  local open_recreate_ok="false" open_final_preflight_status=1
  if capability_recreate_and_verify "true"; then
    if after_preflight_json="$(capability_run_preflight)"; then
      open_final_preflight_status=0
      open_recreate_ok="true"
    fi
  fi

  if [ "${open_recreate_ok}" = "true" ]; then
    result="pass"
  else
    log "FAILURE after the write — restoring the backup and forcing closed"
    rolled_back="true"
    capability_rollback_to_closed "${backup}"
    restore_ok="${CAP_ROLLBACK_OK}"
    blockers="post_write_failure,${CAP_ROLLBACK_BLOCKER}"
    result="fail"
    : "${open_final_preflight_status}" # recorded via the JSON below, not otherwise used
  fi

  emit_capability_json "open" "${result}" "${rolled_back}" "${restore_ok}" "${blockers}" \
    "${CAP_BEFORE_JSON}" "${CAP_AFTER_JSON}" "${before_preflight_json}" "${after_preflight_json}"

  [ "${result}" = "pass" ]
}

capability_close() {
  local backup result="fail" blockers=""
  CAP_BEFORE_JSON="null"
  CAP_AFTER_JSON="null"

  # Read-only, best-effort — NEVER gates the write below. If web/worker are
  # in an unknown state (which is exactly when an operator would be closing
  # capability), this simply reports a null "before" rather than refusing.
  CAP_BEFORE_JSON="$(capability_state_snapshot 2>/dev/null)" || CAP_BEFORE_JSON="null"

  log "Writing ${ENV_KEY}=false (atomic, backed up) — NOT gated on any DB read or running-baseline check"
  if ! backup="$(atomic_set_env_var "${ENV_FILE}" "${ENV_KEY}" "false")"; then
    emit_capability_json "close" "fail" "false" "false" "initial_write_failed" "${CAP_BEFORE_JSON}" "null"
    return 1
  fi
  : "${backup}" # recorded in the log above; the artifact only needs the outcome

  if capability_recreate_and_verify "false"; then
    result="pass"
  else
    blockers="close_verify_failed"
  fi

  emit_capability_json "close" "${result}" "false" "false" "${blockers}" "${CAP_BEFORE_JSON}" "${CAP_AFTER_JSON}"

  [ "${result}" = "pass" ]
}

case "${PHASE}" in
  capability_preflight)
    log "Read-only preflight"
    capability_run_preflight
    ;;
  capability_open)
    capability_open
    ;;
  capability_close)
    capability_close
    ;;
  *)
    echo "unknown capability phase: ${PHASE}" >&2
    exit 1
    ;;
esac
