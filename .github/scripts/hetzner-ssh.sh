#!/usr/bin/env bash

resolve_host() {
  local host="$1"
  if [ -z "${host}" ]; then
    return 0
  fi

  python3 -c 'import socket, sys; print(socket.gethostbyname(sys.argv[1]))' "${host}" 2>/dev/null || printf '%s\n' "${host}"
}

ssh_with_retry() {
  local target_host="$1"
  shift

  local port="${HETZNER_PORT:-22}"
  local ssh_opts=(
    -i "${HOME}/.ssh/id_ed25519"
    -p "${port}"
    -o BatchMode=yes
    -o ServerAliveInterval=30
    -o ServerAliveCountMax=6
    -o TCPKeepAlive=yes
    -o ControlMaster=auto
    -o ControlPersist=600
    -o ControlPath=~/.ssh/adsecute-deploy-%C
    -o ConnectionAttempts=3
  )
  local max_attempts="${SSH_MAX_ATTEMPTS:-4}"
  local attempt=1
  local status=0

  while true; do
    set +e
    ssh "${ssh_opts[@]}" "${HETZNER_USER}@${target_host}" "$@"
    status="$?"
    set -e

    if [ "${status}" -eq 0 ]; then
      return 0
    fi

    echo "ssh_attempt_failed target=${target_host} status=${status} attempt=${attempt}/${max_attempts}"
    if [ "${status}" -ne 255 ] || [ "${attempt}" -ge "${max_attempts}" ]; then
      return "${status}"
    fi

    sleep "$((attempt * 3))"
    attempt=$((attempt + 1))
  done
}

ssh_with_stdin_retry() {
  local target_host="$1"
  shift

  local port="${HETZNER_PORT:-22}"
  local ssh_opts=(
    -i "${HOME}/.ssh/id_ed25519"
    -p "${port}"
    -o BatchMode=yes
    -o ServerAliveInterval=30
    -o ServerAliveCountMax=6
    -o TCPKeepAlive=yes
    -o ControlMaster=auto
    -o ControlPersist=600
    -o ControlPath=~/.ssh/adsecute-deploy-%C
    -o ConnectionAttempts=3
  )
  local stdin_payload_file
  stdin_payload_file="$(mktemp)"
  # The payload now carries a registry token on its first line, so it must not
  # survive an interrupt. mktemp already creates it 0600; this covers the paths
  # the explicit rm below cannot (signals, `set -e` unwinding a caller).
  #
  # DOUBLE quotes, so the path is baked into the trap body NOW. Single quotes
  # deferred the expansion to trap time, by which point this `local` is out of
  # scope and `set -u` turns the cleanup itself into the failure — which is
  # exactly how deploy run 30358123511 died at "Sync deploy compose" with
  # `stdin_payload_file: unbound variable`, after the function had already
  # returned successfully.
  trap "rm -f '${stdin_payload_file}'" EXIT INT TERM
  cat > "${stdin_payload_file}"

  local max_attempts="${SSH_MAX_ATTEMPTS:-4}"
  local attempt=1
  local status=0

  while true; do
    set +e
    ssh "${ssh_opts[@]}" "${HETZNER_USER}@${target_host}" "$@" < "${stdin_payload_file}"
    status="$?"
    set -e

    if [ "${status}" -eq 0 ]; then
      rm -f "${stdin_payload_file}"
      trap - EXIT INT TERM
      return 0
    fi

    echo "ssh_attempt_failed target=${target_host} status=${status} attempt=${attempt}/${max_attempts} stdin=yes"
    if [ "${status}" -ne 255 ] || [ "${attempt}" -ge "${max_attempts}" ]; then
      rm -f "${stdin_payload_file}"
      trap - EXIT INT TERM
      return "${status}"
    fi

    sleep "$((attempt * 3))"
    attempt=$((attempt + 1))
  done
}

run_for_each_deploy_host() {
  local callback="$1"
  shift

  "${callback}" "${PRIMARY_DEPLOY_HOST}" "primary" "$@"

  if [ -n "${PUBLIC_DEPLOY_HOST_IP:-}" ] && [ "${PUBLIC_DEPLOY_HOST_IP}" != "${PRIMARY_DEPLOY_HOST_IP:-}" ]; then
    "${callback}" "${PUBLIC_DEPLOY_HOST_IP}" "public" "$@"
  fi
}

sync_compose_to_host() {
  local target_host="$1"
  local target_label="$2"
  local remote_app_dir_q
  remote_app_dir_q="$(printf '%q' "${REMOTE_APP_DIR}")"

  echo "Syncing docker-compose.yml to ${target_label} (${target_host})"

  ssh_with_stdin_retry "${target_host}" \
    "mkdir -p ${remote_app_dir_q} && cat > ${remote_app_dir_q}/docker-compose.yml.tmp" \
    < docker-compose.yml

  ssh_with_retry "${target_host}" \
    "mv ${remote_app_dir_q}/docker-compose.yml.tmp ${remote_app_dir_q}/docker-compose.yml"
}

