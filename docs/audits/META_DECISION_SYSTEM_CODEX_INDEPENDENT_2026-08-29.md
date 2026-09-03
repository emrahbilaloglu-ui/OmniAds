# Meta Decision System — Codex Independent Audit

**Date:** 2026-08-29  
**Scope:** Meta only; IwaStore, Grandmix, Bilsem Zeka, TheSwaf, IwaTR, ColorFullWorldsTR  
**State:** Independent Codex report, frozen before reading Claude's report  
**Repository:** `babf158e150fd33057117b39b175da044ac62d2e` (`main`, clean at evidence freeze)  
**Media-buyer skill:** `/Users/harmelek/.codex/skills/emb-media-buyer/SKILL.md`, SHA-256 `985754567f2ac07e3623d4bc91ce16b0421ac9e3295f3e842248305ec3cbd187`

## Executive verdict

**Adsecute is not currently capable of replacing Meta Ads Manager.** It is useful as a decision-review surface and it has one narrow, well-defended exact-Ad pause path, but it is not an autonomous media-buying control plane.

The most serious problem is not simply missing automation. It is a mismatch between what the Decision UI appears to authorize and what the write boundary will actually allow:

- The six accounts' ad warehouse and native decision generations stop at 2026-08-21/22.
- The exact-Ad execution preflight rejects decisions older than 12 hours.
- TheSwaf still renders four stale `Cut` decisions as **Action eligible** with enabled `Cut` buttons.
- Those four writes will be rejected as `decision_stale`; therefore the number of presently executable decision-origin actions across all six businesses is **zero**.
- The UI's displayed `68.46h old` value is the age of a newer structure-recommendation snapshot, not the age of the exact creative decision behind the enabled button. The same screen mixes two time authorities.

The second systemic blocker is absence of a learning loop. All six latest native outcome jobs failed with a 30-second database timeout. Three latest native operator-response jobs also failed because a query referenced a nonexistent `business_ref_id` column. Controlled experiments, arms, random assignments, outcome batches, control observations and causal estimates contain zero rows for the six businesses. The engine can classify, but it cannot currently prove that following its classifications improves results.

The third blocker is execution breadth. Current automation can raise proposals and, after explicit operator confirmation, execute campaign/ad-set pause or resume. It cannot autonomously manage budgets, bids, scaling, duplication, creative rotation, launches, audiences or placements. Launchpad deliberately creates paused drafts. Rules deliberately never write. No scheduler auto-approves or auto-dispatches.

**Decision:** keep every Meta live-write path manual/dry-run. Do not turn on full auto mode until the P0/P1 gates in this report are met and proven with provider read-back, receipts, rollback drills and causal holdouts.

## Evidence and method

### Evidence classes

- **Verified fact:** directly read from the production database in a read-only transaction, read from current source code/tests, or observed in the authenticated live/local UI.
- **Inference:** a conclusion that follows from verified facts but was not itself stored as a field.
- **Unknown:** something the available evidence cannot prove.

### Production-data boundary

Production analytical reads used `default_transaction_read_only=on`, a bounded statement timeout and a named audit connection. No Meta provider write, campaign change, deploy, migration or production application-code write was performed. Temporary admin authentication records were used only for local UI inspection and are not decision evidence.

The business/account selection was fixed as follows:

| Business | Business ID | Selected Meta account | Currency | Account timezone / business timezone |
|---|---|---|---|---|
| Bilsem Zeka | `6c690fa4-6395-40b5-9755-e99b34d69bc3` | `act_840779107261785` | TRY | Europe/Istanbul / missing |
| ColorFullWorldsTR | `bc0c6178-7853-4f6f-b026-ef0222a4b9e7` | `act_3554615364751964` | USD | Europe/Istanbul / missing |
| Grandmix | `5dbc7147-f051-4681-a4d6-20617170074f` | `act_805150454596350` | USD | America/Anchorage / America/Los_Angeles |
| IwaStore | `f8a3b5ac-588c-462f-8702-11cd24ff3cd2` | `act_1087566732415606` | USD | America/Los_Angeles / America/Los_Angeles |
| IwaTR | `b79683b4-6f87-48c0-a3ca-44d4356fef51` | `act_2335220976649516` | USD | Europe/Istanbul / missing |
| TheSwaf | `172d0ab8-495b-4679-a4c6-ffa404c389d3` | `act_822913786458311` | USD | America/Chicago / America/New_York |

