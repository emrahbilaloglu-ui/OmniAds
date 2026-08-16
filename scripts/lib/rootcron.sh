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

# Is a paused block currently parked in this state dir?
rootcron_is_paused() {
  [ -s "${1}/rootcron.block" ]
}

# Remove the managed block, parking it for `rootcron_resume`.
#
# Idempotent and crash-safe: the parked block, the unrelated lines and the
# insertion index are all on disk before the crontab is rewritten, so a process
# that dies between the two can be completed by the next run.
rootcron_pause() {
  state_dir="$1"
  if ! mkdir -p "${state_dir}"; then
    rootcron_die "could not create the state directory ${state_dir}; refusing to pause a scheduler we cannot record"
    return 1
  fi

  if rootcron_is_paused "${state_dir}"; then
    rootcron_log "a managed block is already parked in ${state_dir}; leaving it parked"
    return 0
  fi

  tmp="$(mktemp)"; outside="$(mktemp)"; block="$(mktemp)"
  if ! rootcron_read > "${tmp}"; then
    rm -f "${tmp}" "${outside}" "${block}"
    return 1
  fi

  split_rc=0
  start="$(rootcron_split "${tmp}" "${outside}" "${block}")" || split_rc=$?
  if [ "${split_rc}" -ne 0 ]; then
    rm -f "${tmp}" "${outside}" "${block}"
    case "${split_rc}" in
      3) rootcron_die "the root crontab has a '${ROOTCRON_BEGIN}' with no '${ROOTCRON_END}'; refusing to guess where the managed block ends" ;;
      4) rootcron_die "the root crontab contains more than one '${ROOTCRON_BEGIN}' block; refusing to merge or relocate them" ;;
      5) rootcron_die "the root crontab has nested or unmatched Sync markers; refusing to parse it" ;;
      *) rootcron_die "the root crontab could not be parsed (split exit ${split_rc})" ;;
    esac
    return 1
  fi

  if [ "${start}" = "-1" ]; then
    rootcron_log "root crontab has no managed block; nothing to pause"
    rm -f "${tmp}" "${outside}" "${block}"
    return 0
  fi

  # Persist EVERY piece of recovery state, and verify it, BEFORE the live
  # crontab is touched.
  #
  # This function is called as `rootcron_pause ... || return 1`, which places
  # its whole body in a context where errexit and the ERR trap are suppressed —
  # so an unchecked `cp` onto a full or read-only state directory would fail
  # silently and execution would walk straight into `rootcron_write`. That
  # ordering is the difference between "the deploy refused" and "the scheduler
  # is gone and the only copy of it was never written".
  persist_failed=""
  cp "${block}"   "${state_dir}/rootcron.block"   || persist_failed="rootcron.block"
  [ -z "${persist_failed}" ] && { cp "${outside}" "${state_dir}/rootcron.outside" || persist_failed="rootcron.outside"; }
  [ -z "${persist_failed}" ] && { printf '%s' "${start}" > "${state_dir}/rootcron.index" || persist_failed="rootcron.index"; }
  [ -z "${persist_failed}" ] && { rootcron_sha256_file "${outside}" > "${state_dir}/rootcron.outside.sha256" || persist_failed="rootcron.outside.sha256"; }

  # Written is not the same as readable-back: a full filesystem can accept the
  # write and truncate the content.
  if [ -z "${persist_failed}" ]; then
    cmp -s "${state_dir}/rootcron.block" "${block}"     || persist_failed="rootcron.block (content mismatch)"
  fi
  if [ -z "${persist_failed}" ]; then
    cmp -s "${state_dir}/rootcron.outside" "${outside}" || persist_failed="rootcron.outside (content mismatch)"
  fi
  if [ -z "${persist_failed}" ]; then
    [ -s "${state_dir}/rootcron.index" ] || persist_failed="rootcron.index (empty)"
  fi
  if [ -z "${persist_failed}" ]; then
    [ -s "${state_dir}/rootcron.outside.sha256" ] || persist_failed="rootcron.outside.sha256 (empty)"
  fi

  if [ -n "${persist_failed}" ]; then
    # Leave nothing half-parked for the next run to adopt as authoritative.
    rm -f "${state_dir}/rootcron.block" "${state_dir}/rootcron.outside" \
          "${state_dir}/rootcron.index" "${state_dir}/rootcron.outside.sha256"
    rm -f "${tmp}" "${outside}" "${block}"
    rootcron_die "could not durably persist ${persist_failed} under ${state_dir}; the live crontab has NOT been modified"
    return 1
  fi

  chmod 0600 "${state_dir}/rootcron.block" "${state_dir}/rootcron.outside" 2>/dev/null || true

  if ! rootcron_write < "${outside}"; then
    rm -f "${state_dir}/rootcron.block" "${state_dir}/rootcron.outside" \
          "${state_dir}/rootcron.index" "${state_dir}/rootcron.outside.sha256"
    rm -f "${tmp}" "${outside}" "${block}"
    rootcron_die "could not write the root crontab; parked state discarded and the schedule left as it was"
    return 1
  fi

  # From here the block IS removed, so every failure below restores it
  # SYNCHRONOUSLY rather than returning and trusting a caller's trap. Between
  # the write above and a trap that may not be armed yet, production would have
  # no scheduler at all. `${tmp}` still holds the ORIGINAL crontab byte for
  # byte, so recovery is a write, not a reconstruction.
  rootcron_pause_rollback() {
    _rb_reason="$1"
    if rootcron_write < "${tmp}"; then
      _rb_v="$(mktemp)"
      if rootcron_read > "${_rb_v}" && cmp -s "${_rb_v}" "${tmp}"; then
        rm -f "${_rb_v}"
        rootcron_log "rolled the root crontab back to its original contents after: ${_rb_reason}"
        rm -f "${state_dir}/rootcron.block" "${state_dir}/rootcron.outside" \
              "${state_dir}/rootcron.index" "${state_dir}/rootcron.outside.sha256"
        return 0
      fi
      rm -f "${_rb_v}"
    fi
    rootcron_die "could NOT roll the root crontab back after: ${_rb_reason}. The original block is parked at ${state_dir}/rootcron.block and must be restored by hand."
    return 1
  }

  # Read back. `crontab` exiting 0 is not proof the daemon accepted the file.
  vtmp="$(mktemp)"; voutside="$(mktemp)"; vblock="$(mktemp)"
  if ! rootcron_read > "${vtmp}"; then
    rootcron_pause_rollback "the crontab could not be read back after removal" || true
    rm -f "${tmp}" "${outside}" "${block}" "${vtmp}" "${voutside}" "${vblock}"
    return 1
  fi
  if ! rootcron_split "${vtmp}" "${voutside}" "${vblock}" >/dev/null; then
    rootcron_pause_rollback "the crontab was unparseable after removal" || true
    rm -f "${tmp}" "${outside}" "${block}" "${vtmp}" "${voutside}" "${vblock}"
    return 1
  fi
  if [ -s "${vblock}" ]; then
    rootcron_pause_rollback "the managed block was still present after removal" || true
    rm -f "${tmp}" "${outside}" "${block}" "${vtmp}" "${voutside}" "${vblock}"
    return 1
  fi
  if [ "$(rootcron_sha256_file "${voutside}")" != "$(rootcron_sha256_file "${outside}")" ]; then
    rootcron_pause_rollback "removal altered unrelated crontab lines" || true
    rm -f "${tmp}" "${outside}" "${block}" "${vtmp}" "${voutside}" "${vblock}"
    return 1
  fi

  rootcron_log "root crontab: managed Sync block paused; $(wc -l < "${outside}" | tr -d ' ') unrelated line(s) untouched"
  rm -f "${tmp}" "${outside}" "${block}" "${vtmp}" "${voutside}" "${vblock}"
  return 0
}

