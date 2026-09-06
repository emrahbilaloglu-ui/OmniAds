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

# The strict staged-proof verifier is a REAL program that the fake container has
# to execute. run_phase deliberately sanitizes PATH down to the stub bin plus
# /usr/bin and /bin, so `node` is not resolvable by name in there: the first
# version of that check never ran the verifier at all, and its refusal said only
# "node: command not found" — a phase failing closed for a reason that had
# nothing to do with the evidence. The interpreter is resolved here, absolutely,
# and baked into the stub. A missing interpreter is a hard stop, because a
# scenario that cannot run the verifier proves nothing about it.
HARNESS_NODE_BIN="${HARNESS_NODE_BIN:-$(command -v node || true)}"
if [ -z "${HARNESS_NODE_BIN}" ] || [ ! -x "${HARNESS_NODE_BIN}" ]; then
  printf '%s FAIL node is required: this harness executes scripts/verify-staged-proof.ts for real\n' \
    "${LABEL}" >&2
  exit 1
fi

# ── Test-only diagnostics, on the failure path only ─────────────────────────
#
# cleanup() removes the fake host, and it has to: these runs create real
# PostgreSQL data directories and env files. But it also removed the strict
# verifier's field-level failure list, so a failing deploy-disabled could only
# ever be read as "the staged proof artifact did not verify" with no field named
# and nothing left on disk to name it from.
#
# This prints that list — bounded, and filtered on the same denylist the wrapper
# applies to its own diagnostics — and, when HARNESS_DIAGNOSTIC_DIR is set, also
# copies the small proof files there before cleanup runs. It is called only after
# a check has ALREADY been counted as failed; it never touches FAILURES, never
# returns anything a caller branches on, and never alters an exit status, so it
# cannot turn a failing scenario into a passing one. Production cleanup is
# unchanged: HARNESS_ROOT is still removed unconditionally.
SECRET_DENYLIST='(secret|token|password|api[_-]?key|PRIVATE KEY)'

dump_phase_diagnostics() {
  local host="$1" tag="$2"
  local dir file target
  # Two directories, because the wrapper keeps them apart: the STATE dir holds
  # the state record and the release identity, the INSTALL dir holds the proof
  # artifacts a phase produced. A dump that only knew one of them would report
  # "no diagnostics" for exactly the failure this exists to explain.
  for dir in "${host}/state/cutover" "${host}/cutover"; do
    for file in staged-proof-verify.json staged-summary.json state sync-release-identity; do
      [ -s "${dir}/${file}" ] || continue
      printf '%s      diag[%s] %s ->\n' "${LABEL}" "${tag}" "${file}" >&2
      { grep -av -E "${SECRET_DENYLIST}" "${dir}/${file}" || true; } | head -45 | sed 's/^/  | /' >&2 || true
      if [ -n "${HARNESS_DIAGNOSTIC_DIR:-}" ]; then
        mkdir -p "${HARNESS_DIAGNOSTIC_DIR}" 2>/dev/null || continue
        target="${HARNESS_DIAGNOSTIC_DIR}/${FAILURES}-${tag}.${file}"
        { grep -av -E "${SECRET_DENYLIST}" "${dir}/${file}" || true; } > "${target}" 2>/dev/null || true
        chmod 600 "${target}" 2>/dev/null || true
      fi
    done
  done
}

# Test-only: stop after a named checkpoint so a single failing scenario can be
# iterated on without the whole matrix. The exit status is still the failure
# count, and the line says plainly that this was not a full run, so stopping
# early can never be mistaken for — or reported as — a green harness.
harness_stop_after() {
  [ "${HARNESS_STOP_AFTER:-}" = "$1" ] || return 0
  if [ "${FAILURES}" -eq 0 ]; then
    printf '%s stopped after %s with 0 failures (HARNESS_STOP_AFTER: NOT a full run)\n' "${LABEL}" "$1"
    exit 0
  fi
  printf '%s stopped after %s with %s failure(s) (HARNESS_STOP_AFTER: NOT a full run)\n' \
    "${LABEL}" "$1" "${FAILURES}" >&2
  exit 1
}

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

# A LIVE write to the two tables the rollback baseline is taken over, made after
# the snapshot was exported. In production this was a user reconnecting an
# account while the dump ran: max(provider_connections.updated_at) landed
# sixteen minutes after the dump closed, and the preflight then threw a
# perfectly good 23 GiB artifact away because the restored copy did not match a
# database that had moved on.
#
# It changes `status` and `updated_at` — both are folded into
# connection_generation_hash — and INSERTS a row, which is what makes the proof
# non-vacuous without the harness having to re-implement the wrapper's hash SQL:
# the manifest's connection_count is the count under the snapshot, so if it
# still reads 2 while the live table holds 3, the baseline provably is not the
# live database.
cat > "${DBHOST_BIN}/harness-live-mutation" <<STUB
#!/usr/bin/env bash
exec "${PGBIN}/psql" -h 127.0.0.1 -p ${PGPORT} -U postgres \
  --dbname="\${DB_NAME:-adsecute_prod}" -q -v ON_ERROR_STOP=1 -c "
    UPDATE provider_connections SET status = 'revoked', updated_at = now() + interval '3 hours';
    UPDATE integration_credentials SET updated_at = now() + interval '3 hours';
    INSERT INTO provider_connections (business_id, provider, status, provider_account_id)
    VALUES ('biz-live-write', 'meta', 'connected', 'act_live_write');
  " < /dev/null
STUB

# psql, with one extra seam: a live write made BETWEEN the snapshot being
# exported and the baseline hashes being read. That window is closed by exactly
# one thing — the baselines running `SET TRANSACTION SNAPSHOT` — so it is the
# only window that can prove the import is real rather than decorative.
#
# The exporter is identified by --quiet, which snapshot_exporter_session passes
# unconditionally, and it is always the first psql to carry it: nothing before
# it in the phase is snapshot-bound. The write then fires on the NEXT psql of
# any shape, which is the first baseline read. Keying the trigger on "the next
# invocation" rather than on "the next --quiet invocation" matters: a wrapper
# that stopped importing the snapshot would also stop passing --quiet, and a
# probe that keyed on --quiet would then quietly stop injecting anything and
# report a pass it never earned.
cat > "${DBHOST_BIN}/psql" <<STUB
#!/usr/bin/env bash
if [ "\${HARNESS_MUTATE_AT:-}" = "baseline" ]; then
  started="${HARNESS_ROOT}/exporter-started.\${DB_NAME:-adsecute_prod}"
  fired="${HARNESS_ROOT}/baseline-mutated.\${DB_NAME:-adsecute_prod}"
  if [ ! -f "\${started}" ]; then
    case " \$* " in
      *" --quiet "*) : > "\${started}" ;;
    esac
  elif [ ! -f "\${fired}" ]; then
    : > "\${fired}"
    harness-live-mutation >/dev/null 2>&1 || true
  fi
fi
exec "${PGBIN}/psql" -h 127.0.0.1 -p ${PGPORT} -U postgres "\$@"
STUB

# pg_dump, with the seams a snapshot-bound backup has to be proven against: a
# dump slow enough for a signal to arrive while the exporter still holds its
# transaction, a dump that fails outright, and a live write DURING the dump.
cat > "${DBHOST_BIN}/pg_dump" <<STUB
#!/usr/bin/env bash
[ -z "\${HARNESS_PGDUMP_STALL:-}" ] || sleep "\${HARNESS_PGDUMP_STALL}"
if [ -n "\${HARNESS_PGDUMP_FAIL:-}" ]; then
  printf 'pg_dump: error: %s\n' "\${HARNESS_PGDUMP_FAIL}" >&2
  exit 1
