CHATGPT_REVIEW_READY: YES
ROLE: CODEX_EVIDENCE_RUNNER
BRANCH: review/creative-v2-operator-surface-contract-2026-04-26
HEAD_COMMIT: SEE_DRAFT_PR_BODY_CURRENT_HEAD
PRIMARY_REPORT_PATH: docs/operator-policy/creative-segmentation-recovery/reports/v2-operator-surface-contract-2026-04-26/
HANDOFF_FILE: docs/operator-policy/creative-segmentation-recovery/reports/v2-operator-surface-contract-2026-04-26/FOR_CHATGPT_REVIEW.md
SANITIZED: YES
PRODUCT_CODE_CHANGED: NO
MERGE_REQUESTED: NO
MAIN_PUSHED: NO

# Creative v2 Operator Surface Contract v0.1.1

Generated: 2026-04-26T14:40:33Z

This PR is report-only. It updates the Creative Operator Surface
contract from v0 to v0.1. It does not implement UI, API, queue,
apply, resolver, threshold, benchmark, or gold-label changes.

## v0.1 Correction: Direct Is Not Urgency

The v0 contract incorrectly treated `actionability == direct` as
the top buyer urgency bucket. That is not the right operator model.

In v2, `direct` is a confidence and safety axis. It means the resolver
sees fewer interpretation blockers. It does not mean the row is the
most urgent business decision.

Buyer urgency must prioritize:

- all Scale rows, including review-only Scale;
- high-spend Cut candidates, including review-only Cut;
- high-spend active Refresh or fatigue candidates;
- highest-risk current -> v2 decision changes;
- active severe loser, fatigue, or recent-collapse rows;
- then Protect, Test More, and direct-confidence rows.

This is why a review-only Scale or Cut row can appear above a direct
Protect or direct Test More row. The former has higher buyer urgency.
The latter only has cleaner actionability.

## Executive Summary

PR #79 remains useful as inventory. This update revises the surface
contract so the Creative page can become a buyer command surface rather
than a flat review table.

ChatGPT has accepted the v0.1 content direction, especially the
correction that direct is actionability confidence and not buyer urgency.
UI implementation remains blocked pending Claude's explicit review of
this v0.1 contract.

## v0.1.1 Micro-Fix: forbiddenButtonLanguage Parity

ChatGPT accepted the v0.1 contract direction and Claude's explicit
v0.1 review with one blocking contract issue: the Markdown forbidden
button list included three terms that were missing from
the machine-readable contract JSON.

The active v0.1.1 JSON path is:

`docs/operator-policy/creative-segmentation-recovery/reports/v2-operator-surface-contract-2026-04-26/surface-contract-v0.1.1.json`

The compatibility JSON path also contains the same list:

`docs/operator-policy/creative-segmentation-recovery/reports/v2-operator-surface-contract-2026-04-26/surface-contract-v0.1.json`

Both JSON files now use `contractVersion: v0.1.1`.

Added and verified in `forbiddenButtonLanguage`:

- `Auto-*`
- `Push live`
- `Push to review queue`

The exact JSON `forbiddenButtonLanguage` list is:

- `Apply`
- `Apply now`
- `Auto apply`
- `Auto-*`
- `Queue`
- `Queue now`
- `Push live`
- `Push to review queue`
- `Scale now`
- `Cut now`
- `Launch`
- `Budget increase`
- `Approve`
- `Accepted`
- `Direct scale`
- `Product-ready`

Markdown and JSON now match exactly for forbidden button language.

This addresses Claude's only blocking contract issue before read-only
UI preview implementation. No product code, UI, API, resolver,
Command Center, queue, apply, write behavior, thresholds, or gold labels
changed in this micro-fix.

The v2 live audit has 303 rows:

- 1 Scale
- 15 Cut
- 37 Refresh
- 17 Protect
- 40 Test More
- 193 Diagnose

Actionability distribution:

- 2 direct
- 108 review_only
- 193 diagnose

The revised surface model separates:

- urgency buckets: what a senior buyer should see first;
- actionability buckets: what the system is safe to do or not do;
- decision buckets: the resolver's recommended buyer action.

