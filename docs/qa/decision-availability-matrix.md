# The decision availability matrix

This is the durable record of one measurement: **with adequate, fresh evidence
in front of it, does the Meta decision engine produce a concrete recommendation
— or does everything decay into a generic "extra review needed"?**

It is a measurement, not an argument. The facts are held byte-identical and
only the operating posture is varied; every number below was read back from the
served payload and the persisted rows of a throwaway database, never computed
by the reporter.

```
node --import tsx scripts/meta-decision-card-apply-harness.ts --availability-matrix
node --import tsx scripts/meta-decision-card-apply-harness.ts --availability-matrix --keep
MATRIX_ONLY=semi_auto__released__live__master_on \
  node --import tsx scripts/meta-decision-card-apply-harness.ts --availability-matrix
node --import tsx scripts/meta-decision-card-apply-harness.ts \
  --matrix-report=/path/to/availability-matrix.json
```

Run on `codex/meta-v2-panel-fidelity` at `d1746f1df` (plus the five agents'
uncommitted work in the same worktree), as-of day `2026-09-04`, PostgreSQL 16.

**This document now records two full 24-cell runs.** The first is the
measurement that produced Findings 1–5 below. The second was taken after
Findings 1–3 were fixed at source, on the same fixture and the same as-of day,
and every "after" number quoted here comes from it. Findings 4 and 5 are open;
each says why and what would close it.

---

## 1. What is held fixed, and what is varied

The fixture is the standing one from
[`docs/qa/decision-card-apply-harness.md`](decision-card-apply-harness.md) —
28 days of published warehouse facts, a delivery collapse on the newest day of
a cost-capped ad set, a Shopify store with a proven recent-order span, and
**ROAS 2.20 as the only configured commercial target** (no target CPA, no
operator AOV assumption; the CPA benchmark is derived from the store's observed
average order value, 58.00 USD ÷ 2.20 = 26.36).

The matrix seeds that fixture **once**, into a template database, and then
clones it per cell with `CREATE DATABASE … TEMPLATE`. "The facts are identical"
is therefore a property of the clone, not a claim about the seeder — and the
run prints the proof:

```
distinct warehouse fact fingerprints across all cells: 1
```

Each cell then runs in its **own child process**, because
`META_AUTOMATION_LIVE_WRITES` is read through a per-process memoised gate:
flipping it inside one process would grade a value the application never saw.

### The constant nobody named, and the run depends on it

Every cell in both runs was driven with

```
CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION=campaign-context-resolver.v2-account-scoped-name-neutral-2026-09-01
```

exported by the harness into each child's environment
(`scripts/meta-decision-card-apply-harness.ts:2263, :2309, :2815`, and the
launcher it writes at `:349`).

This is not decoration. `campaignContextAuthorityResolverVersion()`
(`lib/creative-decision-engine/campaign-context/source.ts:49-56`) compares the
environment variable to `CAMPAIGN_CONTEXT_RESOLVER_VERSION`
(`lib/creative-decision-engine/campaign-context/resolver.ts:18`) **byte for
byte** and returns `null` on anything else — unset, whitespace-different, an
older identity, a newer one. `isCampaignContextResolverAuthorityValidated`
(`:42-47`) then reads that `null` as "not validated", the persisted role drops
from `contextTrust: "high"` to `"medium"`, and
`applyMetaCampaignLabelGuard` demotes the row with
`campaign_context_unresolved` — the same downgrade Finding 2 is about, arriving
from a completely different cause.

The harness sets it on every child unconditionally, so `--availability-matrix`
always runs with it — that is precisely why nobody noticed it was load-bearing.
But the same surface, in any environment where the variable is unset, stale or
a byte different, degrades with `campaign_context_unresolved` on every campaign
regardless of what roles are published. A reader comparing this matrix against
a hand-driven app that lacks the variable would see a difference the engine did
not cause.

The first report did not name it. It is named here because the honest statement
of what the matrix proves is "with the approved resolver identity present", not
"always" — and because Finding 2's downgrade and this one are indistinguishable
in the served payload, so a future investigator must be able to rule this out
first.

| Varied | Values | Where it lives |
|---|---|---|
| decision mode (all four families: pause, bid, budget, creative) | `manual`, `semi_auto`, `auto` | `meta_automation_decision_type_modes.mode` |
| business STOP | released, engaged | `meta_automation_business_controls.kill_switch_engaged` |
| rehearsal | `dryRunOnly` false, true | `meta_automation_business_controls.guardrails_json` |
| automation master capability | ON, OFF | `META_AUTOMATION_LIVE_WRITES` |

3 × 2 × 2 × 2 = **24 cells**.

Per cell the child drives the shipped path, in this order and no other:

1. **the real producer** — `runMetaSnapshotForBusiness`
2. **the retained snapshot** — `meta_decision_snapshots_daily`, read back
3. **the served card** — `GET /api/meta/decisions-workspace`, the shipped route
   handler, invoked with a **real session cookie** minted by `createSession`
4. **the dispatch** — `POST /api/meta/automation/proposals` with the shipped
   `explicit_operator_confirmation`, against an undici `MockAgent` with
   `disableNetConnect()`

Nothing contacts Meta. Nothing is asserted; the child prints what it observed.

### How a served row is bucketed

The served rows carry one flat `automationReadiness.blockers` array, and a raw
count off it means nothing — `missing_live_preflight` is on *every* row in the
product. Counting those as "blocked" is exactly how a matrix would manufacture
the answer "everything is blocked". So blockers are split four ways and each
cell reports all four:

