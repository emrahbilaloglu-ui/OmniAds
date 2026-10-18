#!/usr/bin/env bash
# rootcron_start may ADOPT an already-present managed block only when it is
# provably the one this cutover recorded. Every mismatch must refuse.
#
# The incident: an earlier failed epoch removed the block and never restored it,
# so this epoch's quiesce saw nothing to stop and recorded no rootcron keys.
# The scheduler is nonetheless running the exact definition preflight recorded,
# and refusing forever leaves phase_chain short of resume-scheduler, blocking
# every ordinary deploy for a scheduler that is demonstrably correct.
set -euo pipefail
cd "$(dirname "$0")/.."
L="[cutover-scheduler-adoption]"; F=0
pass(){ printf '%s PASS %s\n' "$L" "$1"; }
fail(){ printf '%s FAIL %s\n' "$L" "$1" >&2; F=$((F+1)); }
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
STATE_DIR="$W/state"; mkdir -p "$STATE_DIR"
ENV_FILE="$W/.env.production"
SECRET="s3cr3t-current-value"
BLOCK_BODY='*/10 * * * * curl -fsS -m 300 -X POST http://127.0.0.1:3000/api/sync/cron -H "Authorization: Bearer '"$SECRET"'" >/tmp/adsecute-sync-cron.log 2>&1'
printf 'CRON_SECRET=%s\nOTHER=x\n' "$SECRET" > "$ENV_FILE"
printf '# BEGIN adsecute-sync\n%s\n# END adsecute-sync\n' "$BLOCK_BODY" > "$STATE_DIR/rootcron.block"
printf '# unrelated\n17 4 * * * /usr/bin/certbot renew --quiet\n' > "$STATE_DIR/rootcron.outside"
BLOCK_SHA=$(shasum -a 256 "$STATE_DIR/rootcron.block" | awk '{print $1}')

log(){ printf 'LOG %s\n' "$*"; }
die(){ printf 'DIE %s\n' "$*"; return 1; }
sha256_file(){ shasum -a 256 "$1" | awk '{print $1}'; }
STATE_SCHED="$BLOCK_SHA"; STATE_OUTSIDE_SHA=""
state_get(){ case "$1" in scheduler_sha256) printf '%s' "$STATE_SCHED";; rootcron_outside_sha256) printf '%s' "$STATE_OUTSIDE_SHA";; esac; }
CRONTAB_CONTENT=""
rootcron_read(){ printf '%s' "$CRONTAB_CONTENT"; }
rootcron_split(){ awk 'BEGIN{b=0} /^# BEGIN adsecute-sync/{b=1} b==0{print > "'"$2"'"} b==1{print > "'"$3"'"} /^# END adsecute-sync/{b=0}' "$1"; return 0; }
eval "$(awk '/^rootcron_start\(\)/,/^}/' scripts/hetzner-sync-cutover.sh)"

mk_crontab(){ CRONTAB_CONTENT="$(cat "$STATE_DIR/rootcron.outside"; printf '# BEGIN adsecute-sync\n%s\n# END adsecute-sync\n' "$1")"; }

# A1 POSITIVE: identical block present -> adopt
mk_crontab "$BLOCK_BODY"
if out=$(rootcron_start 2>&1); then
  case "$out" in *adopting*) pass "A1 identical present block is ADOPTED";; *) fail "A1 returned 0 without adopting: $out";; esac
else fail "A1 refused a byte-identical block: $out"; fi

# A2 NEGATIVE: different block body -> refuse
mk_crontab '*/5 * * * * curl -fsS -X POST http://127.0.0.1:3000/api/sync/cron -H "Authorization: Bearer '"$SECRET"'"'
out=$(rootcron_start 2>&1) || true
case "$out" in *DIFFERS*) pass "A2 a DIFFERENT present block is refused";; *) fail "A2 did not refuse a different block: $out";; esac

