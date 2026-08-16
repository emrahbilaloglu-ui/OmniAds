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
command -v rootcron_read >/dev/null 2>&1 || rootcron_read() {
  crontab -l -u "${ROOTCRON_USER}" 2>/dev/null || true
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
  awk -v begin="${ROOTCRON_BEGIN}" -v end="${ROOTCRON_END}" \
      -v outside="${outside}" -v block="${block}" '
    BEGIN { inside = 0; found = 0; outcount = 0; startidx = -1 }
    {
      if (!inside && $0 == begin) { inside = 1; found = 1; startidx = outcount; print > block; next }
      if (inside) { print > block; if ($0 == end) { inside = 0 }; next }
      print > outside; outcount++
    }
    END {
      if (inside) exit 3
      if (!found) startidx = -1
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
  mkdir -p "${state_dir}"

  if rootcron_is_paused "${state_dir}"; then
    rootcron_log "a managed block is already parked in ${state_dir}; leaving it parked"
    return 0
  fi

  tmp="$(mktemp)"; outside="$(mktemp)"; block="$(mktemp)"
  rootcron_read > "${tmp}"
  if ! start="$(rootcron_split "${tmp}" "${outside}" "${block}")"; then
    rm -f "${tmp}" "${outside}" "${block}"
    rootcron_die "the root crontab has a '${ROOTCRON_BEGIN}' with no '${ROOTCRON_END}'; refusing to guess where the managed block ends"
    return 1
  fi

  if [ "${start}" = "-1" ]; then
    rootcron_log "root crontab has no managed block; nothing to pause"
    rm -f "${tmp}" "${outside}" "${block}"
    return 0
  fi

  cp "${block}" "${state_dir}/rootcron.block"
  cp "${outside}" "${state_dir}/rootcron.outside"
  printf '%s' "${start}" > "${state_dir}/rootcron.index"
  rootcron_sha256_file "${outside}" > "${state_dir}/rootcron.outside.sha256"
  chmod 0600 "${state_dir}/rootcron.block" "${state_dir}/rootcron.outside" 2>/dev/null || true

  rootcron_write < "${outside}"

  # Read back. `crontab` exiting 0 is not proof the daemon accepted the file.
  vtmp="$(mktemp)"; voutside="$(mktemp)"; vblock="$(mktemp)"
  rootcron_read > "${vtmp}"
  if ! rootcron_split "${vtmp}" "${voutside}" "${vblock}" >/dev/null; then
    rm -f "${tmp}" "${outside}" "${block}" "${vtmp}" "${voutside}" "${vblock}"
    rootcron_die "the root crontab is unparseable after removing the managed block"
    return 1
  fi
  if [ -s "${vblock}" ]; then
    rm -f "${tmp}" "${outside}" "${block}" "${vtmp}" "${voutside}" "${vblock}"
    rootcron_die "the managed block is still present after removing it"
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
  rootcron_read > "${tmp}"
  if ! rootcron_split "${tmp}" "${outside}" "${block}" >/dev/null; then
    rm -f "${tmp}" "${outside}" "${block}" "${rebuilt}"
    rootcron_die "the root crontab is unparseable; refusing to restore over it"
    return 1
  fi

  if [ -s "${block}" ]; then
    # Already back (a previous resume succeeded, or an operator restored it).
    rootcron_log "a managed block is already present; clearing the parked copy"
    rm -f "${saved_block}" "${saved_outside}" "${state_dir}/rootcron.index" "${state_dir}/rootcron.outside.sha256"
    rm -f "${tmp}" "${outside}" "${block}" "${rebuilt}"
    return 0
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
