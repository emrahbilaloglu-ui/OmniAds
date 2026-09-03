# Automatic Campaign Context Resolver Spec - 2026-07-06

Status: implemented locally under D074 on 2026-08-29; not deployed. Automatic
campaign-role inference is the sole runtime source. The exact resolver version
still has zero hard-action authority until its independent validation gate is
explicitly configured. This document does not authorize a provider write,
automation enablement, deployment, or production DB mutation.

## Decision

Manual Campaign Labeling should be removed as an operator-required workflow.
Campaign context must still exist, but it should be produced automatically by a
server-side, deterministic Campaign Context Resolver.

The product should stop asking a buyer to label campaigns as Main, Test, or
Mixed. The engine should receive an inferred campaign context with confidence,
evidence, provenance, and a resolver version. If context cannot be inferred
safely, the engine keeps the current conservative posture under new automatic
context language.

User clarification on 2026-08-29 supersedes the earlier optional-correction
design: there is no manual role assignment or override path. A disagreement is
reported as resolver evidence and remains review-only; it is corrected by
improving and revalidating a versioned resolver, not by writing a label.

## Why Not Delete Context Outright

The current label path performs three different jobs:

1. It selects kind-aware calibration slices when a campaign is Main, Test, or
   Mixed.
2. It enables semantic transforms and buyer CTAs, such as Test refresh to Cut
   and Test scale to Promote to Main.
3. It blocks hard actions when campaign role is missing.

Removing manual labels without replacing these contracts would make Test and
Main campaigns interchangeable again. That would violate the existing
invariant that missing required context cannot produce high-confidence hard
actions.

## Terminology

- `campaignKind`: the campaign role consumed by the engine: `main`, `test`,
  `mixed`, or null/unknown.
- `campaignKindSource`: the runtime provenance: `system_inferred` or `unknown`.
- `campaignContextConfidenceClass`: `high`, `medium`, `low`, `unknown`, or
  `conflict`.
- `campaignContextEvidence`: bounded evidence payload with signal family
  scores and reason codes.
- `campaignContextResolverVersion`: deterministic resolver version string.
The old phrase "campaign label missing" should disappear from buyer-facing
copy. Historical snapshots and evaluation fixtures may retain deprecated field
names, but no live route or decision consumer may read manual-role storage.

## Source Priority

Runtime source priority is exactly:

1. `system_inferred`, from a fresh account-scoped persisted resolver row.
2. `unknown`, when account identity, freshness, confidence, evidence, or the
   exact authority-version gate is insufficient.

Existing `meta_campaign_labels` rows are frozen evaluation/migration evidence
only. They are not a fallback, a seed for runtime authority, or an override.
The buyer-facing GET/PUT route is a 410 tombstone and the management UI is
removed.

## Signals

The resolver should score signal families, not a single raw rule.

| Signal family | Examples | Reliability note |
| --- | --- | --- |
| Behavioral and structural | creative ingress velocity, active creative count, median creative age, creative turnover, top-3 spend share, spend HHI, creative survival curve | strongest family; Test tends toward high turnover and lower per-creative caps, Main tends toward stable winner concentration |
| Creative reuse lineage | creative first appears in one campaign, then later in another campaign with larger budget | useful promote-trace signal, but current warehouse campaign attribution can blur multi-campaign creative lineage |
| Budget and structure | CBO/ABO, budget share, adset count, bid strategy, optimization goal | medium strength; must be account-normalized |
| Naming | account-specific tokens such as test, retest, perm, main, scale | high precision but low coverage; never sufficient alone |
| Age and continuity | campaign age, active duration, pause/reactivation pattern | supporting signal only |
| Historical labels | existing manual rows | imperfect evaluation comparator only; never runtime input or authority |

## Known Data Constraints

Creative lineage is useful but must be capped until measured. Current warehouse
campaign attribution can blur multi-campaign creative reuse when a creative is
joined to the first non-null campaign-like source. That can make a promoted
creative look as if it only belonged to one campaign.

Historical evaluation must therefore report:

- lineage signal coverage;
- lineage conflict rate against behavioral/structural signals;
- cases where a creative appears in multiple campaign contexts but attribution
  collapses to one campaign;
- accuracy with and without the lineage signal family.

If lineage is sparse or polluted for an account, it should lower confidence or
carry a lower account-specific weight. It must not be the deciding signal for a
high-confidence Test/Main/Mixed classification.

