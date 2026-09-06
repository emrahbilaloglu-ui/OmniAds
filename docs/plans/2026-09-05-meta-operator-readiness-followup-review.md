# Independent follow-up review of Claude's remaining-items delivery

Reviewed HEAD: `fbb275acb`. Delta: `bf51bdabe..fbb275acb`.
Authoritative scope: the existing S1–S4 plan and its appendix; this is a correction list, not a replacement plan.

**Verdict: incomplete; local implementation acceptance is not granted.** The new queue executors, mobile controls, production economics fixture, and durable native projection retry are substantive improvements. The remaining defects below affect the required production paths and acceptance criteria. D077 evidence-pack maintenance remains outside this correction task.

## R1 — P1: Budget proposals still require an absent runtime dependency

`lib/meta/budget-proposal-source-loader.ts:208–211` unconditionally reads `D086_PROFILE_LATEST_SQL`, whose table is `engine_v3_account_profile_output`. The normal migration registry does not create it; prepared DDL exists only in `lib/meta/budget-readiness-retention.ts:1440`. A missing-table error becomes null, and `lib/meta/budget-proposal-producer.ts:240–241` refuses the candidate with `composition_sources_unavailable`. Execution refresh uses the same missing dependency in `lib/meta/budget-proposal-server-readers.ts:510–514`.

The new `scripts/ephemeral-postgres-economics-bid-chain-seam-child.ts:864–895` explicitly expects one budget candidate and **zero projected rows**. This demonstrates working sizing and a blocked queue path. It is not positive acceptance of budget production/execution on the shipped schema.

Complete the required runtime dependency through registered migrations and a real retained-profile producer/reader contract, or use an already authoritative retained source that satisfies the same contract. Do not remove commercial eligibility checks or fabricate profile rows. Evidence-pack maintenance being excluded does not exclude a dependency necessary for the approved budget feature.

Acceptance: a migrated isolated DB with genuine eligible source fixtures runs the real snapshot, projects at least one budget proposal, and executes it through approval and scheduled paths against a provider double with durable readback receipts. The unavailable-source negative case remains a separate rejection test.

## R2 — P1: No decision-to-staged-launch producer

`lib/meta/launch-proposal-producer.ts:81–89` selects prepared, unstarted intents carrying decision/snapshot/brief lineage. The code has execution-time intent creation and an operator intent API, but no decision producer stages the required intent for this queue. Claude acknowledges this in the remaining-items report's second open item.

Finish decision → approved asset/copy/destination → staged intent → queue → executor → separate activation. Only use already approved inputs and exact targets; missing approval remains a named blocker. Do not claim a complete creative operation matrix while its first production caller is absent.

Acceptance: start from an eligible production decision fixture, not a manually inserted queue row or finished intent, and observe the persisted intent, proposal, provider-double creation receipt and separately authorized activation receipt. Reruns must not duplicate intents or provider entities.

## R3 — P1: Scheduled create rechecks authority only before the sequence

`lib/meta/scheduled-launch-runtime.ts:346–380` constructs the late scheduled authority/rehearsal check. However, `lib/launchpad/meta-launch-execution.ts:412–415` calls it once before the whole sequence; later `createAdSet` and `createAd` calls at `:541` and `:636` do not repeat it. The add-to-existing multi-create path needs the same audit.

The primitive's `getMetaAdsWriteBlockFailure` still checks hard blocks and account credentials, so this finding does not claim STOP has no effect. The missing checks are the current scheduled mode/enablement/control version and rehearsal posture for every subsequent create. A campaign can be created, automatic authority disabled or rehearsal enabled, and later entities still created.

Acceptance: drive the real shared create runtime with a provider double. After the first successful create, change scheduled mode, enablement/control version, rehearsal or the Launchpad gate. Every remaining provider POST must be withheld; partial identities and the reason must remain durable. Put the check at each actual provider boundary, not just in a test wrapper or one outer callback.

## R4 — P1: Revoked activation approval remains usable within an in-flight sequence

`lib/meta/launch-intent-activation.ts:181–201` validates `intent.activationApproval` once from the originally loaded intent. The per-step hook in `lib/meta/scheduled-activation-runtime.ts:205–232` rereads gates/mode/posture but not the persisted approval or current intent fingerprint. Meanwhile the operator route can persist revocation at `app/api/launchpad/meta/intents/[id]/activation-approval/route.ts:122–136`.

Re-read and validate the current bound approval before every scheduled activation POST: revocation, expiry, payload fingerprint, scope, assets/destination and policy version must remain valid at that step.

