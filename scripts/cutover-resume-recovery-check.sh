#!/usr/bin/env bash
# Proof that the cutover recovery refuses every state shape but one.
#
# The recovery exists because an ordinary deploy is correctly refused while the
# cutover state records a chain that reached `enable` but never
# `resume-scheduler`. The way out must finish the cutover, not edit its state —
# so the dangerous failure mode is not "the recovery does not run", it is "the
# recovery runs against a state it should have refused".
#
# Every case below executes the REAL `cutover_resume_precheck` out of
# .github/scripts/hetzner-remote.sh against a synthetic state directory, with
# stub docker/systemctl/pgrep. No host, no network, no real cutover.
set -euo pipefail

cd "$(dirname "$0")/.."

LABEL="[cutover-resume-recovery]"
FAILURES=0
GOOD_CHAIN="preflight,quiesce,fingerprint-pre,migrate,verify-contract,fingerprint-post,deploy-disabled,enable"
GOOD_SHA="bcc381739b9c11a28fd266e4d7c29c6a9d6a1015"

pass() { printf '%s PASS %s\n' "${LABEL}" "$1"; }
fail() { printf '%s FAIL %s\n' "${LABEL}" "$1" >&2; FAILURES=$((FAILURES + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

mkdir -p "${WORK}/bin" "${WORK}/app/cutover" "${WORK}/state"

# A stand-in wrapper carrying the same STATE_VERSION the real one does, so the
# version agreement check is exercised rather than bypassed.
real_version="$(awk -F= '/^STATE_VERSION=/ { print $2; exit }' scripts/hetzner-sync-cutover.sh | tr -d '"[:space:]')"
printf '#!/usr/bin/env bash\nSTATE_VERSION=%s\nexit 0\n' "${real_version}" > "${WORK}/app/cutover/hetzner-sync-cutover.sh"

for tool in docker systemctl pgrep fuser sha256sum; do
  case "${tool}" in
    pgrep) printf '#!/usr/bin/env bash\nexit 1\n' > "${WORK}/bin/${tool}" ;;   # nothing running
    systemctl) printf '#!/usr/bin/env bash\necho active\nexit 0\n' > "${WORK}/bin/${tool}" ;;
    sha256sum)
      # macOS has no sha256sum; shasum -a 256 prints the same two fields.
      printf '#!/usr/bin/env bash\nshasum -a 256 "$@"\n' > "${WORK}/bin/${tool}" ;;
    *) printf '#!/usr/bin/env bash\nexit 0\n' > "${WORK}/bin/${tool}" ;;
  esac
  chmod +x "${WORK}/bin/${tool}"
done
command -v sha256sum >/dev/null 2>&1 && rm -f "${WORK}/bin/sha256sum"

write_state() { # <chain> <invalidated> <deploy_sha> <state_version>
  cat > "${WORK}/state/state" <<EOF
state_version=${4}
deploy_sha=${3}
db_identity=host:5432/adsecute_prod
env_file_sha256=deadbeef
scheduler_spec=systemd:adsecute-sync.timer
scheduler_sha256=cafebabe
phase_chain=${1}
invalidated=${2}
updated_utc=2026-07-28T03:00:00Z
EOF
}

run_precheck() { # -> exit status; output in ${WORK}/out
  set +e
  PATH="${WORK}/bin:${PATH}" \
  REMOTE_APP_DIR="${WORK}/app" \
  SYNC_CUTOVER_STATE_DIR="${WORK}/state" \
  CUTOVER_RESUME_SHA="${1:-${GOOD_SHA}}" \
  DEPLOY_SHA="${1:-${GOOD_SHA}}" \
    bash .github/scripts/hetzner-remote.sh cutover_resume_precheck > "${WORK}/out" 2>&1
  local status=$?
  set -e
  return "${status}"
}

expect_refusal() { # <case> <needle>
  local name="$1" needle="$2"
  if run_precheck; then
    fail "${name} — the precheck ACCEPTED a state it must refuse"
  elif grep -q "${needle}" "${WORK}/out"; then
    pass "${name}"
  else
    fail "${name} — refused, but not for the expected reason: $(tail -2 "${WORK}/out" | tr '\n' ' ')"
  fi
}

# ── C1 the one shape it may act on ──────────────────────────────────────────
write_state "${GOOD_CHAIN}" "no" "${GOOD_SHA}" "${real_version}"
if run_precheck; then
  pass "C1 the exact expected chain ending in enable, not invalidated, is accepted"
else
  fail "C1 the legitimate state was refused: $(tail -3 "${WORK}/out" | tr '\n' ' ')"
fi

# ── C2 wrong chain: shorter, longer, reordered ──────────────────────────────
write_state "preflight,quiesce,fingerprint-pre,migrate" "no" "${GOOD_SHA}" "${real_version}"
expect_refusal "C2a a chain that never reached enable is refused" "phase_chain is"