fi
case "\${HARNESS_MUTATE_AT:-}" in
  dump | both) harness-live-mutation >/dev/null 2>&1 || exit 1 ;;
esac
exec "${PGBIN}/pg_dump" -h 127.0.0.1 -p ${PGPORT} -U postgres "\$@"
STUB

# pg_restore, with the restore WINDOW modelled: the live database can be written
# while the artifact is being read back, and the restored copy itself can come
# back wrong. Not exec'd, because the corruption has to happen after the restore
# succeeds — that is what turns "the restore completed" into "the restore
# reproduced the artifact", which is the only claim worth anything.
cat > "${DBHOST_BIN}/pg_restore" <<STUB
#!/usr/bin/env bash
case "\${HARNESS_MUTATE_AT:-}" in
  restore | both) harness-live-mutation >/dev/null 2>&1 || exit 1 ;;
esac
if [ -n "\${HARNESS_RESTORE_FAIL:-}" ]; then
  printf 'pg_restore: error: %s\n' "\${HARNESS_RESTORE_FAIL}" >&2
  exit 1
fi
# Holds the restore open while the scratch database already EXISTS, which is the
# only window in which a signal can strand a scratch copy of the database.
[ -z "\${HARNESS_RESTORE_STALL:-}" ] || sleep "\${HARNESS_RESTORE_STALL}"
"${PGBIN}/pg_restore" -h 127.0.0.1 -p ${PGPORT} -U postgres "\$@"
rc=\$?
[ "\${rc}" -eq 0 ] || exit "\${rc}"
if [ -n "\${HARNESS_CORRUPT_RESTORE:-}" ]; then
  target=""
  for arg in "\$@"; do
    case "\$arg" in --dbname=*) target="\${arg#--dbname=}" ;; esac
  done
  [ -n "\${target}" ] || exit 0
  case "\${HARNESS_CORRUPT_RESTORE}" in
    credentials) sql="DELETE FROM integration_credentials;" ;;
    assignments) sql="UPDATE provider_account_assignments SET account_ids = ARRAY['gone'];" ;;
    bindings) sql="DELETE FROM business_provider_accounts WHERE provider = 'shopify';" ;;
    *) sql="UPDATE provider_connections SET status = 'tampered';" ;;
  esac
  "${PGBIN}/psql" -h 127.0.0.1 -p ${PGPORT} -U postgres --dbname="\${target}" \
    -q -v ON_ERROR_STOP=1 -c "\${sql}" < /dev/null || exit 1
fi
exit 0
STUB

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
  # tmp-work is TMPDIR for the phase. Every scenario needs it — the wrapper
  # mktemps for the root crontab split and for the snapshot exporter's FIFOs —
  # and it used to be created ad hoc by whichever scenario happened to reach a
  # phase that needed one. A host without it fails inside `mktemp` with a
  # message about a path nobody wrote, which reads like a wrapper bug.
  mkdir -p "${host}/bin" "${host}/app" "${host}/state" "${host}/log" "${host}/cutover" "${host}/runtime" "${host}/tmp-work"

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

  # The env file a cutover is allowed to open against: every lane explicitly
  # off, which is what `rollout:disable` leaves behind and what preflight now
  # requires before it will pin env_file_sha256 for the epoch. An ABSENT switch
  # is not an off switch, so these are written out rather than omitted — a
  # fixture that omits them would only ever prove the prerequisite refuses.
  cat > "${host}/app/.env.production" <<ENVFILE
DATABASE_URL=postgresql://postgres@127.0.0.1:${PGPORT}/${DB_NAME}
NEXTAUTH_SECRET=unrelated-value
CRON_SECRET=unrelated-cron-secret
ADSECUTE_SYNC_GLOBAL_ENABLED=
ADSECUTE_SYNC_LANE_META_SYNC_ENABLED=
ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED=
ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED=
ADSECUTE_SYNC_LANE_SOURCE_INGEST_ENABLED=
ADSECUTE_SYNC_LANE_CRON_ENQUEUE_ENABLED=
ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED=
ADSECUTE_SYNC_LANE_RETENTION_ENABLED=
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

# A container id is container-SVC-gN, where N is a generation. That is what
# makes a recreate produce a NEW id, so the wrapper can ask whether the
# container it captured before the recreate is still running and get a truthful
# answer. Without it every id is eternal and container replacement is invisible.
#
# NOTE: this shim is generated through an UNQUOTED heredoc. Backticks and
# angle brackets in comments here are EXECUTED at generation time, which once
# broke the shim silently and left a digest command reading stdin forever.
# Prose only, no backticks, no redirection characters.
service_of() { s="\${1#container-}"; printf '%s' "\${s%%-g*}"; }

# Digest of an EXPLICIT existing regular file. Never stdin.
#
# The stdin fallback is what hung: a path that expanded empty made shasum wait on
# a terminal for seventeen minutes with no output and no error. Redirecting from
# /dev/null makes that impossible, and an unusable path is reported rather than
# waited on. macOS has shasum, Debian has sha256sum; both are handled because
# picking one and hoping is how a digest silently becomes empty.
shim_sha256() {
  if [ "\$#" -ne 1 ] || [ -z "\${1:-}" ]; then
    printf 'shim_sha256: needs exactly one non-empty file path\n' >&2
    return 2
  fi
  if [ ! -f "\$1" ] || [ ! -r "\$1" ]; then
    printf 'shim_sha256: not a readable regular file: %s\n' "\$1" >&2
    return 2
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "\$1" < /dev/null | awk '{print \$1}'
  else
    shasum -a 256 "\$1" < /dev/null | awk '{print \$1}'
  fi
}
generation_of() { case "\$1" in *-g*) printf '%s' "\${1##*-g}" ;; *) printf '1' ;; esac; }
current_generation() { cat "\${RUNTIME}/gen.\$1" 2>/dev/null || printf '1'; }

db_sql_via_shim() {
  printf '%s\n' "\$1" | ssh -o BatchMode=yes root@db-host \\
    "runuser -u postgres -- psql --dbname=\${DB_NAME:-adsecute_prod} -v ON_ERROR_STOP=1 --tuples-only --no-align --file=-"
}

