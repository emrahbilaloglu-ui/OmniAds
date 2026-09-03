# Meta Decision System — Claude Cross-Review of the Codex Independent Audit — 2026-08-29

Operating class: **read_only**. This is the Codex↔Claude cross-review phase.
Inputs: the Codex report
`docs/audits/META_DECISION_SYSTEM_CODEX_INDEPENDENT_2026-08-29.md` — SHA-256
verified **55a461c016a24e06cce981a1032959f8b94b2c2ad8fbf7cafcad99c36adec173
(matches expected)** — and my independent report
`docs/audits/META_DECISION_SYSTEM_CLAUDE_INDEPENDENT_2026-08-29.md`. The
emb-media-buyer skill binding (SKILL.md SHA-256
`985754567f2ac07e3623d4bc91ce16b0421ac9e3295f3e842248305ec3cbd187`) and the
project contracts read in the independent phase remain in force.

All new evidence in this document was gathered read-only on 2026-08-29
14:25–14:46 UTC: production DB `adsecute_prod` via the existing tunnel
(`default_transaction_read_only=on`, 30s statement timeout,
`application_name=claude_independent_audit_2026-08-29`) and source code at
`main@babf158e1`. No product code was edited, no DB write issued, no deploy, no
migration, no provider/Meta call of any kind.

**Bottom line of the cross-review:** Codex's report is substantially correct
and materially improves on mine in one headline respect — the
execution-readiness gap. My "exactly 4 actionable decisions" is corrected to
**4 presentation-actionable, 0 execution-executable**. In exchange, Codex's
report misses the two operational P0s that dominate recovery (the pipeline is
*stopped*, not merely stale, and the growth fence is armed again), and this
cross-review adds a new, timestamp-proven root cause for Grandmix's invalid
manifest that neither independent report had: an **observation-vs-decision
ordering race**, not the growth fence.

---

## 1. Codex claims accepted (verified with my own evidence)

