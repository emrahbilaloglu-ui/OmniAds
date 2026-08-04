#!/usr/bin/env bash
# The operator-side single-epoch guard must refuse by default, and when it does
# allow a supersede it must be because superseding strands nothing — not because
# a proxy happened to be satisfied.
#
# THE INCIDENT THIS ENCODES (2026-08-04)
#
# Epoch f77c1dd28f01-20260804T025833Z reached phase_chain=preflight,quiesce,
# fingerprint-pre and then `migrate` refused: a local `next dev` server was
# tunnelling into the production database through `ssh -L`, so quiescence could
# not hold. Production was restored and verified healthy, which left the epoch
# with nothing in flight and a rollback artifact ~3h stale — worthless for the
# zero-data-loss guarantee it exists to provide.
#
# The guard's condition was `phase_chain = "preflight"`. That is a PROXY for "no
# in-flight cutover work", and it was wrong here in the strict direction: nothing
# was in flight, yet the only sanctioned way forward (run preflight again, which
# rewrites state from scratch and takes a fresh artifact) was refused. A guard
# with no reachable exit is how an operator ends up hand-editing state, which is
# the thing the whole design forbids.
#
# The proxy was replaced by the invariant in two parts: the epoch must not have
# reached a phase whose effects a supersede cannot take back, and production must
# be provably back up. This file pins both, and pins that refusal is still the
# default.
set -euo pipefail
cd "$(dirname "$0")/.."

L="[cutover-supersede-guard]"; F=0
pass(){ printf '%s PASS %s\n' "$L" "$1"; }
fail(){ printf '%s FAIL %s\n' "$L" "$1" >&2; F=$((F+1)); }

SRC=scripts/operator/host-phase.sh
[ -f "$SRC" ] || { printf '%s FAIL %s missing\n' "$L" "$SRC" >&2; exit 1; }

# ── Behavioural: the phase-chain classifier, run for real ──────────────────
#
# This is the part that decides whether a half-finished epoch may be abandoned,
# so it is executed rather than pattern-matched. The loop is lifted verbatim out
# of the guard and driven with a stub `die`, so a change to the allowed set here
# fails this file rather than silently widening what may be superseded.
LOOP="$(awk '/for ph in \$\{CUR_CHAIN\/\/,\/ \}; do/{f=1} f{print} f && /^    done$/{exit}' "$SRC")"
[ -n "$LOOP" ] || { printf '%s FAIL could not extract the phase-chain loop\n' "$L" >&2; exit 1; }

chain_verdict() { # $1 = phase_chain -> prints ALLOW or REFUSE
  CUR_CHAIN="$1" bash -c '
    set -u
    die() { exit 3; }
    CUR_EPOCH=test-epoch
    '"$LOOP"'
    exit 0
  ' >/dev/null 2>&1 && printf 'ALLOW' || printf 'REFUSE'
}

# G1..G4 — everything up to and including fingerprint-pre is undone by restoring
# production, so those chains may be superseded.
for c in "" "preflight" "preflight,quiesce" "preflight,quiesce,fingerprint-pre"; do
  v="$(chain_verdict "$c")"
  if [ "$v" = ALLOW ]; then
    pass "a chain of '${c:-<empty>}' may be superseded (nothing it did survives a restore)"
  else
    fail "chain '${c:-<empty>}' was refused, but restoring production undoes all of it"
  fi
done

# G5..G9 — from migrate onward the database schema, the runtime images or the
# scheduler have moved toward the new release. A fresh preflight would inherit
# that half-moved system and call it a clean baseline.
for c in \
  "preflight,quiesce,fingerprint-pre,migrate" \
  "preflight,quiesce,fingerprint-pre,migrate,verify-contract" \
  "preflight,quiesce,fingerprint-pre,migrate,verify-contract,fingerprint-post" \
  "preflight,quiesce,fingerprint-pre,migrate,verify-contract,fingerprint-post,deploy-disabled" \
  "preflight,quiesce,fingerprint-pre,migrate,verify-contract,fingerprint-post,deploy-disabled,enable"; do
  v="$(chain_verdict "$c")"
  last="${c##*,}"
  if [ "$v" = REFUSE ]; then
    pass "a chain reaching '${last}' is refused"
  else
    fail "chain reaching '${last}' was ALLOWED; a supersede there inherits a half-moved release"
  fi
done

# ── Static: the preconditions around the classifier ────────────────────────

# G10 refusal is still the default — no named epoch, no supersede.
if grep -q 'OP_SUPERSEDE_EPOCH:-}" \]' "$SRC" \
   && grep -q 'To deliberately supersede a stale epoch' "$SRC"; then
  pass "G10 refusal is still the default; a supersede must be named explicitly"
else
  fail "G10 the guard no longer requires OP_SUPERSEDE_EPOCH to be set"
fi

# G11 the named epoch must be the one actually in the state record, so a stale
#     value or a typo cannot abandon a different epoch than the one intended.
if grep -q 'Refusing to supersede an epoch that is not the one actually there' "$SRC"; then
  pass "G11 the named epoch must match the state record exactly"
else
  fail "G11 the epoch-identity check is gone; a stale OP_SUPERSEDE_EPOCH could fire"
fi

# G12 production must be proven back up. A failed quiesce leaves the runtime
#     stopped; superseding then would strand it with no epoch owning it.
if grep -q 'docker ps --filter status=running' "$SRC" \
   && grep -q 'production is not restored, so this would strand a stopped runtime' "$SRC"; then
  pass "G12 a supersede refuses unless the runtime is proven running"
else
  fail "G12 nothing proves the runtime is back before abandoning the epoch"
fi

# G13 the scheduler must be proven released, compared against the block this
#     epoch itself installed rather than against a guessed shape.
if grep -q 'rootcron_block_sha256' "$SRC" \
   && grep -q 'the scheduler was never released' "$SRC"; then
  pass "G13 a supersede refuses while this epoch's own quiesce block is still installed"
else
  fail "G13 nothing proves the scheduler was released before abandoning the epoch"
fi

# G14 an epoch that never quiesced records no block, and absent evidence must not
#     become a refusal — otherwise the ordinary stale-preflight case breaks.
if grep -q 'if \[ -n "${BLOCK_SHA}" \]; then' "$SRC"; then
  pass "G14 an epoch that never quiesced is not blocked by absent scheduler evidence"
else
  fail "G14 the scheduler check does not tolerate an epoch that never quiesced"
fi

# G15 the guard still only applies to preflight; every other phase must refuse to
#     operate outside an epoch this runner opened.
if grep -q 'Refusing to cross wrapper identities' "$SRC"; then
  pass "G15 non-preflight phases still refuse to cross wrapper identities"
else
  fail "G15 the cross-identity refusal for non-preflight phases is gone"
fi

# G16 the decision is recorded either way, so a supersede is never silent.
if grep -q 'DELIBERATE SUPERSEDE of' "$SRC"; then
  pass "G16 the supersede decision is written to the phase log"
else
  fail "G16 a supersede would not be recorded in the phase log"
fi

[ "$F" -ne 0 ] && { printf '%s %s FAILED\n' "$L" "$F" >&2; exit 1; }
printf '%s PASS — supersede refuses by default, allows only a fully-reversible chain, and only with production proven restored\n' "$L"
