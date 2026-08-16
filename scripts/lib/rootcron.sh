# shellcheck shell=bash
#
# The root crontab's managed Sync block: one parser, one pair of markers.
#
# The Sync/AI entries live in the ROOT crontab next to a healthz probe and
# unrelated jobs. `crontab -r`, a rewritten file, or "comment out everything
# that mentions adsecute" all silently take those unrelated entries down with
# them, and nobody notices until the thing they scheduled fails to run. So
# every operation here manages exactly one delimited block and proves, by
# digest, that every byte outside it is unchanged.
#
# This file exists so the cutover script and the deploy script cannot disagree
# about where the block starts, where it ends, or how it is parsed. A second
# implementation of that parsing is the failure mode: two definitions of "the
# managed block" is how one of them removes lines the other would have kept.
#
# Callers may override `rootcron_log` and `rootcron_die` before sourcing.

ROOTCRON_BEGIN="${ROOTCRON_BEGIN:-# BEGIN adsecute-sync}"
ROOTCRON_END="${ROOTCRON_END:-# END adsecute-sync}"
ROOTCRON_USER="${ROOTCRON_USER:-root}"

command -v rootcron_log >/dev/null 2>&1 || rootcron_log() { echo "[rootcron] $*"; }
command -v rootcron_die >/dev/null 2>&1 || rootcron_die() { echo "[rootcron] FATAL $*" >&2; return 1; }

rootcron_sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Injectable, like the log/die hooks: a caller that defines these before
# sourcing keeps its own. Defining them unconditionally would silently seize
# the real root crontab from any harness that thought it had substituted a
# fixture — which is how a test suite ends up editing the machine it runs on.
# Read the root crontab, or FAIL — never silently produce an empty one.
#
# `crontab -l` exits non-zero both when the user genuinely has no crontab and
# when it could not look: a permissions refusal, a missing binary, a transient
# cron error. Collapsing all of those to "" with `|| true` makes an unreadable
# scheduler indistinguishable from an absent one, and the caller then concludes
# there is no managed block and lets migrations run while the real scheduler is
# still firing. Only the documented "no crontab for <user>" is an empty read.
command -v rootcron_read >/dev/null 2>&1 || rootcron_read() {
  _rc_err="$(mktemp)"
  if crontab -l -u "${ROOTCRON_USER}" 2>"${_rc_err}"; then
    rm -f "${_rc_err}"
    return 0
  fi
  _rc_status=$?
  _rc_msg="$(cat "${_rc_err}" 2>/dev/null || true)"
  rm -f "${_rc_err}"
  case "${_rc_msg}" in
    *"no crontab for"*)
      # Genuinely empty. Nothing is scheduled, so nothing needs quiescing.
      return 0
      ;;
  esac
  rootcron_die "could not read the ${ROOTCRON_USER} crontab (exit ${_rc_status}): ${_rc_msg:-no diagnostic}. Refusing to treat an unreadable scheduler as an absent one."
  return 1
}

command -v rootcron_write >/dev/null 2>&1 || rootcron_write() {
  crontab -u "${ROOTCRON_USER}" -
}

# Splits the current crontab into "outside" and "block", printing the line
# index in the outside stream at which the block started (-1 when absent).
# Exits 3 when a BEGIN has no END — refusing to guess where the block ends.
rootcron_split() {
  current="$1"; outside="$2"; block="$3"
  : > "${outside}"
  : > "${block}"
  # Exit codes: 3 = BEGIN without END, 4 = more than one managed block,
  # 5 = a nested BEGIN or a stray END outside any block.
  #
  # A second block is not a merge problem, it is an ambiguity: appending both
  # to one saved file and reinserting at the last BEGIN's index would relocate
  # every line between them -- including MAILTO/PATH assignments, whose
  # position changes what the jobs below them inherit.
  awk -v begin="${ROOTCRON_BEGIN}" -v end="${ROOTCRON_END}" \
      -v outside="${outside}" -v block="${block}" '
    BEGIN { inside = 0; blocks = 0; outcount = 0; startidx = -1 }
    {
      if (!inside && $0 == begin) {
        blocks++
        if (blocks > 1) exit 4
        inside = 1; startidx = outcount; print > block; next
      }
      if (inside) {
        if ($0 == begin) exit 5
        print > block
        if ($0 == end) { inside = 0 }
        next
      }
      if ($0 == end) exit 5
      print > outside; outcount++
    }
    END {
      if (inside) exit 3
      if (blocks == 0) startidx = -1
      print startidx
    }
  ' "${current}"
}

