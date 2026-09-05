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

node --import tsx scripts/meta-decision-card-apply-harness.ts --rerun-probe
```

`--rerun-probe` is the rerun-stability grader. It builds its own cluster under
a sibling directory, drives four snapshots, prints what each one produced and
removes the cluster again — see *Re-running the snapshot* below.

```
node --import tsx scripts/meta-decision-card-apply-harness.ts --clock-rerun-probe
```

`--clock-rerun-probe` grades the half of rerun stability the first probe
structurally cannot reach: the anomaly families that read the WALL CLOCK. It
seeds its own small business rather than this fixture, drives the snapshot at
four injected clocks, and prints whether each anomaly row is open or resolved —
see *A rerun at a different hour* below.

```
node --import tsx scripts/meta-decision-card-apply-harness.ts --availability-matrix
```

`--availability-matrix` is the third mode: it seeds this same fixture once,
clones it into 24 databases with `CREATE DATABASE … TEMPLATE`, and drives one
child process per operating posture — decision mode `manual`/`semi_auto`/`auto`,
STOP engaged or released, rehearsal on or off, the automation master capability
open or shut — measuring whether the RECOMMENDATION, its EVIDENCE and its
SIZING survive unchanged while only the queue and the dispatch move. Its
findings and the full table live in
[`docs/qa/decision-availability-matrix.md`](decision-availability-matrix.md).
`MATRIX_ONLY=<substring>` narrows it to matching cells and
`--matrix-report=<file>` re-prints a finished run from its own JSON.

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
| A Shopify store with a **`commerce_orders_recent`** row carrying `latest_successful_sync_window_start` / `_end` (and the attempt columns set equal to them) | `resolveRetainedRecentOrderSpan` proves coverage from the SUCCESS-ONLY bounds; an attempt window reaching outside them is `orders_coverage_unproven` — that is the expanded webhook-repair case, not this one. Without a proven span there is no CPA benchmark, no spend unit, and the whole economics chain withholds. Only `commerce_orders_recent` and `commerce_orders_historical` are read — a `commerce_orders_backfill` row is invisible to it. |
| ROAS 2.20 and nothing else — no target CPA, no AOV assumption | ROAS is the only required commercial target. The store's observed average order value is then the sole source of a CPA benchmark, which is what makes the store's evidence load-bearing rather than decorative. |
| **Both halves of that save**: `business_target_packs` AND `business_target_pack_history` | `upsertBusinessCommercialTruth` writes both in one statement, and they are read by DIFFERENT callers — the engine reads the HISTORY as-of the snapshot day, every serve-time re-validation reads the CURRENT pack through `getBusinessCommercialTruthSnapshot`. Seeding only the history produces a state the product cannot: the engine sizes a decision against ROAS 2.20 and the surface immediately withdraws it with `current_commercial_target_authority_unavailable`. Found by the availability matrix; see its Finding 0. |
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

**This section used to be wrong.** It claimed that a second snapshot for the
same day writes no new anomaly, so the constrained set empties and the cap
raise is withheld — and it offered two `DELETE` statements as the way to get
the decision back. Both statements are gone, and nobody should run them: a
guide that teaches an operator to delete decision rows in order to see a
decision is worse than no guide.

**And then it was wrong in the other direction.** The replacement text said
"the detector is a pure function of `meta_campaign_daily`, `meta_adset_daily`
and `meta_ad_daily`", so unchanged facts produce the same anomalies however
many times you run it. That is true of four of the seven anomaly families and
false of three, and the false half is where a real same-day rerun loss lived.

| family | reads |
|---|---|
| `roas_drop_sudden` | the three warehouse tables only |
| `delivery_stall` | the three warehouse tables only |
| `policy_block` | the three warehouse tables only |
| `cpm_spike` | the three warehouse tables only |
| `pacing_failure` | + the wall clock (fraction of the UTC day) |
| `budget_exhausted_early` | + the wall clock AND the business timezone |
| `zero_conversions_with_spend` | + the business loss budget |

`detectAnomalyEvaluationForBusiness` takes `now` from `input.now ?? new Date()`
and `lib/meta/snapshot.ts` passes none, so the wall clock is sampled afresh on
every run. The profile comes from `readMetaCommercialTargets(...)` and a
`businesses.timezone` read, neither of which is one of those three tables. No
detector reads what a previous run wrote — that part of the claim stands, and
`lib/meta/snapshot-rerun-stability.test.ts` pins it.

The bid path this harness exists for runs entirely on `delivery_stall`, which
IS in the pure half. So for the question the guide was originally answering the
answer is unchanged, and driving `runMetaSnapshotForBusiness` twice against
byte-identical warehouse rows (`--rerun-probe`, below) shows it:

| | run 1 | run 2, identical facts | run 3, after the operator applied | run 4, stall recovered |
|---|---|---|---|---|
| `anomaliesWritten` | 1 | **1** | 1 | 0 |
| `bidProposals` | `{candidates:1, projected:1}` | `{candidates:1, projected:0}` | `{candidates:0, projected:0}` | `{candidates:0, projected:0}` |
| ad set `target_value` | bid intent, 1320 | **bid intent, 1320** | bid intent, 1320 | `NULL` |
| pending proposal rows | 1 | **1** | 0 | 0 |

Read the second column carefully, because it is where the old claim came from.
`projected: 0` is **not** a lost decision. `candidates: 1` says the ad set is
still eligible; `projected: 0` says the producer refused to raise a *second*
row for a slot that already holds one. That refusal is now named in the log
instead of being dropped:

```
[meta-snapshot] bid_proposal_projection { candidates: 1, projected: 0,
  refusals: { insert_conflicted: 1 } }
