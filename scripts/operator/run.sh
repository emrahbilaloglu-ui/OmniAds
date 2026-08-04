#!/bin/bash
# One-shot, fail-closed, agent-forwarded operator session for the installed
# pinned cutover runner.
#
#   scripts/operator/run.sh verify              read-only; proves the credential path only
#   scripts/operator/run.sh phase <phase-name>  runs exactly ONE wrapper phase
#
# WHY A DEDICATED EPHEMERAL AGENT, NOT THE LOGIN AGENT
#
# Forwarding an agent lends every identity it holds to anyone with root on the
# far side, for the life of the connection. The login agent happens to hold
# exactly one identity right now, but "happens to" is not an invariant: a later
# `ssh-add` in any terminal would silently widen what production can use. This
# starts its own agent, loads ONE key into it, and forwards that — so the bound
# is structural rather than a hope, and teardown is provable on both ends.
#
# WHY NOT `ssh -A`
#
# `-A` is a bare flag, invisible in a crowded process list and unpairable with
# the options that make forwarding safe. Every option below is spelled out: no
# multiplexing, no socket that can outlive this process, no prompting, and a
# named agent socket this script owns and destroys.
set -euo pipefail

HERE="$(cd -P -- "$(dirname -- "$0")" && pwd -P)"
. "${HERE}/pins.sh"

MODE="${1:-}"
PHASE="${2:-}"

die() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
note() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

case "${MODE}" in
  verify) [ -z "${PHASE}" ] || die "verify takes no phase argument" ;;
  phase)
    [ -n "${PHASE}" ] || die "phase requires a phase name"
    case " ${OP_PHASES} " in
      *" ${PHASE} "*) : ;;
      *) die "'${PHASE}' is not one of: ${OP_PHASES}" ;;
    esac
    ;;
  *) die "usage: $0 verify | $0 phase <${OP_PHASES// /|}>" ;;
esac

# Release pins are checked AFTER argument parsing so a usage mistake still gets a
# usage message, and BEFORE anything opens a connection: a run with an unset
# target would otherwise compare host state against "" and pass vacuously.
op_pins_require || exit 1

LOG_DIR="${OP_LOG_DIR:-${TMPDIR:-/tmp}/adsecute-operator-logs}"
mkdir -p "${LOG_DIR}"
LOG="${LOG_DIR}/operator-${MODE}${PHASE:+-${PHASE}}-$(date -u +%Y%m%dT%H%M%SZ).log"
: > "${LOG}"
chmod 0600 "${LOG}"

# ── Redaction: DROP whole lines, never substitute ───────────────────────────
#
# A substitution that matches the key but not the value leaves the secret in
# place while looking redacted. That is not hypothetical: a `s/Bearer[^ ]*/…/`
# filter earlier in this engagement printed a live cron token in full, because
# the token sat after a space. So nothing is rewritten — a line that could carry
# a value does not travel at all. Raw crontab and env bodies are never requested
# in the first place; the host scripts emit only hashes, counts and key names.
OP_DENY='(secret|token|password|passwd|api[_-]?key|authorization|bearer|PRIVATE KEY|BEGIN OPENSSH|DATABASE_URL|_URL=)'
redact() { grep -aviE "${OP_DENY}" || true; }

AGENT_SOCK="$(mktemp -u "${TMPDIR:-/tmp}/op-agent.XXXXXX")"
AGENT_PID=""
TEARDOWN_RESULT="not-attempted"
TEARDOWN_DONE=0

# Set to 1 the instant a forwarding connection is actually attempted. Teardown
# needs to distinguish "never forwarded" from "forwarded but lost track of the
# socket": the first is genuinely nothing to prove, the second is a live
# credential with missing evidence, and the old code reported both as GONE.
FORWARDING_OCCURRED=0

# When run under supervise.sh this is the run directory; the remote wrapper's
# PID is written here so ordered shutdown can signal that exact process instead
# of pattern-matching for it.
OP_RUN_DIR="${OP_RUN_DIR:-}"