recreate_service() {
  local svc="\$1"
  printf '%s\n' "\$(date -u +%Y-%m-%dT%H:%M:%S).000000000Z" > "\${RUNTIME}/finished.\${svc}"
  printf '%s\n' "\$(( \$(current_generation "\${svc}") + 1 ))" > "\${RUNTIME}/gen.\${svc}"
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
          printf 'container-%s-g%s\n' "\${svc}" "\$(current_generation "\${svc}")"
          exit 0
        fi
        if [ "\$2" = "--services" ]; then printf 'web\nworker\nmigrate\n'; exit 0; fi
        exit 0 ;;
      stop)
        shift
        for svc in "\$@"; do printf 'exited\n' > "\${RUNTIME}/state.\${svc}"; done
        exit 0 ;;
      rm) exit 0 ;;
      exec)
        shift
        # Drop compose's own flags, then dispatch on the program being run.
        while [ \$# -gt 0 ]; do
          case "\$1" in -T|-d|--no-TTY) shift ;; *) break ;; esac
        done
        svc="\$1"; shift
        case "\$*" in
          *sync-worker-healthcheck.ts*)
            # A recreated container has an empty /tmp, so the artifact from an
            # earlier run of this phase on this host cannot be inherited. Without
            # this, a sabotage case that writes no artifact would be verified
            # against the PREVIOUS run's file and the phase would refuse — or
            # worse, pass — for a reason unrelated to the sabotage.
            rm -f "\${RUNTIME}/incontainer/staged-summary.json"
            if [ -n "\${HARNESS_STAGED_EXEC_SILENT:-}" ]; then
              # The old behaviour: exit 0 with nothing on stdout. It must NOT pass.
              exit 0
            fi
            if [ -n "\${HARNESS_STAGED_CHECK_FAIL:-}" ]; then
              printf '{"pass":false,"reason":"staged_idle_not_observed"}\n'
              exit 1
            fi
            mkdir -p "\${RUNTIME}/incontainer"
            # The artifact must name the release under test and THIS container's
            # start time, or the verifier below would be checking a fixture
            # against itself rather than against the phase's own pins, which are
            # --expect-build-id DEPLOY_SHA and --min-heartbeat-after the value
            # docker inspect reports for State.StartedAt.
            #
            # Written with the real values, not placeholders patched afterwards:
            # this was a sed -i with no backup suffix, which is GNU-only. On BSD
            # sed the substitution expression was consumed as the suffix, the
            # edit failed, the stub has no set -e so nothing surfaced, and the
            # artifact kept its literal placeholders. Generating the values in
            # place removes the portability trap and the silent-failure path with
            # it. A staged scenario may override the build id to prove that a
            # wrong identity is refused.
            started="\$(cat "\${RUNTIME}/started.worker" 2>/dev/null || printf '2026-07-01T00:00:00.000000000Z')"
            art_build="\${HARNESS_STAGED_ARTIFACT_BUILD_ID:-\${DEPLOY_SHA}}"
            art_started="\${HARNESS_STAGED_ARTIFACT_STARTED_AT:-\${started}}"
            art_health="\${HARNESS_STAGED_ARTIFACT_HEALTH_STATE:-healthy}"
            cat > "\${RUNTIME}/incontainer/staged-summary.json" <<ART
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-01T00:06:00.000Z",
  "pass": true,
  "reason": "healthy",
  "onlineWindowMinutes": 5,
  "expectBuildId": "\${art_build}",
  "minHeartbeatAfter": "\${art_started}",
  "stagedWorkerCount": 1,
  "stagedWorkerId": "sync-worker:1:harnessstaged",
  "stagedWorkerStartedAt": "\${art_started}",
  "stagedWorkerBuildId": "\${art_build}",
  "stagedWorkerContractBuildId": "\${art_build}",
  "stagedIsThisRun": true,
  "stagedBuildIdMatches": true,
  "heartbeatSatisfied": true,
  "holdsNothing": true,
  "onlineWorkers": 0,
  "ownedWorkUnits": {
    "runnerLeases": 0,
    "googleLaneLeases": 0,
    "metaPartitionClaims": 0,
    "googlePartitionClaims": 0,
    "metaCheckpointClaims": 0,
    "googleCheckpointClaims": 0,
    "jobLocks": 0
  },
  "runtimeInstance": {
    "instanceId": "sync-worker:1:harnessstaged",
    "buildId": "\${art_build}",
    "healthState": "\${art_health}",
    "updatedAt": "2026-07-01T00:05:59.000Z"
  },
  "runtimeInstanceMatchesStaged": true
}
ART
            bytes="\$(wc -c < "\${RUNTIME}/incontainer/staged-summary.json" | tr -d ' ')"
            digest="\$(shim_sha256 "\${RUNTIME}/incontainer/staged-summary.json")" || {
              printf 'staged-summary digest failed\n' >&2
              exit 1
            }
            if [ -n "\${HARNESS_STAGED_DIGEST_LIE:-}" ]; then
              digest="0000000000000000000000000000000000000000000000000000000000000000"
            fi
            if [ -n "\${HARNESS_STAGED_NO_SUMMARY_LINE:-}" ]; then
              printf '{"pass":true,"reason":"healthy"}\n'
              exit 0
            fi
            if [ -n "\${HARNESS_STAGED_MALFORMED_SUMMARY_LINE:-}" ]; then
              # The key is present but the size and digest are not. This is the
              # case the strict pattern match exists for: a line that looks like
              # the report and carries none of the numbers it has to carry.
              printf 'summary_out=/tmp/staged-summary.json summary_bytes= summary_sha256=\n'
              printf '{"pass":true,"reason":"healthy"}\n'
              exit 0
            fi
            printf 'summary_out=/tmp/staged-summary.json summary_bytes=%s summary_sha256=%s\n' "\${bytes}" "\${digest}"
            printf '{"pass":true,"reason":"healthy"}\n'
            exit 0 ;;
          *verify-staged-proof.ts*)
            # The REAL verifier, against the artifact the phase actually copied
            # out, with the phase's own pins. Nothing is simulated here.
            summary=""; expect_build=""; min_after=""; expect_bytes=""; expect_sha=""
            while [ \$# -gt 0 ]; do
              case "\$1" in
                --summary) summary="\$2"; shift 2 ;;
                --expect-build-id) expect_build="\$2"; shift 2 ;;
                --min-heartbeat-after) min_after="\$2"; shift 2 ;;
                --expect-bytes) expect_bytes="\$2"; shift 2 ;;
                --expect-sha256) expect_sha="\$2"; shift 2 ;;
                *) shift ;;
              esac
            done
            host_copy="\${RUNTIME}/incontainer/staged-summary.json"
            [ -f "\${host_copy}" ] || { printf '{"verified":false,"failures":["no artifact"]}\n'; exit 1; }
            # Absolute interpreter, and from the repo root: PATH here is the stub
            # bin plus /usr/bin and /bin, and the tsx loader and the @/ alias both
            # resolve relative to the working directory, not to the script.
            cd "${REPO_ROOT}" || { printf '{"verified":false,"failures":["repo root unavailable"]}\n'; exit 1; }
            "${HARNESS_NODE_BIN}" --import tsx scripts/verify-staged-proof.ts \
              --summary "\${host_copy}" --expect-build-id "\${expect_build}" \
              --min-heartbeat-after "\${min_after}" \
              --expect-bytes "\${expect_bytes}" --expect-sha256 "\${expect_sha}"
            exit \$? ;;
        esac
        exit 0 ;;
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
        --format | -f) fmt="\$2"; shift 2 ;;
        -*) shift ;;
        *) [ -z "\${id}" ] && id="\$1"; shift ;;
      esac
    done
    svc="\$(service_of "\${id}")"
    case "\${fmt}" in
      '{{.State.Status}}') cat "\${RUNTIME}/state.\${svc}" 2>/dev/null || printf 'absent\n' ;;
      # Per-ID, not per-service: a container superseded by a recreate is not
      # running any more even though its service is.
      '{{.State.Running}}')
        if [ "\$(generation_of "\${id}")" != "\$(current_generation "\${svc}")" ]; then printf 'false\n';
        elif [ "\$(cat "\${RUNTIME}/state.\${svc}" 2>/dev/null)" = "running" ]; then printf 'true\n';
        else printf 'false\n'; fi ;;
      # What a container would report it is running. Deliberately a LITERAL, not
      # \${WEB_IMAGE_REPO}/\${WORKER_IMAGE_REPO} read back out of the wrapper's
      # environment: the wrapper builds its expectation from those variables, so
      # echoing them back would make this stub agree with the wrapper by
      # construction and the image-identity assertions would pass no matter what
      # namespace the wrapper had settled on. An independent literal is what
      # makes the harness able to DISAGREE, which is the only reason it is worth
      # running. It must be updated deliberately when the default namespace
      # changes -- that edit is the test.
      '{{.Config.Image}}') printf 'ghcr.io/emrahbilaloglu-ui/omniads-%s:%s\n' "\${svc}" "\${DEPLOY_SHA}" ;;
      # The immutable image id the container is actually running, which is what
      # the release-identity gate compares against. HARNESS_RUNNING_IMAGE_ID
      # lets a case start a container on an image the record does not pin.
      '{{.Image}}')
        if [ -n "\${HARNESS_RUNNING_IMAGE_ID:-}" ]; then printf '%s\n' "\${HARNESS_RUNNING_IMAGE_ID}";
        else image_id_for "omniads-\${svc}"; printf '\n'; fi ;;
      *org.opencontainers.image.revision*)
        printf '%s\n' "\${HARNESS_RUNNING_IMAGE_REVISION:-\${HARNESS_IMAGE_REVISION:-\${DEPLOY_SHA:-}}}" ;;
      '{{.State.StartedAt}}') cat "\${RUNTIME}/started.\${svc}" 2>/dev/null || printf '2026-07-01T00:00:00.000000000Z\n' ;;
      # When a superseded container exited. The post-stop retirement proof is
      # bound to this, so a stub that cannot answer it would make the wrapper
      # refuse for want of an exit time rather than exercise the proof.
      '{{.State.FinishedAt}}')
        if [ "\$(generation_of "\${id}")" != "\$(current_generation "\${svc}")" ]; then
          cat "\${RUNTIME}/finished.\${svc}" 2>/dev/null || printf '2026-07-01T00:05:00.000000000Z\n'
        else
          printf '0001-01-01T00:00:00Z\n'
        fi ;;
      *) printf '\n' ;;
    esac
    exit 0 ;;

  cp)
    shift
    src="\$1"; dest="\$2"
    case "\${src}" in
      *:/tmp/staged-summary.json)
        host_copy="\${RUNTIME}/incontainer/staged-summary.json"
        [ -f "\${host_copy}" ] || exit 1
        cp "\${host_copy}" "\${dest}" || exit 1
        if [ -n "\${HARNESS_STAGED_TRUNCATE:-}" ]; then
          # Exactly the production failure: fewer bytes arrive than were written.
          head -c 120 "\${host_copy}" > "\${dest}"
        fi
        exit 0 ;;
    esac
    exit 1 ;;

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
    # The outgoing-worker retirement runs as a one-off container from the NEW
    # image, because the tooling exists only there. The harness answers it from
    # the same RUNTIME state the rest of the stub uses, so the wrapper's
    # ordering, its refusals and its parsing are all exercised for real even
    # though no image is pulled.
    for arg in "\$@"; do
      case "\$arg" in
        capture)
          if [ -n "\${HARNESS_RETIRE_CAPTURE_FAIL:-}" ]; then exit 1; fi
          cat <<'CENSUS'
{
  "runtimeInstanceId": "sync-worker:18:harnessoutgoing",
  "buildId": "harness-old-build",
  "workerStartedAt": "2026-07-01T00:00:00.000Z",
  "capturedAt": "2026-07-01T00:00:01.000Z",
  "rows": [
    {"workerId":"sync-worker:18:harnessoutgoing","providerScope":"all","status":"stopping","lastHeartbeatAt":"2026-07-01T00:00:00.000Z"},
    {"workerId":"sync-worker:18:harnessoutgoing:meta","providerScope":"meta","status":"running","lastHeartbeatAt":"2026-07-01T00:00:00.000Z"},
    {"workerId":"sync-worker:18:harnessoutgoing:shopify","providerScope":"shopify","status":"idle","lastHeartbeatAt":"2026-07-01T00:00:00.000Z"},
    {"workerId":"sync-worker:18:harnessoutgoing:google_ads","providerScope":"google_ads","status":"idle","lastHeartbeatAt":"2026-07-01T00:00:00.000Z"}
  ]
}
CENSUS
          exit 0 ;;
        retire)
          if [ -n "\${HARNESS_RETIRE_FAIL:-}" ]; then
            printf '{"pass":false,"reason":"worker_holds_work","message":"harness: the outgoing worker still holds work"}\n'
            exit 1
          fi
          cat <<'RETIRED'
{
  "pass": true,
  "runtimeInstanceId": "sync-worker:18:harnessoutgoing",
  "retiredWorkerIds": ["sync-worker:18:harnessoutgoing:meta","sync-worker:18:harnessoutgoing:shopify","sync-worker:18:harnessoutgoing:google_ads"],
  "alreadyTerminalWorkerIds": ["sync-worker:18:harnessoutgoing"],
  "ownedWorkUnits": {"runnerLeases":0,"jobLocks":0}
}
RETIRED
          exit 0 ;;
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
  dump_phase_diagnostics "${host}" "${phase}"
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
    dump_phase_diagnostics "${host}" "${phase}"
    return 1
  fi
  if printf '%s' "${out}" | grep -q "${needle}"; then
    pass "${what}"
    return 0
  fi
  fail "${what} — phase '${phase}' refused for the wrong reason: ${out}"
  dump_phase_diagnostics "${host}" "${phase}"
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
  if [ "${#artifact_sha}" -eq 64 ] && [ -z "${artifact_sha//[0123456789abcdef]/}" ] &&
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

