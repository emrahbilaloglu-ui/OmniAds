#!/usr/bin/env bash
set -euo pipefail

# STATIC build-context assertion for the cutover wrapper. NOT A SMOKE TEST.
#
# ══ READ THIS BEFORE BELIEVING ANY LINE THIS SCRIPT PRINTS ═════════════════
#
# This script does not build an image, does not run a container, and does not
# have a container runtime available to it. It reads `.dockerignore` and
# `Dockerfile` as TEXT and answers one narrow question:
#
#   given these two files, is `scripts/hetzner-sync-cutover.sh` inside the build
#   context, and is it captured by a COPY that already exists in the
#   `worker-runner` stage — and if so, at which path inside the image?
#
# It then cross-checks that answer against the path `deliver_cutover_wrapper`
# extracts and the path the manifest pins, so those three cannot drift apart.
#
# WHAT IT CANNOT DO, AND WILL NEVER DO
#
#   - It cannot observe layer contents. It asserts what the instructions SAY,
#     not what BuildKit actually captured. If BuildKit's `.dockerignore` or COPY
#     semantics differ from the model below, this script is confidently wrong.
#   - It cannot prove the file is executable, non-empty, or unmangled in the
#     image, because it never looks at the image.
#   - It cannot prove the wrapper RUNS inside the image, that the image has
#     bash, or that any tool the wrapper invokes is present in the runtime.
#   - It exercises no runtime, no entrypoint, and no invocation path.
#
# So: a PASS here means "the build instructions are consistent with delivering
# the wrapper". It does not mean the delivery works. The only thing that proves
# the delivery works is `deliver_cutover_wrapper` running against a real built
# image on a host that has Docker — which is a container smoke test, which this
# is not, and which nothing in this repository currently performs.
#
# The wrapper's BEHAVIOUR is proven separately and for real by
# `scripts/cutover-real-postgres-harness.sh` (`npm run test:cutover-harness`),
# which executes every phase against a real PostgreSQL. That harness says
# nothing about the image; this script says nothing about behaviour. Neither
# substitutes for a container smoke test.
#
# ══ MODEL LIMITS ═══════════════════════════════════════════════════════════
#
# The `.dockerignore` matcher implements: comments, leading/trailing whitespace,
# `!` negation with last-match-wins, `*` (not crossing `/`), `**`, `?`, and the
# rule that a pattern matching an ancestor directory excludes everything beneath
# it. It does NOT reproduce BuildKit's full exception handling for a `!` rule
# nested under an excluded directory. The COPY resolver handles context copies,
# `--from=<stage>` copies, per-stage WORKDIR inheritance, directory sources
# (contents copied into the destination) and exact-file sources. It does not
# model `--chown`/`--chmod` effects, `ADD`, or heredocs.
#
# Every one of those limits is a reason this is an assertion about text, not a
# test of an image.
#
#   scripts/cutover-wrapper-build-context-check.sh

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKERFILE="${REPO_ROOT}/Dockerfile"
DOCKERIGNORE="${REPO_ROOT}/.dockerignore"
REMOTE_SH="${REPO_ROOT}/.github/scripts/hetzner-remote.sh"

WRAPPER_REL="scripts/hetzner-sync-cutover.sh"
MANIFEST_REL="scripts/cutover-wrapper.manifest"
TARGET_STAGE="worker-runner"

# The path the wrapper used to live at. It is a NEGATIVE control: `.dockerignore`
# must still report it excluded, which is both the reason the file was moved and
# the proof that the matcher below discriminates instead of answering "included"
# to everything.
LEGACY_REL=".github/scripts/hetzner-sync-cutover.sh"
# In the context, but deliberately not copied into worker-runner. Second negative
# control, for the COPY resolver.
UNCOPIED_REL="public/__not_copied_into_the_worker_image__"

LABEL="[cutover-build-context]"
FAILURES=0

pass() { printf '%s PASS %s\n' "${LABEL}" "$1"; }
fail() { printf '%s FAIL %s\n' "${LABEL}" "$1" >&2; FAILURES=$((FAILURES + 1)); }

# ── glob → ERE, with Docker's "* does not cross a slash" rule ───────────────
glob_to_ere() {
  local pat="$1" out="" i=0 n ch
  n=${#pat}
  while [ "${i}" -lt "${n}" ]; do
    ch="${pat:${i}:1}"
    case "${ch}" in
      '*')
        if [ "${pat:${i}:2}" = '**' ]; then
          out="${out}.*"; i=$((i + 2)); continue
        fi
        out="${out}[^/]*"; i=$((i + 1)); continue ;;
      '?') out="${out}[^/]"; i=$((i + 1)); continue ;;
      '.'|'+'|'('|')'|'['|']'|'{'|'}'|'^'|'$'|'|'|'\\')
        out="${out}\\${ch}"; i=$((i + 1)); continue ;;
      *) out="${out}${ch}"; i=$((i + 1)); continue ;;
    esac
  done
  printf '%s' "${out}"
}

