# D078 — Six-Business Meta Decision + UI Readiness Acceptance (2026-08-30)

**Correction history, first.** The original D078 answer was independently
REJECTED by Codex on six confirmed grounds (R1–R6): the "exactly six
businesses" frozen bundle carried five unscoped fleet tails (21 business-id
occurrences outside the charter allowlist, seven non-charter ids); the
local-QA harness persisted a fixed session token and a concrete local
connection string, and left a dead dev-server launch entry behind; local
HEAD UI coverage was 2/6 businesses, with the stale-CTA browser gap left
open; selected/deselected account state was still invisible in UI; the
buyer-facing History filter still said "Label flips"; and the report
overclaimed all of the above. **Correction 1 was then itself independently
REJECTED by Codex on seven grounds (C2.1–C2.7)**: its switcher "proof" was
one clicked hop plus five direct session-row updates; its "end-to-end CTA"
test never invoked the actual workspace route; a failed account-state read
was indistinguishable from proven-zero; the deselected-account facts
lacked the timezone, the policy lived in a tooltip, and nothing proved the
scope can actually be SELECTED; the harness logged violations but exited
0; the bundle scope contract pinned two allowlists but not the
business→account pairing; and the records overclaimed closure.
**Correction 2 was then itself independently REJECTED by Codex on five
grounds (C3.1–C3.5)** — after Codex re-ran the DB route runner and
batteries and issued its own production probe at 2026-08-30 07:01:09 UTC
confirming the seven pairs: the real adapter collapsed an absent legacy
`assignedAccountStates` (`undefined`) into read-failed (`null`), so the
claimed four-state chain was false through the actual payload→adapter→UI
path; the "actual route/UI CTA proof" never rendered the real action
drawer, disabled the review controls by passing no callback, scoped its
"no enabled Cut" check to a `data-decision-id` selector this surface has
never emitted (a `?? ""` fallback made it pass vacuously), never asserted
a rendered enabled supervised Cut, and mocked request auth + posture
while claiming "only the provider boundary is mocked"; the matrix
validator accepted disconnected/self/duplicate hop sets as "traversal";
the scope guard never pinned the top-level `bundle.businesses` list; and
the records repeated all of it, §10 still citing the superseded v2
transaction time. **This document is the correction-3 record, submitted
for Codex acceptance — not self-accepted.** Nothing from any rejected
version is silently rewritten — where a claim changed, the change is
stated, and every closure names its evidence class (production
read-only / DB-backed actual-route / actual drawer-action UI / offline
browser withholding / static unit / deployed). **Codex subsequently
independently ACCEPTED correction 3 as the local D078 evidence package;
the independent command/results record is
`D078_CORRECTION_3_CODEX_INDEPENDENT_ACCEPTANCE_2026-08-30.md`. This is
not acceptance of deployment, production recovery, or automation.**

**Blunt verdict (unchanged in direction).** Adsecute still cannot replace
Meta Ads Manager and automation must stay OFF. The decision arithmetic is
proven sound (14/14 current hard actions reproduce exactly), the deployed
UI's most dangerous defect is confirmed live (enabled **Cut** on
180-hour-old decisions), the local branch fixes every confirmed deployed
truth defect — now including explicit deselected-account evidence — and
local HEAD is proven in a real browser across ALL SIX businesses. The
binding constraint is operational: **ingestion has been admission-refused
since 2026-08-22 14:53 UTC**.

Labels: **[fact]** measured this pass, **[inference]**, **[assumption]**,
**[unknown]**. Production evidence class: read_only (REPEATABLE READ READ
ONLY transactions; timestamps below).

---

## 0. Skill gate and evidence provenance

- Bridge `/Users/harmelek/.claude/skills/emb-media-buyer/SKILL.md` sha256
  `03a0790396b65596d4a9de7df223a900374a89319ffad924fbbe5ad29b57d88b`
  (pure indirection, re-verified from disk this correction); canonical
  `/Users/harmelek/.codex/skills/emb-media-buyer/SKILL.md` sha256
  `985754567f2ac07e3623d4bc91ce16b0421ac9e3295f3e842248305ec3cbd187`
  (read completely). Task-relevant references read in full:
  evidence-and-decision-policy, data-quality-and-diagnosis, platform-meta,
  intake-and-unit-economics, metric-dictionary; plus AGENTS.md and the
  START_HERE binding read-set.
