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
- Recent-edit authority is RECEIPT-BACKED, ATTEMPT-BOUND, and evaluated under a
  single knowledge bound shared by the change window and the evidence.
  `meta_campaign_config_history` / `meta_adset_config_history` are
  transition-only, a COMPLETE receipt commits BEFORE
  `append_current_config_history`, and an observation run's `row_count` is the
  FULL logical provider scope on the complete lane — delta runs included. A
  purchase-budget hard action therefore requires, together:
  (a) ONE bound: current day = `min(evaluationNow, provider-local day end)`,
      completed historical day = its own day end, future provider-local day =
      unavailable; strict `<` on every clock, applied to the config-history
      window and to all receipt/run/entity clocks alike;
  (b) the newest receipt at/before that bound, selected WITHOUT filtering on
      status, being `complete` with no error;
  (c) its `sync_run_id` resolving to a terminal `succeeded` `meta_sync_runs` row
      whose finish is STRICTLY before the bound and whose lifecycle contains the
      receipt occurrence, on a matching partition/business/account that was not
      dead-lettered. Legacy null links hold;
  (d) base manifest count == run `row_count` == receipt `providerRowCount` on
      BOTH lanes, verified BEFORE any tombstone is applied, so one legitimate
      deletion cannot invalidate every surviving member. Explicit
      `explicit_deleted` / `explicit_not_found` exits are applied afterwards and
      are superseded by a coalesced re-observation at the receipt occurrence
      clock; `absent_unconfirmed` removes membership; partial and point_lookup
      rows never enter delta reconstruction;
  (e) freshness measured from `observedAt` to the bound.
  Receipt occurrence identity includes `sync_run_id`, so two attempts at one
  millisecond append two receipts and the newest exact attempt governs, while an
  exact retry stays idempotent. A bounded, self-terminating current-day
  bootstrap lets an already-covered account write its first linked receipt.
  A complete, succeeded attempt that saw the entity and recorded zero
  transitions is a known no-edit result and still permits the action.
  Diagnostic, watch and test decisions are unaffected.
  @see `lib/meta/recent-edit-authority.ts`
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
- A persisted exact-Ad authorization is not current execution readiness. The
  served row must also prove the shared 12-hour exact-decision clock, current
  engine epoch, global/business kill-switch posture, and the existence of a
  persisted business automation control. Only then may it offer a control that
  still performs the live provider preflight on submit. Missing controls block
  writes without suppressing decision evidence; recommendation-snapshot age may
  not stand in for exact-decision age.
- Current execution readiness also requires a fresh scoped successful sync, a
  finalized and validated Ad-day through the account-timezone expected cutoff,
  an admitting live DB growth fence, and a valid complete native generation
  manifest. These are separately displayed pipeline-health dimensions. A cron
  invocation or worker heartbeat is not proof of durable success; missing or
  unreadable health is review-only, and the write boundary repeats the check.
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
  authorization, or hysteresis — or, since D091, an IDENTICAL held verdict on
  both sides (same pre-authority label, blocked action and blocker,
  `authorizedAction` null on both). A hold on only one side, or a changed held
  action or blocker, is still semantic drift, and a held verdict is still
  excluded from both `profile_availability_restatement` classes. Arbitrary
  label/reason/context changes remain semantic drift.
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
- Entity observation storage is delta-bounded for the complete lane (D075):
  physical state writes are changed + new + scope-exited entities plus one
  run row, never full scope size. Legacy/full runs keep exact run-bound
  manifests; delta runs reconstruct latest-per-entity over the complete lane
  with explicit `absent` rows, and their hydration completeness bar is the
  reconstructed present count equal to logical `row_count`. Non-complete
  lanes remain full-manifest and are a known residual amplification source.
  Consumer sweep (2026-08-30): every state-history reader is inventoried
  with a verdict in `docs/audits/D075_STATE_HISTORY_CONSUMER_SWEEP_2026-08-30.md`
  and guarded by `state-history-consumer-closure.test.ts`; absence evidence
  serves NULL (never `DELETED`, never a resurrected status) on every
  serving surface, history transitions span present rows only, window-end
  truth is certified by `confirmed_until` (run heartbeat + later delta
  manifests, cutoff-capped; monotonic under replay, deterministic-winner
  and endpoint-scoped supersession per acceptance correction 1), and
  operational verification counts delta membership by reconstruction.

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

