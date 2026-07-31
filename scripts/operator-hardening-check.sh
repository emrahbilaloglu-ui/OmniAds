#!/bin/bash
# Regression suite for the operator hardening. Runs entirely locally — no
# production host is contacted by any case here.
#
# Every case that asserts a REFUSAL is as important as the ones that assert
# success: the 2026-07-30 incident was not a missing feature, it was a check that
# passed vacuously and an ordering that was wrong in the one direction that
# mattered. So the negative cases are first-class.
set -uo pipefail

ROOT="$(cd -P -- "$(dirname -- "$0")/.." && pwd -P)"
HERE="${ROOT}/scripts/operator"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/op-tests.XXXXXX")"
trap 'rm -rf "${TMP}"' EXIT

# ── STRUCTURAL no-production-contact guarantee ─────────────────────────────
#
# Not a convention and not a promise in a comment: the hosts are pointed at the
# reserved `.invalid` TLD (RFC 2606), which by definition never resolves. Every
# ssh in this suite already carries BatchMode=yes and StrictHostKeyChecking=yes,
# so a connection that somehow escaped a stub fails immediately and loudly
# instead of reaching adsecute.com. A test that can reach production is a test
# that can break production.
export OP_APP_HOST="root@operator-tests.invalid"
export OP_DB_SSH="root@operator-tests-db.invalid"
export OP_STATE_DIR="${TMP}/state"
export OP_RUNNER_ROOT="${TMP}/runner"
export OP_ENV_FILE="${TMP}/env.production"
export OP_RUNS_DIR="${TMP}/runs"
export OP_LOG_DIR="${TMP}/logs"
mkdir -p "${OP_STATE_DIR}/ssh" "${OP_RUNNER_ROOT}"

# Release pins: syntactically valid, deliberately fictional. pins.sh refuses to
# run without them, which is itself asserted below.
export OP_SHA="0000000000000000000000000000000000000000"
export OP_OLD_SHA="1111111111111111111111111111111111111111"
export OP_WRAPPER_SHA="2222222222222222222222222222222222222222222222222222222222222222"
export OP_WEB_DIGEST="sha256:3333333333333333333333333333333333333333333333333333333333333333"
export OP_WORKER_DIGEST="sha256:4444444444444444444444444444444444444444444444444444444444444444"
export OP_ENV_SHA_ENABLED="5555555555555555555555555555555555555555555555555555555555555555"

# The suite must not depend on the developer's ~/.ssh. run.sh correctly refuses
# to start without its operator key, and a CI runner has none — so on CI that
# guard fired before any stub could be reached and group 8 sat for 25s waiting
# for a connection that was never going to happen. The failure was real, but it
# was this harness being unportable, not the product misbehaving. A dummy file
# satisfies the existence guard; the stubbed ssh-add never reads its contents,
# and no real key is involved anywhere in this suite.
printf 'not-a-real-key\n' > "${TMP}/operator-key"
chmod 600 "${TMP}/operator-key"
export OP_KEY="${TMP}/operator-key"

PASS=0; FAIL=0
ok()   { printf '  PASS  %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  FAIL  %s\n' "$*"; FAIL=$((FAIL+1)); }
chk()  { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (got '$1', want '$2')"; fi; }
has()  { case "$2" in *"$1"*) ok "$3" ;; *) bad "$3 (missing '$1')" ;; esac; }
hasnt(){ case "$2" in *"$1"*) bad "$3 (unexpectedly found '$1')" ;; *) ok "$3" ;; esac; }

SCRIPTS="pins.sh run.sh lanes.sh supervise.sh host-verify.sh host-phase.sh host-teardown.sh host-signal.sh host-probe.sh"

