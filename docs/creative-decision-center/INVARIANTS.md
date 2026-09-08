# Invariants

These rules are hard gates for V2.1.

## Required Invariants

- UI must not compute `buyerAction`.
- Meta Decisions must never present legacy `diagnose_data` as an Act Now buyer
  action. Its server projection is `decisionState: blocked`,
  `buyerAction: null`, and a non-null versioned resolution.
- UI must not derive a blocked resolution from free-form reason text, raw
  labels, badges, or metrics. It renders the server-produced resolution.
- Persisted `diagnose` remains readable for historical compatibility; a
  presentation change must not rewrite old snapshots.
- Any held Scale, Cut, or Refresh signal must round-trip through nullable
  snapshot `blocked_action_type`; consumers must not recover it by parsing
  free-form reason text.
- A non-null `blocked_action_type` must serve as `decisionState: blocked`,
  `buyerAction: null`, a server-produced resolution, and a held-action label.
  It must never inherit an affirmative soft label such as `Continue Test` from
  the published compatibility label, and it never grants provider authority.
- A blocked, held, review-only, or action-ineligible canonical decision must
  not map to any Launchpad mode. In particular, a held Cut with compatibility
  label `test_more` must never appear as `Fresh Test`.
- Provider-money copy must use the canonical account currency. Missing currency
  must not silently become USD, `$`, TRY, or EUR; presentation may say
  account currency without changing the underlying numeric decision.
- Demo decisions are committed synthetic review evidence only. They must use
  `demo_synthetic_review_only`, null authorized action, false action
  eligibility, and false exact-Ad execution eligibility. Demo businesses have
  zero Meta write authority even if a presentation defect supplies an action.
- Demo fixture validation is all-or-nothing across current epoch, business,
  physical account, complete source manifest, item hashes, identities, count,
  and generation hash. Runtime must not recompute demo decisions or query live
  native-decision persistence.
- Known `test_more`, `keep`, `refresh`, funnel, and out-of-scope states must not
  fall through to a generic "Cannot Assess" assessment.
- Exact-ad candidate caps must run after server state/action classification and
  must preserve representation for every non-empty Act Now, Needs Resolution,
  and Monitoring lane.
- Creative decisions with ambiguous multi-ad identity remain withheld until an
  ad-grain producer exists; they must never be attached to an arbitrary ad.
- No row-level `brief_variation`.
- No `fix_delivery` without active status + no spend/impression proof.
- No `fix_policy` without review/effective/disapproval/limited proof.
- No high-confidence scale/cut on stale data.
- Stale source evidence must not terminally hide a severe mature stop-loss cut;
  it must surface as `stale_evidence` with capped confidence and review-only
  actionability.
- Stale source evidence must hard-veto scale because scale requires fresh
  recent-hold proof.
- Freshness may block execution authority but must not erase a severe stop-loss
  verdict. There is no second 7-day label cliff: the source freshness boundary
  caps confidence and serves the held action as review-only.
- No hard cut for new launch unless maturity threshold is met or severe-loss rule is explicit.
- No high-confidence scale when benchmark/target is missing.
- A configured commercial target with cutoff-safe timestamp provenance does
  not lose authority because of age. Crossing the 30-day review interval must
  not change its target, confidence, Scale/Cut label, actionability, authority
  blocker, or provider-write eligibility.
- Target age may be displayed as advisory metadata only. Engine adapters,
  read models, routes, and UI must not apply an age-based decision transform.
- A valid configured target must never be silently replaced by account P75/P60
  because of age. Pooled native calibration remains soft-only and may be used
  only for a genuine missing/invalid authority path, never an elapsed-time
  path.
- A thin exact native-Ad optimization cell may borrow a same-account pooled
  purchase cell only for soft ranking, with at least 10 mature Ads and a finite
  P60. Pooled calibration can never authorize `scale`, `cut`, or `refresh`.
- A configured commercial target with an unknown/invalid update time remains
  provenance-unsafe and must not be confused with an old but valid timestamp.
- UI surfaces consume the server-produced decision and may render target age;
  they must not compute a 30-day boundary or alter buyer action from it.
- New decisions must persist the ordered authority trail:
  `pre_authority_label` (post-semantic, pre-authority), first
  `authority_blocker`, post-authority `raw_label`, then published `label`.
  A hard pre-authority label is evidence only and can never grant execution.
- The first effective authority blocker must be preserved when later gates add
  restrictions. Historical null provenance is unknown and must not be inferred
  from reason text, badges, raw label, or published label.
- Any change to canonical decision provenance, reason/hash semantics, or
  authority ordering requires a new versioned producer/evaluation contract;
  old snapshots remain readable under their original version key.
- Hysteresis may delay entry into `scale`, `cut`, or `refresh`, but it must
  never republish an earlier hard action after the current guarded decision has
  exited to a soft, blocked, or not-applicable state. A pending hard transition
  must publish a non-hard label with `blockedActionType` provenance and an
  explicit no-action reason; label, reason, badges, and served action must not
  form a hybrid decision.
- Creative fatigue requires either valid exposure pressure or benchmark-relative
  weakening in addition to performance decay. Performance decay without that
  evidence belongs to lifecycle/performance state, not fatigue. A recent
  floor-clearing period that is non-declining versus its older comparison
  period must not be labeled `fatigued`.
- Frequency pressure must be account-relative (28-day creative P75 with at
  least eight observations). A global frequency cliff or a creative's own
  single-row percentile must not authorize fatigue.
- When recent14 exists, creative fatigue decay must use the directly preceding
  disjoint prior14 period. Overlapping cumulative rates are not a substitute.
- A funnel rate must be materially weak relative to the account distribution,
  not merely epsilon-below P25. Landing/checkout evidence remains secondary
  when `ROAS / target_ROAS >= 0.85`; it must not erase a Keep or Winner verdict.
- Every funnel percentile must clear its own metric sample floor. Sample depth
  from CTR must not authorize a sparse downstream conversion-rate percentile.
- Quality-only confidence is information-monotone: adding a compatible scored
  component cannot reduce confidence. Unscored denominators must not enter the
  confidence aggregate.
- Messaging/conversation optimization is not post-engagement. Until dedicated
  conversation totals and calibration exist, unrelated post-engagement metrics
  must never authorize messaging scale or cut.
- Cut maturity must use commercial loss-budget spend, not winner-pool purchase depth.
- A calibrated relative Cut requires its declared ROAS-ratio sample floor and
  positive account P25. The region below the minimum of P25 and explicit
  break-even preserves legacy behavior. Only the strip from a lower P25 (or
  existing uncalibrated fallback) up to but excluding explicit break-even may
  extend Cut authority, and only with canonical maturity plus sufficiently
  sampled recent ROAS below break-even. Missing/thin recent evidence holds the
  pre-authority Cut; recent ROAS equal to or above break-even recovers to Keep.
- Native action readiness must record whether authority came from
  `calibrated_relative`, `calibrated_relative_with_economic_stop_loss`, or
  `commercial_stop_loss`. Pooled, non-purchase, invalid-anchor, or
  lineage-unsafe cells cannot use either economic stop-loss path.
- `calibrated_relative` Cut authority is legacy-region only. The P25-to-
  break-even strip requires hash-bound expanded-economic capability backed by
  either canonical exact-cell CPA evidence at the retained sample floor or a
  valid account/currency spend receipt. An unrelated account-AOV contradiction
  cannot revoke a sample-backed legacy P25 Cut, and it cannot authorize a
  P25-null Cut.
- `expandedEconomicCutAuthority?.eligible === undefined` preserves the
  canonical non-native D063 strip and is not an authority denial. Native
  profiles must carry the hash-bound field explicitly; only native
  `eligible: false` denotes denial. Consumers must not collapse absent
  non-native metadata into false.
- Thin exact-cell AOV remains untrusted. Cut may instead size its commercial
  loss budget from a cutoff-safe 90-day physical-account/currency AOV proof
  with at least 20 canonical revenue-backed purchases. That proof cannot supply
  peer percentiles, winner benchmarks, Scale authority, Refresh authority, or
  confidence.
- When physical-account AOV repairs a canonically Cut-ineligible cell, its
  Cut-only thresholds are the complete spend authority. A lower threshold from
  the untrusted canonical cell cannot be restored through `min(canonical,
account)`; the repaired Cut must wait for the trusted account-AOV floor. Once
that floor is met inside the expanded economic strip, missing/thin recent
evidence must preserve the repaired pre-authority Cut and hold it with
`recent_recovery_unverifiable`; only confirmed recent recovery may restore the
canonical non-Cut profile.
- A physical-account AOV proof must bind one business/account/currency and its
  target-authority hash. Malformed canonical metrics, fractional conversions,
  purchase/revenue contradictions, currency mismatch, conflicting duplicate
  ad-day facts, unsupported future schema, cutoff-unsafe facts, or a forged
  hash fail closed. Malformed/conflicting rows inside the cutoff-safe finalized
  candidate set remain in the evidence manifest even when excluded from the
  AOV numerator; cutoff-unsafe rows are never admitted as historical evidence.
