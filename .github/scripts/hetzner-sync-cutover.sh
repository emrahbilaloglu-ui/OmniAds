#!/usr/bin/env bash
set -euo pipefail

# Host-side global sync cutover.
#
# WHY THIS EXISTS
#
# `scripts/global-sync-rollout.ts` is TypeScript run through npm. The app host
# has psql-less docker and docker compose and no Node, no npm, no node_modules —
# so `npm run rollout:enable` cannot run there. Everything below uses what the
# hosts actually have and reaches the repository's TypeScript by executing it
# inside the already-pinned worker image.
#
# TWO HOSTS
#
# The application and PostgreSQL are on SEPARATE hosts. The app host has the
# Compose project and no local PostgreSQL socket; the DB host has PostgreSQL and
# no Compose project. Assuming both live together is how a cutover script fails
# on its first real run. Every database operation therefore goes through
# `db_sql`, which uses `SYNC_CUTOVER_DB_SSH` when set and falls back to a local
# psql only for single-host development.
#
# PHASE GRAPH
#
# The previous version could not reach migration: its preflight ran the
# post-migration schema contract, which by definition fails before the migration
# has run. Preflight is now OLD-SCHEMA SAFE — it checks images, the env file, the
# backup manifest, the scheduler and database identity, none of which depend on
# the new schema — and the contract verification is its own phase AFTER migrate.
#
# WHAT IT IS NOT
#
# It is not atomic. Writing the env file atomically makes the FILE change atomic;
# it does not make the RUNTIME change atomic, because web and worker read their
# environment when the container is created. The cutover is built around both
# new-build processes already deployed and disabled, physical quiescence for the
# migration, a single preserved env configuration, controlled recreation from
# that same configuration, and readback of what the containers actually got.
#
#   ./hetzner-sync-cutover.sh <phase>
#
# Phases, in order:
#   preflight         old-schema safe; images, env source, backup, scheduler, DB
#   quiesce           stop the real scheduler, autoheal, web, worker; prove drain
#   fingerprint-pre   DB identity, raw counts, hash of the full selected set
#   migrate           run migrations from the pinned image
#   verify-contract   POST-migration schema contract (needs the new schema)
#   fingerprint-post  compare against the pre-migration fingerprint
#   deploy-disabled   both processes on the new build with every lane off
#   enable            update the preserved env, recreate both, verify
#   resume-scheduler  re-enable the real scheduler, last
#   emergency-disable stop live runtime and scheduler; confirm the state
#   status            print the state file and live state

PHASE="${1:-status}"
APP_DIR="${REMOTE_APP_DIR:-/var/www/adsecute}"
ENV_FILE="${APP_DIR}/.env.production"
STATE_DIR="${SYNC_CUTOVER_STATE_DIR:-/var/lib/adsecute-cutover}"
STATE_FILE="${STATE_DIR}/state"
# Immutable image ids resolved once at preflight. Tags are mutable; a rebuild
# under the same SHA tag between phases would otherwise be deployed silently.
IMAGE_PIN_FILE="${STATE_DIR}/image-pin"
LOCK_FILE="${STATE_DIR}/lock"
BACKUP_MANIFEST="${SYNC_CUTOVER_BACKUP_MANIFEST:-/var/backups/adsecute-postgres/verified-restore.manifest}"
DRAIN_SECONDS="${SYNC_CUTOVER_DRAIN_SECONDS:-90}"
DB_NAME="${DB_NAME:-adsecute_prod}"

# The DB host. Empty means "PostgreSQL is reachable locally", which is only true
# in development.
DB_SSH="${SYNC_CUTOVER_DB_SSH:-}"