has_glob() {
  case "$1" in
    *'*'*|*'?'*|*'['*) return 0 ;;
    *) return 1 ;;
  esac
}

# Returns 0 when `.dockerignore` EXCLUDES the given context-relative path.
DOCKERIGNORE_RULE=""
dockerignore_excludes() {
  local path="$1" raw pat ere candidate hit is_negation excluded=1
  DOCKERIGNORE_RULE=""
  [ -f "${DOCKERIGNORE}" ] || return 1
  while IFS= read -r raw || [ -n "${raw}" ]; do
    raw="${raw%$'\r'}"
    pat="$(printf '%s' "${raw}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -n "${pat}" ] || continue
    case "${pat}" in '#'*) continue ;; esac
    is_negation=0
    if [ "${pat:0:1}" = '!' ]; then is_negation=1; pat="${pat:1}"; fi
    pat="${pat#./}"
    pat="${pat%/}"
    [ -n "${pat}" ] || continue
    ere="^$(glob_to_ere "${pat}")\$"
    # A pattern matching any ancestor directory excludes everything under it.
    candidate="${path}"
    hit=1
    while :; do
      if printf '%s' "${candidate}" | grep -Eq "${ere}"; then hit=0; break; fi
      case "${candidate}" in
        */*) candidate="${candidate%/*}" ;;
        *) break ;;
      esac
    done
    # Last matching rule wins, so a later `!` exception re-includes the path.
    if [ "${hit}" = 0 ]; then
      if [ "${is_negation}" = 1 ]; then excluded=1; else excluded=0; fi
      DOCKERIGNORE_RULE="${raw}"
    fi
  done < "${DOCKERIGNORE}"
  return "${excluded}"
}

# ── Dockerfile → one normalized record per COPY ─────────────────────────────
#
#   COPY<TAB>stage<TAB>from-stage<TAB>resolved-dest<TAB>src [src...]
#
# `from-stage` is empty for a copy out of the build context.
COPY_RECORDS="$(
  awk '
    function resolve(p, wd) {
      if (p ~ /^\//) return p
      if (p == "." || p == "./") return wd
      sub(/^\.\//, "", p)
      return (wd == "/" ? "" : wd) "/" p
    }
    { sub(/\r$/, "") }
    (acc == "" && $0 ~ /^[[:space:]]*#/) { next }
    {
      line = $0
      if (acc != "") { line = acc " " line; acc = "" }
      if (line ~ /\\[[:space:]]*$/) { sub(/\\[[:space:]]*$/, "", line); acc = line; next }
      gsub(/^[[:space:]]+/, "", line)
      gsub(/[[:space:]]+$/, "", line)
      if (line == "") next
      n = split(line, tok, /[[:space:]]+/)
      op = toupper(tok[1])
      if (op == "FROM") {
        parent = tok[2]
        name = ""
        for (i = 3; i <= n; i++) if (toupper(tok[i]) == "AS") { name = tok[i + 1]; break }
        if (name == "") { anon++; name = "__anon" anon }
        cur = name
        wd[name] = (parent in wd) ? wd[parent] : "/"
        next
      }
      if (op == "WORKDIR") { wd[cur] = resolve(tok[2], wd[cur]); next }
      if (op == "COPY") {
        from = ""
        s = 2
        while (s <= n && tok[s] ~ /^--/) {
          if (tok[s] ~ /^--from=/) from = substr(tok[s], 8)
          s++
        }
        dest = resolve(tok[n], wd[cur])
        srcs = ""
        for (i = s; i < n; i++) srcs = srcs (srcs == "" ? "" : " ") tok[i]
        if (srcs == "") next
        printf "COPY\t%s\t%s\t%s\t%s\n", cur, from, dest, srcs
        next
      }
    }
  ' "${DOCKERFILE}"
)"

# Where does `path` (relative to `src`) land, given this COPY's destination?
#
# Docker copies the CONTENTS of a directory source into the destination, so
# `COPY --from=builder /app/scripts /app/scripts` puts `<src>/x` at `<dest>/x`.
copy_lands_at() {
  local srcs="$1" dest="$2" nsrcs="$3" path="$4"
  local src norm dest_dir rest ere
  dest_dir="${dest}"
  case "${dest_dir}" in
    /) : ;;
    */) dest_dir="${dest_dir%/}" ;;
  esac
  for src in ${srcs}; do
    norm="${src#./}"
    norm="${norm%/}"
    if [ "${norm}" = "." ] || [ -z "${norm}" ]; then
      # The whole build context.
      printf '%s/%s' "${dest_dir}" "${path}"
      return 0
    fi
    case "${path}" in
      "${norm}"/*)
        rest="${path#${norm}/}"
        printf '%s/%s' "${dest_dir}" "${rest}"
        return 0 ;;
    esac
    if [ "${norm}" = "${path}" ]; then
      if [ "${nsrcs}" -gt 1 ] || [ "${dest}" != "${dest_dir}" ]; then
        printf '%s/%s' "${dest_dir}" "${path##*/}"
      else
        printf '%s' "${dest}"
      fi
      return 0
    fi
    if has_glob "${norm}"; then
      ere="^$(glob_to_ere "${norm}")\$"
      if printf '%s' "${path}" | grep -Eq "${ere}"; then
        printf '%s/%s' "${dest_dir}" "${path##*/}"
        return 0
      fi
    fi
  done
  return 1
}

