# Creative Segmentation Recovery State

Last updated: 2026-04-28 by Codex

## Current Goal

Integrate deterministic Creative media-buyer scoring as the routing layer for
Creative segmentation while preserving the live targeted fatigued-winner Cut
recalibration and all queue/push/apply safety.

Current result: PR #74 and PR #65 are merged into main/live. The Creative v2
buyer surface from PR #78 is promoted from limited query-gated preview to the
normal Creative page as a read-only surface. V1 remains rendered, queue/apply
and Command Center remain disconnected, and no DB or Meta/platform write path
is added by the v2 buyer surface.

## Program Status

- foundation: merged
- foundation hardening: merged
- calibration data gate: passed
- live Meta cohort recovery: complete
- original 10-agent calibration panel: complete
- implementation passes 1-6: merged
- pass 6 fatigue hardening: merged
- live output restoration: merged
- UI taxonomy/count hardening: merged
- test campaign actionability: merged
- critical media-buyer fixes: merged
- critical fix hardening: merged
- equal-segment scoring audit: complete
- equal-segment gate fixes: merged through PR #59
- final equal-segment fixes: merged through PR #61
- trend-collapse evidence hardening: merged through PR #63
- Creative Decision OS manual snapshots: merged through PR #66
- Creative primary-decision resolver: merged through PR #69
- Creative primary-decision UI swap: merged through PR #71
- Creative review-only Scale surface hardening: implemented in prior pass
- fatigued-winner Cut recalibration: merged and live through PR #74
- Creative v2 buyer preview: merged through PR #78; promoted to normal Creative page visibility with explicit query opt-out
- Claude fix-plan implementation, Watch floor-policy fix, Round 5 closure, and PR #65 media-buyer scoring: merged
- Protect/no-touch boundary investigation: merged through PR #65
- Round 6 Watch-as-Refresh edge verification: merged through PR #65; no additional policy change required
- PR #65 score reconciliation: complete; no policy change made
- Creative media-buyer scoring engine: merged through PR #65
- PR #65 fresh scoring unblock: source-read/audit helper hardened; fresh current-output artifact exists but is blocked and invalid for acceptance
- PR #65 scoring runtime recovery: server-side Docker audit completed; fresh current-output artifact is valid for Claude review

## Fatigued Winner Cut Recalibration

Status: merged and live through PR #74; preserved in the current PR #65
integration pass.

Decision:

- no full Creative segmentation rebuild
- no baseline-first replacement classifier
- no UI taxonomy change
- no Scale / Scale Review floor change
- no queue/push/apply safety change

Issue:

- the targeted issue was real
- main already had a catastrophic-CPA `fatigued_winner` / `refresh_replace`
  Cut gate
- that gate did not cover high-spend below-baseline fatigued winners when CPA
  was not catastrophic enough to trip the CPA-specific path

Gate fixed:

- added `isFatiguedHighSpendBelowBaselineCutCandidate`
- admission requires reliable relative baseline, mature evidence, ROAS at or
  below `0.80x` active benchmark, and spend at least
  `max(1500, 3x peer median spend)`
- campaign/ad set context blockers still route to Campaign Check behavior
- weak/unreliable baselines do not invent Cut
- protected no-touch winners remain Protect unless the failure gate applies
  without a protected override

Fixture targets now route to Cut:

- `row-041`
- `row-043`
- `row-046`
- `row-078`

Remaining intentionally out of scope:

- validating Watch -> Refresh
- lifecycle fatigue classifier up-trend guard
- Scale / Scale Review recalibration
- baseline-first classifier replacement

Next recommended action:

- open PR `Recalibrate fatigued winner Cut admission`
- after this lands, evaluate the validating Watch -> Refresh cluster as a
  separate narrow pass

Validation note:

- live-firm audit rerun was retried through the SSH database tunnel
- the tunnel connected, but the helper failed on a database query timeout after
  `8000ms`
- no live score movement is claimed from this pass; acceptance is fixture-backed
  until a fresh audit can complete

Report:

