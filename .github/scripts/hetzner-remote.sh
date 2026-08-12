#!/usr/bin/env bash
# -E (errtrace) matters as much as -e here: without it the `trap on_phase_error
# ERR` installed below does NOT fire for a failure inside a shell function, and
# nearly all of this script's work happens inside functions. The phase still
# exited non-zero, so nothing unsafe proceeded — but it exited SILENTLY, with no
# `deploy_phase=... failed_command=...` line and no diagnostics dump. During a
# failed deploy that is the difference between a diagnosis and a guess.
set -Eeuo pipefail

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

# Reclaim disk by deleting deploy images this host no longer needs.
#
# ── WHY THIS SWEEPS TWO NAMESPACES ─────────────────────────────────────────
#
# This used to match one hardcoded repository prefix. After the transfer there
# are TWO, and getting the choice wrong breaks in one of two directions:
#
#   Match only the NEW namespace  → every pre-transfer image on this box becomes
#     permanently unreachable by the sweep. Those legacy ghcr.io/erhanrdn images
#     are the bulk of what is on disk today, so the sweep silently stops
#     reclaiming anything and the box fills up — a prune that runs, reports
#     success and frees nothing.
#
#   Match only the OLD namespace  → the sweep works today and rots tomorrow: as
#     soon as post-transfer images accumulate, they are the ones never collected.
#
# So it matches BOTH. The safety question that follows is "could sweeping the old
# namespace delete the images production is running right now?", because during
# the first post-transfer deploys the RUNNING containers are on old-namespace
# images. The answer is no, and the reason is the keep-list, not the match:
#
#   - The keep-list is built by asking Docker what the live web/worker/migrate
#     containers are ACTUALLY running (`{{.Config.Image}}`), not by assuming a
#     namespace. An old-namespace image under a running container reports its own
#     old-namespace reference, lands in the keep-list verbatim, and is skipped.
#   - It also holds this release's expected_web_image/expected_worker_image, so
#     the images this deploy is about to start are protected before they are
#     pulled.
#   - Matching is exact-line (`grep -Fxq`) against full `repo:tag` references, so
#     widening the namespace match cannot widen what the keep-list protects.
#
# That is what makes widening safe: the sweep decides what is a CANDIDATE by
# namespace, and what is SPARED by observed reality. Only the candidate set grew.
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

  # Every repository whose images this host may reclaim: the active pair (which
  # follow WEB_IMAGE_REPO/WORKER_IMAGE_REPO, so a legacy rollback does not turn
  # the images it is running into prune candidates) plus the pre-transfer pair.
  # Defined below the phase dispatch; every caller runs after that.
  prune_repos_file="$(mktemp)"
  printf '%s\n' \
    "${WEB_IMAGE_REPO}" \
    "${WORKER_IMAGE_REPO}" \
    "${LEGACY_WEB_IMAGE_REPO}" \
    "${LEGACY_WORKER_IMAGE_REPO}" \
    | sort -u > "${prune_repos_file}"

  # Split each `repo:tag` on its LAST colon and compare the repository as a fixed
  # string. A regex alternation over these values would treat the dots in
  # "ghcr.io" as wildcards and would have to be rebuilt every time a repository
  # variable changes; this cannot drift.
  docker container prune -f || true
  docker builder prune -af || true

  stale_images="$(
    docker images --format '{{.Repository}}:{{.Tag}}' \
      | while IFS= read -r candidate_ref; do
          [ -n "${candidate_ref}" ] || continue
          candidate_repo="${candidate_ref%:*}"
          if grep -Fxq "${candidate_repo}" "${prune_repos_file}"; then
            printf '%s\n' "${candidate_ref}"
          fi
        done \
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

  rm -f "${keep_images_file}" "${prune_repos_file}"
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
  local cutover_state_file cutover_chain cutover_invalidated cutover_resumed
  cutover_state_file="${SYNC_CUTOVER_STATE_DIR:-/var/lib/adsecute-cutover}/state"
  [ -s "${cutover_state_file}" ] || return 0
  cutover_chain="$(awk -F= '$1 == "phase_chain" { sub(/^[^=]*=/, ""); print; exit }' "${cutover_state_file}")"
  cutover_invalidated="$(awk -F= '$1 == "invalidated" { print $2 }' "${cutover_state_file}" | tr -d '[:space:]')"
  # A finished cutover (resume-scheduler reached) and an explicitly abandoned
  # one (emergency-disable invalidated it, so an operator already took manual
  # control) both hand the database back. Anything between preflight and
  # resume-scheduler still owns it.
  # Comma-anchored membership, matching the wrapper's own state_chain_has.
  # An unanchored `grep -q 'resume-scheduler'` was a latent hole: any phase
  # whose NAME merely contained that substring — `pre-resume-scheduler`,
  # `resume-scheduler-verify` — would have opened this gate and let an ordinary
  # deploy migrate underneath a live cutover. Nothing tested it.
  case ",${cutover_chain}," in
    *,resume-scheduler,*) cutover_resumed=yes ;;
    *) cutover_resumed=no ;;
  esac
  if [ -n "${cutover_chain}" ] &&
    [ "${cutover_invalidated}" != "yes" ] &&
    [ "${cutover_resumed}" != "yes" ]; then
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

# The image repository, as a variable with the post-transfer default.
#
# EXPORTED on purpose. docker-compose.yml resolves
# `${WEB_IMAGE_REPO:-ghcr.io/emrahbilaloglu-ui/omniads-web}` from this process's
# environment, and `expected_web_image` below is built from the same variable —
# so what compose PULLS, what compose STARTS, and what the post-deploy readback
# ASSERTS are one exact-SHA identity that cannot disagree. Two independently
# written literals is how a namespace change leaves one of them behind and the
# verifier starts checking a claim nobody is making.
#
# ROLLBACK ACROSS THE TRANSFER BOUNDARY: pre-transfer images exist only under
# ghcr.io/erhanrdn and were never republished, so rolling back to a pre-transfer
# SHA means setting both variables to the legacy repositories below. From CI that
# is `WEB_IMAGE_REPO`/`WORKER_IMAGE_REPO` in the deploy workflow's environment,
# which `.github/scripts/hetzner-ssh.sh` forwards to this script. On the host by
# hand, see the procedure at the top of docker-compose.yml. There is no automatic
# fallback: an ordinary deploy of a missing tag must fail loudly rather than
# quietly resolve somewhere else.
export WEB_IMAGE_REPO="${WEB_IMAGE_REPO:-ghcr.io/emrahbilaloglu-ui/omniads-web}"
export WORKER_IMAGE_REPO="${WORKER_IMAGE_REPO:-ghcr.io/emrahbilaloglu-ui/omniads-worker}"

# The pre-transfer repositories. Not overridable and not dead: `prune_stale_deploy_artifacts`
# has to keep recognising old-namespace images as prunable for as long as any
# remain on disk. See the reasoning there.
LEGACY_WEB_IMAGE_REPO="ghcr.io/erhanrdn/omniads-web"
LEGACY_WORKER_IMAGE_REPO="ghcr.io/erhanrdn/omniads-worker"

expected_web_image="${WEB_IMAGE_REPO}:${DEPLOY_SHA}"
expected_worker_image="${WORKER_IMAGE_REPO}:${DEPLOY_SHA}"

CUTOVER_STATE_DIR="${SYNC_CUTOVER_STATE_DIR:-/var/lib/adsecute-cutover}"
CUTOVER_STATE_FILE="${CUTOVER_STATE_DIR}/state"
CUTOVER_LOCK_FILE="${CUTOVER_STATE_DIR}/lock"
INSTALLED_WRAPPER="${REMOTE_APP_DIR}/cutover/hetzner-sync-cutover.sh"

# The one chain this recovery is willing to act on. Anything else — shorter,
# longer, reordered, or already resumed — is refused rather than interpreted.
EXPECTED_CUTOVER_CHAIN="preflight,quiesce,fingerprint-pre,migrate,verify-contract,fingerprint-post,deploy-disabled,enable"

cutover_state_get() {
  awk -F= -v k="$1" '$1 == k { sub(/^[^=]*=/, ""); print; exit }' "${CUTOVER_STATE_FILE}"
}

