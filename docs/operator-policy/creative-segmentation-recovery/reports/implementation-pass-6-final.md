# Creative Segmentation Implementation Pass 6 Final

Last updated: 2026-04-23 by Codex

## Result

Pass 6 completed as a focused correction pass.

This pass did not start a new calibration phase, did not broaden the taxonomy, and did not loosen queue/push/apply safety.

Code changes were limited to:

- fixing the review-only `Scale Review` gate for live strong-relative rows that were blocked only by missing business validation
- separating mature weak zero-purchase rows from genuinely early/thin `Not Enough Data` rows
- adding a fatigue caveat to `Test More` instructions without changing the top-level label
- correcting the holdout diagnostic helper so protected winners do not masquerade as hidden `Scale Review` misses

## Scale Review Diagnosis

Claude's pass-5 review called out `4` rows that looked like they should have surfaced as `Scale Review`.

Pass-6 diagnosis found that this was not `4` live product misses.

Breakdown:

- `company-01/company-01-creative-03` was the one real review-only scale miss
- `company-06/company-06-creative-02` was a protected winner
- `company-07/company-07-creative-07` was a protected winner
- `company-07/company-07-creative-10` was a protected winner

The miscount came from the holdout reporting helper. It counted any true-scale-strength row that lacked favorable business validation, even when the row was correctly capped by `Protect`.

Pass 6 fixed both layers:

1. the product policy now treats a keep-in-test row with true-scale evidence and missing business validation as `Scale Review` when no other real blocker exists
2. the holdout helper now counts only real review-only scale candidates and excludes protected winners

## What Changed In Product Behavior

### 1. Review-only Scale Review gate

Current rule:

- if a row clears the true-scale evidence bar
- and the remaining blocker is missing business validation / Commercial Truth
- and there is no weak benchmark, campaign blocker, protected-winner hold, fatigue stop, missing provenance, or non-live safety issue

then the row now surfaces as `Scale Review`.

This remains:

- review-only
- push blocked
- queue blocked
- apply blocked

Representative fixed case:

- `company-01/company-01-creative-03`

Representative non-promotions that remain correct:

- weak baseline => not `Scale Review`
- weak campaign/ad set context => `Campaign Check`
- missing provenance / non-live evidence => safety-blocked
- protected stable winners => `Protect`

### 2. Not Enough Data split

`Not Enough Data` now stays reserved for genuinely early / thin cases.

A separate mature weak case now routes to `Watch` when all of the following are true:

- the row is still in `keep_in_test`
- spend is already meaningful
- impressions are already meaningful
- the creative is no longer early
- purchase proof is still zero

That keeps high-spend weak rows from looking identical to early-learning rows.

### 3. Test More fatigue caveat

`Test More` remains the main outcome for promising under-sampled rows.

When fatigue pressure is already visible, the instruction now explicitly says to keep testing while watching fatigue pressure. This is an instruction-level caveat only; it does not create a new top-level label and does not loosen safety.

### 4. Watch / Scale Review / Protect boundary

The boundary changed only narrowly:

- protected stable winners remain `Protect`
- real scalable review-only rows now reach `Scale Review`
- ambiguous or weak cases remain `Watch`

No broader retune was applied.

## Validation

Targeted tests passed:

- `lib/creative-operator-policy.test.ts`
- `lib/creative-operator-surface.test.ts`
- `lib/operator-prescription.test.ts`
- `lib/creative-decision-os.test.ts`
- `scripts/creative-segmentation-holdout-validation.test.ts`

Result:

- `5` files passed
- `83` tests passed

Full validation passed:

- `npm test` => `296` files passed, `2072` tests passed
- `npm run build`
- `npx tsc --noEmit`
- `git diff --check`

Note:

- `npx tsc --noEmit` required a rerun after `npm run build` because the repo typecheck path includes generated `.next/types`

Runtime smoke passed on the documented localhost + tunneled DB path:

- `/platforms/meta/creatives` loaded
- account-wide benchmark stayed the default
- campaign filter alone did not switch benchmark scope
- explicit `Within campaign` re-evaluation still worked
- fixed `Scale Review` rows rendered cleanly
- mature weak `Watch` wording and `Test More` fatigue caveat rendered without label noise
- `/platforms/meta` still loaded

## Outcome

Pass 6 addressed the remaining focused product risks from Claude's review without widening scope.

The remaining work is no longer a calibration or taxonomy problem. The next step is a single final Claude product review on the current pass-6 state.