- The non-null `finalized_at` requirement belongs to strict physical-account
  AOV/currency/timezone evidence only. Peer calibration retains an exact Ad only
  when the Ad and same-day campaign/ad-set facts are all `FINALIZED`/`PASSED`,
  hierarchy identity is complete, and created/updated timestamps are cutoff-
  safe. A null legacy Ad `finalized_at` is quality-counted but does not censor
  that peer observation; it can never enter strict account-AOV authority.
- A cross-business or cross-provider calibration source binding is
  transaction-fatal. A missing/mixed/mismatched currency is contained to its
  physical account as a manifest-bound complete zero-cell generation with
  blocked spend authority; it must not abort healthy sibling accounts, borrow
  mutable currency as decision truth, or leave an older same-day batch serving.
- Account-AOV thresholds may be consumed only by below-break-even Cut paths.
  They must not add a Cut or manual-Cut badge above explicit break-even, and
  kind-aware selection must preserve kind-specific Scale/Refresh authority.
- The bounded P25-to-break-even economic strip may cross the generic `0.85`
  target-band boundary. Refresh keeps precedence, but target-band Keep must not
  terminate a below-break-even row before the economic Cut/recovery/evidence
  branch runs. If native expanded-zone authority is unavailable, Keep remains
  fail-closed but its reason and badges must still say `below breakeven` and
  `stop-loss review`; it must never claim the row is above break-even.
- Purchase-cohort cumulative count, purchase value, and ROAS must agree on
  whether purchase truth exists. When recent spend is positive and both recent
  count and ROAS are present, those facts must agree too. Either contradiction
  fails closed as `diagnose` with `tracking_anomaly` before any hard action.
- **A CONTRADICTION NEEDS TWO OBSERVATIONS THAT DISAGREE (D091).** An absent
  figure is not a contradictory one, and a `tracking_anomaly` is a claim about
  an integration that must not be raised from an absence. A measured zero spend
  with no purchase and no purchase value is the complete and correct
  description of an ad that did not run: its ROAS is `0 / 0`, undefined by
  arithmetic, which is neither missing nor wrong. Such a row is diagnosed by
  the delivery gate, never by the tracking gate. Measured on 2026-09-07, this
  invariant's absence put "Verify pixel/CAPI purchase count, value, and ROAS
  aggregation before acting" on 5,230 of 11,438 native ad rows — the single
  largest reason in the account set — and every one of the 5,230 carried
  `spend = 0` AND `purchases = 0`. The suppression is bounded to a MEASURED
  zero spend: an unknown spend could hide real delivery, and the anomaly still
  fires whenever money left the account.
- An advisory `cut_candidate` is still Cut semantics: when explicit break-even
  exists it may appear only below break-even, never at or above it.
- Historical decision behavior must be tested before live accrual when retained
  evidence can reconstruct it. Frozen production-function acceptance and a
  fixed-cohort paired replay are release gates; the natural scheduler wave is
  only production orchestration, persistence, and lineage proof.
- A restated historical Lane B is formula-sensitivity review only. It must
  admit only finalized/passed daily facts, preserve actual source timestamps
  and exclusions in its hash-bound proof, require the requested exact
  calibration cell, and never invent mutable current SCD0 or account-wide
  fallback authority.
- Historical D036 state must be keyed by the resolved production profile scope
  and advanced by every available daily decision. Outcome cooldown may sample
  rows for scoring, but it must not skip intervening decisions or turn a first
  hard signal into a false confirmation.
- Historical Cut precision counts only published final Cut. Recall counts a
  future loser as an opportunity only when its pre-decision spend already met
  the fixed production commercial-maturity threshold.
- Scale spend maturity must use the same commercial loss-budget spend as cut.
- Scale must additionally require purchase depth and recent performance hold;
  commercial spend maturity alone must not emit `scale`.
- Hard scale must additionally require account winner-benchmark readiness:
  calibration sample ready and positive winner purchase benchmark.
- A scale-zone creative blocked by spend, purchase, recent hold, or benchmark
  readiness remains a near-scale `keep` decision and must not be displayed as a
  healthy no-op row.
- Raw `scale` decisions downgraded by soft-only hard-action eligibility must
  keep a scale-readiness badge so UI lane mapping remains server-driven.
- A `scale` verdict and the executable primary action are separate contracts:
  the resolver owns the verdict; the server-side briefing adapter owns the
  campaign-kind-aware action label.
- Test campaign scale may show `Promote to main`; Main campaign scale must show
  a scale/budget action, not `Promote to main`; Mixed campaign scale must ask
  for structure review before execution.
- UI fallback logic must not map generic `scale` to `Promote to main` unless the
  card has explicit `campaignKind === "test"`.
- `hardCut` multipliers are severe-loss / scaled-loss thresholds, not the
  generic maturity gate.
- Policy and delivery blockers override performance.
- Campaign/adset paused must not become `fix_delivery`.
- Unknown delivery status must not be treated as active delivery or increase
  hard-action authority; it resolves as an explicit data blocker.
- Missing required data must produce `diagnose_data` or confidence cap.
- Aggregate decisions must not attach to a random `creativeId`.
- Same input/config/version must produce deterministic output.
- No hard-coded thresholds scattered inside resolver.
- Budget scale requires a valid explicit target ROAS; break-even alone must not
  be multiplied into a synthetic growth target.
- A hard action requires a commercial ratio of EITHER kind — an explicit target
  ROAS or an explicit break-even ROAS. **Amended by D091**: this previously read
  "Economic cut requires a valid explicit break-even ROAS", which refused a Cut
  on an account configured with a target ROAS alone. Nothing in the native
  computation consumed break-even to reach that refusal: every spend-unit lane
  takes an explicit Target CPA whole or divides a canonical AOV by the Target
  ROAS, and the relative Cut boundary is itself a Target-ROAS ratio. The
  prohibition it was protecting stands unchanged and is restated below: a target
  ROAS is still never multiplied into a synthetic loss boundary, and an explicit
  break-even remains the only thing that defines the bounded economic strip.
  Where no break-even exists, the strip does not exist either — the Cut is
  anchored, not widened.
- Account-relative curve grading must never cut an ad at or above valid explicit
  break-even. When explicit break-even is above account P25, only the bounded
  `P25 <= ratio < break-even` economic-loss strip may widen Cut candidacy, and
  only after existing Refresh precedence, canonical Cut maturity, and
  sufficient recent evidence below break-even. Legacy below-P25 behavior must
  remain unchanged.
- A campaign-kind classifier that failed its own locked segmentation gate must
  not define downstream account calibration cells. Shadow context is not
  calibration authority.
- A controlled-causal payload must not grant automation authority by naming an
  experiment or assignment. The assignment, control estimate, and unique
  treatment receipt must each reconcile to durable server-side records; absent
  registries mean a zero eligible causal sample.
- Annual/month seasonality must not be estimated from less than one complete
  annual cycle. Weekday sensitivity may be tested separately on dated facts.
- A multi-country ad must remain a spend-share vector. It must not be assigned
  to a single majority country, and sparse country cells must fall back to the
  account-goal parent without increasing confidence or action authority.
- A historical country mix may use only the latest generation observed by that
  decision's producer cutoff. Retained `fetched_at` and `created_at` must both
  be at or before the cutoff; an incomplete or invalid latest generation fails
  closed and may not fall back to an older generation.
- Native ad decisions must use parallel `engine_v3_ad_decision_*` authority
  tables and a distinct job/engine epoch. A version predicate on a shared
  creative table is not rollback isolation.
- Native ad identity is `(business, provider account, entity type, ad ID,
scope, engine epoch)`. Nullable `creative_id` is grouping evidence only and
  must never own hysteresis, pruning, snapshot uniqueness, or change events.
- A native snapshot must have an immutable evaluation whose tenant, account,
  entity, date, scope, input hash, and decision hash all match. Missing schema
  capability or any broken link rolls back all native authority writes.
- Native calibration readiness is isolated per account/cell. Missing or
  evidence-unready cells persist explicit `diagnose` snapshots with
  `native_calibration_unavailable`, zero hard-action eligibility, and null
  calibration lineage; they must not abort or prune unrelated ready ads.
