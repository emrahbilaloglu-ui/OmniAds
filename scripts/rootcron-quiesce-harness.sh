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
ROOTCRON_LOCK_FILE="${WORK}/cutover.lock"
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

# --- 8: a DIFFERENT live block must not silently discard the parked one -----
reset_crontab
rootcron_pause "${STATE_DIR}" >/dev/null
# Someone re-adds a managed block, but not the one that was removed: a changed
# cadence and a stale token. The parked copy is the only record of the original.
{
  cat "${CRONTAB_FILE}"
  printf '%s\n' "# BEGIN adsecute-sync"
  printf '%s\n' "*/30 * * * * curl -fsS -X POST http://127.0.0.1:3000/api/sync/cron -H \"Authorization: Bearer STALE\""
  printf '%s\n' "# END adsecute-sync"
} > "${WORK}/tampered" && mv "${WORK}/tampered" "${CRONTAB_FILE}"
rc8=0
rootcron_resume "${STATE_DIR}" >/dev/null 2>&1 || rc8=$?
if [ "${rc8}" -ne 0 ]; then
  ok "resume refuses when a DIFFERENT managed block is live"
else
  bad "resume accepted a different live block"
fi
if rootcron_is_paused "${STATE_DIR}"; then
  ok "the original parked block is preserved, not discarded"
else
  bad "the original parked block was discarded while a different one was live"
fi

# --- 9: a hand-restored crontab is a clean no-op ----------------------------
reset_crontab
rootcron_pause "${STATE_DIR}" >/dev/null
cp "${STATE_DIR}/rootcron.original" "${CRONTAB_FILE}"
rc9=0
rootcron_resume "${STATE_DIR}" >/dev/null 2>&1 || rc9=$?
if [ "${rc9}" -eq 0 ] && ! rootcron_is_paused "${STATE_DIR}"; then
  ok "a crontab already matching the parked original clears state without error"
else
  bad "a hand-restored crontab was not handled cleanly (rc=${rc9})"
fi

# --- 10: unwritable state dir must NOT touch the live crontab ---------------
reset_crontab
before="$(cat "${CRONTAB_FILE}")"
RO_STATE="${WORK}/readonly-state"
mkdir -p "${RO_STATE}"; chmod 0500 "${RO_STATE}"
rc10=0
rootcron_pause "${RO_STATE}" >/dev/null 2>&1 || rc10=$?
chmod 0700 "${RO_STATE}" 2>/dev/null || true
if [ "${rc10}" -ne 0 ]; then
  ok "pause refuses when the state directory is unwritable"
else
  bad "pause proceeded despite unwritable state"
fi
if [ "$(cat "${CRONTAB_FILE}")" = "${before}" ]; then
  ok "the live crontab is untouched when parked state cannot be persisted"
else
  bad "the crontab was modified even though parked state failed to persist"
fi
if ! rootcron_is_paused "${RO_STATE}"; then
  ok "no half-parked state is left for the next run to adopt"
else
  bad "half-parked state survived a failed pause"
fi

# --- 11: a state dir that cannot be created is refused ----------------------
reset_crontab
before="$(cat "${CRONTAB_FILE}")"
BLOCKER="${WORK}/not-a-dir"; : > "${BLOCKER}"
rc11=0
rootcron_pause "${BLOCKER}/state" >/dev/null 2>&1 || rc11=$?
if [ "${rc11}" -ne 0 ] && [ "$(cat "${CRONTAB_FILE}")" = "${before}" ]; then
  ok "an uncreatable state directory is refused with the crontab untouched"
else
  bad "an uncreatable state directory was not handled safely (rc=${rc11})"
fi

# --- 12: an unreadable crontab is NOT treated as empty ----------------------
reset_crontab
before="$(cat "${CRONTAB_FILE}")"
rm -rf "${STATE_DIR}"; mkdir -p "${STATE_DIR}"
rootcron_read() { echo "crontab: must be privileged to use -u" >&2; return 1; }
rc12=0
rootcron_pause "${STATE_DIR}" >/dev/null 2>&1 || rc12=$?
rootcron_read() { cat "${CRONTAB_FILE}" 2>/dev/null || true; }
if [ "${rc12}" -ne 0 ]; then
  ok "an unreadable crontab is refused, not reported as 'no managed block'"
