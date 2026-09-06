# Meta operator readiness — the five remaining items

Continues `2026-09-05-meta-operator-readiness-correction-report.md`. Eight
commits on `codex/meta-v2-panel-fidelity`. Nothing pushed, merged or deployed;
no production configuration or database touched; every provider interaction
went to an in-process double.

Two claims in the previous report were wrong and are corrected below.

---

## 1 — The approved creative operation matrix

`2c4614fe5` foundation · `807e61610` manual execution · `12ecc56aa` scheduled
runtimes and producers · `5d3d9d332` the receipt control

| What was broken | Evidence it is not now |
|---|---|
| A queued `launch` returned `unsupported_action`, and the shared lifecycle settles a withheld outcome as **failed** — so approving one destroyed the row. It was also stamped `dispatch_started_at` first, recording a dispatch that never reached a provider. | `lib/meta/launch-queue-arm.test.ts`; `budget-no-fabricated-defaults.test.ts` now pins the widened no-pre-marker rule (`marksAtItsOwnBoundary`) covering budget, launch and intent-lineage resume. |
| The scheduled arm of `activateLaunchIntent` — the approval check and the ad-scope narrowing — **had no caller at all**. Nor did any scheduled launch. | `scheduled-launch-runtime.test.ts` (15), `scheduled-activation-runtime.test.ts` (14). The activation test drives the **real** `activateLaunchIntent` with a null approval and observes `activation_approval_absent`, and captures the `authorize` hook to prove it is re-read per step: campaign allowed, ad set refused mid-sequence. |
| **A live hazard.** `decisionTypeForProposedAction` maps `resume` to the pause family, and `resume` is automatable — so an activation row would have been armed by the PAUSE standing mode and dispatched by the status runtime, with no approval, no ordering, no lineage. | `scheduled-launchpad-sweep-routing.test.ts` asserts from source that `runtimeFor` tests the row's launch lineage **before** its grain, and that the pending page pre-filters intent-lineage rows unless a stored approval exists. The additive `meta_automation_proposals_activation_lineage` CHECK makes a lineage-less one unstorable. |
| `activation_approval_json` had a writer route and no UI. | `LaunchpadActivationPanel` posts the operator origin and explicit confirmation to both routes; revoke posts `{revoke:true}` and the panel still shows the approver and the withdrawal time. Verified in a real Chromium render with the compiled application CSS at **1280 and 390 px**. |
| `readCreativeId` read two payload keys the shipped payload does not carry, so it returned null for every real intent and the scheduled activation refused each as an asset mismatch. | Fixed to read the `creatives` / `creativeIds` shapes a launch actually stores. |
| The launch producer read `status = 'ready'` — a state written and consumed inside one HTTP request — and its `ON CONFLICT` arbiter could never fire, so a second insert threw and dropped the rest of the batch. | `launch-proposal-producer.test.ts`; the query now reads prepared, unstarted intents with real decision lineage and absorbs a per-candidate conflict. |

Both new runtimes carry a **second** gate the others do not: `META_LAUNCHPAD_EXECUTION`
**and** a complete write-safety family. A create with nobody present is what
that flag exists to keep shut, and flipping it cannot open a family that still
declares a missing step.

## 2 — Shopify window completeness

`6ff7e73e7`

The clock took `MAX(latest_successful_sync_at)` across all four sync targets, so
a **returns** pass an hour old vouched for orders read five days ago. The
returns pass cannot speak for these numbers at all: it writes only
`source_kind: 'return'`, while the purchase count and net revenue come from
order, adjustment and refund rows, all written by the orders pass.

Now scoped to the two ORDER targets, and freshness is no longer the whole
question — the requested window must be **covered**, proved from the recorded
sync windows alone and never from the presence of rows.

The three named cases, all in `shopify-aov-source.test.ts` (20 passing):

- *"does not let a fresh RETURNS sync speak for stale orders"*
- *"refuses a window that begins before the earliest covered day"* → `orders_backfill_incomplete`, plus *"refuses when the covered spans do not join up"* → `orders_coverage_gap`
- *"does NOT call a freshly synced store stale for want of recent sales"* — the regression the earlier fix existed for, still holding

`scripts/ephemeral-postgres-shopify-aov-coverage-seam-child.ts` proves the
predicate against a migrated database. Gate: **PASS**.

## 3 — Scheduler recovery

`4c7838940` — each defect reproduced with a failing test first.

- **A failed projection was never retried**, through three separate paths: the
  whole-chain `already_ran` counted only the three producer jobs; the predicate
  tested `success` and not `previous_success`; and `.catch(() => null)` swallowed
  the failure with nothing recorded. Filling the queue is now a fourth durably
  recorded step, so the slot stays outstanding until it has actually succeeded.
  A manual standing mode records as *skipped*, an unreadable one as *failed* —
  "the operator turned it off" and "we filled the queue" are different answers.
- **Retry covers only the missing accounts**, including A succeeded while B and
  C failed (`snapshot-retry-scope.test.ts`).
- **The persisted cut-off is the source maximum actually read.** The field's own
  comment already said so; the code stored the requested date. A smaller
  observation is written as-is — no high-water mark anywhere — and a run that
  read nothing records that rather than inventing a date.

## 4 — The isolated fixture, and three dead links it exposed

`43512cdcd`

Building a seam that runs the **shipped** snapshot instead of one that mints its
own payload found three production defects, each of which made its chain produce
nothing while every test stayed green:

1. **The bid intent projection wrote a payload the candidate query can never
   select** — no `kind`, `authorityStatus`, `proposedMinorUnits`, `currency` or
   `currencyExponent`. No snapshot-produced bid intent had ever become a queue
   row. The earlier bid tests passed only because they wrote the payload
   themselves, which is exactly the failure mode this item existed to end.
2. **`anomalies.ts` selected a `purchases` column that does not exist** on
   `meta_campaign_daily` (the warehouse counts `conversions`). That query raised
   42703 on every run and the caller swallows a failed detection into an empty
   list — so **no Meta account ever produced a single anomaly, of any type**,
   `delivery_stall` included. That is why the bid path could never find the
   delivery evidence a cap raise requires.
3. **The budget projection passed `rec.decisionLabel ?? null`** to the sizing
   policy. Producers set that field only sometimes, so every eligible candidate
   was withheld for want of a label the recommendation's own type determines.

`scripts/ephemeral-postgres-economics-bid-chain-seam-child.ts` seeds facts and
calls the real functions; `58.00 / 2.20` is never divided in it. Gate output:

> the real snapshot derives its CPA benchmark from a Shopify store and a target
> ROAS alone, sizes a campaign budget 25000 → 27500 that the real candidate SQL
> selects, sizes a cost cap 1200 → 1320 on the delivery-stalled ad set and
> raises the queue row carrying it, refuses the budget row by name on the
> unapplied D086 profile table, loses both intents when the store's evidence is
> withdrawn, and makes zero provider requests.

$26.36 is bound by what the producers wrote (a 10% raise at a 0.83 CPA ratio)
plus a negative control that withdraws the store's evidence and shows both
intents disappear, then restores it and shows them return.

## 5 — Mounted Apply, Approve, STOP and receipts

`3c72f400e`

**The previous report's premise was wrong.** There is no eight-source gate: the
eight are `DECISION_CAPABILITY_SLOTS`, a display envelope with three references
in the repo and none of them a render gate — and two of its slots are hard-coded
`proposed` in production, so "eight available" was unreachable by construction.

**The real defect**: the ceremony sent `row.id`, a display identity like
`structure-7` or `bid-c1`, where the preflight demands `campaign|adset|ad:<id>`.
Every card-level Apply was refused before any data question could be asked.
`DecisionRow` now carries a `decisionKey` derived from the row's own grain
identity with no fallback; a row without one draws no control and never calls
preflight; and the panel offers only the verb the server named.
`scripts/ephemeral-postgres-decision-card-apply-seam-child.ts` proves it on real
SQL — including that the card keeps its Apply while the native read model is
`snapshot_unavailable`. Gate: **PASS**.

**The mobile surface** said automation controls were desktop-only. STOP and the
confirmation queue are now surface-parameterised and rendered on both panes —
one truth, two renders, no second state, every duplicated DOM id scoped by
surface. The guardrail form, the rules, the autonomy ladder and the master
switch stay desktop-only, with their authorization allowlist untouched, and the
copy now names which is which.

Verified mounted, in a browser, against an isolated database and a Meta double:

| At | Observed |
|---|---|
| 390 px | `data-read-only="false"`; STOP and both queue rows operable; no horizontal overflow |
| 390 px | Approve on the bid row → real POST → `/api/meta/adsets/120200000000011/apply-bid` → row `approved`, `dryRun: true` |
| 390 px | STOP engaged through its typed phrase and server read-back; then released the same way |
| 390 px | With STOP engaged, an approval was **refused** and the row stayed `pending`; the pane said "Engaged from the Automation control plane." |
| 320 px | STOP, Review-before-applying, Modify and Dismiss all reachable; no overflow |
| 1280 px | Full desktop pane unchanged; no duplicate DOM ids on either width |

---

## Gates

| Gate | Result |
|---|---|
| `npx vitest run` (full) | **17,353 passed**, 2 failed — both D077, out of scope |
| `npx tsc --noEmit` | 0 |
| `npm run lint` | 0 |
| `scripts/verify-whitespace.sh` | PASS |
| `npm run test:migrations-from-zero` | **PASS**, including the three new seam children |
| `d080b` budget policy simulation | 116 passed when run alone; its earlier failure was a 15 s timeout under full-suite load, not a defect |

## Still open

1. **A populated Decision Center lane was not rendered in a browser.** The card's
   Apply is proved on real SQL by its seam and by jsdom tests of the ceremony,
   and the root-cause fix is the key derivation above. Rendering a lane
   additionally requires the warehouse publication chain (manifest, planner and
   partition pointers) that `filterRowsToPublishedKeys` reads; publishing 84
   slices through the real lifecycle moved the workspace from `unavailable` to
   `available` and surfaced the anomaly, but the census stayed at zero. That is
   fixture depth, not a product defect, and it is the one acceptance line still
   proved at the seam rather than in the browser.
2. **A launch queue row is still unreachable end to end** until something stages
   an intent *from a decision*: the corrected candidate query requires decision
   or brief lineage, and no producer creates an intent today. The path is
   complete and gated; what is missing is its first upstream caller.
3. **D077 artifact hash contract** — two cases, failing since before this work.
   It pins a sha256 per file in the cumulative release diff and is regenerated
   at release time; §7 puts D077/D086 evidence-pack maintenance out of scope.