The default above-the-fold model should show a Today Priority command
strip first. It should not show "direct" rows as the top priority just
because they are direct.

## Source Inputs

- Current branch base: `origin/main` at `fa838df2be0a93c445680c42d23f4adadb52bd8f`.
- Resolver-only WIP source: `origin/wip/creative-decision-os-v2-baseline-first-2026-04-26`.
- PR #78 reviewed head from ChatGPT handoff: `3da2e05cb47f97de89ee42d9af6a64598af8b17a`.
- PR #78 substantive resolver fix from ChatGPT handoff: `10f5a94fa66f0501150376010d3ab4d0c7c16e3a`.
- Live audit artifact used for surface analysis:
  `docs/operator-policy/creative-segmentation-recovery/reports/v2-live-audit-2026-04-26/live-audit-sanitized.json`.
- Live safety artifact used for surface analysis:
  `docs/operator-policy/creative-segmentation-recovery/reports/v2-live-audit-2026-04-26/live-safety-summary.json`.
- Gold evaluation artifact used as context only:
  `docs/operator-policy/creative-segmentation-recovery/reports/v2-baseline-first-2026-04-26/gold-evaluation.json`.

## Current Creative Page Inventory

### Current Route And Main Files

- Route: `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx`
- Support: `app/(dashboard)/platforms/meta/platforms/meta/creatives/page-support.tsx`
- Top/header: `components/platforms/meta/creatives/CreativesTopSection.tsx`
- Table/grid: `components/platforms/meta/creatives/CreativesTableSection.tsx`
- Decision support: `components/platforms/meta/creatives/CreativeDecisionSupportSurface.tsx`
- Generic operator summary: `components/operator/OperatorSurfaceSummary.tsx`
- Decision drawer: `components/platforms/meta/creatives/CreativeDecisionOsDrawer.tsx`
- Drawer content: `components/platforms/meta/creatives/CreativeDecisionOsContent.tsx`
- Overview panels: `components/platforms/meta/creatives/CreativeDecisionOsOverview.tsx`
- Row/detail drawer: `components/platforms/meta/creatives/CreativeDetailExperience.tsx`

`app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx` owns the Creative workflow. It
loads creative rows, historical windows, ad-level breakdowns, the
current Creative Decision OS snapshot, table state, drawer state, quick
filters, and selected row state.

### Current API And Data Path

- `fetchMetaCreatives` calls `/api/meta/platforms/meta/creatives`.
- `fetchMetaCreativesHistory` calls `/api/meta/platforms/meta/creatives/history`.
- `/api/meta/platforms/meta/creatives` is implemented by `app/api/meta/platforms/meta/creatives/route.ts`.
- The Meta creative response is built through `lib/meta/platforms/meta/creatives-api.ts`.
- `getCreativeDecisionOsSnapshot` calls `/api/creatives/decision-os`.
- `runCreativeDecisionOsAnalysis` posts to `/api/creatives/decision-os`.
- `/api/creatives/decision-os` is implemented by `app/api/creatives/decision-os/route.ts`.

The page currently joins Meta creative rows, history, benchmark scope,
and the current decision snapshot on the client.

### Current Decision Fields Shown

Current v1 UI surfaces include:

- decision and segment family filters;
- quick filters from `buildCreativeQuickFilters`;
- operator surface model from `buildCreativeOperatorSurfaceModel`;
- drawer sections for recommendation, benchmark context, source,
  provenance, blockers, and supply planning;
- detail drawer fields for what to do, preview truth, evidence,
  metrics, and blockers.

The v2 preview must not replace the current v1 `creativeDecisionOs`
object or feed existing v1 queue/readiness language.

### Current Queue, Apply, And Action Wiring

No Creative page table button currently executes a v2 action. Existing
Creative page controls are navigation, filtering, selection, drawer
opening, analysis run, export/share, row open, and row breakdown.

Current v1 data structures include execution-related fields such as
`operatorPolicy.queueEligible`, `operatorPolicy.canApply`,
`pushReadiness`, and deployment or supply-plan fields. Command Center
code also consumes Creative Decision OS output for work-item generation.