- A ready native snapshot must reference its exact native calibration UUID.
  Legacy creative calibration and lifecycle rows may not substitute for
  missing native calibration authority. Invalid batch/replacement lineage is
  transaction-fatal rather than a soft fallback.
- Present-day assigned ads without insights may be emitted only with explicit
  unobserved-metric provenance and a non-hard fail-close result. Historical
  `asOf` hydration must never import a dimension-only ad from current state.
- Optional Meta event metrics remain null when no source payload key was
  observed. Source absence must not be converted to a measured zero.
- Creative/Ads `scale` and `cut` hard eligibility follow the same action-specific
  ROAS anchors. A valid target CPA may size evidence but cannot authorize either
  ROAS action by itself.
- A dated Structure snapshot must use the target version visible at its exact
  producer cutoff. A persisted spend-changing recommendation must be rechecked
  against current commercial validity when served; deleted, missing,
  provenance-unsafe, or objective-incompatible authority is review-only with
  no proposed mutation. Age alone cannot demote it.
- A purchase target must not authorize CPL, cost-per-ATC, CPC, or engagement
  spend changes. Until goal-specific commercial anchors exist, those relative
  Structure candidates are review-only even when their cohort rank is strong.
- Loss maturity is the maximum of account-calibrated hard-cut spend and the
  CPA baseline times explicit risk posture. Currency-specific absolute floors
  must not grant or withhold decision authority.
- Positive-spend creative rows spanning more than one provider account,
  campaign, ad set, optimization context, objective, or funnel cohort are
  `out_of_scope` until an ad-grain producer exists. Majority-spend context
  selection is forbidden.
- Structure history must use disjoint reconstructed time bands. Nested
  cumulative windows cannot count as independent confirmations.
- A durable terminal raw cursor (`nextPageUrl = null`) ends fetch. It must not
  restart page one, and post-fetch checkpoint progression is based on the
  partition-global `last_page_index + 1`, never generation length.
- Structure maturity must be bounded by observed first delivery, distinct
  active days, and as-of calendar age; a window label never proves age.
- Structure peer baselines must not cross provider account, currency, funnel
  intent, campaign lane, or incompatible bid/optimization contexts.
- Historical target reads require both effective-time and recorded-time cutoff.
  Mutable current targets must not be projected backward, and pre-history
  remains unknown. Date-only decision replay uses the scheduled 03:00Z producer
  cutoff; same-day target versions recorded later cannot enter that decision.
- Raw snapshot PIT reconstruction must select the latest exact-day generation
  at cutoff without falling back to an older complete generation. Missing
  scopes or identities remain `unknown`, never `pass`.
- Kind-aware baseline selection must be all-or-nothing per decision: a decision
  uses either a kind-selected profile view or the canonical `all` profile, never
  a mixed per-gate blend.
- Kind-aware selection must fall back to canonical baselines when required
  kind calibration fields are null or the kind mature pool is too small.
- Automatic-context uncertainty must use canonical baselines and preserve the
  mathematical Scale/Cut/Refresh verdict as review-only. It must not require a
  manual label or authorize a provider write. Explicit user overrides retain
  priority; inferred kind semantics require the separate authority gate.
- A provisional automatic campaign role derived from persisted resolver scores
  is presentation-only. It must not replace a null resolver kind in evaluation
  inputs, select a kind-specific calibration cell, trigger Test semantics,
  increase confidence, or authorize a provider write.
- A current campaign missing from the daily context source still receives a
  presentation-only automatic role from shared resolver name tokens, then a
  provisional Main fallback. It remains Unknown-confidence, cannot enter
  evaluation inputs, and cannot authorize a provider write.
- Structure inventory may contain every account-scoped campaign and ad set,
  with optional delivery-status and decision filters, but action authority is
  limited to hierarchy rows whose current served status is exactly `ACTIVE`.
  `WITH_ISSUES`, closed, or unknown rows have zero provider-write authority. An
  active ad set under a non-active campaign is also non-actionable. Historical
  range status cannot establish action authority; an unavailable current-status
  reconciliation fails closed as `UNKNOWN`. Inventory visibility must never be
  treated as recommendation or execution eligibility.
- Budget utilization must use the actual evidence-window day count. A selected
  or 30-day spend total must not be divided by a hard-coded 28-day constant.
- Meta budget and currency-formatted bid values are provider minor units.
  Utilization math and UI display must convert them to major units; provider
  write payloads retain the original integer minor-unit contract.
- Sparse Mixed campaign buckets fall back to canonical `all`; they must not be
  inferred from Main or Test buckets.
- Test-cohort `refresh` to `cut` transformation must execute inside
  `finalizeDecision` before `applySoftOnlyLabel`; running it later misses
  refresh emissions already downgraded to `keep`.
- `labelTransform` must be preserved on the final `DecisionOutput` even if the
  transformed label is subsequently downgraded by hard-action eligibility.
- Snapshot persistence may store `labelTransform` only as nullable audit data;
  downstream consumers must not recompute or override decision labels from it.
- Test-cohort semantic transformation applies only to explicit
  `campaignKind === "test"` inputs. Main, Mixed, and unlabeled creatives keep
  their existing refresh semantics.
- Resolver gate files remain responsible for resolver math only; label semantic
  transforms belong in the `finalizeDecision` pipeline orchestrator.
- Native Ad job attempts exist outside the work transaction. A rollback or
  process death must remain visible as failed or stale-running evidence.
- The latest effective native attempt is ranked across engine versions. A
  newer foreign-epoch success or failure cannot expose an older current-epoch
  generation as authoritative.
- `authority_blocker IS NOT NULL` always implies
  `authorized_action IS NULL`; a hard pre-authority or raw label is audit data,
  never execution authority.
- A hysteresis-suppressed hard raw label has no `authorized_action`. Its soft
  published label must carry matching `blocked_action_type` and
  `pending_transition` provenance.
- Full commercial-truth replacement is one transaction guarded by a
  deterministic revision compare-and-swap and per-business transaction lock.
  No section may commit independently.
- Historical exact-Ad backtests are keyed to an explicitly selected engine
  version. Current-version defaults must not make prior immutable epochs
  unreadable or pool multiple epochs.
- A fixed-cohort replay claiming current production parity must rebuild the
  challenger profile through the production native profile grouping/resolver
  against the cutoff-bound challenger calibration generation. A rollback-
  epoch persisted profile is baseline evidence only; selectively patching its
  stale eligibility is not a production replay. Frozen Ad metrics, campaign
  context, data health, identity lineage, and epoch-scoped hysteresis remain
  anchored. Replay currency and timezone come only from cutoff-bound immutable
  source facts; current provider SCD0 drift is audit evidence, not a replay
  input.
- Replay calibration restatements are proof-bound to production output. Both
  projections, resolved inputs, and resolved campaign contexts must reproduce
  through production functions and their proof hashes. The two forward-only
  `profile_availability_restatement` classes are ready collecting Test More to
  Keep under calibration-only maturity, or precise
  `native_calibration_missing` soft-only to ordinary non-hard Keep/Test More
  with zero hard-action eligibility. `calibration_restatement` is a third safe
  class only when both sides are ordinary non-hard Keep/Test More with the same
  action-semantic tuple and only calibration-profile evidence changed. All
  classes require unchanged exact identity, input, data health, and campaign
  context, and no hard label, `cut_candidate`, or pending-transition artifact.
  `calibration_restatement` additionally requires null blocker/blocked
  action/authorization and no hysteresis. Reason/badge drift is safe only when
  production-reproduced from that calibration-only change; arbitrary
  label/reason/context drift remains semantic drift.
- Creatives metadata enrichment writes only dedicated creative
  daily/dimension/media presentation storage and must leave every byte and
  timestamp of `meta_ad_daily` unchanged. Omitted, unknown, and
  non-authoritative daily-fact write modes fail closed before DB access;
  authoritative insights sync is the sole owner of fact insertion and
  truth-version mutation and must explicitly declare that mode. Authoritative ingest
  recursively strips creative-media/preview/debug-media keys before persisting
  `payload_json`, while preserving decision metrics. Creative-media retention
  cleanup excludes `meta_ad_daily` and may never mutate or delete an Ad-day
  fact or timestamp.
- Every Meta provider mutation declares exactly one explicit action origin.
  Native decision, manual operator, and Launchpad manual envelopes are
  non-overlapping; optional field presence cannot infer an origin and mixed
  lineage fails closed.
- Native provider execution requires the exact provider action derived from the
  persisted authorized action: Cut authorizes only `pause`, Scale authorizes
  only `resume`, and null never authorizes either. A matching decision label
  without this exact action tuple fails closed.