| # | Codex claim | My verification anchor |
|---|---|---|
| A1 | Decision-origin ad execution preflight defaults to 12h max decision age and emits `decision_stale` | `lib/creative-decision-engine/execution-safety.ts:543` (`maxDecisionAgeHours = input.maxDecisionAgeHours ?? 12`), `:648-650` (blocker push). The production wrapper `lib/meta/decision-origin-action-preflight.ts:176-180` passes **no override**, and its consumers are the real write routes (`lib/meta/ads-action-routes.ts:35`, `app/api/launchpad/meta/bulk-ad-status/route.ts:45`). Also enforced: `maxCurrentAdStateAgeMinutes ?? 5`, `engine_version_drift`, kill-switch verification. |
| A2 | The four served TheSwaf cuts are `computed_at = 2026-08-22 14:51:26.766+00` and ~167.7h old | DB re-read at 14:41 UTC: all 7 Main-account authorized cuts share exactly that `computed_at`; age **167.83h** at my check vs Codex's 167.68h — consistent with a ~9-minute observation offset. |
| A3 | The UI/read model still marks them action-eligible | `lib/meta/decisions-workspace-read-model.ts:2344-2349`: `actionEligible = activeHierarchy && hasExactCreativeIdentity && decisionState==='act' && authorizedAction match` — **no decision-age term anywhere**. My own live UI capture (independent phase) shows the four Cut rows with enabled "Cut … Pauses this exact ad only" CTAs and no stale annotation. |
| A4 | Native outcome jobs 100% failed on 30s DB timeouts; zero outcome rows | Confirmed independently (360/360 failures since 08-15; `engine_v3_ad_decision_outcomes_daily` = 0 rows ever). |
| A5 | Operator-response jobs failing with `column "business_ref_id" does not exist` | Confirmed; my count: ×138 occurrences since 08-15. |
| A6 | Controlled-causal registries all zero; `business_decision_calibration_profiles` zero rows | Both re-verified by direct count (0 and 0). |
| A7 | Grandmix latest generation: expected 0 vs hydrated 2,529, hashes differ, not prune-authoritative, `complete_source_run_missing`; read model fails closed with `native_account_manifest_incomplete` | Consistent with my serve-time observation (legacy_creative · degraded). Root cause now identified — see §4.5. |
| A8 | Structure Advisor: latest projections 36/89/22/44/40/44 = 275 rows, 0/275 with provider-account lineage | Re-verified exactly: `meta_decision_snapshots_daily` latest snapshot per business — every row has `provider_account_id IS NULL`. |
| A9 | Observational action/outcome logs 64/41/183/112/9/179, mostly inconclusive | Re-verified exactly (`meta_decision_action_outcome_logs`; inconclusive 64/37/143/86/5/119). |
| A10 | IwaStore automation controls: kill-switched, dry-run, 3 actions/day, +15% budget cap, spend ceiling recorded in **EUR** on a **USD** account | Re-verified: `guardrails_json` = `perActionSpendCeilingMinor: 5000, perActionSpendCeilingCurrency: "EUR"` (note: *minor units*, i.e. €50.00 — the unit nuance doesn't change the currency-mismatch defect). |
| A11 | Proposal execution supports `pause`/`resume` only | `lib/meta/automation-proposal-execution.ts:60-66` (`type ExecutableProposalAction = "pause" | "resume"`); anything else returns `withheld: "unsupported_action"`. |
| A12 | Cost-truth table: Grandmix legacy cost model 0.22/0.16/0.035; IwaStore legacy cost model **all zeros**; TheSwaf cost percentages exist | Re-verified. Source split matters: Grandmix and IwaStore rows live in `business_cost_models` (IwaStore genuinely all-zero — an accepted-invalid economics row); TheSwaf's 0.29/0.05/0.046/0.03 live on **`business_target_packs.cost_*` columns**, not the legacy table. Bonus corroboration: TheSwaf margin 1−0.416 = 0.574 → implied BE-ROAS 1/0.574 = 1.742 ≈ its configured 1.71; Grandmix legacy margin 0.585 → 1.709 vs configured 1.80. The configured anchors are roughly margin-consistent where cost data exists. |
| A13 | `meta_adset_daily` row counts (355,094 Bilsem / 529,693 Grandmix / …) | Re-verified exactly; they looked implausible to me and are correct. TheSwaf total 79,132 = Codex's 52,763 selected + the rest on the second account. |
| A14 | Production React #310 crash on IwaStore→TheSwaf business switch | **Accepted as a verified production observation by Codex** with unknown root cause. I could not and did not test production; corroborating negative: my local dev pass switched IwaStore→Grandmix→TheSwaf on Decisions without a crash, matching Codex's "fresh local HEAD did not reproduce". Treated as a production blocker, root cause unknown (see §6). |
| A15 | Automation ledger "Applied" rows lack receipts; Launchpad paused-first; rules never write; no auto-dispatcher | Consistent with my independent findings (92 manual actions, 0 receipts, 0 journal rows, 0 rules; `provider_verified=false` on every action-log row). |

## 2. Codex claims corrected or refined

| # | Codex statement | Correction / refinement | Evidence |
|---|---|---|---|
| B1 | "TheSwaf … 7 persisted cut authorizations" presented as the account total; report elsewhere treats TheSwaf as one selected account | Both counts are right under their scopes and should be stated together: **7 authorized cuts on selected Main (computed 08-22 14:51) + 2 more on the deselected NonTesvik account (as_of 08-21, computed 21:20)** — 9 total for the business, 2 of them unservable by construction. | DB: authorized rows grouped by `provider_account_id` (§4.2 query) |
| B2 | Warehouse "approximately seven days behind", framed as a freshness problem | Understated: the pipeline is **stopped, not slow**. No `meta_sync_runs` row after 2026-08-22 14:53:38, no `engine_v3_job_runs` row after 14:51:26, while the Meta durable sync worker heartbeats `idle` **at 2026-08-29 14:45:17** — re-checked during this review. The recovery action is "restore the scheduler invocation", not "wait for sync". Two worker generations heartbeated today (`18:68ovr0vm` stopped 11:33, `18:4z5f31g0` current), proving deploy/restart activity while the cron chain stayed silent. | `sync_worker_heartbeats`, `meta_sync_runs`, `engine_v3_job_runs` |
| B3 | Grandmix manifest invalidity: root cause left unknown | **Root cause found — see §4.5.** It is an intra-day ordering race, not (as my independent report inferred) the growth fence. | timestamps in §4.5 |
| B4 | "one [proposal] still marked pending although expired" | True at Codex's read time; the row lazily flipped to `expired` during my audit window (observed `pending` ~13:52 UTC, `expired` ~14:12 UTC; its `expires_at` was already 2026-08-27). Not a standing state defect but a lazy-bookkeeping display hazard; the systemic point stands and is stronger: **all 4 proposals ever raised died unapproved on the ~24h TTL**. | `meta_automation_proposals` |
| B5 | Data table lists TheSwaf second account only as "not selected" | The materially missing facts: NonTesvik **spent $1,017 in the final observed week**, its ingest runs nightly, and native decision generations (126 ads/day, incl. 2 authorized cuts) are produced for it — for an account no read surface can serve. See §4.3 for the contract framing. | `meta_ad_daily`, snapshot table |
| B6 | UI table "IwaStore … 23 blocked, 29 monitor" | Definitional note, not an error: the read model's `adCandidates.stateCounts` are blocked 7 / monitor 29; Codex's 23 = 7 native-blocked + 16 pending-native placeholders at the presentation layer. Both true at their layer; reports should name the layer. | live workspace JSON |

## 3. My own claims corrected or retracted

| # | My independent-report claim | Correction |
|---|---|---|
| C1 | "**Exactly 4 actionable ad decisions exist in the entire product today**" (§5.4) | **Corrected: 4 presentation-actionable; 0 execution-executable now.** Every one of them would be refused at the write boundary as `decision_stale` (age 167.8h > 12h default), before kill-switch, provider-state, and status checks even matter. The distinction is not academic: it is itself a P0 defect (the served `actionEligible: true` + the field's own comment "Provider execution still requires sourceAuthority.actionEligible" at `decisions-workspace-read-model.ts:1398` promise an authority the preflight will deny — one execution-readiness truth does not exist). My §9 classification ("cut→pause approval-gated") gains the extra precondition: *and freshly recomputed decisions*. |
| C2 | TheSwaf-NonTesvik "unreachable **despite an assignment row**", listed as a defect of the 403 | **Reframed.** The 403 is contract-correct: `lib/provider-account-assignments.ts:38` filters `AND bpa.is_selected`, and the deselected row is history under the product's selection model. The real, retained finding is the **producer/read-scope inconsistency**: ingest and the native decision producer process the deselected account nightly (and mint authorized actions for it) while every read surface answers "not assigned". Either the producer should skip deselected accounts, or the product should support multi-account serving; producing unservable authority is the defect. |
| C3 | "the fence then refused… which is exactly what broke Grandmix's native manifest on 08-22" (§1.3 / §5.4, labeled inference) | **Retracted.** Disproved by write evidence: 88,876 entity-state rows were written on 08-22 (11,051 for Grandmix alone, last at 14:53:48), so the fence was not refusing that day. The verified root cause is the ordering race in §4.5. The fence breach itself stands, but as a *future* threat (§5.1), not the 08-22 cause. |
| C4 | "target packs carry no margin/AOV/cost inputs" (§8.1) | **Over-generalized.** TheSwaf's pack carries `cost_cogs_percent 0.29 / shipping 0.05 / fulfillment 0.046 / payment 0.03`. Correct statement: 5 of 6 packs carry no cost fields; TheSwaf's does, and its BE-ROAS is approximately margin-consistent (1.742 implied vs 1.71 configured). The downstream point survives unchanged: the engine consumes only the ROAS anchors; no in-product reconciliation ties BE to cost/commerce truth. I also missed IwaStore's all-zero legacy cost-model row (Codex found it). |
| C5 | "SNAPSHOT Stale · 178.16h old" cited without naming its clock (§7) | **Clarified.** That figure (Grandmix) is `pulse.snapshotHealth.ageHours` — the **recommendation-lane** clock (`app/api/meta/account-pulse/route.ts:249-273`, age from rec-engine `lastRunAt`, 26h SLA, engine `v1.2.0-target-age-advisory`). It is not the native decision age. I did not flag that on TheSwaf the same tile reads ~68h while the native cuts behind the enabled buttons are ~168h old — Codex's mixed-clock finding is accepted in full (§4.4). |
| C6 | My active-ad counts presented without predicate labels | Corrected in §4.3 with the explicit predicate; the numbers were right for their definition but invited exactly the cross-report confusion that happened. |

## 4. Reconciled facts — the six disputed claims

### 4.1 "Exactly 4 actionable" vs executable-now (RESOLVED: Codex right)

Facts hold end to end (A1–A3). Layered truth, all verified:

- **Persisted authorization:** 14 rows with `authorized_action` in the latest
  generations (12 cut, 2 scale) — engine-lane truth.
- **Presentation-actionable:** 4 (TheSwaf Main cuts served in ACT with
  `actionEligible: true`, enabled buttons).
- **Execution-preflight-executable now: 0.** `decisionAgeHours 167.8 > 12` →
  `decision_stale` for every one; nothing else in the product is younger.
- Corollary accepted from Codex verbatim: the UI derives execution eligibility
  from the verdict + hierarchy, never from the write boundary's own gates.
  The server read model and the preflight must share one readiness authority
  (P0-4 in §7).

### 4.2 TheSwaf second account (RESOLVED: expected 403; real gap reframed)

`getProviderAccountAssignments` filters `is_selected = TRUE`
(`lib/provider-account-assignments.ts:38,462`); the accounts picker and
workspace honor it. The 403 is the contract working. Reconciliation query:

```sql
SELECT s.provider_account_id, s.as_of_date, s.authorized_action, COUNT(*), MAX(s.computed_at)
FROM engine_v3_ad_decision_snapshots_daily s
WHERE s.business_ref_id='172d0ab8-495b-4679-a4c6-ffa404c389d3'
  AND s.engine_version='v3-ad-2026-07-18-decision-presentation-hardening-shadow'
  AND s.authorized_action IS NOT NULL
  AND s.as_of_date IN ('2026-08-21','2026-08-22')
GROUP BY 1,2,3;
-- act_822913786458311 | 2026-08-22 | cut | 7 | 2026-08-22 14:51:26.766+00
-- act_921275999286619 | 2026-08-21 | cut | 2 | 2026-08-21 21:20:42.318+00
```

Retained finding (agreed formulation): **selection semantics are consistent at
the read boundary but the write-side producers ignore them** — nightly sync +
decision generation + 2 authorized cuts for an account the product will not
serve, while that account spends ~$1k/week. Decide one way: skip deselected
accounts in the producers, or make selection a serving filter rather than an
assignment filter.

### 4.3 Active-ad count reconciliation (RESOLVED: definitional, not contradictory)

Recomputed under labeled predicates (latest `meta_entity_state_history`
observation per entity; `meta_ad_dimensions` for hierarchy):

| Business | (a) ad-level ACTIVE inventory | (b) full-hierarchy ACTIVE (ad+adset+campaign) | (c) my report: ACTIVE ∩ has latest-gen decision row | (d) Codex report |
|---|---:|---:|---:|---:|
| Bilsem Zeka | 144 | 111 | 145 | 141 |
| ColorFullWorldsTR | 18 | 18 | 18 | 18 |
| Grandmix | 80 | 80 | 80 | 80 |
| IwaStore | 67 | 36 | 63 | 52 |
| IwaTR | 60 | 34 | 54 | 60 |
| TheSwaf Main | 41 | 21 | 52 (both accts) | 15 |
| TheSwaf NonT | 13 | 13 | — | (excluded) |

Reading: Codex's IwaTR 60 = predicate (a); Codex's TheSwaf 15 = the served
exact-Ad candidate count (4+3+8), a fourth population; my numbers = predicate
(c) at the 08-22 generation with statuses as-observed-by-08-22 (and, for
Bilsem, the momentary 145-vs-144 delta is drift between my two reads of the
"latest observation per ad" — the underlying statuses last changed 08-22).
IwaStore's served "36 of 36 eligible exact Ad identities" equals predicate (b)
— corroborating that the workspace queue uses full-hierarchy-ACTIVE. Codex's
Bilsem 141 and IwaStore 52 sit between (b) and (a) and most plausibly come from
a config-snapshot inventory read `[unknown — needs Codex's exact SQL to close;
immaterial to any conclusion]`. **No contradiction: four legitimate
populations. Every future report should name predicate + as-of.**

### 4.4 Age displays (RESOLVED: one field, two lanes; mixed-clock defect confirmed)

- The tile "Stale · Xh old" is `pulse.snapshotHealth.ageHours`, computed at
  `app/api/meta/account-pulse/route.ts:249-273` from the **recommendation
  lane's** `lastRunAt` (engine `v1.2.0-target-age-advisory`, 26h SLA).
- Cross-corroboration that we observed the same field: TheSwaf tile read
  **68.46h** in my session and **68.82h** in Codex's — a 0.36h delta matching
  our ~22-minute observation offset, both anchored to rec-lane `lastRunAt`
  2026-08-26 ~17:4x UTC (the last serve-time rec write).
- My 178.16h was the *same field on Grandmix*, whose rec lane last ran 08-22
  03:01 — so on that page it coincidentally approximates the native age, which
  is why I missed the split. On TheSwaf the same tile reads 68h while the
  native decisions behind the enabled Cut buttons are ~168h old.
- Four clocks exist on one screen and only the first three are shown: (1)
  `synced Xd ago` ← `meta_sync_state.latest_successful_sync_at`; (2) header
  `snapshot 2026-08-22 · engine v3-ad-…` ← native generation; (3) tile
  `Stale · Xh` ← rec-lane snapshotHealth; (4) native `computed_at` — displayed
  nowhere as an age, yet it is the one the write boundary judges. **Agreed
  blocker; joint P0 (§7 item 4).**

### 4.5 Grandmix root cause (RESOLVED with new evidence: ordering race, not fence)

Codex's hydration receipt (`complete_source_run_missing`, expected 0) is the
verified mechanism. The missing piece, now timestamp-proven:

```sql
-- Grandmix's ONLY complete ad observation run on 08-22 landed AFTER the last decision run:
-- meta_entity_observation_runs (entity_type='ad', act_805150454596350):
--   2026-08-21 14:53:32 complete (2,517 rows)
--   2026-08-22 14:53:48 complete (2,517 rows)      <-- 2m41s AFTER the stop
-- engine_v3_job_runs (native decisions, Grandmix): last success finished 2026-08-22 14:51:07
```

Daily pattern (complete-obs time vs last decisions-job time): on 08-10, 08-11,
08-12, 08-16, 08-17, 08-19 and 08-22 the complete observation run landed
**after** the day's last decision run (obs ~11:39–18:18 vs decision waves
mostly ending ~03:04); on 08-20 and 08-21 a later decision run (16:11, 15:01)
happened to follow the obs run and could validate. On 08-13/08-18 no complete
ad run exists at all, and 08-14/08-15 have no successful Grandmix decision job.
Grandmix is the largest observation load (2,517 ads; its runs go partial at
2,000/1,500 rows before completing), so it structurally completes last — and
any day whose final decision wave precedes it serves an invalid manifest.
On 08-22 the global scheduler stop at 14:51/14:53 froze exactly the losing
ordering in place.

Classification: **verified mechanism** — decision job consumed no same-day
complete source run that existed only 2m41s later; **verified pattern** — the
race recurs on most recent days; **inference** — no retry/re-order exists after
a late obs completion (no post-obs decision run appears on race days);
**retracted** — my fence-causation inference (writes flowed all day on 08-22).
**Unknown** — why the wave schedule orders the largest account's decisions
before its observation completes, and whether 08-20/21's late runs were
deliberate catch-ups.

### 4.6 Production React #310 (RESOLVED as: verified production blocker, root cause unknown)

Accepted per §1-A14. Facts: crash observed by Codex in the authenticated
production app on IwaStore→TheSwaf switch; minified error #310 (hook-count
change between renders); fresh local HEAD does not reproduce (Codex), and my
local pass through the same transition also did not crash. Honest state:
**verified on production, unreproduced at HEAD, root cause and production
build/version unknown.** Do not conclude "local code is fine" — the deployed
SHA must be captured (`/api/build-info`) and the switch path exercised against
that build. One dated hypothesis worth testing, labeled hypothesis only: a
component whose hook count depends on payload shape could flip when one
business serves `native_ad` and the next serves the legacy-degraded shape
(IwaStore native → TheSwaf… although TheSwaf serves native too; Grandmix is the
degraded one). The test in §7 P0-6 covers all shape transitions.

