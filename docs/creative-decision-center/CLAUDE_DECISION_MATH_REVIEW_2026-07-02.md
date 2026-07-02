# Claude Decision Math Review — 2026-07-02

Independent theoretical review of the Adsecute Creative Decision Center decision
math. Written before reading `DECISION_MATH_THEORETICAL_REVIEW_2026-07-02.md`;
Section 6 was added afterwards and is the only section informed by it.

---

## 1. Evidence Boundary

**What was reviewed.** Branch `codex/adsecute-creative-decision-hardening` at
HEAD `7441536f` **plus uncommitted working-tree changes** (31 modified files, 5
new). Docs read in the required order (START_HERE, DECISION_LOG D001–D032,
DATA_READINESS, GOLDEN_CASES, INVARIANTS). Code read: `engine.ts`,
`config-values.ts`, `spend-unit-resolver.ts`, `account-decision-profile.ts`,
`gates/{types,scope,target-resolution,diagnose,quality-only,zero-conv-burner,maturity,ratio-zones}.ts`
(note: the prompt lists `maturity.ts`/`ratio-zones.ts` at the engine root; they
live under `gates/`), `fatigue.ts`, `funnel.ts`, `outcome-classifier.ts`,
`kind-aware-profile.ts`, `campaign-label-guard.ts`, `data-source.ts`,
`jobs/{decisions-job,decision-outcomes-job,calibration-job,scheduled,business-guard}.ts`,
`backtest.ts`, `backtest-store.ts`, `automation-readiness.ts`, and the
decision-center bridge/adapter/snapshot/validator files.

**Working-tree deltas relevant to math.** The core gate/formula files
(`engine.ts`, all of `gates/`, `config-values.ts`, `fatigue.ts`, `funnel.ts`,
`spend-unit-resolver.ts`, `account-decision-profile.ts`) are **unchanged** from
HEAD. Changed in the working tree: `campaign-label-guard.ts` (the `no_campaign`
bypass is now closed — hard decisions without a campaignId are guarded to
`diagnose` with the same ≤50 confidence cap), `outcome-classifier.ts` (version
bumped to v2; severity thresholds became baseline-relative instead of absolute
1000/500/150), plus scheduler/business-guard/freshness plumbing
(`jobs/scheduled.ts`, `jobs/business-guard.ts`, briefing route now serializes
`maxAgeHours=26`, `latestSnapshotAsOf`, `snapshotAgeHours`, real `generatedAt`,
and an `unknown` freshness status).

**Verification state.** `npx vitest run lib/creative-decision-engine
lib/creative-decision-center app/api/creatives/briefing` on this working tree:
48 files passed + 4 skipped, 486 passed / 53 skipped / 57 todo, 0 failures. The
53 skipped are `describe.skipIf(!DATABASE_URL)` DB-integration tests — job/
warehouse behavior is not verified by this run. Every load-bearing formula
claim below was verified against current source lines, not memory.

**What is unknown / not verifiable here.** (a) Live per-account values of the
calibration percentiles (roasRatioP10/P25, winnerPurchaseP50, CPA P50) — every
zone boundary depends on them; (b) the attribution semantics of
`meta_creative_daily.conversions/revenue` (which Meta action type and
attribution window ingestion maps); (c) whether `CreativeInput.ctr` is
guaranteed percent (the `lowCtrP10 ?? 1.0` fallback and funnel `rate()×100`
imply percent; a fraction-unit source would silently disable the low-CTR
logic); (d) production campaign-label coverage (an earlier read-only session
measured it at roughly 10–35% of active campaigns across the four businesses;
not re-queried in this pass); (e) operator compliance behavior. No DB queries
were run in this pass; no code, tests, or live systems were touched. This
review created exactly one file (this report).

---

## 2. Formula Map

Pipeline: `decideCreative` = kind-aware profile selection → scope →
target-resolution → diagnose → quality-only → zero-conv-burner → maturity →
ratio-zones → fallback `test_more`; every terminal passes `finalizeDecision`
(test-cohort transform → soft-only downgrade → post-process deltas → clamp) and
a redundant `enforceHardActionEligibility`; then the campaign-label guard.

### 2.1 Commercial unit and thresholds

