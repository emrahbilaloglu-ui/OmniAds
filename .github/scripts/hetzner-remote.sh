#!/usr/bin/env bash
set -euo pipefail

phase="${1:-}"
if [ -z "${phase}" ]; then
  echo "remote deploy phase is required" >&2
  exit 1
fi

REMOTE_APP_DIR="${REMOTE_APP_DIR:-/var/www/adsecute}"
cd "${REMOTE_APP_DIR}"

log() {
  printf '\n[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"
}

dump_service_diagnostics() {
  log "Collecting deploy diagnostics"
  docker compose ps || true
  docker compose ps migrate || true
  docker compose logs --tail=120 migrate || true

  for service_name in web worker; do
    container_id="$(docker compose ps -q "${service_name}" || true)"
    if [ -z "${container_id}" ]; then
      echo "Missing container for service ${service_name}"
      continue
    fi

    echo "--- ${service_name} inspect"
    docker inspect "${container_id}" --format '{{json .Config.Image}} {{json .State}}' || true
    echo "--- ${service_name} logs"
    docker logs --tail=120 "${container_id}" || true
  done
}

on_phase_error() {
  status="$?"
  echo "deploy_phase=${phase} failed_command=${BASH_COMMAND:-unknown}"
  dump_service_diagnostics
  exit "${status}"
}

wait_for_build_info() {
  attempts="$1"
  sleep_seconds="$2"
  expected_build="${3:-}"
  attempt=1

  while [ "${attempt}" -le "${attempts}" ]; do
    if build_info_json="$(curl -fsS http://127.0.0.1:3000/api/build-info 2>/dev/null)"; then
      if [ -z "${expected_build}" ]; then
        printf '%s\n' "${build_info_json}"
        return 0
      fi

      if BUILD_INFO_JSON="${build_info_json}" EXPECTED_BUILD="${expected_build}" python3 -c 'import json, os; payload=json.loads(os.environ["BUILD_INFO_JSON"]); expected=os.environ["EXPECTED_BUILD"]; raise SystemExit(0 if (payload.get("buildId") or "") == expected else 1)'
      then
        printf '%s\n' "${build_info_json}"
        return 0
      fi

      observed_build_id="$(
        printf '%s' "${build_info_json}" | python3 -c 'import json, sys; print((json.load(sys.stdin).get("buildId") or ""), end="")'
      )"
      echo "local_build_info_mismatch expected=${expected_build} observed=${observed_build_id:-unknown} attempt=${attempt}/${attempts}"
    fi

    sleep "${sleep_seconds}"
    attempt=$((attempt + 1))
  done

  return 1
}

extract_build_id() {
  python3 -c 'import json, sys; print((json.load(sys.stdin).get("buildId") or ""), end="")'
}

assert_sync_incidents_ready() {
  BUILD_INFO_JSON="$1" python3 -c '
import json, os, sys
payload = json.loads(os.environ["BUILD_INFO_JSON"])
errors = payload.get("controlPlaneErrors") or {}
sync_incidents_error = errors.get("syncIncidents")
sys.exit(0 if sync_incidents_error in (None, "") else 1)
'
}

check_optional_health() {
  service_name="$1"
  max_attempts="${2:-40}"
  container_id="$(docker compose ps -q "${service_name}" || true)"

  if [ -z "${container_id}" ]; then
    echo "Missing container for service ${service_name}"
    return 1
  fi

  has_healthcheck="$(docker inspect "${container_id}" --format '{{if .Config.Healthcheck}}yes{{else}}no{{end}}')"
  if [ "${has_healthcheck}" != "yes" ]; then
    return 0
  fi

  attempt=1
  while [ "${attempt}" -le "${max_attempts}" ]; do
    health_status="$(docker inspect "${container_id}" --format '{{.State.Health.Status}}')"
    echo "${service_name}_health_status=${health_status} attempt=${attempt}/${max_attempts}"
    if [ "${health_status}" = "healthy" ]; then
      return 0
    fi

    sleep 3
    attempt=$((attempt + 1))
  done

  docker inspect "${container_id}" --format '{{json .State.Health}}' || true
  docker logs --tail=120 "${container_id}" || true
  return 1
}

