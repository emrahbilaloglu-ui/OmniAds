#!/bin/bash
# Session-severance resilience for long operator phases.  (Requirement 1 and 2.)
#
#   scripts/operator/supervise.sh start verify                 detach a supervised read-only run
#   scripts/operator/supervise.sh start phase <phase-name>     detach a supervised wrapper phase
#   scripts/operator/supervise.sh status <run-id>
#   scripts/operator/supervise.sh wait   <run-id> [timeout_s]
#   scripts/operator/supervise.sh stop   <run-id>              ORDERED fail-closed shutdown
#
# WHY THIS EXISTS
#
# On 2026-07-30 a preflight died at 07:17:03Z with exit=143 because the process
# that invoked it went away. That alone would have been survivable. What made it
# damaging is what happened next: the dying driver's own trap tore the credential
# down — it closed the DB ControlMaster — while the remote wrapper was still
# 12 minutes into a scratch restore that needed exactly that credential. The
# wrapper then could not even run its own cleanup, so it left an 11 GB orphaned
# database behind and reported nothing, because that cleanup ends `|| true`.
#
# So there are two distinct defects and this script addresses both:
#
#   1. the run must not die merely because its invoker did          -> `setsid`
#   2. when a stop IS wanted, the credential must outlive the       -> ordered
#      remote work and its cleanup, not predecease them                shutdown
#
# WHY DETACH THE LOCAL DRIVER AND NOT THE REMOTE WRAPPER
#
# Agent forwarding is session-scoped: the forwarded socket on the app host exists
# only while that SSH connection exists. Detaching the REMOTE wrapper alone would
# hand it a long life and no credential — which is the incident, reproduced
# deliberately. The connection is the credential, so the thing that has to
# survive the invoker is the local end. `setsid` puts it in a new session, so a
# process-group SIGTERM or a SIGHUP aimed at the invoker cannot reach it.
#
# WHAT THIS DELIBERATELY DOES NOT DO
#
# It does not install anything on the host, does not write authorized_keys, and
# does not extend the credential's life beyond the run: the agent still holds one
# key, still dies with the run, and the lifetime is finite and enforced here.
set -euo pipefail

HERE="$(cd -P -- "$(dirname -- "$0")" && pwd -P)"
. "${HERE}/pins.sh"

# Runtime state lives OUTSIDE the repository: a script that ships in git must
# never write its working files into the working tree.
RUNS_DIR="${OP_RUNS_DIR:-${TMPDIR:-/tmp}/adsecute-operator-runs}"
mkdir -p "${RUNS_DIR}"

# Hard ceiling on a supervised run. Finite by construction: a supervisor that can
# outlive its own usefulness is just a persistent credential with extra steps.
# 4h matches the CI workflow's timeout-minutes: 240 for the same phases.
OP_MAX_LIFETIME_S="${OP_MAX_LIFETIME_S:-14400}"

# How long the remote wrapper is allowed to reach a terminal state after being
# signalled, before we stop waiting. Bounded, and derived below from what the
# wrapper's own cleanup has to do rather than from a guess.
OP_REMOTE_DRAIN_S="${OP_REMOTE_DRAIN_S:-300}"

die()  { printf 'FAIL %s\n' "$*" >&2; exit 1; }
note() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Payloads are piped from files rather than embedded as heredocs. Nested quoting
# and heredocs-inside-command-substitution have already produced two silent
# failures in this engagement; a file on stdin has no such edge, and the payload
# becomes independently readable and testable.
#
# MOCK: under the rehearsal seam this must never dial production. The stub answers
# from OP_MOCK_REMOTE_STATE so the ORDERING logic is exercised for real while the
# network is not.
ssh_ctl_payload() {
  local script="$1"
  if [ "${OP_SUPERVISE_MOCK:-0}" = "1" ]; then
    case "${script}" in
      *host-probe.sh)  printf 'wrappers=0 writers=0 unidentified=0\nREMOTE_STATE=%s\n' \
                         "${OP_MOCK_REMOTE_STATE:-TERMINAL}" ;;
      *host-signal.sh) printf 'resolve=%s\n' "${OP_MOCK_SIGNAL_RESULT:-no-pid-file}" ;;
      *)               printf 'TEARDOWN_VERDICT=CLEAN\n' ;;
    esac
    return 0
  fi
  ssh -o ForwardAgent=no -o ControlMaster=no -o ControlPath=none \
      -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 \
      -T "${OP_APP_HOST}" \
      "OP_STATE_DIR=$(printf %q "${OP_STATE_DIR}") \
       OP_DB_SSH=$(printf %q "${OP_DB_SSH}") \
       OP_REQUIRE_TERMINAL=1 bash -s" < "${script}"
}