- A native decision-action idempotency key is reconstructed from the immutable
  business/account/Ad/snapshot/evaluation/epoch/hash/action/mode tuple. A
  caller-selected different key fails before receipt or provider reads.
  Request, persisted source, and fresh provider state must also carry the same
  non-empty creative ID; nullable legacy creative grouping is review-only.
  A duplicate-success receipt/log must bind the same creative ID, and an exact
  mismatch is an idempotency conflict.
- Manual and native Ad status claim creation shares one exact
  business/account/Ad transaction lock and an indefinite all-origin unresolved
  guard. Pending status rows are part of that guard. New manual claims persist
  exact provider account identity; a legacy manual pending row with null
  account still blocks the same business/Ad
  fail-closed. A concurrent native same-key loser returns typed HTTP 409 with
  the existing pending idempotency receipt and `action_in_flight`; an existing
  reconciliation marker instead returns its non-retryable reconciliation
  state. A native different-key loser returns typed HTTP 409 with
  `decision_origin_pending_reconciliation_required`. Cross-origin and
  manual/manual losers return typed `action_in_flight` with blocking log/origin
  identity. Direct and bulk status routes must not preempt this classifier with
  a native-only pending shortcut or an age-window guard. Every variant performs
  zero provider POSTs.
- A live manual terminal `silent_failure/provider_outcome_ambiguous` remains an
  unresolved status claim. Until exact reconciliation, it blocks every later
  manual or native claim for the same business/physical-account/Ad with
  `meta_ad_status_reconciliation_required`, `reconciliationRequired: true`,
  and `retryAllowed: false`; terminal status does not authorize a retry. A
  dry-run silent failure carries no provider-mutation ambiguity and does not
  create this live hold.
- Every new execute-mode manual pause/resume claim must persist one exact
  business/account/Ad/creative/campaign/ad-set mutation target and the
  `meta-manual-ad-status-mutation-attempt.v1` contract. Before its sole provider
  POST, the adapter completes fresh hierarchy/status/policy/write-block checks
  and supplies the exact six-field baseline to the route hook. Only an exact
  durable-target match appends one immutable, hash-bound `attempt_started`
  event with a two-minute lease and exact slashless Ad path. A received result
  appends one exact `attempt_completed` event before terminalization. The event
  geometry permits exactly one no-retry POST and one of verified success,
  successful-response/verification-failed, definite failure, or ambiguous
  outcome. An unexpected throw may leave only the started event and pending
  source; it never authorizes a second POST. Start must equal the claim's
  durable journal target, and an existing reconciliation event makes every
  late start or completion invalid at both store and database-trigger layers.
  Event creation time is database-canonical; completed-attempt reconciliation
  rejects evidence observed before the durable completion event.
- A journal-required live manual status source may terminalize only with its
  matching completion geometry: verified success for success, ambiguous or
  verification-failed provider success for `silent_failure`, and definite
  rejection for failure. The only no-attempt failure lane is a closed,
  explicitly non-mutation post-claim/start/adapter-abort/bulk-abort proof.
  Generic completion may not bypass the same database guard. Protected source
  identity, journal target/contract, and terminal fields remain immutable even
  after the row is terminal; attempt/reconciliation events are append-only.
- Direct and bulk status routes run the same reconciliation preflight before a
  new claim or provider write. No provider GET occurs before the generic
  settlement floor: completed plus five minutes, started lease plus five
  minutes, journaled no-start claim plus five minutes, or exact legacy
  pre-contract source plus seven days. Legacy eligibility additionally requires
  exactly one database-resolved hierarchy; it is not a business exception.
- A settled reconciliation requires a fresh bounded provider read that exactly
  matches account, Ad, creative, campaign, ad set, configured/effective state,
  active parents, and policy eligibility. Under the shared advisory key it
  revalidates the unchanged source and appends one immutable, evidence-hashed
  `meta-manual-ad-status-reconciliation.v1` event. Its resolution is only
  `current_state_matches_requested` or
  `current_state_matches_precondition`; it does not rewrite history or invent
  old-attempt success. Missing, multiple, contradictory, stale, or uncertain
  evidence fails closed with zero provider POSTs.
- After reconciliation, an incoming request whose desired state already equals
  the exact observed configured/effective state is a verified no-op with no new
  claim. A different desired state must create a fresh exact claim and repeat
  all normal post-claim/journal checks. No timeout-only deletion, provider
  mutation, firm-specific bypass, or mutable overwrite may clear the hold.
- A present `dryRun` field is a JSON boolean or the request fails closed before
  receipt/provider work. String, numeric, null, or other truthy coercion can
  never silently select execute mode.
- Warehouse rows, legacy recommendations, synthetic IDs, and client claims do
  not prove execution identity. Fresh provider GET evidence must bind exact
  returned ID/account/creative/status/policy and required parent hierarchy
  immediately before mutation. Manual and native Ad status execution must
  repeat this preflight after its durable claim; native ignores only its own
  pending receipt. A manual post-claim failure is terminalized DB-only and
  never reaches provider mutation.
- Before every manual item POST, bulk execution must reread complete provider
  state and the exact unresolved claim owner. The state must retain the durable
  account/Ad/creative/campaign/ad-set target and the source must still be that
  same pending claim. Concurrent reconciliation or ownership change stops the
  current and remaining items with no additional POST and does not rewrite an
  earlier completed item as rolled back. Every untouched later prepared claim
  is then terminalized DB-only; cleanup uncertainty is
  reconciliation-required.
- A manual verified status success is
  `meta-ad-status-write-verification.v1`: unchanged account, Ad, creative,
  campaign, and ad-set identity across the immediate pre-POST baseline and
  fresh post-POST read; requested configured/effective Ad state; ACTIVE
  configured/effective parents; policy eligibility; null review blocker;
  observation time; and raw provider GET evidence. Store and database validate
  the payload against the immutable attempt target/action. Missing or drifting
  evidence cannot terminalize as success. GET and the sole POST are each
  30-second bounded; mutation redirects are rejected, and the POST is never
  retried. Terminal persistence retries reuse one frozen identical fact.
- Every newly finalized provider-verified native pause/resume receipt must
  hash-bind the immutable source creative/campaign/ad-set IDs and the verified
  provider-account/creative/campaign/ad-set IDs. Verified identities must equal
  their source/episode counterparts; a hash or lineage contradiction fails
  closed.
- A pre-lineage immutable receipt may retain
  `verification_lineage = NULL` only as additive migration compatibility. Its
  canonical hash omits the absent property exactly as the old contract did;
  readers must not synthesize parent identity, reinterpret the null as new live
  proof, or require a historical hash rewrite.
- Every native unsafe-to-terminalize outcome must leave the same decision-origin
  attempt pending with common error code
  `provider_verification_persistence_failed`,
  `reconciliation_required = true`, and `retry_allowed = false`. Its exact
  outcome is one of `provider_outcome_ambiguous`,
  `provider_response_succeeded_verification_failed`,
  `provider_write_verified_receipt_persistence_failed`,
  `provider_rejection_terminal_persistence_failed`,
  `pre_provider_terminal_persistence_failed`, or
  `dry_run_terminal_persistence_failed`. The marker must not claim mutation
  attempted, succeeded, or ambiguous beyond that outcome's known evidence.
  Readers treat missing or outcome-inconsistent marker booleans as unknown and
  never synthesize provider-mutation success.
- A pending reconciliation row emits no immutable operator-action receipt,
  never becomes treatment-eligible, and authorizes no same- or different-key
  provider POST. Captured provider/verification evidence is reconciliation
  evidence, not success or provider-verified authority; only exact
  reconciliation may terminally finalize the attempt.
- Bulk and multi-create flows must complete all exact target, pending-action,
  live-state, and cardinality preflights before the first provider write. Native
  bulk status must additionally rerun the post-claim preflight immediately
  before each item POST; a later failure stops that item and all remaining work
  without claiming rollback of already completed items.
- Provider create/duplicate POSTs must not retry without provider idempotency
  bound to durable per-attempt receipts. GET-only verification may use bounded
  retry.
- Persisted exact-Ad decision authorization and serve-time execution readiness
  are different facts. `sourceAuthority.actionEligible` records only the former.
  A provider/Launchpad control may be offered only when server-owned
  `executionReadiness` is exactly `live_preflight_required`; an absent value is
  review-only. That value still requires the existing live provider preflight on
  submit and must never be labelled executable now.
- Exact native decision freshness uses the same 12-hour ceiling in presentation
  and mutation preflight. Missing, unparsable, future beyond one minute, or old
  timestamps fail closed. Recommendation snapshot age, warehouse sync age,
  exact-decision age, and provider observation age may not substitute for one
  another in UI copy or authority checks.