verify_worker_fresh_heartbeat_after() {
  min_heartbeat_after="$1"
  max_attempts="${2:-8}"
  sleep_seconds="${3:-5}"
  attempt=1

  while [ "${attempt}" -le "${max_attempts}" ]; do
    echo "worker_fresh_heartbeat_check min_after=${min_heartbeat_after} attempt=${attempt}/${max_attempts}"
    if docker compose exec -T worker \
      node --import tsx scripts/sync-worker-healthcheck.ts \
        --provider-scope meta \
        --online-window-minutes 5 \
        --min-online-workers 1 \
        --min-heartbeat-after "${min_heartbeat_after}"; then
      return 0
    fi

    sleep "${sleep_seconds}"
    attempt=$((attempt + 1))
  done

  docker compose ps worker || true
  worker_container_id="$(docker compose ps -q worker || true)"
  if [ -n "${worker_container_id}" ]; then
    docker inspect "${worker_container_id}" --format '{{json .State.Health}}' || true
    docker logs --tail=120 "${worker_container_id}" || true
  fi

  return 1
}

verify_local_sync_control_plane() {
  provider_scope="${1:-meta}"
  build_info_url="http://127.0.0.1:3000/api/build-info"
  if [ "${provider_scope}" != "meta" ]; then
    build_info_url="${build_info_url}?providerScope=${provider_scope}"
  fi
  attempt=1
  max_attempts=6
  sleep_seconds=5

  while [ "${attempt}" -le "${max_attempts}" ]; do
    if build_info_json="$(curl -fsS "${build_info_url}" 2>/dev/null)" &&
      BUILD_INFO_JSON="${build_info_json}" EXPECTED_BUILD="${DEPLOY_SHA}" python3 -c 'import json, os; payload=json.loads(os.environ["BUILD_INFO_JSON"]); expected=os.environ["EXPECTED_BUILD"]; deploy_gate=payload.get("deployGate") or {}; release_gate=payload.get("releaseGate") or {}; repair_plan=payload.get("repairPlan") or {}; exact=((payload.get("controlPlanePersistence") or {}).get("exactRowsPresent")) is True; raise SystemExit(0 if ((payload.get("buildId") or "") == expected and exact and deploy_gate.get("id") and release_gate.get("id") and repair_plan.get("id")) else 1)'
    then
      echo "local_control_plane_ready=yes provider_scope=${provider_scope} attempt=${attempt}/${max_attempts}"
      return 0
    fi

    echo "local_control_plane_ready=no provider_scope=${provider_scope} attempt=${attempt}/${max_attempts}"
    attempt=$((attempt + 1))
    if [ "${attempt}" -le "${max_attempts}" ]; then
      sleep "${sleep_seconds}"
    fi
  done

  return 1
}

persist_sync_control_plane_via_web() {
  provider_scope="${1:-meta}"
  cron_secret="$(docker compose exec -T web node -e 'process.stdout.write(process.env.CRON_SECRET || "")')"
  if [ -z "${cron_secret}" ]; then
    echo "CRON_SECRET is missing from the web runtime."
    return 1
  fi

  query_string="controlPlaneOnly=1&buildId=${DEPLOY_SHA}&enforceDeployGate=1&providerScope=${provider_scope}"
  if [ "${BREAK_GLASS}" = "true" ]; then
    encoded_override_reason="$(
      python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1]))' "${OVERRIDE_REASON}"
    )"
    query_string="${query_string}&breakGlass=1&overrideReason=${encoded_override_reason}"
  fi

  curl -fsS -X POST "http://127.0.0.1:3000/api/sync/cron?${query_string}" \
    -H "Authorization: Bearer ${cron_secret}"
}

persist_sync_control_plane() {
  persist_sync_control_plane_via_web meta
  verify_local_sync_control_plane meta
  persist_sync_control_plane_via_web google_ads
  verify_local_sync_control_plane google_ads
  persist_image_tag_env
}

