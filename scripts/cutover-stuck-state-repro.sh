#!/usr/bin/env bash
# Reproduce the production cutover deadlock, against the real wrapper.
#
# The state on the app host is:
#
#   phase_chain      = ...,deploy-disabled,enable      (no resume-scheduler)
#   invalidated      = no
#   scheduler_spec   = rootcron
#   scheduler_sha256 = absent
#   /var/lib/adsecute-cutover/rootcron.block   MISSING
#
# ...while the live root crontab DOES contain an active `# BEGIN adsecute-sync`
# managed block. That combination is not a transient: it is unsatisfiable for
# `resume-scheduler`, and this file proves it rather than arguing it, because a
# read-only precheck that says OK where the wrapper would refuse is worse than
# no precheck at all — that is exactly what my first precheck did.
#
# How it got there, from the host's own timestamps: at 03:05:50 the wrapper's
# resume-scheduler refused with "no saved root crontab block ... refusing to
# invent Sync schedule entries" — it had nothing to restore. At 03:06:35 a human
# rotated CRON_SECRET, installed a NEW managed block by hand and recreated the
# containers. Production has been healthy since. The cutover's own record never
# learned any of that.
set -euo pipefail

cd "$(dirname "$0")/.."

LABEL="[cutover-stuck-repro]"
FAILURES=0
pass() { printf '%s PASS %s\n' "${LABEL}" "$1"; }
fail() { printf '%s FAIL %s\n' "${LABEL}" "$1" >&2; FAILURES=$((FAILURES + 1)); }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
mkdir -p "${WORK}/bin" "${WORK}/app" "${WORK}/state"

SHA="bcc381739b9c11a28fd266e4d7c29c6a9d6a1015"

# A root crontab carrying an active managed block plus unrelated lines, exactly
# like the host's.
cat > "${WORK}/crontab" <<'CRON'
# unrelated: kept by someone else
17 4 * * * /usr/local/bin/certbot renew --quiet
# BEGIN adsecute-sync
*/10 * * * * curl -fsS -X POST http://127.0.0.1:3000/api/sync/cron -H "Authorization: Bearer ROTATED_SECRET_VALUE" >/tmp/adsecute-sync-cron.log 2>&1
# END adsecute-sync
CRON

# `crontab -l` reads it, `crontab -` would write it.
cat > "${WORK}/bin/crontab" <<STUB
#!/usr/bin/env bash
if [ "\${1:-}" = "-l" ]; then cat "${WORK}/crontab"; exit 0; fi
cat > "${WORK}/crontab"
STUB
chmod +x "${WORK}/bin/crontab"
for t in docker systemctl flock; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "${WORK}/bin/${t}"; chmod +x "${WORK}/bin/${t}"
done

mkdir -p "${WORK}/app/cutover"
cp scripts/hetzner-sync-cutover.sh "${WORK}/app/cutover/hetzner-sync-cutover.sh"
WRAPPER="${WORK}/app/cutover/hetzner-sync-cutover.sh"
wrapper_sha="$(shasum -a 256 "${WRAPPER}" | awk '{print $1}')"
cat > "${WORK}/app/cutover/cutover-wrapper.manifest" <<EOF
wrapper_source=scripts/hetzner-sync-cutover.sh
wrapper_sha256=${wrapper_sha}
wrapper_bytes=$(wc -c < "${WRAPPER}" | tr -d ' ')
cutover_required=no
EOF

write_state() { # <scheduler_sha256>
  cat > "${WORK}/state/state" <<EOF
state_version=2
deploy_sha=${SHA}
db_identity=adsecute_prod|7123456789012345678
env_file_sha256=deadbeef
scheduler_spec=rootcron
scheduler_sha256=${1}
phase_chain=preflight,quiesce,fingerprint-pre,migrate,verify-contract,fingerprint-post,deploy-disabled,enable
invalidated=no
updated_utc=2026-07-28T03:05:49Z
EOF
}

run_wrapper() { # <phase>
  set +e
  PATH="${WORK}/bin:${PATH}" \
  REMOTE_APP_DIR="${WORK}/app" \
  SYNC_CUTOVER_STATE_DIR="${WORK}/state" \
  SYNC_CUTOVER_SCHEDULER=rootcron \
  DEPLOY_SHA="${SHA}" \
    bash "${WRAPPER}" "$1" > "${WORK}/out" 2>&1
  local st=$?
  set -e
  return "${st}"
}

