# Adsecute Meta Operating System - Codex Independent Study

Date: 2026-07-10
Status: Independent product, media-buying, decision-science, safety, interaction, accessibility, and architecture ruling
Scope: Authenticated Meta product surfaces. Global `/overview`, public marketing pages, and an AI copilot are excluded.

## Executive Ruling

Adsecute should be designed as a Meta media-buying operating system, not as an analytics dashboard. Its operating loop is:

`scope -> prioritized work -> evidence -> approval/preflight -> provider result -> monitoring -> outcome -> history`

The first shippable product level is Stage B: an approval-based decision and execution assistant. Stages C and D may be shown as an earned maturity path, but their controls must remain visibly locked until server-side authority, calibration, safety, and outcome gates exist.

The current decision engines remain the mathematical foundation. The redesign must not add a third decision engine, let the browser infer a buyer action, or destructively rename raw/versioned labels. The missing layer is a canonical, versioned classification and workflow contract around the existing engines.

Three proposed shortcuts are rejected:

1. Campaign membership alone does not make creatives comparable.
2. A relative test winner below business economics does not jump directly from Test to an unrestricted Main state.
3. Existing campaign/ad-set and creative priority heuristics cannot be merged into one numeric rank.

Until common calibration exists, Act Now shows separate `Entity actions` and `Creative actions` groups. This is less visually elegant than a single list, but it is mathematically honest.

## Verified Product Gaps

### Decision truth and scope

- The UI currently says a date range scopes metrics rather than decisions, while the Meta snapshot read selects the latest snapshot inside that range. `metricWindow` and `decisionSnapshot` must become separate contracts. Historical Replay must be an explicit mode.
- A business can map to multiple Meta accounts, but several reads implicitly select one account. Every Meta surface needs an explicit, globally selected `providerAccountId`; account identity must persist through decisions, assets, Launchpad, automation, receipts, and history.
- The current campaign/ad-set and creative engines publish different action and priority semantics. They are not cross-grain comparable.
- Current aggregations can coerce absent values into numeric zero. A missing signal must be typed and rendered as missing.
- Current creative hydration/presentation can lose or merge placement-parent identity. A creative asset and each executable provider placement need separate stable identities.

### Write and authority truth

- Current roles are too coarse for Viewer, Analyst, Operator, and Admin authority.
- Automation modes are persisted posture settings; they are not complete execution authority. The current UI must not call configured defaults "server-enforced" when the provider write path does not enforce all of them.
- Current provider actions lack an immutable execution plan, plan-bound single-use approval, fresh preflight lease, durable idempotency reservation, append-only receipt, and ambiguous-outcome reconciliation.
- A kill switch must be checked at admission and immediately before every provider mutation. A failed control-plane read must fail closed.
- Provider success, compensation, rollback, and financial outcome are different claims. None may be inferred from request acceptance.

### Product workflow truth

- History is not an entity archive. It is an immutable decision journal with transitions, human responses, execution attempts, verification, rollback, confounders, and outcome windows.
- Creative Studio has useful analysis surfaces but no complete durable asset lineage, approved-brief contract, or safe creator-share publication model.
- Launchpad can support PAUSED creation, but an ACTIVE outcome requires staged activation after all child objects have been created PAUSED and verified.
- Mobile currently cannot support the requested low-risk approval contract without a server-issued eligibility and fresh preflight result.

## Binding Product Architecture

### Global Meta navigation

The authenticated Meta workspace has four primary destinations:

1. `Decisions`
2. `Creative Studio`
3. `Launchpad`
4. `Automation`

Global account selection, search, notifications, and user controls live in the application shell. A second business selector inside Decisions is prohibited.

### Decisions

Decisions contains three operational views:

- `Act Now`: work that has sufficient evidence and requires a decision.
- `Monitor`: work that is intentionally waiting, incomplete, newly applied, learning, stale, or blocked by missing/conflicting evidence.
- `History`: the decision and execution journal.

Act Now opens on every visit. A selected account and latest decision snapshot are explicit. Display filters never change decision authority; changing an evaluation scope creates a new versioned snapshot.

Until a common priority contract passes calibration, Act Now has two separately ranked groups:

- `Entity actions`: account, campaign, and ad-set actions from the Meta recommendation engine.
- `Creative actions`: creative actions from Creative Decision Engine V3.

Safety, policy, delivery, and tracking blockers may be pinned above both groups because they gate downstream actions; this does not fabricate a shared performance score.

### Decision inspector

Every decision opens the same persistent evidence inspector. Its order is:

1. Recommended action and affected provider scope
2. Verified facts and source/as-of labels
3. Assessment, economics status, confidence, maturity, and risk
4. Base/upside/downside impact, or an explicit `Cannot calculate`
5. Risk of inaction
6. Missing, stale, or conflicting evidence
7. Formula/provenance and raw engine output
8. Assignment, comments, workflow status, and disposition
9. Preflight and action controls
10. Provider permalink when it is verified

Opening the inspector changes a wide layout from two decision columns to one decision column plus a 420-460px inspector. It must not trap focus as though it were a modal on wide screens.

### Monitor

Monitor is a compact grouped list rather than a card wall. Every row answers:

- What is waiting?
- Why is it waiting?
- Which signal is missing or immature?
- What decision is blocked?
- When or under which condition will it be reevaluated?
- Who owns it and what is its workflow state?

Groups include insufficient evidence, newly applied, learning/pacing, fatigue, tracking/data, policy/delivery, and emerging risk.

### History and Decision Lab

History is cursor-paginated and virtualized for at least 1,500 events. It records:

- computed and published decisions;
- raw/classified label transitions;
- Defer, Reject, Override, Approve, and structured reasons;
- preflight and provider execution attempts;
- verified, partial, failed, ambiguous, and compensation outcomes;
- actor, source, before/intended/observed state, audit ID, and provider trace;
- 1/3/7/14-day outcome slots and confounding-event annotations.

Decision Lab is a separate non-live surface reached from History. It supports historical replay, threshold scenarios, engine/config diffs, and deterministic comparison. It never mutates live formulas or provider state.

### Creative Studio

Creative Studio is analysis-first and visual-first. Its stable sections are:

- `Assets`
- `Copy`
- `Landing Pages`
- `Briefs`
- `Shares`

Assets defaults to a fixed-ratio, virtualized gallery. A table is a secondary deep-analysis mode. Both share a saved scope, filters, and selected metrics. The Studio must support current and historical winners across 7/28/90/all-time windows, while clearly distinguishing observed performance, comparative assessment, and economic readiness.

An asset is not reduced to one parent. The asset view shows all placements; an executable action always targets one explicit account and provider entity.

Briefs are created from a family/cohort or reviewed diagnosis, not from a row-level generated `brief_variation`. Approved briefs hand off to Launchpad through a stored launch intent.

Creator sharing is a publication workflow:

- server-hydrated immutable share snapshot;
- revocable, expiring, asset-scoped link;
- financial metrics off by default and controlled by permission;
- draft/review/publish status;
- reviewed feedback structured as Keep, Change, and Next deliverable;
- access/open ledger and revision history.

### Launchpad

Launchpad supports four entry points:

- `From decision`
- `From brief`
- `New campaign`
- `Manage existing`

A recommendation handoff consumes a stored, account-bound `LaunchIntent`, not a URL containing only a creative ID.

Desktop composition is a step rail, flexible editor, and sticky summary/preflight pane. Final commands are `Save draft`, `Create PAUSED`, and `Publish ACTIVE`.

`Create PAUSED` is the default and must state that it changes Meta provider state but cannot begin delivery.

`Publish ACTIVE` represents a desired final state, not raw ACTIVE hierarchy creation. The executor must:

1. create every object PAUSED;
2. verify every created child and relationship;
3. activate ads and ad sets while the campaign remains PAUSED;
4. activate the campaign last;
5. stop on drift, kill-switch engagement, or ambiguous provider outcome.

Until that executor exists, ACTIVE can be designed as a preview-only flow and must be visibly unavailable for real execution.

### Automation

Automation has one row per action class with exactly four modes:

- `Observe`
- `Recommend`
- `Approval Required`
- `Auto-execute`

The UI separates configured preference from effective server authority. Each row shows evidence gates, risk ceiling, exceptions, current capability, last change, next review, and demotion state.

