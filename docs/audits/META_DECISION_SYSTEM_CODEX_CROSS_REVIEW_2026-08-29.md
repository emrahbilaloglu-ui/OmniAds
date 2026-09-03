# Meta Decision System — Codex Cross-Review of Claude

**Date:** 2026-08-29  
**Scope:** Meta only; IwaStore, Grandmix, Bilsem Zeka, TheSwaf, IwaTR, ColorFullWorldsTR  
**Compared reports:** `META_DECISION_SYSTEM_CODEX_INDEPENDENT_2026-08-29.md` and `META_DECISION_SYSTEM_CLAUDE_INDEPENDENT_2026-08-29.md`  
**Repository evidence freeze:** `main@babf158e150fd33057117b39b175da044ac62d2e`  
**Skill binding:** `/Users/harmelek/.codex/skills/emb-media-buyer/SKILL.md`, SHA-256 `985754567f2ac07e3623d4bc91ce16b0421ac9e3295f3e842248305ec3cbd187`

## Cross-review verdict

Claude materially strengthens the audit in five areas: the breached growth fence, absence of new sync-job creation while the worker remains alive, spend-weighted decision coverage, the weakness of legacy observational outcomes, and sampling uncertainty around near-break-even decisions. I accept those additions.

Two Claude conclusions need correction before reconciliation:

1. The four TheSwaf rows are **presentation-actionable but not executable now**. The server read model exposes enabled Cut actions, while the decision-origin execution boundary rejects their approximately 168-hour-old decisions against a 12-hour maximum. The current executable-now count across the six businesses is zero.
2. TheSwaf account `act_921275999286619` has a historical `business_provider_accounts` row with `is_selected=false`. The provider-account assignment resolver intentionally filters to selected rows. A 403 under that contract is expected, not evidence that a currently assigned account is being rejected. The product gap is that a spending account can continue to have warehouse/decision history while being outside current selected operating scope, without making that state and its consequences obvious.

These corrections do not soften Claude's main verdict: Adsecute is not a Meta Ads Manager replacement and nothing is safe for unattended live execution today.

## Claude claims accepted

### A1. The growth fence is presently breached

**Verified fact.** `pg_total_relation_size('meta_entity_state_history')` was `5,368,750,080` bytes. The configured five-GiB boundary is `5,368,709,120`; the relation is 40,960 bytes over the refusal threshold. The table held 4,239,764 rows in Codex's independent check.

**Why it matters.** This is a live ingestion-safety incident and an automation blocker. The fence needs retention/partitioning plus an operator-visible alert; increasing the ceiling again without controlling growth is not a durable fix.

**Boundary.** The fact that the fence is breached does not alone prove it caused Grandmix's specific incomplete manifest. That causal link remains an inference until the exact hydration/source-run receipts and host logs are reconciled.

### A2. Scheduling/invocation stopped while the worker remained alive

**Verified fact.** No newer `meta_sync_jobs` were created after the 2026-08-22 tail, while `sync_worker_heartbeats` continued to show the Meta worker current, idle and discovering work on 2026-08-29.

**Inference.** The missing link is upstream of queue consumption: scheduler/cron/application invocation or its admission path. The DB does not identify which one.

**Unknown.** The exact host-level cause. It requires cron/app access logs and runtime configuration, not another decision-table query.

### A3. Spend-weighted coverage is more decision-relevant than row counts

**Accepted derived evidence.** Claude's final-observed-week join reveals business risk that raw label counts hide:

- IwaStore: 52.8% of observed spend under held Scale/campaign-context rows.
- Bilsem: 23.0% of observed spend is purchase-engine out-of-scope.
- Grandmix: meaningful spend under hard actions hidden by invalid serving authority.
- TheSwaf: roughly half of final-week spend across the queried account scope under authorized Cut labels.

The exact percentages remain scoped to Claude's SQL window, currencies and account inclusion. They must not be summed across currencies or relabeled current spend on 2026-08-29.

### A4. Native outcomes are absent and the legacy record cannot justify automation