TheSwaf also has `act_921275999286619`; it was not silently merged into the selected account. Grandmix and TheSwaf have account/workspace timezone disagreement, and four businesses have no persisted business timezone. Any daily cutoff, quiet-hours or “today” automation must resolve and display one explicit authoritative timezone before writes are allowed.

## Data readiness

### Warehouse freshness

`meta_account_daily`, `meta_adset_daily` and `meta_ad_daily` are finalized only through **2026-08-21**; the latest rows were updated/finalized on 2026-08-22. At the 2026-08-29 audit, the decision source is approximately seven days behind the operating day.

| Business/account | `meta_ad_daily` rows | Distinct ads | `meta_adset_daily` rows |
|---|---:|---:|---:|
| Bilsem Zeka | 57,591 | 1,793 | 355,094 |
| ColorFullWorldsTR | 13,477 | 298 | 37,017 |
| Grandmix | 28,808 | 1,818 | 529,693 |
| IwaStore | 43,245 | 880 | 67,192 |
| IwaTR | 24,056 | 207 | 10,530 |
| TheSwaf selected account | 13,977 | 732 | 52,763 |
| TheSwaf second account | 3,816 | 105 | not selected |

History is long enough for retrospective analysis, but freshness is not sufficient for live autonomous control.

### Commercial truth

| Business | Target / break-even ROAS | Risk mode | Cost truth | Readiness conclusion |
|---|---|---|---|---|
| Bilsem Zeka | 3.0 / 2.0 | balanced | no cost model | target anchors exist; cost truth incomplete |
| ColorFullWorldsTR | 4.0 / 3.0 | balanced | no cost model | target anchors exist; cost truth incomplete |
| Grandmix | 2.2 / 1.8 | conservative | COGS .22, shipping .16, fee .035 | usable target/cost pack |
| IwaStore | 3.5 / 2.7 | balanced | legacy cost fields all zero | internally inconsistent; zero costs must not be accepted as real economics |
| IwaTR | missing | missing | missing | hard scale/cut authority must remain closed |
| TheSwaf | 2.0 / 1.71 | aggressive | COGS .29, shipping .05, fee .046, other .03 | usable target pack; no legacy cost model |

No `business_decision_calibration_profiles` row exists for any of the six. Target pack values are engine inputs; the legacy cost model is not. This distinction is not clear enough in the UI.

## Native exact-Ad decision audit

### Generation integrity

All latest generations use `v3-ad-2026-07-18-decision-presentation-hardening-shadow` with `as_of_date = 2026-08-22` in Istanbul date rendering (stored date boundary `2026-08-21T21:00:00Z`).

| Business | Latest native job ID | Rows | Manifest authority | Result |
|---|---|---:|---|---|
| Bilsem Zeka | `6cb3bc31-7df0-4e6f-9ad9-bbb534c2354d` | 3,204 | expected = hydrated = 3,204; hashes match; prune-authoritative | valid |
| ColorFullWorldsTR | `5650a607-9c4c-4751-9da2-4f6c7cd77359` | 414 | expected = hydrated = 414; hashes match; prune-authoritative | valid |
| Grandmix | `88e9a7e1-656b-4d16-9e9a-9f42d3d97dc1` | 2,529 | expected 0, hydrated 2,529; manifest hashes differ; source incomplete; not prune-authoritative | **invalid / must fail closed** |
| IwaStore | `60738253-71e8-44d0-9b50-832215327b06` | 1,042 | expected = hydrated = 1,042; hashes match; prune-authoritative | valid |
| IwaTR | `e015ca19-cc8c-4ab7-931f-eb4ed9dd19e9` | 172 | expected = hydrated = 172; hashes match; prune-authoritative | valid |
| TheSwaf | `f9271dcc-581f-42bc-b2f4-f2a4b3de6c95` | 750 | expected = hydrated = 750; hashes match; prune-authoritative | valid |