**Amended by D091 — read this with the `cut` row above.** That row's
"action-specific break-even anchor" was written while an explicit break-even
ROAS was a required Cut input. It no longer is: Cut is anchored by a commercial
ratio of EITHER kind. What the row's "trusted commercial spend unit" now means
is `Meta platform AOV / Target ROAS` where a Target ROAS exists, and a legacy
Target CPA only where one does not; a Shopify AOV is never that unit. An
explicit break-even still defines the bounded P25-to-break-even economic strip
(`cut-policy.hasExplicitBreakEven`), so where it is absent the Cut is anchored
but the strip does not exist — which is also what "break-even-capped commercial
stop-loss path" in that row now refers to.

## Aggregate Actions

| action | requiredData | currentlyAvailable | whereAvailable | missingFields | likelyDataSource | safeFallbackIfMissing | canMVPEmit | confidenceImpact |
|---|---|---|---|---|---|---|---|---|
| brief_variation | family winner/fatigue, no backup, backlog/supply | partial/no | V1 family/supply plan partial | backlog, production status, backup variants | creative ops data + V1 family | disable aggregate | conditional/low | high false positive risk |
| creative_supply_warning | creative supply/backlog/winner gap | no | unknown | backlog, recent launches, production state | planning/ops system | disable aggregate | no | cannot be confident |
| winner_gap | winner cadence window + historical snapshot window | no/partial | historical snapshots if available | fresh persisted decision snapshots | historical decision snapshots | disable aggregate | no until derived | avoid fake supply alarm |
| fatigue_cluster | top N fatigue proof | partial | V1 fatigue/historical metrics | top N definition, trend fields | feature enrichment | disable/low confidence | conditional | composite proof required |
| unused_approved_creatives | explicit approved review status + no delivery | no/partial | `meta_creative_daily` aggregate when review/approval status proof and zero lifetime delivery proof exist | explicit review-status enrichment is still sparse; active effective status is not enough | Meta review status + lifetime insights | suppress aggregate | conditional | must not infer from spend alone, active status alone, or missing status proof |

## H11B campaign-context lifecycle evidence (D076, 2026-08-29)

- Frozen bundle for IwaStore, Grandmix, Bilsem Zeka, TheSwaf, IwaTR,
  ColorFullWorldsTR: `generated/h11b-context-lifecycle-bundle-2026-07-13-
  to-2026-08-22.json`, bundleHash
  `58de78a12a15681ee51de1049f6463971d12231090dad33cd5c72586c5651b91`
  (SELECT-only; labels included strictly as the frozen offline comparator).
- New retained evidence usable by resolver challengers: complete-lane
  campaign/ad-set entity-state history (status, budgets, structure) exists
  ONLY from 2026-07-13, and every source stops at 2026-08-22 (ingestion
  halted at the storage fence). Lifecycle-family features are therefore
  nullable by contract; when absent, their weight stays unallocated and the
  other family weights are not increased.
- Label truth remains sparse and stamp-dated: 57 labels across five of the
  six businesses (IwaTR: zero), only 7 Test labels, of which 5 describe
  tests concluded before any observable anchor. Test recall against running
  behavior is currently NOT measurable; do not cite a Test-recall number
  from this window as evidence of anything.
- D076 gate verdict on this evidence: REJECT (v2 stays compiled; see
  DECISION_LOG § D076 and H11B_CONTEXT_LIFECYCLE_CHALLENGER_2026-06-15_TO_
  2026-08-22.md).

## D077 growth-fence recovery readiness (2026-08-30)

- Verified offender: `meta_entity_state_history` at 5,368,750,080 bytes —
  40,960 bytes over the 5 GiB ceiling — stopped all Meta observation
  writes 2026-08-22 14:53 UTC. Heap 2.684 GB / indexes 2.685 GB; 4.24M
  live rows; complete lane 4,024,264 rows, partial 215,500.
- Frozen census: 3,449,571 complete-lane rows (85.7%) sit in
  byte-identical consecutive duplicate manifests (six businesses:
  1,774,467); 160,477 rows are lineage-FK-pinned (row-level lower bound on
  exclusions). The EXACT removable count after whole-run + interleave
  exclusion is UNKNOWN pending an operator-approved low-traffic planner
  dry-run; no row-level subtraction may be quoted as removable.
- Byte semantics: DELETE alone never clears the raw-size fence. The fence
  now governs this table by effective size (raw − proven reusable heap
  free space, pgstattuple_approx, fail-closed to raw); pgstattuple is NOT
  installed in production, so the effective metric is inert there until
  the operator's `CREATE EXTENSION`. Physical byte return (REINDEX
  CONCURRENTLY / pg_repack) is a separate approval-gated operator step.