# Everything here is read-only. It prints what it saw so the decision is
# auditable from the workflow log, and dies on the first thing that is not
# exactly as expected.
cutover_resume_precheck() {
  local chain invalidated state_sha state_mtime wrapper_sha wrapper_version state_version
  local deploy_sha_recorded scheduler_spec scheduler_live holders

  [ -f "${INSTALLED_WRAPPER}" ] \
    || die_cutover "no installed wrapper at ${INSTALLED_WRAPPER}; refusing to deliver one during a recovery"
  [ -s "${CUTOVER_STATE_FILE}" ] \
    || die_cutover "no cutover state at ${CUTOVER_STATE_FILE}; there is nothing to resume"

  wrapper_sha="$(sha256sum "${INSTALLED_WRAPPER}" | awk '{print $1}')"
  wrapper_version="$(awk -F= '/^STATE_VERSION=/ { print $2; exit }' "${INSTALLED_WRAPPER}" | tr -d '"'"'"'[:space:]')"
  state_sha="$(sha256sum "${CUTOVER_STATE_FILE}" | awk '{print $1}')"
  state_mtime="$(date -u -r "${CUTOVER_STATE_FILE}" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || stat -c %y "${CUTOVER_STATE_FILE}")"
  chain="$(cutover_state_get phase_chain)"
  invalidated="$(cutover_state_get invalidated | tr -d '[:space:]')"
  state_version="$(cutover_state_get state_version)"
  deploy_sha_recorded="$(cutover_state_get deploy_sha)"
  scheduler_spec="$(cutover_state_get scheduler_spec)"

  log "installed wrapper : ${INSTALLED_WRAPPER}"
  log "  sha256          : ${wrapper_sha}"
  log "  STATE_VERSION   : ${wrapper_version}"
  log "state record      : ${CUTOVER_STATE_FILE}"
  log "  sha256          : ${state_sha}"
  log "  mtime (utc)     : ${state_mtime}"
  log "  state_version   : ${state_version}"
  log "  deploy_sha      : ${deploy_sha_recorded}"
  log "  phase_chain     : ${chain}"
  log "  invalidated     : ${invalidated:-<unset>}"
  log "  scheduler_spec  : ${scheduler_spec}"

  # Secrets are never in this file, but the redaction is explicit rather than
  # assumed: anything that looks like a token is refused into the log.
  if grep -qiE '(token|secret|password|api[_-]?key)[[:space:]]*=' "${CUTOVER_STATE_FILE}"; then
    die_cutover "the state record contains a credential-shaped key; refusing to print or act on it"
  fi

  [ "${invalidated}" != "yes" ] \
    || die_cutover "this cutover is INVALIDATED; resume-scheduler is not the legal next phase"
  [ "${chain}" = "${EXPECTED_CUTOVER_CHAIN}" ] \
    || die_cutover "phase_chain is '${chain}'; this recovery only acts on exactly '${EXPECTED_CUTOVER_CHAIN}'"
  [ "${state_version}" = "${wrapper_version}" ] \
    || die_cutover "state_version '${state_version}' != installed wrapper STATE_VERSION '${wrapper_version}'; the wrapper on this host did not open this cutover"
  [ -n "${deploy_sha_recorded}" ] \
    || die_cutover "the state record carries no deploy_sha"
  [ "${deploy_sha_recorded}" = "${CUTOVER_RESUME_SHA:-}" ] \
    || die_cutover "state deploy_sha is ${deploy_sha_recorded}; the dispatch asked for '${CUTOVER_RESUME_SHA:-<unset>}'. Refusing to resume a release the operator did not name."

  # An in-flight wrapper holds this lock. flock -n fails rather than waits.
  if command -v flock >/dev/null 2>&1; then
    if ! flock -n 8 2>/dev/null 8>"${CUTOVER_LOCK_FILE}"; then
      holders="$(command -v fuser >/dev/null 2>&1 && fuser "${CUTOVER_LOCK_FILE}" 2>&1 || echo unknown)"
      die_cutover "the cutover lock is held (${holders}); a wrapper is already running"
    fi
    exec 8>&-
    log "cutover lock     : free"
  else
    log "cutover lock     : flock unavailable; the wrapper takes it itself"
  fi

  if pgrep -f 'hetzner-sync-cutover\.sh' >/dev/null 2>&1; then
    die_cutover "a hetzner-sync-cutover.sh process is running; refusing to act underneath it"
  fi
  log "wrapper process   : none running"

  scheduler_live="$(systemctl is-active "${scheduler_spec#systemd:}" 2>/dev/null || true)"
  log "scheduler live    : ${scheduler_live:-unknown} (spec ${scheduler_spec})"
  log "container states  :"
  docker compose ps --format '  {{.Service}}={{.State}} {{.Image}}' 2>/dev/null || true

  cutover_assert_db_reachable_and_matching
  cutover_assert_wrapper_invariants_would_pass

  log "PRECHECK OK — resume-scheduler is the only legal next phase"
}

# The precheck must never say OK for an invocation the wrapper would refuse.
#
# The first version of this did exactly that: it asked systemctl about a
# `rootcron` spec — a meaningless question — and never simulated the wrapper's
# invariants at all. It reported PRECHECK OK for a state with FOUR independent
# refusals waiting. A green precheck that is wrong is worse than no precheck,
# because it converts a careful operator into a confident one.
#
# So this re-derives, with the CORRECT per-spec mechanism, the two invariants
# that actually bite, in the order assert_state_invariants checks them.
cutover_assert_wrapper_invariants_would_pass() {
  local spec live_env recorded_env live_sched recorded_sched block_count end_count

  spec="$(cutover_state_get scheduler_spec)"

  # 1. env_file_sha256 — checked FIRST by the wrapper, and the one a credential
  #    rotation breaks, because every compose service loads .env.production.
  recorded_env="$(cutover_state_get env_file_sha256)"
  if [ -f "${REMOTE_APP_DIR}/.env.production" ]; then
    live_env="$(sha256sum "${REMOTE_APP_DIR}/.env.production" | awk '{print $1}')"
  else
    die_cutover "no ${REMOTE_APP_DIR}/.env.production; the wrapper would refuse"
  fi
  log "env sha256        : live=${live_env:0:12}… state=${recorded_env:0:12}…"
  [ "${live_env}" = "${recorded_env}" ] \
    || die_cutover "the env file changed outside this cutover (live ${live_env} vs state ${recorded_env}); assert_state_invariants refuses before resume-scheduler is reached"

  # 2. scheduler_sha256 — per spec, with the mechanism the wrapper uses.
  recorded_sched="$(cutover_state_get scheduler_sha256)"
  case "${spec}" in
    rootcron)
      crontab -l -u root >/dev/null 2>&1 \
        || die_cutover "the root crontab is unreadable; an empty read is not proof of absence"
      block_count="$(crontab -l -u root 2>/dev/null | grep -c '^# BEGIN adsecute-sync$' || true)"
      end_count="$(crontab -l -u root 2>/dev/null | grep -c '^# END adsecute-sync$' || true)"
      log "rootcron markers  : ${block_count} BEGIN / ${end_count} END"
      [ "${block_count}" = "1" ] && [ "${end_count}" = "1" ] \
        || die_cutover "expected exactly one managed block, found ${block_count} BEGIN and ${end_count} END; rootcron_split would silently merge duplicates"
      live_sched="$(crontab -l -u root 2>/dev/null | sed -n '/^# BEGIN adsecute-sync$/,/^# END adsecute-sync$/p' | sha256sum | awk '{print $1}')"
      ;;
    systemd:*)
      live_sched="$(systemctl show -p FragmentPath --value "${spec#systemd:}" 2>/dev/null | xargs -r sha256sum 2>/dev/null | awk '{print $1}')"
      ;;
    *)
      die_cutover "this precheck does not know how to verify scheduler spec '${spec}'; refusing rather than guessing"
      ;;
  esac
  log "scheduler sha256  : live=${live_sched:0:12}… state=${recorded_sched}"
  [ "${live_sched}" = "${recorded_sched}" ] \
    || die_cutover "the scheduler definition does not match what the cutover recorded (live ${live_sched} vs state '${recorded_sched}'); resume-scheduler would refuse. If the state records 'absent' there was never a saved block: this cutover is UNFINISHABLE and needs a new epoch, not a recovery."

  # 3. The saved block resume-scheduler would restore.
  case "${spec}" in
    rootcron)
      [ -s "${CUTOVER_STATE_DIR}/rootcron.block" ] \
        || die_cutover "no saved rootcron.block; rootcron_start would refuse to invent Sync schedule entries"
      ;;
  esac
  log "wrapper invariants: would pass"
}

