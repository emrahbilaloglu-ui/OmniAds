# Meta Decision System — Independent Claude Audit — 2026-08-29

Operating class: **read_only**. Scope: Meta only; six businesses (IwaStore, Grandmix,
Bilsem Zeka, TheSwaf, IwaTR, ColorFullWorldsTR) from the persisted production
database plus the rendered UI. No product code was changed, no migration/seed/reset
ran, no DB row of the decision system was written, no Meta mutation was called, and
no ad object was touched. This report was produced independently, without reading
any Codex report.

---

## 1. Executive verdict

**Verdict: the decision core is honest and internally consistent, but the system
cannot manage Meta ads today, and it is not close to safe fully automatic
operation.** Confidence in this verdict: **high** on every database-side claim
(directly queried), **medium** on rendered-UI claims (verified on the current
`main` dev build against the production DB, not on the deployed binary).

Five findings dominate everything else:

1. **The entire Meta pipeline has been silently down for 7 days** (P0). The last
   sync partition and the last engine job run both finish at 2026-08-22 ~14:53 UTC;
   `meta_ad_daily` tops out at 2026-08-21; every audited business's newest native
   decision generation is 2026-08-22 (TheSwaf-NonTesvik: 2026-08-21). The durable
   sync worker is alive and heartbeating **today** (13:43 UTC, status `idle`) — so
   the external cron that POSTs `/api/sync/cron` stopped invoking, or the app-side
   handling of it broke. Nothing in the product raises an alarm for
   "no run at all": the workspace shows source health **"Healthy"** with a 7-day-old
   snapshot, and the only degradation signals are a passive stale-SLA banner and a
   "synced 7d ago" chip rendered in a **positive-tone** pill.
2. **The DB growth fence is breached again** (P0). `meta_entity_state_history` is
   5,368,750,080 bytes against a 5,368,709,120-byte (5 GiB) budget — **40,960 bytes
   over**. This is the exact recurrence of the 2026-08-17 incident documented in
   `lib/sync/db-growth-fence.ts`: at the ceiling, the fence refuses all Meta entity
   observation writes, the native decision job keeps "succeeding" with an incomplete
   observation manifest, and the Decision Center silently serves Creatives from the
   legacy path. The budget raise on 2026-08-18 assumed "~200 rows/day"; measured
   writes were **45,968–160,335 rows/day** in the following week. Even after the
   scheduler is revived, the first wave will re-enter fence refusal.
3. **Grandmix's five authorized actions are invisible to the operator** (P0
   consequence of #2). Grandmix's 2026-08-22 generation carries 3 authorized `cut`s
   ($2,794 of final-week spend, 22.1% of the account) and 2 authorized `scale`s,
   but serve-time bundle validation fails with `native_account_manifest_incomplete`
   and the workspace falls back to `legacy_creative · degraded`, which is
   review-only by contract. The fallback and its reason are displayed (honest), but
   the actionable decisions the engine produced cannot be seen or executed.
4. **The measurement loop has never closed on the native lane** (P0 for any
   automation claim). `engine_v3_ad_decision_outcomes_daily` contains **zero rows
   ever**; `engine_v3_ad_decision_outcomes_job` failed 360/360 recent attempts on
   30-second DB statement timeouts. The controlled-causal registries
   (`meta_controlled_experiments`, `_random_assignments`, `_control_estimates`) are
   all empty, so per D048 the eligible causal sample is structurally zero. Native
   hard-action precision/recall/ECE are unmeasured; automation eligibility is
   correctly fail-closed and factually unearnable today.
5. **The write path has never executed a decision** (core capability gap). All 92
   provider actions ever logged across the six businesses are `ui_manual`
   (last: 2026-07-06); zero have `native_decision_v1` origin; zero are
   `provider_verified`; the D067 attempt-journal tables have zero rows. The only
   executable native actions are **pause** (from Cut) and **resume** (from Scale).
   There is **no write path at all** for budget changes, bid changes, or refresh —
   the decisions with the most money attached are review-only by construction.

What not to do: do not open any automation tier, do not extend the engine's
authority, and do not add new decision surfaces until the pipeline runs again, the
fence has a retention decision, and the outcome job completes. Every one of those
is a repair of existing machinery, not new capability.

**Blockers to "operator no longer needs Meta Ads Manager": see §10 — nine
concrete dependencies remain, four of them structural (no write path exists).**

---

## 2. Method, evidence manifest, limitations

### 2.1 Skill binding

`/Users/harmelek/.codex/skills/emb-media-buyer/SKILL.md` was read completely from
disk. Computed SHA-256:

```
985754567f2ac07e3623d4bc91ce16b0421ac9e3295f3e842248305ec3cbd187   (MATCHES required value)
```

All task-relevant references were read completely. SHA-256 manifest:

| Reference | SHA-256 |
|---|---|
| evidence-and-decision-policy.md | caea7cb3ffee7dea0b082e94ae0bea8e47e84d007b2cf6f75e4a66e1056307af |
| data-quality-and-diagnosis.md | 4eabc9444747e7a97f7c0b3c4265a2250c9c12058237c410e4f2c7e617093987 |
| strategy-and-planning.md | 57c257b1b897041bcc2ab64993abacf60952bdd2ae1543bc250b271269d6dec5 |
| intake-and-unit-economics.md | e3e5a18443502ba6777757f9d0337082e15301612414a088c56bfc01c149388f |
| budget-pacing-and-scaling.md | 7705ce3e0da82b0983e95d641849b5ceacbccdf8bbcba75e0d968811c4fbc3e6 |
| measurement-and-experimentation.md | 75c88dec34c4e620544785dd93eabe29f1d517eaee89f18e02305a4cc145074d |
| creative-system.md | c44aadbe4481c8bc653470efc4b939f406895e3b3f234ab08e196e6a2115abf9 |
| platform-meta.md | 58f0ac97b6d95bf6b8a58f30fb5f26544cc2ba065a5b6daeb57ce269577ce6e7 |
| business-model-playbooks.md | 53d904f0def1e8c6717015fe1a8f344651b50a1a354366ff583a67a4823fb1de |
| operations-and-governance.md | e2c45b339231f5a1e5d197e8f32547dbf0f7ba8b36d3c4d994647c34472a7f83 |
| metric-dictionary.md | 1987999b7d51628cc59faf0856df08411547799f1c3f3edc6caaf8e34387523e |
| security-privacy-and-policy.md | fe61e4dc99aae7bb34f704868d8247d286290b87ca0494ef97c713cf65b71def |
| live-execution-safety.md | 0420070edfadff91607a397f2b0e967784d695d736c0dd79af528f78d8242a0e |
| platform-api-execution.md | b1e7b609aeee428b5e4dee8f2adfaf03e461b38b375eaad23e0617145b5e5300 |
| output-contracts.md | 0512e3e89fdbaad202df511fd87a3868e21b3692dbe4ddc066bbadd5b9e1d7aa |
| runtime-source-registry.md | 614a9de77ad53edf5d7d1b68c3968c8ed8faab1bcfaaffea1e0f9945e62d2d66 |
| contradiction-ledger.md | 49c2d8148fab4cd91b86342a11133d9101cc9c1574f2323c17844e3fe309e0dc |
| script-usage.md | b4a0b155829e4bd9cc917265cf1e44d41726c86274ffb5861ab734b0a6752073 |