`effectiveAuthority = min(configuredMode, businessCeiling, actionReadiness, riskCeiling, systemHealth)`

Stage B exposes Observe, Recommend, and Approval Required where supported. Auto-execute is locked. Promotion is proposed by the system after evidence gates pass and is approved by the user. High-impact or hard-to-reverse R4 actions remain approval-gated at every maturity stage.

## Canonical Classification

Raw/versioned engine output is preserved. The user-facing classifier adds orthogonal dimensions.

### Creative Stage

- `Test`
- `Validation`
- `Main`
- `Exited`

This is not the existing creative engine's performance trajectory.

### Comparative Assessment

- `Relative Winner`
- `Underperformer`
- `Uncertain`
- `Not Comparable`

`Uncertain` means a valid comparison exists but separation is insufficient. `Not Comparable` means no valid comparison exists.

### Economics Status

- `Meets Target`
- `Above Break-even`
- `Below Break-even`
- `Unavailable`

### Recommended Action

- `Collect Comparable Evidence`
- `Continue Testing`
- `Advance to Validation`
- `Continue Validation`
- `Return to Test`
- `Promote to Main`
- `Scale Budget`
- `Cut`
- `Refresh`
- `Observe`
- `Fix Delivery`
- `Fix Policy`
- `Diagnose Data`
- `Review Structure`
- `Retest`

### Campaign context

Campaign Operating Role:

- `Test`
- `Main`
- `Mixed`
- `Unresolved`

Performance Trajectory:

- `Rising`
- `Plateau`
- `Closing`
- `Past Peak`
- `Volatile`
- `Insufficient History`

Strategy Role remains a separate business context such as prospecting, retargeting, catalog, retention, promotion, or geo expansion.

### Binding transitions

```text
Test       -> Validation   : Advance to Validation
Validation -> Validation   : Continue Validation
Validation -> Test         : Return to Test
Validation -> Main         : Promote to Main
Main       -> Main         : Scale Budget / Refresh / Observe
Any live   -> Exited       : Cut
Exited     -> new Test run : Retest
```

Direct `Test -> Main` is rejected. The owner's desired behavior for "take the best test creative into the main structure" is represented as `Advance to Validation`. If it is physically placed in a Main campaign, it remains `Validation in Main`: PAUSED at creation, capped by budget/loss/time, and not described as profitable or scaled.

## Comparable Cohort Ruling

The evaluation path is:

`saved cohort -> auto cohort -> campaign candidate set -> comparability gate`

Campaign membership never passes comparability by itself. Failure emits `Not Comparable` and moves the item to Monitor.

The persisted evaluation scope includes scope ID/version, candidates, estimand, horizon, currency, assignment method, exclusions, and diagnostics. Comparable candidates must agree on objective, optimization event, conversion source, attribution, targeting/geo/placement policy, bid strategy, and budget regime, with at least 80% overlapping eligible time and no intervention-changing edit.

Randomized cohorts require a sample-ratio-mismatch check. Observational cohorts require declared pre-treatment covariates, overlap/support diagnostics, and balance checks. Missing diagnostics means not comparable.

## Priority and Impact Ruling

Existing source scores remain visible only in the inspector with source-specific names. They are not merged or percentile-normalized.

Before calibration:

```text
commonPriority.status = "not_comparable"
commonPriority.score = null
```

A future common score estimates expected incremental seven-day contribution profit from acting now versus no action. It requires:

- one currency and calibration cohort;
- Shopify realized net revenue, refunds, discounts, COGS, and variable fulfillment/payment costs;
- Meta spend;
- a versioned counterfactual method;
- uncertainty intervals;
- nested exposure allocation that counts every underlying exposure once.

Observed spend, revenue, or ROAS must never be relabeled as incremental impact.

## Canonical Server Contracts

### Read and classification contracts

