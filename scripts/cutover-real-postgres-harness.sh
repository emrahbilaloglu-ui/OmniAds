#!/usr/bin/env bash
set -euo pipefail

# EXECUTION proof for scripts/hetzner-sync-cutover.sh, against a REAL
# PostgreSQL and a realistic split-host command surface.
#
# WHY THIS REPLACED THE STUB HARNESS
#
# The previous harness answered every database question with a canned string:
# `*string_agg*` printed `abc123`, `*meta_raw_snapshots*` printed `10|20|30`,
# `*lease_owner*` printed whatever STUB_LEASES said. That can prove the phase
# graph is traversable and nothing else. It cannot prove the fingerprint SQL
# parses, that the old-schema-conditional selection predicate works before
# `is_selected` exists and still reproduces the same digest after the migration
# adds it, that a full pg_dump can actually be restored into a scratch database,
# that quiescence sees a live application backend, or that a hash query is even
# valid SQL — and every one of those is a way the cutover fails on its first real
# run while a canned harness reports PASS.
#
# So this harness starts a real PostgreSQL (initdb/pg_ctl on a free non-5432
# port, trust auth, a temporary data directory, always torn down), seeds a
# pre-migration schema, and runs the real wrapper against it.
#
# THE SPLIT IS REAL TOO
#
# The app host sandbox has docker/curl/crontab/systemctl stubs and deliberately
# has NO psql: `psql` and `runuser` there are traps that log and exit 127, and
# the harness fails if either is ever touched. Every database statement has to
# reach the database through the ssh shim, which is the only thing with the
# PostgreSQL binaries on its PATH — the same shape as production, where the
# application and the database are on separate machines.
#
# WHAT IS EXERCISED
#
#   P  every phase, in order, against the real database:
#      preflight, quiesce, fingerprint-pre, migrate, verify-contract,
#      fingerprint-post, deploy-disabled, enable, resume-scheduler,
#      failure rollback, emergency-disable
#   N  negative controls: low capacity, wrong database, stale/foreign backup
#      manifest, a retagged image, root crontab preservation, a stale state
#      record, a partial recreate failure, an unproven scheduler=none, a
#      tampered wrapper, and a live application backend during quiesce

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WRAPPER="${REPO_ROOT}/scripts/hetzner-sync-cutover.sh"
LABEL="[cutover-real-harness]"
FAILURES=0

HARNESS_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/adsecute-cutover-harness.XXXXXX")"
PGDATA_DIR="${HARNESS_ROOT}/pgdata"
PGLOG="${HARNESS_ROOT}/postgres.log"
DBHOST_BIN="${HARNESS_ROOT}/dbhost-bin"
APPHOST_BACKUPS="${HARNESS_ROOT}/dbhost-backups"
PG_STARTED=0
DB_NAME="adsecute_prod"
DEPLOY_SHA="${DEPLOY_SHA:-a1b2c3d4e5f60718293a4b5c6d7e8f9012345678}"

pass() { printf '%s PASS %s\n' "${LABEL}" "$1"; }
fail() { printf '%s FAIL %s\n' "${LABEL}" "$1" >&2; FAILURES=$((FAILURES + 1)); }

cleanup() {
  if [ "${PG_STARTED}" = "1" ]; then
    "${PGBIN}/pg_ctl" -D "${PGDATA_DIR}" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "${HARNESS_ROOT}"
}
trap cleanup EXIT

# ── A real PostgreSQL, on a port that cannot be a developer's own ──────────

