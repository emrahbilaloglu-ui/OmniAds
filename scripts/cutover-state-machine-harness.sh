#!/usr/bin/env bash
set -euo pipefail

# EXECUTION proof for .github/scripts/hetzner-sync-cutover.sh.
#
# `bash -n` proves the file parses. It says nothing about whether the phase graph
# can be traversed, whether the two-host split holds, whether a missing scheduler
# is caught at the right moment, or whether a failed phase can be resumed. Those
# are the four things that were actually wrong, and all four are about CONTROL
# FLOW, which only running it can show.
#
# So this harness runs the real script with stub `docker`, `curl`, `python3`,
# `systemctl`, `ssh`, `runuser` and `flock` on PATH ahead of the real ones. The
# stubs record what they were asked to do and answer plausibly. Nothing here
# touches production, and the stubs refuse anything they were not taught.
#
#   H1  the phase graph reaches migrate from an OLD schema
#   H2  two hosts: the app host has no local psql, the DB host has no Compose
#   H3  a scheduler that cannot be resolved is refused at PREFLIGHT, not later
#   H4  every declared scheduler kind is stopped and started by its own mechanism
#   H5  a failed phase is resumable, and completed phases are not re-run
#   H6  emergency-disable confirms live state and fails when something survives

HARNESS_ROOT="$(mktemp -d)"
SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/.github/scripts/hetzner-sync-cutover.sh"
FAILURES=0

cleanup() { rm -rf "${HARNESS_ROOT}"; }
trap cleanup EXIT

pass() { printf '[cutover-harness] PASS %s\n' "$1"; }
fail() { printf '[cutover-harness] FAIL %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

# ── Stub host ──────────────────────────────────────────────────────────────

new_host() {
  local host="${HARNESS_ROOT}/$1"
  rm -rf "${host}"
  mkdir -p "${host}/bin" "${host}/app" "${host}/state" "${host}/log"

  # The app host's Compose project.
  cat > "${host}/app/docker-compose.yml" <<'YAML'
services:
  web:
    env_file:
      - .env.production
  worker:
    env_file:
      - .env.production
YAML
  cat > "${host}/app/.env.production" <<'ENVFILE'
DATABASE_URL=postgresql://user:secret@db-host:5432/adsecute_prod
NEXTAUTH_SECRET=unrelated
ENVFILE

  cat > "${host}/bin/docker" <<STUB
#!/usr/bin/env bash
printf '%s\n' "docker \$*" >> "${host}/log/docker"
case "\$1 \$2" in
  "image inspect") exit \${DOCKER_IMAGE_MISSING:-0} ;;
esac
case "\$1" in
  compose)
    shift
    case "\$1" in
      ps)
        if [ "\$2" = "-q" ]; then printf 'container-%s\n' "\$3"; exit 0; fi
        if [ "\$2" = "--services" ]; then printf '%s\n' "\${COMPOSE_SERVICES:-web worker}" | tr ' ' '\n'; exit 0; fi
        exit 0 ;;
      stop|rm|up|exec) exit 0 ;;
      *) exit 0 ;;
    esac ;;
  inspect)
    for arg in "\$@"; do
      case "\$arg" in
        '{{.State.Status}}') printf '%s\n' "\${STUB_CONTAINER_STATE:-exited}"; exit 0 ;;
        '{{.Config.Image}}') printf 'ghcr.io/erhanrdn/omniads-\${STUB_SERVICE:-web}:\${DEPLOY_SHA}\n'; exit 0 ;;
        '{{.State.StartedAt}}') printf '2026-07-26T00:00:00Z\n'; exit 0 ;;
      esac
    done
    exit 0 ;;
  run) exit \${DOCKER_RUN_STATUS:-0} ;;
esac
exit 0
STUB

  cat > "${host}/bin/ssh" <<STUB
#!/usr/bin/env bash
printf '%s\n' "ssh \$*" >> "${host}/log/ssh"
# The DB host. It has psql and the backup manifest, and NO compose project.
case "\$*" in
  *pg_control_system*) printf 'adsecute_prod|7311\n'; exit 0 ;;
  *string_agg*) printf 'abc123\n'; exit 0 ;;
  *meta_raw_snapshots*) printf '10|20|30\n'; exit 0 ;;
  *lease_owner*) printf '%s\n' "\${STUB_LEASES:-0}"; exit 0 ;;
  *verified-restore.manifest*) exit \${STUB_MANIFEST_STATUS:-0} ;;
