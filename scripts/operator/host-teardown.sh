# Runs ON THE APP HOST over a NON-forwarding connection, after the operator
# session has ended. Proves the forwarded credential is actually gone.
#
# Requirement 6. This is a separate connection on purpose: asking the forwarded
# session whether its own forwarding has stopped is not a proof of anything.
#
# ORDERING (requirement 2). The census of live wrappers/writers now runs FIRST,
# before anything is closed, because on 2026-07-30 this script closed the DB
# ControlMaster at 07:17:05Z while a wrapper was still mid-restore and still
# needed it. Withdrawing a credential that live work depends on is not teardown,
# it is sabotage with a tidy log line. With OP_REQUIRE_TERMINAL=1 the close step
# refuses outright unless the remote side is provably terminal.
#
# EVIDENCE HONESTY (requirement 5). If forwarding occurred, an unrecorded socket
# path is reported as UNPROVEN. It used to print `forwarded_socket=GONE`, because
# `[ -n "$S" ] && [ -S "$S" ]` is false when S is empty — a vacuous pass that
# read exactly like a real proof in the incident log.
set -uo pipefail

S="${REMOTE_SOCK:-}"
D="${OP_STATE_DIR:-/var/lib/adsecute-cutover}"
T="${OP_DB_SSH:-}"
REQUIRE_TERMINAL="${OP_REQUIRE_TERMINAL:-0}"
FORWARDED="${OP_FORWARDING_OCCURRED:-unknown}"

FAIL=0

printf 'teardown_probe_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'require_terminal=%s forwarding_occurred=%s\n' "${REQUIRE_TERMINAL}" "${FORWARDED}"

# ── 0. Census FIRST: who still depends on the credential? ──────────────────
# Identity is read from /proc where available (the app host is Linux) and from
# `ps` otherwise. Without the fallback an unreadable /proc yields zero — and zero
# is precisely the answer that authorises withdrawing the credential, so the
# failure mode of a missing fallback is the incident itself.
cmd_of() {
  local p="$1"
  if [ -r "/proc/${p}/cmdline" ]; then
    tr '\0' ' ' < "/proc/${p}/cmdline" 2>/dev/null
  elif ps -p "${p}" >/dev/null 2>&1; then
    ps -o command= -p "${p}" 2>/dev/null
  fi
}
count_wrappers() {
  local n=0 p c
  for p in $(pgrep -f 'hetzner-sync-cutover' 2>/dev/null); do
    [ "$p" = "$$" ] && continue
    [ "$p" = "$PPID" ] && continue
    c="$(cmd_of "$p")"
    case "${c}" in
      *pgrep*) continue ;;
      *hetzner-sync-cutover*) n=$((n + 1)) ;;
    esac
  done
  printf '%s' "${n}"
}
count_writers() {
  local n=0 p c
  for p in $(pgrep -f 'pg_dump|pg_restore|pg_basebackup' 2>/dev/null); do
    [ "$p" = "$$" ] && continue
    [ "$p" = "$PPID" ] && continue
    c="$(cmd_of "$p")"
    case "${c}" in
      *pgrep*) continue ;;
      *pg_dump*|*pg_restore*|*pg_basebackup*) n=$((n + 1)) ;;
    esac
  done
  printf '%s' "${n}"
}

LIVE_WRAPPERS="$(count_wrappers)"
LIVE_WRITERS="$(count_writers)"
printf 'live_wrappers=%s live_writers=%s\n' "${LIVE_WRAPPERS}" "${LIVE_WRITERS}"

# ── 1. The forwarded agent socket itself ───────────────────────────────────
if [ -n "${S}" ]; then
  if [ -S "${S}" ]; then
    printf 'forwarded_socket=PRESENT %s\n' "${S}"
    FAIL=1
  else
    printf 'forwarded_socket=GONE\n'
  fi
elif [ "${FORWARDED}" = "1" ]; then
  # Forwarding definitely happened but nobody recorded which socket. That is not
  # a pass. The generic scans below are the only real evidence in this case, and
  # the caller is told the specific proof is missing rather than satisfied.
  printf 'forwarded_socket=UNPROVEN no socket path recorded for a session that DID forward\n'
  FAIL=1