Acceptance: revoke the approval after the campaign step succeeds; no later adset/ad POST occurs. Repeat with expiry and a changed binding. Preserve completed-step receipts and the explicit blocked step.

## R5 — P1: Activation silently drops additional adsets and ads

`activationPlanForIntent` takes only `adsetIds[0]` and `adIds[0]` (`lib/meta/launch-intent-activation.ts:140–144`). `activateHierarchy` also uses `find` once per grain (`lib/meta/hierarchy-activation.ts:146–148`). The launch create runtime supports multiple adsets and creatives.

Independent execution of the real hierarchy function with injected in-memory provider operations:

```text
requested: [c1, s1, s2, a1, a2]
called:    [c1, s1, a1]
delivering: true
unvisited: [s2, a2]
```

Represent and process the complete approved identity set with parent dependencies, one durable receipt per entity and stable idempotency. An add-to-existing operation must still never activate an unapproved existing parent. Delivery success must cover every intended entity; partial launch/activation must be labelled honestly.

Acceptance: multiple adsets and multiple ads, a mid-sequence failure, and a retry that resumes only unfinished authorized entities. The final receipt must account for all identities.

## R6 — P1: An unsuccessful expanded Shopify sync can falsely prove coverage

`lib/creative-decision-engine/shopify-aov-source.ts:377–381` assumes recent-window starts only advance, then combines `latestSyncWindowStart` with the old `readyThroughDate` at `:399–400`. In fact webhook repair expands recent windows up to 30 days (`lib/shopify/webhooks.ts:183–191`). Running and failed attempts replace the start (`lib/sync/shopify-sync.ts:379–389`), while `lib/shopify/sync-state.ts:201–207` preserves the earlier successful end/time.

Trigger: seven-day successful sync, followed by a running/failed thirty-day repair, with no historical coverage. The reader combines the new unproven start and old successful end. Independent execution of `proveShopifyOrderWindowCovered` on that persisted-state shape returned `{"covered":true}` for the 28-day window.

Use matching successful window bounds/receipts, or conservatively withhold when current retained state cannot prove them. Checking an unrelated successful timestamp is insufficient; do not lose the valid freshly synced store with no recent sales case.

Acceptance through the real sync-state writer and AOV reader: seven-day success → thirty-day running/failed must not establish 28-day coverage; a genuinely completed thirty-day sync does.

## R7 — P2: A failed partial retry overwrites another account's successful slot

`lib/meta/scheduled.ts:345–352` handles a rejected business run by marking every required account failed, even those excluded from this attempt because they already succeeded.

Trigger: A succeeded, B+C failed → retry only B+C → shared calibration/backfill/epilogue throws → A's successful slot is overwritten as failed → next tick regenerates A.

Pass the actual attempted account set into outcome recording and preserve A. Acceptance must cover this rejected-whole-business case, not only per-account fulfilled results.

## R8 — P2: Decision Card Apply remains unproven in the mounted application

Claude's report explicitly says no populated Decision Center lane was rendered in the browser. The new SQL seam verifies hydration, key derivation and an extracted target lookup, but does not mount the real page or drive its real preflight/dispatch to a provider-double receipt. The fixture-depth explanation is a hypothesis; it does not establish that the product route works.

Persist a repeatable local fixture/harness that publishes sufficient authoritative data through the normal readers and produces a real visible decision card. Drive Apply → confirmation → real route → provider double → readback → durable receipt/History at 1280 and 390 px, plus 320 px accessibility. Keep STOP, reviewer and missing-evidence negative cases. Fix actual route/read/render blockers discovered during this work; do not weaken serving guards or substitute a static component render for the mounted application.

## Independent verification in this review

- Nine focused Vitest files passed: **138 tests**, covering launch queue/manual dispatch, scheduled launch/activation, lineage routing, Shopify coverage, native projection recovery, partial snapshot retries, activation UI and mutation ceremony. Database URL was process-overridden to an unused loopback port; selected tests use mocks/injected dependencies. No live database or provider was used.
- Two additional in-process calls to the shipped pure functions reproduced R5 and R6 as shown above. These are synthetic reproductions, not real provider outcomes.
- Other findings are grounded in production caller/SQL/control-flow inspection. Claude's full suite, typecheck/lint and migration gate were not independently rerun in full here.
- No application source was changed. Only this review artifact was added. No prompt was sent to Claude during this review, and no push/merge/deploy/provider mutation was performed.

Suggested correction order: R3/R4/R5 authority and complete activation; R1/R2 reachable producers and dependencies; R6/R7 retained evidence and retry correctness; R8 integrated mounted acceptance. Parallel work may follow non-overlapping file ownership, with one integrator and a maximum of 20 agents total.