find_pg_bin() {
  local candidate
  local -a candidates=()
  [ -n "${EPHEMERAL_PG_BIN_DIR:-}" ] && candidates+=("${EPHEMERAL_PG_BIN_DIR}")
  candidates+=("/opt/homebrew/opt/postgresql@16/bin" "/opt/homebrew/bin" "/usr/local/opt/postgresql@16/bin")
  if [ -d /usr/lib/postgresql ]; then
    for candidate in /usr/lib/postgresql/*/bin; do
      [ -d "${candidate}" ] && candidates+=("${candidate}")
    done
  fi
  local IFS=:
  for candidate in ${PATH}; do candidates+=("${candidate}"); done
  unset IFS
  for candidate in "${candidates[@]}"; do
    if [ -x "${candidate}/initdb" ] && [ -x "${candidate}/pg_ctl" ] &&
       [ -x "${candidate}/createdb" ] && [ -x "${candidate}/psql" ] &&
       [ -x "${candidate}/pg_dump" ] && [ -x "${candidate}/pg_restore" ]; then
      printf '%s' "${candidate}"
      return 0
    fi
  done
  return 1
}

PGBIN="$(find_pg_bin)" || {
  printf '%s FAIL PostgreSQL binaries (initdb/pg_ctl/createdb/psql/pg_dump/pg_restore) were not found; this harness cannot run without a real database\n' "${LABEL}" >&2
  exit 1
}

free_port() {
  # 5432 and 15432 are where a developer's own PostgreSQL lives. Binding one of
  # them would make this harness destroy real data instead of testing anything.
  local port
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    port="$(python3 -c 'import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()')"
    case "${port}" in 5432 | 15432) continue ;; esac
    printf '%s' "${port}"
    return 0
  done
  return 1
}

PGPORT="$(free_port)" || { printf '%s FAIL no safe port\n' "${LABEL}" >&2; exit 1; }

# macOS resolves a locale-dependent LC_ALL through a threaded system library, and
# a postmaster that becomes multithreaded during startup aborts with "postmaster
# became multithreaded during startup". Pinning C is what the repository's other
# ephemeral-PostgreSQL seams do for the same reason.
export LC_ALL=C

"${PGBIN}/initdb" -D "${PGDATA_DIR}" -U postgres --auth=trust --no-locale >/dev/null 2>&1 \
  || { printf '%s FAIL initdb failed\n' "${LABEL}" >&2; exit 1; }
"${PGBIN}/pg_ctl" -D "${PGDATA_DIR}" -l "${PGLOG}" -w \
  -o "-p ${PGPORT} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off" \
  start >/dev/null 2>&1 \
  || { printf '%s FAIL pg_ctl start failed\n' "${LABEL}" >&2; cat "${PGLOG}" >&2 || true; exit 1; }
PG_STARTED=1
"${PGBIN}/createdb" -h 127.0.0.1 -p "${PGPORT}" -U postgres "${DB_NAME}" >/dev/null 2>&1 \
  || { printf '%s FAIL createdb failed\n' "${LABEL}" >&2; exit 1; }

psql_on() {
  local database="$1"
  shift
  "${PGBIN}/psql" -h 127.0.0.1 -p "${PGPORT}" -U postgres --dbname="${database}" \
    -v ON_ERROR_STOP=1 --tuples-only --no-align "$@"
}

psql_direct() { psql_on "${DB_NAME}" "$@"; }

# The PRE-migration schema. `business_provider_accounts` deliberately has no
# `is_selected` column: that column is what the migration under test adds, and
# the pre-fingerprint has to be takeable without it.
#
# Each scenario that has to traverse the whole graph gets its OWN database,
# because the migration is idempotent: replaying it against an already-migrated
# database advances nothing, and fingerprint-post would then correctly refuse a
# release whose schema did not move.
seed_database() {
  local database="$1"
  if [ "${database}" != "${DB_NAME}" ]; then
    "${PGBIN}/createdb" -h 127.0.0.1 -p "${PGPORT}" -U postgres "${database}" >/dev/null 2>&1 \
      || { printf '%s FAIL createdb %s failed\n' "${LABEL}" "${database}" >&2; exit 1; }
  fi
  psql_on "${database}" --quiet --command "
  CREATE TABLE business_provider_accounts (
    id serial PRIMARY KEY,
    business_id text NOT NULL,
    provider text NOT NULL,
    provider_account_id text NOT NULL,
    position integer,
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE provider_connections (
    id serial PRIMARY KEY, business_id text NOT NULL, provider text NOT NULL,
    status text, provider_account_id text, updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE integration_credentials (
    id serial PRIMARY KEY, provider_connection_id integer NOT NULL,
    access_token text, refresh_token text, updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE provider_account_assignments (
    id serial PRIMARY KEY, business_id text NOT NULL, provider text NOT NULL,
    account_ids text[] NOT NULL DEFAULT '{}'
  );
  CREATE TABLE provider_accounts (id serial PRIMARY KEY, provider text, external_id text);
  CREATE TABLE meta_raw_snapshots (id serial PRIMARY KEY, payload jsonb NOT NULL DEFAULT '{}');
  CREATE TABLE shopify_raw_snapshots (id serial PRIMARY KEY, payload jsonb NOT NULL DEFAULT '{}');
  CREATE TABLE google_ads_raw_snapshots (id serial PRIMARY KEY, payload jsonb NOT NULL DEFAULT '{}');
  CREATE TABLE meta_config_snapshots (id serial PRIMARY KEY, payload jsonb NOT NULL DEFAULT '{}');
  CREATE TABLE meta_sync_state (id serial PRIMARY KEY, cursor text);
  CREATE TABLE google_ads_sync_state (id serial PRIMARY KEY, cursor text);
  CREATE TABLE shopify_sync_state (id serial PRIMARY KEY, cursor text);
  CREATE TABLE sync_release_gates (id serial PRIMARY KEY, build_id text, mode text);
  CREATE TABLE sync_runtime_instances (id serial PRIMARY KEY, instance text);
  CREATE TABLE sync_worker_heartbeats (id serial PRIMARY KEY, worker text, beat_at timestamptz NOT NULL DEFAULT now());

  INSERT INTO business_provider_accounts (business_id, provider, provider_account_id, position)
  VALUES ('biz-1', 'meta', 'act_1001', 0), ('biz-1', 'meta', 'act_1002', 1),
         ('biz-1', 'google_ads', '111-222-3333', 0), ('biz-2', 'shopify', 'shop-9', 0);
  INSERT INTO provider_connections (business_id, provider, status, provider_account_id)
  VALUES ('biz-1', 'meta', 'connected', 'act_1001'), ('biz-2', 'shopify', 'connected', 'shop-9');
  INSERT INTO integration_credentials (provider_connection_id, access_token, refresh_token)
  -- Mirrors the production mix the credential census has to reason about: one
  -- row whose secrets are ALREADY ciphertext and must come through the migration
  -- byte-identical, and one still-plaintext row that the encryption migration is
  -- expected to convert. A fixture where everything is already encrypted cannot
  -- exercise the conversion at all, which is how a contract that forbids the
  -- intended conversion reached production green.
  VALUES (1, 'enc:v1:bWV0YS1hY2Nlc3M', 'enc:v1:bWV0YS1yZWZyZXNo'),
         (2, 'shopify-access-token-value', NULL);
  INSERT INTO provider_account_assignments (business_id, provider, account_ids)
  VALUES ('biz-1', 'meta', ARRAY['act_1001','act_1002']);
  INSERT INTO meta_raw_snapshots (payload) SELECT '{}'::jsonb FROM generate_series(1, 12);
  INSERT INTO shopify_raw_snapshots (payload) SELECT '{}'::jsonb FROM generate_series(1, 5);
  INSERT INTO google_ads_raw_snapshots (payload) SELECT '{}'::jsonb FROM generate_series(1, 3);
  INSERT INTO sync_release_gates (build_id, mode) VALUES ('older-build', 'observe');
" >/dev/null
}

seed_database "${DB_NAME}"

# ── The DB host: the only place with PostgreSQL binaries ───────────────────

mkdir -p "${DBHOST_BIN}" "${APPHOST_BACKUPS}"

for tool in psql pg_dump pg_restore createdb dropdb; do
  cat > "${DBHOST_BIN}/${tool}" <<STUB
#!/usr/bin/env bash
exec "${PGBIN}/${tool}" -h 127.0.0.1 -p ${PGPORT} -U postgres "\$@"
STUB
done

# The real DB host runs everything as the postgres system user. Reproducing that
# indirection matters because the wrapper's commands are built around it, and a
# quoting mistake in `runuser -u postgres -- ...` would only ever show up here.
cat > "${DBHOST_BIN}/runuser" <<'STUB'
#!/usr/bin/env bash
while [ $# -gt 0 ]; do
  case "$1" in
    -u) shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done
exec "$@"
STUB

# `df` is real unless a negative control needs the database host to look full.
cat > "${DBHOST_BIN}/df" <<'STUB'
#!/usr/bin/env bash
if [ -n "${HARNESS_DF_FREE_KB:-}" ]; then
  printf 'Filesystem 1024-blocks Used Available Capacity Mounted-on\n'
  printf 'harness 100000000 0 %s 1%% /\n' "${HARNESS_DF_FREE_KB}"
  exit 0
fi
exec /bin/df "$@"
STUB

# systemd on the DATABASE host. Production has adsecute-db-healthcheck.timer
# here, firing every 15 minutes and writing system_capacity_snapshots as the
# postgres user — a writer with no application name, which the app-side
# quiescence checks cannot see. Without a stub this simply does not exist on a
# developer machine and the guard is untestable.
cat > "${DBHOST_BIN}/systemctl" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  list-timers)
    [ -n "${HARNESS_DBHOST_TIMER:-}" ] || exit 0
    printf 'Mon 2026-07-27 13:19:48 UTC 9min Mon 2026-07-27 13:04:48 UTC 5min ago %s %s\n' \
      "${HARNESS_DBHOST_TIMER}" "${HARNESS_DBHOST_TIMER%.timer}.service"
    exit 0 ;;
  is-active)
    if [ "$2" = "${HARNESS_DBHOST_TIMER:-}" ] && [ "${HARNESS_DBHOST_TIMER_ACTIVE:-1}" = "1" ]; then
      printf 'active\n'
    else
      printf 'inactive\n'
    fi
    exit 0 ;;
esac
exit 0
STUB

chmod +x "${DBHOST_BIN}/"*

DBHOST_PATH="${DBHOST_BIN}:/usr/bin:/bin:/usr/sbin:/sbin"

# ── The app host sandbox ───────────────────────────────────────────────────

new_host() {
  local host="${HARNESS_ROOT}/$1"
  rm -rf "${host}"
  mkdir -p "${host}/bin" "${host}/app" "${host}/state" "${host}/log" "${host}/cutover" "${host}/runtime"

  cat > "${host}/app/docker-compose.yml" <<'YAML'
services:
  web:
    env_file:
      - .env.production
  worker:
    env_file:
      - .env.production
    environment:
      SYNC_WORKER_STAGING_IDLE: ${SYNC_WORKER_STAGING_IDLE:-}
  migrate:
    env_file:
      - .env.production
YAML

  cat > "${host}/app/.env.production" <<ENVFILE
DATABASE_URL=postgresql://postgres@127.0.0.1:${PGPORT}/${DB_NAME}
NEXTAUTH_SECRET=unrelated-value
CRON_SECRET=unrelated-cron-secret
ENVFILE

  # A production root crontab: the managed Sync/AI block sits between unrelated
  # entries that a cutover must not disturb.
  cat > "${host}/state/crontab" <<'CRONTAB'
MAILTO=ops@example.invalid
*/1 * * * * /usr/local/bin/healthz-probe
# BEGIN adsecute-sync
*/5 * * * * /usr/local/bin/adsecute-sync-tick
0 3 * * * /usr/local/bin/adsecute-ai-nightly
# END adsecute-sync
0 4 * * * /usr/local/bin/unrelated-backup
@reboot /usr/local/bin/unrelated-boot-task
CRONTAB
  cp "${host}/state/crontab" "${host}/state/crontab.original"

  printf 'running\n' > "${host}/runtime/state.web"
  printf 'running\n' > "${host}/runtime/state.worker"
  printf 'running\n' > "${host}/runtime/state.autoheal"
  # Docker reports StartedAt with nanosecond precision, and the wrapper feeds
  # that value straight into a `timestamptz` literal. Emitting a rounder format
  # here would make the harness pass on a string production never produces.
  printf '2026-07-01T00:00:00.000000000Z\n' > "${host}/runtime/started.web"
  printf '2026-07-01T00:00:00.000000000Z\n' > "${host}/runtime/started.worker"

  # ssh: the ONLY route to the database. It records every invocation, refuses a
  # host it was not told about, and runs the command with the DB host's PATH.
  cat > "${host}/bin/ssh" <<STUB
#!/usr/bin/env bash
target=""
declare -a words=()
while [ \$# -gt 0 ]; do
  case "\$1" in
    -o) shift 2; continue ;;
    -*) shift; continue ;;
    *)
      if [ -z "\${target}" ]; then target="\$1"; else words+=("\$1"); fi
      shift ;;
  esac
done
printf '%s :: %s\n' "\${target}" "\${words[*]}" >> "${host}/log/ssh"
if [ "\${target}" != "root@db-host" ]; then
  printf 'ssh: unknown host %s\n' "\${target}" >&2
  exit 255
fi
# The two hosts do not share a filesystem. The backup artifact is streamed over
# this link and lands on the APP host, so its directory does not exist on the
# database host at all — reaching for it from over here has to fail exactly the
# way it failed in production, where a remote sha256sum of the local artifact
# printed "No such file or directory", returned empty, and let a run continue
# with an unpinned artifact. Without this the shim shares one filesystem and that
# whole class of bug is invisible to the harness.
case "\${words[*]}" in
  *"${APPHOST_BACKUPS}"*)
    printf 'harness: the database host has no %s (app-host storage reached over ssh): %s\n' "${APPHOST_BACKUPS}" "\${words[*]}" >&2
    exit 1 ;;
esac
exec env PATH="${DBHOST_PATH}" /bin/sh -c "\${words[*]}"
STUB

  # Traps. Production's app host has no PostgreSQL client at all; if the wrapper
  # ever reaches for one it is talking to the wrong machine.
  for trap_tool in psql pg_dump runuser; do
    cat > "${host}/bin/${trap_tool}" <<STUB
#!/usr/bin/env bash
printf '%s %s\n' "${trap_tool}" "\$*" >> "${host}/log/local-db"
printf '${trap_tool} is NOT available on the app host\n' >&2
exit 127
STUB
  done

  # crontab, backed by a file, with the same interface the wrapper uses.
  cat > "${host}/bin/crontab" <<STUB
#!/usr/bin/env bash
mode=""
while [ \$# -gt 0 ]; do
  case "\$1" in
    -u) shift 2 ;;
    -l) mode=list; shift ;;
    -) mode=install; shift ;;
    -r) mode=remove; shift ;;
    *) shift ;;
  esac
done
case "\${mode}" in
  list)
    [ -f "${host}/state/crontab" ] || exit 1
    cat "${host}/state/crontab" ;;
  install) cat > "${host}/state/crontab" ;;
  remove) rm -f "${host}/state/crontab" ;;
  *) exit 1 ;;
esac
STUB

  cat > "${host}/bin/systemctl" <<STUB
#!/usr/bin/env bash
printf 'systemctl %s\n' "\$*" >> "${host}/log/systemctl"
case "\$1" in
  list-unit-files) printf '%s\n' "\${HARNESS_UNITS:-}"; exit 0 ;;
  is-active) exit 1 ;;
esac
exit 0
STUB

  cat > "${host}/bin/curl" <<STUB