# A real unix socket, so `[ -S ]` behaves as it does in production.
mk_socket() { python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.bind(sys.argv[1]); s.listen(1)
" "$1"; }

# ── group 1: syntax ─────────────────────────────────────────────────────────
printf '\n== 1. syntax ==\n'
for f in ${SCRIPTS}; do
  if bash -n "${HERE}/${f}" 2>/dev/null; then ok "bash -n ${f}"; else bad "bash -n ${f}"; fi
done

# ── group 2: static SSH / redaction policy ─────────────────────────────────
printf '\n== 2. static policy ==\n'
POLICY="$(python3 - "${HERE}" ${SCRIPTS} <<'PY'
import re,sys,pathlib
here=pathlib.Path(sys.argv[1]); files=sys.argv[2:]
lines=[]
for f in files:
    for l in (here/f).read_text().splitlines():
        if not l.lstrip().startswith("#"): lines.append(l)
def c(p): return sum(1 for l in lines if re.search(p,l))
print("accept_new", c(r"StrictHostKeyChecking=accept-new"))
print("shk_no",     c(r"StrictHostKeyChecking=no\b"))
print("shk_ask",    c(r"StrictHostKeyChecking=ask\b"))
print("ssh_A",      c(r"ssh\s+(-\S+\s+)*-A(\s|$)"))
print("ssh_add_c",  c(r"ssh-add\s+(-\S+\s+)*-c(\s|$)"))
print("sed_redact", c(r"sed\s+.*s[/|].*(secret|token|[Bb]earer)"))
# per-invocation host-key policy
bad=0; tot=0
for f in files:
    joined=[];buf=""
    for l in (here/f).read_text().splitlines():
        if l.lstrip().startswith("#"): continue
        buf+=l.rstrip()
        if buf.endswith("\\"): buf=buf[:-1]+" "; continue
        joined.append(buf); buf=""
    if buf: joined.append(buf)
    for inv in joined:
        for m in re.finditer(r"(?<![\w-])ssh\s",inv):
            seg=inv[m.start():]; tot+=1
            if "StrictHostKeyChecking=yes" in seg: continue
            if "SSH_OPTS[@]" in seg or "ssh_noforward" in seg or "ssh_ctl_payload" in seg or "ssh_plain" in seg: continue
            bad+=1
print("ssh_total",tot); print("ssh_noncompliant",bad)
PY
)"
get() { printf '%s\n' "${POLICY}" | awk -v k="$1" '$1==k{print $2}'; }
chk "$(get accept_new)" 0 "zero StrictHostKeyChecking=accept-new"
chk "$(get shk_no)"     0 "zero StrictHostKeyChecking=no"
chk "$(get shk_ask)"    0 "zero StrictHostKeyChecking=ask"
chk "$(get ssh_A)"      0 "zero ssh -A"
chk "$(get ssh_add_c)"  0 "zero ssh-add -c"
chk "$(get sed_redact)" 0 "zero substitution-based redaction"
chk "$(get ssh_noncompliant)" 0 "every ssh invocation pins the host-key policy ($(get ssh_total) total)"

# ── group 3: teardown evidence honesty (requirement 5) ────────────────────
printf '\n== 3. teardown evidence (requirement 5) ==\n'
run_teardown() {  # run_teardown <state_dir> <env...>
  local sd="$1"; shift
  env "$@" OP_STATE_DIR="${sd}" OP_DB_SSH="" bash "${HERE}/host-teardown.sh" 2>&1
}
SD1="${TMP}/sd1"; mkdir -p "${SD1}/ssh"

O="$(run_teardown "${SD1}" OP_FORWARDING_OCCURRED=1)"
has "forwarded_socket=UNPROVEN" "$O" "forwarding occurred + no socket path => UNPROVEN, not GONE"
hasnt "forwarded_socket=GONE"   "$O" "the vacuous GONE line is not emitted"
has "TEARDOWN_VERDICT=NOT_CLEAN" "$O" "unproven socket makes the verdict NOT_CLEAN"

O="$(run_teardown "${SD1}" OP_FORWARDING_OCCURRED=0)"
has "forwarded_socket=NOT_APPLICABLE" "$O" "no forwarding claimed => NOT_APPLICABLE"
has "TEARDOWN_VERDICT=CLEAN"          "$O" "nothing forwarded and nothing stray => CLEAN"

LIVE="${TMP}/live.sock"; mk_socket "${LIVE}"
O="$(run_teardown "${SD1}" OP_FORWARDING_OCCURRED=1 REMOTE_SOCK="${LIVE}")"
has "forwarded_socket=PRESENT"   "$O" "a socket that still exists reports PRESENT"
has "TEARDOWN_VERDICT=NOT_CLEAN" "$O" "a live forwarded socket makes the verdict NOT_CLEAN"

O="$(run_teardown "${SD1}" OP_FORWARDING_OCCURRED=1 REMOTE_SOCK="${TMP}/never-existed.sock")"
has "forwarded_socket=GONE" "$O" "a recorded path that is truly absent reports GONE"
has "forward_dir=PRESENT"   "$O" "its containing dir is reported when it still exists"