Project contract read completely: `AGENTS.md`, `docs/creative-decision-center/
START_HERE.md` and its full canonical read order (CONTEXT_SNAPSHOT, DECISION_LOG
D001–D071, ARCHITECTURE, VOCABULARY_MAPPING, DATA_READINESS, GOLDEN_CASES,
INVARIANTS, CONTRACTS, EXPERIENCE_STATE_CONTRACT, MIGRATION_PLAN, PR_SEQUENCE,
RISK_REGISTER, OPEN_QUESTIONS).

### 2.2 Evidence freeze

- Git: branch `main`, HEAD `babf158e150fd33057117b39b175da044ac62d2e`, working
  tree clean, single worktree `/Users/harmelek/Adsecute`.
- Database: `adsecute_prod` (production), reached through the existing local SSH
  tunnel `127.0.0.1:15432 → :5432`. Every query ran in a session with
  `default_transaction_read_only=on`, `transaction_read_only=on`,
  `statement_timeout=30000`, `application_name=claude_independent_audit_2026-08-29`.
  Retrieval window: **2026-08-29 13:41–14:20 UTC**.
- Snapshot coherence: queries were separate read-only sessions, not one
  `REPEATABLE READ` transaction, so cross-query drift is possible in principle.
  In practice the decision layer is frozen (no producer has written since
  2026-08-22), and exactly **one** drift event was observed and is labeled:
  `meta_automation_proposals` row created 2026-08-26 read as `pending` at ~13:52
  UTC and as `expired` at ~14:12 UTC (its `expires_at` was already 2026-08-27; the
  status flip is lazy bookkeeping, plausibly triggered by the audit's own read of
  the Automation page).
- Rendered UI: current `main` served by the local dev server (`npm run dev`)
  against the production DB through the tunnel, with a temporary local admin
  session created through the product's own passwordless local-login mechanism
  (`DEMO_USER_EMAIL` override on `/api/auth/demo-login`). Desktop (1440×900
  emulated) and narrow/mobile layouts were both inspected. **Limitation:** this is
  the dev bundler rendering of HEAD, not the deployed production image; server
  contracts (JSON payloads) are the same code path, but visual/build differences
  with the deployed release are possible.

### 2.3 Truth labels used

Claims below are labeled `[fact]` (directly observed in DB/code/UI at retrieval
time), `[derived]` (arithmetic from named inputs, formula shown), `[inference]`
(best explanation, rivals named), or `[unknown]`.

---

## 3. Six-business identity and data table

All rows `[fact]` from `businesses`, `business_provider_accounts`,
`provider_accounts`, `business_target_packs`, `meta_ad_daily`,
`engine_v3_ad_decision_snapshots_daily`, `integration_credentials` at 2026-08-29.

| Business (uuid prefix) | Meta account | Acct currency / tz | Target pack (tROAS / BE-ROAS / posture, updated) | Newest fact day | Newest native decision gen | Final-week spend (acct ccy) | Latest-gen rows / active-ad rows | Cred. expiry stamp |
|---|---|---|---|---|---|---|---|---|
| IwaStore (f8a3b5ac) | act_1087566732415606 IWA-MDNLLC | USD / America/Los_Angeles | 3.5 / 2.7 / balanced, 2026-08-13 | 2026-08-21 | 2026-08-22 | 2,167 | 1,042 / 63 | stamped expired 2026-06-02 (false; syncs succeeded to 08-22) |
| Grandmix (5dbc7147) | act_805150454596350 | USD / America/Anchorage (business tz says America/Los_Angeles — mismatch) | 2.2 / 1.8 / conservative, 2026-05-10 | 2026-08-21 | 2026-08-22 | 12,658 | 2,529 / 80 | stamped expired 2026-06-13 (false) |
| Bilsem Zeka (6c690fa4) | act_840779107261785 | TRY / Europe/Istanbul (business tz null) | 3.0 / 2.0 / balanced, 2026-04-22 — **purchase targets on a largely non-purchase account** | 2026-08-21 | 2026-08-22 | 121,613 TRY | 3,204 / 145 | stamped expired 2026-06-13 (false) |
| TheSwaf (172d0ab8) | act_822913786458311 Main (selected) + act_921275999286619 NonTesvik (assigned, **unreachable in product**) | USD / America/Chicago (business tz America/New_York — mismatch) | 2.0 / 1.71 / aggressive, 2026-07-17 | 2026-08-21 | 08-22 (Main) / 08-21 (NonT) | 15,497 + 1,017 | 876 / 52 | token refreshed 2026-08-21 |
| IwaTR (b79683b4) | act_2335220976649516 IWA-TR | USD / Europe/Istanbul (business tz null) | **NO TARGET PACK — no commercial authority possible** | 2026-08-21 | 2026-08-22 | 417 | 172 / 54 | stamped expired 2026-06-21 (false) |
| ColorFullWorldsTR (bc0c6178) | act_3554615364751964 | USD / Europe/Istanbul (business tz null) | 4.0 / 3.0 / balanced, 2026-05-20 | 2026-08-21 | 2026-08-22 | 473 | 414 / 18 | stamped expired 2026-06-21 (false) |

Data-quality per business `[fact]`: all `meta_ad_daily` rows since 2026-07-21 are
`truth_state=finalized`, `validation_status=passed`, non-null `finalized_at`; zero
missing days in the trailing 28 for TheSwaf-Main (spot-checked); ad-grain sums
reconcile **exactly** to `meta_account_daily` (TheSwaf-Main final week: spend
15,497.00 = 15,497.00; revenue 20,720.13 = 20,720.13). No spending ad lacks an
observed status. All target packs are `settings_manual_entry` with only ROAS
anchors — no `target_cpa`, no AOV assumption, no contribution margin, no cost
fields — so the spend-unit precedence always falls through to physical-account
AOV, and break-even quality is operator-asserted, never reconciled in-product
(§8.1).

---

## 4. Inventory and lineage

### 4.1 Decision producers and stores (Meta)

`[fact]` — every layer below exists in the production DB and/or at HEAD.

