# Runs ON THE APP HOST over the forwarded session. READ-ONLY.
#
# Requirement 3: before any mutation, prove that the forwarded agent exposes
# exactly the operator identity and that a read-only DB-host identity probe
# succeeds. Nothing here writes, starts, stops, pulls or migrates anything.
#
# No crontab or env body is ever read into output — only hashes, counts and key
# names travel, so there is nothing for a redaction filter to have to catch.
set -uo pipefail

fail=0
ok()   { printf 'OK   %s\n' "$*"; }
bad()  { printf 'FAIL %s\n' "$*"; fail=1; }
need() { eval "v=\${$1:-}"; [ -n "${v}" ] || { printf 'FAIL pin %s arrived empty\n' "$1"; exit 1; }; }

# An empty pin must stop the run. A check that compares against "" passes
# vacuously, which is the failure mode that looks like success.
for p in OP_EXPECT_FP OP_DB_SSH OP_DB_NAME OP_SHA OP_OLD_SHA OP_WRAPPER_SHA \
         OP_RUNNER_DIR OP_WEB_REPO OP_WORKER_REPO OP_WEB_DIGEST \
         OP_WORKER_DIGEST OP_STATE_DIR OP_ENV_FILE; do need "$p"; done

printf 'host=%s utc=%s\n' "$(hostname)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ── 1. The forwarded agent ─────────────────────────────────────────────────
# The socket path is printed because the local teardown proof must be able to
# assert on this exact name after the session ends. It is a path, not a secret.
printf 'remote_agent_sock=%s\n' "${SSH_AUTH_SOCK:-<unset>}"
if [ -n "${SSH_AUTH_SOCK:-}" ] && [ -S "${SSH_AUTH_SOCK}" ]; then
  ok "forwarded agent socket present"
else
  bad "no forwarded agent socket; ForwardAgent did not take effect"
fi

AL="$(ssh-add -l 2>/dev/null || true)"
AN="$(printf '%s\n' "${AL}" | grep -c 'SHA256:' || true)"
AF="$(printf '%s\n' "${AL}" | awk '/SHA256:/{print $2}' | head -1)"
printf 'forwarded_identity_count=%s\n' "${AN}"
printf 'forwarded_fingerprint=%s\n' "${AF:-<none>}"
[ "${AN}" = "1" ] && ok "forwarded agent exposes exactly one identity" \
                  || bad "forwarded agent exposes ${AN} identities; exactly 1 required"
[ "${AF}" = "${OP_EXPECT_FP}" ] && ok "forwarded identity is the operator key" \
                               || bad "forwarded identity ${AF:-<none>} != ${OP_EXPECT_FP}"

# ── 2. Read-only DB-host identity probe ────────────────────────────────────
# The wrapper's own db_identity statement, verbatim. ControlMaster/ControlPath
# are pinned off so this probe cannot leave a reusable master behind after the
# agent is gone.
#
# StrictHostKeyChecking=yes, not accept-new: this host's key is already known and
# accepted — the app host's own key attempts to it were refused for AUTH
# ("Permission denied (publickey,password)"), not for an unverified host key,
# which is only reachable past host-key verification. So `yes` costs nothing here
# and closes the one case accept-new would have waved through: a first-contact
# key silently trusted because nobody was watching.
IDENT="$(printf '%s\n' \
  "SELECT current_database() || '|' || system_identifier::text FROM pg_control_system();" \
  | ssh -o BatchMode=yes -o ConnectTimeout=15 -o ControlMaster=no -o ControlPath=none \
        -o StrictHostKeyChecking=yes "${OP_DB_SSH}" \
    "runuser -u postgres -- psql --dbname=$(printf %q "${OP_DB_NAME}") -v ON_ERROR_STOP=1 --tuples-only --no-align --file=-" \
  2>&1 | tr -d '[:space:]')"

case "${IDENT}" in
  "${OP_DB_NAME}"'|'[0-9]*)
    ok "DB identity probe succeeded: ${IDENT}"
    ;;
  *)
    # The server's own reason is the useful part, so it is shown — it is a
    # refusal message, never credential material.
    bad "DB identity probe failed or malformed: ${IDENT:-<empty>}"
    ;;
esac