# Recurring P1 (image-tag env drift): docker compose falls back to the host
# .env APP_IMAGE_TAG on any MANUAL compose command. CI exports the SHA per
# invocation, so the .env value silently ages until an operator recreate
# rolls containers back to a months-old build. Each deploy therefore pins
# the host .env to the deployed SHA so manual compose commands inherit it.
persist_image_tag_env() {
  env_file=".env"
  log "Pinning ${env_file} APP_IMAGE_TAG/APP_BUILD_ID to ${DEPLOY_SHA}"
  touch "${env_file}"
  # Guarantee a trailing newline before appending so a previously unterminated
  # last line cannot be silently merged with the appended key.
  if [ -s "${env_file}" ] && [ "$(tail -c 1 "${env_file}")" != "" ]; then
    printf '\n' >> "${env_file}"
  fi
  if [ ! -w "${env_file}" ]; then
    echo "env pin FAILED: ${env_file} is not writable by $(id -un)"
    return 1
  fi
  for key in APP_IMAGE_TAG APP_BUILD_ID; do
    if grep -q "^${key}=" "${env_file}"; then
      # Portable in-place replace (BSD/GNU sed -i semantics differ): write a
      # temp file and cat it back so the inode (and any symlink/bind mount)
      # is preserved.
      tmp_env="$(mktemp "${env_file}.pin.XXXXXX")"
      sed "s|^${key}=.*|${key}=${DEPLOY_SHA}|" "${env_file}" > "${tmp_env}"
      cat "${tmp_env}" > "${env_file}"
      rm -f "${tmp_env}"
    else
      printf '%s=%s\n' "${key}" "${DEPLOY_SHA}" >> "${env_file}"
    fi
  done
  for key in APP_IMAGE_TAG APP_BUILD_ID; do
    pinned_value="$(grep "^${key}=" "${env_file}" | tail -1 | cut -d= -f2)"
    echo "env_pinned_${key}=${pinned_value}"
    test "${pinned_value}" = "${DEPLOY_SHA}"
  done
}

# The DB host and the app host are Debian and have `sha256sum`; a developer
# machine running this file through `bash -n` or a harness is macOS and has
# `shasum`. Picking one and hoping is how the delivery gate becomes an
# unconditional failure outside production.
sha256_of_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# Deliver the cutover wrapper to this host, pinned by digest.
#
# Before this existed, the cutover wrapper was named by the runbook and by
# deploy/CUTOVER_REQUIRED as the thing to run on the app host, and it was never
# delivered there — the deploy syncs docker-compose.yml and nothing else, and the
# host has no repository. An operator's only options were to paste the script
# over ssh or to hand-copy it, and neither leaves any evidence of WHICH version
# ran.
#
# The wrapper lives at `scripts/hetzner-sync-cutover.sh` and the worker image
# copies `scripts/` wholesale, so the image carries the wrapper itself at
# `${WRAPPER_IMAGE_PATH}` below — not a generated duplicate of it — alongside the
# manifest that pins its SHA-256. Extracting both from the exact pinned image
# binds the wrapper to the release being deployed, this function refuses unless
# the extracted bytes hash to what that manifest pins, and the wrapper re-hashes
# itself against the installed manifest before every phase. A truncated copy, a
# hand-edit on the host, or a wrapper left over from a previous release refuses
# instead of driving a cutover.
WRAPPER_IMAGE_PATH="/app/scripts/hetzner-sync-cutover.sh"
WRAPPER_MANIFEST_IMAGE_PATH="/app/scripts/cutover-wrapper.manifest"
# The recovery tier policy the wrapper measures its capacity gate against. Without
# it the wrapper sees no tier-B tables, silently sizes the rollback artifact
# against the WHOLE database, and refuses a cutover that would have fit.
WRAPPER_POLICY_IMAGE_PATH="/app/deploy/db/recovery-policy.tsv"

