#!/usr/bin/env bash
# Proof that the deploy's private-registry authentication is safe and ordered.
#
# The images for the current GHCR namespace are PRIVATE and the host has no
# docker login. Rather than publish them, the deploy carries a short-lived
# GITHUB_TOKEN for the duration of one phase. That is a credential crossing a
# network into a long-lived machine, so the claims about it must be executed,
# not asserted in a comment — the last time this repository trusted a comment
# about SSH forwarding, the forwarding did not exist.
#
# Everything here runs against stub `ssh`, `docker` and `docker compose`
# binaries in a temp directory. No network, no real host, no real registry.
set -euo pipefail

cd "$(dirname "$0")/.."

LABEL="[deploy-registry-auth]"
FAILURES=0
TOKEN="ghs_FAKE_TOKEN_VALUE_do_not_log_me"

pass() { printf '%s PASS %s\n' "${LABEL}" "$1"; }
fail() { printf '%s FAIL %s\n' "${LABEL}" "$1" >&2; FAILURES=$((FAILURES + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# ── Capture what run_remote_phase_on_host actually sends ─────────────────────
mkdir -p "${WORK}/bin"
cat > "${WORK}/bin/ssh" <<'STUB'
#!/usr/bin/env bash
# Last argument is the remote command; stdin is the payload.
for arg in "$@"; do cmd="$arg"; done
printf '%s' "${cmd}" > "${SSH_CAPTURE_DIR}/command"
cat > "${SSH_CAPTURE_DIR}/payload"
printf '%s\n' "$*" > "${SSH_CAPTURE_DIR}/argv"
STUB
chmod +x "${WORK}/bin/ssh"

export SSH_CAPTURE_DIR="${WORK}/capture"
mkdir -p "${SSH_CAPTURE_DIR}"

(
  PATH="${WORK}/bin:${PATH}"
  export HETZNER_USER=deploy HETZNER_PORT=22 REMOTE_APP_DIR=/var/www/adsecute
  export DEPLOY_SHA=3bc8ab68cadd56e5f841985e324bb93bd97ecbd1
  export BREAK_GLASS=false OVERRIDE_REASON=""
  export GHCR_PULL_USER=deploy-bot GHCR_PULL_TOKEN="${TOKEN}"
  export WEB_IMAGE_REPO="" WORKER_IMAGE_REPO=""
  # shellcheck disable=SC1091
  source .github/scripts/hetzner-ssh.sh
  run_remote_phase_on_host 10.0.0.1 primary prepare_runtime >/dev/null 2>&1
)

command_str="$(cat "${SSH_CAPTURE_DIR}/command")"
argv_str="$(cat "${SSH_CAPTURE_DIR}/argv")"
payload_first_line="$(head -n 1 "${SSH_CAPTURE_DIR}/payload")"
payload_rest_head="$(sed -n '2,3p' "${SSH_CAPTURE_DIR}/payload" | tr '\n' ' ')"

# ── A1: the secret is never on a command line ────────────────────────────────
if printf '%s' "${argv_str}" | grep -qF "${TOKEN}"; then
  fail "A1 the token appears in the ssh argv — visible in the remote process list"
else
  pass "A1 the token never appears in ssh argv"
fi

# ── A2: the secret travels on stdin, as line 1 ───────────────────────────────
if [ "${payload_first_line}" = "${TOKEN}" ]; then
  pass "A2 the token is the first line of the stdin payload"
else
  fail "A2 the token is not the first stdin line (got: ${payload_first_line:0:24}...)"
fi

# ── A3: a deliberate, ordered shell bundle follows it ────────────────────────
#
# The payload after the token is no longer one file. The host has no
# repository, so the shared rootcron helper travels in the same stream,
# concatenated AHEAD of the deploy script — the deploy sources nothing at
# runtime. That makes the contract stronger, not looser: this asserts the
# bundle's identity, its ORDER, that it parses as one script, and that the
# phase dispatch is still reachable. Accepting arbitrary bytes here would let
# a malformed or reordered bundle ship.
payload_bundle="${SSH_CAPTURE_DIR}/payload.bundle"
tail -n +2 "${SSH_CAPTURE_DIR}/payload" > "${payload_bundle}"

rootcron_marker_line="$(grep -n '^ROOTCRON_BEGIN=' "${payload_bundle}" | head -n 1 | cut -d: -f1)"
deploy_shebang_line="$(grep -n '^#!/usr/bin/env bash$' "${payload_bundle}" | head -n 1 | cut -d: -f1)"
rootcron_fn_line="$(grep -n '^rootcron_pause()' "${payload_bundle}" | head -n 1 | cut -d: -f1)"
phase_dispatch_line="$(grep -n '^  run_migrations)' "${payload_bundle}" | head -n 1 | cut -d: -f1)"

if [ -n "${rootcron_marker_line}" ] && [ -n "${rootcron_fn_line}" ]; then
  pass "A3a the shared rootcron helper is present in the bundle"
else
  fail "A3a the rootcron helper is missing from the payload bundle"
fi

if [ -n "${deploy_shebang_line}" ]; then
  pass "A3b the deploy script is present in the bundle"
else
  fail "A3b the deploy script is missing from the payload bundle (got: ${payload_rest_head:0:60})"
fi

# ORDER matters: the deploy defines rootcron_log/rootcron_die AFTER the helper
# so its `command -v ... ||` defaults lose to the deploy's own logging, and it
# calls rootcron_pause during a phase. Helper second would invert both.
if [ -n "${rootcron_marker_line}" ] && [ -n "${deploy_shebang_line}" ] \
  && [ "${rootcron_marker_line}" -lt "${deploy_shebang_line}" ]; then
  pass "A3c the helper precedes the deploy script in the bundle"
else
  fail "A3c bundle order is wrong (helper line ${rootcron_marker_line:-none}, deploy line ${deploy_shebang_line:-none})"
fi

if [ -n "${phase_dispatch_line}" ]; then
  pass "A3d the run_migrations phase is still reachable in the bundle"
else
  fail "A3d the phase dispatch is not present in the payload bundle"
fi

if bash -n "${payload_bundle}" 2>"${SSH_CAPTURE_DIR}/bundle.parse.err"; then
  pass "A3e the concatenated bundle parses as a single shell script"
else
  fail "A3e the bundle does not parse: $(head -n 2 "${SSH_CAPTURE_DIR}/bundle.parse.err" | tr '\n' ' ')"
fi

# The token must not have leaked into the bundle body anywhere.
if grep -qF "${TOKEN}" "${payload_bundle}"; then
  fail "A3f the token appears inside the script bundle, not only on line 1"
else
  pass "A3f the token appears nowhere in the script bundle"
fi

# ── A4: the secret is not exported into the phase environment ────────────────
# `export GHCR_PULL_TOKEN` or `GHCR_TOKEN=` on the command line would be
# readable through `ps eww` by anything running as the same user.
if printf '%s' "${command_str}" | grep -qE '(GHCR_PULL_TOKEN|GHCR_TOKEN)='; then
  fail "A4 a token-bearing variable is set on the remote command line"
else
  pass "A4 no token-bearing variable is set on the remote command line"
fi

# ── A5: the wrapper is POSIX-safe for a non-bash login shell ─────────────────
# ssh runs the command through the remote user's login shell. The wrapper is
# embedded in single quotes, so it must contain none of its own.
# The wrapper spans many lines, so this cannot be a line-oriented sed.
wrapper="$(python3 -c "import sys;t=open(sys.argv[1]).read();q=chr(39);m=chr(98)+chr(97)+chr(115)+chr(104)+chr(32)+chr(45)+chr(99)+chr(32)+q;s=t.index(m)+len(m);sys.stdout.write(t[s:t.rindex(q)])" "${SSH_CAPTURE_DIR}/command")"
if [ -z "${wrapper}" ]; then
  fail "A5 could not extract the bash -c wrapper from the remote command"
else
  if printf '%s' "${wrapper}" | grep -q "'"; then
    fail "A5 the wrapper contains a single quote and would terminate its own quoting"
  else
    pass "A5 the wrapper carries no single quote, so the outer quoting is intact"
  fi
fi

# ── Execute the wrapper for real, against stub docker ───────────────────────
cat > "${WORK}/bin/docker" <<'STUB'
#!/usr/bin/env bash
# Records how it was called, and refuses to accept a password in argv.
printf '%s\n' "$*" >> "${DOCKER_LOG}"
config_dir=""
if [ "${1:-}" = "--config" ]; then config_dir="${2:-}"; shift 2; fi
case "${1:-}" in
  login)
    for a in "$@"; do
      case "$a" in
        ghs_*|gh[pous]_*) echo "SECRET-IN-ARGV" >> "${DOCKER_LOG}"; exit 2 ;;
      esac
    done
    stdin_secret="$(cat)"
    printf 'stdin-secret=%s\n' "${stdin_secret}" >> "${DOCKER_LOG}"
    if [ "${DOCKER_LOGIN_SHOULD_FAIL:-0}" = "1" ]; then exit 1; fi
    mkdir -p "${config_dir}"
    printf '{"auths":{"ghcr.io":{"auth":"REDACTED"}}}' > "${config_dir}/config.json"
    printf '%s\n' "${config_dir}" > "${DOCKER_CONFIG_DIR_RECORD}"
    ;;
  logout) printf 'logout %s\n' "${config_dir}" >> "${DOCKER_LOG}" ;;
  *) : ;;