- Missing or unreadable persisted business automation controls block every Meta
  write but do not hide decision evidence. Global and business kill switches
  must be reflected in server-owned execution readiness and independently
  repeated at the write boundary.
- Exact-decision freshness, successful durable sync activity, finalized
  warehouse cutoff, live DB admission, and generation-manifest integrity are
  separate facts. A provider or Launchpad control requires all of them through
  the server-owned pipeline-health contract. Missing legacy health is
  unavailable, not healthy; a scheduler invocation or worker heartbeat may not
  stand in for durable success. The decision-origin write boundary must re-read
  this evidence and reject `source_pipeline_unready` before provider mutation.
- A live manual duplicate persists exact preparation and start authority before
  its one create POST. Only a structured, non-transient and non-retryable 4xx
  Meta rejection with literal JSON `is_transient: false` is a definite
  duplicate-create failure; missing, null, or string transient flags are
  ambiguous. Network exceptions, HTTP 408/425/429, 5xx, transient/retryable
  errors, and a 2xx response without exact result identity remain ambiguous
  external action results and keep the claim retry-blocking. An unverified 2xx
  completion may carry a resulting Ad id only when it exactly equals the
  nonblank top-level provider response id. A received successful 2xx remains a
  truthful
  `provider_response_received` mutation receipt; missing identity is recorded
  separately as `provider_response_succeeded_verification_failed`. Neither
  unresolved geometry can terminalize as a definite release. Duplicate
  attempt, reconciliation, and provider-read observation facts are append-only
  and exact-lineage bound.
- A pre-contract legacy duplicate `failure` that lacks complete current
  journal and physical-account authority remains retry-blocking without a time
  release. Older failure classification is not negative provider finality.
  Current-contract journaled definite rejections remain retryable.
- The migrated database rejects pre-contract live manual duplicate inserts
  before provider work. An older application rollback therefore fails this
  write surface closed instead of bypassing the journal. Only the current
  canonical non-mutating dry-run envelope is exempt; an older pre-contract
  dry-run may also fail closed. UPDATE cannot create or reshape a contractless
  live manual duplicate envelope.
- A settled unknown-id duplicate may reconcile success only after a token-free
  cursor traversal completes one physical-account Ads cycle with exactly one
  cumulative marker/name/account/ad-set/creative/PAUSED match and an exact
  point GET of that Ad. A partial scan cannot authorize success. Absence,
  multiple matches, pagination failure/cycle, identity drift, missing
  credentials, or persistence uncertainty never releases the claim.
- A native decision-origin provider POST transport exception is an ambiguous
  external outcome and must remain pending as `provider_outcome_ambiguous`
  without an immutable operator-action receipt. Manual status actions retain
  terminal `silent_failure` action-log compatibility when a terminal fact is
  durably available; a journaled unexpected throw may instead remain pending
  with only its immutable start. Launchpad retains its separate terminal
  attempt-receipt contract. A fresh attempt identity cannot bypass an
  unresolved guard, and no timeout clears it without an immutable exact-state
  reconciliation event. For status mutations, a received HTTP rejection
  remains a definite failure when terminal persistence succeeds; the narrower
  duplicate-create classification above is the explicit exception.
- Manual action-log terminalization is a one-way `pending -> terminal`
  compare-and-set. An identical terminal replay is idempotent after JSONB
  normalization, but a different terminal outcome cannot overwrite committed
  success, failure, or `silent_failure`. A live raw adapter exception before
  the start hook is an exact DB-only zero-write failure; an exception after the
  immutable start remains pending and ambiguous without inventing mutation
  success. That exact-Ad claim blocks all later provider claims until the
  journal-backed exact-state reconciliation above. If verified success or
  another manual terminal outcome cannot be durably confirmed after the bounded
  identical retry, the route returns a typed `503`, stops remaining bulk work,
  and never writes a fallback failure.
- Launchpad accepts at most 20 creatives, 10 ad sets or targets, and 20 planned
  provider creates; intent storage and all provider work occur only after that
  bound passes. Manual bulk status accepts at most 20 exact Ads.
- `rebuild_creative` is review-only until every provider image, creative, and
  Ad step has an immutable attempt/result receipt and an ambiguity-safe recovery
  contract.
- Runtime campaign role has exactly one source: automatic account-scoped
  inference from `engine_v3_campaign_context_daily` (D074). No live route,
  decision producer, read model, or UI component may read or write
  `meta_campaign_labels` / `meta_campaign_label_history`; the historical tables
  are frozen evaluation/migration evidence and the static isolation guard
  (`lib/meta/__tests__/campaign-labels-isolation.test.ts`) enforces the
  boundary. There is no manual assignment or override path; resolver
  disagreement is evidence for a future versioned resolver, never a label.
- Campaign-role identity is `business + physical provider account + campaign +
  as-of date`. A context read that cannot prove provider-account scope returns
  no roles and every context-dependent hard action stays review-only. Rows
  with a null provider account can never be updated into runtime authority.
- High-trust campaign-role semantics require BOTH `confidenceClass = high` AND
  the exact resolver-version authority gate
  (`CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION` equal to the compiled
  resolver version). The gate defaults unset; an engine or env rollback may
  only narrow authority (`unknown` mode), never re-arm manual labels.
- Resolver challengers are versioned modules gated by a predeclared,
  frozen-before-validation promotion gate (D076). A challenger that fails
  its gate must NOT become the compiled default, must not bump the runtime
  version constant, and stays exercised only by its offline evaluation
  package and deterministic tests. The v3 lifecycle challenger is in this
  state: gate verdict REJECT (2026-08-29), v2 remains compiled. Missing
  challenger evidence (e.g. lifecycle features on scopes without status
  history) leaves that family's weight unallocated; other weights must not be
  increased — absence may lower confidence, never raise it.
- A complete observation where only K of N entities changed must persist a
  number of state rows bounded by K plus new plus scope-exited entities, never
  N (D075). `row_count` remains the logical full-scope count on every
  manifest kind; delta runs additionally persist their write statistics.
- Scope exit is explicit evidence: an entity leaving a complete scope
  persists a `presence: 'absent_unconfirmed'` row. Any as-of or
  reconstruction reader whose winning row for an entity is absent must
  exclude that entity — as absence, not as usable state and not as a
  confirmed deletion; an older `present` row must never be resurrected past
  a newer absent row. Serving corollaries (2026-08-30 consumer sweep): an
  absent winner serves a NULL status (never a fabricated `DELETED`, which
  is reserved for explicit tombstones), status-transition feeds compare
  present rows only, and status-recovery callers skip non-present winners.
- Window-end truth for an unchanged entity is certified by its
  re-confirmation clock (`confirmed_until`): the row's own run heartbeat
  and later same-endpoint delta manifests while the row is still the
  complete-lane winner, with every input capped at the reader's cutoff. A
  state row's `captured_at` alone cannot certify a later instant, and a
  superseded row's confirmation never extends past its own evidence.
  Supersession follows the EXACT deterministic winner order
  `(captured_at DESC, created_at DESC, id DESC)` — an equal-captured
  tuple-loser never receives confirmation — and its authority is the
  row's own ENDPOINT scope: a sibling endpoint's rows neither supersede
  this endpoint's winner nor borrow its confirmation. The heartbeat
  clocks themselves are monotonic: an accepted older exact replay can
  never move `last_seen_at`/`last_captured_at` backward, so an
  established confirmation cannot be erased by replay.
- Operational verification of manifest membership is manifest-kind-aware:
  a delta run's membership is its reconstruction, never its run-bound
  physical rows.
- Manifest reconstruction for a delta run admits only complete-lane rows at
  or before the run's payload capture clock, restricted to runs of the
  source run's own endpoint — the writer's diff baseline uses the identical
  scope, so the two can never disagree on membership. Partial, failed, and
  point-lookup rows never reshape a complete manifest; legacy and `full`
  runs keep exact `run_id`-bound membership byte-for-byte.
- The heartbeat contract is manifest-kind-agnostic: a byte-identical complete
  payload coalesces into the latest complete run whether that run is legacy,
  `full`, or `delta`, and a replayed `run_hash` remains idempotent.
- The hydration completeness bar is preserved per kind: a delta run is
  `sourceComplete` only when its reconstructed present-member count equals
  its logical `row_count`; any mismatch stays fail-closed and
  non-authoritative, feeding the existing same-day rerun.

## D091 campaign-role authority, partial storage and degraded capture

- The CONSUMER of a campaign-context entry enforces both halves of high-trust
  itself: a `high` `contextTrust` presented beside `resolverAuthorityValidated:
  false`, or beside a non-`high` inference confidence class, is a CONTRADICTION
  and withholds authority. An absent optional provenance field is not a
  contradiction and does not withhold it.
