#!/usr/bin/env bash
# preflight must refuse a lanes-on environment BEFORE any dump.
#
# The incident, twice: preflight pins env_file_sha256 and assert_state_invariants
# refuses any later change, so lanes must be off BEFORE the epoch opens. With
# lanes on, verify-contract refuses at 14/15 — but only after quiesce has taken
# the site down and a ~25 GB artifact has already been written.
set -euo pipefail
cd "$(dirname "$0")/.."
L="[cutover-lane-prereq]"; F=0
pass(){ printf '%s PASS %s\n' "$L" "$1"; }
fail(){ printf '%s FAIL %s\n' "$L" "$1" >&2; F=$((F+1)); }
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
ENV_FILE="$W/env"
log(){ printf 'LOG %s\n' "$*"; }
die(){ printf 'DIE %s\n' "$*"; return 1; }
eval "$(awk '/^CUTOVER_LANE_SWITCHES=/{print} /^assert_lanes_off_for_preflight\(\)/,/^}/' scripts/hetzner-sync-cutover.sh)"

ALL="ADSECUTE_SYNC_GLOBAL_ENABLED ADSECUTE_SYNC_LANE_META_SYNC_ENABLED ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED ADSECUTE_SYNC_LANE_SOURCE_INGEST_ENABLED ADSECUTE_SYNC_LANE_CRON_ENQUEUE_ENABLED ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED ADSECUTE_SYNC_LANE_RETENTION_ENABLED"
write_env(){ : > "$ENV_FILE"; for k in $ALL; do printf '%s=%s\n' "$k" "${!k:-}" >> "$ENV_FILE"; done; printf 'OTHER=x\n' >> "$ENV_FILE"; }
clear_all(){ for k in $ALL; do unset "$k" || true; done; }

# L1 POSITIVE: all off, retention off
clear_all; write_env
if out=$(assert_lanes_off_for_preflight 2>&1); then
  case "$out" in *"all 7 switches off"*) pass "L1 all lanes off + retention off PASSES";; *) pass "L1 passes (msg: $out)";; esac
else fail "L1 refused a fully-off env: $out"; fi

# L2 NEGATIVE: one lane on -> refuse before any dump
clear_all; ADSECUTE_SYNC_LANE_META_SYNC_ENABLED=enabled; write_env
out=$(assert_lanes_off_for_preflight 2>&1) || true
case "$out" in *"Sync lanes are still ENABLED"*META_SYNC*) pass "L2 a single enabled lane REFUSES and names it";; *) fail "L2 did not refuse one enabled lane: $out";; esac

# L3 NEGATIVE: global switch on
clear_all; ADSECUTE_SYNC_GLOBAL_ENABLED=enabled; write_env
out=$(assert_lanes_off_for_preflight 2>&1) || true
case "$out" in *"Sync lanes are still ENABLED"*GLOBAL*) pass "L3 the global switch on REFUSES";; *) fail "L3 did not refuse the global switch: $out";; esac

# L4 NEGATIVE: all seven on (the exact incident)
clear_all; for k in ADSECUTE_SYNC_GLOBAL_ENABLED ADSECUTE_SYNC_LANE_META_SYNC_ENABLED ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED ADSECUTE_SYNC_LANE_SOURCE_INGEST_ENABLED ADSECUTE_SYNC_LANE_CRON_ENQUEUE_ENABLED ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED; do eval "$k=enabled"; done; write_env
out=$(assert_lanes_off_for_preflight 2>&1) || true
case "$out" in *"can never reach verify-contract"*) pass "L4 the incident shape REFUSES with an actionable message";; *) fail "L4 did not refuse the incident shape: $out";; esac

# L5 NEGATIVE: retention ON
clear_all; ADSECUTE_SYNC_LANE_RETENTION_ENABLED=enabled; write_env
out=$(assert_lanes_off_for_preflight 2>&1) || true
case "$out" in *"retention is ENABLED"*) pass "L5 retention ON REFUSES separately";; *) fail "L5 did not refuse retention on: $out";; esac

# L6 NEGATIVE: a switch missing entirely -> ambiguous is not off
clear_all; write_env; grep -v '^ADSECUTE_SYNC_LANE_CRON_ENQUEUE_ENABLED=' "$ENV_FILE" > "$W/e2"; mv "$W/e2" "$ENV_FILE"
out=$(assert_lanes_off_for_preflight 2>&1) || true
case "$out" in *"An ambiguous switch is not an off switch"*) pass "L6 a MISSING switch refuses (ambiguous != off)";; *) fail "L6 did not refuse a missing switch: $out";; esac

# L7 NEGATIVE: retention key missing
clear_all; write_env; grep -v '^ADSECUTE_SYNC_LANE_RETENTION_ENABLED=' "$ENV_FILE" > "$W/e3"; mv "$W/e3" "$ENV_FILE"
out=$(assert_lanes_off_for_preflight 2>&1) || true
case "$out" in *RETENTION*) pass "L7 a missing retention switch refuses";; *) fail "L7 did not refuse a missing retention switch: $out";; esac

# L8: the prerequisite is wired BEFORE the dump in the preflight phase
pf="$(awk '/^  preflight\)/,/^    ;;/' scripts/hetzner-sync-cutover.sh)"
case "$pf" in *assert_lanes_off_for_preflight*) : ;; *) fail "L8 preflight does not call the prerequisite"; esac
pre_line=$(printf '%s\n' "$pf" | grep -n 'assert_lanes_off_for_preflight' | head -1 | cut -d: -f1)
dump_line=$(printf '%s\n' "$pf" | grep -n 'take_verified_backup' | head -1 | cut -d: -f1)
if [ -n "$pre_line" ] && [ -n "$dump_line" ] && [ "$pre_line" -lt "$dump_line" ]; then
  pass "L8 the prerequisite runs BEFORE take_verified_backup (line $pre_line < $dump_line)"
else
  fail "L8 ordering unproven (prereq=$pre_line dump=$dump_line)"
fi

# L9: verify-contract is untouched
case "$(awk '/^  verify-contract\)/,/^    ;;/' scripts/hetzner-sync-cutover.sh)" in
  *global-sync-rollout*) pass "L9 verify-contract still runs the rollout preflight independently";;
  *) fail "L9 verify-contract appears altered";;
esac

[ "$F" -ne 0 ] && { printf '%s %s FAILED\n' "$L" "$F" >&2; exit 1; }
printf '%s PASS — a lanes-on epoch refuses before any dump\n' "$L"
