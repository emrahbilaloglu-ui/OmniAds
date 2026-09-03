# Meta Decision System — Codex × Claude Reconciled Audit

**Date:** 2026-08-29  
**Scope:** Meta only; IwaStore, Grandmix, Bilsem Zeka, TheSwaf, IwaTR, ColorFullWorldsTR  
**Evidence:** production database read-only, current repository source, authenticated production/local UI  
**Repository freeze:** `main@babf158e150fd33057117b39b175da044ac62d2e`  
**Media-buyer skill binding (both auditors):** `/Users/harmelek/.codex/skills/emb-media-buyer/SKILL.md`, SHA-256 `985754567f2ac07e3623d4bc91ce16b0421ac9e3295f3e842248305ec3cbd187`

Claude's recorded hashes for the 18 task-relevant skill references were rechecked against the current on-disk files after reconciliation; every hash still matches byte-for-byte.

## Final verdict

**Adsecute cannot currently replace Meta Ads Manager and no live Meta action is safe for unattended automation.** The persisted exact-Ad decision rows are structurally consistent and selected calculations reproduce, but the operating system around them is admission-blocked, stale, incomplete and unable to learn from its own actions.

The current six-business state is:

- 14 hard actions are persisted in latest account generations.
- four TheSwaf cuts are presented as actionable in the selected-account UI.
- **zero are executable at the write boundary now**: their decisions are approximately 168 hours old and the immutable preflight maximum is 12 hours.
- the UI currently enables Cut while the server will return `decision_stale`.
- no native decision-origin provider write has ever completed.
- the native outcome table has zero rows; recent outcome jobs fail on database timeouts.
- controlled-causal experiment registries are empty.
- only pause/resume have a provider-write path; budget, bid, refresh, allocation and launch automation are absent or deliberately manual/paused-first.

Full auto must remain off. The first implementation goal is not broader execution; it is one truthful execution-readiness contract and visible operational health.

## What the two independent audits agreed on

### Persisted decision quality

The native exact-Ad rows pass the audited structural invariants: no blocker coexists with an authorized action, no duplicate exact identity key was found, evaluation linkage exists, and sampled Cut/Scale arithmetic reproduces from persisted facts within cutoff-window tolerance.

That proves internal consistency only. It does **not** prove:

- incremental profit;
- precision or regret of hard actions;
- marginal return from scaling;
- calibration by business/account/goal;
- safe stale-decision serving;
- controlled causal lift;
- commercial completeness.

The phrase “the decision core is sound” is therefore rejected as too broad. The defensible statement is: **persisted native exact-Ad rows satisfy the audited structural invariants and selected arithmetic reproductions.**

### Data and operations

- `meta_ad_daily`, `meta_adset_daily` and account facts finalize only through 2026-08-21; decision generations stop on 2026-08-22.
- No `meta_sync_runs` or new engine chain appears after the 2026-08-22 tail, while the Meta durable worker continues to heartbeat current and idle on 2026-08-29.
- A later same-day host read disproved the initial scheduler-outage conclusion: root cron still invokes `/api/sync/cron` every ten minutes. The 2026-08-29 16:10 UTC invocation returned HTTP 503, and web logs show `sync_cron_tick` refused before work because `meta_entity_state_history` exceeded its table budget. Database silence therefore records admission refusal, not absence of scheduler invocation.
- `meta_entity_state_history` occupies `5,368,750,080` bytes against a five-GiB limit of `5,368,709,120`: the growth fence refusal condition is presently true.
- The relation contains about 2.68 GB of heap and 2.68 GB of indexes. It persisted 45,968 to 160,335 state rows per observed day in the final week, disproving the prior code comment's approximately 200-row/day premise. Raising the ceiling alone is not a durable recovery.
- Latest native outcome jobs fail at a 30-second query timeout; native outcomes remain zero.
- Operator-response jobs also fail on a production schema query for nonexistent `business_ref_id`.
- No calibration profile exists for any of the six businesses.

### Execution and governance

- Proposal execution supports campaign/ad-set pause/resume only after confirmation.
- Exact-Ad Cut uses a separate approval ceremony and provider preflight.
- Rules propose or block; they do not write.
- Launchpad creates paused drafts and does not close the operating loop.
- IwaStore is persisted kill-switched, dry-run/manual, capped at three actions/day and +15%, with an EUR action ceiling on a USD account.
- The Decisions workspace reads only the environment kill switch and can show false while the business control plane is engaged.
- The other five businesses have no persisted automation-control row and inherit defaults. Missing governance cannot support any write-authority claim.

## Disputes resolved by cross-review

### Actionable versus executable

Use three separate counts:

1. **Persisted-authorized:** an immutable engine row carries an authorized action.
2. **Presentation-actionable:** the served read model offers an action control.
3. **Execution-preflight-executable:** the write-time preflight has passed current provider, policy, hierarchy, governance, identity, idempotency and freshness checks.

For the audited state the counts are 14 / 4 / **0**. The original Claude phrase “four actionable/executable” is retracted.

### TheSwaf second account

`act_921275999286619` has `is_selected=false`; the assignment resolver intentionally filters to selected rows. Its 403 is contract-correct.

The actual defect is producer/serving incoherence: the deselected account continued to spend roughly $1k in the final observed week and received nightly syncs, 126-row decision generations and two authorized cuts, while no current read surface can serve it. Product policy must choose one coherent state:

- producers skip deselected accounts; or
- multi-account serving is supported and selection becomes an explicit operator scope.

### Active-ad counts

The reports counted different populations: Ad-level ACTIVE inventory, full hierarchy ACTIVE, latest-generation decision-joined inventory and served exact-Ad queue. Future counts must always state source, account set, `is_selected` rule, status predicate, observation cutoff and generation as-of. No material conclusion depends on the residual count deltas.

### Mixed freshness clocks

The current screen combines four clocks:

- warehouse/latest successful sync;
- native exact-Ad generation and computed-at;
- recommendation-lane snapshot age;
- current provider-state observation age.

The `Stale · 68h old` TheSwaf tile is the recommendation-lane snapshot. The enabled Cut rows are based on approximately 168-hour-old native decisions. Grandmix's observed `178.16h` was the same recommendation field on a different business. One lane's clock must never label another lane's action.

### Grandmix invalid manifest

The growth fence is a verified present incident but did **not** cause Grandmix's 2026-08-22 receipt; writes continued that day. Cross-review found a stronger timestamp-proven mechanism:

- last Grandmix decision job finished 2026-08-22 14:51:07 UTC;
- the day's only complete Grandmix Ad observation run finished 14:53:48 UTC;
- the complete source therefore arrived 2m41s after the decision job;
- the losing observation-after-decision order repeats on most recent sampled days.

The receipt `complete_source_run_missing`, expected count zero and invalid manifest follow from an observation/decision ordering race. Fix the ordering or trigger a post-completion decision rerun; retain the fence as a separate P0.

### Production React #310

Codex observed the production application crash after IwaStore → TheSwaf on Decisions. Both auditors could switch locally without the crash. The production blocker is verified; root cause, deployed SHA and component stack remain unknown. Do not infer that current local HEAD is proven safe.

## Six-business decision implications

| Business | Material decision fact | Operating implication |
|---|---|---|
| IwaStore | 52.8% of final observed spend is under held Scale/campaign-context rows; zero-cost legacy model; business kill switch engaged | resolve context authority and economics; no write can be offered |
| Grandmix | five hard rows exist but native serving is invalid; observation/decision ordering race; legacy Scale outcomes 9 negative / 2 positive / 1 neutral | repair source ordering and prove seven valid waves before trusting hard rows |
| Bilsem Zeka | 23% of final observed spend is purchase-engine out-of-scope; material Conversations/Lead/ThruPlay history | add calibrated per-goal lanes or explicit operator-acknowledged out-of-scope policy |
| TheSwaf | four selected-account cuts are served but stale; second spending account is deselected yet still produced | freshness must block CTA; resolve multi-account policy |
| IwaTR | no target pack; no commercial action authority | configure and reconcile target/cost truth before hard actions |
| ColorFullWorldsTR | sparse active inventory, missing cost model and calibration | review-only until economics and outcomes are proven |