# How the external trigger is actually run. Declared rather than assumed: the
# previous version accepted a missing systemd unit during quiesce and then
# REQUIRED that same unit to exist when resuming, so a deployment using cron or
# a container scheduler would quiesce "successfully" and then fail to resume.
#   systemd:<unit>     systemctl enable/disable --now
#   cron:<file>        a crontab fragment moved aside and back
#   compose:<service>  a Compose service stopped and started
#   none               explicitly no external scheduler
SCHEDULER_SPEC="${SYNC_CUTOVER_SCHEDULER:-}"

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
# Retagging between phases must refuse. A tag is mutable; the image id is not.
assert_image_pin() {
  local pinned_web pinned_worker web_digest worker_digest
  [ -s "${IMAGE_PIN_FILE}" ] || die "no image pin recorded; run preflight first"
  read -r pinned_web pinned_worker < "${IMAGE_PIN_FILE}"
  web_digest="$(docker image inspect "${EXPECTED_WEB_IMAGE}" --format '{{.Id}}' 2>/dev/null || true)"
  worker_digest="$(docker image inspect "${EXPECTED_WORKER_IMAGE}" --format '{{.Id}}' 2>/dev/null || true)"
  [ "${web_digest}" = "${pinned_web}" ] \
    || die "the web image tag now resolves to ${web_digest}, not the pinned ${pinned_web}; it was retagged mid-cutover"
  [ "${worker_digest}" = "${pinned_worker}" ] \
    || die "the worker image tag now resolves to ${worker_digest}, not the pinned ${pinned_worker}; it was retagged mid-cutover"
}

require_state() {
  state_has "$1" || die "phase '$1' has not completed; run it first"
}

require_sha() {
  [ -n "${EXPECTED_SHA}" ] || die "DEPLOY_SHA is required and must be the exact commit being cut over to"
  case "${EXPECTED_SHA}" in
    *[!0-9a-f]* | "") die "DEPLOY_SHA must be a lowercase hex commit sha" ;;
  esac
}

# ── Two-host primitives ────────────────────────────────────────────────────

# Run SQL on the DATABASE host. Never assumes a local socket.
db_sql() {
  local statement="$1"
  if [ -n "${DB_SSH}" ]; then
    ssh -o BatchMode=yes -o ConnectTimeout=10 "${DB_SSH}" \
      "runuser -u postgres -- psql --dbname=$(printf %q "${DB_NAME}") -v ON_ERROR_STOP=1 --tuples-only --no-align --command=$(printf %q "${statement}")"
  else
    runuser -u postgres -- psql --dbname="${DB_NAME}" -v ON_ERROR_STOP=1 \
      --tuples-only --no-align --command="${statement}"
  fi
}

# Run a command on the DATABASE host.
db_run() {
  if [ -n "${DB_SSH}" ]; then
    ssh -o BatchMode=yes -o ConnectTimeout=10 "${DB_SSH}" "$@"
  else
    "$@"
  fi
}

# ── Scheduler control, for whatever the scheduler actually is ──────────────

resolve_scheduler() {
  if [ -n "${SCHEDULER_SPEC}" ]; then
    printf '%s' "${SCHEDULER_SPEC}"
    return 0
  fi
  # Detect, in order of how this deployment is most likely to be wired.
  if command -v systemctl >/dev/null 2>&1 &&
     systemctl list-unit-files 2>/dev/null | grep -q '^adsecute-sync-cron.timer'; then
    printf 'systemd:adsecute-sync-cron.timer'
    return 0
  fi
  if [ -f /etc/cron.d/adsecute-sync ]; then
    printf 'cron:/etc/cron.d/adsecute-sync'
    return 0
  fi
  if docker compose ps --services 2>/dev/null | grep -qx scheduler; then
    printf 'compose:scheduler'
    return 0
  fi
  printf 'unresolved'
}

scheduler_stop() {
  local spec="$1"
  case "${spec}" in
    systemd:*) systemctl disable --now "${spec#systemd:}" ;;
    cron:*) mv "${spec#cron:}" "${spec#cron:}.cutover-disabled" ;;
    compose:*) docker compose stop "${spec#compose:}" ;;
    none) log "scheduler=none (declared); nothing to stop" ;;
    *) die "cannot stop scheduler: '${spec}' is not a supported spec. Set SYNC_CUTOVER_SCHEDULER explicitly." ;;
  esac
}

scheduler_start() {
  local spec="$1"
  case "${spec}" in
    systemd:*) systemctl enable --now "${spec#systemd:}" ;;
    cron:*) mv "${spec#cron:}.cutover-disabled" "${spec#cron:}" ;;
    compose:*) docker compose up -d "${spec#compose:}" ;;
    none) log "scheduler=none (declared); nothing to start" ;;
    *) die "cannot start scheduler: '${spec}' is not a supported spec" ;;
  esac
}