#!/usr/bin/env bash
for arg in "\$@"; do
  case "\$arg" in
    *build-info*)
      printf '{"buildId":"%s"}\n' "\${HARNESS_BUILD_ID:-\${DEPLOY_SHA}}"
      exit 0 ;;
    *healthz*)
      if [ -n "\${HARNESS_HEALTHZ_FAIL:-}" ]; then exit 22; fi
      # Slow start: refuse the first N calls, then answer. A recreated
      # container is one second old when the phase first asks, and checking
      # once made the phase measure startup latency instead of health —
      # /healthz answered "connection reset" and enable rolled a correct
      # release back. This proves the retry waits rather than getting lucky.
      if [ -n "\${HARNESS_HEALTHZ_SLOW_START:-}" ]; then
        n="\$(cat "${host}/healthz-calls" 2>/dev/null || echo 0)"
        n=\$((n + 1)); printf '%s' "\$n" > "${host}/healthz-calls"
        [ "\$n" -gt "\${HARNESS_HEALTHZ_SLOW_START}" ] || exit 7
      fi
      printf 'ok\n'; exit 0 ;;
  esac
done
exit 0
STUB

  # flock is Linux-only and lock CONTENTION is not what this harness is about.
  cat > "${host}/bin/flock" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

  cat > "${host}/bin/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

  cat > "${host}/bin/docker" <<STUB
#!/usr/bin/env bash
set -uo pipefail
HOSTROOT="${host}"
RUNTIME="${host}/runtime"
printf 'docker %s\n' "\$*" >> "${host}/log/docker"

image_id_for() {
  case "\$1" in
    *omniads-web*) printf 'sha256:webpinned%s' "\${HARNESS_IMAGE_GENERATION:-0}" ;;
    *omniads-worker*) printf 'sha256:workerpinned%s' "\${HARNESS_IMAGE_GENERATION:-0}" ;;
    *) printf 'sha256:unknown' ;;
  esac
}

service_of() { printf '%s' "\${1#container-}"; }

db_sql_via_shim() {
  printf '%s\n' "\$1" | ssh -o BatchMode=yes root@db-host \\
    "runuser -u postgres -- psql --dbname=\${DB_NAME:-adsecute_prod} -v ON_ERROR_STOP=1 --tuples-only --no-align --file=-"
}

recreate_service() {
  local svc="\$1"
  printf 'running\n' > "\${RUNTIME}/state.\${svc}"
  printf '%s\n' "\$(date -u +%Y-%m-%dT%H:%M:%S).000000000Z" > "\${RUNTIME}/started.\${svc}"
  # A container freezes its environment when it is created. Snapshotting the env
  # file at recreate time is what makes "the file changed but the runtime did
  # not" observable instead of assumed.
  cp "\${HOSTROOT}/app/.env.production" "\${RUNTIME}/env.\${svc}"
}

case "\$1 \$2" in
  "image inspect")
    shift 2
    img=""
    want=""
    for arg in "\$@"; do
      case "\$arg" in
        --format) : ;;
        '{{.Id}}') want=id ;;
        *org.opencontainers.image.revision*) want=revision ;;
        '{{.Created}}') want=created ;;
        -*) ;;
        *) [ -z "\${img}" ] && img="\$arg" ;;
      esac
    done
    if [ -n "\${HARNESS_IMAGE_MISSING:-}" ]; then exit 1; fi
    case "\${want}" in
      id) image_id_for "\${img}"; printf '\n' ;;
      # The OCI revision label the real images now carry. HARNESS_IMAGE_REVISION
      # lets a case ship an image whose label does NOT match the deploy sha,
      # which is the tamper the release-identity gate exists to catch.
      revision) printf '%s\n' "\${HARNESS_IMAGE_REVISION:-\${DEPLOY_SHA:-}}" ;;
      created) printf '2026-07-27T00:00:00.000000000Z\n' ;;
    esac
    exit 0 ;;
esac

case "\$1" in
  compose)
    shift
    case "\$1" in
      ps)
        if [ "\$2" = "-q" ]; then
          svc="\$3"
          state="\$(cat "\${RUNTIME}/state.\${svc}" 2>/dev/null || printf 'absent')"
          [ "\${state}" = "absent" ] && exit 0
          printf 'container-%s\n' "\${svc}"
          exit 0
        fi
        if [ "\$2" = "--services" ]; then printf 'web\nworker\nmigrate\n'; exit 0; fi
        exit 0 ;;
      stop)
        shift
        for svc in "\$@"; do printf 'exited\n' > "\${RUNTIME}/state.\${svc}"; done
        exit 0 ;;
      rm) exit 0 ;;
      up)
        shift
        migrate_requested=0
        declare -a services=()
        for arg in "\$@"; do
          case "\$arg" in
            -*) ;;
            migrate) migrate_requested=1 ;;
            web|worker|autoheal) services+=("\$arg") ;;
          esac
        done
        if [ "\${migrate_requested}" = "1" ]; then
          if [ -n "\${HARNESS_MIGRATE_FAIL:-}" ]; then exit 1; fi
          # The migration under test: it adds the column the pre-fingerprint had
          # to work without, backfills it to the pre-model meaning of "selected",
          # and adds an index and a table. Data must be untouched.
          db_sql_via_shim "
            ALTER TABLE business_provider_accounts
              ADD COLUMN IF NOT EXISTS is_selected boolean NOT NULL DEFAULT true;
            CREATE TABLE IF NOT EXISTS provider_scope_backfill (id serial PRIMARY KEY, scope text);
            CREATE INDEX IF NOT EXISTS business_provider_accounts_selected_idx
              ON business_provider_accounts (business_id, provider) WHERE is_selected;
          " >/dev/null || exit 1
          # What the migration does to CREDENTIALS. Default: nothing, so the
          # ordinary run still proves the generation hash does not move. Each
          # mode below is a way the hash CAN move; only the first is legitimate.
          case "\${HARNESS_MIGRATE_CREDENTIALS:-none}" in
            none) : ;;
            encrypt)
              # The real thing: plaintext becomes ciphertext in place, and
              # updated_at is deliberately left alone.
              db_sql_via_shim "
                UPDATE integration_credentials
                   SET access_token = 'enc:v1:' || encode(sha256(convert_to(access_token,'UTF8')),'hex')
                 WHERE access_token IS NOT NULL AND access_token <> ''
                   AND access_token NOT LIKE 'enc:v1:%';
                UPDATE integration_credentials
                   SET refresh_token = 'enc:v1:' || encode(sha256(convert_to(refresh_token,'UTF8')),'hex')
                 WHERE refresh_token IS NOT NULL AND refresh_token <> ''
                   AND refresh_token NOT LIKE 'enc:v1:%';
              " >/dev/null || exit 1 ;;
            reencrypt)
              # An ALREADY-encrypted secret becomes a different ciphertext.
              db_sql_via_shim "
                UPDATE integration_credentials SET access_token = 'enc:v1:something-else'
                 WHERE access_token LIKE 'enc:v1:%';
              " >/dev/null || exit 1 ;;
            decrypt)
              db_sql_via_shim "
                UPDATE integration_credentials SET access_token = 'plaintext-again'
                 WHERE access_token LIKE 'enc:v1:%';
              " >/dev/null || exit 1 ;;
            drop_row)
              # Count-NEUTRAL on purpose: delete one row and insert another, so
              # the row-count diff cannot catch it and the census rule is what
              # has to notice that the id set moved.
              db_sql_via_shim "
                DELETE FROM integration_credentials WHERE provider_connection_id = 2;
                INSERT INTO integration_credentials (provider_connection_id, access_token, refresh_token)
                VALUES (1, 'enc:v1:cmVwbGFjZW1lbnQ', NULL);
              " >/dev/null || exit 1 ;;
            touch)
              # Same secrets, but the row was rewritten.
              db_sql_via_shim "
                UPDATE integration_credentials SET updated_at = now() + interval '1 second';
              " >/dev/null || exit 1 ;;
            mutate_plain)
              # Still plaintext afterwards, just a different value.
              db_sql_via_shim "
                UPDATE integration_credentials SET access_token = 'a-different-plaintext'
                 WHERE access_token NOT LIKE 'enc:v1:%';
              " >/dev/null || exit 1 ;;
          esac
          exit 0
        fi
        for svc in "\${services[@]:-}"; do
          [ -z "\${svc}" ] && continue
          if [ "\${HARNESS_RECREATE_FAIL:-}" = "\${svc}" ]; then
            printf 'exited\n' > "\${RUNTIME}/state.\${svc}"
            printf 'Error response from daemon: could not recreate %s\n' "\${svc}" >&2
            exit 1
          fi
          recreate_service "\${svc}"
        done
        exit 0 ;;
      exec)
        shift
        # docker compose exec -T <service> <command...>
        while [ \$# -gt 0 ]; do
          case "\$1" in -*) shift ;; *) break ;; esac
        done
        svc="\$1"; shift
        for arg in "\$@"; do
          case "\$arg" in
            --provider-scope) next_is_scope=1 ;;
          esac
        done
        scope=""
        prev=""
        for arg in "\$@"; do
          [ "\${prev}" = "--provider-scope" ] && scope="\$arg"
          prev="\$arg"
        done
        if [ -n "\${HARNESS_HEARTBEAT_FAIL_SCOPE:-}" ] && [ "\${HARNESS_HEARTBEAT_FAIL_SCOPE}" = "\${scope}" ]; then
          printf 'no online workers for %s\n' "\${scope}" >&2
          exit 1
        fi
        printf 'worker_online scope=%s service=%s\n' "\${scope:-meta}" "\${svc}"
        exit 0 ;;
      *) exit 0 ;;
    esac ;;

  inspect)
    shift
    id=""
    fmt=""
    while [ \$# -gt 0 ]; do
      case "\$1" in
        --format) fmt="\$2"; shift 2 ;;
        -*) shift ;;
        *) [ -z "\${id}" ] && id="\$1"; shift ;;
      esac
    done
    svc="\$(service_of "\${id}")"
    case "\${fmt}" in
      '{{.State.Status}}') cat "\${RUNTIME}/state.\${svc}" 2>/dev/null || printf 'absent\n' ;;
      '{{.Config.Image}}') printf 'ghcr.io/erhanrdn/omniads-%s:%s\n' "\${svc}" "\${DEPLOY_SHA}" ;;
      # The immutable image id the container is actually running, which is what
      # the release-identity gate compares against. HARNESS_RUNNING_IMAGE_ID
      # lets a case start a container on an image the record does not pin.
      '{{.Image}}')
        if [ -n "\${HARNESS_RUNNING_IMAGE_ID:-}" ]; then printf '%s\n' "\${HARNESS_RUNNING_IMAGE_ID}";
        else image_id_for "omniads-\${svc}"; printf '\n'; fi ;;
      *org.opencontainers.image.revision*)
        printf '%s\n' "\${HARNESS_RUNNING_IMAGE_REVISION:-\${HARNESS_IMAGE_REVISION:-\${DEPLOY_SHA:-}}}" ;;
      '{{.State.StartedAt}}') cat "\${RUNTIME}/started.\${svc}" 2>/dev/null || printf '2026-07-01T00:00:00.000000000Z\n' ;;
      *) printf '\n' ;;
    esac
    exit 0 ;;

  exec)
    shift
    id="\$1"; shift
    svc="\$(service_of "\${id}")"
    # "\$1" is sh, "\$2" is -c, "\$3" is the command.
    snapshot="\${RUNTIME}/env.\${svc}"
    [ -f "\${snapshot}" ] || exit 1
    (
      set -a
      # shellcheck disable=SC1090
      . "\${snapshot}"
      set +a
      exec /bin/sh -c "\$3"
    )
    exit \$? ;;

  run)
    for arg in "\$@"; do
      case "\$arg" in
        *pg_control_system*)
          if [ -n "\${HARNESS_RUNTIME_DB_IDENTITY:-}" ]; then
            printf '%s' "\${HARNESS_RUNTIME_DB_IDENTITY}"
            exit 0
          fi
          # The runtime identity probe reaches the database the same way the
          # application would: over the network, not through a local psql.
          db_sql_via_shim "SELECT current_database() || chr(124) || system_identifier::text FROM pg_control_system();" |
            tr -d '[:space:]'
          exit 0 ;;
      esac
    done
    for arg in "\$@"; do
      case "\$arg" in
        *global-sync-rollout*) : ;;
      esac
    done
    mode=""
    prev=""
    for arg in "\$@"; do
      case "\${prev}" in
        *global-sync-rollout.ts) mode="\$arg" ;;
      esac
      prev="\$arg"
    done
    case "\${mode}" in
      preflight)
        [ -z "\${HARNESS_CONTRACT_FAIL:-}" ] || exit 1
        printf 'contract ok\n'; exit 0 ;;
      enable)
        [ -z "\${HARNESS_ENABLE_REFUSES:-}" ] || exit 1
        env_file="\${HOSTROOT}/app/.env.production"
        tmp="\${env_file}.rollout.\$\$"
        grep -v '^ADSECUTE_SYNC_' "\${env_file}" > "\${tmp}"
        {
          # The real rollout writes a provenance COMMENT alongside the lanes.
          # The stub did not, so the enable guard reduced that comment to the
          # key name '#', matched no managed pattern, and rolled a perfectly
          # good enable back — in production, with the site down.
          printf '# managed by global-sync-rollout\n'
          printf 'ADSECUTE_SYNC_GLOBAL_ENABLED=enabled\n'
          printf 'ADSECUTE_SYNC_LANE_META_ENABLED=enabled\n'
          printf 'ADSECUTE_SYNC_LANE_GOOGLE_ADS_ENABLED=enabled\n'
          printf 'ADSECUTE_SYNC_LANE_SHOPIFY_ENABLED=enabled\n'
        } >> "\${tmp}"
        if [ -n "\${HARNESS_ROLLOUT_TOUCHES_UNMANAGED:-}" ]; then
          printf 'NEXTAUTH_SECRET=rewritten-by-a-bug\n' >> "\${tmp}"
          grep -v '^NEXTAUTH_SECRET=unrelated-value\$' "\${tmp}" > "\${tmp}.2" && mv "\${tmp}.2" "\${tmp}"
        fi
        mv "\${tmp}" "\${env_file}"
        printf 'rollout enable ok\n'; exit 0 ;;
      *) exit 0 ;;
    esac ;;