# Is a paused schedule currently parked in this state dir?
rootcron_is_paused() {
  [ -s "${1}/rootcron.original" ]
}

# Hold the SHARED cutover lock for the length of a crontab mutation.
#
# The same file the cutover wrapper takes with `flock -n 9` and the deploy
# already probes in `assert_no_cutover_in_progress`. Reused rather than
# duplicated: a second lock file would let a cutover and a deploy each believe
# they had exclusive access to the same crontab.
ROOTCRON_LOCK_FILE="${ROOTCRON_LOCK_FILE:-${SYNC_CUTOVER_STATE_DIR:-/var/lib/adsecute-cutover}/lock}"

rootcron_with_lock() {
  if ! command -v flock >/dev/null 2>&1; then
    rootcron_log "flock is unavailable; proceeding without the shared cutover lock"
    "$@"
    return $?
  fi
  mkdir -p "$(dirname "${ROOTCRON_LOCK_FILE}")" 2>/dev/null || true
  _lk_rc=0
  {
    if ! flock -w "${ROOTCRON_LOCK_WAIT_SECONDS:-30}" 9; then
      rootcron_die "could not take the shared scheduler lock ${ROOTCRON_LOCK_FILE}; another deploy or cutover holds it"
      exit 1
    fi
    "$@"
  } 9>"${ROOTCRON_LOCK_FILE}" || _lk_rc=$?
  return "${_lk_rc}"
}

# Park the WHOLE original crontab and install a filtered copy without the
# managed block.
#
# Restore replays the original file verbatim rather than reinserting a block at
# a remembered index. That is the simplification this design needed: the index,
# the outside digest and the reinsertion pass were three separate things that
# each had to be right for the crontab to come back, and each grew its own
# failure mode. One artifact and one byte comparison replaces all of it, and
# "byte-for-byte identical to what was there" is the guarantee actually wanted.
#
# The split is still the single parser: it validates the marker structure and
# produces the filtered copy. One set of markers, one parse, as before.
rootcron_pause() {
  rootcron_with_lock _rootcron_pause_locked "$@"
}

