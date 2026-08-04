#!/usr/bin/env bash
# The migrate phase must refresh the capacity sample its own migration guard
# reads — and must do so on EVIDENCE, never on the sampler's exit code.
#
# THE INCIDENT THIS ENCODES (2026-08-04)
#
# `migrate` refused with:
#   migration_capacity_refused:sync_release_gates_provider_scope: sync_release_gates
#   is 2596438016B and needs 7789314048B free, but the newest db_host_healthcheck
#   sample is 1090.825279s old.
#
# Two gates in the same release were mutually unsatisfiable:
#   - lib/migrations.ts refuses a heavy step unless a db_host_healthcheck sample
#     is younger than 900s;
#   - the only producer of that sample is adsecute-db-healthcheck.timer, which
#     `quiesce` is REQUIRED to stop because it writes to adsecute_prod between
#     polls and corrupts a restore.
# So after quiescence the sample could only age. 137 GB was actually free; the
# gate failed purely on the age of its evidence. The site was down at the time.
#
# The timer runs OnUnitActiveSec=15m — exactly the 900s threshold — so the sample
# is at the limit even outside a cutover. That latent marginality is NOT fixed
# here (it would mean moving a threshold, i.e. weakening a gate, or changing host
# infrastructure); it is recorded in S7 so the next reader sees it.
set -euo pipefail
cd "$(dirname "$0")/.."

L="[cutover-migration-capacity-sample]"; F=0
pass(){ printf '%s PASS %s\n' "$L" "$1"; }
fail(){ printf '%s FAIL %s\n' "$L" "$1" >&2; F=$((F+1)); }

SRC=scripts/hetzner-sync-cutover.sh
[ -f "$SRC" ] || { printf '%s FAIL %s missing\n' "$L" "$SRC" >&2; exit 1; }

# The migrate phase body: from `  migrate)` to the next top-level phase label.
BODY="$(awk '/^  migrate\)$/{f=1} f{print} f && /^    ;;$/{exit}' "$SRC")"
[ -n "$BODY" ] || { printf '%s FAIL could not extract the migrate phase body\n' "$L" >&2; exit 1; }

line_of() { printf '%s\n' "$BODY" | grep -n -- "$1" | head -1 | cut -d: -f1; }

# S1 the sample is refreshed at all, using the sanctioned sampler
if printf '%s\n' "$BODY" | grep -q 'adsecute-db-healthcheck\.sh'; then
  pass "S1 migrate refreshes the capacity sample with the sanctioned host sampler"
else
  fail "S1 migrate does not refresh the capacity sample; the heavy-step guard will refuse on evidence quiesce killed"
fi

# S2 refresh happens AFTER the quiescence proof (so that proof sees an idle DB)
Q="$(line_of 'assert_database_quiescent')"
R="$(line_of 'adsecute-db-healthcheck\.sh')"
if [ -n "$Q" ] && [ -n "$R" ] && [ "$Q" -lt "$R" ]; then
  pass "S2 the refresh runs after the quiescence proof, not before it"
else
  fail "S2 ordering wrong: quiescence proof at ${Q:-none}, refresh at ${R:-none}"
fi

# S3 refresh happens BEFORE the migration container is started
M="$(line_of 'docker compose up --no-deps')"
if [ -n "$R" ] && [ -n "$M" ] && [ "$R" -lt "$M" ]; then
  pass "S3 the refresh runs before migrations start"
else
  fail "S3 ordering wrong: refresh at ${R:-none}, migrations at ${M:-none}"
fi

# S4 the phase must NOT die on the sampler's exit code — that code reports backup
#    age and disk thresholds, which are a different question from "is there a
#    fresh sample". Gating on it would make a stale DB-host backup block a
#    migration for no reason.
SAMPLER_LINE="$(printf '%s\n' "$BODY" | grep -n 'adsecute-db-healthcheck\.sh' | head -1 | cut -d: -f2-)"
if printf '%s' "$SAMPLER_LINE" | grep -q '|| *die'; then
  fail "S4 migrate dies on the sampler's exit code; a stale DB-host backup would block migrations"
else
  pass "S4 migrate does not gate on the sampler's exit code"
fi

# S5 ...but the sampler's verdict must still be logged, not swallowed silently.
if printf '%s\n' "$BODY" | grep -q 'capacity sampler exit='; then
  pass "S5 the sampler's exit and verdict are logged, so a failure is visible"
else
  fail "S5 the sampler's outcome is discarded; a broken sampler would be silent"
fi

# S6 the phase gates on the EVIDENCE: sample must exist and be inside 900s, and
#    both failures must be fatal.
HAS_AGE_QUERY=0; HAS_MISSING_DIE=0; HAS_STALE_DIE=0
printf '%s\n' "$BODY" | grep -q "system_capacity_snapshots" && HAS_AGE_QUERY=1
printf '%s\n' "$BODY" | grep -q 'die "the capacity table exists but holds no db_host_healthcheck sample' && HAS_MISSING_DIE=1
printf '%s\n' "$BODY" | grep -qE '\[ "\$\{capacity_sample_age\}" -lt 900 \]' && HAS_STALE_DIE=1
if [ "$HAS_AGE_QUERY" = 1 ] && [ "$HAS_MISSING_DIE" = 1 ] && [ "$HAS_STALE_DIE" = 1 ]; then
  pass "S6 migrate refuses on a missing sample and on one still older than 900s"
else
  fail "S6 evidence gate incomplete (age_query=$HAS_AGE_QUERY missing_die=$HAS_MISSING_DIE stale_die=$HAS_STALE_DIE)"
fi

# S7 the threshold this phase satisfies must match what the migration actually
#    enforces. If lib/migrations.ts moves off 900s, this phase silently stops
#    guaranteeing anything, so the two are pinned together here.
APP_THRESHOLD="$(grep -oE 'ageSeconds > [0-9]+' lib/migrations.ts | head -1 | grep -oE '[0-9]+' || true)"
if [ "$APP_THRESHOLD" = "900" ]; then
  pass "S7 the wrapper's 900s check matches lib/migrations.ts (ageSeconds > 900)"
else
  fail "S7 lib/migrations.ts enforces '${APP_THRESHOLD:-unknown}s' but the wrapper checks 900s; they must move together"
fi

# S8 the sampler path must be the one the DB host's systemd unit actually runs.
if grep -q '/usr/local/bin/adsecute-db-healthcheck.sh' "$SRC"; then
  pass "S8 the wrapper invokes the same path the healthcheck unit's ExecStart uses"
else
  fail "S8 the wrapper does not invoke /usr/local/bin/adsecute-db-healthcheck.sh"
fi

# S9 the table is created BY a migration, so a database that predates it must not
#    be blocked by this phase. The app-side guard probes with to_regclass and
#    catches; this must too, or a first-ever migration can never run.
if printf '%s\n' "$BODY" | grep -q "to_regclass('system_capacity_snapshots')" \
   && printf '%s\n' "$BODY" | grep -q 'does not exist yet'; then
  pass "S9 an absent capacity table defers to the migration's own guard instead of blocking"
else
  fail "S9 migrate would hard-fail on a database that has not yet created system_capacity_snapshots"
fi

[ "$F" -ne 0 ] && { printf '%s %s FAILED\n' "$L" "$F" >&2; exit 1; }
printf '%s PASS — migrate refreshes its own capacity evidence and gates on the evidence, not the sampler exit\n' "$L"