esac
exit 0
STUB

  chmod +x "${host}/bin/"*

  # The wrapper manifest, exactly as `hetzner-remote.sh deliver_cutover_wrapper`
  # would install it: the released digest, pinned.
  local wrapper_sha
  wrapper_sha="$(sha256_of "${WRAPPER}")"
  {
    printf 'wrapper_source=scripts/hetzner-sync-cutover.sh\n'
    printf 'wrapper_sha256=%s\n' "${wrapper_sha}"
    printf 'wrapper_bytes=%s\n' "$(wc -c < "${WRAPPER}" | tr -d '[:space:]')"
    printf 'cutover_required=yes\n'
    printf 'delivered_deploy_sha=%s\n' "${DEPLOY_SHA}"
    printf 'delivered_policy_sha256=%s\n' "$(sha256_of "${REPO_ROOT}/deploy/db/recovery-policy.tsv")"
  } > "${host}/cutover/cutover-wrapper.manifest"

  # The recovery policy travels with the wrapper, exactly as the real delivery
  # installs it. Without it the wrapper sees no tier-B tables and sizes its
  # capacity gate against the whole database.
  cp "${REPO_ROOT}/deploy/db/recovery-policy.tsv" "${host}/cutover/recovery-policy.tsv"

  printf '%s' "${host}"
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

run_phase() {
  local host="$1" phase="$2"
  shift 2
  env -i \
    PATH="${host}/bin:/usr/bin:/bin" \
    HOME="${host}" \
    TMPDIR="${host}/tmp-work" \
    DEPLOY_SHA="${DEPLOY_SHA}" \
    DB_NAME="${DB_NAME}" \
    REMOTE_APP_DIR="${host}/app" \
    SYNC_CUTOVER_STATE_DIR="${host}/state/cutover" \
    SYNC_CUTOVER_INSTALL_DIR="${host}/cutover" \
    SYNC_CUTOVER_DRAIN_SECONDS=0 \
    SYNC_CUTOVER_DB_SSH="root@db-host" \
    SYNC_CUTOVER_BACKUP_ROOT="${APPHOST_BACKUPS}" \
    SYNC_CUTOVER_SCHEDULER="rootcron" \
    "$@" \
    bash "${WRAPPER}" "${phase}" 2>&1
}

expect_ok() {
  local host="$1" phase="$2" what="$3"
  shift 3
  local out
  if out="$(run_phase "${host}" "${phase}" "$@")"; then
    pass "${what}"
    return 0
  fi
  fail "${what} — phase '${phase}' failed: ${out}"
  return 1
}

# The digest the wrapper computes over a DB-host file, which reads it through a
# command substitution and therefore never sees the trailing newline. A harness
# that hashed the file itself would compare two different things.
sha256_of_content() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$(cat "$1")" | sha256sum | awk '{print $1}'
  else
    printf '%s' "$(cat "$1")" | shasum -a 256 | awk '{print $1}'
  fi
}

expect_refusal() {
  local host="$1" phase="$2" needle="$3" what="$4"
  shift 4
  local out
  if out="$(run_phase "${host}" "${phase}" "$@")"; then
    fail "${what} — phase '${phase}' SUCCEEDED when it had to refuse: ${out}"
    return 1
  fi
  if printf '%s' "${out}" | grep -q "${needle}"; then
    pass "${what}"
    return 0
  fi
  fail "${what} — phase '${phase}' refused for the wrong reason: ${out}"
  return 1
}

mkdir -p "${HARNESS_ROOT}/tmp-work"

# ══ N: refusals that must happen before anything irreversible ══════════════

host="$(new_host lowcapacity)"
mkdir -p "${host}/tmp-work"
expect_refusal "${host}" preflight "insufficient free space on the database host" \
  "N1 low free space on the database host's data directory refuses at preflight, before any dump or migration" \
  HARNESS_DF_FREE_KB=1048576 || true

host="$(new_host wrongdb)"
mkdir -p "${host}/tmp-work"
expect_refusal "${host}" preflight "point at DIFFERENT databases" \
  "N2 a runtime DATABASE_URL resolving to another database refuses at preflight" \
  HARNESS_RUNTIME_DB_IDENTITY="adsecute_staging|9999" || true

host="$(new_host schedulernone)"
mkdir -p "${host}/tmp-work"
expect_refusal "${host}" preflight "claims there is no external scheduler, but one was found" \
  "N3 scheduler=none is refused while adsecute entries are still in the root crontab" \
  SYNC_CUTOVER_SCHEDULER=none || true

host="$(new_host tamperedwrapper)"
mkdir -p "${host}/tmp-work"
cp "${WRAPPER}" "${host}/cutover/hetzner-sync-cutover.sh"
{
  printf '\n'
  printf '# an operator edited the wrapper in place on the host\n'
} >> "${host}/cutover/hetzner-sync-cutover.sh"
tampered_out="$(
  env -i PATH="${host}/bin:/usr/bin:/bin" HOME="${host}" TMPDIR="${host}/tmp-work" \
    DEPLOY_SHA="${DEPLOY_SHA}" DB_NAME="${DB_NAME}" REMOTE_APP_DIR="${host}/app" \
    SYNC_CUTOVER_STATE_DIR="${host}/state/cutover" SYNC_CUTOVER_INSTALL_DIR="${host}/cutover" \
    SYNC_CUTOVER_DB_SSH="root@db-host" SYNC_CUTOVER_SCHEDULER=rootcron \
    bash "${host}/cutover/hetzner-sync-cutover.sh" status 2>&1 || true
)"
if printf '%s' "${tampered_out}" | grep -q "is not the released cutover script"; then
  pass "N4 a wrapper edited on the host refuses against the delivered checksum manifest, before any phase runs"
