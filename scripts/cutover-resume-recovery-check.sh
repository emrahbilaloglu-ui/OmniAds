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
make_agent_socket() {
  rm -f "${WORK}/agent.sock"
  # A REAL AF_UNIX socket: the precheck tests -S, and a regular file is
  # not a socket. An earlier version of this harness used touch and every
  # case downstream refused for the wrong reason.
  python3 -c "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])" "${WORK}/agent.sock"
}
make_agent_socket

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
db_identity=${DB_IDENTITY}
env_file_sha256=deadbeef
scheduler_spec=systemd:adsecute-sync.timer
scheduler_sha256=cafebabe
phase_chain=${1}
invalidated=${2}
updated_utc=2026-07-28T03:00:00Z
EOF
}

# Stubs for the DB half: an agent that holds an identity, an ssh that reaches
# the DB host and returns the recorded identity.
DB_IDENTITY="adsecute_prod|7123456789012345678"
make_db_stubs() { # <agent-ok> <ssh-ok> <identity>
  printf '#!/usr/bin/env bash\n[ "%s" = "1" ] || exit 1\necho "256 SHA256:x runner (ED25519)"\n' "$1" \
    > "${WORK}/bin/ssh-add"
  printf '#!/usr/bin/env bash\n[ "%s" = "1" ] || exit 255\nfor a in "$@"; do case "$a" in *psql*) printf "%%s\\n" "%s"; exit 0;; esac; done\nexit 0\n' "$2" "$3" \
    > "${WORK}/bin/ssh"
  chmod +x "${WORK}/bin/ssh-add" "${WORK}/bin/ssh"
  make_agent_socket
}
make_db_stubs 1 1 "${DB_IDENTITY}"

run_precheck() { # -> exit status; output in ${WORK}/out
  set +e
  PATH="${WORK}/bin:${PATH}" \
  CUTOVER_DB_SSH="${CUTOVER_DB_SSH_OVERRIDE-root@db.example}" \
  SSH_AUTH_SOCK="${SSH_AUTH_SOCK_OVERRIDE-${WORK}/agent.sock}" \
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

# ── D-series: the forwarded database identity ───────────────────────────────
write_state "${GOOD_CHAIN}" "no" "${GOOD_SHA}" "${real_version}"
make_db_stubs 1 1 "${DB_IDENTITY}"

# D1 missing target — the wrapper would silently fall back to a local postgres.
CUTOVER_DB_SSH_OVERRIDE="" expect_refusal "D1 a missing DB ssh target is refused" "no CUTOVER_DB_SSH target"
unset CUTOVER_DB_SSH_OVERRIDE

# D2 invalid target shapes.
CUTOVER_DB_SSH_OVERRIDE="root@host;rm -rf /" expect_refusal "D2a a target with shell metacharacters is refused" "not a bare user@host"
CUTOVER_DB_SSH_OVERRIDE="87.99.149.56" expect_refusal "D2b a target with no user is refused" "must be user@host"
unset CUTOVER_DB_SSH_OVERRIDE

# D3 no forwarded agent — refuse rather than fall back to a persistent key.
SSH_AUTH_SOCK_OVERRIDE="" expect_refusal "D3a no forwarded agent is refused" "no forwarded ssh agent"
unset SSH_AUTH_SOCK_OVERRIDE
SSH_AUTH_SOCK_OVERRIDE="${WORK}/not-a-socket" expect_refusal "D3b a missing agent socket is refused" "no forwarded ssh agent"
unset SSH_AUTH_SOCK_OVERRIDE

make_db_stubs 0 1 "${DB_IDENTITY}"
expect_refusal "D3c an agent holding no identity is refused" "holds no usable identity"

# D4 the DB host refuses the connection.
make_db_stubs 1 0 "${DB_IDENTITY}"
expect_refusal "D4 an unreachable DB host is refused" "cannot reach"

# D5 the database is not the one the cutover was opened against.
make_db_stubs 1 1 "adsecute_prod|9999999999999999999"
expect_refusal "D5 a mismatched database identity is refused" "the control path was repointed"

# D6 an ordinary deploy phase can never forward the agent.
: > "${WORK}/fwd.out"
set +e
( PATH="${WORK}/bin:${PATH}" SSH_AUTH_SOCK="${WORK}/agent.sock" \
  CUTOVER_FORWARD_AGENT=1 CUTOVER_FORWARD_AGENT_PHASE=prepare_runtime \
  HETZNER_USER=x REMOTE_APP_DIR=/tmp bash -c '
    source .github/scripts/hetzner-ssh.sh
    ssh_with_stdin_retry host true </dev/null
  ' ) > "${WORK}/fwd.out" 2>&1
fwd_status=$?
set -e
if [ "${fwd_status}" -ne 0 ] && grep -q "agent forwarding refused for phase" "${WORK}/fwd.out"; then
  pass "D6 an ordinary deploy phase cannot forward the agent, even if the flag is set"
else
  fail "D6 prepare_runtime was allowed to forward the agent (status=${fwd_status})"
fi

# D7 forwarding is off by default for every ordinary phase.
if grep -q 'CUTOVER_FORWARD_AGENT' .github/workflows/deploy-hetzner.yml; then
  fail "D7 the ordinary deploy workflow mentions agent forwarding"
else
  pass "D7 the ordinary deploy workflow never enables agent forwarding"
fi

# D8 no key or agent material is written to the host.
if awk '/^cutover_resume_(precheck|invoke|assert_db_reachable_and_matching)\(\)/,/^}/' \
     .github/scripts/hetzner-remote.sh \
   | grep -qE 'ssh-add -[^l]|cp .*id_|authorized_keys|> *~/\.ssh|IdentityFile'; then
  fail "D8 the recovery writes key material on the host"
else
  pass "D8 the recovery writes no key material on the host — only the forwarded socket, removed by sshd"
fi

# D9 the runner tears the agent down whatever happens.
if grep -q 'ssh-agent -k' .github/workflows/cutover-resume-scheduler.yml \
  && grep -B 10 'ssh-agent -k' .github/workflows/cutover-resume-scheduler.yml | grep -q 'if: always()'; then
  pass "D9 the ephemeral agent is stopped on every path, including failure"
else
  fail "D9 the agent teardown is missing or not unconditional"
fi

# Restore the good stubs so any later case is honest.
make_db_stubs 1 1 "${DB_IDENTITY}"

if [ "${FAILURES}" -ne 0 ]; then
  printf '%s %s check(s) FAILED\n' "${LABEL}" "${FAILURES}" >&2
  exit 1
fi
printf '%s PASS all checks\n' "${LABEL}"
