# Proposed Contracts

Documentation only. Do not implement runtime code from this file without tests and ADR review.

## Core Types

```ts
type CreativeDecisionOsV21PrimaryDecision =
  | "Scale"
  | "Cut"
  | "Refresh"
  | "Protect"
  | "Test More"
  | "Diagnose";

type CreativeDecisionCenterBuyerAction =
  | "scale"
  | "cut"
  | "refresh"
  | "protect"
  | "test_more"
  | "watch_launch"
  | "fix_delivery"
  | "fix_policy"
  | "diagnose_data";

type CreativeDecisionCenterAggregateAction =
  | "brief_variation"
  | "creative_supply_warning"
  | "winner_gap"
  | "fatigue_cluster"
  | "unused_approved_creatives";

type CreativeDecisionCenterExecutionAction =
  | "promote_to_main"
  | "scale_budget"
  | "controlled_scale";

interface CreativeDecisionOsV21Output {
  contractVersion: "creative-decision-os.v2.1";
  engineVersion: string;
  primaryDecision: CreativeDecisionOsV21PrimaryDecision;
  actionability: "direct" | "review_only" | "blocked" | "diagnose";
  problemClass:
    | "performance"
    | "creative"
    | "fatigue"
    | "delivery"
    | "policy"
    | "data_quality"
    | "campaign_context"
    | "insufficient_signal"
    | "launch_monitoring";
  confidence: number;
  maturity: "too_early" | "learning" | "actionable" | "mature";
  priority: "critical" | "high" | "medium" | "low";
  reasonTags: string[];
  evidenceSummary: string;
  blockerReasons: string[];
  missingData: string[];
  queueEligible: false;
  applyEligible: false;
  // Optional review metadata only. These fields must never affect the fields
  // above, buyerAction, an authority blocker, or provider mutation eligibility.
  commercialTargetAge?: {
    status: "recent" | "review_due" | "unknown";
    ageDays: number | null;
  };
}

interface CreativeDecisionCenterRowDecision {
  scope: "creative";
  creativeId: string;
  rowId?: string;
  identityGrain: "ad" | "creative" | "asset" | "family";
  familyId?: string | null;
  engine: CreativeDecisionOsV21Output;
  buyerAction: CreativeDecisionCenterBuyerAction;
  buyerLabel: string;
  uiBucket: CreativeDecisionCenterBuyerAction;
  // D019: optional campaign-kind execution CTA. Null/absent for non-scale rows
  // or scale rows without a labeled campaign kind. Does not expand buyerAction.
  executionAction?: CreativeDecisionCenterExecutionAction | null;
  // D020: opaque audit metadata for the upstream engine label (for example V3
  // `keep`, `same_as_canonical`, `out_of_scope`). Free-form string; never used
  // by the UI to compute buyerAction. Adapter-only diagnostic surface.
  sourceDecision?: string | null;
  confidenceBand: "high" | "medium" | "low";
  priority: "critical" | "high" | "medium" | "low";
  oneLine: string;
  reasons: string[];
  nextStep: string;
  missingData: string[];
}

interface CreativeDecisionCenterAggregateDecision {
  scope: "page" | "family";
  familyId?: string | null;
  action: CreativeDecisionCenterAggregateAction;
  priority: "critical" | "high" | "medium" | "low";
  confidence: number;
  oneLine: string;
  reasons: string[];
  affectedCreativeIds: string[];
  nextStep: string;
  missingData: string[];
}

interface DecisionCenterSnapshot {
  contractVersion: "creative-decision-center.v2.1";
  engineVersion: string;
  adapterVersion: string;
  configVersion: string;
  generatedAt: string;
  dataFreshness: {
    status: "fresh" | "stale" | "unknown";
    maxAgeHours?: number | null;
    latestSnapshotAsOf?: string | null;
    snapshotAgeHours?: number | null;
  };
  inputCoverageSummary: Record<string, number>;
  missingDataSummary: Record<string, number>;
  todayBrief: Array<{
    id: string;
    priority: "critical" | "high" | "medium" | "low";
    text: string;
    rowIds: string[];
    aggregateIds?: string[];
  }>;
  actionBoard: Record<CreativeDecisionCenterBuyerAction, string[]>;
  rowDecisions: CreativeDecisionCenterRowDecision[];
  aggregateDecisions: CreativeDecisionCenterAggregateDecision[];
}

interface BuyerActionMappingRule {
  id: string;
  when: {
    primaryDecision?: CreativeDecisionOsV21PrimaryDecision;
    problemClass?: CreativeDecisionOsV21Output["problemClass"];
    reasonTagsAny?: string[];
    actionability?: CreativeDecisionOsV21Output["actionability"];
    requiredData?: string[];
    blockersAbsent?: string[];
  };
  output: {
    buyerAction: CreativeDecisionCenterBuyerAction;
    buyerLabel: string;
    uiBucket: CreativeDecisionCenterBuyerAction;
    // D019: optional campaign-kind execution CTA emitted alongside `buyerAction`.
    executionAction?: CreativeDecisionCenterExecutionAction | null;
    nextStepTemplate: string;
  };
}

interface CreativeDecisionConfig {
  configVersion: string;
  launchWindowHours: number;
  noSpendWindowHours: number;
  minSpendForMaturityMultiplier: number;
  minPurchasesForScale: number;
  minImpressionsForCtrReliability: number;
  fatigueCtrDropPct: number;
  fatigueCpmIncreasePct: number;
  fatigueFrequencyIncreasePct: number;
  maxCpaOverTargetForCut: number;
  minRoasOverTargetForScale: number;
  winnerGapDays: number;
  fatigueClusterTopN: number;
  benchmarkReliabilityMinimum: "strong" | "medium" | "weak";
  staleDataHours: number;
  minConfidenceForScale: number;
  minConfidenceForCut: number;
}
```

## Meta Decisions Read-Time Compatibility Projection (D035)

The V2.1 adapter union above remains readable for historical snapshots. The
current Meta Decisions server boundary must additionally discriminate an
action from a blocked resolution:

```ts
type MetaDecisionState = "act" | "monitor" | "blocked" | "not_applicable";

interface MetaDecisionResolution {
  code: string;
  category:
    | "data"
    | "tracking"
    | "commercial_truth"
    | "campaign_context"
    | "delivery"
    | "policy"
    | "funnel"
    | "system";
  owner: "system" | "operator" | "integration";
  label: string;
  nextStep: string;
}

interface MetaDecisionClassificationProjection {
  decisionState: MetaDecisionState;
  heldAction: "scale" | "cut" | "refresh" | null;
  legacyBuyerAction: CreativeDecisionCenterBuyerAction;
  buyerAction: Exclude<
    CreativeDecisionCenterBuyerAction,
    "diagnose_data"
  > | null;
  resolution: MetaDecisionResolution | null;
}
```

