#!/usr/bin/env bash
# PRE-DEPLOY AUDIT — atomic, backed-up, permission-preserving env-file writes.
#
# Every function here takes a FILE PATH as an argument and operates on
# nothing else — no host assumption, no hard-coded `.env.production`. That is
# what makes it testable: `automation-capability-env-harness.test.ts` runs
# these exact functions against a local temp file, no host, no SSH, no
# Docker. The remote phase script sources this same file and calls the same
# functions against the real `.env.production` on the host — one
# implementation, two invocation contexts.
#
# WHY EVERY STEP BELOW CHECKS ITS OWN EXIT STATUS EXPLICITLY, NEVER `set -e`:
# every function here is invoked via a command substitution assignment
# (`backup="$(atomic_set_env_var ...)"`, at every real call site, since the
# caller needs the printed backup path) — and bash's `errexit` is DISABLED
# for the entire body of a function executed in that context, exactly the
# same suppression rule that applies inside an `if`/`&&` condition. A bare,
# unchecked `grep`/`chown`/`cp` failure here would therefore silently fall
# through to the next line instead of aborting, which is precisely how a
# read failure partway through stripping the target key's existing lines
# could otherwise collapse the whole file down to just the one freshly
# appended line — every OTHER key the file held, gone, unnoticed.
#
# THE FOUR GUARANTEES, and how each is met:
#
#   ATOMIC   — the new content is written to a temp file on the SAME
#              directory (same filesystem, so `mv` is a rename, not a copy)
#              and `mv -f`'d over the original. A reader never observes a
#              partially-written file.
#   BACKED UP — the original is `cp -p`'d (preserving mode/mtime) to a
#              timestamped, PID-suffixed path BEFORE anything is touched, and
#              that path is returned so a caller can restore it.
#   MODE/OWNER PRESERVED, NO DUPLICATE KEY — the temp file is `chmod`/`chown`
#              to match the original's `stat` before the rename, VERIFIED
#              against the live file again AFTER the rename; every existing
#              line for the key is stripped (not just the first, and the
#              stripped line COUNT is cross-checked against what remains) so
#              a read failure cannot silently truncate the file, before
#              exactly one clean line is appended.
#   EXPLICIT FAILURE — every step above either succeeds or the function
#              returns non-zero with a named `>&2` message; nothing is ever
#              swallowed into a false "it worked".
set -euo pipefail

# GNU stat (Linux, the real host) vs BSD stat (macOS, local test harnesses).
_env_stat_mode() {
  stat -c '%a' "$1" 2>/dev/null || stat -f '%OLp' "$1"
}
_env_stat_owner() {
  stat -c '%u' "$1" 2>/dev/null || stat -f '%u' "$1"
}
_env_stat_group() {
  stat -c '%g' "$1" 2>/dev/null || stat -f '%g' "$1"
}

# _env_stat_with_fallback FN PRIMARY FALLBACK — FN applied to PRIMARY if
# that succeeds, else FN applied to FALLBACK; fails only if BOTH do.
_env_stat_with_fallback() {
  local fn="$1" primary="$2" fallback="$3" value
  if value="$("${fn}" "${primary}" 2>/dev/null)"; then
    printf '%s' "${value}"
    return 0
  fi
  "${fn}" "${fallback}"
}