deliver_cutover_wrapper() {
  cutover_dir="${REMOTE_APP_DIR}/cutover"
  staging_dir="$(mktemp -d "${TMPDIR:-/tmp}/adsecute-cutover-deliver.XXXXXX")"
  extract_container=""

  cleanup_cutover_delivery() {
    if [ -n "${extract_container}" ]; then
      docker rm -f "${extract_container}" >/dev/null 2>&1 || true
    fi
    rm -rf "${staging_dir}"
  }

  log "Delivering the cutover wrapper from ${expected_worker_image}"
  worker_image_id="$(docker image inspect "${expected_worker_image}" --format '{{.Id}}' 2>/dev/null || true)"
  if [ -z "${worker_image_id}" ]; then
    echo "cutover_wrapper_delivery FAILED: ${expected_worker_image} is not present on this host"
    cleanup_cutover_delivery
    return 1
  fi

  extract_container="$(docker create "${expected_worker_image}" true)"
  if ! docker cp "${extract_container}:${WRAPPER_IMAGE_PATH}" "${staging_dir}/hetzner-sync-cutover.sh" ||
    ! docker cp "${extract_container}:${WRAPPER_MANIFEST_IMAGE_PATH}" "${staging_dir}/cutover-wrapper.manifest" ||
    ! docker cp "${extract_container}:${WRAPPER_POLICY_IMAGE_PATH}" "${staging_dir}/recovery-policy.tsv"; then
    echo "cutover_wrapper_delivery FAILED: ${expected_worker_image} does not carry ${WRAPPER_IMAGE_PATH}, ${WRAPPER_MANIFEST_IMAGE_PATH} and ${WRAPPER_POLICY_IMAGE_PATH}"
    cleanup_cutover_delivery
    return 1
  fi
  docker rm -f "${extract_container}" >/dev/null 2>&1 || true
  extract_container=""

  # The manifest names the repository path the digest was taken over, and the
  # builder stage copies the build context to /app, so it must describe the file
  # just extracted. If the wrapper is ever moved again and only one of these two
  # places is updated, this refuses here rather than silently pinning the digest
  # of a file that is not the one being installed.
  manifest_source="$(awk -F= '$1 == "wrapper_source" { print $2 }' "${staging_dir}/cutover-wrapper.manifest" | tr -d '[:space:]')"
  if [ "/app/${manifest_source}" != "${WRAPPER_IMAGE_PATH}" ]; then
    echo "cutover_wrapper_delivery FAILED: manifest pins wrapper_source=${manifest_source:-<none>}, this deploy extracted ${WRAPPER_IMAGE_PATH}"
    cleanup_cutover_delivery
    return 1
  fi

  expected_sha="$(awk -F= '$1 == "wrapper_sha256" { print $2 }' "${staging_dir}/cutover-wrapper.manifest" | tr -d '[:space:]')"
  actual_sha="$(sha256_of_file "${staging_dir}/hetzner-sync-cutover.sh")"
  if [ -z "${expected_sha}" ] || [ "${expected_sha}" != "${actual_sha}" ]; then
    echo "cutover_wrapper_delivery FAILED: extracted wrapper hashes ${actual_sha}, image manifest pins ${expected_sha:-<none>}"
    cleanup_cutover_delivery
    return 1
  fi

  # The installed manifest carries what the repository copy cannot know: which
  # release delivered this wrapper and out of which immutable image. A wrapper
  # left behind by an earlier deploy is then visible as such rather than looking
  # current because its own digest happens to match its own manifest.
  # The recovery policy decides which tables the rollback artifact carries, so
  # the wrapper sizes its capacity gate against it. A delivery that installed the
  # wrapper but dropped the policy left the wrapper seeing no tier-B tables and
  # sizing itself against the whole database — so its digest is pinned here and
  # it is installed alongside, not left in the staging directory.
  policy_sha="$(sha256_of_file "${staging_dir}/recovery-policy.tsv")"
  if [ -z "${policy_sha}" ]; then
    echo "cutover_wrapper_delivery FAILED: could not hash the extracted recovery policy"
    cleanup_cutover_delivery
    return 1
  fi

  {
    cat "${staging_dir}/cutover-wrapper.manifest"
    printf 'delivered_deploy_sha=%s\n' "${DEPLOY_SHA}"
    printf 'delivered_worker_image=%s\n' "${expected_worker_image}"
    printf 'delivered_worker_image_id=%s\n' "${worker_image_id}"
    printf 'delivered_policy_sha256=%s\n' "${policy_sha}"
    printf 'delivered_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "${staging_dir}/installed.manifest"

  mkdir -p "${cutover_dir}"
  chmod 0700 "${cutover_dir}"
  # Rename within one directory, so an operator who starts a phase during the
  # deploy sees the whole old wrapper or the whole new one, never a half-written
  # file. It does NOT make the wrapper and its manifest change together — they
  # are two renames — which is exactly why the wrapper verifies its own digest
  # against the manifest rather than assuming they were installed as a pair.
  cp "${staging_dir}/hetzner-sync-cutover.sh" "${cutover_dir}/.hetzner-sync-cutover.sh.tmp"
  chmod 0700 "${cutover_dir}/.hetzner-sync-cutover.sh.tmp"
  cp "${staging_dir}/installed.manifest" "${cutover_dir}/.cutover-wrapper.manifest.tmp"
  chmod 0600 "${cutover_dir}/.cutover-wrapper.manifest.tmp"
  cp "${staging_dir}/recovery-policy.tsv" "${cutover_dir}/.recovery-policy.tsv.tmp"
  chmod 0600 "${cutover_dir}/.recovery-policy.tsv.tmp"
  # Policy first: the wrapper reads the manifest to verify itself, and a manifest
  # that names a policy digest must not become visible before the policy does.
  mv "${cutover_dir}/.recovery-policy.tsv.tmp" "${cutover_dir}/recovery-policy.tsv"
  mv "${cutover_dir}/.cutover-wrapper.manifest.tmp" "${cutover_dir}/cutover-wrapper.manifest"
  mv "${cutover_dir}/.hetzner-sync-cutover.sh.tmp" "${cutover_dir}/hetzner-sync-cutover.sh"

  echo "cutover_wrapper_installed path=${cutover_dir}/hetzner-sync-cutover.sh sha256=${actual_sha} policy_sha256=${policy_sha} image_id=${worker_image_id}"
  cleanup_cutover_delivery
}

# Does the delivered manifest say this release must go through the cutover?
#
# `deploy/CUTOVER_REQUIRED` is a repository file and this host has no repository,
# so the file check below it could never fire here. The packaged manifest records
# the same fact and IS delivered, which is what makes the refusal real.
delivered_cutover_required() {
  manifest="${REMOTE_APP_DIR}/cutover/cutover-wrapper.manifest"
  if [ ! -f "${manifest}" ]; then
    return 1
  fi
  required="$(awk -F= '$1 == "cutover_required" { print $2 }' "${manifest}" | tr -d '[:space:]')"
  delivered_sha="$(awk -F= '$1 == "delivered_deploy_sha" { print $2 }' "${manifest}" | tr -d '[:space:]')"
  # Only the manifest delivered for THIS release may speak for it. A stale
  # manifest from a previous deploy would otherwise either block a release that
  # does not need the cutover or wave through one that does.
  [ "${delivered_sha}" = "${DEPLOY_SHA}" ] || return 1
  [ "${required}" = "yes" ]
}

verify_service_image() {
  service_name="$1"
  expected_image="$2"
  container_id="$(docker compose ps -q "${service_name}" || true)"

  if [ -z "${container_id}" ]; then
    echo "Missing container for service ${service_name}"
    return 1
  fi

  actual_image="$(docker inspect "${container_id}" --format '{{.Config.Image}}')"
  echo "${service_name}_actual_image=${actual_image}"
  echo "${service_name}_expected_image=${expected_image}"
  test "${actual_image}" = "${expected_image}"
}

log_disk_usage() {
  df -h / /var/lib/docker 2>/dev/null || true
  docker system df || true
}

free_disk_mb() {
  mount_path="$1"
  df -Pm "${mount_path}" 2>/dev/null | awk 'NR==2 {print $4}'
}

prune_stale_deploy_artifacts() {
  keep_images_file="$(mktemp)"
  {
    printf '%s\n' "${expected_web_image}"
    printf '%s\n' "${expected_worker_image}"
    for service_name in web worker migrate; do
      container_id="$(docker compose ps -q "${service_name}" || true)"
      if [ -n "${container_id}" ]; then
        docker inspect "${container_id}" --format '{{.Config.Image}}' || true
      fi
    done
  } | sort -u > "${keep_images_file}"

  docker container prune -f || true
  docker builder prune -af || true

  stale_images="$(
    docker images --format '{{.Repository}}:{{.Tag}}' \
      | grep -E '^ghcr.io/erhanrdn/omniads-(web|worker):' \
      | sort -u \
      || true
  )"

  while IFS= read -r image_ref; do
    [ -n "${image_ref}" ] || continue
    if grep -Fxq "${image_ref}" "${keep_images_file}"; then
      continue
    fi
    echo "Removing stale deploy image ${image_ref}"
    docker image rm -f "${image_ref}" || true
  done <<< "${stale_images}"

  rm -f "${keep_images_file}"
}