# ── 3. The pinned runner package, re-derived from bytes on disk ────────────
# Same gates cutover_runner_verify_package applies. Driving the wrapper from a
# shell must not mean driving it with weaker integrity checks than CI used.
if [ -d "${OP_RUNNER_DIR}" ]; then
  ok "runner package directory present"
  for f in hetzner-sync-cutover.sh cutover-wrapper.manifest recovery-policy.tsv runner.manifest; do
    [ -f "${OP_RUNNER_DIR}/${f}" ] && ok "package file ${f}" || bad "package missing ${f}"
  done
  WSHA="$(sha256sum "${OP_RUNNER_DIR}/hetzner-sync-cutover.sh" 2>/dev/null | awk '{print $1}')"
  PSHA="$(sha256sum "${OP_RUNNER_DIR}/recovery-policy.tsv" 2>/dev/null | awk '{print $1}')"
  MPIN="$(awk -F= '$1=="wrapper_sha256"{print $2}' "${OP_RUNNER_DIR}/cutover-wrapper.manifest" 2>/dev/null | tr -d '[:space:]')"
  RPIN="$(awk -F= '$1=="wrapper_sha256"{print $2}' "${OP_RUNNER_DIR}/runner.manifest" 2>/dev/null | tr -d '[:space:]')"
  RDIG="$(awk -F= '$1=="image_digest"{print $2}'  "${OP_RUNNER_DIR}/runner.manifest" 2>/dev/null | tr -d '[:space:]')"
  RPOL="$(awk -F= '$1=="policy_sha256"{print $2}' "${OP_RUNNER_DIR}/runner.manifest" 2>/dev/null | tr -d '[:space:]')"
  DPOL="$(awk -F= '$1=="delivered_policy_sha256"{print $2}' "${OP_RUNNER_DIR}/cutover-wrapper.manifest" 2>/dev/null | tr -d '[:space:]')"
  printf 'wrapper_sha256=%s\n' "${WSHA:-<none>}"
  [ "${WSHA}" = "${OP_WRAPPER_SHA}" ] && ok "wrapper hashes to the caller's expectation" || bad "wrapper hashes ${WSHA:-<none>}, expected ${OP_WRAPPER_SHA}"
  [ "${MPIN}" = "${WSHA}" ] && ok "wrapper manifest pins the wrapper on disk"       || bad "cutover-wrapper.manifest pins ${MPIN:-<none>}"
  [ "${RPIN}" = "${WSHA}" ] && ok "runner manifest pins the wrapper on disk"        || bad "runner.manifest pins wrapper ${RPIN:-<none>}"
  [ "${RDIG}" = "${OP_WORKER_DIGEST}" ] && ok "package built from the pinned worker digest" || bad "package records image_digest ${RDIG:-<none>}"
  [ "${RPOL}" = "${PSHA}" ] && ok "runner manifest pins the policy on disk"         || bad "runner.manifest policy ${RPOL:-<none>} != ${PSHA:-<none>}"
  [ "${DPOL}" = "${PSHA}" ] && ok "wrapper manifest pins the delivered policy"      || bad "delivered_policy_sha256 ${DPOL:-<none>} != ${PSHA:-<none>}"
else
  bad "no runner package at ${OP_RUNNER_DIR}"
fi

# ── 4. The exact images, by digest and by tag, agreeing ───────────────────
for pair in "web ${OP_WEB_REPO} ${OP_WEB_DIGEST}" "worker ${OP_WORKER_REPO} ${OP_WORKER_DIGEST}"; do
  set -- ${pair}
  svc="$1"; repo="$2"; dig="$3"
  bytag="$(docker image inspect -f '{{.Id}}' "${repo}:${OP_SHA}" 2>/dev/null || echo MISSING)"
  bydig="$(docker image inspect -f '{{.Id}}' "${repo}@${dig}"    2>/dev/null || echo MISSING)"
  rev="$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "${repo}:${OP_SHA}" 2>/dev/null || echo MISSING)"
  if [ "${bytag}" = "${bydig}" ] && [ "${bytag}" != MISSING ] && [ "${rev}" = "${OP_SHA}" ]; then
    ok "${svc} image: tag and digest resolve to one id, revision ${OP_SHA}"
  else
    bad "${svc} image mismatch bytag=${bytag} bydig=${bydig} revision=${rev}"
  fi
done

# ── 5. Single-fresh-epoch position, and current production, read-only ─────
if [ -f "${OP_STATE_DIR}/state" ]; then
  SW="$(awk -F= '$1=="wrapper_sha256"{print $2}' "${OP_STATE_DIR}/state" | tr -d '[:space:]')"
  printf 'state_wrapper_sha256=%s\n' "${SW:-<none>}"
  printf 'state_phase_chain=%s\n' "$(awk -F= '$1=="phase_chain"{print $2}' "${OP_STATE_DIR}/state")"
  if [ "${SW}" = "${OP_WRAPPER_SHA}" ]; then
    printf 'epoch_position=OUR EPOCH ALREADY OPEN — preflight would open a second one and is refused\n'
  else
    printf 'epoch_position=no epoch for this runner yet — preflight is the next legal phase\n'
  fi
else
  printf 'epoch_position=no state record at all\n'
fi

printf 'env_file_sha256=%s\n' "$(sha256sum "${OP_ENV_FILE}" | awk '{print $1}')"
printf 'lanes_enabled_count=%s\n' "$(grep -acE '^ADSECUTE_SYNC_(GLOBAL|LANE_[A-Z_]+)_ENABLED=enabled' "${OP_ENV_FILE}" || true)"
printf 'containers=%s\n' "$(docker ps -q | wc -l | tr -d ' ')"
docker ps --format '{{.Names}}|{{.Status}}|{{.Image}}' | sed 's#ghcr.io/emrahbilaloglu-ui/##' | sort
printf 'healthz=%s home=%s\n' \
  "$(curl -s -o /dev/null -w %{http_code} --max-time 10 https://adsecute.com/api/healthz)" \
  "$(curl -s -o /dev/null -w %{http_code} --max-time 10 https://adsecute.com/)"
printf 'root_disk=%s\n' "$(df -h / | tail -1 | awk '{print $5" used, "$4" avail"}')"

# Orphan / writer census, with self and pgrep excluded — an unexcluded pgrep -f
# matches its own command line and reports phantom writers.
N=0
for p in $(pgrep -f 'hetzner-sync-cutover|pg_dump|pg_restore|pg_basebackup' 2>/dev/null); do
  [ "$p" = "$$" ] && continue
  [ "$p" = "$PPID" ] && continue
  C="$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null)"
  case "${C}" in
    *pgrep*) continue ;;
    *hetzner-sync-cutover*|*pg_dump*|*pg_restore*|*pg_basebackup*) N=$((N + 1)) ;;
  esac
done
printf 'orphaned_wrappers_or_writers=%s\n' "${N}"
[ "${N}" = "0" ] && ok "nothing is holding the cutover or the database" || bad "${N} wrapper/writer process(es) present"

printf '\n'
if [ "${fail}" = "0" ]; then
  printf 'VERIFY RESULT: PASS — the forwarded credential path is proven and mutates nothing.\n'
  exit 0
fi
printf 'VERIFY RESULT: FAIL — do not proceed to any mutating phase.\n'
exit 1