| Group | Members | What it means |
|---|---|---|
| **programme** | `no_empirical_outcome_model`, `missing_controlled_causal_evidence`, `missing_valid_treatment_receipt`, `missing_valid_random_assignment`, `missing_valid_control_estimate`, `insufficient_empirical_sample`, `empirical_precision_below_floor`, `missing_holdout_plan`, `missing_post_action_monitor` | conditions of the automation research programme; true of nearly every row |
| **prerequisite** | `missing_live_preflight`, `missing_rollback_plan`, `missing_operator_enablement`, `missing_executor` | what *unattended* execution needs. Never a statement about this account's data, and never a reason an operator cannot apply by hand |
| **posture** | `not_action_state`, `diagnostic_or_watch_state`, `unsupported_action_class`, `low_confidence` | a description of the decision, not an absence |
| **missing data** | everything else (here: `campaign_context_unresolved`) | a named input this account is actually missing |

Only the last group counts into `missing`. A row that offers a typed verb with
an amount is counted **concrete** even when its automation readiness is
blocked, because the operator can apply it today; conflating those two is the
error that makes an engine look like it recommends nothing.

The recommendation fingerprint covers the recommendation identity, the evidence
sentence, the sized intent and the missing-data codes — and **nothing** about
dispatch or CTA. Ten wall-clock keys (`knowledgeAsOf`, `generatedAt`,
`createdAt`, `updatedAt`, `observedAt`, `decidedAt`, `dispatchedAt`,
`snapshotCreatedAt`, `evaluatedAt`, `asOf`, `sampledAt`) are stripped before
hashing, because two cells run seconds apart and cannot share one. That list is
short, explicit, and lives in `MATRIX_VOLATILE_KEYS`.

---

## 2. The matrix

Every cell serves **7 rows**. The counts below are the SECOND run, after
Findings 1–3 were fixed: 1 concrete, 1 blocked on a named missing input, 1
carrying a justified hold, 4 state rows carrying a justified hold with a
reason. Identical in all 24.

Before the fixes the same 24 cells read `1 concrete / 0 hold / 2 missing / 4
state`; the row that moved is `scale_for_volume` on campaign `…101`, which was
being reported as missing an input it has (Finding 2).

| cell | rows | concrete (amount) | hold | missing | state | queue | dispatch |
|---|---|---|---|---|---|---|---|
| manual · released · live · master ON | 7 | 1 (1320) | 1 | 1 | 4 | 0 | `no_pending_queue_row` |
| manual · released · live · master OFF | 7 | 1 (1320) | 1 | 1 | 4 | 0 | `no_pending_queue_row` |
| manual · released · rehearsal · master ON | 7 | 1 (1320) | 1 | 1 | 4 | 0 | `no_pending_queue_row` |
| manual · released · rehearsal · master OFF | 7 | 1 (1320) | 1 | 1 | 4 | 0 | `no_pending_queue_row` |
| manual · STOP · live · master ON | 7 | 1 (1320) | 1 | 1 | 4 | 0 | `no_pending_queue_row` |
| manual · STOP · live · master OFF | 7 | 1 (1320) | 1 | 1 | 4 | 0 | `no_pending_queue_row` |
| manual · STOP · rehearsal · master ON | 7 | 1 (1320) | 1 | 1 | 4 | 0 | `no_pending_queue_row` |
| manual · STOP · rehearsal · master OFF | 7 | 1 (1320) | 1 | 1 | 4 | 0 | `no_pending_queue_row` |
| semi_auto · released · live · master ON | 7 | 1 (1320) | 1 | 1 | 4 | 1 | **200 · applied · `dryRun=false`** |
| semi_auto · released · live · master OFF | 7 | 1 (1320) | 1 | 1 | 4 | 1 | 503 `kill_switch_engaged` / **`release_capability_closed`** |
| semi_auto · released · rehearsal · master ON | 7 | 1 (1320) | 1 | 1 | 4 | 1 | 200 · approved · **`dryRun=true`** |
| semi_auto · released · rehearsal · master OFF | 7 | 1 (1320) | 1 | 1 | 4 | 1 | 503 `kill_switch_engaged` / `release_capability_closed` |
| semi_auto · STOP · live · master ON | 7 | 1 (1320) | 1 | 1 | 4 | 1 | 503 `kill_switch_engaged` / **`business_kill_switch`** |
| semi_auto · STOP · live · master OFF | 7 | 1 (1320) | 1 | 1 | 4 | 1 | 503 `kill_switch_engaged` / `business_kill_switch` |
| semi_auto · STOP · rehearsal · master ON | 7 | 1 (1320) | 1 | 1 | 4 | 1 | 503 `kill_switch_engaged` / `business_kill_switch` |
| semi_auto · STOP · rehearsal · master OFF | 7 | 1 (1320) | 1 | 1 | 4 | 1 | 503 `kill_switch_engaged` / `business_kill_switch` |
| auto · released · live · master ON | 7 | 1 (1320) | 1 | 1 | 4 | 1 | **200 · applied · `dryRun=false`** |
| auto · released · live · master OFF | 7 | 1 (1320) | 1 | 1 | 4 | 1 | 503 `kill_switch_engaged` / `release_capability_closed` |
| auto · released · rehearsal · master ON | 7 | 1 (1320) | 1 | 1 | 4 | 1 | 200 · approved · `dryRun=true` |
| auto · released · rehearsal · master OFF | 7 | 1 (1320) | 1 | 1 | 4 | 1 | 503 `kill_switch_engaged` / `release_capability_closed` |
| auto · STOP · live · master ON | 7 | 1 (1320) | 1 | 1 | 4 | 1 | 503 `kill_switch_engaged` / `business_kill_switch` |
| auto · STOP · live · master OFF | 7 | 1 (1320) | 1 | 1 | 4 | 1 | 503 `kill_switch_engaged` / `business_kill_switch` |
| auto · STOP · rehearsal · master ON | 7 | 1 (1320) | 1 | 1 | 4 | 1 | 503 `kill_switch_engaged` / `business_kill_switch` |
| auto · STOP · rehearsal · master OFF | 7 | 1 (1320) | 1 | 1 | 4 | 1 | 503 `kill_switch_engaged` / `business_kill_switch` |

