# Automatic Campaign Context Resolver Spec - 2026-07-06

Status: design/spec only. No resolver behavior, DB migration, UI behavior, or
production decision path changes are approved by this document alone.

## Decision

Manual Campaign Labeling should be removed as an operator-required workflow.
Campaign context must still exist, but it should be produced automatically by a
server-side, deterministic Campaign Context Resolver.

The product should stop asking a buyer to label campaigns as Main, Test, or
Mixed. The engine should receive an inferred campaign context with confidence,
evidence, provenance, and a resolver version. If context cannot be inferred
safely, the engine keeps the current conservative posture under new automatic
context language.

User clarification on 2026-07-06: removing manual labeling does not mean
removing campaign context or removing all correction paths. The default source
must be backend automatic assignment. A user may later correct that assignment,
and the correction should be treated as an explicit, auditable override rather
than as the old required labeling workflow.

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
- `campaignKindSource`: where the role came from: `user_override`,
  `system_inferred`, or `unknown`.
- `campaignContextConfidenceClass`: `high`, `medium`, `low`, `unknown`, or
  `conflict`.
- `campaignContextEvidence`: bounded evidence payload with signal family
  scores and reason codes.
- `campaignContextResolverVersion`: deterministic resolver version string.
- `campaignContextOverride`: optional user correction with actor, timestamp,
  previous automatic value, reason, and resolver version being overridden.

The old phrase "campaign label missing" should disappear from buyer-facing
copy once the automatic system is active. Internal compatibility can keep old
fields as deprecated aliases during migration.

## Source Priority

Runtime source priority should be:

1. `user_override`, when a user explicitly corrects the automatic assignment.
   This is optional, auditable, and must not be a buyer-required workflow.
2. `system_inferred`, from the automatic resolver.
3. `unknown`, when no fresh, reliable context exists.

Existing `meta_campaign_labels` rows may be used as evaluation labels,
backfill seeds, or migration input for explicit user overrides. They must not
remain the primary operational source of truth.

## Signals

The resolver should score signal families, not a single raw rule.

| Signal family | Examples | Reliability note |
| --- | --- | --- |
| Behavioral and structural | creative ingress velocity, active creative count, median creative age, creative turnover, top-3 spend share, spend HHI, creative survival curve | strongest family; Test tends toward high turnover and lower per-creative caps, Main tends toward stable winner concentration |
| Creative reuse lineage | creative first appears in one campaign, then later in another campaign with larger budget | useful promote-trace signal, but current warehouse campaign attribution can blur multi-campaign creative lineage |
| Budget and structure | CBO/ABO, budget share, adset count, bid strategy, optimization goal | medium strength; must be account-normalized |
| Naming | account-specific tokens such as test, retest, perm, main, scale | high precision but low coverage; never sufficient alone |
| Age and continuity | campaign age, active duration, pause/reactivation pattern | supporting signal only |
| Historical labels | existing manual labels | evaluation ground truth, backfill seed, or migration input for explicit user overrides only |

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

Manual-label coverage is also uneven by account. Accounts with few or zero
historical labels, such as EMOLOS-like cases, cannot be validated by labeled
accuracy alone and need a user spot-check package before production
consumption.

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
- `campaign_context_conflict`: signal families disagree or a user override
  conflicts with inferred context.

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

## Migration Plan

1. Land this ADR/spec with no behavior change.
2. Add classifier golden cases for signal scoring, false-Test protection,
   conflict, unknown, hysteresis, and determinism.
3. Add a read-only historical evaluation harness against existing manual labels
   and historical replay output. Existing labels are evaluation evidence, not
   runtime truth.
4. Add a shadow-only producer/table path. The table can be populated without
   decisions consuming it.
5. Run live shadow for enough days to measure context distribution, flapping,
   inferred-vs-manual divergence, and decision divergence.
6. Flip decision consumption behind a kill switch such as
   `CAMPAIGN_CONTEXT_MODE=legacy_labels|automatic|unknown`. Default remains
   `legacy_labels` until the automatic path is approved for consumption:
   - `legacy_labels`: current behavior; existing labels are consumed and missing
     label/context keeps today's conservative guard behavior.
   - `automatic`: effective source priority is `user_override`,
     `system_inferred`, then `unknown`.
   - `unknown`: emergency context circuit breaker; all campaign context is
     treated as unresolved and hard actions demote under the existing
     missing-context safety posture.

   Because semantics change, bump the decision engine version.
7. Replace the manual label UI with an automatic-context review/correction
   surface, or hide it when no correction is needed, only after inferred context
   is proven. The user correction path is optional and must not block normal
   decision generation.
8. Keep additive snapshot fields and old field compatibility until historical
   snapshots no longer depend on old label status names.

## Validation Gates

Minimum gates before production consumption:

- High-confidence inferred rows should reach at least 90% accuracy against a
  reviewed labeled evaluation subset and must be reported as exact counts, for
  example `27/30` rather than only a percentage.
- False-Test rate must be explicitly measured and separately bounded. Recommended
  initial bar: zero false-Test classifications in the reviewed labeled subset,
  unless the user explicitly accepts a different integer bound.
- High-confidence unlabeled rows need a 10-15 campaign user spot-check package,
  prioritized toward accounts with sparse labels and EMOLOS-like coverage gaps.
- Context flapping must remain below an agreed threshold after hysteresis.
- Historical replay must quantify decision-label divergence and hard-action
  unlock/demotion changes.
- Live shadow must prove that unresolved/conflict rows use conservative
  fallback behavior.
- Full test suite, typecheck, lint, and diff checks must pass.

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
- Existing old snapshots with `campaignLabelStatus` remain readable.

## Remaining User Approval Gates

The user has approved the product direction that backend automatic assignment is
the default and users may optionally correct the assignment. Remaining gates
before production consumption are:

1. Should medium-confidence context allow mature severe stop-loss cuts to stay
   visible, or should all medium/low/unknown context demote hard actions exactly
   like today's unlabeled guard?
2. Does the user want to keep Main/Test/Mixed semantics, or remove those product
   semantics too? Removing them would also remove promote-to-main and Test
   refresh-to-cut behavior and needs a separate ADR.
3. What validation bar should block rollout if the high-confidence classifier
   misses the recommended 90% accuracy, exact false-Test bound, or user
   spot-check bar?

## Non-Goals

- No Meta writes.
- No automatic budget, bid, pause, or promotion action.
- No UI-side context inference.
- No row-level `brief_variation`.
- No removal of old snapshot compatibility.
- No immediate deletion of `meta_campaign_labels`, its route, or existing tests
  before the automatic path is proven and a user-override migration path exists.
