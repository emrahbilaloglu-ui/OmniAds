# Generalized point-in-time historical replay — six-business backtest of the candidate decision engine (2026-08-30, correction 4 / revision 9)

**Revision notice.** Revisions 1–2, 3–4 (correction 1), 5 (correction 2),
and 7 (correction 3) were each independently **REJECTED**; the full
ledger is embedded in the artifact (revisions 1–9, prior verdicts
preserved). Correction 3 fixed the four correction-2 findings — target
"exact" semantics that reproduced the `[0, expected]` mixed pattern;
attested sections passing cascading rehash with no external anchor;
remaining non-composite business/account keys; an incomplete declared
source set — and every one of those fixes was independently reproduced
and confirmed valid. Correction 3 was nonetheless rejected for a single
narrow defect of a different kind: the anchored-tier adversarial test
hard-coded an ephemeral Claude session scratchpad directory as the
destination for its mutated attack artifacts, so it passed only because
that machine-specific directory happened to exist.

**Correction 4 (this revision) is an OFFLINE portability closure — zero
DB reads, frozen raw inputs untouched.** The anchored-tier test now
creates an exclusively owned per-run temporary directory under the
platform temp root, removes exactly that directory in a `finally`
block, and proves its non-existence afterwards; nothing is written
inside the repository. A new fail-first repository portability guard
censuses every repository test file and rejects hard-coded
session-specific or user-specific absolute paths. No replay result,
denominator, threshold, or verification tier changed.

**Verdict.** Unchanged in direction: on 279 deterministic historical
origins (population 3,231 selected-account origin-days, 2025-03-02 →
2026-08-22, horizons 1/3/7/14/28/60/90), the candidate engine is
fail-closed to the point of complete hard-action withholding — zero
enabled hard actions in 15,508 selected historical and 15,508 selected
stale rows (all 24 Cut-labelled rows are held stop-loss cuts under the
closed `campaign_context` authority), 91.1% abstention, kind semantics
active on 0 rows by design. The replay validates SAFETY and determinism;
it cannot validate hard-action quality (no enabled action exists),
causal lift (UNKNOWN — no replayed action was ever executed; only
retrospective associations and policy proxies are reported), strict PIT
safety (0 of 279 origins provable), or **target version consumption**
(unobservable — see §4). Automation remains OFF.

Labels: **[fact]** (frozen artifact), **[derived]**, **[inference]**,
**[assumption]**, **[unknown]**. Layers separated: deterministic replay
fact → later observed outcome → retrospective proxy → causal conclusion
(UNKNOWN throughout).

## 1. Two-tier verification — what each tier actually proves [fact]

- **Tier 1 (semantic verifier)** rederives every genuinely derived
  section from the frozen raw inputs — the analysis (including two-layer
  target verification and the scenario matrix), the primary role
  timelines and role analysis (rebuilt from raw tuples), and the
  recovery model — enforces the exact 25-key protected-section manifest,
  semantic invariants (RR/RO proof, name-blind contract, ledger schema,
  base verdict), and declared-source hash pinning. It **returns the list
  of extraction-attested sections it cannot rederive** (raw rows, engine
  outputs, persisted-inference counts, ledger text, full UI decision
  payloads incl. reason/badges, transaction proofs) and never claims
  those are semantically verified.
- **Tier 2 (anchored package verifier, `verify-package`)** computes the
  evidence file's byte SHA-256 and compares it to the
  `evidenceFileSha256Anchor` embedded in this report's machine-facts
  block. Any byte mutation of attested content followed by a complete
  internal rehash fails this tier. The canonical package passes both
  tiers, run twice with identical outputs. The three anchored-tier
  attacks are staged in a portable, per-run, exclusively owned temp
  directory (correction 4) that is removed and proven gone — the test
  depends on no machine-specific path and writes nothing into the
  repository.
- **Boundary [fact]:** a coherent rewrite of BOTH the artifact and this
  report's anchor is not detectable without a cryptographic signature or
  task-record anchor; none exists. The independently reproduced
  correction-2 attacks (persisted count 0→999; fabricated ledger
  verdict; fabricated UI reason/badges — each followed by full cascading
  rehash) now behave exactly per contract: the semantic tier reports the
  attested boundary honestly, and the anchored tier FAILS each of them
  (regression-tested). The adversarial case count is generated from the
  exported case list, never hand-maintained.

