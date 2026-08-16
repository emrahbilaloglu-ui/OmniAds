#!/usr/bin/env bash
#
# Proves the deploy's scheduler quiesce against a simulated root crontab.
#
# The property that matters is not "the Sync block came back" — it is that
# UNRELATED crontab lines are byte-identical afterwards. A quiesce that
# restores sync but drops someone's healthz probe has caused a silent outage
# in a job nobody is watching, which is exactly the failure the marker-block
# design exists to prevent.
#
# Run: bash scripts/rootcron-quiesce-harness.sh
set -Eeuo pipefail

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

CRONTAB_FILE="${WORK}/crontab"
STATE_DIR="${WORK}/state"
mkdir -p "${STATE_DIR}"

# Stand in for the real crontab so nothing on this machine is touched.
rootcron_read() { cat "${CRONTAB_FILE}" 2>/dev/null || true; }
rootcron_write() { cat > "${CRONTAB_FILE}"; }
rootcron_log() { echo "  [rootcron] $*"; }
rootcron_die() { echo "  [rootcron] REFUSED $*"; return 1; }

# shellcheck source=lib/rootcron.sh
. "$(dirname "$0")/lib/rootcron.sh"

ORIGINAL="$(cat <<'CRON'
MAILTO=""
# a probe someone else owns
*/5 * * * * /usr/local/bin/healthz >/dev/null 2>&1
# BEGIN adsecute-sync
*/10 * * * * curl -fsS -X POST http://127.0.0.1:3000/api/sync/cron -H "Authorization: Bearer x"
17 3 * * * /usr/local/bin/adsecute-daily-backup
# END adsecute-sync
# unrelated nightly job
30 4 * * * /usr/local/bin/rotate-logs
CRON
)"

failures=0
ok()   { echo "  PASS  $1"; }
bad()  { echo "  FAIL  $1"; failures=$((failures + 1)); }

reset_crontab() { printf '%s\n' "${ORIGINAL}" > "${CRONTAB_FILE}"; rm -rf "${STATE_DIR}"; mkdir -p "${STATE_DIR}"; }

unrelated_lines() {
  grep -v -e '^# BEGIN adsecute-sync$' -e '^# END adsecute-sync$' \
          -e 'api/sync/cron' -e 'adsecute-daily-backup' "${CRONTAB_FILE}"
}

echo "Scheduler quiesce against a simulated root crontab"

# --- 1: pause removes ONLY the managed block --------------------------------
reset_crontab
before_unrelated="$(unrelated_lines)"
rootcron_pause "${STATE_DIR}" >/dev/null
if grep -q 'api/sync/cron' "${CRONTAB_FILE}"; then
  bad "pause leaves the sync entry scheduled"
else
  ok "pause removes the sync entry"
fi
if [ "$(unrelated_lines)" = "${before_unrelated}" ]; then
  ok "pause preserves unrelated crontab lines byte-for-byte"
else
  bad "pause altered unrelated crontab lines"
fi

# --- 2: resume restores the file exactly ------------------------------------
rootcron_resume "${STATE_DIR}" >/dev/null
if [ "$(cat "${CRONTAB_FILE}")" = "${ORIGINAL}" ]; then
  ok "resume restores the crontab byte-for-byte, block back in position"
else
  bad "resume did not reproduce the original crontab"
  diff <(printf '%s\n' "${ORIGINAL}") "${CRONTAB_FILE}" | sed 's/^/        /' || true
fi

# --- 3: crash between pause and resume is recoverable -----------------------
reset_crontab
rootcron_pause "${STATE_DIR}" >/dev/null
# Simulate the deploy process dying here: state on disk, block still parked.
if rootcron_is_paused "${STATE_DIR}"; then
  ok "a crashed deploy leaves the block parked and detectable"
else
  bad "the parked block is not detectable after a crash"
fi
rootcron_resume "${STATE_DIR}" >/dev/null
if [ "$(cat "${CRONTAB_FILE}")" = "${ORIGINAL}" ]; then
  ok "the next run restores what the crashed run parked"
else
  bad "recovery after a crash did not restore the crontab"
fi

# --- 4: pause is idempotent -------------------------------------------------
reset_crontab
rootcron_pause "${STATE_DIR}" >/dev/null
rootcron_pause "${STATE_DIR}" >/dev/null
rootcron_resume "${STATE_DIR}" >/dev/null
if [ "$(cat "${CRONTAB_FILE}")" = "${ORIGINAL}" ]; then
  ok "pausing twice then resuming once is still exact"
else
  bad "double pause corrupted the crontab"
fi

# --- 5: resume REFUSES when unrelated lines changed meanwhile ---------------
reset_crontab
rootcron_pause "${STATE_DIR}" >/dev/null
printf '%s\n' "0 6 * * * /usr/local/bin/someone-elses-new-job" >> "${CRONTAB_FILE}"
tampered="$(cat "${CRONTAB_FILE}")"
resume_rc=0
rootcron_resume "${STATE_DIR}" >/dev/null 2>&1 || resume_rc=$?
if [ "${resume_rc}" -ne 0 ]; then
  ok "resume refuses when unrelated lines changed under it"
else
  bad "resume silently overwrote a concurrent crontab edit"
fi
if [ "$(cat "${CRONTAB_FILE}")" = "${tampered}" ]; then
  ok "the refusal left the operator's edit intact"
else
  bad "the refusal still modified the crontab"
fi
if rootcron_is_paused "${STATE_DIR}"; then
  ok "the parked block survives a refused resume (recoverable by hand)"
else
  bad "a refused resume discarded the parked block"
fi

# --- 6: a crontab with no managed block is left alone -----------------------
printf '%s\n' "MAILTO=\"\"" "*/5 * * * * /usr/local/bin/healthz" > "${CRONTAB_FILE}"
rm -rf "${STATE_DIR}"; mkdir -p "${STATE_DIR}"
none="$(cat "${CRONTAB_FILE}")"
rootcron_pause "${STATE_DIR}" >/dev/null
if [ "$(cat "${CRONTAB_FILE}")" = "${none}" ]; then
  ok "a crontab with no managed block is untouched"
else
  bad "pause modified a crontab that had no managed block"
fi

# --- 7: an unterminated block is refused, not guessed -----------------------
printf '%s\n' "MAILTO=\"\"" "# BEGIN adsecute-sync" "*/10 * * * * something" > "${CRONTAB_FILE}"
rm -rf "${STATE_DIR}"; mkdir -p "${STATE_DIR}"
broken="$(cat "${CRONTAB_FILE}")"
pause_rc=0
rootcron_pause "${STATE_DIR}" >/dev/null 2>&1 || pause_rc=$?
if [ "${pause_rc}" -ne 0 ] && [ "$(cat "${CRONTAB_FILE}")" = "${broken}" ]; then
  ok "a BEGIN with no END is refused and the crontab is untouched"
else
  bad "an unterminated block was not refused safely (rc=${pause_rc})"
fi

if [ "${failures}" -ne 0 ]; then
  echo "FAILED: ${failures} case(s)"
  exit 1
fi
echo "All cases passed."
