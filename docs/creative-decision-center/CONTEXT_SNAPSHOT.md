# Context Snapshot

## Project State

Adsecute / OmniAds Creative page should become a media buyer decision center, not a dashboard.

The user's main product need:

> What should I do, why, and with how much confidence?

## Current Problem

Multiple decision vocabularies and decision-like layers exist. They are valuable, but they can produce confusing product language unless normalized behind one buyer-facing contract.

Known layers:

- V1 `creative-decision-os`
- V2 `creative-decision-os-v2`
- `creative-media-buyer-scoring`
- `creative-old-rule-challenger`
- `creative-operator-policy`
- `creative-operator-surface`

## Current Decision

Evolve V2 into V2.1. Do not create a new standalone core.

Reason: V2 already has a cleaner primary decision contract and safety posture. The missing work is data enrichment, adapter mapping, aggregate separation, compatibility, and tests.

## Latest Resolver Context

- 2026-05-16: hard scale is now separated from blocked near-scale candidates.
  `scaleMinPurchases` remains account-history based, but hard scale also
  requires account scale benchmark readiness: enough calibration sample and a
  positive winner purchase P50. If this benchmark is thin or missing, the
  resolver keeps the row as near-scale `keep` with server-emitted readiness
  badges. Raw `scale` rows downgraded by soft-only hard-action eligibility also
  receive the readiness badge; the UI must render those badges and must not
  compute the decision.
- 2026-05-16: `scale` is now explicitly split from execution action in the
  briefing API. Test campaign scale renders `Promote to main`, Main campaign
  scale renders `Scale budget`, Mixed campaign scale renders
  `Review structure & scale`, and unlabeled would-be scale remains blocked by
  the campaign-label guard. UI fallback may only map generic scale to promote
  when the card is explicitly from a Test campaign.

## Known Risks

- V2 input likely lacks data for confident `fix_delivery`, `fix_policy`, `watch_launch`, and reliable fatigue decisions.
- Known missing/weak fields include `ctr`, `cpm`, `frequency`, `firstSeenAt`, `firstSpendAt`, `reviewStatus`, `disapprovalReason`, `limitedReason`, and `spend24h`.
- `creative-operator-policy` and `creative-operator-surface` are large first-class migration scope, not helper files.
- Existing V1/operator snapshots must remain renderable.

## MVP

1. Today Brief
2. Action Board
3. Creative Table
4. Minimal Detail Drawer

## Deferred

- Asset library
- Timestamp comments
- Approval workflow
- Client share links
- PDF/Notion export
- TikTok/Meta merge
- Seasonality
- Hook library
- Automated queue/apply actions
