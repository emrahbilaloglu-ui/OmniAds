# Meta operator readiness — the eight follow-up findings

Answers `2026-09-05-meta-operator-readiness-followup-review.md`, reviewed at
`fbb275acb`. Seven agents with non-overlapping file ownership plus one
integrator; every handoff between them is applied and listed below.

Nothing was pushed, merged or deployed. No production configuration, database
or advertising account was touched. Every provider interaction went to an
in-process double or to an undici `MockAgent` with `disableNetConnect()`.

Each finding was **reproduced before it was fixed**, by driving the shipped
functions — not by reading them.

---

## R1 — budget proposals required an absent runtime dependency · FIXED

`engine_v3_account_profile_output` existed only in the unapplied D086 pack.
Nothing created it, nothing wrote it, the loader's missing-table error became
`null`, and the producer refused every candidate with
`composition_sources_unavailable`.

The dependency is completed rather than substituted. Binding to the one
already-migrated candidate (`engine_v3_ad_account_calibration_daily`
`action_readiness_json`) would have meant either loosening
`classifyRetainedProfile` — which requires the
`adsecute.account-decision-profile.v1` contract and a `D086_CANONICAL_BLOCKER_CODES`
code — or asserting that a verdict came from the account decision profile when
it came from the ad-calibration cell. So: the DDL is now a registered migration
(byte-for-byte the pack's own statements, the same correction already applied to
`engine_v3_campaign_role_authority`), and `lib/meta/account-profile-output-producer.ts`
is a real producer that reads the account's retained facts and resolves the
canonical profile through `resolveAccountDecisionProfile`. It decides nothing:
the boolean and its blocker code are the engine's, and an ineligible account
retains an ineligible row.

**The identity problem the review did not name.** Even with a table and a
producer, `expectedProfileIdentity` reads `profileInputFingerprint` /
`profileSourceFingerprint` off the engine decision, and no producer in this
repository has ever written them there — three test fixtures are the only
occurrences. Every real candidate would still have answered
`profile_identity_agreement_unavailable`. `reconcileProfileIdentityExpectation`
adds a second, external source: the identity of the inputs retained now,
re-derived from the commercial-truth and calibration readers and never from the
row being judged. Decision-carried digests are still honoured; where both exist
they must agree exactly. This only ever adds refusals.

**Three further production defects found by getting further**, each swallowed by
a `catch` before: `control.businessControl.updatedAt?.slice(...)` threw on a
`Date`; `classifyRetainedProfile` read `effective_at`/`recorded_at` with an ISO
regex against `Date` values, so every well-formed verdict was
`retained_profile_recorded_malformed`; and `nowMs` was sampled at reader entry,
before the provider baseline was read, so D085 refused every candidate with
`capture_after_knowledge_cutoff`.

**One more, in a file the agent did not own, now fixed by the integrator.**
`lib/meta/budget-write-execution.ts` sampled its clock before
`readProviderBaseline`, and the preflight refuses `baseline.readAtMs > nowMs` as
`provider_baseline_stale` — so on a real account, where a Meta GET takes longer
than zero milliseconds, **every budget write was refused before any POST**.
Against an instant double both stamps landed in the same millisecond and every
test passed. The clock is now sampled after the read. The agent's workaround
pre-read in `budget-proposal-server-readers.ts` is removed, as it asked.

**And one strengthening.** The loader and the execution reader reported
`classifyRetainedProfile(...).usable` as the commercial verdict, so a well-formed
retained row saying `eligible: false` with the engine's own blocker code would
have read as eligible the moment the table started carrying rows. They now bind
the retained row's own boolean and its own code.

**Acceptance, on a migrated isolated database** (`scripts/ephemeral-postgres-economics-bid-chain-seam-child.ts`,
in the gate):

> the real snapshot derives its CPA benchmark from a Shopify store and a target
> ROAS alone, sizes a campaign budget 25000 → 27500 that the real candidate SQL
> selects, sizes a cost cap 1200 → 1320 on the delivery-stalled ad set and
> raises the queue row carrying it, retains the canonical commercial verdict
> through the real producer and raises both budget rows on it, refuses an absent
> and a superseded verdict by name, **executes one row through operator approval
> and the other through the scheduled sweep with durable read-back receipts**,
> loses both intents when the store's evidence is withdrawn, and makes exactly
> two provider writes.