esac
STUB
chmod +x "${WORK}/bin/docker"

export DOCKER_LOG="${WORK}/docker.log"
export DOCKER_CONFIG_DIR_RECORD="${WORK}/config-dir"

run_wrapper() {
  : > "${DOCKER_LOG}"
  : > "${DOCKER_CONFIG_DIR_RECORD}"
  # `bash -s` inside the wrapper reads the remaining payload as its script, so
  # feed it a stand-in that records the environment the phase actually sees.
  {
    printf '%s\n' "$1"
    cat <<'PHASE'
printf 'phase=%s\n' "${1:-}" >> "${PHASE_LOG}"
printf 'DOCKER_CONFIG=%s\n' "${DOCKER_CONFIG:-unset}" >> "${PHASE_LOG}"
printf 'token_in_env=%s\n' "$(env | grep -v '^PROBE_TOKEN=' | grep -c "${PROBE_TOKEN}" || true)" >> "${PHASE_LOG}"
PHASE
  } | env PATH="${WORK}/bin:${PATH}" GHCR_USER=deploy-bot PHASE=prepare_runtime \
        PHASE_LOG="${WORK}/phase.log" PROBE_TOKEN="${TOKEN}" \
        DOCKER_LOG="${DOCKER_LOG}" DOCKER_CONFIG_DIR_RECORD="${DOCKER_CONFIG_DIR_RECORD}" \
        DOCKER_LOGIN_SHOULD_FAIL="${DOCKER_LOGIN_SHOULD_FAIL:-0}" \
        sh -c "${wrapper}"
}

