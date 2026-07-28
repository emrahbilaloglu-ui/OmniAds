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

  # ── Ephemeral agent forwarding, recovery phases only ──────────────────────
  #
  # The cutover wrapper reaches PostgreSQL by ssh'ing from the app host to the
  # database host. The app host has no key that can do that — verified: it gets
  # Permission denied — and putting one there would be a long-lived credential
  # on a long-lived machine, which is the thing worth avoiding here.
  #
  # So the runner lends its own identity for the length of one connection. The
  # key never lands on the host; only a socket the sshd removes when the session
  # ends. It is gated TWICE — an explicit opt-in from the recovery workflow AND
  # the phase name — because an ordinary deploy has no business holding a
  # credential that can reach the database host.
  if [ "${CUTOVER_FORWARD_AGENT:-0}" = "1" ]; then
    case "${CUTOVER_FORWARD_AGENT_PHASE:-}" in
      # cutover_runner_run drives the wrapper's own phases, which ssh to the
      # database host, so it needs the lent identity exactly as cutover_epoch_run
      # does. The other three runner phases are NOT here on purpose: pulling an
      # image, unpacking it into a directory and deleting that directory never
      # touch the database, and a phase that cannot use a credential should not
      # be handed one. The workflow correspondingly does not even request
      # forwarding for them.
      cutover_resume_precheck | cutover_resume_scheduler \
        | cutover_epoch_preserve_evidence | cutover_epoch_prune_images \
        | cutover_epoch_run | cutover_runner_run | cutover_ssh_diagnose)
        [ -n "${SSH_AUTH_SOCK:-}" ] \
          || { echo "agent forwarding requested but no SSH_AUTH_SOCK is present" >&2; return 1; }
        # A forwarded invocation must never REUSE a master opened without
        # forwarding. ControlPath=~/.ssh/adsecute-deploy-%C keys only on user,
        # host and port — not on whether the master carries an agent — and
        # ControlPersist=600 keeps it alive for ten minutes, across jobs on a
        # runner whose home directory survives. So a runner-pull (deliberately
        # unforwarded) leaves a master that a preflight minutes later silently
        # rides, arriving at the app host with no agent; the wrapper then cannot
        # authenticate onward to the database host and reports
        # "Permission denied (publickey,password)".
        #
        # PREPENDED, not appended: ssh takes the FIRST value it obtains for an
        # option, so these must precede the multiplexing settings below to win.
        # Appending ForwardAgent=yes to a reused master achieved nothing, which
        # is exactly how this stayed invisible.
        ssh_opts=(-o ControlPath=none -o ControlMaster=no "${ssh_opts[@]}")
        ssh_opts+=(-o ForwardAgent=yes)
        ;;
      *)
        echo "agent forwarding refused for phase '${CUTOVER_FORWARD_AGENT_PHASE:-<unset>}'" >&2
        return 1
        ;;
    esac
  fi

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
  local cutover_db_ssh_q
  # A host target, not a credential: the credential stays in the runner's
  # agent. Empty for every ordinary deploy phase.
  cutover_db_ssh_q="$(printf '%q' "${CUTOVER_DB_SSH:-}")"
  local cutover_scheduler_q cutover_phase_q cutover_continues_q
  cutover_scheduler_q="$(printf '%q' "${CUTOVER_SCHEDULER:-}")"
  cutover_phase_q="$(printf '%q' "${CUTOVER_EPOCH_PHASE:-}")"
  cutover_continues_q="$(printf '%q' "${CUTOVER_CONTINUES_FROM:-}")"
  # The isolated runner package. All three or none: the digest says WHICH image
  # the wrapper comes from, and the expected hash is the external pin that makes
  # the extracted manifest something to check rather than something to trust.
  # Forwarding the digest without the hash would leave that pin reading an empty
  # string, which is worse than not pinning at all because it still looks pinned.
  local runner_digest_q runner_wrapper_sha_q runner_repo_q
  runner_digest_q="$(printf '%q' "${CUTOVER_RUNNER_IMAGE_DIGEST:-}")"
  runner_wrapper_sha_q="$(printf '%q' "${CUTOVER_RUNNER_WRAPPER_SHA256:-}")"
  runner_repo_q="$(printf '%q' "${CUTOVER_RUNNER_IMAGE_REPO:-}")"
  CUTOVER_FORWARD_AGENT_PHASE="${phase}"

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
    "mkdir -p ${remote_app_dir_q} && cd ${remote_app_dir_q} && GHCR_USER=${ghcr_user_q} PHASE=${phase_q} DEPLOY_SHA=${deploy_sha_q} BREAK_GLASS=${break_glass_q} OVERRIDE_REASON=${override_reason_q} DEPLOY_MIGRATION_TIMEOUT_MS=${deploy_migration_timeout_ms_q} DEPLOY_MIGRATION_TIMEOUT_SECONDS=${deploy_migration_timeout_seconds_q} APP_IMAGE_TAG=${deploy_sha_q} APP_BUILD_ID=${deploy_sha_q} WEB_IMAGE_REPO=${web_image_repo_q} WORKER_IMAGE_REPO=${worker_image_repo_q} CUTOVER_RESUME_SHA=${cutover_resume_sha_q} CUTOVER_DB_SSH=${cutover_db_ssh_q} CUTOVER_SCHEDULER=${cutover_scheduler_q} CUTOVER_EPOCH_PHASE=${cutover_phase_q} CUTOVER_CONTINUES_FROM=${cutover_continues_q} CUTOVER_RUNNER_IMAGE_DIGEST=${runner_digest_q} CUTOVER_RUNNER_WRAPPER_SHA256=${runner_wrapper_sha_q} CUTOVER_RUNNER_IMAGE_REPO=${runner_repo_q} REMOTE_APP_DIR=${remote_app_dir_q} bash -c '
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