The negative case is separate and still a rejection test: with the table
emptied, the real execution reader answers `profile_not_retained`,
`commercial.sourceStatus: unavailable`, `commercial.eligible: null`; running the
producer again admits the same candidate with zero blockers.

**Missing upstream caller, now present.** `lib/meta/snapshot.ts` produces the
day's retained verdict per assigned account immediately before
`projectMetaBudgetProposals`, degrading like the other projections. The loader's
`ensureRetainedAccountProfileOutputs` probe is kept as the safety net.

## R2 — no decision-to-staged-launch producer · FIXED

Reproduced two ways. At source: every writer of `meta_launch_intents` was
grepped; `POST /api/launchpad/meta/intents` passes only `sourceDraftId`, so no
row could ever match the queue's decision/brief lineage requirement. And
permanently, as step 0 of the new seam: with the fully approved fixture in
place, `projectMetaLaunchProposals` finds `candidates: 0` and the table is
empty. That assertion stays, so the defect cannot silently return.

`lib/meta/launch-intent-producer.ts` stages the intent from an eligible
decision, an approved asset, a reviewed brief and an operator-composed draft —
only already-approved inputs, exact targets, missing approval a named blocker.

**Acceptance** (`scripts/ephemeral-postgres-decision-launch-chain-seam-child.ts`,
newly registered in the gate):

> an eligible decision with a reviewed brief and an operator-composed draft
> stages one PAUSED launch intent, raises one launch row, creates exactly one
> provider ad through the real approval route, activates it through a separate
> approval, and reruns to no second intent, no second row and no second ad; an
> approval missing its destination stages nothing and says which one is missing.

The approval goes through the real `POST /api/meta/automation/proposals` under a
real session cookie with `manualConfirmation: explicit_operator_confirmation`.

**The limit is now lifted, by a second authority rather than a wider one.**
`lib/launchpad/meta-manual-authority.ts` adds
`META_LAUNCHPAD_STAGED_AUTHORITY = {launchpad_decision_staged_v1, decision_staged_approval}`.
The producer binds it in **every** mode it stages under — not only `auto`,
because an intent staged under `semi_auto` and swept after a mode change would
otherwise arrive at the unattended arm carrying a confirmation nobody gave.
`storedLaunchExecutionAuthority` returns which of the two it found, and the
create routes bind the STORED payload's authority when a `launchIntentId` is
present (re-binding the operator pair recomputes a different fingerprint and
dies as `launch_intent_contract_mismatch` — verified, not assumed).
`evaluateMetaLaunchpadManualAuthority` is unchanged at runtime: an HTTP request
must still present the operator pair and may never claim the staged one. Only
`manual` is refused now, by name.

## R3 — scheduled create rechecked authority only once · FIXED

Reproduced by execution, not by reading: pre-fix variants differing only by the
removed per-create boundary were swapped in and the new suites run. Ten of
eleven new-campaign cases failed; after the campaign POST was answered and the
family taken off `auto`, the provider double still received
`[act_9/campaigns, 120/adsets, 121/ads, 121/ads, 120/adsets, 131/ads, 131/ads]`
where the fix produces `[act_9/campaigns]`.

The boundary is now asked **once per provider create**. The review's premise
that the primitives already accept a `beforeMutationAttempt` hook was true of
`duplicateAd` and false of `createCampaign` / `createAdSet` / `createAd`, so the
integrator added it: `MetaLaunchCreateOptions` on all three primitives, threaded
into `metaFetchWithRateLimitRetry`'s POST path — after
`getMetaAdsWriteBlockFailure` and immediately before the `metaFetch`, with the
same try/catch shape as `runPreMutationHook`. A refusal returns a named code and
a null `mutationAttempt`. That closes the review's exact demand: *the check is at
each actual provider boundary, not in a test wrapper or one outer callback.*

