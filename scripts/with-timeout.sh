#!/usr/bin/env bash
# Run a command under a hard ceiling, and FAIL if the ceiling is reached.
#
# A hang is not a pass and must not be reported as one. This exists because a
# generated shim once left `shasum` blocked on stdin: no error, no output, and a
# suite that never returned. The ceiling converts that into a stated failure
# without suppressing whatever the command did manage to print.
set -uo pipefail
LIMIT="${1:?seconds}"; shift
"$@" & child=$!
( sleep "${LIMIT}"; kill -0 "${child}" 2>/dev/null && {
    printf '\n[with-timeout] ABORT the command exceeded %ss; killing it. A hang is a FAILURE, not a pass.\n' "${LIMIT}" >&2
    kill -TERM "${child}" 2>/dev/null
    sleep 5; kill -KILL "${child}" 2>/dev/null
  } ) & watchdog=$!
wait "${child}"; status=$?
kill "${watchdog}" 2>/dev/null || true
exit "${status}"
