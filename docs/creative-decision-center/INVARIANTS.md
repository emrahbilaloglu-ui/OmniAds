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
  be multiplied into a synthetic growth target. Economic cut requires a valid
  explicit break-even ROAS; target ROAS alone must not be multiplied into a
  synthetic loss boundary.
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
- A native decision-origin provider POST transport exception is an ambiguous
  external outcome and must remain pending as `provider_outcome_ambiguous`
  without an immutable operator-action receipt. Manual status actions retain
  terminal `silent_failure` action-log compatibility when a terminal fact is
  durably available; a journaled unexpected throw may instead remain pending
  with only its immutable start. Launchpad retains its separate terminal
  attempt-receipt contract. A fresh attempt identity cannot bypass an
  unresolved guard, and no timeout clears it without an immutable exact-state
  reconciliation event. A received HTTP rejection remains a definite failure
  when terminal persistence succeeds.
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
| only target ROAS becomes known                      | target-relative context appears; economic cut stays blocked without break-even                      |
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
