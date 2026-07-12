# Adsecute Meta Operating System - Joint Decision

Date: 2026-07-10
Status: Joint Codex + Claude Code ruling; review blockers incorporated
Inputs:

- `META_OS_OWNER_DISCOVERY_2026-07-10.md`
- `CODEX_META_OS_INDEPENDENT_STUDY_2026-07-10.md`
- `CLAUDE_META_OS_INDEPENDENT_STUDY_2026-07-10.md`
- current repository contracts and rendered wireframes

## North Star

Adsecute Meta is a verified-execution, institutional-memory media-buying operating system. Its defensible product is not a claim that it has the smartest recommendation. It is the complete trust loop:

`decision -> evidence -> human authority -> provider write -> verification -> outcome -> history`

The first executable maturity is Stage B, an approval assistant. C and D are earned per action class and remain visibly locked until server evidence and safety gates exist.

## Binding Decisions

### Information architecture

- Primary Meta navigation: Decisions, Creative Studio, Launchpad, Automation.
- Decisions uses Act Now and Monitor on `/platforms/meta`.
- History becomes an additive `/platforms/meta/history` journal route.
- Historical Replay and Decision Lab are explicit read-only modes, never date-filter side effects.
- Healthy is supporting context; Out of sales scope is a Monitor segment; closed structures move to History.
- Creative Inbox is resoped to the selected account and absorbed into Studio; cross-business portfolio behavior is retired.
- Audiences stays an honest planned/readiness route until a real server contract exists.

### Act Now composition

Act Now is permanently sectioned:

1. Integrity Fires
2. Money Moves
3. Creative Rotation

No interleaved campaign/ad-set/creative feed is allowed. A future calibrated composite may select a compact Top strip with per-grain quotas; it never replaces the sections.

Every section is server-selected, top-N bounded, pre-cap counted, and followed by a suppression receipt. Null financial exposure moves into a visible unrankable/investigate band instead of sorting as zero.

### Desktop layout ruling

The owner preference and first Codex interaction review favored two columns when no item was open. Claude's red team rejected that because it creates two scan orders, cannot coexist cleanly with an inspector at 1440px, and reflows the queue on selection.

Joint ruling: one decision column plus a permanently reserved 420-460px right context/inspector zone at `>=1440`.

- Before selection, the right zone contains overnight receipts, due-backs, recent outcomes, and a concise selection state.
- After selection, it becomes the evidence inspector without moving the queue.
- Below 1440, the inspector is an overlay/full-screen drawer.
- Honest 1440x900 density is approximately 5 compact text cards, 4 full fact-strip cards, or 3-4 thumbnail cards.

This deliberately overrides the two-column owner input because the original request authorized expert challenge and the single-column model has the stronger scan-order and no-reflow argument.

### Card and inspector ruling

Cards show action, entity, role, creative assessment where available, one-line reason, real spend exposure, three action-relevant metrics, confidence band, maturity/freshness/risk, and one command.

Cards do not show:

- numeric confidence;
- numeric priority;
- formula details;
- risk-of-inaction prose;
- base/upside/downside scenarios.

Those belong in the inspector. Impact is `unavailable | exposure_proxy | modeled`; current v1 renders unavailable/exposure proxy because no honest scenario model exists.

`riskTier` is a proposed server producer, not a current field. It emits `low | medium | high`; absence renders `Risk unclassified` and always receives the highest confirmation ceremony. Missing never defaults to low risk.

### Taxonomy ruling

Raw/versioned engine output is immutable. A versioned server overlay adds:

- Lifecycle Role: Test, Main, Mixed, or Label needed state.
- Assessment at creative grain only: Proven winner, Above target - not scale-ready, Fatigued former winner, Below target, Can't assess - named blocker.
- Reserved future assessment: Relative winner (cohort), only after Evaluation Scope and comparability exist.
- Action: current server buyerAction headline plus executionAction suffix.

`Observe` is reserved for Automation. User action copy uses `Watch`. Generic `Diagnose` becomes `Investigate - {named signal}`.

Economics remains a sourced fact/qualifier, not a fourth client-computed classifier.

### Promote versus Scale ruling

Do not introduce a new Validation engine stage without a real producer. Persist `promotionBasis` instead:

- `economic_scale_in_test`
- `relative_winner_below_target` - future gated path

A below-economics relative winner is never described as profitable and never receives Scale Budget automatically. A future promotion duplicates/reuses the creative/post into an operator-selected Main ad set in PAUSED state, records source/result lineage, remains budget-neutral by default, and creates a paired source-cut/follow-up decision.