When `decisionState === "blocked"`, `buyerAction` must be null,
`resolution` must be non-null, and no provider mutation may be exposed. The UI
must not recreate this projection from raw labels, reason text, or badge copy.
When persisted `blocked_action_type` is non-null, the server projection must
also be blocked and must label the held Scale/Cut/Refresh signal explicitly;
the published soft compatibility label remains audit provenance only.

## Native Ad Calibration Action Readiness v3 (D060-D063)

The v3 native calibration receipt keeps the v2 action path and adds one
account/currency spend-unit proof. Label math remains in the canonical
resolver:

```ts
interface NativeAdCalibrationActionReadinessEntryV3 {
  ready: boolean;
  reason: string | null;
  authorityBasis:
    | "calibrated_relative"
    | "calibrated_relative_with_economic_stop_loss"
    | "commercial_stop_loss"
    | null;
  observedSampleCount: number;
  requiredSampleCount: number;
}

interface NativeAdAccountAovEvidenceV1 {
  status:
    | "ready"
    | "insufficient_sample"
    | "contradictory_purchase_truth"
    | "unavailable";
  scope: "business_provider_account_currency";
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  accountCurrency: string | null;
  sampleWindowStart: string;
  sampleWindowEnd: string;
  asOfCutoff: string;
  observedPurchaseCount: number;
  requiredPurchaseCount: 20;
  revenueBackedRowCount: number;
  canonicalRowCount: number;
  contradictoryRowCount: number;
  legacySchemaRowCount: number;
  unsupportedSchemaRowCount: number;
  totalRevenue: number;
  meanAov: number | null;
  evidenceHash: string;
}

interface NativeAdSpendUnitAuthorityV1 {
  contractVersion:
    | "engine-v3-native-ad-spend-unit-authority.v1"
    | "engine-v3-native-ad-spend-unit-authority.v2"
    | "engine-v3-native-ad-spend-unit-authority.v3"
    | "engine-v3-native-ad-spend-unit-authority.v4";
  status: "ready" | "blocked";
  basis:
    | "target_cpa"
    | "operator_aov"
    | "observed_shopify_aov"
    | "physical_account_purchase_aov_90d"
    | null;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  accountCurrency: string | null;
  asOfCutoff: string;
  targetAuthorityHash: string;
  baseSpendUnit: number | null;
  accountAovEvidence: NativeAdAccountAovEvidenceV1;
  observedShopifyAovEvidence?: ObservedShopifyAovEvidence | null;
  authorityHash: string;
}

interface NativeAdCalibrationActionReadinessV3 {
  spendUnitAuthority: NativeAdSpendUnitAuthorityV1;
  scale: NativeAdCalibrationActionReadinessEntryV3;
  cut: NativeAdCalibrationActionReadinessEntryV3;
  refresh: NativeAdCalibrationActionReadinessEntryV3;
}

interface ExpandedEconomicCutAuthorityV1 {
  eligible: boolean;
  authorityBasis:
    | "calibrated_relative_with_economic_stop_loss"
    | "commercial_stop_loss"
    | null;
  reason: string | null;
}
```