# Absolute path of a context-relative file inside `stage`, or empty. Later COPY
# instructions win, matching the way the image is actually layered.
path_in_stage() {
  local stage="$1" path="$2" depth="${3:-0}"
  local rec r_stage r_from r_dest r_srcs nsrcs found="" upstream landed
  [ "${depth}" -le 8 ] || return 0
  while IFS= read -r rec; do
    [ -n "${rec}" ] || continue
    r_stage="$(printf '%s' "${rec}" | cut -f2)"
    [ "${r_stage}" = "${stage}" ] || continue
    r_from="$(printf '%s' "${rec}" | cut -f3)"
    r_dest="$(printf '%s' "${rec}" | cut -f4)"
    r_srcs="$(printf '%s' "${rec}" | cut -f5)"
    nsrcs="$(printf '%s' "${r_srcs}" | wc -w | tr -d '[:space:]')"
    if [ -z "${r_from}" ]; then
      landed="$(copy_lands_at "${r_srcs}" "${r_dest}" "${nsrcs}" "${path}" || true)"
    else
      upstream="$(path_in_stage "${r_from}" "${path}" $((depth + 1)))"
      [ -n "${upstream}" ] || continue
      landed="$(copy_lands_at "${r_srcs}" "${r_dest}" "${nsrcs}" "${upstream}" || true)"
    fi
    [ -n "${landed}" ] && found="${landed}"
  done <<EOF
${COPY_RECORDS}
EOF
  printf '%s' "${found}"
}

manifest_value() {
  awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "${REPO_ROOT}/${MANIFEST_REL}" | tr -d '[:space:]'
}

printf '%s STATIC build-context assertion only — this is NOT a container smoke test.\n' "${LABEL}"
printf '%s No image is built, no container is run, no layer is inspected.\n' "${LABEL}"

# ── A1: the canonical wrapper exists where everything else expects it ───────
if [ -f "${REPO_ROOT}/${WRAPPER_REL}" ]; then
  pass "A1 the canonical wrapper exists at ${WRAPPER_REL}"
else
  fail "A1 no wrapper at ${WRAPPER_REL}"
fi

# ── A2: negative control — the matcher discriminates ───────────────────────
if dockerignore_excludes "${LEGACY_REL}"; then
  pass "A2 negative control: .dockerignore still excludes the old location ${LEGACY_REL} (rule '${DOCKERIGNORE_RULE}') — which is why the wrapper was moved"
else
  fail "A2 negative control failed: .dockerignore reports ${LEGACY_REL} as INCLUDED, so this matcher is not discriminating and no other result here can be trusted"
fi

# ── A3: the wrapper and its manifest survive .dockerignore ─────────────────
if dockerignore_excludes "${WRAPPER_REL}"; then
  fail "A3 .dockerignore excludes ${WRAPPER_REL} from the build context (rule '${DOCKERIGNORE_RULE}')"
else
  pass "A3 .dockerignore does not exclude ${WRAPPER_REL}: it is inside the build context"
fi

if dockerignore_excludes "${MANIFEST_REL}"; then
  fail "A4 .dockerignore excludes ${MANIFEST_REL} from the build context (rule '${DOCKERIGNORE_RULE}')"
else
  pass "A4 .dockerignore does not exclude ${MANIFEST_REL}: it is inside the build context"
fi

# ── A5: the target stage exists at all ─────────────────────────────────────
if printf '%s\n' "${COPY_RECORDS}" | cut -f2 | grep -qx "${TARGET_STAGE}"; then
  pass "A5 Dockerfile defines a ${TARGET_STAGE} stage with COPY instructions"
else
  fail "A5 Dockerfile has no COPY instructions in a ${TARGET_STAGE} stage"
fi

# ── A6: negative control for the COPY resolver ─────────────────────────────
uncopied_path="$(path_in_stage "${TARGET_STAGE}" "${UNCOPIED_REL}")"
if [ -z "${uncopied_path}" ]; then
  pass "A6 negative control: ${UNCOPIED_REL} is in the context but no ${TARGET_STAGE} COPY captures it, so the resolver is not matching everything"
