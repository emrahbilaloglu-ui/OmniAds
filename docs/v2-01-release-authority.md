# V2-01 Release Authority

Historical reference only. The active canonical release-authority document moved to `docs/v3-01-release-authority.md`.

This document is the canonical release-authority doc for the accepted V2-01 baseline.

Current live release truth is not inferred from older phase docs alone. It is defined by:

- `lib/release-authority/inventory.ts`
- `GET /api/release-authority`
- `/admin/release-authority`

Current accepted live baseline for this authority layer:

- current live SHA: `433f9ca8aec08a5c6bd843b5a3999870f4ce0b52`
- rollback target before the next release: `6fc971574946f65f4c7217eb4a51b6e8ed66fefb`
- repository authority: `erhanrdn/OmniAds` `main`

The `erhanrdn/OmniAds` name above records the repository as it was at the V2-01 baseline and is left unchanged on purpose: this document is a dated record, not a live contract. The repository was later transferred to `emrahbilaloglu-ui/OmniAds`. For the current release identity read `docs/v3-01-release-authority.md` or `GET /api/release-authority`. Both SHAs above predate the transfer, so their GHCR images exist only under `ghcr.io/erhanrdn`.

## Authority Rules

- `documented` means this document and `/api/release-authority` explain the surface explicitly.
- `live` means operator-visible in the current baseline without an allowlist gate.
- `flagged` means merged but not globally live; a feature gate still controls exposure.
- `legacy` means intentionally shipped for compatibility, not the canonical surface.
- `drifted` means the authority route reports a mismatch that still needs review.
- Older Phase 02-06 docs remain design and contract references only. They are not the final live release authority.

## Feature Matrix

| Surface | Runtime posture | Flag posture | Docs posture | Notes |
| --- | --- | --- | --- | --- |
| `Operating Mode` | `live` | `n/a` | `current` | Deterministic commercial-truth overlay remains live on Meta and Creative contexts. |
| `Recommendations` | `live` | `n/a` | `current` | Meta `Recommendations` wording remains current and operator-visible. |
| `Meta Decision OS` | `live` or `flagged` | `META_DECISION_OS_V1`, `META_DECISION_OS_CANARY_BUSINESSES` | `current` | Release authority must report whether the surface is globally enabled or allowlisted. The current baseline includes additive policy metadata and a read-only winner scale candidate board while keeping the execution subset unchanged. |
| `Creative Decision OS` | `live` or `flagged` | `CREATIVE_DECISION_OS_V1`, `CREATIVE_DECISION_OS_CANARY_BUSINESSES` | `current` | Deterministic creative surface remains separate from AI commentary; the current baseline uses a dedicated resizable drawer plus additive economics, compatibility, protected winners, supply planning boards, and an analysis-only selected-period historical panel. |
| `Decision Signals` | `live` | `n/a` | `current` | Compatibility surface for deterministic creative actions. |
| `AI Commentary` | `live` | `n/a` | `current` | Commentary remains interpretation-only, never workflow authority. |
| `Command Center workflow` | `live` or `flagged` | `COMMAND_CENTER_V1`, `COMMAND_CENTER_CANARY_BUSINESSES` | `current` | Unified queue, journal, saved views, throughput budgeting, structured feedback, status-only batch workflow, and an additive historical intelligence / self-tuning panel. |
| `Command Center execution preview` | `live` or `flagged` | `COMMAND_CENTER_EXECUTION_V1` | `current` | Preview-first surface is inventoried separately from apply authority and now includes an explicit per-family support matrix plus rollback-truth copy. |
| `Command Center apply / rollback` | `flagged` until canary apply is explicitly enabled | `COMMAND_CENTER_EXECUTION_V1`, `META_EXECUTION_APPLY_ENABLED`, `META_EXECUTION_CANARY_BUSINESSES` | `current` | This baseline must never present disabled apply as live. Duplicate `clientMutationId` flows must replay the terminal result or stop with a non-dispatching conflict instead of issuing a second write. |
| `/platforms/meta/copies` | `live` | `n/a` | `current` | The route stays visible in the matrix so copy-surface risk cannot go opaque. |

## Docs Role Split

Current workflow throughput baseline references:

- `docs/v2-06-command-center-throughput.md`
- `docs/v2-06-release-checklist.md`
- `docs/v2-06-rollout-runbook.md`
- `docs/v2-07-safe-execution-proof.md`
- `docs/v2-07-release-checklist.md`
- `docs/v2-07-rollout-runbook.md`
- `docs/v2-08-historical-intelligence.md`

These V2-06, V2-07, and V2-08 docs define the current additive workflow, execution-proof, and historical-intelligence layers on top of the already accepted Phase 05 and Phase 06 baselines.

- `docs/phase-02-operating-modes.md`
- `docs/phase-03-meta-decision-os.md`
- `docs/phase-04-creative-decision-os.md`
- `docs/phase-05-command-center.md`
- `docs/phase-06-safe-execution-layer.md`

These older phase documents remain important references for design intent, contracts, and rollout context. They are not allowed to override the live/flagged/legacy posture reported by `/api/release-authority`.

## Drift Policy

- `live vs main` drift is real and must stay visible.
- `docs vs runtime` drift is real unless this doc and `/api/release-authority` explicitly cover the surface.
- `flagged` is not a failure when the manifest says it is intentional.
- `legacy` is not hidden; it stays visible so future phases do not assume it is canonical.

## Review Order

1. Verify the current live SHA from `/api/build-info`.
2. Verify `GET /api/release-authority` and `/admin/release-authority`.
3. Verify the surface matrix for live, flagged, and legacy posture.
4. Verify unresolved drift items before treating the baseline as release-ready.
5. Use older Phase 02-06 docs only after the authority route and this doc agree on the baseline.