else
  fail "N4 a tampered wrapper was accepted: ${tampered_out}"
fi

# ══ P: the full phase graph, against the real database ═════════════════════

host="$(new_host main)"
mkdir -p "${host}/tmp-work"
MAIN_HOST="${host}"

expect_ok "${host}" preflight \
  "P1 preflight completes on the OLD schema: images, env, scheduler, capacity, database identity" || true

# The rollback artifact is real: a full pg_dump that was restored into a scratch
# database and read back.
manifest_path="$(awk -F= '$1=="backup_manifest_path"{print $2}' "${host}/state/cutover/state")"
if [ -n "${manifest_path}" ] && [ -s "${manifest_path}" ]; then
  artifact="$(awk -F= '$1=="artifact_path"{print $2}' "${manifest_path}")"
  artifact_bytes="$(awk -F= '$1=="artifact_bytes"{print $2}' "${manifest_path}")"
  restored="$(awk -F= '$1=="scratch_restore_verified"{print $2}' "${manifest_path}")"
  credential_count="$(awk -F= '$1=="credential_count"{print $2}' "${manifest_path}")"
  assignment_count="$(awk -F= '$1=="assignment_count"{print $2}' "${manifest_path}")"
  connection_count="$(awk -F= '$1=="connection_count"{print $2}' "${manifest_path}")"
  artifact_sha="$(awk -F= '$1=="artifact_sha256"{print $2}' "${manifest_path}")"
  if [ -s "${artifact}" ] && [ "${restored}" = "yes" ] &&
    [ "${credential_count}" = "2" ] && [ "${assignment_count}" = "1" ] && [ "${connection_count}" = "2" ]; then
    pass "P2 preflight produced a FRESH full backup (${artifact_bytes}B), scratch-restored it, and bound the manifest to 2 connections, 2 credentials and 1 assignment set — the rows the old core backup omitted"
  else
    fail "P2 the backup manifest is not bound to a verified fresh artifact: $(cat "${manifest_path}")"
  fi

  # P2b — the digest has to BE a digest, and it has to be THIS artifact's.
  #
  # The artifact is streamed over SSH to the host running this script, so for a
  # while it was hashed on the database host, where that path does not exist:
  # sha256sum wrote "No such file or directory" to stderr, the substitution
  # returned empty, and the manifest pinned the artifact to nothing. Every later
  # equality check still passed, because empty equals empty. Asserting the shape
  # AND recomputing it here is what makes the pin real rather than self-agreeing.
  recomputed="$(sha256_of "${artifact}" 2>/dev/null || true)"
  if [ "${#artifact_sha}" -eq 64 ] && [ -z "${artifact_sha//[0-9a-f]/}" ] &&
    [ "${artifact_sha}" = "${recomputed}" ]; then
    pass "P2b the manifest pins the artifact to its own real sha256, recomputed independently"
  else
    fail "P2b the artifact digest is not a real pin: manifest='${artifact_sha}' recomputed='${recomputed}'"
  fi

  # P2c — the artifact is a full copy of the production database, including every
  # encrypted credential. A `>` redirection gave it the umask's 0644. `ls -l`
  # rather than stat, whose mode flags differ between GNU and BSD.
  artifact_mode="$(ls -l "${artifact}" | cut -c1-10)"
  manifest_mode="$(ls -l "${manifest_path}" | cut -c1-10)"
  if [ "${artifact_mode}" = "-rw-------" ] && [ "${manifest_mode}" = "-rw-------" ]; then
    pass "P2c the artifact and its manifest are both 0600, not merely hidden behind a 0700 directory"
  else
    fail "P2c artifact mode ${artifact_mode}, manifest mode ${manifest_mode}; both must be -rw-------"
  fi
else
  fail "P2 preflight recorded no backup manifest"
fi

if grep -q '^state_version=2$' "${host}/state/cutover/state" &&
  grep -q '^cutover_epoch=' "${host}/state/cutover/state" &&
  grep -q '^web_image_digest=' "${host}/state/cutover/state" &&
  grep -q '^worker_image_digest=' "${host}/state/cutover/state" &&
  grep -q '^env_file_sha256=' "${host}/state/cutover/state" &&
  grep -q '^scheduler_sha256=' "${host}/state/cutover/state" &&
  grep -q '^backup_manifest_sha256=' "${host}/state/cutover/state"; then
  pass "P3 preflight wrote a VERSIONED state record bound to the deploy sha, both image digests, the database identity, the env hash, the scheduler spec+hash, the backup manifest hash and a cutover epoch"
else
  fail "P3 the state record is not the versioned form: $(cat "${host}/state/cutover/state")"
fi

# A live application backend must block quiescence — the whole point of moving
# the gate off expired lease strings and onto pg_stat_activity.
PGAPPNAME=omniads-worker "${PGBIN}/psql" -h 127.0.0.1 -p "${PGPORT}" -U postgres \
  --dbname="${DB_NAME}" -c "BEGIN; SELECT pg_sleep(120);" >/dev/null 2>&1 &
LIVE_BACKEND_PID=$!
sleep 1
expect_refusal "${host}" quiesce "quiescence not reached" \
  "P4 quiesce refuses while a live omniads backend is attached to the database (observed in pg_stat_activity, not counted from lease rows)" || true

# Killing the client does not end the BACKEND — the server only notices the
# closed socket when it next tries to write, which for a sleeping query is
# minutes away. The backend is terminated server-side and the harness waits for
# pg_stat_activity to agree, because otherwise the next quiesce would refuse for
# the right reason at the wrong time.
kill "${LIVE_BACKEND_PID}" >/dev/null 2>&1 || true
wait "${LIVE_BACKEND_PID}" 2>/dev/null || true
psql_direct --quiet --command \
  "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name LIKE 'omniads%' AND pid <> pg_backend_pid();" >/dev/null 2>&1 || true
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  remaining="$(psql_direct --command "SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'omniads%' AND pid <> pg_backend_pid();" | tr -d '[:space:]')"
  [ "${remaining}" = "0" ] && break
  sleep 1
done

if grep -q 'phase_chain=preflight$' "${host}/state/cutover/state"; then
  pass "P5 the failed quiesce was NOT recorded, so resuming re-runs exactly that phase"
else
  fail "P5 a failed phase was recorded: $(grep phase_chain "${host}/state/cutover/state")"
fi

expect_ok "${host}" quiesce \
  "P6 quiesce stops the scheduler, autoheal, web and worker and proves the database is quiescent" || true

# Root crontab: the managed block is gone, every unrelated line is untouched.
if ! grep -q 'adsecute-sync-tick' "${host}/state/crontab" &&
  grep -q 'healthz-probe' "${host}/state/crontab" &&
  grep -q 'unrelated-backup' "${host}/state/crontab" &&
  grep -q 'unrelated-boot-task' "${host}/state/crontab" &&
  grep -q '^MAILTO=ops@example.invalid$' "${host}/state/crontab"; then
  pass "P7 root crontab: only the delimited adsecute block was removed; MAILTO, the healthz probe and both unrelated jobs stayed active"
else
  fail "P7 root crontab was not preserved: $(cat "${host}/state/crontab")"
fi

expect_ok "${host}" fingerprint-pre \
  "P8 fingerprint-pre runs against the real pre-migration schema, before is_selected exists" || true

if grep -q '^selected_binding_hash=[0-9a-f]\{64\}$' "${host}/state/cutover/fingerprint-pre" &&
  grep -q '^connection_generation_hash=[0-9a-f]\{64\}$' "${host}/state/cutover/fingerprint-pre" &&
  grep -q '^credential_generation_hash=[0-9a-f]\{64\}$' "${host}/state/cutover/fingerprint-pre" &&
  grep -q '^assignment_hash=[0-9a-f]\{64\}$' "${host}/state/cutover/fingerprint-pre" &&
  grep -q '^release_gate_hash=[0-9a-f]\{64\}$' "${host}/state/cutover/fingerprint-pre" &&
  grep -q '^count.business_provider_accounts=4$' "${host}/state/cutover/fingerprint-pre" &&
  grep -q '^count.integration_credentials=2$' "${host}/state/cutover/fingerprint-pre" &&
  grep -q '^count.meta_raw_snapshots=12$' "${host}/state/cutover/fingerprint-pre" &&
  [ "$(grep -c '^count\.' "${host}/state/cutover/fingerprint-pre")" -ge 14 ]; then
  pass "P9 the fingerprint is $(grep -c '^count\.' "${host}/state/cutover/fingerprint-pre") real counts plus the selected identity/position set, connection and credential generations, assignments, release gates, the schema identity and the exact database id — every value computed by PostgreSQL"
else
  fail "P9 the fingerprint is not the expanded form: $(cat "${host}/state/cutover/fingerprint-pre")"
fi

if grep -q 'access_token\|refresh_token\|meta-access-token-value' "${host}/state/cutover/fingerprint-pre"; then
  fail "P10 the fingerprint leaked credential material"
else
  pass "P10 the credential generation is a digest: no token value appears anywhere in the fingerprint"
fi

expect_ok "${host}" migrate \
  "P11 migrate applies the real migration (is_selected added and backfilled, an index and a table created) from the pinned image" || true

if [ "$(psql_direct --command "SELECT count(*) FROM information_schema.columns WHERE table_name='business_provider_accounts' AND column_name='is_selected';" | tr -d '[:space:]')" = "1" ]; then
  pass "P12 the migration really ran against the real database: business_provider_accounts.is_selected now exists"
else
  fail "P12 the migration did not change the real schema"
fi

expect_ok "${host}" verify-contract \
  "P13 verify-contract runs the POST-migration schema contract, which preflight could not have run" || true

expect_ok "${host}" fingerprint-post \
  "P14 fingerprint-post: every count and every identity/generation hash is byte-identical across the migration, and the schema identity advanced" || true