**Acceptance**, driving the real shared create runtime with a provider double at
`global.fetch` (`lib/meta/scheduled-launch-authority-boundary.test.ts`,
`lib/launchpad/meta-add-to-existing-authority-boundary.test.ts`,
`lib/meta/launch-create-boundary.test.ts`): after the first successful create,
each of scheduled mode, enablement, enabling actor, activation control version,
rehearsal posture, STOP and the Launchpad gate is changed in its own case, and
every remaining POST is withheld — asserted as exact equality on the recorded
path list, not a count. Partial identities and the reason stay durable:
`partially_succeeded` with the created campaign in the result receipt and
`provider_mutation_withheld` plus the gate name in the error receipt.

## R4 — a revoked approval stayed usable mid-sequence · FIXED

Reproduced by running the real `activateLaunchIntent` with a scheduled
authorization and a provider double that persisted a revocation the moment the
campaign came on: `posted: [camp_1, set_1, ad_1]` under an authorization
withdrawn before either later write.

`activateLaunchIntent` gained `reloadIntent` (defaulting to
`getMetaLaunchIntent`, so a scheduled caller cannot get the stale copy by
forgetting to pass one) and, for `{kind: "scheduled"}`, composes a per-step
re-check **ahead of** the caller's gates: re-read the row, re-run the identical
`approvalVerdictFor` (revocation, expiry, fingerprint, business/account,
operation, scope, asset, destination, policy version), re-check that the scope
still covers this grain and that the current receipt still names this identity.

**Acceptance** (`lib/meta/activation-approval-recheck.test.ts`): revoked after
the campaign step → `posted === [camp_1]`, `resumeAdset` and `resumeAd` never
called, `blockedAt: adset`, `blockedReason: activation_approval_revoked`, and
the stored receipt keeps `[camp_1 activated, set_1 blocked, ad_1 not_attempted]`
with exactly one settled journal row. Repeated for expiry and a changed binding.

## R5 — activation silently dropped additional adsets and ads · FIXED

The review's reproduction, verbatim, before any edit:

```text
requested: [c1, s1, s2, a1, a2]
called:    [c1, s1, a1]
delivering: true
unvisited: [s2, a2]
```

`activationPlanForIntent` now emits every `adsetIds[*]` and every `adIds[*]`,
each naming the parent this same launch created, read off the receipt's own step
ordering. `activateHierarchy` walks every target instead of `find`-ing one per
grain, records exactly one step per identity, and gates each on its parent.
`delivering` now means `coverage.on === coverage.planned` over the identities
rather than "every step I chose to take"; the result carries `partial` and a
`coverage` count that the receipt, the scheduled runtime response, the operator
route and the panel all render. The review's reproduction is kept as a
regression case.

Stop semantics were split rather than loosened: an ambiguous provider outcome
and a refused authority still halt the whole run; an ordinary blocked step stops
its own descendants and leaves an independently approved sibling branch alone.
That is the only behavioural loosening and it is stated in the module header.

**The approval could not name a set — now it can.** `ActivationApproval` held
one `approvedAsset` and one `approvedDestination.adsetId`, so a launch built
from three creatives could only ever be approved for one of them: either the
other two were turned on under an authorization that never mentioned them, or
the whole launch was refused. The contract is now
`meta.launch-activation-approval.**v2**` with `approvedAssets[]` and
`approvedDestination.adsetIds[]`, and validation is containment — every creative
and ad set the receipt names must appear in the approval. A v1 document is
refused as an unknown contract rather than reinterpreted, because its silence
about the creatives it did not name is exactly the defect being replaced. The
writer route and the operator panel pass and render the full sets.

**Acceptance**: `lib/meta/activation-identity-coverage.test.ts` (multiple ad
sets and ads, a mid-sequence failure, a retry that resumes only unfinished
authorized entities, and a final receipt accounting for all identities), and on
a migrated database —

> complete identity set with parentage survives the receipt round trip, one
> journalled row per entity settles independently, a five-identity partial
> receipt reads back with its counts, a persisted approval is accepted then
> refused once withdrawn, and an approval naming fewer creatives than the launch
> produced is refused by name.

## R6 — an unsuccessful expanded Shopify sync could falsely prove coverage · FIXED

The review's own reproduction was confirmed first: `proveShopifyOrderWindowCovered`
extracted verbatim from `fbb275acb` returned `{"covered": true}` for the 28-day
window on the shape the writer actually leaves — a 30-day repair's unproven start
combined with a seven-day pass's retained success end.

