#!/usr/bin/env bash
set -euo pipefail

# The cutover gate must refuse BEFORE the deploy touches the running system.
#
# It used to live inside run_migrations_service, which the run_migrations phase
# calls after `docker compose stop worker`. So an ordinary deploy of a
# cutover-required release stopped the production worker and only then refused.
# A gate that fires after it has already changed production is not a gate.
#
# `grep -q 'deploy/CUTOVER_REQUIRED'` in CI proves the string is present. It
# cannot prove the ORDER, which is the entire property. This runs the real phase
# against a docker that records every invocation and fails if the phase reached
# it at all.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="${REPO_ROOT}/.github/scripts/hetzner-remote.sh"
LABEL="[deploy-gate-ordering]"
FAILURES=0

pass() { printf '%s PASS %s\n' "${LABEL}" "$1"; }
fail() { printf '%s FAIL %s\n' "${LABEL}" "$1" >&2; FAILURES=$((FAILURES + 1)); }

ROOT="$(mktemp -d "${TMPDIR:-/tmp}/deploy-gate-ordering.XXXXXX")"
trap 'rm -rf "${ROOT}"' EXIT

mkdir -p "${ROOT}/bin" "${ROOT}/app/cutover" "${ROOT}/app/deploy" "${ROOT}/state"

# A docker that records rather than runs.
#
# Only MUTATING verbs count as a violation. The phase's error trap dumps
# diagnostics on the way out — `compose ps`, `compose logs`, `inspect` — and
# those run after the refusal by design and change nothing. Counting them would
# make this test fail for the right behaviour, which is how a test gets deleted
# instead of fixed.
cat > "${ROOT}/bin/docker" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${ROOT}/docker-all"
case " \$* " in
  *" stop "*|*" up "*|*" start "*|*" restart "*|*" rm "*|*" pull "*|*" run "*|*" exec "*|*" kill "*|*" down "*)
    printf '%s\n' "\$*" >> "${ROOT}/docker-invocations" ;;
esac
exit 0
STUB
chmod +x "${ROOT}/bin/docker"

for tool in curl python3 awk grep sed date printf timeout; do
  real="$(command -v "${tool}" 2>/dev/null || true)"
  [ -n "${real}" ] && ln -sf "${real}" "${ROOT}/bin/${tool}" 2>/dev/null || true
done

DEPLOY_SHA=1111111111111111111111111111111111111111

run_gated_phase() {
  local phase="$1"
  : > "${ROOT}/docker-invocations"
  : > "${ROOT}/docker-all"
  env -i PATH="${ROOT}/bin:/usr/bin:/bin" HOME="${ROOT}" \
    REMOTE_APP_DIR="${ROOT}/app" APP_DIR="${ROOT}/app" \
    DEPLOY_SHA="${DEPLOY_SHA}" \
    SYNC_CUTOVER_STATE_DIR="${ROOT}/state" \
    bash "${SCRIPT}" "${phase}" >"${ROOT}/out" 2>&1
}

# ── The delivered manifest says this release needs the cutover ──────────────
cat > "${ROOT}/app/cutover/cutover-wrapper.manifest" <<EOF
wrapper_source=scripts/hetzner-sync-cutover.sh
cutover_required=yes
delivered_deploy_sha=${DEPLOY_SHA}
EOF

if run_gated_phase run_migrations; then
  fail "G1 the ordinary deploy did NOT refuse a cutover-required release"
else
  if [ -s "${ROOT}/docker-invocations" ]; then
    fail "G1 the gate refused, but only AFTER a mutating docker command: $(tr '\n' ';' < "${ROOT}/docker-invocations")"
  elif grep -q 'cutover_required=yes' "${ROOT}/out"; then
    pass "G1 a cutover-required release is refused before ANY docker command runs — the production worker is never stopped"
  else
    fail "G1 refused for the wrong reason: $(cat "${ROOT}/out")"
  fi
fi

# ── The repository marker, which is the other half of the same gate ─────────
rm -f "${ROOT}/app/cutover/cutover-wrapper.manifest"
printf 'this release needs the cutover\n' > "${ROOT}/app/deploy/CUTOVER_REQUIRED"

if run_gated_phase run_migrations; then
  fail "G2 deploy/CUTOVER_REQUIRED did not stop the ordinary deploy"
else
  if [ -s "${ROOT}/docker-invocations" ]; then
    fail "G2 refused only after running docker: $(tr '\n' ';' < "${ROOT}/docker-invocations")"
  else
    pass "G2 deploy/CUTOVER_REQUIRED also refuses before any docker command"
  fi
fi

# ── A cutover in flight owns the database ──────────────────────────────────
rm -f "${ROOT}/app/deploy/CUTOVER_REQUIRED"
printf 'phase_chain=preflight,quiesce,fingerprint-pre\n' > "${ROOT}/state/state"

if run_gated_phase run_migrations; then
  fail "G3 an in-flight cutover did not stop the ordinary deploy"
else
  if [ -s "${ROOT}/docker-invocations" ]; then
    fail "G3 refused only after running docker: $(tr '\n' ';' < "${ROOT}/docker-invocations")"
  else
    pass "G3 an in-flight cutover refuses before any docker command, so two migration paths cannot race"
  fi
fi

if [ "${FAILURES}" -eq 0 ]; then
  printf '%s PASS all checks\n' "${LABEL}"
else
  printf '%s %s check(s) FAILED\n' "${LABEL}" "${FAILURES}" >&2
  exit 1
fi