- A held row keeps the engine's verdict. On the no-context circuit-breaker path
  too, it carries that verdict in `decisionLabel`, names it in operator copy and
  publishes it as `signalQuality.blocked_decision_label`. `diagnose` is written
  only where the canonical mapper has no typed verdict for the type at all —
  never as a replacement for one it does have — and the mapper's untyped
  `keep`/`test_more` fallback must never be stamped onto a held row.
- A PARTIAL observation run is NOT a manifest. It stores only the entities its
  payload positively observed whose content differed from the winner a reader
  already resolves, and it declares that explicitly:
  `delta_stats_json.manifestContract` is
  `d075.partial-observed-present-delta.v1`, against
  `d075.complete-scope-manifest.v1` on the complete lane. `manifest_kind`
  cannot carry the distinction — its CHECK admits only `full` and `delta` — so
  the discriminator is stamped rather than inferred. Its `row_count` is not a
  membership count, `exitedEntityCount` is structurally 0, it never writes an
  `absent_unconfirmed` row, and nothing may reconstruct a scope from it.
- A DEGRADED capture states what it lost. When a provider refuses a requested
  field, the receipt is `partial`, never `complete`; the affected column reports
  `degraded_not_observed` in field coverage — an explicit "not asked", never a
  measured absence — and a value the system had already observed is carried
  forward rather than overwritten with NULL. The carry is read-side, because
  `state_hash` is computed before the write and coalescing at INSERT time would
  put a row and its own hash out of agreement.
- **An UNUSABLE schedule value is an explicit unknown, and it does not inherit.**
  A `timestamptz` schedule the provider answered with a value that cannot be
  represented is validated BEFORE the write, not by PostgreSQL during it: the
  column is NULL and field coverage reports `invalid_not_retained`. That is a
  THIRD state, distinct from a measured absence (`true`/`false`) and from
  `degraded_not_observed`. The carry-forward lateral restores a prior value for
  `degraded_not_observed` and for nothing else, so an invalid row wins the
  as-of read on its own recency and resolves to unknown — a request that never
  asked leaves the last observed value standing; an answer that cannot be read
  contradicts it. Normalization happens before `state_hash` is computed, so the
  row and its own hash describe the same values. Measured: `'not-a-date'` and
  `''` both raise on cast, while `'99999-01-01'` is ACCEPTED and its ISO
  round-trip then raises "time zone displacement out of range" — so normalizing
  an out-of-range date would CREATE the abort it was meant to prevent.
- A field-degradation record must say whether the narrowing WORKED. Recording
  the dropped field names on a request that failed anyway attributes the
  provider's refusal to fields it never objected to, and that record is
  persisted into `meta_raw_snapshots.request_context.pagination`.
- A windowed diagnostic must not sum lifetime counters. An occurrence count
  scoped to a window is derived from the immutable per-capture receipts, and any
  field that remains lifetime says so in its own name.

## D091 presentation, direction and inventory

- **The decision lanes carry DECISIONS.** ACTIVE provider inventory that no
  producer has decided is not one. It must never be synthesised into a decision
  row, must never enter a lane, a lane count, a pre-cap count or the response
  cap, and must never carry a CTA. It is served as one count
  (`ads.pendingInventoryCount`) and one limitation sentence
  (`active_ad_inventory_pending_native_decision`), which the Creatives scope
  renders. Hiding the population is equally forbidden: it is a real
  source-health fact.
- **A capped-out decision is a decision.** The full identity universe of exact
  candidates must reach the presentation intact, so an entry omitted by the
  response cap is never counted as un-decided inventory. Any carrier for it
  must survive the route's own pipeline, including the `structuredClone` in
  `applyMetaExecutionGovernanceToReadModel`; a non-enumerable symbol does not.
- **A non-positive commercial target is the ABSENCE of a target.** A zero
  `effectiveTargetRoas` — which `truth_source = 'global_default'` persists, on
  6,365 of 11,438 native rows measured 2026-09-07 — must never be rendered as
  "vs 0.00 target", and no ratio may be measured against it. It is served as
  null and every consumer's existing no-target branch handles it.
- **ONE mapper owns directional semantics, and no prose is authority.** A
  recommendation type whose producer emits it only below the efficiency
  benchmark must never receive an affirmative Scale label, whatever its action
  text says and whatever an upstream stage wrote into `decisionLabel`. Direction
  is decided from the type and from explicit structured labels — never by
  matching English words, which a rewrite, a translation or a copy edit
  silently changes. A promotion minted FROM a defensive verdict is still
  defensive, and its `labelTransform.fromType` is the evidence.
- **No backend prose reaches an operator.** Producer reason strings, bracketed
  internal states and reason codes stay in the diagnostics panel that names
  them; the operator-facing sentence is buyer copy, and an unmapped code falls
  back to a written sentence rather than to itself.

## Metamorphic Tests

| Change                                              | Expected behavior                                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| dataFreshness becomes stale                         | stop-loss confidence is capped; mature severe losers may stay `cut`; scale is blocked               |
| benchmarkReliability strong -> weak                 | confidence goes down                                                                                |
| campaignStatus active -> paused                     | `fix_delivery` disappears                                                                           |
| reviewStatus -> disapproved                         | policy overrides performance                                                                        |
| launch age under threshold                          | hard scale/cut becomes `watch_launch` / `test_more` unless maturity threshold is met                |
| commercial target crosses 30-day review age         | target, confidence, label, and authority remain unchanged; advisory metadata may change             |
| commercial target timestamp missing                 | provenance fails closed; this is distinct from a valid old timestamp                                |
| only break-even ROAS becomes known                  | portfolio comparison may improve; campaign budget scale stays blocked                               |
| only target ROAS becomes known                      | target-relative context appears; the Cut is anchored on the target ROAS (D091), but the bounded economic strip stays absent without an explicit break-even |
| fresh break-even falls below account P25            | cut boundary narrows to break-even; legacy behavior below that safe boundary is unchanged           |
| fresh break-even rises above account P25            | only the below-break-even strip may become Cut; sufficient recent ROAS below break-even is required |
| expanded-strip recent evidence becomes missing/thin | pre-authority Cut is held with `recent_recovery_unverifiable`; no pending or authorized action      |
| expanded-strip recent ROAS reaches break-even       | Cut disappears; equality is economic recovery                                                       |
| creative reused in second ad set                    | aggregate action authority falls to out-of-scope; confidence must not increase                      |
| nested 30d window is added                          | independent Structure evidence count does not increase                                              |
| frequency 3.0, account P75 3.5                      | frequency does not establish fatigue pressure                                                       |
| future target version is inserted                   | earlier as-of replay remains byte-equivalent                                                        |

## Test Placement

TODO: Convert these into executable tests before resolver changes. Keep tests close to adapter/resolver contracts, not UI components.

## D077 state-history compaction

- The only deletable unit is a WHOLE complete run whose manifest signature
  is byte-identical to the immediately preceding complete run of the same
  (business, account, entity type, endpoint) scope, that is not the scope
  head, contains no FK-pinned row (one pinned row protects the entire run),
  and has no partial/point-lookup observation interleaved between it and
  its retained predecessor. Multi-endpoint scopes are excluded fail-closed.
- Every execution needs: a planner artifact whose canonical payload hash
  the executor RECOMPUTES, the approval token derived from that hash, and
  the on-the-record physical-shrink acknowledgement — which can never turn
  an `insufficient_evidence` plan into an executable one. An invalid
  attempt writes nothing, journal included.
- The fence's governing number for `meta_entity_state_history` is the
  effective size (raw minus PROVEN currently-reusable heap free space);
  every uncertainty — extension missing, malformed or inconsistent
  measurement — falls back to the raw size, and an invalid raw measurement
  is an explicit unavailable state that denies. Index bytes are always
  fully counted. No DELETE plan may ever be described as clearing the
  raw-size fence; physical byte return is a separate operator step.
- The executor is unreachable from app runtime and never scheduled (static
  guard); one executor owns the operation via an expiring journal lease;
  every batch fully revalidates scope/rows/signature/predecessor/pins/
  interleave in-transaction and rolls back on any mismatch; a completed
  plan never executes twice.