`spendUnit` provenance ladder (spend-unit-resolver.ts): `targetCpa` (high,
hard-eligible) → `operatorAov/targetRoas` (high) → `metaAov90d ×
attributionAdj / targetRoas` (medium if ≥20 purchases/90d, else low) →
`accountCpaP50` (medium/low, never hard-eligible) → `metaAov/breakEvenRoas`
(low) → `insufficient` (all spend thresholds null). Engine-wide confidence
deltas: insufficient −20, low −10.

All spend thresholds = `spendUnit × preset multiplier` (config-values.ts,
balanced): zeroConvBurner 3.0, cutCandidate 2.0, sustainedLoser 3.0,
lossBudget 2.0, hardCut 5.0, recentSample 0.5. Purchase floor for scale =
`ceil(winnerPurchaseP50 × {0.7/1.0/1.5})`. Ratio boundaries: cut zone =
account `roasRatioP25 ?? 0.7`; severe loser = `roasRatioP10`; scale entry =
fixed `{1.2/1.3/1.4}`; target band starts at 0.85; refresh decay =
`refreshRatioP10 ?? 0.75`.

**Assumptions encoded:** one CPA-sized unit of spend is the natural quantum of
evidence; the account's own trailing-90d distribution is the correct benchmark;
preset multipliers (2/3/5 units) are acceptable loss budgets per risk posture.

### 2.2 Target resolution (truth ladder)

Operator `targetRoas` → commercial_truth (no penalty); else account roasP75 if
≥30 mature converters (−5); else roasP60 if ≥10 (−15); else global_default with
target 0 and ratio null (−25). `ratioToTarget = roas/target` only when both
positive-finite. **Assumption:** percentile-of-peers is a usable target when
the operator has not stated one; count thresholds (30/10) proxy estimator
reliability.

### 2.3 Gate formulas

- **Diagnose:** stale if `dataFreshnessHours > 48` (badge + downstream cap 65).
  Verified no-delivery: ACTIVE ∧ spend24h≤0 ∧ impressions24h≤0 (both non-null)
  ∧ freshness ≤36h → base 75. Policy proof (explicit rejected/limited enums or
  reason text) → base 75. Funnel LP/checkout diagnosis conf ≥0.65 → base 70.
  Tracking anomaly → base 85 (**dead**: `computeFunnelDiagnosis` never returns
  "tracking"). Note `dataFreshnessHours === null` fails the `!== null` check in
  `isStaleData` (gates/diagnose.ts:47-52) and is therefore treated as fresh.
- **Quality-only** (only when truth=global_default ∧ ratio null): weighted mean
  of component ratios vs account P50, weights hook .05 / ctr .10 / cpm .10 /
  clickToLpv .15 / lpvToAtc .20 / atcToIc .25, each clamped [0.5, 2];
  component dropped when stage denominator confidence <0.5 with
  `denomConf = min(1, n / fallbackP50)` and fallbacks 1000 impressions / 50
  clicks / 10 ATC; weights renormalized over surviving components. Bands:
  ≥1.3 strong, ≥1.0 above_average, ≥0.85 neutral, ≥0.7 below_average, else
  weak. Confidence base = `round(clamp(0.5 + minDenomConf×0.2 + 0.03×k,
  0.45, 0.85) × 100)` — **while the −25 global_default delta from gate 2 is
  still in the context**, a systematic double penalty.
- **Zero-conv burner:** purchases === 0 ∧ ageDays ≥7 ∧ spend ≥
  max(spendUnit×{2/3/5}, maturityThreshold) ∧ status null-or-ACTIVE → cut, +5.
  Implicitly Poisson-sane: at 3 units, P(0 purchases | average creative) ≈ e⁻³
  ≈ 5%. Nothing in code states this; the aggressive preset (2 units ⇒ ~13.5%
  false-cut odds for an average creative) is materially looser.
- **Maturity:** threshold = max(recentSampleMinSpend ?? 50, spendUnit ×
  lossBudget), falling back through accountCpaP50×lossBudget →
  sustainedLoserSpend → matureSpendP50 ?? recentSampleMinSpend ?? **300
  (bare constant)**. Below threshold: severe-loser carve-out (spend ≥ hardCut
  ∧ ratio < P10) — **unreachable under every default preset** because hardCut
  multiplier (3/5/8) > lossBudget multiplier (1.5/2/2.5) and the gate is only
  entered when spend < lossBudget threshold; then `test_more` (launch badge if
  explicit launch age ≤3d).