# ── group 4: termination ordering (requirement 2) ──────────────────────────
printf '\n== 4. credential withdrawal ordering (requirement 2) ==\n'
SD2="${TMP}/sd2"; mkdir -p "${SD2}/ssh"
mk_socket "${SD2}/ssh/cutover-deadbeef"

# Stub pgrep so the host script believes a wrapper is mid-flight, and stub ssh so
# a close attempt would be observable if it were (wrongly) made.
BIN="${TMP}/bin"; mkdir -p "${BIN}"
cat > "${BIN}/ssh" <<EOS
#!/bin/bash
echo "STUB_SSH_CALLED \$*" >> "${TMP}/ssh-calls.log"
exit 0
EOS
chmod +x "${BIN}/ssh"

# A process whose REAL command line contains the wrapper name. macOS has no
# /proc, so a fabricated pid could never be identity-checked and the census would
# correctly refuse to count it — which would make this case vacuous rather than
# passing. A real process plus the ps fallback exercises the true code path.
cat > "${TMP}/hetzner-sync-cutover.sh" <<'EOS'
#!/bin/bash
sleep 90
EOS
chmod +x "${TMP}/hetzner-sync-cutover.sh"
bash "${TMP}/hetzner-sync-cutover.sh" & FAKE_WRAPPER=$!
sleep 1
cat > "${BIN}/pgrep" <<EOS
#!/bin/bash
case "\$*" in *hetzner-sync-cutover*) echo ${FAKE_WRAPPER} ;; *) exit 1 ;; esac
EOS
chmod +x "${BIN}/pgrep"

: > "${TMP}/ssh-calls.log"
O="$(PATH="${BIN}:${PATH}" env OP_STATE_DIR="${SD2}" OP_DB_SSH="root@db.invalid" \
      OP_REQUIRE_TERMINAL=1 OP_FORWARDING_OCCURRED=0 \
      bash "${HERE}/host-teardown.sh" 2>&1)"
has "live_wrappers=1"           "$O" "census identifies the live wrapper by real cmdline"
has "db_master_close=REFUSED"   "$O" "live wrapper => the DB master close is REFUSED"
has "TEARDOWN_VERDICT=NOT_CLEAN" "$O" "refusing to close makes the verdict NOT_CLEAN"
hasnt "STUB_SSH_CALLED" "$(cat "${TMP}/ssh-calls.log" 2>/dev/null || echo none)" \
  "no ssh -O exit was attempted while a wrapper was live"
kill "${FAKE_WRAPPER}" 2>/dev/null || true
wait "${FAKE_WRAPPER}" 2>/dev/null || true

# host-probe.sh must agree: a live wrapper is LIVE, and it must never report
# TERMINAL on an unidentifiable process.
bash "${TMP}/hetzner-sync-cutover.sh" & FAKE2=$!
sleep 1
cat > "${BIN}/pgrep" <<EOS
#!/bin/bash
case "\$*" in *hetzner-sync-cutover*) echo ${FAKE2} ;; *) exit 1 ;; esac
EOS
chmod +x "${BIN}/pgrep"
O="$(PATH="${BIN}:${PATH}" bash "${HERE}/host-probe.sh" 2>&1)"
has "REMOTE_STATE=LIVE" "$O" "host-probe reports LIVE while a wrapper runs"
kill "${FAKE2}" 2>/dev/null || true; wait "${FAKE2}" 2>/dev/null || true
cat > "${BIN}/pgrep" <<'EOS'
#!/bin/bash
exit 1
EOS
chmod +x "${BIN}/pgrep"
O="$(PATH="${BIN}:${PATH}" bash "${HERE}/host-probe.sh" 2>&1)"
has "REMOTE_STATE=TERMINAL" "$O" "host-probe reports TERMINAL once nothing runs"