# Put the managed block back exactly where it was, byte for byte.
#
# Refuses rather than guesses when the unrelated lines changed while the block
# was out: that means someone else edited the crontab meanwhile, and silently
# overwriting their edit is worse than stopping.
rootcron_resume() {
  state_dir="$1"
  saved_block="${state_dir}/rootcron.block"
  saved_outside="${state_dir}/rootcron.outside"

  if ! rootcron_is_paused "${state_dir}"; then
    rootcron_log "no parked block in ${state_dir}; nothing to resume"
    return 0
  fi

  tmp="$(mktemp)"; outside="$(mktemp)"; block="$(mktemp)"; rebuilt="$(mktemp)"
  if ! rootcron_read > "${tmp}"; then
    rm -f "${tmp}" "${outside}" "${block}" "${rebuilt}"
    return 1
  fi
  if ! rootcron_split "${tmp}" "${outside}" "${block}" >/dev/null; then
    rm -f "${tmp}" "${outside}" "${block}" "${rebuilt}"
    rootcron_die "the root crontab is unparseable; refusing to restore over it"
    return 1
  fi

  if [ -s "${block}" ]; then
    # A block is already present. It is only safe to drop the parked copy if
    # the live one is byte-identical to it.
    #
    # Treating any non-empty block as "already restored" would discard the only
    # copy of the original while a DIFFERENT schedule stayed active — a changed
    # cadence, or a stale bearer token that now fails every run. The parked file
    # is the sole record of what was removed, so a mismatch has to stop rather
    # than clean up.
    if cmp -s "${block}" "${saved_block}"; then
      rootcron_log "the managed block is already present and identical to the parked copy; clearing state"
      rm -f "${saved_block}" "${saved_outside}" "${state_dir}/rootcron.index" "${state_dir}/rootcron.outside.sha256"
      rm -f "${tmp}" "${outside}" "${block}" "${rebuilt}"
      return 0
    fi
    rm -f "${tmp}" "${outside}" "${block}" "${rebuilt}"
    rootcron_die "a DIFFERENT managed block is live than the one parked at ${saved_block}; refusing to discard the original. Reconcile the two by hand."
    return 1
  fi

  expected_outside_sha="$(cat "${state_dir}/rootcron.outside.sha256" 2>/dev/null || true)"
  actual_outside_sha="$(rootcron_sha256_file "${outside}")"
  if [ -n "${expected_outside_sha}" ] && [ "${expected_outside_sha}" != "${actual_outside_sha}" ]; then
    rm -f "${tmp}" "${outside}" "${block}" "${rebuilt}"
    rootcron_die "unrelated root crontab lines changed while the Sync block was out; reconcile by hand before resuming. The parked block is still at ${saved_block}."
    return 1
  fi

  start="$(cat "${state_dir}/rootcron.index" 2>/dev/null || echo 0)"
  case "${start}" in '' | *[!0-9]*) start=0 ;; esac

  awk -v idx="${start}" -v blockfile="${saved_block}" '
    BEGIN { emitted = 0 }
    {
      if (NR - 1 == idx) { while ((getline line < blockfile) > 0) print line; close(blockfile); emitted = 1 }
      print
    }
    END { if (!emitted) { while ((getline line < blockfile) > 0) print line; close(blockfile) } }
  ' "${outside}" > "${rebuilt}"

  rootcron_write < "${rebuilt}"

  vtmp="$(mktemp)"; voutside="$(mktemp)"; vblock="$(mktemp)"
  rootcron_read > "${vtmp}"
  if ! rootcron_split "${vtmp}" "${voutside}" "${vblock}" >/dev/null; then
    rm -f "${tmp}" "${outside}" "${block}" "${rebuilt}" "${vtmp}" "${voutside}" "${vblock}"
    rootcron_die "the root crontab is unparseable after restoring the managed block"
    return 1
  fi
  if ! cmp -s "${vblock}" "${saved_block}"; then
    rm -f "${tmp}" "${outside}" "${block}" "${rebuilt}" "${vtmp}" "${voutside}" "${vblock}"
    rootcron_die "the restored managed block is not byte-identical to the one that was removed"
    return 1
  fi
  if [ "$(rootcron_sha256_file "${voutside}")" != "${actual_outside_sha}" ]; then
    rm -f "${tmp}" "${outside}" "${block}" "${rebuilt}" "${vtmp}" "${voutside}" "${vblock}"
    rootcron_die "restoring the managed block changed unrelated root crontab lines"
    return 1
  fi

  rootcron_log "root crontab: managed Sync block restored byte-for-byte, unrelated lines untouched"
  rm -f "${saved_block}" "${saved_outside}" "${state_dir}/rootcron.index" "${state_dir}/rootcron.outside.sha256"
  rm -f "${tmp}" "${outside}" "${block}" "${rebuilt}" "${vtmp}" "${voutside}" "${vblock}"
  return 0
}
