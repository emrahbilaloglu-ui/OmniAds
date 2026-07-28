#!/usr/bin/env bash
# Proof that the isolated cutover RUNNER package can never write the installed
# wrapper, and can never be built from anything but an exact image digest.
#
# WHY THIS EXISTS. Production carries a half-finished cutover whose
# `resume-scheduler` is unsatisfiable, and the sanctioned way out is a NEW epoch
# opened by `preflight` with a CORRECTED wrapper. The obvious way to get that
# wrapper onto the host — `deliver_cutover_wrapper` — installs into
# ${REMOTE_APP_DIR}/cutover, i.e. on top of the wrapper that opened the stuck
# epoch. That destroys the evidence and rewrites the bytes of a script an
# operator may be executing. So `cutover_runner_install` installs BESIDE it.
#
# The dangerous failure mode is therefore not "the package does not install".
# It is "the package installs, and something about the destination quietly made
# it land in ${REMOTE_APP_DIR}/cutover after all" — which a string comparison
# would not see, because a symlink is not a substring.
#
# Every case below executes the REAL functions out of
# .github/scripts/hetzner-remote.sh with a shell-level `docker` fake. No docker
# daemon, no network, no host, no root.
set -euo pipefail

cd "$(dirname "$0")/.."

LABEL="[cutover-runner-package]"
FAILURES=0
pass() { printf '%s PASS %s\n' "${LABEL}" "$1"; }
fail() { printf '%s FAIL %s\n' "${LABEL}" "$1" >&2; FAILURES=$((FAILURES + 1)); }

# PHYSICAL, deliberately. On macOS `mktemp -d` hands back a path under /var,
# which is itself a symlink to /private/var — and the functions under test
# report the physical destination, because resolving it is the entire point. A
# harness that compared against the unresolved path would fail here for a reason
# that has nothing to do with what it is testing.
WORK="$(cd -P "$(mktemp -d)" && pwd -P)"
trap 'rm -rf "${WORK}"' EXIT

SHA="bcc381739b9c11a28fd266e4d7c29c6a9d6a1015"
REPO="ghcr.io/fixture/omniads-worker"
GOOD_DIGEST="sha256:1111111111111111111111111111111111111111111111111111111111111111"
FIXTURE_IMAGE_ID="2222222222222222222222222222222222222222222222222222222222222222"
RUNNER_ROOT="${WORK}/runner-root"

mkdir -p "${WORK}/bin" "${WORK}/app/cutover" "${WORK}/state" \
  "${WORK}/image/app/scripts" "${WORK}/image/app/deploy/db" "${RUNNER_ROOT}"

sha_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}
mtime_of() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1"; }
# macOS `ls -l` suffixes the mode with '@' (extended attributes) or '+' (ACL);
# GNU ls uses '.' for an SELinux context. None of those are permission bits.
mode_of() { ls -ld "$1" | awk '{ sub(/[@+.]$/, "", $1); print $1 }'; }

# ── Fixtures ────────────────────────────────────────────────────────────────
#
# TWO wrappers, both real and both valid, differing by one comment line. The
# INSTALLED one stands in for what is on the production host right now; the one
# inside the fixture image is the "corrected" wrapper this package delivers.
# They must not hash the same, or R2 would pass for the wrong reason.
cp scripts/hetzner-sync-cutover.sh "${WORK}/app/cutover/hetzner-sync-cutover.sh"
cp deploy/db/recovery-policy.tsv "${WORK}/app/cutover/recovery-policy.tsv"
INSTALLED_WRAPPER_SHA="$(sha_of "${WORK}/app/cutover/hetzner-sync-cutover.sh")"
INSTALLED_POLICY_SHA="$(sha_of "${WORK}/app/cutover/recovery-policy.tsv")"
cat > "${WORK}/app/cutover/cutover-wrapper.manifest" <<EOF
wrapper_source=scripts/hetzner-sync-cutover.sh
wrapper_sha256=${INSTALLED_WRAPPER_SHA}
wrapper_bytes=$(wc -c < "${WORK}/app/cutover/hetzner-sync-cutover.sh" | tr -d ' ')
cutover_required=no
delivered_deploy_sha=0000000000000000000000000000000000000000
delivered_policy_sha256=${INSTALLED_POLICY_SHA}
EOF
printf 'installed by the PREVIOUS deploy; this file must never be rewritten here\n' \
  > "${WORK}/app/cutover/installed.manifest"