Spend shares use Claude's explicit final-observed-week join and per-account currencies. They must not be summed across currencies or relabeled current 2026-08-29 spend.

## Reconciled execution-readiness contract

The read model must answer four independent questions for every row:

1. **Verdict:** Scale/Cut/Keep/Diagnose/Test More/Out of Scope.
2. **Evidence readiness:** complete/partial/blocked, with source cutoff and missing fields.
3. **Execution readiness:** deterministic server-local state; never inferred by UI.
4. **Last provider outcome:** verified applied/unchanged/refused/unknown/reconciliation-required.

`sourceAuthority.actionEligible` represents persisted decision-side authorization only. A new server-owned `executionReadiness` is the only mutation-CTA gate. It may express:

- `decision_not_authorized`;
- `stale_decision`;
- `engine_version_drift`;
- `kill_switched`;
- `governance_unavailable`;
- `live_preflight_required`.

There is intentionally no read-model `executable_now` state. A page render cannot carry a current provider GET to submit time. The maximum truthful promise is: **all deterministic local gates pass; submit will run the exact live preflight.**

The UI may render a mutation CTA only for `live_preflight_required`, must state that a live preflight runs on submit, and must render every other state as review-only. A stale/future/unparsable decision never receives an enabled mutation CTA.

## P0 implementation order

Two lanes proceed in parallel.

### Local code lane

1. Share the 12-hour decision-freshness evaluator between the read model and execution preflight; fail closed for stale, future or unparsable timestamps.
2. Serve `executionReadiness`, exact decision computed-at/age/max-age and blocker reason from the server; gate every mutation CTA on it.
3. Separate recommendation snapshot, native decision, warehouse and provider-state clocks in UI copy and evidence drawers.
4. Serve effective global + business governance truth; a missing/unreadable control row blocks writes but not decision reading.
5. Surface sync absence, warehouse cutoff, manifest validity and fence refusal as separate health dimensions; none may aggregate to Healthy while stale/invalid.
6. Clarify selected versus historical/deselected spending accounts.
7. Add a business-switch regression covering native, degraded fallback, loading and error payload shapes.

### Operational/data lane

1. Preserve the verified host cron and make its repeated 503 admission refusal visible as a source-health incident; do not treat an empty job tail as proof that invocation stopped.
2. Decide and execute evidence-safe compaction/retention plus a re-baselined table budget; recover at least six months of measured headroom without relying on a silent ceiling raise.
3. Fix observation-before-decision ordering or enqueue a decision rerun after complete observation.
4. Optimize/batch outcome accrual and fix the operator-response schema query; backfill outcomes.
5. Capture the deployed build and reproduce React #310 with sourcemaps.

No production mutation, retention deletion, cron repair, deploy or Meta write is authorized by this document.

## Acceptance gates before supervised execution

- Stale/future/unparsable decision fixtures are review-only, with no mutation CTA.
- Fresh decision-side authority reaches `live_preflight_required`, never `executable_now`.
- IwaStore with env switch off and business switch on is engaged on every surface and write boundary.
- Missing control row blocks writes explicitly.
- Recommendation age cannot label native action age.
- Seven consecutive Grandmix waves are manifest-valid and served `native_ad`.
- Fourteen consecutive outcome/operator-response runs are green and outcome coverage is published.
- At least 20 supervised decision-origin actions have complete intent → provider read → write → read-back → immutable receipt → rollback lineage, with zero unresolved ambiguity.
- Controlled-causal registries are populated and observational summaries remain labeled observational.
- Production business-switch regression is green and no React #310 is observed for seven days.

## Gates before unattended automation

- 30 consecutive natural scheduler waves across all assigned accounts with absence alarms.
- Every assigned spending account has complete native serving and explicit goal coverage.
- Commercial targets and break-even are reconciled to cost/commerce truth.
- T+7/T+14 native outcomes cover at least 90% of hard decisions.
- Decision precision, calibration, regret and holdout lift are published with denominators.
- Budget/bid contracts have immutable scope, caps, live verification, receipts and rollback.
- Per-business action caps, budget-delta caps, quiet hours, spend ceilings and currency are persisted and verified.
- Provider read-back, reconciliation and kill-switch drills pass.

Until every gate is evidenced, full-auto remains off and Adsecute remains a review/supervised-control surface rather than the sole Meta operating console.

## Remaining unknowns

- exact compaction/retention contract for `meta_entity_state_history`, including foreign-key-protected rows and physical-space reclamation;
- production build/component causing React #310;
- intent for TheSwaf NonTesvik account selection;
- Bilsem non-purchase optimization contract;
- account attribution-window/model drift;
- outcome-job performance after production-scale optimization;
- seven-/thirty-day natural-wave proof after recovery.

## No-mutation attestation

The analytical evidence queries and local UI data path were read-only. No Meta/provider write, ad change, deployment, migration, retention deletion, scheduler change, commit, push or PR was performed. The only database mutations were the explicitly temporary local-QA authentication records: one user, one session and six memberships were created, then removed after QA; verified remaining counts are zero for all three.

## Local fail-closed implementation completed — not deployed

The reconciled P0 contract has been implemented locally from the frozen repository base. This is a safety slice, not an operational recovery and not authorization to turn automation on.

- A shared 12-hour exact-decision freshness evaluator now fails closed for stale, future, missing or unparsable timestamps and is reused by the read model and provider-write preflight.
- The server now owns `executionReadiness`; persisted `actionEligible` remains decision-side authorization only. There is no `executable_now` read-model state.
- Effective global and business governance is read once per workspace request. Missing or unreadable persisted business controls keep decisions readable but block every write.
- Decision Center, briefing, native pause and Launchpad handoff consumers require `live_preflight_required`; stale or governance-blocked rows render review-only.
- The UI distinguishes recommendation-snapshot age from exact-decision computed-at/freshness and exposes execution readiness in the evidence drawer.
- ADR D072, data-readiness notes, invariants and golden cases AR-011 through AR-014 record the compatibility and rollback contract.

Local verification:

- TypeScript: `tsc --noEmit` passed.
- ESLint: every changed TypeScript/TSX file passed.
- Changed-test set: 474 passed, 53 intentionally skipped across 17 files.
- Briefing/Launchpad regression set: 295 passed, 53 intentionally skipped across 23 files.
- Decision payload coverage matrix: 35/35 passed with one worker.
- Real TheSwaf local UI: separate stale-decision and missing-governance alerts rendered; the four persisted-authorized Cut rows became blocked `Refresh Decision` rows; the evidence drawer showed exact decision computed-at, `Stale · 168.72h old · max 12h`, `Execution readiness: Stale decision`, and a disabled action. No enabled Cut/Pause action was present and the browser console contained no error after a clean server restart.

The read-only UI server was stopped after QA. Operational/data P0s, production React #310, deploy and every Meta/provider mutation remain unresolved and out of this local implementation's proof boundary.

## Storage P0 and manual-label removal — local implementation record (2026-08-29, second slice)

This section records the second local slice: the exact database-growth
diagnosis, the D074 manual-label removal, the storage-lane corrections, and
what remains blocked. Labels: **[fact]** directly measured/read, **[inference]**
best-supported explanation with the discriminator named, **[assumption]**
planning input, **[unknown]** not provable from available evidence.