# Prints "running" or "stopped". Never guesses: an unsupported spec is fatal.
scheduler_state() {
  local spec="$1"
  case "${spec}" in
    systemd:*)
      if systemctl is-active --quiet "${spec#systemd:}" 2>/dev/null; then
        printf 'running'
      else
        printf 'stopped'
      fi
      ;;
    cron:*)
      if [ -f "${spec#cron:}" ]; then printf 'running'; else printf 'stopped'; fi
      ;;
    compose:*)
      case "$(container_state "${spec#compose:}")" in
        running) printf 'running' ;;
        *) printf 'stopped' ;;
      esac
      ;;
    none) printf 'stopped' ;;
    *) printf 'unknown' ;;
  esac
}

# ── App-host primitives ────────────────────────────────────────────────────

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
  # The FULL identity set, not a count. A count still matches after one selected
  # account is swapped for another; this does not.
  #
  # OLD-SCHEMA SAFE. `is_selected` is added BY the migration this cutover runs,
  # so before it exists the query would fail and the pre-fingerprint could never
  # be taken — the deadlock this phase graph exists to avoid. Before the column
  # exists, the pre-model semantics are that every identity binding IS selected,
  # so that is what gets hashed. After the migration, the backfilled selected set
  # must reproduce exactly the same digest.
  db_sql "
    SELECT COALESCE(encode(digest(string_agg(identity, E'\n' ORDER BY identity), 'sha256'), 'hex'), 'empty')
    FROM (
      SELECT bpa.business_id || '|' || bpa.provider || '|' || bpa.provider_account_id AS identity
      FROM business_provider_accounts bpa
      WHERE CASE
              WHEN EXISTS (
                SELECT 1 FROM information_schema.columns
                WHERE table_schema = current_schema()
                  AND table_name = 'business_provider_accounts'
                  AND column_name = 'is_selected'
              )
              -- Post-migration: the real selected set.
              THEN COALESCE((to_jsonb(bpa) ->> 'is_selected')::boolean, FALSE)
              -- Pre-migration: every identity binding was in effect selected.
              ELSE TRUE
            END
    ) rows;
  " | tr -d '[:space:]'
}

# ── F4: physical and logical capacity, from the DB host itself ─────────────
#
# Migration is the single most disk-consuming step of the cutover: it backfills
# provider_scope across a multi-gigabyte relation and builds three indexes
# concurrently. Waiting for the post-migration TypeScript verification to notice
# a full disk is waiting until after the damage.
#
# `df` is read on the DB host for the EXACT PostgreSQL data directory, not for
# `/`, because they are routinely different filesystems.
db_free_bytes() {
  local data_dir
  data_dir="$(db_sql "SHOW data_directory;" | tr -d '[:space:]')"
  [ -n "${data_dir}" ] || return 1
  # POSIX df reports 1K blocks in field 4 of the second line.
  db_run "df -Pk $(printf %q "${data_dir}") | awk 'NR==2 {print \$4 * 1024}'" |
    tr -d '[:space:]'
}

db_logical_bytes() {
  db_sql "SELECT pg_database_size(current_database())::text;" | tr -d '[:space:]'
}

assert_capacity_for_migration() {
  local free logical required
  free="$(db_free_bytes || true)"
  logical="$(db_logical_bytes || true)"
  case "${free}" in
    "" | *[!0-9]*) die "could not read free space on the database host's PostgreSQL data directory; refusing to migrate blind" ;;
  esac
  case "${logical}" in
    "" | *[!0-9]*) die "could not read the logical size of ${DB_NAME}; refusing to migrate blind" ;;
  esac
  # The backfill rewrites matched rows and the concurrent index builds need room
  # for the new relations plus WAL. Half the database again, with a 5 GiB floor,
  # is the smallest defensible headroom.
  required=$(( logical / 2 ))
  if [ "${required}" -lt 5368709120 ]; then required=5368709120; fi
  log "db free=${free}B logical=${logical}B required=${required}B"
  [ "${free}" -ge "${required}" ]     || die "insufficient free space on the database host: ${free}B free, ${required}B required for a ${logical}B database"
}