- `DecisionScopeV1`: business, provider account, currency, grain, entity, and complete parent chain.
- `EvaluationScopeV1`: immutable comparison membership and diagnostics.
- `TruthSignal<T>`: `observed | missing | stale | conflict | not_applicable`, source, grain, as-of, and attribution method.
- `TruthBundleV1`: Meta delivery/platform truth, Shopify realized commercial truth, and GA4 diagnostic context.
- `MetaDecisionEnvelopeV1`: immutable snapshot, raw engine/version, classifier/version, scope, truth, priority, authority, and journal references.
- `CampaignContextAssignmentV1`: operating role, strategy role, source, authority, confidence, evidence, resolver version, effective period, and correction ID.
- `CreativePlacementMapV1`: stable asset identity plus every account-bound ad placement and parent chain.
- `CreatorShareSnapshotV1`: immutable assets, lineage, redaction policy, permissions, expiry, revocation, and published feedback revision.

### Collaboration and execution contracts

- `DecisionCaseV1`: stable case, workflow state, disposition, assignee, optimistic version, and journal.
- `DecisionJournalEventV1`: append-only computed, published, response, collaboration, preflight, execution, verification, compensation, and outcome events.
- `LaunchIntentV1`: originating decision/brief, selected account, exact target, scope, role metadata, requested final state, and expiry.
- `ExecutionPlanV1`: canonical ordered mutations, intended states, exposure, risk, preconditions, policy version, reversibility class, and SHA-256 hash.
- `ApprovalV1`: single-use approver, capability, exact plan hash, exposure ceiling, and expiry.
- `PreflightLeaseV1`: account/provider/current-state verification, data freshness, policy/kill state, exposure, and a maximum five-minute validity.
- `ExecutionReceiptV1`: actor/source, plan/approval hashes, before/intended/observed state, attempts, provider trace IDs, verification, partial results, and compensation events.

## Risk and Authority Model

| Risk | Examples | Maximum authority |
|---|---|---|
| R0 | Read, analyze, recommend | Observe/Recommend |
| R1 | Create PAUSED provider objects | Operator approval at B; bounded C candidate |
| R2 | Pause, bounded bid/budget reduction | Approval at B; bounded C candidate |
| R3 | Resume, ACTIVE publish, bid/budget increase | Explicit approval at B/C; bounded D below owner thresholds |
| R4 | Threshold exceedance, broad rebuild, hard-to-reverse action | Admin approval forever |

Roles expose capabilities rather than being interpreted in the browser:

- Viewer: view, search, inspect, permitted export.
- Analyst: Viewer plus comment, assign, disposition, brief/share draft.
- Operator: Analyst plus policy-bounded approve/execute, publish feedback, and engage stop controls.
- Admin: economics, access, automation promotion, R4 approval, and kill-switch release.

## Visual and Interaction System

The design should borrow Triple Whale's principles of consolidated navigation, saved working contexts, visual creative analysis, and separate deep-analysis modes, without copying its product or branding.

### Foundations

- Light-first, paired dark theme.
- IBM Plex Sans and IBM Plex Mono with tabular numerics.
- Calm neutral surfaces, semantic color only for danger, caution, positive, info, and automation.
- Flat page bands and tools; no marketing hero, decorative gradients, nested cards, or card-wall KPI dashboard.
- 1px borders, 4-8px radii, restrained elevation only for floating overlays.
- Lucide icons and tooltips for unfamiliar icon commands.
- Stable dimensions so labels, badges, thumbnails, and loading states do not shift layout.

### Desktop shell and Decisions density

- 48px top bar.
- 184px collapsible application navigation.
- 16px content gutters.
- Decisions chrome below the top bar is capped at approximately 156px.
- At 1440x900, two columns show 4-6 complete decisions in the first viewport.
- Opening one decision produces one column plus the persistent inspector.
- The first card is actionable content, not a stack of banners, KPI tiles, or instructions.
- Global freshness appears once. A local warning appears only where it changes truth or authority.

### Responsive behavior

- `<768`: single-column triage, full-screen inspector, no desktop table miniaturization.
- `768-1023`: compact single-column work surfaces with drawers.
- `1024-1439`: one-column decisions plus overlay inspector when needed.
- `>=1440`: two decision columns; one column plus inspector when selected.
- `>=1600`: persistent inspector may coexist without crushing the work surface.