### Exact DB growth diagnosis

- **[fact]** `meta_entity_state_history` = 5,368,750,080 bytes / 4,239,764
  rows against the 5 GiB fence budget (5,368,709,120); refusal condition
  `bytes >= budget` is true. Heap ≈ 2.68 GB, indexes ≈ 2.68 GB.
- **[fact]** The table absorbed 45,968–160,335 rows/day in the final observed
  week — repeated FULL observation manifests, not deltas. Host cron still
  invokes `/api/sync/cron` every 10 minutes; the 2026-08-29 16:10 UTC tick
  returned HTTP 503 with `sync_cron_tick` refused on this table's budget, so
  the "silent stop" records admission refusal, not a dead scheduler.
- **[fact]** Two rewrite mechanisms were reproduced against real Postgres:
  (1) a `complete → failed/partial → same complete` sequence rewrote a
  byte-identical payload because the heartbeat lookup mixed completeness
  lanes; (2) a 1,042-ad complete scope rewrote every row when only 1–4
  entities actually changed, because manifests are whole-scope, not
  per-entity deltas.
- **[inference]** Mechanism (1) plus the per-day full-manifest design explains
  the measured write volume; the discriminator (lane-scoped coalescing under
  the seam harness) now passes and is asserted.

### What this slice changed locally (all verified by the harness below)

Storage lane (mechanism 1) — corrected and regression-locked:

- Same-completeness heartbeat lookup (`lib/meta/entity-state-history.ts`),
  `last_captured_at` column + migration + verification spec, and a heartbeat
  that is a single-row run UPDATE (zero state-row writes).