harness_stop_after P16

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

# ══ V: the rollback baseline is bound to ONE snapshot, and nothing leaks ═══
#
# THE BUG THIS SECTION EXISTS FOR
#
# take_verified_backup dumps the database, scratch-restores that dump about a
# hundred minutes later, and compares four hashes. It used to compare the
# restored copy against the LIVE database as it stood at comparison time, which
# can only agree if nobody wrote to provider_connections,
# integration_credentials, business_provider_accounts or
# provider_account_assignments for the whole window. A production preflight
# aborted on exactly that:
#
#   [16:13:52Z] backup artifact bytes=25113968381 sha256=98b2ba24...
#   [17:53:37Z] ABORT the restored backup does not reproduce provider_connections
#
# with max(provider_connections.updated_at) at 16:30:06 — after the dump closed.
# The artifact was correct and was thrown away.
#
# The wrapper now exports ONE snapshot, holds it open, dumps with
# `pg_dump --snapshot=<id>`, and reads the four baselines in transactions that
# `SET TRANSACTION SNAPSHOT` the same id. V2 is the production failure replayed:
# it must now pass, and it must pass for the right reason.
#
# Holding a transaction open on a 70 GB database is itself a hazard, so V4 is as
# important as V2: the exporter, the FIFOs, the temp directory and the scratch
# database must be gone on EVERY exit path.

snapshot_backends_left() {
  psql_direct --command "SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'adsecute-cutover-snap-%';" |
    tr -d '[:space:]'
}

scratch_databases_left() {
  psql_direct --command "SELECT count(*) FROM pg_database WHERE datname LIKE 'adsecute_cutover_scratch%';" |
    tr -d '[:space:]'
}

snapshot_workdirs_left() {
  find "$1/tmp-work" -maxdepth 1 -name 'cutover-snapshot.*' 2>/dev/null | wc -l | tr -d '[:space:]'
}