`NativeAdSpendUnitAuthorityV1` above keeps its original interface name (it is
what a persisted row's shape is called) but THREE versions are now READ and only
`.v3` is minted (`NATIVE_AD_SPEND_UNIT_AUTHORITY_CONTRACT_VERSION`,
`lib/creative-decision-engine/jobs/ad-calibration-job.ts`). An unrecognized
version fails CLOSED — `nativeAdSpendUnitAuthorityHashContent` throws, and both
callers that reach persisted data reject it first. `observedShopifyAovEvidence`
is hashed under `.v2` only. `.v1` predates the source; `.v3` carries it and
excludes it from `authorityHash`, the generation content and the cell input
manifest. Rows are never backfilled between versions: each recomputes under its
own key.

`basis` likewise enumerates what a persisted row may NAME, not what a mint may
choose. `operator_aov` and `observed_shopify_aov` are RETIRED bases (D091):
readable so old rows parse, never minted, and never an expected basis — a row
naming one now fails the validator closed. Measured on production: zero rows in
`engine_v3_ad_account_calibration_daily`, on any `as_of_date`, carry either.

**CPA AND ACCOUNT-CALIBRATION AUTHORITY IS LIMITED TO THE NO-TARGET-ROAS CASE.**
Whenever a positive Target ROAS exists, the only authoritative money-per-purchase
unit is READY same-provider-account, same-cutoff Meta platform-attributed AOV
over that ratio. In that mode a Target CPA, a break-even CPA, the account's own
measured `accountCpaP50` / `accountCpaSampleCount`, an operator AOV assumption, a
Shopify AOV, a calibrated spend floor and an attribution multiplier may not
authorize, threshold, size, fingerprint, hash or retain an action — and none of
them may substitute for a missing or thin AOV. **A missing, thin, stale, future,
malformed or unverifiable AOV HOLDS the action.** Where no positive Target ROAS
exists the legacy CPA compatibility path applies unchanged, because there the
typed CPA genuinely is the anchor and no ratio is being divided.

Two consequences that are easy to state wrongly:

- **Native Cut readiness holds OUTRIGHT, not downstream.** With a governing
  Target ROAS and a spend-unit authority that is not READY,
  `resolveNativeAdCalibrationActionReadiness` answers
  `ready: false, reason: "commercial_spend_unit_authority_missing"` even when the
  cell carries a sample-backed positive `roasRatioP25`. `calibrated_relative` is
  reachable only on the no-Target-ROAS legacy path.
- **Target ROAS is the RELATIVE boundary whenever it is positive.**
  `metaRelativeCutRoasCeiling` returns the Target ROAS and falls to a configured
  break-even only when there is no Target ROAS at all. Break-even powers the
  separately labeled economic stop-loss path (`metaCutRoasCeiling` /
  `metaCutRoasReviewCeiling`), which is optional in both directions: it never
  fires without a configured break-even, and its absence never blocks a relative
  decision.

**Amended by D091 — read this before the two paragraphs below; their break-even
requirement is superseded.** Cut authority needs a commercial target authority
of EITHER kind, not both: `hasCommercialTargetAuthority` is
`targetRoasAuthority || breakEvenRoasAuthority`
(`lib/creative-decision-engine/jobs/ad-calibration-job.ts`), and the served
equivalent is `cutAnchorEligible = targetPackAuthoritative &&
(breakEvenAnchored || targetRoasAnchored)`
(`lib/creative-decision-engine/account-decision-profile.ts`). An explicit
break-even ROAS is therefore no longer a required Cut input on either path:
nothing in the computation consumed it to reach that refusal — every spend-unit
lane takes an explicit Target CPA whole or divides a canonical AOV by the
Target ROAS, and the relative Cut boundary is itself a Target-ROAS ratio — so
the requirement gated an input it never used. What break-even still does is
unchanged: it is the only thing that defines the bounded P25-to-break-even
economic strip (`cut-policy.hasExplicitBreakEven`), and a Target ROAS is never
multiplied into a synthetic loss boundary in its place. Where no break-even
exists the Cut is anchored, not widened. The refusal that remains is real: with
NEITHER target present there is no commercial anchor at all and the action is
blocked by name (`target_roas_authority_missing`). The block reason
`break_even_roas_authority_missing` stays in the union unused by new rows,
because rows minted before this rule are persisted with it and must still
parse.

A ready `commercial_stop_loss` proof is valid only for exact purchase-cell
`cut`, requires explicit target, ~~break-even,~~ and spend-unit authority, and
declares zero required peer samples when no usable exact-cell P25 exists. A
ready `calibrated_relative_with_economic_stop_loss` proof has the same
target and ~~break-even~~ requirements, a valid loss-budget spend unit from either
the authenticated account/currency receipt or the canonical exact-cell CPA P50
at the retained sample floor, plus a positive exact-cell P25 backed by the
retained Cut sample floor. It tells the canonical resolver that both the legacy
P25 region and D063's economic-loss extension are available; it is not a
second decision or an authorization to bypass maturity. A ready
`calibrated_relative` proof still requires the action's positive sample floor
and observed samples at or above it, but for Cut it authorizes only the legacy
region below P25. The native profile carries the readiness result as the
hash-bound `expandedEconomicCutAuthority`; only the hybrid and
`commercial_stop_loss` bases set it eligible. Blocked proofs must have a
non-null reason and null authority basis. Pooled/non-purchase cells remain
blocked.

`expandedEconomicCutAuthority` is optional only for canonical non-native
profiles. On that surface, the absent field makes
`expandedEconomicCutAuthority?.eligible === undefined`; that state preserves
the canonical D063 strip and is not an explicit denial. Native profiles must
always set the field from their hash-bound readiness receipt: `eligible: true`
grants the native expanded-strip capability, while `eligible: false` is the
explicit native denial. Consumers must not coerce the absent non-native field
to false.

D063 leaves the legacy region byte-compatible and adds one disjoint region.
Let `L = min(P25 ?? 0.70, 1.0)` and
`B = min(breakEvenRoas / targetRoas, 1.0)`. Ratios below `min(L, B)` retain the
existing Cut policy. Only when `B > L` may `L <= ratio < B` enter the existing
Cut maturity gate, and only after Refresh precedence. `ratio >= B`, including
equality, is never Cut-eligible. In the expanded region, sufficient canonical
recent spend with recent ROAS below break-even confirms the loss; recent ROAS
at or above break-even produces Keep. Missing or thin recent evidence persists
the exact held tuple below:

```ts
{
  preAuthorityLabel: "cut",
  label: "test_more",
  rawLabel: "test_more",
  authorityBlocker: "recent_recovery_unverifiable",
  blockedActionType: "cut",
  authorizedAction: null,
  pendingTransition: false,
}
```

The hold is evidence authority, not D036 hysteresis. When sufficient evidence
first appears, independent-date Cut confirmation starts fresh. Target age is
advisory and cannot veto the result. A ready physical-account AOV proof may
size only Cut loss-budget maturity; it cannot change `L`, `B`, the recent-spend
threshold, recovery, Scale, Refresh, or confidence. V1/v2 receipts remain
readable only under their original engine epochs and must not be upgraded by
inference.

### Release Version Matrix — CURRENT (D091, 2026-09-07)

This is the matrix to read. The D061-D066 matrix beneath it is retained as the
record of a superseded release and must not be used as a current value.

| Contract surface | Release value |
| --- | --- |
| Canonical engine | `v3-2026-09-07-held-verdict-authority` |
| Native-Ad engine | `v3-ad-2026-09-07-held-verdict-authority-shadow` |
| Exact native rollback epoch | `v3-ad-2026-07-15-commercial-stop-loss-shadow` |
| Native calibration | `engine-v3-native-ad-calibration.v5` (minted); `.v3` durably recomputable; `.v1`/`.v2` offline-only and refused as superseded. See the durable-compatibility note below. |
| Canonical evaluation | `engine-v3-canonical-evaluation.v9` |
| Native-Ad evaluation | `engine-v3-canonical-ad-evaluation.v11` |
| Native-Ad spend-unit authority | `engine-v3-native-ad-spend-unit-authority.v4` (minted); `.v1`, `.v2` and `.v3` readable — readable means PARSED and hash-verified, never authoritative: a historical version cannot authorize a current decision |
| Native-Ad lifecycle evidence | `native-ad-lifecycle-evidence.v3-full-receipt` |
| D086 retention identity | `d086.budget-readiness-retention.v12`; `.v1`–`.v11` superseded (eleven entries in `D086_SUPERSEDED_RETENTION_CONTRACTS`) — a superseded stamp is readable as HISTORY only and can never retain or authorize a current verdict |
| Native-Ad outcome | `engine-v3-ad-decision-outcome.v3` |
| Decisions workspace read | `meta-decisions-workspace.read.v4` |
| Classification overlay | `meta-decisions-classification-overlay.v4` |
| Decisions OS presentation | `meta-os-decisions.presentation.v5` |
| Automation rule evaluation report | `automation-rule-evaluation-report.v2` — `anchors` are read from `business_target_pack_history` AS OF the evaluation cutoff, never from the current workspace snapshot |
| D086 input-pack artifact | `d086.budget-readiness-input-pack.v13` (`r13`); `r1`–`r12` frozen and byte-recomputable, verified by the generator's own `frozenRevisions` check. `r12` is additionally pinned by the D077 release-candidate manifest at `a508d90527b441b6a82cf25537e1b5b5425203f72d22d6083cceb6bad0eb4b6b` and is recorded in `D086_REJECTED_REVISIONS` with that hash |
| D086 pinned local-Postgres evidence | `d086-local-postgres-evidence-2026-09-02.r4.json` (`d086.capture-to-readiness-evidence.v3`), sha256 `cceb24fadf6d3814481b78b597e14b2852b1e7dafb93d92ca9c97cb5107b29dc`. It records the current SEVEN-index catalogue with `indisvalid` / `indisready` / `indislive` on every entry; the verifier refuses a short, extra, wrong-name or unusable catalogue and refuses the retired `meta_entity_observation_receipts_occurrence`, `idx_meta_entity_observation_receipts_freshness` and `idx_meta_entity_observation_receipts_cohort`. `r1`–`r3` remain frozen; `r3` is D077-pinned and is never rewritten |

### Durable calibration compatibility, exactly as implemented (Round 9)

Both calibration tables carry an immutable `contract_version` column. What
actually happens, function by function:

- **Writing.** `INSERT_NATIVE_AD_CALIBRATION_BATCH_SQL` and
  `INSERT_NATIVE_AD_CALIBRATION_SQL` both write `contract_version`; the cell
  inherits the batch's, so agreement is true by construction on every new row.
- **Migrating.** `ALTER_NATIVE_AD_CALIBRATION_CONTRACT_VERSION_SQL` adds the
  column with `DEFAULT 'legacy_unknown' NOT NULL` and then drops the default.
  `ADD COLUMN … DEFAULT … NOT NULL` is metadata-only on PostgreSQL 11+ and fires
  no row trigger, which matters because both tables raise unconditionally on
  `UPDATE` — a backfill written as an `UPDATE` would abort the migration.
- **Backfill value.** `legacy_unknown`, NOT `.v3` and NOT `.v4`. `git show HEAD`
  reads `.v3`; `git log -S'engine-v3-native-ad-calibration.v4'` returns zero
  commits, so `.v4` never wrote a row; and `.v1`, `.v2` and `.v3` each appear in
  committed history, so existing rows could have been written by any of the
  three and nothing on the row discriminates. Guessing would make a row
  recompute against a formula it was not written with and fail as if corrupt.
- **Reading.** `READ_NATIVE_AD_ACCOUNT_CALIBRATION_CELL_SQL` joins on
  `batch.contract_version = calibration.contract_version`, and
  `nativeCalibrationContractVersion` asserts the same agreement on the mapped
  object. A missing stamp maps to `legacy_unknown`, never to the current value.
- **Recomputing — and the exact boundary of what is DURABLY readable.**
  `recomputeNativeAdCalibrationCellInputManifestHash` and
  `computeNativeAdCalibrationCellSetHash` take the row's OWN version.
  `nativeAdCalibrationCellInputManifestContentLegacy` reproduces the **`.v3`**
  formula literally (five fields blanked, the row's clocks KEPT), and
  `nativeAdCalibrationBatchGenerationContent` applies the semantic target
  projection only from `.v5` on and omits `spendUnitAuthority` entirely for
  `.v1`/`.v2` — the member first appears in the `.v3` blob.

  **`.v1` and `.v2` are NOT durably readable, and this table no longer claims
  they are.** Their cell manifest digested
  `observations: observations.map(observationManifestEntry)` and
  `targetAuthority: purchase ? … : null`, and the calibration table persists
  neither input. `nativeAdCalibrationDurablyRecomputable` answers false for
  both; `recomputeNativeAdCalibrationCellInputManifestHash` THROWS rather than
  returning a `.v3`-shaped digest that would report a good historical row as
  corrupt; and `validateCell` returns `superseded` without attempting a
  recompute. Their formula is reproducible OFFLINE only, through the exported
  `nativeAdCalibrationCellInputManifestContentV1V2` and the synthetic fixtures
  in `native-ad-historical-calibration-formulas.test.ts` — which are built from
  that implementation and are **not** captured production rows.
- **Refusing.** `validateCell` returns `superseded` for a stamp that is not the
  current one (after re-deriving it under its own formula, so a genuinely
  corrupt historical row still reports `invalid`), and
  `resolveNativeAdAccountDecisionProfile` fails closed with
  `native_calibration_contract_superseded`.

There is no `assertNativeAdCalibrationBatchIntegrity` version gate doing this
work — that function checks a batch being WRITTEN, not a row being read, and an
earlier revision of this table named it as the durable compatibility mechanism.
It was not one.

### Current authority vs historical record — the tables

Two questions get confused constantly, and confusing them is how a stale row
becomes an authority: **which table does a decision taken TODAY read**, and
**which table is retained so a past decision can still be explained**. They are
listed separately here, and every other file in this set
(`START_HERE.md`, `INVARIANTS.md`, `GOLDEN_CASES.md`, `DATA_READINESS.md`)
defers to this list rather than restating it.

READ FOR A CURRENT DECISION — the authority for the grain named:

| Table | Grain / role |
| --- | --- |
| `meta_account_daily`, `meta_campaign_daily`, `meta_adset_daily`, `meta_ad_daily` | Authoritative provider FACTS, owned by insights sync (D066). Admitted only as `truth_state = 'finalized' AND validation_status = 'passed' AND created_at <= cutoff AND updated_at <= cutoff` |
| `engine_v3_ad_decision_snapshots_daily` | Native Ad-grain verdicts — the `native_ad` authority |
| `engine_v3_decision_snapshots_daily` | Creative-grain verdicts — the `legacy_creative` fallback authority |
| `engine_v3_ad_account_calibration_daily` | Native calibration cells, and the spend-unit authority inside `action_readiness_json` |
| `engine_v3_account_calibration_daily` | Account calibration baselines |
| `engine_v3_creative_lifecycle_daily` | Creative lifecycle overlay (overlay only; never a source of spend or ROAS) |
| `engine_v3_campaign_context_daily` | Campaign role context. Trusted for ACTION only through `isContextTrustedForAction` — high trust, `system_inferred`, validated resolver identity, high inference confidence |
| `engine_v3_account_profile_output` | D086 per-canonical-action commercial verdict |
| `business_target_packs` | Target / break-even ROAS |

RETAINED, READABLE, NEVER A CURRENT AUTHORITY:

| Table / version | Why it is not current |
| --- | --- |
| `meta_campaign_config_history`, `meta_adset_config_history` | Their only writer records TRANSITIONS; a transition row is not a statement about today's configuration |
| `meta_entity_state_history` | Point-in-time observations. Read AS OF a cutoff; the present-day dimension tables are consulted only in present-day mode |
| `engine_v3_campaign_role_authority` | Retained role attestations for past decisions |
| Spend-unit authority `.v1`, `.v2`, `.v3` | Readable means PARSED and hash-verified under each row's own rule. `.v4` is the only version that may authorize |
| Superseded contract versions in the matrix above | Retained so a past receipt still verifies |
| `lib/archive/v1-v2-v21/**` | Archived engines; excluded from the default vitest run |

The rule that ties the two lists together: **a value read out of the second
list may explain a decision and may never grant one.** A `campaignKind` read
back off a persisted snapshot, a `.v3` authority row, a config-history
transition — each is evidence about the past, and each is re-derived from the
first list before it can move a current verdict.

Each value's source of truth is its constant, never this table: `ENGINE_VERSION`
and `NATIVE_AD_ENGINE_VERSION` in `lib/creative-decision-engine/types.ts`,
`CANONICAL_EVALUATION_CONTRACT_VERSION` in
`lib/creative-decision-engine/canonical-evaluation.ts`,
`AD_DECISION_EVALUATION_CONTRACT_VERSION` in
`lib/creative-decision-engine/evaluation-store.ts`,
`NATIVE_AD_SPEND_UNIT_AUTHORITY_CONTRACT_VERSION` and
`NATIVE_AD_CALIBRATION_CONTRACT_VERSION` in
`lib/creative-decision-engine/jobs/ad-calibration-job.ts`,
`NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION` in
`lib/creative-decision-engine/jobs/ad-operator-response-job.ts`,
`AD_DECISION_OUTCOME_CONTRACT_VERSION` in
`lib/creative-decision-engine/jobs/ad-decision-outcomes-job.ts`, and
the three presentation constants in `lib/meta/decisions-workspace-contract.ts`
and `lib/meta/decisions-os-contract.ts`.

Four rows moved since the D061-D066 matrix, and they moved for two different
reasons:

- **Both engine epochs (PRODUCER).** `reason`, `blockers`, `preAuthorityLabel`,
  `authorityBlocker` and `blockedActionType` all change for identical inputs
  under D091, and all five feed the sha256 `decisionHash` in `normalizeDecision`.
  Both epochs move together because `ratioZonesGate` is shared: the legacy
  creative job and the native ad job both reach it through `decideCreative` and
  each stamps its own constant.
- **Canonical evaluation `.v5 → .v6` and Native-Ad evaluation `.v7 → .v8`
  (ENVELOPE).** D091's own entry in `DECISION_LOG.md` states these were
  deliberately NOT bumped, and that statement was true when written — the
  envelope was unchanged then. It was bumped afterwards, for a different
  reason: `normalizeSpendUnitEvidence` stopped spreading `SpendUnitEvidence`
  wholesale and now ENUMERATES what it canonicalizes, dropping the three
  Shopify members and the `observed_shopify_aov_*` warnings. Under the bare
  spread the hashed field list was whatever the interface happened to carry, so
  adding the Shopify members had silently moved every `contextHash` with no
  version key moving at all — production already shows `.v7` labelling two
  different field lists, 14,340 rows without the Shopify keys and 23 with them.
  Rows under the older keys stay readable under their own key and are never
  recomputed under current semantics.

The `Native-Ad spend-unit authority` row is NEW here; it was never in the
D061-D066 matrix because the authority did not carry a version key of its own
then.

### D061-D066 Release Version Matrix (HISTORICAL — superseded by the matrix above)

**Do not read a current value out of this table.** It records what the
D061-D066 release shipped. The Canonical-engine, Native-Ad-engine,
Canonical-evaluation and Native-Ad-evaluation rows are all superseded by D091
and by the envelope bump described above; the other rows happen to be unchanged,
which is a fact about those contracts and not a licence to trust this table.

| Contract surface | Release value (as shipped at D061-D066) |
| --- | --- |
| Canonical engine | ~~`v3-2026-07-18-decision-presentation-hardening`~~ |
| Native-Ad engine | ~~`v3-ad-2026-07-18-decision-presentation-hardening-shadow`~~ |
| Exact native rollback epoch | `v3-ad-2026-07-15-commercial-stop-loss-shadow` |
| Native calibration | `engine-v3-native-ad-calibration.v3` |
| Canonical evaluation | ~~`engine-v3-canonical-evaluation.v5`~~ |
| Native-Ad evaluation | ~~`engine-v3-canonical-ad-evaluation.v7`~~ |
| Native-Ad outcome | `engine-v3-ad-decision-outcome.v3` |
| Decisions workspace read | `meta-decisions-workspace.read.v4` |
| Classification overlay | `meta-decisions-classification-overlay.v4` |
| Decisions OS presentation | `meta-os-decisions.presentation.v5` |

D061 and D063 were not deployed separately. D064 therefore advances their
single release epoch while retaining the already-bumped v3/v5/v7 contracts
above. D065 execution hardening and D066 fact-ownership/replay proof do not
change resolver output or persisted decision shape, so they use that same
release epoch without another version bump. Older immutable rows remain
readable only under their recorded contracts — which is why the struck values
above are still the correct key for rows written under them, reported as
`engine_epoch_mismatch` / `engine_version_drift` rather than as unreadable.

## Canonical Briefing Authority And Synthetic Demo (D062, D064)

The briefing projection accepts only two authoritative statuses:

```ts
type BriefingCanonicalAuthorityStatus =
  | "native_exact"
  | "demo_synthetic_review_only";
```

`native_exact` may expose an action only when the persisted authority names the
same buyer action and every exact-Ad lineage field validates.
`demo_synthetic_review_only` must have null `authorizedAction`,
`actionEligible: false`, review-only reason
`demo_synthetic_review_only`, and identity `adActionEligible: false`.
`legacy_review_only` is not a canonical serving authority.

The demo generation contract binds one current-epoch synthetic Meta account,
the complete input-row manifest, one item hash per exact Ad, expected count,
and a generation manifest hash. Runtime projection validates the committed
fixture; it does not call the resolver or native persistence. Validation is
all-or-nothing and any mismatch returns an unavailable canonical inventory.
The production generator must reproduce the committed JSON byte-for-byte.

Blocked or held canonical actions never map to a launchpad mode, even when
their compatibility label is `test_more`. Money presentation uses the
canonical `accountCurrency`; missing currency is described generically and is
never silently defaulted to USD.

## Meta Provider Execution Origin And Live-Proof Contract (D065)

Provider mutations accept one explicit, non-overlapping authority envelope:

```ts
type MetaProviderActionOrigin =
  | {
      actionOrigin: "native_decision_v1";
      decisionOrigin: DecisionOriginAdExecutionRequest;
    }
  | {
      actionOrigin: "manual_operator_v1";
      manualConfirmation: "explicit_operator_confirmation";
      providerAccountId: string;
      entityId: string;
      creativeId: string | null;
    }
  | {
      actionOrigin: "launchpad_manual_v1";
      manualConfirmation: "explicit_operator_confirmation";
      launchIntentRequestFingerprint: string;
    };
```

Origin is a required discriminator; optional lineage-field presence is never
an origin signal. Manual and Launchpad envelopes reject every native-lineage
field when it is present, including `null`.

A native decision-origin preflight requires an exact derived provider action
from persisted `authorized_action`: only Cut-to-`pause` and Scale-to-`resume`
match. A null or different derived action is `action_not_authorized`; a matching
published label alone is insufficient.
The idempotency key is server-verifiable and deterministic over business,
physical account, Ad, snapshot, evaluation, engine epoch, decision hash,
provider action, and execute/dry-run mode. A non-canonical key fails before any
receipt lookup or live read. `creativeId` is required for execution and must
match the persisted source tuple and fresh provider Ad; a nullable legacy value
cannot authorize a write. A duplicate-success receipt and its durable log must
also carry that exact creative ID; a mismatch is `idempotency_conflict`.
`dryRun`, when present, is strictly boolean at the runtime JSON boundary.
Strings, numbers, null, and other malformed values are rejected before
receipt/provider work rather than being treated as execute mode.

Manual-operator and native-decision Ad status claim creation uses one shared
transactional claim over the exact business/provider-account/Ad tuple. The
transaction takes one advisory key, checks every origin for an unresolved
status claim, including any pending pause/resume row without a TTL, and either
inserts one claim or returns a typed conflict. New manual claims persist exact
`provider_account_id`; a legacy manual pending row whose account is null still
blocks the same business/Ad fail-closed. Provider network work never runs while
the transaction lock is held.

A live manual terminal `silent_failure/provider_outcome_ambiguous` remains an
unresolved status claim even though its row is terminal. Until exact
reconciliation clears that ambiguity, any later manual or native claim for the
same business/physical-account/Ad is rejected with
`meta_ad_status_reconciliation_required`,
`reconciliationRequired: true`, and `retryAllowed: false`, and performs zero
provider POSTs. A dry-run `silent_failure` is a definite non-mutation result and
does not create this live reconciliation hold.

Every new live manual pause/resume claim persists the exact
business/provider-account/Ad/creative/campaign/ad-set target and declares
`meta-manual-ad-status-mutation-attempt.v1`. Immediately before its sole
provider POST, the adapter must finish its fresh hierarchy/status/policy and
write-block checks and pass the exact business/account/Ad/creative/campaign/
ad-set baseline to the route's pre-mutation hook. Only an exact match to the
durable target may append one immutable `attempt_started` event under the shared
exact-Ad advisory lock. The event binds the source log, target hierarchy,
action, slashless Ad POST path, start time, and a two-minute attempt lease. The
provider call is forbidden on baseline drift, adapter precondition failure, or
start persistence failure. A received provider result must append one immutable
`attempt_completed` event before the source log becomes terminal. The
completion binds the exact one-attempt/no-automatic-retry receipt and one of:

- `provider_response_verified_success`;
- `provider_response_succeeded_verification_failed`;
- `provider_definite_failure`; or
- `provider_outcome_ambiguous`.

An unexpected throw after the immutable start may intentionally leave the
source pending with only `attempt_started`; a second POST is never inferred or
attempted. Started/completed events are append-only, evidence-hashed, and
idempotent only for the same normalized fact. The store and database trigger
both require the start target to equal the source claim's durable journal
target. Once a reconciliation event exists for that source, neither a late
start nor a late completion may be appended. Event `created_at` is
database-canonical and caller backdating is rejected; completed-attempt
reconciliation requires provider `observedAt` at or after the durable
completion event.

A live journal-required manual source may become terminal only through one of
the journal-consistent paths enforced by both store and database:

- success requires an exact `provider_response_verified_success` completion;
- `silent_failure` requires an ambiguous or
  successful-response/verification-failed completion;
- a provider failure requires an exact `provider_definite_failure` completion;
  or
- a pre-provider DB-only failure requires one of the closed, explicitly
  non-mutation post-claim/start/adapter-abort/bulk-abort proof shapes and no
  attempt event.

Generic action-log completion cannot bypass this guard. Dry-run, native, legacy
pre-contract, and non-status manual logs retain their own contracts. Protected
source identity, journal target/contract, and committed terminal fields are
immutable on every update; attempt and reconciliation events are append-only.

Direct and bulk live status routes run the same automatic reconciliation
preflight before any new claim or provider write. It performs no provider GET
before the source-specific settlement floor:

- a completed attempt waits five minutes after completion;
- a started-only attempt waits through its two-minute lease and five additional
  minutes;
- a journal-contract pending row with no start waits five minutes after claim
  creation; and
- a pre-contract legacy `silent_failure` with no physical-account identity is
  quarantined for seven days after its latest requested/updated/verified
  timestamp and is eligible only when the database resolves one exact target.

After that floor, reconciliation performs one bounded exact-state read sequence
and requires matching business, physical account, Ad, creative, campaign,
ad-set, configured/effective status, active parent hierarchy, and policy
eligibility. Under the same advisory key, it revalidates the unchanged source
authority and appends one immutable
`meta-manual-ad-status-reconciliation.v1` event with provider GET evidence and
hash. The only resolutions are `current_state_matches_requested` and
`current_state_matches_precondition`; neither rewrites the historical terminal
fact or pretends the old provider attempt succeeded. A final source reread must
prove the unresolved blocker disappeared. Missing, multiple, contradictory,
stale, ineligible, or persistence-uncertain evidence fails closed with zero
provider POSTs.

If the reconciled current configured/effective state already equals the new
request's desired status, that request returns a verified no-op and creates no
new mutation claim. Otherwise the route creates a fresh exact claim and runs
the normal post-claim preflight plus single-attempt journal. These rules are
provider-generic and identical for every business; no firm-specific bypass,
manual provider mutation, or timeout-only deletion can clear a hold.

A concurrent native same-key loser receives HTTP 409 with the existing pending
idempotency receipt and `action_in_flight`; if that receipt already has a
reconciliation marker, the response instead carries the marker's common error
code, `reconciliationRequired: true`, and `retryAllowed: false`. A concurrent
native different-key loser receives HTTP 409 with
`decision_origin_pending_reconciliation_required`,
`reconciliationRequired: true`, and `retryAllowed: false`. Cross-origin and
manual/manual conflicts receive HTTP 409 `action_in_flight`,
`blockingActionLogId`, `blockingOrigin`, and `retryAllowed: false`; a native
reconciliation receipt is included when applicable. Every variant authorizes
zero provider POSTs. Direct and bulk status endpoints must reach this shared
classifier rather than substituting native-only or time-window pending guards.

Before the first mutation:

- the exact business-owned provider account and requested entity IDs must
  resolve from server-held identity;
- a fresh provider GET must prove returned entity ID, `account_id`, creative
  identity, configured/effective status, policy eligibility, and every
  required parent link;
- duplicate/reuse must prove the source Ad/creative and ACTIVE target
  ad-set/campaign;
- new-campaign creation must prove every selected creative/account; and
- bulk and multi-create requests must pass all target, pending-action, and
  cardinality checks as one preflight set.

The all-target set is the initial batch gate: one failure there prevents the
first provider mutation. After either a manual or native Ad status action has
atomically claimed its pending log row, it must rerun the exact live preflight;
native ignores only its own pending receipt. A blocked manual post-claim
preflight is persisted as a DB-only terminal failure and performs no provider
POST. Bulk status execution performs an additional fresh exact-state and
unresolved-owner check immediately before each manual provider POST. The source
must still be the same pending claim and must still own the exact durable
target; a concurrent reconciliation or ownership change stops the current and
remaining items with no additional POST. A later claim conflict or preflight
failure never represents earlier completed mutations as rolled back. Any halt
DB-only terminalizes every untouched later prepared claim; cleanup uncertainty
returns reconciliation-required 503.

Provider-verified manual status success uses
`meta-ad-status-write-verification.v1`. The write adapter binds a complete
execution-state baseline immediately before its one allowed POST, then performs
a fresh complete read. Success requires unchanged provider account, Ad,
creative, campaign, and ad-set identity; requested Ad configured and effective
status; ACTIVE campaign/ad-set configured and effective status; policy
eligibility; null review blocker; observation time; and the unmodified provider
GET evidence. The store and database completion trigger revalidate this
canonical payload against the immutable attempt target and requested action.
Any missing field, effective-state drift, parent drift, policy/review blocker,
or identity contradiction is verification failure, never verified success.
Every provider GET and the sole POST are bounded at 30 seconds. Mutation fetches
use redirect-error semantics so provider redirects cannot replay the POST; no
POST retry is allowed. Bounded terminal retries reuse one frozen,
byte-identical terminal fact, including duration.

Post-write verification repeats returned ID, provider-account, creative,
campaign, and ad-set checks before an intent or action log can become
successful. A newly finalized provider-verified native pause/resume receipt
persists the full proof as:

```ts
interface ExactMetaStatusVerificationLineage {
  sourceCreativeId: string;
  sourceCampaignId: string;
  sourceAdsetId: string;
  verifiedProviderAccountId: string;
  verifiedCreativeId: string;
  verifiedCampaignId: string;
  verifiedAdsetId: string;
}
```

The verified account must equal the physical provider account and every
verified creative/campaign/ad-set ID must equal the corresponding immutable
source/episode ID. This object is part of the immutable receipt hash; changing
one field without changing the receipt is a hash mismatch, while a recomputed
but contradictory object still fails exact episode/provider lineage checks.

`verification_lineage` remains nullable only for receipts persisted before the
additive column existed. When it is null, the receipt hash intentionally omits
the `verificationLineage` property and therefore preserves the old canonical
hash bytes. Readers may accept that old receipt under its recorded contract,
but may not invent the missing hierarchy or treat null as newly observed live
proof. New provider-verified status finalization writes the complete non-null
object.

Every native decision-origin condition that cannot be safely terminalized leaves
the existing attempt pending and uses one common reconciliation error code:

```ts
type DecisionOriginReconciliationOutcome =
  | "provider_outcome_ambiguous"
  | "provider_response_succeeded_verification_failed"
  | "provider_write_verified_receipt_persistence_failed"
  | "dry_run_terminal_persistence_failed"
  | "provider_rejection_terminal_persistence_failed"
  | "pre_provider_terminal_persistence_failed";

{
  errorCode: "provider_verification_persistence_failed";
  outcome: DecisionOriginReconciliationOutcome;
  reconciliationRequired: true;
  retryAllowed: false;
  providerMutationAttempted: boolean;
  providerMutationSucceeded: boolean;
  providerOutcomeAmbiguous: boolean;
}
```

`provider_outcome_ambiguous` means a provider POST began but exact external
outcome is unknown. `provider_response_succeeded_verification_failed` means the
response proves mutation success but exact verification failed.
`provider_write_verified_receipt_persistence_failed` means mutation and
verification succeeded but atomic terminal row/receipt persistence failed.
`provider_rejection_terminal_persistence_failed` means a definite rejection was
received but its terminal failure could not be persisted.
`pre_provider_terminal_persistence_failed` and
`dry_run_terminal_persistence_failed` both assert that no provider mutation
occurred; the latter is specifically a non-mutation dry-run DB-only terminal
persistence failure.

The marker retains available mutation-attempt, provider-response, and
verification evidence but does not set success, `provider_verified`,
`verified_at`, or terminal-finalization authority. A pending reconciliation row
cannot emit an immutable operator-action receipt and is always treatment
ineligible, even when its outcome proves provider mutation success. A same-key
replay returns this non-retryable reconciliation state and performs zero
provider POSTs; a different key for the same exact Ad is likewise blocked. It
may become terminal only after exact reconciliation against current provider
state. A reader may expose `providerMutationSucceeded: true` only when the
marker carries a success-compatible outcome, mutation attempted and succeeded
are both explicitly true, and ambiguity is explicitly false. Missing or
contradictory fields remain unknown.

`rebuild_creative` is not executable until image, creative, and Ad steps have
durable attempt receipts. Provider create/duplicate POSTs are not automatically
retried without a provider-idempotent attempt contract; bounded retry remains
allowed for GET verification only.

Every live manual duplicate declares
`meta-manual-ad-duplicate-attempt.v1` and persists exact preparation and start
authority before its sole create POST. Duplicate-create rejection finality is
narrow: only a structured, non-retryable 4xx Meta rejection whose
`is_transient` value is the literal JSON boolean `false` is definite. A
missing, null, or string transient flag is ambiguous. Network exceptions,
408/425/429, 5xx, transient/retryable errors, and 2xx responses without an
exact result identity remain ambiguous external action results and retain the
unresolved claim. For an unverified successful 2xx, a nonblank top-level
provider response id must equal the durable resulting Ad id; otherwise both
cannot be persisted as one completion fact. The mutation receipt separately
preserves the literal transport/HTTP fact: a successful received 2xx remains
`provider_response_received`, while its missing identity produces
`provider_response_succeeded_verification_failed`. The database enforces this
layered geometry and does not permit either unresolved outcome to become a
definite release. A pre-contract legacy `failure` without complete current
journal and physical-account authority is also retry-blocking because its old
provider finality cannot be reconstructed safely; a current journaled definite
rejection remains retryable. Preparation/start/completion, reconciliation, and
read-observation facts are append-only and exact-lineage bound.
The migrated schema also rejects a pre-contract live manual duplicate insert
before provider work, so an older application rollback disables this write
surface instead of bypassing the journal. Only the current canonical
non-mutating dry-run envelope is exempt; an older pre-contract dry-run may also
fail closed. An UPDATE cannot create or reshape a contractless live manual
duplicate envelope.

Settled unresolved duplicates are recovered only by the natural scheduler's
bounded provider-GET sweep. A known result id requires one exact point GET. A
lost id requires a token-free cursor traversal whose append-only segments bind
one scan cycle and cumulative exact-match set. Partial scans cannot authorize
success. Only a complete cycle with exactly one cumulative marker/name/account/
ad-set/creative/PAUSED match plus an exact point GET can reconcile success.
Absence, multiple matches, incomplete reads, identity drift, or persistence
uncertainty remain quarantined; no timeout or manual row update releases the
claim.

For native decision-origin status actions, a provider POST transport exception
uses the pending `provider_outcome_ambiguous` reconciliation outcome above and
creates no immutable operator-action receipt. Manual status actions retain
terminal `silent_failure` action-log compatibility when a terminal fact can be
persisted; a new journaled raw throw may instead remain pending with only its
immutable start so settlement authority is not invented. Launchpad retains its
separate terminal attempt-receipt behavior. For status mutations, a received
provider HTTP rejection is a definite failure when terminal persistence
succeeds; the narrower duplicate-create classification above is the explicit
exception. Multi-step execution stops after either mutation failure.

Every manual action-log completion is a pending-only compare-and-set. Repeating
the same JSONB-normalized terminal fact is idempotent; a different terminal
fact conflicts and cannot overwrite the first outcome. A live raw adapter
exception before the pre-mutation hook is an exact DB-only zero-write failure.
An exception after the immutable start remains pending as an ambiguous external
outcome, with no inferred mutation success and `retryAllowed: false`; it blocks
every later provider claim for the exact Ad until reconciliation. Terminal
status alone does not make an ambiguous external outcome safe to retry. The
append-only journal and exact-state reconciliation above are the only generic
recovery path. If a verified success or other manual terminal fact cannot be
confirmed after two identical completion attempts, the response is a typed
`503` carrying the action-log identity and non-retryable disposition; bulk
execution omits every later item and no fallback failure completion is allowed.

The shared Launchpad fan-out contract rejects more than 20 creatives, 10 ad
sets or targets, or 20 planned provider creates before intent persistence or
provider work. The manual bulk status contract separately rejects more than
20 exact Ads.

The LaunchIntent request fingerprint binds the exact manual authority and
normalized payload while excluding attempt identity fields. Validation,
result/error receipts, and action logs carry that fingerprint. An unresolved
ambiguous intent blocks any fresh-key intent for the same business, physical
account, operation, and semantic fingerprint before persistence. The guard has
no timeout without an explicit reconciliation record. A retry or recovery
implementation must reconcile provider state against that fingerprint and the
recorded step attempts; it must not replay a POST from an ambiguous success.

## Native Ad Fact Ownership And Replay Proof (D066)

`upsertMetaAdDailyRows` accepts only its authoritative fact mode:

```ts
interface MetaAdDailyWriteOptions {
  writeMode: "authoritative_fact";
}
```

The explicit `authoritative_fact` mode retains the existing
insert, reference-resolution, provider-account metadata, Ad-dimension, fact,
and truth-version contract. Any other runtime mode, including the removed
`creative_enrichment` lane or an omitted mode, throws before DB access.
Creatives metadata sync writes only dedicated creative
daily/dimension/media presentation tables and must leave every byte and
timestamp of `meta_ad_daily` unchanged.

The authoritative lane recursively strips creative-media, preview, and
media-debug keys from `payload_json` before persistence while preserving metric
and other decision-evidence keys. The creative-media retention routine is
presentation-storage cleanup only: `meta_ad_daily` is excluded from its table
readiness contract, no Ad-day row or timestamp is mutated or deleted, and its
Ad-day update count is always zero.

Peer calibration and strict account evidence are intentionally non-identical:

- peer eligibility requires exact same-day Ad/campaign/ad-set hierarchy, all
  three truth states `FINALIZED`/`PASSED`, and cutoff-safe created/updated
  timestamps; Ad `finalized_at` may be null and is then quality-counted;
- physical-account AOV/currency/timezone eligibility additionally requires a
  non-null cutoff-safe Ad `finalized_at`.

The v7 current-day replay admits exactly three safe calibration classes only
after hash-bound production recomputation proves both projections, resolved
inputs, and resolved campaign contexts. Two
`profile_availability_restatement` classes are forward-only: exact
ready-profile collecting Test More to Keep under calibration-only maturity, or
the exact `native_calibration_missing` soft-only profile to an ordinary
non-hard Keep/Test More profile with zero hard-action eligibility on both
sides. The third, `calibration_restatement`, requires both sides to be ordinary
non-hard Keep/Test More with the identical action-semantic tuple while only
calibration-profile evidence changes. All three require unchanged exact
identity/input/data health/context and no hard label, `cut_candidate`, or
pending-transition artifact. `calibration_restatement` additionally requires
null blocker/blocked action/authorization and no hysteresis, OR — added by D091
— an IDENTICAL held verdict on both sides: the same `preAuthorityLabel`,
`blockedActionType` and `authorityBlocker`, `authorizedAction` null on both, no
hysteresis, no `cut_candidate` and no pending artifact. A held verdict
authorizes nothing, so a bounded numeric restatement beneath one is still
bounded; but a hold that appears on only ONE side, or whose action or blocker
CHANGES, is semantic drift, and a held verdict remains excluded from both
`profile_availability_restatement` classes — those permit label TRANSITIONS
without an action-tuple equality check, so admitting a hold there would let a
brand-new held verdict pass as benign. A reason or badge
difference is safe only when production reproduction proves it is the
deterministic consequence of the calibration-only profile change. Reverse,
hybrid, arbitrary label/reason/context, hard-action, identity, or data-health
drift is `semantic_drift` and fails release.

The focused and all-current-population compact artifacts use
`adsecute.meta.native-ad-account-aov-current-day-production-parity.v7`, bind
the omitted full-row artifact and pre-output repository manifest, and require
an adjacent checksum. The real PostgreSQL seam must prove enrichment
immutability and retained authoritative upsert/truth-version behavior.

## Constraints

- Do not collapse `primaryDecision` and `buyerAction`.
- Do not add `brief_variation` to row-level `BuyerAction`.
- Row decision must expose engine root for drawer.
- Snapshot must include `engineVersion`, `adapterVersion`, `configVersion`, `generatedAt`, `dataFreshness`, `inputCoverageSummary`, and `missingDataSummary`.
- Do not expand `CreativeDecisionOsV21PrimaryDecision`. Upstream engine labels
  that do not match the existing six values (V3 `keep`, `same_as_canonical`,
  `out_of_scope`) ride on the optional `sourceDecision` audit metadata. See D020.
- Do not expand `CreativeDecisionCenterBuyerAction` for campaign-kind execution
  moves. Pair the existing `scale` buyerAction with the optional
  `executionAction` field. See D019.
- `actionBoard` stays keyed only by `buyerAction`. `executionAction` is row-level
  metadata and must not become a top-level bucket.

## Minimal Drawer Fields

- `buyerAction`
- `buyerLabel`
- engine `primaryDecision`
- `actionability`
- `problemClass`
- `reasonTags`
- `evidenceSummary`
- blockers
- `confidence`
- `maturity`
- `priority`
- `nextStep`
- `missingData` if any