Fingerprints across the 24 cells, unchanged by the fixes — both runs:

```
distinct warehouse fact fingerprints:      1
distinct SERVED decision fingerprints:     1   (recommendation + evidence + sizing)
distinct RETAINED snapshot fingerprints:   1
distinct CTA fingerprints:                 1
```

The served census and the served commercial anchor are also single-valued
across all 24 cells in the second run, which is the point: the three fixes moved
the ANSWER, not its dependence on posture.

```
queue.actionStates   {"executablePause":0,"executableBid":1,"executableResume":0,
                      "launchpadRoutes":0,"reviewOnly":6,"missingActionKind":0}
system.commercialAnchor.explanation
                     status  "eligible_observed_shopify_aov"
                     spendUnit 26.36363636363636   source "observed_shopify_aov"
                     confidence "high"             missingInputs []
                     scale: scale_calibration_below_floor · cut: eligible · refresh: eligible
```

**The invariant holds.** The recommendation, its evidence and its sizing are
byte-identical in every cell. Only the queue and the dispatch move, and they
move for exactly the reason the posture names.

### The seven rows, in every cell

| row | bucket | what it carries |
|---|---|---|
| `scenario_e1_frequency_fatigue` · adset `…201` | **concrete** | `operatorApply {action:"bid", grain:"adset", entityId:"9000000000201", bidAmountMinor:1320}`; persisted intent `authorityStatus:"authorised"`, `blockerCodes:[]`, 1200 → 1320 USD, `sizingPolicyVersion:"meta.bid-sizing.v1"` |
| `adset_state` · adset `…201` | justified hold | *"Mature entity is above the calibrated upper ROAS band; protect it from unnecessary changes."* |
| `campaign_state` · campaign `…101` | justified hold | same reason |
| `scale_for_volume` · campaign `…101` | justified hold | Before the fix: **missing data**, `campaign_context_unresolved` — and false; see Finding 2. Campaign `…101` has a published, high-confidence, `system_inferred` role from the approved resolver identity, and the row now carries no missing-data blocker at all |
| `scale_for_profitability` · campaign `…102` | missing data | `campaign_context_unresolved` — genuine, and unchanged by the fix: campaign `…102` deliberately has no published role. This is the control that makes the line above a measurement rather than a hope |
| `adset_state` · adset `…202` | justified hold | *"Automatic Main/Test/Mixed campaign role is unresolved…"* |
| `campaign_state` · campaign `…102` | justified hold | same reason |

### Execution-only pending / withheld, by posture

| posture | code | where it is emitted |
|---|---|---|
| mode `manual` | `bid_mode_manual`, `budget_mode_manual` — `candidates:0, projected:0` | `projectMetaBidProposals` / `projectMetaBudgetProposals`; the **card still carries 1320**, because manual means the operator applies from the card rather than from a second inbox |
| mode `semi_auto` / `auto` | bid `candidates:1, projected:1` → one `pending` queue row | `lib/meta/bid-proposal-producer.ts` |
| budget arm, every mode | `canonical_fact_not_action_bearing`, `role_authority_absent`, `profile_not_retained`, `change_history_unknown`, `provider_baseline_unavailable` — `candidates:1, projected:0` | budget composition; a genuine, named withholding, not a silent zero |
| STOP engaged | `business_kill_switch` (503, row stays `pending`, nothing reaches the double) | `getMetaWriteBlockState`, `lib/meta/automation-control-plane.ts:2318-2326` |
| master OFF | `release_capability_closed` (503, row stays `pending`) | `readMetaReleaseGates().automationLiveWrites` via `app/api/meta/automation/proposals/route.ts:524` |
| rehearsal ON, master ON, STOP released | 200, receipt `dryRun:true`, `outcome:"dry_run"`, endpoint recorded, nothing posted | `metaAutomationDryRunOnly` |
| live, master ON, STOP released | 200, receipt `dryRun:false`, `outcome:"verified"`, `POST bid_amount=1320` then the read-back | shipped `/api/meta/adsets/<id>/apply-bid` |

STOP takes precedence over the master gate: with both closed the reported
reason is `business_kill_switch`. Both refusals arrive under the same outer
envelope code `kill_switch_engaged`; only the inner `reason` separates them.
That is legible enough for a machine and misleading for a person — the
master-OFF case tells an operator a kill switch is engaged when none is. It is
a naming defect, not a decision defect, and it is still open: see Finding 4.

---

## 3. Findings

*Findings 1–3 are stated as they were measured in the FIRST run and each ends
with a "Fixed, and re-measured" block carrying the second run's numbers.
Findings 4 and 5 are open and say so. Read the present tense inside 1–3 as
describing the first run.*

### Finding 0 (fixture, fixed here) — the harness wrote only half of a target save

The first full run reported `commercial_target_missing` and
`missing_commercial_anchor` on both `scale_*` rows in all 24 cells, and served
them as "Review Commercial Truth" with `stateReason:
current_commercial_target_authority_unavailable`.

