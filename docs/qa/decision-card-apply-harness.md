# The Decision Center apply harness

`scripts/meta-decision-card-apply-harness.ts` builds a throwaway workspace in
which the Meta Decision Center renders a populated lane and the confirmation
queue holds a real, engine-produced bid proposal that can be approved against a
provider double. It exists because the card-level Apply had only ever been
proved at the SQL seam and in jsdom, and neither of those mounts the product.

```
node --import tsx scripts/meta-decision-card-apply-harness.ts          # build it
sh  $TMPDIR/adsecute-decision-card-apply-harness/start-dev.sh          # run the app
node --import tsx scripts/meta-decision-card-apply-harness.ts --stop   # tear it down
```

The build prints its own `DATABASE_URL`, the two sign-in identities, the
business and account ids, and the URL to open. It also writes the launcher and
the provider double next to the cluster, so nothing about the fixture has to be
reconstructed by hand.

## Safety

The cluster runs on a random free port that is never **5432** (this machine's
local volume) and never **15432** (the tunnel `.env.local` points at
PRODUCTION). `DATABASE_URL` is exported by the launcher *before* `next dev`
starts, because `@next/env` skips keys already present in `process.env` — that
is the only thing standing between this fixture and the production database.

`meta-provider-double.mjs` installs an undici `MockAgent` with
`disableNetConnect()`, re-enabling loopback only (the app calls its own upstream
routes over HTTP). Nothing can reach Meta: an un-intercepted request throws.
Every request the double answers is appended to `provider-double.log`.

The double holds state. `updateAdsetBidAmount` posts an amount and then re-reads
the entity, refusing with `silent_failure` when the read-back disagrees — so a
double that always echoed success would make that check unfalsifiable. It also
answers `campaign{id}` for each ad set, because the manual preflight refuses
with `current_hierarchy_identity_mismatch` when the parent it reads back is not
the parent the warehouse recorded.

## What the fixture contains, and why each part is load-bearing

| Seeded | Why the surface is empty without it |
|---|---|
| 28 days of `account_daily`, `campaign_daily`, `adset_daily` through the real upsert writers | The writers maintain the dimension rows both candidate queries join against. |
| A published slice **and pointer** per account-day per surface, through `createMetaAuthoritativeSliceVersion` + `publishMetaAuthoritativeSliceVersion` | `filterRowsToPublishedKeys` drops every warehouse row whose `account:day` is not a published key, and an empty key set returns an empty array. Creating a slice is not enough: `getMetaPublishedVerificationSummary` requires a publication pointer whose target slice is `status='published'` AND `state='finalized_verified'`. |
| The newest day is **yesterday** (UTC), recomputed per run | `isMetaCurrentAccountDay` never treats today as published, and `/api/meta/decisions-workspace` anchors its 28-day window on `previousUtcDate()`. |
| `account_daily` published too | The account-pulse upstream reads it, and the workspace awaits *both* upstreams before it serves anything. |
| A selected `business_provider_accounts` row | `readAssignmentRowsByBusiness` filters on `is_selected`; an unselected row reads as no assigned account at all, short-circuiting before the warehouse. |
| `is_demo_business = FALSE` | `readMetaBusinessDataPosture` answers `unverified` for anything it cannot prove is a real workspace, and the workspace route then returns 503 before it reads anything. |
| A Shopify store with a **`commerce_orders_recent`** row carrying `latest_sync_window_end = ready_through_date` and a successful status | `recentOrderSpanIsProven` pairs the retained start with the retained success end only under those conditions; otherwise the AOV reader answers `orders_coverage_unproven`, the CPA benchmark is absent, and the whole economics chain withholds. Only `commerce_orders_recent` and `commerce_orders_historical` are read — a `commerce_orders_backfill` row is invisible to it. |
| ROAS 2.20 and nothing else — no target CPA, no AOV assumption | ROAS is the only required commercial target. The store's observed average order value is then the sole source of a CPA benchmark, which is what makes the store's evidence load-bearing rather than decorative. |
| `meta_entity_state_history` with an observation run per grain | The rows carry a composite key back to the run, so the run must exist first. The capped ad set carries its parent's amount and owns none of it, which is what makes its budget universe `proven_non_applicable`. |
| A published `engine_v3_campaign_context_daily` role for the capped campaign only | `contextTrust` is `high` only on an exact `high` confidence class, a byte-for-byte `system_inferred` origin AND an approved resolver identity. The launcher exports `CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION` so the running app agrees with the seed. |
| Guardrails naming **USD** and both sizing policy versions | An absent ceiling takes the packaged EUR default and every sized intent dies on `policy_spend_ceiling_currency_mismatch`; a stale policy version refuses before any evidence is read. |
| A delivery collapse on the newest day of the capped ad set | `delivery_stall` is the only evidence in this product that a cap is holding delivery back, and the bid policy withholds every raise without it. |