else
  bad "an unreadable crontab was treated as absent"
fi
if [ "$(cat "${CRONTAB_FILE}")" = "${before}" ]; then
  ok "an unreadable crontab leaves the schedule untouched"
else
  bad "an unreadable crontab still led to a modification"
fi

# --- 13: duplicate managed blocks are refused, never merged -----------------
reset_crontab
{
  cat "${CRONTAB_FILE}"
  printf '%s\n' "MAILTO=ops@example.test"
  printf '%s\n' "# BEGIN adsecute-sync"
  printf '%s\n' "0 * * * * /usr/local/bin/second-block"
  printf '%s\n' "# END adsecute-sync"
} > "${WORK}/dup" && mv "${WORK}/dup" "${CRONTAB_FILE}"
before="$(cat "${CRONTAB_FILE}")"
rm -rf "${STATE_DIR}"; mkdir -p "${STATE_DIR}"
rc13=0
rootcron_pause "${STATE_DIR}" >/dev/null 2>&1 || rc13=$?
if [ "${rc13}" -ne 0 ]; then
  ok "two managed blocks are refused rather than concatenated"
else
  bad "two managed blocks were merged or relocated"
fi
if [ "$(cat "${CRONTAB_FILE}")" = "${before}" ]; then
  ok "the duplicate-block crontab is byte-identical after the refusal"
else
  bad "the duplicate-block crontab was modified"
fi

# --- 14: a stray END with no BEGIN is refused -------------------------------
printf '%s\n' "MAILTO=\"\"" "# END adsecute-sync" "*/5 * * * * /usr/local/bin/healthz" > "${CRONTAB_FILE}"
before="$(cat "${CRONTAB_FILE}")"
rm -rf "${STATE_DIR}"; mkdir -p "${STATE_DIR}"
rc14=0
rootcron_pause "${STATE_DIR}" >/dev/null 2>&1 || rc14=$?
if [ "${rc14}" -ne 0 ] && [ "$(cat "${CRONTAB_FILE}")" = "${before}" ]; then
  ok "a stray END marker is refused with the crontab untouched"
else
  bad "a stray END marker was not refused safely (rc=${rc14})"
fi

# --- 15: environment assignments keep their exact position ------------------
reset_crontab
{
  printf '%s\n' "MAILTO=ops@example.test"
  printf '%s\n' "PATH=/usr/local/bin:/usr/bin:/bin"
  cat "${CRONTAB_FILE}"
} > "${WORK}/env" && mv "${WORK}/env" "${CRONTAB_FILE}"
envbefore="$(cat "${CRONTAB_FILE}")"
rm -rf "${STATE_DIR}"; mkdir -p "${STATE_DIR}"
rootcron_pause "${STATE_DIR}" >/dev/null
rootcron_resume "${STATE_DIR}" >/dev/null
if [ "$(cat "${CRONTAB_FILE}")" = "${envbefore}" ]; then
  ok "MAILTO/PATH assignments keep their exact position across pause+resume"
else
  bad "environment assignments moved across pause+resume"
  diff <(printf '%s\n' "${envbefore}") "${CRONTAB_FILE}" | sed 's/^/        /' || true
fi

# --- 16: removal succeeded but READBACK fails -> synchronous rollback -------
reset_crontab
original="$(cat "${CRONTAB_FILE}")"
# Let the removal write land, then make the verification read fail once.
_real_read() { cat "${CRONTAB_FILE}" 2>/dev/null || true; }
_reads=0
rootcron_read() {
  _reads=$((_reads + 1))
  # 1st read = pause's initial read (ok). 2nd = verification (fail).
  if [ "${_reads}" -eq 2 ]; then echo "crontab: transient cron failure" >&2; return 1; fi
  _real_read
}
rc16=0
rootcron_pause "${STATE_DIR}" >/dev/null 2>&1 || rc16=$?
rootcron_read() { _real_read; }
if [ "${rc16}" -ne 0 ]; then
  ok "pause fails when the post-removal readback fails"