That was the **fixture**, not the engine. The product's own writer
(`upsertBusinessCommercialTruth`, `lib/business-commercial.ts:2069`) inserts
`business_target_packs` and appends `business_target_pack_history` in one CTE,
and the two are read by different callers: the engine reads the **history**
as-of the snapshot day, while every serve-time re-validation reads the
**current pack** through `getBusinessCommercialTruthSnapshot`. The harness
seeded only the history — a state the product cannot produce.

Measured before the fix: `readMetaCommercialTargets(businessId)` →
`{"source":"none", …}`, `hasMetaHardActionAnchor → false`.
Measured after: `{"source":"configured_targets","targetRoas":2.2,
"breakEvenRoas":1.8,"freshness":"fresh"}`, `hasMetaHardActionAnchor → true`, and
all 48 `commercial_target_missing` / `missing_commercial_anchor` observations
disappeared. **This is the only change made to the fixture, and it was made so
the matrix measures the product rather than the seed.** No threshold was
lowered, no guard removed, and no fact enriched beyond what one ordinary
Commercial Truth save writes.

### Finding 1 (FIXED) — the served action census can never report an executable row

Every cell served:

```json
"actionStates": {"executablePause":0,"executableBid":0,"executableResume":0,
                 "launchpadRoutes":0,"reviewOnly":7,"missingActionKind":0}
```

…on the same request whose card carries
`operatorApply {action:"bid", …, bidAmountMinor:1320}`, and in the cells where
that amount was actually POSTed to the provider and verified by read-back.

`queue.actionStates` counts `rec.actionKind`
(the `actionStates` reducer in `app/api/meta/decisions-workspace/route.ts`).
`actionKind` has exactly
two writers in the whole tree:

- `lib/meta/rec-presentation.ts:444` → `serverActionKindForRec`, which
  (`lib/meta/rec-presentation.ts:177-192`) returns only `review_drill`,
  `route_launchpad_rebuild` or `route_launchpad_duplicate`;
- `lib/meta/decisions-os-presentation.ts:227` → the literal `"review_drill"`.

Neither can ever produce `execute_bid`, `execute_pause` or `execute_resume`, so
those three counters are structurally dead and `reviewOnly` is always the row
total. This is the user's headline concern in its most literal form: the
workspace's own summary reports "7 review-only, 0 executable" over a decision
set that contains a proven, correctly sized, applyable and actually-applied bid
change.

The row-level control is fine — `serverOperatorApplyForRec` offers the typed
verb and the amount, deliberately separate from the engine's own authority. It
is the **census** that is wrong.

#### Fixed, and re-measured

The reducer now counts `rec.operatorApply?.action` first and falls through to
the `actionKind` chain
(`app/api/meta/decisions-workspace/route.ts`, `function actionStates`). All 24
cells of the second run:

```
"actionStates": {"executablePause":0,"executableBid":1,"executableResume":0,
                 "launchpadRoutes":0,"reviewOnly":6,"missingActionKind":0}
```

`serverActionKindForRec` was NOT changed. The separation it enforces — the
engine's own authority versus the operator's capability — is deliberate and
documented at `lib/meta/rec-presentation.ts:249-267`, and the file is outside
this change's scope in any case.

**The three `execute_*` branches stay**, unreached today, and that is a
decision rather than an oversight: they are the landing site for the
engine-authorized execution path that `rec-presentation.ts:249-267` describes
as not yet existing for campaign and ad-set grain. When it lands, those rows
will carry both an `execute_*` stamp and an `operatorApply`, the
`operatorApply` test will already have counted them, and the `else if` ordering
keeps that from double-counting. A comment in the reducer says exactly this, so
the next reader is not left wondering whether dead code was forgotten.

One caution for whoever reads this next: several existing cases in
`app/api/meta/decisions-workspace/route.test.ts` hand the route a lane row with
`actionKind: "execute_pause"` written in by hand. No producer can emit that, so
those cases were asserting a value the product cannot serve — which is exactly
how a structurally dead counter stayed green for as long as it did. The new
cases in `app/api/meta/serve-availability-decision-census.test.ts` build their
rows through the real `annotateMetaRecPresentation` instead, and assert
`actionKind === "review_drill"` as the premise.

### Finding 2 (FIXED) — the lane serve path cannot see a campaign role it has

The strongest result in the run, because it is the same shipped function driven
twice against the same database in the same instant, with one argument changed:

```
with account    scale_for_volume  state=watch kind=main ctx=null
without account scale_for_volume  state=watch kind=main ctx=review_only
```

`readMetaDecisionSnapshotForRange` reads the campaign context through
`readCampaignContextGuardState`, which is **account scoped**. The lane serve
path called it **without a provider account**
(the `loadBaseEvidence` snapshot read in `app/api/meta/lane-classify/route.ts`),
because lane classification was taken to be business-wide by design. With `providerAccountId: null`,
`readCampaignContextLabelMap` returns an empty map — measured directly,
`size = 0` — so every campaign reads as unlabeled and
`applyMetaCampaignLabelGuard` downgrades every hard action through
`restrictAutomaticContextToReview` (`lib/meta/campaign-label-guard.ts:383-429`):
`decisionState → "watch"`, `confidence → "low"`,
`campaign_context_action_authority → "review_only"`, and
`campaign_context_unresolved` pushed onto the blockers.

Campaign `…101` in this fixture has a published, high-confidence,
`system_inferred` role from an approved resolver identity. With the account
passed, the resolver answers `contextTrust: "high"`,
`resolverAuthorityValidated: true`. The operator is nevertheless told
*"Automatic Main/Test/Mixed campaign role is unresolved."*