The v2 preview must not feed Command Center, queue, apply, or work-item
generation.

### Current Feature Flag And Preview Patterns

- `lib/creative-decision-os-config.ts` contains `CREATIVE_DECISION_OS_V1`.
- `lib/creative-decision-os-config.ts` supports `CREATIVE_DECISION_OS_CANARY_BUSINESSES`.
- Current Creative API/page paths already use explicit debug and preview
  query params for media mode, preview debugging, thumbnail debugging,
  snapshot bypass, and snapshot warming.

A future implementation can add a separate v2 preview flag and canary
list. This report does not add those flags.

### Safe Future Injection Point

The safest future injection point is a separate read-only v2 preview
payload fetched alongside the current Creative page data.

The v2 preview should:

1. load after current creative rows, history, benchmark scope, and v1
   snapshot are available;
2. join to visible rows by sanitized row keys and available campaign,
   adset, ad, and creative identifiers;
3. render in a separate preview surface;
4. avoid replacing the v1 `creativeDecisionOs` object;
5. avoid Command Center, queue, apply, and v1 quick-filter wiring.

Candidate future shape:

- endpoint: `GET /api/creatives/decision-os-v2/preview`
- response field: `decisionOsV2Preview`
- client state: `creativeDecisionOsV2Preview`
- component: `CreativeDecisionOsV2PreviewSurface`
- behavior: read-only preview only

## Before / After Bucket Model

### v0 Model Defect

v0 defined "Act Now / Direct candidates" as `actionability == direct`.
That made the two direct rows look like the highest buyer priority.

That is wrong because the direct rows in the live audit are one Protect
row and one Test More row. They are not more urgent than the review-only
Scale row, critical Cut rows, or high-spend Refresh/fatigue rows.

### v0.1 Model

v0.1 uses three separate axes.

Urgency tells the buyer what to inspect first:

- Today Priority / Buyer Command Strip
- Inactive Review
- secondary decision queues

Actionability tells the buyer what the system is safe to do:

- Ready for Buyer Confirmation
- Buyer Review
- Diagnose First
- Blocked

Decision buckets tell the buyer the recommended direction:

- Scale Review Required
- Cut Review Required
- Refresh Review
- Protect Hold Review
- Test More Review
- Diagnose First

## Top-Level Urgency Model

### A. Today Priority / Buyer Command Strip

Criteria:

- all Scale rows, even review-only;
- Cut rows with high spend, high risk, critical risk, or confirmed
  severe-loser evidence;
- active Refresh rows with high spend, fatigue, recent decay, recent
  collapse, or below-benchmark conversion evidence;
- high-risk current -> v2 decision changes;
- active severe loser, fatigue, or recent-collapse rows;
- inactive rows only when spend or risk is high enough to override the
  default collapsed inactive treatment.

Purpose:

- show the rows a senior buyer should notice within five seconds;
- route each row to its underlying decision bucket for details;
- keep queue/apply disabled.

Live-audit count under this proposed rule: 69 rows.

### B. Ready For Buyer Confirmation

Criteria:

- `actionability == direct`

Purpose:

- confidence signal only;
- no Apply button;
- no Queue button;
- not automatically above Scale, Cut, active Refresh, or high-risk
  decision-change urgency.

Live-audit count: 2 rows.

### C. Buyer Review

Criteria:

- `actionability == review_only`

Internal split:

- Scale Review Required: 1 row
- Cut Review Required: 15 rows
- Refresh Review: 37 rows
- Protect Hold Review: 16 rows
- Test More Review: 39 rows

Live-audit total: 108 rows.

### D. Diagnose First

Criteria:

- `primaryDecision == Diagnose`
- or `actionability == diagnose`

Behavior:

- collapsed by default;
- grouped by blocker or problem class;
- high-spend and high-risk Diagnose rows may also appear in Today
  Priority, but their detail route remains Diagnose First;
- no action buttons.

Live-audit count: 193 rows.

### E. Inactive Review

Criteria:

- inactive rows whose primary decision is Refresh, Diagnose, Cut,
  Protect, or Test More.

Behavior:

