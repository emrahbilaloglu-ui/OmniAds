# Runs ON THE APP HOST over the forwarded session. Runs exactly ONE wrapper phase.
#
# This bypasses `cutover_runner_run`, which lives in the CI repo and is not on
# this host — so it re-applies that function's gates rather than assuming them.
# Driving the wrapper from a shell must not mean driving it with weaker checks
# than CI used.
#
# The wrapper's own output goes to a HOST-SIDE log and only a bounded tail comes
# back. That is not tidiness: streaming a phase's full output — which includes
# container logs from the docker commands it runs — is what killed the SSH
# channel with status 255 on all four CI attempts.
set -uo pipefail

need() { eval "v=\${$1:-}"; [ -n "${v}" ] || { printf 'FAIL pin %s arrived empty\n' "$1"; exit 1; }; }
for p in OP_EXPECT_FP OP_DB_SSH OP_DB_NAME OP_SHA OP_WRAPPER_SHA OP_RUNNER_DIR \
         OP_WEB_REPO OP_WORKER_REPO OP_WEB_DIGEST OP_WORKER_DIGEST \
         OP_SCHEDULER OP_STATE_DIR OP_PHASE; do need "$p"; done

die() { printf 'FAIL %s\n' "$*"; exit 1; }
log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

log "host=$(hostname) phase=${OP_PHASE} sha=${OP_SHA}"

# ── Gate 1: the forwarded agent, again, here, before anything mutates ──────
printf 'remote_agent_sock=%s\n' "${SSH_AUTH_SOCK:-<unset>}"
[ -n "${SSH_AUTH_SOCK:-}" ] && [ -S "${SSH_AUTH_SOCK}" ] \
  || die "no forwarded agent socket; the wrapper cannot reach the database host"
AL="$(ssh-add -l 2>/dev/null || true)"
AN="$(printf '%s\n' "${AL}" | grep -c 'SHA256:' || true)"
AF="$(printf '%s\n' "${AL}" | awk '/SHA256:/{print $2}' | head -1)"
[ "${AN}" = "1" ] || die "forwarded agent exposes ${AN} identities; exactly 1 required"
[ "${AF}" = "${OP_EXPECT_FP}" ] || die "forwarded identity ${AF:-<none>} != ${OP_EXPECT_FP}"
log "forwarded agent OK: exactly ${OP_EXPECT_FP}"

# ── Gate 2: the runner package, re-derived from bytes on disk ──────────────
[ -d "${OP_RUNNER_DIR}" ] || die "no runner package at ${OP_RUNNER_DIR}"
for f in hetzner-sync-cutover.sh cutover-wrapper.manifest recovery-policy.tsv runner.manifest; do
  [ -f "${OP_RUNNER_DIR}/${f}" ] || die "runner package is missing ${f}"
done
WSHA="$(sha256sum "${OP_RUNNER_DIR}/hetzner-sync-cutover.sh" | awk '{print $1}')"
PSHA="$(sha256sum "${OP_RUNNER_DIR}/recovery-policy.tsv" | awk '{print $1}')"
[ "${WSHA}" = "${OP_WRAPPER_SHA}" ] || die "wrapper hashes ${WSHA}, expected ${OP_WRAPPER_SHA}"
[ "$(awk -F= '$1=="wrapper_sha256"{print $2}' "${OP_RUNNER_DIR}/cutover-wrapper.manifest" | tr -d '[:space:]')" = "${WSHA}" ] \
  || die "cutover-wrapper.manifest does not pin the wrapper on disk"
[ "$(awk -F= '$1=="wrapper_sha256"{print $2}' "${OP_RUNNER_DIR}/runner.manifest" | tr -d '[:space:]')" = "${WSHA}" ] \
  || die "runner.manifest does not pin the wrapper on disk"
[ "$(awk -F= '$1=="image_digest"{print $2}' "${OP_RUNNER_DIR}/runner.manifest" | tr -d '[:space:]')" = "${OP_WORKER_DIGEST}" ] \
  || die "runner package was not built from ${OP_WORKER_DIGEST}"
