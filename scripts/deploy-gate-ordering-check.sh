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

# ── The other two phases that can mutate production on their own ───────────
#
# run_migrations is not the only reachable phase. prepare_runtime pulls images
# and OVERWRITES the cutover wrapper, and recreate_services replaces the running
# containers; both are dispatched as separate workflow steps and neither goes
# through run_migrations. Gating only run_migrations leaves both open.
rm -f "${ROOT}/state/state" "${ROOT}/app/deploy/CUTOVER_REQUIRED"
printf 'phase_chain=preflight,quiesce,fingerprint-pre\n' > "${ROOT}/state/state"

if run_gated_phase prepare_runtime; then
  fail "G4 prepare_runtime ran during a cutover; it would have overwritten the wrapper the cutover is executing"
elif [ -s "${ROOT}/docker-invocations" ]; then
  fail "G4 prepare_runtime refused only after a mutating docker command: $(tr '\n' ';' < "${ROOT}/docker-invocations")"
else
  pass "G4 prepare_runtime refuses during a cutover BEFORE the pull, so a delivery cannot rewrite a wrapper mid-run"
fi

if run_gated_phase recreate_services; then
  fail "G5 recreate_services ran during a cutover"
elif [ -s "${ROOT}/docker-invocations" ]; then
  fail "G5 recreate_services refused only after a mutating docker command: $(tr '\n' ';' < "${ROOT}/docker-invocations")"
else
  pass "G5 recreate_services refuses during a cutover before recreating anything"
fi

# ── The workflow itself ────────────────────────────────────────────────────
#
# The host script is only half of it. The gate used to live inside the "Run
# database migrations" step, whose condition ends in `inputs.run_migrations ==
# 'true'` — wired to schema_changed. A release with no schema change SKIPPED
# that step, and skipped the gate with it, then recreated the containers anyway.
# These assertions are about the workflow's structure, which is where that bug
# lived and where a grep for a string cannot reach.
WORKFLOW="${REPO_ROOT}/.github/workflows/deploy-hetzner.yml"
workflow_report="$(WORKFLOW="${WORKFLOW}" python3 - <<'PY'
import os, re, sys

path = os.environ["WORKFLOW"]
lines = open(path).read().split("\n")

# Steps in order: (index, name, condition text). The condition may be folded
# over several lines with `if: >-`.
steps, i = [], 0
while i < len(lines):
    m = re.match(r"^      - name: (.+)$", lines[i])
    if not m:
        i += 1
        continue
    name, cond, j = m.group(1).strip(), "", i + 1
    while j < len(lines) and not re.match(r"^      - name: ", lines[j]):
        c = re.match(r"^        if: (.*)$", lines[j])
        if c:
            cond = c.group(1).strip()
            if cond in (">-", "|"):
                cond, k = "", j + 1
                while k < len(lines) and re.match(r"^          \S", lines[k]):
                    cond += " " + lines[k].strip()
                    k += 1
        j += 1
    steps.append((len(steps), name, cond.strip()))
    i = j

names = [s[1] for s in steps]
def idx(pred):
    for n, nm in enumerate(names):
        if pred(nm):
            return n
    return -1

gate = idx(lambda n: "Cutover gate" in n)
problems = []

if gate < 0:
    problems.append("there is no independent 'Cutover gate' step at all")
else:
    gate_cond = steps[gate][2]
    if "run_migrations" in gate_cond:
        problems.append(
            "the gate depends on run_migrations, so a schema-unchanged release skips it: " + gate_cond
        )
    # It must precede every step that can touch the host.
    for marker in ("Prepare SSH access", "Sync deploy compose", "Prepare runtime images",
                   "Run database migrations", "Recreate web and worker"):
        at = idx(lambda n, m=marker: n.startswith(m))
        if at >= 0 and at < gate:
            problems.append(f"'{marker}' runs BEFORE the cutover gate")
    # Everything after the gate must be success()-guarded, or a gate failure
    # does not stop it. An explicit `if:` REPLACES the implicit success() guard.
    for n, nm, cond in steps[gate + 1:]:
        if cond and "success()" not in cond and "always()" not in cond and "failure()" not in cond:
            problems.append(f"step '{nm}' has a custom if: without success(), so it runs even after the gate fails")

print("PROBLEMS:" + ("|".join(problems) if problems else "none"))
print("STEPS:%d GATE_INDEX:%d" % (len(steps), gate))
PY
)"

if printf '%s' "${workflow_report}" | grep -q "PROBLEMS:none"; then
  pass "W1 the deploy workflow has an independent cutover gate that precedes every host-touching step, does not depend on run_migrations, and is followed only by success()-guarded steps ($(printf '%s' "${workflow_report}" | grep -o 'STEPS:[0-9]*'))"
else
  fail "W1 workflow gate structure is wrong: $(printf '%s' "${workflow_report}" | sed -n 's/^PROBLEMS://p')"
fi

if [ "${FAILURES}" -eq 0 ]; then
  printf '%s PASS all checks\n' "${LABEL}"
else
  printf '%s %s check(s) FAILED\n' "${LABEL}" "${FAILURES}" >&2
  exit 1
fi