chmod 0700 "${WORK}/app/cutover"

cp scripts/hetzner-sync-cutover.sh "${WORK}/image/app/scripts/hetzner-sync-cutover.sh"
printf '\n# corrected wrapper: this line is what separates it from the installed one\n' \
  >> "${WORK}/image/app/scripts/hetzner-sync-cutover.sh"
cp deploy/db/recovery-policy.tsv "${WORK}/image/app/deploy/db/recovery-policy.tsv"
IMAGE_WRAPPER_SHA="$(sha_of "${WORK}/image/app/scripts/hetzner-sync-cutover.sh")"
write_image_manifest() { # <wrapper_sha256-to-pin>
  cat > "${WORK}/image/app/scripts/cutover-wrapper.manifest" <<EOF
wrapper_source=scripts/hetzner-sync-cutover.sh
wrapper_sha256=${1}
wrapper_bytes=$(wc -c < "${WORK}/image/app/scripts/hetzner-sync-cutover.sh" | tr -d ' ')
cutover_required=no
EOF
}
write_image_manifest "${IMAGE_WRAPPER_SHA}"

[ "${IMAGE_WRAPPER_SHA}" != "${INSTALLED_WRAPPER_SHA}" ] || {
  fail "fixture is wrong: the installed and image wrappers hash identically"
  exit 1
}
PKG_DIR="${RUNNER_ROOT}/${SHA}-${IMAGE_WRAPPER_SHA:0:12}"

# ── Stubs ───────────────────────────────────────────────────────────────────
for tool in flock systemctl pgrep fuser; do
  case "${tool}" in
    pgrep) printf '#!/usr/bin/env bash\nexit 1\n' > "${WORK}/bin/${tool}" ;;
    *) printf '#!/usr/bin/env bash\nexit 0\n' > "${WORK}/bin/${tool}" ;;
  esac
  chmod +x "${WORK}/bin/${tool}"
done
printf '#!/usr/bin/env bash\nexit 1\n' > "${WORK}/bin/crontab"
chmod +x "${WORK}/bin/crontab"

printf '%s\n' "${REPO}@${GOOD_DIGEST}" > "${WORK}/image.ref"
: > "${WORK}/docker.log"; : > "${WORK}/created.txt"; : > "${WORK}/removed.txt"

# The docker fake. It records EVERY invocation, so "the container was removed"
# and "no container was created" are read off a log rather than assumed, and it
# can be told to fail one verb so the failure path is exercised for real.
cat > "${WORK}/bin/docker" <<DOCKER
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "${WORK}/docker.log"
fail_verb="\$(cat "${WORK}/docker.fail" 2>/dev/null || true)"
case "\${1:-}" in
  image)
    if [ "\${2:-}" = "inspect" ]; then
      [ "\${3:-}" = "\$(cat "${WORK}/image.ref")" ] || exit 1
      printf 'sha256:${FIXTURE_IMAGE_ID}\n'
      exit 0
    fi
    exit 0
    ;;
  create)
    [ "create" != "\${fail_verb}" ] || exit 1
    [ "\${2:-}" = "\$(cat "${WORK}/image.ref")" ] || exit 1
    n=\$(( \$(cat "${WORK}/cid.seq" 2>/dev/null || echo 0) + 1 ))
    printf '%s\n' "\${n}" > "${WORK}/cid.seq"
    printf 'fixturecontainer%s\n' "\${n}" >> "${WORK}/created.txt"
    printf 'fixturecontainer%s\n' "\${n}"
    exit 0
    ;;
  cp)
    [ "cp" != "\${fail_verb}" ] || exit 1
    src="\${2:-}"; dst="\${3:-}"
    path="\${src#*:}"
    [ -f "${WORK}/image\${path}" ] || exit 1
    cp "${WORK}/image\${path}" "\${dst}"
    exit 0
    ;;
  rm)
    printf '%s\n' "\${@: -1}" >> "${WORK}/removed.txt"
    exit 0
    ;;
  *) exit 0 ;;
esac
DOCKER
chmod +x "${WORK}/bin/docker"

# A REAL AF_UNIX socket: cutover_runner_run tests -S, and a regular file is not
# a socket, so a `touch` would make every case refuse for the wrong reason.
python3 -c "import socket,sys; s=socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])" "${WORK}/agent.sock"