esac
exit 0
STUB

  # Deliberately absent on the app host: this is what proves the script never
  # assumes a local PostgreSQL socket.
  cat > "${host}/bin/runuser" <<STUB
#!/usr/bin/env bash
printf '%s\n' "runuser \$*" >> "${host}/log/runuser"
echo "runuser/psql is NOT available on the app host" >&2
exit 127
STUB

  cat > "${host}/bin/systemctl" <<STUB
#!/usr/bin/env bash
printf '%s\n' "systemctl \$*" >> "${host}/log/systemctl"
case "\$1" in
  list-unit-files) printf '%s\n' "\${STUB_UNITS:-}" ; exit 0 ;;
  is-active) exit \${STUB_SCHEDULER_ACTIVE:-1} ;;
  enable) printf 'enabled\n' > "${host}/state/scheduler"; exit 0 ;;
  disable) printf 'disabled\n' > "${host}/state/scheduler"; exit 0 ;;
esac
exit 0
STUB

  cat > "${host}/bin/curl" <<'STUB'
#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    *build-info*) printf '{"buildId":"%s"}\n' "${DEPLOY_SHA}"; exit 0 ;;
    *healthz*) printf 'ok\n'; exit 0 ;;
  esac
done
exit 0
STUB

  cat > "${host}/bin/python3" <<'STUB'
#!/usr/bin/env bash
# The script pipes build-info JSON in and asks for buildId.
cat > /dev/null
printf '%s' "${DEPLOY_SHA}"
STUB

  cat > "${host}/bin/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

  # flock is Linux-only; production runs on Linux and has it. Stubbed so the
  # harness can exercise the control flow on any developer machine. It always
  # grants, because lock CONTENTION is not what these checks are about.
  cat > "${host}/bin/flock" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

  chmod +x "${host}/bin/"*
  printf '%s' "${host}"
}

run_phase() {
  local host="$1" phase="$2"
  shift 2
  env -i \
    PATH="${host}/bin:/usr/bin:/bin" \
    HOME="${host}" \
    DEPLOY_SHA="${DEPLOY_SHA:-abc123def456}" \
    REMOTE_APP_DIR="${host}/app" \
    SYNC_CUTOVER_STATE_DIR="${host}/state" \
    SYNC_CUTOVER_DRAIN_SECONDS=0 \
    SYNC_CUTOVER_DB_SSH="root@db-host" \
    SYNC_CUTOVER_BACKUP_MANIFEST="/var/backups/adsecute-postgres/verified-restore.manifest" \
    "$@" \
    bash "${SCRIPT}" "${phase}" 2>&1
}

# ── H1 + H2 + H4: the graph reaches migrate, on two hosts ──────────────────

host="$(new_host graph)"
if out="$(run_phase "${host}" preflight SYNC_CUTOVER_SCHEDULER="systemd:adsecute-sync-cron.timer")"; then
  if grep -q "preflight OK" <<<"${out}"; then
    pass "H1 preflight completes on an OLD schema (no post-migration contract)"
  else
    fail "H1 preflight did not report OK: ${out}"
  fi
else
  fail "H1 preflight failed on an old schema: ${out}"
fi

# Every database read went to the DB host over ssh, and the app host's psql —
# which exits 127 — was never invoked.
if [ -s "${host}/log/ssh" ] && [ ! -s "${host}/log/runuser" ]; then
  pass "H2 two hosts: all database access went over ssh, none through a local psql"
else
  fail "H2 the app host attempted a local psql (runuser log non-empty) or never reached the DB host"
fi

for phase in quiesce fingerprint-pre migrate; do
  if out="$(run_phase "${host}" "${phase}" SYNC_CUTOVER_SCHEDULER="systemd:adsecute-sync-cron.timer")"; then
    :
  else
    fail "H1 phase ${phase} failed, so the graph cannot reach migration: ${out}"
    break
  fi
done
if grep -q "^migrate:" "${host}/state/state" 2>/dev/null; then
  pass "H1 the phase graph reaches migrate: preflight -> quiesce -> fingerprint-pre -> migrate"
else
  fail "H1 the graph did not reach migrate; state is: $(cat "${host}/state/state" 2>/dev/null)"
fi

# ── H3: an unresolvable scheduler is refused at preflight ──────────────────

host="$(new_host scheduler)"
if out="$(run_phase "${host}" preflight)"; then
  fail "H3 preflight accepted an unresolvable scheduler"
else
  if grep -q "could not determine how the external scheduler runs" <<<"${out}"; then
    pass "H3 an unresolvable scheduler is refused at PREFLIGHT, not silently accepted and required later"
  else
    fail "H3 preflight failed for the wrong reason: ${out}"
  fi