Grandmix's successful job status is not equivalent to a valid serving generation. The read model correctly withholds canonical authority with `native_account_manifest_incomplete`, but the job-level “success” label is operationally misleading unless manifest validity is surfaced beside it.

### Latest-generation classification distribution

| Business | Persisted labels / states | Raw hard-action context | Authorized exact action |
|---|---|---|---:|
| Bilsem Zeka | keep 11; diagnose 1,081; test_more 105; out_of_scope 2,007 | one raw cut; 109 authority blockers | 0 |
| ColorFullWorldsTR | keep 4; diagnose 388; test_more 12; out_of_scope 10 | 89 blockers | 0 |
| Grandmix | cut 3; scale 2; keep 15; diagnose 2,335; test_more 35; out_of_scope 139 | five hard labels inside an invalid generation | 0 serveable |
| IwaStore | cut 4; scale 4; keep 13; diagnose 945; test_more 36; out_of_scope 40 | 26 blockers | 0 |
| IwaTR | keep 5; diagnose 109; test_more 58 | one blocker | 0 |
| TheSwaf | cut 19; keep 10; diagnose 672; test_more 44; out_of_scope 5 | 32 blockers; 34 transitions | 7 persisted cut authorizations |

The action rate is appropriately sparse, but sparsity is not proof of quality. With no current outcome accrual and no controlled estimates, the audit cannot establish precision, incremental profit or regret for those hard labels.

### Current active inventory coverage and effective executability

| Business | Current active ads | Active ads lacking an exact native decision | UI/read-model posture | Actually executable now |
|---|---:|---:|---|---:|
| Bilsem Zeka | 141 | 26 | no authorized current action | 0 |
| ColorFullWorldsTR | 18 | 0 | 7 blocked, 11 monitor | 0 |
| Grandmix | 80 | 0 by identity, but generation invalid | fail-closed canonical source | 0 |
| IwaStore | 52 | 16 | 16 honest pending-native placeholders; 23 blocked, 29 monitor | 0 |
| IwaTR | 60 | 4 | no authorized current action | 0 |
| TheSwaf | 15 | 0 | UI says 4 act, 3 blocked, 8 monitor; four cuts shown action-eligible | **0; all four fail the 12h decision-age gate** |

The IwaStore placeholder behavior is good: the current UI keeps active ads visible while saying exact native decisions are pending. It should be the standard behavior for every incomplete account.

## Structure Advisor audit

The current served projection contains 36/89/22/44/40/44 recommendations for Bilsem Zeka, ColorFullWorldsTR, Grandmix, IwaStore, IwaTR and TheSwaf respectively. All **275** rows lack provider-account lineage and all have automation readiness false. The raw latest-day Bilsem table contains 34 rows while the served projection contains 36; the two carried rows are not explained on the UI. This is a lineage/explainability gap, not permission to discard them.

| Business | Latest projection date | Act | Test | Watch | Provider-account lineage | Auto-eligible |
|---|---|---:|---:|---:|---|---:|
| Bilsem Zeka | 2026-08-26 | 3 | 0 | 33 | 0/36 | 0 |
| ColorFullWorldsTR | 2026-08-22 | 6 | 1 | 82 | 0/89 | 0 |
| Grandmix | 2026-08-22 | 0 | 6 | 16 | 0/22 | 0 |
| IwaStore | 2026-08-24 | 2 | 2 | 40 | 0/44 | 0 |
| IwaTR | 2026-08-22 | 1 | 1 | 38 | 0/40 | 0 |
| TheSwaf | 2026-08-26 | 2 | 6 | 36 | 0/44 | 0 |

Across these 275 rows, 273 share missing controlled-causal evidence, live preflight, operator enablement, rollback evidence, valid receipt, random assignment, control estimate and outcome model. Most are also unsupported action classes or diagnostic/watch states. High confidence in the classification is therefore not equivalent to execution readiness.

### Reproducible example: TheSwaf cut recommendation