- **Ratio zones** (28d blended ROAS/target): ratio ≥ scaleRatio → `scale` only
  if purchases ≥ scaleMinPurchases ∧ calibrationReady (≥30 mature) ∧
  winnerPurchaseP50 present ∧ freshness ≤48h ∧ recent7dRoas ≥ target; any miss
  → near-scale `keep` with typed blockers (`scale_spend_depth` blocker is dead
  — spend depth is guaranteed by the maturity gate). Band [0.85, scaleRatio):
  fatigue refresh iff fatigued ∧ recent7dSpend ≥ recentSampleMinSpend ∧
  recent7dRoas/roas < refreshRatioP10??0.75; else keep sub-bands (<0.95 weak /
  <1.15 at target / else near scale). **Cut zone `ratio < roasRatioP25??0.7`**
  (ratio-zones.ts:599): a three-tier ladder (hardCut → sustainedLoser∧P10 →
  lossBudget maturity) whose third predicate (line 632, `spend ≥
  commercialMaturitySpend`) is **always true** because the maturity gate
  already enforced the same pure function — so the ladder collapses to
  "below-P25 ⇒ hard cut at ~2 spend-units", and the fatigue-refresh and
  "observe, not yet mature" branches at lines 646–664 are unreachable.
  Band [P25, 0.85): fatigue-decay refresh, else below-breakeven "demote
  candidate" keep at hardCut spend, else weak-zone keep.
- **Finalization:** test-campaign refresh→cut (recorded as `labelTransform`);
  soft-only downgrades when hard-action eligibility fails (scale→keep+badge,
  cut→test_more+cut_candidate, refresh→keep); post-process: dataHealth stale
  tier −10/−15/−25, `ctr < lowCtrP10??1.0` → badge **and −10 on cut/refresh**,
  missing recent7d −10, lifecycle deltas (+5 scale rising / +3 keep / +2
  plateau / −3 past-peak refresh/cut / −5 volatile); confidence =
  clamp(base+Σdeltas, **40**, 95), then min(·, **65**) if `stale_evidence`.
  Label guard (working tree): unlabeled **or missing campaignId** hard
  decisions → `diagnose`, confidence ≤50, `blockedActionType` preserved,
  stop-loss badge for cuts.
- **Fatigue:** bestWindow = highest-ROAS of {last14/30/90/allHistory} (no
  spend floor on the baseline window); decay = (best−current28d)/best,
  significant ≥0.18 for CTR / click-to-purchase / ROAS; pressure =
  spendConcentration ≥0.55 or frequency ≥2.5; winner memory = ≥2 windows with
  spend ≥ minSpend ∧ purchases ≥ minPurchases ∧ ROAS ≥ max(0.85×target,
  1.1×breakeven, fallback 1.5). `fatigued` requires winner ∧ ≥2 decays ∧
  (pressure ∨ benchmark weakening). **Production callers pass
  spendConcentration=null, benchmark statuses=null, and omit the winner-memory
  minimums** (defaults 0 spend / 1 purchase), so in practice pressure =
  frequency-only and winner memory ≈ any window with one purchase.
- **Outcome classifier v2 / backtest:** scale positive iff outcome ROAS ≥
  target ∧ purchases>0, negative <0.8×target; cut positive iff purchases≤0 ∨
  ROAS <0.7×target, negative ≥target; refresh positive iff <0.9×target ∧
  <0.85×baseline; non-hard "positive" = missed hard action (≥1.3×target ∧ ≥2
  purchases, or ≤0 purchases / <0.6×target); zero forward spend or missing
  target → unknown. Severity (v2, working tree): relative to baseline spend
  (≥1× critical, ≥0.5× high, ≥0.25× medium) with a **currency-blind 250
  fallback** when baseline is missing. Backtest: precision = positive hard
  rows / **all** hard rows (neutral and unknown count against); recall is
  opportunity-based; ECE = decile buckets vs bucket midpoint, pooled across
  hard and non-hard labels.

---

## 3. Strengths (code-backed)

1. **Account-relative, provenance-tracked calibration.** Zone boundaries and
   spend quanta derive from the account's own distribution with explicit
   sample gates in SQL (`converter_count >= 30/10/20`) and a deterministic
   spend-unit ladder whose confidence tier feeds both engine confidence and
   hard-action eligibility. This is the right skeleton; most tools hardcode
   global constants.