- collapsed by default;
- high-spend or high-risk inactive rows can be promoted into Today
  Priority while still showing the inactive context;
- the row must clearly explain whether the buyer problem is creative
  refresh, campaign/status diagnosis, confirmed loser review, or hold.

Live-audit count: 70 rows.

## Default Above-The-Fold Model

The first viewport should show:

1. Today Priority count and top rows.
2. The one Scale candidate, even though it is review-only.
3. Critical/high Cut candidates by spend.
4. Active Refresh/fatigue candidates by spend and risk.
5. Highest-risk current -> v2 decision changes.
6. Diagnose First count, grouped and collapsed.
7. Ready for Buyer Confirmation count as a secondary safety rail.
8. Preview safety state: queue disabled, apply disabled.

This prevents the page from becoming a flat panel of 108 review rows and
193 diagnose rows.

## Field Mapping Contract

- `primaryDecision`
  - UI placement: primary decision badge and decision bucket.
  - Behavior: display Scale, Cut, Refresh, Protect, Test More, or
    Diagnose. Never display Watch or Scale Review.

- `actionability`
  - UI placement: safety badge and actionability queue.
  - Behavior: direct is confidence/safety, not urgency.

- `confidence`
  - UI placement: secondary score or band.
  - Behavior: use for context and sorting. Do not unlock actions by
    itself.

- `reasonTags`
  - UI placement: 2 to 3 visible chips.
  - Behavior: use buyer-readable tags; collapse overflow.

- `evidenceSummary`
  - UI placement: row "why" and drawer detail.
  - Behavior: product-safe language only.

- `riskLevel`
  - UI placement: risk badge and sort key.
  - Behavior: critical and high risk sort above medium and low.

- `queueEligible`
  - UI placement: preview safety indicator.
  - Behavior: queue remains disabled in v2 preview.

- `applyEligible`
  - UI placement: preview safety indicator.
  - Behavior: apply remains disabled in v2 preview.

- `blockerReasons`
  - UI placement: blocker badge and Diagnose grouping.
  - Behavior: first blocker visible; full list in drawer.

- `secondarySuggestion`
  - UI placement: drawer-only next step.
  - Behavior: informational only; never an action button.

## Sorting Rules

### Today Priority

1. Scale rows.
2. Critical/high Cut rows by spend.
3. High-spend active Refresh/fatigue rows.
4. Highest-risk current -> v2 changes.
5. Active recent-collapse rows.
6. High-spend/high-risk inactive exceptions.
7. Direct-confidence Protect/Test More rows.

### Buyer Review

1. Decision urgency: Scale, Cut, Refresh, Protect, Test More.
2. Risk level: critical, high, medium, low.
3. Spend descending.
4. Current-vs-v2 decision changed before unchanged.
5. Confidence descending.

### Diagnose First

1. High spend or high risk exceptions.
2. Blocker or problem class.
3. Spend descending.
4. Recent conversion stop or source-trust ambiguity.
5. Confidence descending.

### Inactive Review

1. High spend or high risk exceptions.
2. Decision: Cut, Refresh, Diagnose, Protect, Test More.
3. Spend descending.
4. Confidence descending.

## Filter Rules

Required filters:

- urgency bucket;
- decision;
- actionability;
- risk;
- changed from current decision;
- active state;
- inactive-only;
- spend band;
- benchmark relationship;
- recent trend;
- blocker present;
- source/campaign trust;
- preview queue/apply state.

## Button Policy

Allowed button or link language:

- Review
- Open review
- Review required
- Investigate
- Mark investigated
- See blocker
- View diagnosis
- Compare evidence
- Open detail
- Open current setup
- Copy row ID
- Mark reviewed
- Ready for buyer confirmation
- No action

Forbidden button or link language:

- Apply
- Apply now
- Auto apply
- Auto-*
- Queue
- Queue now
- Push live
- Push to review queue
- Scale now
- Cut now
- Launch
- Budget increase
- Approve
- Accepted
- Direct scale
- Product-ready

Direct rows may show "Ready for buyer confirmation". They must not
show "Apply" or "Queue".