# macOS ships no setsid(1). Python's os.setsid() is the same syscall, so this is
# a portability shim and not a weaker mechanism: the child really does become a
# session leader, which is exactly what stops the invoker's process-group signals
# and SIGHUP from reaching it. stdin is reopened on /dev/null because a closed or
# EOF pipe inherited from a dying parent is its own kind of kill signal.
detach() {
  if command -v setsid >/dev/null 2>&1; then
    setsid "$@"
  else
    python3 -c 'import os,sys
os.setsid()
fd = os.open(os.devnull, os.O_RDONLY)
os.dup2(fd, 0)
os.close(fd)
os.execvp(sys.argv[1], sys.argv[1:])' "$@"
  fi
}

run_dir()  { printf '%s/%s' "${RUNS_DIR}" "$1"; }
run_field() {
  local d f
  d="$(run_dir "$1")"; f="$2"
  [ -f "${d}/${f}" ] && cat "${d}/${f}" || printf ''
}

# ── ordered shutdown ────────────────────────────────────────────────────────
#
# The whole point of the exercise. Every step is observable, and an ambiguous
# step is a refusal rather than a shrug.
ordered_shutdown() {
  local id="$1" reason="$2"
  local d child waited state out
  d="$(run_dir "${id}")"
  child="$(run_field "${id}" child.pid)"

  note "ordered_shutdown begin run=${id} reason=${reason}"
  note "step 1/5 signal the exact remote run, credential still valid"

  # Resolve the exact PID on the host and validate it before signalling. Never a
  # pattern and never a sweep: `pkill -f hetzner-sync-cutover` would also kill a
  # concurrent run. host-phase.sh writes the PID beside its log precisely so a
  # later credential-free connection can find it.
  #
  # The wrapper installs `trap snapshot_cleanup_and_exit 143` on TERM, so this is
  # what lets its own scratch_db_drop and artifact discard run *while the
  # forwarded agent is still alive*. That ordering is the entire fix.
  out="$(ssh_ctl_payload "${HERE}/host-signal.sh" 2>&1 || echo resolve=unreachable)"
  printf '%s\n' "${out}" >>"${d}/shutdown.log" 2>/dev/null || true
  note "step 1/5 ${out}"
  case "${out}" in
    *signalled*)  printf '%s' "${out}" | sed -n 's/.*pid=\([0-9]\{1,\}\).*/\1/p' > "${d}/remote.pid" ;;
    *refused-identity-mismatch*)
      note "step 1/5 REFUSING: the recorded pid is not a cutover wrapper. Not signalling."
      ;;
  esac

  note "step 2/5 wait bounded for the remote to reach a terminal state"
  waited=0
  state=""
  while [ "${waited}" -lt "${OP_REMOTE_DRAIN_S}" ]; do
    state="$(ssh_ctl_payload "${HERE}/host-probe.sh" 2>/dev/null || echo REMOTE_STATE=UNREACHABLE)"
    case "${state}" in
      *REMOTE_STATE=TERMINAL*)    note "step 2/5 remote terminal after ${waited}s"; break ;;
      *REMOTE_STATE=UNREACHABLE*) note "step 2/5 host unreachable at ${waited}s; cannot assert terminal state" ;;
      *)                          note "step 2/5 remote still live at ${waited}s" ;;
    esac
    waited=$((waited + 10))
    sleep 10
  done
  printf '%s' "${state}" > "${d}/remote.final" 2>/dev/null || true

  case "${state}" in
    *REMOTE_STATE=TERMINAL*) : ;;
    *)
      # REFUSE AMBIGUITY. If the remote is still running, or we cannot see it,
      # closing the control master now would repeat the incident exactly.
      note "step 3/5 REFUSING to withdraw the credential: remote state is '${state}'"
      note "step 3/5 the DB control master and agent are LEFT IN PLACE on purpose."
      note "step 3/5 credential must be treated as LIVE; resolve the remote run first."
      printf 'ambiguous-remote-credential-left-live\n' > "${d}/status"
      note "ordered_shutdown end run=${id} result=refused-ambiguous"
      return 3
      ;;
  esac

  note "step 3/5 remote is terminal; its cleanup has had a valid credential throughout"
  note "step 4/5 close the DB control master (safe now, and only now)"
  ssh_ctl_payload "${HERE}/host-teardown.sh" \
    >>"${d}/shutdown.log" 2>&1 || note "step 4/5 host teardown reported a problem; see shutdown.log"

  note "step 5/5 stop the local child and its dedicated agent"
  if [ -n "${child}" ] && kill -0 "${child}" 2>/dev/null; then
    kill -TERM "${child}" 2>/dev/null || true
    waited=0
    while [ "${waited}" -lt 60 ] && kill -0 "${child}" 2>/dev/null; do
      sleep 2; waited=$((waited + 2))
    done
    kill -0 "${child}" 2>/dev/null && kill -KILL "${child}" 2>/dev/null || true
  fi
  printf 'stopped-ordered\n' > "${d}/status"
  note "ordered_shutdown end run=${id} result=ordered-complete"
  return 0
}