2. **Scale is genuinely hard to earn and machine-explainable.** Six
   independent predicates, each failure emitting a typed
   `DecisionPredicateBlocker` — the near-scale `keep` rows carry exactly what
   is missing (GC-050–053 lock this in executable tests).
3. **Loss-averse staleness asymmetry (D032) is theoretically defensible.**
   Stale evidence hard-vetoes scale (which needs fresh recent-hold proof) but
   only caps stop-loss cuts at 65 — the expected cost of acting on a stale
   winner exceeds the cost of flagging a stale severe loser for review.
   GC-057/058 pin the behavior.
4. **The funnel-attribution guard prevents a classic false cut.** Cut/refresh
   terminals consult `computeFunnelDiagnosis`; LP/checkout-diagnosed weakness
   with `creativeResponsible=false` downgrades refresh→keep and caveats cut
   (ratio-zones.ts:330–407).
5. **Zero-conv burner encodes sane implicit Poisson logic** at the balanced
   preset (3 CPA-units of spend with zero purchases ≈ 5% false-cut odds for an
   average creative), with an age floor and confirmed-delivery guard.
6. **The label guard is now closed on both entry points** (working tree):
   unlabeled *and* campaignless hard actions demote to diagnose ≤50 with the
   original verdict preserved as `blockedActionType`; the bridge mirrors the
   same rule defensively (`v3-bridge.ts` HARD_V3_ACTION_LABELS + label-gap
   check), so a guard regression cannot leak a hard action to the buyer
   surface.
7. **Determinism and auditability are engineered:** same input/config/version
   → same output (invariant + tests); badges, reason strings, labelTransform,
   truthSource, and snapshot lineage (job_run/lifecycle/calibration row ids)
   make every decision replayable.
8. **Executable golden cases exist** (22 of 59 run against `decideCreative`,
   including the loss-budget/scale-gate family GC-048–053 and stale stop-loss
   GC-057/058), plus a static test that greps UI sources to enforce "UI must
   not compute buyerAction".

---

## 4. Findings Ranked by Severity

**F1 — The cut ladder collapses to its weakest tier (high, confirmed).**
Because `maturityGate` and the ratio-zones cut block gate on the *same*
threshold function, tier 3 (ratio-zones.ts:632) is always satisfied: every
below-P25 creative past ~2 spend-units receives a **hard cut** with no minimum
purchase evidence and no recent-window recovery check; the graduated tiers
survive only as reason text, and the fatigue-refresh/observe branches
(646–664) are dead. At the balanced preset this cuts on ~2 expected purchases
of evidence — far below any reasonable sample floor for an irreversible
recommendation — and asymmetric against high-variance creatives (a lucky/
unlucky 2-unit window is common). GC-048 locks this behavior in as *expected*,
so the golden suite currently certifies the defect.

**F2 — The cut boundary is an unclamped relative percentile (high,
theoretical, needs live data to size).** `bottomQuartileRatio =
roasRatioP25` with no absolute clamp (account-decision-profile.ts:182;
fallback 0.7 only when null). By construction ~25% of the mature converter
population sits below it. In a strong account, P25-of-ratio can exceed 0.85 —
or 1.0 — and the cut zone then swallows creatives that are *profitable and
near target* (the [P25, 0.85) demote band vanishes when P25 ≥ 0.85). In a weak
account P25 sinks far below breakeven and true losers survive. Grading on a
curve conflates "worse than peers" with "losing money". The boundary needs a
clamp (e.g. `min(roasRatioP25, ~1.0)` upper, plus a breakeven-anchored floor)
— the exact bounds should come from the historical sweep in §5.

**F3 — Confidence is a pseudo-probability that downstream code treats as a
probability (high).** Bases (75/70/85/60/55) and deltas (−5…−25, +2…+5) are
unvalidated constants; the clamp floor of 40 hides compounded negative
evidence; quality-only decisions are double-penalized (§2.3); the low-CTR
delta on cut/refresh (−10, gates/types.ts:166-168) points the wrong way — low
CTR is *supporting* evidence for a cut, not against it. Meanwhile the lane
router (`decisionLane`, briefing route) thresholds at confidence ≥70 and the
backtest's ECE treats confidence as a calibrated probability. Incoherent
end-to-end: numbers invented as heuristics are consumed as statistics.