[ "$(awk -F= '$1=="policy_sha256"{print $2}' "${OP_RUNNER_DIR}/runner.manifest" | tr -d '[:space:]')" = "${PSHA}" ] \
  || die "runner.manifest does not pin the policy on disk"
[ "$(awk -F= '$1=="delivered_policy_sha256"{print $2}' "${OP_RUNNER_DIR}/cutover-wrapper.manifest" | tr -d '[:space:]')" = "${PSHA}" ] \
  || die "cutover-wrapper.manifest does not pin the delivered policy"
log "runner package integrity OK wrapper=${WSHA}"

# ── Gate 3: the exact images, tag and digest agreeing ─────────────────────
for pair in "web ${OP_WEB_REPO} ${OP_WEB_DIGEST}" "worker ${OP_WORKER_REPO} ${OP_WORKER_DIGEST}"; do
  set -- ${pair}
  bytag="$(docker image inspect -f '{{.Id}}' "$2:${OP_SHA}" 2>/dev/null || echo MISSING)"
  bydig="$(docker image inspect -f '{{.Id}}' "$2@$3" 2>/dev/null || echo MISSING)"
  rev="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$2:${OP_SHA}" 2>/dev/null || echo MISSING)"
  [ "${bytag}" = "${bydig}" ] && [ "${bytag}" != MISSING ] || die "$1 image tag and digest disagree"
  [ "${rev}" = "${OP_SHA}" ] || die "$1 image revision ${rev} != ${OP_SHA}"
done
log "both exact images present and digest-consistent"

# ── Gate 4: the single-fresh-epoch rule ───────────────────────────────────
#
# `preflight` is the phase that OPENS an epoch, and it deliberately skips the
# wrapper-identity check so a new epoch is always reachable. That is exactly why
# it needs a guard here: run twice, it would open a second epoch and silently
# abandon the first. Every later phase needs the opposite guard — our epoch must
# already exist, or the phase would be operating inside somebody else's.
SW=""
[ -f "${OP_STATE_DIR}/state" ] && \
  SW="$(awk -F= '$1=="wrapper_sha256"{print $2}' "${OP_STATE_DIR}/state" | tr -d '[:space:]')"