Coverage is now proved only from matching successful window bounds, and withheld
when the retained state cannot prove them. The freshly-synced store with no
recent sales keeps working — that regression case is still asserted.

**Acceptance through the real sync-state writer and the real AOV reader** on a
migrated database. The 30 is not asserted: it is read out of the real
`resolveShopifySyncWebhookRepairPolicy`, whose `windowExpanded` is checked and
whose window start the seam reads back to prove the writer really left the
deceptive shape.

> order coverage read from shopify_sync_state through the real columns, a fresh
> returns row unreachable from the result, a short backfill refused as a gap, a
> joined historical+recent span covered, a recent-only store refused as an
> incomplete backfill, a seven-day success followed by a 30-day running or
> failed repair refused as unproven, and the same repair accepted once it
> completed.

## R7 — a failed partial retry overwrote another account's successful slot · FIXED

Reproduced on a real database through the real cron entry point. Account A got a
genuine `success` slot row from `runMetaSnapshotJobIfDue`; B and C were then
assigned and a corrupt payload written under B. The next tick's own
`metaSnapshotMissingPairsForSlot` returned `[B, C]`, the shared calibration threw
on an unguarded numeric cast, and the pre-fix code failed the seam with:

```text
expected {"status":"success","finishedAt":"…066277+03"}
got      {"status":"failed","finishedAt":"…075186+03"}
```

A's success overwritten, with a fresh `finished_at` proving the row was
rewritten. The outcome is now recorded from the accounts actually **attempted**.

**Acceptance** (`scripts/ephemeral-postgres-slot-retry-scope-seam-child.ts`,
newly registered in the gate):

> a whole-business rejection of a {B, C} retry failed only the two accounts that
> were attempted, left account A's slot row reading success with its original
> finished_at, kept A out of the next missing-pair computation, and the repaired
> retry closed the slot without regenerating A.

Nothing was weakened: the pre-existing whole-business rejection test still
asserts both accounts fail — that is the case where attempted and required
coincide — and its title now states the new law.

## R8 — Decision Card Apply in the mounted application · FIXED

`scripts/meta-decision-card-apply-harness.ts` and
`docs/qa/decision-card-apply-harness.md` build a repeatable workspace: a
throwaway cluster on a random free port that is never 5432 (local) and never
15432 (the tunnel `.env.local` points at production), migrated by the repo's own
script, seeded **through the normal writers and the real publication chain**,
with the decision derived by `runMetaSnapshotForBusiness` rather than minted.
`--stop` removes it. A provider double built on undici `MockAgent` with
`disableNetConnect()` holds per-entity state, so the shipped read-back
verification is falsifiable.

Building it settled the previous report's "fixture depth" hypothesis and found
the real blocker, which was **not** a fixture problem:
`proposedActionForRecommendation` granted an executable action only to an
`adset`-grain recommendation whose `type` was `bid_value_guidance` — and the
only emitter of that type builds a **campaign** recommendation, while the bid
projection attaches its intent to whichever ad-set recommendation is present.
The condition was unsatisfiable for every real row. Observed in the mounted
product, both halves at once:

```text
scenario_e1_frequency_fatigue-9000000000201
  level adset · targetValue.bidAmountMinor 1320
  operatorApply null · primary "Review refresh plan"
```

Three corrections, by the integrator:

1. **The gate reads the intent, not the label.** `executableBidIntentMinorUnits`
   (in `bid-intent-contract.ts`, so one predicate serves both readers) requires
   the bid-intent contract, `authorityStatus: "authorised"`, an empty blocker
   list and an amount the two fields agree on — the same question
   `TYPED_BID_CANDIDATE_SQL` asks. The card and the queue can no longer disagree
   about whether one amount is applyable. `serverLaunchModeForRec` carried the
   identical dead condition and got the same treatment.
2. **The stamp is re-taken after sizing.** `stampRecommendation` runs when a
   recommendation is built and the budget and bid projections attach their
   intents afterwards, so the stamp was always taken before the amount existed.
   `restampProposedActions` runs at the end of the sizing pass, and
   `serverOperatorApplyForRec` re-derives from the row's own target value so
   rows persisted before this ordering was corrected light up too.