- `docs/operator-policy/creative-segmentation-recovery/reports/fatigued-winner-cut-recalibration/final.md`

## PR #71 P1 Review-Only Scale Surface Issue

Status: fixed in prior pass; PR flow pending in this state file.

Issue:

- `buildCreativeOperatorSurfaceModel` used total primary `scale` count to set
  `act_now` emphasis and Scale headlines.
- primary `Scale` intentionally includes review-only Scale Review rows.
- if all Scale rows were review-only, muted, or non-live, the surface could
  still imply direct scale action was ready.

Fix summary:

- added presentation-only Scale actionability counts:
  - total primary Scale
  - direct-action Scale
  - review-first Scale
  - muted / non-live Scale
- direct-action Scale now requires existing policy/readiness safety:
  - resolved primary `scale`
  - not `review_only`
  - not muted/thin/archive
  - live or legacy-unset evidence source
  - `scale_ready` policy segment
  - queue/apply eligible, `safe_to_queue`, or `eligible_for_push_when_enabled`
- review-only Scale remains grouped under the Scale filter but cannot set
  `act_now` emphasis.
- when no direct-action Scale exists, surface copy says Scale candidates need
  operator review and no creatives are ready for direct Scale.

Tests/checks:

- targeted Creative operator surface/UI tests passed
- targeted operator prescription test passed
- `npm test` passed
- `npx tsc --noEmit` passed
- `npm run build` passed
- `git diff --check` passed
- hidden/bidi/control scan passed
- raw ID scan on touched docs passed
- runtime smoke passed with expected auth redirects for `/platforms/meta/creatives` and `/platforms/meta`

Report:

- `docs/operator-policy/creative-segmentation-recovery/reports/scale-review-surface-hardening/final.md`

Next recommended action:

- open PR `Harden review-only Scale surface emphasis`
- after merge, rerun Claude primary-decision UI review

## Creative Primary-Decision Resolver

Status: implemented and merged through PR #69.

Direction accepted:

- current 10 user-facing labels mix operator action, confidence, evidence, and context states
- target primary decisions are `scale`, `test_more`, `protect`, `refresh`, `cut`, and `diagnose`
- secondary reason tags preserve the nuance currently carried by Scale Review, Watch, Retest, Campaign Check, and Not Enough Data

Implementation summary:

- added exported `CreativeOperatorPrimaryDecision`, `CreativeOperatorSubTone`, and `CreativeOperatorReasonTag` types
- added `resolveCreativeOperatorDecision(creative)` as a pure parallel resolver in `lib/creative-operator-surface.ts`
- resolver returns one primary decision, one sub-tone, and up to two deterministic reason tags
- `Scale Review` maps to `scale` with `review_only`
- paused historical Retest maps to `refresh` with `revive`
- Campaign Check maps to `diagnose` with `campaign_context_blocker`
- Not Enough Data maps to diagnostic low-evidence handling
- Watch is not a primary decision in the resolver

Safety and product boundaries:

- no Creative policy thresholds changed
- no Scale / Scale Review gates changed
- no queue/push/apply safety changed
- old-rule challenger output remains comparison-only
- no snapshot schema change was made

Tests added:

- direct resolver mapping tests for Scale, Scale Review, Test More, Protect, Watch-like, Refresh, Retest, Cut, Campaign Check, and Not Enough Data rows
- safety invariance tests for review-only Scale and non-live/fallback evidence
- sanitized live-firm audit fixture test proving every row resolves to one of six primaries and Diagnose rows carry diagnostic reason tags

Report:

- `docs/operator-policy/creative-segmentation-recovery/reports/taxonomy-simplification-resolver/final.md`

## Creative Primary-Decision UI Swap

Status: complete and merged through PR #71.

Active primary-decision taxonomy:

- `Scale`
- `Test More`
- `Protect`
- `Refresh`
- `Cut`
- `Diagnose`

Implementation summary:

