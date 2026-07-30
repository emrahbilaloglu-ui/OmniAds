#!/usr/bin/env bash
# discard_incomplete_artifact must remove ONLY this run's own unmanifested,
# unreferenced, unheld artifact — and must refuse everything else. Fail-closed
# by construction.
#
# WHY THE HARNESS CHANGED
#
# The earlier version stubbed `state_get cutover_epoch` to return the epoch being
# written. That is not what happens in a real run: preflight rewrites the state
# record at the END, so throughout take_verified_backup the committed epoch is
# still the PREVIOUS one. The old guard compared against the committed epoch, so
# in production it was always false and the function could never reclaim the
# artifact it had just failed to finish — which is exactly what happened on
# 2026-07-30, leaving a 25,302,238,753-byte dump behind permanently.
#
# So the default here is now the truthful one: committed epoch != this run's
# epoch. The binding is to the RUN (INCOMPLETE_ARTIFACT_EPOCH / _OWNER_PID),
# and every obligation that could make the file somebody's evidence is a refusal.
set -euo pipefail
L="[cutover-self-cleanup]"; F=0
pass(){ printf '%s PASS %s\n' "$L" "$1"; }
fail(){ printf '%s FAIL %s\n' "$L" "$1" >&2; F=$((F+1)); }
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
BACKUP_ROOT="$W/backups"; mkdir -p "$BACKUP_ROOT"
STATE_DIR="$W/state"; mkdir -p "$STATE_DIR/attestations"

RUN_EPOCH="ep-thisrun"        # the epoch THIS run is writing
COMMITTED_EPOCH="ep-previous" # what the state record still says, as in reality
MANIFEST_PATH=""

log(){ :; }
# Linux fuser: exit 1 when NOTHING holds the file, 0 when something does.
# macOS/BSD fuser exits 0 either way, so the real guard degrades CLOSED there
# (it keeps the file). The wrapper only ever runs on the Linux app host, so the
# test emulates Linux semantics to exercise the actual decision on any machine.
FUSER_HELD=no
FUSER_PRESENT=yes
fuser(){ [ "$FUSER_HELD" = yes ] && return 0; return 1; }
command(){ # only intercept the fuser availability probe
  if [ "${1:-}" = "-v" ] && [ "${2:-}" = "fuser" ]; then
    [ "$FUSER_PRESENT" = yes ] && { printf 'fuser\n'; return 0; }
    return 1
  fi
  builtin command "$@"
}
state_get(){
  case "$1" in
    cutover_epoch)        printf '%s' "$COMMITTED_EPOCH" ;;
    backup_manifest_path) printf '%s' "$MANIFEST_PATH" ;;
  esac
}
backup_dir_for_epoch(){ printf '%s/%s' "$BACKUP_ROOT" "$1"; }
eval "$(awk '/^discard_incomplete_artifact\(\)/,/^}/' "$(dirname "$0")"/hetzner-sync-cutover.sh)"

# The run's claim, as take_verified_backup records it.
claim(){
  INCOMPLETE_ARTIFACT_EPOCH="${1:-$RUN_EPOCH}"
  INCOMPLETE_ARTIFACT_OWNER_PID="${2:-$$}"
}
mk(){ mkdir -p "$BACKUP_ROOT/$1"; head -c "${2:-1024}" /dev/zero > "$BACKUP_ROOT/$1/full.dump"; }
run(){ discard_incomplete_artifact "$BACKUP_ROOT/$1" "$BACKUP_ROOT/$1/full.dump" >/dev/null 2>&1 || true; }
gone(){ [ ! -f "$BACKUP_ROOT/$1/full.dump" ]; }
kept(){ [ -f "$BACKUP_ROOT/$1/full.dump" ]; }
reset_all(){ claim; FUSER_HELD=no; FUSER_PRESENT=yes; MANIFEST_PATH=""; COMMITTED_EPOCH="ep-previous"
             rm -rf "$BACKUP_ROOT" "$STATE_DIR"; mkdir -p "$BACKUP_ROOT" "$STATE_DIR/attestations"; }

# ── POSITIVE: the one case that may be reclaimed ──────────────────────────
reset_all; mk "$RUN_EPOCH"; run "$RUN_EPOCH"
gone "$RUN_EPOCH" && pass "S1 this run's own unmanifested artifact removed" \
                  || fail "S1 this run's own unmanifested artifact survived"