- Recovery pipeline state (all operator decisions, nothing executed):
  1) install pgstattuple; 2) low-traffic planner dry-run (SELECT-only,
  read-only-transaction enforced); 3) approve + execute the compaction
  (CLI only; journal-leased; never scheduled); 4) routine vacuum converts
  deletions to proven free space → effective metric re-admits;
  5) optional physical shrink for raw-size return; 6) deploy D075 or the
  reclaimed space refills at the measured ~0.89 GiB/4-day rate.
- Hardening (2026-08-30): the dry-run is one REPEATABLE READ READ ONLY
  transaction (planner-enforced); execution is gated by an authoritative
  pre-write re-plan (exact payload equality, zero writes on any mismatch —
  the approval token is acknowledgement, not authenticity); plans carry
  per-reason protection counts (overlapping pin families, non-additive);
  and the business Automation page renders the readiness facts
  display-only (business-scoped journal with explicit read provenance —
  an unreadable journal is UNKNOWN, never "not executed"; measured D075
  writer evidence as observed/not_observed/unknown; planned reclaim
  honestly unknown without an operator artifact). Per-reason protection
  counts include the exact measured multi-endpoint exclusion, with
  fail-closed run- and row-level count reconciliation.

## D074b vocabulary closure (2026-08-30)

- Active runtime, readiness contracts, API projections, and buyer UI now
  speak only the canonical automatic-role vocabulary
  (`campaignRoleStatus: resolved|unresolved|no_campaign`,
  `campaign_context_unresolved`, `automatic_campaign_context_authority`,
  `role_unresolved`, `waiting_on_role_resolution`,
  `campaign_role_unresolved`, `campaign_role_status_drift`,
  `requireResolvedCampaignRole`). No buyer-facing copy requests a label.
- Legacy names (`campaignLabelStatus`, `label_status`,
  `unlabeled_campaign_context`, `unlabeled_campaign_soft_only`,
  `missing_campaign_label`, `waiting_on_labels`, `campaign_label_missing`,
  `campaign_label_status_drift`, `requireCampaignLabel`) survive ONLY as
  deprecated type members and parse-time recognition, normalized at
  `lib/creative-decision-engine/campaign-label-guard.ts` /
  `lib/meta/campaign-label-guard.ts`. They can never grant authority:
  after the 2026-08-30 acceptance corrections the fold is fail-closed
  (legacy-only `labeled` → unresolved; missing status → unresolved;
  canonical/legacy contradiction → unresolved; the `requireCampaignLabel`
  guardrail alias is tighten-only), kind display/CTAs require canonical
  resolved status at every serving layer, Launchpad opens are refused for
  every card until a validated launch-authority contract exists, and the
  closure guard enforces a per-file per-token exact-count ledger across
  app/components/lib/scripts.
- Migration plan: after one deployed release whose persisted snapshots all
  carry canonical names, a follow-up may drop the deprecated members and
  parse arms (grep production payload samples first, per D074b).

## D079 commercial spend-unit anchor readiness (2026-08-31)

> **Amended by D091 — read this before the section.** The owner input a
> hard action now needs is a RATIO, not a money amount. With a Target ROAS
> configured, the average order value it divides is an account fact the
> warehouse does supply — Meta's own attributed purchase AOV — so no CPA and no
> AOV needs to be typed. The "Required input" bullets below carry the
> superseded wording struck in place, and the two-case split that replaced it.

~~The hard-action threshold gate needs an owner-supplied economic anchor that
the warehouse cannot supply.~~ **[SUPERSEDED BY D091: it needs an owner-supplied
RATIO — a Target ROAS, or a break-even ROAS for Cut — plus a Meta platform AOV
the warehouse supplies. The only case still needing an owner-supplied money
amount is an account with no Target ROAS at all, where a legacy Target CPA is
the anchor.]** On the accepted generalized PIT evidence
(`56f4472b…`), 1,872 of 1,993 held hard-action signals (93.93%) carry the
persisted first blocker `profile_hard_action_ineligible`, every one of them
running on `account_baseline` or `account_baseline_thin`.

**That persisted value is a first-blocker FAMILY, not a commercial-threshold
verdict.** It also covers a below-floor scale calibration, an unverifiable
target provenance, an insufficient sampled AOV, and a missing per-action ROAS
anchor. A real profile with a configured Target CPA can satisfy the commercial
threshold and still land in this family through Scale calibration alone. Only a
canonical per-action code (`commercial_anchor_missing`,
`break_even_roas_missing`, `target_roas_missing`,
`scale_calibration_below_floor`, `commercial_anchor_sample_insufficient`,
`commercial_anchor_provenance_unverified`) may be read as a specific cause.

Required input, per business, on `business_target_pack_history`:

