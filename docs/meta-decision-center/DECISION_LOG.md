# Meta Decision Center Decision Log

This log records the Meta campaign/adset decision-model decisions behind Phases
A through G. It complements, but does not replace, the Creative Decision Center
decision log.

## D-M001 - Use One Funnel Cohort Resolver

Decision: campaign/adset recommendation windows, lane classification, entity
state rows, and related Meta decision paths must use the shared
`resolveMetaFunnelCohort(...)` resolver.

Reason: string-based local purchase filters let non-purchase campaigns leak
into sales decisions and let sales objective text override explicit non-purchase
optimization goals.

Rejected alternative: keep per-module objective/optimization string matching.
That duplicates taxonomy and recreates the original sales-style logic failure.

## D-M002 - Hard Purchase Actions Need Commercial Anchors

Decision: purchase hard scale/cut needs configured target or profit anchors from
the business target pack. Account percentiles are benchmark context only.

Hard-action anchor fields:

- `target_roas`
- `break_even_roas`
- `target_cpa`
- `break_even_cpa`

Reason: p75/p25 benchmarks describe account distribution; they do not prove
profitability. Hard actions must connect to the business economics.

Rejected alternative: treat legacy coverage/fallback thresholds as target
anchors. Review found this would let fallback values act as fake commercial
truth.

## D-M003 - Purchase Maturity Uses Loss Budget

Decision: purchase maturity uses
`spend >= max(currency_floor, CPA_baseline * risk_multiplier)`, with CPA
baseline priority `break_even_cpa`, then `target_cpa`, then account CPA.

Reason: maturity should represent allowed loss budget, not relative spend
against the largest main campaigns. Otherwise test creatives/campaigns never
reach a fair verdict or get judged against scale-campaign spend.

## D-M004 - Main/Test/Mixed Labels Are Semantic Inputs

Decision: Main/Test/Mixed labels are backend decision inputs for hard-action
guards, kind-aware calibration, and Test campaign semantics.

Rules:

- unlabeled hard actions downgrade to diagnostic/review-only output;
- requested kind calibration falls back to canonical `all` when sparse;
- Test refresh semantics become cut semantics in backend payloads;
- Test scale semantics may emit `promote_test_to_main` payload diagnostics;
- UI CTA binding for `promote_test_to_main` remains deferred.

Reason: Test campaigns are experiments. Their failure and success semantics are
not the same as Main campaign stability semantics.

## D-M005 - Unsupported Signals Stay Diagnostic

Decision: tracking, checkout, feed, overlap, placement, pacing, learning, and
recent-edit paths must emit hard action only when their required source signal
exists and is fresh enough.

Reason: zero purchases or poor ROAS alone cannot diagnose CAPI, checkout, feed,
or delivery problems. The engine must distinguish performance failure from
missing signal proof.

## D-M006 - Scenario Expansion Is Data-Gated

Decision: Phase E implemented only scenario families whose required signals were
present or could be explicitly populated. Remaining scenario-library ideas are
deferred until signal coverage exists.

Reason: adding more named scenarios without signal support would increase
apparent sophistication while reducing decision truth.

Deferred to Phase H or later:

- audience overlap and lookalike compound actions;
- deeper placement mix gates;
- cross-campaign overlap and budget-shift families;
- seasonal/peak scale ceiling and taper variants;
- deeper C1 controlled-scale automation.

## D-M007 - Empirical Outcomes Gate Automation, Not Visible Confidence

Decision: empirical outcome logs and summaries can inform automation readiness,
but they do not change visible confidence scores in Phase F.

Reason: visible confidence, empirical precision, live preflight, rollback proof,
and auto-execute tier are different concepts. Collapsing them would make the UI
look safer than the operational system actually is.

Auto-execute requires all of:

- sufficient positive/negative judged outcome sample;
- precision/negative-rate thresholds;
- live preflight proof;
- rollback proof;
- label, target, maturity, freshness, and blocker checks.

## D-M008 - Phase G Closes Documentation And Release Hygiene