_rootcron_pause_locked() {
  _rc_state_dir="$1"
  if ! mkdir -p "${_rc_state_dir}"; then
    rootcron_die "could not create the state directory ${_rc_state_dir}; refusing to pause a scheduler we cannot record"
    return 1
  fi

  if rootcron_is_paused "${_rc_state_dir}"; then
    rootcron_log "a schedule is already parked in ${_rc_state_dir}; leaving it parked"
    return 0
  fi

  _rc_original="${_rc_state_dir}/rootcron.original"
  _rc_filtered="${_rc_state_dir}/rootcron.filtered"
  _rc_tmp="$(mktemp)"; _rc_outside="$(mktemp)"; _rc_block="$(mktemp)"

  if ! rootcron_read > "${_rc_tmp}"; then
    rm -f "${_rc_tmp}" "${_rc_outside}" "${_rc_block}"
    return 1
  fi

  _rc_split_rc=0
  _rc_start="$(rootcron_split "${_rc_tmp}" "${_rc_outside}" "${_rc_block}")" || _rc_split_rc=$?
  if [ "${_rc_split_rc}" -ne 0 ]; then
    rm -f "${_rc_tmp}" "${_rc_outside}" "${_rc_block}"
    case "${_rc_split_rc}" in
      3) rootcron_die "the root crontab has a '${ROOTCRON_BEGIN}' with no '${ROOTCRON_END}'; refusing to guess where the managed _rc_block ends" ;;
      4) rootcron_die "the root crontab contains more than one '${ROOTCRON_BEGIN}' _rc_block; refusing to merge or relocate them" ;;
      5) rootcron_die "the root crontab has nested or unmatched Sync markers; refusing to parse it" ;;
      *) rootcron_die "the root crontab could not be parsed (split exit ${_rc_split_rc})" ;;
    esac
    return 1
  fi

  if [ "${_rc_start}" = "-1" ]; then
    rootcron_log "root crontab has no managed _rc_block; nothing to pause"
    rm -f "${_rc_tmp}" "${_rc_outside}" "${_rc_block}"
    return 0
  fi

  # Persist and READ BACK before touching the _rc_live crontab. A full filesystem
  # accepts a write and truncates the content, so written is not recorded.
  _rc_persist_failed=""
  cp "${_rc_tmp}" "${_rc_original}"      || _rc_persist_failed="rootcron.original"
  [ -z "${_rc_persist_failed}" ] && { cp "${_rc_outside}" "${_rc_filtered}" || _rc_persist_failed="rootcron.filtered"; }
  [ -z "${_rc_persist_failed}" ] && { cmp -s "${_rc_original}" "${_rc_tmp}"     || _rc_persist_failed="rootcron.original (content mismatch)"; }
  [ -z "${_rc_persist_failed}" ] && { cmp -s "${_rc_filtered}" "${_rc_outside}" || _rc_persist_failed="rootcron.filtered (content mismatch)"; }
  if [ -n "${_rc_persist_failed}" ]; then
    rm -f "${_rc_original}" "${_rc_filtered}"
    rm -f "${_rc_tmp}" "${_rc_outside}" "${_rc_block}"
    rootcron_die "could not durably persist ${_rc_persist_failed} under ${_rc_state_dir}; the _rc_live crontab has NOT been modified"
    return 1
  fi
  chmod 0600 "${_rc_original}" "${_rc_filtered}" 2>/dev/null || true

  # Re-read immediately before writing. Between the first read and here, an
  # operator or a cooperating process may have edited the crontab; installing
  # our _rc_filtered copy would silently discard that edit.
  _rc_recheck="$(mktemp)"
  if ! rootcron_read > "${_rc_recheck}"; then
    rm -f "${_rc_original}" "${_rc_filtered}" "${_rc_tmp}" "${_rc_outside}" "${_rc_block}" "${_rc_recheck}"
    return 1
  fi
  if ! cmp -s "${_rc_recheck}" "${_rc_tmp}"; then
    rm -f "${_rc_original}" "${_rc_filtered}"
    rm -f "${_rc_tmp}" "${_rc_outside}" "${_rc_block}" "${_rc_recheck}"
    rootcron_die "the root crontab changed between reading and writing it; refusing to overwrite a concurrent edit"
    return 1
  fi
  rm -f "${_rc_recheck}"

  if ! rootcron_write < "${_rc_filtered}"; then
    rm -f "${_rc_original}" "${_rc_filtered}" "${_rc_tmp}" "${_rc_outside}" "${_rc_block}"
    rootcron_die "could not write the root crontab; parked state discarded and the schedule left as it was"
    return 1
  fi

  # The _rc_block is gone from here on. Any failure restores the _rc_original file
  # synchronously; if THAT fails the parked _rc_original stays on disk and the
  # caller is told, so its recovery trap still has something to act on.
  _rootcron_rollback() {
    if rootcron_write < "${_rc_original}"; then
      _v="$(mktemp)"
      if rootcron_read > "${_v}" && cmp -s "${_v}" "${_rc_original}"; then
        rm -f "${_v}"
        rootcron_log "rolled the root crontab back to its _rc_original contents after: $1"
        rm -f "${_rc_original}" "${_rc_filtered}"
        return 0
      fi
      rm -f "${_v}"
    fi
    rootcron_die "could NOT roll the root crontab back after: $1. The _rc_original is parked at ${_rc_original} and MUST be restored by hand."
    return 1
  }

  _rc_vtmp="$(mktemp)"
  if ! rootcron_read > "${_rc_vtmp}"; then
    _rootcron_rollback "the crontab could not be read back after removal" || true
    rm -f "${_rc_tmp}" "${_rc_outside}" "${_rc_block}" "${_rc_vtmp}"
    return 1
  fi
  if ! cmp -s "${_rc_vtmp}" "${_rc_filtered}"; then
    _rootcron_rollback "the crontab after removal is not the copy that was written" || true
    rm -f "${_rc_tmp}" "${_rc_outside}" "${_rc_block}" "${_rc_vtmp}"
    return 1
  fi

  rootcron_log "root crontab: managed Sync _rc_block paused; the _rc_original is parked at ${_rc_original}"
  rm -f "${_rc_tmp}" "${_rc_outside}" "${_rc_block}" "${_rc_vtmp}"
  return 0
}