3. **The bid handler names its outcome.** The status handler returned
   `{outcome, durable, reference}` and the bid handler did not; the ceremony
   normalises an absent `outcome` to `provider_outcome_ambiguous` on purpose,
   so a verified write told the operator *"Outcome unknown · No receipt · do not
   retry."*

**And the receipt was invisible.** Both manual entity handlers called
`createMetaAdsActionLog` without `providerAccountId`, so the row landed with
`provider_account_id` NULL and `history-read-model.ts` — which fails closed on a
row with no account lineage — never showed the write. A successful operator
pause, resume or bid apply was durable and absent from Meta History's Writes
journal.

**Acceptance, mounted, at 1512 px against the isolated database and the double.**
Signed in through the real login form; census 4, lanes and ROAS tiles populated
from the published warehouse. On the ad-set card: primary control → the manual
action sheet → preflight *"Checked at … against persisted state. Meta was not
contacted."* → amount → typed **CHANGE BID** confirmation → the shipped
`/api/meta/adsets/9000000000201/apply-bid` route. The provider double recorded:

```text
GET  /v22.0/9000000000201?fields=id,account_id,status,effective_status,campaign{id}
GET  /v22.0/9000000000101?fields=id,account_id,status,effective_status
POST /v22.0/9000000000201  {bid_amount: "1320"}
GET  /v22.0/9000000000201?fields=…,bid_amount,bid_strategy,…
```

The card then read **"Applied and verified. Meta confirmed the change and we
re-read it back. HTTP 200 · Copy receipt · Applied — nothing to retry."**
`meta_ads_action_log` holds the row `success · manual_operator_v1 ·
provider_account_id act_9000000000001`, and
`GET /api/meta/history?kind=writes` returns it as `verified_success` — where it
returned `entries: []` before. Two card-originated writes (1320, then 1450) are
both journalled and both in History.

**Negative cases.** STOP engaged through the real control with its typed phrase:
the card's primary opens the evidence drawer, the manual ceremony does not open,
the surface reads *"Kill switch engaged. …"*, and the provider double received
three page-load GETs and **zero POSTs**. Released the same way. The read-only
viewer and missing-evidence cases were driven at the confirmation queue.

**390 px and 320 px.** The Decisions surface's mobile stage renders the same
lanes and the same row and states its law on screen: *"Writes are desktop-only —
rows here open evidence, never a pause button"*, with *"role admin ·
write-capable on desktop. This device is read-only by design: it shows every
decision the desktop shows and executes none of them."* The card ceremony is
therefore desktop-only by design, and the operator's mobile route to the same
write is the Automation confirmation queue's Approve, which is operable at 390
and 320 px. At 320 px there is no horizontal overflow and every enabled control
now meets 44 px — two banner links measured 26 px and were given the target the
stage's own footer promises.

---

## Handoffs applied by the integrator

| From | What | Where |
|---|---|---|
| R3 | `beforeMutationAttempt` on the three create primitives | `lib/meta/launch-write.ts`, `lib/launchpad/meta-launch-execution.ts`, `lib/meta/launch-create-boundary.test.ts` |
| R4/R5 | multi-creative / multi-ad-set approval, contract v2 | `lib/meta/launch-activation-approval.ts` + writer route + panel + four suites |
| R4/R5 | `partial` / `coverage` on the operator activate response | `lib/meta/launch-activation-route-handlers.ts` |
| R4/R5 | receipt fixture matches what production writes | `scripts/ephemeral-postgres-launch-intent-seam-child.ts` |
| R1 | D086 audit accepts the second corrected exception | `scripts/audits/d086-budget-readiness-input-pack.test.ts` |
| R1 | D075 ledger and audit doc re-classified | `lib/meta/__tests__/state-history-consumer-closure.test.ts`, `docs/audits/D075_…md` |
| R1 | the clock-before-baseline defect, and the workaround removed | `lib/meta/budget-write-execution.ts`, `lib/meta/budget-proposal-server-readers.ts` |
| R1 | the missing upstream caller | `lib/meta/snapshot.ts` |
| R1 | required table + column assertion | `scripts/ephemeral-postgres-migrations-check.ts` |
| R2, R7, R4/R5 | three new seam children registered | `scripts/ephemeral-postgres-migrations-check.ts` |
| R6 | the registration comment matches what the child now proves | `scripts/ephemeral-postgres-migrations-check.ts` |
| R8 | the card-Apply gate, the re-stamp, the bid terminal answer, the History lineage | `lib/meta/bid-intent-contract.ts`, `recommendations.ts`, `rec-presentation.ts`, `snapshot.ts`, `entity-action-routes.ts` |