write_state "${GOOD_CHAIN},resume-scheduler" "no" "${GOOD_SHA}" "${real_version}"
expect_refusal "C2b an ALREADY-resumed chain is refused — the recovery is idempotent by refusal" "phase_chain is"

write_state "enable,preflight,quiesce,fingerprint-pre,migrate,verify-contract,fingerprint-post,deploy-disabled" "no" "${GOOD_SHA}" "${real_version}"
expect_refusal "C2c a reordered chain is refused rather than interpreted" "phase_chain is"

# ── C3 an explicitly invalidated cutover ────────────────────────────────────
write_state "${GOOD_CHAIN}" "yes" "${GOOD_SHA}" "${real_version}"
expect_refusal "C3 an INVALIDATED cutover is refused; resume is not its legal next phase" "INVALIDATED"

# ── C4 the state describes a different release ──────────────────────────────
write_state "${GOOD_CHAIN}" "no" "0000000000000000000000000000000000000000" "${real_version}"
expect_refusal "C4 a state opened for another release is refused" "the dispatch asked for"

# ── C5 the installed wrapper did not open this cutover ──────────────────────
write_state "${GOOD_CHAIN}" "no" "${GOOD_SHA}" "99"
expect_refusal "C5 a state_version the installed wrapper does not write is refused" "did not open this cutover"

# ── C6 a wrapper process is already running ─────────────────────────────────
write_state "${GOOD_CHAIN}" "no" "${GOOD_SHA}" "${real_version}"
printf '#!/usr/bin/env bash\nexit 0\n' > "${WORK}/bin/pgrep"   # "found a match"
chmod +x "${WORK}/bin/pgrep"
expect_refusal "C6 an in-flight hetzner-sync-cutover.sh process is refused" "refusing to act underneath it"
printf '#!/usr/bin/env bash\nexit 1\n' > "${WORK}/bin/pgrep"
chmod +x "${WORK}/bin/pgrep"

# ── C7 no state at all, and no installed wrapper ────────────────────────────
mv "${WORK}/state/state" "${WORK}/state/state.away"
expect_refusal "C7a no cutover state means there is nothing to resume" "nothing to resume"
mv "${WORK}/state/state.away" "${WORK}/state/state"

mv "${WORK}/app/cutover/hetzner-sync-cutover.sh" "${WORK}/app/cutover/away"
expect_refusal "C7b a missing installed wrapper is refused, NOT delivered" "refusing to deliver one"
mv "${WORK}/app/cutover/away" "${WORK}/app/cutover/hetzner-sync-cutover.sh"

# ── C8 the recovery never writes the state itself ───────────────────────────
before="$(cat "${WORK}/state/state")"
run_precheck || true
if [ "${before}" = "$(cat "${WORK}/state/state")" ]; then
  pass "C8 the precheck leaves the state record byte-identical"
else
  fail "C8 the precheck modified the state record"
fi

# ── C9 the recovery path performs no mutating docker verb ───────────────────
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "%s/docker.log"\nexit 0\n' "${WORK}" > "${WORK}/bin/docker"
chmod +x "${WORK}/bin/docker"
: > "${WORK}/docker.log"
run_precheck || true
if grep -qE '(^| )(stop|up|start|restart|rm|pull|run|exec|kill|down) ' "${WORK}/docker.log"; then
  fail "C9 the precheck issued a mutating docker verb: $(grep -m1 -E '(stop|up|pull|rm)' "${WORK}/docker.log")"
else
  pass "C9 the precheck issues no mutating docker verb (only compose ps)"
fi

# ── C10 the phase never delivers a wrapper ──────────────────────────────────
if awk '/^  cutover_resume_(precheck|scheduler)\)/,/;;/' .github/scripts/hetzner-remote.sh \
     | grep -q 'deliver_cutover_wrapper'; then
  fail "C10 a recovery phase calls deliver_cutover_wrapper; it would overwrite the wrapper that wrote the state"
else
  pass "C10 no recovery phase delivers a wrapper over the one that opened the cutover"
fi

# ── C11 no break-glass anywhere in the recovery workflow ────────────────────
if grep -qE 'break_glass:[[:space:]]*(true|\$)' .github/workflows/cutover-resume-scheduler.yml; then
  fail "C11 the recovery workflow can pass break_glass"
else
  pass "C11 the recovery workflow never sets break_glass"
fi

# ── C12 confirmation is required, not defaulted ─────────────────────────────
if grep -qE 'INPUT_CONFIRM.*!= "resume"' .github/workflows/cutover-resume-scheduler.yml \
  && grep -A 4 'confirm:' .github/workflows/cutover-resume-scheduler.yml | grep -q 'default: "no"'; then
  pass "C12 the recovery refuses unless confirm is literally 'resume'"
else
  fail "C12 the confirmation gate is missing or defaults to the affirmative"
fi

if [ "${FAILURES}" -ne 0 ]; then
  printf '%s %s check(s) FAILED\n' "${LABEL}" "${FAILURES}" >&2
  exit 1
fi
printf '%s PASS all checks\n' "${LABEL}"