"Push to review queue" should be avoided in the read-only preview phase
unless a later implementation proves it is purely local, non-writing,
and explicitly safe. The safer default copy is "Review", "Open detail",
"Mark reviewed", "Investigate", "Mark investigated", or "See blocker".

## Safety Invariants

- Queue/apply buttons remain disabled for v2 preview.
- Direct Scale remains non-apply unless explicitly approved later.
- Cut direct must not be auto-applied in preview.
- Diagnose rows must not show action buttons.
- `review_only` rows must show "Review required", not "Apply".
- `blocked` rows must show why blocked before any buyer action.
- v2 preview must not write to queue/apply state.
- v2 preview must not create Command Center work items.
- v2 preview must not replace the current v1 `creativeDecisionOs` object.

## Live Audit Distribution Used

Rows audited: 303

Businesses/accounts audited: 8 businesses / 9 accounts

| Decision | Rows |
| --- | ---: |
| Diagnose | 193 |
| Test More | 40 |
| Refresh | 37 |
| Protect | 17 |
| Cut | 15 |
| Scale | 1 |

| Actionability | Rows |
| --- | ---: |
| diagnose | 193 |
| review_only | 108 |
| direct | 2 |

| Safety counter | Rows |
| --- | ---: |
| direct Scale | 0 |
| inactive direct Scale | 0 |
| queueEligible true | 0 |
| applyEligible true | 0 |
| Watch primary | 0 |
| Scale Review primary | 0 |
| direct action despite source/campaign blockers | 0 |
| Test More direct on degraded/data-quality risk | 0 |
| Protect despite recent severe decay | 0 |

## Top 20 Highest-Spend Placement

1. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-05|company-05-creative-46`
   - Spend: 124046.89
   - Current -> v2: Refresh -> Refresh
   - Placement: Today Priority + Inactive Review + Refresh Review

2. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-06|company-05-creative-47`
   - Spend: 61027.88
   - Current -> v2: Protect -> Refresh
   - Placement: Today Priority + Inactive Review + Refresh Review

3. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-07|company-05-creative-48`
   - Spend: 57588.45
   - Current -> v2: Refresh -> Cut
   - Placement: Today Priority + Inactive Review + Cut Review Required

4. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-05|company-05-creative-49`
   - Spend: 33858.47
   - Current -> v2: Protect -> Refresh
   - Placement: Today Priority + Inactive Review + Refresh Review

5. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-06|company-05-creative-50`
   - Spend: 33045.48
   - Current -> v2: Cut -> Diagnose
   - Placement: Today Priority + Inactive Review + Diagnose First

6. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-05|company-05-creative-51`
   - Spend: 29265.56
   - Current -> v2: Protect -> Refresh
   - Placement: Today Priority + Inactive Review + Refresh Review

7. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-05|company-05-creative-52`
   - Spend: 28450.98
   - Current -> v2: Refresh -> Diagnose
   - Placement: Today Priority + Inactive Review + Diagnose First

8. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-05|company-05-creative-53`
   - Spend: 26077.54
   - Current -> v2: Refresh -> Refresh
   - Placement: Today Priority + Inactive Review + Refresh Review

9. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-05|company-05-creative-54`
   - Spend: 25506.30
   - Current -> v2: Diagnose -> Cut
   - Placement: Today Priority + Inactive Review + Cut Review Required

10. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-06|company-05-creative-55`
    - Spend: 23522.86
    - Current -> v2: Diagnose -> Refresh
    - Placement: Today Priority + Inactive Review + Refresh Review

11. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-05|company-05-creative-56`
    - Spend: 16255.87
    - Current -> v2: Protect -> Refresh
    - Placement: Today Priority + Inactive Review + Refresh Review

12. `company-05|company-05-account-01|company-05-campaign-01|company-05-adset-01|company-05-creative-01`
    - Spend: 13373.07
    - Current -> v2: Protect -> Protect
    - Placement: Protect Hold Review

13. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-07|company-05-creative-57`
    - Spend: 12644.77
    - Current -> v2: Cut -> Cut
    - Placement: Today Priority + Inactive Review + Cut Review Required