# A3 NEGATIVE: stale secret -> refuse
mk_crontab "$BLOCK_BODY"; printf 'CRON_SECRET=rotated-new-value\n' > "$ENV_FILE"
out=$(rootcron_start 2>&1) || true
case "$out" in *"current CRON_SECRET"*) pass "A3 a block carrying a STALE secret is refused";; *) fail "A3 did not refuse a stale secret: $out";; esac
printf 'CRON_SECRET=%s\nOTHER=x\n' "$SECRET" > "$ENV_FILE"

# A4 NEGATIVE: recorded scheduler_sha256 mismatch -> refuse
mk_crontab "$BLOCK_BODY"; STATE_SCHED="deadbeef"
out=$(rootcron_start 2>&1) || true
case "$out" in *scheduler_sha256*) pass "A4 hash differing from preflight scheduler_sha256 is refused";; *) fail "A4 did not refuse a hash mismatch: $out";; esac
STATE_SCHED="$BLOCK_SHA"

# A5 NEGATIVE: unrelated lines changed -> refuse
CRONTAB_CONTENT="$(printf '# unrelated CHANGED\n17 4 * * * /usr/bin/certbot renew --quiet\n'; printf '# BEGIN adsecute-sync\n%s\n# END adsecute-sync\n' "$BLOCK_BODY")"
out=$(rootcron_start 2>&1) || true
case "$out" in *"unrelated root crontab lines differ"*) pass "A5 changed unrelated crontab lines are refused";; *) fail "A5 did not refuse changed unrelated lines: $out";; esac

# A6 NEGATIVE: no saved rootcron.outside -> refuse (cannot prove)
mk_crontab "$BLOCK_BODY"; mv "$STATE_DIR/rootcron.outside" "$STATE_DIR/.o"
out=$(rootcron_start 2>&1) || true
case "$out" in *"cannot be proven"*) pass "A6 missing rootcron.outside refuses (unprovable state)";; *) fail "A6 did not refuse without rootcron.outside: $out";; esac
mv "$STATE_DIR/.o" "$STATE_DIR/rootcron.outside"

# A7 NEGATIVE: no saved block at all -> original refusal preserved
mk_crontab "$BLOCK_BODY"; mv "$STATE_DIR/rootcron.block" "$STATE_DIR/.b"
out=$(rootcron_start 2>&1) || true
case "$out" in *"refusing to invent"*) pass "A7 missing saved block still refuses to invent entries";; *) fail "A7 lost the invent-refusal: $out";; esac
mv "$STATE_DIR/.b" "$STATE_DIR/rootcron.block"

# A8 POSITIVE: D194's exact locked caller is still provably adoptable after a
# NEW preflight records it. This does not adopt a changed old preflight hash.
WRAPPED_BODY="$(python3 - "$BLOCK_BODY" <<'PY'
import importlib.util,sys
sys.dont_write_bytecode=True
s=importlib.util.spec_from_file_location('caller','scripts/operator/sync-cron-call-lifecycle.py')
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
text='# BEGIN adsecute-sync\n'+sys.argv[1]+'\n# END adsecute-sync\n'
print(m.plan(text)[0].splitlines()[1])
PY
)"
printf '# BEGIN adsecute-sync\n%s\n# END adsecute-sync\n' "$WRAPPED_BODY" > "$STATE_DIR/rootcron.block"
STATE_SCHED="$(sha256_file "$STATE_DIR/rootcron.block")"
mk_crontab "$WRAPPED_BODY"
if out=$(rootcron_start 2>&1); then
  case "$out" in *adopting*) pass "A8 exact locked caller is adopted after matching preflight";; *) fail "A8 returned 0 without adopting: $out";; esac
else fail "A8 locked caller refused: $out"; fi

# A9 NEGATIVE: the same wrapper may not bypass an earlier frozen definition.
STATE_SCHED="$BLOCK_SHA"
out=$(rootcron_start 2>&1) || true
case "$out" in *scheduler_sha256*) pass "A9 locked caller refuses a different recorded definition";; *) fail "A9 wrapper bypassed frozen scheduler hash: $out";; esac

[ "$F" -ne 0 ] && { printf '%s %s FAILED\n' "$L" "$F" >&2; exit 1; }
printf '%s PASS — adopts only a provably identical block, refuses every mismatch\n' "$L"