Historical comparator coverage is uneven by account and may itself be stale or
wrong. Accounts with few or zero reviewed examples cannot be validated by
agreement alone and need an independent adjudication set before the exact
resolver version receives authority.

## Resolver Shape

The first resolver must be deterministic and explainable:

- Config-as-data weights and thresholds.
- No LLM/ML inference in the production decision path.
- Same input, config, and resolver version must produce the same output.
- Signal family scores should be stored in evidence JSON.
- Account-specific naming patterns should be config, not scattered code.
- Test classification must require stricter evidence than Main classification.
- Class changes require hysteresis, for example N consecutive days plus a
  score-margin requirement, so daily noise cannot flip action semantics.

Initial threshold defaults should be treated as spec placeholders until
historical replay validates them. A reasonable starting policy:

- `high`: strong absolute score, clear top-class margin, and at least two
  signal families agreeing.
- `medium`: plausible top class but insufficient evidence for kind-specific
  transforms.
- `low` or `unknown`: weak or stale evidence.
- `conflict`: strong disagreement between signal families or top classes too
  close to separate safely.

## Action Semantics

Campaign context has three roles, so each confidence class should gate those
roles separately.

| Confidence class | Calibration | Transforms and CTAs | Hard actions |
| --- | --- | --- | --- |
| `high` | Kind-aware slice can be used if existing sample floors pass | Full kind semantics enabled | Allowed subject to all other guards |
| `medium` | Canonical `all` only | No Test refresh-to-cut or promote-to-main transform; scale should become structure-review/near-scale copy | Mature severe cut visibility is an approval gate; hard scale should be downgraded |
| `low` or `unknown` | Canonical `all` only | None | Current unlabeled-equivalent behavior: hard actions demote to Diagnose |
| `conflict` | Canonical `all` only | None | Diagnose/structure review with conflict evidence |

`mixed` and `conflict` are not the same thing. `mixed` is a positive
`campaignKind` when evidence consistently shows that the campaign intentionally
combines stable winner spend with active testing behavior. `conflict` is a
confidence class when signal families disagree and no stable mixed explanation
is supported. A high-confidence `mixed` campaign can use Mixed semantics; a
`conflict` row must stay conservative and explain the disagreement.

Medium-confidence mature stop-loss cut is deliberately unresolved. Claude
recommended allowing mature severe cuts to remain visible with
`campaign_context_low_confidence`, while hard scale remains downgraded. This is
looser than today's unlabeled guard and requires explicit user approval before
implementation.

## New Blockers And Badges

Replace buyer-facing label blockers with automatic context blockers:

- `campaign_context_unresolved`: automatic context is missing, stale, or too
  weak. Existing hard-action demotion behavior should remain equivalent to the
  current label guard, including preserving `blockedActionType`.
- `campaign_context_low_confidence`: context is plausible but not strong
  enough for kind-aware calibration or Test-specific transforms.
- `campaign_context_conflict`: strong signal families disagree.

Buyer copy should explain evidence, not ask for labels. Example intent:
"Campaign role could not be resolved automatically; review structure before
changing budget or promotion flow."

## Runtime Architecture

Proposed read model:

`engine_v3_campaign_context_daily`

Recommended columns:

- `business_id`
- `provider_account_id`
- `campaign_id`
- `campaign_name`
- `as_of_date`
- `inferred_kind`
- `confidence_score`
- `confidence_class`
- `kind_source`
- `resolver_version`
- `signal_scores_json`
- `evidence_json`
- `conflict_reasons_json`
- `hysteresis_state_json`
- `input_freshness_json`
- `created_at`
- `updated_at`

The resolver should run in the producer/enrichment chain near calibration,
before decisions consume campaign kind. Daily briefing and decision jobs should
read persisted context. If the row is missing or stale, they must fall back to
unknown rather than recomputing expensive context inline.

The UI may display the context source and evidence summary, but must not
compute `buyerAction`, `campaignKind`, fallback semantics, or confidence class.

## Implemented Migration State

1. The deterministic producer persists account-scoped daily context under the
   unique identity `(business_id, provider_account_id, campaign_id, as_of_date)`.
2. Every live Meta decision consumer reads that automatic source. Missing
   provider-account scope fails closed; no cross-account campaign-ID collapse is
   allowed.
3. `CAMPAIGN_CONTEXT_MODE` now resolves to `automatic` unless explicitly set to
   the emergency `unknown` circuit breaker. The old `legacy_labels` value cannot
   restore manual authority.