14. `company-05|company-05-account-01|company-05-campaign-02|company-05-adset-01|company-05-creative-02`
    - Spend: 10118.73
    - Current -> v2: Protect -> Scale
    - Placement: Today Priority + Scale Review Required

15. `company-05|company-05-account-01|company-05-campaign-03|company-05-adset-02|company-05-creative-03`
    - Spend: 10022.46
    - Current -> v2: Cut -> Cut
    - Placement: Today Priority + Cut Review Required

16. `company-05|company-05-account-01|company-05-campaign-03|company-05-adset-02|company-05-creative-04`
    - Spend: 8765.22
    - Current -> v2: Diagnose -> Protect
    - Placement: Protect Hold Review

17. `company-08|company-08-account-01|company-08-campaign-01|company-08-adset-01|company-08-creative-01`
    - Spend: 8295.35
    - Current -> v2: Cut -> Refresh
    - Placement: Today Priority + Refresh Review

18. `company-05|company-05-account-01|company-05-campaign-04|company-05-adset-03|company-05-creative-05`
    - Spend: 6991.75
    - Current -> v2: Diagnose -> Test More
    - Placement: Test More Review

19. `company-05|company-05-account-01|company-05-campaign-03|company-05-adset-02|company-05-creative-06`
    - Spend: 6686.77
    - Current -> v2: Cut -> Cut
    - Placement: Today Priority + Cut Review Required

20. `company-05|company-05-account-01|company-05-campaign-05|company-05-adset-04|company-05-creative-07`
    - Spend: 6314.72
    - Current -> v2: Cut -> Cut
    - Placement: Today Priority + Cut Review Required

## Top 20 Highest-Risk Decision-Change Placement

1. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-07|company-05-creative-48`
   - Spend: 57588.45
   - Current -> v2: Refresh -> Cut
   - Placement: Today Priority + Inactive Review + Cut Review Required

2. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-05|company-05-creative-54`
   - Spend: 25506.30
   - Current -> v2: Diagnose -> Cut
   - Placement: Today Priority + Inactive Review + Cut Review Required

3. `company-05|company-05-account-01|company-05-campaign-02|company-05-adset-01|company-05-creative-02`
   - Spend: 10118.73
   - Current -> v2: Protect -> Scale
   - Placement: Today Priority + Scale Review Required

4. `company-08|company-08-account-01|company-08-campaign-01|company-08-adset-01|company-08-creative-01`
   - Spend: 8295.35
   - Current -> v2: Cut -> Refresh
   - Placement: Today Priority + Refresh Review

5. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-07|company-05-creative-58`
   - Spend: 5025.29
   - Current -> v2: Diagnose -> Cut
   - Placement: Today Priority + Inactive Review + Cut Review Required

6. `company-08|company-08-account-02|company-08-campaign-02|company-08-adset-02|company-08-creative-02`
   - Spend: 4365.02
   - Current -> v2: Cut -> Refresh
   - Placement: Today Priority + Refresh Review

7. `company-06|company-06-account-01|company-06-campaign-01|company-06-adset-01|company-06-creative-01`
   - Spend: 1701.51
   - Current -> v2: Cut -> Refresh
   - Placement: Today Priority + Refresh Review

8. `company-01|company-01-account-01|company-01-campaign-02|company-01-adset-02|company-01-creative-02`
   - Spend: 833.63
   - Current -> v2: Test More -> Refresh
   - Placement: Today Priority + Refresh Review

9. `company-04|company-04-account-01|company-04-campaign-08|company-04-adset-05|company-04-creative-17`
   - Spend: 286.87
   - Current -> v2: Diagnose -> Cut
   - Placement: Today Priority + Inactive Review + Cut Review Required

10. `company-04|company-04-account-01|company-04-campaign-01|company-04-adset-01|company-04-creative-02`
    - Spend: 151.25
    - Current -> v2: Diagnose -> Refresh
    - Placement: Today Priority + Refresh Review

11. `company-03|company-03-account-01|company-03-campaign-01|company-03-adset-01|company-03-creative-05`
    - Spend: 132.06
    - Current -> v2: Diagnose -> Refresh
    - Placement: Today Priority + Refresh Review

12. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-05|company-05-creative-52`
    - Spend: 28450.98
    - Current -> v2: Refresh -> Diagnose
    - Placement: Today Priority + Inactive Review + Diagnose First