if [ "${OP_PHASE}" = "preflight" ]; then
  if [ "${SW}" = "${OP_WRAPPER_SHA}" ]; then
    # An epoch opened by THIS runner already exists. Refusing is the default,
    # because a second preflight would otherwise silently abandon the first.
    #
    # DELIBERATE SUPERSEDE. There is exactly one legitimate reason to open a
    # second epoch with the same runner: the existing one's rollback artifact has
    # gone stale. A preflight artifact is a point-in-time backup and production
    # keeps writing until `quiesce` stops it — so an epoch parked at
    # `phase_chain=preflight` for days no longer guarantees zero data loss, and
    # continuing it to quiesce would silently accept that loss. The wrapper's own
    # sanctioned semantics for this are precisely "run preflight again": it
    # rewrites the state record from scratch and takes a fresh artifact.
    #
    # This is NOT a weakening of the gate. The default is still refusal. To
    # proceed, the caller must name the exact epoch it intends to supersede, that
    # name must match what is actually in the state record, and that epoch must
    # be provably finished with — so a stale value, a typo, an accidental re-run,
    # or an epoch with in-flight cutover work cannot fire it. The intent is
    # recorded in the phase log either way.
    [ -n "${OP_SUPERSEDE_EPOCH:-}" ] \
      || die "an epoch opened by THIS runner already exists (state wrapper_sha256=${SW}); a second preflight would open a second epoch. Refusing. To deliberately supersede a stale epoch, set OP_SUPERSEDE_EPOCH to its exact id."
    CUR_EPOCH="$(awk -F= '$1=="cutover_epoch"{print $2}' "${OP_STATE_DIR}/state" | tr -d '[:space:]')"
    [ "${OP_SUPERSEDE_EPOCH}" = "${CUR_EPOCH}" ] \
      || die "OP_SUPERSEDE_EPOCH='${OP_SUPERSEDE_EPOCH}' does not match the epoch in the state record ('${CUR_EPOCH}'). Refusing to supersede an epoch that is not the one actually there."
    CUR_CHAIN="$(awk -F= '$1=="phase_chain"{print $2}' "${OP_STATE_DIR}/state" | tr -d '[:space:]')"
    # "still at preflight" was a PROXY for what actually matters — that
    # superseding strands no in-flight cutover work — and the proxy is wrong in
    # both directions. An epoch that reaches `fingerprint-pre`, fails, and is
    # fully rolled back has nothing in flight, yet its artifact is now stale by
    # exactly the length of the failure; refusing there leaves no sanctioned way
    # forward at all, which is how an operator ends up hand-editing state. So the
    # proxy is replaced by the invariant itself, in two parts, both of which must
    # hold.
    #
    # PART 1 — the epoch must not have reached a phase whose effects a supersede
    # cannot take back. `quiesce` only stops things and `fingerprint-pre` only
    # reads; restoring production undoes both. From `migrate` onward the schema,
    # the runtime images or the scheduler have been moved toward the new release,
    # and a fresh preflight would silently inherit a half-moved system.
    for ph in ${CUR_CHAIN//,/ }; do
      case "${ph}" in
        preflight | quiesce | fingerprint-pre) : ;;
        *) die "epoch ${CUR_EPOCH} reached '${ph}' (phase_chain=${CUR_CHAIN}); from migrate onward a supersede would inherit a half-moved release. Refusing." ;;
      esac
    done
    # PART 2 — production must actually be back up. The runtime and the scheduler
    # are precisely what a failed quiesce leaves stopped, so proving both restored
    # is proving there is nothing left to strand. Nothing needs proving here about
    # a running wrapper: Gate 5 refuses the phase outright if one exists, before
    # the wrapper is ever invoked.
    RUNNING="$(docker ps --filter status=running --format '{{.Names}}' 2>/dev/null | grep -c '^adsecute-' || true)"
    [ "${RUNNING:-0}" -ge 2 ] \
      || die "epoch ${CUR_EPOCH} is being superseded but only ${RUNNING:-0} adsecute container(s) are running; production is not restored, so this would strand a stopped runtime. Refusing."
    BLOCK_SHA="$(awk -F= '$1=="rootcron_block_sha256"{print $2}' "${OP_STATE_DIR}/state" | tr -d '[:space:]')"
    if [ -n "${BLOCK_SHA}" ]; then
      LIVE_CRON="$(crontab -l 2>/dev/null | sha256sum | awk '{print $1}')"
      [ "${LIVE_CRON}" != "${BLOCK_SHA}" ] \
        || die "epoch ${CUR_EPOCH} is being superseded but the live crontab still hashes to its quiesce block (${BLOCK_SHA}); the scheduler was never released. Refusing."
      log "supersede precondition: scheduler released (live crontab ${LIVE_CRON} is not the quiesce block)"
    fi
    log "single-epoch guard: DELIBERATE SUPERSEDE of ${CUR_EPOCH} (phase_chain=${CUR_CHAIN}), production proven restored (${RUNNING} containers up), authorised by OP_SUPERSEDE_EPOCH"
  else
    log "single-epoch guard OK: no epoch for this runner yet"
  fi
else
  [ "${SW}" = "${OP_WRAPPER_SHA}" ] \
    || die "no epoch opened by this runner (state wrapper_sha256=${SW:-<none>}); run preflight first. Refusing to cross wrapper identities."
  log "single-epoch guard OK: operating inside this runner's epoch"
fi

# ── Gate 5: nothing else is already holding the cutover ──────────────────
N=0
for p in $(pgrep -f 'hetzner-sync-cutover' 2>/dev/null); do
  [ "$p" = "$$" ] && continue
  [ "$p" = "$PPID" ] && continue
  C="$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null)"
  case "${C}" in *pgrep*) continue ;; *hetzner-sync-cutover*) N=$((N + 1)) ;; esac
done
[ "${N}" = "0" ] || die "${N} wrapper process(es) already running; refusing to overlap"
log "no overlapping wrapper"