maybe_prune_stale_deploy_artifacts() {
  min_free_mb="${DEPLOY_PRUNE_MIN_FREE_MB:-6144}"
  root_free_mb="$(free_disk_mb /)"
  docker_free_mb="$(free_disk_mb /var/lib/docker)"
  if [ -z "${docker_free_mb}" ]; then
    docker_free_mb="${root_free_mb}"
  fi

  echo "disk_free_mb root=${root_free_mb:-unknown} docker=${docker_free_mb:-unknown} threshold=${min_free_mb}"

  if [ -n "${root_free_mb}" ] &&
    [ -n "${docker_free_mb}" ] &&
    [ "${root_free_mb}" -ge "${min_free_mb}" ] &&
    [ "${docker_free_mb}" -ge "${min_free_mb}" ]; then
    log "Skipping aggressive prune; disk headroom is sufficient"
    docker container prune -f || true
    return 0
  fi

  log "Pruning stale deploy artifacts because disk headroom is low"
  prune_stale_deploy_artifacts
}

read_env_file_migration_timeout_ms() {
  if [ ! -f .env.production ]; then
    return 0
  fi

  (
    set -a
    # shellcheck disable=SC1091
    . ./.env.production >/dev/null 2>&1 || exit 0
    if [ -n "${DEPLOY_MIGRATION_TIMEOUT_MS:-}" ]; then
      printf '%s' "${DEPLOY_MIGRATION_TIMEOUT_MS}"
    elif [ -n "${MIGRATION_TIMEOUT_MS:-}" ]; then
      printf '%s' "${MIGRATION_TIMEOUT_MS}"
    fi
  )
}