else
  fail "A6 negative control failed: the resolver claims ${UNCOPIED_REL} lands at ${uncopied_path} in ${TARGET_STAGE}; it is matching paths it should not"
fi

# ── A7: an EXISTING COPY captures the wrapper ──────────────────────────────
wrapper_image_path="$(path_in_stage "${TARGET_STAGE}" "${WRAPPER_REL}")"
if [ -n "${wrapper_image_path}" ]; then
  pass "A7 an existing ${TARGET_STAGE} COPY captures ${WRAPPER_REL}; the instructions place it at ${wrapper_image_path}"
else
  fail "A7 no COPY in the ${TARGET_STAGE} stage captures ${WRAPPER_REL}; the image would not carry the wrapper"
fi

manifest_image_path="$(path_in_stage "${TARGET_STAGE}" "${MANIFEST_REL}")"
if [ -n "${manifest_image_path}" ]; then
  pass "A8 an existing ${TARGET_STAGE} COPY captures ${MANIFEST_REL}; the instructions place it at ${manifest_image_path}"
else
  fail "A8 no COPY in the ${TARGET_STAGE} stage captures ${MANIFEST_REL}; the delivered wrapper could not be checked against a digest"
fi

# ── A9: no new Dockerfile or .dockerignore special case was needed ──────────
#
# The whole point of moving the wrapper into `scripts/` was to reuse a COPY that
# already worked rather than introduce build behaviour nobody here can exercise.
# If the wrapper ever needs its own COPY line or a `.dockerignore` negation, that
# is a mechanism this machine cannot verify, and this assertion says so.
if printf '%s\n' "${COPY_RECORDS}" | grep -q "${WRAPPER_REL}"; then
  fail "A9 the Dockerfile names ${WRAPPER_REL} in a COPY of its own. The wrapper is supposed to ride an existing directory COPY; a bespoke COPY is build behaviour that cannot be verified without a container runtime"
else
  pass "A9 no bespoke COPY for the wrapper: it rides an existing directory COPY, so no unverifiable build behaviour was introduced"
fi

if grep -Eq '^[[:space:]]*!' "${DOCKERIGNORE}"; then
  fail "A10 .dockerignore now contains a negation rule. Negation semantics cannot be exercised on a machine with no container runtime; the wrapper is supposed to need none"
else
  pass "A10 .dockerignore contains no negation rules, so nothing here depends on BuildKit negation semantics"
fi

# ── A11/A12: the three places that name the path agree ─────────────────────
remote_wrapper_path="$(awk -F'"' '/^WRAPPER_IMAGE_PATH=/ { print $2; exit }' "${REMOTE_SH}")"
remote_manifest_path="$(awk -F'"' '/^WRAPPER_MANIFEST_IMAGE_PATH=/ { print $2; exit }' "${REMOTE_SH}")"

if [ -n "${remote_wrapper_path}" ] && [ "${remote_wrapper_path}" = "${wrapper_image_path}" ] &&
  [ -n "${remote_manifest_path}" ] && [ "${remote_manifest_path}" = "${manifest_image_path}" ]; then
  pass "A11 deliver_cutover_wrapper extracts exactly the paths the Dockerfile produces (${remote_wrapper_path}, ${remote_manifest_path})"
else
  fail "A11 deliver_cutover_wrapper extracts '${remote_wrapper_path:-<none>}' and '${remote_manifest_path:-<none>}', the Dockerfile produces '${wrapper_image_path:-<none>}' and '${manifest_image_path:-<none>}'"
fi

manifest_source="$(manifest_value wrapper_source)"
if [ "${manifest_source}" = "${WRAPPER_REL}" ]; then
  pass "A12 ${MANIFEST_REL} pins wrapper_source=${manifest_source}, the file the COPY actually captures"
else
  fail "A12 ${MANIFEST_REL} pins wrapper_source=${manifest_source:-<none>}, not ${WRAPPER_REL}; the digest would describe a different file than the one delivered"
fi

# ── A13: the duplicate really is gone ──────────────────────────────────────
if [ -e "${REPO_ROOT}/scripts/cutover-wrapper-payload.sh" ]; then
  fail "A13 scripts/cutover-wrapper-payload.sh exists again: the image would carry two copies of the cutover wrapper"
else
  pass "A13 no generated duplicate of the wrapper is in the build context"
fi

if [ "${FAILURES}" -eq 0 ]; then
  printf '%s PASS build-context assertions hold. This says NOTHING about the built image or the runtime.\n' "${LABEL}"
  exit 0
fi
printf '%s FAILED %s assertion(s)\n' "${LABEL}" "${FAILURES}" >&2
exit 1
