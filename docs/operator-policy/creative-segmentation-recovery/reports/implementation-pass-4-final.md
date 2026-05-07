# Creative Segmentation Implementation Pass 4

Last updated: 2026-04-23 by Codex

## Scope

Pass 4 implemented the next narrow authority gap after pass 3:

- true `Scale` activation under strict, fixture-backed conditions
- stronger baseline-quality follow-through in the policy path
- explicit business-validation promotion and demotion rules
- cleaner single-output operator messaging for `Scale`, `Scale Review`, and `Watch`

This pass did not broaden queue, push, or apply authority.

This pass did not change benchmark-scope defaults.

This pass did not import old-rule challenger behavior into policy.

## Implemented In Pass 4

### 1. True `Scale` is now live under strict conditions

`Scale` now requires all of the following:

- live evidence
- provenance and trust present
- preview truth not missing or degraded for aggressive action
- no campaign/ad set context blocker
- favorable business validation
- strong relative baseline support
- stronger evidence than `Scale Review`

Current direct-scale floor:

- relative baseline reliability = `strong`
- at least `6` eligible peer creatives
- relative spend basis at least `500`
- relative purchase basis at least `8`
- creative spend at least `max(300, 1.3 x median peer spend)`
- creative purchases at least `6`
- ROAS at least `1.6 x` median peer ROAS
- CPA not worse than the median peer CPA when CPA basis exists

When those conditions are met, the row can surface as `Scale`.

This still does not invent a budget, bid, or apply-ready action.

### 2. `Scale Review` now acts as the relative-winner review state, not only the missing-truth state

`Scale Review` still stays review-only.

It now covers strong relative winners when:

- relative benchmark evidence is strong enough for comparison
- campaign context is not the primary blocker
- but direct `Scale` is not yet justified

That includes:

- missing Commercial Truth / missing business validation
- medium baseline reliability that is good enough for review but not direct promotion

Current `Scale Review` floor:

- relative baseline reliability = `medium` or `strong`
- at least `3` eligible peer creatives
- relative spend basis at least `150`
- relative purchase basis at least `3`
- creative spend at least `max(80, 0.2 x median peer spend)`
- creative purchases at least `2`
- ROAS at least `1.4 x` median peer ROAS
- CPA not worse than `1.2 x` median peer CPA when CPA basis exists

### 3. Business validation now has explicit promotion and demotion behavior

Current behavior:

- favorable business validation can promote a strong relative winner from `Scale Review` to `Scale`
- missing business validation keeps the relative winner visible as `Scale Review`
- unfavorable business validation demotes the row out of `Scale` into `Watch`

This keeps relative strength visible without pretending business proof exists.

### 4. Weak baseline quality no longer leaks false authority

Current behavior:

- weak or unavailable baseline cannot produce `Scale`
- weak or unavailable baseline cannot produce false `Scale Review`
- medium baseline can support `Scale Review`, but not direct `Scale`
- report text now calls out benchmark reliability more explicitly instead of reading like a fully authoritative benchmark

### 5. Surface messaging now stays single-output and cleaner

Current surface shape:

- `Scale`:
  - strong relative performer against the active benchmark
  - business validation supports a controlled scale move
- `Scale Review`:
  - strong relative performer against the active benchmark
  - review-only because business validation is missing or baseline authority is not yet strong enough for direct promotion
- `Watch` after relative-winner demotion:
  - promising relative performer
  - business validation does not support a direct scale move yet

This keeps one main row outcome while using the supporting note to explain why that outcome is capped.

## Fixture Coverage Added Or Hardened

This pass added or hardened coverage for:

- strong account-relative winner + favorable business validation => `Scale`
- same strong winner + missing Commercial Truth => `Scale Review`
- same strong winner + unfavorable business validation => `Watch`, not `Scale`
- same strong winner + medium baseline => `Scale Review`, not `Scale`
- same strong winner + weak campaign context => `Campaign Check`, not `Scale`
- strong explicit campaign benchmark => campaign-relative `Scale`
- account-relative and campaign-relative report text now reflects benchmark reliability
- `Scale` reason text and `Scale Review` reason text stay aligned with the row outcome
- demoted relative winner stays single-output `Watch`

## Safety Status

Still preserved:

- `Scale Review` remains review-only
- `Scale` does not invent budget, bid, or amount guidance
- `Scale` does not unlock apply authority
- missing provenance still blocks queue/apply/push
- non-live/demo/snapshot/fallback evidence stays non-push eligible
- selected reporting range remains analysis context only
- old challenger remains comparison-only
- Command Center safety was not loosened

## Validation

Targeted:

- `npx vitest run lib/creative-operator-policy.test.ts lib/creative-decision-os.test.ts lib/creative-operator-surface.test.ts lib/operator-prescription.test.ts`
- `npx vitest run lib/command-center.test.ts lib/creative-old-rule-challenger.test.ts`

Full:

- `npm test`
- `npm run build`
- `npx tsc --noEmit`
- `git diff --check`

Runtime smoke:

- documented localhost runtime path with local DB tunnel / existing local forward
- `PLAYWRIGHT_USE_WEBSERVER=0 PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 npx playwright test playwright/tests/reviewer-smoke.spec.ts`
- ad hoc Playwright runtime check on `/platforms/meta/creatives` confirmed:
  - default benchmark stays `Account-wide`
  - adding a campaign filter alone does not silently switch scope
  - explicit `Within campaign` switch activates campaign-relative evaluation
  - switching back restores account-wide comparison

## Result

Pass 4 makes true `Scale` real without broadening authority blindly:

- `Scale` now exists as a stricter state than `Scale Review`
- `Scale Review` remains the review-only relative-winner state
- baseline reliability now materially controls promotion authority
- business validation now explicitly promotes, caps, or demotes relative winners
- the operator surface still resolves to one clear main outcome per row

Pass 5 is still needed for broader scale-path coverage, deeper baseline-quality work, and any future fixture-backed expansion beyond the current strict authority ladder.
