#!/usr/bin/env bash
# Guard against the pre-transfer repository owner reappearing in an active path.
#
# The repository moved from erhanrdn/OmniAds to emrahbilaloglu-ui/OmniAds, and
# the GHCR namespace moved with it. A find-and-replace fixes that once. Nothing
# stops it coming back: a copied deploy snippet, a resurrected runbook, a new
# script cribbed from an old one.
#
# The hard part is that most occurrences MUST NOT change. Old PR URLs, old
# commit URLs, incident records and dated agent reports name a repository that
# genuinely had that name at the time. Rewriting them falsifies the record. So
# this is not a ban on a string — it is a partition:
#
#   HISTORICAL roots  — chronology. Counts are FROZEN in both directions: a new
#                       occurrence means someone filed active work in an
#                       archive, and a lost one means evidence was rewritten.
#                       Most guards check only one direction and miss the second.
#   ACTIVE roots      — machinery. Every occurrence must be either marked at the
#                       point of use with `release-owner-legacy: <reason>`, or
#                       registered below with an exact count.
#
# Counts, not blanket per-file permission: "docker-compose.yml may mention the
# old owner" would silently absorb a fifth, accidental occurrence. Requiring the
# count to be edited puts a human at the moment the active/historical call is
# actually made.
#
# Line numbers are deliberately NOT pinned. These files are edited often and a
# line-anchored registry is stale within the hour, which trains people to ignore
# it.
set -euo pipefail

cd "$(dirname "$0")/.."

TOKEN="erhanrdn"
LABEL="[release-owner-guard]"

# Chronology. Frozen in both directions.
HISTORICAL_ROOTS=(
  "_analysis/"
  "docs/agent-reports/"
  "docs/operator-policy/"
)

# Active-path occurrences that are deliberate, with the reason they exist.
# Format: <path>|<expected count>|<reason>
REGISTRY=(
  "docker-compose.yml|4|Legacy rollback procedure: header note plus the WEB_IMAGE_REPO/WORKER_IMAGE_REPO export lines an operator copies."
  ".github/workflows/deploy-hetzner.yml|3|The enumerated image_namespace=legacy branch and its rationale."
  ".github/workflows/ci.yml|2|Comments explaining why GITHUB_TOKEN cannot write the old namespace from here."
  ".github/scripts/hetzner-remote.sh|4|Stale-image prune must still recognise old-namespace images on host disk, plus LEGACY_*_IMAGE_REPO."
  ".github/scripts/hetzner-ssh.sh|1|Comment on forwarding the rollback repo variables over SSH."
  "lib/release-authority/types.ts|1|The sanctioned definition site: RELEASE_AUTHORITY_LEGACY_IMAGE_NAMESPACE."
  "lib/release-authority/report.ts|2|Comment on the api.github.com transferred-repo redirect hazard."
  "lib/release-authority/report.test.ts|6|Negative assertions plus pins on the LEGACY_* constants."
  "lib/release-authority/release-namespace.test.ts|8|The cross-language contract test; asserts the legacy constants by value."
  "app/api/release-authority/route.test.ts|2|Negative assertion that the API no longer emits the old owner."
  "components/admin/release-authority-panel.test.tsx|1|Negative assertion that the panel no longer renders the old owner."
  "scripts/check-release-owner-references.sh|9|This guard names the token it searches for."
  "scripts/hetzner-sync-cutover.sh|2|Legacy rollback image references for a pre-transfer cutover."
  "docs/architecture/serving-release-execution-evidence.md|9|Dated 2026-04-10 release evidence: PR, commit and run URLs."
  "docs/architecture/serving-product-ready-signoff.md|1|Dated 2026-04-10 signoff recording the approval basis at that time."
  "docs/architecture/serving-direct-production-release-runbook.md|7|Live runbook: the rollback-across-the-transfer section, where pre-transfer SHAs legitimately name the old namespace."
  "docs/canonical-cleanup-2026-04-30.md|4|Dated cleanup record, including an escalation that is still correct as written because those packages remain under the old owner."
  "docs/v2-01-release-authority.md|2|Superseded document headed 'Historical reference only', plus the note explaining the transfer happened after this baseline."
  "docs/meta-sync-hardening/incident-evidence.md|6|Incident record: workflow run URLs."
  "docs/creative-decision-center/PATH_B_POST_DEPLOY_MONITORING_2026-07-05.md|2|Dated record of exactly which images were running."
)