## Found while correcting

- **`creative null-versus-zero presence` seam.** Its `SET NOT NULL` is
  table-wide but its precondition cleared only its own business's rows. That
  held while nothing else in the gate wrote a NULL `link_clicks`, and stopped
  holding the moment another child seeded measurements through the production
  writer — which stores an unsupplied count as NULL, precisely the distinction
  that file exists to prove. The precondition is now as wide as the constraint.
- **A dev-mode prefetch loop.** `/platforms/meta?…&_rsc=` is prefetched,
  aborted and retried without bound while the Decision Center is open (thousands
  of requests within minutes), saturating `next dev` until the page renders an
  empty shell. Not investigated further; it is a dev observation, and a restart
  clears it.

## Round three — the five bounded Codex items, and the two flagged contradictions

Reviewed at `d1746f1df`. Six agents delivered, six **adversarial verifiers**
then re-drove each delivery, and six more agents repaired what the verifiers
proved wrong. Every regression below was found by a verifier, not by the agent
that wrote the code, which is the reason the verify pass exists.

### Item 1 — the automatic creative path · **COMPLETE**

`META_LAUNCHPAD_STAGED_AUTHORITY = {launchpad_decision_staged_v1, decision_staged_approval}`
is a second exact authority, not a wider one. The producer binds it in **every**
mode it stages under — not only `auto`, because an intent staged under
`semi_auto` and swept after a mode change would otherwise reach the unattended
arm carrying a confirmation nobody gave. That is the lie the previous round was
already storing, and it is gone. The create routes bind the STORED payload's
authority when a `launchIntentId` is present; re-binding the operator pair
recomputes a different fingerprint and dies as `launch_intent_contract_mismatch`
(verified, not assumed). `evaluateMetaLaunchpadManualAuthority` is unchanged: an
HTTP request must still present the operator pair and can never claim the staged
one. Only `manual` refuses now, by name.

Acceptance, in the registered seam child: under `auto` the producer stages under
its own authority, the real sweep creates one PAUSED ad **and** one PAUSED
test-launch hierarchy with no operator confirmation anywhere in the journal,
activation still waits for its own approval, a family taken off auto and a
missing or revoked approval each reach the provider with **zero writes**, and
the rerun duplicates neither an intent nor a provider entity.

Unattended **activation** remains operator-only, deliberately: turning a created
entity on needs `activation_approval_json`, which only the operator's approval
route writes. That is the plan's own S3.4 rule and Codex's instruction that
activation keeps its separate approval.

### Item 2 — the activation pre-POST boundary · **COMPLETE**, after one repair

The recheck now runs inside each resume primitive's own `beforeMutationAttempt`.
Three awaits used to stand between the last authority question and the POST —
`authorize`, then `journal.findUnresolved`, then `journal.claim` — and a
revocation inside any of them was ignored for exactly one write.

**The verifier caught a regression in the fix.** The new `contacted` flag
excluded `unresolved_prior_attempt`, and `contacted` is published as
`providerMutationAttempted`, which `budget-execution-lifecycle.ts:151` reads to
decide whether the row parks in `reconcile`. So a row whose earlier provider
outcome is *unknown* settled `failed` and **released the entity's action slot** —
the exact thing `META_AUTOMATION_PROPOSAL_OPEN_STATUSES` exists to prevent. The
repair publishes no value in that one case, so the lifecycle's `?? markerWritten`
fallback answers from the durable pre-POST marker; a comment at the reading end
now says the `??` is load-bearing, and the case is pinned through the **real**
claimed-execution lifecycle rather than the runtime's own return value.

### Item 3 — account-scoped measured calibration · **COMPLETE**, after two repairs

The measured half of the retained verdict was read at the pooled `account/*`
scope for a row keyed on one provider account, so a sibling's samples moved this
account's identity and could supply calibration it had no evidence for.