- top Creative filters now use the six primary decisions
- filter and overview counts come from `resolveCreativeOperatorDecision(...).primary`
- Creative preview cards show primary decision, optional sub-tone, and reason tags
- Creative Decision Support and overview surfaces use primary-decision language
- Creative detail verdict uses primary decision first
- old 10-label aggregate counts no longer drive top-line taxonomy cards

Scale Review representation:

- old `Scale Review` rows now appear under `Scale`
- sub-tone shows `Review only`
- reason tags preserve `Business target missing` / `Commercial truth missing`
- queue/push/apply eligibility remains governed by the underlying policy and stays blocked where review-only

Old labels demoted:

- `Watch` is not a primary filter; resolver maps those rows to `Test More`, `Refresh`, `Cut`, or `Diagnose`
- `Retest` is represented as `Refresh` with `Revive`, `Comeback candidate`, or `Paused winner`
- `Campaign Check` is represented as `Diagnose` with `Campaign context`
- `Not Enough Data` is represented as `Diagnose` or `Test More` with low-evidence reason tags

Preserved:

- no Creative policy retune
- no Scale / Scale Review floor change
- no benchmark-scope behavior change
- no queue/push/apply safety change
- manual Decision OS snapshot behavior remains active
- selected reporting range remains non-authoritative

Tests/checks so far:

- targeted Creative operator surface/filter tests passed
- targeted Creative overview/drawer/detail/operator-prescription/API tests passed
- `npx tsc --noEmit` passed
- `npm test` passed
- `npm run build` passed
- `git diff --check` passed
- hidden/bidi/control scan passed
- raw ID scan on touched docs passed
- runtime smoke passed with expected auth redirects for `/platforms/meta/creatives` and `/platforms/meta`

Report:

- `docs/operator-policy/creative-segmentation-recovery/reports/primary-decision-ui-swap/final.md`

Next recommended action:

- complete the review-only Scale surface hardening pass before rerunning
  Claude product review on the simplified UI

## Creative Decision OS Manual Snapshot Pass

Status: complete and merged.

PR:

- URL: `https://github.com/erhanrdn/OmniAds/pull/66`
- title: `Add manual Creative Decision OS analysis snapshots`
- branch: `feature/adsecute-creative-decision-os-snapshots`
- local validation: passed
- GitHub status contexts: none reported by the connector at PR-open time
- merge method: squash
- merged commit: `7be5f28cf2918fe020b55393cd5f8513882eceb2`
- merged to: `main`

Root issue:

- `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx` enabled a `creative-decision-os` query on page load.
- that query key included `drStart` and `drEnd`
- changing the selected reporting range could refetch `/api/creatives/decision-os`
- the API `GET` path computed Decision OS immediately

Fix summary:

- added `creative_decision_os_snapshots`
- added `lib/creative-decision-os-snapshots.ts`
- changed Creative Decision OS API behavior:
  - `GET /api/creatives/decision-os` loads the latest matching snapshot only
  - `POST /api/creatives/decision-os` manually computes and saves a snapshot
- changed the Creative page to:
  - load snapshot state on page load
  - show `Run Creative Analysis`
  - show last analyzed timestamp
  - show analysis scope and benchmark scope
  - keep reporting-range changes reporting-only
  - show not-run state when a matching business/scope snapshot does not exist

Snapshot identity:

- business
- analysis scope: account or campaign
- benchmark scope: account or campaign
- benchmark scope id when campaign-scoped

Reporting dates are stored as context only and are not snapshot authority.

Policy/safety impact:

- no Creative segmentation retune
- no taxonomy change
- no Scale / Scale Review floor change
- no queue/push/apply safety change
- no Command Center safety change

Validation:

- targeted snapshot store/API/page/drawer tests passed
- full `npm test`
- `npm run build`
- `npx tsc --noEmit`
- `git diff --check`
- hidden/bidi/control scan
- raw ID scan on touched docs/reports
- runtime smoke on `/platforms/meta/creatives` and `/platforms/meta`

## Current PR