# ── Run the one phase ────────────────────────────────────────────────────
PHASE_LOG="/var/lib/adsecute-cutover-runner/operator-${OP_PHASE}-$(date -u +%Y%m%dT%H%M%SZ).log"
log "phase log (host-side, full): ${PHASE_LOG}"

# Byte-for-byte the environment cutover_runner_run establishes.
# SYNC_CUTOVER_INSTALL_DIR is load-bearing: the wrapper resolves its manifest AND
# its recovery policy from there, so without it the runner wrapper would read the
# INSTALLED wrapper's manifest, fail its own integrity check, and the isolation
# between the two epochs would be a fiction.
#
# Run it in the BACKGROUND and wait, rather than synchronously, purely so the
# wrapper's exact PID is knowable. Ordered shutdown must be able to signal THIS
# process — `pkill -f hetzner-sync-cutover` would also hit a concurrent run and
# is exactly the kind of broad sweep this procedure refuses. The PID file sits
# beside the log so a later, credential-free connection can find it.
#
# SYNC_CUTOVER_CONTINUES_FROM defaults to empty, which is byte-for-byte what
# cutover_runner_run establishes. It is non-empty only when the operator names a
# prior cutover, and it is needed for a release whose migration is a genuine
# no-op: `fingerprint-post` refuses an unchanged schema unless some earlier
# cutover's attestation accounts for it, so the "no schema change" claim is
# checked rather than believed. Forwarding it trusts nothing — the wrapper
# re-derives everything itself: the attestation must exist on THIS host, be
# version 1, carry a schema_identity_post byte-identical to the live schema and
# the same db_identity, and the plaintext-secret count is re-proved now instead
# of inherited. A wrong or invented name fails every one of those.
PID_FILE="${PHASE_LOG%.log}.pid"
status=0
SYNC_CUTOVER_INSTALL_DIR="${OP_RUNNER_DIR}" \
SYNC_CUTOVER_DB_SSH="${OP_DB_SSH}" \
SYNC_CUTOVER_SCHEDULER="${OP_SCHEDULER}" \
SYNC_CUTOVER_CONTINUES_FROM="${OP_CONTINUES_FROM:-}" \
DEPLOY_SHA="${OP_SHA}" \
WEB_IMAGE_REPO="${OP_WEB_REPO}" \
WORKER_IMAGE_REPO="${OP_WORKER_REPO}" \
  bash "${OP_RUNNER_DIR}/hetzner-sync-cutover.sh" "${OP_PHASE}" \
  > "${PHASE_LOG}" 2>&1 &
WRAPPER_PID=$!
printf '%s\n' "${WRAPPER_PID}" > "${PID_FILE}"
chmod 0600 "${PID_FILE}" 2>/dev/null || true
log "remote_wrapper_pid=${WRAPPER_PID} pid_file=${PID_FILE}"
wait "${WRAPPER_PID}" || status=$?
rm -f "${PID_FILE}" 2>/dev/null || true
chmod 0600 "${PHASE_LOG}" 2>/dev/null || true

log "phase exit=${status} log_bytes=$(wc -c < "${PHASE_LOG}" 2>/dev/null || echo 0)"
log "last 40 lines (value-bearing lines dropped, not rewritten):"
tail -n 40 "${PHASE_LOG}" 2>/dev/null \
  | grep -aviE '(secret|token|password|passwd|api[_-]?key|authorization|bearer|PRIVATE KEY|DATABASE_URL|_URL=)' \
  | sed 's/^/  | /'

# The state record after the phase: names and hashes only, never values.
if [ -f "${OP_STATE_DIR}/state" ]; then
  log "state record after this phase:"
  grep -aviE '(secret|token|password|api[_-]?key|authorization|bearer)' "${OP_STATE_DIR}/state" | sed 's/^/  | /'
fi

[ "${status}" = "0" ] || die "phase '${OP_PHASE}' failed with status ${status}; full log stays at ${PHASE_LOG}"
log "PHASE ${OP_PHASE} SUCCEEDED"