## 2. Composite identity — completed closure [fact]

Beyond the correction-2 tuple/selection/outcome/prior-state keys,
correction 3 completes the remaining composite paths: campaign name
points and first-seen rows now carry `businessId` (offline-migrated via
a fail-closed unique account→business mapping; ambiguous or missing
mappings abort), `campaignMetaAsOf` filters business+account, the
extraction builds **per-account context maps** chosen by each decision
input's resolved account (a business-global campaignId key no longer
exists), and freshness pairing, flip metrics, unique-decision
denominators, `byAccount`, representative row references, and the UI
consistency index all key business+account+creative. Adversarial tests
cover the same account id under two businesses and two accounts in one
business with identical campaign/creative ids. The real frozen scope
remains cardinality-clean (no account under two businesses — measured,
test-pinned).

## 3. Temporal integrity [fact/derived]

Unchanged and re-verified under revision 9: exact per-origin decision
cutoff, no future allowance, **overall PIT-safe origins 0 of 279**, 12
origins carry the source-layer-only lifecycle-snapshot characteristic,
all 279 `restated_retrospective`; `restated_after_days` is restatement
metadata, never a reconstruction; restated origins can never be promoted
to PIT-safe (regression-tested). Origin-as-of relaunch stands at
**2,202** classified rows.

## 4. Two-layer target verification [fact]

- **Layer 1 — authoritative selection/version evidence:** the expected
  bitemporal history row at the production 03:00Z instant is frozen per
  origin (row id, effectiveAt, recordedAt, operation, values). Because
  correction 2 froze no observed row id/recordedAt per decision,
  **version consumption is `source_version_unobservable` for all 20
  target-present origins and the version-proven exact count is 0**; a
  truth-source family string plus an equal value is not version proof.
  The other 259 origins have `no_versioned_target`.
- **Layer 2 — per-decision consumption over EVERY selected row:** each
  origin freezes row counts and distinct effective-target values BY
  truth source plus the all-row served-value set. On the frozen data:
  **1 origin is an all-row value singleton matching the expectation**
  (ColorFullWorldsTR 2026-07-20, `[4]`) and **19 are
  `mixed_sources_including_expected`** — the `[0, expected]` pattern
  (target-claiming rows serve the expected value while out-of-scope
  fallback rows serve 0); 0 mixed-target-value, 0 wrong-value, 0
  phantom-target origins; 259 `no_versioned_target`. Nothing in this
  package calls a mixed set "exact"; correction 2's
  "20 exact_match_singleton" claim is **withdrawn**.

## 5. Decision layer, outcomes, scenarios [fact/derived]

Preserved real-data results (machine block §8): 15,508 selected
historical rows (keep 1,362 · test_more 8,038 · out_of_scope 5,315 ·
diagnose 769 · cut 24 — all 24 held), enabled hard actions 0, held
1,993, abstention 91.1%; 15,508 selected stale rows with 0 enabled hard
actions; deselected appendix 635/635; unscoped 0/0; 53 scenario cells
(3 explicitly unsupported); attribution embargo 7 days (95,862 mature /
2,434 immature cells); proxies with unique denominators (missed-cut
5,434 unique decision-origins / 1,492 creatives; hold-consistent 2,492 /
733); flip metrics under the grid-chained qualification. No
counterfactual revenue, savings, or lift anywhere; hard-action quality
remains unmeasurable.

## 6. Role inference, UI truth, support, recovery, baseline [fact]

Name-blind primary inference (zero manual labels, ablation-tested):
resolved-at-medium 8,968 / unresolved 6,540 / kind-active 0. Persisted
production context: 0 account-scoped vs 2,350 legacy null-account rows
[extraction-attested; anchored-tier protected]. Support matrix is
account-aware with the execution grain explicit — six selected accounts
(population 538–539, own-plan 46–47, executed 46–47 within range) and
TheSwaf's deselected account **392 / 36 / 0**. Seven real frozen UI
states project through the server-owned adapter (review-only ⇒ no
execution action; held ⇒ blocked "Cut · Held"; stale/unresolved/blocked
⇒ never an enabled hard mutation); full UI decision payloads
(reason/badges) are byte-anchored, not semantically rederived — stated
in the verification contract. Recovery stays a pure local model. The
`babf158e…` base engine replay stays honestly unsupported (guarded).