- PR: `https://github.com/erhanrdn/OmniAds/pull/65`
- title: `Implement Claude Creative segment recalibration plan`
- status: open; being readied for merge in the current integration pass
- merge status: not merged
- latest commit: media-buyer scoring engine update on PR #65 branch
- latest checks: server-side current-output artifact generation completed from PR commit `8eca958977378fb67fcb2dde45669b49f97d02f9`; local validation for the runtime-recovery changes is pending final rerun in this pass
- reason: merge requires current local static/test/build validation plus review that the live PR #74 Cut behavior and Creative v2 buyer preview surface are preserved

## Media Buyer Scoring Engine

Status: implemented locally on PR #65 branch.

Added:

- `lib/creative-media-buyer-scoring.ts`
- `lib/creative-media-buyer-scoring.test.ts`

The scorecard computes:

- relative performance class
- evidence maturity
- trend state
- efficiency risk
- winner signal
- loser signal
- context state
- business validation state
- recommended user-facing segment
- internal operator segment
- confidence
- reason tags
- blocked actions
- review-only status

Routing change:

- `assessCreativeOperatorPolicy()` builds the scorecard once.
- `resolveSegment()` now returns `mediaBuyerScorecard.operatorSegment`.
- The old policy helper logic remains for missing-evidence, required-evidence, reason, and safety surface computation.

Safety preserved:

- `Scale` floors were not changed.
- `Scale Review` remains review-only when business validation / Commercial Truth is missing.
- `Cut`, `Refresh`, and `Retest` remain operator-review outcomes.
- queue/push/apply safety was not loosened.
- benchmark scope behavior was not changed.
- old challenger remains comparison-only.

Audit helper update:

- `scripts/creative-live-firm-audit.ts` now emits sanitized scorecard summaries for each sampled row.
- the helper no longer performs a duplicate campaign/ad set source-snapshot read after Decision OS has already resolved delivery context.
- the helper writes `docs/operator-policy/creative-segmentation-recovery/reports/equal-segment-scoring/artifacts/pr65-current-output-fresh.json`.
- the helper records per-business source-read failures and can write a blocked current-output artifact instead of failing without an artifact.
- Decision OS source reads now scope campaign/ad set context to campaign IDs referenced by the primary Creative decision window.

Fresh live audit attempts:

Earlier score read:

- macro segment score: about `83/100`, not `86/100`
- raw row accuracy: about `83%`, not `90%`
- Watch score: `55/100`
- Refresh score: `73/100`
- Cut recall: below target because Cut-shaped rows were still hiding in Refresh
- pdf-company-01 context: about `80/100`
- pdf-company-02 context: about `82/100`

Local tunnel attempts:

- SSH tunnel to local `127.0.0.1:15432` was established.
- `scripts/creative-live-firm-audit.ts` was run with production DB URL rewritten to the tunnel.
- first runs hit DB query timeouts on Meta campaign/ad set context reads.
- after source-read hardening, reruns progressed farther but the SSH DB tunnel dropped or returned connection timeouts/refusals during discovery/evaluation.
- a fresh blocked artifact was written at `docs/operator-policy/creative-segmentation-recovery/reports/equal-segment-scoring/artifacts/pr65-current-output-fresh.json`.
- artifact status: `blocked`
- `valid_for_acceptance: false`
- `validForClaudeReview: false`
- runtime blockers: `discovery:db_tunnel_connection_refused`, `prior_live_run:db_tunnel_connection_timeout`, `prior_live_run:database_query_timeout_meta_campaign_adset_context`

Server-side runtime recovery:

- runtime path: temporary Docker worker image built on the app server from PR #65 commit `8eca958977378fb67fcb2dde45669b49f97d02f9`
- production services were not restarted or modified
- the audit used the production-equivalent environment path from the app server and avoided the local SSH Postgres tunnel
- current-output artifact: `docs/operator-policy/creative-segmentation-recovery/reports/equal-segment-scoring/artifacts/pr65-current-output-fresh.json`
- artifact status: `complete_current_output`
- `valid_for_claude_review: true`
- `valid_for_acceptance: false`
- reason acceptance remains false: artifact has fresh current outputs, but no fresh expected-label scoring
- readable businesses: `8`
- sampled creatives: `78`
- current segment counts: `Scale 0`, `Scale Review 1`, `Test More 6`, `Protect 6`, `Watch 10`, `Refresh 21`, `Retest 0`, `Cut 13`, `Campaign Check 0`, `Not Enough Data 16`, `Not eligible 5`

