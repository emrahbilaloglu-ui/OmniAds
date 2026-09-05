# Meta operator readiness — correction report

Reviewed HEAD: `8d5756c53`. Corrections land in ten commits on
`codex/meta-v2-panel-fidelity`. Every finding in
`2026-09-05-meta-operator-readiness-review.md` was reproduced against the source
at that HEAD before anything was changed; none is disputed.

Nothing was pushed, merged or deployed. No production configuration, database
or advertising account was touched. Every provider interaction below went to an
in-process test double.

---

## Finding by finding

| # | Fix (commit) | Reproducer / execution test | Observed result |
|---|---|---|---|
| **1** Rehearsal, capability and read-only not enforced on real write paths | `f9bc6aa30` — `automation-control-plane.ts` gains `release_capability_closed` and `readiness_tier_read_only` and reports `rehearsal`; `automation-write-guard.ts` fail-closes; `entity-action-routes.ts` decides `dryRun` on the server and re-proves at `beforeMutationAttempt`; `ads-action-routes.ts` overrides the parsed body one-way | `lib/meta/write-posture-enforcement.test.ts` (10); posture blocks added to `scheduled-status-runtime.test.ts`, `bid-queue-arm.test.ts`, `scheduled-ad-status-runtime.test.ts`; mounted approval in the isolated app | A request omitting `dryRun` against a rehearsing business now composes `dryRun: true`; an unreadable posture refuses. The mounted queue reported **"Recorded as a dry run — nothing was sent to Meta. The dryRunOnly guardrail held this approval inside the building."** |
| **2** Sizing source query does not match the schema | `43376e64a` — `intent-projection-context.ts` rewritten against `meta_entity_state_history` (`budget_origin`, `*_daily_budget_raw` minor units, `budget_currency`), `conversions` for purchases, `bid_value`/`bid_value_format` for the cap | `lib/meta/intent-projection-context.test.ts` (10, with a forbidden-column guard) + `scripts/ephemeral-postgres-intent-projection-seam-child.ts` on a genuinely migrated throwaway database | Seam **PASS**. It caught a defect in the fix itself: the account total read 550,000 instead of 300,000 because an ad set under a CBO campaign carries the campaign's amount in its own observation. Ownership now matches the entity's own grain. |
| **3** Shopify AOV reader not connected to production | `104915425` — `ad-calibration-job.ts` resolves it per provider binding into `buildNativeAdSpendUnitAuthority`; `snapshot.ts` uses it as the third spend-unit rung and feeds the same benchmark to the maturity gate | `lib/meta/shopify-anchor-wiring.test.ts` (9); `ad-calibration-job.test.ts` | A business with only a target ROAS and real store sales now gets a spend unit: AOV $58.00 ÷ 2.20 = **$26.36**, basis `observed_shopify_aov`. Verified through the sizing path with injected readers, not through a snapshot run on a real account. |
| **4** Missing semi-automatic / automatic families | `9e2afceec` (bid envelope, producer, executor, cap), `b15ce6257` (ad grain), `9572f7730` (activation-approval writer, launch queue producer, manual bid approval) | `bid-queue-arm.test.ts` (16), `scheduled-ad-status-runtime.test.ts` (14), `launch-activation-approval-writer.test.ts` (11), `launch-proposal-producer.test.ts` (4), `scripts/ephemeral-postgres-bid-queue-seam-child.ts` | Approving a bid row in the mounted UI reached `/api/meta/adsets/120200000000011/apply-bid` with **`bidAmountMinor: 1320`** — the envelope's amount, not an operator's typing — and settled `approved` with a durable receipt. |
| **5** Daily cap counts only budget | `f9bc6aa30`, widened by `9e2afceec` | `automation-proposals.test.ts` → "counts EVERY automatic family against the cap, not only budget" | The atomic claim binds `AUTOMATABLE_PROPOSAL_ACTIONS` as `$4::text[]`, now `["bid","budget","pause","resume"]`, so one list bounds what the sweep dispatches. |
| **6** Activation has no durable claim, journal or ambiguous record | `8e2ec3274` — every step claims in `meta_ads_action_log` before its POST and terminalises from the step's verdict; `meta_launch_intents.activation_receipt_json` stores the sequence; the route returns the durable row ids and now reads the Launchpad execution gate | `lib/meta/launch-activation-durability.test.ts` (6) + the launch-intent DB seam extended with claim → settle → `findUnresolved` | Reproduced at `8d5756c53`: the module referenced the durable machinery **zero** times. Now an ambiguous outcome settles as `silent_failure`, which is exactly what `findUnresolvedMetaAdStatusActionLog` selects, so the next attempt refuses with `unresolved_prior_attempt` and sends nothing. |
| **7** Delivery evidence never produced | `104915425` — anomaly detection hoisted above the per-account loop; `deliveryConstrainedAdsetIdsFrom` threads `delivery_stall` into `attachSizedIntents` | `lib/meta/delivery-evidence-wiring.test.ts` (6) | The set is no longer unconditionally empty, so a cap raise can be produced. A2.5's $12.00 → $13.20 case is asserted in the sizing policy and in the queue arm; not yet through a full snapshot run (see the open item below). |
| **8** A failed 15:00 run marked successful by morning rows | `94a61d76c` — `recordSlotOutcome` writes per (business, account, day, slot) from the attempt; `runMetaSnapshotForAllBusinesses` takes `onlyPairs` | `lib/meta/slot-completion.test.ts` (5) + `meta_structure_snapshot_runs` assertions in `ephemeral-postgres-migrations-check.ts` | A failed afternoon run can no longer be closed by the morning's own output, and only missing (business, account, slot) pairs re-run. |
| **9** Native proposals projected before they exist | `94a61d76c` — `projectNativeAdProposals` extracted and called after a successful native publish | `lib/meta/native-projection-order.test.ts` (4) | The structure snapshot no longer projects native rows that the native chain has not yet written. |
| **10** Shopify freshness and store scope wrong | `104915425` — freshness reads `shopify_sync_state.latest_successful_sync_at`; the currency and window readers bind to `provider_account_id` | `lib/creative-decision-engine/shopify-aov-source.test.ts` | A store that synced today with no sales in three days is no longer called stale, and a second store's currency can no longer contaminate the selected one's evidence. |