# A backend does not vanish the instant its client is killed, so this waits
# rather than sampling once — a race here would make the strongest assertion in
# the section the flakiest.
snapshot_backends_settled() {
  local left="" i
  for i in 1 2 3 4 5 6 7 8 9 10; do
    left="$(snapshot_backends_left)"
    [ "${left}" = "0" ] && break
    sleep 1
  done
  printf '%s' "${left}"
}

assert_no_snapshot_residue() {
  local host="$1" label="$2" backends scratches workdirs
  backends="$(snapshot_backends_settled)"
  scratches="$(scratch_databases_left)"
  workdirs="$(snapshot_workdirs_left "${host}")"
  if [ "${backends}" = "0" ] && [ "${scratches}" = "0" ] && [ "${workdirs}" = "0" ]; then
    pass "${label}"
    return 0
  fi
  fail "${label} — exporter backends left=${backends}, scratch databases left=${scratches}, exporter workdirs left=${workdirs}"
  return 1
}

# ── V1: a snapshot-bound artifact passes, and says so ──────────────────────
seed_database adsecute_snapok
host="$(new_host snapok)"
expect_ok "${host}" preflight \
  "V1 a snapshot-bound backup passes preflight against a real dump and a real scratch restore" \
  DB_NAME=adsecute_snapok || true

v1_manifest="$(awk -F= '$1=="backup_manifest_path"{print $2}' "${host}/state/cutover/state" 2>/dev/null || true)"
if [ -n "${v1_manifest}" ] && [ -s "${v1_manifest}" ]; then
  v1_snap="$(awk -F= '$1=="snapshot_id"{print $2}' "${v1_manifest}")"
  v1_source="$(awk -F= '$1=="baseline_source"{print $2}' "${v1_manifest}")"
  # `<hex>-<hex>-<n>`, the shape PostgreSQL gives an exported snapshot. Asserted
  # because an EMPTY id would make every snapshot-bound read fall back to a live
  # read that compares equal to itself — a vacuous pass is the failure mode this
  # whole section is guarding against.
  case "${v1_snap}" in
    *[!0-9A-Fa-f-]* | "") v1_shape=0 ;;
    *-*-*) v1_shape=1 ;;
    *) v1_shape=0 ;;
  esac
  if [ "${v1_source}" = "exported_snapshot" ] && [ "${v1_shape}" = "1" ]; then
    pass "V1b the manifest records the exported snapshot (${v1_snap}) the dump and the baseline both read"
  else
    fail "V1b the manifest does not name a real exported snapshot: baseline_source='${v1_source}' snapshot_id='${v1_snap}'"
  fi
else
  fail "V1b preflight recorded no backup manifest for the snapshot case"
fi
assert_no_snapshot_residue "${host}" "V4a a SUCCESSFUL preflight leaves no exporter session, no scratch database, no FIFO and no temp directory" || true

# ── V2: the production failure, replayed ───────────────────────────────────
#
# provider_connections and integration_credentials are written while the artifact
# is being restored — after the snapshot was exported, exactly as they were in
# production. The artifact was already verified against the snapshot, so this
# must not invalidate it.
seed_database adsecute_snapmut
host="$(new_host snapmut)"
expect_ok "${host}" preflight \
  "V2 a live provider_connections/integration_credentials write DURING the restore window does not invalidate the already-verified artifact" \
  DB_NAME=adsecute_snapmut HARNESS_MUTATE_AT=restore || true

v2_manifest="$(awk -F= '$1=="backup_manifest_path"{print $2}' "${host}/state/cutover/state" 2>/dev/null || true)"
v2_live_connections="$(psql_on adsecute_snapmut --command "SELECT count(*) FROM provider_connections;" | tr -d '[:space:]')"
v2_live_revoked="$(psql_on adsecute_snapmut --command "SELECT count(*) FROM provider_connections WHERE status = 'revoked';" | tr -d '[:space:]')"
v2_live_moved="$(psql_on adsecute_snapmut --command "SELECT count(*) FROM integration_credentials WHERE updated_at > now() + interval '2 hours';" | tr -d '[:space:]')"
if [ -n "${v2_manifest}" ] && [ -s "${v2_manifest}" ]; then
  v2_conn_count="$(awk -F= '$1=="connection_count"{print $2}' "${v2_manifest}")"
  v2_verified="$(awk -F= '$1=="scratch_restore_verified"{print $2}' "${v2_manifest}")"
  # NON-VACUITY, without re-implementing the wrapper's hash SQL in the test:
  # the live table now holds THREE connections, two of them 'revoked' with a
  # moved updated_at, while the manifest — read under the snapshot — still says
  # two. The baseline the artifact was judged against therefore cannot be the
  # live database, and a live-now comparison could not have matched.
  if [ "${v2_verified}" = "yes" ] && [ "${v2_conn_count}" = "2" ] &&
    [ "${v2_live_connections}" = "3" ] && [ "${v2_live_revoked}" = "2" ] && [ "${v2_live_moved}" = "2" ]; then
    pass "V2b non-vacuous: the live database moved under the restore (3 connections, 2 revoked, 2 credentials re-stamped) while the verified baseline still describes the snapshot's 2 connections"
  else
    fail "V2b the mutation did not actually diverge the live database from the baseline: manifest connection_count=${v2_conn_count} verified=${v2_verified}; live connections=${v2_live_connections} revoked=${v2_live_revoked} credentials_moved=${v2_live_moved}"
  fi
else
  fail "V2b the mutated run recorded no backup manifest"
fi

# The same write, made DURING the dump rather than during the restore. pg_dump
# is attached to the exported snapshot, so the artifact must not contain it
# either.
seed_database adsecute_snapmutdump
host="$(new_host snapmutdump)"
expect_ok "${host}" preflight \
  "V2c a live write DURING the dump is invisible to a snapshot-attached pg_dump, so the artifact still verifies" \
  DB_NAME=adsecute_snapmutdump HARNESS_MUTATE_AT=dump || true

# The same write again, this time landing between the snapshot being exported
# and the baseline hashes being read. Only an actual `SET TRANSACTION SNAPSHOT`
# closes this window: a baseline that read live rows would see this write, the
# snapshot-attached dump would not, and the restore would be refused for a
# divergence the artifact is not responsible for.
seed_database adsecute_snapmutbase
host="$(new_host snapmutbase)"
expect_ok "${host}" preflight \
  "V2d a live write between the snapshot export and the baseline read is invisible to the baseline, because the baseline IMPORTS the snapshot rather than reading live rows" \
  DB_NAME=adsecute_snapmutbase HARNESS_MUTATE_AT=baseline || true

v2d_manifest="$(awk -F= '$1=="backup_manifest_path"{print $2}' "${host}/state/cutover/state" 2>/dev/null || true)"
v2d_conn_count="$(awk -F= '$1=="connection_count"{print $2}' "${v2d_manifest}" 2>/dev/null || true)"
v2d_live="$(psql_on adsecute_snapmutbase --command "SELECT count(*) FROM provider_connections;" | tr -d '[:space:]')"
if [ "${v2d_conn_count}" = "2" ] && [ "${v2d_live}" = "3" ]; then
  pass "V2d-b non-vacuous: the write really landed before the baseline was read (live now holds 3 connections) and the baseline still recorded the snapshot's 2"
else
  fail "V2d-b the pre-baseline write did not diverge live from the baseline: manifest connection_count=${v2d_conn_count} live=${v2d_live}"
fi

# ── V3: a restored dataset that is not what the artifact held must refuse ───
seed_database adsecute_snapcorrupt
host="$(new_host snapcorrupt)"
expect_refusal "${host}" preflight "does not reproduce provider_connections" \
  "V3a a restored copy whose provider_connections came back different refuses closed" \
  DB_NAME=adsecute_snapcorrupt HARNESS_CORRUPT_RESTORE=connections || true
