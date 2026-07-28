#!/usr/bin/env bash
# Guard against the pre-transfer repository owner reappearing in an active path.
#
# The repository moved to emrahbilaloglu-ui/OmniAds and the GHCR namespace moved
# with it. A find-and-replace fixes that once; nothing stops it coming back in a
# copied deploy snippet or a script cribbed from an old one.
#
# The hard part is that most occurrences MUST NOT change. Old PR and commit
# URLs, incident records and dated agent reports name a repository that
# genuinely had that name at the time. Rewriting them falsifies the record. So
# this is a partition, not a ban:
#
#   HISTORICAL roots  — chronology. Counts frozen in BOTH directions: a new
#                       occurrence means active work was filed into an archive;
#                       a lost one means evidence was rewritten.
#   META files        — the guard and its contract test, which cannot do their
#                       job without naming the token. See META_FILES.
#   ACTIVE            — machinery. Every occurrence must be marked at the point
#                       of use or registered with an exact count.
#
# ── TWO DEFECTS THIS VERSION FIXES ───────────────────────────────────────────
#
# 1. It enumerated with `git ls-files`, i.e. TRACKED files only. A brand-new
#    file was invisible until committed, so the first run that could see it was
#    the one in CI. That is exactly how this guard shipped green locally and
#    failed on push: two new files carried registry entries the guard had never
#    once been able to check. Enumeration now includes untracked-but-not-ignored
#    files, so a new deploy script with a stale namespace fails before it is
#    committed rather than after it is pushed.
#
# 2. It counted ITSELF and its contract test. Both must name the token to
#    function, so editing a sentence of this comment changed the expected count
#    and demanded recalibration — a rule whose upkeep is indistinguishable from
#    a false positive gets silenced. Those two files are now META by exact path
#    and are not counted at all.
#
# The exemption is deliberately narrow: exact paths, never a `*.test.*` or
# `scripts/**` glob, either of which would let a genuinely stale deploy script
# hide. And it is not free — because META files are unchecked, this script runs
# a HERMETIC SELF-TEST on every invocation proving the matcher still catches the
# failures it exists to catch. If the self-test cannot fail the guard, the guard
# does not run. That is the anti-vacuity contract, persisted rather than
# performed once by hand.
#
# What stops a META file smuggling in a real stale image reference: the actual
# namespace values live in lib/release-authority/types.ts (registry-counted),
# and release-namespace.test.ts pins them BY VALUE against those constants. A
# wrong literal in the contract test fails the contract test.
set -euo pipefail

cd "$(dirname "$0")/.."

TOKEN="erhanrdn"
LABEL="[release-owner-guard]"

# Files that must name the token to do their job. Exact paths only.
META_FILES=(
  "scripts/check-release-owner-references.sh"
  "lib/release-authority/release-namespace.test.ts"
)

HISTORICAL_ROOTS=(
  "_analysis/"
  "docs/agent-reports/"
  "docs/operator-policy/"
)