**F4 — Freshness gating has a null hole and no engine-side age quantification
(medium-high).** `dataFreshnessHours === null` bypasses `stale_evidence`, the
65 cap, and the scale freshness veto (gates/diagnose.ts:47-52). A source that
omits freshness metadata is treated as maximally fresh — the exact inversion
of safe-default. (The working tree improves *presentation* — snapshotAgeHours,
maxAgeHours=26, `unknown` status in the briefing response — but the engine
gate itself still trusts null.) Also, stale cuts are deliberately routed to
the Action lane by the briefing route while capped at 65; defensible per D032,
but only if the UI renders the cap and the stale badge prominently, which is a
contract this review cannot verify from math alone.

**F5 — Fatigue math is mostly disconnected in production (medium-high).**
With nulls for concentration/benchmarks and no winner-memory minimums at both
call sites, `fatigued` reduces to: any two nested windows containing one
purchase + ≥2 decay ratios ≥0.18 + frequency ≥2.5. Nested windows
(last14⊂last30⊂last90⊂allHistory) double-count toward the two-window
requirement; the max-ROAS baseline window has no spend floor, so a thin lucky
window inflates all three decay ratios (mean-reversion masquerading as
fatigue); daily-averaged frequency underestimates cumulative frequency
(ingestion-side), biasing the one live pressure signal downward. Net: refresh
verdicts ride on a signal whose designed evidence requirements are silently
absent.

**F6 — Window semantics bias recent-hold and decay checks (medium).**
`spend24h/impressions24h` are the asOf *calendar date*, not a rolling 24h —
early-day runs feed near-zero "24h" delivery under a misleading name (the
verified no-delivery gate requires non-null, but the semantics remain wrong).
Attribution lag makes recent7dRoas systematically pessimistic relative to 28d
blended ROAS; this makes the scale recent-hold conservatively strict
(acceptable) but also pushes the refresh decay ratio (recent7d/28d) toward
false fatigue (compounds F5). Missing payload_json funnel fields COALESCE to 0
and dilute impression-weighted rates, feeding false "weak upper funnel"
components into quality-only and diagnosis.

**F7 — Outcome classification validates momentum and is confounded by
compliance (medium — becomes high the moment anyone reads the backtest
numbers as accuracy).** Decisions are made from ROAS-vs-target and scored
days later on the same creative's ROAS-vs-target: autocorrelated performance
self-confirms cut/scale. A *followed* cut (paused → zero forward spend) scores
"unknown" and still counts against precision; a followed scale that saturates
from the budget change scores as an engine false positive. The
operator-response module exists but is never joined and does not track cuts.
ECE pools hard and non-hard labels whose "positive" have opposite meanings —
the ≤0.05 gate is unpassable by a good engine as specified. Severity v2's
baseline-relative bands fix the worst currency distortion but keep a
currency-blind 250 fallback.

**F8 — Dead or contradictory math paths (low-medium, cheap to fix).**
(a) Tracking-anomaly diagnose (base 85 — the engine's highest-confidence
terminal) is unreachable. (b) The maturity severe-loser carve-out is
unreachable under all presets (§2.3) — GC-009's "severe early overspend"
intent exists in doc but not in reachable code. (c) `scale_spend_depth`
blocker is dead. (d) Post-process `cut_candidate` uses `min(0.6, P25??0.6)`
while the live cut boundary is `P25??0.7` — two definitions of "bad ratio" in
one engine. (e) `enforceHardActionEligibility` re-applies what
`finalizeDecision` already did — harmless today, a divergence trap tomorrow.

**F9 — Unit and fallback contract risks (low, unknown likelihood).**
`lowCtrP10 ?? 1.0` and funnel `rate()×100` assume percent units for CTR-like
inputs; a fraction-unit regression upstream would silently disable low-CTR
logic and distort quality components. The maturity chain's terminal `?? 300`
constant is currency- and account-blind. `getBusinessTargetPack` and calibration
reads swallow DB errors into null — a transient outage silently reshapes
thresholds (spend-unit downgrade, percentile loss) with only evidence-string
breadcrumbs.