else
  printf 'forwarded_socket=NOT_APPLICABLE no socket path recorded and no forwarding claimed\n'
fi

# ── 2. Its containing directory, which sshd creates per session and removes with it.
if [ -n "${S}" ]; then
  PD="$(dirname "${S}")"
  if [ -d "${PD}" ]; then printf 'forward_dir=PRESENT %s\n' "${PD}"; FAIL=1; else printf 'forward_dir=GONE\n'; fi
else
  printf 'forward_dir=UNKNOWN no socket path recorded\n'
fi

# ── 3. Generic scan: any forwarded-agent socket left behind at all. ────────
#    Independent of anything the caller recorded, which is what makes it the
#    load-bearing check when the specific path is missing.
STRAY=0
for d in /tmp/ssh-*; do
  [ -d "${d}" ] || continue
  for s in "${d}"/agent.*; do
    [ -S "${s}" ] || continue
    STRAY=$((STRAY + 1))
  done
done
printf 'other_forwarded_sockets=%s\n' "${STRAY}"
printf 'ssh_session_dirs=%s\n' "$(ls -1d /tmp/ssh-* 2>/dev/null | wc -l | tr -d ' ')"
[ "${STRAY}" = "0" ] || FAIL=1

# ── 4. The wrapper's ControlPersist master to the DB host. ─────────────────
#
#    This keeps an ALREADY-authenticated channel open for up to 900s, so it
#    stays usable after the agent that authenticated it is gone. Left to expire
#    it is a window; closed explicitly it is not.
#
#    BUT: closing it while a wrapper still needs it IS the 2026-07-30 incident.
#    Under OP_REQUIRE_TERMINAL the close is gated on a proven-terminal remote.
CLOSED=0
SKIPPED=0
for s in "${D}"/ssh/cutover-*; do
  [ -S "${s}" ] || continue
  printf 'db_master_found=%s\n' "$(basename "${s}")"
  if [ "${REQUIRE_TERMINAL}" = "1" ] && { [ "${LIVE_WRAPPERS}" != "0" ] || [ "${LIVE_WRITERS}" != "0" ]; }; then
    printf 'db_master_close=REFUSED live_wrappers=%s live_writers=%s still depend on this credential\n' \
      "${LIVE_WRAPPERS}" "${LIVE_WRITERS}"
    SKIPPED=$((SKIPPED + 1))
    FAIL=1
    continue
  fi
  if [ -n "${T}" ]; then
    # -O exit speaks to the existing master socket, so it performs no host-key
    # verification of its own. The policy is stated anyway: no ssh invocation in
    # this procedure may rely on a compiled-in default, and if a future change
    # makes this path open a fresh connection it must fail closed rather than
    # quietly inherit `ask`.
    ssh -O exit -o ControlPath="${s}" \
        -o BatchMode=yes -o StrictHostKeyChecking=yes \
        "${T}" >/dev/null 2>&1 && CLOSED=$((CLOSED + 1))
  fi
done
REMAIN=0
for s in "${D}"/ssh/cutover-*; do
  [ -S "${s}" ] && REMAIN=$((REMAIN + 1))
done
printf 'db_masters_closed=%s db_masters_skipped=%s db_masters_remaining=%s\n' \
  "${CLOSED}" "${SKIPPED}" "${REMAIN}"

# ── 5. Nothing left running that would need the credential. ────────────────
printf 'orphaned_wrappers_or_writers=%s\n' "$(( LIVE_WRAPPERS + LIVE_WRITERS ))"

# ── 6. One verdict line, so a caller never has to infer one. ──────────────
if [ "${FAIL}" = "0" ] && [ "$(( LIVE_WRAPPERS + LIVE_WRITERS ))" = "0" ]; then
  printf 'TEARDOWN_VERDICT=CLEAN\n'
else
  printf 'TEARDOWN_VERDICT=NOT_CLEAN\n'
fi