Current acceptance status:

- represented segment scores are not re-proven after the scoring engine pass.
- Creative Recovery is not accepted yet.
- Next recommended action is to run Claude/supervisor review against the valid fresh current-output artifact.

## PR #65 Scoring Runtime Recovery

Status: current-output artifact unblocked; acceptance scoring still not valid.

Chosen runtime path:

- server-side temporary Docker audit image built from the PR #65 branch
- production-equivalent app server environment
- no local SSH DB tunnel

Why:

- local tunnel runs repeatedly failed with DB query timeouts and tunnel drops
- server-side container execution completed the audit without runtime blockers

Artifact status:

- path: `docs/operator-policy/creative-segmentation-recovery/reports/equal-segment-scoring/artifacts/pr65-current-output-fresh.json`
- `artifactStatus: complete_current_output`
- `valid_for_claude_review: true`
- `valid_for_acceptance: false`

Fresh equal-segment scoring:

- not run
- stale expected labels were not used
- Claude should independently score from the fresh artifact

Merge status:

- PR #65 must remain unmerged until review/acceptance completes

Last updated by Codex: 2026-04-26

## PR #65 Fresh Scoring Unblock

Status: superseded by PR #65 scoring runtime recovery.

Root cause found:

- The original live audit path duplicated campaign/ad set context reads after Decision OS had already fetched source context.
- The core source path also read broad campaign/ad set context for the full business, which was too slow over the SSH tunnel.
- After narrowing those reads to referenced campaign IDs, the remaining local-tunnel blocker was SSH/DB tunnel stability, not a proven policy/scoring defect.
- This blocker was resolved for current-output artifact generation by running the audit in a server-side temporary Docker image.

What was fixed:

- audit active-status sampling now uses Decision OS delivery context.
- Decision OS campaign/ad set context reads are campaign-ID scoped from the primary Creative decision window.
- blocked current-output artifacts are persisted instead of silently missing.

Fresh acceptance scoring:

- not run
- no current scores are valid for acceptance
- Claude review may now run against the fresh current-output artifact, but PR #65 must not merge before review/acceptance

Last updated by Codex: 2026-04-26

## Fresh Baseline Audit

Current `main` at branch start was the PR #63 state:

- macro replay: `87/100`
- raw replay accuracy: `87%`
- Watch: `75/100`
- Refresh: `84/100`
- Protect: `83/100`
- Test More: `83/100`
- Not Enough Data: `88/100`
- Cut recall: about `92%`

A fresh live-firm audit was rerun on this branch after the Round 5 patch using the corrected current Decision OS path:

- readable businesses: `8`
- sampled creatives: `78`
- Scale: `0`
- Scale Review: `6`
- Test More: `7`
- Protect: `1`
- Watch: `10`
- Refresh: `23`
- Retest: `0`
- Cut: `12`
- Campaign Check: `0`
- Not Enough Data: `14`
- Not eligible for evaluation: `5`

The committed sanitized artifact was updated at:

- `docs/operator-policy/creative-segmentation-recovery/reports/live-firm-audit/artifacts/sanitized-live-firm-audit.json`

The local private artifact remains local-only:

- `/tmp/adsecute-creative-live-firm-audit-local.json`

## Claude Fix Plan Implementation

Implemented:

1. validating trend-collapse Refresh admission now accepts mature quarter-trend collapse (`7d / 30d <= 0.25`) while preserving the PR #63 low-evidence guard.
2. catastrophic CPA `fatigued_winner` / `refresh_replace` Cut behavior was verified and preserved.
3. mature one-purchase catastrophic CPA rows can now route from `Not Enough Data` to review-safe `Cut`.
4. stable protected winners now use tiered trend-collapse sensitivity:
   - mild above-baseline winners (`1.0x` to `<1.4x` benchmark) can route to `Refresh` at `<=0.50` trend ratio
   - stronger winners keep the stricter `<=0.40` trend ratio