Decision: Phase G closes the implemented A-F.4 chain by adding Meta-specific
read order, decisions, data-readiness matrix, invariants, golden cases, fixture
audit, final regression, deploy/post-deploy evidence, and context update.

Reason: without these docs, future AI sessions can pass tests while drifting
back to fixed benchmarks, UI-derived actions, missing-signal hard actions, or
unbounded automation claims.

Scope note: Phase G completion does not mean all future scenario families are
done. It means implemented behavior is documented, verified, deployed, and
explicit about its post-closeout limitations.

## D-M009 - Snapshot Rows Carry A Physical Provider Account

Decision: `meta_decision_snapshots_daily` gains a nullable
`provider_account_id` column, populated at snapshot-generation time from the
campaign and ad-set rows the engine already reads. Account-scoped readers pass
the selected account and WITHHOLD rows whose lineage cannot be proven.

Reason: Account Intelligence is an account-scoped surface — it receives a
`providerAccountId` and names one account on screen — but the snapshot could not
say which account a recommendation was about, so `readLatestMetaDecisionSnapshot`
answered business-wide and the surface offered one account's recommendations
under another account's heading. The respond control then acted on them. That
contradicts D6 ("one physical provider account") and the plan's exact-account
write order.

`scope_id` is not the answer and must never be used as one: for
`scope_type = 'account'` rows it holds the BUSINESS id
(`scopeForRecommendation` in `lib/meta/snapshot.ts`), so a predicate on it would
mean two different things by row level and would reject every account-level
recommendation.

Scope and compatibility:

- The column is NULLABLE and outside the primary key, which stays
  `(scope_type, scope_id, snapshot_date, rec_type)`. Both writers depend on it.
- Rows written before the column existed stay NULL. There is deliberately no
  backfill: inventing lineage for a legacy row is the synthetic "all accounts"
  fallback this decision exists to prevent.
- Account-LEVEL rows for a business with more than one assigned account also
  stay NULL — they are genuinely about all of them. With exactly one assigned
  account, "this business" and "this account" are the same fact and the row
  carries it.
- Business-scoped readers that are not account surfaces — History, lane
  classification, the ignored-marker sweep — pass no account and are unchanged.
- An account-scoped read that finds no proven row reports an empty current
  snapshot for that account. It does not fall back to business-wide.

Deferred, and named so it is not mistaken for done: an account-level
recommendation for a multi-account business remains unattributable. Making those
per-account requires the engine to run per account, which is a Phase H change to
`runMetaSnapshotForBusiness`, not a column.

## D-M010 - Operator Responses Are Authorized Per Action, At Write Time

Decision: `POST /api/meta/recommendations/respond` authorizes the `recId` in the
same statement that inserts it, and the rule depends on the action:

- `acted`, `deferred`, `ignored` require the recommendation to be in the CURRENT
  served snapshot for the authorized physical account;
- `undeferred` requires a currently ACTIVE prior deferral for that exact rec,
  where "active" means the latest response is `deferred` and its `reappear_at`
  has not passed.

Reason: the column has no foreign key — `lib/triage-events.ts` is a second
writer whose rec ids are synthetic and never have a snapshot row — so nothing
below the route established that an id named a real recommendation, while
`lib/meta/outcome-accrual.ts` reads those rows back as evidence that an operator
acted.

A fixed recency window was tried first and was wrong: the mounted control is
drawn from the LATEST snapshot only, so an id served yesterday and absent today
passed a check the screen would never have offered. Per-action is what makes
`undeferred` work without opening that hole, because undeferral is the one
action whose purpose is to reach backwards.

The check is the INSERT's own `WHERE` rather than a read followed by a write:
`upsertSnapshotRows` DELETEs and re-inserts a day's rows, so a snapshot rotation
between a permissive read and an unrelated INSERT could produce a row the check
would refuse.

An unreadable source refuses with its own code and never reads as absence — a
404 for a database outage would tell an operator their recommendation is gone.