is_positive_integer() {
  case "${1:-}" in
    ''|*[!0-9]*)
      return 1
      ;;
  esac

  [ "$1" -gt 0 ]
}

# FAIL CLOSED on a cutover-required release.
#
# The ordinary main deploy builds images and then runs migrate + recreate
# outside the cutover lock, with no quiesce, no capacity gate, no
# pre-fingerprint and no rollback artifact. For a schema-changing Sync release
# that is precisely the path the cutover exists to prevent, and nothing stopped
# a release from taking it.
#
# Extracted so it can be called BEFORE the deploy touches the running system.
# It used to sit inside run_migrations_service, which the phase calls after
# `docker compose stop worker` — so a gated release stopped the production
# worker and only then refused. A gate that fires after it has already changed
# production is not a gate; it is a report.
assert_not_cutover_required() {
  # A release that requires the cutover carries `deploy/CUTOVER_REQUIRED` in the
  # repo. The cutover driver is what removes it, so an ordinary deploy of that
  # SHA refuses rather than migrating unattended.
  if [ -f "${APP_DIR:-.}/deploy/CUTOVER_REQUIRED" ]; then
    log "ABORT deploy/CUTOVER_REQUIRED is present: this release must go through the cutover workflow, not the ordinary deploy"
    cat "${APP_DIR:-.}/deploy/CUTOVER_REQUIRED" || true
    return 1
  fi
  # The check above is the repository-side one and cannot fire on this host,
  # which has no repository. The manifest delivered out of this release's own
  # worker image carries the same fact and does.
  if delivered_cutover_required; then
    log "ABORT the manifest delivered for ${DEPLOY_SHA} records cutover_required=yes: this release must go through ${REMOTE_APP_DIR}/cutover/hetzner-sync-cutover.sh, not the ordinary deploy"
    return 1
  fi
  return 0
}