- **Frozen evidence bundle v3** [fact]:
  `docs/audits/generated/d078-six-business-evidence-bundle-2026-08-30.json`,
  contract `adsecute.meta.d078-six-business-evidence-bundle.v3`, embedded
  bundle hash
  `13074631deb57836cabc3831f37172f85508c629bf16ac5d11a054be3e760be1`,
  production read at **2026-08-30 05:42:39 UTC** in a fresh REPEATABLE
  READ READ ONLY transaction. Carries the `scopeContract` — six charter
  business ids, seven pinned account ids, AND (new in v3, C2.6)
  `charterAssignments`, the exact business→account pairing — plus a
  `fleetGlobal` object for the only facts that cannot be business-scoped
  (physical table size, singleton worker heartbeats, fleet denominators),
  each with a machine-readable scope note, and (new in v3) an
  `assignedAccountStatesProbe`: the shipped `ASSIGNED_ACCOUNT_STATES_SQL`
  run per business inside the same transaction, returning exactly 7 rows
  matching exactly the charter pairs. **The v1 bundle (payload hash
  `5eeed44a…`) was NOT six-scoped, and the v2 bundle (payload hash
  `7609a004…`) pinned allowlists but not pairs — both superseded.**
- **Hard-action recompute artifact v3** [fact]:
  `docs/audits/generated/d078-hard-action-recompute-2026-08-30.json`,
  embedded hash
  `ee6e440f6a684fd779832d4036488b200910a20a1e255c843335ba96583a6287`,
  regenerated against the v3 bundle (its `sourceBundleHash` equals the v3
  bundle hash; guard-asserted). 41 rows (14 hard + 27 samples), every row
  a charter PAIR (guard walks business+account together, not two
  independent lists).
- **Scope + residue guards** [fact]:
  `lib/meta/__tests__/d078-acceptance-guards.test.ts` (12 tests) — (a)
  walks every recursively-found business/account id against the exact
  charter PAIR (a valid business id next to the wrong charter account is
  a failure), requires `charterAssignments` to equal the allowlists
  exactly, requires the probe to hold exactly the 7 pairs, fails fleet
  entries naming business ids, and fails a recompute artifact not bound
  to the current bundle hash; (b) — new in correction 3 (C3.4) — pins
  the TOP-LEVEL `bundle.businesses` list itself: exactly six unique
  charter ids with the pinned charter names, with a pure helper whose
  fail-first cases prove an extra, missing, duplicated, or renamed
  business each fails; (c) scans `.claude/launch.json`,
  `scripts/audits/**` and `docs/audits/**` for the rejected harness's
  fixed token, its concrete connection string, and the removed
  launch-entry name (needles built by concatenation so the guard itself
  can never match); (d) proves account-state evidence feeds no write
  selector (C2.4.4); (e) — new in correction 3 — static wiring guards on
  the proof files themselves: the actual-route test must not mock
  auth/posture (the rejected correction-2 shape), the drawer proof must
  mock no data/provider boundary at all, and the browser harness/seed
  must contain no sessions UPDATE and exactly ONE sessions INSERT (the
  single seeded initial state, C3.3.4).
- **Local-UI acceptance matrix v3** [fact]:
  `docs/audits/generated/d078-local-ui-acceptance-matrix-2026-08-30.json`,
  contract `adsecute.meta.d078-local-ui-acceptance-matrix.v3` — **31
  entries, 0 failed assertions, 31 non-empty screenshots** under
  `docs/audits/generated/d078-local-ui-screenshots/`, an 11-hop
  machine-readable `switcherProof`, and a `routeCtaProof` (exit 0,
  covering BOTH the node actual-route test and the jsdom drawer/action
  test). Validated by the shared contract validator
  (`scripts/audits/d078-matrix-contract.ts`) whose violations set a
  nonzero harness exit after teardown (C2.5). **Strengthened in
  correction 3 (C3.3)**: the validator no longer accepts a from/to name
  set — it validates the DECLARED ordered chain per width
  (`D078_SWITCH_ORDER`, shared with the harness so the two cannot
  drift): exact hop count (5 at 1440 px, 6 at 390 px), no self-hop, no
  duplicate target, from-continuity hop to hop, the exact declared
  from→to sequence, and per-hop identity proof (selected identity names
  the target; rendered identity is `url:<target>` or `body:<target>`,
  never unknown/error). Seven new fail-first cases prove
  disconnected/self/duplicate/wrong-from/wrong-selected/wrong-rendered/
  wrong-count artifacts each fail; the correction-2 artifact's 11 hops
  pass the strengthened validator unchanged — the hops were real, the
  validator was weak.
- **Deployed build** [fact]: `/api/build-info` served
  `babf158e150fd33057117b39b175da044ac62d2e` (deploy gate pass 2026-08-29
  11:35 UTC). Production runs none of the D072–D078 branch.
- Deployed QA used the operator's existing authenticated browser session —
  no production QA auth rows were ever created. Local QA ran entirely on a
  throwaway cluster whose session token is generated per run
  (crypto.randomBytes, process memory only; only its sha256 touches the
  ephemeral DB) and which the harness deletes on exit.

## 1. Current operational state (re-verified at 05:42 UTC in the v3 bundle transaction; leads, not carry-forwards)

