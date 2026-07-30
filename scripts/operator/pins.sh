# Pinned constants for an operator cutover session. SOURCED, never executed.
#
# Split deliberately into two halves:
#
#   INFRASTRUCTURE — stable across releases, so it lives here as a literal.
#   RELEASE        — different for every cutover, so it is REQUIRED from the
#                    environment and has no default at all.
#
# The release half used to be hard-coded to one commit. That is fine for a single
# engagement and wrong for a file that ships in the repo: the next operator would
# inherit last release's digests and, because every check would still "pass"
# against them, would be told a stale target was verified. There is no default
# that is safer than refusing, so there is no default.
#
# Nothing here is derived at runtime, discovered, or guessed: a cutover that
# resolves its own target is a cutover that can drift onto the wrong one.

# ── infrastructure ─────────────────────────────────────────────────────────
# The operator identity, and the ONLY identity permitted in the forwarded agent.
OP_EXPECT_FP="${OP_EXPECT_FP:-SHA256:VqHQoYUYI4aIj0KnYvWZEUp/BHAMFkuBksYRJDD+KQ4}"
OP_KEY="${OP_KEY:-${HOME}/.ssh/id_ed25519}"

OP_APP_HOST="${OP_APP_HOST:-root@adsecute.com}"
OP_DB_SSH="${OP_DB_SSH:-root@87.99.149.56}"
OP_DB_NAME="${OP_DB_NAME:-adsecute_prod}"

OP_WEB_REPO="${OP_WEB_REPO:-ghcr.io/emrahbilaloglu-ui/omniads-web}"
OP_WORKER_REPO="${OP_WORKER_REPO:-ghcr.io/emrahbilaloglu-ui/omniads-worker}"

OP_SCHEDULER="${OP_SCHEDULER:-rootcron}"
OP_STATE_DIR="${OP_STATE_DIR:-/var/lib/adsecute-cutover}"
OP_RUNNER_ROOT="${OP_RUNNER_ROOT:-/var/lib/adsecute-cutover-runner}"
OP_ENV_FILE="${OP_ENV_FILE:-/var/www/adsecute/.env.production}"

# The one legal phase order. `preflight` opens the single fresh epoch; every
# later phase requires that epoch to already exist and refuses to open another.
OP_PHASES="${OP_PHASES:-preflight quiesce fingerprint-pre migrate verify-contract fingerprint-post deploy-disabled enable resume-scheduler}"

# ── release-specific: required, never defaulted ────────────────────────────
#
#   OP_SHA               the release being cut over to
#   OP_OLD_SHA           the release currently serving, for rollback proof
#   OP_WRAPPER_SHA       sha256 of scripts/hetzner-sync-cutover.sh in that release
#   OP_WEB_DIGEST        exact published web image digest
#   OP_WORKER_DIGEST     exact published worker image digest
#   OP_ENV_SHA_ENABLED   sha256 of .env.production BEFORE any lane change
#
# OP_RUNNER_DIR is derived, not supplied, so it cannot disagree with the pins it
# is supposed to describe — hetzner-remote.sh builds the same name the same way.
OP_SHA="${OP_SHA:-}"
OP_OLD_SHA="${OP_OLD_SHA:-}"
OP_WRAPPER_SHA="${OP_WRAPPER_SHA:-}"
OP_WEB_DIGEST="${OP_WEB_DIGEST:-}"
OP_WORKER_DIGEST="${OP_WORKER_DIGEST:-}"
OP_ENV_SHA_ENABLED="${OP_ENV_SHA_ENABLED:-}"

if [ -n "${OP_SHA}" ] && [ -n "${OP_WRAPPER_SHA}" ]; then
  OP_RUNNER_DIR="${OP_RUNNER_ROOT}/${OP_SHA}-${OP_WRAPPER_SHA:0:12}"
else
  OP_RUNNER_DIR=""
fi

# Shape checks, so a typo is caught here rather than by a comparison that
# silently comes out false on the host. Empty is allowed at SOURCE time — the
# host scripts refuse empty pins themselves, and the read-only checks in this
# suite must be sourceable without a release selected.
op_pins_require() {
  local missing=""
  local v
  for v in OP_SHA OP_OLD_SHA OP_WRAPPER_SHA OP_WEB_DIGEST OP_WORKER_DIGEST OP_ENV_SHA_ENABLED; do
    eval "[ -n \"\${$v:-}\" ]" || missing="${missing} $v"
  done
  if [ -n "${missing}" ]; then
    printf 'FAIL release pins are unset:%s\n' "${missing}" >&2
    printf '     set them in the environment; there is deliberately no default.\n' >&2
    return 1
  fi
  case "${OP_SHA}" in [0-9a-f]*) [ "${#OP_SHA}" -eq 40 ] || { printf 'FAIL OP_SHA is not a 40-char sha\n' >&2; return 1; } ;;
    *) printf 'FAIL OP_SHA is not hexadecimal\n' >&2; return 1 ;; esac
  case "${OP_WRAPPER_SHA}" in [0-9a-f]*) [ "${#OP_WRAPPER_SHA}" -eq 64 ] || { printf 'FAIL OP_WRAPPER_SHA is not a 64-char sha\n' >&2; return 1; } ;;
    *) printf 'FAIL OP_WRAPPER_SHA is not hexadecimal\n' >&2; return 1 ;; esac
  case "${OP_WEB_DIGEST}"    in sha256:*) : ;; *) printf 'FAIL OP_WEB_DIGEST must be sha256:<hex>\n' >&2; return 1 ;; esac
  case "${OP_WORKER_DIGEST}" in sha256:*) : ;; *) printf 'FAIL OP_WORKER_DIGEST must be sha256:<hex>\n' >&2; return 1 ;; esac
  return 0
}