---

## 5. Important evidence Codex missed or understated (offered for adoption)

Each item was re-verified during this cross-review and comes with an anchor a
reviewer can replay.

1. **The pipeline is stopped, not stale — and the worker is alive.** Last sync
   run 2026-08-22 14:53:38; last engine job 14:51:26; Meta worker heartbeat
   `idle` at 2026-08-29 14:45:17 (re-checked this session). The Codex report
   never states that nothing has *invoked* the chain for 7 days, which changes
   the P0 from "improve freshness/SLA" to "restore the external
   `/api/sync/cron` trigger and add absence-of-run alerting". Anchor:
   `sync_worker_heartbeats`, `meta_sync_runs`, `engine_v3_job_runs` max rows.
2. **The growth fence is armed right now.**
   `pg_total_relation_size('meta_entity_state_history') = 5,368,750,080` ≥
   budget `5,368,709,120` (5 GiB), comparator `bytes >= budget` at
   `lib/sync/db-growth-fence.ts:864` → the next observation batch after
   restart will be refused, reproducing exactly the silent legacy-fallback
   family the fence's own comment documents for 2026-08-17. Measured write
   volume 08-16..22 was 45,968–160,335 rows/day against the budget-raise
   premise of "~200 rows/day". Absent from the Codex report entirely; it is
   the difference between "restart the cron and recover" and "restart the cron
   and silently degrade every account".