| Clock | Measured | scope |
|---|---|---|
| Warehouse facts (`meta_ad_daily`) | max fact/finalized **2026-08-21** all six (NonTesvik 08-20) | per account [fact] |
| Last successful sync | 2026-08-22 14:49–14:53 per account | six accounts [fact] |
| Native decision generation | as-of 08-22 (NonTesvik 08-21); ages 182.9–200.4 h at the v3 recompute | per account [fact] |
| Recommendation snapshots | TheSwaf/Bilsem 08-26, IwaStore 08-24 — produced after the warehouse stopped | per business [fact] |
| Fence (fleetGlobal) | `meta_entity_state_history` 5,368,750,080 B vs 5,368,709,120 budget; last write 08-22 14:53:48 | physical table, whole fleet [fact] |
| Worker (fleetGlobal) | durable meta worker idle heartbeat at read time | singleton process [fact] |
| Engine job lane — SIX-BUSINESS | every engine_v3 job last ran 2026-08-22; `engine_v3_native_ad_operator_response_shadow_job` **8,027** non-success rows for the six businesses; failing with `column "business_ref_id" does not exist` | numerator: non-success runs, denominator: that job's six-business runs [fact] |
| Engine job lane — FLEET (separate, never a six-business denominator) | same job fleet-wide: 8,513 non-success of 10,751 total | all businesses [fact] |
| Outcomes / experiments / receipts | six-business outcomes rows **0**; six-business experiments **0**; fleet outcomes 0; fleet experiments/arms/assignments 0/0/0; operator receipts for six: none | both scopes stated [fact] |
| Campaign roles | six businesses: 2,350 context rows, ALL account-NULL v1-shadow, max as-of 08-22 → runtime coverage zero; fleet denominator 4,440 (fleetGlobal) | [fact] |

Schema compatibility [fact]: production has none of
`manifest_kind`/`base_run_id`/`delta_stats_json`/`last_captured_at` and no
compaction journal table; local HEAD additionally must not run against the
production tunnel because its boot instrumentation writes
`sync_runtime_instances`. Local rendering therefore uses the ephemeral
harness (§5).

## 2. Six-business matrix (per account, own currency; bundle v3)

| Business / account | 14d spend→revenue (to own cutoff) | Goal mix by spend | Targets/cost truth | Latest gen (rows/authorized) | Verdict |
|---|---|---|---|---|---|
| TheSwaf-Main USD | 33,887 → 46,441 (258 conv) | 90% Value-optimization purchase | tROAS 2 / BE 1.71 + cost %s | 750 / 7 cuts | Sound arithmetic, 180 h stale → hold/review-only until recovery. |
| TheSwaf-NonTesvik USD (deselected) | 1,652 → 4,139 | 100% purchase | same pack | 126 / 2 cuts (conf 45) | Now EXPLICIT read-only historical evidence on the branch (§5 R4); provider-mutation scope still forbidden; select/stop-production remains the operator policy decision. |
| Grandmix USD | 22,503 → 47,034 | OUTCOME_SALES (config optimization-goal coverage gap [fact]) | tROAS 2.2 / BE 1.8 + cost model | 2,529 / 3 cuts + 2 scales | Ordering race reproduced in final data; native serving invalid on deployed; hard rows valid but unservable + stale. |
| Bilsem Zeka TRY | 252,132 → 1,548,882 TRY | 76.5% purchase / 18.2% lead / 2.8% profile-visit / 2.6% ThruPlay | tROAS 3 / BE 2; no cost model; no calibration | 3,204 / 0 | Purchase motor explicitly refuses non-purchase scope (`non_purchase_optimization`, review-only); ~24% of TRY spend decision-uncovered by design and disclosed. |
| IwaTR USD | 840 → 4,856 | 100% purchase | **NO target pack** [fact] | 172 / 0 | Engine degrades to `account_baseline_thin` and refuses hard authority; both deployed and local UI show the "Set commercial truth" banner. Blocked on operator input. |
| ColorFullWorldsTR USD | 865 → 5,708 | purchase (79% conversions / 21% value) | tROAS 4 / BE 3 (2026-05-20); no cost model/calibration | 414 / 0 | Review-only; thin volume; honest state. |

Calibration profiles: zero for all six [fact]. Governance: only IwaStore
has a persisted controls row (kill-switched, dry-run, EUR ceiling on a USD
account — data correction still pending); the other five have no row →
fail-closed write-block on the branch, silently "ENABLED" on deployed
(fixed on branch, §5). Rules 0; proposals 3 expired (TheSwaf); promotions 0.

## 3. Decision-quality audit (Phase B, regenerated against bundle v3)

