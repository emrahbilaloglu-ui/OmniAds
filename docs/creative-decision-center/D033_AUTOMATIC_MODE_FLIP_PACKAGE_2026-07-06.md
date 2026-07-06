# D033 Automatic-Mode Flip Package (prepared 2026-07-06)

The decision this package supports: setting `CAMPAIGN_CONTEXT_MODE=automatic`
so decision surfaces consume the resolver's campaign kinds instead of manual
labels (manual labels become optional operator overrides). This is a
production behavior flip and stays a user decision; everything below is
pre-computed so the decision is a checklist, not an investigation.

## Evidence already in hand (simulation + day-1 live)

| Criterion | Threshold | Status |
|---|---|---|
| Resolver quality on labeled truth | no false-Test; high-class agreement | MET - 0/38 false-Test any-class; 7/7 high agree (shadow, pooled) |
| Temporal stability (daily grid, production hysteresis) | no kind-to-kind churn on spenders beyond isolated cases | MET - ~5 spending campaigns with <=2 flips over 35 days; final raw-vs-published divergence 2/71 |
| Stale-kind pinning | none (grace must exhaust; conflicts must surface) | MET - grace capped at 3 days then state clears; persistent conflicts publish from day 2; round-trip seam proven live (95 states parse, 73 with counters) |
| Operational proof (job in chain) | 14/14 success, non-gating | MET - live 2026-07-06 wave: 14/14 context success, no collapse, downstream unaffected |
| Guard direction in weak classes | conservative only | MET - low/unknown/conflict -> unresolved handling (cut-visible only); no hard action rides on unstable classes |

## Remaining gates before flipping (dated)

1. **7 consecutive live shadow days** under production semantics
   (2026-07-06..07-12): rerun `campaign-context-day1-check.ts` daily; no
   collapse, no failed producers, published-flip counts in line with the
   daily-grid simulation (order: a handful account-wide, cold-start entries
   excluded).
2. **Operator overrides for the named honest conflicts** (optional but
   recommended before flip so day-one automatic labels match intent):
   - IwaStore "Test Kampanyası -30 Nisan" - behaves main, named test.
   - EMOLOS EMB-17Jun-Permanent pair - naming contradicts behavior.
   - TheSwaf manual-mixed disagreements (TS_F5K 365D_Winner_Retest,
     Core_Value_ReligiousDuality) - resolver says main/medium, manual mixed.
3. **Golden promotion**: promote the context-guard trust-class tests to the
   golden set on the flip commit (noted in GOLDEN_CASES.md conventions).

## Flip procedure (for Codex, when the user approves)

1. Set `CAMPAIGN_CONTEXT_MODE=automatic` in the host env (both hosts) - the
   code default stays `legacy_labels` so rollback is env-only.
2. Bump `ENGINE_VERSION` (decision provenance changes; snapshots must not
   mix label sources under one version key). Expect the documented one-day
   clean-epoch flip wave and hysteresis memory reset.
3. Deploy with the standard pipeline; verify build-info + env pin.
4. Day-1: `campaign-context-day1-check.ts` + briefing spot-check that
   campaign kind chips match resolver kinds; overrides (manual labels) win
   where present.
5. Rollback: unset `CAMPAIGN_CONTEXT_MODE` (reverts to legacy_labels);
   previous-version snapshots intact under their version key.

## What automatic mode changes for the operator

Manual campaign labeling stops being required workflow: the backend assigns
kinds daily with confidence classes; the existing label editor becomes the
override surface (user_override always wins). Unresolved/conflict campaigns
degrade conservatively and are exactly the list the operator may choose to
override - surfaced with `campaign_context_unresolved` / `conflict` badges.
