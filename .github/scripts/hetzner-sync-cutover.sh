#!/usr/bin/env bash
set -euo pipefail

# Host-side global sync cutover.
#
# WHY THIS EXISTS AT ALL
#
# `scripts/global-sync-rollout.ts` is TypeScript run through npm. The production
# host has psql, docker and docker compose — and no Node, no npm, no
# node_modules. So `npm run rollout:enable` cannot run there, and a runbook that
# says to run it is a runbook that cannot be followed. Everything below runs with
# what the host actually has, and reaches the TypeScript verifier by executing it
# INSIDE the already-pinned worker image with the project directory bind-mounted.
#
# WHAT IT IS NOT
#
# It is not atomic, and this file will not pretend otherwise. Writing the env
# file atomically makes the FILE change atomic; it does not make the RUNTIME
# change atomic, because web and worker read their environment when the container
# is created. The cutover is therefore built around: both new-build processes
# already deployed and disabled, physical quiescence for the migration, a single
# preserved env configuration, controlled recreation from that same
# configuration, and readback of what the containers actually got.
#
# STATE
#
# Every phase records completion in a durable state file, so an interrupted
# cutover resumes rather than restarting — re-running a completed phase is
# refused rather than silently repeated. One flock serialises the whole thing:
# two operators, or an operator and a cron, must not interleave.
#
#   ./hetzner-sync-cutover.sh <phase>
#
# Phases, in order:
#   preflight        read-only; verify SHA, quiescence targets, backup manifest
#   quiesce          disable external scheduler, stop autoheal + web + worker
#   fingerprint-pre  record DB identity, counts, selected-binding hash
#   migrate          run migrations from the pinned image
#   fingerprint-post compare against the pre-migration fingerprint
#   deploy-disabled  bring web + worker up on the new build with lanes OFF
#   enable           update the preserved env, recreate both, verify
#   resume-scheduler re-enable the external scheduler, last
#   emergency-disable  stop everything now; report success only once confirmed
#   status           print the state file

PHASE="${1:-status}"
APP_DIR="${REMOTE_APP_DIR:-/var/www/adsecute}"
ENV_FILE="${APP_DIR}/.env.production"
STATE_DIR="${SYNC_CUTOVER_STATE_DIR:-/var/lib/adsecute-cutover}"
STATE_FILE="${STATE_DIR}/state"
LOCK_FILE="${STATE_DIR}/lock"
BACKUP_MANIFEST="${SYNC_CUTOVER_BACKUP_MANIFEST:-/var/backups/adsecute-postgres/verified-restore.manifest}"
DRAIN_SECONDS="${SYNC_CUTOVER_DRAIN_SECONDS:-90}"
SCHEDULER_UNIT="${SYNC_CUTOVER_SCHEDULER_UNIT:-adsecute-sync-cron.timer}"
DB_NAME="${DB_NAME:-adsecute_prod}"
PSQL=(runuser -u postgres -- psql --dbname="${DB_NAME}" -v ON_ERROR_STOP=1 --tuples-only --no-align)

# The exact build being cut over to. Not optional: "whatever is deployed" is how
# a cutover ends up half on one build and half on another.
EXPECTED_SHA="${DEPLOY_SHA:-}"
EXPECTED_WEB_IMAGE="ghcr.io/erhanrdn/omniads-web:${EXPECTED_SHA}"
EXPECTED_WORKER_IMAGE="ghcr.io/erhanrdn/omniads-worker:${EXPECTED_SHA}"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1"; }
die() { printf '[%s] ABORT %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >&2; exit 1; }

mkdir -p "${STATE_DIR}"
touch "${STATE_FILE}" "${LOCK_FILE}"
chmod 0600 "${STATE_FILE}"

state_has() { grep -qxF "$1" "${STATE_FILE}"; }
state_put() { grep -qxF "$1" "${STATE_FILE}" || printf '%s\n' "$1" >> "${STATE_FILE}"; }
require_state() {
  state_has "$1" || die "phase '$1' has not completed; run it first"
}
refuse_repeat() {
  ! state_has "$1" || die "phase '$1' already completed; nothing to redo (see ${STATE_FILE})"
}

require_sha() {
  [ -n "${EXPECTED_SHA}" ] || die "DEPLOY_SHA is required and must be the exact commit being cut over to"
  case "${EXPECTED_SHA}" in
    *[!0-9a-f]* | "") die "DEPLOY_SHA must be a lowercase hex commit sha" ;;
  esac
}