assert_no_snapshot_residue "${host}" "V4b a preflight that REFUSED at the comparison leaves no exporter session, no scratch database and no temp directory" || true

seed_database adsecute_snapmissing
host="$(new_host snapmissing)"
expect_refusal "${host}" preflight "does not reproduce integration_credentials" \
  "V3b a restored copy that is MISSING integration_credentials rows refuses closed" \
  DB_NAME=adsecute_snapmissing HARNESS_CORRUPT_RESTORE=credentials || true

seed_database adsecute_snapbindings
host="$(new_host snapbindings)"
expect_refusal "${host}" preflight "does not reproduce the selected-binding set" \
  "V3c a restored copy missing an identity binding refuses closed" \
  DB_NAME=adsecute_snapbindings HARNESS_CORRUPT_RESTORE=bindings || true

seed_database adsecute_snaprestfail
host="$(new_host snaprestfail)"
expect_refusal "${host}" preflight "could NOT be restored" \
  "V3d a restore that fails outright refuses: an unrestorable artifact is not a rollback" \
  DB_NAME=adsecute_snaprestfail HARNESS_RESTORE_FAIL="damaged archive" || true
assert_no_snapshot_residue "${host}" "V4c a FAILED restore drops the scratch database it created and releases the exporter" || true

# ── V4: the exporter cannot outlive the run that opened it ─────────────────
#
# A pg_dump that fails leaves the wrapper holding an open REPEATABLE READ
# transaction on a 70 GB database. This is the `die` path.
seed_database adsecute_snapdumpfail
host="$(new_host snapdumpfail)"
expect_refusal "${host}" preflight "pg_dump failed" \
  "V4d a pg_dump that fails while the exporter is open still refuses, and does not migrate" \
  DB_NAME=adsecute_snapdumpfail HARNESS_PGDUMP_FAIL="connection to server was lost" || true
assert_no_snapshot_residue "${host}" "V4e the die path released the exporter transaction, the FIFOs and the temp directory" || true

# An old pg_dump has no --snapshot at all. It must be named for what it is, and
# it must NOT quietly fall back to the comparison that caused the outage.
seed_database adsecute_snapunsupported
host="$(new_host snapunsupported)"
expect_refusal "${host}" preflight "does not support --snapshot" \
  "V4f a pg_dump without --snapshot refuses with that diagnosis instead of falling back to a live-now comparison" \
  DB_NAME=adsecute_snapunsupported HARNESS_PGDUMP_FAIL='unrecognized option "--snapshot"' || true
assert_no_snapshot_residue "${host}" "V4g the unsupported-pg_dump refusal leaves nothing behind either" || true

# A SIGNAL, delivered while the dump is running and the exporter is holding its
# transaction. Run inline rather than through run_phase so that $! is the
# wrapper's own shell and the signal reaches it rather than a subshell.
seed_database adsecute_snapsignal
host="$(new_host snapsignal)"
env -i \
  PATH="${host}/bin:/usr/bin:/bin" HOME="${host}" TMPDIR="${host}/tmp-work" \
  DEPLOY_SHA="${DEPLOY_SHA}" DB_NAME=adsecute_snapsignal REMOTE_APP_DIR="${host}/app" \
  SYNC_CUTOVER_STATE_DIR="${host}/state/cutover" SYNC_CUTOVER_INSTALL_DIR="${host}/cutover" \
  SYNC_CUTOVER_DRAIN_SECONDS=0 SYNC_CUTOVER_DB_SSH="root@db-host" \
  SYNC_CUTOVER_BACKUP_ROOT="${APPHOST_BACKUPS}" SYNC_CUTOVER_SCHEDULER="rootcron" \
  HARNESS_PGDUMP_STALL=6 \
  bash "${WRAPPER}" preflight > "${host}/signal.out" 2>&1 &
SIGNAL_WRAPPER_PID=$!
signal_armed=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if [ "$(snapshot_backends_left)" != "0" ]; then signal_armed=1; break; fi
  sleep 1
done
if [ "${signal_armed}" = "1" ]; then
  kill -TERM "${SIGNAL_WRAPPER_PID}" 2>/dev/null || true
  wait "${SIGNAL_WRAPPER_PID}" 2>/dev/null || true
  assert_no_snapshot_residue "${host}" "V4h a SIGTERM while the exporter holds its transaction releases it, drops the FIFOs and removes the temp directory" || true
else
  kill -TERM "${SIGNAL_WRAPPER_PID}" 2>/dev/null || true
  wait "${SIGNAL_WRAPPER_PID}" 2>/dev/null || true
  fail "V4h the exporter session never appeared in pg_stat_activity, so the signal case proved nothing: $(cat "${host}/signal.out" 2>/dev/null)"
fi

# The same signal, delivered later: during the RESTORE, when the scratch
# database already exists. This is the only window in which a signal can strand
# a full scratch copy of the database on the DB host's data directory, which is
# the filesystem the capacity gate exists to protect.
seed_database adsecute_snapsigrestore
host="$(new_host snapsigrestore)"
env -i \
  PATH="${host}/bin:/usr/bin:/bin" HOME="${host}" TMPDIR="${host}/tmp-work" \
  DEPLOY_SHA="${DEPLOY_SHA}" DB_NAME=adsecute_snapsigrestore REMOTE_APP_DIR="${host}/app" \
  SYNC_CUTOVER_STATE_DIR="${host}/state/cutover" SYNC_CUTOVER_INSTALL_DIR="${host}/cutover" \
  SYNC_CUTOVER_DRAIN_SECONDS=0 SYNC_CUTOVER_DB_SSH="root@db-host" \
  SYNC_CUTOVER_BACKUP_ROOT="${APPHOST_BACKUPS}" SYNC_CUTOVER_SCHEDULER="rootcron" \
  HARNESS_RESTORE_STALL=8 \
  bash "${WRAPPER}" preflight > "${host}/signal-restore.out" 2>&1 &
RESTORE_WRAPPER_PID=$!
restore_armed=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if [ "$(scratch_databases_left)" != "0" ]; then restore_armed=1; break; fi
  sleep 1
done
kill -TERM "${RESTORE_WRAPPER_PID}" 2>/dev/null || true
wait "${RESTORE_WRAPPER_PID}" 2>/dev/null || true
if [ "${restore_armed}" = "1" ]; then
  assert_no_snapshot_residue "${host}" "V4l a SIGTERM during the scratch RESTORE drops the scratch database it had already created" || true
else
  fail "V4l the scratch database never appeared, so the restore-window signal case proved nothing: $(cat "${host}/signal-restore.out" 2>/dev/null)"
fi

# SIGKILL: no trap can run, so this is the one case that rests entirely on the
# FIFO. The exporter reads its script from a FIFO the wrapper holds open; when
# the wrapper dies the write end closes, psql reads EOF and exits, and the
# transaction ends with it. Nothing on the app host can clean up after SIGKILL,
# so the temp directory IS left behind — and the next run sweeps it, which is
# what the second half of this case asserts.
seed_database adsecute_snapkill
host="$(new_host snapkill)"
env -i \
  PATH="${host}/bin:/usr/bin:/bin" HOME="${host}" TMPDIR="${host}/tmp-work" \
  DEPLOY_SHA="${DEPLOY_SHA}" DB_NAME=adsecute_snapkill REMOTE_APP_DIR="${host}/app" \
  SYNC_CUTOVER_STATE_DIR="${host}/state/cutover" SYNC_CUTOVER_INSTALL_DIR="${host}/cutover" \
  SYNC_CUTOVER_DRAIN_SECONDS=0 SYNC_CUTOVER_DB_SSH="root@db-host" \
  SYNC_CUTOVER_BACKUP_ROOT="${APPHOST_BACKUPS}" SYNC_CUTOVER_SCHEDULER="rootcron" \
  HARNESS_PGDUMP_STALL=6 \
  bash "${WRAPPER}" preflight > "${host}/kill.out" 2>&1 &
