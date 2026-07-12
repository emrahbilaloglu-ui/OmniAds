# Adsecute Meta Operating System - Owner Discovery

Date: 2026-07-10
Status: Owner-confirmed product inputs for independent Codex and Claude Code studies
Scope: All authenticated Meta product surfaces. Global `/overview` is excluded.

## Product North Star

- Initial product role: a decision and execution assistant. It prioritizes and recommends; the user approves writes.
- Maturity path: approval-based assistant -> guardrailed auto-execution -> mature autonomous media buyer.
- Initial primary persona: an experienced media buyer managing one or a few brands.
- Intended product feeling: a Media Buying Operating System, not a reporting dashboard.
- Daily workflow: Act on priorities -> analyze account and assets -> build/repair through Launchpad -> supervise Automation.
- Decisions is the command center. Creative Studio, Launchpad, and Automation are linked specialist surfaces.
- AI copilot is explicitly deferred. It is not part of the current scope.

## Decisions Command Center

- First screen must answer what to act on now. Show 3-7 top decisions, with roughly 4-6 compact decisions visible in the first desktop viewport.
- Rank through an explainable composite priority model combining risk, opportunity, spend, confidence, and time sensitivity.
- Show a numeric priority score and short component summary. Put detailed calculation evidence in the inspector.
- A decision card must show: clear action, concise media-buyer reason, estimated impact, risk of inaction, confidence, and core metrics.
- Estimated impact uses base/upside/downside scenarios. If evidence cannot support a number, say it cannot be calculated.
- Risk determines action flow. Low-risk work can start confirmation from the card. High-risk work requires evidence, preflight, and explicit confirmation.
- Risk classification is based primarily on reversibility and financial exposure.
- Wide desktop uses two decision columns when no item is open. Opening a decision changes to one decision column plus a persistent right evidence inspector.
- Campaign/ad-set structure is an on-demand, collapsible scope rail, not a permanent business selector.
- Navigation is simplified to three operational areas: Act Now, Monitor, History.
- Healthy and Non-sales are supporting filters/context, not equal top-level operational lanes.
- Act Now should use one cross-grain priority order for campaign, ad set, and creative only after those engines publish a genuinely calibrated common priority contract.
- Under the top decisions, show compact Needs Monitoring and Recent Outcomes summaries. Their complete inventories live in their own areas.
- Compact freshness appears once at the top. Local warnings become prominent only where a freshness/tracking problem affects truth or action.
- Date range normally changes metrics, not the latest decision snapshot. A separate Historical Replay mode opens a past decision snapshot.

## Evidence, Trust, and Feedback

- Evidence presentation: one-sentence media-buyer rationale, verifiable facts, then optional formula detail.
- Missing required evidence sends an item to Monitor with the missing signal, decision impact, and reevaluation condition. It must not become a high-confidence action.
- User disagreement supports Defer, Reject, Override, and a structured reason. Free-form notes are optional.
- Outcome measurement is automatic, with user ability to mark outside/confounding events.
- Financial contribution follows an evidence hierarchy: holdout where possible, controlled comparison/model where necessary, and `uncertain` when no honest counterfactual exists.
- Every completed provider action returns a short immediate status and an expandable receipt containing provider result, changed value, time, and audit record.
- Ads Manager links are contextual verified permalinks in the inspector and receipts. If a real link cannot be produced, the control is absent.

## Monitor and History

- Monitor includes immature candidates, newly applied decisions, learning/pacing/fatigue/tracking issues, and emerging risks.
- Every Monitor item explains why it is waiting and when it will be evaluated again.
- History is a decision journal covering writes, decision/confidence transitions, 1/3/7/14-day outcomes, overrides, deferrals, failures, and rollback attempts.
- Weekly/monthly Meta review covers decision quality, actions and deferrals, financial outcomes, creative winner movement, and automation safety.

## Existing Decision Engine and Taxonomy