5. thin-spend weak-ratio positives now remain `Not Enough Data` instead of `Test More`; strong-relative thin-spend positives can still become `Test More`.
6. high-relative non-test Watch false negatives can now route to review-only `Scale Review` when evidence is mature and no context blocker exists.
7. validating below-benchmark rows with zero recent ROAS and enough spend/purchase/impression evidence can now route from `Watch` to review-only `Refresh`.
8. PR #65 P1 hardening: high-relative non-test review candidates are excluded from true `Scale` intent / `scaleAction`, so favorable business validation cannot promote that review-only path into `scale_ready` or queue eligibility.
9. PR #65 P2 hardening: the new below-benchmark collapse Refresh gate now requires known creative age `>= 7` days, so unknown-age creatives stay conservative.
10. Protect/no-touch boundary fix: high-volume stable winners below active benchmark with elevated CPA now route to `Watch` instead of passive `Protect`, while explicit protected watchlist rows remain Protect.
11. Round 6 verification: the requested `company-08 / creative-10` validating below-benchmark collapse shape is already covered by `isValidatingBelowBaselineCollapseRefreshCandidate`.

Preserved / not changed:

- True `Scale` floors were not changed.
- Broad Scale Review floors were not changed; the new Watch fix is a narrow non-test high-relative floor with stronger evidence requirements.
- Queue/push/apply safety was not loosened.
- Benchmark scope remains explicit-only.
- Old challenger remains comparison-only.

## Score Status

Previous after-score claims are superseded by the PR #65 score reconciliation.

What is proven:

- the current committed live artifact has `company-08 / company-08-creative-10` as `Refresh`
- the current committed live artifact segment distribution is `Scale Review 6`, `Test More 7`, `Protect 1`, `Watch 10`, `Refresh 23`, `Cut 12`, `Not Enough Data 14`, and `Not eligible 5`
- severe CPA examples `company-03 / company-03-creative-01` and `company-07 / company-07-creative-01` are `Cut`

What is not proven:

- exact current macro score
- exact current Watch / Refresh / Protect scores
- exact current IwaStore / TheSwaf equal-segment scores

Reason: the only local equal-segment expected-label artifact predates the latest PR #65 commits and is not safe as the score of record. Joining that stale expected-label artifact to the current live artifact produces an intentionally invalid reconciliation score, not an acceptance score.

## Watch Floor Policy Fix

Status: fixed in deterministic replay.

- before this fix: `Watch` at `83/100`
- after this fix: `Watch` at `90/100`

Gate fixed:

- representative sanitized trace: `company-05 / company-05-creative-04`
- before outcome: `Watch`
- after outcome: `Scale Review`
- reason: the row has strong baseline-backed relative evidence, mature spend/purchase/impression depth, non-worse CPA, missing business validation, non-test context, and no primary campaign blocker

The fix remains review-only:

- missing Commercial Truth still blocks true `Scale`
- queue/apply remain false
- campaign-context blockers still become `Campaign Check`
- no-touch winners still become `Protect`
- PR #65 P1 review issue was real and fixed: this path is no longer part of true `scaleIntent` or `scaleAction`; even with favorable business validation and true-scale evidence it remains `Scale Review`, `operator_review_required`, and queue/apply blocked.

## Round 5 Equal-Segment Target Closure

Status: fixed for the clear Watch miss; followed by Protect boundary investigation.

Fixed gate:

- representative sanitized trace: `company-08 / company-08-creative-10`
- before outcome: `Watch`
- after outcome: `Refresh`
- reason: validating / keep-in-test row had ROAS around `0.37x` active benchmark, 7-day ROAS `0`, spend around `$378`, `2` purchases, meaningful impressions, and no campaign-context blocker

Gate added:

- `isValidatingBelowBaselineCollapseRefreshCandidate`
- admits only validating / keep-in-test rows at or below `0.40x` active benchmark with zero or collapsed recent ROAS, spend `>= 300`, purchases `>= 2`, impressions `>= 3000`, and known creative age `>= 7`
- stronger rows that meet existing Cut gates still route to `Cut`
- campaign-context blockers still route to `Campaign Check`

Surface alignment:

- the fixed row now has `Refresh` label, `Refresh` instruction headline, and Refresh-specific reason / next observation
- queue/apply remain false

## Round 6 Watch Edge Verification

Status: verified; no new policy change required.

Requested target:

- sanitized row: `company-08 / company-08-creative-10`
- before outcome in Claude review: `Watch`
- expected: `Refresh`, unless existing severe Cut gates apply
- evidence shape: validating / keep-in-test, ROAS about `0.37x` active benchmark, recent ROAS `0`, spend around `$378`, `2` purchases, no campaign-context blocker

Current branch behavior:

- `isValidatingBelowBaselineCollapseRefreshCandidate` already admits this shape
- policy segment: `needs_new_variant`
- user-facing outcome: `Refresh`
- queue/apply remain false

Score read:

- Watch remains about `90/100` after the Round 5 fix
- macro remains about `90/100` after Round 5 plus Protect boundary
- no segment score changed in this no-op verification pass

Reconciliation update:

- the row outcome remains `Refresh`
- the score estimate should not be treated as the score of record
- a fresh equal-segment review must score the current artifact directly

## Protect Boundary Investigation

Status: implemented in current branch.

Result:

- the issue was real as a narrow reviewed-set boundary
- sanitized reviewed row: `company-05 / company-05-creative-01`
- before: `Protect`
- expected: `Watch`
- gate responsible: unconditional `hold_no_touch` fallback to `protected_winner`
- fix: added a narrow below-benchmark high-CPA stable winner guard that routes to `hold_monitor` / Watch

Admission requires:

- lifecycle `stable_winner`
- primary action `hold_no_touch`
- not explicitly `protected_watchlist`
- reliable relative baseline
- spend at least `max(1000, 1.25x peer median spend)`
- mature purchase, impression, and creative-age evidence
- ROAS at or below `0.90x` active benchmark
- CPA at least `1.50x` peer median CPA
- no campaign/ad set blocker

Preserved:

- true protected watchlist rows remain Protect
- healthy above-benchmark no-touch winners remain Protect
- scale-worthy review-only rows remain Scale Review
- trend-collapse winners still route to Refresh only through existing trend gates
- queue/push/apply safety unchanged

Score read:

- Protect boundary behavior changed as documented
- exact current Protect score is not proven by a fresh scoring artifact
- pdf-company-01 remains unresolved as a score claim until the next fresh review

| Metric | Before | After |
|---|---:|---:|
| Macro segment score | `83/100` | `87/100` |
| Raw row accuracy | `83%` | `87%` |
| Watch score | `55/100` | `75/100` |
| Refresh score | `73/100` | `84/100` |
| Cut recall | `~77%` | `~92%` |
| pdf-company-01 context | `80/100` | `80/100` |
| pdf-company-02 context | `82/100` | `82/100` |

## PR #65 Score Reconciliation

Status: complete; no policy change made.

Artifacts:

- reconciliation report: `docs/operator-policy/creative-segmentation-recovery/reports/pr65-score-reconciliation/final.md`
- committed reconciliation artifact: `docs/operator-policy/creative-segmentation-recovery/reports/equal-segment-scoring/artifacts/pr65-current-equal-segment.json`
- local private copy: `/tmp/adsecute-pr65-current-equal-segment-local.json`

Answers:

- Claude reviewed stale data for `company-08 / creative-10`; current artifact says `Refresh`, not `Watch`
- STATE.md overclaimed acceptance-level scores; exact current per-segment scores are not regenerated
- the joined stale expected-label artifact is marked `not_valid_for_acceptance`
- another policy fix is not justified by the `company-08 / creative-10` dispute alone
- a future policy fix may still be needed if a fresh review of the current artifact confirms other high-spend validating Watch/Refresh/Cut boundaries remain wrong

