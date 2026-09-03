# Meta Decision System — Retrospective Completeness Audit (2026-08-30)

One bounded, truth-seeking acceptance audit of every package delivered in this
Claude working thread against the original user requirements. No fixes were
implemented by this audit; no production, app, code, or existing-doc mutation
was made; this file is the only repository change of the task. Statements are
labeled **[fact]** (verified this task or verifiably recorded with frozen
evidence), **[inference]**, **[assumption]**, or **[unknown]**.

Skill setup record **[fact]**: bridge
`/Users/harmelek/.claude/skills/emb-media-buyer/SKILL.md` — 984 bytes, sha256
`03a0790396b65596d4a9de7df223a900374a89319ffad924fbbe5ad29b57d88b`, modified
2026-08-29 — is a pure indirection ("do not use a cached copy; re-read the
canonical file at the start of each applicable task") to canonical
`/Users/harmelek/.codex/skills/emb-media-buyer/SKILL.md` — 12,861 bytes,
sha256 `985754567f2ac07e3623d4bc91ce16b0421ac9e3295f3e842248305ec3cbd187`,
modified 2026-08-24 — which equals the hash the original audit charter bound.
Currentness holds **by indirection**: the bridge carries no content that can
go stale, and the canonical file was read completely this task. START_HERE's
binding read-set for resolver work (DECISION_LOG, DATA_READINESS,
GOLDEN_CASES, INVARIANTS) plus the automatic-context spec and CONTEXT_SNAPSHOT
were read in this session before evaluation.

---

## 1. Executive verdict

**Can the user manage Meta exclusively through Adsecute today? NO.**
Three independent hard stops: (a) **[fact]** every Meta observation write has
been refused since 2026-08-22 14:53 UTC (state-history fence breach, 40,960
bytes over the 5 GiB ceiling) — Adsecute currently has no fresh evidence to
decide on; (b) **[fact]** the provider mutation surface implements only
pause/resume (ad/ad-set/campaign), one ad-set bid-amount update, and ad
duplication (`lib/meta/ads-write.ts`) — no budget change, no allocation, no
campaign/ad-set/ad creation or edit, no targeting, no creative replacement;
launching runs through a Launchpad *handoff into Ads Manager*, not the API;
(c) **[fact]** production serves zero runtime campaign roles (all 4,440
persisted context rows are account-NULL v1-shadow rows that D074's fail-closed
read rejects), so every context-dependent hard action is review-only.

**Can automation safely be enabled today? NO.** The authority env is unset by
design and MUST stay unset: the current resolver measured 0.20 high-confidence
accuracy on fresh-label validation **[fact, H11B]**; the v3 challenger's
predeclared gate returned REJECT **[fact]**; native outcomes and controlled
causal registries were recorded empty as of 2026-08-29 **[fact at that date]**;
ingestion is stopped; and D075/D077 are local-only (undeployed). What IS true:
the fail-closed wiring, fence-recovery machinery, delta-storage architecture,
and their regression proofs exist locally and are seam-verified — the system
is materially closer to *enable-ready*, which is a different claim than
*enable-safe*.

---

## 2. Evidence / source inventory

| Artifact | Kind | Window / date | Six-business coverage | Currency |
|---|---|---|---|---|
| `docs/audits/META_DECISION_SYSTEM_CLAUDE_INDEPENDENT_2026-08-29.md` | audit doc | 2026-08-29 | six named businesses | frozen |
| `…_CLAUDE_CROSS_REVIEW_2026-08-29.md` (+ reconciliation appendix) | audit doc | 2026-08-29 | six | frozen |
| `…_RECONCILED_2026-08-29.md` (D074–D077 implementation records) | audit doc | 2026-08-29/30 | six | frozen, updated through D077 |
| H11 locked replay + v2 post-hoc (`H11_CAMPAIGN_CONTEXT_*`, generated JSONs) | replay artifacts | 2025-12-01..2026-07-05 | 12 businesses incl. six | frozen, byte-untouched **[fact]** |
| H11B bundle `generated/h11b-context-lifecycle-bundle-…json` | frozen prod evidence | 2026-04-21..2026-08-22 | exactly the six (7 accounts) | frozen; bundleHash `58de78a12a15681ee51de1049f6463971d12231090dad33cd5c72586c5651b91` |
| H11B eval + train diagnosis (`H11B_CONTEXT_LIFECYCLE_CHALLENGER_…md`, JSONs) | offline eval | anchors 2026-06-15..08-17 | five labeled + IwaTR zero-truth | frozen/local |
| D077 production census (fence bytes, anatomy, duplicate/pin counts) | SELECT-only prod reads | 2026-08-29/30 | six + required global table facts | frozen in reconciled audit + D077 ADR |
| Migrations-from-zero harness logs (28→30 PASS across phases) | local test evidence | this session | n/a | local/ephemeral |
| Focused vitest runs (92/97/59/208/34/77/15 …) | local test evidence | this session | n/a | local |
| Production runtime probes (context rows account-NULL; sync stopped 08-22) | SELECT-only prod reads | 2026-08-29/30 | global + six | frozen |
| **[unknown]** pre-summary session raw transcripts (independent-audit phase details, admin QA steps) | chat history | 2026-08-29 | — | summarized only; not re-readable in full within this task's bounds |

All sources stop at 2026-08-22 for pipeline data **[fact]**: nothing after
that date is current production behavior.

---

## 3. Master traceability matrix

| # | Requirement / package | Status | Verified evidence | Gap | Acceptance criterion still needed |
|---|---|---|---|---|---|
| 1 | Independent Claude audit, six businesses, read-only | **COMPLETE** | audit doc exists; DB-safety pattern recorded | pre-summary details unverifiable here **[unknown]** | — |
| 2 | Cross-review + final reconciliation vs Codex | **COMPLETE** | cross-review + appended reconciliation docs | — | — |
| 3 | Six-business evidence bundle / admin QA cleanup | **PARTIAL/UNPROVEN** | H11B bundle frozen+hashed **[fact]**; repo tree holds no temp/QA leftovers (untracked inventory reviewed) **[fact]** | the *earlier* session's claimed admin-QA cleanup is not independently re-verifiable from context | one `rg`/route sweep proving no admin QA endpoint/fixture remains from the 08-29 phase |
| 4 | Shared pipeline-health / execution-readiness + UI safety (D072/D073) | **PARTIAL** | `decision-pipeline-health.ts` + tests exist (untracked, this thread); AR-015 golden case | end-to-end UI verification of blocked states not re-run this thread | one browser-level pass of blocked/ready states per business |
| 5 | D074 manual-label removal from active behavior + buyer UI | **PARTIAL** | table-level isolation guard 5/5 **[fact]**; write path physically removed; 410 tombstone | **active label vocabulary persists** (§5, lead A confirmed): `missing_campaign_label` readiness reason + `label_status`/"unlabeled" gating (`lib/meta/automation-readiness.ts:21,63–97`), `campaignLabelStatus` through the live serialization chain, buyer-facing copy `"A campaign role label is required"` (`meta-decision-center-exact-adapter.ts:1951`), "Promote to main" flows keyed on label status (`card-serialization.ts:61–71`) | zero buyer-facing "label" asks; readiness reasons renamed to automatic-role vocabulary; per-file categorization of §5 resolved |
| 6 | D075 delta-bounded storage + consumer compatibility | **COMPLETE (local, assurance closed 2026-08-30)** | 1-of-1,042 → 1 row measured on real PG; harness now 31-PASS incl. the D15 consumer-sweep leg; coalesced-lineage P1 found+fixed (D14n); full reader census + 4 confirmed reader fixes in D075_STATE_HISTORY_CONSUMER_SWEEP_2026-08-30.md, guarded by state-history-consumer-closure.test | undeployed — realized amplification/warm-plan cost unknown until release | deploy gate |
| 7 | D076 resolver challenger + UI explanation | **COMPLETE (honest REJECT)** | gate REJECT recorded; v2 stays compiled; explanation surface verified by author after helper stop (lead C confirmed) | v2's own 0.20 validation high-conf accuracy means runtime roles are weak even when serving resumes; Test recall unmeasurable | independent adjudication package (10–15 campaigns) + shadow waves |
| 8 | D077 fence recovery planner/executor/fence/readiness/CLI/tests | **PARTIAL** | harness 30-PASS incl. compaction seam; 77 unit tests; interleave defect caught pre-production | see §D077 adversarial table: 7 confirmed gaps incl. forgeable policy gate, no UI consumer, missing per-reason pin counts | close P1s in §8 before the operator run |
| 9 | Grounded in real production DB evidence for the six businesses | **COMPLETE** | frozen census + bundle, business-scoped, hashed | evidence frozen at ≤08-22 | refresh after ingestion resumes |
| 10 | Quality of decision outputs and their UI appearance | **PARTIAL/UNPROVEN** | contract-level tests pass; role explanation payload verified | no end-to-end UI verification for the six businesses in this thread; earlier UI-parity claims not re-checked → **[unknown]** | six-business browser pass with production-shaped data |
| 11 | Advisor/Decision Engine manages ads end-to-end | **MISSING** | capability map §6 | write surface limited to pause/resume/bid/duplicate; no budget/launch/targeting/creative; live verification only for status | build-out per §9 backlog |
| 12 | Fully-automatic-ready while automation stays OFF | **PARTIAL** | gates, gating envs, fail-closed wiring, controls exist and are tested | outcome evidence empty; resolver weak; storage undeployed; capability gaps | the §9 dependency chain through supervised canary |
| 13 | Operate without opening Meta Ads Manager | **MISSING** | §6 | reads YES (until 08-22), decisions PARTIAL, mutations/receipts/rollback largely absent | §6 rows all green |
| 14 | Changes general, not hardcoded per business | **COMPLETE** | resolver v3 config-as-data, no campaign/business tokens beyond generic name-token lists; D075/D077 scope-parameterized; guards enforce | one D077 readiness blocker string hardcodes a deploy-state assumption (lead D) | move blocker derivation to measured state |
| 15 | Media-buyer skill current | **COMPLETE** | hashes above; indirection model verified this task | canonical last touched 08-24 (before D075–D077); content is platform-generic so nothing in it is falsified **[inference]** | optional: canonical addendum for Adsecute-specific gates |
| 16 | Hardware/agent restraint | **COMPLETE** | ≤2 helpers concurrently across thread; stalled helpers killed on request; this audit used zero helpers **[fact]** | two helpers were stopped pre-report (recorded, not hidden) | — |
| 17 | Automation/deploy/prod-mutation as separate approval gates | **COMPLETE** | every package ends with gates listed; env switches unset (§11) | — | — |

---

## 4. D074–D077 adversarial acceptance

### D074 — claim vs proof

| Claim | Proof state |
|---|---|
| Manual write path removed from repository | **CONFIRMED** — isolation guard test asserts no writer export/transaction import/mutation SQL; 5/5 green this thread |
| No runtime read of label tables | **CONFIRMED** — guard walks app/components/lib; only migrations exempt |
| Buyer copy "never asks for a label" | **REFUTED** — `meta-decision-center-exact-adapter.ts:1951` ships `"A campaign role label is required"` **[fact, rg this task]** |
| Label vocabulary out of active behavior | **REFUTED** — `automation-readiness.ts` gates on `label_status === "unlabeled"` with reason `missing_campaign_label` and guard reason `unlabeled_campaign_soft_only`; `campaignLabelStatus` flows through `v3-bridge`, `decision-engine-v3` route, `canonical-projection`, `card-serialization`, `decisions-job`, `ad-decisions-job` **[fact]** |

Net: **PARTIAL** — table/authority isolation is real; vocabulary/copy/readiness
semantics are not fully migrated. (The vocabulary is now *fed* by automatic
context, so this is a copy/semantics debt, not a hidden authority path —
**[inference]** from the guard plus source-of-value tracing.)

### D075 — claim vs proof

| Claim | Proof state |
|---|---|
| 1-of-N writes bounded; 1-of-1,042 → 1 row | **CONFIRMED** on real PG (harness D14m) |
| Reconstruction/heartbeat/exit/re-entry/checkpoint semantics | **CONFIRMED** (D14a–D14n + native seam D075 leg) |
| Coalesced-path lineage correctness | **CONFIRMED after a real P1 was found by adversarial pass and fixed** (D14n) |
| Broad consumer-audit assurance | **REFUTED as complete** — the single reviewer was stopped mid-sweep; recorded as incomplete in the reconciled audit **[fact]** |
| Production amplification stops | **UNPROVEN** — undeployed; ingestion stopped |

### D076 — claim vs proof

| Claim | Proof state |
|---|---|
| Predeclared gate frozen before validation; REJECT honored | **CONFIRMED** (ADR sequence; REJECT recorded; v2 constant unchanged — guard test asserts it) |
| R1 mixed/high error class eliminated | **CONFIRMED** on validation fold (G5 pass; IwaStore corrected) |
| Explanation surface server-derived, UI render-only, label-free copy | **CONFIRMED for the new fields** (208 tests; author-verified after helper stop); pre-existing label copy elsewhere is the D074 gap, not this surface |
| Independent review of the UI helper work | **REFUTED as independent** — helper stopped; verification was author-side **[fact]** |
| Test-recall improvement | **CORRECTLY NOT CLAIMED** — structurally unmeasurable on the window |

### D077 — claim vs proof (leads D, all investigated)

| Lead | Finding |
|---|---|
| Readiness has no UI consumer | **CONFIRMED** — `stateHistoryCompaction` appears only in the route itself **[fact, rg]**; "read-only readiness/UI contract" is API-only today |
| Per-reason protected counts | **CONFIRMED GAP** — planner emits aggregate `pinnedRuns/pinnedRunRows` (+head/multi-endpoint/interleave classes) but NOT the ADR-promised per-pin-family split (lineage vs archived-schema vs response-event) |
| Response-event pin fixture | **CONFIRMED GAP** — no dedicated real-PG fixture (episode/job FK chain); covered by shared SQL arm + shape guard only; recorded as residual in ADR §3b |
| "Foreign run id produces zero writes" | **CONFIRMED OVERSTATEMENT** — executor header (`state-history-compaction-executor.ts:8–13`) says zero writes incl. journal; an honestly re-hashed foreign-run plan passes validation and writes `lease_acquired`/`planned`/`refused` journal rows before its batch rolls back. Deletion-zero is proven (seam); journal-zero is false for this case **[fact]** |
| Token is not authenticity | **CONFIRMED** — `expectedApprovalToken` = fixed prefix + public planHash; a caller can flip `status`/`cleared`/totals, recompute hash+token, and the executor executes: there is **no planner-provenance proof and no pre-mutation re-derivation of totals/fence/projection/current fence state**. Blast radius is bounded to the *policy* gates because per-run in-transaction revalidation (scope, rows, signature, identical retained predecessor, non-head, pins, interleave) independently proves deletion safety **[fact + inference]** — but the readiness/clearance gate is forgeable. P1. |
| Readiness journal read global/latest-5 + hard-coded blocker | **CONFIRMED** — journal query is unscoped latest-5; blocker string `d075_delta_manifests_not_deployed` is hard-coded (route line ~740) rather than derived from deployment state |
| Repeatable-read determinism | **CONFIRMED GAP** — planner/CLI enforce READ ONLY + statement timeout but not `REPEATABLE READ`; a concurrent writer could yield cross-statement snapshot skew inside one plan (mitigated post-hoc by the executor's fingerprint + per-run revalidation, but the plan artifact itself is not snapshot-consistent) |
| Focused tests/typecheck/lint green | **CONFIRMED** — harness 30-PASS ×2, 77 unit, tsc/eslint clean, `git diff --check` clean |

---

## 5. Active manual-label residue inventory

**Active authority/readiness (must migrate):** `lib/meta/automation-readiness.ts`
(`missing_campaign_label` reason line 21, `READ_ONLY_LABELS`/decision-label
machinery is *decision*-label not campaign-label — only the campaign-label
parts count: `isMissingCampaignLabel` line 94–97 gating on
`label_status === "unlabeled"`, `UNLABELED_CAMPAIGN_GUARD_REASON` line 76);
`lib/creative-decision-engine/execution-safety.ts` + `lib/meta/engine-v1/state-rows.ts`
(`label_status` producers/consumers).
**Buyer-facing copy/UI:** `meta-decision-center-exact-adapter.ts:1951`
("A campaign role label is required"); `card-serialization.ts` "Promote to
main"/review flows keyed on `campaignLabelStatus`/"unlabeled" (lines 37–71);
badge id `unlabeled_campaign_context`.
**Compatibility-only (retain):** `campaign-label-guard.ts` trust ladder and
`override`/`legacy_label` union members (old-snapshot deserialization, D074
documented); `buildCreativeCampaignLabelMap` fixture helper (zero live call
sites); `campaignLabelStatus` as a serialized field NAME where its value now
derives from automatic context **[inference]**.
**Frozen evaluation truth (retain, never runtime):** `meta_campaign_labels`
/ `_history` tables; `lib/meta/campaign-labels.ts` SELECT-only comparator;
H11/H11B label reads.
**Tests/docs (retain):** isolation guard, guard tests, replay tests, ADRs.
No blind deletion is recommended anywhere; the migration need is vocabulary
and copy, with the comparator layer explicitly preserved.

## 6. "No Meta Ads Manager" capability map

| Capability | State | Evidence |
|---|---|---|
| Discovery/read (accounts, structure, spend, status) | **YES until 2026-08-22; currently stalled** | sync stopped at fence **[fact]** |
| Decisioning (native ad-grain, guarded) | **PARTIAL** | engine + gates exist; roles unresolved in prod; outcomes empty (as of 08-29) |
| Presentation/UI of decisions | **PARTIAL** | contracts/tests; six-business UI parity unverified this thread **[unknown]** |
| Approvals/operator controls | **PARTIAL** | review-only workflow + business controls exist; per-action approval ceremony exists for pause |
| Pause/resume (ad/ad-set/campaign) | **YES (code)** | `ads-write.ts:2616–2662`; preflight + readback for ad pause path |
| Budget change | **NO** | absent from write surface **[fact]** |
| Bid change | **PARTIAL** | `updateAdsetBidAmount` only (:2664) |
| Allocation across campaigns | **NO** | — |
| Structure launch/edit (campaign/ad-set/ad create, edit) | **NO (API)** | Launchpad is a prefill *handoff to Ads Manager* (`launchpad-handoff-server.ts`) |
| Targeting edits | **NO** | — |
| Creative replacement/launch | **PARTIAL** | `duplicateAd` (:2805) + creative studio share flows; no direct creative swap |
| Live preflight/read-back | **PARTIAL** | execution-state readers exist for status paths |
| Receipts | **PARTIAL** | action log + journals for implemented actions |
| Rollback | **PARTIAL** | pause↔resume is self-inverse; nothing else has rollback because nothing else exists |
| Outcomes/learning | **NO (empty)** | zero native outcomes recorded as of 08-29 **[fact at date]** |
| Incident controls | **YES** | fence, kill switches, `CAMPAIGN_CONTEXT_MODE=unknown`, automation controls |

## 7. Six-business readiness (verified evidence only; ≤2026-08-22)

| Business | Labels (frozen) | Role coverage (prod runtime) | H11B exact-acc (validation) | Known blockers |
|---|---|---|---|---|
| IwaStore | 10 (2 test) | zero (account-NULL rows) | v3 0.80 / v2 0.60 (n=5) | outcome emptiness; ingestion stopped |
| Grandmix | 13 (2 test, both concluded pre-window) | zero | 1.00 (n=2, tiny) | test-truth unobservable |
| Bilsem Zeka | 7 (fresh 08-26) | zero | 0.4286 (n=7) — weakest fresh-truth fit | mixed-detection semantics; **non-purchase goal contract [unknown — not re-verified this thread]** |
| TheSwaf | 25 across 2 accounts (2nd not selected) | zero | 0.50–1.00 by account (n≤4); both engines 0/2 high on act_921… | multi-account coherence **[unknown currency]** |
| IwaTR | 0 labels | zero | no truth — correctly unresolvable | role truth/target pack absent **[fact: zero labels]** |
| ColorFullWorldsTR | 2 | zero | 1.00 (n=2) | economics/calibration **[unknown — no in-thread evidence]** |

React #310, outcome/operator-response job failures, six-business UI parity:
**[unknown]** — asserted in earlier frozen audits, not re-verified in this
thread; treat as stale leads, not current facts.

## 8. Ranked findings

**P0-1** Ingestion stopped since 2026-08-22 (fence breach). Blocks everything:
no fresh reads → no decisions → no automation. Recovery = D077 operator chain
(§9). `db-growth-fence.ts:178` budget vs measured 5,368,750,080 B.
**P0-2** Provider capability gap (§6): without budget/structure/targeting/
creative mutations there is no "manage without Ads Manager" even with perfect
decisions. `lib/meta/ads-write.ts` export inventory.
**P0-3** Campaign-role runtime void: 4,440 account-NULL v1-shadow rows;
fail-closed read serves nothing; v2 fresh-truth high-conf accuracy 0.20.
Blocks any kind-aware automation.
**P1-1** D077 executor policy-gate forgeability — **CLOSED 2026-08-30**:
fail-first seam evidence showed a policy-forged plan (edited status/
projection, honestly re-hashed) executing to `completed` and deleting rows.
The executor now re-derives the authoritative plan from the database
(REPEATABLE READ READ ONLY, production planner) before lease/journal and
requires exact canonical-payload equality; forged, stale, and foreign-run
payloads refuse with ZERO writes (seam-proven). The token is recorded as
operator acknowledgement, not provenance.
**P1-2** D074 residue (§5): label vocabulary in active readiness gating +
buyer copy at `exact-adapter.ts:1951`. Contradicts the "sole automatic
authority" product story the moment users see it.
**P1-3** D075 consumer-sweep incompleteness — **CLOSED 2026-08-30**: the
full census (41 code files + non-code refs) with verdicts and proofs is in
`D075_STATE_HISTORY_CONSUMER_SWEEP_2026-08-30.md`, guarded by
`state-history-consumer-closure.test.ts`. Four confirmed reader defects
fixed (workspace absent→'DELETED' fabrication; History-feed absence
transitions; operator-response window-end confirmation via
`confirmed_until` + source-proof v3; natural-wave verifier run-bound delta
counts), each with a pre-fix-failing regression and real-PG seam proof
(harness 31 PASS). Acceptance correction 1 (same day) closed three
further gaps fail-first: the stale label-copy test the directory-scoped
"broad" run had missed (exact broad command now 241 files / 3,027 passed /
0 failed), the non-monotonic coalescing heartbeat (replay erased
confirmed_until — D15e), and the captured-at-only anti-supersession
predicate (tie and sibling-endpoint cases — D15f/D15g; adjudicated winner
order + endpoint authority, guard-pinned).
**P1-4** D077 planner snapshot/per-reason counts/journal scoping/hard-coded
blocker/header overstatement/UI consumer — **CLOSED 2026-08-30** (first
closure claim independently REJECTED and corrected the same day): RR READ
ONLY planner transaction with an in-planner isolation check (fail-first: a
READ COMMITTED session was accepted; a mid-plan concurrent commit is now
snapshot-invisible); hash-bound `protectionsByReason` per scope/totals with
non-additive overlap semantics INCLUDING the exact measured multi-endpoint
exclusion (was a boolean/zeros — seam failed pre-fix) and fail-closed
run+ROW-level consistency through the exported, perturbation-tested
`validateCompactionScopeCounts` (row reconciliation was missing pre-fix);
business-scoped journal read with explicit provenance (a journal-only read
failure was falsely "NOT_EXECUTED/no entries" — now
UNKNOWN_JOURNAL_UNAVAILABLE, contract v3); measured D075 writer evidence
replacing the hard-coded blocker; header corrected; and a display-only
readiness section on the business Automation page (desktop + mobile).
**P2-1** Response-event pin fixture — **CLOSED 2026-08-30**: the seam seeds
the full episode chain and proves family attribution, whole-run protection,
and the fail-closed refusal of a post-plan pin (zero writes; RESTRICT FK
never exercised).
**P2-2** H11B truth thinness (7 Test labels, 5 unobservable) — permanent
until new running tests or adjudication.
**P2-3** Skill canonical predates D075–D077 (generic content unaffected).

## 9. Dependency-ordered remediation backlog (one Claude-prompt-sized each)

*Code-ready (local, no approval):*
1. **D074 vocabulary closure** — migrate `missing_campaign_label`/
   `label_status`/`campaignLabelStatus`/copy at `exact-adapter.ts:1951` +
   `card-serialization.ts` to automatic-role vocabulary, additive serialized
   aliases for old snapshots; update guard tests.
2. **D077 hardening** — DONE 2026-08-30 (see P1-1/P1-4/P2-1): all closed
   fail-first with real-Postgres proof; readiness UI consumer shipped on
   the business Automation page.
3. **D075 consumer sweep completion** — DONE 2026-08-30 (see P1-3): census
   complete, four reader fixes landed, closure guard added.

*Production read-only verification:*
4. Six-business UI parity + decision-output QA pass (browser, read-only),
   refreshing the §7 unknowns (React #310, job failures, Bilsem/ColorFull
   contracts).

*Operator/deploy gates (each separately approved):*
5. Deploy D075 (+D074/76/77 code) → verify write amplification live.
6. D077 recovery run: `CREATE EXTENSION pgstattuple` → low-traffic planner
   dry-run (produces the still-UNKNOWN exact removable counts) → approved
   execution → vacuum → effective-metric re-admission → optional physical
   shrink → ingestion resumes.
7. Resolver evidence rebuild: context job on real accounts → shadow waves →
   independent 10–15-campaign adjudication → only then any authority-env
   discussion.
8. Capability build-out (budget → structure → targeting/creative), each with
   preflight/read-back/rollback per the skill's execution contract.
9. Outcome accrual + controlled-causal registry population → supervised
   canary → any automation activation (operator decision, out of scope).

## 10. Overstated / contradicted / stale / unproven prior claims

1. D074 "copy asks for evidence refresh or role re-inference, never for a
   label" — **contradicted** (`exact-adapter.ts:1951`).
2. D077 executor header "foreign run id … produces zero writes, journal
   included" — was **overstated** (journal rows preceded batch rollback);
   **now true** after the 2026-08-30 pre-write authoritative re-plan
   (seam-proven zero journal rows on foreign-run and stale payloads).
3. D077 "read-only readiness/UI contract … UI renders only" — was
   **overstated** (no UI consumer existed); **closed 2026-08-30**: the
   business Automation page renders the server-owned readiness facts on
   desktop and mobile, display-only.
4. D077 ADR "protected counts by reason" — was **not delivered** (aggregate
   only); **delivered 2026-08-30** as hash-bound `protectionsByReason`
   (head/live-lineage/archived-lineage/response-event/interleave, overlap
   documented, fail-closed consistency).
5. D075 "consumer compatibility" assurance — **now proven** (2026-08-30
   sweep closed the gap the stopped reviewer left; four reader defects the
   partial claim had missed were found and fixed — the honest record is
   that "compatibility" was NOT fully true when first recorded).
6. D076 helper "verified" — verification was **author-side**, not
   independent (recorded at the time).
7. 2026-08-18 fence-raise rationale "a decade of headroom" (pre-thread code
   comment) — **falsified** within four days; already superseded by D077.
8. Earlier-audit items (React #310, job failures, UI parity, Bilsem/
   ColorFullWorlds contracts) — **stale/unknown**, not current facts.
9. Pre-summary admin-QA cleanup — **unproven** from this thread's context.
10. `approvalToken` naming suggests authorization strength it does not have —
    it is a deliberate-ceremony string, not authenticity **[fact]**.

## 11. Final restraint & non-mutation snapshot

**[fact]** `META_AUTOMATION_ENABLED`, `CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION`,
`STATE_HISTORY_COMPACTION_ABORT` (and `SYNC_GROWTH_FENCE_OVERRIDE`) are unset
in the shell environment and absent from `.env.local`/`.env.production`
(checked this task). **[fact]** This audit used zero helper agents and ran no
harness, no migration, and no production query. **[fact]** `git diff --check`
is clean; the tracked-file worktree fingerprint
(`git status --porcelain | sha256`, prefix `16375a4d46b011d4`) was captured
before the audit and re-verified after (the only delta being this file's
appearance under the pre-existing untracked `docs/audits/` directory); no
code or existing document was modified. All pre-existing dirty files belong
to the prior packages, not to this audit.