# host-signal.sh refusals: no pid file, and an identity mismatch.
RR="${TMP}/runner"; mkdir -p "${RR}"
O="$(OP_RUNNER_ROOT="${RR}" bash "${HERE}/host-signal.sh" 2>&1)"
has "resolve=no-pid-file" "$O" "host-signal refuses when no pid file exists"
sleep 300 & MISMATCH=$!
printf '%s\n' "${MISMATCH}" > "${RR}/operator-preflight-test.pid"
O="$(OP_RUNNER_ROOT="${RR}" bash "${HERE}/host-signal.sh" 2>&1)"
has "resolve=refused-identity-mismatch" "$O" "host-signal REFUSES a pid that is not a cutover wrapper"
if kill -0 "${MISMATCH}" 2>/dev/null; then ok "the mismatched process was NOT signalled"; else bad "the mismatched process was signalled"; fi
kill "${MISMATCH}" 2>/dev/null || true; wait "${MISMATCH}" 2>/dev/null || true
printf '999999999\n' > "${RR}/operator-preflight-test.pid"
O="$(OP_RUNNER_ROOT="${RR}" bash "${HERE}/host-signal.sh" 2>&1)"
has "resolve=pid-not-running" "$O" "host-signal reports a stale pid as not running"

# Same socket, no live wrapper: the close must now be attempted.
cat > "${BIN}/pgrep" <<'EOS'
#!/bin/bash
exit 1
EOS
chmod +x "${BIN}/pgrep"
: > "${TMP}/ssh-calls.log"
O="$(PATH="${BIN}:${PATH}" env OP_STATE_DIR="${SD2}" OP_DB_SSH="root@db.invalid" \
      OP_REQUIRE_TERMINAL=1 OP_FORWARDING_OCCURRED=0 \
      bash "${HERE}/host-teardown.sh" 2>&1)"
has "db_master_found=cutover-deadbeef" "$O" "the DB master is discovered by exact name"
if grep -q 'STUB_SSH_CALLED' "${TMP}/ssh-calls.log" 2>/dev/null; then
  ok "no live wrapper => the close IS attempted"
  has "StrictHostKeyChecking=yes" "$(cat "${TMP}/ssh-calls.log")" "the close carries an explicit host-key policy"
else
  bad "no live wrapper => the close should have been attempted"
fi

# ── group 5: supervisor survives the invoking parent (requirement 1) ───────
printf '\n== 5. disconnect rehearsal (requirement 1) ==\n'
MARKER="${TMP}/mock-completed"
# A "long" task: long enough that the parent is certainly killed mid-flight.
MOCK="sleep 12; printf done > $(printf %q "${MARKER}")"

# The invoking parent runs in its OWN process group, then gets SIGTERM'd exactly
# as the Claude/UI parent did at 07:17:03Z. If the supervisor shares that group
# or session it dies with it — which is the bug being tested for.
PARENT_OUT="${TMP}/parent.out"
set -m
(
  OP_SUPERVISE_MOCK=1 OP_SUPERVISE_MOCK_CMD="${MOCK}" \
  bash "${HERE}/supervise.sh" start verify > "${PARENT_OUT}" 2>&1
  sleep 300
) &
PARENT_PGID=$!
set +m

# wait for the run to register
RID=""
for _ in $(seq 1 30); do
  RID="$(awk -F= '/^RUN_ID=/{print $2}' "${PARENT_OUT}" 2>/dev/null | head -1)"
  [ -n "${RID}" ] && break
  sleep 1
done

if [ -z "${RID}" ]; then
  bad "supervised mock run never registered (see ${PARENT_OUT})"