```

Two unique indexes stand behind it, and the probe prints both from the migrated
schema before it runs anything:

- `uq_meta_automation_proposals_projection` on
  `(business_id, provider_account_id, decision_key, rec_type, snapshot_date)`
  — the one `insertBidProposalRow`'s `ON CONFLICT … DO NOTHING` names, so a
  rerun for the same day cannot raise a second row from the same decision.
- `uq_meta_automation_proposals_open_slot` on
  `(business_id, provider_account_id, decision_key, proposed_action)`
  `WHERE status IN ('pending','claimed','reconcile')` — one OPEN row per slot
  whatever raised it. It supersedes the older
  `uq_meta_automation_proposals_pending_slot`, which the migration drops once
  this wider one exists; a freshly migrated database therefore has the open-slot
  index and not the pending-slot one.

The third column is the sequence the walkthrough above actually puts you
through. Once the proposal is settled, `TYPED_BID_CANDIDATE_SQL`'s open-slot
predicate excludes the slot for the rest of the day — `candidates: 0` — so a
rerun cannot ask you to apply the same bid twice. The decision itself is
untouched: the card still shows 1320.

The fourth column is the falsifier. Restore the stalled day's impressions to
the ad set's own seven-day median and the evidence genuinely disappears: the
anomaly row for the day is stamped `resolved_at`, `target_value` goes `NULL`
and no bid candidate remains. Stable is not the same as frozen.

To grade all four in one command, on a cluster it creates and removes itself:

```
node --import tsx scripts/meta-decision-card-apply-harness.ts --rerun-probe
```

It seeds the identical fixture, skips the seed's own snapshot, and drives
`runMetaSnapshotForBusiness` itself — printing, per run, the warehouse fact
fingerprint, the detector's unguarded return value (the production caller
degrades a throw to "no anomalies, and nothing resolved" and logs
`anomaly_detection_failed`, so the probe calls the detector without that
`.catch` and lets a throw surface as a stack), the run counters, the ad set's
`target_value` and the proposal rows. Add `--keep` to leave the cluster up.

The Decision Center's own "Run a snapshot" button is rate-limited by a
server-side cooldown, so a second press inside the window reports the cooldown
rather than running.

## A rerun at a different hour

The table above varies the FACTS. It cannot see the other rerun an operator
actually performs — same facts, different hour, "Run a snapshot" pressed in the
morning and again at night — and that is where a real evidence loss lived until
it was fixed. This fixture structurally cannot show it: its snapshot date is
always yesterday, so the two clock-gated families are outside their window in
all four of its runs and never appear in that table at all.

Two families decline to judge outside a window, because the judgement is
meaningless outside it: `pacing_failure` needs more than 60% of the UTC day
behind it, and `budget_exhausted_early` is only answerable between 20% and 90%
of the LOCAL day (a campaign at 95% of budget at 90% of the day is pacing
correctly; the same campaign at 30% of the day has stopped buying). A third,
`zero_conversions_with_spend`, needs a loss budget the business may not have
configured.

The writer used to read a family's silence as recovery. Its resolve step stamps
`resolved_at` on any open anomaly of the day that is absent from the run's
payload, and `/api/meta/decisions-workspace` serves `resolved_at IS NULL` as
`open`, so:

> a campaign at 96/100 of its daily budget produces a **high**-severity
> `budget_exhausted_early` row at 08:00 local; a rerun at 22:00 the same day, on
> byte-identical warehouse rows, resolved it — because 92% of the local day is
> outside the window, not because anything recovered.

The same fired for a snapshot of a PAST day, where `localDayProgress` returns 1
and the family can never be re-detected at all.

The fix is in two places. `detectAnomalyEvaluationForBusiness` now returns
`evaluatedTypes` and `skipped` alongside the anomalies, so "we looked and found
nothing" is a different answer from "we did not look"; and both of the resolve
statements in `lib/meta/snapshot.ts`'s `upsertSnapshotRows` — the `resolved`
CTE and the empty-payload `UPDATE` — now carry `rec_type = ANY(...)` over the
evaluated families. A recommendation-only write (every per-account write in the
loop, which previously resolved the whole day's anomalies before the epilogue
re-raised them) and a detection that throws now evaluate nothing and therefore
resolve nothing. The detectors were NOT changed to ignore the time of day — the
gate is correct for detection.

`--clock-rerun-probe` measures it. Four snapshots of one business in
`Europe/Istanbul` (UTC+3, no DST), one campaign at 96 of a 100 daily budget:

| run | injected clock | local | family judged? | the row |
|---|---|---|---|---|
| 1 | `2026-09-06T05:00Z` | 08:00, 33% | yes | written, **open**, high |
| 2 | `2026-09-06T19:00Z` | 22:00, 92% | no — outside the window | **open** |
| 3 | `2026-09-07T05:00Z` | snapshot date now past | no — progress is 1 | **open** |
| 4 | `2026-09-06T05:00Z`, spend 96 → 10 | 08:00, 33% | yes | **resolved** |

The warehouse fingerprint is identical across runs 1–3 and only moves for run
4, which the probe prints. Run 4 is the falsifier: without it, "resolves only
what it evaluated" and "never resolves" would look the same, and simply
deleting the resolve step would produce the first three rows.

Each run also names what it declined to judge, so a family's silence is legible
in the log rather than inferred:

```
[meta-snapshot] anomaly_families_not_evaluated {
  skipped: [
    'zero_conversions_with_spend: profile_input_unavailable (no loss budget is configured …)',
    'budget_exhausted_early: time_of_day_gate (92% of the local day has passed; early exhaustion is only judgeable between 20% and 90%)'
  ]
}
```

`lib/meta/snapshot-rerun-stability.test.ts` pins both halves without a cluster.

## What running it established about the card-level Apply

**This section used to say the card's Apply was unreachable.** When the harness
was first built that was true and it was the fixture's most valuable finding:
`proposedActionForRecommendation` granted an executable action only to an
`adset`-grain recommendation whose `type` was `bid_value_guidance`, and the sole
emitter of that type builds a **campaign** recommendation, so the condition was
unsatisfiable for every real row. The card offered "Review refresh plan" beside
a validated 1320.

That gate has since been repaired: the predicate now reads the bid-intent
contract rather than the label (`executableBidIntentMinorUnits` in
`lib/meta/bid-intent-contract.ts`, the same question `TYPED_BID_CANDIDATE_SQL`
asks), and `restampProposedActions` re-takes the stamp after the sizing pass so
the amount exists by the time the stamp is derived. `--rerun-probe` reports the
served control on every run, derived by the surface's own
`serverOperatorApplyForRec` from the persisted row:

```text
run 1  scenario_e1_frequency_fatigue -> {"action":"bid","grain":"adset",
                                         "entityId":"9000000000201","bidAmountMinor":1320}
run 2  scenario_e1_frequency_fatigue -> {"action":"bid", … "bidAmountMinor":1320}
run 3  scenario_e1_frequency_fatigue -> {"action":"bid", … "bidAmountMinor":1320}
run 4  scenario_e1_frequency_fatigue -> null
```

Two things are worth reading off that. The control is **stable across reruns**
— the card does not lose its Apply because the snapshot ran again — and it
still **disappears on the facts**, not on a rerun: once the stall is over there
is no amount to apply and the card says nothing rather than offering a stale
one. `adset_state` rows correctly offer nothing at all in every run, because a
state row describes a condition rather than a change to make.

The same 1320 also reaches an operator through the confirmation queue, which is
the path the walkthrough above drives end to end. The two surfaces now agree
about whether one amount is applyable, which is the whole point of both reading
the same predicate.

## Known, unrelated absences in this fixture

- **"Canonical decision source is unavailable."** No `engine_v3` creative
  decision snapshot is seeded. That banner is about the native creative source,
  not the Meta recommendation source, and the structure lane is served anyway.
- **"Meta data sync is stopped — current decisions are unavailable."** No
  `meta_sync_*` scheduler state is seeded. It suppresses nothing that this
  harness exercises.