All 14 persisted-authorized hard actions reproduce exactly [fact]:
snapshot==input; ROAS==value/spend (1e-9); ratio-to-target stored & derived;
CPA; effective target == business target pack (business-derived threshold
origin); 28d/7d warehouse re-derivation within 2% (mostly exact to the
cent); no authorized row carries a blocker; hashes present and linked; all
ages 182.9–200.4 h at the v3 recompute ⇒ every one beyond the 12 h ceiling. Worked example
(TheSwaf `120251377938760042`): spend 1,277.78, value 1,162.34, ROAS
0.9097 = 45% of target 2.0, recent-7d 0.575 < BE 1.71 on 1,144.68 →
economic stop-loss; warehouse matches. Stratified samples (27): zero-window
diagnose rows are honest fail-closed refusals; the keep row (ROAS 4.54,
227% of target) is held from scale by three named gates; the only
surviving flags are IwaTR's three `commercialAnchorConfigured=false` rows —
a true business gap. Latest generations carry zero duplicate identity keys;
historical duplicates exist only on 2026-07-14/15 (bounded incident). All
41 recompute rows carry only charter ids (guard-asserted).
Eligibility now: **persisted-authorized 14 / presentation-actionable 4
(deployed) / execution-preflight-eligible 0**. No resolver/threshold
change was made.

## 4. Deployed UI (adsecute.com, build babf158e1, authenticated)

Confirmed live defects — all now fixed on this branch, all deploy-gated:
1. **P0** enabled Cut button on 180 h-stale decisions (evidence drawer),
   with `Served campaign role: main · user_override · trusted for action`
   (manual-label authority live).
2. **P1** false health copy (`native_ad · healthy` at 188 h; "Syncing
   now"/"Serving" during the outage).
3. **P1** clock mixing ("Synced 8d/5d/3d ago" for one 8-day-stale
   warehouse on different pages).
4. **P1** label surfaces (LABELS tiles, "Manage labels", "Label flips"
   filter, label-fed Launchpad CTA).
5. **P2** deselected TheSwaf account invisible on every surface — **now a
   fixed-on-branch defect (§5 R4), no longer "just a policy question"**;
   the remaining policy decision (re-select vs stop production) is
   explicitly surfaced by the new evidence states.
6. React #310 did NOT reproduce on this build (all six businesses switched
   on Decisions, zero console errors) [fact]; the old crash's cause on the
   earlier build stays [unknown].
Honest deployed behaviour also recorded: stale banners; Grandmix
`legacy_creative · degraded` review-only; IwaTR economics banner;
capability gaps listed; honest Ads Manager handoff naming; IwaStore
Automation truth; 390 px read-only mobile rendering.

## 5. Local HEAD — six-business browser acceptance + fixes (corrections 1–2)

**Coverage [fact, local ephemeral browser proof]**: the harness
(`scripts/audits/d078-local-ui-ephemeral-harness.ts`) boots an ephemeral
cluster, runs the real deploy migrations from zero, seeds a sanitized
bundle-derived fixture for ALL SIX businesses and ALL SEVEN account
assignments (shared seed module `scripts/audits/d078-lattice-seed.ts`,
one transaction), launches the dev server and a Playwright Chromium
itself (secrets in memory only), and drives **31 matrix entries — six
businesses × {Decisions 1440/390, Creatives, Automation, History 1440}
plus TheSwaf History 390 — with 0 failed assertions and 31 non-empty
screenshots**. Correction-1 highlights that still hold: admission-blocked
evidence named on every business; no manual-label ask anywhere;
"CAMPAIGN ROLES · Automatic inference" replaces label tiles; kill-switch
pill truth per business (IwaStore **STOPPED**, TheSwaf **ENABLED**
persisted open row, the other four **BLOCKED · NOT CONFIGURED**
fail-closed); the D077 recovery-readiness section renders real server
facts on the canonical route.

**Correction 3 first (C3.1–C3.5).** Each confirmed correction-2 defect,
its fix, and its evidence class:

- **C3.1 four-state account evidence through the REAL adapter [fact,
  adapter+render test]**: the correction-2 adapter line
  (`assignedAccountStates: workspace.assignedAccountStates ?? null`)
  collapsed an absent legacy field into read-failed, so a legacy payload
  rendered the "coverage unavailable" warning — the claimed
  "`undefined` stays legacy-silent" was FALSE through the actual
  payload→adapter→UI chain (only the component's own props respected
  it). Fixed to forward verbatim;
  `components/meta/decision-center/assigned-account-tri-state-adapter.test.tsx`
  starts from REAL workspace-shaped payloads, calls
  `buildMetaDecisionCenterExactViewModel`, renders the produced view
  model, and proves all four results (absent ⇒ nothing; null ⇒ visible
  unavailable warning; [] ⇒ anomalous proven-zero; populated ⇒ panel).
  Fail-first proven: the absent-field case fails against the
  correction-2 `?? null` (1 failed / 3 passed on the reverted line;
  4/4 on the fix). **History's exact semantics, stated precisely**: the
  History client (`fetchMetaHistoryAccountScopes`) implements
  `historicalAccounts: array | null` ONLY — `null` (server read failed)
  passes through, and a missing field on a legacy payload ALSO maps to
  `null`/unavailable, deliberately fail-closed; History has no separate
  `undefined` state and this record claims none.