Scale Budget has no active provider budget-mutation path today. Until the Single Write Gateway includes a receipted budget executor with prior-state capture, Scale Budget is a routed manual Ads Manager step plus receipt capture, tagged Proposed/contract required; it is never a one-click current capability.

### Evaluation-scope ruling

Default order:

`Launchpad-stamped cohort -> explicit saved scope -> validated inferred fallback`

Auto-formed inference is not the day-one default. Campaign membership does not establish comparability. Failed diagnostics create an aggregate Monitor item and no winner claim.

### Creative Studio ruling

- Visual-first Assets gallery; table is secondary deep analysis.
- Current/Historical Winners are truth-source qualified and separated by engine-version era.
- Winner language is banned under global-default/thin baseline evidence.
- Media older than retention renders metadata-only unless a winner-pinning contract preserved it.
- Fatigued former winners drive a reviewed Brief flow.
- Brief is a persisted object with evidence-linked Keep/Change/Next fields, not a row-level `brief_variation`.

### Creator sharing ruling

The current frozen share implementation is not the creator product and has a live data-exposure defect. It must be hardened before expansion.

The creator product uses grants:

- business/creator/asset scope;
- creator and expiration;
- token rotation;
- revocation at read;
- no-store caching;
- access ledger;
- server-projected payload.

Absolute spend, revenue, CPA, ROAS, CPM, cost per result, impressions, reach, and frequency never serialize to creator v1 because combinations of those fields can reconstruct spend. The live Tier-0 creative-signal set is closed to thumbstop/hook retention, all/link CTR, and video 25-100 completion. A future Admin-gated Tier 1 may show indexed relative outcomes without absolute currency or target values. No absolute-financial tier exists. Trend precedes winner status. Status later uses a closed relationship-safe vocabulary and reviewed evidence.

### Launchpad and ACTIVE ruling

PAUSED remains the create invariant. `Publish ACTIVE` is a composite desired final state:

1. create every object PAUSED;
2. verify hierarchy and child state;
3. run fresh activation preflight and exposure summary;
4. activate children while the campaign remains PAUSED;
5. activate the campaign last.
6. halt immediately on state drift, kill-switch engagement, or any ambiguous provider outcome; never activate past an unverified child and never retry before reconciliation.

The current unguarded `activateAfterCreate` duplicate path is a P0 defect, not an accepted exception. Creation is contain-only, never represented as undoable.

### Automation ruling

One vocabulary per action class:

- Observe
- Recommend
- Approval Required
- Auto-execute

Configured mode and effective authority are separate. Auto-execute remains locked at Stage B.

Promotion requires all hard gates: runtime sample `n >= 30` per calibration cell, ECE `<= 0.05` per label, mature financial outcomes excluding unknown provider outcomes, and zero critical errors. Any `silent_failure` trips the action-class circuit breaker.

Kill-switch engage is risk-reducing and broadly available; release is Admin, desktop-only, and requires fresh preflight. Control-plane read failure must fail closed. Switch state is checked at admission and immediately before every provider mutation/retry. Mid-batch engagement stops every remaining write and emits one aggregate receipt. Engagement freezes every pending approval in scope as `Blocked by kill switch`; release auto-executes nothing and returns each item to Approval Required with a fresh preflight.

### Mobile ruling

Mobile is a real responsive surface, not a device mock.

Stage B Tier-0:

- triage and full evidence;
- Defer/Reject/Acknowledge/comments;
- single-entity Pause;
- kill-switch Engage;
- pending-write reconciliation.

Kill-switch Release, budget/bid/activation, and bulk actions are absent. Additional low-risk approvals wait for server risk tier, capability, freshness, and preflight.

## Current-State Corrections That Must Precede Trust Claims

### P0 honesty and privacy

1. Separate metrics range from decision snapshot. Past decision snapshots are read-only with unmistakable Historical Replay chrome.
2. Harden legacy creative shares: remove absolute financial serialization from external payloads, add business/creator attribution, revocation, no-store reads, and a stricter mint capability.
3. Remove or route `activateAfterCreate` through the ACTIVE activation contract.
4. Require explicit `providerAccountId` across Decisions, Studio, Launchpad, Automation, and History.
5. Unknown currency cannot default to USD.
6. Unknown freshness cannot render fresh.
7. Missing confidence cannot persist as a measured default.
8. Every current Meta ROAS/revenue label says Meta-attributed until a Shopify divergence/join contract exists.
9. A commercial target older than 30 days demotes to `commercial_truth_stale`, receives a confidence penalty, and renders `Target stale — reduced authority`; wire the existing `lib/business-commercial.ts` staleness rule into the engine read.
10. Decisions shows every engaged write-stop scope, including both environment and business switches; business engagement cannot remain invisible on the command center.
11. Archive/delete the guard-bypassing `lib/meta/execution.ts` write path; archived write paths are never revived.
12. Guard `bulk-ad-status` resume, the actual activation money moment, with live billing/pixel/creative preflight, a batch cap, and launched-draft target scoping absent explicit override.