- Hardening (2026-08-30): the plan is built in ONE `REPEATABLE READ READ
  ONLY` transaction and the planner itself refuses weaker isolation — a
  multi-statement plan may never mix snapshots. The approval token is an
  operator acknowledgement of one exact planner artifact, never
  authenticity: before lease or any journal write, the executor re-derives
  the authoritative plan from the database and requires exact
  canonical-payload equality (scope, removable sets, all protection
  counts, timelines, fingerprint, fence, projection, insufficiency,
  status); any mismatch, re-derivation failure, weaker isolation, or
  non-ready authoritative status is a typed zero-write refusal. The
  equality gate binds first admission; resumes of an admitted plan keep
  the lease/fingerprint/per-batch proofs. Plans expose hash-bound
  `protectionsByReason` (head-duplicate, live-lineage, archived-lineage,
  response-event, interleave, and the exact measured multi-endpoint
  exclusion — wholesale, disjoint, never a boolean) whose pin families may
  overlap and are never additive — the union stays
  `pinnedRuns`/`pinnedRunRows`; internal inconsistency fail-closes the
  planner at BOTH run and ROW level (disjoint candidate reconciliation and
  pinned-union family bounds for runs and rows, per scope and totals, via
  the exported perturbation-tested validator), and removable rows are
  never derived by row-level pin subtraction. On the readiness surface,
  journal-read provenance is explicit: an unreadable journal is
  UNKNOWN_JOURNAL_UNAVAILABLE with its own blocker — never an empty array
  presented as NOT_EXECUTED; NOT_EXECUTED is asserted only from a
  successful empty business-scoped read. The readiness read model is
  business-scoped, measures D075 writer evidence from `manifest_kind`
  presence (observed/not_observed/unknown — never an asserted deployment
  claim, never converted to ready), and its UI consumers render
  server-owned facts display-only with no token or mutation affordance.

- D074b (acceptance-corrected 2026-08-30): the manual Test/Main label
  vocabulary is closed. Active writers emit only the canonical
  automatic-role names; the legacy names are deprecated type members and
  parse-time recognition at the documented compatibility boundary,
  normalized FAIL-CLOSED and never authority-bearing: only an
  uncontradicted canonical `campaignRoleStatus: "resolved"` grants role
  authority — legacy-only `labeled`, missing status, and canonical/legacy
  contradictions all resolve to unresolved, kind display and
  kind-conditional CTAs require resolved status at every serving layer,
  the `requireCampaignLabel` guardrail alias may only tighten, and no
  card can open Launchpad until a validated launch-authority contract
  exists. No buyer-facing surface may request a label OR describe saving/
  correcting one; unresolved automatic role is described as unresolved
  inference plus the evidence/refresh needed. The closure guard test
  enforces this statically with a per-file per-token exact-count ledger
  across app/components/lib/scripts (categorized frozen/parse-boundary
  entries only) plus emission, copy, and authority-matrix pins. The
  Decision Center compatibility row is provenance, never authority: its
  scale execution action may shape a card's current primary or filters
  only by exactly CONFIRMING the current unblocked Scale decision — the
  current label must be an eligible Scale (no held action, no authority
  blocker), the canonical role resolved with an agreeing kind, and the
  server-derived current primary must map to the same CTA. A resolved
  role never proves the row is current; a non-current scale row neither
  classifies a card nor suppresses its held/blocked state. The row feeds
  NO operator-visible current surface beyond that confirm-only primary:
  the Asset Library label cell, label filter, and CSV are
  current-projection-only (fail-closed to an explicit "Review" when no
  current server label exists), and the row's sole display site is the
  Evidence Drawer's explicitly non-authoritative compatibility-snapshot
  section (no composed buyerLabel/nextStep guidance; queue/apply shown
  as stored values conveying no current eligibility). Enforced at
  serialization and through the single gated client helper, and pinned
  leg-by-leg by the guard's precedence section plus the raw-row field
  census.

## D079 commercial spend-unit anchor

- A commercial anchor grants THRESHOLD eligibility only. Freshness, campaign
  context, calibration, governance, pipeline health, and the automation and
  provider-write gates stay independent; clearing an anchor restores the prior
  behaviour exactly.
- **Amended by D091 — the ladder is a TWO-CASE SPLIT, not a precedence list.**
  WITH a Target ROAS configured, the canonical hard-decision spend unit is the
  Meta platform attributed purchase AOV (attributed purchase revenue / purchases)
  divided by that Target ROAS — `meta_derived_aov` on the served path,
  `physical_account_purchase_aov_90d` on the native one. A configured Target
  CPA, an operator AOV assumption and the store's observed AOV are carried as
  evidence and change no basis. Where the platform AOV is absent or below the
  `ready` sample bar the authority HOLDS — it never falls back to the Target
  CPA or to another book.
  **Amended in Round 6 — the hold is TOTAL, and this passage used to say
  otherwise.** It read "only the never-hard-eligible soft rungs
  (`account_history`, `break_even_aov`) may still supply a threshold number",
  which described a fall-through the rule does not permit: `account_history` is
  the account's own median CPA and `break_even_aov` divides by a second ratio,
  so both are money-per-purchase units built from something other than ready
  Meta AOV on an account whose Target ROAS says only ready Meta AOV may answer.
  `hardEligibleByDefault: false` bounded the ACTION and left the ARITHMETIC —
  the spend unit, the maturity floor and every threshold derived from it —
  sized from the substituted number, and put it into the canonical hash.
  `resolveSpendUnit` now answers `insufficient` in the governed branch: with a
  positive Target ROAS the result is the READY unit or no unit at all. The two
  soft rungs remain reachable ONLY where there is no positive Target ROAS,
  which is the legacy compatibility case.
  WITH NO Target ROAS, nothing can divide an average order value, and legacy
  Target CPA compatibility is preserved exactly: `target_cpa`, high confidence,
  hard-eligible.
  `operator_aov` and `observed_shopify_aov` are RETIRED rungs — readable for
  persisted rows, never minted again; a persisted row naming one under a Target
  ROAS fails CLOSED. The served resolver and the native builder/validator
  implement ONE rule and must be changed together: if they disagree by a single
  rung the validator raises `native_target_authority_mismatch` and the whole
  native job rolls back, which is what took three accounts dark for a day.
  This supersedes the earlier D091 wording that kept a Target CPA and an
  operator AOV ahead of the platform AOV.
- **Shopify AOV is diagnostic evidence and nothing else (D091).** It may be
  carried and labelled as contextual, and it may never enter builder/validator
  agreement, outrank the Meta basis, size a hard action on any surface, or
  produce a provenance mismatch. A missing Meta AOV is never silently
  substituted by a store figure. This applies to the SERVED Decision Center
  path and the native producer path identically — the two surfaces must not
  disagree about what a Meta purchase is worth.
- **Evidence that chooses nothing must not move IDENTITY either (Round 4
  amendment to the bullet above).** Removing the store from the ladder fixed
  the arithmetic and left hashing alone, so a store-only change — observed,
  stale, unavailable, observed-with-zero-orders, or simply a different AOV —
  still moved `authorityHash`, `generationContentHash`, `inputManifestHash`,
  `cellSetHash` and `contextHash`. The rule is now: a field carried as
  contextual evidence is excluded from every hash minted under the current
  contract version, and the exclusion is version-scoped rather than
  retroactive. Native spend-unit authority `.v3` excludes
  `observedShopifyAovEvidence` from `authorityHash`, the generation content and
  the cell input manifest, and is stamped UNCONDITIONALLY — including when the
  store was never consulted, because choosing the version from whether Shopify
  was consulted would put the store back into identity through the version
  string, which is itself hashed content. `.v2` rows keep hashing it verbatim,
  because that is what they were minted over, and `.v1` never carried it; an
  unrecognized version fails CLOSED rather than hashing an unknown shape.
  Canonical evaluation `.v6` and Native-Ad evaluation `.v8` enumerate the
  members `normalizeSpendUnitEvidence` canonicalizes instead of spreading
  `SpendUnitEvidence` wholesale, dropping the three Shopify members and every
  `observed_shopify_aov_*` warning — because under a bare spread the hashed
  field list was whatever the interface happened to carry, so adding a field to
  that interface moved every `contextHash` with no version key moving at all.
  A canonicalizer must therefore ENUMERATE what it hashes; it must never spread
  an interface whose membership can change beneath it.
- Every anchor input is fail-closed: null, blank, zero, negative, malformed,
  and partial (an AOV with no Target ROAS) never establish a spend unit, and a
  target whose update timestamp cannot be verified is demoted, not trusted.
- A hard-action withholding must carry a stable machine code, and the codes
  are derived from the same predicates as the eligibility booleans — a code may
  never disagree with the boolean it explains. Absence of a code is unknown,
  never eligible.
- The UI renders the server-owned anchor panel and never derives a spend unit,
  eligibility, threshold, `buyerAction`, or campaign role from it. A missing
  panel renders nothing; it never implies a configured anchor.
- Anchor money is shown in the business currency. A missing currency must not
  silently become USD.