# A cutover already in progress owns the database. Migrating underneath it would
# run two migration paths against one database at once.
assert_no_cutover_in_progress() {
  local cutover_state_file cutover_chain cutover_invalidated
  cutover_state_file="${SYNC_CUTOVER_STATE_DIR:-/var/lib/adsecute-cutover}/state"
  [ -s "${cutover_state_file}" ] || return 0
  cutover_chain="$(awk -F= '$1 == "phase_chain" { sub(/^[^=]*=/, ""); print; exit }' "${cutover_state_file}")"
  cutover_invalidated="$(awk -F= '$1 == "invalidated" { print $2 }' "${cutover_state_file}" | tr -d '[:space:]')"
  # A finished cutover (resume-scheduler reached) and an explicitly abandoned
  # one (emergency-disable invalidated it, so an operator already took manual
  # control) both hand the database back. Anything between preflight and
  # resume-scheduler still owns it.
  if [ -n "${cutover_chain}" ] &&
    [ "${cutover_invalidated}" != "yes" ] &&
    ! printf '%s' "${cutover_chain}" | grep -q 'resume-scheduler'; then
    log "ABORT a sync cutover is in progress (phases: ${cutover_chain}); the ordinary deploy must not migrate underneath it"
    return 1
  fi
  return 0
}

run_migrations_service() {
  env_file_migration_timeout_ms=""
  if [ -z "${DEPLOY_MIGRATION_TIMEOUT_MS:-}" ]; then
    env_file_migration_timeout_ms="$(read_env_file_migration_timeout_ms)"
  fi

  migration_timeout_ms="${DEPLOY_MIGRATION_TIMEOUT_MS:-${env_file_migration_timeout_ms:-1800000}}"
  if ! is_positive_integer "${migration_timeout_ms}"; then
    log "Ignoring invalid DEPLOY_MIGRATION_TIMEOUT_MS=${migration_timeout_ms}; using 1800000"
    migration_timeout_ms="1800000"
  fi

  migration_timeout_seconds="${DEPLOY_MIGRATION_TIMEOUT_SECONDS:-$((migration_timeout_ms / 1000 + 60))}"
  if ! is_positive_integer "${migration_timeout_seconds}"; then
    log "Ignoring invalid DEPLOY_MIGRATION_TIMEOUT_SECONDS=${migration_timeout_seconds}; deriving from node timeout"
    migration_timeout_seconds="$((migration_timeout_ms / 1000 + 60))"
  fi

  export DEPLOY_MIGRATION_TIMEOUT_MS="${migration_timeout_ms}"

  # Both gates are ALSO called at the top of the run_migrations phase, before
  # anything stops or starts a container. They are idempotent and cheap, and
  # keeping them here means a future caller of this function cannot reach a
  # migration by skipping the phase wrapper.
  assert_not_cutover_required || return 1
  assert_no_cutover_in_progress || return 1

  log "Starting migrate service timeout_seconds=${migration_timeout_seconds} node_timeout_ms=${DEPLOY_MIGRATION_TIMEOUT_MS}"
  docker compose rm -f migrate >/dev/null 2>&1 || true

  if command -v timeout >/dev/null 2>&1; then
    set +e
    timeout "${migration_timeout_seconds}" docker compose up --no-deps --abort-on-container-exit --exit-code-from migrate migrate
    status="$?"
    set -e
  else
    set +e
    docker compose up --no-deps --abort-on-container-exit --exit-code-from migrate migrate
    status="$?"
    set -e
  fi

  if [ "${status}" -ne 0 ]; then
    docker compose ps migrate || true
    docker compose logs --tail=200 migrate || true
  fi

  docker compose rm -f migrate >/dev/null 2>&1 || true
  return "${status}"
}

export APP_IMAGE_TAG="${DEPLOY_SHA}"
export APP_BUILD_ID="${DEPLOY_SHA}"
expected_web_image="ghcr.io/erhanrdn/omniads-web:${DEPLOY_SHA}"
expected_worker_image="ghcr.io/erhanrdn/omniads-worker:${DEPLOY_SHA}"

trap on_phase_error ERR