pre_sel="$(awk -F= '$1=="selected_binding_hash"{print $2}' "${host}/state/cutover/fingerprint-pre")"
post_sel="$(awk -F= '$1=="selected_binding_hash"{print $2}' "${host}/state/cutover/fingerprint-post")"
pre_schema="$(awk -F= '$1=="schema_identity"{print $2}' "${host}/state/cutover/fingerprint-pre")"
post_schema="$(awk -F= '$1=="schema_identity"{print $2}' "${host}/state/cutover/fingerprint-post")"
if [ -n "${pre_sel}" ] && [ "${pre_sel}" = "${post_sel}" ] && [ "${pre_schema}" != "${post_schema}" ]; then
  pass "P15 the schema-conditional selection predicate reproduces the SAME digest before and after is_selected exists (${pre_sel}), while the schema identity moved ${pre_schema} -> ${post_schema}"
else
  fail "P15 selected=${pre_sel}/${post_sel} schema=${pre_schema}/${post_schema}"
fi

expect_ok "${host}" deploy-disabled \
  "P16 deploy-disabled brings both processes up on the pinned build with every lane off and proves a fresh worker registration" || true

# ══ N: a partial recreate failure during enable ════════════════════════════

cp "${host}/app/.env.production" "${HARNESS_ROOT}/env-before-failed-enable"
expect_refusal "${host}" enable "enable failed and was rolled back" \
  "N5 a partial recreate failure during enable rolls back: the rollout ran, web failed to come back, and the phase refused" \
  HARNESS_RECREATE_FAIL=web || true

if cmp -s "${HARNESS_ROOT}/env-before-failed-enable" "${host}/app/.env.production"; then
  pass "N6 the failed enable restored the DISABLED env file byte-for-byte"
else
  fail "N6 the env file was left enabled after a failed enable: $(cat "${host}/app/.env.production")"
fi

if [ "$(cat "${host}/runtime/state.web")" != "running" ] &&
  [ "$(cat "${host}/runtime/state.worker")" != "running" ] &&
  [ "$(cat "${host}/runtime/state.autoheal")" != "running" ] &&
  [ "$(cat "${host}/state/cutover/state" | awk -F= '$1=="invalidated"{print $2}')" = "yes" ]; then
  pass "N7 the failed enable stopped all runtime and the scheduler and INVALIDATED the state"
else
  fail "N7 the failed enable left runtime up or state valid: $(cat "${host}/state/cutover/state")"
fi

# R6: after a rollback the release record must say so, and must still carry the
# identity a restore has to put back. A record still claiming the release is
# live is how the next operator deploys on top of a rolled-back host.
relrec="${host}/state/cutover/sync-release-identity"
rel_phase="$(awk -F= '$1=="phase"{print $2}' "${relrec}" 2>/dev/null)"
rel_target="$(awk -F= '$1=="restore_target_web_image_ref"{print $2}' "${relrec}" 2>/dev/null)"
rel_envmatch="$(awk -F= '$1=="restored_env_matches_preflight"{print $2}' "${relrec}" 2>/dev/null)"
if [ "${rel_phase}" = "rolled-back:enable" ] && [ -n "${rel_target}" ] && [ "${rel_envmatch}" = "yes" ]; then
  pass "R6 the rollback recorded itself in the release record: phase=${rel_phase}, restore target web=${rel_target}, and the restored env matches the digest captured at preflight"
else
  fail "R6 the release record does not describe the rollback: phase='${rel_phase}' target='${rel_target}' env_match='${rel_envmatch}'"
fi

expect_refusal "${host}" enable "has not completed in this cutover" \
  "N8 after the rollback, enable refuses until the runtime proof is re-established" || true

expect_ok "${host}" deploy-disabled \
  "P17 a clean retry is permitted: deploy-disabled re-establishes the runtime proof and clears the invalidation" || true

expect_ok "${host}" enable \
  "P18 enable updates only the managed lane keys, recreates both containers, and verifies every enabled lane in BOTH, retention off, exact images, build id and fresh meta/google_ads/shopify registrations" || true

if grep -q '^enabled_lanes=.*ADSECUTE_SYNC_LANE_META_ENABLED' "${host}/state/cutover/state" &&
  grep -q '^enabled_lanes=.*ADSECUTE_SYNC_LANE_SHOPIFY_ENABLED' "${host}/state/cutover/state" &&
  grep -q 'ADSECUTE_SYNC_LANE_META_ENABLED=enabled' "${host}/runtime/env.web" &&
  grep -q 'ADSECUTE_SYNC_LANE_META_ENABLED=enabled' "${host}/runtime/env.worker" &&
  ! grep -q 'RETENTION' "${host}/runtime/env.worker"; then
  pass "P19 both containers were recreated from the same enabled configuration and neither carries a retention lane"
else
  fail "P19 the containers did not both pick up the enabled lanes: web=$(cat "${host}/runtime/env.web") worker=$(cat "${host}/runtime/env.worker")"
fi

expect_ok "${host}" resume-scheduler \
  "P20 resume-scheduler restores the root crontab block last, after both processes are proven" || true

if cmp -s "${host}/state/crontab.original" "${host}/state/crontab"; then
  pass "P21 the root crontab is byte-identical to what it was before the cutover: the managed block came back in its original position and nothing else moved"
else
  fail "P21 the root crontab differs after the cutover: $(diff "${host}/state/crontab.original" "${host}/state/crontab" || true)"
fi

# ══ P/N: emergency-disable invalidates the enable and resume proofs ════════

expect_ok "${host}" emergency-disable \
  "P22 emergency-disable stops the scheduler and all runtime and CONFIRMS live state" || true

expect_refusal "${host}" resume-scheduler "has not completed in this cutover" \
  "N9 enable -> emergency-disable -> resume-scheduler REFUSES: the emergency stop invalidated the enable proof" || true

# ══ N: stale state, stale/foreign backup, retag ════════════════════════════

host="$(new_host stalestate)"
mkdir -p "${host}/tmp-work"
run_phase "${host}" preflight >/dev/null 2>&1 || true
expect_refusal "${host}" quiesce "One state directory cannot hold two releases" \
  "N10 a state record opened for one release refuses every phase of another: one state directory cannot hold two cutovers" \
  DEPLOY_SHA=00000000000000000000000000000000deadbeef || true

host="$(new_host retag)"
mkdir -p "${host}/tmp-work"
run_phase "${host}" preflight >/dev/null 2>&1 || true
run_phase "${host}" quiesce >/dev/null 2>&1 || true
run_phase "${host}" fingerprint-pre >/dev/null 2>&1 || true
expect_refusal "${host}" migrate "retagged mid-cutover" \
  "N11 an image tag rebuilt between phases refuses instead of migrating with a different build" \
  HARNESS_IMAGE_GENERATION=9 || true

stale_manifest="$(awk -F= '$1=="backup_manifest_path"{print $2}' "${host}/state/cutover/state")"
if [ -n "${stale_manifest}" ]; then
  sed 's/^cutover_epoch=.*/cutover_epoch=someone-elses-cutover/' "${stale_manifest}" > "${stale_manifest}.edited"
  mv "${stale_manifest}.edited" "${stale_manifest}"
  expect_refusal "${host}" migrate "the backup manifest changed since preflight" \
    "N12 a backup manifest edited after preflight refuses: it is not the artifact this cutover was authorised against" || true
else
  fail "N12 could not locate the backup manifest to make stale"
fi

host="$(new_host foreignbackup)"
mkdir -p "${host}/tmp-work"
run_phase "${host}" preflight >/dev/null 2>&1 || true
foreign_manifest="$(awk -F= '$1=="backup_manifest_path"{print $2}' "${host}/state/cutover/state")"
if [ -n "${foreign_manifest}" ]; then
  sed 's/^db_system_identifier=.*/db_system_identifier=7777777777777777777/' "${foreign_manifest}" > "${foreign_manifest}.edited"
  mv "${foreign_manifest}.edited" "${foreign_manifest}"
  new_sha="$(sha256_of_content "${foreign_manifest}")"
  # The state record is repointed at the edited manifest's digest so the refusal
  # under test is the FOREIGN-DATABASE one, not the tamper one already covered.
  sed "s/^backup_manifest_sha256=.*/backup_manifest_sha256=${new_sha}/" \
    "${host}/state/cutover/state" > "${host}/state/cutover/state.edited"
  mv "${host}/state/cutover/state.edited" "${host}/state/cutover/state"
  expect_refusal "${host}" quiesce "It is a foreign backup" \
    "N13 a manifest describing another PostgreSQL system identifier refuses, even with a matching digest" || true
else
  fail "N13 could not locate the backup manifest to make foreign"
fi

# ══ N: the root crontab is not restored over somebody else's edit ══════════

# Its own database: this scenario has to reach `enable`, and `enable` is only
# reachable through a migration that actually advances the schema.
seed_database adsecute_cronedit
host="$(new_host cronedit)"
mkdir -p "${host}/tmp-work"
for phase in preflight quiesce; do
  run_phase "${host}" "${phase}" DB_NAME=adsecute_cronedit >/dev/null 2>&1 || true
done
printf '0 5 * * * /usr/local/bin/added-by-somebody-else\n' >> "${host}/state/crontab"
for phase in fingerprint-pre migrate verify-contract fingerprint-post deploy-disabled enable; do
  run_phase "${host}" "${phase}" DB_NAME=adsecute_cronedit >/dev/null 2>&1 || true
done
if grep -q '^phase_chain=.*enable' "${host}/state/cutover/state"; then
  expect_refusal "${host}" resume-scheduler "unrelated root crontab lines changed while the Sync block was out" \
    "N14 resume-scheduler refuses when somebody else edited the root crontab during the cutover, instead of overwriting their entry" \
    DB_NAME=adsecute_cronedit || true