# ── F5: the fingerprint host and the runtime must be the same database ─────
#
# `db_sql` reaches the database through SYNC_CUTOVER_DB_SSH/DB_NAME; the app
# reaches it through DATABASE_URL in .env.production. Nothing proved those were
# the same system. A cutover could fingerprint one database, migrate it, and
# leave the runtime pointed at another.
assert_runtime_database_matches() {
  local runtime_identity control_identity
  control_identity="$(db_identity)"
  [ -n "${control_identity}" ] || die "could not read the control-path database identity"
  runtime_identity="$(
    docker run --rm --network host --env-file "${ENV_FILE}" \
      --entrypoint /bin/sh "${EXPECTED_WEB_IMAGE}" -c '
        node -e "
          const { Client } = require(\"pg\");
          const client = new Client({ connectionString: process.env.DATABASE_URL });
          client.connect()
            .then(() => client.query(\"SELECT current_database() || chr(124) || system_identifier::text AS id FROM pg_control_system()\"))
            .then((r) => { process.stdout.write(r.rows[0].id); return client.end(); })
            .catch((e) => { process.stderr.write(String(e && e.message)); process.exit(1); });
        "' 2>/dev/null | tr -d '[:space:]'
  )"
  [ -n "${runtime_identity}" ] \
    || die "could not read the database identity through the runtime's DATABASE_URL"
  [ "${runtime_identity}" = "${control_identity}" ] \
    || die "the cutover control path (${control_identity}) and the runtime DATABASE_URL (${runtime_identity}) point at DIFFERENT databases"
  log "runtime and control path agree: ${control_identity}"
}

db_identity() {
  db_sql "SELECT current_database() || '|' || system_identifier::text FROM pg_control_system();" |
    tr -d '[:space:]'
}

raw_counts() {
  db_sql "
    SELECT (SELECT count(*) FROM meta_raw_snapshots)::text || '|' ||
           (SELECT count(*) FROM shopify_raw_snapshots)::text || '|' ||
           (SELECT count(*) FROM business_provider_accounts)::text;
  " | tr -d '[:space:]'
}

cd "${APP_DIR}"

exec 9>"${LOCK_FILE}"
flock -n 9 || die "another cutover is in progress (${LOCK_FILE})"

SCHEDULER="$(resolve_scheduler)"

case "${PHASE}" in
  status)
    printf 'state file: %s\n' "${STATE_FILE}"
    cat "${STATE_FILE}"
    printf 'scheduler=%s state=%s\n' "${SCHEDULER}" "$(scheduler_state "${SCHEDULER}")"
    for service in web worker autoheal; do
      printf '%s=%s\n' "${service}" "$(container_state "${service}")"
    done
    ;;

  preflight)
    # OLD-SCHEMA SAFE. Nothing here may depend on the migration having run —
    # that was the phase-graph deadlock: preflight required post-migration
    # objects, and migrate required preflight.
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

    log "Resolving the external scheduler"
    [ "${SCHEDULER}" != "unresolved" ] \
      || die "could not determine how the external scheduler runs. Set SYNC_CUTOVER_SCHEDULER to systemd:<unit>, cron:<file>, compose:<service>, or none."
    log "scheduler=${SCHEDULER} state=$(scheduler_state "${SCHEDULER}")"

    log "Requiring a VERIFIED backup manifest on the DB host"
    db_run test -s "${BACKUP_MANIFEST}" \
      || die "missing or empty ${BACKUP_MANIFEST} on the database host"
    db_run grep -q "scratch_restore_verified=yes" "${BACKUP_MANIFEST}" \
      || die "${BACKUP_MANIFEST} does not record a completed scratch restore; a backup nobody restored is not a rollback plan"

    log "Reaching the database host"
    identity="$(db_identity)"
    [ -n "${identity}" ] || die "could not read database identity from the DB host"
    log "database=${identity}"

    log "Proving the runtime's DATABASE_URL is the SAME database"
    assert_runtime_database_matches

    log "Proving there is room to migrate"
    assert_capacity_for_migration

    log "Pinning image digests"
    web_digest="$(docker image inspect "${EXPECTED_WEB_IMAGE}" --format '{{.Id}}')"
    worker_digest="$(docker image inspect "${EXPECTED_WORKER_IMAGE}" --format '{{.Id}}')"
    [ -n "${web_digest}" ] && [ -n "${worker_digest}" ] \
      || die "could not resolve immutable image ids for ${EXPECTED_SHA}"
    printf '%s %s\n' "${web_digest}" "${worker_digest}" > "${IMAGE_PIN_FILE}"
    log "web=${web_digest} worker=${worker_digest}"

    state_put "preflight:${EXPECTED_SHA}"
    log "preflight OK"
    ;;

  quiesce)
    require_sha
    require_state "preflight:${EXPECTED_SHA}"
    log "Stopping the external scheduler (${SCHEDULER}) BEFORE anything else"
    scheduler_stop "${SCHEDULER}"
    observed="$(scheduler_state "${SCHEDULER}")"
    [ "${observed}" = "stopped" ] \
      || die "scheduler is still '${observed}'; an external trigger would restart work mid-migration"

    # autoheal FIRST: it restarts unhealthy containers, so stopping the worker
    # while autoheal runs is how a "stopped" worker comes back by itself.
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
    [ "$(scheduler_state "${SCHEDULER}")" = "stopped" ] \
      || die "the scheduler restarted during the drain window"

    leases="$(db_sql "
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
    assert_image_pin
    log "Re-proving capacity immediately before the disk-consuming step"
    assert_capacity_for_migration
    log "Running migrations from the pinned image against the DB host"
    APP_IMAGE_TAG="${EXPECTED_SHA}" APP_BUILD_ID="${EXPECTED_SHA}" \
      docker compose up --no-deps --abort-on-container-exit --exit-code-from migrate migrate \
      || die "migrations failed; completion was not announced and nothing was enabled"
    docker compose rm -f migrate >/dev/null 2>&1 || true
    state_put "migrate:${EXPECTED_SHA}"
    log "migrate OK"
    ;;

  verify-contract)
    # POST-migration. This is what preflight used to run, which is why the graph
    # could never reach migration.
    require_state "migrate:${EXPECTED_SHA}"
    log "Verifying the post-migration schema contract from the pinned image"
    run_in_pinned_image node --import tsx scripts/global-sync-rollout.ts preflight \
      || die "the post-migration contract refused; do not continue"
    state_put "verify-contract:${EXPECTED_SHA}"
    log "verify-contract OK"
    ;;

  fingerprint-post)
    require_state "verify-contract:${EXPECTED_SHA}"
    {
      printf 'identity=%s\n' "$(db_identity)"
      printf 'counts=%s\n' "$(raw_counts)"
      printf 'selected_hash=%s\n' "$(selected_binding_hash)"
    } > "${STATE_DIR}/fingerprint-post"
    chmod 0600 "${STATE_DIR}/fingerprint-post"
    # The migration is expand-only. Identity, row counts and the FULL selected
    # binding identity set must be byte-identical.
    if ! diff -u "${STATE_DIR}/fingerprint-pre" "${STATE_DIR}/fingerprint-post"; then
      die "the migration changed identity, row counts or the selected-binding set. Do not enable. Restore from the verified backup."
    fi
    state_put "fingerprint-post:${EXPECTED_SHA}"
    log "fingerprint-post OK — identical"
    ;;

  deploy-disabled)
    require_state "fingerprint-post:${EXPECTED_SHA}"
    assert_image_pin
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

    # Effective CONTAINER environment, not the file. Key names and a yes/no
    # only — never a value.
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
    assert_image_pin
    log "Updating ONLY the managed lane keys in the preserved env file"
    run_in_pinned_image node --import tsx scripts/global-sync-rollout.ts enable \
      || die "enable refused; nothing was changed"

    # The file changed. The RUNTIME has not: both processes read their
    # environment at container creation. This recreate is the runtime change,
    # and it is not atomic either — the containers come up one after the other.
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
    log "enable OK — the external scheduler is still stopped"
    ;;

  resume-scheduler)
    require_state "enable:${EXPECTED_SHA}"
    log "Both processes are proven; restarting the scheduler (${SCHEDULER}) last"
    scheduler_start "${SCHEDULER}"
    observed="$(scheduler_state "${SCHEDULER}")"
    [ "${observed}" = "running" ] || die "scheduler is '${observed}' after start"
    state_put "resume-scheduler:${EXPECTED_SHA}"
    log "resume-scheduler OK"
    ;;

  emergency-disable)
    # Always available: no state file, no DEPLOY_SHA, no database. Reports
    # success only after LIVE state is confirmed stopped — "the command returned
    # 0" is not the same as "nothing is running".
    log "EMERGENCY: stopping scheduler (${SCHEDULER}), autoheal, web, worker"
    scheduler_stop "${SCHEDULER}" || true
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
    scheduler_observed="$(scheduler_state "${SCHEDULER}")"
    log "scheduler=${SCHEDULER} state=${scheduler_observed}"
    [ "${scheduler_observed}" = "stopped" ] || failed=1
    [ "${failed}" = "0" ] || die "emergency disable did NOT fully take effect; intervene by hand"
    state_put "emergency-disable"
    log "emergency-disable CONFIRMED stopped"
    ;;

  *)
    die "unknown phase '${PHASE}'"
    ;;
esac