# Auth for the teardown check itself: the agent is still needed to log in, but
# forwarding is OFF, so this connection lends nothing.
ssh_noforward() {
  ssh -o ForwardAgent=no -o ControlMaster=no -o ControlPath=none \
      -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 \
      -o IdentitiesOnly=yes -o IdentityAgent="${AGENT_SOCK}" \
      -T "${OP_APP_HOST}" "$@"
}

# Runs on success, failure, interruption and timeout alike. Order matters: the
# remote proof needs the agent to authenticate, so the local agent dies last.
cleanup() {
  local rc=$? remote_sock tries out
  set +e
  # Idempotent, but reported ONCE. On a signalled exit both the signal trap and
  # the EXIT trap fire, and the 2026-07-30 incident log shows this entire block
  # printed twice — the second pass announcing "nothing was ever forwarded"
  # purely because the first pass had already removed the socket. That second
  # verdict was noise that contradicted the first. One run, one verdict.
  if [ "${TEARDOWN_DONE}" = "1" ]; then
    exit "${rc}"
  fi
  TEARDOWN_DONE=1
  {
    note "teardown begins (exit=${rc})"

    # Read from the log, not a variable: the payload ran inside a pipeline, so
    # its assignments never reached this shell, and an interrupted run must
    # still be able to name the socket it needs to prove gone.
    remote_sock="$(awk -F= '/^remote_agent_sock=/{print $2; exit}' "${LOG}" 2>/dev/null)"
    note "remote_agent_sock_observed=${remote_sock:-<none recorded>}"

    if [ -n "${AGENT_PID}" ] && [ -S "${AGENT_SOCK}" ]; then
      tries=0
      while [ "${tries}" -lt 6 ]; do
        # OP_REQUIRE_TERMINAL=1: the host script must REFUSE to close the DB
        # control master while a wrapper or writer still depends on it. That
        # refusal is the fix for the incident — closing it at 07:17:05Z is what
        # stopped the wrapper's own cleanup from authenticating.
        #
        # OP_FORWARDING_OCCURRED lets the host script tell "nothing to prove"
        # apart from "forwarded, but the socket path was never recorded".
        out="$(ssh_noforward \
          "REMOTE_SOCK=$(printf %q "${remote_sock}") \
           OP_STATE_DIR=$(printf %q "${OP_STATE_DIR}") \
           OP_DB_SSH=$(printf %q "${OP_DB_SSH}") \
           OP_REQUIRE_TERMINAL=1 \
           OP_FORWARDING_OCCURRED=$(printf %q "${FORWARDING_OCCURRED}") bash -s" \
          < "${HERE}/host-teardown.sh" 2>&1)"
        printf '%s\n' "${out}" | redact
        # Verdict comes from ONE explicit line the host script emits, not from
        # sniffing for a substring that can be true vacuously.
        case "${out}" in
          *"TEARDOWN_VERDICT=CLEAN"*)     TEARDOWN_RESULT="verified-gone"; break ;;
          *"TEARDOWN_VERDICT=NOT_CLEAN"*) TEARDOWN_RESULT="still-present" ;;
          *)                              TEARDOWN_RESULT="no-verdict-returned" ;;
        esac
        tries=$((tries + 1))
        sleep 5
      done
    elif [ "${FORWARDING_OCCURRED}" = "1" ] || [ -n "${remote_sock}" ]; then
      # Contradiction: the host recorded a forwarded socket, so forwarding DID
      # happen — but this shell has no agent handle to tear down with. Claiming
      # "nothing-forwarded" here would be a vacuous pass over a live credential,
      # which is precisely what the subshell-scoping bug produced once already.
      # Fail loudly instead; a teardown that cannot be asserted is not a teardown.
      note "CONTRADICTION: forwarding occurred (occurred=${FORWARDING_OCCURRED}"
      note "socket=${remote_sock:-<none recorded>}) but this shell holds no agent"
      note "handle, so teardown cannot be asserted from here."
      TEARDOWN_RESULT="unprovable-treat-as-live"
    else
      note "no agent was established; nothing was ever forwarded"
      TEARDOWN_RESULT="nothing-forwarded"
    fi

    if [ -n "${AGENT_PID}" ]; then
      kill "${AGENT_PID}" 2>/dev/null
      wait "${AGENT_PID}" 2>/dev/null
    fi
    rm -f "${AGENT_SOCK}" 2>/dev/null
    if [ -e "${AGENT_SOCK}" ]; then
      note "local_agent_socket=PRESENT ${AGENT_SOCK}  <-- REMOVE MANUALLY"
    else
      note "local_agent_socket=GONE"
    fi
    if [ -n "${AGENT_PID}" ] && kill -0 "${AGENT_PID}" 2>/dev/null; then
      note "local_agent_pid_alive=YES pid=${AGENT_PID}  <-- KILL MANUALLY"
    else
      note "local_agent_pid_alive=NO"
    fi
    note "remote_forward_teardown=${TEARDOWN_RESULT}"

    case "${TEARDOWN_RESULT}" in
      still-present|unprovable-treat-as-live|no-verdict-returned)
        note "TEARDOWN NOT PROVEN — treat the forwarded credential as LIVE until a"
        note "manual check shows the socket gone. Do NOT start another phase."
        note "manual proof: re-run host-teardown.sh over a NON-forwarding connection"
        note "(RUNBOOK.md records the exact options; do not improvise them here)"
        ;;
    esac
    note "teardown ends"
  } 2>&1 | tee -a "${LOG}"
  exit "${rc}"
}
trap cleanup EXIT INT TERM HUP

