# V3-01 Release Authority

This document is generated from `lib/release-authority/*`. Do not hand-edit it.

Current accepted authority contract for this layer:

- runtime live SHA source: `https://adsecute.com/api/build-info`
- runtime release authority source: `https://adsecute.com/api/release-authority`
- repository authority: `erhanrdn/OmniAds` `main`
- canonical doc path: `docs/v3-01-release-authority.md`
- rollback target before the next release: `fe3e23f5df5e9dd7f90cc2318ea7b66920e189d2`

## Literal parity

- build info URL must expose the same live SHA that `/api/release-authority` reports at runtime.
- `/api/release-authority` must expose the current remote `main` SHA.
- The rollback target in this doc must match the rollback target in `/api/release-authority`.
- The surface matrix below must stay literal with the release-authority inventory.

## Feature Matrix

| Surface | Runtime posture | Docs posture | Flag posture | Notes |
| --- | --- | --- | --- | --- |
| `Operating Mode` | `live` | `current` | n/a | Deterministic commercial-truth overlay remains live. No feature flag gates the current operating mode surface. |
| `Recommendations` | `live` | `current` | n/a | The compatibility route remains live, but the visible panel now renders secondary workflow/context notes derived from the Meta Decision OS authority snapshot. This surface no longer carries an independent decision voice. |
| `Meta Decision OS` | `legacy` | `current` | n/a | Legacy Meta Decision OS is archived in Phase 4.1 and no longer has serving runtime posture. The Meta page keeps snapshot-backed recommendations as context without importing archived authority code. Archived source, route, and UI files remain available under lib/archive/v1-v2-v21/ for R&D reference. |
| `Creative Decision OS` | `legacy` | `current` | n/a | Legacy Creative Decision OS V1/V2/V2.1 surfaces are archived in Phase 4.1. Active creative authority lives in lib/creative-decision-engine/ and is tracked separately. Archived source, route, and UI files remain available under lib/archive/v1-v2-v21/ for R&D reference. |
| `Decision Signals Compatibility` | `legacy` | `current` | n/a | The legacy Decision Signals route is archived with the retired creative engines. No serving route remains for this compatibility surface after Phase 4.1. |
| `AI Commentary` | `live` | `current` | n/a | AI commentary remains bounded interpretation only. This authority layer only inventories the surface; it does not change provenance rules. |
| `Command Center Workflow` | `legacy` | `current` | n/a | Legacy Command Center workflow is archived in Phase 4.1. No serving workflow routes or dashboard components remain outside lib/archive/v1-v2-v21/. |
| `Command Center Execution Preview` | `legacy` | `current` | n/a | Legacy Command Center execution preview is archived in Phase 4.1. Archived execution files remain available under lib/archive/v1-v2-v21/ for R&D reference. |
| `Command Center Apply & Rollback` | `legacy` | `current` | n/a | Legacy Command Center apply and rollback routes are archived in Phase 4.1. No serving apply or rollback route remains outside lib/archive/v1-v2-v21/. |
| `/platforms/meta/copies` | `live` | `current` | n/a | The surface remains live and intentionally unchanged in this phase. Authority coverage is explicit so /platforms/meta/copies cannot disappear into baseline ambiguity. |

## Unresolved Drift

| Item | Status | Detail |
| --- | --- | --- |
| none | aligned | No unresolved drift items remain. |


## Carry-Forward Acceptance Gaps

No accepted carry-forward gaps remain.

| Item | Status | Detail | Next requirement |
| --- | --- | --- | --- |
| none | complete | No accepted carry-forward gaps remain. | n/a |


## Review Order

1. Review release identity through `/api/build-info` and `/api/release-authority` first.
2. Review the feature matrix next: runtime state, flag posture, and docs posture for each surface.
3. Review `docs/v3-01-release-authority.md` before older Phase 02-06 docs when deciding what is truly live.
4. Review legacy aliases after the main surfaces so redirects do not get mistaken for canonical entrypoints.
5. Resolve any unresolved drift items before treating the baseline as release-ready.