: > "${WORK}/phase.log"
set +e
run_wrapper "${TOKEN}" >/dev/null 2>&1
wrapper_status=$?
set -e

# ── A6: docker received the secret on stdin, never in argv ───────────────────
if grep -q "SECRET-IN-ARGV" "${DOCKER_LOG}"; then
  fail "A6 docker login received the token as an argument"
elif grep -qF "stdin-secret=${TOKEN}" "${DOCKER_LOG}"; then
  pass "A6 docker login received the token on stdin only"
else
  fail "A6 docker login did not receive the token on stdin"
fi

# ── A7: an ephemeral DOCKER_CONFIG, not the user's ~/.docker ─────────────────
cfg_dir="$(cat "${DOCKER_CONFIG_DIR_RECORD}")"
phase_cfg="$(sed -n 's/^DOCKER_CONFIG=//p' "${WORK}/phase.log")"
if [ -n "${cfg_dir}" ] && [ "${cfg_dir}" = "${phase_cfg}" ] && [ "${cfg_dir}" != "${HOME}/.docker" ]; then
  pass "A7 the phase runs against the per-invocation DOCKER_CONFIG (${cfg_dir##*/}), not ~/.docker"
else
  fail "A7 DOCKER_CONFIG mismatch: login wrote ${cfg_dir:-<none>}, phase saw ${phase_cfg:-<none>}"
fi

# ── A8: credentials do not outlive the phase ─────────────────────────────────
if [ -n "${cfg_dir}" ] && [ ! -e "${cfg_dir}" ]; then
  pass "A8 the credential directory was removed when the phase exited"
else
  fail "A8 the credential directory survived: ${cfg_dir}"
fi
if grep -q "^logout " "${DOCKER_LOG}"; then
  pass "A8b docker logout ran before the directory was removed"
else
  fail "A8b no docker logout was issued"
fi

# ── A9: the token is not in the phase's environment ──────────────────────────
if grep -q '^token_in_env=0$' "${WORK}/phase.log"; then
  pass "A9 the token is absent from the phase environment (no ps eww exposure)"
else
  fail "A9 the token is present in the phase environment"
fi

# ── A10: login failure aborts BEFORE the phase runs at all ───────────────────
# prepare_runtime is the first host-touching phase and precedes every stop,
# migration and recreate. If auth fails here, production is untouched.
: > "${WORK}/phase.log"
set +e
DOCKER_LOGIN_SHOULD_FAIL=1 run_wrapper "${TOKEN}" >/dev/null 2>&1
failed_status=$?
set -e
if [ "${failed_status}" -eq 78 ] && [ ! -s "${WORK}/phase.log" ]; then
  pass "A10 a failed registry login exits 78 and the deploy phase never executes"