The decision itself is **not** seeded. `runMetaSnapshotForBusiness` — the same
function the scheduler calls — derives the `delivery_stall` anomaly, sizes the
cost cap 1200 → 1320 minor units, and raises the queue row.

## The two identities

| Sign in as | Role | What it is for |
|---|---|---|
| `harness-operator@adsecute.test` | admin | The positive path. |
| `harness-reviewer@adsecute.test` | guest | The read-only viewer. |

Both use the password printed by the harness. The shipped `isReviewerEmail`
reviewer is a single hard-coded address that `canReviewerAccessBusiness`
confines to the demo business, so it cannot be pointed at this workspace; the
other half of the same predicate — `readOnly = reviewer || role === "guest"` in
`workspaceViewer` — is reachable and is the one that governs what renders.

## The walkthrough

1. Sign in, open `/c/<business>/meta/decisions?providerAccountId=<account>`.
   The census, the lanes and the ROAS tiles are populated from the published
   warehouse.
2. Open `/c/<business>/meta/automation?...`. "Needs your confirmation" holds
   **Apply bid · Broad prospecting**.
3. **Approve & apply** → `POST /api/meta/automation/proposals` → the shipped
   `/api/meta/adsets/<id>/apply-bid` route → `POST bid_amount=1320` at the
   double → the read-back GET → the proposal turns `approved` and
   `meta_automation_activity_ledger` holds an `applied` receipt naming the
   endpoint, `dryRun: false` and the amount.
4. Negative cases: engage the STOP with its typed phrase and approve again —
   the POST answers **503**, the row stays `pending`, and nothing reaches the
   double; sign in as the guest — Approve, Modify and Dismiss are all disabled
   and the pane says writes require collaborator access; age
   `shopify_sync_state.latest_successful_sync_at` past its freshness bound and
   re-run the snapshot — the proposal disappears entirely.

## Re-running the snapshot

The bid intent is produced from **this run's own** `delivery_stall` anomalies.
A second snapshot for the same day writes no new anomaly, so the constrained set
is empty and the cap raise is withheld. To raise the proposal again, clear the
day's anomaly rows and the settled proposal first:

```sql
DELETE FROM meta_automation_proposals;
DELETE FROM meta_decision_snapshots_daily WHERE kind = 'anomaly';
```

then run the snapshot. The Decision Center's own "Run a snapshot" button is
rate-limited by a server-side cooldown, so a second press inside the window
reports the cooldown rather than running.

## What running it established about the card-level Apply

The card's Apply is **not reachable** by any recommendation this engine
produces, and no fixture can make it so.
`proposedActionForRecommendation` (`lib/meta/recommendations.ts`) grants an
executable action only to an `adset`-grain recommendation whose `type` is
`bid_value_guidance`, and the sole emitter of that type —
`maybeBidRecommendation` — builds a **campaign** recommendation. Nothing else
in the repo sets `proposedAction` on a recommendation.

The mounted workspace payload shows both halves of that at once. The ad-set row
carries the sized intent and offers no apply:

```
scenario_e1_frequency_fatigue-9000000000201
  level adset · type scenario_e1_frequency_fatigue · decisionState test
  targetValue.bidAmountMinor 1320
  operatorApply null · actionKind review_drill · primary "Review refresh plan"
queue.actionStates { executableBid: 0, reviewOnly: 7, missingActionKind: 0 }
```

The same 1320 reaches an operator through the confirmation queue, which is the
path the walkthrough above drives. Until the type gate is repaired, that queue
is the only mounted route from a sized bid intent to a provider write.

## Known, unrelated absences in this fixture

- **"Canonical decision source is unavailable."** No `engine_v3` creative
  decision snapshot is seeded. That banner is about the native creative source,
  not the Meta recommendation source, and the structure lane is served anyway.
- **"Meta data sync is stopped — current decisions are unavailable."** No
  `meta_sync_*` scheduler state is seeded. It suppresses nothing that this
  harness exercises.