else
  ok "supervised run registered: ${RID}"
  SPID="$(cat "${OP_RUNS_DIR}/${RID}/supervisor.pid" 2>/dev/null || echo)"
  # PGID, not `ps -o sess=`: on macOS the sess field is always 0 and proves
  # nothing. Group leadership (pgid == own pid) is the observable that matters,
  # and the kill below is the behavioural proof regardless of ps field support.
  SPGID="$(ps -o pgid= -p "${SPID}" 2>/dev/null | tr -d ' ')"
  MYPGID="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"
  if [ -n "${SPID}" ] && [ "${SPGID}" = "${SPID}" ] && [ "${SPGID}" != "${MYPGID}" ]; then
    ok "supervisor leads its own group (pgid=${SPGID}=pid, invoker=${MYPGID}) — detach took effect"
  else
    bad "supervisor did not detach (pgid=${SPGID} pid=${SPID} invoker=${MYPGID})"
  fi

  # Kill the invoking parent's whole process group, hard.
  kill -TERM -"${PARENT_PGID}" 2>/dev/null || kill -TERM "${PARENT_PGID}" 2>/dev/null || true
  sleep 2
  kill -KILL -"${PARENT_PGID}" 2>/dev/null || true
  ok "invoking parent process group killed mid-task"

  if [ -n "${SPID}" ] && kill -0 "${SPID}" 2>/dev/null; then
    ok "supervisor survived the parent's death"
  else
    bad "supervisor died with its parent — session severance not survived"
  fi

  # Prove it reaches its NATURAL terminal result, not just that it is alive.
  REACHED=0
  for _ in $(seq 1 40); do
    [ -f "${MARKER}" ] && { REACHED=1; break; }
    sleep 1
  done
  chk "${REACHED}" 1 "supervised task ran to its natural completion after the parent died"
  # The marker is written by the child just before it exits; the supervisor needs
  # one more poll interval to observe that and record the outcome. Reading the
  # status immediately is a race, and it must not be resolved by a bare sleep —
  # wait for the terminal status itself. Leaving a run stuck at 'running' would
  # also (correctly) make the overlap guard refuse every later case.
  ST="running"
  for _ in $(seq 1 30); do
    ST="$(cat "${OP_RUNS_DIR}/${RID}/status" 2>/dev/null || echo none)"
    [ "${ST}" != "running" ] && break
    sleep 1
  done
  chk "${ST}" "finished" "run status reached 'finished'"
  chk "$(cat "${OP_RUNS_DIR}/${RID}/exit.code" 2>/dev/null || echo none)" "0" "natural exit code recorded"
fi

# ── group 6: bounded lifetime becomes ORDERED shutdown, not a kill ─────────
printf '\n== 6. bounded lifetime (requirement 1) ==\n'
OUT2="${TMP}/life.out"
# OP_SUPERVISE_MOCK also stubs ssh_ctl_payload, so ordered shutdown exercises its
# real sequencing without opening a single connection to production.
OP_SUPERVISE_MOCK=1 OP_SUPERVISE_MOCK_CMD="sleep 120" OP_MAX_LIFETIME_S=5 OP_REMOTE_DRAIN_S=10 \
OP_MOCK_REMOTE_STATE=TERMINAL OP_MOCK_SIGNAL_RESULT=signalled \
  bash "${HERE}/supervise.sh" start verify > "${OUT2}" 2>&1
RID2="$(awk -F= '/^RUN_ID=/{print $2}' "${OUT2}" | head -1)"
if [ -z "${RID2}" ]; then
  bad "bounded-lifetime run never registered"
else
  SP2="$(cat "${OP_RUNS_DIR}/${RID2}/supervisor.pid" 2>/dev/null || echo)"
  W=0; while [ -n "${SP2}" ] && kill -0 "${SP2}" 2>/dev/null && [ "${W}" -lt 90 ]; do sleep 2; W=$((W+2)); done
  ST2="$(cat "${OP_RUNS_DIR}/${RID2}/status" 2>/dev/null || echo none)"
  case "${ST2}" in
    deadline-expired|stopped-ordered|ambiguous-remote-credential-left-live)
      ok "deadline produced an ordered outcome: ${ST2}" ;;
    *) bad "deadline produced '${ST2}', expected an ordered outcome" ;;
  esac
  SUPLOG="$(cat "${OP_RUNS_DIR}/${RID2}/supervisor.log" 2>/dev/null || echo)"
  has "converting to ORDERED shutdown" "${SUPLOG}" "deadline converts to ordered shutdown rather than a kill"
  has "ordered_shutdown begin"         "${SUPLOG}" "ordered shutdown was entered"
  has "step 1/5"                       "${SUPLOG}" "step 1 (signal remote) is emitted"
  has "step 2/5"                       "${SUPLOG}" "step 2 (bounded wait) is emitted"
  # The credential steps must come AFTER the wait, in order.
  S1="$(printf '%s\n' "${SUPLOG}" | grep -n 'step 1/5' | head -1 | cut -d: -f1)"
  S2="$(printf '%s\n' "${SUPLOG}" | grep -n 'step 2/5' | head -1 | cut -d: -f1)"
  S45="$(printf '%s\n' "${SUPLOG}" | grep -nE 'step (3|4)/5' | head -1 | cut -d: -f1)"
  if [ -n "${S1}" ] && [ -n "${S2}" ] && [ -n "${S45}" ] && [ "${S1}" -lt "${S2}" ] && [ "${S2}" -lt "${S45}" ]; then
    ok "ordering is signal -> bounded wait -> credential teardown"
  else
    bad "step ordering wrong (1=${S1} 2=${S2} 3/4=${S45})"
  fi