**F10 — The golden suite certifies labels, not math (low as a defect, high as
a false-assurance risk).** GOLDEN_CASES.md line 3 demands each case assert
confidence, priority, problemClass, maturity, and reason tag; the executable
test asserts only the primary label for 22 of 59 cases (37 todo). The
INVARIANTS.md metamorphic table ("stale ⇒ capped stop-loss, blocked scale",
"weak benchmark ⇒ confidence down", …) still ends with "TODO: Convert these
into executable tests". So the safety net that would catch F1–F4 regressions
does not yet exist in executable form.

---

## 5. Historical Data and Scenario Backtest Plan

The warehouse (`meta_creative_daily`, fresh to 2026-07-02, 12 businesses) is
sufficient to run everything below read-only and offline.

**Where historical data helps directly:**

1. **Cut-threshold ROC / regret sweep (attacks F1, F2).** Replay every
   (creative, day) over the trailing 180d: reconstruct engine inputs, simulate
   the cut rule under variants (current; +purchase floor 2/3/5; +recent-7d
   recovery guard; P25 clamped to [breakeven-anchored floor, 1.0]), then
   measure forward 14/28d realized ROAS. Metrics: premature-cut rate
   (creatives flagged cut that subsequently held ≥ target), spend saved on
   true losers, median days-earlier vs a perfect-hindsight cut. Survivorship
   caveat: history only contains creatives the operator did not kill, so
   premature-cut rate is *underestimated* — usable for ranking variants, not
   for absolute accuracy claims.
2. **Percentile stability audit (attacks F2, target ladder).** Bootstrap
   roasRatioP10/P25 and roasP60/P75 per account per week; report CI width vs
   mature-count. This turns the arbitrary 30/10/20 count gates into empirical
   CI-width gates and answers whether four accounts of this size can support
   percentile targets at all, or whether P25 needs shrinkage toward a pooled
   prior.
3. **Zero-conv burner multiplier validation.** Empirical distribution of
   "spend-units consumed before first purchase" among eventual converters, per
   account: directly validates/falsifies the 2/3/5 multipliers and quantifies
   the aggressive preset's false-cut odds.
4. **Fatigue decay vs mean reversion (attacks F5).** For historical winner
   windows, measure P(recovery within 14d | decay ≥0.18) with and without the
   designed pressure/winner-memory requirements. If recovery is common at 0.18
   with frequency <2.5, the wiring gap is materially generating false refresh
   pressure.
5. **Confidence recalibration (attacks F3) — only after outcomes accrue.**
   With the producer chain scheduled (working tree) and the classifier fixed,
   fit per-label reliability curves of realized outcome vs confidence; then
   either refit the deltas or replace the additive scheme with a small
   monotone model. Do not hand-tune constants before this data exists.
6. **Regression-discontinuity as a counterfactual substitute.** Creatives
   falling just above/below the P25 boundary (or just above/below the scale
   ratio) are quasi-random; comparing their forward trajectories estimates the
   *causal* value of the boundary without a holdout, given enough volume.

**Where generated/scenario data helps:** executable metamorphic tests from the
INVARIANTS.md table (stale ⇒ cap+veto; benchmark weak ⇒ confidence down;
paused ⇒ no fix_delivery; launch-age monotonicity); adversarial boundary
sweeps (P25 > 1.0 accounts, spendUnit null, freshness null, TRY-scale spends,
fraction-unit CTR); property tests for monotonicity (more spend at same ratio
must never *increase* scale confidence blockers, etc.). Synthetic data is the
right tool for invariants and reachability (would have caught F1/F8
mechanically), and the wrong tool for calibrating thresholds — it can only
encode the assumptions under test.

**Where both are insufficient:** (a) true counterfactuals for followed
recommendations — compliance confounding is structural; only the planned
holdout policy (D028) or the RDD above gives causal ground truth; (b)
attribution truth — Meta-attributed revenue vs Shopify reality needs
cross-source reconciliation, not more Meta history; (c) regime shifts
(seasonality, price changes, attribution-platform changes) — trailing-90d
percentiles will lag any regime break and no amount of replay fixes that
without explicit change-point handling; (d) four businesses is a small N for
account-level generalization: pooled/hierarchical baselines would change the
model and would require a new ADR before implementation.

---

## 6. Review of Codex Report