- **C3.2 the actual drawer/action proof [fact, DB-backed actual-route +
  actual drawer-action UI]**: the correction-2 "rendered UI" test never
  rendered the action surface — it rendered the queue only (where the
  served action is decision-information TEXT), passed no
  `onCreativeReview` callback (review controls disabled), scoped its "no
  enabled Cut" assertion to `data-decision-id` — an attribute this
  surface has never emitted — with a `?? ""` fallback that made the
  absent region pass vacuously, never asserted a rendered enabled
  supervised Cut, and mocked `requireBusinessAccess` +
  `readMetaBusinessDataPosture` while the record said only the provider
  boundary was mocked. All corrected: (1) the node route test now uses
  REAL cookie auth (an in-memory token for the seeded QA user; only its
  sha256 touches the throwaway DB) and the REAL posture read, mocking
  ONLY the external provider-inventory boundary — a static guard scans
  the file for the two rejected mocks; its rendered-queue test is
  relabeled decision-information proof, pins that `data-decision-id`
  does not exist, and its region extractor THROWS on an absent row. (2)
  A new jsdom test (`drawer-cta.db.test.tsx`) drives the REAL
  `MetaPlatformPage` wiring over the EXACT captured route payload
  (handed off by the node test in the same runner invocation, because
  the jsdom web transform cannot import server modules): real queue row
  → real review control click → real `CreativeEvidenceWindowExact`
  drawer → real `authorizeMetaNativeAdPause` gate. Proven separately,
  scoped to the exact seeded ad (each drawer contains its own ad's name
  and NOT the other's): STALE — drawer opens, stale evidence visible,
  primary is the review-only "Refresh Decision" and is DISABLED, zero
  Cut/Pause buttons exist, no ceremony; FRESH — drawer opens,
  live-preflight copy visible, the supervised **Cut primary is present
  and ENABLED**, and clicking it opens ONLY the real
  `MetaNativeAdPauseDialog` confirmation ceremony ("…re-read the
  immutable decision lineage and live hierarchy before one provider
  attempt") with its confirm control present and NOT clicked. A
  throwing fetch recorder proves zero provider/mutation calls (the only
  attempted fetches are the fire-and-forget instrumentation beacons,
  each thrown before any I/O); every required selector goes through a
  helper that throws on zero matches, with explicit would-have-failed
  probes for the absent drawer and the absent row. The drawer file
  mocks NO data/provider boundary at all; its jsdom framework harness
  (navigation/store/react-query mounting stub/i18n) carries no data
  semantics — the workspace and accounts data ARE the captured actual
  route responses. Runner result: route 5 passed / 1 skipped, drawer
  4 passed / 1 skipped, exit 0, teardown clean.
- **C3.3 ordered-chain switch validation [fact, static unit + artifact
  re-validation]**: §0's strengthened validator + the static guard that
  the harness performs no sessions mutation after the single seed.
- **C3.4 top-level scope pinning [fact, static unit]**: §0's
  `bundle.businesses` guard. The bundle payload bytes are UNCHANGED
  (same embedded hash) — this was a guard gap, not an artifact defect,
  so no regeneration was warranted.
- **C3.5 records [fact]**: this document, the DECISION_LOG correction-3
  amendment, and the GOLDEN_CASES amendments; §10's attestation now
  names the v3 transaction (05:42:39 UTC) and Codex's independent
  07:01:09 UTC probe, and the superseded v2 wording is corrected.

The seven correction-2 closures as amended, each with its evidence class:

- **C2.1 real business switching [fact, browser]**: `switcherProof` is a
  machine-readable hop array — 11 hops (5 at 1440 px, 6 at 390 px), each
  `{width, from, to, selectedIdentity, renderedIdentity, pass}` — and
  every hop clicks the real topbar switcher; the chain traverses ALL SIX
  businesses at BOTH widths from the one seeded initial state, with zero
  `sessions.active_business_id` writes between hops. The shared validator
  rejects the correction-1 single-string shape and any per-width chain
  that misses a business. **The correction-1 claim "switched via topbar
  across six businesses" is corrected: it was one hop + five DB writes.**
- **C2.2 stale/fresh CTA through the ACTUAL route [fact, actual-route
  integration proof — AMENDED by C3.2 above]**:
  `app/api/meta/decisions-workspace/route.lattice-cta.db.test.tsx` invokes
  the real GET handler against a constitutionally valid seeded lattice
  (calibration batch→cells→daily→context→evaluations→snapshots through
  the real composite FKs and CHECKs; a decisions job run whose
  hydration-receipt manifest hash is the REAL
  `hashAdDecisionIdentityManifest` recomputation; finalized+validated
  warehouse ad-days; fresh sync activity; and a healthy
  physical-capacity telemetry sample so the REAL growth fence admits —
  no gate is bypassed). Sibling upstreams run in-process via the shipped
  `META_DECISIONS_UPSTREAM_TRANSPORT` option; a throwing fetch spy
  proves zero provider/network calls. The route response contains BOTH
  exact seeded Ad rows; the shipped 12-hour evaluator itself derives one
  stale (≈180 h ⇒ `stale_decision`: review-only "Refresh Decision" +
  provider mutation null) and one fresh (`live_preflight_required` ⇒
  supervised Cut whose copy states the live preflight). The
  campaign-role authority env is stubbed process-scoped inside the test
  only — the repo's established simulation practice — never in the
  shell, and no production env bypass exists. **Corrected by C3.2**: the
  correction-2 mock ledger was false (auth and posture were also mocked
  — both are REAL now), its rendered-UI leg proved queue text only
  through a nonexistent selector, and the actionable-control proof lives
  in the drawer test above.
  The browser leg remains labeled honestly: offline, the workspace
  WITHHOLDS native rows because no live provider inventory exists — that
  browser proof covers FAIL-CLOSED withholding and the absence of
  mutation controls, NOT row-level CTAs; row-level actionable controls
  are the drawer test's proof. **The correction-1 claim that
  `stale-fresh-cta-boundary.test.tsx` was "end-to-end" stays corrected:
  it is the static function-level complement (relabeled in-file),
  because it never invoked the route.**
- **C2.3 tri-state account evidence [fact, route + render tests —
  AMENDED by C3.1 above]**: on the workspace, `assignedAccountStates`
  distinguishes `undefined` (legacy payload; renders nothing) from
  `null` (read FAILED ⇒ the visible "Assigned-account coverage
  unavailable — do not assume there is only one/no historical account"
  warning — never a silently empty section) from `[]` (proven-zero,
  rendered as its own anomalous state) — now proven THROUGH the real
  adapter, whose correction-2 revision collapsed `undefined` into
  `null` (C3.1). On History, `historicalAccounts` is `array | null`
  ONLY: both a failed read and an absent legacy field map to `null`
  (the visible unavailable note), fail-closed by design — no
  `undefined` state exists there and none is claimed. The journal route
  answers a deep link to a non-selected scope with fail-closed 503
  `meta_history_account_scope_unavailable` when the authority read
  fails, and 404s only after a successful authority read proves absence.
  Server→client→render tests cover all states.
- **C2.4 complete visible facts + real selection [fact, browser at 1440
  AND 390 px]**: `accountTimezone` is carried route→adapter→UI; the
  coverage strip is now a per-account PANEL whose facts (identity,
  selection state, currency, timezone, own-window 14d spend,
  facts-through date, latest produced decisions with authorized counts
  and "unserved") and full operator policy are VISIBLE TEXT, not
  tooltips. The harness actually SELECTS NonTesvik in TheSwaf History at
  both widths and asserts the journal answered
  `accountScope: "deselected_historical"` plus the note's
  identity/currency/timezone/spend/freshness/generation/policy lines and
  zero write controls (12/12 assertions per width). TOCTOU and
  write-authority suites stay green; the negative guard proves
  account-state evidence feeds no write selector.
- **C2.5 exit guard [fact, static unit + live]**: all harness verdicts
  flow through `validateD078Matrix`; any assertion failure, failed hop,
  missing/duplicate entry, missing/zero-byte screenshot, contract
  mismatch, or failed route proof sets a nonzero exit AFTER `finally`
  teardown. Deterministically fail-first proven
  (`lib/meta/__tests__/d078-matrix-contract.test.ts`, 7 tests) and
  proven live: the first correction-2 run exited 1 on 5 real violations
  (they drove real fixes), the final run exited 0.
- **C2.6**: bundle v3 `charterAssignments` + pair-walking guard + the
  in-transaction production probe (§0).
- **C2.7 → C3.5**: this document, the DECISION_LOG amendments, and the
  GOLDEN_CASES entries preserve the full THREE-rejection history
  (original → correction 1 → correction 2, each independently rejected)
  and label every closure's evidence class; deployed behavior remains
  the §4 babf158e1 evidence and is claimed for nothing newer. The
  historical label tables and route aliases are NOT physically removed:
  runtime/UI authority is automatic-only, and physical compatibility
  deletion stays behind the §8 deployed-release + persisted-payload-
  census migration gate. Correction 3 was subsequently independently
  accepted by Codex as the local D078 evidence package; deployment,
  production recovery, compatibility deletion, and automation remain
  outside that acceptance.

**R1 fix**: superseded by C2.6 (bundle v3, above).
**R2 fix (upheld)**: the dev-server launch entry was removed from
`.claude/launch.json` (the user's own entries untouched); the harness
generates its token per run, holds it in memory only, launches dev
server/browser/assertions itself, and tears everything down in
`finally`; the residue guard pins all of it. Teardown readback [fact]:
ports 15544 and 3210 closed, no harness/dev-server process, no data
directory, no launch entry.
**R3 fix**: superseded by C2.1/C2.2 (above).
**R4 fix (new capability, general)**: `lib/meta/assigned-account-states.ts`
(read model over ALL assigned identities: selection state, currency/tz,
latest fact date, own-window 14d spend, latest produced generation +
authorized counts, operator policy line); served additively on the
decisions-workspace payload (`assignedAccountStates`, classified in the
executable payload-coverage matrix with measured DOM proof [7,2]) and
rendered as the display-only account-coverage strip; History accounts
endpoint serves a separate `historicalAccounts` group and the journal now
serves a deselected-but-bound account as an explicitly marked read-only
scope (`accountScope: "deselected_historical"`) while an unbound id still
404s; write scopes are untouched (deselected never appears in any write
control). Fail-first: the journal route test file, unmodified, failed 5
against the new route until the deliberate contract update; the new
accounts-route/view probes fail on the rejected code by construction (no
historical group/optgroup/note existed).
**R5 fix**: the History filter renders `label_flips` as **"Decision
transitions"** (wire kind unchanged for persisted history); render test
proves no "Label flips", no label-ask copy (fail-first: 1 failed on the
reverted rename).

## 6. Capability matrix (worktree code census — unchanged from the first pass)

Pause/resume ad/ad-set/campaign: YES (preflight+claim+read-back). Ad-set
bid amount: YES. Budget edit of existing entities: NO. Allocation: NO.
Structure create: PARTIAL (Launchpad paused drafts with budgets/bid/
targeting at create time; prefill handoff otherwise). Structure/targeting
edit: NO. Creative replace: PARTIAL (duplicate only). Receipts/rollback:
implemented actions only (pause↔resume self-inverse). Outcomes/learning:
code present, data zero. Incident controls: YES.
**Ads Manager remains required for**: budget changes on existing
campaigns/ad-sets, bid strategies beyond one ad-set field,
audience/targeting/placement edits, creative swap on a live ad,
campaign-structure edits, catalog/feed work — and (by write-authority
design, not by evidence gap anymore) any MUTATION on the deselected
TheSwaf account.

## 7. Blunt verdicts

- **Decision-output quality**: arithmetic sound and fail-closed gating
  correct — on an 8-day-stale warehouse, an engine predating role-authority
  closure, zero outcomes, zero calibration. Hold, not act.
- **UI truthfulness**: deployed is not truthful (P0/P1 list above); every
  confirmed defect now has a branch fix, including the account-state
  invisibility this correction closed. The gap is a deploy decision.
- **Advisor/Decision Engine ability to manage ads**: recommend within
  purchase-ROAS scope, supervise pause-grade actions after recovery,
  mutate {pause, resume, one bid field, duplicate, paused-draft launch}.
  Nothing more.
- **Ready for automatic enablement (kept OFF)**: no — evidence lanes
  (outcomes 0, experiments 0, roles 0, calibration 0, ingestion stopped)
  gate it, not code wiring.
- Env readback [fact]: `META_AUTOMATION_ENABLED`,
  `CAMPAIGN_CONTEXT_AUTHORITY_RESOLVER_VERSION`,
  `STATE_HISTORY_COMPACTION_ABORT` all unset.

## 8. Dependency-ordered roadmap ("no Meta Ads Manager")

*Local code:* D072–D078+correction complete on this branch. Remaining
local follow-ups (small, non-blocking): rename the residual internal
`label_flips` wire kind only if a history-contract migration is ever
warranted; IwaStore guardrail currency row correction via settings.
*Deploy gate:* 1) deploy the branch.
*Production recovery:* 2) `CREATE EXTENSION pgstattuple`; 3) D077 planner
dry-run (exact removable counts still [unknown]); 4) approved compaction
via CLI; 5) vacuum → effective-metric re-admission; 6) optional physical
shrink; 7) seven natural waves incl. a valid Grandmix manifest.
*Supervised evidence:* 8) outcome accrual + operator-response runs green
14 days; 9) role-resolver rebuild → independent 10–15-campaign
adjudication (authority env stays unset until its 90% gate); 10) ≥20
supervised actions with full lineage; controlled registries populated.
*Compatibility-removal gate (R5.3, explicit):* after one deployed
canonical-only release AND a production persisted-payload census, remove
the deprecated label parse aliases, the label-route tombstone, and the
frozen manual-label tables in one separately-reviewed migration with
backup/retention terms. Runtime authority is automatic-only NOW; this
gate only deletes dead compatibility.
*Capability build-out (D079, not started):* budget-edit contract first,
then structure/targeting/creative, each with preflight/read-back/rollback.
*Activation:* separate operator decision after all of the above.