# ── the supervisor body, which runs detached ────────────────────────────────
supervise_body() {
  local id="$1" mode="$2" phase="${3:-}"
  local d child deadline now
  d="$(run_dir "${id}")"

  # A SIGHUP aimed at the invoker's session must not reach here, and if one does
  # arrive anyway it must mean ordered shutdown, never sudden death.
  trap 'ordered_shutdown "'"${id}"'" signal-TERM; exit 143' TERM
  trap 'ordered_shutdown "'"${id}"'" signal-HUP;  exit 129' HUP
  trap 'ordered_shutdown "'"${id}"'" signal-INT;  exit 130' INT

  printf '%s\n' "$$" > "${d}/supervisor.pid"
  deadline=$(( $(date +%s) + OP_MAX_LIFETIME_S ))
  printf '%s\n' "${deadline}" > "${d}/deadline.epoch"
  printf 'running\n' > "${d}/status"

  note "supervisor pid=$$ session=$(ps -o sess= -p $$ 2>/dev/null | tr -d ' ') run=${id}"
  note "bounded lifetime: ${OP_MAX_LIFETIME_S}s, hard deadline epoch ${deadline}"

  # The real work, as its own child so it can be signalled precisely.
  #
  # MOCK SEAM, for the disconnect rehearsal only. Deliberately narrow: it needs
  # OP_SUPERVISE_MOCK=1 *and* a run id that begins `mock-`, and it refuses to
  # apply to a `phase` run at all. A rehearsal that exercised the real production
  # path would not be a rehearsal, and a seam wide enough to be convenient here
  # would be wide enough to fire by accident later.
  if [ "${OP_SUPERVISE_MOCK:-0}" = "1" ] && [ "${mode}" != "phase" ]; then
    case "${id}" in
      mock-*)
        note "MOCK RUN: executing the rehearsal command, not run.sh"
        bash -c "${OP_SUPERVISE_MOCK_CMD:-true}" >>"${d}/run.log" 2>&1 &
        child=$!
        printf '%s\n' "${child}" > "${d}/child.pid"
        note "child pid=${child} mode=mock"
        while kill -0 "${child}" 2>/dev/null; do
          now="$(date +%s)"
          if [ "${now}" -ge "${deadline}" ]; then
            note "hard deadline reached; converting to ORDERED shutdown, not a kill"
            ordered_shutdown "${id}" deadline-expired || true
            printf 'deadline-expired\n' > "${d}/status"
            exit 124
          fi
          sleep 1
        done
        wait "${child}" 2>/dev/null; rc=$?
        printf '%s\n' "${rc}" > "${d}/exit.code"
        printf 'finished\n' > "${d}/status"
        note "child exited rc=${rc}; natural terminal result reached"
        exit "${rc}"
        ;;
    esac
  fi

  if [ "${mode}" = "phase" ]; then
    OP_RUN_DIR="${d}" "${HERE}/run.sh" phase "${phase}" >>"${d}/run.log" 2>&1 &
  else
    OP_RUN_DIR="${d}" "${HERE}/run.sh" verify >>"${d}/run.log" 2>&1 &
  fi
  child=$!
  printf '%s\n' "${child}" > "${d}/child.pid"
  note "child pid=${child} mode=${mode}${phase:+ phase=${phase}}"

  # Watch the child and the deadline. `wait` alone would ignore the deadline.
  while kill -0 "${child}" 2>/dev/null; do
    now="$(date +%s)"
    if [ "${now}" -ge "${deadline}" ]; then
      note "hard deadline reached; converting to ORDERED shutdown, not a kill"
      ordered_shutdown "${id}" deadline-expired || true
      printf 'deadline-expired\n' > "${d}/status"
      exit 124
    fi
    sleep 5
  done
  wait "${child}" 2>/dev/null; rc=$?
  printf '%s\n' "${rc}" > "${d}/exit.code"
  printf 'finished\n' > "${d}/status"
  note "child exited rc=${rc}; natural terminal result reached"
  exit "${rc}"
}