---

## Found while correcting, not in the review

| What | Where | State |
|---|---|---|
| **The app would not start.** `intents/[id]` and `intents/[intentId]` are one dynamic position; Next refuses the whole build (`You cannot use different slug names for the same dynamic path`). Not one page, API route or health check came up. Unit tests, typecheck and `verify-mounted-bodies` all passed — an import graph reaches modules the router never mounts. | `7639c2528` — routes moved under `[id]`; `app/route-slug-consistency.test.ts` is a directory read that fails with the sentence "the app does not start" | Fixed. The guard was verified to fail on the real conflict before being kept. |
| The duplicate-ad DB seam broke between `8d5756c53` (clean) and `94a61d76c`: the new capability gate refused `duplicateAd` at the pre-POST authority snapshot, and the seam read it as "fake provider duplicate did not verify". | `e1fd528d6` — the seam states the environment capability it needs, like the manual ad-status seam | Fixed. No guard weakened; the closed answer keeps its own coverage. |
| Three suites my earlier commits broke and I had not re-run: quiet-hours enforcement, demo write authority, and the D075 state-history ledger. | `9e2afceec` | Fixed — the first two now state the release capability they need; the ledger classifies the sizing projection reader, with an audit-doc addendum. |
| A bid write is journalled as `action: "launch_adset"` with `payload_request.operation = "apply_bid"`. History and the client feed disambiguate it, but the verb is untrue. `bid` is now a legal verb in the type and the CHECK (the unattended runtime uses it), so correcting the operator route is cheap. | `lib/meta/entity-action-routes.ts:917` | **Not changed.** Outside the ten findings, and it needs two downstream readers moved with it. Flagged. |

---

## Local proof vs. what still needs a rollout

**Proven locally, in an isolated app against a provider double**

- Login, Overview morning card (queue counts, standing modes), Automation surface.
- **STOP** in both directions, each behind its typed confirmation and each
  confirmed by a server read-back; a confirmation older than five minutes is
  refused, which the surface says and enforces.
- **Approve** on a bid row: mounted click → `/api/meta/automation/proposals` →
  claim → the new bid branch → the guarded `apply-bid` handler → the provider
  double → read-back → `approved` with a durable receipt naming the endpoint
  and the amount.
- With STOP engaged, the same approval returned **503** and the row stayed
  `pending` — no write, no settle, and the surface said why.
- The standing-mode switch persisted (`budget: semi_auto → auto`) and produced
  a promotion record.
- The guardrail form exposes the per-action ceiling **and** its currency, which
  is the A1.8 trap being avoidable rather than silent.
- `npm run test:migrations-from-zero`: **PASS**, including the two new seams.

**Still requires a later, separately authorized rollout**

- Every provider write above was a rehearsal or hit a double. Nothing has
  reached Meta, and `ads_management` permission for budget and bid writes is
  unproven until a real write's read-back says so.
- The four production settings the plan already listed remain unset:
  the resolver-version env, `META_AUTOMATION_LIVE_WRITES`, IwaStore's STOP, and
  IwaTR's ROAS target.

---

## Open items

1. **Apply from a decision card is not visually confirmed.** The Decision
   Center refuses to serve until eight sources are available; the fixture
   satisfies the recommendation snapshot and the warehouse but not the
   canonical creative decision source, so the lanes stayed at zero and no card
   rendered. The same operator-origin write path is proven end to end through
   the queue's Approve, which drives the same guarded handlers. Closing this
   needs a deeper fixture (`engine_v3_ad_decision_snapshots_daily` and its FK
   chain), not a code change.

2. **At 390 px the Automation surface is read-only by design.** It renders
   `data-read-only="true"` and says "Automation controls are available only in
   the desktop workspace": STOP state is visible, STOP is not operable, and the
   queue is absent. That contradicts the plan's §6 acceptance line ("Uygula /
   Onayla accessible at 320px"). It is a stated product decision, not a broken
   layout, so it needs a decision rather than a silent fix: make the mobile
   surface carry STOP and the queue, or amend the acceptance line.

3. **D077 artifact hash contract fails** — two cases, already failing at
   `8d5756c53`. It pins a sha256 per file in the cumulative release diff and is
   regenerated at release time; §7 of the plan puts D077/D086 evidence-pack
   maintenance out of scope. It must be regenerated before release.

S1–S4 are **not** declared complete: items 1 and 2 above are acceptance
criteria that remain unmet.
