# Native Ad Physical-Account AOV Authority - 2026-07-16

## Scope

This change repairs a generic native-Ad decision authority defect and adds the
D063 bounded economic-loss strip. D060 could make an exact purchase cell's
commercial stop-loss receipt ready without a peer P25 while the retained
account profile still rejected Cut when that narrow cell's AOV sample was below 20. The adapter then intersected a correct semantic Cut with a second
spend-unit veto and served no hard decision.

No business-specific exception, fixed currency amount, manual cron, provider
write, or live database write is part of the repair.

## Read-Only Production Evidence

At the 2026-07-16 native calibration cutoff, SELECT-only repeatable-read checks
showed the grain mismatch:

| Account      |                                   Rollback-wave profile evidence |                                               Current cutoff recompute |               Cutoff-safe physical-account evidence |
| ------------ | ---------------------------------------------------------------: | ---------------------------------------------------------------------: | --------------------------------------------------: |
| EMOLOS       |                           5 purchases, AOV 79.2940, `low_sample` |                         38 purchases, `ready`, 12 mature Ads, P25 null |    112 purchases, revenue 9,597.67, AOV 85.6935 GBP |
| IwaStore     |  8 purchases, AOV 136.5050, `low_sample` in the affected context | 38 OFFSITE / 93 VALUE purchases, `ready`, 12 / 14 mature Ads, P25 null | 733 purchases, revenue 126,114.80, AOV 172.0529 USD |
| Grandmix     | primary exact context ready; other contexts include thin samples |       production resolver recompute covered all current exact contexts |  389 purchases, revenue 85,772.49, AOV 220.4948 USD |
| TheSwaf Main |                                  primary purchase contexts ready |       production resolver recompute covered all current exact contexts | 742 purchases, revenue 150,911.66, AOV 203.3850 USD |

All four physical-account samples used canonical metric schema v2, one exact
account currency, integer conversions, and zero purchase/revenue
contradictions. The broader active native account audit found one account below
the 20-purchase floor and one account with contradictory facts; those cases are
expected to remain fail-closed unless an explicit CPA/operator AOV has higher
precedence.

## Canonical Repair

The calibration transaction now produces one account/currency AOV evidence
receipt independently of campaign/ad-set context. It requires finalized,
passed, cutoff-safe canonical ad facts and at least 20 revenue-backed purchases.
Malformed facts and conflicting duplicate ad-days remain in the evidence
manifest and block the proof.

That strict non-null `finalized_at` rule belongs only to the physical-account
AOV/currency/timezone evidence lane. The retained peer-calibration lane still
requires exact same-day Ad/campaign/ad-set `FINALIZED`/`PASSED` truth and
cutoff-safe hierarchy timestamps, but a legacy Ad row with null `finalized_at`
is quality-counted rather than censoring an otherwise-valid peer observation.
It can never enter the strict account-AOV numerator.

The retained account-profile resolver consumes a valid proof through its
existing spend-unit resolver and threshold builder. It exposes a Cut-only
commercial stop-loss threshold view. The following authority remains unchanged:

- exact-cell peer P25/P10 and other relative calibration;
- winner benchmarks and Scale eligibility;
- Refresh, fatigue, lifecycle, and recent-hold evidence;
- break-even as a no-widen Cut ceiling;
- D036 first-day pending and later-date confirmation;
- status, policy, freshness, context, lineage, and execution blockers.

The receipt and store validator bind business/account/currency identity,
cutoff, target-authority hash, purchase/revenue arithmetic, evidence hash,
selected basis, base spend unit, and final authority hash. Numeric JSON proof
fields are type-strict. Duplicate resolution is source-order invariant.

## Replay Gates

The deterministic frozen acceptance gate runs production calibration, native
profile, decision, D036, and snapshot-authority functions over anonymous
fixtures. It covers:

- exact-cell AOV below the sample floor plus account/currency AOV at the floor;
- below-break-even Cut, first-day pending, same-day retry, and later-day Cut;
- above-break-even Keep and no widened manual-Cut badge;
- recovery hold;
- Scale and Refresh isolation; and
- `authorized_action = null` while pending and `cut` only after confirmation.

Command:

```bash
npm run creative:decision:native-ad-frozen-acceptance
```

A separate SELECT-only fixed-cohort baseline-versus-challenger replay freezes
persisted Ad metrics, campaign context, data health, identity lineage and
epoch-scoped hysteresis. It recomputes cutoff-bound calibration cells and then
rebuilds challenger profile groups through the same production resolver used
by the scheduled job. Rollback-epoch ready/soft profile state is baseline
evidence only; it is never reused as the challenger profile. This distinction
prevents a stale low-sample profile from hiding a production-ready Cut.

The earlier worktree note recorded a 2026-07-18 pre-release snapshot with 12
active+enabled Meta-bound businesses, 13 exact physical accounts, 14,748 fixed
Ad identities, 10,006 ready challenger profiles, and 4,742 explicit soft-only
profiles. No retained 2026-07-18 replay artifact is present in the current
proof set, so those counts are unverified historical context, not final release
evidence.