- ~~`target_cpa` (positive), OR `aov_assumption` (positive) together with
  `target_roas` (positive);~~ **SUPERSEDED BY D091 — this is a TWO-CASE SPLIT,
  not a precedence list.**
  - **WITH `target_roas` (positive):** the ONLY hard basis is the canonical
    Meta platform AOV divided by that ratio. `target_cpa` and `aov_assumption`
    are read from the same target pack, are CARRIED AS EVIDENCE, and choose
    nothing — neither outranks the platform AOV and neither is a fallback when
    it is absent. Verified in `resolveSpendUnit` CASE 1
    (`lib/creative-decision-engine/spend-unit-resolver.ts`) and
    `buildNativeAdSpendUnitAuthority` CASE 1
    (`lib/creative-decision-engine/jobs/ad-calibration-job.ts`); the executable
    proof is `__tests__/canonical-meta-aov-permutations.test.ts`
    ("with a target ROAS, the platform AOV outranks every operator input").
  - **WITHOUT `target_roas`:** nothing can divide an average order value, so
    legacy Target-CPA compatibility applies unchanged — a positive `target_cpa`
    is taken whole (`target_cpa`, high confidence, hard-eligible).
  - `aov_assumption` establishes NO rung in either case: `operator_aov` only
    ever built `aov_assumption / target_roas`, which CASE 1 now owns, so it is
    a RETIRED rung — readable for persisted rows, never minted again. Same for
    `observed_shopify_aov`.
  - An earlier D091 amendment in this bullet said `target_cpa` was "still taken
    whole where it exists" and that `aov_assumption` with `target_roas` "still
    ranks ahead of the account's own AOV". Both are superseded by the split
    above; neither was true of the shipped resolver.
- a verifiable `effective_at` provenance stamp — an unverifiable timestamp
  demotes the anchor rather than being trusted;
- `target_roas` additionally for Scale. **`break_even_roas` is no longer
  required for Cut (D091)**: a commercial ratio of either kind anchors it. An
  explicit break-even is still what defines the bounded
  P25-to-break-even economic strip, so where it is absent the Cut is anchored
  but the strip does not exist.

What is required INSTEAD, and it is an account fact rather than an owner input:
a usable Meta platform AOV (Meta attributed purchase revenue over its purchase
count, ≥20 cutoff-safe purchases). Where it is absent the authority holds
explicitly as `commercial_spend_unit_authority_missing`. A Shopify AOV is
diagnostic evidence and never substitutes for it — and since the Round 4
hashing correction it is excluded from HASHED IDENTITY as well: native
authority `.v3` keeps `observedShopifyAovEvidence` out of `authorityHash`, the
generation content and the cell input manifest, and canonical evaluation `.v6`
/ Native-Ad evaluation `.v8` stopped hashing the three Shopify evidence members
and the `observed_shopify_aov_*` warnings. The evidence is still carried and
still served; it just moves no hash.

State at the time of writing [verified from the frozen evidence, not
re-queried]: all five configured packs had `target_cpa`, `break_even_cpa` and
`aov_assumption` null; IwaTR had no pack. Nothing in this slice supplies those
values — they are owner economics, and no real target was written for any
business.

Not readiness for action, and not even readiness for the whole hard-action
set: the threshold gate is common, but ~~Cut additionally needs a break-even
ROAS and~~ **[SUPERSEDED BY D091: Cut additionally needs a commercial ratio of
EITHER kind — `cutAnchorEligible = targetPackAuthoritative && (breakEvenAnchored
|| targetRoasAnchored)` in `resolveHardActionEligibility`,
`lib/creative-decision-engine/account-decision-profile.ts`; the native
equivalent is `hasCommercialTargetAuthority` in
`lib/creative-decision-engine/jobs/ad-calibration-job.ts`]** Scale additionally
needs a Target ROAS plus a calibration sample.