13. `company-01|company-01-account-01|company-01-campaign-04|company-01-adset-07|company-01-creative-27`
    - Spend: 983.91
    - Current -> v2: Refresh -> Diagnose
    - Placement: Today Priority + Inactive Review + Diagnose First

14. `company-07|company-07-account-01|company-07-campaign-01|company-07-adset-01|company-07-creative-07`
    - Spend: 277.11
    - Current -> v2: Refresh -> Diagnose
    - Placement: Today Priority + Diagnose First

15. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-06|company-05-creative-47`
    - Spend: 61027.88
    - Current -> v2: Protect -> Refresh
    - Placement: Today Priority + Inactive Review + Refresh Review

16. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-05|company-05-creative-49`
    - Spend: 33858.47
    - Current -> v2: Protect -> Refresh
    - Placement: Today Priority + Inactive Review + Refresh Review

17. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-05|company-05-creative-51`
    - Spend: 29265.56
    - Current -> v2: Protect -> Refresh
    - Placement: Today Priority + Inactive Review + Refresh Review

18. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-06|company-05-creative-55`
    - Spend: 23522.86
    - Current -> v2: Diagnose -> Refresh
    - Placement: Today Priority + Inactive Review + Refresh Review

19. `company-05|company-05-account-01|company-05-campaign-06|company-05-adset-05|company-05-creative-56`
    - Spend: 16255.87
    - Current -> v2: Protect -> Refresh
    - Placement: Today Priority + Inactive Review + Refresh Review

20. `company-05|company-05-account-01|company-05-campaign-04|company-05-adset-03|company-05-creative-05`
    - Spend: 6991.75
    - Current -> v2: Diagnose -> Test More
    - Placement: Test More Review

## How v0.1 Prevents A Review Wall

The page should not default to all 303 rows. It should default to the
Today Priority command strip and a Buyer Review queue split by decision.

The 108 review-only rows become useful because they are split into:

- Scale Review Required: 1
- Cut Review Required: 15
- Refresh Review: 37
- Protect Hold Review: 16
- Test More Review: 39

The 193 Diagnose rows become useful because they are collapsed by
default and grouped by blocker or problem class. High-spend and
high-risk Diagnose rows can still be promoted to Today Priority so the
buyer does not miss expensive ambiguity.

The 2 direct rows are displayed in a secondary "Ready for Buyer
Confirmation" rail. They do not outrank review-only Scale, critical Cut,
or high-spend Refresh rows.

## Output Files

- `docs/operator-policy/creative-segmentation-recovery/reports/v2-operator-surface-contract-2026-04-26/FOR_CHATGPT_REVIEW.md`
- `docs/operator-policy/creative-segmentation-recovery/reports/v2-operator-surface-contract-2026-04-26/surface-contract-v0.1.1.json`
- `docs/operator-policy/creative-segmentation-recovery/reports/v2-operator-surface-contract-2026-04-26/surface-contract-v0.1.json`

`surface-contract-v0.1.1.json` is the active contract. The older
`surface-contract-v0.1.json` path is retained as a compatibility copy,
but it also has `contractVersion: v0.1.1` and the same
`forbiddenButtonLanguage` list.

## Commands Run