- The existing decision engine and its mathematics are the foundation. The owner believes it reflects their media-buying view well.
- The primary current problem is output classification and terminology, not a request to replace the core engine.
- Preserve raw/versioned engine output and historical snapshots.
- Add versioned classification dimensions rather than destructively renaming raw labels.
- Desired classification has three dimensions:
  1. Lifecycle role, such as Test or Main.
  2. Assessment, such as Winner, Underperformer, or Uncertain.
  3. Action, such as Promote to Main, Scale Budget, Cut, Refresh, or Observe.
- Exact vocabulary and segment set must be challenged and finalized by expert media buyers. It must be immediately understandable in professional use.
- Card hierarchy: the action verb is the headline. Lifecycle role and assessment are quieter context chips.
- A key correction is separating test winner selection from economic scaling:
  - `Promote to Main` means a relative test winner can move into the main campaign without implying profitability or increasing budget.
  - `Scale Budget` is a separate action reserved for sufficiently validated economic performance.
- If every creative is below the business economics target, the best comparable test creative may still be a relative Winner and eligible for Promote to Main. It must not be described as profitable or automatically receive Scale Budget.

## Campaign Roles and Correctable Classification

- Launchpad-created campaigns should carry explicit role metadata.
- Externally created campaigns may be automatically classified from available structure and behavior.
- User corrections become authoritative for the affected campaign.
- Corrections train a separate shadow classifier. They must not immediately mutate the live decision formula or online-learn without validation.
- A corrected classifier becomes authoritative only after replay, golden tests, shadow evidence, and versioned release gates.

## Winner Evaluation Scope

- Winner comparison uses an explicit, saved evaluation scope rather than an ad hoc display filter silently changing action authority.
- Users can select stored scopes such as Campaign, Ad set, or Test cohort; a new decision snapshot records the scope that was used.
- Default: an automatically formed comparable test cohort. If a reliable cohort cannot be formed, fall back to campaign scope.
- A winner is not declared when distribution/evidence is not comparable. The cohort moves to Monitor with the imbalance and required evidence.

## Creative Studio

- Act Now creative decisions use a real thumbnail in a compact decision card.
- Creative Studio is visual-first and follows: find winners/decliners -> diagnose hook/format/message/funnel -> produce the next brief.
- Approved briefs move to Launchpad. In the first stage the user supplies/selects the asset and completes launch setup.
- Creative Studio contains linked subviews for Assets, Copy, and Landing Pages with shared scope/filter context.
- It needs Current Winners and Historical Winners based on persisted decision snapshots and 7/28/90/all-time filters.
- Explore a creator-facing persistent share surface:
  - First stage uses revocable, time/asset-scoped share links.
  - Show winner status, basic performance trend, and structured creative feedback.
  - Sensitive financial metrics are permission-controlled.
  - The system drafts evidence-based feedback; a media buyer reviews/edits before publishing to the creator.

## Launchpad

- Primary first-stage job: turn an approved Decisions/Creative Studio recommendation into a safe campaign or ad-set draft.
- It should eventually also cover from-scratch campaign creation, existing structure edits/rebuilds, and full campaign-builder needs.
- Default provider creation state is PAUSED.
- The user may explicitly select ACTIVE before creation.
- ACTIVE creation requires mandatory preflight, budget summary, and an explicit `Publish ACTIVE` confirmation.

## Automation

- Configure modes per action type: Observe, Recommend, Approval Required, Auto-execute.
- Promotion to a stronger mode is proposed by the system with evidence and approved by the user.
- Promotion evidence requires all of: minimum sample, accuracy/calibration, financial outcomes, and critical-error limits.
- Even at mature autonomy, high-financial-impact or hard-to-reverse operations remain approval-gated through user-defined thresholds.
- Rollback policy is impact-aware: restore prior state where honestly possible, stop the affected automation class when necessary, and trigger the global kill switch for critical/widespread failure.
- Never claim rollback or retry success unless the provider result proves it.

## Business Economics and Strategy