Mobile approval appears only when the server returns `mobileApprovalEligible`, actor capability, bounded/reversible risk, healthy evidence, and a fresh passed preflight. High-risk work deep-links to the exact desktop case/snapshot.

## Required State Model

Every major screen must design and implement:

- loading without fake counts;
- valid empty with applied scope and recovery action;
- missing evidence;
- stale snapshot/source;
- tracking/source conflict;
- partial data;
- failed resource while preserving an explicitly locked last-valid snapshot;
- disconnected or unassigned account;
- insufficient history/readiness;
- restricted role;
- preflight not run, running, passed-until, warning, blocked, expired, and control unavailable;
- execution queued, applying, verification pending, succeeded, partial, failed, unknown outcome, compensating, compensated, compensation failed, and cancelled;
- provider rejection and silent failure;
- kill switch engaged and release review;
- rollback requested, verified, failed, or impossible;
- long names, missing thumbnails, mixed currencies, and high-volume data.

Workflow, disposition, and execution are orthogonal state machines. A provider request does not mark a case Done.

## Backend Release Sequence

1. Freeze canonical contracts and preserve current compatibility projections.
2. Add explicit provider-account scope, typed truth signals, evaluation scope, and classifier projection.
3. Add decision cases and append-only journal under shadow/dual read.
4. Add stored LaunchIntent, immutable plan/approval, fresh preflight, durable saga/idempotency, reconciliation, and receipts.
5. Move every Meta mutation endpoint through one fail-closed authorization/executor boundary.
6. Release read-only/collaboration History and Decision Lab.
7. Release Stage B low-risk desktop approval to one account with verified kill-switch behavior.
8. Add high-risk preflight workflows, then mobile low-risk approval.
9. Earn C/D per action class only after calibration, outcome, safety, and operational evidence gates pass.

## Acceptance Gates

### Data and contract

- Two-account fixture produces zero cross-account rows and zero cross-currency aggregation.
- Reused creative fixture preserves every placement; each write targets one explicit provider entity/account.
- Raw engine snapshots remain byte-preserved while classifier versions change independently.
- Missing Shopify data renders missing, never zero; GA4 cannot raise execution authority.
- Changing a display filter cannot change evaluation authority.
- One failed workspace source leaves unaffected sections usable.
- No cross-grain sort when any item is not comparable.

### Execution safety

- 100% of Meta mutation endpoints traverse one authorization/executor guard.
- 100 concurrent identical creates produce exactly one provider create.
- Same idempotency key with a different plan hash returns conflict.
- Ambiguous create timeout produces zero automatic create retries before reconciliation.
- Mid-batch kill engagement produces zero subsequent provider calls.
- Control-plane failure produces zero provider calls.
- ACTIVE campaign activation never precedes required child verification.
- No success, rollback, or compensation state exists without provider proof.
- 100% of attempts, failures, and blocks have complete append-only receipts.

### UX, accessibility, and scale

- WCAG 2.2 AA; text contrast at least 4.5:1 and component/focus contrast at least 3:1.
- Product target sizes at least 36px desktop and 44px mobile.
- Complete keyboard/focus behavior for tabs, drawers, dialogs, grids, and return-to-origin.
- No lost function at 200% zoom or 320px width.
- Stress fixtures: 5 Act Now decisions, 40 Monitor rows, 300 creatives, and 1,500 History events.
- Required viewports: 390x844, 768x1024, 1280x800, 1440x900, and 1728x1117, light and dark.
- Initial API payload at most 200KB compressed; virtualized DOM window at most 60 rows/tiles.
- Cached inspector open p95 at most 150ms; client filter/sort p95 at most 100ms under the test profile.
- Field p75 LCP at most 2.5s, INP at most 200ms, and CLS at most 0.1.

## Open Owner Ratification

One terminology/operating correction is intentionally visible rather than silently assumed:

- Owner wording: a below-target relative test winner may be moved to the Main campaign.
- Expert ruling: its semantic stage remains Validation until the commercial confirmation gate passes. The UI action is `Advance to Validation`; physical placement in Main is `Validation in Main`, with PAUSED creation and enforceable caps.

This preserves the desired buying behavior while preventing `Main`, `Winner`, `Profitable`, and `Scale` from collapsing into the same claim.