# ── Driver ──────────────────────────────────────────────────────────────────
run_phase() { # <remote phase>; output lands in ${WORK}/out
  set +e
  env PATH="${WORK}/bin:${PATH}" \
    REMOTE_APP_DIR="${WORK}/app" \
    CUTOVER_RUNNER_ROOT="${RUNNER_ROOT_OVERRIDE-${RUNNER_ROOT}}" \
    SYNC_CUTOVER_STATE_DIR="${WORK}/state" \
    CUTOVER_RUNNER_IMAGE_DIGEST="${DIGEST_OVERRIDE-${GOOD_DIGEST}}" \
    CUTOVER_RUNNER_WRAPPER_SHA256="${EXPECTED_SHA_OVERRIDE-${IMAGE_WRAPPER_SHA}}" \
    CUTOVER_RUNNER_IMAGE_REPO="${REPO}" \
    CUTOVER_RUNNER_DIR="${RUNNER_DIR_OVERRIDE-}" \
    CUTOVER_RESUME_SHA="${SHA}" \
    DEPLOY_SHA="${SHA}" \
    CUTOVER_DB_SSH="root@db.example" \
    CUTOVER_SCHEDULER=rootcron \
    CUTOVER_EPOCH_PHASE="${EPOCH_PHASE_OVERRIDE-status}" \
    SSH_AUTH_SOCK="${WORK}/agent.sock" \
    BREAK_GLASS=false OVERRIDE_REASON="" \
    bash .github/scripts/hetzner-remote.sh "$1" > "${WORK}/out" 2>&1
  local status=$?
  set -e
  return "${status}"
}

# ALWAYS returns 0, and the failure count is what decides the exit status.
#
# It used to `return 1` on a failed case, and the call sites are bare commands
# under `set -e` — so the FIRST case that refused for the wrong reason killed the
# harness and every later check silently never ran. A suite that stops at its
# first failure reports one problem and hides the rest, which is exactly the
# wrong behaviour when the point is to show which controls bite.
expect_refusal() { # <phase> <case> <needle>
  if run_phase "$1"; then
    fail "$2 — it ACCEPTED what it must refuse"
    return 0
  fi
  if grep -qa "$3" "${WORK}/out"; then
    pass "$2"
    return 0
  fi
  fail "$2 — refused for another reason: $(grep -a ABORT "${WORK}/out" | head -1)"
  return 0
}

# Contents + sha256 + mtime of every path under a directory, including the
# directory mtimes. This is the R2 instrument: "byte-identical" has to cover a
# file that was rewritten with the same bytes, which only mtime shows.
snapshot_tree() { # <dir>
  [ -d "$1" ] || { printf 'ABSENT %s\n' "$1"; return 0; }
  find "$1" -mindepth 0 | LC_ALL=C sort | while IFS= read -r path; do
    if [ -d "${path}" ]; then
      printf 'D %s mtime=%s mode=%s\n' "${path}" "$(mtime_of "${path}")" \
        "$(mode_of "${path}")"
    else
      printf 'F %s sha=%s mtime=%s bytes=%s mode=%s\n' "${path}" "$(sha_of "${path}")" \
        "$(mtime_of "${path}")" "$(wc -c < "${path}" | tr -d ' ')" \
        "$(mode_of "${path}")"
    fi
  done
}

INSTALLED_BEFORE="$(snapshot_tree "${WORK}/app/cutover")"
assert_installed_untouched() { # <case>
  local now
  now="$(snapshot_tree "${WORK}/app/cutover")"
  if [ "${now}" = "${INSTALLED_BEFORE}" ]; then
    pass "$1"
  else
    fail "$1 — ${WORK}/app/cutover CHANGED:
$(diff <(printf '%s\n' "${INSTALLED_BEFORE}") <(printf '%s\n' "${now}") || true)"
  fi
}

# ── R1 only an exact sha256 digest is accepted ──────────────────────────────
DIGEST_OVERRIDE="${REPO}:${SHA}" \
  expect_refusal cutover_runner_install \
  "R1a a TAG is refused, never resolved" "is not a sha256 content digest"
DIGEST_OVERRIDE="sha256:abc123" \
  expect_refusal cutover_runner_install \
  "R1b a short digest is refused" "is not sha256:<64 lowercase hex>"
