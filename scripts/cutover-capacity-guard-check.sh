#!/usr/bin/env bash
# The backup capacity guard must require the FULL artifact, not a constant.
#
# It did not. `dump_input * prior_bytes * 3 / prior_input` overflows signed
# 64-bit (6.2e10 * 2.5e10 ~ 1.6e21 vs a 9.2e18 ceiling), wrapped to a small
# number, sank below the 2 GiB floor, and the floor was logged as though it were
# a measured requirement. A preflight then started with 11.12 GB free for an
# artifact that reaches 25.15 GB and drove the filesystem to 99%.
set -euo pipefail
cd "$(dirname "$0")/.."
LABEL="[cutover-capacity-guard]"
FAILURES=0
pass() { printf '%s PASS %s\n' "${LABEL}" "$1"; }
fail() { printf '%s FAIL %s\n' "${LABEL}" "$1" >&2; FAILURES=$((FAILURES + 1)); }

# Production numbers, measured on the host.
PRIOR_BYTES=25148412597      # last measured artifact
PRIOR_INPUT=62440865792      # its dump input
DUMP_INPUT=62380605440       # this run's dump input
FREE_BAD=11120386048         # app root free when the incident happened (93% used)
FREE_OK=61344235520          # after removing the two unmanifested orphans

new_required() { # scaled-to-MiB form, floor at prior_bytes, plus reserve
  local dump_mib prior_mib req reserve
  dump_mib=$(( DUMP_INPUT / 1048576 )); prior_mib=$(( PRIOR_INPUT / 1048576 ))
  req=$(( PRIOR_BYTES / prior_mib * dump_mib ))
  [ "${req}" -lt "${PRIOR_BYTES}" ] && req="${PRIOR_BYTES}"
  reserve=$(( req / 10 )); [ "${reserve}" -lt 5368709120 ] && reserve=5368709120
  echo $(( req + reserve ))
}
old_required() { # the shipped formula, verbatim
  local req; req=$(( DUMP_INPUT * PRIOR_BYTES * 3 / PRIOR_INPUT ))
  [ "${req}" -lt 2147483648 ] && req=2147483648
  echo "${req}"
}

NEW="$(new_required)"; OLD="$(old_required)"

# N1 — the defect reproduces exactly.
if [ "${OLD}" -eq 2147483648 ]; then
  pass "N1 the old formula collapses to the 2147483648B floor (overflow reproduced)"
else
  fail "N1 expected the old formula to clamp to 2147483648, got ${OLD}"
fi

# N2 — and would have ALLOWED the run that filled the disk.
if [ "${FREE_BAD}" -ge "${OLD}" ]; then
  pass "N2 the old guard ADMITS ${FREE_BAD}B free for a ~25.15GB artifact — the incident"
else
  fail "N2 the old guard unexpectedly refused; the incident is not reproduced"
fi

# P1 — the corrected requirement is at least the measured artifact.
if [ "${NEW}" -ge "${PRIOR_BYTES}" ]; then
  pass "P1 corrected requirement ${NEW}B >= last measured artifact ${PRIOR_BYTES}B"
else
  fail "P1 corrected requirement ${NEW}B is below the measured artifact ${PRIOR_BYTES}B"
fi

# P2 — no overflow: must be a sane positive number, not wrapped.
if [ "${NEW}" -gt 0 ] && [ "${NEW}" -lt 100000000000 ]; then
  pass "P2 corrected requirement is sane and unwrapped (${NEW}B)"
else
  fail "P2 corrected requirement looks overflowed: ${NEW}B"
fi

# P3 — it REFUSES the incident's free space.
if [ "${FREE_BAD}" -lt "${NEW}" ]; then
  pass "P3 corrected guard REFUSES ${FREE_BAD}B free (needs ${NEW}B)"
else
  fail "P3 corrected guard still admits ${FREE_BAD}B free — the fix does not bite"
fi

# P4 — and ADMITS the post-cleanup free space.
if [ "${FREE_OK}" -ge "${NEW}" ]; then
  pass "P4 corrected guard ADMITS ${FREE_OK}B free after orphan cleanup"
else
  fail "P4 corrected guard refuses ${FREE_OK}B; cleanup did not create a usable margin"
fi

# P5 — the wrapper actually carries the scaled form, so this cannot silently drift.
if grep -q 'prior_bytes / prior_mib \* dump_mib' scripts/hetzner-sync-cutover.sh; then
  pass "P5 the wrapper uses the MiB-scaled arithmetic"
else
  fail "P5 the wrapper no longer contains the scaled form"
fi
if grep -q 'if \[ "${artifact_required}" -lt "${prior_bytes}" \]; then artifact_required="${prior_bytes}"; fi' scripts/hetzner-sync-cutover.sh; then
  pass "P6 the wrapper floors at the last measured artifact, not a constant"
else
  fail "P6 the measured-artifact floor is missing"
fi

[ "${FAILURES}" -ne 0 ] && { printf '%s %s check(s) FAILED\n' "${LABEL}" "${FAILURES}" >&2; exit 1; }
printf '%s PASS — a fresh artifact requires its full measured size plus reserve\n' "${LABEL}"