*(Added after the sections above were finalized; based on
`DECISION_MATH_THEORETICAL_REVIEW_2026-07-02.md`. Sections 1–5, 7, 8 were
written blind to it.)*

**Where we independently converge (strong signal both are right):** the dead
cut ladder and the unreachable severe-loser carve-out (same multiplier
arithmetic, found independently); confidence as an uncalibrated "heuristic
trust score" that must not be presented as probability; the null-freshness
rule (unknown ≠ fresh; veto scale, cap-not-hide cut, explicit badge — Codex §5
P1 matches my P-A.4 verbatim in substance); the two-tier use of historical
data (infrastructure validation now, threshold refit only after fresh
outcomes); the do-not-do list (no auto-execution, no scale-guard loosening, no
new core, no premature threshold refit). Codex's confidence-vs-priority
separation (a low-confidence, high-damage cut candidate can be operationally
high priority) is a good point I did not make; I endorse it.

**Codex claims I verified against the working tree (all true):** the
scheduled producer chain and business guard exist and are tested; the
`no_campaign` hard-action bypass is closed; and — correcting my own earlier
audit — the outcomes job can now re-classify rows whose `realized_outcome` is
`unknown` or whose `classifier_version` differs from current (the eligibility
CTE was changed from `NOT EXISTS` to a LEFT JOIN with exactly those
conditions), which makes the previously dead `ON CONFLICT DO UPDATE` path
reachable. Section 8/P-C of this report was adjusted accordingly.

**Where I disagree or would sharpen:**

1. **Cut-zone characterization is understated.** Codex writes that the mature
   hard-cut branch "catches too broadly" and the lower branches run "less than
   expected". Provably stronger: the third predicate is *always* true after
   the maturity gate (both call the same pure threshold function), so the
   fatigue-refresh and observe branches in the cut zone are dead code — never,
   not rarely. Codex's Faz 2 acceptance criteria also omit that **GC-048
   currently pins the defective behavior as expected**; any ladder fix must
   update the golden case or the suite will fail-certify the fix.
2. **Low-CTR delta.** Codex frames the direction as genuinely debatable. For
   the cut/refresh branch specifically I disagree: low CTR corroborates
   creative weakness there, and the "weak data interpretation" concern is
   already handled by the funnel denominator-confidence path. We converge on
   the remedy (no fixed −10 without outcome evidence; zero or flip it).

**Material points missing from Codex's report:**

1. **The unclamped relative cut boundary (my F2).** Nothing in Codex's review
   notes that `roasRatioP25` is unbounded: in a strong account the cut zone
   can swallow profitable, near-target creatives (and the [P25, 0.85) demote
   band vanishes when P25 ≥ 0.85); in a weak account true losers survive.
   This is a distinct defect from the ladder collapse and needs a clamp plus
   the §5.1 sweep to size it.
2. **ECE is not merely un-run — it is polarity-broken as implemented.**
   Pooled hard and non-hard rows have opposite meanings of "positive", so
   Codex's Faz 4 acceptance criterion (observed outcome rate per confidence
   bucket) would inherit the defect unless computed per label class.
   Similarly, precision's denominator counts `unknown` outcomes, so operator
   *compliance* with a cut mechanically lowers measured precision — the
   operator-response join (and cut-response detection, which the module
   lacks) is absent from Codex's plan.
3. **Quality-only double penalty** (−25 global-default delta stacked on the
   assessment-derived base) — unmentioned.
4. **Fatigue baseline-window defects beyond wiring:** the max-ROAS baseline
   window has no spend floor (mean reversion reads as decay) and nested
   windows double-count toward the ≥2-strong-window requirement.
5. **Window semantics:** `spend24h/impressions24h` are calendar-date fields,
   and attribution lag biases the recent7d/28d decay ratio toward false
   fatigue while making the scale recent-hold stricter than designed.
6. **Regression-discontinuity around thresholds** as a compliance-free causal
   readout — a cheap, read-only addition to Codex's Faz 1 baseline that
   neither holdouts nor raw precision can substitute for.

**Net:** no conflict on sequencing — Codex's Faz 1–5 and my P-A…P-D are
compatible (I would merge its Faz 2 and Faz 3 into one config-level PR). Its
scores (math 6.5, measurement 3.5, read-only 6, auto-exec 2) are within half a
point of mine; the residual gap is that Codex scores the ladder+boundary
problem as one issue where I count two (F1, F2), and F2 is the one a
baseline-freeze alone will not surface.

