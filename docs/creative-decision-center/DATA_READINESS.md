# Data Readiness

Status: framework plus known risks. A 2026-07-18 SELECT-only repeatable-read
audit covers the current active+enabled Meta-bound population (12 businesses,
13 physical accounts, 14,748 fixed Ad identities). That audit proves current
replay coverage and release-gate consistency, not causal lift, provider-write
readiness, or the required post-deploy natural scheduler wave.

Known facts to preserve unless repo evidence proves otherwise:

- V3 input now carries `ctr`, `cpm`, `frequency`, `firstSeenAt`, `firstSpendAt`, `spend24h`, `impressions24h`, `reviewStatus`, `disapprovalReason`, and `limitedReason` where warehouse rows expose them.
- `fix_delivery`, `fix_policy`, and `watch_launch` remain proof-gated: they may emit only when those fields are present and the bridge can map the server-produced diagnostic badge.
- If required data is missing, fallback to `diagnose_data` or cap confidence.
- Stale source evidence caps confidence and disables execution readiness, but
  it must not hide mature severe stop-loss `cut` decisions. Stale scale remains
  blocked because scale depends on fresh recent-hold proof.
- `brief_variation` requires family grouping / supply / backlog / winner gap data and should be aggregate only.
- Native Cut spend-unit readiness may use a 90-day physical-account/currency
  AOV only when at least 20 cutoff-safe canonical revenue-backed purchases and
  zero malformed/conflicting canonical facts are proven. Campaign/ad-set
  context is not required for that scalar; it remains required for peer
  percentiles and cannot be borrowed into Scale or Refresh.
- Non-null Ad `finalized_at` is required for strict physical-account AOV,
  source-currency, and source-timezone evidence. Peer calibration instead
  retains the existing exact Ad/campaign/ad-set `FINALIZED`/`PASSED` hierarchy
  contract with cutoff-safe created/updated timestamps; null legacy Ad
  `finalized_at` is quality-counted and cannot enter strict account evidence.
- Historical Lane B can review formulas only from finalized/passed daily facts.
  It is not exact production parity when original availability, current SCD0,
  campaign-role, or exact optimization-cell evidence was not retained. Missing
  exact cells remain an explicit coverage gap rather than being replaced by an
  account-wide cell.
- Decision copy has currency authority only when the latest cutoff-safe
  finalized/passed daily source currency is carried into the canonical input.
  Mutable provider-account currency is a current-run fallback only when source
  currency is absent; it cannot overwrite retained source identity. Historical
  replay uses source currency and the latest admitted source-date timezone
  only. Missing currency may still support unitless decision math, but
  presentation must say account currency rather than guess USD or a symbol.
- Demo decisions are fixed synthetic review evidence, not live coverage. The
  committed fixture must match the current engine epoch and the complete demo
  source-row manifest; any drift makes the whole demo canonical inventory
  unavailable. Demo output never proves provider execution readiness.
- Warehouse entity rows, recommendation payloads, and synthetic IDs are
  discovery evidence only. Provider execution additionally needs an explicit
  origin contract and a fresh exact provider GET proving ID, account,
  creative, status/policy, and parent hierarchy. Missing or contradictory live
  proof makes the action review-only.
- Creatives metadata sync is presentation enrichment, not daily decision truth.
  It writes dedicated creative daily/dimension/media tables and may not insert
  or update any `meta_ad_daily` row or timestamp. Authoritative ingest strips
  creative-media/preview/debug-media keys before persisting the Ad-day payload
  while retaining decision metrics and must explicitly declare
  `writeMode: "authoritative_fact"`; omitted authority fails before DB access.
  Creative-media retention cleanup likewise never touches `meta_ad_daily`; it
  prunes only dedicated presentation/media storage.
- Replay calibration restatements are not generic ignore buckets. The two
  `profile_availability_restatement` classes permit only a forward
  calibration-only Test More-to-Keep maturity change or the exact
  native-calibration-missing soft profile to an ordinary non-hard result.
  `calibration_restatement` additionally permits a calibration-evidence-only
  change when both projections are ordinary non-hard Keep/Test More and retain
  the same action-semantic tuple. Every class requires hash-bound production
  reproduction of both projection/input/context envelopes, unchanged
  identity/input/data health/context, and no hard, `cut_candidate`, or pending
  artifact. `calibration_restatement` additionally requires no blocker,
  authorization, or hysteresis. Arbitrary label/reason/context changes remain
  semantic drift.
- Provider mutation plus complete live verification is not sufficient for a
  successful receipt. Every unsafe-to-terminalize native decision-origin row
  stays pending with common error code
  `provider_verification_persistence_failed`, a separate exact outcome
  (`provider_outcome_ambiguous`,
  `provider_response_succeeded_verification_failed`,
  `provider_write_verified_receipt_persistence_failed`,
  `provider_rejection_terminal_persistence_failed`,
  `pre_provider_terminal_persistence_failed`, or
  `dry_run_terminal_persistence_failed`), reconciliation required, and retry
  forbidden. Pending rows emit no immutable operator-action receipt and are
  treatment-ineligible. Same- and different-key attempts for that exact Ad are
  blocked until exact reconciliation.
