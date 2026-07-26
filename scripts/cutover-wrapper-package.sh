#!/usr/bin/env bash
set -euo pipefail

# Packages the cutover wrapper into an artifact the app host can actually
# receive, and pins it by digest.
#
# WHY THIS EXISTS
#
# The deploy only ever synced `docker-compose.yml` to the app host, so
# `.github/scripts/hetzner-sync-cutover.sh` — the script the runbook and
# `deploy/CUTOVER_REQUIRED` tell an operator to run there — did not exist on the
# host at all. The two ways to fix that are both worse than this one: telling
# operators to paste a 900-line script over ssh means the wrapper that runs is
# whatever survived the paste, and cloning the repository onto the app host means
# the wrapper that runs is whatever branch happens to be checked out.
#
# Instead the wrapper travels inside the image the cutover is FOR. `.dockerignore`
# excludes `.github/`, and the worker image copies `scripts/`, so this script
# writes a verbatim copy of the wrapper to `scripts/cutover-wrapper-payload.sh`
# and its SHA-256 to `scripts/cutover-wrapper.manifest`. Both are then inside
# `ghcr.io/erhanrdn/omniads-worker:<sha>`, which means the wrapper delivered to
# the host is provably the wrapper built from the commit being cut over to —
# `hetzner-remote.sh deliver_cutover_wrapper` extracts them from the pinned image
# and the wrapper re-hashes itself against the manifest before every phase.
#
# `verify` exists so the copy can never silently drift from the source: CI runs
# it, so a change to the wrapper that does not repackage fails the build instead
# of shipping an image whose wrapper is a release behind.
#
#   scripts/cutover-wrapper-package.sh emit     regenerate the payload + manifest
#   scripts/cutover-wrapper-package.sh verify   refuse if either has drifted

MODE="${1:-verify}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_REL=".github/scripts/hetzner-sync-cutover.sh"
PAYLOAD_REL="scripts/cutover-wrapper-payload.sh"
MANIFEST_REL="scripts/cutover-wrapper.manifest"

SOURCE="${REPO_ROOT}/${SOURCE_REL}"
PAYLOAD="${REPO_ROOT}/${PAYLOAD_REL}"
MANIFEST="${REPO_ROOT}/${MANIFEST_REL}"

die() { printf '[cutover-package] ABORT %s\n' "$1" >&2; exit 1; }

# The DB host and the app host are Debian and have `sha256sum`; a developer
# machine is macOS and has `shasum`. Picking one and hoping is how a packaging
# gate becomes an unconditional failure on somebody's laptop.
sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

[ -f "${SOURCE}" ] || die "missing ${SOURCE_REL}"

wrapper_sha256="$(sha256_file "${SOURCE}")"
wrapper_bytes="$(wc -c < "${SOURCE}" | tr -d '[:space:]')"

# The ordinary deploy has to know, on the host, whether this release may be
# migrated outside the cutover lock. `deploy/CUTOVER_REQUIRED` is a repository
# file and the app host has no repository, so the answer is carried in the
# manifest the image already delivers.
if [ -f "${REPO_ROOT}/deploy/CUTOVER_REQUIRED" ]; then
  cutover_required=yes
else
  cutover_required=no
fi

render_manifest() {
  printf 'wrapper_source=%s\n' "${SOURCE_REL}"
  printf 'wrapper_payload=%s\n' "${PAYLOAD_REL}"
  printf 'wrapper_sha256=%s\n' "${wrapper_sha256}"
  printf 'wrapper_bytes=%s\n' "${wrapper_bytes}"
  printf 'cutover_required=%s\n' "${cutover_required}"
}

case "${MODE}" in
  emit)
    cp "${SOURCE}" "${PAYLOAD}"
    chmod 0755 "${PAYLOAD}"
    render_manifest > "${MANIFEST}"
    printf '[cutover-package] emitted %s and %s (sha256=%s bytes=%s cutover_required=%s)\n' \
      "${PAYLOAD_REL}" "${MANIFEST_REL}" "${wrapper_sha256}" "${wrapper_bytes}" "${cutover_required}"
    ;;

  verify)
    [ -f "${PAYLOAD}" ] || die "missing ${PAYLOAD_REL}; run 'npm run cutover:package' and commit the result"
    [ -f "${MANIFEST}" ] || die "missing ${MANIFEST_REL}; run 'npm run cutover:package' and commit the result"
    cmp -s "${SOURCE}" "${PAYLOAD}" \
      || die "${PAYLOAD_REL} is not byte-identical to ${SOURCE_REL}. The image would deliver a wrapper from an older commit; run 'npm run cutover:package'."
    expected="$(render_manifest)"
    actual="$(cat "${MANIFEST}")"
    [ "${expected}" = "${actual}" ] \
      || die "${MANIFEST_REL} does not describe the current wrapper. Expected:
${expected}
Found:
${actual}"
    printf '[cutover-package] PASS wrapper payload and manifest match %s (sha256=%s, cutover_required=%s)\n' \
      "${SOURCE_REL}" "${wrapper_sha256}" "${cutover_required}"
    ;;

  *)
    die "unknown mode '${MODE}'; use emit or verify"
    ;;
esac