| Layer | Producer / table | State at audit |
|---|---|---|
| Daily facts | authoritative insights sync → `meta_ad_daily` / `meta_adset_daily` / `meta_campaign_daily` / `meta_account_daily` (writeMode `authoritative_fact`, D066) | frozen at day 2026-08-21 |
| Entity state | observation runs → `meta_entity_state_history` (+`meta_entity_observation_runs`) | frozen 2026-08-22; **table over fence budget** |
| Campaign context | `engine_v3_campaign_context_job` → `engine_v3_campaign_context_daily` | frozen 2026-08-22; all rows `system_inferred`, zero user overrides across all six |
| Native Ad decisions (canonical serving authority, D062) | `engine_v3_native_ad_decisions_shadow_job` → `engine_v3_ad_decision_snapshots_daily` + evaluations/contexts/events, epoch `v3-ad-2026-07-18-decision-presentation-hardening-shadow` | frozen 2026-08-22 |
| Legacy creative decisions (compat, review-only) | `engine_v3_decisions_job` → `engine_v3_decision_snapshots_daily` | still co-produced daily until 2026-08-22 (1,544 rows on the last day) |
| Native calibration | `engine_v3_native_ad_calibration_shadow_job` → `engine_v3_ad_account_calibration_daily`/`_batches` | frozen 2026-08-22 |
| Native outcomes | `engine_v3_ad_decision_outcomes_job` → `engine_v3_ad_decision_outcomes_daily` | **zero rows ever; job fails 100% on DB timeouts** |
| Legacy outcomes | `engine_v3_decision_outcomes_job` → `engine_v3_decision_outcomes_daily` | 72,865 rows through 2026-08-22 (observational classifier) |
| Structure recommendations | recommendation engine `v1.2.0-target-age-advisory` → `meta_decision_snapshots_daily` | wrote 2026-08-24 (IwaStore) and 2026-08-26 (Bilsem) — serve-time/visit-driven activity after the scheduler stop `[inference]` |
| Automation control plane | `meta_automation_business_controls` (1 row: IwaStore kill switch ENGAGED), `_proposals` (4 ever, all expired unapproved), `_rules` (0), `_decision_type_modes` (0), `_promotion_records` (0 via UI) | Tier 1 supervised, dry-run only |
| Controlled-causal registries (D048) | `meta_controlled_*` | all empty → causal sample structurally zero |
| Provider writes | `meta_ads_action_log` + D067 journals (`meta_ads_action_mutation_attempt_events`, `_reconciliation_events`, duplicate journals) | 92 manual rows (last 2026-07-06); journals 0 rows; `engine_v3_ad_operator_action_receipts` 0; `engine_v3_ad_recommendation_episodes` 0; `meta_launch_intents` 0 |

### 4.2 primaryDecision vs buyerAction, and action states

The persisted chain (D056) is fully populated on native rows:
`pre_authority_label → authority_blocker → raw_label → label`, plus
`blocked_action_type` and `authorized_action`. Serve-time projections (D035/D059)
convert held actions to `decisionState: blocked` with `buyerAction: null` and a
server resolution — verified live in the workspace JSON for IwaStore (a held cut
serves `sourceAuthority.actionEligible: false`,
`reviewOnlyReason: served_decision_is_not_actionable`, `authorizedAction: null`).

Action-state ladder observed in the wild:

- **recommended** — 8,237 native rows in the six latest generations; 14 carry
  `authorized_action`.
- **intent / accepted / attempted / provider-confirmed / reconciled / reverted** —
  **zero instances ever** on the decision-origin path (no `native_decision_v1`
  write has ever run). The manual path has 92 attempts: 58 success, 29 failure,
  5 `silent_failure`; `provider_verified` is false on every row (all predate the
  verification-lineage contract).
- **stale** — every served decision today (7-day-old generation).
- **ambiguous** — 5 legacy `silent_failure` rows (1 IwaStore pause 2026-05-18,
  2 TheSwaf launch_ad, 2 TheSwaf duplicate). Per D065/D069 these are
  retry-blocking for their exact Ads until reconciliation; the reconciliation
  sweep has never recorded an event (journal tables empty). `[fact]`

### 4.3 Duplicate/conflicting cores and silent-fallback surfaces

- Two decision lanes still co-produce daily (native ad-grain + legacy
  creative-grain). Serving is fail-closed to the native bundle (D062), with the
  legacy lane as an explicitly labeled degraded fallback. Observed live: Grandmix
  serves the legacy lane **today** (§5.4). Not a hidden second core, but a live
  dual-core coexistence with different grains.
- A third vocabulary ships on the Structure lane (recommendation engine
  `v1.2.0`): its latest snapshots still emit **"Label this campaign as Main,
  Test, or Mixed before taking hard action"** (Bilsem 08-26 ×2, ColorFull 08-22
  ×2, IwaStore 08-24 ×10) — the manual-labeling ask that D033/D050 explicitly
  removed. Two surfaces disagree about whether labeling is required. `[fact]`
- Demo/fixture behavior: the six audited businesses are all `is_demo=false`; no
  demo leakage was found in their serving paths. The known D071 canonical-page
  posture gap remains open but touches only the demo business.
- Cross-business leakage: zero ads appear under more than one business
  (`inv5` below). One shell-level smell: after switching business, the topbar
  status chip issued `/api/meta/status` for the **previous** business id in the
  same page load `[fact, dev build]` — presentation-only, but a mixed-scope read.

---

## 5. Quantitative audit

Reproduce-note: every count below can be re-run read-only; representative SQL is
included. All decision-layer numbers are stable while the pipeline is frozen.

### 5.1 Coverage checksum (latest generation per account, current epoch)

Expected = rows of the newest `as_of_date` per account under engine
`v3-ad-2026-07-18-decision-presentation-hardening-shadow`. Observed = same query
grouped by label. Unique keys verified (inv4 = 0 duplicates). Missing = 0;
Duplicates = 0.

| Business | Rows | diagnose | out_of_scope | test_more (plain) | keep (plain) | held (blocked_action_type≠null) | authorized |
|---|---|---|---|---|---|---|---|
| Bilsem Zeka | 3,204 | 1,081 | 2,007 | 105 | 10 | 1 | 0 |
| ColorFullWorldsTR | 414 | 388 | 10 | 12 | 4 | 0 | 0 |
| Grandmix | 2,529 | 2,335 | 139 | 32 | 13 | 5 | 5 (3 cut, 2 scale) |
| IwaStore | 1,042 | 945 | 40 | 36 | 10 | 11 | 0 |
| IwaTR | 172 | 109 | 0 | 57 | 5 | 1 | 0 |
| TheSwaf (2 accts) | 876 | 766 | 24 | 37 | 6 | 34 | 9 (cut) |
| **Total** | **8,237** | **5,624 (68.3%)** | **2,220 (27.0%)** | **279** | **48** | **52** | **14 (0.17%)** |

```sql
-- coverage + label distribution (per business, newest generation)
WITH latest AS (
  SELECT business_ref_id, provider_account_id, MAX(as_of_date) AS d
  FROM engine_v3_ad_decision_snapshots_daily
  WHERE engine_version='v3-ad-2026-07-18-decision-presentation-hardening-shadow'
  GROUP BY 1,2)
SELECT b.name, s.label, s.pre_authority_label, s.authority_blocker,
       s.blocked_action_type, s.authorized_action, COUNT(*)
FROM engine_v3_ad_decision_snapshots_daily s
JOIN latest l USING (business_ref_id, provider_account_id)
JOIN businesses b ON b.id=s.business_ref_id
WHERE s.as_of_date=l.d AND s.engine_version='v3-ad-2026-07-18-decision-presentation-hardening-shadow'
GROUP BY 1,2,3,4,5,6;
```

