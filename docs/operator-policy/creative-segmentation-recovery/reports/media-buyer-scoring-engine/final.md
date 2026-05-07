# Creative Media Buyer Scoring Engine Final

Date: 2026-04-25

## Executive Result

Result: deterministic scoring engine implemented; fresh score acceptance is still blocked by live audit runtime timeouts.

This pass stops routing Creative policy through a loose sequence of ad hoc segment branches. The policy now builds a deterministic `CreativeMediaBuyerScorecard` for every creative and routes the operator segment from that scorecard recommendation. The downstream operator state, push readiness, queue eligibility, and apply safety remain unchanged.

This is not a Claude/LLM runtime decision system. The scorecard is deterministic TypeScript using the existing Creative policy input, live metrics, relative baselines, benchmark reliability, business validation status, lifecycle, fatigue, trend, and campaign context.

## Scorecard Dimensions Added

New module:

- `lib/creative-media-buyer-scoring.ts`
- `lib/creative-media-buyer-scoring.test.ts`

The scorecard includes:

- relative performance class: `strong`, `above_baseline`, `near_baseline`, `below_baseline`, `weak`, `unknown`
- evidence maturity: `high`, `medium`, `low`, `insufficient`
- trend state: `accelerating`, `stable`, `declining`, `collapsed`, `unknown`
- efficiency risk: `none`, `moderate`, `high`, `catastrophic`, `unknown`
- winner signal: `none`, `promising`, `strong`, `scale_review`, `scale`
- loser signal: `none`, `watch`, `refresh`, `cut`
- context state: `clear`, `campaign_blocked`, `data_blocked`, `benchmark_weak`, `unknown`
- business validation: `favorable`, `missing`, `unfavorable`, `unknown`
- recommended user-facing segment
- internal operator segment used by existing policy surfaces
- confidence, reason tags, blocked actions, and safety status

## Routing Change

`assessCreativeOperatorPolicy()` now builds the scorecard once and `resolveSegment()` returns `mediaBuyerScorecard.operatorSegment`.

The former branch ordering is represented inside `buildCreativeMediaBuyerScorecard()` as deterministic media-buyer priority:

1. hard data / campaign blockers
2. severe loser signals
3. refresh / retest signals
4. strong winner signals
5. true protect / no-touch
6. promising but under-sampled
7. residual Watch

The old policy helper logic is still present where needed to compute missing evidence, required evidence, reasons, and safety surfaces. The segment-routing authority now comes from the scorecard.

## Safety Guards Preserved

Preserved:

- true `Scale` still requires the existing business validation and evidence floors
- `Scale Review` remains review-only
- `Cut`, `Refresh`, and `Retest` remain operator-review outcomes
- queue/push/apply safety was not loosened
- non-live, snapshot, demo, fallback, missing provenance, missing preview, and suppressed rows still cannot become push/apply eligible
- campaign/ad set context blockers still route to investigation instead of forcing winner/loser action
- benchmark scope behavior was not changed
- old rule challenger remains comparison-only

## Audit Helper Update

`scripts/creative-live-firm-audit.ts` now serializes a sanitized `mediaBuyerScorecard` summary per sampled creative:

- score classes
- recommended segment
- confidence
- reason tags
- review-only flag
- blocked actions
- benchmark ratios

No raw business IDs, ad account IDs, creative IDs, tokens, cookies, or customer-identifying values are added to committed artifacts by this field.

## Fixture Coverage Added

New deterministic scorecard tests cover:

- true Scale
- review-only Scale Review with missing business validation
- Test More under-sampled positives
- true Protect / no-touch winners
- validating trend-collapse Refresh
- severe validating Cut
- fatigued catastrophic CPA Cut
- paused historical Retest
- Campaign Check context blockers
- Not Enough Data thin rows
- narrow residual Watch
- non-live evidence push/apply blocking
- benchmark reliability classification

Existing Creative operator policy fixtures still pass unchanged.

## Before / After Scores