# atomic_set_env_var FILE KEY VALUE [BACKUP_PATH_OUT_FILE]
# Prints the backup path on stdout on success. If BACKUP_PATH_OUT_FILE is
# given, the backup's path is ALSO written there immediately after the
# backup is created — BEFORE the strip/write/rename is even attempted — so
# a caller can always recover which backup to restore even when this
# function later returns failure, INCLUDING a failure discovered only by
# the POST-rename verification below, after the live file has already
# changed. Without this, a caller invoking `backup="$(atomic_set_env_var
# ...)"` learns NOTHING on failure (the function's only success-path output
# is its very last line), even though the mutating rename may have already
# happened.
atomic_set_env_var() {
  local file="$1" key="$2" value="$3" backup_out_file="${4:-}"

  if [ ! -f "${file}" ]; then
    echo "atomic_set_env_var: env file missing: ${file}" >&2
    return 1
  fi
  if [ ! -r "${file}" ]; then
    echo "atomic_set_env_var: env file not readable: ${file}" >&2
    return 1
  fi
  case "${key}" in
    *[!A-Za-z0-9_]*|"")
      echo "atomic_set_env_var: key must be a bare identifier, got '${key}'" >&2
      return 1
      ;;
  esac

  local mode owner group backup tmp
  mode="$(_env_stat_mode "${file}")" || {
    echo "atomic_set_env_var: could not stat mode of ${file}" >&2
    return 1
  }
  owner="$(_env_stat_owner "${file}")" || {
    echo "atomic_set_env_var: could not stat owner of ${file}" >&2
    return 1
  }
  group="$(_env_stat_group "${file}")" || {
    echo "atomic_set_env_var: could not stat group of ${file}" >&2
    return 1
  }
  backup="${file}.bak.$(date -u +%Y%m%dT%H%M%SZ).$$"
  tmp="${file}.tmp.$$"

  if ! cp -p "${file}" "${backup}"; then
    echo "atomic_set_env_var: could not create backup ${backup}" >&2
    return 1
  fi

  if [ -n "${backup_out_file}" ]; then
    if ! printf '%s\n' "${backup}" > "${backup_out_file}"; then
      echo "atomic_set_env_var: could not record the backup path to ${backup_out_file}" >&2
      rm -f "${backup}"
      return 1
    fi
  fi

  # How many lines this key does NOT own, measured BEFORE the strip — the
  # exact count the stripped file must have, so a read failure that would
  # otherwise silently truncate the write is caught by comparison, not
  # assumed away. `grep -c` exits 1 (not an error) on a legitimate ZERO
  # count — under `set -e` a bare `var="$(cmd)"` assignment aborts the
  # script on THAT exit code same as any other, so the exit status is
  # captured via an `if`, which bash exempts from -e, never via a separate
  # `$?` line that -e would already have skipped past.
  local existing_other_lines existing_status
  if existing_other_lines="$(grep -vc -E "^${key}=" "${file}" 2>/dev/null)"; then
    existing_status=0
  else
    existing_status=$?
  fi
  if [ "${existing_status}" -gt 1 ]; then
    echo "atomic_set_env_var: could not read ${file} to count non-${key} lines (grep exit ${existing_status})" >&2
    rm -f "${backup}"
    return 1
  fi

  # Strip EVERY existing line for this key — not just the first — so a file
  # that already had a duplicate (from a previous manual edit) is cleaned up
  # rather than perpetuated. `grep -v` exits 1 (not an error) when the WHOLE
  # file was lines for this key and nothing remains to keep; it exits >1 on
  # a genuine read failure — distinguished explicitly, never swallowed by a
  # blanket `|| true`, and captured the same -e-safe way as above.
  local strip_status
  if grep -v -E "^${key}=" "${file}" > "${tmp}" 2>/dev/null; then
    strip_status=0
  else
    strip_status=$?
  fi
  if [ "${strip_status}" -gt 1 ]; then
    echo "atomic_set_env_var: could not read ${file} to strip existing ${key} lines (grep exit ${strip_status})" >&2
    rm -f "${tmp}" "${backup}"
    return 1
  fi

  local tmp_line_count
  tmp_line_count="$(wc -l < "${tmp}")" || {
    echo "atomic_set_env_var: could not count lines written to ${tmp}" >&2
    rm -f "${tmp}" "${backup}"
    return 1
  }
  if [ "${tmp_line_count}" -ne "${existing_other_lines}" ]; then
    echo "atomic_set_env_var: line-count mismatch stripping ${key} — kept ${tmp_line_count}, expected ${existing_other_lines}; refusing to write a possibly-truncated file" >&2
    rm -f "${tmp}" "${backup}"
    return 1
  fi

  if ! printf '%s=%s\n' "${key}" "${value}" >> "${tmp}"; then
    echo "atomic_set_env_var: could not append ${key} to ${tmp}" >&2
    rm -f "${tmp}" "${backup}"
    return 1
  fi

  if ! chmod "${mode}" "${tmp}"; then
    echo "atomic_set_env_var: could not chmod ${tmp} to ${mode}" >&2
    rm -f "${tmp}" "${backup}"
    return 1
  fi
  if ! chown "${owner}:${group}" "${tmp}"; then
    echo "atomic_set_env_var: could not chown ${tmp} to ${owner}:${group}" >&2
    rm -f "${tmp}" "${backup}"
    return 1
  fi

  if ! mv -f "${tmp}" "${file}"; then
    echo "atomic_set_env_var: could not rename ${tmp} over ${file}" >&2
    rm -f "${tmp}"
    return 1
  fi

  # Verify mode/owner survived the rename — chmod/chown succeeding on the
  # temp file does not, by itself, prove the LIVE file ended up that way.
  local final_mode final_owner final_group
  final_mode="$(_env_stat_mode "${file}")" || {
    echo "atomic_set_env_var: could not stat ${file} after the write to verify mode" >&2
    return 1
  }
  final_owner="$(_env_stat_owner "${file}")" || {
    echo "atomic_set_env_var: could not stat ${file} after the write to verify owner" >&2
    return 1
  }
  final_group="$(_env_stat_group "${file}")" || {
    echo "atomic_set_env_var: could not stat ${file} after the write to verify group" >&2
    return 1
  }
  if [ "${final_mode}" != "${mode}" ]; then
    echo "atomic_set_env_var: post-write mode is ${final_mode}, expected ${mode} — permissions drifted across the write" >&2
    return 1
  fi
  if [ "${final_owner}" != "${owner}" ] || [ "${final_group}" != "${group}" ]; then
    echo "atomic_set_env_var: post-write owner:group is ${final_owner}:${final_group}, expected ${owner}:${group} — ownership drifted across the write" >&2
    return 1
  fi

  local final_count final_count_status
  if final_count="$(grep -c -E "^${key}=" "${file}" 2>/dev/null)"; then
    final_count_status=0
  else
    final_count_status=$?
  fi
  if [ "${final_count_status}" -gt 1 ] || [ "${final_count}" -ne 1 ]; then
    echo "atomic_set_env_var: post-write line count for ${key} is '${final_count}' (grep exit ${final_count_status}), not exactly 1" >&2
    return 1
  fi

  printf '%s\n' "${backup}"
}