Half of the `missing` column in the matrix — 1 of the 2 rows per cell, 24
row-observations of `campaign_context_unresolved` out of 96 — is this defect
rather than an account fact. The other half (campaign `…102`) is genuine: that
campaign deliberately has no published role, which is what makes this a
controlled comparison rather than a guess.

#### Fixed, and re-measured

`app/api/meta/lane-classify/route.ts` now passes `providerAccountId` into
`readLatestMetaDecisionSnapshot`. The field already existed on the reader
(`lib/meta/snapshot.ts`), optional and `undefined`/`null`-preserving; the call
site was simply not using it.

Second run, all 24 cells:

```
campaign_context_unresolved   72 row-observations across 24 cells   (was 96)
```

The 24 that disappeared are exactly campaign `…101`'s `scale_for_volume`, one
per cell. The three that remain per cell — `scale_for_profitability` and
`campaign_state` on campaign `…102`, and `adset_state` on ad set `…202` under
it — are the genuine ones, and campaign `…102` still reports the code, which is
the control holding.

**Which of the two scopings changed, precisely.** The reader applies its account
argument in two places: the ROW filter over `meta_decision_snapshots_daily`, and
the CAMPAIGN-CONTEXT read inside it. The defect is entirely the second. The
first is a real change too, and it is safe here for two reasons already true of
this route, both checked rather than assumed:

- the snapshot recommendations are re-filtered immediately afterwards against
  `campaignIdsInScope` / `adsetIdsInScope`, which are built from
  `getMetaCampaignsForRange` / `getMetaAdSetsForRange` called with
  `accountId: providerAccountId` — so a row belonging to another account, or an
  account-level row with no lineage, could never be served on this surface
  anyway (`app/api/meta/lane-classify/route.ts`, the
  `snapshotRecommendations` filter);
- `clearUnattributedRecommendationRows` (`lib/meta/snapshot.ts`) deletes
  every lineage-less recommendation row for the day on each business refresh, so
  the account-scoped predicate is not silently discarding rows a business still
  depends on.

It also fixes a smaller thing in passing: the reader's `latest` CTE picks
`MAX(snapshot_date)` within the same scope, so an account whose newest snapshot
is older than a sibling's now reads its OWN latest day instead of finding
nothing on the business-wide maximum.

**One stale comment is left behind, and it is not ours to edit.**
The doc comment on `readLatestMetaDecisionSnapshot` in `lib/meta/snapshot.ts` —
the paragraph beginning *"Omitted keeps the pre-lineage behaviour"* — still lists "lane classification" among the
business-scoped callers that omit the account. That sentence is now false. The
exact correction is in this change's handoff list.

### Finding 3 (FIXED) — the served commercial-anchor panel contradicts the decision it sits beside

Identical in all 24 cells of the first run:

```json
"explanation": {
  "status": "blocked_missing_owner_anchor",
  "thresholdEligible": false,
  "spendUnit": null, "spendUnitSource": "insufficient",
  "targetPackFreshness": "fresh",
  "lineage": {"targetRoas": 2.2, "breakEvenRoas": 1.8,
              "targetCpa": null, "operatorAovAssumption": null,
              "metaAttributedAovMean90d": null, …},
  "missingInputs": ["target_cpa", "operator_aov_assumption"],
  "actions": {"scale": {"eligible": false, "blockerCode": "commercial_anchor_missing"},
              "cut":   {"eligible": false, "blockerCode": "commercial_anchor_missing"},
              "refresh":{"eligible": false, "blockerCode": "commercial_anchor_missing"}}
}
```

Three things are wrong with that, in one payload:

1. `missingInputs` demands `target_cpa` and `operator_aov_assumption`. The
   binding product rule is that ROAS is the only required commercial target and
   the absence of those two is never a blocker.
2. Its own operator copy reads *"Set a Target ROAS in Commercial Truth — the
   average order value is read from your Shopify orders, so no CPA or AOV needs
   to be typed."* A Target ROAS **is** set (`lineage.targetRoas: 2.2`,
   `targetPackFreshness: "fresh"`), and Shopify orders **are** present and
   proven.
3. The same account, on the same as-of day, has retained
   `engine_v3_account_profile_output` rows that say otherwise:

   ```
   action  | eligible | blocker_code                   | spend_unit
   cut     | t        |                                | 26.3636…
   refresh | t        |                                | 26.3636…
   scale   | f        | scale_calibration_below_floor  | 26.3636…
   ```

   26.36 is 58.00 ÷ 2.20 — the Shopify AOV rung, which exists and is named
   (`observed_shopify_aov`, `lib/creative-decision-engine/spend-unit-resolver.ts:172-181`
   and `lib/creative-decision-engine/types.ts:60-73`). The serve-time
   `resolveAccountDecisionProfile` re-resolution did not reach it and reported
   `spendUnitSource: "insufficient"`.

The lanes themselves were **not** degraded by this: the lane re-validation uses
a different and correct predicate (`hasMetaHardActionAnchor` +
`targetRoas`/`breakEvenRoas`, the `targetHardActionEligibility` block feeding
`revalidateMetaStructureLanesForCurrentTargets` in
`app/api/meta/decisions-workspace/route.ts`).
So the workspace serves two contradictory commercial-authority verdicts in one
response — the lanes say the hard actions are anchored, the panel the operator
reads to understand *why* says no anchor exists. The panel also feeds
`evaluateBudgetDecisionGates`, so the contradiction is not cosmetic.

#### Why the serve-time re-resolution could not reach the rung