# <path>|<expected count>|<reason>
REGISTRY=(
  "docker-compose.yml|4|Legacy rollback procedure: header note plus the WEB_IMAGE_REPO/WORKER_IMAGE_REPO export lines an operator copies."
  ".github/workflows/deploy-hetzner.yml|3|The enumerated image_namespace=legacy branch and its rationale."
  ".github/workflows/ci.yml|2|Comments explaining why GITHUB_TOKEN cannot write the old namespace from here."
  ".github/scripts/hetzner-remote.sh|4|Stale-image prune must still recognise old-namespace images on host disk, plus LEGACY_*_IMAGE_REPO."
  ".github/scripts/hetzner-ssh.sh|1|Comment on forwarding the rollback repo variables over SSH."
  "lib/release-authority/types.ts|1|The sanctioned definition site: RELEASE_AUTHORITY_LEGACY_IMAGE_NAMESPACE."
  "lib/release-authority/report.ts|2|Comment on the api.github.com transferred-repo redirect hazard."
  "lib/release-authority/report.test.ts|6|Negative assertions plus pins on the LEGACY_* constants."
  "app/api/release-authority/route.test.ts|2|Negative assertion that the API no longer emits the old owner."
  "components/admin/release-authority-panel.test.tsx|1|Negative assertion that the panel no longer renders the old owner."
  "scripts/hetzner-sync-cutover.sh|2|Legacy rollback image references for a pre-transfer cutover."
  "docs/architecture/serving-release-execution-evidence.md|9|Dated 2026-04-10 release evidence: PR, commit and run URLs."
  "docs/architecture/serving-product-ready-signoff.md|1|Dated 2026-04-10 signoff recording the approval basis at that time."
  "docs/architecture/serving-direct-production-release-runbook.md|7|Live runbook: the rollback-across-the-transfer section, where pre-transfer SHAs legitimately name the old namespace."
  "docs/canonical-cleanup-2026-04-30.md|4|Dated cleanup record, including an escalation still correct as written because those packages remain under the old owner."
  "docs/v2-01-release-authority.md|2|Superseded document headed 'Historical reference only', plus the note explaining the transfer happened after this baseline."
  "docs/meta-sync-hardening/incident-evidence.md|6|Incident record: workflow run URLs."
  "docs/creative-decision-center/PATH_B_POST_DEPLOY_MONITORING_2026-07-05.md|2|Dated record of exactly which images were running."
)

HISTORICAL_COUNTS=(
  "_analysis/|10"
  "docs/agent-reports/|5"
  "docs/operator-policy/|66"
)

# Overridden by the self-test to point at a synthetic tree.
SCAN_ROOT=""

collect_files() {
  if [ -n "${SCAN_ROOT}" ]; then
    ( cd "${SCAN_ROOT}" && find . -type f -print0 ) | while IFS= read -r -d '' f; do
      printf '%s\0' "${f#./}"
    done
  else
    # Tracked AND untracked-but-not-ignored. See defect 1 above.
    git ls-files -z --cached --others --exclude-standard
  fi
}

file_path() {
  if [ -n "${SCAN_ROOT}" ]; then printf '%s/%s' "${SCAN_ROOT}" "$1"; else printf '%s' "$1"; fi
}

in_list() {
  local needle="$1"; shift
  local item
  for item in "$@"; do [ "${item}" = "${needle}" ] && return 0; done
  return 1
}

is_historical() {
  local path="$1" root
  for root in "${HISTORICAL_ROOTS[@]}"; do
    case "${path}" in "${root}"*) return 0 ;; esac
  done
  return 1
}

registry_count() {
  local path="$1" entry rest
  for entry in "${REGISTRY[@]}"; do
    if [ "${entry%%|*}" = "${path}" ]; then
      rest="${entry#*|}"; printf '%s' "${rest%%|*}"; return 0
    fi
  done
  printf ''
}

# An occurrence is exempt when a `release-owner-legacy: <reason>` marker sits on
# the same line or the line immediately above.
marked_count() {
  awk -v token="${TOKEN}" '
    { lines[NR] = $0 }
    END {
      n = 0
      for (i = 1; i <= NR; i++) {
        if (index(lines[i], token) == 0) continue
        if (lines[i] ~ /release-owner-legacy:[[:space:]]*[^[:space:]]/) { n++; continue }
        if (i > 1 && lines[i-1] ~ /release-owner-legacy:[[:space:]]*[^[:space:]]/) { n++; continue }
      }
      print n
    }
  ' "$1"
}

OFFENDERS=""
HISTORICAL_TOTAL=0