DIGEST_OVERRIDE="sha256:1111111111111111111111111111111111111111111111111111111111111AAA" \
  expect_refusal cutover_runner_install \
  "R1c an UPPERCASE-hex digest is refused" "is not sha256:<64 lowercase hex>"
DIGEST_OVERRIDE="sha256:111111111111111111111111111111111111111111111111111111111111111" \
  expect_refusal cutover_runner_install \
  "R1d a 63-character digest is refused" "is not sha256:<64 lowercase hex>"
DIGEST_OVERRIDE="" \
  expect_refusal cutover_runner_install \
  "R1e an unset digest is refused" "CUTOVER_RUNNER_IMAGE_DIGEST is unset"
EXPECTED_SHA_OVERRIDE="" \
  expect_refusal cutover_runner_install \
  "R1f an unset caller expectation is refused" "is not a 64-character lowercase hex sha256"

# ── R3 the extracted wrapper must match its OWN extracted manifest ──────────
write_image_manifest "0000000000000000000000000000000000000000000000000000000000000000"
EXPECTED_SHA_OVERRIDE="0000000000000000000000000000000000000000000000000000000000000000" \
  expect_refusal cutover_runner_install \
  "R3 a wrapper that disagrees with its extracted manifest is refused" \
  "its own manifest pins"
write_image_manifest "${IMAGE_WRAPPER_SHA}"

# ── R4 and it must match the CALLER's independent expectation ───────────────
# A tampered image supplies the wrapper and its manifest together, so those two
# agreeing proves consistency and nothing else. This is the check that makes the
# pin external.
EXPECTED_SHA_OVERRIDE="3333333333333333333333333333333333333333333333333333333333333333" \
  expect_refusal cutover_runner_install \
  "R4 a wrapper that disagrees with the caller's expected hash is refused" \
  "the caller expected"

# ── R6b the extraction container is removed on the FAILURE path ─────────────
: > "${WORK}/created.txt"; : > "${WORK}/removed.txt"
printf 'cp' > "${WORK}/docker.fail"
expect_refusal cutover_runner_install \
  "R6b a failed extraction still refuses" "does not carry"
rm -f "${WORK}/docker.fail"
if [ ! -s "${WORK}/created.txt" ]; then
  fail "R6b fixture is wrong: no container was ever created, so removal proves nothing"
elif diff <(LC_ALL=C sort -u "${WORK}/created.txt") <(LC_ALL=C sort -u "${WORK}/removed.txt") >/dev/null; then
  pass "R6b every extraction container created on the failure path was removed ($(wc -l < "${WORK}/created.txt" | tr -d ' '))"
else
  fail "R6b a container leaked on the failure path: created=$(tr '\n' ' ' < "${WORK}/created.txt") removed=$(tr '\n' ' ' < "${WORK}/removed.txt")"
fi

# ── R5 a destination that RESOLVES into the installed dir is refused ────────
# The symlink is the point: the destination STRING contains nothing resembling
# ${REMOTE_APP_DIR}/cutover, so a string check would wave it through.
ln -s "${WORK}/app/cutover" "${PKG_DIR}"
case "${PKG_DIR}" in
  *"${WORK}/app/cutover"*)
    fail "R5 fixture is wrong: the destination string already contains the installed path, so this would not test realpath"
    ;;
  *)
    expect_refusal cutover_runner_install \
      "R5a a destination symlinked into the installed wrapper dir is refused (string match would not see it)" \
      "is INSIDE the installed wrapper directory"
    ;;
esac
rm -f "${PKG_DIR}"
assert_installed_untouched "R5b the refused symlink destination left the installed wrapper dir byte-identical"

RUNNER_ROOT_OVERRIDE="${WORK}/root-link" ln -s "${WORK}/app/cutover" "${WORK}/root-link"
RUNNER_ROOT_OVERRIDE="${WORK}/root-link" \
  expect_refusal cutover_runner_install \
  "R5c a runner ROOT symlinked onto the installed wrapper dir is refused" \
  "overlaps the installed wrapper directory"
rm -f "${WORK}/root-link"

mkdir -p "${WORK}/app/nested"
RUNNER_ROOT_OVERRIDE="${WORK}/app" \
  expect_refusal cutover_runner_install \
  "R5d a runner root that CONTAINS the installed wrapper dir is refused" \
  "overlaps the installed wrapper directory"