`adset_cut_spend-120251375825870042` is mathematically reproducible from stored data:

- snapshot: 2026-08-26;
- observed window: 2026-08-06 through 2026-08-21 local;
- 16 observed days;
- spend 3,815.74; revenue 2,552.80; ROAS `2552.80 / 3815.74 = 0.669`;
- empirical p25 ROAS threshold 1.1734 over sample 20;
- configured target / break-even ROAS 2.0 / 1.71.

The direction “cut/rebuild” is reasonable as a diagnostic recommendation. It is not automation-ready: the source window ends five days before the recommendation snapshot, the row lacks provider-account lineage, the UI says currency unavailable despite the selected account being USD, observational precision is zero, and causal evidence is zero.

## Outcome and learning audit

### Native jobs

Every latest `engine_v3_ad_decision_outcomes_job` failed with `native_outcome_job_failed` and `Database query timed out after 30000ms.`; each wrote zero outcome rows. Latest job IDs:

- Bilsem Zeka `c667a1c8-a0da-43d0-8296-097042fa3c30`
- ColorFullWorldsTR `bd07e5d6-6f43-4edf-84d1-14c4809f990d`
- Grandmix `34f366c6-0ef9-4932-9cff-b1b55ac57ca1`
- IwaStore `9ceb381e-23d4-4447-8e9d-fb231abfa54e`
- IwaTR `1b7df1bb-8521-4edf-82f8-be397c772259`
- TheSwaf `62bfc3ab-2958-4fab-b6b3-282d7ef7f2eb`

The latest native operator-response jobs for ColorFullWorldsTR, Grandmix and TheSwaf failed with `column "business_ref_id" does not exist`. The other three succeeded but accrued zero rows. Provider write history is unavailable in the native decision drawer.

### Observational versus causal evidence

Observational action/outcome logs exist, but are mostly inconclusive:

| Business | Observational logs | Inconclusive |
|---|---:|---:|
| Bilsem Zeka | 64 | 64 |
| ColorFullWorldsTR | 41 | 37 |
| Grandmix | 183 | 143 |
| IwaStore | 112 | 86 |
| IwaTR | 9 | not enough to calibrate |
| TheSwaf | 179 | 119 |

For the six-business scope, controlled experiments, arms, assignment batches, random assignments, seed reveals, control observations and estimates all contain **zero rows**. Observational logs must not be relabeled causal.

**Inference:** the engine is currently a rule/classification system with incomplete feedback, not a self-calibrating optimizer.

## UI audit

### Verified strengths

- IwaStore active ads without an exact decision stay visible as pending-native placeholders instead of disappearing or borrowing another decision.
- Grandmix canonical action authority fails closed when the native manifest is invalid.
- Drawers show source authority, decision/snapshot identity and the absence of provider write outcomes.
- Structure actions that lack a write contract route to review or Launchpad rather than pretending to execute.
- Launchpad states that it creates paused drafts.

### P0 UI truth defects

1. **Stale action appears executable.** TheSwaf shows four exact cuts as Action eligible and enables `Cut`, although the server rejects them as older than 12 hours.
2. **Mixed freshness clocks.** `Stale · 68.46h old` comes from the newer structure snapshot while the creative action is based on an approximately seven-day-old native decision. `synced 7d ago`, snapshot date, engine run and exact-decision age are displayed as if they describe one source.
3. **Live client crash.** In the authenticated production application, changing from IwaStore to TheSwaf on Decisions produced `Minified React error #310` and the global “Application error” screen. React #310 means a component rendered more hooks than on its previous render. Current local HEAD did not reproduce a crash in a fresh TheSwaf load; the exact production component/version remains unknown. This is a verified production blocker but the root cause is not yet proven.
4. **Misleading receipt promise.** Automation says every outcome lands in the ledger with a receipt, while historical rows marked Applied have null receipt IDs. Copy must distinguish legacy/unverified rows from receipt-backed writes.
5. **Missing action evidence.** A strong exact cut drawer can omit CTR/funnel/placement evidence and has no persisted risk tier, even though these are decision-relevant media-buyer checks.
6. **Missing lineage/currency.** Structure rows do not expose their absent provider-account lineage; TheSwaf can show currency unavailable although the selected account is USD.
7. **Unexplained date scope.** IwaStore structure evidence can show a recommendation as-of 2026-08-24 and a UI range through 2026-08-28 while the underlying warehouse cuts off on 2026-08-21.
8. **Meta Ads Manager remains a dependency.** The Decision Center still links to Ads Manager. That is acceptable during migration, but it proves the stated no-Ads-Manager operating goal is not met.

