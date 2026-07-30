#!/usr/bin/env bash
# The harness GENERATES its docker shim through an unquoted heredoc.
#
# That means backticks and redirection characters inside it are interpreted when
# the shim is written, not when it runs. A comment reading
# "container-<svc>-g<generation>" wrapped in backticks was executed at generation
# time: the substitution broke the shim, a digest path expanded empty, and
# `shasum` with no argument sat reading stdin for seventeen minutes with no error
# and no output. The suite did not fail — it hung.
#
# These checks are about the generator, not the cutover.
set -euo pipefail
cd "$(dirname "$0")/.."
L="[harness-generator-safety]"; F=0
pass(){ printf '%s PASS %s\n' "$L" "$1"; }
fail(){ printf '%s FAIL %s\n' "$L" "$1" >&2; F=$((F+1)); }
H=scripts/cutover-real-postgres-harness.sh

# G1. No backticks anywhere inside the generated shim body.
SHIM_START="$(grep -n 'cat > "${host}/bin/docker"' "$H" | head -1 | cut -d: -f1 || true)"
if [ -z "${SHIM_START}" ]; then
  SHIM_START="$(grep -n 'bin/docker' "$H" | head -1 | cut -d: -f1)"
fi
SHIM_END="$(awk -v s="${SHIM_START}" 'NR>s && /^DOCKERSTUB$|^STUB$|^SHIM$/ {print NR; exit}' "$H")"
if [ -n "${SHIM_START}" ] && [ -n "${SHIM_END}" ]; then
  if sed -n "${SHIM_START},${SHIM_END}p" "$H" | grep -q '`'; then
    fail "G1 the generated shim body contains a backtick; in an unquoted heredoc that EXECUTES at generation time"
  else
    pass "G1 the generated shim body (lines ${SHIM_START}-${SHIM_END}) contains no backticks"
  fi
else
  fail "G1 could not locate the shim heredoc bounds to check it"
fi

# G2. The digest helper demands an explicit file and can never read stdin.
if grep -q 'shim_sha256()' "$H"; then
  pass "G2 a dedicated digest helper exists"
else
  fail "G2 no shim_sha256 helper; digests are computed ad hoc"
fi
for needle in '< /dev/null' 'needs exactly one non-empty file path' 'not a readable regular file'; do
  if grep -qF "$needle" "$H"; then :; else fail "G2 the digest helper lacks the guard: ${needle}"; fi
done
grep -qF '< /dev/null' "$H" && pass "G2 the digest helper reads from /dev/null, so it cannot wait on a terminal"

# G3. No bare sha256sum/shasum call inside the shim that could inherit stdin.
# The helper's OWN body legitimately names the tools; everything else must not.
if sed -n "${SHIM_START},${SHIM_END}p" "$H" \
     | awk '/^shim_sha256\(\) \{/{inhelper=1} inhelper&&/^\}/{inhelper=0;next} !inhelper' \
     | grep -qE '(sha256sum|shasum)'; then
  fail "G3 the shim calls a digest tool directly, outside the guarded helper"
else
  pass "G3 every digest inside the shim goes through the guarded helper"
fi

# G4. The generator still parses. A generation-time syntax error is exactly what
# left the previous run hung rather than failed.
if bash -n "$H"; then pass "G4 the generator parses"; else fail "G4 the generator does not parse"; fi

# G5. The helper itself, exercised: missing path, empty path and a real file.
tmp="$(mktemp)"; printf 'digest me\n' > "$tmp"
helper="$(mktemp)"
{
  echo 'set -u'
  sed -n '/^shim_sha256() {/,/^}/p' "$H" | sed 's/\\\$/$/g; s/\\${/${/g'
} > "$helper"
# shellcheck disable=SC1090
. "$helper"
if shim_sha256 </dev/null >/dev/null 2>&1; then
  fail "G5 the helper accepted no argument instead of refusing"
else
  pass "G5 no argument refuses rather than waiting on stdin"
fi
if shim_sha256 "" >/dev/null 2>&1; then
  fail "G5 the helper accepted an empty path"
else
  pass "G5 an empty path refuses"
fi
if shim_sha256 /nonexistent/definitely-not-here >/dev/null 2>&1; then
  fail "G5 the helper accepted a missing file"
else
  pass "G5 a missing file refuses"
fi
actual="$(shim_sha256 "$tmp")" || actual=""
case "$actual" in
  [0-9a-f]*) [ "${#actual}" -eq 64 ] && pass "G5 a real file yields a 64-hex digest on this platform" \
              || fail "G5 the digest is ${#actual} characters, not 64" ;;
  *) fail "G5 the helper produced no digest for a real file" ;;
esac
rm -f "$tmp" "$helper"

[ "$F" -ne 0 ] && { printf '%s %s FAILED\n' "$L" "$F" >&2; exit 1; }
printf '%s PASS — the generator cannot execute its own documentation and its digest helper cannot hang\n' "$L"