---

## 7. What Not To Change Yet

1. **Do not invert the D032 staleness asymmetry.** Capped stale stop-loss cuts
   + hard-vetoed stale scale is the right loss-averse shape; fix the *null*
   hole and the presentation, not the asymmetry.
2. **Do not replace the account-relative percentile framework with absolute
   thresholds.** Clamp it (F2) — wholesale replacement discards the best idea
   in the engine and would effectively be a new decision core, requiring a new
   ADR in DECISION_LOG.md.
3. **Do not hand-retune confidence constants now.** Without a working outcome
   loop any retune is churn; freeze the scheme, fix only the sign error
   (low-CTR) and the double penalty, and let §5.5 drive recalibration.
4. **Do not attempt a Bayesian/shrinkage rewrite in one step.** Posterior-based
   decisions (Beta-Binomial on purchase rates, shrunk percentiles) are the
   right eventual destination but are a new-core-scale change: separate ADR,
   dual-run comparison, and the F1/F2 guards land first as small reversible
   deltas.
5. **Do not remove `enforceHardActionEligibility` or the ladder tiers without
   characterization tests** — harmless redundancy today; deletion without
   pinned behavior invites silent divergence.
6. Out of scope by project constraint and by correctness: UI computing
   buyerAction, row-level `brief_variation`, deleting V1/operator/V2 snapshot
   compatibility, route renames. Nothing in this review requires any of them.

---

## 8. Recommended Next Phases

Ordered; each small, config-as-data, ENGINE_VERSION-bumped, rollbackable.

**P-A (before any operator treats `cut` as execute-without-review):**
1. Cut evidence floor: hard cut in the ratio zone requires purchases ≥
   max(2, ceil(0.5 × winnerPurchaseP50)) **or** spend ≥ sustainedLoserSpend;
   below that emit `test_more`+`cut_candidate` (resurrects the dead observe
   branch). 2. Recent-recovery guard: recent7dRoas ≥ target (with
   recent7dSpend ≥ recentSampleMinSpend) blocks the cut to `keep [demote
   candidate]` — symmetric to the scale hold. 3. Clamp the cut boundary:
   `min(roasRatioP25, 1.0)` upper bound now; breakeven-anchored floor after
   the §5.1 sweep. 4. `dataFreshnessHours === null` ⇒ treated as stale-class
   (cap + hard-action block), not fresh. Tests: extend GC-048/049 with
   boundary/recovery variants, add a P25>1.0 golden case, convert the five
   INVARIANTS metamorphic rows to executable tests. Rollback: preset-gated
   constants in config-values.ts.

**P-B (confidence hygiene, same release or next):** remove the quality-only
double penalty; flip the low-CTR delta sign (or zero it pending data); align
`cut_candidate`'s ratio definition with the live boundary; implement-or-delete
the tracking branch and the maturity carve-out (if kept, make it reachable by
allowing a hardCut-below-lossBudget override and pin GC-009 to it).

**P-C (measurement validity, prerequisite for any 10/10 claim):** ECE split by
label class (gate on hard-only); join operator-response into outcome
classification and add cut-response detection; replace the vacuous conflict
gate. Re-evaluation of `unknown`/stale-classifier outcomes is **already
implemented in the working tree** (eligibility now re-selects unknown and
version-mismatched rows — verified post-§1–5, see §6) and needs only a
DB-gated test. Then run §5.1–5.4 offline studies and publish the numbers into
`docs/creative-decision-center/generated/` with live-status provenance.

**P-D (structural, ADR-gated):** shrunk/pooled percentile baselines;
probability-calibrated confidence; RDD/holdout causal readout. Only after P-A
… P-C have data behind them.

**What must be true before "close to 10/10" is claimable:** F1 and F2 guards
live and golden-tested; the null-freshness hole closed; a valid (hard-only,
compliance-aware) precision/recall readout over ≥ several hundred hard-action
outcomes from the now-scheduled pipeline; the metamorphic invariants
executable; and the §5 studies published with live provenance. The current
math is a well-structured 6/10: the skeleton (relative calibration, layered
guards, determinism) is production-grade; the evidence floors, confidence
semantics, and validation loop are not yet.
