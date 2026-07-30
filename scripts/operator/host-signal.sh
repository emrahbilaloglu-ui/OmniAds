# Runs ON THE APP HOST over a NON-forwarding connection. Signals exactly one
# cutover wrapper — the one this operator run started — and nothing else.
#
# Step 1 of ordered shutdown (requirement 2). This exists so the wrapper's OWN
# cleanup (scratch_db_drop, discard_incomplete_artifact) runs while the forwarded
# credential is still valid. On 2026-07-30 the credential was withdrawn first and
# that cleanup silently failed to authenticate, stranding an 11 GB database.
#
# `pkill -f hetzner-sync-cutover` is deliberately NOT used: it would also kill a
# concurrent run. The PID comes from the file host-phase.sh wrote beside its log,
# and is then VALIDATED against the process's own cmdline before any signal — a
# stale pid file must never be able to aim a TERM at an unrelated process that
# has since inherited the number.
set -uo pipefail

RUNNER_ROOT="${OP_RUNNER_ROOT:-/var/lib/adsecute-cutover-runner}"

P="$(ls -1t "${RUNNER_ROOT}"/operator-*.pid 2>/dev/null | head -1)"
if [ -z "${P}" ]; then
  printf 'resolve=no-pid-file\n'
  exit 0
fi

PID="$(tr -dc '0-9' < "${P}" 2>/dev/null)"
if [ -z "${PID}" ]; then
  printf 'resolve=empty-pid-file file=%s\n' "$(basename "${P}")"
  exit 0
fi

# Identity before action. Prefer /proc (the app host is Linux); fall back to ps
# so an absent /proc cannot make this silently report "not running" and move on.
CMD=""
if [ -r "/proc/${PID}/cmdline" ]; then
  CMD="$(tr '\0' ' ' < "/proc/${PID}/cmdline" 2>/dev/null)"
elif ps -p "${PID}" >/dev/null 2>&1; then
  CMD="$(ps -o command= -p "${PID}" 2>/dev/null)"
else
  printf 'resolve=pid-not-running pid=%s\n' "${PID}"
  exit 0
fi

if [ -z "${CMD}" ]; then
  printf 'resolve=pid-not-running pid=%s\n' "${PID}"
  exit 0
fi

case "${CMD}" in
  *hetzner-sync-cutover*)
    if kill -TERM "${PID}" 2>/dev/null; then
      printf 'resolve=signalled pid=%s\n' "${PID}"
    else
      printf 'resolve=signal-failed pid=%s\n' "${PID}"
    fi
    ;;
  *)
    # Refuse. A pid whose identity does not match is not ours to signal.
    printf 'resolve=refused-identity-mismatch pid=%s\n' "${PID}"
    ;;
esac