## 9. Verification (serial, `--maxWorkers=1`; the correction-3 battery)

Recorded in the final response with exact counts: new fail-first tests
for C3.1–C3.4 (four-state adapter chain, drawer/action proof probes,
ordered-chain validator cases, top-level scope pinning, static wiring
guards); the standalone route+drawer runner (real ephemeral DB, clean
teardown); the full browser harness; all correction-2 focused suites plus
D074/D075/D077 closure guards;
`npx vitest run lib/creative-decision-engine lib/meta`; affected app
suites (history routes/views, workspace route/coverage, automation trio,
exact component probes); `npm run test:migrations-from-zero`;
`npx tsc --noEmit`; focused ESLint on every changed file;
`git diff --check` + untracked whitespace; embedded-hash recomputation +
file sha256 for bundle/recompute/matrix + per-screenshot nonzero checks;
pair-scope guard; residue scan; teardown readback; env readback; the
final harness run (31 entries, 11 hops, routeCtaProof exit 0, command
exit 0).

## 10. No-mutation attestation

Production access was SELECT-only inside REPEATABLE READ READ ONLY
transactions. Two distinct read sessions stand behind this record: (1)
the **bundle v3** transaction at **2026-08-30 05:42:39 UTC** (with the
recompute read at 05:44:26 UTC in the same session), which produced the
accepted evidence under review; (2) **Codex's own independent readback**
at **2026-08-30 07:01:09 UTC** (`transaction_read_only=on`, repeatable
read), which re-ran the shipped seven-account probe and confirmed the
same six businesses / seven pinned pairs and values. The earlier v2
session (03:49:35 UTC) is superseded and is no longer the basis of any
claim here. Correction 3 itself performed NO production access.
No commit, push, PR, deploy, production migration, extension install,
retention/compaction execution, scheduler change, provider/Meta mutation,
ad change, activation, or automation enablement. The deployed Cut ceremony
was opened and closed without submit. All writes happened only inside
throwaway local clusters that were deleted (ports/process/dir readbacks
recorded). The local dev server was never pointed at the production
tunnel.