### P0 selection and history prerequisites

1. Date-free stable `decisionId` episode identity.
2. Snapshot-backed creative read model for Decisions and Replay.
3. Versioned classification overlay and named blocker persistence.
4. Server top-N plus true pre-cap counts and suppression receipts.
5. Response attribution plus Reject/Override/reason codes.
6. Keyed History read model over decision, response, write, transition, and outcome journals.
7. Ads Manager copy says `link built from provider-returned ID`, never verified permalink.
8. Per-grain server `riskTier` with missing-to-highest-ceremony behavior.
9. Creative decision envelope extensions for account, parent chain, thumbnail URL/state, and explicit missing-media state.
10. Per-grain nullable exposure/priority producer, hierarchy-deduplicated exposure, and true digest totals using `COUNT(*)` beside capped exemplars.
11. Persisted graduation record and `promotionBasis`, each covered by an ADR with every other new decision producer.

### Before any automation authority

1. One server-enforced capability and write gateway.
2. Durable idempotency reservation and unknown-outcome reconciliation.
3. Fresh preflight lease bound to an immutable plan and single-use approval.
4. Guardrails enforced at every mutation, not displayed as posture only.
5. Prior-state capture and verified forward inverse actions.
6. Fail-closed scoped switch registry and per-class breakers.
7. Attribution-mature outcome accrual and financial evidence gates.
8. Business and action-class switches visible on Decisions; approval freeze/re-preflight semantics.

## Implementation Sequence

No push, deploy, or PR is part of this local design phase.

### Phase 0 - Safety and truth repairs

- Date/snapshot write-safety split.
- Legacy share privacy/revocation hardening.
- `activateAfterCreate` closure.
- Archive/delete the orphaned guard-bypass `lib/meta/execution.ts` path.
- Guard bulk resume with live activation preflight, batch cap, and target scope.
- Unknown currency/freshness/default-confidence fixes.
- Stale commercial-target demotion using the existing 30-day review rule.
- Meta-attributed provenance copy.

### Phase 1 - Canonical read contracts

- Explicit provider account scope.
- Snapshot-backed Decisions workspace.
- Versioned classification overlay.
- Server-stamped `riskTier`; absent tier receives the highest ceremony.
- Creative envelope parent/thumbnail fields and typed truth signals.
- Persisted graduation record and `promotionBasis`.
- Server section selection, pre-cap counts, suppression receipts.
- Per-grain nullable exposure plus hierarchy dedup; true digest totals.
- Stable decision identity, response attribution, and History read model.

### Phase 2 - Decisions UI

- Calm shell and sectioned Act Now.
- Persistent context/evidence inspector.
- Monitor pagination and aggregate entries.
- History, Replay, receipts, and outcome views.
- Mobile Tier-0 and dark-token parity.

### Phase 3 - Creative Studio

- Assets gallery/table, winner eras, fatigue clusters.
- Copy and Landing Page truth boundaries.
- Brief object and Launchpad handoff.
- Grant-based creator sharing.

### Phase 4 - Launchpad

- Stored LaunchIntent and lineage.
- Role/cohort stamping.
- PAUSED create flow and object manifest.
- ACTIVE preview first; real staged activation only after executor contracts.

### Phase 5 - Automation supervision

- Four-mode matrix.
- Evidence gates and honest closed states.
- Switch registry and receipts.
- No executor or auto-execute until all release gates pass.

### Phase 6 - Closure

- Route coverage ledger.
- 390/768/1280/1440/1728 light/dark visual baselines.
- WCAG 2.2 AA and keyboard/focus tests.
- 300-creative, 300+ Monitor, and 1,500-History stress fixtures.
- Full typecheck, lint, Vitest, migrations-from-zero, and Playwright suite.
- Two-account isolation; 100-concurrent-create singleton; mid-batch kill zero-follow-on-write; control-plane fail-closed; initial payload <=200KB compressed; virtualized DOM window <=60; cached inspector p95 <=150ms; client filter/sort p95 <=100ms.
- Codex self-review and Claude Code adversarial review with `CONTINUE` or `STOP_AND_FIX`.

## Release Boundary

The clickable local design may demonstrate proposed/future states only when each is visibly labeled `Proposed/contract required` or `Future/fixture-only`. It must not call provider write paths to simulate them. Current/live-wired, proposed, and future are visually distinct in design documentation and test fixtures.