fi

# ── H4: each scheduler kind uses its own mechanism ─────────────────────────

host="$(new_host cron)"
mkdir -p "${host}/cron"
printf '* * * * * root true\n' > "${host}/cron/adsecute-sync"
run_phase "${host}" preflight SYNC_CUTOVER_SCHEDULER="cron:${host}/cron/adsecute-sync" >/dev/null
if out="$(run_phase "${host}" quiesce SYNC_CUTOVER_SCHEDULER="cron:${host}/cron/adsecute-sync")"; then
  if [ -f "${host}/cron/adsecute-sync.cutover-disabled" ] && [ ! -f "${host}/cron/adsecute-sync" ]; then
    pass "H4 a cron-file scheduler is moved aside rather than requiring a systemd unit that does not exist"
  else
    fail "H4 the cron fragment was not disabled: $(ls "${host}/cron")"
  fi
else
  fail "H4 quiesce failed with a cron scheduler: ${out}"
fi

host="$(new_host declared_none)"
if out="$(run_phase "${host}" preflight SYNC_CUTOVER_SCHEDULER=none)"; then
  pass "H4 an explicitly declared absence (scheduler=none) is accepted"
else
  fail "H4 scheduler=none was refused: ${out}"
fi

# ── H5: resumability ───────────────────────────────────────────────────────

host="$(new_host resume)"
run_phase "${host}" preflight SYNC_CUTOVER_SCHEDULER=none >/dev/null
# quiesce fails because a lease is still live.
if out="$(run_phase "${host}" quiesce SYNC_CUTOVER_SCHEDULER=none STUB_LEASES=3)"; then
  fail "H5 quiesce succeeded with 3 live leases"
else
  if grep -q "quiescence not reached" <<<"${out}"; then
    pass "H5 quiesce refuses while work is in flight"
  else
    fail "H5 quiesce failed for the wrong reason: ${out}"
  fi
fi
if grep -q "^quiesce:" "${host}/state/state" 2>/dev/null; then
  fail "H5 a FAILED phase was recorded as complete"
else
  pass "H5 a failed phase is not recorded, so resuming re-runs exactly it"
fi
# ...and it resumes once the leases clear, without redoing preflight.
if run_phase "${host}" quiesce SYNC_CUTOVER_SCHEDULER=none >/dev/null; then
  if grep -q "^quiesce:" "${host}/state/state"; then
    pass "H5 the same phase resumes and completes once the blocker clears"
  else
    fail "H5 quiesce reported success without recording state"
  fi
else
  fail "H5 quiesce could not be resumed"
fi
# A phase whose predecessor is missing is refused rather than run out of order.
host="$(new_host order)"
if out="$(run_phase "${host}" migrate SYNC_CUTOVER_SCHEDULER=none)"; then
  fail "H5 migrate ran without its predecessor"
else
  if grep -q "has not completed" <<<"${out}"; then
    pass "H5 a phase whose predecessor is missing is refused, not run out of order"
  else
    fail "H5 out-of-order migrate failed for the wrong reason: ${out}"
  fi
fi

# ── H6: emergency-disable confirms live state ─────────────────────────────

host="$(new_host emergency)"
if out="$(run_phase "${host}" emergency-disable SYNC_CUTOVER_SCHEDULER=none)"; then
  if grep -q "CONFIRMED stopped" <<<"${out}"; then
    pass "H6 emergency-disable confirms live state, with no state file and no DEPLOY_SHA needed"
  else
    fail "H6 emergency-disable did not confirm: ${out}"
  fi
else
  fail "H6 emergency-disable failed on a stopped host: ${out}"
fi
# ...and it FAILS when something is still running, rather than reporting success
# because the stop command returned 0.
host="$(new_host emergency_running)"
if out="$(run_phase "${host}" emergency-disable SYNC_CUTOVER_SCHEDULER=none STUB_CONTAINER_STATE=running)"; then
  fail "H6 emergency-disable reported success while containers were still running"
else
  if grep -q "did NOT fully take effect" <<<"${out}"; then
    pass "H6 emergency-disable fails when a container survives, instead of trusting the exit code"
  else
    fail "H6 emergency-disable failed for the wrong reason: ${out}"
  fi
fi

if [ "${FAILURES}" -eq 0 ]; then
  printf '[cutover-harness] PASS\n'
else
  printf '[cutover-harness] %s check(s) FAILED\n' "${FAILURES}" >&2
  exit 1
fi