# The database half of the proof, and the reason this precheck exists at all.
#
# resume-scheduler re-derives db_identity and compares it to the one the cutover
# recorded. That comparison is the whole point — a cutover resumed against a
# different database is worse than one never resumed — but the wrapper reaches
# PostgreSQL by ssh'ing to the DB host, and this host has no key for it. The
# runner lends its agent for the length of one connection.
#
# Everything here fails CLOSED. No forwarded agent, no target, an unreachable
# host or a mismatched identity all refuse before the wrapper is invoked, which
# is before anything can be written.
cutover_assert_db_reachable_and_matching() {
  local recorded observed

  [ -n "${CUTOVER_DB_SSH:-}" ] \
    || die_cutover "no CUTOVER_DB_SSH target was forwarded; the wrapper would fall back to a local postgres this host does not have"
  case "${CUTOVER_DB_SSH}" in
    *[!a-zA-Z0-9._@-]* | "" | *" "*)
      die_cutover "CUTOVER_DB_SSH '${CUTOVER_DB_SSH}' is not a bare user@host target" ;;
    *@*) : ;;
    *) die_cutover "CUTOVER_DB_SSH '${CUTOVER_DB_SSH}' must be user@host" ;;
  esac
  log "db ssh target     : ${CUTOVER_DB_SSH}"

  [ -n "${SSH_AUTH_SOCK:-}" ] && [ -S "${SSH_AUTH_SOCK}" ] \
    || die_cutover "no forwarded ssh agent on this host; refusing to continue rather than fall back to a persistent key"
  ssh-add -l >/dev/null 2>&1 \
    || die_cutover "the forwarded agent holds no usable identity"
  log "forwarded agent   : present, $(ssh-add -l 2>/dev/null | wc -l | tr -d ' ') identity(ies)"

  # Reachability, proven rather than assumed, with BatchMode so a prompt can
  # never hang a deploy.
  ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
      "${CUTOVER_DB_SSH}" true >/dev/null 2>&1 \
    || die_cutover "cannot reach ${CUTOVER_DB_SSH} over the forwarded agent"
  log "db host           : reachable over the forwarded agent"

  recorded="$(cutover_state_get db_identity)"
  observed="$(ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 \
      "${CUTOVER_DB_SSH}" \
      "runuser -u postgres -- psql --dbname=$(printf %q "${CUTOVER_DB_NAME:-adsecute_prod}") -v ON_ERROR_STOP=1 --tuples-only --no-align -c \"SELECT current_database() || '|' || system_identifier::text FROM pg_control_system();\"" \
      2>/dev/null | tr -d '[:space:]')"

  [ -n "${observed}" ] \
    || die_cutover "could not read the database identity from ${CUTOVER_DB_SSH}"
  [ "${observed}" = "${recorded}" ] \
    || die_cutover "database identity is now '${observed}', the cutover was opened against '${recorded}'; the control path was repointed"
  log "db identity       : matches the cutover state"
}

cutover_resume_invoke() {
  # The wrapper re-derives and re-checks every invariant itself; this adds no
  # arguments beyond the SHA it already demands, and writes nothing.
  SYNC_CUTOVER_DB_SSH="${CUTOVER_DB_SSH}" DEPLOY_SHA="${CUTOVER_RESUME_SHA}" \
    bash "${INSTALLED_WRAPPER}" resume-scheduler
  log "wrapper returned 0; reading the state back"
  SYNC_CUTOVER_DB_SSH="${CUTOVER_DB_SSH}" DEPLOY_SHA="${CUTOVER_RESUME_SHA}" \
    bash "${INSTALLED_WRAPPER}" status || true
  case ",$(cutover_state_get phase_chain)," in
    *,resume-scheduler,*) : ;;
    *) die_cutover "resume-scheduler is still absent from the chain after the wrapper returned 0" ;;
  esac
  log "RESUME OK — phase_chain now: $(cutover_state_get phase_chain)"
}

# ── Clean-epoch cutover: evidence, headroom, and the wrapper's own phases ────
#
# The previous cutover is unfinishable: its `resume-scheduler` fails four
# independent invariants because the scheduler block it was meant to restore
# never existed when it ran, and a human installed a new one afterwards. The
# supported answer is not to adopt that block behind the wrapper's back, nor to
# teach the deploy gate a new exception — it is to open a NEW epoch with the
# wrapper that is already installed and manifest-pinned, which is exactly what
# `preflight` is for: it rewrites the state record from scratch and records the
# scheduler as it actually is.
#
# Nothing here edits state. The only writer is the installed wrapper.
CUTOVER_AUDIT_ROOT="/var/lib/adsecute-cutover-audit"

# Step 1. Copy the evidence somewhere the new epoch cannot overwrite, BEFORE
# preflight truncates the state file. An audit copy, not a state edit.
cutover_epoch_preserve_evidence() {
  local stamp dest src digest
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  dest="${CUTOVER_AUDIT_ROOT}/${stamp}"
  mkdir -p "${dest}"
  chmod 0700 "${CUTOVER_AUDIT_ROOT}" "${dest}"

  for src in \
    "${CUTOVER_STATE_FILE}" \
    "${CUTOVER_STATE_DIR}/sync-release-identity" \
    "${CUTOVER_STATE_DIR}/image-pin" \
    "${REMOTE_APP_DIR}/cutover/cutover-wrapper.manifest" \
    "${REMOTE_APP_DIR}/cutover/installed.manifest"; do
    if [ -f "${src}" ]; then
      cp -p "${src}" "${dest}/$(basename "${src}")"
      log "preserved $(basename "${src}") bytes=$(wc -c < "${src}" | tr -d ' ') sha256=$(sha256sum "${src}" | awk '{print $1}')"
    else
      log "absent (recorded as absent): ${src}"
      printf 'ABSENT %s\n' "${src}" >> "${dest}/absent.txt"
    fi
  done

  sha256sum "${INSTALLED_WRAPPER}" > "${dest}/installed-wrapper.sha256"
  log "installed wrapper sha256=$(awk '{print $1}' "${dest}/installed-wrapper.sha256")"

  ls -la "${CUTOVER_STATE_DIR}" > "${dest}/state-dir-listing.txt" 2>&1 || true
  ls -la "${CUTOVER_STATE_DIR}/attestations" > "${dest}/attestations.txt" 2>&1 || true

  # NAMES only, and logged rather than merely filed. An attestation's CONTENTS
  # record schema and database identity, so they stay on the host; the file
  # names are just epoch labels and are what a continuation has to reference.
  #
  # Logged here on purpose. fingerprint-post refuses when the schema identity is
  # unchanged and no prior epoch is named, and fingerprint-post runs AFTER
  # quiesce — so a missing attestation would otherwise be discovered with the
  # site already down. This is the read that makes that knowable beforehand.
  attestation_names="$(ls -1 "${CUTOVER_STATE_DIR}/attestations" 2>/dev/null | tr '\n' ' ' || true)"
  log "attestations present: ${attestation_names:-none}"

  # Cron: STRUCTURE and digests only. The managed block carries a bearer token,
  # so no line of it is ever copied or printed.
  crontab -l -u root 2>/dev/null > "${dest}/.cron.raw" || true
  if [ -s "${dest}/.cron.raw" ]; then
    {
      printf 'total_lines=%s\n' "$(wc -l < "${dest}/.cron.raw" | tr -d ' ')"
      printf 'begin_markers=%s\n' "$(grep -c '^# BEGIN adsecute-sync$' "${dest}/.cron.raw" || true)"
      printf 'end_markers=%s\n' "$(grep -c '^# END adsecute-sync$' "${dest}/.cron.raw" || true)"
      printf 'whole_sha256=%s\n' "$(sha256sum "${dest}/.cron.raw" | awk '{print $1}')"
      printf 'block_sha256=%s\n' "$(sed -n '/^# BEGIN adsecute-sync$/,/^# END adsecute-sync$/p' "${dest}/.cron.raw" | sha256sum | awk '{print $1}')"
      printf 'outside_sha256=%s\n' "$(sed '/^# BEGIN adsecute-sync$/,/^# END adsecute-sync$/d' "${dest}/.cron.raw" | sha256sum | awk '{print $1}')"
      printf 'outside_sync_refs=%s\n' "$(sed '/^# BEGIN adsecute-sync$/,/^# END adsecute-sync$/d' "${dest}/.cron.raw" | grep -ciE 'adsecute|omniads' || true)"
    } > "${dest}/cron-structure.txt"
    rm -f "${dest}/.cron.raw"
    log "cron structure recorded (digests only, no line copied)"
    cat "${dest}/cron-structure.txt" | sed 's/^/  /'
  else
    rm -f "${dest}/.cron.raw"
    log "root crontab unreadable or empty"
  fi

  # Env: per-key NAMES and digests. Never a value.
  if [ -f "${REMOTE_APP_DIR}/.env.production" ]; then
    printf 'env_file_sha256=%s\n' "$(sha256sum "${REMOTE_APP_DIR}/.env.production" | awk '{print $1}')" \
      > "${dest}/env-digest.txt"
    awk -F= '/^[A-Za-z_][A-Za-z0-9_]*=/ { print $1 }' "${REMOTE_APP_DIR}/.env.production" | sort \
      > "${dest}/env-keys.txt"
    log "env sha256=$(awk -F= '{print $2}' "${dest}/env-digest.txt") keys=$(wc -l < "${dest}/env-keys.txt" | tr -d ' ')"
  fi

  # The pre-enable env snapshots are the strongest evidence of the rotation.
  for src in "${CUTOVER_STATE_DIR}"/env.disabled.*; do
    [ -f "${src}" ] || continue
    printf '%s sha256=%s bytes=%s\n' "$(basename "${src}")" \
      "$(sha256sum "${src}" | awk '{print $1}')" "$(wc -c < "${src}" | tr -d ' ')" \
      >> "${dest}/rotation-artifacts.txt"
  done
  [ -f "${dest}/rotation-artifacts.txt" ] && sed 's/^/  /' "${dest}/rotation-artifacts.txt" || true

  chmod -R go-rwx "${dest}"
  digest="$(find "${dest}" -type f -exec sha256sum {} + | sort -k2 | sha256sum | awk '{print $1}')"
  log "AUDIT COPY COMPLETE dir=${dest} files=$(find "${dest}" -type f | wc -l | tr -d ' ') tree_sha256=${digest}"
}