- Manual and native Ad status writes share one exact
  business/provider-account/Ad transactional claim. Its all-origin pending
  guard has no TTL, new manual rows persist exact provider-account identity,
  and a legacy null-account manual pending row blocks the same business/Ad
  fail-closed. Native same-key/different-key semantics retain typed
  `action_in_flight` and
  `decision_origin_pending_reconciliation_required`; cross-origin and
  manual/manual losers receive typed `action_in_flight` with blocking
  log/origin identity. Native batches still require an all-target initial
  preflight. Both manual and native status writes rerun exact live preflight
  after claim and immediately before each provider POST; a blocked manual claim
  is completed as a DB-only failure. No conflict or failed post-claim
  preflight performs provider mutation, and bulk halts that item and the
  remainder.
- Launchpad multi-create recovery is not data-ready for automatic POST retry.
  Until provider idempotency and durable per-attempt receipts exist, create and
  duplicate POSTs run once; only GET verification may retry. Rebuild-creative
  remains review-only.

## Buyer Actions

| action | requiredData | currentlyAvailable | whereAvailable | missingFields | likelyDataSource | safeFallbackIfMissing | canMVPEmit | confidenceImpact |
|---|---|---|---|---|---|---|---|---|
| scale | spend, purchases, CPA/ROAS, valid target or benchmark, truth, maturity | partial | V1/V2 metrics, commercial truth partial | action-specific target anchor, timestamp provenance, attribution quality | business target config, snapshot trust | test_more / diagnose_data | conditional | target age has no confidence impact; missing/invalid authority fails closed |
| cut | mature spend, trusted commercial spend unit, CPA/ROAS vs valid break-even, no recovery, truth | partial | V1/V2 metrics plus native account/currency AOV receipt | action-specific break-even anchor, maturity, timestamp/account/currency/schema provenance | commercial truth, finalized canonical ad facts, historical windows | diagnose_data | conditional | target age has no confidence impact; no hard cut without maturity/valid truth; peer P25 is optional only for the break-even-capped commercial stop-loss path; thin exact-cell AOV may be replaced only for Cut sizing by a >=20-purchase physical-account proof |
| refresh | CTR/CPM/frequency trend, fatigue proof, winner context | partial | V1 fatigue/historical windows | explicit `ctr`, `cpm`, `frequency` trend fields in V2 input | historical feature enrichment | test_more / diagnose_data | conditional | single-metric fatigue is low confidence |
| protect | stable winner, adequate history, no blockers | partial | V1 lifecycle/operator, V2 Protect | freshness/target context | V1/V2 + trust | test_more / diagnose_data | conditional | cap if benchmark weak |
| test_more | low maturity/insufficient signal | yes/partial | V1/V2/scoring | none critical | current metrics | diagnose_data if stale | yes | safe default |
| watch_launch | firstSeenAt/firstSpendAt/launch age, early spend/purchase | partial | V3 input from warehouse/lifecycle + latest Meta row | complete first-spend coverage where warehouse lacks it | Meta ad created_time + earliest spend insight | diagnose_data | conditional | emitted only with explicit launch basis |
| fix_delivery | active ad/campaign/adset + 24h no spend/impressions | partial | V3 input from latest daily warehouse row | campaign/adset active status still partial | Meta ad/adset/campaign status + latest daily insights | diagnose_data | conditional | must not emit without spend/impression proof |
| fix_policy | review/effective status + disapproval/limited reason | partial | V3 input from effective status + payload review/reason fields | Meta review fields depend on payload availability | Meta ad/ad creative review fields | diagnose_data | conditional | must not emit without policy/review proof |
| diagnose_data | missing required data, stale data, truth issue | partial | trust/provenance/snapshot | per-row freshness and missingData summary | snapshot/source health | diagnose_data | yes | honest fallback |

## Aggregate Actions

| action | requiredData | currentlyAvailable | whereAvailable | missingFields | likelyDataSource | safeFallbackIfMissing | canMVPEmit | confidenceImpact |
|---|---|---|---|---|---|---|---|---|
| brief_variation | family winner/fatigue, no backup, backlog/supply | partial/no | V1 family/supply plan partial | backlog, production status, backup variants | creative ops data + V1 family | disable aggregate | conditional/low | high false positive risk |
| creative_supply_warning | creative supply/backlog/winner gap | no | unknown | backlog, recent launches, production state | planning/ops system | disable aggregate | no | cannot be confident |
| winner_gap | winner cadence window + historical snapshot window | no/partial | historical snapshots if available | fresh persisted decision snapshots | historical decision snapshots | disable aggregate | no until derived | avoid fake supply alarm |
| fatigue_cluster | top N fatigue proof | partial | V1 fatigue/historical metrics | top N definition, trend fields | feature enrichment | disable/low confidence | conditional | composite proof required |
| unused_approved_creatives | explicit approved review status + no delivery | no/partial | `meta_creative_daily` aggregate when review/approval status proof and zero lifetime delivery proof exist | explicit review-status enrichment is still sparse; active effective status is not enough | Meta review status + lifetime insights | suppress aggregate | conditional | must not infer from spend alone, active status alone, or missing status proof |