# ── NEGATIVE: every case that must survive ────────────────────────────────
reset_all; mk "$RUN_EPOCH"; : > "$BACKUP_ROOT/$RUN_EPOCH/cutover-backup.manifest"; run "$RUN_EPOCH"
kept "$RUN_EPOCH" && pass "S2 MANIFESTED artifact refused (survives)" \
                  || fail "S2 a manifested artifact was DELETED"

reset_all; mk "ep-other"; run "ep-other"
kept "ep-other" && pass "S3 another epoch's artifact refused" \
                || fail "S3 deleted another epoch's artifact"

reset_all; mkdir -p "$W/elsewhere"; head -c 512 /dev/zero > "$W/elsewhere/full.dump"
claim; discard_incomplete_artifact "$W/elsewhere" "$W/elsewhere/full.dump" >/dev/null 2>&1 || true
[ -f "$W/elsewhere/full.dump" ] && pass "S4 path outside BACKUP_ROOT refused" \
                                || fail "S4 deleted outside BACKUP_ROOT"

reset_all; mk "$RUN_EPOCH"; FUSER_HELD=yes; run "$RUN_EPOCH"
kept "$RUN_EPOCH" && pass "S5 artifact held open by a writer refused" \
                  || fail "S5 deleted an artifact still held open"

reset_all
discard_incomplete_artifact "$BACKUP_ROOT/ep-missing" "$BACKUP_ROOT/ep-missing/full.dump" >/dev/null 2>&1 \
  && pass "S6 absent artifact is a no-op" || fail "S6 errored on an absent artifact"

# S7: the state record has COMMITTED this epoch -> it is the rollback position.
reset_all; COMMITTED_EPOCH="$RUN_EPOCH"; mk "$RUN_EPOCH"; run "$RUN_EPOCH"
kept "$RUN_EPOCH" && pass "S7 committed-epoch artifact refused (it is the rollback position)" \
                  || fail "S7 deleted the committed epoch's rollback artifact"

# S8: the state record's manifest path points into the directory.
reset_all; mk "$RUN_EPOCH"; MANIFEST_PATH="$BACKUP_ROOT/$RUN_EPOCH/cutover-backup.manifest"; run "$RUN_EPOCH"
kept "$RUN_EPOCH" && pass "S8 artifact referenced by state backup_manifest_path refused" \
                  || fail "S8 deleted an artifact the state record points at"

# S9: an attestation exists for the epoch.
reset_all; mk "$RUN_EPOCH"; : > "$STATE_DIR/attestations/$RUN_EPOCH"; run "$RUN_EPOCH"
kept "$RUN_EPOCH" && pass "S9 attested epoch refused" || fail "S9 deleted an attested epoch's artifact"

# S10: any other file under STATE_DIR still names the epoch (audit reference).
reset_all; mk "$RUN_EPOCH"; printf 'epoch=%s\n' "$RUN_EPOCH" > "$STATE_DIR/sync-release-identity"; run "$RUN_EPOCH"
kept "$RUN_EPOCH" && pass "S10 epoch referenced elsewhere under STATE_DIR refused" \
                  || fail "S10 deleted an artifact still referenced under STATE_DIR"

# S11: claimed by a different process — a stale or inherited binding.
reset_all; mk "$RUN_EPOCH"; claim "$RUN_EPOCH" 999999; run "$RUN_EPOCH"
kept "$RUN_EPOCH" && pass "S11 artifact claimed by another pid refused" \
                  || fail "S11 deleted an artifact claimed by a different process"

# S12: no epoch recorded at all — nothing proves the file is ours.
reset_all; mk "$RUN_EPOCH"; INCOMPLETE_ARTIFACT_EPOCH=""; run "$RUN_EPOCH"
kept "$RUN_EPOCH" && pass "S12 unclaimed artifact refused" || fail "S12 deleted an unclaimed artifact"

# S13: fuser unavailable — "cannot check" must not mean "nothing holds it".
reset_all; mk "$RUN_EPOCH"; FUSER_PRESENT=no; run "$RUN_EPOCH"
kept "$RUN_EPOCH" && pass "S13 refused when no-writer cannot be proven (fail-closed)" \
                  || fail "S13 deleted while the writer check was unavailable"

[ "$F" -ne 0 ] && { printf '%s %s FAILED\n' "$L" "$F" >&2; exit 1; }
printf '%s PASS — reclaims only its own unmanifested, unreferenced, unheld artifact\n' "$L"
