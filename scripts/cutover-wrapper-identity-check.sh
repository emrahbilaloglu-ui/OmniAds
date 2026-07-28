#!/usr/bin/env bash
# Prove a cutover epoch belongs to exactly one wrapper.
#
# Why this exists. Delivering a fixed wrapper without overwriting the installed
# one means two wrappers exist on the host at once. preflight always RECORDED
# `wrapper_sha256`, but no phase ever read it back, and both wrappers write
# `state_version=2` — so the version check does not separate them. Two wrappers
# could therefore take turns driving one state record, each believing it was
# continuing its own work. That is mixed-wrapper state, and it is precisely what
# a bounded, manifest-pinned delivery is supposed to make impossible.
#
# The checks below run the REAL wrapper against real state files. W4 is the one
# that keeps this from becoming a second deadlock: preflight must stay reachable
# no matter how badly the recorded identity mismatches, because "open a new
# epoch" is the sanctioned way past a refusal — editing state is not.
set -euo pipefail

cd "$(dirname "$0")/.."

LABEL="[cutover-wrapper-identity]"
FAILURES=0
pass() { printf '%s PASS %s\n' "${LABEL}" "$1"; }
fail() { printf '%s FAIL %s\n' "${LABEL}" "$1" >&2; FAILURES=$((FAILURES + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
mkdir -p "${WORK}/bin" "${WORK}/state"

SHA="bcc381739b9c11a28fd266e4d7c29c6a9d6a1015"

for t in systemctl flock crontab; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "${WORK}/bin/${t}"; chmod +x "${WORK}/bin/${t}"
done

# `docker image inspect` must return digests that MATCH the recorded pin.
# Without this the wrapper dies at assert_image_pin, one check after the
# identity check, and W1 would pass for the wrong reason — an incidental early
# exit rather than the guard under test. The fixture has to let a foreign
# wrapper get far enough that identity is the thing that stops it.
cat > "${WORK}/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
if [ "${1:-}" = "image" ] && [ "${2:-}" = "inspect" ]; then
  case "${3:-}" in
    *worker*) printf 'sha256:workerdigestfixture\n' ;;
    *)        printf 'sha256:webdigestfixture\n' ;;
  esac
  exit 0
fi
exit 0
DOCKER
chmod +x "${WORK}/bin/docker"

# Two wrappers that differ by one byte of comment. Both are "valid" wrappers
# with correct manifests; the ONLY thing separating them is their hash, which
# is the whole point.
install_wrapper() { # <dir> <extra-comment-or-empty>
  local dir="$1" extra="${2:-}"
  mkdir -p "${dir}/cutover"
  cp scripts/hetzner-sync-cutover.sh "${dir}/cutover/hetzner-sync-cutover.sh"
  if [ -n "${extra}" ]; then
    printf '\n# %s\n' "${extra}" >> "${dir}/cutover/hetzner-sync-cutover.sh"
  fi
  local w="${dir}/cutover/hetzner-sync-cutover.sh"
  cat > "${dir}/cutover/cutover-wrapper.manifest" <<EOF
wrapper_source=scripts/hetzner-sync-cutover.sh
wrapper_sha256=$(shasum -a 256 "${w}" | awk '{print $1}')
wrapper_bytes=$(wc -c < "${w}" | tr -d ' ')
cutover_required=no
EOF
  shasum -a 256 "${w}" | awk '{print $1}'
}

HASH_A="$(install_wrapper "${WORK}/appA")"
HASH_B="$(install_wrapper "${WORK}/appB" "this wrapper differs from A by exactly this line")"

[ "${HASH_A}" != "${HASH_B}" ] \
  || { fail "fixture is wrong: both wrappers hash identically"; exit 1; }

write_state() { # <wrapper_sha256-value-or-OMIT>
  {
    echo "state_version=2"
    echo "deploy_sha=${SHA}"
    echo "db_identity=adsecute_prod|7123456789012345678"
    echo "env_file_sha256=deadbeef"
    echo "scheduler_spec=rootcron"
    echo "scheduler_sha256=absent"
    [ "$1" = "OMIT" ] || echo "wrapper_sha256=$1"
    echo "phase_chain=preflight"
    echo "invalidated=no"
    echo "updated_utc=2026-07-28T03:05:49Z"
  } > "${WORK}/state/state"
  printf 'sha256:webdigestfixture sha256:workerdigestfixture\n' > "${WORK}/state/image-pin"
}

run_wrapper() { # <app-dir> <phase>
  set +e
  PATH="${WORK}/bin:${PATH}" \
  REMOTE_APP_DIR="$1" \
  SYNC_CUTOVER_STATE_DIR="${WORK}/state" \
  SYNC_CUTOVER_SCHEDULER=rootcron \
  DEPLOY_SHA="${SHA}" \
    bash "$1/cutover/hetzner-sync-cutover.sh" "$2" > "${WORK}/out" 2>&1
  local st=$?
  set -e
  return "${st}"
}

# ── W1: a foreign wrapper is refused ────────────────────────────────────────
write_state "${HASH_A}"
if run_wrapper "${WORK}/appB" quiesce; then
  fail "W1 wrapper B CONTINUED an epoch opened by wrapper A — mixed-wrapper state is possible"
else
  if grep -q "was opened by wrapper ${HASH_A}" "${WORK}/out" \
     && grep -q "wrapper running now is ${HASH_B}" "${WORK}/out"; then
    pass "W1 wrapper B refuses an epoch opened by wrapper A, naming both hashes"
  else
    fail "W1 refused, but not for the wrapper-identity reason: $(tail -3 "${WORK}/out" | tr '\n' ' ' | cut -c1-200)"
  fi
fi

# ── W2: the refusal is about identity, not about being unable to run ────────
# Same wrapper, same state: must get PAST the identity check. It may still die
# later (this fixture has no database), so we assert the identity message is
# absent rather than that the phase succeeds.
write_state "${HASH_A}"
run_wrapper "${WORK}/appA" quiesce || true
if grep -q "was opened by wrapper" "${WORK}/out"; then
  fail "W2 wrapper A was refused against its OWN epoch — the check is too strict to use"
else
  pass "W2 wrapper A passes the identity check on its own epoch (no identity refusal)"
fi

# ── W3: a legacy state with no recorded identity fails CLOSED ───────────────
# The production state predates nothing here — but a record that cannot prove
# who opened it must refuse, not default to trusting the caller.
write_state OMIT
if run_wrapper "${WORK}/appA" quiesce; then
  fail "W3 a state with NO wrapper_sha256 was accepted — the check defaults open"
else
  if grep -q "does not say which wrapper opened this cutover" "${WORK}/out"; then
    pass "W3 a state with no recorded wrapper identity is refused, failing closed"
  else
    fail "W3 refused for another reason: $(tail -3 "${WORK}/out" | tr '\n' ' ' | cut -c1-200)"
  fi
fi

# ── W4: preflight stays reachable — this must never become a deadlock ───────
# The single most important check here. If a wrapper-identity mismatch could
# also block preflight, the fix would recreate the exact class of unfinishable
# state it exists to prevent.
if grep -n 'assert_state_invariants' scripts/hetzner-sync-cutover.sh \
     | awk -F: '{print $1}' \
     | while read -r ln; do
         awk -v target="${ln}" 'NR <= target && /^  [a-z-]+\)$/ {ph=$1} NR == target {print ph}' \
           scripts/hetzner-sync-cutover.sh
       done | grep -q '^preflight)$'; then
  fail "W4 preflight calls assert_state_invariants — a mismatch would be unrecoverable"
else
  pass "W4 preflight does NOT call assert_state_invariants, so a new epoch is always reachable"
fi

# ── W5: and preflight actually re-stamps the identity ───────────────────────
if awk '/^  preflight\)/,/^    ;;/' scripts/hetzner-sync-cutover.sh \
     | grep -q 'state_set wrapper_sha256'; then
  pass "W5 preflight records the running wrapper's hash, so the new epoch is self-consistent"
else
  fail "W5 preflight does not record wrapper_sha256; W4's escape hatch would not re-bind identity"
fi

if [ "${FAILURES}" -ne 0 ]; then
  printf '%s %s check(s) FAILED\n' "${LABEL}" "${FAILURES}" >&2
  exit 1
fi
printf '%s PASS — a cutover epoch is bound to exactly one wrapper, and preflight remains reachable\n' "${LABEL}"
