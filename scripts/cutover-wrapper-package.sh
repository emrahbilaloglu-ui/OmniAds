#!/usr/bin/env bash
set -euo pipefail

# Pins the cutover wrapper by digest, in a manifest that ships beside it.
#
# WHY THIS EXISTS
#
# The deploy only ever synced `docker-compose.yml` to the app host, so the
# script the runbook and `deploy/CUTOVER_REQUIRED` tell an operator to run there
# did not exist on the host at all. The two ways to fix that are both worse than
# this one: telling operators to paste a 900-line script over ssh means the
# wrapper that runs is whatever survived the paste, and cloning the repository
# onto the app host means the wrapper that runs is whatever branch happens to be
# checked out.
#
# Instead the wrapper travels inside the image the cutover is FOR. It lives at
# `scripts/hetzner-sync-cutover.sh`, and the worker image copies `scripts/`
# wholesale, so it is already inside `ghcr.io/erhanrdn/omniads-worker:<sha>` at
# `/app/scripts/hetzner-sync-cutover.sh` with no build-context special case.
# This script's only job is the digest: it writes the wrapper's SHA-256, its
# byte count and this release's cutover requirement to
# `scripts/cutover-wrapper.manifest`, which ships in the same image directory.
# `hetzner-remote.sh deliver_cutover_wrapper` extracts both from the pinned
# image, refuses unless the extracted wrapper hashes to what the manifest pins,
# and the wrapper re-hashes ITSELF against the installed manifest before every
# phase — so the wrapper delivered to the host is provably the wrapper built
# from the commit being cut over to.
#
# WHAT THIS NO LONGER DOES
#
# It used to also emit `scripts/cutover-wrapper-payload.sh`, a generated
# byte-identical duplicate of the wrapper, because the wrapper then lived under
# `.github/` and `.dockerignore` excludes `.github/`. A second copy of a
# security-critical script is a liability even with a drift gate, so the wrapper
# was moved into `scripts/` — the directory the image already copies — and the
# duplicate and its cmp gate were deleted. Nothing is generated from the wrapper
# any more; only measured.
#
# `verify` still has real work: the manifest is a hand-committed file describing
# a file that changes, so CI runs it and a wrapper edit that does not repackage
# fails the build instead of shipping an image whose manifest pins the previous
# release's digest — which `deliver_cutover_wrapper` would then refuse ON THE
# HOST, mid-deploy, instead of here.
#
#   scripts/cutover-wrapper-package.sh emit     regenerate the manifest
#   scripts/cutover-wrapper-package.sh verify   refuse if it has drifted

MODE="${1:-verify}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_REL="scripts/hetzner-sync-cutover.sh"
MANIFEST_REL="scripts/cutover-wrapper.manifest"

SOURCE="${REPO_ROOT}/${SOURCE_REL}"
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

# `wrapper_source` is deliberately BOTH facts at once: the path in this
# repository and, because the builder stage copies the build context to `/app`,
# the path inside the image at `/app/${wrapper_source}`. `deliver_cutover_wrapper`
# cross-checks it against the path it actually extracted, so moving the wrapper
# again without updating the delivery fails loudly rather than reporting that the
# image "does not carry the packaged cutover wrapper".
render_manifest() {
  printf 'wrapper_source=%s\n' "${SOURCE_REL}"
  printf 'wrapper_sha256=%s\n' "${wrapper_sha256}"
  printf 'wrapper_bytes=%s\n' "${wrapper_bytes}"
  printf 'cutover_required=%s\n' "${cutover_required}"
}

case "${MODE}" in
  emit)
    render_manifest > "${MANIFEST}"
    printf '[cutover-package] emitted %s for %s (sha256=%s bytes=%s cutover_required=%s)\n' \
      "${MANIFEST_REL}" "${SOURCE_REL}" "${wrapper_sha256}" "${wrapper_bytes}" "${cutover_required}"
    ;;

  verify)
    [ -f "${MANIFEST}" ] || die "missing ${MANIFEST_REL}; run 'npm run cutover:package' and commit the result"
    expected="$(render_manifest)"
    actual="$(cat "${MANIFEST}")"
    [ "${expected}" = "${actual}" ] \
      || die "${MANIFEST_REL} does not describe the current wrapper. Expected:
${expected}
Found:
${actual}"
    # The duplicate is gone; keep it gone. A regenerated copy under `scripts/`
    # would ship a second wrapper inside the image, and whichever one
    # `deliver_cutover_wrapper` happened to extract would be the one that drives
    # the cutover.
    [ ! -e "${REPO_ROOT}/scripts/cutover-wrapper-payload.sh" ] \
      || die "scripts/cutover-wrapper-payload.sh is back. The wrapper is no longer duplicated into a payload — it lives at ${SOURCE_REL}, which the image already carries. Delete the payload."
    printf '[cutover-package] PASS %s pins %s (sha256=%s, bytes=%s, cutover_required=%s)\n' \
      "${MANIFEST_REL}" "${SOURCE_REL}" "${wrapper_sha256}" "${wrapper_bytes}" "${cutover_required}"
    ;;

  *)
    die "unknown mode '${MODE}'; use emit or verify"
    ;;
esac