KILL_WRAPPER_PID=$!
kill_armed=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do
  if [ "$(snapshot_backends_left)" != "0" ]; then kill_armed=1; break; fi
  sleep 1
done
kill -KILL "${KILL_WRAPPER_PID}" 2>/dev/null || true
wait "${KILL_WRAPPER_PID}" 2>/dev/null || true
if [ "${kill_armed}" = "1" ]; then
  kill_left="$(snapshot_backends_settled)"
  if [ "${kill_left}" = "0" ]; then
    pass "V4i a kill -9 of the wrapper — where no trap can run — still ends the exporter's transaction, because the FIFO write end dies with the process"
  else
    fail "V4i ${kill_left} exporter session(s) survived a kill -9 of the wrapper; an abandoned REPEATABLE READ transaction pins the xmin horizon"
  fi
  # The residue SIGKILL necessarily leaves, and the sweep that heals it.
  kill_workdirs="$(snapshot_workdirs_left "${host}")"
  expect_ok "${host}" preflight \
    "V4j the next run sweeps the exporter directory a kill -9 left behind (${kill_workdirs} before) and completes normally" \
    DB_NAME=adsecute_snapkill || true
  assert_no_snapshot_residue "${host}" "V4k after that run nothing is left on either host" || true
else
  fail "V4i the exporter session never appeared, so the kill -9 case proved nothing: $(cat "${host}/kill.out" 2>/dev/null)"
fi

# ── V5: the split-host seam ────────────────────────────────────────────────
#
# Everything above has to have travelled over the ssh shim. The app host has no
# PostgreSQL client at all — psql, pg_dump and runuser there are traps that log
# and exit 127 — so a snapshot feature that quietly reached for a local socket
# would be talking to the wrong machine, and on production there is no database
# on that machine to talk to.
seed_database adsecute_snapseam
host="$(new_host snapseam)"
expect_ok "${host}" preflight \
  "V5 the snapshot-bound backup completes with PostgreSQL reachable ONLY over the ssh shim" \
  DB_NAME=adsecute_snapseam || true

seam_manifest="$(awk -F= '$1=="backup_manifest_path"{print $2}' "${host}/state/cutover/state" 2>/dev/null || true)"
seam_snap="$(awk -F= '$1=="snapshot_id"{print $2}' "${seam_manifest}" 2>/dev/null || true)"
seam_dump_line="$(grep -c -- "--snapshot=${seam_snap}" "${host}/log/ssh" 2>/dev/null || true)"
seam_exporter_line="$(grep -c 'psql --dbname=adsecute_snapseam --quiet' "${host}/log/ssh" 2>/dev/null || true)"
seam_local_db=0
[ -s "${host}/log/local-db" ] && seam_local_db=1
if [ -n "${seam_snap}" ] && [ "${seam_dump_line}" -ge 1 ] &&
  [ "${seam_exporter_line}" -ge 2 ] && [ "${seam_local_db}" = "0" ]; then
  pass "V5b the seam is real: the exporter session and every snapshot-bound read crossed the ssh shim (${seam_exporter_line} invocations), pg_dump carried --snapshot=${seam_snap} across it, and the app host's psql/pg_dump/runuser were never touched"
else
  fail "V5b the snapshot path did not stay on the DB-host seam: snapshot=${seam_snap} dump_lines=${seam_dump_line} exporter_lines=${seam_exporter_line} local_db_touched=${seam_local_db}"
fi

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
  local host phase out rc
  seed_database "${db}" || return $?
  host="$(new_host "${hostname}")" || return $?
  mkdir -p "${host}/tmp-work" || return $?
  for phase in preflight quiesce fingerprint-pre migrate verify-contract; do
    # A failed prerequisite is not a census refusal. Keep its actual diagnosis
    # and stop here: swallowing it made fingerprint-post report only an empty
    # phase chain, after the error that caused it had already been discarded.
    if out="$(run_phase "${host}" "${phase}" DB_NAME="${db}" \
      HARNESS_MIGRATE_CREDENTIALS="${mode}")"; then
      :
    else
      rc=$?
      fail "credential case '${mode}' prerequisite '${phase}' failed (exit ${rc}): ${out}"
      dump_phase_diagnostics "${host}" "credential-${mode}-${phase}"
      return "${rc}"
    fi
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

# ══ E: the staged proof EVIDENCE, end to end ═══════════════════════════════
#
# A rehearsal once reported PASSED while its own extraction had failed: the
# verbose health payload passed 64 KiB, the shell capture truncated it, the JSON
# parse raised, the staged worker id came out empty, the next command ran against
# a fallthrough path, and the verdict stood on the checker's exit code alone.
#
# deploy-disabled therefore does not accept an exit code as evidence. It reads a
# BOUNDED artifact out of the container, checks the byte count and digest the
# writer declared, and hands the file to a separate strict verifier that exits
# nonzero. These cases exercise that chain for real — the verifier below is
# scripts/verify-staged-proof.ts itself, not a stand-in — and then break it one
# link at a time. Every break must refuse, and must refuse for its own reason.
seed_database adsecute_evidence
host="$(new_host evidence)"
mkdir -p "${host}/tmp-work"
for phase in preflight quiesce fingerprint-pre migrate verify-contract fingerprint-post; do
  run_phase "${host}" "${phase}" DB_NAME=adsecute_evidence >/dev/null 2>&1 || true
done

expect_ok "${host}" deploy-disabled \
  "E1 deploy-disabled runs the whole evidence chain: the staged check writes a compact artifact, the phase copies it out of the container, the declared bytes and digest agree, and the strict verifier accepts it" \
  DB_NAME=adsecute_evidence || true

evidence_report="${host}/cutover/staged-proof-verify.json"
evidence_artifact="${host}/cutover/staged-summary.json"

# The verifier RAN. Its report is a machine-readable document of its own making,
# and the byte count in it is the count of the file the phase actually copied.
# This is the check that would have caught the version of this harness whose
# verifier could not start at all: PATH inside the phase is sanitized, `node` was
# not resolvable, and the refusal read "node: command not found" — a phase
# failing closed on the absence of an interpreter while appearing to fail closed
# on the evidence.
evidence_bytes="$(sed -n 's/.*"bytes": \([0-9]*\).*/\1/p' "${evidence_report}" 2>/dev/null | head -1)"
if [ -s "${evidence_report}" ] &&
  grep -q '"verified": true' "${evidence_report}" &&
  grep -q '"failures": \[\]' "${evidence_report}" &&
  [ -n "${evidence_bytes}" ] &&
  [ "${evidence_bytes}" = "$(wc -c < "${evidence_artifact}" | tr -d ' ')" ]; then
  pass "E2 the strict verifier really executed: its own report says verified with no failures over exactly the ${evidence_bytes} bytes the phase copied out"
else
  fail "E2 the verifier did not produce a report of the copied artifact: $(head -5 "${evidence_report}" 2>/dev/null)"
