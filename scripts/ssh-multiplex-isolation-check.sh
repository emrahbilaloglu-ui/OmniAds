#!/usr/bin/env bash
# A forwarded invocation must never reuse a master opened WITHOUT forwarding.
#
# ControlPath=~/.ssh/adsecute-deploy-%C keys on user, host and port only — NOT
# on whether the master carries an agent — and ControlPersist keeps it alive for
# ten minutes, across jobs on a runner whose home directory survives. So an
# unforwarded phase left a master that a later forwarded phase silently rode,
# reaching the app host with no agent. The wrapper then could not authenticate
# onward to the database host and reported "Permission denied
# (publickey,password)" — which reads like a wrong key and was not one.
#
# ssh takes the FIRST value it obtains for an option, so the disabling options
# must PRECEDE the multiplexing ones. Appending ForwardAgent=yes to a reused
# master achieved nothing, which is exactly how this stayed invisible.
set -euo pipefail
cd "$(dirname "$0")/.."

LABEL="[ssh-multiplex-isolation]"
FAILURES=0
pass() { printf '%s PASS %s\n' "${LABEL}" "$1"; }
fail() { printf '%s FAIL %s\n' "${LABEL}" "$1" >&2; FAILURES=$((FAILURES + 1)); }

SRC=".github/scripts/hetzner-ssh.sh"

# M1: the forwarding branch disables multiplexing at all.
branch="$(awk '/CUTOVER_FORWARD_AGENT:-0/,/^  fi$/' "${SRC}")"
case "${branch}" in
  *"ControlPath=none"*) pass "M1 the forwarding branch sets ControlPath=none" ;;
  *) fail "M1 the forwarding branch does NOT disable the shared ControlPath" ;;
esac
case "${branch}" in
  *"ControlMaster=no"*) pass "M2 the forwarding branch sets ControlMaster=no" ;;
  *) fail "M2 the forwarding branch does NOT set ControlMaster=no" ;;
esac

# M3: and does so by PREPENDING, because ssh honours the first value only.
if printf '%s\n' "${branch}" | grep -q 'ssh_opts=(-o ControlPath=none -o ControlMaster=no "${ssh_opts\[@\]}")'; then
  pass "M3 the disabling options are PREPENDED, so they win over the defaults"
else
  fail "M3 the disabling options are not prepended; ssh would keep the shared master"
fi

# M4: order actually resolves that way. Proven, not asserted: ssh -G prints the
# effective configuration, so the winning value is observable. Note ssh renders
# ControlMaster=no as "false" and omits controlpath entirely when it is none —
# checking for the literal strings passed in would fail against a correct fix.
if command -v ssh >/dev/null 2>&1; then
  eff="$(ssh -G -o ControlPath=none -o ControlMaster=no \
             -o ControlMaster=auto -o ControlPath=/tmp/should-not-win-%C \
             example.invalid 2>/dev/null | awk '$1=="controlpath"||$1=="controlmaster"{print $1"="$2}' | sort | tr '\n' ' ')"
  cm_ok=no; cp_ok=no
  case "${eff}" in *"controlmaster=false"*) cm_ok=yes ;; esac
  case "${eff}" in *"controlpath=/tmp/should-not-win"*) cp_ok=no ;; *) cp_ok=yes ;; esac
  if [ "${cm_ok}" = yes ] && [ "${cp_ok}" = yes ]; then
    pass "M4 ssh resolves first-wins: the later auto/shared-path lose (effective: ${eff:-<no control options>})"
  else
    fail "M4 ssh did not resolve first-wins: ${eff}"
  fi
else
  fail "M4 no ssh binary to prove option precedence"
fi

# M5: ordinary deploy phases still cannot request forwarding.
allow="$(awk '/CUTOVER_FORWARD_AGENT_PHASE:-/,/esac/' "${SRC}")"
m5_bad=0
for p in prepare_runtime run_migrations recreate_services cutover_runner_pull cutover_runner_install cutover_runner_remove; do
  case "${allow}" in
    *"${p}"*) fail "M5 '${p}' appears in the forwarding allowlist and must not"; m5_bad=$((m5_bad + 1)) ;;
  esac
done
# Its own counter: gating this on the SUITE's failure count would make M5 go
# quiet whenever any earlier check failed, which is when it matters most.
[ "${m5_bad}" -eq 0 ] && pass "M5 no ordinary deploy or additive runner phase may request forwarding"

# M6: the phases that genuinely reach the database ARE allowed.
for p in cutover_runner_run cutover_epoch_run cutover_ssh_diagnose; do
  case "${allow}" in
    *"${p}"*) : ;;
    *) fail "M6 '${p}' reaches the database host but is not allowlisted" ;;
  esac
done
case "${allow}" in
  *cutover_ssh_diagnose*) pass "M6 database-reaching phases are allowlisted" ;;
esac

if [ "${FAILURES}" -ne 0 ]; then
  printf '%s %s check(s) FAILED\n' "${LABEL}" "${FAILURES}" >&2
  exit 1
fi
printf '%s PASS — a forwarded invocation cannot ride an unforwarded master\n' "${LABEL}"