4. `CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION` is an exact-version allowlist.
   It is intentionally unset by default. A high-confidence result from any
   unapproved/stale resolver remains review-only.
5. The manual management section and modal are deleted. `/api/meta/campaign-labels`
   returns 410 for reads and writes. Live pulse/workspace payloads expose
   `campaignRoleCoverage` with `classifiedCampaigns` and
   `unresolvedCampaigns`; they do not emit the old label-coverage wire field.
6. Historical snapshot fields and helper names remain readable only where
   required for immutable evidence compatibility. They grant no live authority.

## Validation Gates

Minimum gates before production consumption:

- High-confidence inferred rows must reach at least 90% on a frozen,
  independently adjudicated holdout with an agreed minimum denominator; exact
  counts are mandatory, not only percentages.
- False-Test rate must be explicitly measured and separately bounded. Recommended
  initial bar: zero false-Test classifications in the reviewed labeled subset,
  unless the user explicitly accepts a different integer bound.
- High-confidence rows lacking historical comparators need an independent
  10-15 campaign adjudication package, prioritized toward sparse accounts.
- Context flapping must remain below an agreed threshold after hysteresis.
- Historical replay must quantify decision-label divergence and hard-action
  unlock/demotion changes.
- Live shadow must prove that unresolved/conflict rows use conservative
  fallback behavior.
- Full test suite, typecheck, lint, diff checks, and seven natural production
  shadow waves must pass before setting the exact authority version.

Current evidence is useful but not sufficient for authority: the six-business
replay reaches 9/10 agreement on the high-confidence comparator subset, catches
both active Test examples, and emits no false Test there. The locked post-hoc
H11 regression remains rejected (high-confidence 63.64%, selected P1 72.73%,
historical Test recall 0/12). Therefore the authority env remains unset.

2026-08-29 addendum (D076): a lifecycle challenger
(`campaign-context-resolver.v3-lifecycle-2026-08-29`) was evaluated on the
new H11B frozen bundle (six businesses, truth-freshness-paired anchors
2026-06-15..2026-08-17). Its predeclared local gate returned **REJECT**
(high-confidence n=4 at 0.50 vs the 0.8 @ n>=5 bar; one low-class false
Test; LOBO-unstable at that n), so v2 remains the compiled default and the
challenger is parked offline. The run also measured the CURRENT resolver at
0.20 high-confidence accuracy on the fresh-label validation fold —
independent confirmation that the authority env must stay unset. The 90%
adjudicated-holdout gate above is unchanged and remains the only path to
authority; the sparse-account adjudication package (10-15 campaigns) is
still the binding blocker for Test-recall evidence, because five of the
seven frozen Test labels describe tests that concluded before observable
history begins.

## Golden Case List

Required golden cases:

- Stable high-spend, low-turnover campaign must not classify as Test without
  overwhelming evidence.
- Campaign with high creative churn, low per-creative caps, and test naming can
  classify as Test only when at least two signal families agree.
- Naming-only Test hint stays Medium or Low and must not enable Test
  transforms.
- Creative lineage A-to-B promote trace marks A more test-like and B more
  main-like, but only when lineage data is reliable.
- A stable campaign with intentional winner spend plus active testing behavior
  can classify as `mixed` when positive evidence supports it.
- Conflicting naming and behavior emits `campaign_context_conflict`, not
  `mixed`, unless a stable mixed explanation is independently supported.
- Missing or stale context emits `campaign_context_unresolved`.
- Medium-confidence scale downgrades to structure-review/near-scale.
- Medium-confidence mature cut remains a user-approval golden case, not an
  implemented behavior change.
- Hysteresis prevents one-day context flips.
- Existing old snapshots with `campaignLabelStatus` remain readable but cannot
  become a live role source.

## Remaining Activation Gates

No product choice remains about manual labels: they are not part of runtime.
Before automatic role context may authorize hard actions, the exact resolver
version must pass the independent holdout, false-Test, flapping, natural-wave,
and decision-divergence gates above. Until then Main/Test/Mixed is visible as
inference evidence while provider execution remains review-only.

## Non-Goals

- No Meta writes.
- No automatic budget, bid, pause, or promotion action.
- No UI-side context inference.
- No row-level `brief_variation`.
- No removal of old snapshot compatibility.
- No destructive production-table deletion in this local slice. Historical
  `meta_campaign_labels` data is retained only for audit/evaluation and can be
  removed later through a separately verified migration after all immutable
  compatibility readers are inventoried.