# Replay the parked _rc_original, byte for byte.
rootcron_resume() {
  rootcron_with_lock _rootcron_resume_locked "$@"
}

_rootcron_resume_locked() {
  _rc_state_dir="$1"
  _rc_original="${_rc_state_dir}/rootcron.original"
  _rc_filtered="${_rc_state_dir}/rootcron.filtered"

  if ! rootcron_is_paused "${_rc_state_dir}"; then
    rootcron_log "nothing parked in ${_rc_state_dir}; nothing to resume"
    return 0
  fi

  _rc_live="$(mktemp)"
  if ! rootcron_read > "${_rc_live}"; then
    rm -f "${_rc_live}"
    return 1
  fi

  if cmp -s "${_rc_live}" "${_rc_original}"; then
    rootcron_log "the crontab is already identical to the parked _rc_original"
    rm -f "${_rc_live}"
    _rootcron_clear_state "${_rc_state_dir}"
    return $?
  fi

  # It must still be exactly what we installed. Anything else means someone
  # edited the crontab while the _rc_block was out, and replaying the _rc_original
  # would discard their edit.
  if [ -s "${_rc_filtered}" ] && ! cmp -s "${_rc_live}" "${_rc_filtered}"; then
    rm -f "${_rc_live}"
    rootcron_die "the root crontab changed while the Sync _rc_block was out; refusing to overwrite it. The _rc_original is parked at ${_rc_original}."
    return 1
  fi

  if ! rootcron_write < "${_rc_original}"; then
    rm -f "${_rc_live}"
    rootcron_die "could not write the root crontab back; the _rc_original is still parked at ${_rc_original}"
    return 1
  fi

  _rc_verify="$(mktemp)"
  if ! rootcron_read > "${_rc_verify}" || ! cmp -s "${_rc_verify}" "${_rc_original}"; then
    rm -f "${_rc_live}" "${_rc_verify}"
    rootcron_die "the restored crontab is not byte-identical to the parked _rc_original; it is still at ${_rc_original}"
    return 1
  fi

  rootcron_log "root crontab: restored byte-for-byte from the parked _rc_original"
  rm -f "${_rc_live}" "${_rc_verify}"
  _rootcron_clear_state "${_rc_state_dir}"
}

# Clearing parked state is part of the contract, not cleanup.
#
# A stale rootcron.original is authoritative to the NEXT pause: it would see a
# parked schedule, decline to park again, and let migrations run while cron was
# active. So every removal is checked and read back, and a _rc_residue is a failure.
_rootcron_clear_state() {
  _rc_state_dir="$1"
  rm -f "${_rc_state_dir}/rootcron.original" "${_rc_state_dir}/rootcron.filtered" \
        "${_rc_state_dir}/rootcron.block" "${_rc_state_dir}/rootcron.outside" \
        "${_rc_state_dir}/rootcron.index" "${_rc_state_dir}/rootcron.outside.sha256" 2>/dev/null || true
  _rc_residue=""
  for f in rootcron.original rootcron.filtered rootcron.block rootcron.outside rootcron.index rootcron.outside.sha256; do
    [ -e "${_rc_state_dir}/${f}" ] && _rc_residue="${_rc_residue} ${f}"
  done
  if [ -n "${_rc_residue}" ]; then
    rootcron_die "parked scheduler state could not be cleared (${_rc_residue# }); a later pause would treat the scheduler as already parked and run migrations while cron is active"
    return 1
  fi
  return 0
}