**The verifier caught two regressions in the fix**, both of them new paths from
"enough evidence" to a hold — the user's concern in miniature. (1) Funnel and
by-kind evidence became unconditionally EMPTY on every real account, because
those readers are precomputed-only and `calibration-job.ts` wrote only the
pooled scope; the agent's own probe had planted rows at both scopes, a state
production never has. (2) The identity became volatile against ordinary sync
writes, so a verdict retained at projection was withheld at approval as
`profile_not_retained` because the account's own sync ran in between.

Repaired by materialising one calibration scope per selected account beside the
pooled one, reporting a scoped miss as the named hold
`account_calibration_scope_not_materialised` instead of a silent zero, and
folding the duplicated AOV statement back into `computeMetaAttributedAov`.
Proved with rows planted only the way the shipped jobs write them.

### Item 4 — the mobile card Apply, and the History verb · **COMPLETE**, after four repairs

Codex was right that the queue is not an equivalent path: `bid-proposal-producer.ts:165`
returns `refusals: {bid_mode_manual: 1}` in manual mode, so in MANUAL there is no
queue row to approve at all and the card was the only route. The ceremony now
renders on the mobile stage from the same server-authorized component, one
truth and two renders, with surface-scoped DOM ids and the role restrictions
intact. Mounted at 390 px: card → `Apply · bid` → preflight → typed
**CHANGE BID** → the shipped route → `POST {bid_amount: "1320"}` at the double →
read-back → "Applied and verified". The same shared component through the
desktop pane at 1280 px. Both writes are in `meta_ads_action_log` as
`action = 'bid'` and both appear in History as `Bid | Broad prospecting` where
the shipped code titled them "Launch Adset".

Verifier repairs: a comment in shipped source cited a **test file that does not
exist** (every directory-qualified path in the owned files was then audited);
the DB test only ran the title expression, so the `INNER JOIN LATERAL` that
decides whether a bid row reaches the journal was covered by nothing, and now a
seam-guarded test executes the real `META_HISTORY_READ_SQL`; and the 44 px rule
was scoped by POSITION (`body > [role=dialog]`), which matched nothing once the
dialog portalled into `ZeroBasePortalHost` and matched unrelated overlays when
it did not — it is now scoped by identity.

### Item 5 — decision availability, measured · **COMPLETE**

24 cells: creative/bid/budget/pause modes × STOP × rehearsal × automation master,
facts held constant by cloning one seeded template database per cell, each cell
in its own process, driving the real producer → retained snapshot → served route
→ approval against `disableNetConnect()`. ROAS 2.20 is the only configured
target; the CPA benchmark is the store's observed AOV, 58.00 / 2.20 = 26.36.

**The invariant holds.** The served decision fingerprint, the retained snapshot
fingerprint and the CTA fingerprint are each a single value across all 24
postures. Only the queue and the dispatch move, each with a distinct code.

But four degradations were CONSTANT in every cell — the "everything becomes
generic extra review" symptom, measured. Three are fixed and the fourth was the
refusal envelope:

| Finding | Before | After |
|---|---|---|
| Action census could never report an executable row | `executableBid 0, reviewOnly 7` on the same request whose card carried `bidAmountMinor 1320` | `executableBid 1, reviewOnly 6` |
| Lane serve path could not see a published campaign role | `campaign_context_unresolved` × 96 row-observations | × 72 — the 24 removed are exactly the campaign that HAS a published role; the genuine one is unchanged |
| Commercial-anchor panel contradicted the card beside it | `blocked_missing_owner_anchor`, `spendUnit null`, `missingInputs ["target_cpa","operator_aov_assumption"]` — the two inputs the product declares optional | `eligible_observed_shopify_aov`, `26.36`, `missingInputs []`, byte-identical to the account's retained profile rows |
| One refusal envelope for six postures | every blocked posture answered `kill_switch_engaged` | each names itself; `isMetaWriteBlockedCode` is the single question the four sequence-halting callers ask |

All four fingerprints stayed single-valued afterwards, so the posture invariant
is untouched. No threshold was lowered and no guard removed — one guard was
*strengthened*: `observed_shopify_aov` was missing from `usesCommercialThreshold`
and alone escaped the target-pack provenance demotion. The durable record is
`docs/qa/decision-availability-matrix.md`.

### Check (a) — the same-day rerun contradiction · **SETTLED, and a real loss found**