else
  bad "pause reported success despite a failed readback"
fi
if [ "$(cat "${CRONTAB_FILE}")" = "${original}" ]; then
  ok "the managed block and unrelated lines are restored byte-for-byte after a failed readback"
else
  bad "the crontab was left mutated after a failed readback"
  diff <(printf '%s\n' "${original}") "${CRONTAB_FILE}" | sed 's/^/        /' || true
fi
if ! rootcron_is_paused "${STATE_DIR}"; then
  ok "rollback clears the parked state it no longer owns"
else
  bad "parked state survived a successful rollback"
fi

# --- 17: removal succeeded but VERIFY sees the block still there ------------
reset_crontab
original="$(cat "${CRONTAB_FILE}")"
_writes=0
_real_write() { cat > "${CRONTAB_FILE}"; }
rootcron_write() {
  _writes=$((_writes + 1))
  if [ "${_writes}" -eq 1 ]; then
    # Pretend the daemon ignored the removal: keep the original on disk.
    cat >/dev/null
    printf '%s\n' "${original}" > "${CRONTAB_FILE}"
    return 0
  fi
  _real_write
}
rc17=0
rootcron_pause "${STATE_DIR}" >/dev/null 2>&1 || rc17=$?
rootcron_write() { _real_write; }
if [ "${rc17}" -ne 0 ] && [ "$(cat "${CRONTAB_FILE}")" = "${original}" ]; then
  ok "a removal the daemon ignored is detected and rolled back byte-for-byte"
else
  bad "an ignored removal was not detected or not rolled back (rc=${rc17})"
fi

# --- 18: rollback FAILS -> parked evidence survives for later recovery ------
reset_crontab
orig18="$(cat "${CRONTAB_FILE}")"
_w18=0
_realw() { cat > "${CRONTAB_FILE}"; }
rootcron_write() {
  _w18=$((_w18 + 1))
  # 1 = the removal (succeeds). 2 = the rollback attempt (fails).
  if [ "${_w18}" -eq 2 ]; then cat >/dev/null; return 1; fi
  _realw
}
_r18=0
_realr() { cat "${CRONTAB_FILE}" 2>/dev/null || true; }
# Reads: 1 = initial, 2 = the pre-write concurrent-edit recheck, 3 = the
# post-removal verification. Failing #3 is what puts us past the write with a
# rollback still to attempt.
rootcron_read() { _r18=$((_r18 + 1)); if [ "${_r18}" -eq 3 ]; then echo "crontab: transient" >&2; return 1; fi; _realr; }
rc18=0
rootcron_pause "${STATE_DIR}" >/dev/null 2>&1 || rc18=$?
rootcron_write() { _realw; }; rootcron_read() { _realr; }
if [ "${rc18}" -ne 0 ]; then
  ok "pause fails when it removed the block and could not roll back"
else
  bad "pause reported success after a failed rollback"
fi
if rootcron_is_paused "${STATE_DIR}"; then
  ok "the parked original survives as unmistakable evidence for recovery"
else
  bad "a failed rollback discarded the parked original"
fi
# The caller's EXIT recovery runs later and must succeed from that evidence.
rc18b=0
rootcron_resume "${STATE_DIR}" >/dev/null 2>&1 || rc18b=$?
if [ "${rc18b}" -eq 0 ] && [ "$(cat "${CRONTAB_FILE}")" = "${orig18}" ]; then
  ok "later EXIT recovery restores byte-for-byte from the parked evidence"
else
  bad "EXIT recovery could not restore from parked evidence (rc=${rc18b})"
fi

# --- 19: cleanup that cannot complete must FAIL the resume ------------------
reset_crontab
rootcron_pause "${STATE_DIR}" >/dev/null
chmod 0500 "${STATE_DIR}" 2>/dev/null || true
rc19=0
rootcron_resume "${STATE_DIR}" >/dev/null 2>&1 || rc19=$?
chmod 0700 "${STATE_DIR}" 2>/dev/null || true
if [ "${rc19}" -ne 0 ]; then
  ok "resume fails when parked state cannot be cleared"