`resolveAccountDecisionProfile` does no IO of its own for the store evidence by
design: `observedShopifyAov` is an INPUT, supplied by the caller. Every other
caller supplies it — the retention producer resolves it
(`readAccountProfileRetentionInputs` in
`lib/meta/account-profile-output-producer.ts`) and the snapshot's own benchmark
resolution does the same (the `observedAov` / `majorSpendUnit` block in
`lib/meta/snapshot.ts`). The
workspace route was the one caller that passed
`{businessId, asOf, dataSource, flags}` and nothing else, so
`resolveSpendUnitProfile` handed `resolveSpendUnit` a null store AOV, the
ladder fell past `observed_shopify_aov` with no Meta sample and no account CPA
history behind it, and landed on `insufficient`. The panel then reported the
absence of the two inputs the ladder's *upper* rungs use, which is where
`missingInputs: ["target_cpa","operator_aov_assumption"]` came from.

#### Fixed, and re-measured

The serve path now resolves the store evidence exactly as the producer does —
account currency from `provider_accounts` through the business's own
assignment, the ISO minor-unit exponent, and the same short-circuit (a
configured target CPA or operator AOV assumption sits above the store in the
ladder, so the store is not read at all in that case). All 24 cells of the
second run:

```json
"explanation": {
  "status": "eligible_observed_shopify_aov",
  "thresholdEligible": true,
  "spendUnit": 26.36363636363636,
  "spendUnitSource": "observed_shopify_aov",
  "spendUnitConfidence": "high",
  "missingInputs": [],
  "actions": {"scale":   {"eligible": false, "blockerCode": "scale_calibration_below_floor"},
              "cut":     {"eligible": true,  "blockerCode": null},
              "refresh": {"eligible": true,  "blockerCode": null}}
}
```

That is now byte-for-byte the same verdict as the account's own retained
`engine_v3_account_profile_output` rows quoted above — `cut` eligible,
`refresh` eligible, `scale` withheld on `scale_calibration_below_floor`, spend
unit `26.36363636363636`. The two commercial-authority answers in one response
no longer contradict each other.

Two smaller corrections went with it, both in the same file set:

- **`eligible_observed_shopify_aov` is a new `CommercialAnchorStatus`.** Before
  it existed, an anchor resolved from the store would have been reported as
  `eligible_meta_derived_aov` — telling the operator the number came from a
  sampled attribution estimate when it was read out of Shopify. The wire value
  is additive and the only renderer of it
  (`components/meta/decision-center/meta-decision-center-exact-adapter.ts:3067-3070`)
  prints the string it is given, so no reader breaks.
- **`observed_shopify_aov` was missing from `usesCommercialThreshold`**
  (`lib/creative-decision-engine/account-decision-profile.ts`,
  `resolveSpendUnitProfile`). Every member of that list is a rung derived
  THROUGH the target pack, and the store rung divides by
  `targetPack.targetRoas` like the rest — but it alone escaped both the
  provenance demotion and the staleness warning. While the rung was unreachable
  at serve time nobody could have noticed; making it reachable without this line
  would have shipped the hole. This ADDS a guard; a case in
  `lib/meta/serve-availability-commercial-anchor-rung.test.ts` proves an
  untrusted pack now demotes the store rung to `low` and refuses.

`lib/creative-decision-engine/spend-unit-resolver.ts` needed no change: the
`observed_shopify_aov` rung was already correct and already `high`-confidence
and `hardEligibleByDefault`. The defect was upstream of it, in what it was
handed.

**Still open, deliberately deferred.** The panel names its rung through
`spendUnitSource` but its `lineage` block still has no row for the store's own
average order value or its order count. Adding one means moving
`CommercialAnchorLineage`, the exact adapter's rendered rows and the payload
coverage census together; the census in
`components/meta/decision-center/decision-payload-coverage.test.ts` pins the
leaf count exactly and fails on an unclassified leaf, which is the census doing
its job. It is in this change's handoff list as one coordinated edit rather than
a half-done one.

### Finding 4 (OPEN, cosmetic) — one refusal envelope for two different postures

Both the STOP and the closed release capability answer
`{"code":"kill_switch_engaged", "reason": …}`. Only `reason` distinguishes
`business_kill_switch` from `release_capability_closed`. An operator who has
not engaged a STOP is told a kill switch is engaged.

#### Located exactly, and still open

The envelope is minted in one place —
`metaWriteBlockedResponse` (`lib/meta/automation-write-guard.ts:70-82`) — which
hardcodes `code: "kill_switch_engaged"` for every blocked posture and carries
the discriminator only in `reason`.

The server's `message` is in fact already distinct
(`"Live Meta writes are not enabled in this environment, so nothing was
sent."`, `lib/meta/automation-control-plane.ts:2345-2350`), so this would be
harmless if anything rendered it. Nothing does: **both** operator-facing readers
match on the CODE and replace the server's sentence with a hardcoded one —

- `components/meta/redesign/MetaPlatformPage.tsx:854-856` →
  *"Meta writes are temporarily disabled (kill switch). Try again later."*
- `components/creatives/briefing/action-handlers.ts:169-171` → the same
  sentence.

So the distinct message is written, sent, and then discarded by the UI. That is
the whole defect.

**Readers of the string `"kill_switch_engaged"`, enumerated before proposing a
change** (42 non-test occurrences at the time of writing). Only these consume THIS envelope, i.e. a
response produced by `metaWriteBlockedResponse` / `rejectIfMetaWritesBlocked`:

| Reader | What it does with it |
|---|---|
| `components/meta/redesign/MetaPlatformPage.tsx:854` | swaps in the hardcoded kill-switch sentence |
| `components/creatives/briefing/action-handlers.ts:169` | same |
| `app/api/launchpad/meta/bulk-ad-status/route.ts:2066, :3591` | classifies a halted reason |
| `lib/launchpad/meta-launch-execution.ts:269, :1372` | classifies a halted reason |