```bash
git status --short --branch
git rev-parse HEAD
git branch --show-current
gh --version
gh auth status
LC_ALL=C grep -RIn "[^[:print:][:space:]]" \
  docs/operator-policy/creative-segmentation-recovery/reports/v2-operator-surface-contract-2026-04-26
LC_ALL=C grep -RIn "[^ -~]" \
  docs/operator-policy/creative-segmentation-recovery/reports/v2-operator-surface-contract-2026-04-26
git show origin/wip/creative-decision-os-v2-baseline-first-2026-04-26:\
docs/operator-policy/creative-segmentation-recovery/reports/\
v2-live-audit-2026-04-26/live-audit-sanitized.json
jq . \
  docs/operator-policy/creative-segmentation-recovery/reports/v2-operator-surface-contract-2026-04-26/surface-contract-v0.1.1.json
node -e "JSON.parse(require('fs').readFileSync(\
'docs/operator-policy/creative-segmentation-recovery/reports/v2-operator-surface-contract-2026-04-26/surface-contract-v0.1.1.json',\
'utf8')); console.log('json ok')"
node -e "const p='docs/operator-policy/creative-segmentation-recovery/reports/v2-operator-surface-contract-2026-04-26/surface-contract-v0.1.1.json';\
const j=JSON.parse(require('fs').readFileSync(p,'utf8'));\
for (const term of ['Auto-*','Push live','Push to review queue']) {\
if (!j.forbiddenButtonLanguage.includes(term)) process.exit(1);\
} console.log('forbidden terms ok')"
grep -RIn "Auto-\\*\\|Push live\\|Push to review queue" \
  docs/operator-policy/creative-segmentation-recovery/reports/v2-operator-surface-contract-2026-04-26
git diff --check
awk 'length($0)>160 {print FILENAME ":" FNR ":" length($0)}' \
  docs/operator-policy/creative-segmentation-recovery/reports/v2-operator-surface-contract-2026-04-26/FOR_CHATGPT_REVIEW.md \
  docs/operator-policy/creative-segmentation-recovery/reports/v2-operator-surface-contract-2026-04-26/surface-contract-v0.1.1.json
find \
  docs/operator-policy/creative-segmentation-recovery/reports/v2-operator-surface-contract-2026-04-26 \
  \( -name '.env' -o -name '*.env' -o -name '*c[o]okie*' \
  -o -name '*t[o]ken*' -o -name '*s[e]cret*' -o -name '*tmp*' \) \
  -print
```

Additional Node scans were run over the report folder for hidden,
bidirectional, and control characters, and for secret/raw-ID patterns.

`gh auth status` reported:

```text
You are not logged into any GitHub hosts. To log in, run: gh auth login
```

The GitHub connector was used for PR body updates because local `gh` is
not authenticated.

Product tests were not run because this PR changes only sanitized report
artifacts and no product code.

## Hygiene Addendum

Local validation completed before push:

- JSON parse check for `surface-contract-v0.1.1.json`: passed
- grep/find check for `Auto-*`, `Push live`, and
  `Push to review queue`: passed
- JSON pretty-format with `jq`: passed
- normal line-break check: passed; no active report lines exceed 160
  characters
- `git diff --check`: passed
- hidden/bidi/control scan: passed
- strict non-ASCII scan: passed
- restricted filename scan: passed
- secret/raw-ID scan: passed

The previous local scan did not reproduce the GitHub warning. For v0.1,
the active files were rewritten as ASCII-only report files, the old v0
JSON was removed, and strict scans confirmed no hidden, bidirectional,
control, or non-ASCII characters remain in the report folder.

GitHub warning status:

- Active files are clean.
- Exact active file/line/codepoint remaining: none found.
- The current branch raw files were inspected from GitHub after push.
  They match the pushed branch head and have normal line breaks:
  - `FOR_CHATGPT_REVIEW.md`: 836 lines
  - `surface-contract-v0.1.1.json`: 662 lines
  - `surface-contract-v0.1.json`: 662 lines
- The active GitHub raw files have no strict non-ASCII matches and no
  lines over 160 characters.
- The active branch blob views were also opened. No exact active warning
  codepoint was visible in the active report files.
- If the PR conversation still shows a hidden/bidirectional Unicode
  warning, this is historical/stale PR rendering or conversation-level
  state from earlier generated files, not a reproducible character in
  the active branch files.

## Confirmations

- No product code changed.
- No resolver logic changed.
- No thresholds changed.
- No gold labels changed.
- No UI/API/queue/apply integration was added.
- No queue/apply behavior was loosened.
- Artifacts use sanitized IDs only.
- No private credentials, `.env` files, browser storage artifacts, DB URLs,
  raw customer names, raw creative names, private screenshots, or private
  tmp artifacts are included.