### Required UI state model

Each row needs four separate, server-owned answers:

1. **Verdict:** scale/cut/keep/diagnose/test_more/out_of_scope.
2. **Evidence readiness:** complete/partial/blocked with exact missing fields and source cutoff.
3. **Execution readiness:** executable now / dry-run only / approval required / unsupported / stale / kill-switched.
4. **Last provider outcome:** verified applied / verified unchanged / refused / unknown / reconciliation required.

The UI must never derive (3) from (1), and it must never call (4) successful without provider read-back.

## Advisor and execution capability

| Capability | Current decision support | Current provider control | Full-auto ready? |
|---|---|---|---|
| Exact Ad pause from cut | native exact authority exists for a narrow set | manual confirmation path; fresh provider preflight; receipt/read-back design | No: current decisions stale and outcomes broken |
| Exact Ad resume | safety contract exists | not a normal surfaced engine action | No |
| Campaign/ad-set pause/resume | structure recommendations and proposals | only after explicit operator confirmation | No |
| Budget increase/decrease | recommendations can mention scaling | no executable budget proposal/endpoint | No |
| Bid/bid-strategy change | review recommendations | explicitly review-only | No |
| Duplicate/promote/rebuild | can route to Launchpad | manual wizard; creates PAUSED draft | No |
| Creative refresh/rotation | can create/route a brief | no automatic build/QA/launch/rotation/retirement loop | No |
| Campaign launch | Launchpad supports construction | manual; paused-first by design | No |
| Audience/placement management | diagnostic context only | no autonomous mutation contract | No |
| Rule automation | ROAS/CPA/quiet-hour rules | raises proposal or hard-block only; never writes | No |
| Outcome learning | observational logs | native outcomes currently fail; no causal estimates | No |
| Rollback/reconciliation | some guarded handlers and receipt tables | incomplete coverage and legacy receipt gaps | No |

## Automation control-plane audit

- Only IwaStore has a persisted `meta_automation_business_controls` row.
- IwaStore is kill-switched (`Zero-base Meta stop`), `auto_execution_enabled=false`, readiness tier manual, `dryRunOnly=true`, maximum three actions/day, maximum +15% budget change, and 5,000 spend ceiling recorded as EUR while the Meta account is USD.
- The other five businesses have no persisted control row. Code derives manual/dry-run defaults, but absence of a control row must become an explicit fail-closed state at every write boundary, not a permissive implicit configuration.
- None of the six has a decision-type mode or active automation rule.
- TheSwaf has three old proposals: two expired and one still marked pending although expired.
- No launch intent exists for the six-business scope.
- Old IwaStore/TheSwaf manual action logs lack provider verification, idempotency and decision lineage.
- Proposal execution supports campaign/ad-set `pause` and `resume` only. `bid` and `duplicate` are explicitly unsupported.
- The scheduler raises proposals; no code path auto-approves or auto-dispatches them.

## What must be built

### P0 — truth and safety before any expansion