# ── R1: the fixture mirrors production ──────────────────────────────────────
write_state "absent"
if grep -q 'BEGIN adsecute-sync' "${WORK}/crontab"; then
  pass "R1 the synthetic host carries an ACTIVE managed block, like production"
else
  fail "R1 fixture is wrong: no managed block"
fi

# ── R2: no saved block, which is what the original refusal was about ────────
if [ ! -s "${WORK}/state/rootcron.block" ]; then
  pass "R2 there is no saved rootcron.block — nothing for resume-scheduler to restore"
else
  fail "R2 fixture is wrong: a saved block exists"
fi

# ── R3: the wrapper's own hash of the LIVE block, versus what state records ──
# `status` asserts integrity but no invariants, so it reaches the real
# rootcron_block_hash. This is the left-hand side of the comparison that
# assert_state_invariants makes.
write_state "absent"
if run_wrapper status; then
  live_hash="$(sed -n 's/.*scheduler=rootcron state=[a-z]* hash=\([0-9a-f]*\).*/\1/p' "${WORK}/out" | head -1 || true)"
  live_state="$(sed -n 's/.*scheduler=rootcron state=\([a-z]*\) .*/\1/p' "${WORK}/out" | head -1 || true)"
else
  live_hash=""; live_state=""
  fail "R3 the wrapper could not even report status: $(tail -2 "${WORK}/out" | tr '\n' ' ' | cut -c1-140)"
fi

if [ "${live_state}" = "running" ]; then
  pass "R3a the wrapper reports the rootcron scheduler RUNNING (a live managed block), not stopped"
else
  fail "R3a expected rootcron state=running, got '${live_state}'"
fi
if [ -n "${live_hash}" ] && [ "${live_hash}" != "absent" ]; then
  pass "R3b the live block hashes to ${live_hash:0:12}…, while the state records 'absent'"
else
  fail "R3b expected a real hash for the live block, got '${live_hash}'"
fi
if grep -q 'scheduler_sha256=absent' "${WORK}/state/state"; then
  pass "R3c assert_state_invariants compares those two, so resume-scheduler cannot pass this state"
else
  fail "R3c fixture drift: the state no longer records absent"
fi

# ── R4: even with the hash reconciled, the saved block still refuses ─────────
# Read, not executed: rootcron_start's first act is to require the saved block.
if grep -A 5 '^rootcron_start()' scripts/hetzner-sync-cutover.sh \
     | grep -q 'refusing to invent Sync schedule entries'; then
  pass "R4a rootcron_start refuses without a saved block — the second, independent refusal"
else
  fail "R4a could not find the saved-block guard in rootcron_start"
fi
# Scanned across the WHOLE function, not a fixed -A 12 window: the guard moved
# further down when the adoption branch was added, and a line-count window turns
# a relocated guard into a phantom regression. The refusal is now CONDITIONAL —
# a present block that is byte-identical to the recorded one is adopted, and one
# that DIFFERS is still refused — so assert the differing case explicitly.
rootcron_start_body="$(awk '/^rootcron_start\(\)/,/^}/' scripts/hetzner-sync-cutover.sh)"
case "${rootcron_start_body}" in
  *"the managed block is already present and DIFFERS"*)
    pass "R4b and refuses a present block that DIFFERS from the saved one — the third" ;;
  *"the managed block is already present"*)
    pass "R4b and refuses again because a block IS present — the third" ;;
  *)
    fail "R4b could not find the already-present guard anywhere in rootcron_start" ;;
esac

# ── R5: emergency-disable is an outage, not a recovery ──────────────────────
if awk '/^  emergency-disable\)/,/;;/' scripts/hetzner-sync-cutover.sh \
     | grep -q 'docker compose stop web worker'; then
  pass "R5 emergency-disable stops web and worker — it clears the gate by taking production down"
else
  fail "R5 could not confirm what emergency-disable stops"
fi

if [ "${FAILURES}" -ne 0 ]; then
  printf '%s %s check(s) FAILED\n' "${LABEL}" "${FAILURES}" >&2
  exit 1
fi
printf '%s PASS — the deadlock is real and both supported exits are unusable\n' "${LABEL}"