After the natural 2026-07-19 03:00 UTC wave, the current SELECT-only replay
observed the same exact 12-business/13-account scheduler population and 14,771
fixed Ad identities. All 14,771 challengers computed without an execution
failure: 10,029 were ready and 4,742 remained explicit soft-only. Scheduler
population coverage, authority/lineage, canonical-envelope,
current-day-restatement, requested-scope, above-break-even, Scale/Refresh,
cutoff, D036, D063, and exact media-buyer contradictions were all zero.

That 2026-07-19 replay nevertheless failed closed. TheSwaf Main account
`act_822913786458311` had 687 frozen and hydrated rows, but its scheduler-owned
hydration receipt declared zero expected rows, carried a different expected
manifest hash, and was not authoritative for prune. This produced exactly one
unresolved source-dimension contradiction and one wave/hydration coverage
contradiction. The compact outputs from that attempt remain untracked and are
not release evidence. Do not weaken either gate, manufacture a replacement
anchor, call cron manually, or write the live database/provider. Final proof
must be regenerated against the first complete natural post-deploy scheduler
wave.

The four-account buyer-facing diagnostic is the 156 ACTIVE rows, not the
14,771-row technical identity proof. Its exact media-buyer audit has zero
contradictions, but the table remains diagnostic until the scheduler-owned
source proof also passes:

| Exact account | ACTIVE / profile | Pre-authority → raw → published | Media-buyer reading |
|---|---:|---|---|
| TheSwaf Main | 7 / 7 ready | `1 Keep + 6 Test More` → same → same | no mature hard signal; no blocker and no provider-authorized action |
| IwaStore | 54 / 48 ready + 6 soft-only | `10 Cut + 11 Keep + 27 Test More + 6 out of scope` → same → `21 Keep + 27 Test More + 6 out of scope` | ten mature losses surface as Cut pending; seven rows separately carry unresolved campaign-context review |
| EMOLOS | 28 / 28 ready | `17 Cut + 1 Diagnose + 2 Keep + 8 Test More` → same → `1 Diagnose + 19 Keep + 8 Test More` | seventeen mature losses surface as Cut pending with no separate authority blocker |
| Grandmix | 67 / 67 ready | `8 Cut + 10 Keep + 1 Scale + 48 Test More` → `6 Cut + 10 Keep + 1 Scale + 50 Test More` → `17 Keep + 50 Test More` | six Cut and one Scale signals remain visible while D036/context proof is pending; two economic losses explicitly await enough recent evidence |

All 156 ACTIVE rows in this diagnostic have null provider authorization. Held
hard signals remain pending until their required authority proof passes. The
server briefing projection preserves held-action provenance and renders
`Cut pending — evidence review`, `Scale pending — evidence review`, or the
specific recent-evidence instruction instead of misrepresenting the
compatibility Keep/Test More label as the media-buyer verdict.

Run it only through the existing local production tunnel. The command enforces
`REPEATABLE READ READ ONLY`, `default_transaction_read_only=on`, and a 30-second
statement timeout; it never invokes cron or writes to the database/provider:

```bash
npm run creative:decision:native-ad-account-aov-replay -- \
  --as-of=2026-07-19 \
  --provider-account=172d0ab8-495b-4679-a4c6-ffa404c389d3:act_822913786458311 \
  --provider-account=f8a3b5ac-588c-462f-8702-11cd24ff3cd2:act_1087566732415606 \
  --provider-account=a7fd8563-8c9a-497a-b0d7-fd65e4248d1f:act_1054905059780305 \
  --provider-account=5dbc7147-f051-4681-a4d6-20617170074f:act_805150454596350 \
  --audit-provider-account=172d0ab8-495b-4679-a4c6-ffa404c389d3:act_822913786458311 \
  --audit-provider-account=f8a3b5ac-588c-462f-8702-11cd24ff3cd2:act_1087566732415606 \
  --audit-provider-account=a7fd8563-8c9a-497a-b0d7-fd65e4248d1f:act_1054905059780305 \
  --audit-provider-account=5dbc7147-f051-4681-a4d6-20617170074f:act_805150454596350 \
  --json-out=/tmp/native-ad-account-aov-authority-replay-2026-07-19-focused-final-full.json \
  --compact-json-out=docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-19-compact.json \
  --provenance-exclude=docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-19-all-current-population-compact.json \
  --provenance-exclude=docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-16-compact.json \
  --provenance-exclude=docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-19-compact.json \
  --provenance-exclude=docs/creative-decision-center/generated/native-ad-account-aov-authority-replay-2026-07-19-all-current-population-compact.json \
  --stdout=none
```