- Business economics is the primary floor and source for commercial truth.
- Account history and current regime calibrate thresholds.
- Relative test winners below the economics target remain eligible for Promote to Main, not automatic Scale Budget.
- Business operating mode is the default strategy. Campaign roles can apply controlled exceptions.
- Test/Growth exceptions use role-specific learning budgets, maximum loss limits, and time windows.
- User strategy control is preset-only: Conservative, Balanced, Aggressive.
- Preset is selected at business level; campaign roles apply bounded policy differences. Users do not edit raw formula weights.
- Decision Lab is a separate surface for historical replay, threshold scenarios, and decision diffs. Live formulas change only through controlled versioned release.

## Data Truth Policy

- Meta is truth for spend, delivery state, platform attribution, and provider objects.
- Shopify is truth for realized orders, revenue, refunds, and profit.
- GA4 is diagnostic context for funnel behavior, not the source of provider action truth.
- Missing or conflicting sources reduce decision confidence and automation authority. Missing must never render as zero.

## Navigation, Scale, and Collaboration

- Decisions remains scoped to the globally selected single account. No cross-account Portfolio surface is requested.
- Default operational scope is active and recent-evidence entities. Old/closed structures live in History search.
- Main navigation at scale: global search + saved scopes/views. The collapsible rail shows selected context.
- Saved scope/filter views, density, and notification preferences are customizable. Core information architecture stays fixed.
- Roles: Viewer, Analyst, Operator, Admin, with separate view/approve/execute authority.
- Collaboration: assignment, comments, and Open/In Review/Done status on decisions.
- Notifications: critical risk and automation failures are immediate; other decisions arrive in a planned daily digest.
- Mobile supports triage/evidence plus safe approval of low-risk actions. High-risk work routes to desktop.

## Onboarding and Readiness

- Guided start: select account -> business economics -> operating mode -> first snapshot.
- Campaign roles are initially auto-classified and later correctable.
- Insufficient history produces a Data Readiness surface, safe preliminary analysis, and explicit waiting evidence. It does not produce unsupported hard actions.

## Product and Design Direction

- Visual goal: calm, compact, professional simplicity inspired by Triple Whale principles, but an original Adsecute system.
- Avoid both a raw spreadsheet and a marketing-style card dashboard.
- Light theme is primary; dark theme uses the same semantic token system.
- Semantic color communicates danger, caution, positive, info, and automation only.
- Claude Design should produce one strong, end-to-end direction, not shallow variants.
- Use realistic stress data: a handful of Act Now decisions, dozens of Monitor items, hundreds of creatives, and 1,000+ History records.
- Required states: normal, loading, empty, error, missing/stale data, tracking degradation, confirmation, success, partial failure, rollback, kill switch, read-only role, mobile, dark theme, high volume, and long text.
- Claude Design scope is the full Meta Operating System and common Meta design system. Global `/overview` is excluded.

## Execution and Approval

- First finalize taxonomy and shared product/data contracts.
- Then execute Decisions -> Creative Studio -> Launchpad -> Automation under one system.
- Validation before changing classification authority requires unit/golden tests, historical replay/diff, live write-disabled shadow evidence, and expert media-buyer case review.
- Codex will build its design directly in the local Adsecute app. No push/deploy is part of the design phase.
- Claude Code provides an independent repo-backed senior-team study and later adversarial review. It does not implement the alternate visual design.
- The owner will use the final joint prompt in the separate Claude Design application to create an alternate full Meta design.
- Before production implementation, the owner reviews the working clickable local prototype after Codex and Claude Code review.

## Explicitly Unresolved for Expert Teams

- Exact expert terminology and complete taxonomy values for lifecycle role, assessment, and action.
- How to calibrate a common cross-grain priority score without fabricating comparability across engines.
- Minimum evidence and outcome gates for Promote to Main, Scale Budget, and automation promotion.
- The safest useful creator-share product boundary.
- The precise navigation and visual composition that delivers 4-6 first-viewport actions without recreating spreadsheet or card-wall failure modes.