**Verified fact.** Native outcome rows are zero; recent native outcome jobs fail on 30-second database timeouts. Operator-response jobs also contain a schema error referencing nonexistent `business_ref_id`.

**Accepted interpretation.** Legacy outcome rows are observational, highly censored and materially negative for some Scale histories. They are useful counterevidence against overconfidence, not causal estimates of policy effect.

### A5. Near-break-even Cut/Scale language exceeds the evidence ceiling

**Accepted inference.** Claude's Poisson approximation is not a full revenue-variance or attribution model, but it is a valid stress test: at small purchase counts, point ROAS and a recent-window point estimate cannot support language such as “clear loser” or confident marginal scaling. Loss-budget stop rules can still justify reversible pauses when the loss is large enough; the UI must name that mechanism instead of presenting a precise ranking claim.

### A6. The pacing block is circular

**Accepted derived finding.** When `dailyTarget = MTD spend / elapsed days` and `mtdTarget = dailyTarget × days in month`, the “target” is generated from realized spend. It is not a budget plan, and the resulting pace status is not suitable for allocation or automation.

### A7. Kill-switch authority is inconsistent across surfaces

**Verified fact.** The Decisions workspace uses the environment kill switch, while the business control plane persisted IwaStore as kill-switched. A workspace can therefore display false while the business is actually disabled. This is a governance-truth defect and belongs in P0, not P1.

## Claude claims corrected or narrowed

### C1. “Exactly four actionable/executable decisions”

The count is only true at the presentation layer.

- Persisted decision time for the served TheSwaf cuts: `2026-08-22T14:51:26.766Z`.
- Audit age: approximately `167.68h` at Codex's check.
- `lib/creative-decision-engine/execution-safety.ts` defaults decision-origin Ad actions to `maxDecisionAgeHours = 12`.
- The Decisions read model nevertheless marks four rows `actionEligible=true`, exposes `authorizedAction=cut`, and the drawer renders an enabled Cut control.

**Reconciled terminology:**

- persisted-authorized: seven current selected-account rows in the stored generation;
- served action-presented: four active selected-account rows;
- execution-preflight-executable now: zero.

This is the highest-severity UI truth defect because the operator is invited to attempt an action the server already knows it must refuse.

### C2. TheSwaf second account is not currently selected

`act_921275999286619` has `is_selected=false`. `getProviderAccountAssignments` filters `business_provider_accounts.is_selected`; the history contract deliberately keeps deselected rows for attribution/history. Thus `provider_account_not_assigned` is consistent with current authorization semantics.

The real product questions are:

- whether a second spending account was intentionally deselected;
- whether all spending accounts should be first-class selectable/operable in the same business;
- whether the UI must warn when historical/synced spend exists outside current selected scope;
- whether decision producers should continue for a deselected account.

Those are material, but they are not proof of an authorization bug.

### C3. Active-ad counts use different populations

Claude reports active rows in latest decision generations and, for TheSwaf, combines two accounts. Codex reports current provider/config projection for the selected account and counts missing exact decisions explicitly. The numbers therefore answer different questions.

Required reconciliation contract for every count:

- source table or API;
- provider account set and `is_selected` rule;
- provider/config status predicate;
- decision `as_of_date`/generation;
- observation cutoff;
- whether historical/deselected accounts are included.

Until those fields accompany a number, neither table should be presented as “the” current active-ad inventory.

### C4. Freshness ages describe different authorities

Codex observed the current local tile showing approximately `68.82h old` for a newer structure recommendation while the exact native Ad decision behind the enabled Cut was approximately `167.68h old`. Claude's `178.16h` needs an explicit observation timestamp and row/field; it may be a later measurement or a different clock.

The important reconciled fact is not the ten-hour numeric difference. One tile combines warehouse sync age, structure snapshot age, engine generation/as-of and exact-decision age without naming them separately. Execution freshness must come only from the exact action's server-owned preflight authority.

### C5. Growth fence as Grandmix root cause