fi

# ── group 7: overlap refusal + mock-seam refusal ───────────────────────────
printf '\n== 7. refusals ==\n'
O="$(OP_SUPERVISE_MOCK=1 OP_SUPERVISE_MOCK_CMD=true bash "${HERE}/supervise.sh" start phase preflight 2>&1 || true)"
has "mock seam must never be used with a real phase" "$O" "mock seam refuses a real phase"
O="$(bash "${HERE}/supervise.sh" start phase not-a-phase 2>&1 || true)"
has "is not a legal phase" "$O" "an unknown phase name is refused"
O="$(bash "${HERE}/supervise.sh" start verify extra 2>&1 || true)"
has "verify takes no phase argument" "$O" "verify refuses a stray argument"

# ── group 8: op-run reports teardown exactly once, under signal ───────────
printf '\n== 8. teardown reported once under signal (requirement 5) ==\n'
#
# This has to exercise the REAL traps, because the defect is that a signalled
# exit fires the signal trap AND the EXIT trap. It must also never contact
# production, so ssh/ssh-agent/ssh-add are stubbed on PATH. Note that pins.sh
# assigns OP_KEY unconditionally, so an inherited OP_KEY is discarded — an
# "invalid key" shortcut would have sailed past the guard and dialled the real
# host. Stubs, not env tricks.
STUB="${TMP}/stub"; mkdir -p "${STUB}"
cat > "${STUB}/ssh-agent" <<'EOS'
#!/bin/bash
SOCK=""
while [ $# -gt 0 ]; do case "$1" in -a) SOCK="$2"; shift 2 ;; *) shift ;; esac; done
python3 -c "
import socket,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM); s.bind(sys.argv[1]); s.listen(1)
" "$SOCK"
# stdio MUST be detached: op-run reads this stub through $( ), and a background
# child that keeps the stdout pipe open makes the command substitution block
# until the child exits — 600s of nothing, which is what made this case fail.
sleep 600 </dev/null >/dev/null 2>&1 &
echo "SSH_AUTH_SOCK=$SOCK; export SSH_AUTH_SOCK;"
echo "SSH_AGENT_PID=$!; export SSH_AGENT_PID;"
EOS
cat > "${STUB}/ssh-add" <<'EOS'
#!/bin/bash
for a in "$@"; do [ "$a" = "-l" ] && {
  echo "256 SHA256:VqHQoYUYI4aIj0KnYvWZEUp/BHAMFkuBksYRJDD+KQ4 stub (ED25519)"; exit 0; }
done
exit 0
EOS
cat > "${STUB}/ssh" <<EOS
#!/bin/bash
case "\$*" in
  *ForwardAgent=yes*)
    # stand in for a long forwarded phase: announce the socket, then block.
    # The marker is how the test knows forwarding really started — see below.
    touch "${TMP}/forward.started"
    echo "remote_agent_sock=/tmp/ssh-STUBDIR/agent.1"
    sleep 600 ;;
  *)
    echo "TEARDOWN_VERDICT=CLEAN"; exit 0 ;;
esac
EOS
chmod +x "${STUB}/ssh-agent" "${STUB}/ssh-add" "${STUB}/ssh"

RUNOUT="${TMP}/once.out"
# Started directly, NOT inside a `( … )` subshell: $! must be run.sh itself so
# the SIGTERM lands on the process whose traps are under test. TERMing a wrapping
# subshell would leave run.sh orphaned and its traps unfired.
#
# `set -m` makes it a process-group leader so the group can be signalled. That is
# the FAITHFUL reproduction of the incident: the invoker's death took the ssh
# connection with it, so op-run's foreground pipeline returned and its trap ran.
# Signalling op-run alone would instead expose a bash property worth stating —
# a trap is DEFERRED until the running foreground command returns, so while the
# forwarded ssh is still alive the driver's own trap cannot fire. That is exactly
# why ordered shutdown lives in supervise.sh, which is not blocked on the
# pipeline, rather than relying on this trap for timeliness.
set -m
PATH="${STUB}:${PATH}" bash "${HERE}/run.sh" verify >"${RUNOUT}" 2>&1 &
RUNPID=$!
set +m
# Wait on a marker FILE the stub creates, not on op-run's output and not on
# pgrep.
#
#   - op-run pipes through `grep` into `tee`, and grep block-buffers to a pipe, so
#     its output can lag the event by many seconds.
#   - `pgrep -f 'ForwardAgent=yes'` matches THIS shell, whose own command line
#     contains that literal string, so it succeeds instantly and the TERM lands
#     before the agent even exists. That produced a "failure" whose message —
#     "nothing was ever forwarded" — was in fact the correct report for 1s in.
#     Same pgrep self-match class as the phantom pg_dump writers earlier.
REACHED_CONN=0
for _ in $(seq 1 25); do
  if [ -f "${TMP}/forward.started" ]; then REACHED_CONN=1; break; fi
  sleep 1