rmdir "${WORK}/app/nested"

# ── R2 the happy path, and the installed dir before/after ───────────────────
: > "${WORK}/docker.log"; : > "${WORK}/created.txt"; : > "${WORK}/removed.txt"
if run_phase cutover_runner_install; then
  if grep -qa "cutover_runner_package_installed .*wrapper_sha256=${IMAGE_WRAPPER_SHA}" "${WORK}/out" &&
    grep -qa "image_digest=${GOOD_DIGEST}" "${WORK}/out" &&
    grep -qa "dest=${PKG_DIR}" "${WORK}/out"; then
    pass "R2a install succeeds and prints image digest, wrapper/manifest/policy hashes and destination"
  else
    fail "R2a install succeeded without a complete provenance line: $(grep -a cutover_runner_package "${WORK}/out" | head -1)"
  fi
else
  fail "R2a install of a well-formed package failed: $(grep -a ABORT "${WORK}/out" | head -1)"
fi
assert_installed_untouched "R2b the installed wrapper dir is byte-identical AFTER install (contents, hashes, mtimes)"

if [ -f "${PKG_DIR}/hetzner-sync-cutover.sh" ] &&
  [ "$(sha_of "${PKG_DIR}/hetzner-sync-cutover.sh")" = "${IMAGE_WRAPPER_SHA}" ] &&
  [ -f "${PKG_DIR}/cutover-wrapper.manifest" ] &&
  [ -f "${PKG_DIR}/recovery-policy.tsv" ] &&
  [ -f "${PKG_DIR}/runner.manifest" ]; then
  pass "R2c the package carries the wrapper, its manifest and the recovery policy together"
else
  fail "R2c the package is incomplete: $(ls -la "${PKG_DIR}" 2>&1 | tr '\n' ' ')"
fi

pkg_mode="$(mode_of "${PKG_DIR}")"
file_modes="$(find "${PKG_DIR}" -type f -exec ls -ld {} + | awk '{ sub(/[@+.]$/, "", $1); print $1 }' | LC_ALL=C sort -u)"
if [ "${pkg_mode}" = "drwx------" ] && [ "${file_modes}" = "-rw-------" ]; then
  pass "R2d the package directory is 0700 and every file is 0600"
else
  fail "R2d wrong modes: dir=${pkg_mode} files=$(printf '%s' "${file_modes}" | tr '\n' ' ')"
fi

# ── R6a the extraction container is removed on the SUCCESS path ─────────────
if [ ! -s "${WORK}/created.txt" ]; then
  fail "R6a no container was created during the successful install"
elif diff <(LC_ALL=C sort -u "${WORK}/created.txt") <(LC_ALL=C sort -u "${WORK}/removed.txt") >/dev/null; then
  pass "R6a the extraction container is removed on the success path"
else
  fail "R6a a container leaked on the success path: created=$(tr '\n' ' ' < "${WORK}/created.txt") removed=$(tr '\n' ' ' < "${WORK}/removed.txt")"
fi
if grep -qa "create ${REPO}@${GOOD_DIGEST}" "${WORK}/docker.log"; then
  pass "R6c the container was created from the DIGEST reference, not a tag"
else
  fail "R6c the extraction container was not created from ${REPO}@${GOOD_DIGEST}: $(grep -a create "${WORK}/docker.log" | head -1)"
fi

# ── R2e a real phase run, through the RUNNER wrapper ────────────────────────
cat > "${WORK}/state/state" <<EOF
state_version=2
deploy_sha=${SHA}
phase_chain=preflight
invalidated=no
EOF
if run_phase cutover_runner_run; then
  :
else
  : # the phase may legitimately fail in this fixture; the assertions below say why it must not matter
fi
if grep -qa "wrapper integrity OK sha256=${IMAGE_WRAPPER_SHA}" "${WORK}/out"; then
  pass "R2e the RUNNER wrapper ran and verified itself against the RUNNER manifest (not the installed one)"
else
  fail "R2e the runner wrapper did not reach its own integrity check: $(tail -3 "${WORK}/out" | tr '\n' ' ' | cut -c1-260)"
