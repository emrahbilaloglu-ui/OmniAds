# Creative Segmentation Implementation Pass 3

Last updated: 2026-04-23 by Codex

## Scope

This pass implemented the next fixture-backed product gap after pass 2:

- explicit benchmark-scope operator control
- explicit campaign-relative re-evaluation only when the operator chooses it
- clearer relative-strength vs business-validation messaging
- baseline-quality follow-through in the operator surface

This pass did not broaden queue, push, or apply authority.

This pass did not import old-rule challenger behavior into policy.

This pass did not force true `Scale` counts.

## Implemented In Pass 3

### 1. Explicit benchmark-scope control is now active on the Creative page

- the Creative page now exposes an explicit benchmark control
- default scope remains `Account-wide`
- `Within campaign` only appears when the current filtered context resolves to exactly one campaign
- changing a campaign filter alone does not silently switch benchmark authority
- the active scope stays visible in the control itself and inside the Decision OS surface metadata

### 2. Campaign-relative re-evaluation now happens only when explicitly enabled

- the page now passes explicit benchmark scope into the existing Creative Decision OS query path
- campaign-relative evaluation is only requested when the operator has explicitly chosen campaign scope
- when the operator stays on account scope, the page keeps account-wide comparison even if a single campaign is filtered
- preview-strip heat benchmarking now follows the explicit benchmark scope instead of silently following incidental visible-row filtering

### 3. Relative strength and business validation are now separated more clearly

- `Scale Review` rows now explain that the creative is a strong relative performer against the active benchmark
- when Commercial Truth or business targets are still missing, the row now says that explicitly instead of reading like a vague hold
- `Scale Review` instruction copy now keeps `Scale Review` as the headline even when the instruction kind is still `investigate`
- Decision OS overview now shows:
  - benchmark scope
  - baseline reliability
  - whether business validation is missing or configured
- Creative detail now shows:
  - benchmark scope
  - baseline reliability
  - explicit business-validation-missing note when relevant

### 4. Baseline-quality honesty stays intact

- weak or unavailable campaign/account cohorts still do not produce false `Scale Review`
- this pass did not loosen baseline admission floors from pass 2
- benchmark reliability remains visible so the operator can see when the comparison is thin instead of inferring false certainty

### 5. True `Scale` was evaluated and deferred again

True `Scale` was not expanded in this pass.

Reason:

- fixture support is still strongest for `Scale Review`, not broader execution authority
- Commercial Truth and business-target validation are still too often incomplete for safe wider scale authorization
- the product gap here was clarity and explicit scope control, not authority widening

## Fixture Coverage Added Or Hardened

This pass added or hardened coverage for:

- default account-wide benchmark scope
- explicit campaign benchmark scope
- selected campaign filter without silent benchmark switching
- campaign-scope metadata visibility
- account-scope restoration after leaving campaign mode
- `Scale Review` relative-winner messaging with business validation still missing
- benchmark reliability labeling
- benchmark scope + reliability visibility in creative detail
- single-output clarity for `Scale Review`

## Safety Status

Still preserved:

- old-rule challenger remains comparison-only
- `Scale Review` remains review-only
- missing provenance still blocks queue/apply/push
- missing Commercial Truth still blocks push/apply and absolute-profit claims
- non-live/demo/snapshot/fallback evidence stays non-push eligible
- selected reporting range remains analysis context only
- Command Center safety was not loosened

## Validation

Ran targeted:

- `npx vitest run components/platforms/meta/creatives/platforms/meta/creatives-top-section-support.test.ts components/platforms/meta/creatives/CreativeBenchmarkScopeControl.test.tsx lib/creative-operator-surface.test.ts lib/operator-prescription.test.ts components/platforms/meta/creatives/CreativeDecisionOsOverview.test.tsx components/platforms/meta/creatives/CreativeDetailExperience.test.tsx`

Runtime smoke:

- documented localhost runtime path with local DB tunnel / existing local forward
- `PLAYWRIGHT_USE_WEBSERVER=0 PLAYWRIGHT_BASE_URL=http://127.0.0.1:3000 npx playwright test playwright/tests/reviewer-smoke.spec.ts --project=smoke-chromium`
- reviewer smoke passed against localhost and covered both `/platforms/meta` and `/platforms/meta/creatives`

Full validation:

- `npm test`
- `npx tsc --noEmit`
- `npm run build`
- `git diff --check`
- hidden/bidi/control scan on touched docs/code
- raw ID scan on updated docs/code

## Result

Implementation pass 3 makes benchmark authority explicit in the product instead of implicit in the filtering state:

- operators can now choose account-wide vs campaign-relative benchmarking explicitly
- campaign-relative re-evaluation works only when explicitly requested
- `Scale Review` now reads like a relative-winner diagnosis plus an honest business-validation caveat
- benchmark scope and reliability are visible in the UI
- true `Scale` remains deferred until stronger fixtures justify it

Pass 4 is still needed for any safe expansion beyond the current review-only scale path.