# ── Requirement 1: prove the agent locally, immediately before connecting ──
#
# The agent is started HERE, in the parent shell, and deliberately NOT inside the
# `{ … } | tee` block below. That block is a pipeline, so it runs in a subshell,
# and an AGENT_PID assigned there never reaches `cleanup`, which runs in the
# parent. That is not hypothetical: the first real run of this script reported
# "nothing-forwarded", skipped the host teardown entirely, and left the agent
# process alive — for exactly this reason. Anything `cleanup` must act on has to
# be assigned before the pipeline, not within it.
[ -f "${OP_KEY}" ] || die "operator key ${OP_KEY} is absent"

# `-a` gives a socket path this script owns, so teardown asserts on a known
# name instead of guessing. The PID comes from ssh-agent's own output, not from
# a pgrep pattern that could match a different agent.
AGENT_OUT="$(ssh-agent -a "${AGENT_SOCK}")" || die "could not start a dedicated agent"
AGENT_PID="$(printf '%s\n' "${AGENT_OUT}" | sed -n 's/.*SSH_AGENT_PID=\([0-9]\{1,\}\).*/\1/p' | head -1)"
[ -n "${AGENT_PID}" ] || die "dedicated agent started but reported no pid"
export SSH_AUTH_SOCK="${AGENT_SOCK}"

# </dev/null: BatchMode discipline. If this key ever gains a passphrase this
# must fail closed rather than sit waiting on a prompt nobody is watching.
ssh-add -q "${OP_KEY}" </dev/null || die "could not load ${OP_KEY} into the dedicated agent"

# Set HERE, in the parent shell, for the same reason AGENT_PID is: everything
# below runs inside a `{ … } | tee` pipeline, so an assignment made there would
# never reach `cleanup`. From this point on every connection this script opens
# forwards the agent, so the flag is true from now on. If the script dies between
# the agent existing and the connection opening, this over-reports slightly —
# deliberately, because over-reporting demands proof of teardown whereas
# under-reporting waives it.
FORWARDING_OCCURRED=1