run_scan() {
  OFFENDERS=""
  HISTORICAL_TOTAL=0
  local path full count expected marked
  while IFS= read -r -d '' path; do
    case "${path}" in
      package-lock.json|pnpm-lock.yaml|*.min.*) continue ;;
    esac
    if in_list "${path}" "${META_FILES[@]}"; then continue; fi
    full="$(file_path "${path}")"
    [ -f "${full}" ] || continue
    count="$(grep -c "${TOKEN}" "${full}" 2>/dev/null || true)"
    [ "${count:-0}" -gt 0 ] || continue

    if is_historical "${path}"; then
      HISTORICAL_TOTAL=$((HISTORICAL_TOTAL + count))
      continue
    fi

    expected="$(registry_count "${path}")"
    if [ -n "${expected}" ]; then
      [ "${count}" -eq "${expected}" ] ||
        OFFENDERS="${OFFENDERS}${path}: found ${count}, registry expects ${expected}"$'\n'
      continue
    fi

    marked="$(marked_count "${full}")"
    [ "${marked}" -eq "${count}" ] ||
      OFFENDERS="${OFFENDERS}${path}: ${count} occurrence(s), ${marked} marked, no registry entry"$'\n'
  done < <(collect_files)

  local entry root exp actual c
  for entry in "${HISTORICAL_COUNTS[@]}"; do
    root="${entry%%|*}"; exp="${entry##*|}"; actual=0
    while IFS= read -r -d '' path; do
      case "${path}" in "${root}"*) ;; *) continue ;; esac
      full="$(file_path "${path}")"
      [ -f "${full}" ] || continue
      c="$(grep -c "${TOKEN}" "${full}" 2>/dev/null || true)"
      actual=$((actual + ${c:-0}))
    done < <(collect_files)
    [ "${actual}" -eq "${exp}" ] ||
      OFFENDERS="${OFFENDERS}chronology under ${root} changed: found ${actual}, expected ${exp}"$'\n'
  done
}