# atomic_restore_env_backup FILE BACKUP
atomic_restore_env_backup() {
  local file="$1" backup="$2"

  if [ ! -f "${backup}" ]; then
    echo "atomic_restore_env_backup: backup missing: ${backup}" >&2
    return 1
  fi
  if [ ! -r "${backup}" ]; then
    echo "atomic_restore_env_backup: backup not readable: ${backup}" >&2
    return 1
  fi

  local mode owner group tmp
  mode="$(_env_stat_with_fallback _env_stat_mode "${file}" "${backup}")" || {
    echo "atomic_restore_env_backup: could not determine a mode to restore" >&2
    return 1
  }
  owner="$(_env_stat_with_fallback _env_stat_owner "${file}" "${backup}")" || {
    echo "atomic_restore_env_backup: could not determine an owner to restore" >&2
    return 1
  }
  group="$(_env_stat_with_fallback _env_stat_group "${file}" "${backup}")" || {
    echo "atomic_restore_env_backup: could not determine a group to restore" >&2
    return 1
  }
  tmp="${file}.restore.tmp.$$"

  if ! cp -p "${backup}" "${tmp}"; then
    echo "atomic_restore_env_backup: could not copy ${backup} to ${tmp}" >&2
    rm -f "${tmp}"
    return 1
  fi
  if ! chmod "${mode}" "${tmp}"; then
    echo "atomic_restore_env_backup: could not chmod ${tmp} to ${mode}" >&2
    rm -f "${tmp}"
    return 1
  fi
  if ! chown "${owner}:${group}" "${tmp}"; then
    echo "atomic_restore_env_backup: could not chown ${tmp} to ${owner}:${group}" >&2
    rm -f "${tmp}"
    return 1
  fi
  if ! mv -f "${tmp}" "${file}"; then
    echo "atomic_restore_env_backup: could not rename ${tmp} over ${file}" >&2
    rm -f "${tmp}"
    return 1
  fi

  local restored_content backup_content
  restored_content="$(cat "${file}")" || {
    echo "atomic_restore_env_backup: could not read ${file} after restoring, to verify" >&2
    return 1
  }
  backup_content="$(cat "${backup}")" || {
    echo "atomic_restore_env_backup: could not read ${backup} to verify against" >&2
    return 1
  }
  if [ "${restored_content}" != "${backup_content}" ]; then
    echo "atomic_restore_env_backup: restored content does not match the backup byte-for-byte" >&2
    return 1
  fi
}

# count_env_var_lines FILE KEY — for tests and for the workflow's own sanity checks.
count_env_var_lines() {
  grep -c -E "^${2}=" "${1}" 2>/dev/null || true
}

# read_env_var_value FILE KEY — the value of the (assumed single) line, or empty.
read_env_var_value() {
  grep -E "^${2}=" "${1}" 2>/dev/null | tail -n1 | cut -d'=' -f2- || true
}