run_remote_phase_on_host() {
  local target_host="$1"
  local target_label="$2"
  local phase="$3"
  local deploy_sha_q
  local break_glass_q
  local override_reason_q
  local deploy_migration_timeout_ms_q
  local deploy_migration_timeout_seconds_q
  local remote_app_dir_q
  local phase_q
  local web_image_repo_q
  local worker_image_repo_q

  deploy_sha_q="$(printf '%q' "${DEPLOY_SHA}")"
  break_glass_q="$(printf '%q' "${BREAK_GLASS}")"
  override_reason_q="$(printf '%q' "${OVERRIDE_REASON}")"
  deploy_migration_timeout_ms_q="$(printf '%q' "${DEPLOY_MIGRATION_TIMEOUT_MS:-}")"
  deploy_migration_timeout_seconds_q="$(printf '%q' "${DEPLOY_MIGRATION_TIMEOUT_SECONDS:-}")"
  remote_app_dir_q="$(printf '%q' "${REMOTE_APP_DIR}")"
  phase_q="$(printf '%q' "${phase}")"

  # Forwarded so a legacy-namespace rollback is drivable from CI rather than only
  # by hand on the host. Empty is the normal case and is exactly right: the
  # remote script applies its own post-transfer default via `${VAR:-...}`, so an
  # ordinary deploy is byte-for-byte unchanged. Set both in the calling
  # workflow's environment ONLY to roll back to a pre-transfer SHA, whose images
  # exist solely under the legacy ghcr.io/erhanrdn namespace — see the procedure
  # at the top of docker-compose.yml.
  web_image_repo_q="$(printf '%q' "${WEB_IMAGE_REPO:-}")"
  worker_image_repo_q="$(printf '%q' "${WORKER_IMAGE_REPO:-}")"

  local ghcr_user_q cutover_resume_sha_q
  ghcr_user_q="$(printf '%q' "${GHCR_PULL_USER:-}")"
  # Only the cutover recovery phases read this; empty for every ordinary
  # deploy phase, which is what keeps the recovery path opt-in.
  cutover_resume_sha_q="$(printf '%q' "${CUTOVER_RESUME_SHA:-}")"

  echo "Running remote deploy phase=${phase} on ${target_label} (${target_host})"

  # ── Ephemeral private-registry authentication ──────────────────────────────
  #
  # The images for the current namespace are PRIVATE. The host has no docker
  # login and pulled anonymously, which worked only while the old packages were
  # public. Rather than publish the new ones, the deploy carries a short-lived
  # GITHUB_TOKEN scoped `packages: read` for the duration of one phase.
  #
  # HOW THE TOKEN TRAVELS. On stdin, as the first line of the payload — never in
  # argv and never exported. An ssh command line is visible in the remote
  # process list, and an exported variable is visible via `ps eww` to anything
  # running as the same user. `read` consumes exactly that line, `bash -s` then
  # reads the rest of the stream as the deploy script, and the variable is
  # cleared before the phase runs.
  #
  # WHERE IT LANDS. `docker login` must write a credential file; it writes into
  # a per-invocation mktemp DOCKER_CONFIG, never the user's ~/.docker. The trap
  # logs out and removes that directory on EXIT, INT and TERM — success, failure
  # and interrupt alike — so nothing outlives the phase.
  #
  # The wrapper below deliberately contains NO single quote: it is embedded in a
  # single-quoted string, and ssh runs it through the remote user's login shell,
  # which is not guaranteed to be bash. Everything here is POSIX.
  {
    printf '%s\n' "${GHCR_PULL_TOKEN:-}"
    cat .github/scripts/hetzner-remote.sh
  } | ssh_with_stdin_retry "${target_host}" \
    "mkdir -p ${remote_app_dir_q} && cd ${remote_app_dir_q} && GHCR_USER=${ghcr_user_q} PHASE=${phase_q} DEPLOY_SHA=${deploy_sha_q} BREAK_GLASS=${break_glass_q} OVERRIDE_REASON=${override_reason_q} DEPLOY_MIGRATION_TIMEOUT_MS=${deploy_migration_timeout_ms_q} DEPLOY_MIGRATION_TIMEOUT_SECONDS=${deploy_migration_timeout_seconds_q} APP_IMAGE_TAG=${deploy_sha_q} APP_BUILD_ID=${deploy_sha_q} WEB_IMAGE_REPO=${web_image_repo_q} WORKER_IMAGE_REPO=${worker_image_repo_q} CUTOVER_RESUME_SHA=${cutover_resume_sha_q} REMOTE_APP_DIR=${remote_app_dir_q} bash -c '
IFS= read -r __ghcr_tok || true
__dcfg=\"\$(mktemp -d)\"
cleanup_registry_auth() {
  docker --config \"\${__dcfg}\" logout ghcr.io >/dev/null 2>&1 || true
  rm -rf \"\${__dcfg}\"
}
trap cleanup_registry_auth EXIT INT TERM
if [ -n \"\${__ghcr_tok}\" ]; then
  printf %s \"\${__ghcr_tok}\" | docker --config \"\${__dcfg}\" login ghcr.io -u \"\${GHCR_USER}\" --password-stdin >/dev/null 2>&1 || {
    echo remote-registry-login-failed >&2
    exit 78
  }
  echo \"registry auth: ephemeral docker config established\"
else
  echo \"registry auth: none supplied; anonymous pull\"
fi
__ghcr_tok=
unset __ghcr_tok
export DOCKER_CONFIG=\"\${__dcfg}\"
bash -seuo pipefail -- \"\${PHASE}\"
'"
}
