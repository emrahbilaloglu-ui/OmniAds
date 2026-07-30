#!/bin/bash
# Lane switches, with NO agent forwarding at all.
#
#   scripts/operator/lanes.sh disable   all 8 managed switches off (preflight's prerequisite)
#   scripts/operator/lanes.sh restore   put the enabled file back, byte-for-byte
#
# WHY THIS IS NOT PART OF THE FORWARDED SESSION
#
# `rollout:disable` has no database preconditions by design — stopping must work
# even when the database is unreachable — so it needs no agent, no DB host and no
# forwarded credential. Least privilege: the identity that can reach the database
# is lent only to the phases that cannot work without it.
set -euo pipefail

HERE="$(cd -P -- "$(dirname -- "$0")" && pwd -P)"
. "${HERE}/pins.sh"

ACTION="${1:-}"
case "${ACTION}" in disable|restore) : ;; *) printf 'usage: %s disable|restore\n' "$0" >&2; exit 1 ;; esac

# `disable` runs the release's own rollout script from the pinned image, and
# `restore` will only accept a backup hashing to OP_ENV_SHA_ENABLED. Both are
# release-specific, so neither may run against unset pins.
op_pins_require || exit 1

LOG_DIR="${OP_LOG_DIR:-${TMPDIR:-/tmp}/adsecute-operator-logs}"; mkdir -p "${LOG_DIR}"
LOG="${LOG_DIR}/operator-lanes-${ACTION}-$(date -u +%Y%m%dT%H%M%SZ).log"
: > "${LOG}"; chmod 0600 "${LOG}"

ssh_plain() {
  ssh -o ForwardAgent=no -o ControlMaster=no -o ControlPath=none \
      -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 \
      -T "${OP_APP_HOST}" "$@"
}

{
printf '[%s] lanes %s (no agent forwarding)\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${ACTION}"

if [ "${ACTION}" = "disable" ]; then
  ssh_plain "OP_SHA=$(printf %q "${OP_SHA}") \
             OP_WORKER_REPO=$(printf %q "${OP_WORKER_REPO}") \
             OP_ENV_FILE=$(printf %q "${OP_ENV_FILE}") bash -s" <<'REMOTE'
set -uo pipefail
D="$(dirname "${OP_ENV_FILE}")"
BEFORE="$(sha256sum "${OP_ENV_FILE}" | awk '{print $1}')"
printf 'env_sha256_before=%s\n' "${BEFORE}"
printf 'keys_before=%s\n' "$(grep -acE '^[A-Za-z_][A-Za-z0-9_]*=' "${OP_ENV_FILE}")"

# The repository's own sanctioned script, executed from the pinned release image
# with the project directory mounted at its real path — so the script's defaults
# already point at the right file and no override is needed. The entrypoint is
# the stock Node passthrough (`exec "$@"`), so nothing else runs.
docker run --rm -v "${D}:${D}" \
  "${OP_WORKER_REPO}:${OP_SHA}" \
  node --import tsx scripts/global-sync-rollout.ts disable
printf 'rollout_exit=%s\n' "$?"

AFTER="$(sha256sum "${OP_ENV_FILE}" | awk '{print $1}')"
printf 'env_sha256_after=%s\n' "${AFTER}"
printf 'keys_after=%s\n' "$(grep -acE '^[A-Za-z_][A-Za-z0-9_]*=' "${OP_ENV_FILE}")"

OFF=0
for K in ADSECUTE_SYNC_GLOBAL_ENABLED ADSECUTE_SYNC_LANE_META_SYNC_ENABLED \
         ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED \
         ADSECUTE_SYNC_LANE_SOURCE_INGEST_ENABLED ADSECUTE_SYNC_LANE_CRON_ENQUEUE_ENABLED \
         ADSECUTE_SYNC_LANE_ASSIGNMENT_MUTATION_ENABLED ADSECUTE_SYNC_LANE_RETENTION_ENABLED; do
  V="$(grep -aE "^${K}=" "${OP_ENV_FILE}" | head -1 | cut -d= -f2-)"
  [ -z "${V}" ] && OFF=$((OFF + 1))
done
printf 'switches_off=%s of 8\n' "${OFF}"
[ "${OFF}" = "8" ] || { printf 'FAIL not every switch is off\n'; exit 1; }

# Independent proof that nothing outside the managed keys moved. The script says
# so itself; this checks it from the outside.
BK="$(ls -1t "${OP_ENV_FILE}".rollout-backup-* 2>/dev/null | head -1)"
printf 'backup=%s\n' "${BK:-<none>}"
[ -n "${BK}" ] || { printf 'FAIL no backup was written\n'; exit 1; }
CH="$(diff <(grep -avE '^ADSECUTE_SYNC_(GLOBAL|LANE_[A-Z_]+)_ENABLED=' "${BK}") \
           <(grep -avE '^ADSECUTE_SYNC_(GLOBAL|LANE_[A-Z_]+)_ENABLED=' "${OP_ENV_FILE}") \
     | grep -c '^[<>]' || true)"
printf 'non_managed_lines_changed=%s\n' "${CH}"
[ "${CH}" = "0" ] || { printf 'FAIL unrelated lines changed; restore from %s\n' "${BK}"; exit 1; }
printf 'LANES DISABLED AND PROVEN\n'
REMOTE
else
  ssh_plain "OP_ENV_FILE=$(printf %q "${OP_ENV_FILE}") \
             OP_EXPECT=$(printf %q "${OP_ENV_SHA_ENABLED}") bash -s" <<'REMOTE'
set -uo pipefail
# Fail closed: restore only from a backup whose hash equals the value recorded
# BEFORE anything was ever changed. A backup that does not match is not the
# state we are trying to return to, whatever its filename says.
BK="$(ls -1t "${OP_ENV_FILE}".rollout-backup-* 2>/dev/null | while read -r f; do
        [ "$(sha256sum "$f" | awk '{print $1}')" = "${OP_EXPECT}" ] && { printf '%s\n' "$f"; break; }
      done)"
[ -n "${BK}" ] || { printf 'FAIL no backup hashes to %s\n' "${OP_EXPECT}"; exit 1; }
printf 'restoring_from=%s\n' "${BK}"
cp -p "${OP_ENV_FILE}" "${OP_ENV_FILE}.cutover-disabled.$(date -u +%Y%m%dT%H%M%SZ)"
install -m 600 -o root -g root "${BK}" "${OP_ENV_FILE}.restore.tmp"
mv -f "${OP_ENV_FILE}.restore.tmp" "${OP_ENV_FILE}"
sync
NOW="$(sha256sum "${OP_ENV_FILE}" | awk '{print $1}')"
printf 'restored_sha256=%s byte_identical=%s\n' "${NOW}" "$([ "${NOW}" = "${OP_EXPECT}" ] && echo YES || echo NO)"
[ "${NOW}" = "${OP_EXPECT}" ] || { printf 'FAIL restore did not reproduce the recorded state\n'; exit 1; }
printf 'enabled_switches=%s\n' "$(grep -acE '^ADSECUTE_SYNC_(GLOBAL|LANE_[A-Z_]+)_ENABLED=enabled' "${OP_ENV_FILE}")"
printf 'LANES RESTORED BYTE-FOR-BYTE\n'
REMOTE
fi
} 2>&1 | grep -aviE '(secret|token|password|passwd|api[_-]?key|authorization|bearer|PRIVATE KEY|DATABASE_URL|_URL=)' | tee -a "${LOG}"