fi
if grep -qa "sha256          : ${IMAGE_WRAPPER_SHA}" "${WORK}/out" &&
  grep -qa "sha256          : ${INSTALLED_WRAPPER_SHA}" "${WORK}/out" &&
  grep -qa "the runner and installed wrappers DIFFER" "${WORK}/out"; then
  pass "R2f the run logs the runner hash and the installed hash SIDE BY SIDE, and says they differ"
else
  fail "R2f the two wrapper hashes were not logged side by side: $(grep -a 'wrapper' "${WORK}/out" | head -4 | tr '\n' ' ')"
fi
assert_installed_untouched "R2g the installed wrapper dir is byte-identical AFTER a phase run"

# ── R11 the phase allowlist, unchanged ──────────────────────────────────────
EPOCH_PHASE_OVERRIDE=emergency-disable \
  expect_refusal cutover_runner_run \
  "R11a emergency-disable is refused through the runner path too" \
  "emergency-disable is not available through this path"
EPOCH_PHASE_OVERRIDE=definitely-not-a-phase \
  expect_refusal cutover_runner_run \
  "R11b an unknown phase is refused" "unknown or refused cutover phase"

# ── R8 re-install is idempotent, and re-verifies ────────────────────────────
PKG_BEFORE="$(snapshot_tree "${PKG_DIR}")"
: > "${WORK}/docker.log"; : > "${WORK}/created.txt"
if run_phase cutover_runner_install; then
  if grep -qa "cutover_runner_package_reused" "${WORK}/out"; then
    pass "R8a re-installing the same digest is a no-op that reports reuse"
  else
    fail "R8a the second install did not report reuse: $(grep -a cutover_runner_package "${WORK}/out" | head -1)"
  fi
else
  fail "R8a the second install of the same digest failed: $(grep -a ABORT "${WORK}/out" | head -1)"
fi
if [ -s "${WORK}/created.txt" ] || grep -qa '^create ' "${WORK}/docker.log"; then
  fail "R8b the idempotent re-install still created a container: $(grep -a '^create' "${WORK}/docker.log" | head -1)"
else
  pass "R8b the idempotent re-install touches no container and no image"
fi
if [ "$(snapshot_tree "${PKG_DIR}")" = "${PKG_BEFORE}" ]; then
  pass "R8c the re-install left the package byte-identical, mtimes included"
else
  fail "R8c the re-install rewrote the package"
fi

printf '\n# tampered on the host after install\n' >> "${PKG_DIR}/hetzner-sync-cutover.sh"
expect_refusal cutover_runner_install \
  "R8d re-install RE-VERIFIES: a package tampered with after install is refused, not silently reused" \
  "its own manifest pins"
expect_refusal cutover_runner_run \
  "R8e a tampered package is refused at RUN time too" \
  "its own manifest pins"
# Restore the package for the removal cases.
cp "${WORK}/image/app/scripts/hetzner-sync-cutover.sh" "${PKG_DIR}/hetzner-sync-cutover.sh"
chmod 0600 "${PKG_DIR}/hetzner-sync-cutover.sh"

# ── R7 removal ──────────────────────────────────────────────────────────────
STATE_BEFORE="$(snapshot_tree "${WORK}/state")"
RUNNER_DIR_OVERRIDE="/tmp/adsecute-not-a-runner-package" \
  expect_refusal cutover_runner_remove \
  "R7a a removal target OUTSIDE the runner root is refused" \
  "is outside the runner root"
RUNNER_DIR_OVERRIDE="${RUNNER_ROOT}" \
  expect_refusal cutover_runner_remove \
  "R7b removing the runner ROOT itself is refused" \
  "is the runner ROOT itself"
RUNNER_DIR_OVERRIDE="${WORK}/app/cutover" \
  expect_refusal cutover_runner_remove \
  "R7c removing the installed wrapper directory is refused" \
  "is INSIDE the installed wrapper directory"
ln -s "${WORK}/app/cutover" "${RUNNER_ROOT}/escape"
RUNNER_DIR_OVERRIDE="${RUNNER_ROOT}/escape" \
  expect_refusal cutover_runner_remove \
  "R7d a removal target INSIDE the runner root that symlinks out is refused" \
  "is INSIDE the installed wrapper directory"
rm -f "${RUNNER_ROOT}/escape"
assert_installed_untouched "R7e every refused removal left the installed wrapper dir byte-identical"

