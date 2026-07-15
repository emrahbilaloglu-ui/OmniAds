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
  positive account P25. When that percentile is unavailable, only an exact
  purchase cell with cutoff-safe explicit target and break-even authority may
  use the canonical commercial stop-loss path. Its boundary is the minimum of
  the existing uncalibrated fallback, break-even/target, and 1.0; break-even
  may narrow but never widen Cut authority.
- Native action readiness must record whether authority came from
  `calibrated_relative` or `commercial_stop_loss`. Pooled, non-purchase,
  invalid-anchor, or lineage-unsafe cells cannot use the stop-loss path.
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
  break-even. Break-even may narrow account P25; it must never widen the account
  cut zone toward break-even.
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

## Metamorphic Tests

| Change                              | Expected behavior                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| dataFreshness becomes stale         | stop-loss confidence is capped; mature severe losers may stay `cut`; scale is blocked  |
| benchmarkReliability strong -> weak | confidence goes down                                                                   |
| campaignStatus active -> paused     | `fix_delivery` disappears                                                              |
| reviewStatus -> disapproved         | policy overrides performance                                                           |
| launch age under threshold          | hard scale/cut becomes `watch_launch` / `test_more` unless maturity threshold is met   |
| commercial target crosses 30-day review age | target, confidence, label, and authority remain unchanged; advisory metadata may change |
| commercial target timestamp missing | provenance fails closed; this is distinct from a valid old timestamp                         |
| only break-even ROAS becomes known  | portfolio comparison may improve; campaign budget scale stays blocked                  |
| only target ROAS becomes known      | target-relative context appears; economic cut stays blocked without break-even          |
| fresh break-even falls below account P25 | cut boundary narrows to break-even; known working-zone behavior below P25 is not widened |
| creative reused in second ad set    | aggregate action authority falls to out-of-scope; confidence must not increase          |
| nested 30d window is added          | independent Structure evidence count does not increase                                  |
| frequency 3.0, account P75 3.5      | frequency does not establish fatigue pressure                                           |
| future target version is inserted   | earlier as-of replay remains byte-equivalent                                             |

## Test Placement

TODO: Convert these into executable tests before resolver changes. Keep tests close to adapter/resolver contracts, not UI components.