Codex was right to flag it as a contradiction rather than a diagnosis. The
documentation was wrong about the delivery-stall/bid path: two runs on
byte-identical facts reproduce the same anomaly and the same 1320 intent, and
`projected: 0` on the second run is the **anti-duplicate guard** refusing a
second row for a slot that already holds one. The two DELETE statements the
guide taught are gone.

**But a real loss survived, in a family the first agent never looked at.** Three
of the seven detectors are not pure over the warehouse tables:
`pacing_failure`, `budget_exhausted_early` and `zero_conversions_with_spend`
read the wall clock and the profile. A `budget_exhausted_early` row written at
08:00 local was **resolved** on a 22:00 rerun with byte-identical facts, because
the detector's time gate returned `[]` and the writer read absence as recovery.
Two more instances of the same defect were found while fixing it: every
per-account recommendation-only write ran the blanket resolve, and a bare
`.catch(() => [])` around detection closed every open anomaly of the day
silently. Fixed by making each detector report whether it *evaluated* its
family, and scoping resolution to the families that actually looked. The time
gates are untouched — a pacing verdict at 02:00 is meaningless, and that is
correct for DETECTION.

### Check (b) — a proven window during an in-flight refresh · **COMPLETE**, after one repair

Success-only retained bounds (`latest_successful_sync_window_start` / `_end`)
now carry the proof, so an ordinary running pass no longer withholds a 28-day
window and its derived CPA benchmark. A 30-day webhook repair's expanded span is
still never borrowed, and a failed attempt still proves nothing.

**The verifier caught a deploy-day regression.** Every existing row has NULL
retained bounds and nothing backfilled them, so for the class of store whose
recent span is load-bearing the refusal moved from "while a sync is running" to
"until a sync runs" — strictly WIDER than the behaviour being fixed. An additive,
idempotent backfill now runs in the same migration, restating exactly the
pairing the previous release already accepted as proof, so it can grant no
coverage that release withheld. It invents nothing for a row whose last attempt
was running, had failed, or ended somewhere other than its own
`ready_through_date`. The false `orders_coverage_unproven` docstring is
corrected.

### Still open, and deliberately so

- **`orders_coverage_unproven` is a weaker name than `orders_coverage_gap`.** A
  store with a genuine permanent hole is named precisely when nothing is in
  flight and vaguely the moment any attempt is running. That is a definite
  finding degrading into a vaguer one — the user's concern — but narrowing it
  changes the refusal-naming rule, which is outside what was asked here. Pinned
  by three seam cases so it cannot drift unnoticed, and flagged for its own item.
- **A closed-day `budget_exhausted_early` row now stays open forever**, because
  that family can never be re-evaluated for a past date. Believed correct — the
  finding is a fact about that day — and harmless in the reader, which anchors
  on `MAX(snapshot_date)`. Stated because it is a behaviour change nobody asked
  for explicitly.
- **D077 artifact hash contract**, kept explicitly separate as instructed. It
  pins a sha256 per file in the cumulative release diff, now lists ~78 files
  from this delivery, and is regenerated at release time.

## Gates

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | 0 |
| `npm run lint` | 0 |
| `scripts/verify-whitespace.sh` | PASS |
| `npx vitest run` (full) | **17,448 passed**, 2 failed — both D077, out of scope |
| `npm run test:migrations-from-zero` | **PASS**, exit 0, including the three newly registered seam children |
| Mounted browser acceptance | Decision card Apply → provider double → History, at 1512 px; STOP refusal; 320 px accessibility |

The two D077 cases are the artifact-hash contract, failing since before this
work. One of them now also lists this delivery's own new files, which is what
that contract does: it pins a sha256 per file in the cumulative release diff and
is regenerated at release time. §7 of the plan puts D077/D086 evidence-pack
maintenance out of scope.

## Explicitly unresolved

1. **A bid write is journalled as `action: "launch_adset"`** with
   `payload_request.operation = "apply_bid"`. History and the client feed
   disambiguate it, and the mounted receipt above reads "Launch Adset" for a bid.
   Flagged in the previous report, unchanged here, and outside the eight
   findings.
2. **D077 artifact hash contract** — failing since before this work, and §7 of
   the plan puts D077/D086 evidence-pack maintenance out of scope. It must be
   regenerated before release.