- Saving commercial truth is a product-settings write. It must not open or
  imply automation or provider-write authority, and it must not overwrite
  engine-owned calibration columns it does not read.
- The anchor is economics, never a role: no campaign-kind writer, manual label,
  or role selector may be reintroduced through this path.

## D079 correction 1 — canonical authority, capture truth, replay honesty

- The canonical `AccountDecisionProfile.hardActionEligibility` (its `anchor`
  and `codes`) is the SOLE authority for the commercial-anchor explanation. No
  surface may re-derive source, confidence, spend unit, eligibility or an
  action blocker from target fields. A projection may attach only the known
  business/account currency and aggregate persisted blocker counts.
- A profile that cannot be resolved serves an explicit `unavailable` panel. It
  is never rendered as "no anchor configured", and never as eligible.
- Anchor status keys off the resolver's own chosen rung, never off a separately
  supplied quality label that can disagree with it.
- The capture UI states the canonical choice, the unit, the spend-unit formula,
  and which action each anchor unlocks. It must not promise that saving an
  anchor enables automation or execution.
- An unknown business currency stays visibly unknown. No surface may format an
  amount as USD for a business that never configured a currency.
- Offline replay is PER ACTION. Clearing the commercial threshold never counts
  as clearing Cut (which needs a break-even ROAS) or Scale (which needs a
  Target ROAS and a calibration sample).
- Offline replay resolves a target pack bitemporally as of each row's origin —
  `effectiveAt` AND `recordedAt` at or before the cutoff — or uses explicitly
  declared all-window hypotheticals that are part of the candidate hash. A
  later revision is never applied to an earlier row.
- An outcome that depends on evidence the frozen package does not carry is
  emitted as `not_determinable_from_frozen_evidence`, by action and business. A
  persisted `profile_hard_action_ineligible` is never restated as a specific
  anchor sub-cause.

## D079 correction 2

- `profile_hard_action_ineligible` is a persisted first-blocker FAMILY. No
  surface, projection, artifact or document may restate it as a
  commercial-threshold gate or any other specific sub-cause. Only a canonical
  per-action code produced by the engine may name a cause.
- A per-action blocker code and its operator sentence must derive from the SAME
  effective code, after any overlay. The code is never downgraded to match
  stale copy, and an eligible action carries neither.
- No surface may render retired commercial vocabulary. `CPA ceiling` and
  `AOV floor` must not appear anywhere in served output.
- Account-history CPA p50 and its sample count are shown as source-backed
  lineage, labelled as history and never as an operator target.
- Every replay action row and total partitions completely, with mutually
  exclusive buckets chosen by the persisted first blocker. `blockedAfterTotal`
  is the only field that may be read as the blocked population; a narrower
  bucket must never be presented as the total.
- Independent campaign-context and recovery rows stay independent-gate
  transitions in every scenario and are never recast as anchor transitions.

## D092 — the canonical commercial rule

**With a Target ROAS, the authoritative spend unit is ready Meta
platform-attributed AOV over that ratio, and nothing scales it.** No attribution
adjustment multiplier is applied on any rung, including the `break_even_aov`
stop-loss rung. An account setting that scales the unit also scales the maturity
floor and the thresholds derived from it, which makes an attribution knob a
silent authority.

**A missing, thin, stale, future, malformed or unverifiable AOV HOLDS the
action, and CPA/account-calibration authority exists only where no positive
Target ROAS does (Round 8).** Under a governing Target ROAS the account's own
measured `accountCpaP50` / `accountCpaSampleCount` are OBSERVED evidence and
choose nothing: not the unit, not a threshold, not an eligibility, and — since
`engine-v3-canonical-evaluation.v9`, `engine-v3-native-ad-calibration.v5` and
`d086.budget-readiness-retention.v12` — not an identity either. They are
projected out of `spendUnitEvidence`, of `accountBaselines` /
`accountBaselinesByKind`, of the native cell manifest and of the D086
`source_fingerprint` through one shared projection
(`lib/creative-decision-engine/commercial-semantic-projection.ts`). Without a
positive Target ROAS the `account_history` rung is reachable, the CPA genuinely
chooses the unit, and every one of those digests is unchanged.

**Native readiness holds outright for SCALE, CUT and REFRESH (Round 8, widened
in Round 10).** With a governing Target ROAS and a spend-unit authority that is
not READY, the calibration cell answers `ready: false` with
`commercial_spend_unit_authority_missing` on ALL THREE actions — even where a
sample-backed positive `roasRatioP25` exists. Round 8 closed Cut alone, which
was the same defect one action to the left: Scale sizes a budget INCREASE and
Refresh authorizes spend to continue, and neither has admissible arithmetic
without the canonical unit. A relative percentile is not READY Meta AOV over the
Target ROAS, and a "ready" cell with no economic unit would persist an authority
the account does not have — into the retained profile and into its hash.

**A commercial-target timestamp is read strictly (Round 8).** `Date.parse`
accepts a bare `YYYY-MM-DD`, a naked local time whose instant differs per host,
prose dates, and `2026-02-30` — which it silently reports as 2026-03-02. Any of
those used to prove provenance and keep the hard-action gate open.
`lib/meta/commercial-target-instant.ts` constructs the instant from the literal
calendar fields instead, and every invalid class closes authority. The
repository's point-in-time helper (`normalizeAsOfCutoff`) keeps its intentional
date-only behaviour: a query cutoff is a DAY an operator names, which is a
different kind of value from a timestamp the database recorded.

**A number that cannot change the verdict must not change the maturity floor.**
`metaLossBudgetMaturity` starts where `resolveSpendUnit` starts and uses the
same `classifyMetaAovQuality` readiness bar, so an account's spend unit and the
gate deciding whether that unit may act cannot disagree about what one purchase
is worth. Without a Target ROAS the legacy
`breakEvenCpa ?? targetCpa ?? accountCpa` ladder is preserved unchanged.

**ROUND 10 CORRECTION to the sentence above.** It previously read "Without a
Target ROAS, OR with a Meta sample below the ready bar, the legacy ladder is
preserved" — and the second half is exactly the CPA fallback this whole
invariant forbids. With a positive Target ROAS a thin, missing, stale, future or
malformed sample is a TOTAL HOLD: `metaLossBudgetMaturity` answers null, no
maturity floor is built, and no Target CPA, break-even CPA, account CPA,
operator AOV, Shopify AOV or calibrated spend floor substitutes for it. The
legacy ladder is reachable only where no positive Target ROAS exists.

**A number that cannot change the verdict must not change an identity either,
and neither may the row it arrived on.** Dropping `targetCpa` from a digest
while keeping the target pack's `updatedAt`, or the native authority's
`sourceRowId` / `effectiveAt` / `recordedAt`, closes nothing: those move on any
re-save, so a CPA-only edit still moves the hash — it just stops saying why. The
projection in `commercial-semantic-projection.ts` removes both, and is the ONE
definition read by the canonical evaluation envelope, the native
authority/generation/cell hashes and the D086 fingerprints.

**Without a Target ROAS the legacy Target CPA governs and MUST key identity.**
Blanking it there would make two genuinely different accounts share a
fingerprint. Every projection is version-scoped on `targetRoasGoverns`, never
unconditional.

**A historical contract version is readable, never authoritative.** A persisted
spend-unit authority stamped `.v1`, `.v2` or `.v3` still parses and still
hash-verifies under the rule that minted it. It cannot authorize a current
decision: it is refused by version before its rungs are compared, because
judging an old row by today's ladder can either grant hard action on a retired
rung or fail the whole native job closed.

**Every Refresh carries a receipt, held or authorized.** The lifecycle evidence
hash is never null. A Refresh withheld for missing or invalid evidence is the
outcome that most needs provenance, and it must be distinguishable from a
Refresh withheld for a different gap — so the receipt covers the bands or their
explicit absence, the sorted missing-evidence codes, the observed states, the
winner bars and sample floors, the ROAS targets, the frequency reading and its
threshold, and the derived lifecycle state.

**A date must be the day it claims to be.** `Date.parse` accepts `2026-02-30`
and returns 2026-03-02; it accepts `2026-04-31` and returns 2026-05-01. A band
window date is round-tripped and must equal its input, or the band is
inadmissible. An impossible date may not silently redefine the window it bounds.

## Current authority vs historical record

> **Current authority vs historical record.** Which table a decision taken today
> may read, and which is retained only so a past decision can be explained, are
> listed once in
> [`CONTRACTS.md` → *Current authority vs historical record — the tables*](./CONTRACTS.md#current-authority-vs-historical-record--the-tables).
> A value from the retained list may EXPLAIN a decision and may never GRANT one.