# ── command surface ─────────────────────────────────────────────────────────
CMD="${1:-}"
case "${CMD}" in
  start)
    MODE="${2:-}"; PHASE="${3:-}"
    case "${MODE}" in
      verify) [ -z "${PHASE}" ] || die "verify takes no phase argument" ;;
      phase)
        [ -n "${PHASE}" ] || die "phase requires a phase name"
        case " ${OP_PHASES} " in *" ${PHASE} "*) : ;; *) die "'${PHASE}' is not a legal phase" ;; esac
        ;;
      *) die "usage: $0 start verify | $0 start phase <name>" ;;
    esac

    # Same ordering as run.sh: usage first, then pins, then any connection.
    op_pins_require || exit 1

    # Refuse overlap on identity, not on a guess: one supervised run at a time.
    for existing in "${RUNS_DIR}"/*/; do
      [ -d "${existing}" ] || continue
      s="$(cat "${existing}/status" 2>/dev/null || echo)"
      p="$(cat "${existing}/supervisor.pid" 2>/dev/null || echo)"
      if [ "${s}" = "running" ] && [ -n "${p}" ] && kill -0 "${p}" 2>/dev/null; then
        die "run $(basename "${existing}") is still running (supervisor pid ${p}); refusing to overlap"
      fi
    done

    # A mock run is named `mock-…` so the seam above can key on identity rather
    # than on an env var alone.
    RUN_ID="${MODE}${PHASE:+-${PHASE}}-$(date -u +%Y%m%dT%H%M%SZ)-$$"
    if [ "${OP_SUPERVISE_MOCK:-0}" = "1" ]; then
      [ "${MODE}" != "phase" ] || die "the mock seam must never be used with a real phase"
      RUN_ID="mock-${RUN_ID}"
    fi
    D="$(run_dir "${RUN_ID}")"
    mkdir -p "${D}"; chmod 0700 "${D}"
    printf '%s\n' "${RUN_ID}" > "${D}/run.id"
    printf '%s\n' "${OP_SHA}"  > "${D}/target.sha"

    # setsid: a NEW session, so the invoker's death cannot reach it. Redirected
    # off the invoker's stdio too, because a closed pipe is its own kill signal.
    detach "$0" __supervise "${RUN_ID}" "${MODE}" "${PHASE}" \
      >>"${D}/supervisor.log" 2>&1 < /dev/null &
    disown 2>/dev/null || true

    # Confirm it really detached before claiming so.
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      [ -f "${D}/supervisor.pid" ] && break
      sleep 1
    done
    SP="$(cat "${D}/supervisor.pid" 2>/dev/null || echo)"
    [ -n "${SP}" ] || die "supervisor did not report a pid; see ${D}/supervisor.log"
    printf 'RUN_ID=%s\n' "${RUN_ID}"
    printf 'SUPERVISOR_PID=%s\n' "${SP}"
    # PGID, not `ps -o sess=`: macOS leaves the sess field as 0, so it proves
    # nothing. A supervisor whose PGID equals its own PID is a group leader in a
    # new session, which is what makes the invoker's group signals miss it.
    printf 'SUPERVISOR_PGID=%s\n' "$(ps -o pgid= -p "${SP}" 2>/dev/null | tr -d ' ')"
    printf 'INVOKER_PGID=%s\n'    "$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"
    printf 'RUN_DIR=%s\n' "${D}"
    ;;

  __supervise)  # internal
    supervise_body "${2}" "${3}" "${4:-}"
    ;;

  status)
    ID="${2:-}"; [ -n "${ID}" ] || die "status needs a run id"
    D="$(run_dir "${ID}")"; [ -d "${D}" ] || die "no such run ${ID}"
    printf 'run=%s\nstatus=%s\nsupervisor_pid=%s\nchild_pid=%s\nremote_pid=%s\nexit=%s\ndeadline_in_s=%s\n' \
      "${ID}" "$(run_field "${ID}" status)" "$(run_field "${ID}" supervisor.pid)" \
      "$(run_field "${ID}" child.pid)" "$(run_field "${ID}" remote.pid)" \
      "$(run_field "${ID}" exit.code)" \
      "$(( $(run_field "${ID}" deadline.epoch 2>/dev/null || echo 0) - $(date +%s) ))"
    SP="$(run_field "${ID}" supervisor.pid)"
    printf 'supervisor_alive=%s\n' "$([ -n "${SP}" ] && kill -0 "${SP}" 2>/dev/null && echo yes || echo no)"
    ;;

  wait)
    ID="${2:-}"; TMO="${3:-14400}"; [ -n "${ID}" ] || die "wait needs a run id"
    SP="$(run_field "${ID}" supervisor.pid)"
    [ -n "${SP}" ] || die "run ${ID} has no supervisor pid"
    W=0
    while kill -0 "${SP}" 2>/dev/null; do
      [ "${W}" -ge "${TMO}" ] && die "wait timed out after ${TMO}s; run still going"
      sleep 5; W=$((W + 5))
    done
    printf 'run=%s status=%s exit=%s\n' "${ID}" "$(run_field "${ID}" status)" "$(run_field "${ID}" exit.code)"
    ;;

  stop)
    ID="${2:-}"; [ -n "${ID}" ] || die "stop needs a run id"
    [ -d "$(run_dir "${ID}")" ] || die "no such run ${ID}"
    ordered_shutdown "${ID}" operator-requested
    ;;

  *) die "usage: $0 {start|status|wait|stop} ..." ;;
esac