done
if [ "${REACHED_CONN}" = "1" ]; then
  ok "stubbed forwarded phase reached the connection stage"
  kill -TERM -"${RUNPID}" 2>/dev/null || kill -TERM "${RUNPID}" 2>/dev/null || true
  W=0; while kill -0 "${RUNPID}" 2>/dev/null && [ "${W}" -lt 60 ]; do sleep 2; W=$((W+2)); done
  kill -KILL -"${RUNPID}" 2>/dev/null || true
  # `grep -c` prints its count AND exits 1 when the count is zero, so a trailing
  # `|| echo 0` emits a SECOND line and the comparison sees "0\n0". Pipe through
  # head instead, which keeps the count and swallows the exit status.
  cnt() { grep -c "$1" "$2" 2>/dev/null | head -1; }
  N="$(cnt 'teardown begins' "${RUNOUT}")"
  chk "${N}" "1" "SIGTERM fires the teardown block exactly once (was twice in the incident)"
  V="$(cnt 'remote_forward_teardown=' "${RUNOUT}")"
  chk "${V}" "1" "exactly one teardown verdict is reported"
  hasnt "nothing was ever forwarded" "$(cat "${RUNOUT}")" \
    "a forwarded run never claims 'nothing was ever forwarded'"
else
  bad "stubbed run never reached the connection stage (see ${RUNOUT})"
  kill -KILL "${RUNPID}" 2>/dev/null || true
fi

# ── group 9: structural no-production-contact + pins refusal ──────────────
printf '\n== 9. structural safety ==\n'
case "${OP_APP_HOST}" in *.invalid) ok "app host is a reserved .invalid name — cannot resolve" ;;
  *) bad "app host ${OP_APP_HOST} is resolvable; this suite could reach a real host" ;; esac
case "${OP_DB_SSH}" in *.invalid) ok "db host is a reserved .invalid name — cannot resolve" ;;
  *) bad "db host ${OP_DB_SSH} is resolvable; this suite could reach a real host" ;; esac
hasnt "adsecute.com" "${OP_APP_HOST} ${OP_DB_SSH}" "no production hostname is configured in the suite"

# The pins file must REFUSE a release-less invocation rather than compare against
# empty strings, which is the failure mode that looks exactly like success.
O="$(env -u OP_SHA -u OP_OLD_SHA -u OP_WRAPPER_SHA -u OP_WEB_DIGEST -u OP_WORKER_DIGEST \
      -u OP_ENV_SHA_ENABLED bash "${HERE}/run.sh" verify 2>&1 || true)"
has "release pins are unset" "$O" "run.sh refuses to run without release pins"
hasnt "LOCAL AGENT PROOF OK" "$O" "no agent is started when the pins are unset"

O="$(env OP_SHA=nothex bash "${HERE}/run.sh" verify 2>&1 || true)"
has "OP_SHA is not hexadecimal" "$O" "a malformed target sha is refused by shape"

O="$(env OP_WEB_DIGEST=notadigest bash "${HERE}/run.sh" verify 2>&1 || true)"
has "OP_WEB_DIGEST must be sha256:" "$O" "a malformed image digest is refused by shape"

# The derived runner directory must agree with the pins it describes.
O="$(bash -c 'HERE="'"${HERE}"'"; . "${HERE}/pins.sh"; printf "%s\n" "${OP_RUNNER_DIR}"')"
case "${O}" in
  */"${OP_SHA}-${OP_WRAPPER_SHA:0:12}") ok "runner dir is DERIVED from the pins, not supplied separately" ;;
  *) bad "runner dir '${O}' does not follow from the pins" ;;
esac

printf '\n== summary ==\n'
printf '  passed=%s failed=%s\n' "${PASS}" "${FAIL}"
[ "${FAIL}" = "0" ] || exit 1