fi

# The artifact names the release under test and this container's start time.
# A fixture that still carried its placeholders would be verified against
# itself: `sed -i` with no backup suffix is GNU-only, on BSD sed the expression
# was consumed as the suffix, the edit failed, and — the stub having no `set -e`
# — the literal placeholders survived into the artifact unnoticed.
if grep -q "\"stagedWorkerBuildId\": \"${DEPLOY_SHA}\"" "${evidence_artifact}" &&
  grep -q "\"buildId\": \"${DEPLOY_SHA}\"" "${evidence_artifact}" &&
  ! grep -q 'HARNESS_' "${evidence_artifact}"; then
  pass "E3 the artifact is bound to the pinned release and carries no unsubstituted placeholder, so the verifier compared it against the phase's own pins"
else
  fail "E3 the artifact does not name ${DEPLOY_SHA} or still holds a placeholder: $(cat "${evidence_artifact}")"
fi

# ── Now break each link ────────────────────────────────────────────────────

# THE ORIGINAL FAILURE MODE: exec exits 0 and prints nothing at all.
expect_refusal "${host}" deploy-disabled "the healthcheck produced NO output at all" \
  "E4 a staged check that exits 0 with NO output cannot pass: silence is not a verdict, and the phase says so instead of proceeding" \
  DB_NAME=adsecute_evidence HARNESS_STAGED_EXEC_SILENT=1 || true

# Output, a passing verdict, but no report of the artifact it wrote.
expect_refusal "${host}" deploy-disabled "the worker did not come up staged" \
  "E5 a staged check that claims pass but never reports its artifact's size and digest is not accepted, however healthy its JSON looks" \
  DB_NAME=adsecute_evidence HARNESS_STAGED_NO_SUMMARY_LINE=1 || true

# The report line is present in shape and empty of numbers.
expect_refusal "${host}" deploy-disabled "did not report its artifact's size and digest" \
  "E6 a size/digest report with the key present and the numbers missing is refused by the strict pattern rather than read as zero" \
  DB_NAME=adsecute_evidence HARNESS_STAGED_MALFORMED_SUMMARY_LINE=1 || true

# The artifact is never written, so there is nothing to copy out.
expect_refusal "${host}" deploy-disabled "did not come up staged" \
  "E7 a staged check whose predicate genuinely fails refuses at the predicate, before any artifact is read, and prints its reason code" \
  DB_NAME=adsecute_evidence HARNESS_STAGED_CHECK_FAIL=1 || true

# THE 64 KiB INCIDENT, in the small: fewer bytes arrive than were written.
expect_refusal "${host}" deploy-disabled "the staged proof artifact is truncated" \
  "E8 an artifact truncated in transit is caught by the byte count the writer declared, which is the failure that once slipped through as PASSED" \
  DB_NAME=adsecute_evidence HARNESS_STAGED_TRUNCATE=1 || true

# Right length, wrong content: only the digest can see this.
expect_refusal "${host}" deploy-disabled "the staged proof artifact did not verify" \
  "E9 an artifact whose declared digest does not match its bytes is refused, so a same-length substitution cannot pass the byte count" \
  DB_NAME=adsecute_evidence HARNESS_STAGED_DIGEST_LIE=1 || true

if grep -q 'does not match the writer' "${evidence_report}" 2>/dev/null; then
  pass "E10 and the refusal names the field: the preserved verifier payload states the digest disagreement rather than only that something failed"
else
  fail "E10 the verifier payload did not name the digest mismatch: $(head -8 "${evidence_report}" 2>/dev/null)"
fi

# A well-formed, intact artifact that proves the WRONG release. Bytes and digest
# agree, so only the identity pins can refuse it — which is the whole reason the
# verifier takes --expect-build-id rather than trusting the document.
expect_refusal "${host}" deploy-disabled "the staged proof artifact did not verify" \
  "E11 an intact artifact naming a DIFFERENT build is refused: a proof that some worker staged is not a proof that this release staged" \
  DB_NAME=adsecute_evidence \
  HARNESS_STAGED_ARTIFACT_BUILD_ID=8de30c461c51d3e76e7cd5cc4fb71984751d014e || true

if grep -q 'stagedWorkerBuildId' "${evidence_report}" 2>/dev/null &&
  grep -q 'runtimeInstance.buildId' "${evidence_report}" 2>/dev/null; then
  pass "E12 both identity paths are named in the refusal: the heartbeat metadata and the runtime row are checked separately, so a proof quoting only one cannot pass"
else
  fail "E12 the verifier payload did not name the build mismatch: $(head -12 "${evidence_report}" 2>/dev/null)"
fi

# A start time from before this container existed: the previous process's
# registration, which is exactly what --min-heartbeat-after exists to exclude.
expect_refusal "${host}" deploy-disabled "the staged proof artifact did not verify" \
  "E13 an artifact whose staged worker started BEFORE this container is refused, so an old process's registration cannot stand in for this run's" \
  DB_NAME=adsecute_evidence \
  HARNESS_STAGED_ARTIFACT_STARTED_AT=2026-06-01T00:00:00.000000000Z || true

if grep -q 'precedes the container start' "${evidence_report}" 2>/dev/null; then
  pass "E14 and the refusal names the run boundary it violated"
else
  fail "E14 the verifier payload did not name the start-time violation: $(head -12 "${evidence_report}" 2>/dev/null)"
fi

# THE REJECTED ALTERNATIVE. `health_state` is binary in this schema: the CHECK
# admits 'healthy' and 'invalid', one reader collapses everything that is not
# 'healthy' to 'invalid', and production holds no third value. A writer emitting
# 'staged' was writing a value no consumer distinguished and the constraint never
# admitted. Widening the column was considered and rejected on that evidence, so
# a runtime row carrying a third value must be refused here rather than absorbed.
expect_refusal "${host}" deploy-disabled "the staged proof artifact did not verify" \
  "E15 a runtime row whose health_state is 'staged' is refused: the column is binary, no reader distinguishes a third value, and a proof resting on one is not a proof" \
  DB_NAME=adsecute_evidence HARNESS_STAGED_ARTIFACT_HEALTH_STATE=staged || true

if grep -q 'healthState' "${evidence_report}" 2>/dev/null &&
  grep -q 'binary' "${evidence_report}" 2>/dev/null; then
  pass "E16 and the refusal explains the contract: staging is proven by the disabled/all heartbeat and the run identity, not by inventing a health value"
else
  fail "E16 the verifier payload did not name the health_state contract: $(head -12 "${evidence_report}" 2>/dev/null)"
fi

expect_refusal "${host}" deploy-disabled "the staged proof artifact did not verify" \
  "E17 a runtime row reading 'invalid' is refused too, so the binary model is enforced in both directions rather than only against unknown values" \
  DB_NAME=adsecute_evidence HARNESS_STAGED_ARTIFACT_HEALTH_STATE=invalid || true

# And the chain still works afterwards: none of the sabotage above left the host
# in a state where a correct deploy-disabled can no longer prove itself.
expect_ok "${host}" deploy-disabled \
  "E18 after every one of those refusals a correct deploy-disabled still proves itself, so the evidence chain refuses without wedging the cutover" \
  DB_NAME=adsecute_evidence || true

if [ "${FAILURES}" -eq 0 ]; then
  printf '%s PASS all checks\n' "${LABEL}"
else
  printf '%s %s check(s) FAILED\n' "${LABEL}" "${FAILURES}" >&2
  exit 1
fi