# Step 2. Headroom, by removing ONLY images no container is using. Never
# touches volumes, containers, backups, state or DB data.
cutover_epoch_prune_images() {
  local keep before_free after_free
  keep="$(mktemp)"
  # Every image id a live container is using, plus the tagged refs of the
  # release the wrapper is pinned to.
  docker ps -a --format '{{.Image}}' | sort -u >> "${keep}"
  for c in $(docker ps -aq); do
    docker inspect "${c}" --format '{{.Image}}' 2>/dev/null >> "${keep}" || true
  done
  sort -u -o "${keep}" "${keep}"
  log "preserving $(wc -l < "${keep}" | tr -d ' ') image reference(s) in use:"
  sed 's/^/  /' "${keep}"

  before_free="$(df -Pm / | awk 'NR==2 {print $4}')"
  log "free before: ${before_free} MB"
  log "docker usage before:"; docker system df | sed 's/^/  /'

  # -a removes images with no container; the keep-list above is what `docker`
  # itself considers in use, so this cannot remove a running container's image.
  docker image prune -af --filter "until=1h" || true

  after_free="$(df -Pm / | awk 'NR==2 {print $4}')"
  log "free after: ${after_free} MB (reclaimed $((after_free - before_free)) MB)"
  log "docker usage after:"; docker system df | sed 's/^/  /'

  # Nothing may have been removed that a container needs.
  local missing=0
  while IFS= read -r ref; do
    [ -n "${ref}" ] || continue
    docker image inspect "${ref}" >/dev/null 2>&1 || { log "MISSING AFTER PRUNE: ${ref}"; missing=1; }
  done < "${keep}"
  rm -f "${keep}"
  [ "${missing}" -eq 0 ] || die_cutover "the prune removed an image a container is using"
  log "every in-use image survived the prune"
}

# Step 3/4. Run one phase of the INSTALLED wrapper. Enumerated, never
# emergency-disable, and the wrapper re-checks everything itself.
cutover_epoch_run() {
  local phase="${CUTOVER_EPOCH_PHASE:-}"
  case "${phase}" in
    preflight|quiesce|fingerprint-pre|migrate|verify-contract|fingerprint-post|deploy-disabled|enable|resume-scheduler|status) : ;;
    emergency-disable) die_cutover "emergency-disable is not available through this path" ;;
    *) die_cutover "unknown or refused cutover phase '${phase}'" ;;
  esac

  [ -f "${INSTALLED_WRAPPER}" ] || die_cutover "no installed wrapper at ${INSTALLED_WRAPPER}"
  log "installed wrapper sha256=$(sha256sum "${INSTALLED_WRAPPER}" | awk '{print $1}')"
  [ -n "${CUTOVER_DB_SSH:-}" ] || die_cutover "no CUTOVER_DB_SSH target forwarded"
  [ -n "${SSH_AUTH_SOCK:-}" ] && [ -S "${SSH_AUTH_SOCK}" ] \
    || die_cutover "no forwarded ssh agent; the wrapper cannot reach the database host"

  log "running installed wrapper phase='${phase}' for ${CUTOVER_RESUME_SHA}"
  SYNC_CUTOVER_DB_SSH="${CUTOVER_DB_SSH}" \
  SYNC_CUTOVER_SCHEDULER="${CUTOVER_SCHEDULER:-rootcron}" \
  SYNC_CUTOVER_CONTINUES_FROM="${CUTOVER_CONTINUES_FROM:-}" \
  DEPLOY_SHA="${CUTOVER_RESUME_SHA}" \
    bash "${INSTALLED_WRAPPER}" "${phase}"

  log "phase '${phase}' returned 0; state now:"
  sed 's/^/  /' "${CUTOVER_STATE_FILE}" 2>/dev/null | grep -viE '(secret|token|password|api[_-]?key)' || true
}

# ── The isolated cutover RUNNER package ────────────────────────────────────
#
# WHY THIS EXISTS, AND WHY IT IS NOT `deliver_cutover_wrapper`.
#
# The host carries a half-finished cutover whose `resume-scheduler` cannot be
# satisfied. The supported way forward is a NEW epoch, opened by `preflight`,
# which truncates and rewrites the state record. That needs a CORRECTED wrapper
# on the host — and `deliver_cutover_wrapper` installs into
# `${REMOTE_APP_DIR}/cutover`, i.e. ON TOP of the wrapper that is already there.
# Overwriting it destroys the only evidence of what opened the stuck epoch, and
# rewrites the bytes of a script an operator may be executing at that moment.
#
# So this installs BESIDE it, never over it: a self-contained, digest-pinned,
# immutable package under `${CUTOVER_RUNNER_ROOT}`, keyed by release SHA and
# wrapper hash. `${REMOTE_APP_DIR}/cutover` is never opened for writing by any
# function below, and every path is checked by its PHYSICAL location — a symlink
# planted at the destination must not be able to smuggle a write into the
# installed directory, and string comparison alone would not see it.
#
# The wrapper resolves its own manifest and recovery policy from
# `${SYNC_CUTOVER_INSTALL_DIR:-${APP_DIR}/cutover}`, so `cutover_runner_run`
# sets SYNC_CUTOVER_INSTALL_DIR to the package directory. That is what makes the
# runner wrapper verify itself against the RUNNER's manifest rather than the
# installed one. Without it the runner wrapper would read the installed
# manifest, fail its own integrity check, and the isolation would be a fiction.
#
# WRAPPER IDENTITY IS NOT DUPLICATED HERE. `scripts/hetzner-sync-cutover.sh`
# already refuses any post-preflight phase whose recorded `wrapper_sha256` is
# not its own, and `preflight` deliberately skips that check so a new epoch is
# always reachable. Nothing below re-implements, relaxes or pre-empts that: the
# package simply makes it possible for a second wrapper to exist on the host
# without the two of them sharing a directory.
#
# NOT WIRED TO CI YET, ON PURPOSE. `.github/scripts/hetzner-ssh.sh`'s
# `run_remote_phase_on_host` forwards a fixed list of environment variables, and
# CUTOVER_RUNNER_IMAGE_DIGEST / CUTOVER_RUNNER_WRAPPER_SHA256 /
# CUTOVER_RUNNER_IMAGE_REPO are NOT on it. Until they are, these phases are
# reachable only from a shell on the host. That is deliberate: the forwarding
# change and the workflow that dispatches it are a separate, reviewable step,
# and half-wiring it (forwarding the digest but not the expected hash) would
# turn the caller-supplied hash check into a no-op. `cutover-runner-package-check.sh`
# pins them as all-or-nothing.
CUTOVER_RUNNER_ROOT="${CUTOVER_RUNNER_ROOT:-/var/lib/adsecute-cutover-runner}"

# Resolved by cutover_runner_resolve_inputs; declared here so `set -u` cannot
# turn a mis-ordered call into an obscure unbound-variable failure.
RUNNER_DIGEST=""
RUNNER_IMAGE_REPO=""
RUNNER_IMAGE_REF=""
RUNNER_EXPECTED_WRAPPER_SHA=""
RUNNER_RELEASE_SHA=""
RUNNER_DIR=""
RUNNER_RESOLVED_PATH=""
RUNNER_PKG_WRAPPER_SHA=""
RUNNER_PKG_MANIFEST_SHA=""
RUNNER_PKG_POLICY_SHA=""

# Lowercase-hex of an exact length, without a regex. `case` globs are available
# in every shell this script could plausibly be run by, and a `grep -E` in a
# command substitution that does NOT match returns 1 — which under `set -e`
# aborts the phase instead of answering the question that was asked.
is_lower_hex() { # <string> <length>
  # The sixteen characters are enumerated, never expressed as a range.
  #
  # `[0-9a-f]` is a COLLATION range, and every UTF-8 locale orders letters
  # aAbBcC…, so "A" sits inside a-f and an UPPERCASE digest passed this check
  # unnoticed. It was then refused further downstream for a different reason —
  # not being present on the host — which reads as a correct refusal and is not
  # one: a malformed digest that happened to be present would have been
  # accepted. Only `LC_ALL=C` makes the range mean bytes, and a validator must
  # not depend on the caller's locale to be a validator.
  case "$1" in
    "" | *[!0123456789abcdef]*) return 1 ;;
  esac
  [ "${#1}" -eq "$2" ]
}