# Frozen counts for the chronology roots.
HISTORICAL_COUNTS=(
  "_analysis/|10"
  "docs/agent-reports/|5"
  "docs/operator-policy/|66"
)

failed=0

is_historical() {
  local path="$1" root
  for root in "${HISTORICAL_ROOTS[@]}"; do
    case "${path}" in "${root}"*) return 0 ;; esac
  done
  return 1
}

registry_count() {
  local path="$1" entry
  for entry in "${REGISTRY[@]}"; do
    if [ "${entry%%|*}" = "${path}" ]; then
      local rest="${entry#*|}"
      printf '%s' "${rest%%|*}"
      return 0
    fi
  done
  printf ''
}

# Occurrences marked at the point of use. A marker on the same line or the line
# immediately above exempts that occurrence without a registry edit, so a
# genuinely new deliberate use is possible without silently widening an existing
# exemption.
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

echo "${LABEL} scanning tracked files for '${TOKEN}'"

historical_total=0
declare -a offenders=()

while IFS= read -r -d '' path; do
  case "${path}" in
    package-lock.json|pnpm-lock.yaml|*.min.*) continue ;;
  esac
  [ -f "${path}" ] || continue
  count="$(grep -c "${TOKEN}" "${path}" 2>/dev/null || true)"
  [ "${count:-0}" -gt 0 ] || continue

  if is_historical "${path}"; then
    historical_total=$((historical_total + count))
    continue
  fi

  expected="$(registry_count "${path}")"
  marked="$(marked_count "${path}")"

  if [ -n "${expected}" ]; then
    if [ "${count}" -ne "${expected}" ]; then
      offenders+=("${path}: found ${count}, registry expects ${expected}")
    fi
    continue
  fi

  if [ "${marked}" -eq "${count}" ]; then
    continue
  fi

  offenders+=("${path}: ${count} occurrence(s), ${marked} marked, no registry entry")
done < <(git ls-files -z)

if [ "${#offenders[@]}" -gt 0 ]; then
  echo "${LABEL} FAIL — active paths reference the pre-transfer owner:"
  printf '  %s\n' "${offenders[@]}"
  cat <<'EOF'

An active build/deploy/runtime path names the pre-transfer owner.

GITHUB_TOKEN can only publish to the namespace of this repository's own owner,
so an old-namespace push fails; and an old-namespace pull or readback compares
against an image this pipeline never built.

If the reference is deliberate — the legacy rollback path is the only sanctioned
case — either mark it at the point of use:

    # release-owner-legacy: pre-transfer images live only in this namespace

or add it to REGISTRY in this script with an exact count and a reason. Do NOT
rewrite historical evidence to silence this.
EOF
  failed=1
fi

# The inverse guard. Chronology must not drift in either direction.
for entry in "${HISTORICAL_COUNTS[@]}"; do
  root="${entry%%|*}"
  expected="${entry##*|}"
  actual=0
  while IFS= read -r -d '' path; do
    case "${path}" in "${root}"*) ;; *) continue ;; esac
    [ -f "${path}" ] || continue
    c="$(grep -c "${TOKEN}" "${path}" 2>/dev/null || true)"
    actual=$((actual + ${c:-0}))
  done < <(git ls-files -z)
  if [ "${actual}" -ne "${expected}" ]; then
    echo "${LABEL} FAIL — chronology under ${root} changed: found ${actual}, expected ${expected}."
    echo "  More occurrences means active work was filed into an archive."
    echo "  Fewer means historical evidence was rewritten. Neither is a formatting fix."
    failed=1
  fi
done

if [ "${failed}" -ne 0 ]; then
  exit 1
fi

echo "${LABEL} PASS — ${historical_total} historical occurrence(s) frozen; every active-path reference is registered or marked."