else
  fail "N14 the cronedit scenario never reached enable: $(grep phase_chain "${host}/state/cutover/state")"
fi

# ══ The split-host invariant ═══════════════════════════════════════════════

if [ -s "${MAIN_HOST}/log/ssh" ] && [ ! -s "${MAIN_HOST}/log/local-db" ]; then
  pass "P23 two hosts held: $(wc -l < "${MAIN_HOST}/log/ssh" | tr -d '[:space:]') database operations went over the ssh shim and the app host's psql/pg_dump/runuser were never invoked"
else
  fail "P23 the app host reached for a local PostgreSQL client, or never reached the database host: $(cat "${MAIN_HOST}/log/local-db" 2>/dev/null)"
fi

# Advance a fresh scenario host to the point just before the container swap.
# Echoes the phase that failed, so a broken precondition names itself instead of
# surfacing as "the scenario never reached deploy-disabled".
# These cases are about the RELEASE IDENTITY gate at the swap boundary, not
# about the phase graph, which P1-P23 already exercise end to end. So the host
# is advanced by running the real preflight — which is what WRITES the record —
# and then satisfying the phase chain directly. Driving the full migration chain
# here would only re-test the graph and couple these cases to scenario database
# state they do not care about.
advance_to_swap_ready() {
  local h="$1" out
  if ! out="$(run_phase "${h}" preflight 2>&1)"; then
    printf 'preflight: %s' "${out}"
    return 1
  fi
  local st="${h}/state/cutover/state"
  sed 's/^phase_chain=.*/phase_chain=preflight,quiesce,fingerprint-pre,migrate,verify-contract,fingerprint-post/' \
    "${st}" > "${st}.x" && mv "${st}.x" "${st}"
  return 0
}

# ── Release identity gate ────────────────────────────────────────────────────
#
# The record binds which release this cutover IS. These cases prove it refuses
# on each way that binding can be broken, and that a rollback records the truth.

# R1 positive: preflight writes a complete, correctly-owned record.
host="$(new_host relrec)"
if run_phase "${host}" preflight >/dev/null 2>&1; then
  rec="${host}/state/cutover/sync-release-identity"
  if [ ! -f "${rec}" ]; then
    fail "R1 preflight wrote no release identity record"
  else
    missing=""
    for k in record_version source_sha web_image_id worker_image_id \
             web_image_revision worker_image_revision wrapper_sha256 \
             manifest_sha256 policy_sha256 backup_manifest_id \
             prev_web_image_ref prev_env_sha256 phase; do
      grep -q "^${k}=" "${rec}" || missing="${missing} ${k}"
    done
    mode="$(stat -c %a "${rec}" 2>/dev/null || stat -f %Lp "${rec}" 2>/dev/null)"
    secretish="$(grep -ciE 'token|secret|password|key=' "${rec}" || true)"
    if [ -n "${missing}" ]; then
      fail "R1 the release record is missing fields:${missing}"
    elif [ "${mode}" != "600" ]; then
      fail "R1 the release record is mode ${mode}, not 600"
    elif [ "${secretish}" != "0" ]; then
      fail "R1 the release record appears to contain secret material"
    else
      pass "R1 preflight wrote a complete mode-0600 release identity record binding source sha, both image ids, both OCI revision labels, wrapper/manifest/policy digests, the backup manifest id and the PREVIOUS runtime identity — with no secret material"
    fi
  fi
else
  fail "R1 preflight failed before a release record could be written"
fi

# R2 mismatch: an image whose OCI revision label is not the sha being deployed.
host="$(new_host relmismatch)"
expect_refusal "${host}" preflight "OCI revision label" \
  "R2 an image whose revision label does not name the deployed sha is refused: a moved tag cannot impersonate the release" \
  HARNESS_IMAGE_REVISION=0000000000000000000000000000000000000000 || true

# R3 tamper: the record is edited after preflight.
host="$(new_host reltamper)"
if adv="$(advance_to_swap_ready "${host}")"; then
  rec="${host}/state/cutover/sync-release-identity"
  sed 's/^web_image_id=.*/web_image_id=sha256:tampered/' "${rec}" > "${rec}.x" && mv "${rec}.x" "${rec}"
  expect_refusal "${host}" deploy-disabled "release identity" \
    "R3 a release record edited after preflight refuses the container swap" || true
else
  fail "R3 the tamper scenario stopped early — ${adv}"
fi

# R4 partial write: a truncated record must refuse, not read as "fields match".
host="$(new_host relpartial)"
if adv="$(advance_to_swap_ready "${host}")"; then
  rec="${host}/state/cutover/sync-release-identity"
  head -3 "${rec}" > "${rec}.x" && mv "${rec}.x" "${rec}"
  expect_refusal "${host}" deploy-disabled "missing" \
    "R4 a truncated release record refuses instead of matching on the fields that survived" || true
else
  fail "R4 the partial-write scenario stopped early — ${adv}"
fi

# R5 running-image mismatch: the container comes up on an image the record does
# not pin. Starting successfully is not the same as running the right thing.
host="$(new_host relrunning)"
if adv="$(advance_to_swap_ready "${host}")"; then
  expect_refusal "${host}" deploy-disabled "the running web container is image" \
    "R5 a container running an image the record does not pin refuses, even though it started cleanly" \
    HARNESS_RUNNING_IMAGE_ID=sha256:someotherimage || true
else
  fail "R5 the running-image scenario stopped early — ${adv}"
fi

# R7/R8: the recovery policy is part of the delivered release, not scenery.
host="$(new_host relpolicymissing)"
rm -f "${host}/cutover/recovery-policy.tsv"
expect_refusal "${host}" preflight "no recovery policy" \
  "R7 a wrapper delivered without its recovery policy refuses, rather than silently treating every table as tier A and sizing itself against the whole database" || true

host="$(new_host relpolicyedited)"
printf '\nmeta_ad_daily\tB\tedited on the host\n' >> "${host}/cutover/recovery-policy.tsv"
expect_refusal "${host}" preflight "recovery policy hashes" \
  "R8 a recovery policy edited on the host refuses against the digest the delivery pinned" || true

# ══ T: a container is not broken for being one second old ══════════════════
#
# Every check after `docker compose up -d --force-recreate` used to run ONCE,
# immediately. At that point Next.js has not bound its port and the worker has
# not written its first heartbeat, so the checks measured startup latency and
# called it failure — three separate times on live cutovers, once rolling a
# correct enable back with the site down. The retries are bounded, so a
# genuinely dead release still fails; it just does not fail for being young.
seed_database adsecute_slowstart
host="$(new_host slowstart)"
mkdir -p "${host}/tmp-work"
for phase in preflight quiesce fingerprint-pre migrate verify-contract fingerprint-post; do
  run_phase "${host}" "${phase}" DB_NAME=adsecute_slowstart >/dev/null 2>&1 || true
done
expect_ok "${host}" deploy-disabled \
  "T1 a web container that refuses the first 5 health probes still passes deploy-disabled: the phase waits for readiness instead of measuring boot time" \
  DB_NAME=adsecute_slowstart HARNESS_HEALTHZ_SLOW_START=5 || true

rm -f "${host}/healthz-calls"
expect_refusal "${host}" enable "/healthz" \
  "T2 a web container that NEVER answers still fails enable, so the retry is a budget and not a bypass" \
  DB_NAME=adsecute_slowstart HARNESS_HEALTHZ_FAIL=1 || true

# ══ K: continuation once production is already migrated ════════════════════
#
# After a cutover has migrated production, every LATER release carries a
# migration that is correctly a no-op — and fingerprint-post refuses an
# unchanged schema, because that is also what "you forgot to migrate" looks
# like. Refusing forever would mean either never releasing again or restoring a
# 24 GB backup to give the migration something to do.
#
# So a no-op is allowed against EVIDENCE and never against a flag: the operator
# names the cutover that did apply the migration, and that cutover's own
# attestation has to describe the schema now in front of us. The migration still
# runs and still has to exit 0. These cases are the ways that can be wrong.
seed_database adsecute_cont
host="$(new_host cont)"
mkdir -p "${host}/tmp-work"
for phase in preflight quiesce fingerprint-pre migrate verify-contract fingerprint-post; do
  run_phase "${host}" "${phase}" DB_NAME=adsecute_cont >/dev/null 2>&1 || true
done
first_epoch="$(awk -F= '$1=="cutover_epoch"{print $2}' "${host}/state/cutover/state" 2>/dev/null)"
if [ -n "${first_epoch}" ] && [ -f "${host}/state/cutover/attestations/${first_epoch}" ]; then
  pass "K1 a cutover that reached fingerprint-post writes a migration attestation naming the schema it proved"
else
  fail "K1 no attestation was written for epoch '${first_epoch}'"
fi

# The SAME database, a SECOND release. The migration is idempotent, so the
# schema cannot move, and this is exactly the state production is in.
cont_host="$(new_host cont2)"
mkdir -p "${cont_host}/tmp-work"
cp -R "${host}/state/cutover/attestations" "${cont_host}/state/" 2>/dev/null || true
SECOND_SHA=b2c3d4e5f60718293a4b5c6d7e8f90123456789a
retag_images_for "${cont_host}" "${SECOND_SHA}" 2>/dev/null || true
for phase in preflight quiesce fingerprint-pre migrate verify-contract; do
  run_phase "${cont_host}" "${phase}" DB_NAME=adsecute_cont \
    SYNC_CUTOVER_ATTESTATION_DIR="${cont_host}/state/attestations" \
    DEPLOY_SHA="${SECOND_SHA}" >/dev/null 2>&1 || true
done

expect_refusal "${cont_host}" fingerprint-post "no prior cutover was named" \
  "K2 an unchanged schema with NO named predecessor still refuses — the 'you forgot to migrate' case is untouched" \
  DB_NAME=adsecute_cont SYNC_CUTOVER_ATTESTATION_DIR="${cont_host}/state/attestations" \
  DEPLOY_SHA="${SECOND_SHA}" || true