# Where a path PHYSICALLY lives, symlinks resolved, whether or not it exists.
#
# `realpath -m` does exactly this and is GNU-only; macOS's `readlink` is not the
# same program as GNU's. This walks up to the deepest component that DOES exist,
# resolves that with `cd -P` (which is what actually follows symlinks), and
# re-appends the rest. The walk is the load-bearing part: an install destination
# does not exist yet, and a resolver that gives up on a missing path would make
# every containment check below pass vacuously.
resolve_physical_path() { # <path> -> physical path on stdout
  local target head tail base
  target="$1"
  [ -n "${target}" ] || return 1
  case "${target}" in
    /*) : ;;
    *) target="${PWD}/${target}" ;;
  esac
  while [ "${target}" != "/" ] && [ "${target%/}" != "${target}" ]; do
    target="${target%/}"
  done

  head="${target}"
  tail=""
  while [ ! -e "${head}" ] && [ "${head}" != "/" ]; do
    base="$(basename "${head}")"
    tail="${base}${tail:+/${tail}}"
    head="$(dirname "${head}")"
  done

  if [ -d "${head}" ]; then
    head="$(cd -P -- "${head}" && pwd -P)" || return 1
  else
    base="$(basename "${head}")"
    head="$(cd -P -- "$(dirname "${head}")" && pwd -P)/${base}" || return 1
  fi

  if [ -z "${tail}" ]; then
    printf '%s\n' "${head}"
  elif [ "${head}" = "/" ]; then
    printf '/%s\n' "${tail}"
  else
    printf '%s/%s\n' "${head}" "${tail}"
  fi
}

# Is <needle> the same path as <haystack>, or inside it? Both arguments must
# already be physical paths — this is deliberately a pure string test, so the
# resolution happens exactly once, at a place where its failure is visible.
path_is_within() { # <needle> <haystack>
  [ -n "$1" ] && [ -n "$2" ] || return 1
  [ "$2" != "/" ] || return 0
  case "$1" in
    "$2" | "$2"/*) return 0 ;;
  esac
  return 1
}

# The isolation gate. Sets RUNNER_RESOLVED_PATH; dies loudly on refusal.
#
# It sets a global rather than printing the resolved path because a `$(...)`
# would put `die_cutover` in a subshell: the ABORT line would be captured as the
# function's output instead of reaching the log, and the refusal would read as a
# blank value rather than a refusal.
cutover_runner_assert_isolated() { # <path> <label>
  local candidate label candidate_real installed_real root_real
  candidate="$1"
  label="${2:-destination}"

  case "${candidate}" in
    /*) : ;;
    *) die_cutover "REFUSING: the cutover runner ${label} '${candidate}' is not an absolute path" ;;
  esac

  candidate_real="$(resolve_physical_path "${candidate}")" \
    || die_cutover "REFUSING: could not resolve the cutover runner ${label} '${candidate}' to a physical path"
  installed_real="$(resolve_physical_path "${REMOTE_APP_DIR}/cutover")" \
    || die_cutover "REFUSING: could not resolve ${REMOTE_APP_DIR}/cutover to a physical path"
  root_real="$(resolve_physical_path "${CUTOVER_RUNNER_ROOT}")" \
    || die_cutover "REFUSING: could not resolve the runner root ${CUTOVER_RUNNER_ROOT} to a physical path"

  [ "${candidate_real}" != "/" ] \
    || die_cutover "REFUSING: the cutover runner ${label} resolves to /"

  if path_is_within "${root_real}" "${installed_real}" || path_is_within "${installed_real}" "${root_real}"; then
    die_cutover "REFUSING: the runner root ${CUTOVER_RUNNER_ROOT} (-> ${root_real}) overlaps the installed wrapper directory ${REMOTE_APP_DIR}/cutover (-> ${installed_real}). The runner package exists precisely so that these two never share a directory."
  fi
  if path_is_within "${candidate_real}" "${installed_real}"; then
    die_cutover "REFUSING: the cutover runner ${label} ${candidate} resolves to ${candidate_real}, which IS or is INSIDE the installed wrapper directory ${installed_real}. This path installs beside the installed wrapper, never over it."
  fi
  if path_is_within "${installed_real}" "${candidate_real}"; then
    die_cutover "REFUSING: the cutover runner ${label} ${candidate} resolves to ${candidate_real}, which CONTAINS the installed wrapper directory ${installed_real}; writing or deleting it would reach the installed wrapper."
  fi
  if ! path_is_within "${candidate_real}" "${root_real}"; then
    die_cutover "REFUSING: the cutover runner ${label} ${candidate} resolves to ${candidate_real}, which is outside the runner root ${root_real}."
  fi

  RUNNER_RESOLVED_PATH="${candidate_real}"
}

# Globals, NOT `local`: this runs from an EXIT trap, by which point the function
# that would have declared them has returned and a `local` is out of scope —
# under `set -u` the cleanup itself becomes the failure. That exact shape once
# killed a deploy in `hetzner-ssh.sh`; see the trap comment there.
CUTOVER_RUNNER_EXTRACT_CONTAINER=""
CUTOVER_RUNNER_STAGING_DIR=""
cutover_runner_cleanup_extraction() {
  if [ -n "${CUTOVER_RUNNER_EXTRACT_CONTAINER:-}" ]; then
    docker rm -f "${CUTOVER_RUNNER_EXTRACT_CONTAINER}" >/dev/null 2>&1 || true
    CUTOVER_RUNNER_EXTRACT_CONTAINER=""
  fi
  if [ -n "${CUTOVER_RUNNER_STAGING_DIR:-}" ]; then
    rm -rf "${CUTOVER_RUNNER_STAGING_DIR}"
    CUTOVER_RUNNER_STAGING_DIR=""
  fi
}

cutover_runner_resolve_inputs() {
  local repo
  RUNNER_DIGEST="${CUTOVER_RUNNER_IMAGE_DIGEST:-}"
  RUNNER_EXPECTED_WRAPPER_SHA="${CUTOVER_RUNNER_WRAPPER_SHA256:-}"
  RUNNER_RELEASE_SHA="${CUTOVER_RESUME_SHA:-${DEPLOY_SHA:-}}"

  # A TAG is mutable: the same `:sha` can be repushed, and the whole point of
  # this package is that what was verified is what runs. Only a content digest
  # is accepted, and it is checked as a shape rather than trusted as a string.
  [ -n "${RUNNER_DIGEST}" ] \
    || die_cutover "REFUSING: CUTOVER_RUNNER_IMAGE_DIGEST is unset; the runner package is pinned by digest, never by a tag"
  case "${RUNNER_DIGEST}" in
    sha256:*)
      is_lower_hex "${RUNNER_DIGEST#sha256:}" 64 \
        || die_cutover "REFUSING: CUTOVER_RUNNER_IMAGE_DIGEST='${RUNNER_DIGEST}' is not sha256:<64 lowercase hex>"
      ;;
    *)
      die_cutover "REFUSING: CUTOVER_RUNNER_IMAGE_DIGEST='${RUNNER_DIGEST}' is not a sha256 content digest. A tag is mutable and is refused here."
      ;;
  esac

  # The caller's INDEPENDENT expectation. Without it the only cross-check would
  # be the extracted wrapper against its own extracted manifest — a pair that a
  # tampered image supplies together, so it proves consistency and nothing else.
  is_lower_hex "${RUNNER_EXPECTED_WRAPPER_SHA}" 64 \
    || die_cutover "REFUSING: CUTOVER_RUNNER_WRAPPER_SHA256='${RUNNER_EXPECTED_WRAPPER_SHA:-<unset>}' is not a 64-character lowercase hex sha256"

  # Half the package key, and it lands in a filesystem path — so it is validated
  # as 40-hex rather than interpolated as whatever arrived.
  is_lower_hex "${RUNNER_RELEASE_SHA}" 40 \
    || die_cutover "REFUSING: no valid release SHA (CUTOVER_RESUME_SHA/DEPLOY_SHA='${RUNNER_RELEASE_SHA:-<unset>}'); it keys the package directory and must be 40 lowercase hex"

  repo="${CUTOVER_RUNNER_IMAGE_REPO:-${WORKER_IMAGE_REPO}}"
  # No '@' and no ':' may survive this, so the reference built below cannot end
  # up carrying a tag or a second digest.
  case "${repo}" in
    "" | *[!a-zA-Z0-9./_-]*)
      die_cutover "REFUSING: cutover runner image repository '${repo}' is not a bare registry path"
      ;;
  esac

  RUNNER_IMAGE_REPO="${repo}"
  RUNNER_IMAGE_REF="${repo}@${RUNNER_DIGEST}"
  RUNNER_DIR="${CUTOVER_RUNNER_ROOT}/${RUNNER_RELEASE_SHA}-${RUNNER_EXPECTED_WRAPPER_SHA:0:12}"
}

# Everything the package must still be true about itself, re-derived from the
# bytes on disk. Called after installing, and again before every run.
cutover_runner_verify_package() { # <dir>
  local dir file manifest_pinned recorded
  dir="$1"

  for file in hetzner-sync-cutover.sh cutover-wrapper.manifest recovery-policy.tsv runner.manifest; do
    [ -f "${dir}/${file}" ] \
      || die_cutover "REFUSING: the runner package at ${dir} is missing ${file}"
  done

  RUNNER_PKG_WRAPPER_SHA="$(sha256_of_file "${dir}/hetzner-sync-cutover.sh")"
  RUNNER_PKG_MANIFEST_SHA="$(sha256_of_file "${dir}/cutover-wrapper.manifest")"
  RUNNER_PKG_POLICY_SHA="$(sha256_of_file "${dir}/recovery-policy.tsv")"

  manifest_pinned="$(awk -F= '$1 == "wrapper_sha256" { print $2 }' "${dir}/cutover-wrapper.manifest" | tr -d '[:space:]')"
  [ -n "${manifest_pinned}" ] \
    || die_cutover "REFUSING: ${dir}/cutover-wrapper.manifest records no wrapper_sha256"
  [ "${manifest_pinned}" = "${RUNNER_PKG_WRAPPER_SHA}" ] \
    || die_cutover "REFUSING: the packaged wrapper hashes ${RUNNER_PKG_WRAPPER_SHA}, its own manifest pins ${manifest_pinned}"
  [ "${RUNNER_EXPECTED_WRAPPER_SHA}" = "${RUNNER_PKG_WRAPPER_SHA}" ] \
    || die_cutover "REFUSING: the packaged wrapper hashes ${RUNNER_PKG_WRAPPER_SHA}, the caller expected ${RUNNER_EXPECTED_WRAPPER_SHA}"

  recorded="$(awk -F= '$1 == "image_digest" { print $2 }' "${dir}/runner.manifest" | tr -d '[:space:]')"
  [ "${recorded}" = "${RUNNER_DIGEST}" ] \
    || die_cutover "REFUSING: the package at ${dir} was built from image digest ${recorded:-<none>}, this invocation names ${RUNNER_DIGEST}"
  recorded="$(awk -F= '$1 == "wrapper_sha256" { print $2 }' "${dir}/runner.manifest" | tr -d '[:space:]')"
  [ "${recorded}" = "${RUNNER_PKG_WRAPPER_SHA}" ] \
    || die_cutover "REFUSING: the package records wrapper_sha256=${recorded:-<none>}, the file on disk hashes ${RUNNER_PKG_WRAPPER_SHA}"
  recorded="$(awk -F= '$1 == "policy_sha256" { print $2 }' "${dir}/runner.manifest" | tr -d '[:space:]')"
  [ "${recorded}" = "${RUNNER_PKG_POLICY_SHA}" ] \
    || die_cutover "REFUSING: the package records policy_sha256=${recorded:-<none>}, the file on disk hashes ${RUNNER_PKG_POLICY_SHA}"

  # The same field the wrapper's own assert_recovery_policy reads. Pinned here
  # too, so a package whose policy was swapped is refused before the wrapper is
  # ever started rather than midway through a phase.
  recorded="$(awk -F= '$1 == "delivered_policy_sha256" { print $2 }' "${dir}/cutover-wrapper.manifest" | tr -d '[:space:]')"
  [ "${recorded}" = "${RUNNER_PKG_POLICY_SHA}" ] \
    || die_cutover "REFUSING: ${dir}/cutover-wrapper.manifest pins delivered_policy_sha256=${recorded:-<none>}, the packaged policy hashes ${RUNNER_PKG_POLICY_SHA}"
}

cutover_runner_install() {
  local staging dest incoming image_id manifest_source extracted_sha policy_sha

  cutover_runner_resolve_inputs
  cutover_runner_assert_isolated "${RUNNER_DIR}" "destination"
  dest="${RUNNER_RESOLVED_PATH}"

  # Idempotent by RE-VERIFICATION, not by rewriting. A package is named by the
  # digest it came out of and the hash of the wrapper inside it, so "the same
  # digest and hash" can only mean the same bytes; rewriting them would change
  # mtimes for no reason and would put a second write near a directory a phase
  # may be reading from.
  if [ -e "${dest}" ]; then
    [ -d "${dest}" ] \
      || die_cutover "REFUSING: ${dest} exists and is not a directory"
    log "runner package already present at ${dest}; re-verifying rather than rewriting"
    cutover_runner_verify_package "${dest}"
    echo "cutover_runner_package_reused image_digest=${RUNNER_DIGEST} image_ref=${RUNNER_IMAGE_REF} wrapper_sha256=${RUNNER_PKG_WRAPPER_SHA} manifest_sha256=${RUNNER_PKG_MANIFEST_SHA} policy_sha256=${RUNNER_PKG_POLICY_SHA} dest=${dest}"
    return 0
  fi

  mkdir -p "${CUTOVER_RUNNER_ROOT}"
  chmod 0700 "${CUTOVER_RUNNER_ROOT}"

  CUTOVER_RUNNER_STAGING_DIR="$(mktemp -d "${TMPDIR:-/tmp}/adsecute-cutover-runner.XXXXXX")"
  chmod 0700 "${CUTOVER_RUNNER_STAGING_DIR}"
  staging="${CUTOVER_RUNNER_STAGING_DIR}"
  # EXIT, not just the happy path: `die_cutover` exits, and the ERR trap exits
  # too, so the extraction container has to be removed from somewhere that runs
  # on every one of those paths.
  trap cutover_runner_cleanup_extraction EXIT

  log "Building an isolated cutover runner package from ${RUNNER_IMAGE_REF}"
  # A last structural check on the reference actually handed to docker: whatever
  # else a future edit changes, this must still be a digest reference.
  case "${RUNNER_IMAGE_REF}" in
    *"@${RUNNER_DIGEST}") : ;;
    *) die_cutover "REFUSING: the resolved image reference '${RUNNER_IMAGE_REF}' is not pinned to ${RUNNER_DIGEST}" ;;
  esac

  image_id="$(docker image inspect "${RUNNER_IMAGE_REF}" --format '{{.Id}}' 2>/dev/null || true)"
  [ -n "${image_id}" ] \
    || die_cutover "REFUSING: ${RUNNER_IMAGE_REF} is not present on this host; pull the exact digest first"

  CUTOVER_RUNNER_EXTRACT_CONTAINER="$(docker create "${RUNNER_IMAGE_REF}" true)"
  [ -n "${CUTOVER_RUNNER_EXTRACT_CONTAINER}" ] \
    || die_cutover "REFUSING: could not create an extraction container from ${RUNNER_IMAGE_REF}"

  if ! docker cp "${CUTOVER_RUNNER_EXTRACT_CONTAINER}:${WRAPPER_IMAGE_PATH}" "${staging}/hetzner-sync-cutover.sh" ||
    ! docker cp "${CUTOVER_RUNNER_EXTRACT_CONTAINER}:${WRAPPER_MANIFEST_IMAGE_PATH}" "${staging}/cutover-wrapper.manifest" ||
    ! docker cp "${CUTOVER_RUNNER_EXTRACT_CONTAINER}:${WRAPPER_POLICY_IMAGE_PATH}" "${staging}/recovery-policy.tsv"; then
    die_cutover "REFUSING: ${RUNNER_IMAGE_REF} does not carry ${WRAPPER_IMAGE_PATH}, ${WRAPPER_MANIFEST_IMAGE_PATH} and ${WRAPPER_POLICY_IMAGE_PATH}"
  fi

  docker rm -f "${CUTOVER_RUNNER_EXTRACT_CONTAINER}" >/dev/null 2>&1 || true
  CUTOVER_RUNNER_EXTRACT_CONTAINER=""

  manifest_source="$(awk -F= '$1 == "wrapper_source" { print $2 }' "${staging}/cutover-wrapper.manifest" | tr -d '[:space:]')"
  [ "/app/${manifest_source}" = "${WRAPPER_IMAGE_PATH}" ] \
    || die_cutover "REFUSING: the image manifest pins wrapper_source=${manifest_source:-<none>}, this extraction took ${WRAPPER_IMAGE_PATH}"

  extracted_sha="$(sha256_of_file "${staging}/hetzner-sync-cutover.sh")"
  policy_sha="$(sha256_of_file "${staging}/recovery-policy.tsv")"
  [ -n "${policy_sha}" ] \
    || die_cutover "REFUSING: could not hash the extracted recovery policy"

  {
    cat "${staging}/cutover-wrapper.manifest"
    printf 'delivered_deploy_sha=%s\n' "${RUNNER_RELEASE_SHA}"
    printf 'delivered_worker_image=%s\n' "${RUNNER_IMAGE_REF}"
    printf 'delivered_worker_image_id=%s\n' "${image_id}"
    printf 'delivered_policy_sha256=%s\n' "${policy_sha}"
    printf 'delivered_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "${staging}/composed.manifest"

  {
    printf 'runner_package_version=1\n'
    printf 'image_digest=%s\n' "${RUNNER_DIGEST}"
    printf 'image_ref=%s\n' "${RUNNER_IMAGE_REF}"
    printf 'image_id=%s\n' "${image_id}"
    printf 'wrapper_sha256=%s\n' "${extracted_sha}"
    printf 'policy_sha256=%s\n' "${policy_sha}"
    printf 'release_sha=%s\n' "${RUNNER_RELEASE_SHA}"
    printf 'installed_uid=%s\n' "$(id -u)"
    printf 'installed_utc=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "${staging}/runner.manifest"

  # Assembled under a sibling name and renamed into place, so a package is
  # either wholly there or not there at all. Same parent directory, so the
  # rename is atomic; a cross-filesystem `mv` would not be.
  incoming="${dest}.incoming"
  cutover_runner_assert_isolated "${incoming}" "staging destination"
  incoming="${RUNNER_RESOLVED_PATH}"
  rm -rf "${incoming}"
  mkdir -p "${incoming}"
  chmod 0700 "${incoming}"

  cp "${staging}/hetzner-sync-cutover.sh" "${incoming}/hetzner-sync-cutover.sh"
  cp "${staging}/composed.manifest" "${incoming}/cutover-wrapper.manifest"
  cp "${staging}/recovery-policy.tsv" "${incoming}/recovery-policy.tsv"
  cp "${staging}/runner.manifest" "${incoming}/runner.manifest"
  # 0600, not 0700: the wrapper is started as `bash <path>`, which reads the
  # file rather than exec'ing it, so it never needs the execute bit.
  chmod 0600 "${incoming}"/*
  if [ "$(id -u)" = "0" ]; then
    chown -R 0:0 "${incoming}"
  else
    log "not running as root (uid=$(id -u)); leaving package ownership as the invoking user"
  fi

  # Re-checked immediately before publishing: the checks above ran against a
  # path that did not exist yet, and something could have been planted since.
  cutover_runner_assert_isolated "${incoming}" "staging destination"
  cutover_runner_assert_isolated "${dest}" "destination"
  mv "${incoming}" "${dest}"
  chmod 0700 "${dest}"

  cutover_runner_assert_isolated "${dest}" "destination"
  cutover_runner_verify_package "${dest}"

  cutover_runner_cleanup_extraction
  trap - EXIT

  echo "cutover_runner_package_installed image_digest=${RUNNER_DIGEST} image_ref=${RUNNER_IMAGE_REF} image_id=${image_id} wrapper_sha256=${RUNNER_PKG_WRAPPER_SHA} manifest_sha256=${RUNNER_PKG_MANIFEST_SHA} policy_sha256=${RUNNER_PKG_POLICY_SHA} dest=${dest}"
  echo "cutover_runner_installed_wrapper_untouched path=${REMOTE_APP_DIR}/cutover"
}

cutover_runner_run() {
  local phase dest installed_sha
  phase="${CUTOVER_EPOCH_PHASE:-}"

  # The SAME allowlist cutover_epoch_run enforces, including the refusal of
  # emergency-disable. An isolated wrapper is still a wrapper: it must not open
  # a path the installed one refuses.
  case "${phase}" in
    preflight | quiesce | fingerprint-pre | migrate | verify-contract | fingerprint-post | deploy-disabled | enable | resume-scheduler | status) : ;;
    emergency-disable) die_cutover "emergency-disable is not available through this path" ;;
    *) die_cutover "unknown or refused cutover phase '${phase}'" ;;
  esac

  cutover_runner_resolve_inputs
  cutover_runner_assert_isolated "${RUNNER_DIR}" "destination"
  dest="${RUNNER_RESOLVED_PATH}"

  [ -d "${dest}" ] \
    || die_cutover "REFUSING: no cutover runner package at ${dest}; run the cutover_runner_install phase first"
  # Re-verified HERE, not trusted from install time: install and run are
  # separate dispatches, minutes or hours apart, and anything that could edit
  # the package in between is exactly what this is defending against.
  cutover_runner_verify_package "${dest}"

  if [ -f "${INSTALLED_WRAPPER}" ]; then
    installed_sha="$(sha256_of_file "${INSTALLED_WRAPPER}")"
  else
    installed_sha="<absent>"
  fi

  # Side by side, always. Mixed-wrapper state is the failure mode this whole
  # package risks introducing, so which two programs are on this host is a line
  # in the log rather than something inferred afterwards from two runs.
  log "runner wrapper    : ${dest}/hetzner-sync-cutover.sh"
  log "  sha256          : ${RUNNER_PKG_WRAPPER_SHA}"
  log "  image digest    : ${RUNNER_DIGEST}"
  log "installed wrapper : ${INSTALLED_WRAPPER}"
  log "  sha256          : ${installed_sha}"
  if [ "${installed_sha}" = "${RUNNER_PKG_WRAPPER_SHA}" ]; then
    log "  the runner and installed wrappers are the SAME program"
  else
    log "  the runner and installed wrappers DIFFER; this phase runs the runner wrapper ${RUNNER_PKG_WRAPPER_SHA}"
  fi

  [ -n "${CUTOVER_DB_SSH:-}" ] || die_cutover "no CUTOVER_DB_SSH target forwarded"
  [ -n "${SSH_AUTH_SOCK:-}" ] && [ -S "${SSH_AUTH_SOCK}" ] \
    || die_cutover "no forwarded ssh agent; the wrapper cannot reach the database host"

  log "running RUNNER wrapper phase='${phase}' for ${RUNNER_RELEASE_SHA}"
  # SYNC_CUTOVER_INSTALL_DIR is what keeps this isolated: the wrapper resolves
  # its manifest AND its recovery policy from that directory, so without it the
  # runner wrapper would read ${REMOTE_APP_DIR}/cutover's manifest and refuse
  # itself. Everything else is byte-for-byte the contract cutover_epoch_run uses.
  # Output goes to a HOST-SIDE file, not down the SSH channel.
  #
  # preflight emits a great deal — including container output from the docker
  # commands it runs — and streaming that over the connection killed it: ssh
  # returned 255 on all four attempts about 25 seconds in, before the backup
  # even started. The bytes, not the work, were the problem.
  #
  # Writing to the host also keeps the full record where the audit evidence
  # already lives, instead of only in a workflow log: a bounded tail comes back
  # for the decision, the whole thing stays on the machine it describes.
  local phase_log
  phase_log="${CUTOVER_RUNNER_ROOT}/phase-${phase}-$(date -u +%Y%m%dT%H%M%SZ).log"
  local phase_status=0
  set +e
  SYNC_CUTOVER_INSTALL_DIR="${dest}" \
  SYNC_CUTOVER_DB_SSH="${CUTOVER_DB_SSH}" \
  SYNC_CUTOVER_SCHEDULER="${CUTOVER_SCHEDULER:-rootcron}" \
  SYNC_CUTOVER_CONTINUES_FROM="${CUTOVER_CONTINUES_FROM:-}" \
  DEPLOY_SHA="${RUNNER_RELEASE_SHA}" \
    bash "${dest}/hetzner-sync-cutover.sh" "${phase}" > "${phase_log}" 2>&1
  phase_status=$?
  set -e

  log "phase log: ${phase_log} ($(wc -c < "${phase_log}" 2>/dev/null || echo 0) bytes) — last 40 lines:"
  tail -n 40 "${phase_log}" 2>/dev/null | sed 's/^/  | /' || true

  [ "${phase_status}" -eq 0 ] \
    || die_cutover "phase '${phase}' failed with status ${phase_status}; the full log is at ${phase_log} on the host"

  log "phase '${phase}' returned 0; state now:"
  sed 's/^/  /' "${CUTOVER_STATE_FILE}" 2>/dev/null | grep -viE '(secret|token|password|api[_-]?key)' || true
}

# The reversible host-side fail-safe. Deletes ONE runner package directory and
# nothing else: not state, not the installed wrapper, not a container, not an
# image. Undoing this phase is `cutover_runner_install` again — the package is
# reproducible from its digest, which is why removing it is safe and why nothing
# here needs to be preserved first.
# Fetch the exact image the runner package is built from.
#
# Kept SEPARATE from cutover_runner_install on purpose. Install's job is to
# verify and refuse; if it could also fetch, a failed verification would be one
# retry away from silently pulling something else. So this is the only step that
# reaches the network, it names the digest explicitly, and install still refuses
# when the digest is not already local.
#
# The ephemeral DOCKER_CONFIG the SSH layer exports is what authorises this; no
# credential is created here and none outlives the phase.
# READ-ONLY proof that the app host can authenticate onward to the database
# host. Nothing is created, copied, or persisted; no key material is printed.
#
# This exists because a forwarded invocation silently rode a master opened
# WITHOUT forwarding, so the app host had no agent and the wrapper reported
# "Permission denied (publickey,password)" — a message that reads like a wrong
# key or a wrong user, and is neither. The probe separates those cases: if the
# agent is present and `true` succeeds, multiplexing was the fault; if the agent
# is present and it still fails, the target user or authorized key is wrong.
cutover_ssh_diagnose() {
  [ -n "${CUTOVER_DB_SSH:-}" ] || die_cutover "no CUTOVER_DB_SSH target forwarded"

  if [ -n "${SSH_AUTH_SOCK:-}" ] && [ -S "${SSH_AUTH_SOCK}" ]; then
    log "agent socket present: ${SSH_AUTH_SOCK}"
  else
    log "agent socket ABSENT (SSH_AUTH_SOCK='${SSH_AUTH_SOCK:-<unset>}')"
  fi

  # Fingerprints only. ssh-add -l prints type, fingerprint and comment — never
  # private material — and the comment is dropped in case it carries a name.
  if ssh-add -l >/dev/null 2>&1; then
    log "forwarded agent identities:"
    ssh-add -l 2>/dev/null | awk '{print "  | " $1 " " $2}' || true
  else
    log "forwarded agent holds no identities (or is unreachable)"
  fi

  # BatchMode: never prompt, fail immediately, so this cannot hang a job.
  # StrictHostKeyChecking is left at the host's own default.
  log "probing ${CUTOVER_DB_SSH} with a non-interactive 'true'"
  if ssh -o BatchMode=yes -o ConnectTimeout=10 "${CUTOVER_DB_SSH}" true 2>&1 | sed 's/^/  | /'; then
    log "DB SSH PROBE OK — the app host can authenticate to the database host"
  else
    log "DB SSH PROBE FAILED — see the line above for the server's own reason"
    return 1
  fi
}

cutover_runner_pull() {
  local repo digest
  repo="${CUTOVER_RUNNER_IMAGE_REPO:-}"
  digest="${CUTOVER_RUNNER_IMAGE_DIGEST:-}"
  [ -n "${repo}" ] || die_cutover "no CUTOVER_RUNNER_IMAGE_REPO supplied"
  case "${digest}" in
    sha256:*) : ;;
    *) die_cutover "CUTOVER_RUNNER_IMAGE_DIGEST must be sha256:<64 hex>, got '${digest}'" ;;
  esac
  is_lower_hex "${digest#sha256:}" 64 \
    || die_cutover "CUTOVER_RUNNER_IMAGE_DIGEST is not a 64-character lowercase hex digest"

  log "pulling ${repo}@${digest}"
  docker pull "${repo}@${digest}" >/dev/null \
    || die_cutover "could not pull ${repo}@${digest}; the runner package cannot be built from an image that is not here"
  # By digest, so this can only confirm the thing we asked for.
  docker image inspect "${repo}@${digest}" --format '{{.Id}}' >/dev/null 2>&1 \
    || die_cutover "pulled ${repo}@${digest} but the daemon cannot inspect it"
  log "runner image present: ${repo}@${digest}"

  # A digest pull creates NO tag. The image is genuinely present, and
  # `docker image inspect ${repo}:${sha}` still fails — which is how preflight
  # refused with "missing image ...; pull it first" while the bytes were sitting
  # right there. The wrapper resolves images by tag, so the tag has to exist.
  #
  # Tagging FROM the digest rather than pulling by tag is what keeps the pin
  # intact: the tag can only ever point at the bytes just verified, instead of
  # at whatever the registry currently calls that tag.
  if [ -n "${DEPLOY_SHA:-}" ]; then
    docker tag "${repo}@${digest}" "${repo}:${DEPLOY_SHA}" \
      || die_cutover "pulled ${repo}@${digest} but could not tag it ${repo}:${DEPLOY_SHA}"
    local tagged_id digest_id
    tagged_id="$(docker image inspect "${repo}:${DEPLOY_SHA}" --format '{{.Id}}' 2>/dev/null || true)"
    digest_id="$(docker image inspect "${repo}@${digest}" --format '{{.Id}}' 2>/dev/null || true)"
    [ -n "${tagged_id}" ] && [ "${tagged_id}" = "${digest_id}" ] \
      || die_cutover "tag ${repo}:${DEPLOY_SHA} does not resolve to ${digest}"
    log "tagged ${repo}:${DEPLOY_SHA} -> ${digest} (image id ${tagged_id})"
  fi
}

cutover_runner_remove() {
  local target resolved root_real
  if [ -n "${CUTOVER_RUNNER_DIR:-}" ]; then
    target="${CUTOVER_RUNNER_DIR}"
  else
    cutover_runner_resolve_inputs
    target="${RUNNER_DIR}"
  fi

  cutover_runner_assert_isolated "${target}" "removal target"
  resolved="${RUNNER_RESOLVED_PATH}"

  root_real="$(resolve_physical_path "${CUTOVER_RUNNER_ROOT}")" \
    || die_cutover "REFUSING: could not resolve the runner root ${CUTOVER_RUNNER_ROOT} to a physical path"
  [ "${resolved}" != "${root_real}" ] \
    || die_cutover "REFUSING: ${resolved} is the runner ROOT itself; this phase removes ONE package directory"

  if [ ! -e "${resolved}" ]; then
    log "no runner package at ${resolved}; nothing to remove"
    echo "cutover_runner_package_absent dest=${resolved}"
    return 0
  fi
  [ -d "${resolved}" ] \
    || die_cutover "REFUSING: ${resolved} is not a directory"

  log "removing runner package ${resolved}"
  ls -la "${resolved}" | sed 's/^/  /' || true
  rm -rf "${resolved}"
  [ ! -e "${resolved}" ] \
    || die_cutover "the runner package at ${resolved} survived removal"

  echo "cutover_runner_package_removed dest=${resolved}"
}

die_cutover() {
  log "ABORT ${1}"
  exit 1
}

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
    # Recreate one service at a time. With both services in a single `up`, the
    # worker's health-check/autoheal restart can race Docker's removal after the
    # web container has already been replaced. That leaves production with no
    # web container and an old worker. Stopping the worker first closes that
    # race; the two explicit `up` calls also make a partial failure recoverable.
    log "Stopping worker before service recreation"
    docker compose stop worker || true

    log "Recreating web"
    docker compose up -d --force-recreate web

    log "Recreating worker"
    docker compose up -d --force-recreate worker

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

  # ── Cutover recovery: the narrowest path back to an ordinary deploy ────────
  #
  # An ordinary deploy is refused while /var/lib/adsecute-cutover/state records
  # a chain that reached `enable` but never `resume-scheduler`. That refusal is
  # correct — between those two phases the cutover still owns the database — and
  # the supported way out is to finish the cutover, not to edit its state or
  # bypass the gate.
  #
  # These two phases do exactly that and nothing else. They never migrate, never
  # pull, never recreate a container, never touch retention, and never write the
  # state file directly: the only writer is the wrapper's own `resume-scheduler`,
  # which re-checks every invariant itself. This is a second lock on a door that
  # already locks, because the cost of being wrong here is a cutover resumed
  # against a runtime it does not describe.
  #
  # Deliberately absent: deliver_cutover_wrapper. The installed wrapper is the
  # one that WROTE this state, quite possibly shipped inside the currently
  # running old worker image. Overwriting it before resuming would resume a
  # cutover with a different program than the one that opened it.
  cutover_resume_precheck)
    log "Cutover resume precheck — read only, no mutation"
    cutover_resume_precheck
    ;;

  cutover_epoch_preserve_evidence)
    log "Preserving cutover evidence before a new epoch truncates it"
    cutover_epoch_preserve_evidence
    ;;

  cutover_epoch_prune_images)
    log "Reclaiming app-host headroom (unused images only)"
    cutover_epoch_prune_images
    ;;

  cutover_epoch_run)
    cutover_epoch_run
    ;;

  # ── The isolated runner package ─────────────────────────────────────────
  #
  # Deliberately NOT reachable from `prepare_runtime` or any ordinary deploy
  # phase, and deliberately NOT calling deliver_cutover_wrapper: the whole
  # point is to leave ${REMOTE_APP_DIR}/cutover exactly as it is.
  cutover_ssh_diagnose)
    log "Read-only: can the app host authenticate onward to the database host?"
    cutover_ssh_diagnose
    ;;

  cutover_runner_pull)
    log "Fetching the exact image the runner package is extracted from"
    cutover_runner_pull
    ;;

  cutover_runner_install)
    log "Installing an isolated, digest-pinned cutover runner package"
    cutover_runner_install
    ;;

  cutover_runner_run)
    cutover_runner_run
    ;;

  cutover_runner_remove)
    log "Removing the isolated cutover runner package (the reversible fail-safe)"
    cutover_runner_remove
    ;;

  cutover_resume_scheduler)
    log "Cutover resume — invoking the installed wrapper's own resume-scheduler"
    cutover_resume_precheck
    cutover_resume_invoke
    ;;

  *)
    echo "unknown remote deploy phase: ${phase}" >&2
    exit 1
    ;;
esac

trap - ERR
