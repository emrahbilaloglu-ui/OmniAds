# Systemic Decision Health Review - 2026-07-14

## Scope And Evidence Boundary

- Businesses: IwaStore, EMOLOS, Grandmix, and TheSwaf (two bound Meta accounts).
- Live database checks used the production tunnel in a read-only transaction.
- No provider write, database write, manual cron call, environment edit, or
  production mutation was performed.
- Live evidence is from deployed build `1dac166232b281e9cf39cdbae449846e1b3fe0fc`
  and native engine `v3-ad-2026-07-12-d047-authority-v2-shadow`.
- Local code advances the native engine to
  `v3-ad-2026-07-14-decision-health-provenance-shadow`; its new columns and
  behavior are pre-deploy evidence only until the normal deployment completes.

## Live Production Findings

All four businesses produced a successful 2026-07-14 native Ad run. Every
account manifest was authoritative and exact: expected count, hydrated count,
and persisted snapshot count matched.

| Business / account | Manifest snapshots | Current ACTIVE Ads | ACTIVE snapshots | ACTIVE labels                         | ACTIVE metric unavailable | Context unresolved | Commercial target stale |
| ------------------ | -----------------: | -----------------: | ---------------: | ------------------------------------- | ------------------------: | -----------------: | ----------------------: |
| EMOLOS             |                593 |                 28 |               28 | test_more 27, keep 1                  |                         0 |                  0 |                      28 |
| Grandmix           |              2,493 |                 67 |               67 | test_more 52, keep 15                 |                         0 |                 36 |                      67 |
| IwaStore           |                985 |                 54 |               54 | test_more 37, keep 11, out_of_scope 6 |                         0 |                 20 |                      48 |
| TheSwaf / 8229     |                651 |                 20 |               20 | test_more 19, keep 1                  |                         0 |                 20 |                      20 |
| TheSwaf / 9212     |                126 |                 13 |               13 | test_more 11, keep 2                  |                         0 |                  0 |                      13 |

The large account-wide `ad_metrics_unavailable` counts belong to present but
inactive historical Ads. They are not an ACTIVE-Ad data failure: all 182 ACTIVE
Ads had exact snapshots and zero `ad_metrics_unavailable` rows. UI and health
reporting must preserve this denominator distinction.

No ACTIVE Ad received a hard label or authorized action. This is not evidence
that account performance is uniformly neutral. The common authority cause is
stale commercial truth: target-dependent Scale/Cut authority is correctly
closed until the unchanged economics are explicitly reconfirmed. Automatic
campaign context is a secondary review-only restriction for 76 ACTIVE Ads; it
must not be converted into a mandatory manual labeling task.

## Local UI Verification

The current branch was exercised through an authenticated browser against the
read-only production tunnel. Account selection remained isolated and no
cross-account totals were formed.

| Business / account | Structure rows | Initial Ads rows | Ads rendered | `cannot assess` rows | Always-open role editor controls |
| ------------------ | -------------: | ---------------: | -----------: | -------------------: | -------------------------------: |
| EMOLOS             |             29 |               28 |           28 |                    0 |                                0 |
| Grandmix           |            475 |               60 |           60 |                    0 |                                0 |
| IwaStore           |             59 |               54 |           54 |                    0 |                                0 |
| TheSwaf / 8229     |             66 |               20 |           20 |                    0 |                                0 |
| TheSwaf / 9212     |             20 |               13 |           13 |                    0 |                                0 |

Grandmix has 67 ACTIVE Ads in the live manifest. The UI intentionally loads
the first 60 in the server-defined urgency order and exposes the remaining
seven through `Show more decisions`; the maximum is a pagination boundary, not
data loss. The campaign-role correction controls are collapsed behind an
explicit correction disclosure instead of appearing as a mandatory question
on every Ad.

Desktop `1440x1000` and mobile `390x844` checks had no horizontal document
overflow. The local branch currently reports `source_read_failed` because it
expects the new nullable provenance columns while the production schema is
still pre-migration. This is expected only for the pre-deploy local-against-live
combination: the standard deployment applies migrations before serving the new
web/worker image. Until that sequence completes, all exact Ad actions remain
withheld rather than falling through to legacy authority.

## Historical Simulation

### Recent exact cohort

The native Ad paired replay for 2026-06-01 through 2026-06-29 produced 886
decision rows across all four businesses. Target lineage, creative identity,
and 3d/7d/14d outcome completeness were all 100%; duplicate cohort keys were
zero. The recent window was too short to populate defensible rolling-origin
calibration/test folds, so it is coverage evidence, not a formula-selection
result.

### Long rolling-origin cohort

The full challenger grid for 2025-12-01 through 2026-06-29 produced 6,757
unique decision inputs and complete 3d/7d/14d outcomes for every row. Only
22.9% had exact target history over the full period, so older target-dependent
comparisons remain bounded. All source rows were restated after their historical
cutoff; the replay therefore zeroed unsafe current-only context and remains
observational, not causal.