3. **Spend-weighted decision coverage.** Ad counts flatten what matters;
   weighting by final-week spend: IwaStore has **52.8%** of live spend under a
   campaign-context-held Scale (four ads, ROAS 5.25–7.72 vs target 3.5, held
   only by the closed D050 hard-authority gate — one explicit label correction
   releases it, and the UI's "LABELS 5/5 100%" hides that); TheSwaf has
   **51.0%** of live spend under authorized Cut; Grandmix **22.1%** under
   authorized-but-invisible Cut; Bilsem **23.0%** out_of_scope (Conversations
   182 / Lead 32 / ThruPlay 10 ad sets historically — a permanently unsupported
   business model share, not a data gap).
4. **Per-business kill-switch display contradiction.** The workspace's
   `system.killSwitchEngaged` reads only `process.env.META_ADS_WRITE_KILL_SWITCH`
   (`app/api/meta/decisions-workspace/route.ts:632`) and serves **false** for
   IwaStore while `meta_automation_business_controls.kill_switch_engaged=true`
   ("Zero-base Meta stop"). Codex audited the control plane but not this
   display split; it belongs beside their "one execution-readiness authority"
   P0 — the kill switch has two truths too.
5. **The pulse "pacing" is circular.** `dailyTarget = mtdSpend / elapsedDays`;
   `mtdTarget = dailyTarget × 30`; `dayPace = elapsed/30` (IwaStore served
   values reproduce this exactly: 5,317.15/22 = 241.688 → ×30 = 7,250.66).
   No plan input exists; the display can never show a real over/under-spend.
6. **Structure lane still demands manual labels.** Latest snapshots for
   Bilsem (08-26), ColorFull (08-22) and IwaStore (08-24) contain "Label this
   campaign as Main, Test, or Mixed before taking hard action" — the
   operator-labeling requirement D033/D050 removed. Two lanes ship opposite
   doctrines; Codex's Structure audit (lineage, auto-eligibility) is right and
   this contradiction should join it.
7. **Realized-outcome evidence beyond the action logs.** Codex's outcome table
   covers `meta_decision_action_outcome_logs` (mostly inconclusive). The
   legacy lane's `engine_v3_decision_outcomes_daily` (72,865 rows) is the
   stronger dataset: known-outcome scales are 39% negative overall, and
   **Grandmix scale: 9 negative / 2 positive / 1 neutral** — observational,
   regression-to-mean-uncorrected, but it is direct evidence against the scale
   gate's real-world quality on the exact account where two scales are
   currently authorized.
8. **All proposals ever raised died on the 24h TTL unapproved** (4/4,
   including one raised post-outage on 08-26) — the supervised-automation loop
   has never completed even once at the approval step.
9. **Grandmix ordering race** (§4.5) — new root cause available to both
   reports.

## 6. Unresolved unknowns (joint ledger after cross-review)

| # | Unknown | Cheapest discriminator |
|---|---|---|
| U1 | Why the scheduler stopped 2026-08-22 ~14:53 UTC (host crontab, CRON_SECRET/env parse break on deploy, deliberate stop) | host crontab + app access log for `POST /api/sync/cron` (401 vs absent) |
| U2 | Production build SHA and component stack for React #310 | `/api/build-info` on production + sourcemapped reproduction on that SHA |
| U3 | Codex's exact predicate for "current active ads" (Bilsem 141, IwaStore 52) | Codex supplies the SQL; expected to be a config-snapshot inventory |
| U4 | Whether any post-obs decision retry mechanism exists that simply never fired on race days | code path of the wave scheduler ordering (`runNativeAdScheduledChain`) |
| U5 | Whether the 08-20/21 late decision runs (16:11/15:01) were catch-up logic or manual triggers | job-run metadata / invocation source for those two runs |
| U6 | What a fresh, served, executable Scale row renders (none exists anywhere; resume-only semantics untested in UI) | first post-recovery generation with an authorized scale |
| U7 | Attribution window/model drift per account (neither report audited) | `meta_config_snapshots` account attribution fields |

## 7. Proposed P0 implementation order and acceptance tests

Order chosen so each step unblocks verification of the next; items merge both
reports' P0 lists.

| # | Action | Acceptance test |
|---|---|---|
| P0-1 | **Restore the scheduler invocation** (find/fix the external cron → `/api/sync/cron`); capture root cause (U1) | A `meta_sync_runs` row and a full `engine_v3_job_runs` chain exist for the current day for all 6 businesses; D068 natural-wave verifier passes |
| P0-2 | **Clear the growth fence before restart** — operator retention decision on `meta_entity_state_history` (3.76M rows to 2020) or an evidence-based budget with alerting; add "fence refusal ⇒ degraded source health + alert" | `pg_total_relation_size < budget` with ≥6 months headroom at the measured 45–160k rows/day; a simulated at-budget state visibly degrades source health instead of silently falling back |
| P0-3 | **Fix the Grandmix ordering race**: decision job must anchor to the latest complete observation run ≤ cutoff or re-run after obs completion; alternatively order the wave obs-before-decisions per account | 7 consecutive days of Grandmix generations with `expected = hydrated`, hash-matched, prune-authoritative; workspace serves `native_ad` for Grandmix |
| P0-4 | **One execution-readiness authority** (joint headline): the read model computes `actionEligible` through the same gate set as `runDecisionOriginAdExecutionPreflight` (decision age, engine version, kill switch incl. per-business DB switch, hierarchy, policy); stale ⇒ served blocked with reason, button disabled | Contract test: for any served row, `sourceAuthority.actionEligible === (preflight.blockers.length === 0)` on the same inputs; a >12h-old authorized cut serves as blocked `decision_stale` |
| P0-5 | **Separate the four clocks** (§4.4): label warehouse cutoff, native decision age, rec-snapshot age, provider-state age as distinct fields; never render one lane's age beside another lane's action; fix the positive-tone stale chip | Snapshot test: TheSwaf-like fixture shows rec-age 68h and native-age 168h simultaneously, each labeled; tone for stale/unknown is non-positive |
| P0-6 | **Repair the measurement loop**: outcome-job query optimization (30s timeout family), operator-response `business_ref_id` schema fix; backfill; then 14 green daily runs | `engine_v3_ad_decision_outcomes_daily` > 0 and growing for all 6; zero failed outcome/operator-response runs for 14 consecutive days |
| P0-7 | **Production switch crash**: capture build SHA, reproduce with sourcemaps, add a business-switch test cycling native / legacy-degraded / demo payload shapes through loading→error→loaded | Switch test green on the deployed build; no #310 in production error logs for 7 days |
| P0-8 | **Kill-switch single truth + fail-closed missing controls** (Codex P0-4 + my §6.4): write boundary and every display read env + per-business row; absent row = explicit fail-closed state | Contract test: IwaStore fixture (DB switch on, env off) serves engaged=true everywhere; a business with no controls row cannot pass any write preflight |
| P0-9 | **Producer/selection coherence** (§4.2): skip deselected accounts in sync+decision producers, or serve them; also decide the Bilsem contract (per-goal out-of-scope acknowledgment) | No generation exists for an account no surface can serve, or the surface serves it; census equality between producer scope and serving scope |

Everything further (budget/bid write contracts, staged autonomy ladder,
holdout evidence, Ads-Manager parity) stays behind these nine, exactly as both
independent reports concluded; Codex's go-live gate list is accepted as the
superset checklist for any future auto mode, with one addition from my report:
**controlled-causal registries must be populated per D048 before any
auto-tier, and observational outcome summaries must never be relabeled causal.**

## 8. No-mutation attestation

During this cross-review phase: all database access was read-only
(`default_transaction_read_only=on`, 30s statement timeout, distinctive
`application_name`), 2026-08-29 14:25–14:46 UTC; queries touched only catalog
and decision-system tables listed above. No product code was edited; no file
other than this artifact was created or modified; no migration, seed, reset,
deploy, commit, push, or PR; no Meta/provider call of any kind; no UI session
was opened in this phase (all UI citations reference the independent phase's
already-attested inspection). The only repository change from this phase is
this file: `docs/audits/META_DECISION_SYSTEM_CLAUDE_CROSS_REVIEW_2026-08-29.md`.

*Claude Code cross-review of the Codex independent audit, 2026-08-29, against
`main@babf158e1` and `adsecute_prod`.*

---

# Response to Codex cross-review

Input: `docs/audits/META_DECISION_SYSTEM_CODEX_CROSS_REVIEW_2026-08-29.md`,
SHA-256 verified
**6d8c94959b3745fbd034c922e936f13938fa9e3448a6a14934613b41a77da749 (matches
expected)**, read in full. This section is the final discussion round before
local implementation. No product code and no DB state were touched in
producing it; the only change is this appended section.

## R1. Codex's ledger and P0 order — accepted, with one amendment

**The accepted/corrected claim ledger is accepted in full.** Codex A1–A7
correspond to my §5 offers and re-verify cleanly; Codex C1 and C2 are the same
corrections I adopted in §3 (C1/C2) with identical reconciled terminology
(persisted-authorized 7 / served action-presented 4 / execution-preflight-
executable 0, and the NonTesvik 403 as contract-correct with the
producer-vs-selection scope question as the real gap). C3's reconciliation
contract for counts (source, account set + `is_selected` rule, status
predicate, generation, observation cutoff, deselected inclusion) is exactly
what my §4.3 table needed and I adopt it as the standing rule for every future
count in these audits. C4 is resolved in my §4.4 with the field anchor
(`pulse.snapshotHealth.ageHours`, rec-lane `lastRunAt`, 26h SLA at
`account-pulse/route.ts:249-273`) and the cross-corroborated 68.46h/68.82h
observation pair; my 178.16h is the same field observed on Grandmix, where the
rec lane stopped the morning of 08-22 — a later measurement of a different
business, not a different authority. **C6 is accepted as stated**: "the
decision core is sound" is hereby narrowed to "the persisted native exact-Ad
rows satisfy the audited structural invariants and the selected arithmetic
reproductions" — internal consistency, not commercial accuracy, calibration,
or read-model stale-safety (the last of which is demonstrably absent).

**One amendment, from evidence Codex did not yet have when writing its
cross-review.** Codex C5 correctly held the fence→Grandmix link at
"plausible, not proven." My §4.5 has since settled it in the *other*
direction: the fence did **not** cause the 08-22 receipt (88,876 entity-state
rows were written that day, 11,051 for Grandmix, so the fence was not
refusing); the proven mechanism is the **observation-before-decision ordering
race** — Grandmix's only complete ad observation run of 08-22 landed at
14:53:48, 2m41s after the last decisions job (14:51:07), and the same losing
order recurs on 08-10/11/12/16/17/19. The reconciled report should carry that
version, and Codex's P0 #3 ("Restore ingestion safely") must therefore gain a
sub-item: **fix the ordering race** — anchor the decisions job to the latest
complete observation run at cutoff or re-run decisions after a late
completion — with the acceptance test "7 consecutive Grandmix generations with
`expected = hydrated`, hash-matched, prune-authoritative, served as
`native_ad`." Without this, a fully recovered scheduler still reproduces
Grandmix's invalid serving on most days. The fence remains a separate, armed
P0 exactly as Codex A1 states.

**P0 order: accepted with that amendment, read as two parallel lanes.**
Codex's 1–2 (false affordances; health truth) and 5 (governance truth) are
pure local code and start immediately; 3–4 (ingestion recovery + ordering
race; learning jobs) are the operational lane and proceed in parallel — my
§7 P0-1/P0-2 ordering reflected dependency for *verification* (nothing
end-to-end can be proven until the pipeline runs), not a reason to delay the
code lane. 6 (React #310) needs the deployed build; 7 (account scope) is
small and local. The two orders are compatible; the merged sequencing is:
code lane {Codex 1, 2, 5, 7} ∥ ops lane {Codex 3 + ordering race, 4}, then 6,
then breadth. My §7 acceptance tests and Codex's acceptance-test list are
complementary and both apply.

## R2. The P0-4 semantics — chosen contract: two fields, no render-time provider reads

Codex's objection to my P0-4 phrasing is correct and accepted: the mutation
preflight is not only the 12h age gate — it also requires an exact ≤5-minute
provider GET (`maxCurrentAdStateAgeMinutes ?? 5`,
`execution-safety.ts:544-545`), policy/hierarchy truth, kill-switch
*verification* (not just value), idempotency-claim state, and the write-time
post-claim re-preflight (D065). A read-model row can never truthfully promise
mutation success, because the live half of that evidence does not exist at
render time and cannot be carried to the mutation moment even if it did.

**Chosen contract — the first option, made precise:**

1. `sourceAuthority.actionEligible` is narrowed to mean exactly *"this
   persisted decision authorizes this action"* — decision-side authority only
   (hierarchy-active, exact identity, `decisionState: act`, authorized-action
   match), which is what the field already computes today.
2. A new server-owned `executionReadiness` field is added beside it, computed
   from the **deterministic, server-local subset of the preflight's gates,
   evaluated by the same imported code the preflight uses**:
   `stale_decision` (shared 12h authority; future/unparsable timestamps fail
   closed here too), `engine_version_drift`, `kill_switched` (effective
   global + business truth), `governance_unavailable` (controls/kill-switch
   state unreadable — mirrors the preflight's
   `kill_switch_state_unavailable`, fail-closed), `blocked:<reason>` (claim
   holds, unresolved reconciliation), and — as the *maximum* attainable value
   — **`live_preflight_required`**. There is deliberately **no
   `executable_now` value at the read model.** The strongest truthful promise
   a read can make is "everything the server can know without touching Meta
   passes; execution still runs the live preflight at submit."
3. The UI renders a mutation CTA only when
   `executionReadiness === "live_preflight_required"`, and the CTA/ceremony
   copy states that submission runs a live preflight first. In every other
   state the row is review-only with the served reason. **In all cases a
   decision older than 12h serves as blocked/review-only with
   `stale_decision`, and no enabled mutation CTA may appear** — satisfying
   both acceptance-test lists verbatim.

**Why not the second option (run full read-only preflight inputs before
rendering):** it would require a fresh provider GET per rendered candidate —
turning every page view into dozens of Marketing API reads (rate limits are a
live failure class: 12 quota failures on 08-22 alone), coupling read
availability to provider availability, and inflating an already 20–40s page.
And it buys no truth: a render-time GET is stale by submit time, so the write
boundary must re-run the live preflight anyway (D065's post-claim preflight
makes this non-negotiable). Render-time live evidence is TOCTOU theater at
API-quota prices. The one legitimate live-read moment before mutation is the
ceremony itself, where the existing preflight already runs on the exact
target.

**Why this is the safest implementable contract:** (a) the freshness/engine/
governance gates become *one imported authority* (single constant, single
evaluation function) consumed by both the read model and
`runDecisionOriginAdExecutionPreflight`, so the two truths cannot drift —
enforceable by the contract test "served `executionReadiness ===
live_preflight_required` ⟺ deterministic-subset preflight blockers are empty
on identical inputs"; (b) it is the existing project doctrine applied to
freshness — D052 separates visibility from action authority, D059 separates
held verdict from buyer action; this separates *authorization* from
*execution readiness* the same way, and it instantiates field 3 of Codex's
own four-answer row model (verdict / evidence readiness / execution readiness
/ last provider outcome), which I adopt; (c) UI computes nothing (D005
preserved); (d) fail-closed defaults cover the unknowns (unreadable
governance, unparsable timestamps) instead of defaulting eligible.

## R3. First local implementation slice — confirmed, with exact contents and limits

The proposed slice is confirmed as the smallest globally applicable unit. Its
contents:

1. **Shared freshness authority.** Extract `MAX_DECISION_AGE_HOURS = 12` and
   a single `evaluateDecisionFreshness(computedAt, now)` (stale / future /
   unparsable ⇒ fail closed) into one module imported by *both*
   `lib/creative-decision-engine/execution-safety.ts` and
   `lib/meta/decisions-workspace-read-model.ts`. Read model: freshness
   failure ⇒ `actionEligible` stays decision-side but `executionReadiness:
   stale_decision`, served review-only with reason, and the served
   `authorizedAction` nulled per the existing
   `actionEligible ? authorizedAction : null` pattern (read-model:2372).
2. **Served freshness fields.** Per candidate: `decisionComputedAt`,
   `decisionAgeHours`, `maxDecisionAgeHours`, `executionReadiness`, blocked
   reason. Per workspace: the four clocks as separate named fields —
   warehouse cutoff, native generation computed-at/age, recommendation
   snapshot age (the current tile), provider-state observation age.
3. **UI clock separation.** The stale tile is relabeled as the
   recommendation-lane clock; exact-decision age renders beside every
   action row and in the drawer (computed-at, age, max age, blocker — Codex's
   drawer acceptance test); mutation CTAs gate on `executionReadiness`;
   stale/unknown freshness never renders in a positive tone.
4. **Effective kill-switch truth.** One helper
   (`resolveEffectiveMetaWriteAuthority(businessId)`) combining the env
   switch and `meta_automation_business_controls` (engaged if either says so;
   unreadable ⇒ fail-closed `governance_unavailable`), consumed by workspace
   `system`, the Automation page, and the preflight evidence builder. A
   missing controls row fails closed **at every write boundary** and serves
   an explicit "controls not configured" governance state on read surfaces —
   it must not blank decision *reading*, which stays governed by the serving
   contracts (this keeps the five row-less businesses readable while making
   them un-writable, which is also their factual state today).
5. **Tests.** The read↔preflight equivalence contract test; the nine Codex
   acceptance tests plus my P0-4/P0-8 fixtures: >12h authorized cut ⇒ blocked
   + disabled control; future/unparsable timestamp ⇒ blocked; fresh
   authorized decision ⇒ `live_preflight_required`, still approval-gated,
   reaching the unchanged preflight; rec-snapshot freshness cannot relabel
   exact-decision freshness; IwaStore (env off, DB switch on) ⇒ engaged
   everywhere; no-controls-row business ⇒ fail-closed write state; selected
   vs deselected account authorization tested separately; a static check
   that no UI component computes buyer action or execution readiness.
6. **Canonical docs.** One new ADR in `DECISION_LOG.md` (serving/presentation
   semantics + shared authority; no resolver-math change; no new decision
   core — AGENTS.md-conformant), plus an INVARIANTS.md addition: *"Served
   action eligibility must never exceed the deterministic subset of the
   execution preflight evaluated by the shared authority; no enabled mutation
   CTA may render for a decision older than the shared freshness maximum;
   `executable_now` is not a servable state."*

**What remains operational and cannot be proven by local code alone:** the
scheduler/cron revival and its root cause (host-level; U1); the
`meta_entity_state_history` retention decision and fence headroom (operator
decision on deleting pre-2020s history; the fence is at-budget *now*); proof
that the ordering-race fix works (needs live waves; the code change is local,
the acceptance evidence is 7 days of production generations); outcome-job
performance at production data volume (the 30s timeout is only reproducible
against the real table sizes); React #310 (needs the deployed bundle and
production error telemetry); the D068 natural-wave verification after
restart; and the two product decisions — TheSwaf-NonTesvik selection intent
and the Bilsem non-purchase-scope acknowledgment. Local code can make every
one of these *visible and fail-closed*; it cannot make them *true*.

## R4. Remaining disagreements

**None that would materially change implementation.** Two record-keeping
notes, both already handled above: (1) Codex C5's truth-label caution on the
Grandmix cause is superseded — in the retracting direction Codex asked for —
by the §4.5 ordering-race proof, and the reconciled backlog must carry the
race fix inside ingestion recovery; (2) Codex C6's narrowing of "the decision
core is sound" is adopted as the standing formulation. With those absorbed,
the two audit lines are in full agreement on facts, corrections, the P0
set, and the execution-readiness contract chosen in R2.

## No-mutation attestation (this round)

Verifying and responding to the Codex cross-review involved exactly one
SHA-256 computation and file read of the Codex artifact, plus this appended
section. No product code was edited, no database session was opened in this
round, no state of any kind was written outside this document, and no
provider/Meta call was made.