## Validation

- targeted Creative policy tests: passed
- targeted Creative policy/surface/Decision OS/prescription tests: passed
- targeted Creative UI surface tests: passed
- targeted Command Center safety tests: passed
- full `npm test`: passed
- `npx tsc --noEmit`: passed
- `npm run build`: passed
- `/platforms/meta/creatives` localhost smoke: passed through expected auth redirect/load
- `/platforms/meta` localhost smoke: passed through expected auth redirect/load
- prior PR #65 `git diff --check`: passed before the current unstaged external-review edit
- hidden/bidi/control scan: passed
- raw ID scan on touched docs: passed
- touched-file `git diff --check`: passed
- full working-tree `git diff --check`: blocked by unstaged external-review trailing whitespace in `docs/external-reviews/creative-segmentation-recovery/equal-segment-review.md`; that file was already modified outside this pass and is not staged
- lint skipped: no `lint` script exists
- live-firm audit rerun attempt: blocked by production DB query timeout over the SSH tunnel (`DB query timed out after 8000ms`); no committed live-firm artifact changed
- Round 5 targeted policy/surface tests: passed
- Round 5 live-firm audit rerun: passed
- PR #65 P1 regression test for review-only non-test Scale Review: passed
- PR #65 P2 regression test for unknown-age below-benchmark collapse rows: passed
- Protect boundary policy tests: passed
- Round 6 Watch edge verification: passed; target fixture already resolves to Refresh
- equal-segment scoring audit: not rerun by script in this pass; no executable equal-segment scoring helper exists in the repo, and this pass made no policy change beyond verifying the existing Round 5 gate
- PR #65 scoring reconciliation artifact generated; marked `not_valid_for_acceptance` because it joins stale expected labels with the current live artifact

## Reports

- Claude fix plan implementation: `docs/operator-policy/creative-segmentation-recovery/reports/claude-fix-plan-implementation/final.md`
- Watch floor policy fix: `docs/operator-policy/creative-segmentation-recovery/reports/watch-floor-policy-fix/final.md`
- Round 5 target closure: `docs/operator-policy/creative-segmentation-recovery/reports/round-5-equal-segment-target-closure/final.md`
- Protect boundary investigation: `docs/operator-policy/creative-segmentation-recovery/reports/protect-boundary-investigation/final.md`
- Round 6 Watch edge verification: `docs/operator-policy/creative-segmentation-recovery/reports/round-6-watch-refresh-edge-fix/final.md`
- PR #65 score reconciliation: `docs/operator-policy/creative-segmentation-recovery/reports/pr65-score-reconciliation/final.md`
- Creative v2 buyer surface promotion: `docs/operator-policy/creative-segmentation-recovery/reports/v2-buyer-surface-promotion-2026-04-28/final.md`
- equal-segment scoring final: `docs/operator-policy/creative-segmentation-recovery/reports/equal-segment-scoring/final.md`
- per-segment scores: `docs/operator-policy/creative-segmentation-recovery/reports/equal-segment-scoring/per-segment-scores.md`
- confusion matrix: `docs/operator-policy/creative-segmentation-recovery/reports/equal-segment-scoring/confusion-matrix.md`
- sanitized live artifact: `docs/operator-policy/creative-segmentation-recovery/reports/live-firm-audit/artifacts/sanitized-live-firm-audit.json`
- PR #65 current equal-segment reconciliation artifact: `docs/operator-policy/creative-segmentation-recovery/reports/equal-segment-scoring/artifacts/pr65-current-equal-segment.json`

## Next Recommended Action

Complete the Creative v2 buyer surface promotion validation and deploy the exact
main SHA. Required checks for this pass: static tests, TypeScript, production
build, Creative v2 safety gate, no-write enforcement, request side-effect scan,
and authenticated Creative v2 smoke confirming default-visible, explicit opt-out
hidden, no forbidden wording, and no mutation requests.