No challenger family passed the automation gate. The gate remained closed at
all outcome windows: no variant met action-specific equal-mass sample coverage,
ECE <= 0.05, and at least 10% Brier improvement. The selected H6 funnel
challenger increased locked-test precision from 15.4% to 18.8% but reduced
opportunity recall from 100% to 49.0% (paired net wins -26; exact p < 0.000001).
It is rejected. Producing more hard decisions by loosening thresholds would be
an unsupported regression.

The current-engine Creative-grain replay for 2026-07-13 is preserved in
`SYSTEMIC_DECISION_HEALTH_PHASE0_2026-07-13.md` and its generated JSON. It is a
compatibility diagnostic only; native exact-Ad evidence is the Decisions source
of authority.

## Systemic Fixes In This Change

1. Latest native authority follows the latest effective terminal attempt,
   including failures and engine-version changes; old success cannot hide a
   newer bad run.
2. Native job attempts are durable outside the work transaction and fail closed
   after rollback, connection failure, or stale-running timeout.
3. Source health and fallback reason are served explicitly; legacy Creative
   rows remain review-only and exact Ad execution is withheld.
4. Commercial truth supports explicit value-preserving target reconfirmation,
   strict anchor validation, atomic full-snapshot replacement, advisory locking,
   and revision compare-and-swap.
5. Pre-authority label and first authority blocker are persisted through
   evaluations, snapshots, outcomes, APIs, and evidence UI.
6. Any authority blocker unconditionally clears `authorized_action`, including
   hard-raw replay/hysteresis edge cases.
7. Historical exact-Ad backtests select an explicit engine epoch and report
   blocker/pre-authority distributions instead of discarding them.
8. Operator-response migrations preserve prior immutable engine epochs while
   current application writes remain current-version strict. The generalized
   checks retain the immediately preceding image's inspected epoch literal,
   reject null decision-origin engine lineage, and do not rebuild an already
   compatible constraint on later deploys.
9. The native snapshot CHECK contract accepts hard review-only provenance only
   when `authorized_action` is null; a blocker/action contradiction is rejected
   by PostgreSQL. Hysteresis-pending hard raw labels are likewise unauthorized
   and require explicit pending-transition provenance. Both paths are covered by
   the real migration seam.
10. Full commercial-truth replacement and value-preserving target
    reconfirmation use the same 64-bit per-business advisory lock. A real
    two-connection race proves one mutation and one conflict with exactly one
    history version; transaction-local snapshot reads are sequential so they do
    not issue concurrent queries on one PostgreSQL client.
11. Commercial input rejects target-pack metadata without any CPA/ROAS anchor.
    Write-path numeric fields use strict type validation and reject booleans,
    arrays, and numeric strings; the legacy `Number(...)` normalization remains
    only on the PostgreSQL read-compatibility path. Reconfirmation authorization
    runs before body shape feedback, canonical revisions use locale-independent
    ordering, and generated migration identifiers are allow-list validated.

## Adversarial Review Closure

Claude Code's first phase-end review returned `STOP_AND_FIX`. Its rollback,
commercial-validation, and concurrency findings were valid and are closed in
this change. The hysteresis finding identified a real snapshot-contract defect:
a suppressed hard raw label could retain `authorized_action`. The provider
preflight already rejected such a row because `blocked_action_type` was
non-null, so it was not provider-write reachable; the snapshot now also clears
authorization, PostgreSQL enforces the tuple, and a preflight regression test
proves the independent execution guard.

The rollback fix is tested against the preceding production engine literal,
both preceding and current epoch values, null lineage rejection, and unchanged
constraint OIDs on a no-op compatibility rerun. The first from-zero run exposed
an ordering defect where compatibility SQL could run before action-lineage
columns existed; the migration now waits for the complete required column set.
The final real PostgreSQL seam passes from zero and on the idempotency rerun.

Final local gates after these fixes: 572 test files passed (4 skipped), 4,843
tests passed (61 skipped, 61 todo), TypeScript passed, ESLint passed, migration
from zero passed, and `git diff --check` passed.

Claude Code's follow-up review independently re-checked every original finding,
classified all blockers, majors, minors, and requested seam gaps as
`VERIFIED_FIXED`, found no new blocker or major, and corrected its own initial
hysteresis severity from provider-write exposure to snapshot-contract
inconsistency. Its final verdict was `JOINT_REVIEW: CONTINUE`.

## Decision

Proceed with the systemic authority/data fixes. Do not change performance
thresholds from this replay. After deployment, let the scheduled chain produce
the new epoch naturally, verify provenance coverage and exact ACTIVE manifests,
then reconfirm each business's still-valid target pack through the guarded UI.
Hard actions should remain closed wherever commercial truth is not explicitly
current or the strict evidence gate is not met.