- Reviewed defects found in the in-flight change and fixed in this slice:
  - the hydration receipt consumed the heartbeat clock as its payload capture
    floor, so the FIRST coalesce would have filtered out every manifest state
    row and thrown `manifest/state mismatch` for the whole account (delayed
    onset; e.g. `expected 1042, resolved 0`). The receipt now carries
    `sourcePayloadCapturedAt` (the run's original capture time) and hydration
    floors on it (`lib/creative-decision-engine/data-source.ts`).
  - the exact-`source_run_id` manifest membership silently killed the
    tombstone arm (tombstones live in their own `point_lookup` runs), freezing
    deleted ads into the manifest forever. Tombstone membership is now
    identity-scoped and floored by the run's effective capture clock, which
    also preserves the "pre-generation tombstone must not censor a re-observed
    ad" contract.
  - the `ON CONFLICT (run_hash)` replay path could move `last_seen_at` /
    `last_captured_at` backwards; both are now `GREATEST`-guarded.
  - the freshness pair could invert on transitional rows (advanced
    `last_seen_at`, null `last_captured_at`); the receipt clamps with
    `LEAST()` so observed can never exceed captured.
  - a lane-aware index
    (`idx_meta_entity_observation_runs_lane_latest`, with contract assertion)
    backs the new lane-scoped `FOR UPDATE` lookup.
- New regression legs in the real-Postgres seam
  (`ephemeral-postgres-entity-state-history-seam-child.ts`): complete→failed→
  same-complete coalesces into the original run; the heartbeat advances BOTH
  clocks (asserted values); a payload change first seen while degraded still
  appends on the complete lane. The native-ad seam
  (`ephemeral-postgres-native-ad-decision-seam.ts`) again proves capture-axis
  receipts, the 501-row generation-bound hydration, and tombstone shrinkage.

Ordering/rerun (Grandmix race):

- **[fact]** The native chain has no observation→decision ordering; the gate is
  time-only (03:00 UTC slot). What the worktree already implements is a
  deterministic same-day RERUN: `readSuccessfulNativeJobs` refuses to reuse a
  decisions success whose hydration receipts are not authoritative
  (`hydrated = expected`, hash-equal, source/hydration complete), so a
  pre-observation run cannot suppress the later rerun and the chain retries
  every 10-minute tick until a complete manifest exists.
- **[fact]** Before this slice's fix, that loop could not converge after a
  heartbeat coalesce (hydration threw instead of reporting non-authoritative).
  With the payload-clock fix it converges; this is the smallest safe local
  ordering fix, and no production scheduler was touched.

Manual-label removal (D074) — completed in live runtime and UI:

- Contract renamed (`campaignRoleCoverage` / `classifiedCampaigns` /
  `unresolvedCampaigns`) across pulse, workspace, adapters, widgets, and the
  dev fixture; the label route is a 410 tombstone; the management component is
  deleted; the last buyer-facing "label is missing" string now reads
  "The automatic campaign role is unresolved"; orphaned copy keys (EN+TR)
  removed; `label_needed` union members carry `@deprecated`; the
  Commercial-Truth footnote no longer instructs a labeling action.
- Role identity is account-scoped (`business + provider account + campaign +
  as-of`), with a partial unique index and account-scoped hysteresis keys;
  missing account scope returns no roles (fail-closed). High trust requires
  high confidence AND the exact resolver-version env gate, which stays unset.
- `lib/meta/campaign-labels.ts` is a frozen, **SELECT-only** historical
  comparator module: the manual write implementation
  (`writeMetaCampaignLabels`, its normalization and transaction/assignment
  code) is **removed from the repository**, not merely unreachable. The
  static isolation guard
  (`lib/meta/__tests__/campaign-labels-isolation.test.ts`) proves zero live
  imports, zero live SQL references outside schema history, no writer export
  anywhere under app/components/lib, no `runDbTransaction` import in the
  module, and no mutation SQL against either label table; the entity-state
  seam seeds its frozen label fixtures with seam-local ephemeral-DB SQL
  instead of a product write path, and `decisions-job.ts` no longer imports
  the legacy label-map helper (zero live call sites). Manual-label types are
  `@deprecated`. The production tables are NOT dropped (frozen evidence;
  destructive drop is out of scope for this slice).
- Evaluation lanes intentionally keep historical vocabulary: the H11
  simulation module and replay scripts still read `meta_campaign_labels` as a
  comparator — that is their contract, not a runtime path.

Seam-harness compatibility fixes required by the worktree's own D072 gate
(fail-closed missing controls): the manual-ad-status route seam and the
duplicate-ad reconciliation seam now persist an explicit open
`meta_automation_business_controls` row for their fixture businesses, and the
hysteresis seam passes the new 16-parameter account-scoped context upsert.

### Test evidence (this slice, single-worker)

- `npm run test:migrations-from-zero` (ephemeral Postgres, migrations from
  zero + every DB seam child): **green end-to-end, 28 PASS banners, exit 0** —
  after three real failures were fixed forward (missing controls rows in two
  seam fixtures; 15-vs-16 parameter context upsert in the hysteresis seam).
- `ephemeral-postgres-native-ad-decision-seam.ts` standalone: PASS (was red on
  schema drift + a 500/501 manifest regression before the payload-clock and
  tombstone-membership fixes).
- Focused vitest (each run `--maxWorkers=1`): campaign-context
  source/data/hysteresis 23 passed; guard + execution-safety + pipeline-health
  54 passed; decisions/calibration/operator-response/ad-grain jobs 36 passed +
  30 DB-gated skips; workspace read model / OS presentation / preflight /
  native-pause / control-plane 160 passed (the native-pause file was red in
  the inherited worktree — its zero-blocker fixture now simulates the D074
  resolver-authority act explicitly and passes 29/29); ad-grain SQL contract
  30 passed; isolation guard 3 passed at that point (5 after the write-removal
  correction below); intelligence window interaction 8
  passed after dead-mock removal.
- Write-removal correction (SELECT-only comparator module): the strengthened
  isolation guard now has 5 tests; the scoped correction suite —
  `campaign-labels.test.ts`, the isolation guard, `decisions-job.test.ts`, and
  both campaign-label-guard test files — verified at 5 files, 43 passed /
  14 skipped (DB-gated), 0 failed; the migrations-from-zero harness re-ran
  green (28 PASS, exit 0) after the seam's fixture SQL change.

### Remaining blockers (not hidden by this slice)

- **[fact→blocker]** Mechanism (2) — whole-scope manifests — is NOT durably
  solved by lane-aware coalescing: any real 1-of-N entity change still
  rewrites the full N-row manifest. A durable storage architecture needs
  content-addressed / per-entity delta state (per-entity change detection with
  a manifest that references unchanged rows instead of rewriting them). That
  is a larger ADR + migration with hydration-contract impact and is
  deliberately NOT attempted here. *(Superseded the same day: implemented as
  D075 delta-bounded manifests — see the "D075" section at the end of this
  document.)*
- **[fact→blocker]** The fence remains breached in production; retention /
  compaction / re-budgeting of `meta_entity_state_history` is an operator
  decision on production data and out of local scope. Nothing in this slice
  raises the fence.
- **[unknown]** Whether coalescing + the heartbeat lane reduces production
  write volume enough to live inside a corrected budget — measurable only
  after deploy + fence recovery, from real per-day row counts.
- **[fact]** The H11 authority gate remains failed (`REJECT`, high-confidence
  agreement 63.64%, selected P1 72.73%, historical Test recall 0/12); the
  account-scoped comparator subset (9/10 high-confidence, 2/2 active Test,
  0 false Test) is small and uneven. Validation has NOT passed;
  `CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION` stays unset.
- **[assumption]** Production tables `meta_campaign_labels` /
  `meta_campaign_label_history` remain as frozen evidence; dropping them later
  requires its own migration ADR with backup/retention terms.

### Why automation is still OFF

Nothing in this slice grants execution authority: the resolver-version gate is
unset (all inferred roles cap at medium trust; every context-dependent hard
action stays review-only), the controlled-causal registries are still empty
(D048), native outcomes are still zero pending the operational lane,
per-business automation controls remain manual/dry-run (and absent rows now
fail closed at the write boundary), and the fence still refuses ingestion in
production. This slice makes the system *enable-ready* — fail-closed
contracts, regression tests, and documented gates — while enabling anything
remains a separate, explicit operator decision that no local change performs.


---

## D075: delta-bounded manifests (implementation record, 2026-08-29)

This section records the D075 slice that closes the whole-scope
write-amplification blocker flagged above. ADR: `DECISION_LOG.md` § D075;
invariants: `INVARIANTS.md` (D075 block); readiness note:
`DATA_READINESS.md`.

### What changed (facts — exact files)

- `lib/meta/entity-state-history.ts` — the complete-lane write path now
  diffs the incoming payload against the reconstructed baseline (latest
  complete-lane row per entity, **endpoint-scoped**, joined through the
  run table) and persists only changed + new rows, one
  `absent_unconfirmed` row per scope exit, and ads carried for the
  creative-lineage FK; first-complete stays a full manifest; non-complete
  lanes are untouched. The run insert carries `manifest_kind`,
  `base_run_id`, `delta_stats_json`; the persist result returns
  `manifestKind` and `deltaStats`. The coalesced-path lineage now resolves
  the rows the kept run actually holds (`lineageStatesForRun`).
- `lib/migrations.ts` + `lib/migration-verification.ts` — three additive
  nullable columns on `meta_entity_observation_runs` (`manifest_kind` with
  CHECK `full|delta`, `base_run_id` uuid, `delta_stats_json` jsonb), with
  matching column-spec verification. No CHECK change on
  `meta_entity_state_history`: `absent_unconfirmed` already existed.
- `lib/creative-decision-engine/data-source.ts` — the hydration receipt
  query gains a `member_states` CTE: legacy/full membership stays exactly
  `state.run_id = run.source_run_id`; delta membership is the
  reconstructed complete lane (latest per entity at or before the run's
  payload capture clock, endpoint-scoped, present winners only). The
  compaction guard admits zero-row delta checkpoints. The receipt carries
  `sourceManifestKind` (additive). The complete-receipt hydration read
  drops its capture floor for delta receipts (carried members live in
  older runs). The two as-of readers
  (`READ_AD_ENTITY_STATE_AS_OF_QUERY`, `READ_PRESENT_AD_STATE_SEEDS_QUERY`)
  are absent-aware: an `absent_unconfirmed` winner shadows the stale
  present row and is treated as absence evidence — never usable state,
  never `DELETED`; on a complete receipt a non-present winner for an
  expected member fails the count guard closed.
- `scripts/ephemeral-postgres-entity-state-history-seam-child.ts` — new
  D14a–D14m legs against real Postgres (below).
- `scripts/ephemeral-postgres-native-ad-decision-seam.ts` — synthetic run
  DDL gains the three columns; new D075 leg drives the full
  `hydrateAdDecisionInputs` path over a delta chain.
- Test-fixture ripple: `lib/api/meta.test.ts`,
  `lib/creative-decision-engine/__tests__/data-source.ad-grain.test.ts`
  (state fixtures now carry `presence`),
  `lib/creative-decision-engine/__tests__/jobs/ad-decisions-job.test.ts`.

### Measured results (facts)

- **1-of-1,042**: on real Postgres, a 1,042-ad complete scope followed by a
  single-ad change appends exactly **1 physical state row** (run
  `delta_stats_json`: logical 1042, changed 1, physical 1; storage census
  2 runs / 1,043 rows). Under the pre-D075 contract this was 1,042 rows.
- A zero-change forced checkpoint (past the 24h cadence) appends **0**
  state rows while keeping the logical `row_count`.
- A 1-of-3 change appends 1 row; a scope shrink appends exactly one
  `absent_unconfirmed` row that as-of reads honor (and earlier cutoffs
  ignore); re-entry appends one present row; 8 concurrent changed
  observers serialize to one delta run with one row; replays add nothing;
  account and sibling-endpoint scopes never fabricate exits.
- Production layout (SELECT-only, 2026-08-29): exactly one complete-lane
  endpoint per entity type (`ad_configs`/`adset_configs`/
  `campaign_configs`, 13 accounts, zero multi-endpoint scopes), so the
  endpoint-scoped contract matches production data as an invariant. The
  one-time exit backfill the first delta run writes per scope
  (historically departed entities) has a measured upper bound of **35
  rows** on the largest scope; every other scope is ≤20.

### Verification (facts, single-worker)

- `npm run test:migrations-from-zero`: **green end-to-end, 29 PASS
  banners, exit 0**, including the new
  `[entity-state-history-seam] D14 PASS delta manifests` legs and every
  pre-existing H1–H18 leg unchanged.
- `ephemeral-postgres-native-ad-decision-seam.ts` standalone: PASS,
  including the new `D075 PASS delta hydration` leg (1-of-3 delta run
  hydrates all 3 members with the changed row winning status resolution
  and carried members resolved from the older full run; scope-exit shrink
  to 2; zero-row checkpoint accepted as a complete authoritative source).
- Focused vitest (`--maxWorkers=1`): `entity-state-history.test`,
  `data-source.ad-grain.test`, `api/meta.test`, `ad-decisions-job.test`,
  `decision-pipeline-health.test` — **5 files, 97 passed, 0 failed**.
- `npx tsc --noEmit` clean; ESLint clean on all nine touched files.

### Compatibility and rollback (facts + one assumption)

- All schema changes are additive nullable columns; no existing row is
  rewritten. Legacy rows (`manifest_kind IS NULL`) and `full` runs read
  through the unchanged run-bound membership path, byte-compatible.
- Mixed history needs no cutover: a delta run's baseline may be a legacy
  full run; reconstruction is latest-per-entity over the complete lane,
  not a chain walk, so old and new generations interleave freely.
- Rollback: reverting the code restores full-manifest writes immediately;
  the three columns are inert under old code. Already-written delta runs
  are readable only through the delta-aware receipt readers — a rollback
  that also reverts the reader treats a delta run as an
  under-persisted manifest and fails closed (non-authoritative receipt,
  same-day rerun) until the next full observation re-establishes a
  run-bound generation. **[assumption]** That fail-closed window is
  acceptable rollback behavior; nothing corrupts.
- V1/operator/V2 snapshot compatibility untouched (this layer is below
  decision snapshots). No route renamed; no scheduler, provider, or
  production write performed. Production DB was queried SELECT-only.

### Remaining production blockers (unchanged by this slice)

- **[fact]** The fence is still breached in production; this slice adds no
  retention, deletion, or budget change. Delta-bounded writes shrink
  *future* growth only after a deploy — an operator decision.
- **[inference]** Complete lanes were ≈87% of weekly state-row volume;
  D075 bounds that class. The partial-lane residual (≈11%) remains
  full-manifest by design (a partial scope is not a well-defined diff
  baseline).
- **[unknown]** Realized production amplification after deploy — locally
  proven, but the production write mix (heartbeat hit-rate × change rate)
  is measurable only from `delta_stats_json` once a release carries this
  code.
- **[fact]** H11 resolver quality is untouched (explicitly out of scope);
  the authority gate remains `REJECT` and
  `CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION` stays unset.
- Automation remains **OFF** for the same reasons recorded above; D075
  makes storage enable-ready, it does not enable anything.

### Bounded adversarial review (2026-08-29, post-implementation)

One author-side adversarial pass plus one helper reviewer agent were run
against the D075 change surface. Outcome, with epistemic labels:

- **[fact — defect found and fixed]** P1, coalesced-path lineage: a
  creative relationship first observed while states coalesce onto a
  **delta** kept run named an ad with no durable row in that run;
  `persistMetaObservationLineage` silently skipped it (the inferred arm's
  state filter and the run-bound verified-pair join alike), deferring the
  edge until the next appending observation (worst case the 24h
  checkpoint) and stamping `relationship_observed_at` late — the H8 defect
  reintroduced for delta manifests. Fix: carry the missing ad's row into
  the kept run (byte-identical to the lane winner by definition of
  coalescing; kept-run clocks for the composite FK), bump the kept run's
  `delta_stats_json` (physical rows + lineage carries) so telemetry stays
  truthful, report the carry in the persist result's `stateCount`, and
  share one `lineageRelevantAdIds` helper between the append and coalesced
  paths. Regression: new seam leg D14n (carry + edge landing on the kept
  run + truthful stats + no-op repeat). Re-verified: migrations-from-zero
  green (29 PASS, exit 0) with D14n, 97/97 focused unit tests, typecheck
  and ESLint clean.
- **[fact — measured, deliberately not changed]** The writer-baseline /
  reader-delta-arm reconstruction (latest-per-entity over a scope's
  complete-lane history) costs ~2.47 s cold on the largest production
  scope (324,512 rows; SELECT-only `EXPLAIN ANALYZE`; heap reads dominate).
  No supporting index was added: indexes count toward
  `pg_total_relation_size`, which feeds the already-breached growth fence,
  so an index would deepen the breach and re-block sync on deploy.
  Index-versus-fence is an operator decision interlocked with retention;
  D075 caps further growth of the scanned history. Until deploy, no
  production query uses either shape (no delta runs exist there).
- **[fact — verified clean]** The replayed-`run_hash` `DO UPDATE` touches
  only `semantic_hash` and the GREATEST-guarded heartbeat clocks — never
  `manifest_kind`/`base_run_id`/`delta_stats_json`. Rollback-under-old-code
  behavior matches the record above: old readers fail closed to the
  non-authoritative fallback on delta receipts (a zero-row checkpoint is
  skipped by the old compaction guard; an under-persisted delta run
  mismatches its logical `row_count`), and the old writer's first complete
  observation restores a full run-bound generation.
- **[fact — superseded 2026-08-30]** The single independent reviewer agent
  was stopped before producing a completed report; its partial sweep was
  never counted as evidence. The consumer sweep has since been COMPLETED
  as its own bounded package: full census, verdicts, call paths, and
  proofs in `docs/audits/D075_STATE_HISTORY_CONSUMER_SWEEP_2026-08-30.md`,
  guarded by `lib/meta/__tests__/state-history-consumer-closure.test.ts`.
  Four confirmed reader defects were found and fixed (the
  decisions-workspace laterals fabricated `'DELETED'` from absence — the
  earlier "presence-aware laterals verified" phrasing had checked
  shadowing, not the DELETED mapping; the History feed fabricated
  status-change entries from scope exits; operator-response window-end
  confirmation was structurally unsatisfiable for unchanged entities
  under heartbeat/delta writers — fixed with `confirmed_until` and a
  source-proof v3 bump; the natural-wave verifier counted delta membership
  run-bound). All fixes carry pre-fix-failing regressions and real-PG
  proof (seam leg D15; harness 31 PASS, exit 0).
  **Acceptance correction 1 (same day):** independent acceptance rejected
  the sweep on three further gaps, all fixed fail-first — the sweep's
  "broad battery" claim is withdrawn (directory-scoped run missed
  root-level lib/meta tests; the exact
  `npx vitest run lib/creative-decision-engine lib/meta --maxWorkers=1`
  now discovers 241 files / 3,027 passed / 117 skipped / 52 todo / 0
  failed after fixing the stale label-copy assertion); the coalescing
  heartbeat was not replay-monotonic (D15e failed on the rejected writer;
  both clocks now GREATEST-guarded); and anti-supersession was
  captured-at-only (D15f: equal-captured tuple-loser wrongly extended,
  proven per-row through the exported production fragment; D15g: sibling
  endpoint wrongly superseded this endpoint's winner) — adjudicated to
  the exact winner order `(captured_at, created_at, id)` with
  endpoint-scoped authority, byte-pinned in the closure guard.
- **[unknown]** Warm-cache versus cold plan cost of the reconstruction
  shape under real production load, and the realized post-deploy write
  mix — both measurable only after a release carries this code.


---

## D076: campaign-role resolver challenger (implementation record, 2026-08-29)

ADR: `DECISION_LOG.md` § D076 (written before implementation; gate frozen
before the single validation run). Verdict: **REJECT — v2 stays the compiled
default**, the authority env stays unset, automation stays OFF.

### Frozen evidence (facts)

- Bundle: six businesses exactly (IwaStore, Grandmix, Bilsem Zeka, TheSwaf,
  IwaTR, ColorFullWorldsTR), bundleHash
  `58de78a12a15681ee51de1049f6463971d12231090dad33cd5c72586c5651b91`,
  SELECT-only, labels included strictly as the frozen offline comparator.
  57 labels (7 test); IwaTR zero. Anchors: train 2026-06-15..07-27,
  validation 2026-08-03/10/17; truth-freshness pairing ±45d of label stamp.
- The locked H11 replay documents and JSON artifacts (2025-12-01..
  2026-07-05) are byte-untouched by this phase.
- Production runtime fact: all 4,440 persisted context rows are
  account-NULL `v1-shadow` rows (last as_of 2026-08-22); under D074's
  fail-closed read production serves ZERO runtime roles today.

### Diagnosis (facts + separation)

- **[fact — data gap]** 5/7 Test labels describe tests concluded before
  observable history; a 6th fails floors while paused. Test recall against
  running behavior is unmeasurable on this window.
- **[fact — label ambiguity]** The one observable test-labeled campaign
  carries 39.6% of account spend with settled winners; v2 and v3 both
  surface it as `conflict` — the correct honest surface, kept.
- **[fact — resolver defects]** R1: v2 published `mixed/high` against main
  labels on small creative-cycling campaigns (3 of its 5 high-confidence
  train errors). R2: a real 32-creative hybrid missed the 0.5 winner-core
  bar at 0.4747. R3: `top3SpendShare` is structurally 1.0 at ≤3 creatives
  and v2 reads it as Main evidence — the mechanical core of the historical
  0/12 Test recall and of artifact conflicts on small named tests.
- **[inference]** The historical 12 missed Tests are attributed to R3 by
  formula analysis confirmed on current-window data; a per-campaign
  re-decomposition of the locked window was NOT re-run (the locked
  artifact stays frozen) — recorded as an unknown, not a claim.

### Challenger and gate result (facts)

v3 (`campaign-context-resolver.v3-lifecycle-2026-08-29`,
`campaign-context/resolver-v3.ts`) implements the R1/R2/R3 corrections plus
an optional lifecycle family (status share + cohort-relative budget) that
renormalizes away when evidence is missing. Validation (21 labels):
v3 high-confidence 2/4 (0.50, Wilson 0.150–0.850) vs v2 1/5 (0.20);
falseTestHigh 0 for v3; falseTestAny 1 (low class) vs v2's 0; coverage
0.9524 both; the R1 class eliminated (v3 corrects the paired IwaStore
campaign to `main/high`, per-account exact accuracy 0.60→0.80). Gate:
G1 FAIL (n=4 < 5, 0.50 < 0.8), G3 FAIL, G6 FAIL (LOBO unstable at n=4);
G2/G4/G5/G7 PASS → **REJECT**, honestly kept. Full tables:
`H11B_CONTEXT_LIFECYCLE_CHALLENGER_2026-06-15_TO_2026-08-22.md` +
`generated/h11b-context-lifecycle-eval.json`.

### UI/API explanation surface (facts)

The decisions-workspace payload now carries an additive per-campaign
`campaignRoleExplanation` (kind, confidenceClass, confidenceScore,
evidence[], conflictReasons[], unresolvedReason, lastEvaluatedAt,
resolverVersion) derived server-side from the persisted resolver row —
`not_yet_evaluated` when no row exists, `insufficient_evidence`/
`conflicting_signals` from the persisted class. The evidence window
renders it verbatim ("Automatically inferred role", label-free copy),
never computes a kind, and old serialized payloads render without the
rows. The helper that drafted this surface was stopped before reporting
(resource bound); the result recorded here was inspected and verified
directly (types → SQL → derivation → adapter), not taken from the helper.

### Verification (facts, single-worker)

- Context suites: resolver-v3 (13 new), source, hysteresis, data,
  isolation guard, label guard — 6 files, 59 passed.
- Explanation surface: decisions-os-presentation, decisions-workspace
  route, evidence-window adapter, workspace read-model — 4 files,
  208 passed.
- Locked-replay machinery untouched and green: simulation + runner +
  shadow tests — 3 files, 34 passed. `tsc --noEmit` clean; ESLint clean on
  every touched file. The D075 doc cleanup (duplicate comment, truthful
  `coalesced` doc) is included with no behavior change.

### Remaining blockers (unchanged stance)

- **[fact]** Authority requires the spec's 90% adjudicated-holdout gate;
  nothing here approaches it. `CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION`
  stays unset; v2's own 0.20 validation high-confidence accuracy
  independently confirms the gate must stay closed.
- **[fact]** Ingestion has been stopped at the storage fence since
  2026-08-22; no fresher evidence can accrue until the operator retention
  decision. The 10–15 campaign independent adjudication package remains
  the binding path to measurable Test recall.
- **[unknown]** v3's behavior on genuinely running test campaigns; LOBO
  stability at any realistic n; production shadow behavior of the
  lifecycle family once ingestion resumes.


---

## D077: growth-fence recovery package (implementation record, 2026-08-30)

ADR: `DECISION_LOG.md` § D077 (written before code; twice amended under
adversarial review before implementation hardened). Nothing was executed on
production: no mutation, deploy, activation, commit, or push; production
access stayed SELECT-only; automation stays OFF. This package makes the
recovery operation ready for a separately approved run — production is NOT
unblocked.

### Verified facts (frozen SELECT-only queries, 2026-08-29/30)

- Offender: `meta_entity_state_history` = 5,368,750,080 bytes vs the 5 GiB
  ceiling (40,960 bytes over); Meta sync stopped 2026-08-22 14:53 UTC. The
  2026-08-18 raise (4→5 GiB) was consumed in four days (~0.89 GiB) by the
  D075-measured 1-of-N rewrite class. Database total 118.3 GB (aggregate
  budget not breached).
- Anatomy: heap+TOAST 2,684,198,912 B; indexes 2,684,551,168 B (six
  btrees; largest 941 MB); 4,239,834 live rows, 277 dead; complete lane
  4,024,264 rows, partial 215,500, failed/point_lookup 0.
- Duplicate census: 3,449,571 complete-lane rows (85.7% of the lane,
  81.4% of the table) in byte-identical consecutive duplicate manifests;
  six businesses' share 1,774,467. Pin census: 160,477 rows lineage-FK
  pinned; 0 archived-schema; 0 response-event. The retained
  `adsecute_compact_20260726t0204z` schema holds RESTRICT FKs into the
  LIVE table.
- `pgstattuple`: available, NOT installed — free-space proof impossible in
  production today.

### Honesty rulings (bound into planner, executor, fence, UI, tests)

- **[fact]** DELETE + routine vacuum does not reliably lower
  `pg_total_relation_size`; no DELETE plan is presented anywhere as
  clearing the raw-size fence. The fence's governing number for this one
  table is now effective size = raw − PROVEN currently-reusable heap free
  space (`pgstattuple_approx.approx_free_space`, post-maintenance), with
  index bytes always fully counted and fail-closed fallback to raw on
  every uncertainty; an invalid raw measurement is an explicit
  unavailable state that denies, never zero-that-admits.
- **[unknown]** Exact removable rows after whole-run + interleave
  exclusion: the bounded production recomputation was aborted at the
  session's time budget; the number is produced only by the planner's own
  approved low-traffic dry-run, and the executor refuses until a plan is
  `ready` (which additionally requires the free-space proof).
- **[fact — defect found by the seam, fixed before production]** The
  draft deletion contract was falsified by the real-Postgres seam: a
  duplicate complete run with a partial observation interleaved between
  it and its retained predecessor is load-bearing for mixed-lane as-of
  reads. The rule now excludes such runs at plan time and re-verifies the
  interleave window inside every batch transaction.

### What shipped (local/ephemeral only)

`lib/sync/state-history-effective-size.ts` (strict measurement + pure
fail-closed derivation), fence integration in `db-growth-fence.ts`
(admission-affecting, one table, additive diagnostics),
`lib/meta/state-history-compaction.ts` (read-only-transaction-enforced
planner; canonical execution-payload hash binding every
execution-relevant field), `state-history-compaction-executor.ts`
(zero-write validation phase; journal lease exclusivity; per-batch full
revalidation — scope, row count, signature, identical retained
predecessor, non-head, pins, interleave — with batch rollback; bounded
inputs; exact resume accounting; kill switch; completed-plan
idempotency), journal migration + verification specs, operator CLI
(plan default dry-run, execute demands token + acknowledgement + exact
scope), readiness contract on the admin engine-v3 readiness route
(fence under both metrics, `NOT_EXECUTED`, named blockers; UI renders
only), static isolation guards, and the real-Postgres seam child wired
into the migrations harness.

### Verification (single-worker)

- `npm run test:migrations-from-zero`: green end-to-end, **30 PASS
  banners, exit 0**, including the new compaction seam (candidate
  selection with head/pin/multi-endpoint/delta/interleave protection;
  zero-write refusals; injection rollback; stale-plan refusal; interrupt
  + exact-accounting resume with lease exclusivity; pre/post equality of
  as-of winners, partial/failed interleaves, pinned rows, receipts
  guard, and the untouched twin business; post-compaction D075 writer
  twin-equivalence incl. coalesce).
- Unit: effective-size derivation 8 tests + strict parsing; isolation
  guards 6 tests — 15 passed. `tsc --noEmit` clean; ESLint clean on all
  touched files; `git diff --check` clean.

### Remaining operator decisions (this package executes none of them)

1. `CREATE EXTENSION pgstattuple` (enables the effective-size proof).
2. Low-traffic planner dry-run window (produces the exact removable
   counts and the binding projection).
3. Approval + execution of the compaction run via the CLI.
4. Physical byte return (REINDEX CONCURRENTLY / pg_repack / VACUUM FULL)
   for the raw-size number.
5. D075 deploy — without it, reclaimed space refills at the measured
   ~0.89 GiB/4-day rate.
6. The retained compact-schema's future; any change to the 5 GiB budget
   (raising it again is rejected by the ADR).


---

## D074b: manual-label vocabulary closure (implementation record, 2026-08-30)

Closes the retrospective audit's P1-2 (D074 PARTIAL). ADR:
`DECISION_LOG.md` § D074b (written before the migration). Automation OFF;
no deploy/production access/env change.

**Active residues removed (facts):** the buyer copy "A campaign role label
is required" and "Label campaign before scaling"; the `missing_campaign_label`
readiness blocker emission (+ `campaign_label` required-evidence name); the
`label_status`/`quality_status: missing_campaign_label`/
`unlabeled_campaign_soft_only` signal emission on both guard fallbacks; the
`campaignLabelStatus` field as an active branching input and emission across
jobs, read model, projections, card serialization, evaluation payloads, and
UI; the `unlabeled_campaign_context` badge/state emission (V1 state rows
included, whose served title/decision now read "campaign context
unresolved"); the `waiting_on_labels` sub-bucket and `unlabeled` watching
segment emissions; the V2.1 adapter reason `campaign_label_missing`; the
`campaign_label_status_drift` execution-safety emission; the
`requireCampaignLabel` guardrail key (TS + fresh-install seed). "Promote to
main" was audited and deliberately RETAINED: it fires only on trusted
automatic `campaignKind === "test"` and names the real winner-promotion
lifecycle. Commercial-truth's "Unlabeled" bucket was audited and retained as
generic ROAS-band vocabulary, not campaign role.

**Compatibility retained (why):** every legacy name persists as a
deprecated type member plus parse-time recognition normalized at the two
campaign-label-guard modules (`resolveCampaignRoleStatus`,
`canonicalCampaignRoleStatus`, `isCampaignRoleUnresolved`,
`isCampaignContextUnresolvedBadgeType`) — old persisted snapshots,
evaluations, receipts, and guardrail rows must keep deserializing, and a
legacy-only payload fails closed as unresolved and can never grant
authority. Frozen comparator tables/H11 artifacts untouched.

**Verification (first pass, superseded):** the first-pass closure guard
went 5/5 with a 28-file whole-file allowlist and 22 suites green — but
independent Codex acceptance REJECTED that state (see the correction
record below); "the guard works" was an overstated claim, since the
whole-file exemptions and a narrow copy regex let four defect classes
through. Deliberate tightening retained from that pass: canonical
`campaign_context_unresolved` tier-caps readiness to `read_only` exactly
as the legacy blocker did (fail-closed direction).

**Bounded adversarial review (one helper, read-only) — findings and fixes:**
The reviewer confirmed the consumer sweep, the authority-proof, the mixed
old/new drift comparison, and the allowlist judgments ("Promote to main",
commercial-truth ROAS bucket, studio-truth name grouping), and verified
legacy-recognition test coverage survived. It found, all fixed and
re-verified: (P1) `v3-bridge` was still EMITTING `campaign_label_missing`
reason tags/blockers on fresh payloads — my allowlist had miscategorized
those lines as recognition; now emits `campaign_role_unresolved` and the
closure guard's emission regex covers the pattern; (P1) the
decision-payload-coverage suite was red in the worktree (D076's eight
explanation keys were wired but never pinned) — pinned in sorted position;
(P2) the unresolved-role chip lost its warning tone
(`campaignKindClass` matched the old display string); (P2) a
client-synthesized Launchpad wrapper card fabricated
`campaignRoleStatus: "resolved"` — now `null`; (P2) the watching strip's
visible word "labels" → "roles unresolved"; (P2) a re-fed historical
`watchSegment: "unlabeled"` count was silently dropped — now folded into
`role_unresolved`; (P2) `isAlreadyGuarded` recognized only the legacy
shape — now symmetric. Two informational items deliberately deferred, on
record: the evaluation-hash input rename lands WITHOUT an engine-version
bump (persisted-row continuity in outcome/calibration/response jobs keys on
that string; rotating it is a deploy-package decision — the interim
consequence is a fail-closed `decision_hash_mismatch` on any stale
pre-deploy execution attempt), and `ad-decisions-job`'s metrics-unavailable
path reads medium-trust context as "unresolved" where the guard path says
"resolved" — inconsistent across surfaces but strictly fail-closed.

**Final verification after fixes:** 24 suites, 482 passed (+14 skipped,
11 todo); closure guard 5/5; `tsc --noEmit`, ESLint, `git diff --check`
clean.

**Acceptance rejection and corrections (2026-08-30, final):** Codex
acceptance rejected the first pass with four confirmed defect classes,
all now fixed and re-verified:

- **P0 authority normalizer:** `canonicalCampaignRoleStatus("labeled")`
  returned `"resolved"` (a manual-era label granting automatic-role
  authority); canonical status silently beat a conflicting legacy alias;
  missing-both was NOT unresolved. Corrected matrix: legacy `labeled` →
  `unresolved`; missing-both → `unresolved`; canonical/legacy
  contradiction → `unresolved` (same-claim pairs are agreement); new
  `hasResolvedCampaignRole` is the only authority predicate;
  `isAlreadyGuarded` keys on explicitly stamped statuses. Kind display and
  kind-conditional CTAs now additionally require resolved status in
  card-serialization, canonical-projection, `cardCampaignRoleStatus`,
  CampaignKindChip, ActionNowCard, and the evidence drawer — so "Promote
  to main" can no longer fire from a kind without resolved provenance
  (the earlier "fires only on trusted automatic kind" claim held for
  fresh engine output but NOT for legacy/unstamped payloads; it holds
  unconditionally now).
- **P0 Launchpad bridge:** the UI derived provider modes from
  `card.label` text, `campaignKind` (`scale`+`test`→promote), primary
  kinds, and the absence of `blockedActionType`. All derivations are
  deleted; `canOpenBriefingCardInLaunchpad` is false for every card and
  mode until a validated launch-authority contract exists, and every
  consumer (overlay, bulk teleport, compare drawer, watching/evidence
  CTAs) degrades to review-only. The v3-bridge treats missing/legacy-only/
  contradictory status as a campaign-context Diagnose and carries an
  isolation-compliant local mirror of the fold, byte-pinned by the guard.
- **P1 copy:** "save an explicit correction only when the provisional
  role is wrong" (decision-semantics ×2) and "(campaign label missing;
  execution move blocked)" (adapter) removed; resolution copy is
  system-owned automatic-evidence phrasing.
- **P1 guard:** rewritten to a per-file per-token EXACT-COUNT ledger
  (24 categorized entries; drift in either direction fails), scanning
  `scripts/` with categorized frozen-offline/parse-fixture entries only,
  an emission scan with a single documented fixture exception, a
  broadened copy regex proven against both missed strings, and pins for
  the corrected matrix. Also found in self-review: the legacy
  `requireCampaignLabel: false` guardrail row could DISABLE
  `requireResolvedCampaignRole`; the alias is now tighten-only
  (`resolveRequireResolvedCampaignRole`).

**Final verification after corrections:** engine suite 55 files /
915 passed; meta + decision-center + briefing + serialization suites
784 tests passed (closure guard 10/10); `tsc --noEmit`, focused ESLint,
`git diff --check` clean; automation env triple confirmed unset. The
regression tests added are ones that fail on the pre-correction code
(refusals, fail-closed folds, render-honesty), not expectation rewrites
alone.

**Acceptance rejection 2 and correction (2026-08-30, stale Decision
Center row):** a second independent acceptance run rejected the package on
one confirmed gap the first correction missed — and the first correction's
claim that kind-conditional CTAs were gated "at every serving layer" was
false while it stood. `primaryActionForDecisionCenterRow` received only
the compatibility row, so a stale `scale`/`promote_to_main` row outranked
the fail-closed role status: the probe (missing canonical status +
legacy-only `labeled` + `campaignKind: "test"` + stale promote row)
served `{ kind: "promote", label: "Promote to main" }` beside
`campaignRoleStatus: "unresolved"`, `campaignKind: null`. ActionNowCard
read `decisionCenterRow.executionAction` directly as a second echo.

Corrected boundary, end to end: the row is provenance, never authority.
Serialization lets a row's scale action shape the primary only under
canonical resolved status with an agreeing kind (test→promote_to_main,
main→scale_budget, mixed→controlled_scale); otherwise the resolved-gated
decision CTA (review-only) stands and the row is retained verbatim for
the evidence drawer. One shared gated client helper
(`cardCurrentRowScaleAction`) now feeds ActionNowCard's execution CTA and
the page's Promote filter; the Asset Library label shows scale rows as
plain "Scale" (its composed buyerLabel embeds the unverifiable execution
hint); the evidence drawer's decision-center block remains the one
documented provenance display. The closure guard pins the serialization
gate, the helper's decision table, ActionNowCard's helper usage, and an
exact-count census of every `.executionAction` read on the briefing
surface (4 documented sites). Proofs that fail on the pre-correction
code: the dual-write test previously pinned the trusting behavior
(resolved MAIN + promote row → "Promote to main") and now pins "Scale
budget"; the stale-row matrix across missing/legacy-only/contradiction/
no_campaign and all three scale actions; ActionNowCard's ungrounded-row
render; the Promote-filter refusal; the Asset Library label pin.
Re-verified: engine 55 files / 915 passed; meta + center + briefing sweep
793 passed (closure guard 11/11); `tsc --noEmit`, ESLint,
`git diff --check` clean; automation env triple unset.

**Acceptance rejection 3 and correction (2026-08-30, current-decision
precedence):** a third acceptance run rejected the package on two
confirmed variants, and correction 2's statement that the row was
"provenance, never authority" is withdrawn for the period it stood —
its gate proved role/kind agreement but not that the row was the CURRENT
decision. Probe A: canonical resolved Test role + stale
`scale`/`promote_to_main` row overrode every current decision label
(keep/diagnose/cut/refresh/test_more all served `{ kind: "promote" }`,
erasing a current Cut). Probe B: on a source-freshness-blocked Scale the
server correctly served `{ "kind": "review", "label": "Refresh
evidence" }`, but `cardCurrentRowScaleAction` passed on role+kind alone
and ActionNowCard rendered `Promote to main ↗` over it.

Corrected boundary: the row may only CONFIRM the current decision.
Serialization requires the current unblocked Scale verdict (label,
blockedActionType, authorityBlocker checks), resolved role + agreeing
kind, and exact agreement between the row CTA and the decision-derived
primary. The client helper additionally requires `card.primary.kind` to
agree exactly with the row action and fails closed on held/blocked
state, so server review/cut/refresh/diagnose labels stand verbatim. The
action filter treats a non-current scale row as absent — it can no
longer classify the card or suppress `blockedActionType`. The closure
guard byte-pins every gate leg on both sides. Proofs failing on the
correction-2 code: the five-label server matrix, the three-block server
matrix, the client current-primary matrix, the exact ActionNowCard
source-freshness render probe, and the filter held-suppression pins (the
render harness is static markup, so the no-Launchpad click guarantee
rests on the globally-false bridge tests plus the non-executable render —
stated as a limitation). Re-verified: engine 55 files / 915 passed;
meta + center + briefing sweep 57 files / 787 passed; `tsc --noEmit`,
ESLint, `git diff --check` clean; automation env triple unset.

**Acceptance rejection 4 and correction (2026-08-30, provenance
surfaces):** a fourth acceptance run confirmed the correction-3 gates but
rejected two raw-row consumers, and correction 3's closing statement that
the Asset Library plain action word and the Evidence Drawer attributed
section were already valid non-executable provenance displays is
withdrawn — operator-visible decision, filter, and CSV correctness is
part of authority integrity even with no provider button. Bypass C: with
current server label `cut` and a stale `scale`/"Scale - Promote to main"
row, `resolveAssetLibraryRowLabel` returned `{ label: "Scale", source:
"decision_center" }` and `rowEffectiveDecisionLabel` returned "scale" —
visible label, filter grouping, and CSV export all followed the stale
row. Bypass D: on a current-Cut card the drawer rendered "Scale -
Promote to main" bold, "Promote to main now." as guidance, and "Queue
true - apply true" as current-looking eligibility with no disclosure.

Corrected boundary: the Asset Library Label cell, label filter, and CSV
are current-projection-only (shared helper; fail-closed explicit
"Review" with `data-label-source="current_unavailable"` when no current
server label exists — the old null→"Main" render default is also gone);
the raw row feeds nothing there. The drawer block is now "Compatibility
snapshot (provenance)" with the explicit "Not the current decision …
cannot execute any action" disclosure; composed
buyerLabel/oneLine/nextStep no longer render; raw action/queue/apply
values survive only as attributed snapshot lines marked as conveying no
current eligibility. The closure guard adds a per-file exact-count
census over the raw decision fields (buyerAction, buyerLabel, nextStep,
oneLine, queueEligible, applyEligible) on the briefing surface, byte
pins on the corrected helpers, and disclosure/absence pins on the
drawer. Proofs failing on correction-3 code: the exact bypass-C fixture
across cell/filter/shared projection (all five current labels + the
no-current-label fail-close) and the exact bypass-D render. Correction-3
accepted probes re-verified green. Battery: engine 55 files / 915
passed; meta + center + briefing sweep 57 files / 789 passed;
`tsc --noEmit`, ESLint, `git diff --check` clean; automation env triple
unset.

**Remaining boundary (not hidden):** the deprecated names still exist as
parse arms/type members by design — exactly the 24 ledger entries, all
parse/recognition/frozen positions, none authority-granting; their removal
is a post-deploy follow-up per the D074b migration plan. The bridge
retains the unused pure mapper `mapExecutionActionToLaunchpadMode`
(display/routing helper; no production caller reaches Launchpad through
it). The served `decisionCenterRow` keeps its fields byte-intact; it can
shape a current primary ONLY by exactly confirming the current unblocked
server decision under resolved role authority, it never feeds the Asset
Library label/filter/CSV, and its single display site is the drawer's
explicitly non-authoritative compatibility-snapshot section. With all
four acceptance corrections verified, D074's matrix status is
COMPLETE-with-documented-compatibility-boundary.
