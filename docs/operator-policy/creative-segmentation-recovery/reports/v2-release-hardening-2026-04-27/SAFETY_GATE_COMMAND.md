# Safety Gate Command

CHATGPT_REVIEW_READY: YES
SANITIZED: YES
MERGE_REQUESTED: NO
MAIN_PUSHED: NO

# Command

```bash
npm run creative:v2:safety
```

Implementation:

```text
package.json -> node --import tsx scripts/creative-v2-safety-gate.ts
```

Current PR #82 head at public Raw verification:
`ca76bf5ff0931d94f3a3ef68eebae2690ef22179`

New newline-normalization commit:
`ca76bf5ff0931d94f3a3ef68eebae2690ef22179`

GitHub confirmed the commit exists and PR #82 commit list contains it.

# Public Raw Formatting Gate

Public Raw line counts after push:

```text
scripts/creative-v2-safety-gate.ts: 82
lib/creative-v2-no-write-enforcement.test.ts: 156
scripts/creative-v2-self-hosted-smoke.ts: 141
.github/workflows/ci.yml: 336
```

Public Raw max-line checks:

```text
scripts/creative-v2-safety-gate.ts: no output
lib/creative-v2-no-write-enforcement.test.ts: no output
scripts/creative-v2-self-hosted-smoke.ts: no output
.github/workflows/ci.yml: no output
```

Byte-level diagnosis before and after normalization:

```text
scripts/creative-v2-safety-gate.ts bytes 2578 LF 82 CR 0 U+2028 0 U+2029 0 NEL 0
lib/creative-v2-no-write-enforcement.test.ts bytes 5430 LF 156 CR 0 U+2028 0 U+2029 0 NEL 0
scripts/creative-v2-self-hosted-smoke.ts bytes 4135 LF 141 CR 0 U+2028 0 U+2029 0 NEL 0
.github/workflows/ci.yml bytes 10318 LF 336 CR 0 U+2028 0 U+2029 0 NEL 0
```

# Safety Gate Scope

The gate runs these focused Vitest files:

```text
lib/creative-decision-os-v2.test.ts
lib/creative-decision-os-v2-preview.test.tsx
lib/creative-v2-no-write-enforcement.test.ts
lib/get-route-side-effect-guard.test.ts
src/services/data-service-ai.test.ts
components/platforms/meta/creatives/CreativeDecisionSupportSurface.test.tsx
components/platforms/meta/creatives/CreativesTableSection.test.tsx
app/(dashboard)/platforms/meta/platforms/meta/creatives/page.test.tsx
app/api/creatives/decision-os-v2/preview/route.test.ts
```

The gate then evaluates the v2 gold artifact and fails on:

```text
macroF1 below 90
severe mismatches above 0
high mismatches above 0
Watch primary outputs above 0
Scale Review primary outputs above 0
queue eligible outputs above 0
apply eligible outputs above 0
direct Scale outputs above 0
inactive direct Scale outputs above 0
```

# Latest Result

`npm run creative:v2:safety` passed:

```text
Test Files  9 passed (9)
Tests  51 passed (51)
```

Safety output:

```json
{
  "creativeV2SafetyGate": "passed",
  "artifactVersion": "gold-v0.1",
  "rowCount": 78,
  "macroF1": 97.96,
  "mismatchCounts": {
    "severe": 0,
    "high": 0,
    "medium": 2,
    "low": 0,
    "none": 76
  },
  "queueApplySafety": {
    "queueEligibleCount": 0,
    "applyEligibleCount": 0,
    "directScaleCount": 0,
    "inactiveDirectScaleCount": 0,
    "watchPrimaryCount": 0,
    "scaleReviewPrimaryCount": 0
  }
}
```

# Additional Checks

```text
git diff --check: passed
npm test: passed, 307 files, 2203 tests
npx tsc --noEmit: passed
npm run build: passed
focused resolver test: passed, 1 file, 15 tests
focused preview tests: passed, 5 files, 28 tests
no-write enforcement tests: passed, 2 files, 6 tests
forbidden rendered button/text scan: passed
forbidden internal artifact scan: passed
contract parity check: passed
hidden/bidi/control scan: passed, 13 targeted paths
strict non-ASCII scan: passed, 13 targeted paths
restricted filename scan: passed, 13 targeted paths
secret/raw-ID scan: passed, 13 targeted paths
line-length/readability check: passed, 13 targeted paths, max 220
JSON parse checks: passed, 24 tracked JSON files
```

# Self-Hosted Runtime Smoke

Status: not executed against self-hosted runtime.

Local command output:

```text
CREATIVE_V2_SMOKE_BASE_URL is required locally to run the self-hosted smoke.
Do not paste or commit domains, tokens, cookies, DB URLs, or credentials.
```

# Readiness

Product-ready: NO.

Merge-ready to main: NO.

PR #82 ready for PR #78 branch merge consideration: NO.

Queue/apply disabled.

Command Center disconnected.

v1 default.

v2 preview off by default.

Self-hosted site/DB active infra.

Vercel/Neon deprecated.

PR remains Draft.

No main push.