The `diagnose` wall is dominated by **"[Ad metrics unavailable - fail closed]"**
rows — inventory ads with no insights row on the as-of day (overwhelmingly
inactive). On **active** ads the picture is far healthier (412 active-ad
decisions): Bilsem 85 test_more / 48 out_of_scope / 10 keep / 2 diagnose;
Grandmix 33 test_more / 27 diagnose / 15 keep / 3 cut / 2 scale; IwaStore 36
test_more / 13 keep / 5 diagnose / 4 held-scale / 4 held-cut / 1 oos; IwaTR 48
test_more / 4 keep / 2 diagnose; TheSwaf 30 test_more / 10 keep / 8 cut / 4
diagnose; ColorFull 11 test_more / 4 keep / 3 diagnose. Grandmix's 27 active
diagnose rows are all metrics-unavailable fail-closed (zero snapshot spend) —
recently created ads never observed with insights `[fact]`; launch blindness for
new ads is guaranteed while the pipeline is down.

### 5.2 Spend-weighted decision coverage (final observed week, per account currency)

The decision-relevant view: how much money each label governs
(`meta_ad_daily` 2026-08-15..21 joined to the latest decision per ad).

| Business | Label / blocker | Ads | Spend | Share |
|---|---|---|---|---|
| Bilsem Zeka (TRY) | keep | 9 | 62,110 | 51.1% |
| | test_more | 78 | 31,526 | 25.9% |
| | **out_of_scope (non-purchase)** | 33 | **27,977** | **23.0%** |
| ColorFullWorldsTR | keep | 4 | 353 | 74.6% |
| | diagnose · native_profile_unavailable | 3 | 92 | 19.4% |
| Grandmix | keep | 15 | 8,358 | 66.0% |
| | **cut (authorized, invisible — §5.4)** | 3 | **2,794** | **22.1%** |
| | scale (authorized, invisible) | 2 | 519 | 4.1% |
| | held cut (recent_recovery_unverifiable) | 3 | 273 | 2.2% |
| IwaStore | **scale held · campaign_context** | 4 | **1,144** | **52.8%** |
| | test_more | 26 | 505 | 23.3% |
| | keep | 3 | 458 | 21.1% |
| TheSwaf | **cut (authorized, served)** | 9 | **8,422** | **51.0%** |
| | keep | 8 | 6,751 | 40.9% |
| IwaTR | keep | 5 | 256 | 61.3% |
| | test_more | 56+1 | 161 | 38.5% |
| | (no decision row) | 3 | 1 | 0.2% |

Three business-defining facts fall out `[derived]`:

- **IwaStore: 52.8% of live spend sits under a held Scale** blocked by
  `campaign_context` — four winner ads at ROAS 5.25–7.72 vs target 3.5 in the
  "CATALOG ACQ COSTCAP" campaign whose inferred context is `main/high (0.67)`.
  The block is D050's closed hard-authority gate (high-confidence inferred
  context is consumed as medium because the H11 classifier never passed its
  locked gate). The documented unlock — an explicit operator correction — is
  available in the UI ("Manage labels"), but nothing signposts it: the header
  shows **"LABELS 5/5 100%"**, which reads as "nothing to do here".
- **TheSwaf: 51.0% of live spend is under authorized Cut** and the workspace
  actually serves 4 of them as executable ACT rows — the one place the full
  chain works end to end (minus outcome measurement and minus the second
  account).
- **Bilsem: 23% of live spend (≈28k TRY/week) is `out_of_scope` by design** —
  the ads optimize for non-purchase outcomes. Historical ad-set optimization
  goals for Bilsem: Offsite Conversions 216, **Conversations 182, Lead 32,
  ThruPlay 10, App Installs 8** `[fact]`. The engine is purchase-ROAS-only
  (D053); for this business the "Advisor" is structurally silent on a large,
  permanent share of what the operator manages daily.

### 5.3 Invalid-state and integrity sweep (entire native table, all epochs)

```sql
SELECT
 (SELECT COUNT(*) FROM engine_v3_ad_decision_snapshots_daily
   WHERE authority_blocker IS NOT NULL AND authorized_action IS NOT NULL),           -- inv1: 0
 (SELECT COUNT(*) FROM engine_v3_ad_decision_snapshots_daily
   WHERE blocked_action_type IS NOT NULL AND authorized_action IS NOT NULL),         -- inv2: 0
 (SELECT COUNT(*) FROM engine_v3_ad_decision_snapshots_daily
   WHERE label IN ('scale','cut','refresh') AND authorized_action IS NULL
     AND authority_blocker IS NULL AND blocked_action_type IS NULL),                 -- inv3: 0
 (SELECT COUNT(*) FROM (SELECT business_ref_id,provider_account_id,ad_id,as_of_date,
   engine_version FROM engine_v3_ad_decision_snapshots_daily
   GROUP BY 1,2,3,4,5 HAVING COUNT(*)>1) d),                                        -- inv4 dup keys: 0
 (SELECT COUNT(*) FROM (SELECT ad_id FROM engine_v3_ad_decision_snapshots_daily
   GROUP BY ad_id HAVING COUNT(DISTINCT business_ref_id)>1) x),                      -- inv5 cross-biz: 0
 (SELECT COUNT(*) FROM engine_v3_ad_decision_snapshots_daily
   WHERE evaluation_id IS NULL);                                                     -- inv6: 0
```