# Run the repository's TypeScript from inside the pinned worker image. The host
# has no Node; the image does, and it is the exact build being deployed.
run_in_pinned_image() {
  docker run --rm \
    --network host \
    --env-file "${ENV_FILE}" \
    -e NODE_ENV=production \
    -e SYNC_ROLLOUT_PROJECT_DIR="${APP_DIR}" \
    -v "${APP_DIR}:${APP_DIR}" \
    -w /app \
    "${EXPECTED_WORKER_IMAGE}" \
    "$@"
}

container_state() {
  local service="$1" id
  id="$(docker compose ps -q "${service}" 2>/dev/null || true)"
  if [ -z "${id}" ]; then printf 'absent'; return; fi
  docker inspect "${id}" --format '{{.State.Status}}' 2>/dev/null || printf 'unknown'
}

assert_stopped() {
  local service="$1" observed
  observed="$(container_state "${service}")"
  case "${observed}" in
    absent | exited | created) log "${service}=${observed}" ;;
    *) die "${service} is '${observed}'; it must be stopped before continuing" ;;
  esac
}

selected_binding_hash() {
  # The FULL identity set, not a count. A count matches after an account is
  # swapped for another; this does not. Ordered so the hash is stable.
  "${PSQL[@]}" --command="
    SELECT encode(digest(string_agg(identity, E'\n' ORDER BY identity), 'sha256'), 'hex')
    FROM (
      SELECT bpa.business_id || '|' || bpa.provider || '|' || bpa.provider_account_id AS identity
      FROM business_provider_accounts bpa
      WHERE bpa.is_selected
    ) rows;
  " | tr -d '[:space:]'
}

db_identity() {
  "${PSQL[@]}" --command="
    SELECT current_database() || '|' || system_identifier::text FROM pg_control_system();
  " | tr -d '[:space:]'
}

raw_counts() {
  "${PSQL[@]}" --command="
    SELECT (SELECT count(*) FROM meta_raw_snapshots)::text || '|' ||
           (SELECT count(*) FROM shopify_raw_snapshots)::text || '|' ||
           (SELECT count(*) FROM business_provider_accounts)::text;
  " | tr -d '[:space:]'
}

cd "${APP_DIR}"

exec 9>"${LOCK_FILE}"
flock -n 9 || die "another cutover is in progress (${LOCK_FILE})"