case "${phase}" in
  prepare_runtime)
    # Before the pull, and before the wrapper delivery below.
    #
    # deliver_cutover_wrapper OVERWRITES ${REMOTE_APP_DIR}/cutover/hetzner-sync-cutover.sh.
    # A cutover in flight is executing that exact file, so delivering underneath
    # it replaces a running script's bytes mid-run. That happened: an ordinary
    # deploy rewrote the wrapper while a preflight was reading it.
    assert_no_cutover_in_progress
    assert_not_cutover_required

    log "Checking disk headroom before pull"
    log_disk_usage
    maybe_prune_stale_deploy_artifacts
    log "Disk headroom after prune decision"
    log_disk_usage

    log "Pulling exact SHA images"
    docker compose pull web worker

    # Delivered HERE, before run_migrations, on purpose: a cutover-required
    # release aborts in run_migrations, and the wrapper that performs the cutover
    # has to already be on the host when it does.
    deliver_cutover_wrapper
    ;;

  deliver_cutover_wrapper)
    # Standalone re-delivery, for the case where an operator needs the wrapper
    # for a release whose deploy aborted before prepare_runtime completed —
    # which, now that the gate refuses ahead of prepare_runtime, is the normal
    # way a cutover-required release gets its wrapper.
    #
    # Deliberately NOT gated on cutover_required: this is the phase you need
    # BECAUSE the release requires a cutover. It IS gated on a cutover already
    # running, because delivery overwrites the wrapper file, and overwriting it
    # while a cutover is executing rewrites a running script's bytes mid-run.
    assert_no_cutover_in_progress
    deliver_cutover_wrapper
    ;;

  run_migrations)
    # The cutover gate runs FIRST, before anything touches the running system.
    #
    # It used to live inside run_migrations_service, which is called below —
    # after `docker compose stop worker`. So an ordinary deploy of a
    # cutover-required release stopped the production worker and only then
    # refused. A gate that fires after it has already changed production is not
    # a gate; it is a report.
    assert_not_cutover_required
    assert_no_cutover_in_progress

    log "Stopping worker before migrations to reduce DB contention"
    docker compose stop worker || true

    log "Running migrations for ${DEPLOY_SHA}"
    run_migrations_service
    ;;

  recreate_services)
    # A recreate is the single most production-visible thing this script does,
    # and it is reachable independently of run_migrations. It gets the gate too.
    assert_not_cutover_required
    assert_no_cutover_in_progress
    log "Recreating web and worker"
    docker compose up -d --force-recreate web worker

    log "Checking running services"
    docker compose ps

    log "Verifying exact service images"
    verify_service_image web "${expected_web_image}"
    verify_service_image worker "${expected_worker_image}"
    ;;

  verify_runtime)
    log "Checking runtime build info"
    BUILD_INFO_JSON="$(wait_for_build_info 30 3 "${DEPLOY_SHA}")"
    BUILD_ID="$(printf '%s' "${BUILD_INFO_JSON}" | extract_build_id)"
    echo "DEPLOY_SHA=${DEPLOY_SHA}"
    echo "BUILD_ID=${BUILD_ID}"
    test -n "${BUILD_ID}"
    test "${BUILD_ID}" = "${DEPLOY_SHA}"
    log "Checking sync_incidents schema readiness through build-info"
    assert_sync_incidents_ready "${BUILD_INFO_JSON}"

    log "Checking optional container health"
    check_optional_health web 20
    check_optional_health worker 40

    worker_container_id="$(docker compose ps -q worker || true)"
    if [ -z "${worker_container_id}" ]; then
      echo "Missing container for service worker"
      exit 1
    fi
    worker_started_at="$(docker inspect "${worker_container_id}" --format '{{.State.StartedAt}}')"
    log "Verifying fresh Meta heartbeat after worker start"
    verify_worker_fresh_heartbeat_after "${worker_started_at}" 8 5
    ;;

  persist_control_plane)
    log "Persisting current-build sync control plane"
    persist_sync_control_plane
    ;;

  *)
    echo "unknown remote deploy phase: ${phase}" >&2
    exit 1
    ;;
esac

trap - ERR