{
note "operator session mode=${MODE}${PHASE:+ phase=${PHASE}}"
note "target sha=${OP_SHA}"
note "runner=${OP_RUNNER_DIR}"
note "log=${LOG}"

AGENT_LIST="$(ssh-add -l 2>/dev/null || true)"
AGENT_N="$(printf '%s\n' "${AGENT_LIST}" | grep -c 'SHA256:' || true)"
AGENT_FP="$(printf '%s\n' "${AGENT_LIST}" | awk '/SHA256:/{print $2}' | head -1)"
note "local_agent_socket=${AGENT_SOCK}"
note "local_agent_pid=${AGENT_PID}"
note "local_agent_identity_count=${AGENT_N}"
note "local_agent_fingerprint=${AGENT_FP}"
[ "${AGENT_N}" = "1" ] || die "dedicated agent holds ${AGENT_N} identities; exactly 1 is required"
[ "${AGENT_FP}" = "${OP_EXPECT_FP}" ] || die "dedicated agent identity ${AGENT_FP} != ${OP_EXPECT_FP}"
note "LOCAL AGENT PROOF OK — exactly one identity, and it is the operator key"

# ── Requirement 2: forwarding, scoped to this one session, spelled out ────
SSH_OPTS=(
  -o ForwardAgent=yes               # the whole point; explicit, not `-A`
  -o IdentityAgent="${AGENT_SOCK}"  # forward THIS agent, never a login agent
  -o IdentitiesOnly=yes
  -o ControlMaster=no               # nothing multiplexed
  -o ControlPath=none               # no socket can outlive this process
  -o ForwardX11=no
  -o ForwardX11Trusted=no
  -o BatchMode=yes                  # never prompt, never hang
  -o StrictHostKeyChecking=yes      # a changed host key aborts, it does not ask
  -o ConnectTimeout=15
  -o ServerAliveInterval=30         # a long phase must not look idle...
  -o ServerAliveCountMax=20         # ...but a dead link must still be noticed
  -T                                # no tty; the payload arrives on stdin
)

# Non-secret pins, passed explicitly. The host scripts refuse an empty value for
# any of them — which is what makes an unsubstituted or dropped variable a hard
# stop instead of a check that silently compares against "".
COMMON_ENV="OP_EXPECT_FP=$(printf %q "${OP_EXPECT_FP}") \
OP_DB_SSH=$(printf %q "${OP_DB_SSH}") \
OP_DB_NAME=$(printf %q "${OP_DB_NAME}") \
OP_SHA=$(printf %q "${OP_SHA}") \
OP_OLD_SHA=$(printf %q "${OP_OLD_SHA}") \
OP_WRAPPER_SHA=$(printf %q "${OP_WRAPPER_SHA}") \
OP_RUNNER_DIR=$(printf %q "${OP_RUNNER_DIR}") \
OP_WEB_REPO=$(printf %q "${OP_WEB_REPO}") \
OP_WORKER_REPO=$(printf %q "${OP_WORKER_REPO}") \
OP_WEB_DIGEST=$(printf %q "${OP_WEB_DIGEST}") \
OP_WORKER_DIGEST=$(printf %q "${OP_WORKER_DIGEST}") \
OP_SCHEDULER=$(printf %q "${OP_SCHEDULER}") \
OP_STATE_DIR=$(printf %q "${OP_STATE_DIR}") \
OP_ENV_FILE=$(printf %q "${OP_ENV_FILE}")"

case "${MODE}" in
  verify)
    note "READ-ONLY credential proof; this mutates nothing"
    ssh "${SSH_OPTS[@]}" "${OP_APP_HOST}" "${COMMON_ENV} bash -s" \
      < "${HERE}/host-verify.sh" 2>&1 | redact
    ;;
  phase)
    note "running exactly ONE wrapper phase: ${PHASE}"
    # OP_SUPERSEDE_EPOCH is forwarded only when the caller set it. Empty by
    # default, so the host-side single-epoch guard keeps refusing a second
    # preflight unless an exact epoch id was named deliberately.
    [ -z "${OP_SUPERSEDE_EPOCH:-}" ] || note "supersede requested for epoch ${OP_SUPERSEDE_EPOCH}"
    ssh "${SSH_OPTS[@]}" "${OP_APP_HOST}" \
      "${COMMON_ENV} OP_PHASE=$(printf %q "${PHASE}") \
       OP_SUPERSEDE_EPOCH=$(printf %q "${OP_SUPERSEDE_EPOCH:-}") bash -s" \
      < "${HERE}/host-phase.sh" 2>&1 | redact
    ;;
esac

note "session payload returned 0"
} 2>&1 | tee -a "${LOG}"