else
  bad "resume reported success while stale parked state remained"
fi
# And the next pause must not mistake the stale state for a live park.
rm -rf "${STATE_DIR}"; mkdir -p "${STATE_DIR}"

# --- 20: a concurrent edit between read and write is not overwritten --------
reset_crontab
_r20=0
rootcron_read() {
  _r20=$((_r20 + 1))
  if [ "${_r20}" -eq 2 ]; then
    # Someone edits the crontab between our first read and the write.
    printf '%s\n' "0 6 * * * /usr/local/bin/operator-added-job" >> "${CRONTAB_FILE}"
  fi
  cat "${CRONTAB_FILE}" 2>/dev/null || true
}
rc20=0
rootcron_pause "${STATE_DIR}" >/dev/null 2>&1 || rc20=$?
rootcron_read() { cat "${CRONTAB_FILE}" 2>/dev/null || true; }
if [ "${rc20}" -ne 0 ]; then
  ok "pause refuses when the crontab changed between read and write"
else
  bad "pause overwrote a concurrent edit"
fi
if grep -q "operator-added-job" "${CRONTAB_FILE}"; then
  ok "the operator's concurrent edit survives untouched"
else
  bad "the operator's concurrent edit was lost"
fi
if grep -q "api/sync/cron" "${CRONTAB_FILE}"; then
  ok "the managed block is still scheduled after the refusal"
else
  bad "the managed block was removed despite the refusal"
fi

# --- 21: an empty filtered crontab is still concurrency proof ---------------
printf '%s\n' \
  "# BEGIN adsecute-sync" \
  "*/10 * * * * curl -fsS http://127.0.0.1:3000/api/sync/cron" \
  "# END adsecute-sync" > "${CRONTAB_FILE}"
rm -rf "${STATE_DIR}"; mkdir -p "${STATE_DIR}"
only_block_original="$(cat "${CRONTAB_FILE}")"
rootcron_pause "${STATE_DIR}" >/dev/null
if [ ! -s "${CRONTAB_FILE}" ] && [ -e "${STATE_DIR}/rootcron.filtered" ]; then
  ok "a crontab containing only the managed block produces a valid empty filtered proof"
else
  bad "the only-block crontab did not produce the expected empty live/proof pair"
fi
printf '%s\n' "0 6 * * * /usr/local/bin/operator-added-job" > "${CRONTAB_FILE}"
rc21=0
rootcron_resume "${STATE_DIR}" >/dev/null 2>&1 || rc21=$?
if [ "${rc21}" -ne 0 ] && grep -q "operator-added-job" "${CRONTAB_FILE}"; then
  ok "an edit to a valid empty filtered crontab is refused and preserved"
else
  bad "resume overwrote an edit because the filtered proof was zero bytes (rc=${rc21})"
fi
printf '%s\n' "${only_block_original}" > "${CRONTAB_FILE}"
rm -rf "${STATE_DIR}"; mkdir -p "${STATE_DIR}"

# --- 22: migration admission proves the live block is absent ----------------
reset_crontab
rc22a=0
rootcron_assert_quiesced >/dev/null 2>&1 || rc22a=$?
if [ "${rc22a}" -ne 0 ]; then
  ok "migration admission refuses while the managed block is live"
else
  bad "migration admission accepted a live Sync block"
fi
rootcron_pause "${STATE_DIR}" >/dev/null
rc22b=0
rootcron_assert_quiesced >/dev/null 2>&1 || rc22b=$?
if [ "${rc22b}" -eq 0 ]; then
  ok "migration admission accepts the verified filtered crontab"
else
  bad "migration admission rejected a genuinely quiesced host (rc=${rc22b})"
fi
rootcron_resume "${STATE_DIR}" >/dev/null

if [ "${failures}" -ne 0 ]; then
  echo "FAILED: ${failures} case(s)"
  exit 1
fi
echo "All cases passed."