1. **Use one execution-readiness authority.** Apply the exact same decision-age, engine, identity, current-state, kill-switch and policy gates in the server read model that the write preflight uses. A stale decision must be served as blocked/review-only and its button disabled before click.
2. **Separate time authorities.** Display warehouse cutoff, structure snapshot/run age, exact-Ad snapshot/run age and current provider-state observation age as separate fields. Never show one age beside another source's action.
3. **Repair the outcome pipeline.** Explain/optimize the 30-second native outcome query, bound its partitions and prove successful accrual for every selected account. Fix the operator-response query/schema mismatch and backfill safely.
4. **Fail closed on missing control state.** Every write family must require a readable, persisted business control row and a resolved currency/timezone. Defaults may populate a setup form; they must not authorize a write.
5. **Validate Commercial Truth.** Reject zero/negative/impossible costs, prevent currency mismatches, require target or break-even authority for hard actions, and show which fields the engine actually consumes.
6. **Fix production business switching.** Capture the production build/version and component stack for React #310; add a test that switches business IDs without remounting through loading/error/loaded states.
7. **Correct UI claims.** Disable stale/unsupported controls; label legacy no-receipt history as unverified; expose lineage, source cutoff, currency, risk tier and missing evidence.
8. **Operational health gate.** A failed native generation manifest, stale warehouse, failed outcome job or unavailable current-provider read must automatically close automation for the affected account and explain why.

### P1 — complete the media-buying control plane

1. Add guarded, idempotent, receipt-backed provider contracts for budget changes, bid changes, duplication/promotion, creative lifecycle actions, campaign launch, audience and placement changes.
2. Give every action: immutable decision lineage, fresh provider preflight, daily/account/entity caps, quiet hours, minimum sample/maturity, cooldown, conflict lock, rollback snapshot, provider read-back and reconciliation.
3. Implement staged autonomy modes: `observe` → `propose` → `dry_run` → `auto_low_risk` → `auto_bounded` → `stopped`. Mode must be persisted per business and action type; no implicit default can authorize.
4. Add an automatic dispatcher only for explicitly whitelisted low-risk action types whose readiness gates are all green. High-risk actions remain approval-gated until separate evidence thresholds are met.
5. Build a single “Why not automatic?” panel that lists the exact failed gates and the one next action for each.
6. Build a provider-state inventory and change timeline inside Adsecute so routine verification does not require Ads Manager.

### P1 — prove decision quality

1. Establish holdout/control assignment before actions, with immutable seeds and account/entity eligibility.
2. Measure incremental profit or contribution margin, not ROAS alone; report action precision, false-action rate, opportunity cost, regret, rollback rate and silent-failure rate.
3. Calibrate confidence by business/account, decision type, spend band, maturity and data-quality tier.
4. Require predeclared success/reversion thresholds and minimum sample. Do not promote observational associations to causal evidence.
5. Backtest every engine/config change on frozen PIT-safe bundles and compare against the deployed baseline before rollout.

### P2 — eliminate Ads Manager as an operating dependency

- Complete provider parity for entity creation/editing, budgets, bids, creative assignment, placements, audiences, policy/review status and billing/account alerts.
- Provide an exception inbox for provider-only blockers and an immutable audit trail with before/after/read-back/rollback.
- Keep a break-glass deep link to Meta for incidents, but it should no longer be required for normal daily management.

## Go-live gates for full automation

Full automation is **NO-GO** until all of the following are true for every enabled business/account/action type:

- warehouse cutoff meets the defined SLA and uses the account's authoritative timezone;
- current provider inventory and policy state were observed within the preflight SLA;
- decision and execution-readiness ages are below the same configured threshold;
- native generation manifest is complete and hash-valid;
- Commercial Truth is valid, current and currency-consistent;
- provider-account lineage exists on every actionable row;
- outcome and operator-response jobs are green for at least 14 consecutive daily runs;
- every attempted write has an idempotency key, durable receipt, provider read-back and reconciliation state;
- rollback is proven in a dry-run and a sandbox/canary drill;
- controlled holdout evidence meets predeclared precision/regret guardrails;
- UI and API report the same action eligibility in contract tests;
- business switching, stale refresh, partial failure and kill-switch drills pass;
- account/day/entity spend and action caps are enforced at the write boundary;
- a global and per-business stop control is visible and independently tested.

## Conclusion

The system's architecture contains several good safety primitives, but the operating claim must remain conservative: **Adsecute currently recommends and supports a narrow manual action workflow; it does not yet autonomously manage Meta advertising.** The immediate goal is not to add more “Auto” toggles. It is to make one server-owned execution-readiness truth, restore the learning loop, complete provider action coverage, and prove that every automated action is beneficial, bounded, observable and reversible.

