#!/usr/bin/env bash
# discard_incomplete_artifact must remove ONLY this epoch's unmanifested,
# unheld artifact — and must refuse everything else. Fail-closed by construction.
set -euo pipefail
L="[cutover-self-cleanup]"; F=0
pass(){ printf '%s PASS %s\n' "$L" "$1"; }
fail(){ printf '%s FAIL %s\n' "$L" "$1" >&2; F=$((F+1)); }
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
BACKUP_ROOT="$W/backups"; mkdir -p "$BACKUP_ROOT"
CUR_EPOCH="ep-current"
log(){ :; }
# Linux fuser: exit 1 when NOTHING holds the file, 0 when something does.
# macOS/BSD fuser exits 0 either way, so the real guard degrades CLOSED there
# (it keeps the file). The wrapper only ever runs on the Linux app host, so the
# test emulates Linux semantics to exercise the actual decision on any machine.
FUSER_HELD=no
fuser(){ [ "$FUSER_HELD" = yes ] && return 0; return 1; }
state_get(){ [ "$1" = cutover_epoch ] && printf '%s' "$CUR_EPOCH"; }
backup_dir_for_epoch(){ printf '%s/%s' "$BACKUP_ROOT" "$1"; }
eval "$(awk '/^discard_incomplete_artifact\(\)/,/^}/' "$(dirname "$0")"/hetzner-sync-cutover.sh)"

mk(){ mkdir -p "$BACKUP_ROOT/$1"; head -c "${2:-1024}" /dev/zero > "$BACKUP_ROOT/$1/full.dump"; }

# S1: own epoch, no manifest, no writer -> removed
mk "$CUR_EPOCH"
discard_incomplete_artifact "$BACKUP_ROOT/$CUR_EPOCH" "$BACKUP_ROOT/$CUR_EPOCH/full.dump" >/dev/null 2>&1
[ ! -f "$BACKUP_ROOT/$CUR_EPOCH/full.dump" ] && pass "S1 own unmanifested artifact removed" || fail "S1 own unmanifested artifact survived"

# S2: MANIFESTED -> must survive (the dangerous direction)
mk "$CUR_EPOCH"; : > "$BACKUP_ROOT/$CUR_EPOCH/cutover-backup.manifest"
discard_incomplete_artifact "$BACKUP_ROOT/$CUR_EPOCH" "$BACKUP_ROOT/$CUR_EPOCH/full.dump" >/dev/null 2>&1
[ -f "$BACKUP_ROOT/$CUR_EPOCH/full.dump" ] && pass "S2 MANIFESTED artifact refused (survives)" || fail "S2 a manifested artifact was DELETED"
rm -f "$BACKUP_ROOT/$CUR_EPOCH/cutover-backup.manifest"

# S3: different epoch -> must survive
mk "ep-other"
discard_incomplete_artifact "$BACKUP_ROOT/ep-other" "$BACKUP_ROOT/ep-other/full.dump" >/dev/null 2>&1
[ -f "$BACKUP_ROOT/ep-other/full.dump" ] && pass "S3 another epoch's artifact refused" || fail "S3 deleted another epoch's artifact"

# S4: outside BACKUP_ROOT -> must survive
mkdir -p "$W/elsewhere"; head -c 512 /dev/zero > "$W/elsewhere/full.dump"
discard_incomplete_artifact "$W/elsewhere" "$W/elsewhere/full.dump" >/dev/null 2>&1
[ -f "$W/elsewhere/full.dump" ] && pass "S4 path outside BACKUP_ROOT refused" || fail "S4 deleted outside BACKUP_ROOT"

# S5: writer still holding it -> must survive
mk "$CUR_EPOCH"
FUSER_HELD=yes
discard_incomplete_artifact "$BACKUP_ROOT/$CUR_EPOCH" "$BACKUP_ROOT/$CUR_EPOCH/full.dump" >/dev/null 2>&1
[ -f "$BACKUP_ROOT/$CUR_EPOCH/full.dump" ] && pass "S5 artifact held open by a writer refused" || fail "S5 deleted an artifact still held open"
FUSER_HELD=no

# S6: missing file -> no error
discard_incomplete_artifact "$BACKUP_ROOT/ep-missing" "$BACKUP_ROOT/ep-missing/full.dump" >/dev/null 2>&1 && pass "S6 absent artifact is a no-op" || fail "S6 errored on an absent artifact"

[ "$F" -ne 0 ] && { printf '%s %s FAILED\n' "$L" "$F" >&2; exit 1; }
printf '%s PASS — removes only its own unmanifested, unheld artifact\n' "$L"