The replay figures immediately below were produced under the PRE-D091 rule and
are kept as recorded. `break_even_roas_missing` is still a live blocker code,
but its trigger changed: it is now emitted only when NEITHER a break-even ROAS
nor a Target ROAS anchors the pack (or the pack's provenance is unverifiable),
not merely when break-even is absent. Do not re-derive a current expectation
from these counts.

Under illustrative candidates for four businesses the corrected per-action
replay clears 50 rows, all Refresh; every held Cut stays withheld (1,355 on
`break_even_roas_missing`, 149 on `commercial_anchor_missing`). Campaign
context, freshness, calibration, governance and the automation gates remain
untouched, and all 121 signals that reached those later gates in the accepted
replay were blocked there.

Bitemporal caveat for any replay against this evidence: every frozen target
pack was RECORDED on 2026-07-14 or later while decision origins begin
2025-03-02. A pack must be resolved by `effectiveAt` AND `recordedAt`; resolving
by effective date alone applies values the system could not have known.

### Replay partition (D079 correction 2)

Every per-action replay row and total must partition completely:

```text
heldBefore = eligibleAfter + blockedByEffectiveProfileCodeTotal
           + blockedNoCandidate + blockedNotDeterminable
           + blockedByCampaignContext + blockedByRecentRecoveryUnverifiable
           + blockedByOtherIndependentGate
```

`blockedAfterTotal = heldBefore - eligibleAfter` is the only field that may be
read as the blocked population; it is 1,993 at the no-anchor baseline. Exact
per-action independent-gate counts on the accepted evidence:

| action | held | campaign context | recovery |
|---|---|---|---|
| Scale | 8 | 8 | 0 |
| Cut | 1,925 | 86 | 26 |
| Refresh | 60 | 1 | 0 |
| total | 1,993 | 95 | 26 |
## D091 — `meta_ad_daily.link_clicks` is not being ingested, and it gates fatigue

Measured read-only on 2026-09-07:

| month | rows | `link_clicks` NULL | `link_clicks` > 0 |
|---|---|---|---|
| 2026-03 | 13,182 | 0 | 7,666 |
| 2026-04 | 11,722 | 0 | 7,219 |
| 2026-05 | 13,751 | 0 | 738 |
| 2026-06 | 14,540 | 0 | 2,676 |
| 2026-07 | 16,452 | 0 | 58 |
| 2026-08 | 11,948 | 5,676 | 0 |
| 2026-09 | 2,327 | 2,327 | 0 |

The column is populated all-time (122,825 positive rows since 2024-03-19), so
this is an ingestion regression that began degrading in May 2026 and went fully
NULL in August, not a column that was never written.

CONSEQUENCE, and it is deliberate. The native ad-grain lifecycle evidence
contract requires a CTR + click-to-purchase composite over equal disjoint 14/14
windows. Click-to-purchase has no denominator anywhere in the current decision
window, so the contract fails closed to `fatigueStatus: "unknown"` and **no
native ad can be labelled fatigued until the ingestion is repaired**. A Refresh
is openly HELD — visible, with its reason, authorizing nothing. It is not
silently absent.

At the 2026-09-06 cutoff the OTHER half is real: of 873 ads in the 28-day
window, 465 have spend and 467 have impressions and clicks in BOTH 14-day
bands, and all 13 provider accounts clear the account-wide frequency floor of
eight observations (largest 193). Only the link-click denominator is missing.

Repairing it is out of scope here and is the single highest-value follow-up for
Refresh: it is the one input standing between a held Refresh and an authorized
one.

## Meta-attributed AOV readiness governs the commercial anchor (D092)

The canonical spend unit needs BOTH halves: the ratio from the business target
pack and the average order value from Meta's own attributed purchases. The AOV
half has a readiness bar (`classifyMetaAovQuality`: `unavailable` under 1
purchase, `unstable` under 5, `low_sample` under 20, `ready` at 20+), and only
`ready` supplies an authoritative unit.

An account that has typed a Target ROAS but whose Meta purchase sample is not
ready is HELD, not substituted. It does not fall back to a typed Target CPA:
taking the CPA there would mint a hard-action grant on an account where Meta
attributed no usable purchases at all, reporting an absence as an anchor.

**CORRECTED (Round 5).** This section used to end "the maturity floor falls
back to the legacy CPA ladder in that state, which is a gate rather than a
basis." That was describing the defect, not the rule. The maturity floor is
sized from the SAME unit the threshold it admits is sized from, so a floor
built from a CPA while the unit came from the AOV/ROAS ratio gave one account
two answers to "what is a purchase worth". `metaLossBudgetMaturity` now returns
`null` whenever a positive Target ROAS exists and no ready Meta AOV does — the
hold is total. The legacy `breakEvenCpa ?? targetCpa ?? accountCpa` ladder
applies ONLY where there is no positive Target ROAS, which is the compatibility
case D091 preserves.

Readiness is therefore a data-readiness fact with authority consequences, and it
is read from one place. `metaLossBudgetMaturity`, `metaCanonicalSpendUnit` and
`resolveSpendUnit` all call the same classifier so that none of them can claim a
unit another would refuse to build.

## Current authority vs historical record

> **Current authority vs historical record.** Which table a decision taken today
> may read, and which is retained only so a past decision can be explained, are
> listed once in
> [`CONTRACTS.md` → *Current authority vs historical record — the tables*](./CONTRACTS.md#current-authority-vs-historical-record--the-tables).
> A value from the retained list may EXPLAIN a decision and may never GRANT one.
