# Round 6 Watch Refresh Edge Fix

Date: 2026-04-25

Branch / PR: `feature/adsecute-creative-claude-fix-plan-implementation` /
`https://github.com/erhanrdn/OmniAds/pull/65`

## Executive Result

The requested Watch-as-Refresh edge issue was real in Claude's Round 4 review,
but the exact target shape is already fixed on the current PR #65 branch.

No additional policy change was made in this pass.

## Target Trace

Representative reviewed shape:

- sanitized row: `company-08 / company-08-creative-10`
- lifecycle / action: `validating` / `keep_in_test`
- before outcome in Claude review: `Watch`
- expected outcome: `Refresh`, unless existing severe Cut gates apply
- evidence shape: spend around `$378`, ROAS about `0.37x` active benchmark,
  `2` purchases, recent 7-day ROAS `0`, elevated but not catastrophic CPA, no
  campaign-context blocker

Current PR #65 behavior:

- policy segment: `needs_new_variant`
- user-facing outcome: `Refresh`
- push readiness: `operator_review_required`
- queue/apply: false

## Gate Status

The current branch already contains `isValidatingBelowBaselineCollapseRefreshCandidate`
in `lib/creative-operator-policy.ts`.

Admission requires:

- lifecycle `validating`
- primary action `keep_in_test`
- reliable active relative baseline
- spend `>= 300`
- purchases `>= 2`
- impressions `>= 3000`
- known creative age `>= 7`
- ROAS at or below `0.40x` active benchmark
- recent ROAS `0` or trend ratio `<= 0.30`
- no campaign/ad set context blocker

This matches the requested narrow rule. Stronger severe failures still route to
Cut through the existing Cut gates, and thinner or context-blocked rows remain
conservative.

## Tests Covering The Requested Cases

Existing fixture coverage in `lib/creative-operator-policy.test.ts` includes:

- `company-08/creative-10` shape routes to Refresh, not Watch
- stronger severe failure routes to Cut, not Refresh
- spend below the floor does not force Refresh
- purchases below the floor does not force Refresh
- campaign context blocker routes to Campaign Check / investigate
- above-baseline validating row with a short dip does not false-Refresh
- missing 7-day ROAS does not infer collapse
- queue/push/apply remain blocked for the review-safe Refresh path

## Score Read

Because no additional code change was required, the score read remains the
current PR #65 post-Round-5 estimate:

- Watch: `75/100` before Round 5 -> about `90/100`
- Refresh: `88/100` before Round 5 -> about `90/100`
- macro: `87/100` before Round 5 -> about `90/100` after Round 5 plus the
  Protect boundary guard

The exact owner acceptance score still needs an independent Claude re-review of
the latest PR #65 branch because this repo does not contain an executable
equal-segment scoring helper for regenerating the independent human-judgment
score.

## Validation

- targeted Creative policy/surface/Decision OS/prescription tests: passed
- targeted Creative UI surface tests: passed
- targeted Command Center safety tests: passed
- full `npm test`: passed (`300` files, `2173` tests)
- `npx tsc --noEmit`: passed
- `npm run build`: passed
- `/platforms/meta/creatives` localhost smoke: passed through expected auth redirect/load
- `/platforms/meta` localhost smoke: passed through expected auth redirect/load
- hidden/bidi/control scan on touched docs: passed
- raw ID scan on touched docs: passed
- lint skipped: no `lint` script exists

`git diff --check` on the touched/staged files passed. Full working-tree
`git diff --check` is currently blocked by unstaged external-review whitespace
in `docs/external-reviews/creative-segmentation-recovery/equal-segment-review.md`;
that file was already modified outside this pass and is not staged here.

## Remaining Risks

- no broad Watch or Refresh retune was made
- no Scale / Scale Review floor changed
- no queue/push/apply safety changed
- no UI or taxonomy change was made

If a new Claude review identifies a different Watch-as-Refresh shape, it should
be traced as a separate narrow fixture instead of broadening this gate.

## Next Recommended Action

Run Claude equal-segment re-review against the current PR #65 branch. Do not
merge PR #65 before that review or explicit supervisor approval.