case "${PHASE}" in
  status)
    printf 'state file: %s\n' "${STATE_FILE}"
    cat "${STATE_FILE}"
    for service in web worker autoheal; do
      printf '%s=%s\n' "${service}" "$(container_state "${service}")"
    done
    ;;

  preflight)
    require_sha
    log "Verifying the exact images for ${EXPECTED_SHA} are present"
    docker image inspect "${EXPECTED_WEB_IMAGE}" >/dev/null \
      || die "missing image ${EXPECTED_WEB_IMAGE}; pull it first"
    docker image inspect "${EXPECTED_WORKER_IMAGE}" >/dev/null \
      || die "missing image ${EXPECTED_WORKER_IMAGE}; pull it first"

    log "Verifying the env file the runtime actually sources"
    [ -f "${ENV_FILE}" ] || die "missing ${ENV_FILE}"
    grep -q "\.env\.production" "${APP_DIR}/docker-compose.yml" \
      || die "docker-compose.yml does not reference .env.production; the target is wrong"

    log "Requiring a VERIFIED backup manifest (a backup nobody restored is not a rollback plan)"
    [ -s "${BACKUP_MANIFEST}" ] || die "missing or empty ${BACKUP_MANIFEST}"
    grep -q "scratch_restore_verified=yes" "${BACKUP_MANIFEST}" \
      || die "${BACKUP_MANIFEST} does not record a completed scratch restore"

    log "Running the repository preflight inside the pinned image"
    run_in_pinned_image node --import tsx scripts/global-sync-rollout.ts preflight \
      || die "repository preflight refused; do not continue"

    state_put "preflight:${EXPECTED_SHA}"
    log "preflight OK"
    ;;

  quiesce)
    require_sha
    require_state "preflight:${EXPECTED_SHA}"
    log "Disabling the external scheduler BEFORE stopping anything"
    systemctl disable --now "${SCHEDULER_UNIT}" 2>/dev/null || true
    if systemctl is-active --quiet "${SCHEDULER_UNIT}" 2>/dev/null; then
      die "${SCHEDULER_UNIT} is still active; an external trigger would restart work mid-migration"
    fi

    # autoheal FIRST. It restarts unhealthy containers, so stopping the worker
    # while autoheal is running is how a "stopped" worker comes back by itself.
    log "Stopping autoheal, then web, then worker"
    docker compose stop autoheal || true
    assert_stopped autoheal
    docker compose stop web worker || true
    assert_stopped web
    assert_stopped worker

    log "Draining for ${DRAIN_SECONDS}s and proving nothing is mid-flight"
    sleep "${DRAIN_SECONDS}"
    assert_stopped web
    assert_stopped worker
    assert_stopped autoheal

    leases="$("${PSQL[@]}" --command="
      SELECT (SELECT count(*) FROM meta_sync_partitions WHERE lease_owner IS NOT NULL)
           + (SELECT count(*) FROM google_ads_sync_partitions WHERE lease_owner IS NOT NULL)
           + (SELECT count(*) FROM sync_runner_leases WHERE lease_expires_at > now())
           + (SELECT count(*) FROM provider_sync_jobs WHERE status = 'running');
    " | tr -d '[:space:]')"
    [ "${leases}" = "0" ] || die "quiescence not reached: ${leases} live lease(s)/running job(s). Wait for expiry; do not clear by hand."

    state_put "quiesce:${EXPECTED_SHA}"
    log "quiesce OK"
    ;;

  fingerprint-pre)
    require_state "quiesce:${EXPECTED_SHA}"
    refuse_repeat "fingerprint-pre:${EXPECTED_SHA}"
    {
      printf 'identity=%s\n' "$(db_identity)"
      printf 'counts=%s\n' "$(raw_counts)"
      printf 'selected_hash=%s\n' "$(selected_binding_hash)"
    } > "${STATE_DIR}/fingerprint-pre"
    chmod 0600 "${STATE_DIR}/fingerprint-pre"
    cat "${STATE_DIR}/fingerprint-pre"
    state_put "fingerprint-pre:${EXPECTED_SHA}"
    log "fingerprint-pre OK"
    ;;

  migrate)
    require_state "fingerprint-pre:${EXPECTED_SHA}"
    log "Running migrations from the pinned image"
    APP_IMAGE_TAG="${EXPECTED_SHA}" APP_BUILD_ID="${EXPECTED_SHA}" \
      docker compose up --no-deps --abort-on-container-exit --exit-code-from migrate migrate \
      || die "migrations failed; completion was not announced and nothing was enabled"
    docker compose rm -f migrate >/dev/null 2>&1 || true
    state_put "migrate:${EXPECTED_SHA}"
    log "migrate OK"
    ;;

  fingerprint-post)
    require_state "migrate:${EXPECTED_SHA}"
    {
      printf 'identity=%s\n' "$(db_identity)"
      printf 'counts=%s\n' "$(raw_counts)"
      printf 'selected_hash=%s\n' "$(selected_binding_hash)"
    } > "${STATE_DIR}/fingerprint-post"
    chmod 0600 "${STATE_DIR}/fingerprint-post"
    # The migration is expand-only. Identity, row counts and the FULL selected
    # binding identity set must be byte-identical. A count alone would still
    # match if one selected account had been swapped for another.
    if ! diff -u "${STATE_DIR}/fingerprint-pre" "${STATE_DIR}/fingerprint-post"; then
      die "the migration changed identity, row counts or the selected-binding set. Do not enable. Restore from the verified backup."
    fi
    state_put "fingerprint-post:${EXPECTED_SHA}"
    log "fingerprint-post OK — identical"
    ;;

  deploy-disabled)
    require_state "fingerprint-post:${EXPECTED_SHA}"
    log "Confirming every lane is OFF before the new build starts"
    if grep -Eq '^\s*(export\s+)?ADSECUTE_SYNC_(GLOBAL|LANE_[A-Z_]+)_ENABLED\s*=\s*enabled' "${ENV_FILE}"; then
      die "a sync lane is already enabled in ${ENV_FILE}; the new build must start disabled"
    fi

    log "Starting web and worker on ${EXPECTED_SHA}, lanes off"
    APP_IMAGE_TAG="${EXPECTED_SHA}" APP_BUILD_ID="${EXPECTED_SHA}" \
      docker compose up -d --force-recreate web worker

    for service in web worker; do
      expected="ghcr.io/erhanrdn/omniads-${service}:${EXPECTED_SHA}"
      actual="$(docker inspect "$(docker compose ps -q "${service}")" --format '{{.Config.Image}}')"
      [ "${actual}" = "${expected}" ] || die "${service} is running ${actual}, expected ${expected}"
      log "${service} image=${actual}"
    done

    log "Checking /healthz and /build-info"
    curl -fsS http://127.0.0.1:3000/api/healthz >/dev/null || die "/healthz did not answer"
    build_id="$(curl -fsS http://127.0.0.1:3000/api/build-info | python3 -c 'import json,sys; print(json.load(sys.stdin).get("buildId") or "")')"
    [ "${build_id}" = "${EXPECTED_SHA}" ] || die "build-info reports '${build_id}', expected ${EXPECTED_SHA}"

    # Effective CONTAINER environment, not the file. This is the readback that
    # proves the recreate actually picked the configuration up — and it prints
    # only key names and a yes/no, never a value.
    for service in web worker; do
      id="$(docker compose ps -q "${service}")"
      for key in ADSECUTE_SYNC_GLOBAL_ENABLED DATABASE_URL; do
        if docker exec "${id}" sh -c "test -n \"\${${key}:-}\""; then present=yes; else present=no; fi
        log "${service} env ${key} present=${present}"
        if [ "${key}" = "ADSECUTE_SYNC_GLOBAL_ENABLED" ] && [ "${present}" = "yes" ]; then
          die "${service} started with the master switch set; it must start disabled"
        fi
        if [ "${key}" = "DATABASE_URL" ] && [ "${present}" = "no" ]; then
          die "${service} has no DATABASE_URL; the env file was not sourced"
        fi
      done
    done

    log "Proving the worker registered fresh and no old process is still heartbeating"
    worker_started_at="$(docker inspect "$(docker compose ps -q worker)" --format '{{.State.StartedAt}}')"
    docker compose exec -T worker node --import tsx scripts/sync-worker-healthcheck.ts \
      --provider-scope meta --online-window-minutes 5 --min-online-workers 1 \
      --min-heartbeat-after "${worker_started_at}" \
      || die "no fresh worker heartbeat after start; an old process may still hold work"

    state_put "deploy-disabled:${EXPECTED_SHA}"
    log "deploy-disabled OK"
    ;;

  enable)
    require_state "deploy-disabled:${EXPECTED_SHA}"
    refuse_repeat "enable:${EXPECTED_SHA}"

    log "Updating ONLY the managed lane keys in the preserved env file"
    run_in_pinned_image node --import tsx scripts/global-sync-rollout.ts enable \
      || die "enable refused; nothing was changed"

    # The file changed. The RUNTIME has not: web and worker read their
    # environment at container creation. This recreate is the runtime change,
    # and it is not atomic — the two containers come up one after the other.
    log "Recreating web and worker from that same configuration"
    APP_IMAGE_TAG="${EXPECTED_SHA}" APP_BUILD_ID="${EXPECTED_SHA}" \
      docker compose up -d --force-recreate web worker

    curl -fsS http://127.0.0.1:3000/api/healthz >/dev/null || die "/healthz did not answer after recreate"
    for service in web worker; do
      id="$(docker compose ps -q "${service}")"
      docker exec "${id}" sh -c 'test "${ADSECUTE_SYNC_GLOBAL_ENABLED:-}" = "enabled"' \
        || die "${service} did not pick up the master switch; the recreate did not take effect"
      docker exec "${id}" sh -c 'test -z "${ADSECUTE_SYNC_LANE_RETENTION_ENABLED:-}"' \
        || die "${service} has retention enabled; retention must stay off"
      log "${service} master switch active, retention off"
    done

    docker compose up -d autoheal
    state_put "enable:${EXPECTED_SHA}"
    log "enable OK — the external scheduler is still OFF"
    ;;

  resume-scheduler)
    require_state "enable:${EXPECTED_SHA}"
    log "Both processes are proven; re-enabling the external scheduler last"
    systemctl enable --now "${SCHEDULER_UNIT}"
    systemctl is-active --quiet "${SCHEDULER_UNIT}" || die "${SCHEDULER_UNIT} did not start"
    state_put "resume-scheduler:${EXPECTED_SHA}"
    log "resume-scheduler OK"
    ;;

  emergency-disable)
    # Stopping must always be available, including when the database is
    # unreachable and when no state file exists. It reports success only after
    # LIVE state is confirmed stopped — "the command returned 0" is not the same
    # as "nothing is running".
    log "EMERGENCY: disabling scheduler and stopping autoheal, web, worker"
    systemctl disable --now "${SCHEDULER_UNIT}" 2>/dev/null || true
    docker compose stop autoheal || true
    docker compose stop web worker || true
    failed=0
    for service in autoheal web worker; do
      observed="$(container_state "${service}")"
      log "${service}=${observed}"
      case "${observed}" in
        absent | exited | created) ;;
        *) failed=1 ;;
      esac
    done
    if systemctl is-active --quiet "${SCHEDULER_UNIT}" 2>/dev/null; then
      log "${SCHEDULER_UNIT}=active"
      failed=1
    fi
    [ "${failed}" = "0" ] || die "emergency disable did NOT fully take effect; intervene by hand"
    state_put "emergency-disable"
    log "emergency-disable CONFIRMED stopped"
    ;;

  *)
    die "unknown phase '${PHASE}'"
    ;;
esac