Everything else that matches the string is a DIFFERENT producer with its own
envelope and is untouched by any change here: `lib/meta/ads-write.ts:294-300,
:351-356` and its status mapper `:437`; the `result.error.code` status mappers
in `lib/meta/entity-action-routes.ts:821, :1010` and
`lib/meta/ads-action-routes.ts:2097, :2629`; `lib/meta/launch-write.ts:521`;
the five scheduled runtimes, which already emit `release_gate_closed` and
`auto_execution_disabled` as separate codes
(`lib/meta/scheduled-{activation,bid,status,ad-status,launch}-runtime.ts`);
`lib/meta/entity-action-routes.ts:669`, which already answers
`posture.reason ?? "kill_switch_engaged"` and is therefore already honest; and
the blocker vocabularies in `lib/meta/read-state-contract.ts:112`,
`lib/meta/budget-proposal-dry-run.ts:173`,
`lib/meta/budget-write-preflight.ts:23`,
`lib/meta/budget-proposal-runtime.ts:49`,
`lib/creative-decision-engine/execution-safety.ts:122` and
`lib/meta/scheduled-action-execution.ts:38`.

`lib/meta/automation-write-guard.ts` and the two component files are outside
this change's ownership, so the fix is in its handoff list as one coordinated
edit across the three files. It is deliberately NOT a bare code rename: changing
only the code string would leave the two UI readers falling through to a generic
message and would silently reclassify the four halted-reason readers above.

### Finding 5 (OPEN, not a product defect) — a blocking danger banner in every cell, and the first report omitted it

The first report listed three constant degradations and there were four. Every
one of the 24 cells, in both runs, also serves:

```json
{"id": "meta_decision_pipeline_health", "tone": "danger", "blocking": true,
 "title": "Meta data sync is stopped — current decisions are unavailable.",
 "detail": "New sync work is refused by the growth fence (physical_snapshot_missing).
            No finalized and validated Meta Ad day is available.
            The sync admission gate is closed. snapshot_unavailable snapshot_unavailable
            No current decision can execute until the stated pipeline checks recover."}
```

It is built by `pipelineHealthBanner`
(`app/api/meta/decisions-workspace/route.ts`, invoked from the payload's
`banners`), and it sits above a card carrying a proven, applyable 1200 → 1320
cost-cap raise. That contradiction is what makes it worth naming even though
none of it is a product defect. Its four sentences have two different causes,
and separating them is the point:

| Sentence | Blocker | Cause | Would it appear in production? |
|---|---|---|---|
| *"New sync work is refused by the growth fence (`physical_snapshot_missing`)"* and *"The sync admission gate is closed."* | `sync_admission_blocked` (`lib/meta/decision-pipeline-health.ts:329-332`) | **Environmental.** `evaluateDbGrowthFence` refuses because no `db_host_healthcheck` sample exists — the fence wants a physical-capacity sample that a throwaway cluster on a random port has never had written to it. The child prints the refusal verbatim: `reason: 'physical_snapshot_missing', detail: "No 'db_host_healthcheck' sample exists. Confirm adsecute-db-healthcheck.timer is running on the database host."` | No — a production host has the timer |
| *"No finalized and validated Meta Ad day is available."* | `warehouse_cutoff_missing` (`:373-374`) | **Fixture.** The fence-scoped warehouse cutoff read finds no finalized Meta Ad day for this synthetic account | No |
| *"snapshot_unavailable snapshot_unavailable"* (twice: once for the generation dimension, once for the manifest) | the decision read model's own `unavailable.code`, forwarded by `buildMetaDecisionPipelineHealth` (`lib/meta/decision-pipeline-health.ts:544-547`) | **Fixture.** The harness seeds the Meta v1 snapshot path (`meta_decision_snapshots_daily`) and does not seed the engine-v3 native exact-Ad generation, so the native read model is `unavailable` | No |

So: one third environmental, two thirds fixture, and **nothing in it is a
finding about the engine**. It is recorded because a reader of the first report
could open the harness, see a red blocking banner over a healthy decision, and
reasonably conclude the matrix had measured a broken product. Closing it would
mean writing a `db_host_healthcheck` sample and seeding the native generation
into the fixture — a harness change, not a product one, and not attempted here.

The `meta_write_kill_switch` banner also appears, in the 12 STOP cells only. That
one is posture-dependent and correct, and is not a constant.

### Is the instrument falsifiable?

A matrix that always prints "one fingerprint" would be worthless. Three things
in this run show it is not stuck:

- the **queue** column moves with the mode (0 rows under `manual`, 1 under
  `semi_auto` and `auto`) and the **dispatch** column takes four distinct
  values, so the instrument does register differences when there are any;
- the same harness's `--rerun-probe` drives the same fixture with one FACT
  changed — the delivery stall restored to the ad set's own seven-day median —
  and the fingerprint-bearing `target_value` goes `NULL`, `bidIntent` goes from
  1320 to none and the candidate disappears. Stable is not frozen;
- the first full run of this matrix, before the fixture fix in Finding 0,
  produced a *different* served decision fingerprint content: 48 additional
  `commercial_target_missing` / `missing_commercial_anchor` observations and
  both `scale_*` rows stamped `current_commercial_target_authority_unavailable`.
  The fingerprint moved when the inputs moved;
- and the SECOND run is the fourth datum: three of the four constant
  degradations moved when the code moved — the census, the campaign-role
  downgrade and the commercial anchor — while all four fingerprints stayed at
  1. An instrument that could not distinguish the two code states would have
  printed the same table twice.