The planned retained artifact is a hash-bound compact proof. The 2026-07-19
candidate filename is
`native-ad-account-aov-authority-replay-2026-07-19-compact.json`, but the failed
candidate is intentionally not committed. Its adjacent checksum placeholder
still names and hashes an older 2026-07-18 output and does not match the current
JSON bytes. A retained artifact exists only after `releaseGate.passed=true`, a
matching adjacent checksum is generated from the exact retained bytes, and
both outputs are staged. Its `artifactProjection` records the full artifact
SHA-256 and byte count and binds all omitted technical replay identity rows.
The buyer-facing surface remains the bounded set of active decisions, not this
proof manifest.
The full drilldown artifact is
intentionally local under `/tmp`, not committed to the repository.
Its pre-output provenance manifest binds the current content of every tracked
and untracked non-ignored repository file, including `cut-policy.ts`; declared
artifact output paths are excluded to avoid self-reference, and the source
manifest is asserted unchanged after both artifacts are written.
`--audit-provider-account` declares the exact four-account release audit without
changing query selection; the population command therefore gates this cohort
and the complete scheduler population in one transaction. The obsolete local
v6 compact is an explicit provenance exclusion and is not release evidence.
For a later successful scheduler date, replace the operational `--as-of`,
`--json-out`, `--compact-json-out`, and same-date sibling path, but keep both
explicit 2026-07-19 paths above unchanged as known failed, non-evidence output
exclusions. The replay de-duplicates them when the operational date itself is
2026-07-19.
Because tracking status is hash-bound, every intended source, test, and document
must be staged before the final focused/population artifacts and checksums are
regenerated and staged.
The challenger admits prior D036 memory only when its persisted source engine
equals the challenger epoch; rollback-epoch rows are reported as
`epoch_mismatch` and replay with an empty prior map. It also mirrors the live
native adapter's absent optional calibration-profile source (`null` plus
canonical resolver defaults) instead of inferring multiplier configuration
from the persisted rollback-epoch profile.

## Historical Formula-Sensitivity Review

The corrected Lane B replay evaluated all 4,163 available daily decisions in
chronological order. Its seven-day scoring schedule contains 907 rows overall;
682 fall inside the locked 2026-06-01 through 2026-06-27 quality window.
Pre-window rows advance or conservatively reset D036 state but do not enter
locked quality strata. All 4,163 chronological evaluations, including the
3,256 non-scored intermediate rows, remain inside the integrity and safety
population; the 907-row cooldown schedule owns quality denominators only. The
scored cohort must be an exact subset of the duplicate-free chronological
manifest or the replay stops. The replay binds profile requests to the
calibration batch's immutable account-dimension admission receipt, while
preserving the raw requested dimensions and admission hashes in each row proof.
It produced
405 published Cut rows across all available history: 219 for TheSwaf Main, 100
for EMOLOS, and 86 for Grandmix. IwaStore's historical daily batches do not
retain the exact purchase-event optimization cell required by today's
production profile, so all 1,156 historical Iwa rows remain Diagnose instead
of borrowing an account-wide fallback.

The 14-day observational quality gate rejects promotion: 41 published Cuts
have known uncontaminated outcomes, 33 remain below break-even and 8 recover
above it (80.49% precision; 65.99% Wilson lower bound). The 33 supported Cuts
capture 38.82% of the 85 known below-break-even opportunities, and available
daily history has 811 conservative consecutive-day gap resets. Above-break-even
challenger Cuts, Scale/Refresh drift, execution errors, old-target 30-day drift,
and hierarchy/action-coverage gaps are all zero. These safety results do not
repair the precision, recall, named-account, or consecutive-day quality limits.

The v3 report therefore separates `integrityGate` from
`historicalPromotionQualityGate`. Only integrity failures stop the release;
expected Lane B observational rejection remains
`review_only_reject_promotion`, and `automationPromotionGate` stays false
unconditionally. This is not causal counterfactual evidence and must not tune a
threshold or authorize execution. The full hash-bound JSON and generated
Markdown drilldown remain local under `/tmp` so they cannot create a circular
repository-content claim with the current-day authority artifact.

## Version And Rollback

- Canonical engine: `v3-2026-07-18-decision-presentation-hardening`
- Native engine: `v3-ad-2026-07-18-decision-presentation-hardening-shadow`
- Native calibration: `engine-v3-native-ad-calibration.v3`
- Canonical evaluation: `engine-v3-canonical-evaluation.v5`
- Native-Ad evaluation: `engine-v3-canonical-ad-evaluation.v7`
- Exact native rollback epoch:
  `v3-ad-2026-07-15-commercial-stop-loss-shadow`

Old receipts are not reinterpreted under the new epoch. Rollback therefore
restores the prior semantics without rewriting historical snapshots.

## Release Acceptance

The release is not complete until all local gates, independent review, normal
PR/CI/merge/deploy, both build-info domains, release authority, and the next
natural scheduler wave pass. Production verification remains SELECT-only and
must prove terminal job success, exact chain order, receipt/manifest coverage,
zero proof/lineage contradictions, expected D036 progression, and no unexpected
Scale/Refresh or above-break-even Cut expansion.