else
  fail "A10 failed login: status=${failed_status} (want 78), phase log $( [ -s "${WORK}/phase.log" ] && echo 'ran' || echo 'empty')"
fi
cfg_after_fail="$(cat "${DOCKER_CONFIG_DIR_RECORD}" 2>/dev/null || true)"
if [ -z "${cfg_after_fail}" ] || [ ! -e "${cfg_after_fail}" ]; then
  pass "A10b nothing was left behind on the failure path"
else
  fail "A10b credentials survived a failed login: ${cfg_after_fail}"
fi

# ── A11: no token supplied still works — legacy anonymous rollback ───────────
: > "${WORK}/phase.log"
set +e
run_wrapper "" >/dev/null 2>&1
anon_status=$?
set -e
if [ "${anon_status}" -eq 0 ] && grep -q '^phase=prepare_runtime$' "${WORK}/phase.log"; then
  pass "A11 with no token the phase still runs, so an anonymous legacy-namespace rollback is unaffected"
else
  fail "A11 the anonymous path broke: status=${anon_status}"
fi
if grep -q " login " "${DOCKER_LOG}"; then
  fail "A11b a login was attempted with no token"
else
  pass "A11b no login is attempted when no token is supplied"
fi

# ── A12: the pull is ordered before any mutating phase ──────────────────────
# Structural, from the workflow: the phase that pulls must precede the phases
# that stop, migrate and recreate.
first_pull="$(grep -n 'run_remote_phase_on_host prepare_runtime' .github/workflows/deploy-hetzner.yml | head -1 | cut -d: -f1 || true)"
first_mut="$(grep -nE 'run_remote_phase_on_host (run_migrations|recreate_services)' .github/workflows/deploy-hetzner.yml | head -1 | cut -d: -f1 || true)"
if [ -n "${first_pull}" ] && [ -n "${first_mut}" ] && [ "${first_pull}" -lt "${first_mut}" ]; then
  pass "A12 prepare_runtime (the pull) precedes the first mutating phase in the deploy workflow"
else
  fail "A12 could not prove the pull precedes mutation (pull=${first_pull:-?} mutate=${first_mut:-?})"
fi

# ── A13: the whole shell must exit cleanly, not just the function ───────────
#
# The gap that shipped a broken deploy. Every check above exercises
# run_remote_phase_on_host; none exercised sync_compose_to_host, and none
# exercised what happens when the STEP SHELL EXITS. The cleanup trap
# referenced a `local` in single quotes, so it expanded at trap time, after the
# function had returned and the variable was gone — and under `set -u` the
# cleanup became the failure. The function succeeded; the shell died.
#
# Deploy run 30358123511 failed exactly there, at "Sync deploy compose", having
# touched no container. This asserts the end-to-end exit status under the same
# `set -euo pipefail` the workflow step uses.
cat > "${WORK}/bin/ssh-quiet" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "${WORK}/bin/ssh-quiet"
cp "${WORK}/bin/ssh-quiet" "${WORK}/bin/ssh"

exit_probe="${WORK}/exit-probe.sh"
cat > "${exit_probe}" <<'PROBE'
set -euo pipefail
source .github/scripts/hetzner-ssh.sh
export HETZNER_USER=probe HETZNER_PORT=22 REMOTE_APP_DIR=/var/www/adsecute
sync_compose_to_host 10.0.0.1 primary >/dev/null
PROBE

set +e
PATH="${WORK}/bin:${PATH}" bash "${exit_probe}" </dev/null >/dev/null 2>"${WORK}/probe.err"
probe_status=$?
set -e
if [ "${probe_status}" -eq 0 ]; then
  pass "A13 sync_compose_to_host leaves a shell that exits 0 under set -euo pipefail"
else
  fail "A13 the shell exited ${probe_status} after a successful sync: $(tr -d '\n' < "${WORK}/probe.err" | tail -c 120)"
fi

# ── A14: no payload temp file survives ──────────────────────────────────────
leaked="$(find "${TMPDIR:-/tmp}" -maxdepth 1 -name 'tmp.*' -newer "${exit_probe}" -type f 2>/dev/null | head -3 || true)"
if [ -z "${leaked}" ]; then
  pass "A14 no stdin payload file was left behind"
else
  fail "A14 payload temp file(s) survived: ${leaked}"
fi

if [ "${FAILURES}" -ne 0 ]; then
  printf '%s %s check(s) FAILED\n' "${LABEL}" "${FAILURES}" >&2
  exit 1
fi
printf '%s PASS all checks\n' "${LABEL}"