**All six invariants hold at zero violations across the full table** `[fact]` —
including "blocker implies no authorized action" (D057) and evaluation linkage.
Additionally: zero authorized cuts anywhere have stored ROAS at/above their
business's current break-even (D049/D063 economics invariant holds); lifetime
authorized actions total 237 (217 cut, 20 scale, **0 refresh — refresh has never
been authorized in the system's entire history**).

### 5.4 The serve-time picture per business (live API, 2026-08-29)

`GET /api/meta/decisions-workspace` per account `[fact]`:

| Account | Serving authority | Fallback reason | act / blocked / monitor (ad candidates) |
|---|---|---|---|
| IwaStore | native_ad · available | — | 0 / 7 / 29 |
| Grandmix | **legacy_creative · degraded** | **native_account_manifest_incomplete** | 0 / — / — (22 review-only rows; 2 held cuts + 20 "Evidence pending" ACTIVE ads) |
| Bilsem Zeka | native_ad · available | — | 0 / 1 / 80 (59 selected) |
| ColorFullWorldsTR | native_ad · available | — | 0 / 7 / 11 |
| IwaTR | native_ad · available | — | 0 / 4 / 52 |
| TheSwaf-Main | native_ad · available | — | **4** / 3 / 8 |
| TheSwaf-NonTesvik | **HTTP 403 `provider_account_not_assigned`** | — | unreachable, despite an assignment row (`is_selected=false`), $1,017 final-week spend, and nightly decision generations of its 126 ads |

Grandmix root cause `[inference, strongly supported]`: the generation's job
receipts match snapshot counts (2,529 = 2,529), so the incompleteness is the
observation/hydration manifest — the same-day complete ad observation run —
which is exactly what the growth fence refuses when `meta_entity_state_history`
is at budget (the mechanism is documented verbatim in `db-growth-fence.ts` for
the 2026-08-17 recurrence, and the table is over budget again now). Cheapest
discriminator: the hydration job's `error_json`/source receipts for Grandmix's
08-22 run.

The engine-wide census across all served accounts: **exactly 4 actionable ad
decisions exist in the entire product today** (all TheSwaf cuts), against ~$150k+
of monthly managed spend across six businesses.

### 5.5 Outcome evidence (what exists is legacy-lane, observational)

Native lane: zero rows `[fact]`. Legacy creative lane (through 08-22), realized
outcomes by hard label, all businesses `[fact]`:

| Label | positive | negative | neutral | unknown | known-negative share |
|---|---|---|---|---|---|
| cut | 147 | 71 | 10 | 432 (65%) | 31% of known |
| scale | 37 | 30 | 9 | 15 | **39% of known** |

Per audited business, Grandmix scale: **9 negative / 2 positive / 1 neutral**;
TheSwaf scale: 16 negative / 14 positive. `[fact]` These are observational
classifier outputs (no counterfactual, regression-to-mean uncorrected — D048's
point), but they are the only outcome evidence in the system, and they do not
support "the scale gate makes money" on these accounts. The unknown/censoring
rate (65% of cuts) additionally caps what even observational review can say.

### 5.6 Job health at the stop point

- `engine_v3_ad_decision_outcomes_job`: 360 failures / 0 successes since
  2026-08-15 — `Database query timed out after 30000ms` and statement-timeout
  cancellations `[fact]`.
- `engine_v3_native_ad_operator_response_shadow_job`: 956 failures vs 1,193
  successes in the same window; failure causes include the timeouts **and a
  production schema bug — `column "business_ref_id" does not exist` ×138**
  `[fact]`.
- Sync tail on 08-22 (before the stop): 13,505 succeeded runs, 693 cancelled,
  51 lease conflicts, 12 quota, **3 invalid_token ("the user changed their
  password")**, 3 dead-letter partitions `[fact]`.
- The five stamped-expired `token_expires_at` values (June dates) are the
  product's own stamps and demonstrably false — syncs succeeded through 08-22.
  One credential row was updated 2026-08-26 06:16 (post-stop operator activity).

---

## 6. Recalculations and counterexamples

### 6.1 Authorized cut reproduces from raw facts `[derived]`

TheSwaf `120251381050900042` (authorized cut, confidence 75): stored tuple
spend 4,745 / purchases 45 / ROAS 1.64 / recent7d 1.54, reason "[economic
stop-loss] … below explicit break-even".

Recomputed from `meta_ad_daily` (28d = 2026-07-25..08-21):
`spend = 4,745.36; purchases = 45; revenue = 7,793.48; ROAS = 7,793.48 / 4,745.36
= 1.642` — **matches**. Recent-7d recompute (08-15..21) = 1.381 vs stored 1.54:
window-boundary difference (the producer's cutoff-relative week vs my calendar
week), not a math error.

**Counterexample-grade critique (skill rule 6):** with 45 purchases the Poisson
relative SE is `1/√45 = 14.9%`; the ROAS interval ≈ 1.64 × exp(±1.96·0.149) →
[1.22, 2.20] **brackets break-even 1.71**. The stored copy "clear loser at
scale" overstates what the design can distinguish; the recent-7d confirmation
(1.54 < 1.71) and the D036 two-evaluation confirmation partially compensate, and
the action (pause one ad, reversible, aggressive posture) is proportionate — but
confidence 75 with "clear" phrasing is above the evidence ceiling for the two
cuts sitting within one SE of break-even (this ad, and TS_R5_RTG_INTL at 1.69
held pending). The clearly-below cuts (ROAS 0.47–1.39) are economically solid.

A thinner case: TheSwaf `120244829399580430` — cut authorized on **1 purchase**
($269 spend, ROAS 0.47, confidence 45). Loss-budget maturity (spend ≥ 164)
substitutes for sample depth here; even at 3 purchases the ROAS could not
plausibly reach 1.71, so the direction survives, but "cut on n=1" should be
recognized as a loss-budget stop, not a performance ranking — the copy says so
("loss-budget maturity reached"), which is correct.

### 6.2 Authorized scale reproduces `[derived]`

Grandmix `120249371638060316` (authorized scale): stored 663 / 9 purchases /
ROAS 3.74 / recent7d 9.38. Recomputed 28d: 673.26 / 9 / 3.69 (boundary shift);
7d: 171.33 / 2 / 7.45. Reproduces. Media-buyer note: 9 purchases → RSE 33%;
recent-7d "holding at 9.38" rests on ~2 purchases. The engine's own winner
benchmark and recent-hold gates passed, but marginal-response evidence is absent
by construction (average ≠ marginal; skill §3), and the historical scale
outcome record on this account is 9-negative-of-12 (§5.5). A staged +10–15%
budget move with a preregistered reversal — which is what the Structure lane
suggests separately — is the defensible ceiling here; "scale" as resume-only
execution is toothless anyway (§9).

### 6.3 The pulse "pacing" block is circular `[derived]`

IwaStore pulse (served): `mtdSpend 5,317.15; dailyTarget 241.688; mtdTarget
7,250.66; dayPace 0.733`. Arithmetic: `5,317.15 / 22 elapsed days = 241.688`;
`241.688 × 30 = 7,250.66`; `22/30 = 0.733`. The "target" is the realized MTD
average projected to 30 days — **the plan is derived from the actual, so pace
always reads ~on-plan**. No budget-plan table exists to anchor it. Under the
skill's pacing contract this is not pacing; it is elapsed-time restated, and the
`dayPace 0.73` will read as "behind" purely because August has 31 days. P1.

### 6.4 Kill-switch display contradicts the persisted switch `[fact]`

`meta_automation_business_controls` has IwaStore `kill_switch_engaged = true`
(set 2026-08-13, tier `manual_review`, auto-exec false). The Decisions-workspace
`system.killSwitchEngaged` is computed from `process.env.META_ADS_WRITE_KILL_SWITCH`
only (`route.ts:632`) and served **false** for IwaStore. Two switches with
different authorities; the workspace displays the wrong one for the business
context. (The Automation page reads the control plane and shows the per-business
switch correctly.) P1: a governance-truth display defect on the primary surface.

### 6.5 Growth-fence arithmetic `[fact]`

`pg_total_relation_size('meta_entity_state_history') = 5,368,750,080` ≥ budget
`5 GiB = 5,368,709,120` → the fence's refusal condition is met **now**. Write
volume 2026-08-16..22: 45,968 / 79,069 / 10,298 / 112,600 / 115,294 / 160,335 /
88,876 rows/day — vs the "~200 rows (~220 KB) a day" premise in the 2026-08-18
budget raise. The runaway the fence guards against is present, not absent; the
retention decision the code defers to the operator is now due.

---

## 7. Rendered UI

Method: §2.2. Surfaces inspected: Decisions workspace (IwaStore mobile-width,
Grandmix desktop, TheSwaf desktop incl. Creatives ACT/BLOCKED/MONITOR lanes),
Automation (TheSwaf), History (TheSwaf), Creative Studio (TheSwaf), Overview
(demo business shell), plus per-business workspace JSON for all six accounts.

**What is genuinely strong** (and better than most of this market):

- Every decision row carries window, denominator, threshold, provenance, and an
  explicit next step ("ROAS 1.39 (28d) = 70% of commercial target, below explicit
  break-even, after 6,496 spend (28d)… Recent 7d ROAS 1.09 remains below
  break-even 1.71 on 2,444 recent spend" / "Pauses this exact ad only").
- Held/pending states are honest: "No hard action is published until this signal
  repeats on the next evaluation", "The held Scale/Cut/Refresh verdict is
  visible, but no provider action is authorized yet".
- Source authority is disclosed with table, engine epoch, job run id, manifest
  hash, expected-ad count, coverage, omission counts, capability gaps
  (`provider write linkage: unavailable — native_action_receipt_not_observed`),
  and limitation codes. The Grandmix degraded fallback is labeled with its exact
  reason. Money copy uses the account currency; absent values render as "—".
- Staleness is stated ("snapshot 2026-08-22", "Stale · 178.16h old", stale-SLA
  banner), and "Open Meta Ads Manager… Nothing here is executed" draws the write
  boundary correctly. The Automation page correctly refuses to claim an empty
  proposal queue when it cannot count it.

**Defects found (beyond §6.3/§6.4):**

1. **Outage reads as health.** During a 7-day total outage: source health
   "Healthy" (IwaStore), topbar chip "Synced 7d ago" in a positive-tone pill,
   data-readiness banner says warehouse data "is still being prepared" (implies
   progress that is not happening), and `dataReadiness.status: "ok"` co-exists
   with `isPartial: true` + a not-ready reason in one tuple. Nothing pushes an
   alert; every signal is passive and visit-dependent. (ESC's own "absence of
   evidence must never be presented as benign" rule, violated in tone if not in
   copy.)
2. **Grandmix operator dead end.** The Creatives lane shows 22 blocked rows, of
   which 20 are "Evidence pending — complete the native Ad decision schema and
   producer lineage gate" — correct internally, but the operator has no
   actionable remedy on-screen, and the five authorized decisions the engine
   already computed that same day are nowhere. During an incident the page's
   honest fallback amounts to "the advisor has no advice about the majority of
   your live spend".
3. **Structure lane still demands manual labels** ("Label this campaign as Main,
   Test, or Mixed before taking hard action" on latest snapshots of 3
   businesses) — contradicts D050 and the Decisions lane's automatic-context
   presentation. Same product, two doctrines.
4. **IwaStore's unlock is unsignposted** — "LABELS 5/5 100%" while 52.8% of
   spend is scale-held on context authority that one explicit correction would
   release (§5.2).
5. **TheSwaf-NonTesvik**: picker omits the account; workspace 403s it as "not
   assigned" while nightly decisions exist for it and it spends ~$1k/week —
   either the `is_selected` semantics are wrong at the read boundary or the
   product genuinely does not support 2-account businesses; either way the
   answer given ("not assigned") contradicts the DB. `[fact]`
6. Client fires the identical workspace GET 4× per page load `[fact, dev]`;
   the workspace request needs ~20–40s against the tunnel (dev-bundler inflated,
   but the fan-out is real).
7. Minor: `prev` comparison values served as 0 for spend/revenue (renders as
   meaningless deltas); scope band renders `Freshness: source unknown` while
   banners say stale; anomaly card "Sudden ROAS drop" uses a headline as its
   `recommended_action` text.

**Coverage note:** IwaTR and ColorFull UIs were verified via server JSON only;
Launchpad was not walked end-to-end (no writes permitted); mobile deep-pass was
limited to IwaStore. The known D071/canonical-page demo-posture gap was not
re-verified beyond code/doc reading.

---

## 8. Media-buyer quality judgment

### 8.1 Economics and target provenance

The engine consumes exactly the operator-entered ROAS pair per business
(`settings_manual_entry`); action-specific anchors are correctly enforced (scale
needs tROAS, cut needs BE-ROAS — IwaTR with no pack correctly produces zero hard
actions ever; AR-001..003 behavior confirmed in data). But:

- Break-even quality is **unverifiable in-product**: target packs carry no
  margin/AOV/cost inputs, the decision engine does not read the cost model
  (verified non-consumer in ESC Phase B), and no reconciliation ties BE-ROAS to
  Shopify/margin truth. If TheSwaf's 1.71 is wrong, every cut boundary is wrong
  with it, at full confidence. The system is *internally* rigorous about an
  *externally* unvalidated number.
- **Three-ledger separation does not exist in the decision path.** All decisions
  run on Meta-attributed 28d revenue (7d-click-1d-view era semantics as synced);
  no refunds/returns netting, no advertiser-owned outcome joins, no
  incrementality ledger (controlled registries empty). MER/blended views exist
  elsewhere (Overview) but never gate a Meta decision. For pause-level stop-loss
  this is acceptable; for scale it is exactly the "average attributed ROAS"
  trap the skill forbids — mitigated only by the fact that scale execution is
  currently inert.
- Comparability & lag: windows are cutoff-disciplined (D043) and the recovery
  gate demands recent evidence below/above BE with a sample threshold — good.
  Purchase-lag (attribution tail) is not modeled in the recent-7d window; a
  1-day-view/7-day-click tail can flip a marginal recent read; the engine's own
  hysteresis (D036) is the de-facto lag buffer. Adequate for pause; thin for
  scale.
- Timezone/currency: per-account currency discipline is real (TRY renders as
  TRY); but business-vs-account timezone mismatches exist for Grandmix
  (LA vs Anchorage) and TheSwaf (NY vs Chicago) `[fact]` — day-boundary skew
  risk for "today/24h" claims; the UI's "SPEND · TODAY —" honestly shows nothing
  today, so no live harm observed.
- Threshold provenance: the core engine is account-calibrated (P25/P75, winner
  benchmarks, loss budgets) with recorded origins — genuinely good. The
  **Structure/recommendation lane** is the weak sibling: "10–15% budget",
  "3–5 days", "Test Cost Cap instead of…" are house heuristics served without
  origin/approval metadata (practitioner-heuristic tier presented as advice),
  and its bid "bands from history" are descriptive ranges without uncertainty.

### 8.2 Do the decisions make money sense?

- The 14 authorized decisions all reproduce from stored facts and are
  economically directionally right; 12 of 14 are stop-losses below explicit
  break-even at real spend depth. Two cuts sit within sampling noise of BE
  (§6.1) — defensible as reversible risk control, overconfident as worded.
- The two Grandmix scales pass every internal gate but rest on 7–9 purchases,
  an account with 9-of-12 negative historical scale outcomes, and no marginal
  evidence; their real-world execution path (resume) cannot even express the
  intent. Scale is the engine's weakest product claim.
- The dog that does not bark: **Grandmix account ROAS 2.00 vs target 2.20 and
  TheSwaf 1.28 vs 2.00 at pulse level** while lane counts say "Action Now 0 /
  Healthy 0" on the Campaigns tab. Account-level underperformance has no
  first-class decision anywhere — decisions are per-ad and per-adset; the
  portfolio question ("this account is 36% below target — reallocate or
  restructure what?") is answered only by watch-tier prose recommendations.
- Fatigue/refresh: the discipline (pressure + decay, disjoint windows) is
  correct per D037, and its consequence is visible: refresh has **never** been
  authorized. Combined with `FATIGUED SPEND SHARE 0%` and `REFRESH PIPELINE 0`,
  the creative-rotation muscle of the product is, in effect, decorative today.

---

## 9. Automation readiness — decision-by-decision classification

Substrate facts: origin contracts (D065), claim locks, attempt journal (D067),
duplicate journal (D069), idempotency-key reconstruction, live preflight, and
verification lineage all exist **in code**; none has ever run in production
(zero journal rows). Outcome/causal evidence: zero (native), observational-only
(legacy). Controls: Tier-1 supervised, "Approvals reach Meta: No — dry run
only", 0 rules, 0 promotion records; proposals expire in ~24h and all 4 ever
raised died unapproved. Kill switch: env-level off; IwaStore business-level ON.

| Decision type | Write path | Classification today | What would move it |
|---|---|---|---|
| Ad **cut → pause** (exact-Ad, native) | exists (never exercised) | **Approval-gated** (the only candidate) — and *hold* until the pipeline runs and outcomes accrue | pipeline recovery; outcome job fixed & ≥1 lag-complete window; first supervised executions with receipts; then D048 controlled evidence for any auto-tier |
| Ad **scale → resume** | exists, semantically near-empty (resume of an active ad is a no-op) | **Shadow-only** | real budget-scale write path (adset budget), which today does not exist |
| Ad **refresh** | none | **Unsupported** | never authorized in history; creative-rotation loop unbuilt |
| Campaign/adset **budget & bid changes** | none (`review_drill` by D052; historical `execute_*` normalized to review) | **Unsupported** | an immutable decision-origin contract at those grains + a write path + preflight |
| **Launch / duplicate** | Launchpad manual (20/10/20 caps; `reuse_creative` only; no auto-retry; `rebuild_creative` review-only) | **Approval-gated manual by design** ("new spend never automates" — correct) | n/a (keep manual) |
| Aggregates / brief_variation etc. | deny-by-default (D024) | **Shadow-only** | family/supply data readiness |
| Non-purchase objectives (Bilsem's Conversations/Lead/ThruPlay) | no decisions at all | **Unsupported** | goal-specific commercial anchors + calibration (D039 boundary) |

**Safe-to-automate-now: nothing.** This is not a judgment call; it is the
system's own contract (D048: zero eligible causal sample) agreeing with the
evidence (zero outcome rows, zero receipts, sub-50% precision unknown).

**Specified path to the first live write (later approval packet + staged canary):**

1. Recover the scheduler; verify a natural 03:00Z wave per D068's verifier.
2. Resolve the fence (retention decision on `meta_entity_state_history` —
   3.76M rows back to 2020 — or a justified budget with measured write-rate).
3. Fix `engine_v3_ad_decision_outcomes_job` timeouts (it is a query-shape
   problem: 30s statement timeout; same family as the earlier 258s→6s fix) and
   the operator-response `business_ref_id` schema bug; accrue ≥14 days of
   T+7/T+14 outcomes.
4. Approval packet per skill/output-contracts §Execution: exact Ad IDs,
   field-level current→proposed (`status: ACTIVE→PAUSED`), per-ad financial
   exposure (daily spend), experiment impact (none — no experiments exist),
   read-back predicate (D067 verification proof), rollback (resume + lineage),
   packet validated by `validate_decision_packet.py`.
5. Staged canary: 1 business (TheSwaf), ≤3 ads, dry-run first, then
   execute-mode with operator confirmation per action; observe the full
   claim→journal→verify→receipt chain once before any batch; no same-day
   retries; kill switch rehearsed.
6. Only after clean supervised receipts + accrued outcomes: revisit tier
   promotion via the promotion-records contract — with D048's controlled-causal
   requirement still gating auto-execution.

---

## 10. Meta Ads Manager dependency map

What still forces the operator into Ads Manager (or elsewhere), today:

| # | Dependency | Class |
|---|---|---|
| 1 | **Budget changes** (campaign/ad-set) — no write path; Structure is review-only | structural |
| 2 | **Bid changes** — same | structural |
| 3 | **Creative rotation/refresh** — never authorized; no write path | structural |
| 4 | **Non-purchase campaign management** (Bilsem: Conversations/Lead/ThruPlay/App Installs; any account's messaging/lead lanes) | structural |
| 5 | **TheSwaf-NonTesvik** — account unreachable in product ($1k/wk) | defect |
| 6 | **Same-day delivery/pacing** — no intraday data by design (data ends at D-1 even when healthy; "SPEND · TODAY —") | design gap |
| 7 | **Audience/targeting/placement edits, catalog & feed ops, policy appeals, billing** — entirely absent | structural |
| 8 | **Pause/resume at scale** — exists in-product (manual, ≤20 ads/batch) but 5 unresolved legacy `silent_failure` ambiguities block their exact Ads until a reconciliation sweep actually runs | partial |
| 9 | **Outage response** — when the pipeline halts, the product has no push alerting and its surfaces read healthy; the operator needs Ads Manager as the fallback console for everything | operational |

Launch/duplicate is genuinely covered in-product (Launchpad, caps, PAUSED-first)
— the one Ads-Manager workflow with a real replacement, and the action-ledger +
History journal give better audit than Ads Manager does.

---

## 11. Backlog

**P0 — restore truth and the loop (order matters):**
1. Revive the external cron → `/api/sync/cron` invocation; then run D068's
   natural-wave verifier. Root-cause why it stopped at 2026-08-22 14:53 UTC
   (`[unknown]` from DB: candidates — host crontab loss, CRON_SECRET/env parse
   break on a deploy, deliberate stop; the worker generation changed today,
   proving deploy-level activity).
2. Decide `meta_entity_state_history` retention (operator decision per the
   fence's own comment) or re-derive the budget from the measured 45–160k
   rows/day; the fence is refusing at 5 GiB **now**. Also: make a fence refusal
   surface as degraded source health + an alert, not a silent legacy fallback.
3. Fix `engine_v3_ad_decision_outcomes_job` (100% timeout failure; table empty
   forever) and the operator-response `business_ref_id` schema error (×138).
4. After 1–2: confirm Grandmix's bundle validates and its authorized decisions
   serve; if not, the manifest-incomplete cause is deeper than the fence
   (falsifies my §5.4 inference — re-diagnose from hydration receipts).
5. An absence-of-run alarm: "no successful native generation for account X in
   >26h" must page/notify, not wait to be visited; and it must flip source
   health away from "Healthy".

**P1 — serve what exists, honestly:**
6. Workspace kill-switch display: merge env + per-business control-plane truth (§6.4).
7. TheSwaf-NonTesvik reachability (assignment vs `is_selected` read semantics).
8. Signpost the context-override unlock when held actions are context-blocked
   (IwaStore: 52.8% of spend; "LABELS 5/5 100%" is anti-signal).
9. Retire the Structure lane's "Label this campaign…" copy (D050 conformance)
   and give its 10–15%/3–5d heuristics threshold-provenance records or demote
   the copy to explicitly-labeled suggestions.
10. Replace the circular pacing block (§6.3) with either a real plan input or
    an honest "no approved plan" state.
11. Proposal TTL: 24h expiry with no notification guarantees death-by-timeout;
    either notify on creation or extend/renew until viewed.
12. Fix `prev=0` comparisons; reconcile `dataReadiness.status ok` vs
    `isPartial`; give `stale` its own (non-positive) chip tone.

**P2 — quality:**
13. Cut copy calibration: suppress "clear loser" phrasing (and consider a
    confidence haircut) when |ROAS−BE| < 1 SE (Poisson) — e.g. the 1.64/1.71
    and 1.69/1.71 cases.
14. Timezone mismatches (business vs account) for Grandmix/TheSwaf; null
    business timezones ×3.
15. De-duplicate the 4× workspace fetch; workspace latency budget.
16. Purge or verify the false `token_expires_at` stamps (known-stale "Action
    required" source).
17. Account-level portfolio decision (target-miss at account grain) as a
    first-class surface, not prose.

---

## 12. Acceptance criteria — "operator can run Meta from Adsecute alone"

1. **Pipeline liveness:** 30 consecutive days of natural waves with zero missed
   generations across all assigned accounts; a tested absence-alarm; growth
   fence with a retention policy and measured headroom ≥ 6 months.
2. **Serving completeness:** every assigned, spending account serves
   `native_ad` authority (no degraded fallback) — including multi-account
   businesses; 100% of active spend carries a decision row (no
   "Evidence pending" on ACTIVE ads beyond first observation lag).
3. **Decision coverage:** every optimization goal with ≥5% of business spend
   has either a calibrated decision lane or an explicit, operator-acknowledged
   out-of-scope contract (Bilsem cannot pass with purchase-only).
4. **Anchor integrity:** BE/target ROAS reconciled at least quarterly against
   the cost model or commerce truth, with the reconciliation recorded on the
   target pack (source ≠ `settings_manual_entry` alone).
5. **Closed loop:** outcome job green; T+7/T+14 outcomes on ≥90% of hard
   decisions; published hard-action precision with denominators on the
   workspace; ECE/recall per D044 once volumes allow.
6. **Write proof:** ≥20 supervised decision-origin executions with complete
   journal→verify→receipt lineage and zero unresolved ambiguities; the 5 legacy
   silent-failures reconciled by the sweep.
7. **Budget/bid authority:** an immutable decision-origin contract and write
   path at ad-set grain for budget moves (without this, "manage Meta ads" is
   pause-only and Ads Manager remains the real console).
8. **Governance truth:** one kill-switch truth on every surface; guardrails
   (max actions/day, budget-delta caps, quiet hours) persisted per business,
   not defaults; incident runbook exercised once.
9. **Alerting:** delivery anomalies (spend=0 on active, ROAS collapse, policy
   rejections) push to the operator within the account's own cadence contract —
   not on next visit.

---

## 13. Contradiction and unknown ledger

| # | Item | State |
|---|---|---|
| C1 | Decisions lane (automatic context, no label asks) vs Structure lane ("Label this campaign…") | contradiction, live on 3 businesses' latest snapshots |
| C2 | Workspace `killSwitchEngaged:false` (env) vs `meta_automation_business_controls` engaged=true (IwaStore) | contradiction (display) |
| C3 | Source health "Healthy" vs 7-day pipeline outage | contradiction in effect (health models runs, not absence of runs) |
| C4 | DB assignment row for TheSwaf-NonTesvik vs served `provider_account_not_assigned` | contradiction |
| C5 | `dataReadiness.status:"ok"` + `isPartial:true` + notReadyReason in one tuple | internal inconsistency |
| C6 | Fence budget premise "~200 rows/day" vs measured 45–160k rows/day | falsified premise, breach recurred |
| C7 | "Synced 7d ago" in positive tone vs ESC tone rule for stale | known ESC Phase-A gap, observed live |
| U1 | Why the scheduler stopped at 2026-08-22 14:53 UTC | unknown — DB shows absence of invocation, worker alive; host/cron/env-level causes indistinguishable from a read-only DB session. Cheapest evidence: host crontab + app access log for `/api/sync/cron` |
| U2 | Whether Grandmix's manifest-incompleteness is fully explained by the fence | inference; verify from the 08-22 hydration receipts after recovery |
| U3 | What a served executable **scale** row renders (CTA wording/ceremony) | unknown — none is currently served anywhere |
| U4 | Deployed-production rendering vs dev-build rendering | unknown; JSON contracts audited are identical code paths |
| U5 | Whether the 2026-08-24/26 recommendation-snapshot writes were operator visits or a partial scheduler | unknown; either way inconsequential to the verdict |
| U6 | Attribution-setting drift (window/model per account) | not audited this pass; decisions consume synced revenue as-is |

---

## 14. No-mutation attestation and temporary artifacts

- Database: all queries ran under `default_transaction_read_only=on` with
  30s statement timeout and `application_name=claude_independent_audit_2026-08-29`;
  no INSERT/UPDATE/DELETE/DDL was issued by the auditor. Verified side effects of
  the audit in the decision system: **none** (0 job runs, 0 decision/recommendation
  snapshots, 0 action-log rows created on 2026-08-29 during the session).
- Incidental app-level writes from the sanctioned temporary local admin login:
  one `sessions` row created via the product's own `/api/auth/demo-login`
  (passwordless local mechanism), plus that route's deletion of already-expired
  demo-user session rows; page visits may have triggered lazy bookkeeping
  (observed: an already-past-`expires_at` automation proposal's status flip to
  `expired`). No Meta API call with write semantics was made; no ad object was
  created/paused/updated/deleted; no config or tracked file was altered.
- Tracked files: none modified. This report is the only file created under the
  repository.
- Temporary non-secret artifacts (outside the repo, session scratchpad):
  `scratchpad/roq.sh` (read-only psql wrapper; reads `DATABASE_URL` from
  `.env.local` at runtime, contains no secret itself). The untracked, git-ignored
  `.claude/launch.json` was temporarily extended with a local login dev
  configuration and **restored to its original content** before this report was
  written. The local dev server was stopped.

*Prepared independently by Claude Code (read-only auditor), 2026-08-29,
against `main@babf158e1` and `adsecute_prod` retrieved 13:41–14:20 UTC.*
