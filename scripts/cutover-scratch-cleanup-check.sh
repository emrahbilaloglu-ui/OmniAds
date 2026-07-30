#!/usr/bin/env bash
# scratch_db_drop must be TRUTHFUL: it may report success only when the scratch
# database is provably absent, and it must refuse anything whose identity is not
# unmistakably this run's scratch copy.
#
# THE INCIDENT THIS ENCODES
#
# On 2026-07-30 an operator session was severed mid scratch-restore. The wrapper
# called scratch_db_drop on its way out, exactly as designed — but the drop runs
# over SSH to the database host, the credential had just been withdrawn, and the
# call ended `>/dev/null 2>&1 || true`. So it could not authenticate, said
# nothing, and left an 11 GB half-restored copy of a 72 GB production database in
# pgdata. No error appeared in any log on either host.
#
# Every case below is therefore about the difference between "it is gone" and
# "I could not tell", which the old implementation collapsed into success.
set -euo pipefail
L="[cutover-scratch-cleanup]"; F=0
pass(){ printf '%s PASS %s\n' "$L" "$1"; }
fail(){ printf '%s FAIL %s\n' "$L" "$1" >&2; F=$((F+1)); }

DB_NAME="adsecute_prod"
CUTOVER_OWNER_DEPTH=0
BASH_SUBSHELL_OVERRIDE=0
LOG_LINES=""
log(){ LOG_LINES="${LOG_LINES}$*
"; }
cutover_owns_resources(){ return 0; }

# Stubs for the two ways the wrapper reaches the database host. Each case sets
# the behaviour it wants; nothing here can open a socket.
DROP_RC=0; DROP_OUT=""
CONN_COUNT="0"; REMAINING="0"
db_run(){ printf '%s' "$DROP_OUT"; return "$DROP_RC"; }
db_sql_on(){
  case "$2" in
    *pg_stat_activity*) printf '%s' "$CONN_COUNT" ;;
    *pg_database*)      printf '%s' "$REMAINING" ;;
  esac
}

eval "$(awk '/^scratch_db_drop\(\)/,/^}/' "$(dirname "$0")"/hetzner-sync-cutover.sh)"

reset_all(){ SCRATCH_DB="adsecute_cutover_scratch_ep_20260730_000000_"; SCRATCH_DB_LAST=""
             DROP_RC=0; DROP_OUT=""; CONN_COUNT="0"; REMAINING="0"; LOG_LINES=""; }
saw(){ case "$LOG_LINES" in *"$1"*) return 0 ;; *) return 1 ;; esac; }

# ── POSITIVE ──────────────────────────────────────────────────────────────
reset_all
if scratch_db_drop && saw "dropped and proven absent"; then
  pass "T1 drop succeeds and absence is PROVEN"
else
  fail "T1 a clean drop was not reported as proven"
fi

reset_all; SCRATCH_DB=""
scratch_db_drop && pass "T2 nothing to drop is success, not a failure" \
                || fail "T2 an unset scratch name reported failure"

# ── NEGATIVE: the incident itself ─────────────────────────────────────────
reset_all; DROP_RC=1; DROP_OUT="Permission denied (publickey,password)."
if scratch_db_drop; then
  fail "T3 an authentication failure was reported as SUCCESS (the 2026-07-30 defect)"
else
  saw "SCRATCH CLEANUP FAILED" && pass "T3 authentication failure surfaces as a real failure" \
                              || fail "T3 failed but did not say why"
fi

# dropdb exits 0 but the database is still there — a lie that must be caught.
reset_all; REMAINING="1"
if scratch_db_drop; then
  fail "T4 trusted dropdb's exit code over the catalogue"
else
  saw "still present after dropdb reported success" && pass "T4 a database still present after a 'successful' drop is a failure" \
                                                   || fail "T4 failed without naming the cause"
fi

# The confirmation query itself cannot be answered.
reset_all; REMAINING="could not connect to server"
if scratch_db_drop; then
  fail "T5 reported success when absence could not be confirmed"
else
  saw "UNPROVEN" && pass "T5 an unconfirmable absence is UNPROVEN, not success" \
                 || fail "T5 failed without marking it unproven"
fi

# ── NEGATIVE: identity refusals ───────────────────────────────────────────
reset_all; SCRATCH_DB="adsecute_prod"
if scratch_db_drop; then
  fail "T6 DID NOT REFUSE THE PRODUCTION DATABASE"
else
  saw "production or template" && pass "T6 refuses the production database by name" \
                               || fail "T6 refused but not for the identity reason"
fi

for bad_name in template0 template1 postgres; do
  reset_all; SCRATCH_DB="$bad_name"
  if scratch_db_drop; then fail "T7 did not refuse ${bad_name}"
  else pass "T7 refuses ${bad_name}"; fi
done

reset_all; SCRATCH_DB="some_other_database"
if scratch_db_drop; then
  fail "T8 dropped a name that is not a cutover scratch database"
else
  saw "not a cutover scratch name" && pass "T8 refuses a non-scratch name" \
                                   || fail "T8 refused for the wrong reason"
fi

# Still-connected backends: dropdb would fail anyway, but the refusal must name it.
reset_all; CONN_COUNT="2"
if scratch_db_drop; then
  fail "T9 dropped while backends were still connected"
else
  saw "backend(s) still connected" && pass "T9 refuses while backends are connected" \
                                   || fail "T9 refused without naming the connections"
fi

reset_all; CONN_COUNT="FATAL: no pg_hba.conf entry"
if scratch_db_drop; then
  fail "T10 proceeded when the connection count was unreadable"
else
  saw "UNPROVEN" && pass "T10 an unreadable connection count is UNPROVEN" \
                 || fail "T10 refused without marking it unproven"
fi

# The name is remembered after the drop clears it, so a failure can name it.
reset_all; DROP_RC=1
scratch_db_drop || true
[ "$SCRATCH_DB_LAST" = "adsecute_cutover_scratch_ep_20260730_000000_" ] \
  && pass "T11 the scratch name survives for the failure message" \
  || fail "T11 lost the scratch name on failure"

[ "$F" -ne 0 ] && { printf '%s %s FAILED\n' "$L" "$F" >&2; exit 1; }
printf '%s PASS — cleanup is proven, or it is a failure\n' "$L"