## Files changed by D078 (original + corrections 1–2)

Code: `app/(dashboard)/platforms/meta/automation/legacy-page.tsx` +
`automation-view.tsx` + `page.test.tsx` + `legacy-page.test.tsx`;
`app/(dashboard)/platforms/meta/history/history-view.tsx` +
`page.test.tsx` + `historical-account-scope.test.tsx` +
`HistoryPage.module.css`; `app/api/meta/history/route.ts` +
`accounts/route.ts` (+ both route tests);
`app/api/meta/decisions-workspace/route.ts`;
`lib/meta/assigned-account-states.ts` (new); `lib/meta/history-contract.ts`
+ `history-client.ts`; `components/meta/redesign/types.ts`;
`components/meta/decision-center/meta-decision-center-exact-adapter.ts` +
`MetaDecisionCenterExact.tsx` + `decision-payload-coverage.test.ts` +
`account-coverage-strip.test.tsx` + `stale-fresh-cta-boundary.test.tsx`;
`lib/meta/__tests__/d078-acceptance-guards.test.ts` (new) +
`state-history-consumer-closure.test.ts` +
`campaign-role-vocabulary-closure.test.ts` (ledger classifications);
`app/(dashboard)/platforms/meta/history/demo-journal-render.test.tsx`
(mock ripple). Correction 3 adds/changes:
`components/meta/decision-center/meta-decision-center-exact-adapter.ts`
(the `?? null` collapse removed) + `MetaDecisionCenterExact.tsx`
(four-state doc) +
`assigned-account-tri-state-adapter.test.tsx` (new, fail-first C3.1);
`app/api/meta/decisions-workspace/route.lattice-cta.db.test.tsx` (real
auth + real posture, honest ledger, real-selector queue test, handoff
write) + `drawer-cta.db.test.tsx` (new, the drawer/action proof);
`scripts/audits/d078-matrix-contract.ts` (`D078_SWITCH_ORDER` +
ordered-chain validation) + `lib/meta/__tests__/d078-matrix-contract.test.ts`
(seven C3.3 fail-first cases);
`lib/meta/__tests__/d078-acceptance-guards.test.ts` (C3.4 top-level
pinning + static wiring guards); `scripts/audits/d078-route-cta-runner.ts`
(two serial proofs + handoff); `scripts/audits/d078-local-ui-ephemeral-harness.ts`
(shared switch order, two-proof routeCtaProof). Correction 2 added:
`app/api/meta/decisions-workspace/route.lattice-cta.db.test.tsx` (new,
the actual-route CTA proof); `scripts/audits/d078-matrix-contract.ts`
(new, shared validator) + `lib/meta/__tests__/d078-matrix-contract.test.ts`
(new, fail-first); `scripts/audits/d078-lattice-seed.ts` (new, shared
single-transaction seed); `scripts/audits/d078-route-cta-runner.ts` (new,
fast iteration runner); tri-state/timezone/panel changes in
`components/meta/redesign/types.ts`, the workspace route + Decision
Center panel, `lib/meta/history-client.ts`, the History view/route and
their tests. Scripts: the `scripts/audits/d078-*` read-only harnesses
(bundle v3 / recompute / local-UI harness).
`.claude/launch.json`: the D078 dev-server entry REMOVED. Docs: this file,
the generated artifacts (bundle v3, recompute v3, local-UI matrix v3 +
31 screenshots), the D075 sweep artifact line, `DECISION_LOG.md` § D078
(+ correction-2 amendment), `GOLDEN_CASES.md` (SC-023/024 + correction
cases).