if run_phase cutover_runner_remove; then
  if [ ! -e "${PKG_DIR}" ] && grep -qa "cutover_runner_package_removed" "${WORK}/out"; then
    pass "R7f the package directory is removed"
  else
    fail "R7f removal reported success but ${PKG_DIR} still exists"
  fi
else
  fail "R7f removing the package failed: $(grep -a ABORT "${WORK}/out" | head -1)"
fi
assert_installed_untouched "R7g removal left the installed wrapper dir byte-identical"
if [ "$(snapshot_tree "${WORK}/state")" = "${STATE_BEFORE}" ]; then
  pass "R7h removal left the cutover state record byte-identical"
else
  fail "R7h removal modified the cutover state"
fi
if [ -d "${RUNNER_ROOT}" ]; then
  pass "R7i removal deleted ONE package directory, not the runner root"
else
  fail "R7i removal deleted the runner root"
fi
if run_phase cutover_runner_remove && grep -qa "cutover_runner_package_absent" "${WORK}/out"; then
  pass "R7j removing an already-absent package is a reported no-op, not a failure"
else
  fail "R7j a second removal did not report the package as already absent"
fi

# ── R9 the CI wiring is all-or-nothing ──────────────────────────────────────
#
# run_remote_phase_on_host forwards a FIXED list of variables. Forwarding the
# digest without the caller's expected hash would leave the external pin reading
# an empty string, so these three move together or not at all.
forwarded=0
for var in CUTOVER_RUNNER_IMAGE_DIGEST CUTOVER_RUNNER_WRAPPER_SHA256 CUTOVER_RUNNER_IMAGE_REPO; do
  if grep -qa "${var}=" .github/scripts/hetzner-ssh.sh; then
    forwarded=$((forwarded + 1))
  fi
done
if [ "${forwarded}" -eq 0 ] || [ "${forwarded}" -eq 3 ]; then
  pass "R9 the runner env contract is forwarded all-or-nothing (forwarded=${forwarded}/3)"
else
  fail "R9 hetzner-ssh.sh forwards ${forwarded}/3 runner variables; a partial forward makes the caller-supplied hash check a no-op"
fi

# ── R10 static: the runner path can never become the delivery path ──────────
runner_body="$(awk '/^cutover_runner_(install|run|remove)\(\)/,/^}/' .github/scripts/hetzner-remote.sh)"
if printf '%s\n' "${runner_body}" | grep -qa 'deliver_cutover_wrapper'; then
  fail "R10a a cutover_runner_* function calls deliver_cutover_wrapper"
else
  pass "R10a no cutover_runner_* function calls deliver_cutover_wrapper"
fi
if printf '%s\n' "${runner_body}" | grep -qaE '(cp|mv|rm|mkdir|chmod|chown|tee|>)[^|]*\$\{(REMOTE_APP_DIR|INSTALLED_WRAPPER)\}'; then
  fail "R10b a cutover_runner_* function writes under \${REMOTE_APP_DIR}"
else
  pass "R10b no cutover_runner_* function writes under \${REMOTE_APP_DIR}"
fi
if grep -qa 'CUTOVER_RUNNER_ROOT="\${CUTOVER_RUNNER_ROOT:-/var/lib/adsecute-cutover-runner}"' .github/scripts/hetzner-remote.sh; then
  pass "R10c the runner root defaults to /var/lib/adsecute-cutover-runner"
else
  fail "R10c the runner root default is not /var/lib/adsecute-cutover-runner"
fi
if awk '/^assert_no_cutover_in_progress\(\)/,/^}/' .github/scripts/hetzner-remote.sh | grep -qa 'RUNNER'; then
  fail "R10d assert_no_cutover_in_progress grew a runner exception"
else
  pass "R10d assert_no_cutover_in_progress is untouched by the runner path"
fi
if awk '/^  (prepare_runtime|run_migrations|recreate_services)\)/,/^    ;;/' .github/scripts/hetzner-remote.sh \
  | grep -qa 'cutover_runner_'; then
  fail "R10e an ordinary deploy phase reaches the runner package"
else
  pass "R10e no ordinary deploy phase reaches the runner package"
fi

if [ "${FAILURES}" -ne 0 ]; then
  printf '%s %s check(s) FAILED\n' "${LABEL}" "${FAILURES}" >&2
  exit 1
fi
printf '%s PASS — the runner package is digest-pinned, isolated by realpath, and never writes the installed wrapper\n' "${LABEL}"