Score of record before this pass:

- exact current PR #65 macro score: not proven
- exact current Watch / Refresh / Protect scores: not proven
- exact current IwaStore / TheSwaf scores: not proven

Reason: the prior `/tmp` expected-label artifact predates the latest PR #65 commits. The previous reconciliation proved that joining stale expected labels to current output is not a valid acceptance score.

After this pass:

- no valid fresh equal-segment score was produced
- no acceptance-level score claim is made
- this pass is an architecture/routing implementation with fixture-backed parity and safety checks

## Live Audit Attempt

Attempted runtime rerun:

- established the requested SSH DB tunnel to local `127.0.0.1:15432`
- exported `DATABASE_URL` from production env with the DB host rewritten to the tunnel
- ran `DB_QUERY_TIMEOUT_MS=60000 CREATIVE_LIVE_FIRM_AUDIT_SCREEN_TIMEOUT_MS=60000 node --import tsx scripts/creative-live-firm-audit.ts`

Result:

- the script initialized the DB client
- Meta campaign/ad set context lookups repeatedly timed out after `60000ms`
- the run did not complete and did not produce a valid fresh scoring artifact
- the local process was terminated after repeated query timeouts

Observed timeout messages were sanitized in this report; raw business IDs from the terminal are not committed.

## Remaining Mismatches

Unknown until a fresh current-code audit or independent review runs successfully.

This pass intentionally did not claim that every represented segment is `90+`, because the live scoring artifact could not be regenerated from current code and current independent expected labels.

## Watch Usage

The scoring engine makes Watch a residual recommendation rather than a default first-class action:

- clear winners route to `Scale` / `Scale Review`
- clear losers route to `Cut`
- decay / replacement cases route to `Refresh`
- paused comeback winners route to `Retest`
- campaign blockers route to `Campaign Check`
- truly thin rows route to `Not Enough Data`
- Watch remains only for meaningful but ambiguous rows

Existing policy tests confirm the residual Watch fixture remains Watch and clear action fixtures leave Watch.

## Manual Table Reading

The architecture is now closer to deterministic media-buyer math than the prior scattered branch implementation. However, product usefulness cannot be accepted from architecture alone. A fresh live/equal-segment review is still required before claiming the Creative page is better than manual table reading.

## Claude Re-Review

Claude re-review should run only after a fresh current-code artifact is generated successfully, or after the reviewer explicitly accepts the fixture-backed scorecard implementation without a live rerun.

Current recommendation:

- do not merge PR #65 as final yet
- fix or work around the live audit DB timeout
- regenerate a valid current equal-segment artifact
- then run Claude/supervisor review against that artifact

## Validation

Passed:

- `npx vitest run lib/creative-media-buyer-scoring.test.ts lib/creative-operator-policy.test.ts`
- `npx vitest run lib/creative-media-buyer-scoring.test.ts lib/creative-operator-policy.test.ts lib/creative-operator-surface.test.ts lib/creative-decision-os.test.ts lib/operator-prescription.test.ts app/api/creatives/decision-os/route.test.ts components/command-center/CommandCenterExecutionSupportMatrix.test.tsx lib/command-center.test.ts`
- `npm test`
- `npx tsc --noEmit`
- `npm run build`
- scoped `git diff --check` on touched committed files
- hidden/bidi/control scan on touched docs/code/scripts
- raw sensitive-value scan on committed reports

Full `git diff --check` is blocked by unrelated pre-existing trailing whitespace in `docs/external-reviews/creative-segmentation-recovery/equal-segment-review.md`, which was already dirty in the worktree and was not edited or staged by this pass.

Runtime smoke:

- `/platforms/meta/creatives` returned the expected auth redirect to `/login?next=%2Fcreatives`
- `/platforms/meta` returned the expected auth redirect to `/login?next=%2Fplatforms%2Fmeta`
- `/api/creatives/decision-os` returned `401 Unauthorized` without a session

No local dev server or SSH tunnel was left running after validation.