expect_refusal "${cont_host}" fingerprint-post "no attestation for cutover" \
  "K3 naming a cutover that never reached fingerprint-post refuses: a continuation cannot be licensed by a run that proved nothing" \
  DB_NAME=adsecute_cont SYNC_CUTOVER_ATTESTATION_DIR="${cont_host}/state/attestations" \
  DEPLOY_SHA="${SECOND_SHA}" SYNC_CUTOVER_CONTINUES_FROM=never-happened || true

# An attestation whose schema no longer matches: something migrated outside a
# cutover since it was written.
sed 's/^schema_identity_post=.*/schema_identity_post=0000000000000000000000000000000000000000000000000000000000000000/' \
  "${cont_host}/state/attestations/${first_epoch}" > "${cont_host}/state/attestations/stale-schema"
expect_refusal "${cont_host}" fingerprint-post "cannot license this one" \
  "K4 an attestation describing a DIFFERENT schema refuses, so a database migrated outside a cutover cannot ride in on old evidence" \
  DB_NAME=adsecute_cont SYNC_CUTOVER_ATTESTATION_DIR="${cont_host}/state/attestations" \
  DEPLOY_SHA="${SECOND_SHA}" SYNC_CUTOVER_CONTINUES_FROM=stale-schema || true

# An attestation from another PostgreSQL system.
sed 's/^db_identity=.*/db_identity=someone_else|123456789/' \
  "${cont_host}/state/attestations/${first_epoch}" > "${cont_host}/state/attestations/foreign-db"
expect_refusal "${cont_host}" fingerprint-post "describes a different system" \
  "K5 an attestation from another database refuses, even with a matching schema identity" \
  DB_NAME=adsecute_cont SYNC_CUTOVER_ATTESTATION_DIR="${cont_host}/state/attestations" \
  DEPLOY_SHA="${SECOND_SHA}" SYNC_CUTOVER_CONTINUES_FROM=foreign-db || true

# Plaintext secrets reappearing invalidates the continuation even when the
# schema still matches: the attestation describes a state this database is no
# longer in.
# The plaintext has to predate the fingerprint, or the credential census
# refuses first for its own (also correct) reason — ciphertext becoming
# plaintext. Re-taking fingerprint-pre with the plaintext already there isolates
# the continuation's own re-proof: the census sees no change at all, and the
# only thing left to catch it is "the attestation describes a state this
# database is no longer in".
psql_on adsecute_cont --quiet --command \
  "UPDATE integration_credentials SET access_token='plaintext-came-back' WHERE provider_connection_id = 2;" >/dev/null 2>&1 || true
for phase in fingerprint-pre migrate verify-contract; do
  run_phase "${cont_host}" "${phase}" DB_NAME=adsecute_cont \
    SYNC_CUTOVER_ATTESTATION_DIR="${cont_host}/state/attestations" \
    DEPLOY_SHA="${SECOND_SHA}" >/dev/null 2>&1 || true
done
expect_refusal "${cont_host}" fingerprint-post "hold a plaintext secret" \
  "K6 plaintext secrets reappearing refuses the continuation: the encryption outcome is re-proved, never inherited" \
  DB_NAME=adsecute_cont SYNC_CUTOVER_ATTESTATION_DIR="${cont_host}/state/attestations" \
  DEPLOY_SHA="${SECOND_SHA}" SYNC_CUTOVER_CONTINUES_FROM="${first_epoch}" || true
psql_on adsecute_cont --quiet --command \
  "UPDATE integration_credentials SET access_token='enc:v1:' || encode(sha256(convert_to(access_token,'UTF8')),'hex') WHERE access_token NOT LIKE 'enc:v1:%' AND access_token <> '' AND access_token IS NOT NULL;" >/dev/null 2>&1 || true

expect_ok "${cont_host}" fingerprint-post \
  "K7 a genuine continuation is allowed: the migration ran, changed nothing, and a prior cutover's attestation proves this exact schema on this exact database with zero plaintext secrets" \
  DB_NAME=adsecute_cont SYNC_CUTOVER_ATTESTATION_DIR="${cont_host}/state/attestations" \
  DEPLOY_SHA="${SECOND_SHA}" SYNC_CUTOVER_CONTINUES_FROM="${first_epoch}" || true

# ══ Q: quiescence has to cover writers this cutover does not manage ════════
#
# The app-side scheduler is stopped by name and the containers are stopped by
# name. Neither is the whole set of writers to the production database. A
# systemd timer on the DATABASE host runs as postgres, carries no application
# name, and connects/writes/disconnects between polls — so both the named-backend
# check and a point-in-time session count can miss it entirely.
#
# In production adsecute-db-healthcheck.timer wrote five rows into
# system_capacity_snapshots while pg_restore was loading that same table, and the
# restore died putting the primary key back. Quiescence a background writer can
# walk through is not quiescence.
seed_database adsecute_qtimer
host="$(new_host qtimer)"
mkdir -p "${host}/tmp-work"
run_phase "${host}" preflight DB_NAME=adsecute_qtimer >/dev/null 2>&1 || true
expect_refusal "${host}" quiesce "write to adsecute_qtimer between polls" \
  "Q1 an ACTIVE adsecute timer on the database host refuses quiesce, naming the unit — the writer that corrupted a production restore" \
  DB_NAME=adsecute_qtimer HARNESS_DBHOST_TIMER=adsecute-db-healthcheck.timer || true

seed_database adsecute_qtimeroff
host="$(new_host qtimeroff)"
mkdir -p "${host}/tmp-work"
run_phase "${host}" preflight DB_NAME=adsecute_qtimeroff >/dev/null 2>&1 || true
expect_ok "${host}" quiesce \
  "Q2 the same timer STOPPED lets quiesce through: the guard tracks whether it is armed, not whether the unit exists" \
  DB_NAME=adsecute_qtimeroff HARNESS_DBHOST_TIMER=adsecute-db-healthcheck.timer \
  HARNESS_DBHOST_TIMER_ACTIVE=0 || true

# ══ C: the credential generation hash may move ONLY by encryption ══════════
#
# This release's migration encrypts legacy plaintext secrets in place. That is
# the point of it, and it necessarily moves a hash taken over secret values. The
# contract used to compare the two hashes and refuse any difference, which made
# the intended conversion indistinguishable from a corrupted token — it refused
# both. Now the difference has to be EXPLAINED against a census taken before the
# migration, and only a plaintext-to-ciphertext conversion is an explanation.
#
# Every case below drives the real graph against a real database and lets the
# real wrapper decide. C1 is the one that must be allowed through; the rest are
# the ways a credential can move that must still stop the cutover dead.
credential_case() {
  local mode="$1" db="$2" hostname="$3"
  local host
  seed_database "${db}"
  host="$(new_host "${hostname}")"
  mkdir -p "${host}/tmp-work"
  for phase in preflight quiesce fingerprint-pre migrate verify-contract; do
    run_phase "${host}" "${phase}" DB_NAME="${db}" \
      HARNESS_MIGRATE_CREDENTIALS="${mode}" >/dev/null 2>&1 || true
  done
  printf '%s' "${host}"
}

host="$(credential_case encrypt adsecute_credconv credconv)"
out="$(run_phase "${host}" fingerprint-post DB_NAME=adsecute_credconv HARNESS_MIGRATE_CREDENTIALS=encrypt 2>&1)" && ok=1 || ok=0
if [ "${ok}" = "1" ] && printf '%s' "${out}" | grep -q "plaintext secret(s) became ciphertext"; then
  pass "C1 a credential hash that moved ONLY because plaintext became ciphertext is explained row by row and allowed through"
else
  fail "C1 the intended encryption was not accepted: ${out}"
fi

host="$(credential_case reencrypt adsecute_credreenc credreenc)"
expect_refusal "${host}" fingerprint-post "not a plaintext-to-ciphertext conversion" \
  "C2 an ALREADY-encrypted secret rewritten to a different ciphertext is refused: a re-encryption is not a conversion" \
  DB_NAME=adsecute_credreenc HARNESS_MIGRATE_CREDENTIALS=reencrypt || true

host="$(credential_case decrypt adsecute_creddec creddec)"
expect_refusal "${host}" fingerprint-post "not a plaintext-to-ciphertext conversion" \
  "C3 ciphertext turning back into plaintext is refused, in the direction the rule must never allow" \
  DB_NAME=adsecute_creddec HARNESS_MIGRATE_CREDENTIALS=decrypt || true

host="$(credential_case drop_row adsecute_creddrop creddrop)"
expect_refusal "${host}" fingerprint-post "did not exist before the migration" \
  "C4 a credential row swapped for a different one is refused by the census even though the row COUNT is unchanged" \
  DB_NAME=adsecute_creddrop HARNESS_MIGRATE_CREDENTIALS=drop_row || true

host="$(credential_case touch adsecute_credtouch credtouch)"
expect_refusal "${host}" fingerprint-post "changed updated_at" \
  "C5 identical secrets whose rows were nonetheless rewritten are refused: updated_at moving means something wrote them" \
  DB_NAME=adsecute_credtouch HARNESS_MIGRATE_CREDENTIALS=touch || true

host="$(credential_case mutate_plain adsecute_credplain credplain)"
expect_refusal "${host}" fingerprint-post "not a plaintext-to-ciphertext conversion" \
  "C6 a plaintext secret changed to a DIFFERENT plaintext is refused, and would leave plaintext behind" \
  DB_NAME=adsecute_credplain HARNESS_MIGRATE_CREDENTIALS=mutate_plain || true

if [ "${FAILURES}" -eq 0 ]; then
  printf '%s PASS all checks\n' "${LABEL}"
else
  printf '%s %s check(s) FAILED\n' "${LABEL}" "${FAILURES}" >&2
  exit 1
fi