## 7. Blockers and enable-readiness (unchanged)

P0: populate account-scoped role context (D074 job); run the D077
operator recovery chain. P1: authority-chain review before threshold
tuning; IwaTR target pack. P2: capture-time versioning for daily facts.
Review-only serving + recovery chain: ready for supervised operation.
Automatic execution: NOT ready. **Automation remains OFF.**

## 8. Machine-verified facts (generated from the artifact; carries the external package anchor)

<!-- MACHINE-FACTS BEGIN (generated by generalized-pit-replay.ts report-facts; do not hand-edit) -->

```json
{
 "contract": "adsecute.meta.generalized-pit-replay.v3",
 "artifactHash": "67cc313178dbdd463915c424e5fe40f8e75c3eeb9f2cf5c55d54e65592925edf",
 "currentRevision": 9,
 "origins": 279,
 "decisionRowsAllModesAllAccounts": 32286,
 "tuples": 89433,
 "decisionLayer": {
  "totalDecisionRows": 15508,
  "byBusiness": {
   "f8a3b5ac-588c-462f-8702-11cd24ff3cd2": 3504,
   "5dbc7147-f051-4681-a4d6-20617170074f": 2072,
   "6c690fa4-6395-40b5-9755-e99b34d69bc3": 4512,
   "172d0ab8-495b-4679-a4c6-ffa404c389d3": 1613,
   "b79683b4-6f87-48c0-a3ca-44d4356fef51": 2369,
   "bc0c6178-7853-4f6f-b026-ef0222a4b9e7": 1438
  },
  "byAccount": {
   "f8a3b5ac-588c-462f-8702-11cd24ff3cd2\u0000act_1087566732415606": 3504,
   "5dbc7147-f051-4681-a4d6-20617170074f\u0000act_805150454596350": 2072,
   "6c690fa4-6395-40b5-9755-e99b34d69bc3\u0000act_840779107261785": 4512,
   "172d0ab8-495b-4679-a4c6-ffa404c389d3\u0000act_822913786458311": 1613,
   "b79683b4-6f87-48c0-a3ca-44d4356fef51\u0000act_2335220976649516": 2369,
   "bc0c6178-7853-4f6f-b026-ef0222a4b9e7\u0000act_3554615364751964": 1438
  },
  "labelMix": {
   "keep": 1362,
   "test_more": 8038,
   "out_of_scope": 5315,
   "diagnose": 769,
   "cut": 24
  },
  "rawLabelMix": {
   "keep": 1291,
   "test_more": 8038,
   "out_of_scope": 5315,
   "diagnose": 769,
   "cut": 86,
   "refresh": 1,
   "scale": 8
  },
  "blockerMix": {
   "profile_hard_action_ineligible": 1872,
   "campaign_context": 95,
   "recent_recovery_unverifiable": 26
  },
  "roleStatusMix": {
   "resolved": 8968,
   "unresolved": 6540
  },
  "contextTrustMix": {
   "medium": 8968,
   "low": 4312,
   "unknown": 2228
  },
  "abstentionRate": 0.910626773278308,
  "hardActionCount": 24,
  "heldHardActionCount": 1993,
  "boundaryNearTargetCount": 507,
  "staleModeRows": 15508,
  "staleModeEnabledHardActions": 0,
  "enabledHardActionCount": 0,
  "freshnessBlock": {
   "historicalEnabledHardActions": 0,
   "blockedUnderWallClockStaleness": 0,
   "freshnessBlockRate": null,
   "note": "no ENABLED hard action exists anywhere in the historical replay (every hard signal is context-held or hysteresis-suppressed), so staleness had nothing further to demote; stale-mode enabled hard actions are independently zero"
  }
 },
 "appendix": {
  "note": "Diagnostic-only rows excluded from EVERY headline metric, action count, proxy, and UI/state selection above: deselected-account rows and fail-closed unscoped (null provider-account) rows.",
  "deselectedHistoricalRows": 635,
  "deselectedStaleRows": 635,
  "unscopedHistoricalRowsExcluded": 0,
  "unscopedStaleRowsExcluded": 0
 },
 "temporalCounts": {
  "origins": 279,
  "overallPitSafe": 0,
  "overallRestatedRetrospective": 279,
  "lifecycleSnapshotPersistedSameDay": 12,
  "roleLayerCaptureProven": false,
  "metricLayerCaptureProven": false,
  "note": "Overall PIT safety requires EVERY contributing layer (metrics, role/context, lifecycle) capture-proven at or before the origin's decision cutoff. This evidence cannot prove the role or metric layers for any origin, so the honest overall PIT-safe count is 0; lifecycleSnapshotPersistedSameDay is a SOURCE-LAYER characteristic only."
 },
 "targetVerification": {
  "layer1SelectionVersion": {
   "originsChecked": 279,
   "versionProvenExact": 0,
   "sourceVersionUnobservable": 20,
   "noVersionedTarget": 259
  },
  "layer2Consumption": {
   "originsChecked": 279,
   "allRowsValueSingletonMatchesExpected": 1,
   "mixedSourcesIncludingExpected": 19,
   "mixedTargetSourcedValues": 0,
   "targetSourcedWrongValueOnly": 0,
   "fallbackOnlyNoTargetClaimingRows": 0,
   "noDecisionRows": 0,
   "targetClaimingRowsWithoutVersionedTarget": 0,
   "noVersionedTarget": 259
  }
 },
 "cascadingAdversarialCaseCount": 18,
 "sourceManifestFileCount": 18,
 "sourceManifestFiles": [
  "scripts/creative-decision-center/generalized-pit-replay.ts",
  "scripts/creative-decision-center/generalized-pit-replay.test.ts",
  "lib/creative-decision-engine/engine.ts",
  "lib/creative-decision-engine/data-source.ts",
  "lib/creative-decision-engine/account-decision-profile.ts",
  "lib/creative-decision-engine/feature-flags.ts",
  "lib/creative-decision-engine/data-health.ts",
  "lib/creative-decision-engine/types.ts",
  "lib/creative-decision-engine/campaign-context/resolver.ts",
  "lib/creative-decision-engine/campaign-context/data.ts",
  "lib/creative-decision-engine/campaign-context/source.ts",
  "lib/creative-decision-engine/jobs/campaign-context-job.ts",
  "lib/creative-decision-engine/campaign-label-guard.ts",
  "lib/creative-decision-engine/outcome-classifier.ts",
  "lib/creative-decision-engine/decision-stability.ts",
  "lib/meta/canonical-decision-presentation.ts",
  "lib/db.ts",
  "scripts/_operational-runtime.ts"
 ],
 "outcome": {
  "matureEvaluatedCells": 95862,
  "immatureEmbargoedCells": 2434,
  "unsupportedDecisionHorizonCells": 10260,
  "proxies": {
   "prematureCutProxy": 0,
   "supportedCutProxy": 0,
   "prematureScaleProxy": 0,
   "supportedScaleProxy": 0,
   "missedScaleProxy": {
    "cells": 2811,
    "uniqueDecisionOrigins": 1119,
    "uniqueCreatives": 377
   },
   "missedCutProxy": {
    "cells": 26337,
    "uniqueDecisionOrigins": 5434,
    "uniqueCreatives": 1492
   },
   "holdConsistentProxy": {
    "cells": 7588,
    "uniqueDecisionOrigins": 2492,
    "uniqueCreatives": 733
   },
   "unknownOutcomeCells": 59126,
   "note": "Observational proxies over ATTRIBUTION-MATURE classifier outcomes under the action NOT taken; horizon cells are correlated duplicates (unique denominators included); causal effect of taking the action is UNKNOWN (no controlled treatment)."
  }
 },
 "flipMetrics": {
  "consecutiveDayComparisons": 935,
  "consecutiveDayFlips": 117,
  "consecutiveDayFlipRate": 0.12513368983957218,
  "biweeklyGridComparisons": 12706,
  "biweeklyGridFlips": 2282,
  "biweeklyGridFlipRate": 0.17960018888713994,
  "qualification": "The stabilization chain feeding these decisions is the SAMPLED origin grid, not a complete daily production chain; adjacent-pair flips measure single-step label agreement under that grid-chained prior state."
 },
 "scenarioCells": 53,
 "scenarioUnsupportedCells": 3,
 "relaunchAsOfRows": 2202,
 "supportMatrix": [
  {
   "businessId": "172d0ab8-495b-4679-a4c6-ffa404c389d3",
   "providerAccountId": "act_822913786458311",
   "isSelected": true,
   "firstOrigin": "2025-03-02",
   "lastOrigin": "2026-08-22",
   "populationDays": 539,
   "accountPlanSampledOriginCount": 47,
   "businessExecutionSampledWithinAccountRange": 47,
   "executionGrain": "decisions execute once per business origin; deselected accounts execute zero decision origins",
   "horizonSupportedOriginDays": {
    "h1": 538,
    "h3": 536,
    "h7": 532,
    "h14": 525,
    "h28": 511,
    "h60": 479,
    "h90": 449
   },
   "unsupportedReason": null
  },
  {
   "businessId": "172d0ab8-495b-4679-a4c6-ffa404c389d3",
   "providerAccountId": "act_921275999286619",
   "isSelected": false,
   "firstOrigin": "2025-07-26",
   "lastOrigin": "2026-08-21",
   "populationDays": 392,
   "accountPlanSampledOriginCount": 36,
   "businessExecutionSampledWithinAccountRange": 0,
   "executionGrain": "decisions execute once per business origin; deselected accounts execute zero decision origins",
   "horizonSupportedOriginDays": {
    "h1": 391,
    "h3": 389,
    "h7": 385,
    "h14": 378,
    "h28": 364,
    "h60": 332,
    "h90": 302
   },
   "unsupportedReason": null
  },
  {
   "businessId": "5dbc7147-f051-4681-a4d6-20617170074f",
   "providerAccountId": "act_805150454596350",
   "isSelected": true,
   "firstOrigin": "2025-03-02",
   "lastOrigin": "2026-08-22",
   "populationDays": 539,
   "accountPlanSampledOriginCount": 47,
   "businessExecutionSampledWithinAccountRange": 47,
   "executionGrain": "decisions execute once per business origin; deselected accounts execute zero decision origins",
   "horizonSupportedOriginDays": {
    "h1": 538,
    "h3": 536,
    "h7": 532,
    "h14": 525,
    "h28": 511,
    "h60": 479,
    "h90": 449
   },
   "unsupportedReason": null
  },
  {
   "businessId": "6c690fa4-6395-40b5-9755-e99b34d69bc3",
   "providerAccountId": "act_840779107261785",
   "isSelected": true,
   "firstOrigin": "2025-03-03",
   "lastOrigin": "2026-08-22",
   "populationDays": 538,
   "accountPlanSampledOriginCount": 46,
   "businessExecutionSampledWithinAccountRange": 46,
   "executionGrain": "decisions execute once per business origin; deselected accounts execute zero decision origins",
   "horizonSupportedOriginDays": {
    "h1": 537,
    "h3": 535,
    "h7": 531,
    "h14": 524,
    "h28": 510,
    "h60": 478,
    "h90": 448
   },
   "unsupportedReason": null
  },
  {
   "businessId": "b79683b4-6f87-48c0-a3ca-44d4356fef51",
   "providerAccountId": "act_2335220976649516",
   "isSelected": true,
   "firstOrigin": "2025-03-03",
   "lastOrigin": "2026-08-22",
   "populationDays": 538,
   "accountPlanSampledOriginCount": 46,
   "businessExecutionSampledWithinAccountRange": 46,
   "executionGrain": "decisions execute once per business origin; deselected accounts execute zero decision origins",
   "horizonSupportedOriginDays": {
    "h1": 537,
    "h3": 535,
    "h7": 531,
    "h14": 524,
    "h28": 510,
    "h60": 478,
    "h90": 448
   },
   "unsupportedReason": null
  },
  {
   "businessId": "bc0c6178-7853-4f6f-b026-ef0222a4b9e7",
   "providerAccountId": "act_3554615364751964",
   "isSelected": true,
   "firstOrigin": "2025-03-03",
   "lastOrigin": "2026-08-22",
   "populationDays": 538,
   "accountPlanSampledOriginCount": 46,
   "businessExecutionSampledWithinAccountRange": 46,
   "executionGrain": "decisions execute once per business origin; deselected accounts execute zero decision origins",
   "horizonSupportedOriginDays": {
    "h1": 537,
    "h3": 535,
    "h7": 531,
    "h14": 524,
    "h28": 510,
    "h60": 478,
    "h90": 448
   },
   "unsupportedReason": null
  },
  {
   "businessId": "f8a3b5ac-588c-462f-8702-11cd24ff3cd2",
   "providerAccountId": "act_1087566732415606",
   "isSelected": true,
   "firstOrigin": "2025-03-02",
   "lastOrigin": "2026-08-22",
   "populationDays": 539,
   "accountPlanSampledOriginCount": 47,
   "businessExecutionSampledWithinAccountRange": 47,
   "executionGrain": "decisions execute once per business origin; deselected accounts execute zero decision origins",
   "horizonSupportedOriginDays": {
    "h1": 538,
    "h3": 536,
    "h7": 532,
    "h14": 525,
    "h28": 511,
    "h60": 479,
    "h90": 449
   },
   "unsupportedReason": null
  }
 ],
 "accountBusinessCardinality": {
  "accountsAppearingUnderMultipleBusinesses": [],
  "note": "measured from the frozen scope; composite keys keep the replay correct even when an account id repeats across businesses"
 },
 "roleAnalysisPerAccount": [
  {
   "businessId": "172d0ab8-495b-4679-a4c6-ffa404c389d3",
   "accountId": "act_822913786458311",
   "campaigns": 61,
   "daysEvaluated": 2986,
   "publishedKindPoints": {
    "mixed": 40,
    "main": 109,
    "unresolved": 89,
    "test": 16
   },
   "transitions": 107,
   "suppressedFlipPoints": 38,
   "conflictPoints": 0,
   "nameBlindVsParityDisagreements": 12,
   "parityOnlyResolvedCampaigns": 12
  },
  {
   "businessId": "172d0ab8-495b-4679-a4c6-ffa404c389d3",
   "accountId": "act_921275999286619",
   "campaigns": 15,
   "daysEvaluated": 1044,
   "publishedKindPoints": {
    "mixed": 20,
    "main": 43,
    "unresolved": 20,
    "test": 1
   },
   "transitions": 33,
   "suppressedFlipPoints": 19,
   "conflictPoints": 0,
   "nameBlindVsParityDisagreements": 1,
   "parityOnlyResolvedCampaigns": 1
  },
  {
   "businessId": "5dbc7147-f051-4681-a4d6-20617170074f",
   "accountId": "act_805150454596350",
   "campaigns": 104,
   "daysEvaluated": 5348,
   "publishedKindPoints": {
    "mixed": 37,
    "main": 101,
    "unresolved": 129,
    "test": 24
   },
   "transitions": 102,
   "suppressedFlipPoints": 33,
   "conflictPoints": 0,
   "nameBlindVsParityDisagreements": 0,
   "parityOnlyResolvedCampaigns": 0
  },
  {
   "businessId": "6c690fa4-6395-40b5-9755-e99b34d69bc3",
   "accountId": "act_840779107261785",
   "campaigns": 36,
   "daysEvaluated": 3236,
   "publishedKindPoints": {
    "main": 148,
    "unresolved": 52,
    "mixed": 74,
    "test": 49
   },
   "transitions": 139,
   "suppressedFlipPoints": 67,
   "conflictPoints": 0,
   "nameBlindVsParityDisagreements": 2,
   "parityOnlyResolvedCampaigns": 2
  },
  {
   "businessId": "b79683b4-6f87-48c0-a3ca-44d4356fef51",
   "accountId": "act_2335220976649516",
   "campaigns": 5,
   "daysEvaluated": 690,
   "publishedKindPoints": {
    "mixed": 8,
    "main": 24,
    "unresolved": 8,
    "test": 4
   },
   "transitions": 18,
   "suppressedFlipPoints": 7,
   "conflictPoints": 0,
   "nameBlindVsParityDisagreements": 0,
   "parityOnlyResolvedCampaigns": 0
  },
  {
   "businessId": "bc0c6178-7853-4f6f-b026-ef0222a4b9e7",
   "accountId": "act_3554615364751964",
   "campaigns": 9,
   "daysEvaluated": 900,
   "publishedKindPoints": {
    "mixed": 19,
    "main": 46,
    "unresolved": 15,
    "test": 5
   },
   "transitions": 35,
   "suppressedFlipPoints": 14,
   "conflictPoints": 0,
   "nameBlindVsParityDisagreements": 0,
   "parityOnlyResolvedCampaigns": 0
  },
  {
   "businessId": "f8a3b5ac-588c-462f-8702-11cd24ff3cd2",
   "accountId": "act_1087566732415606",
   "campaigns": 37,
   "daysEvaluated": 3935,
   "publishedKindPoints": {
    "main": 151,
    "test": 39,
    "unresolved": 68,
    "mixed": 88
   },
   "transitions": 157,
   "suppressedFlipPoints": 75,
   "conflictPoints": 0,
   "nameBlindVsParityDisagreements": 2,
   "parityOnlyResolvedCampaigns": 1
  }
 ],
 "uiTruthStateCount": 7,
 "persistedInference": {
  "note": "Only account-scoped rows are consumable by the D074 runtime (readCampaignContextMap requires a matching provider_account_id); legacy null-account rows reach no decision.",
  "accountScopedRowsByBusiness": {
   "172d0ab8-495b-4679-a4c6-ffa404c389d3": 0,
   "5dbc7147-f051-4681-a4d6-20617170074f": 0,
   "6c690fa4-6395-40b5-9755-e99b34d69bc3": 0,
   "b79683b4-6f87-48c0-a3ca-44d4356fef51": 0,
   "bc0c6178-7853-4f6f-b026-ef0222a4b9e7": 0,
   "f8a3b5ac-588c-462f-8702-11cd24ff3cd2": 0
  },
  "legacyNullAccountRowsByBusiness": {
   "172d0ab8-495b-4679-a4c6-ffa404c389d3": 758,
   "5dbc7147-f051-4681-a4d6-20617170074f": 379,
   "6c690fa4-6395-40b5-9755-e99b34d69bc3": 405,
   "b79683b4-6f87-48c0-a3ca-44d4356fef51": 149,
   "bc0c6178-7853-4f6f-b026-ef0222a4b9e7": 103,
   "f8a3b5ac-588c-462f-8702-11cd24ff3cd2": 556
  },
  "lifecycleCoverage": [
   {
    "businessId": "172d0ab8-495b-4679-a4c6-ffa404c389d3",
    "minAsOf": "2026-05-04",
    "maxAsOf": "2026-08-22",
    "rows": 17762
   },
   {
    "businessId": "5dbc7147-f051-4681-a4d6-20617170074f",
    "minAsOf": "2026-05-25",
    "maxAsOf": "2026-08-22",
    "rows": 11416
   },
   {
    "businessId": "6c690fa4-6395-40b5-9755-e99b34d69bc3",
    "minAsOf": "2026-07-03",
    "maxAsOf": "2026-08-22",
    "rows": 6011
   },
   {
    "businessId": "b79683b4-6f87-48c0-a3ca-44d4356fef51",
    "minAsOf": "2026-07-03",
    "maxAsOf": "2026-08-22",
    "rows": 5300
   },
   {
    "businessId": "bc0c6178-7853-4f6f-b026-ef0222a4b9e7",
    "minAsOf": "2026-07-03",
    "maxAsOf": "2026-08-22",
    "rows": 2713
   },
   {
    "businessId": "f8a3b5ac-588c-462f-8702-11cd24ff3cd2",
    "minAsOf": "2026-05-04",
    "maxAsOf": "2026-08-22",
    "rows": 9145
   }
  ]
 },
 "evidenceFileSha256Anchor": "56f4472ba94363987a0c9854d3a20dbcd23a89dc9e9037f773e822e2be4ddfe1",
 "attestedSectionsNotSemanticallyVerified": [
  "scope",
  "targetHistory",
  "coverage",
  "creativeDayTuples",
  "campaignNamePoints",
  "campaignFirstSeen",
  "originPlans",
  "perOriginDecisions",
  "perOriginMeta",
  "persistedInference",
  "uiTruthStates",
  "correctionLedger",
  "provenance",
  "labelIsolation",
  "generatedAtUtc",
  "contract"
 ]
}
```

<!-- MACHINE-FACTS END -->