### The durable guards left behind by the fixes

Three test files, all runnable in under a second, pin what the full 24-cell run
proved. Each was checked by reverting its fix and watching it fail:

| File | What it pins |
|---|---|
| `app/api/meta/serve-availability-decision-census.test.ts` | the served census counts `operatorApply`; `serverActionKindForRec` cannot produce an `execute_*` for any of 540 input shapes; the serve path hands the profile the store evidence, and does not read the store at all when a target CPA exists |
| `app/api/meta/serve-availability-lane-campaign-role-scope.test.ts` | the shipped lane route passes `providerAccountId` into the snapshot read, and still reads business-wide when none is named |
| `lib/meta/serve-availability-commercial-anchor-rung.test.ts` | the store rung resolves, names its own source, and demands nothing; it still refuses with no store evidence, with thin evidence, and when the target pack's provenance is untrusted; and it is never consulted above an operator AOV |

A durable millisecond-scale guard for the posture invariant lives in
`lib/meta/decision-availability-posture-independence.test.ts`: the three
presentation functions the card is built from take no business id, open no
connection and read no release gate, so posture cannot reach the
recommendation. That test also pins the deliberate divergence between the
engine's `actionKind` and the operator's `operatorApply`, and shows the apply is
withheld when the persisted intent is not `authorised`.

---

## 4. Verdict

**On the invariant the matrix was built to test: it holds.** Across 24
postures over identical facts, the recommendation, its evidence and its sizing
never moved — one fingerprint, in the served payload and in the persisted rows
alike. The 1320-minor-unit cap raise is present and applyable in every single
cell, including with STOP engaged and the master capability closed. Only the
queue and the dispatch move, and each moves for exactly the reason its posture
names — with a distinct `reason`, though the outer envelope code is shared
between two of them, which is Finding 4.

**On the user's acceptance concern: the three defects that pushed a correct
decision toward a generic review sentence are fixed.** With adequate fresh
evidence this engine produces a concrete, sized, applyable recommendation, and
it produces justified holds with stated reasons rather than shrugs. What the
operator's own summary says about that has moved, on identical facts:

| | before | after |
|---|---|---|
| `queue.actionStates.executableBid` | 0 | **1** |
| `queue.actionStates.reviewOnly` | 7 | 6 |
| rows blocked on a named missing input | 2 | **1** (the remaining one is genuine) |
| `campaign_context_unresolved` row-observations, 24 cells | 96 | **72** |
| `commercialAnchor.explanation.status` | `blocked_missing_owner_anchor` | **`eligible_observed_shopify_aov`** |
| `commercialAnchor.explanation.spendUnit` | `null` | **26.36363636363636** |
| `commercialAnchor.explanation.missingInputs` | `["target_cpa","operator_aov_assumption"]` | **`[]`** |
| `cut` / `refresh` anchor eligibility | blocked `commercial_anchor_missing` | **eligible** |
| distinct SERVED / RETAINED / CTA fingerprints | 1 / 1 / 1 | 1 / 1 / 1 |

`laneCounts.actionNow` is still `0` in every cell and all seven rows still sit
in `watching`, and that is **not** a residue of Findings 1–3. The concrete row
is `decisionState: "test"`, and the lane classifier places a `test` row in
`watching` by its own rule. Forcing it into `actionNow` would be forcing an
action count, which this work does not do. The census now reports the
executable row that lane contains, which is the honest half of what the
operator needed.

Two things remain open, and both are named rather than quietly carried:

- the **refusal envelope** still tells an operator with no STOP engaged that a
  kill switch is engaged (Finding 4) — a naming defect in three files this
  change does not own, with the exact edit and the full reader enumeration in
  its handoff list;
- every cell still serves a **blocking pipeline-health danger banner**
  (Finding 5) over a healthy decision — one third environmental, two thirds
  fixture, and no part of it a product defect.

Nothing in this document was obtained by forcing an action count, lowering a
threshold, or removing an identity or freshness guard. The one fixture change
(Finding 0) is documented above with the measurement before and after it, and
the only guard that moved in the fixes moved in the strengthening direction:
`observed_shopify_aov` was ADDED to `usesCommercialThreshold`, so it can no
longer escape the target-pack provenance demotion.

---

## 5. Reproducing it

The whole matrix is one command; it builds its own cluster on a random free
port that is never 5432 or 15432, migrates it with the repo's own deploy entry
point, and removes it again unless `--keep` is passed.

```
node --import tsx scripts/meta-decision-card-apply-harness.ts --availability-matrix
```

The run writes `availability-matrix.json` next to the cluster (one object per
cell: posture, fact fingerprint, snapshot counters, the full served rows, the
queue, the control plane, the dispatch attempt, the activity ledger, the
serve-scope reproduction and the three fingerprints) and copies it to
`$TMPDIR/adsecute-availability-matrix-<as-of>.json`. `--matrix-report=<file>`
re-prints the table from that JSON without measuring again.

`MATRIX_ONLY=<substring>` narrows the run to matching cells while a cell is
being debugged. It filters the same generated list, so a narrowed run and a
full run always agree about what a cell is.

On this machine the run needs `EPHEMERAL_PG_BIN_DIR` when `initdb`/`pg_ctl` are
not on `PATH`, and `LC_ALL=C` for `initdb`:

```
EPHEMERAL_PG_BIN_DIR=/opt/homebrew/opt/postgresql@16/bin LC_ALL=C \
  node --import tsx scripts/meta-decision-card-apply-harness.ts --availability-matrix
```