The fence mechanism and present breach are verified. Grandmix's invalid native generation is verified. The receipt phrase `complete_source_run_missing` directly identifies an absent complete source run. The fence is a plausible common cause, not yet the proven cause of that particular receipt. The final report must preserve that truth label.

### C6. “The decision core is sound” is too broad

The invariant sweep and arithmetic reproduction support **internal consistency of persisted classifications**. They do not establish commercial accuracy, incremental profit, calibration, stale-decision safety at the read model, multi-object allocation quality or outcome-driven learning. The narrower statement is: the persisted native exact-Ad rows satisfy the audited structural invariants and selected arithmetic reproductions.

## Codex gaps identified by Claude

The Codex independent report should be amended in reconciliation to include:

- exact relation-size arithmetic and measured growth-fence breach;
- the scheduler/worker separation and its remaining host-level unknown;
- spend-weighted decision coverage with explicit windows/account scope;
- lifetime and recent native job-failure context, not only latest-per-business rows;
- the circular pacing derivation;
- the business-vs-environment kill-switch contradiction;
- small-sample/loss-budget language discipline;
- optimization-goal coverage as a product requirement, especially Bilsem's non-purchase spend;
- a retention/headroom gate rather than a one-time fence recovery.

## Reconciled P0 order proposed by Codex

1. **Stop false action affordances.** Apply the same exact-decision freshness authority in the server read model and execution preflight; stale, future or unparsable decisions must be review-only with an explicit reason. The UI must show exact decision age separately.
2. **Make source outage impossible to call healthy.** Surface sync-job absence, warehouse cutoff, engine generation age, manifest validity and growth-fence state as separate server-owned health dimensions. Block writes when any required dimension is stale/invalid.
3. **Restore ingestion safely.** Diagnose the missing scheduler invocation, implement retention/partitioning for `meta_entity_state_history`, recover headroom, then backfill and verify all selected accounts without silently raising the fence.
4. **Repair learning jobs.** Fix the operator-response schema query and redesign/batch outcome accrual so it completes within bounded DB load. Backfill and publish coverage/failure denominators.
5. **Unify governance truth.** Merge workspace and per-business kill switches and show the exact effective authority, source, cap, quiet hours and dry-run status on every execution surface.
6. **Resolve production React #310.** Reproduce against the deployed bundle/business-switch path, add a regression test and prove production read-back before calling Decision Center operable.
7. **Clarify account scope.** Expose selected vs historical/deselected spending accounts and prevent “all business spend covered” claims when some account spend is outside current operating scope.

Only after these are green should execution breadth (budget/bid/refresh/launch) be expanded.

## Acceptance tests for the first implementation slice

- A decision older than 12 hours is returned by the read model as non-executable; no provider mutation or enabled action control is present.
- Future or unparsable decision timestamps fail closed.
- A fresh authorized decision remains approval-gated and reaches the same execution preflight contract.
- Structure snapshot freshness cannot overwrite or label exact-decision freshness.
- The drawer shows decision computed-at, age, maximum age and blocker reason from the server contract.
- IwaStore workspace reports the effective persisted business kill switch as engaged even when the environment switch is false.
- Missing sync-job creation beyond cadence, warehouse staleness, invalid manifest and breached growth fence each prevent a Healthy aggregate state.
- Tests cover selected/deselected provider-account authorization separately.
- No UI component computes buyer action or execution readiness locally.

## Unresolved unknowns

- Exact scheduler/host/runtime reason no sync jobs were created after 2026-08-22.
- Exact cause chain for Grandmix's incomplete source manifest.
- Exact deployed component/version and state transition causing React #310.
- User intent for TheSwaf's deselected second account.
- Attribution-window/model drift and revenue-source comparability across accounts.
- Commercially calibrated target/cost truth for businesses with missing or contradictory cost models.

## No-mutation attestation

This cross-review used the two frozen reports, current repository source and read-only production evidence already gathered for the independent audit. It made no provider/Meta write, deployment, migration or production application-code change. This document is the only artifact added by the Codex cross-review step.