# ── HERMETIC SELF-TEST ───────────────────────────────────────────────────────
# The price of the META exemption. Runs on a synthetic tree, never the repo, so
# it neither depends on nor perturbs real state.
self_test() {
  local tmp saved_registry saved_hist_roots saved_hist_counts saved_meta failures=0
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2034
  trap 'rm -rf "${tmp}"' RETURN

  mkdir -p "${tmp}/active" "${tmp}/archive"
  saved_registry=("${REGISTRY[@]}")
  saved_hist_roots=("${HISTORICAL_ROOTS[@]}")
  saved_hist_counts=("${HISTORICAL_COUNTS[@]}")
  saved_meta=("${META_FILES[@]}")

  REGISTRY=("active/registered.sh|1|synthetic")
  HISTORICAL_ROOTS=("archive/")
  HISTORICAL_COUNTS=("archive/|1")
  META_FILES=("active/meta.sh")
  SCAN_ROOT="${tmp}"

  expect() { # <case> <want: fail|pass> <substring-if-fail>
    local name="$1" want="$2" needle="${3:-}"
    run_scan
    if [ "${want}" = "fail" ]; then
      if [ -z "${OFFENDERS}" ] || { [ -n "${needle}" ] && ! printf '%s' "${OFFENDERS}" | grep -q "${needle}"; }; then
        echo "${LABEL} SELF-TEST FAILED: ${name} should have been caught" >&2
        failures=$((failures + 1))
      fi
    else
      if [ -n "${OFFENDERS}" ]; then
        echo "${LABEL} SELF-TEST FAILED: ${name} should have passed, got: ${OFFENDERS}" >&2
        failures=$((failures + 1))
      fi
    fi
  }

  # Baseline: a registered file at its count, chronology intact, meta noisy.
  printf 'image %s/omniads-web\n' "ghcr.io/${TOKEN}" > "${tmp}/active/registered.sh"
  printf 'PR https://github.com/%s/OmniAds/pull/1\n' "${TOKEN}" > "${tmp}/archive/evidence.md"
  printf 'TOKEN=%s\n%s again\n%s thrice\n' "${TOKEN}" "${TOKEN}" "${TOKEN}" > "${tmp}/active/meta.sh"
  expect "S0 baseline" pass

  # S1 a NEW active file naming the old owner, unregistered and unmarked.
  printf 'image ghcr.io/%s/omniads-worker\n' "${TOKEN}" > "${tmp}/active/new-deploy.sh"
  expect "S1 new active old-owner reference" fail "new-deploy.sh"
  rm -f "${tmp}/active/new-deploy.sh"

  # S2 historical evidence rewritten away.
  printf 'PR https://github.com/emrahbilaloglu-ui/OmniAds/pull/1\n' > "${tmp}/archive/evidence.md"
  expect "S2 removed historical occurrence" fail "chronology"
  printf 'PR https://github.com/%s/OmniAds/pull/1\n' "${TOKEN}" > "${tmp}/archive/evidence.md"

  # S3 an extra unmarked legacy runtime use inside an ALREADY-registered file.
  printf 'image %s/omniads-web\nimage %s/omniads-worker\n' "ghcr.io/${TOKEN}" "ghcr.io/${TOKEN}" \
    > "${tmp}/active/registered.sh"
  expect "S3 unmarked legacy use in a registered file" fail "registered.sh"
  printf 'image %s/omniads-web\n' "ghcr.io/${TOKEN}" > "${tmp}/active/registered.sh"

  # S4 the same use, marked at the point of use, in an UNregistered file.
  printf '# release-owner-legacy: rollback target predates the transfer\nimage ghcr.io/%s/omniads-web\n' \
    "${TOKEN}" > "${tmp}/active/marked.sh"
  expect "S4 marked legacy use is permitted" pass
  rm -f "${tmp}/active/marked.sh"

  # S5 the whole point of META: editing its prose changes nothing.
  printf 'TOKEN=%s\n%s\n%s\n%s\n%s\nnew sentence about %s\n' \
    "${TOKEN}" "${TOKEN}" "${TOKEN}" "${TOKEN}" "${TOKEN}" "${TOKEN}" > "${tmp}/active/meta.sh"
  expect "S5 meta prose edits need no recalibration" pass

  # S6 ...but META is not a hiding place for the rest of the tree.
  printf 'image ghcr.io/%s/omniads-web\n' "${TOKEN}" > "${tmp}/active/sneaky.sh"
  expect "S6 meta exemption does not extend to other files" fail "sneaky.sh"
  rm -f "${tmp}/active/sneaky.sh"

  REGISTRY=("${saved_registry[@]}")
  HISTORICAL_ROOTS=("${saved_hist_roots[@]}")
  HISTORICAL_COUNTS=("${saved_hist_counts[@]}")
  META_FILES=("${saved_meta[@]}")
  SCAN_ROOT=""

  if [ "${failures}" -ne 0 ]; then
    echo "${LABEL} the guard cannot prove it still catches anything; refusing to vouch for the tree." >&2
    return 1
  fi
  echo "${LABEL} self-test OK — S1 new active ref, S2 rewritten history, S3 unmarked legacy use, S4 marked use allowed, S5 meta prose free, S6 meta not contagious"
  return 0
}

self_test

# META files are unchecked, so their absence must not be silent.
for meta in "${META_FILES[@]}"; do
  [ -f "${meta}" ] || {
    echo "${LABEL} FAIL — meta file ${meta} is missing; the exemption has no counterpart." >&2
    exit 1
  }
done

echo "${LABEL} scanning tracked and untracked files for '${TOKEN}'"
run_scan

if [ -n "${OFFENDERS}" ]; then
  echo "${LABEL} FAIL:"
  printf '%s' "${OFFENDERS}" | sed 's/^/  /'
  cat <<'EOF'

An active build/deploy/runtime path names the pre-transfer owner, or the
historical record moved.

GITHUB_TOKEN can only publish to the namespace of this repository's own owner,
so an old-namespace push fails; and an old-namespace pull or readback compares
against an image this pipeline never built.

If a reference is deliberate — the legacy rollback path is the only sanctioned
case — either mark it at the point of use:

    # release-owner-legacy: pre-transfer images live only in this namespace

or add it to REGISTRY with an exact count and a reason. Do NOT rewrite
historical evidence to silence this.
EOF
  exit 1
fi

echo "${LABEL} PASS — ${HISTORICAL_TOTAL} historical occurrence(s) frozen; every active-path reference is registered or marked; ${#META_FILES[@]} meta file(s) covered by the self-test."
