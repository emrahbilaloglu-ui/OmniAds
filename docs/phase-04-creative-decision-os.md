# Phase 04 - Creative Decision OS V1

> Live release posture for this surface now lives in `docs/v3-01-release-authority.md` and `/api/release-authority`.
> This document remains a design and contract reference.

## Goal

Phase 04 turns `/platforms/meta/creatives` into a concept-first operator decision center.

Phase 05 keeps the same deterministic contract and read-only posture, but upgrades the shipped surface with:

- a dedicated resizable `Creative Decision OS` drawer instead of a long inline page block
- additive deterministic economics floors for scale promotion
- additive deployment compatibility evidence
- additive family provenance, protected winners, and supply planning boards
- structured filters that keep deterministic taxonomy and AI-tag provenance separate

The shipped surface must answer:

- which creative is scale-ready
- which creative should stay in test
- which creative is fatigued versus blocked
- which concept family is working
- which Meta lane, ad set role, and GEO context a creative belongs in
- what the deterministic engine decided versus what AI only commented on

## Guardrails

- The surface remains read-only. No write-back, queue persistence, or action execution is introduced in this phase.
- `Recommendations`, `Decision Signals`, and `AI Commentary` wording remains unchanged.
- The deterministic engine remains the source of truth for lifecycle, operator decisions, benchmarks, fatigue, and deployment guidance.
- `AI Commentary` remains bounded interpretation. It may summarize deterministic evidence and uncertainty, but it may not invent actions, targets, or deployment changes.
- `Operating Mode` remains the top commercial-truth guardrail for creative deployment aggressiveness.
- Export/share truth remains unchanged.
- `/platforms/meta/copies` is untouched.

## Exact code path

- `app/api/creatives/decision-os/route.ts`
- `lib/creative-decision-os.ts`
- `lib/creative-decision-os-config.ts`
- `lib/ai/generate-creative-decisions.ts`
- `components/platforms/meta/creatives/CreativeDecisionOsOverview.tsx`
- `components/platforms/meta/creatives/CreativeDecisionOsDrawer.tsx`
- `components/platforms/meta/creatives/CreativesTableSection.tsx`
- `components/platforms/meta/creatives/CreativeDetailExperience.tsx`
- `app/(dashboard)/platforms/meta/platforms/meta/creatives/page.tsx`

## Contract summary

Creative Decision OS ships as a versioned payload:

- `contractVersion`
- `generatedAt`
- `businessId`
- `startDate`
- `endDate`
- `summary`
- `creatives`
- `families`
- `patterns`
- `protectedWinners`
- `supplyPlan`
- `lifecycleBoard`
- `operatorQueues`
- `commercialTruthCoverage`

The engine is deterministic and typed. It does not depend on AI generation.

## Decision logic

### Family grouping

Family grouping precedence is fixed:

1. story or post identity
2. stable asset identity
3. normalized copy signature plus AI-tag signature
4. singleton fallback

Each family carries `familySource` so the operator can see whether the grouping came from strong identity or heuristic fallback.

Phase 05 tightens heuristic grouping:

- same format is required
- same deterministic primary taxonomy is required
- heuristic grouping only happens on exact normalized headline match, or matching `hookTactic + messagingAngle`
- each creative and family now carries provenance confidence plus over-grouping risk

### Contextual benchmarks

Benchmark cohort precedence is fixed:

1. `family`
2. `family + format`
3. `format + age`
4. `format + spend maturity`
5. `meta campaign family`
6. `format`
7. `account`

If a cohort is too thin, the engine falls back to the next cohort and records the fallback chain plus missing context.

### Lifecycle states

Lifecycle outputs are:

- `incubating`
- `validating`
- `scale_ready`
- `stable_winner`
- `fatigued_winner`
- `blocked`
- `retired`
- `comeback_candidate`

### Primary operator actions

Primary deterministic actions are:

- `promote_to_scaling`
- `keep_in_test`
- `hold_no_touch`
- `refresh_replace`
- `block_deploy`
- `retest_comeback`

These map back to the shipped `Decision Signals` action set so the Phase 03 baseline does not regress.

### Economics floors

`promote_to_scaling` is now gated by absolute floors, not benchmark wins alone.

- minimum `spend >= 200`
- minimum `purchases >= 4`
- if `targetRoas` exists, ROAS must meet it
- else if `breakEvenRoas` exists, ROAS must clear `breakEvenRoas + 0.15`
- else fallback floor is `spend >= 250`, `purchases >= 5`, `roas >= 2.0`
- if `targetCpa` or `breakEvenCpa` exists, CPA must also stay inside ceiling

When commercial truth is degraded, the surface may still show a strong candidate, but it will not ship as action-core scale promotion.

### Fatigue engine

Fatigue uses:

- CTR decay
- click-to-purchase decay
- ROAS decay
- winner-memory from historical windows
- spend concentration inside the concept family
- optional frequency pressure when available

Missing frequency lowers confidence and surfaces `unknown`; it does not hard-fail the page.

### Deployment matrix

Deployment guidance stays aligned with Phase 03 Meta semantics:

- `metaFamily`
- target lane
- target ad set role
- preferred campaign and ad set targets when confidence is sufficient
- GEO context
- constraints
- what would change this decision

Phase 05 adds `deployment.compatibility`:

- `compatible | limited | blocked`
- objective family / optimization / bid-regime readout
- matched campaign and ad set ids
- explicit reasons when scale deployment is downgraded or blocked

Deployment aggressiveness is softened by commercial truth and `Operating Mode`.

## Drawer UX

- `/platforms/meta/creatives` no longer renders the full Decision OS overview inline
- the surface opens from a `Creative Decision OS` button in the top controls row
- the drawer is right-anchored, resizable, wider than the creative detail panels by default, and persists its width locally
- queue/family clicks still focus the main table
- active Decision OS queue/family filters remain visible near the trigger after the drawer closes

## Fallback semantics

- If `CREATIVE_DECISION_OS_V1` is disabled, or the workspace is not in `CREATIVE_DECISION_OS_CANARY_BUSINESSES`, the route returns disabled and the page falls back to the shipped Phase 03 creative baseline.
- If commercial truth is missing, the engine lowers confidence and prefers safer `keep_in_test`, `hold_no_touch`, or `block_deploy` outcomes.
- If creative history or taxonomy fields are thin, the page still returns a read-only deterministic payload with explicit missing-context markers.
